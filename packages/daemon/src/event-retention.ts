import { setImmediate as cederLoop } from 'node:timers/promises';
import type { UnitOfWork } from '@agents-hub/core';
import type { EstadoDoEspaco, SqliteEspacoDoBanco } from '@agents-hub/store';
import type { RetentionPolicy } from './config.js';

export interface CompactionResult {
  cutoffIso: string;
  rowsCompacted: number;
  /** Páginas devolvidas ao sistema de arquivos nesta passada (R09-07). */
  pagesReleased: number;
}

/** O pedaço da manutenção do arquivo que a passada periódica usa. */
export type EspacoDoBanco = Pick<SqliteEspacoDoBanco, 'estado' | 'devolverPaginasLivres' | 'truncarWal'>;

/**
 * Páginas por `incremental_vacuum`: 128 × 4 KiB = 512 KiB. Medido num banco
 * de 203 MB com 40 mil eventos compactados: ≈9 ms por lote em média (os
 * picos são o auto-checkpoint do WAL, que qualquer escrita dispara). Mesmo
 * espírito de `COMPACTION_BATCH`: pedaços curtos, event loop livre entre eles.
 */
export const PAGINAS_POR_LOTE = 128;

/**
 * Teto de dado VIVO para converter sozinho, na subida, um banco antigo (sem
 * `auto_vacuum`). A conversão é um `VACUUM` completo, síncrono, que custou
 * ≈26 ms por MB de dado vivo (193 MB → 4,5 s; 580 MB → 15 s): 64 MB ficam em
 * ≈1,7 s, uma única vez na vida do banco. Acima disso travar a subida por
 * dezenas de segundos (e fazer o autostart da CLI desistir) é pior que o
 * espaço preso — o caminho é `hub backup` + `hub restore` com o daemon
 * parado, que já gera o banco convertido (ver `backupDatabase`).
 */
export const CONVERSAO_AUTOMATICA_MAX_BYTES = 64 * 1024 * 1024;

export type DecisaoDeConversao =
  | { converter: true; bytesVivos: number }
  | { converter: false; motivo: 'ja-incremental' | 'grande-demais'; bytesVivos: number };

/** Decide, sem tocar no banco, se a subida converte o banco para `INCREMENTAL`. */
export function decidirConversao(
  estado: EstadoDoEspaco,
  tetoBytes: number = CONVERSAO_AUTOMATICA_MAX_BYTES,
): DecisaoDeConversao {
  const bytesVivos = (estado.pageCount - estado.freelistCount) * estado.pageSize;
  if (estado.autoVacuum === 'incremental') {
    return { converter: false, motivo: 'ja-incremental', bytesVivos };
  }
  if (bytesVivos > tetoBytes) return { converter: false, motivo: 'grande-demais', bytesVivos };
  return { converter: true, bytesVivos };
}

export type ResultadoDaConversao = DecisaoDeConversao & {
  /** Duração do `VACUUM`, quando houve. */
  ms: number;
};

/**
 * Converte, se couber no teto, um banco antigo para `auto_vacuum =
 * INCREMENTAL`. Roda na subida do daemon, antes da reconciliação: nenhuma
 * sessão rodando, e o `VACUUM` precisa da conexão sem transação aberta.
 * Falha (disco cheio — o `VACUUM` precisa de espaço para a cópia) não
 * derruba nada: o SQLite desfaz, o banco fica como estava, e quem chama
 * registra e segue.
 */
export function converterBancoAntigo(
  espaco: Pick<SqliteEspacoDoBanco, 'estado' | 'converterParaIncremental'>,
  tetoBytes: number = CONVERSAO_AUTOMATICA_MAX_BYTES,
): ResultadoDaConversao {
  const decisao = decidirConversao(espaco.estado(), tetoBytes);
  if (!decisao.converter) return { ...decisao, ms: 0 };
  const inicio = performance.now();
  espaco.converterParaIncremental();
  return { ...decisao, ms: Math.round(performance.now() - inicio) };
}

/**
 * Compactador periódico de `events.raw_json` (ADR 06.3 + achado §3.7 do doc
 * 08: a tabela cresce para sempre com `payload_json` E `raw_json`, sem
 * `DELETE` nem `VACUUM`).
 *
 * Mesmo padrão de timer com `unref()` que `WorktreeReaper` já usa: uma
 * passada na largada (o daemon pode ter ficado dias parado) e depois um
 * `setInterval` que não segura o processo vivo sozinho.
 *
 * Deliberadamente NÃO roda `VACUUM` completo — ele bloqueia o banco inteiro
 * por tempo proporcional ao dado vivo, e isso criaria uma categoria nova de
 * trava num daemon que fica no ar por dias. Devolve espaço ao SO com
 * `incremental_vacuum` em lotes de `PAGINAS_POR_LOTE` (banco com `auto_vacuum
 * = INCREMENTAL`: todo banco novo, e o antigo depois de `converterBancoAntigo`)
 * e zera o `-wal` no fim (R09-07). O que isso NÃO devolve: a fragmentação
 * dentro das páginas que continuam em uso (a linha encolheu, a página ficou) —
 * medido, ≈45% do arquivo volta; o resto só um `VACUUM` completo recupera, e
 * ele acontece na conversão e em todo `hub backup` (`VACUUM INTO`).
 */
/**
 * Linhas por lote de compactação. Um UPDATE único sobre 100k eventos segurava
 * o daemon por ~2,7 s (vistoria 2026-09-25, 09-store-core): `DatabaseSync` é
 * síncrono e roda no mesmo thread do HTTP, do SSE e dos hooks. Em lotes, cada
 * pedaço custa poucos ms e o event loop respira entre eles.
 */
export const COMPACTION_BATCH = 2000;

export class EventRetentionCompactor {
  #timer: NodeJS.Timeout | null = null;
  /** Passada em andamento: timer e largada não podem compactar em paralelo. */
  #emAndamento: Promise<CompactionResult> | null = null;

  constructor(
    private readonly store: Pick<UnitOfWork, 'events'>,
    private readonly retention: Pick<RetentionPolicy, 'rawEventDays' | 'sweepIntervalMinutes'>,
    private readonly batchSize: number = COMPACTION_BATCH,
    /** Sem ele a passada só compacta (testes que não olham o arquivo). */
    private readonly espaco: EspacoDoBanco | null = null,
  ) {}

  start(): void {
    if (this.#timer) return;
    // Passada do timer: ninguém espera por ela, então a falha (banco ocupado,
    // disco cheio) é registrada AQUI. Antes era `void this.compact()` — a
    // rejeição ficava sem dono e caía no `unhandledRejection` genérico, que
    // culpa "a sessão de origem" por um erro do compactador.
    const passada = (): void => {
      this.compact().catch((err: unknown) => {
        console.error(
          `[retenção] compactação de eventos falhou: ${(err as Error)?.message ?? String(err)}`,
        );
      });
    };
    passada();
    this.#timer = setInterval(passada, Math.max(1, this.retention.sweepIntervalMinutes) * 60_000);
    // Um compactador de banco não pode ser o motivo de o processo não sair.
    this.#timer.unref?.();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  compact(now: Date = new Date()): Promise<CompactionResult> {
    this.#emAndamento ??= this.#compactar(now).finally(() => {
      this.#emAndamento = null;
    });
    return this.#emAndamento;
  }

  async #compactar(now: Date): Promise<CompactionResult> {
    const cutoffIso = new Date(
      now.getTime() - this.retention.rawEventDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    let rowsCompacted = 0;
    for (;;) {
      const afetadas = this.store.events.compactRawBefore(cutoffIso, this.batchSize);
      rowsCompacted += afetadas;
      if (afetadas < this.batchSize) break;
      // Cede o event loop entre lotes: requisições HTTP e eventos de sessão
      // que chegaram durante o lote são atendidos antes do próximo.
      await cederLoop();
    }
    const pagesReleased = this.espaco ? await this.#devolverEspaco(this.espaco) : 0;
    return { cutoffIso, rowsCompacted, pagesReleased };
  }

  /**
   * Devolve ao SO as páginas livres — as que a compactação acabou de liberar
   * e as que sobraram de passadas anteriores. Banco sem `auto_vacuum =
   * INCREMENTAL` não tem o que fazer aqui (o pragma seria inócuo).
   */
  async #devolverEspaco(espaco: EspacoDoBanco): Promise<number> {
    const estado = espaco.estado();
    if (estado.autoVacuum !== 'incremental' || estado.freelistCount === 0) return 0;

    let devolvidas = 0;
    for (;;) {
      const lote = espaco.devolverPaginasLivres(PAGINAS_POR_LOTE);
      devolvidas += lote;
      if (lote < PAGINAS_POR_LOTE) break;
      await cederLoop();
    }
    espaco.truncarWal();
    return devolvidas;
  }
}
