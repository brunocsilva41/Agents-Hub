import { newId, nowIso, type Artifact, type EventEnvelope, type Session, type Task, type UnitOfWork } from '@agents-hub/core';
import { captureDiff, loadBaseline, persistDiff } from './diff-capture.js';

/** O que `capturarMudancas` precisa do `SessionManager`, sem precisar dele inteiro. */
export interface CapturarMudancasDeps {
  store: Pick<UnitOfWork, 'artifacts'>;
  artifactRoot: string;
  /** Mesma assinatura de `SessionManager#emit` — publica no bus e persiste. */
  emit: (draft: {
    sessionId: string;
    taskId: string | null;
    agentId: string;
    type: EventEnvelope['type'];
    payload: Record<string, unknown>;
  }) => void;
}

/**
 * Registra o que a sessão mudou no código.
 *
 * Sem isto, `TaskResult.artifacts` era sempre `[]` e a tabela de artefatos
 * nunca via uma linha: o Hub sabia quanto custou e o que o agente disse, mas
 * não o que ele efetivamente escreveu. O diff é a resposta à pergunta que
 * sempre vem primeiro.
 *
 * Extraído de `session-manager.ts` (dívida arquitetural do arquivo grande).
 * `emit` chega por parâmetro em vez de a função pertencer à classe: é o único
 * jeito de isolar esta orquestração sem levar `SessionManager` inteiro junto
 * — a leitura/escrita de diff já era externa (`diff-capture.ts`), só a cola
 * (criar `Artifact`, persistir, emitir evento) estava presa na classe.
 */
export async function capturarMudancas(
  deps: CapturarMudancasDeps,
  session: Session,
  task: Task,
): Promise<string[]> {
  const capture = await captureDiff(
    session.workdir,
    await loadBaseline(deps.artifactRoot, session.id),
  );
  if (!capture || capture.empty) return [];

  const arquivo = await persistDiff(deps.artifactRoot, session.id, capture);
  if (!arquivo) return [];

  const artifact: Artifact = {
    id: newId('art'),
    sessionId: session.id,
    taskId: task.id,
    kind: 'diff',
    path: arquivo,
    hash: null,
    createdAt: nowIso(),
  };
  deps.store.artifacts.create(artifact);

  deps.emit({
    sessionId: session.id,
    taskId: task.id,
    agentId: session.agentId,
    type: 'file.changed',
    payload: {
      summary: `${capture.filesChanged} arquivo(s), +${capture.insertions} −${capture.deletions}`,
      untracked: capture.untracked,
      artifactId: artifact.id,
    },
  });

  return [artifact.id];
}
