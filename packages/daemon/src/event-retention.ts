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
export class EventRetentionCompactor {
  #timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: Pick<UnitOfWork, 'events'>,
    private readonly retention: Pick<RetentionPolicy, 'rawEventDays' | 'sweepIntervalMinutes'>,
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

  async compact(now: Date = new Date()): Promise<CompactionResult> {
    const cutoffIso = new Date(
      now.getTime() - this.retention.rawEventDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    const rowsCompacted = this.store.events.compactRawBefore(cutoffIso);
    return { cutoffIso, rowsCompacted };
  }
}
