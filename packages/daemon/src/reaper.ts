import { existsSync } from 'node:fs';
import type { UnitOfWork } from '@agents-hub/core';
import type { RetentionPolicy } from './config.js';
import type { WorktreeManager } from './worktree.js';

export interface SweepResult {
  examined: number;
  removed: string[];
  kept: number;
}

/**
 * Coletor de worktrees expirados (ADR 06.3).
 *
 * A regra é retenção, não limpeza imediata: quando uma sessão termina, o
 * checkout continua no disco por alguns dias justamente para você poder abrir
 * e ver o estado em que o agente deixou as coisas — `git diff`, rodar os
 * testes, comparar. Apagar na hora do encerramento tira de você a única janela
 * em que isso é fácil.
 *
 * O branch `hub/<sessionId>` NUNCA é apagado por aqui: mesmo depois de o
 * checkout expirar, o trabalho continua acessível por `git log hub/<id>`.
 */
export class WorktreeReaper {
  #timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: UnitOfWork,
    private readonly worktrees: WorktreeManager,
    private readonly retention: RetentionPolicy,
  ) {}

  start(): void {
    if (this.#timer) return;
    // Uma passada na largada: o daemon pode ter ficado dias desligado.
    void this.sweep();
    this.#timer = setInterval(
      () => void this.sweep(),
      Math.max(1, this.retention.sweepIntervalMinutes) * 60_000,
    );
    // Um coletor de disco não pode ser o motivo de o processo não conseguir sair.
    this.#timer.unref?.();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  async sweep(now: Date = new Date()): Promise<SweepResult> {
    const cutoff = now.getTime() - this.retention.worktreeDays * 24 * 60 * 60 * 1000;
    const result: SweepResult = { examined: 0, removed: [], kept: 0 };

    const finished = this.store.sessions
      .list()
      .filter((s) => s.endedAt !== null && s.isolation === 'worktree');

    for (const session of finished) {
      result.examined += 1;

      if (!existsSync(session.workdir)) continue;
      if (new Date(session.endedAt as string).getTime() > cutoff) {
        result.kept += 1;
        continue;
      }

      const project = this.store.projects.get(session.projectId);
      if (!project) continue;

      await this.worktrees.release({
        projectPath: project.path,
        worktreePath: session.workdir,
      });

      if (!existsSync(session.workdir)) result.removed.push(session.workdir);
      await this.worktrees.prune(project.path);
    }

    return result;
  }
}
