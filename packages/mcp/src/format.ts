import { textoDe, type EventEnvelope, type Workflow, type WorkflowRunResult } from '@agents-hub/core';
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

  // Failover em cascata sem aviso (vistoria 08, achado 11): o chamador via
  // "delegado para claude" e nunca sabia que quem executou foi outro agente.
  const troca = trocaDeAgente(status);
  if (troca) lines.push(troca);

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

  if (task.result?.validation) {
    const v = task.result.validation;
    lines.push(
      `validação: ${v.passed ? 'passou' : 'REPROVOU'} — ${v.checks
        .map((c) => `${c.name}${c.passed ? ' ok' : `: ${c.detail ?? 'falhou'}`}`)
        .join('; ')}`,
    );
  }

  if (task.state === 'input_required') {
    // Dizer "normalmente orçamento esgotado" quando o bloqueio foi outra coisa
    // faz o agente orientar mal o usuário. O motivo real vem junto do status.
    const motivo = status.approval
      ? `${status.approval.action} (risco: ${status.approval.risk})`
      : 'motivo não identificado';

    lines.push(
      `AÇÃO NECESSÁRIA: a task está bloqueada aguardando decisão humana — ${motivo}.`,
      status.approval
        ? `Peça ao seu usuário para rodar: hub approve ${status.approval.id}  (ou hub deny ${status.approval.id})`
        : 'Avise seu usuário; você não pode desbloquear sozinho.',
    );
  }

  return lines.join('\n');
}

/**
 * Linha de aviso quando a task não está (mais) com o agente que recebeu a
 * primeira tentativa — fallback do daemon ou handoff. `null` quando não houve
 * troca.
 */
export function trocaDeAgente(status: TaskStatus): string | null {
  const { task, session } = status;
  const primeiro = task.attempts[0]?.agentId;
  if (!primeiro) return null;
  const cadeia: string[] = [];
  for (const a of task.attempts) {
    if (cadeia.at(-1) !== a.agentId) cadeia.push(a.agentId);
  }
  if (cadeia.at(-1) !== session.agentId) cadeia.push(session.agentId);
  if (cadeia.length < 2) return null;
  return (
    `FALLBACK: a tarefa começou em ${primeiro} e quem executa agora é ${session.agentId} ` +
    `(cadeia: ${cadeia.join(' → ')}; sessão atual ${session.id}) — o resultado abaixo é de ${session.agentId}`
  );
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
          return `[${time}] ${truncate(textoDe(p['text']), 1500)}`;
        case 'command.executed':
          return `[${time}] $ ${textoDe(p['command'])} → ${textoDe(p['exitCode'], '?')}`;
        case 'file.changed':
          return `[${time}] alterou ${describeFiles(p)}`;
        case 'tool.call':
          return `[${time}] ferramenta ${textoDe(p['tool'])}`;
        case 'delegation.requested':
          return `[${time}] delegou para ${textoDe(p['targetAgent'])}: ${textoDe(p['objective'])}`;
        case 'delegation.completed':
          return `[${time}] delegação a ${textoDe(p['agentId'])} terminou: ${textoDe(p['state'])}`;
        case 'error':
          return `[${time}] ERRO: ${textoDeErro(p)}`;
        case 'turn.completed':
          return `[${time}] turno concluído`;
        case 'session.ended':
          return `[${time}] sessão encerrada (${textoDe(p['reason'])})`;
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

/** Relatório de `hub_workflow_run` — mesma informação que `hub workflow run` imprime. */
export function formatWorkflowResult(workflow: Workflow, resultado: WorkflowRunResult): string {
  const ok = resultado.steps.filter((s) => s.state === 'completed').length;
  const lines = [
    `workflow "${workflow.name}": ${ok}/${resultado.steps.length} passos concluídos · US$ ${resultado.totalUsd.toFixed(4)}`,
  ];

  for (const s of resultado.steps) {
    const marca = s.state === 'completed' ? 'ok' : s.state === 'blocked' ? 'bloqueado' : s.state;
    lines.push(
      `- ${s.stepId} (${s.agent}): ${marca}` +
        (s.detail ? ` — ${s.detail}` : '') +
        (s.sessionId ? ` [sessão ${s.sessionId}]` : ''),
    );
  }

  const vivos = resultado.steps.filter((s) => s.state === 'blocked' || s.state === 'timeout');
  if (vivos.length > 0) {
    lines.push(
      '',
      `sessões ainda vivas no daemon: ${vivos.map((s) => s.sessionId).join(', ')}`,
    );
  }

  if (!resultado.ok) {
    lines.push('', 'ATENÇÃO: nem todos os passos concluíram — veja os detalhes acima.');
  }

  return lines.join('\n');
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Texto de um evento de erro. O mapper do Claude põe o motivo em `summary`
 * ("Prompt is too long"), o desfecho do processo em `error`, o pump em
 * `message` — lendo só `message ?? error`, o agente via `ERRO: ` vazio
 * (vistoria 08, achado 16).
 */
function textoDeErro(p: Record<string, unknown>): string {
  for (const chave of ['message', 'summary', 'error'] as const) {
    const v = p[chave];
    if (typeof v === 'string' && v.trim().length > 0) return truncate(v.trim(), 500);
  }
  const razao = p['reason'] ?? p['subtype'];
  return textoDe(razao, 'sem detalhe');
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [truncado]` : text;
}

function describeFiles(payload: Record<string, unknown>): string {
  const files = payload['files'];
  if (Array.isArray(files)) {
    return files
      .map((f) => textoDe((f as Record<string, unknown>)['path']))
      .filter(Boolean)
      .join(', ');
  }
  return textoDe(payload['path']);
}
