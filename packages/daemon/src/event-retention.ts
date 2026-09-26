import { setImmediate as cederLoop } from 'node:timers/promises';
import type { UnitOfWork } from '@agents-hub/core';
import type { RetentionPolicy } from './config.js';

export interface CompactionResult {
  cutoffIso: string;
  rowsCompacted: number;
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
 * Deliberadamente NÃO roda `VACUUM` — `VACUUM` bloqueia o banco inteiro por
 * tempo proporcional ao tamanho do arquivo, e isso criaria uma categoria nova
 * de trava num daemon que fica no ar por dias. Zerar `raw_json` já libera o
 * espaço para o SQLite reutilizar em páginas futuras; só não devolve o
 * espaço ao sistema de arquivos, o que é uma troca aceitável pelo que evita.
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
  ) {}

  start(): void {
    if (this.#timer) return;
    void this.compact();
    this.#timer = setInterval(
      () => void this.compact(),
      Math.max(1, this.retention.sweepIntervalMinutes) * 60_000,
    );
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
    return { cutoffIso, rowsCompacted };
  }
}
