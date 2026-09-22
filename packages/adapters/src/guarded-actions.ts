import path from 'node:path';
import type { GuardedAction } from '@agents-hub/core';
import type { MappedEvent } from './types.js';

/**
 * Traduz um evento do agente nas ações que a política sabe classificar.
 *
 * Só existem duas fontes reais de risco observável: comando executado e
 * arquivo alterado. Caminho relativo é resolvido contra o worktree da sessão —
 * sem isso, todo arquivo do agente pareceria estar fora do diretório dele.
 *
 * Extraído de `session-manager.ts` (dívida arquitetural do arquivo grande) —
 * mora em `adapters`, não em `core`, porque depende de `MappedEvent`
 * (formato de evento do adapter) além de `GuardedAction` (tipo do domínio);
 * `core` não pode conhecer `adapters`.
 */
export function guardedActionsOf(mapped: MappedEvent, workdir: string): GuardedAction[] {
  if (mapped.type === 'command.executed') {
    const command = mapped.payload['command'];
    return typeof command === 'string' && command.trim().length > 0
      ? [{ kind: 'command', command }]
      : [];
  }

  if (mapped.type === 'file.changed') {
    const files = mapped.payload['files'];
    const paths =
      Array.isArray(files) && files.length > 0
        ? files.map((f) => (f as Record<string, unknown>)['path'])
        : [mapped.payload['path']];

    return paths
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .map((p) => ({ kind: 'file.write' as const, path: path.resolve(workdir, p) }));
  }

  return [];
}

/** Descreve uma `GuardedAction` em texto legível para timeline/aprovação. */
export function describeAction(action: GuardedAction): string {
  switch (action.kind) {
    case 'command':
      return `executou: ${action.command}`;
    case 'file.write':
      return `escreveu em: ${action.path}`;
    case 'file.read':
      return `leu: ${action.path}`;
    case 'network':
      return `acessou: ${action.url}`;
    case 'delegation':
      return `delegou para: ${action.agent}`;
    case 'budget.overrun':
      return action.detail;
  }
}
