import type { EventEnvelope } from '@agents-hub/core';
import type { BudgetSummary, GraphSummary, TaskStatus } from '@agents-hub/client';

/**
 * Formatação para consumo de MODELO, não de humano.
 *
 * A saída de uma tool volta para dentro da janela de contexto do agente
 * chamador, então cada caractere é pago. Texto compacto e denso vence JSON
 * indentado — e vence com folga quando o agente vai ler isso a cada polling.
 */

export function formatBudget(budget: BudgetSummary): string {
  const pct = Math.round(budget.pressure * 100);
  return [
    `orçamento do fluxo: US$ ${budget.consumed.usd.toFixed(4)} de ${budget.limits.usd.toFixed(2)}`,
    `${formatTokens(budget.consumed.tokens)} de ${formatTokens(budget.limits.tokens)} tokens`,
    `${pct}% consumido${budget.exhausted ? ' — ESGOTADO' : ''}`,
  ].join(' · ');
}

export function formatTaskStatus(status: TaskStatus): string {
  const { task, session, live, budget } = status;
  const lines = [
    `task ${task.id}: ${task.state}${live ? ' (executando agora)' : ''}`,
    `agente: ${session.agentId} · sessão: ${session.id} · worktree: ${session.workdir}`,
    `objetivo: ${task.brief.objective}`,
  ];

  const failures = task.attempts.filter((a) => a.outcome === 'error');
  if (failures.length > 0) {
    lines.push(
      `tentativas com falha: ${failures
        .map((a) => `#${a.n} em ${a.agentId} (${a.error ?? 'sem detalhe'})`)
        .join('; ')}`,
    );
  }

  if (task.result) {
    lines.push(
      `resultado: ${task.result.summary}`,
      `custo desta task: US$ ${task.result.usage.usd.toFixed(4)} · ${formatTokens(
        task.result.usage.tokens,
      )} tokens · ${task.result.usage.seconds}s`,
    );
  }

  lines.push(formatBudget(budget));

  if (task.state === 'input_required') {
    lines.push(
      'AÇÃO NECESSÁRIA: a task está bloqueada aguardando decisão humana ' +
        '(normalmente orçamento esgotado). Avise seu usuário — você não pode desbloquear sozinho.',
    );
  }

  return lines.join('\n');
}

/**
 * Eventos em uma linha cada. Filtra o que não ajuda o chamador a decidir:
 * `log`, `reasoning` e deltas são ruído caro dentro de outro agente.
 */
export function formatEvents(events: EventEnvelope[], includeVerbose = false): string {
  const useful = events.filter((e) =>
    includeVerbose ? true : e.type !== 'log' && e.type !== 'message.delta' && e.type !== 'reasoning',
  );

  if (useful.length === 0) return 'nenhum evento novo';

  return useful
    .map((event) => {
      const time = event.ts.slice(11, 19);
      const p = event.payload;
      switch (event.type) {
        case 'message':
          return `[${time}] ${truncate(String(p['text'] ?? ''), 1500)}`;
        case 'command.executed':
          return `[${time}] $ ${String(p['command'] ?? '')} → ${String(p['exitCode'] ?? '?')}`;
        case 'file.changed':
          return `[${time}] alterou ${describeFiles(p)}`;
        case 'tool.call':
          return `[${time}] ferramenta ${String(p['tool'] ?? '')}`;
        case 'delegation.requested':
          return `[${time}] delegou para ${String(p['targetAgent'] ?? '')}: ${String(p['objective'] ?? '')}`;
        case 'delegation.completed':
          return `[${time}] delegação a ${String(p['agentId'] ?? '')} terminou: ${String(p['state'] ?? '')}`;
        case 'error':
          return `[${time}] ERRO: ${String(p['message'] ?? p['error'] ?? '')}`;
        case 'turn.completed':
          return `[${time}] turno concluído`;
        case 'session.ended':
          return `[${time}] sessão encerrada (${String(p['reason'] ?? '')})`;
        case 'budget.exceeded':
          return `[${time}] ORÇAMENTO ESGOTADO`;
        default:
          return `[${time}] ${event.type}`;
      }
    })
    .join('\n');
}

export function formatGraph(nodes: GraphSummary[], depth = 0): string {
  return nodes
    .flatMap((node) => [
      `${'  '.repeat(depth)}${depth > 0 ? '└ ' : ''}${node.agentId} [${node.state}] ` +
        `US$ ${node.usd.toFixed(4)} · ${formatTokens(node.tokens)} tok · ${node.sessionId}` +
        (node.title ? `\n${'  '.repeat(depth + 1)}${node.title}` : ''),
      ...(node.children.length > 0 ? [formatGraph(node.children, depth + 1)] : []),
    ])
    .join('\n');
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [truncado]` : text;
}

function describeFiles(payload: Record<string, unknown>): string {
  const files = payload['files'];
  if (Array.isArray(files)) {
    return files
      .map((f) => String((f as Record<string, unknown>)['path'] ?? ''))
      .filter(Boolean)
      .join(', ');
  }
  return String(payload['path'] ?? '');
}
