import type { EventEnvelope } from '@agents-hub/core';
import type { GraphSummary } from './client.js';

const supportsColor =
  process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;

const ESC = String.fromCharCode(27);

const paint = (code: string, text: string): string =>
  supportsColor ? `${ESC}[${code}m${text}${ESC}[0m` : text;

export const dim = (t: string): string => paint('2', t);
export const bold = (t: string): string => paint('1', t);
export const red = (t: string): string => paint('31', t);
export const green = (t: string): string => paint('32', t);
export const yellow = (t: string): string => paint('33', t);
export const blue = (t: string): string => paint('34', t);
export const magenta = (t: string): string => paint('35', t);
export const cyan = (t: string): string => paint('36', t);

/**
 * Uma linha por evento, com o agente sempre visível.
 *
 * Quando três agentes trabalham no mesmo fluxo, saber *quem* falou importa
 * mais do que a formatação bonita — por isso o id do agente vem antes do texto.
 */
export function renderEvent(event: EventEnvelope, opts: { showAgent?: boolean } = {}): string {
  const time = dim(event.ts.slice(11, 19));
  const who = opts.showAgent === false ? '' : `${cyan(event.agentId.padEnd(12))} `;
  const p = event.payload;

  switch (event.type) {
    case 'session.started':
      return `${time} ${who}${green('▸ sessão iniciada')}`;

    case 'turn.started':
      return `${time} ${who}${dim('… turno iniciado')}`;

    case 'message':
      return `${time} ${who}${textOf(p['text'])}`;

    case 'reasoning':
      return `${time} ${who}${dim(truncate(textOf(p['text']), 220))}`;

    case 'tool.call':
      return `${time} ${who}${blue('⚒')} ${String(p['tool'] ?? 'tool')} ${dim(compact(p['input']))}`;

    case 'tool.result':
      return `${time} ${who}${p['isError'] === true ? red('⚒ falhou') : dim('⚒ ok')}`;

    case 'command.executed':
      return `${time} ${who}${yellow('$')} ${textOf(p['command'])}${
        p['exitCode'] !== undefined && p['exitCode'] !== null ? dim(` → ${String(p['exitCode'])}`) : ''
      }`;

    case 'file.changed':
      return `${time} ${who}${magenta('✎')} ${describeFiles(p)}`;

    case 'delegation.requested':
      return `${time} ${who}${bold(magenta('→ delegou'))} para ${bold(
        String(p['targetAgent']),
      )} ${dim(`(nível ${String(p['depth'])})`)}\n${' '.repeat(9)}${dim(textOf(p['objective']))}`;

    case 'delegation.completed':
      return `${time} ${who}${bold(magenta('← retornou'))} de ${bold(String(p['agentId']))} ${
        p['state'] === 'completed' ? green('✓') : red('✗')
      }`;

    case 'approval.requested':
      return `${time} ${who}${yellow('⏸ aguardando aprovação')} ${textOf(p['action'])}`;

    case 'budget.exceeded':
      return `${time} ${who}${red('✗ orçamento esgotado')}`;

    case 'turn.completed': {
      const cost = event.cost?.usd;
      return `${time} ${who}${green('✓ turno concluído')}${
        cost ? dim(` — US$ ${cost.toFixed(4)}`) : ''
      }`;
    }

    case 'error':
      return `${time} ${who}${red('✗')} ${textOf(p['message'] ?? p['error'] ?? p['text'])}`;

    case 'session.ended':
      return `${time} ${who}${dim(`▪ sessão encerrada (${String(p['reason'] ?? '')})`)}`;

    case 'log':
      return `${time} ${who}${dim(truncate(textOf(p['text'] ?? compact(p['data'])), 160))}`;

    default:
      return `${time} ${who}${dim(event.type)} ${dim(compact(p))}`;
  }
}

export function renderGraph(nodes: GraphSummary[], prefix = '', isRoot = true): string[] {
  const lines: string[] = [];

  nodes.forEach((node, index) => {
    const last = index === nodes.length - 1;
    // A raiz não recebe conector; todo descendente recebe — inclusive os
    // filhos diretos da raiz, que é onde a indentação estava se perdendo.
    const branch = isRoot ? '' : last ? '└─ ' : '├─ ';
    const childPrefix = isRoot ? '   ' : `${prefix}${last ? '   ' : '│  '}`;

    lines.push(
      `${prefix}${branch}${bold(node.agentId)} ${stateBadge(node.state)} ${dim(
        `US$ ${node.usd.toFixed(4)} · ${formatTokens(node.tokens)} tok`,
      )}`,
    );
    lines.push(`${childPrefix}${dim(node.title ?? node.sessionId)}`);

    if (node.children.length > 0) {
      lines.push(...renderGraph(node.children, childPrefix, false));
    }
  });

  return lines;
}

export function stateBadge(state: string): string {
  switch (state) {
    case 'running':
      return green('● rodando');
    case 'completed':
      return green('✓ concluída');
    case 'failed':
      return red('✗ falhou');
    case 'killed':
      return red('■ encerrada');
    case 'waiting_approval':
      return yellow('⏸ aguardando');
    case 'paused':
      return yellow('⏸ pausada');
    default:
      return dim(state);
  }
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function compact(value: unknown): string {
  if (value === undefined || value === null) return '';
  const json = JSON.stringify(value);
  return truncate(json ?? '', 160);
}

function describeFiles(payload: Record<string, unknown>): string {
  const files = payload['files'];
  if (Array.isArray(files)) {
    return files
      .map((f) => (f as Record<string, unknown>)['path'])
      .filter(Boolean)
      .join(', ');
  }
  return textOf(payload['path']);
}
