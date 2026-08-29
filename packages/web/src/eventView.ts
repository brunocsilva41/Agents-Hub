import type { EventEnvelope } from '@agents-hub/core';

export interface EventView {
  text: string;
  kind: string;
  /** Eventos escondidos por padrão: ruído caro de ler numa sessão longa. */
  verbose: boolean;
}

/**
 * Um envelope nunca muda depois de criado, então sua tradução também não.
 *
 * Sem este cache, `describeEvent` roda de novo para a timeline inteira a cada
 * render — inclusive a cada tecla digitada no campo de mensagem. Com `WeakMap`
 * a entrada some junto com o evento quando ele sai da janela, sem limite a
 * ajustar nem vazamento a vigiar.
 */
const viewCache = new WeakMap<EventEnvelope, EventView>();

export function viewOf(event: EventEnvelope): EventView {
  const cached = viewCache.get(event);
  if (cached) return cached;
  const view = describeEvent(event);
  viewCache.set(event, view);
  return view;
}

/**
 * Traduz o `EventEnvelope` normalizado para uma linha legível.
 *
 * Como todos os oito agentes chegam aqui no mesmo formato, esta função é a
 * única que precisa existir — não há um renderizador por agente.
 */
export function describeEvent(event: EventEnvelope): EventView {
  const p = event.payload;

  switch (event.type) {
    case 'session.started':
      return {
        text: p['external'] === true ? '▸ agente externo conectado' : '▸ sessão iniciada',
        kind: 'lifecycle',
        verbose: false,
      };

    case 'session.ended':
      return { text: `▪ encerrada — ${str(p['reason'])}`, kind: 'lifecycle', verbose: false };

    case 'turn.started':
      return { text: '… turno iniciado', kind: 'lifecycle', verbose: true };

    case 'turn.completed':
      return {
        text: `✓ turno concluído${event.cost?.usd ? ` — US$ ${event.cost.usd.toFixed(4)}` : ''}`,
        kind: 'lifecycle',
        verbose: false,
      };

    case 'message':
      return { text: str(p['text']), kind: 'message', verbose: false };

    case 'message.delta':
      return { text: str(p['text']), kind: 'message', verbose: true };

    case 'reasoning':
      return { text: str(p['text']), kind: 'reasoning', verbose: true };

    case 'tool.call':
      return {
        text: `⚒ ${str(p['tool'])}${p['input'] ? ` ${compact(p['input'])}` : ''}`,
        kind: 'tool',
        verbose: false,
      };

    case 'tool.result':
      return {
        text: p['isError'] === true ? '⚒ ferramenta falhou' : '⚒ ok',
        kind: p['isError'] === true ? 'error' : 'reasoning',
        verbose: true,
      };

    case 'command.executed':
      return {
        text: `$ ${str(p['command'])}${p['exitCode'] === undefined || p['exitCode'] === null ? '' : ` → ${String(p['exitCode'])}`}`,
        kind: 'command',
        verbose: false,
      };

    case 'file.changed':
      return { text: `✎ ${describeFiles(p)}`, kind: 'file', verbose: false };

    case 'delegation.requested':
      return {
        text: `→ delegou para ${str(p['targetAgent'])} (nível ${String(p['depth'] ?? '?')}): ${str(p['objective'])}`,
        kind: 'delegation',
        verbose: false,
      };

    case 'delegation.completed':
      return {
        text: `← ${str(p['agentId'])} retornou: ${str(p['state'])}${p['error'] ? ` — ${str(p['error'])}` : ''}`,
        kind: 'delegation',
        verbose: false,
      };

    case 'approval.requested':
      return { text: `⏸ aguardando aprovação: ${str(p['action'])}`, kind: 'error', verbose: false };

    case 'budget.exceeded':
      return { text: '✗ orçamento do fluxo esgotado', kind: 'error', verbose: false };

    case 'error':
      return {
        text: `✗ ${str(p['message'] ?? p['error'] ?? p['text'])}`,
        kind: 'error',
        verbose: false,
      };

    case 'log':
      return { text: str(p['text'] ?? compact(p['data'])), kind: 'log', verbose: true };

    default:
      return { text: `${event.type} ${compact(p)}`, kind: 'log', verbose: true };
  }
}

function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return JSON.stringify(value);
}

function compact(value: unknown): string {
  if (value === undefined || value === null) return '';
  const json = JSON.stringify(value) ?? '';
  return json.length > 220 ? `${json.slice(0, 220)}…` : json;
}

function describeFiles(payload: Record<string, unknown>): string {
  const files = payload['files'];
  if (Array.isArray(files)) {
    const paths = files
      .map((f) => str((f as Record<string, unknown>)['path']))
      .filter((p) => p.length > 0);
    return paths.join(', ') || 'arquivos alterados';
  }
  return str(payload['path']) || 'arquivo alterado';
}
