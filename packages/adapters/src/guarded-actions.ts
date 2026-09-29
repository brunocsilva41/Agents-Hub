import path from 'node:path';
import type { GuardedAction, PolicyEngine, RiskLevel, SessionMode, WatchPolicy } from '@agents-hub/core';
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

/**
 * Descreve a ação como PEDIDO, sem afirmar que rodou — para o evento que o
 * gate pré-execução ainda vai decidir (o Claude emite o `tool_use` no stream
 * antes de chamar o hook, então "executou" ali seria falso).
 */
export function describeRequest(action: GuardedAction): string {
  switch (action.kind) {
    case 'command':
      return `pediu para executar: ${action.command}`;
    case 'file.write':
      return `pediu para escrever em: ${action.path}`;
    default:
      return describeAction(action);
  }
}

/**
 * Quais eventos o gate pré-execução DESTA sessão decide antes de a ferramenta
 * rodar. Quem monta é o daemon, com a mesma fonte de verdade que liga o gate
 * no spawn (`gate.settingsArgs` do manifesto; bypass de confiança do Codex).
 *
 * - `hook-por-sessao` (Claude/OpenClaude, `--settings`): o `tool_use` chega no
 *   stream ANTES do PreToolUse (medido com o claude 2.1.285 real). Vale para
 *   a ferramenta do evento (`payload.tool`) que está no matcher do hook.
 * - `codex-comandos`: o Codex emite `command_execution` só no `item.completed`,
 *   DEPOIS de rodar — e só roda o que o hook deixou. `file_change`
 *   (`apply_patch`) fica de fora: que o PreToolUse do Codex o intercepte não
 *   foi medido, então a vigilância continua pausando nele.
 */
export type CoberturaDoGate =
  | { tipo: 'nenhuma' }
  | { tipo: 'hook-por-sessao'; ferramentas: readonly string[] }
  | { tipo: 'codex-comandos' };

/** O gate pré-execução desta sessão decide o evento (antes de a ferramenta rodar)? */
export function gateDecideOEvento(mapped: MappedEvent, cobertura: CoberturaDoGate): boolean {
  switch (cobertura.tipo) {
    case 'nenhuma':
      return false;
    case 'codex-comandos':
      return mapped.type === 'command.executed';
    case 'hook-por-sessao': {
      const tool = mapped.payload['tool'];
      return typeof tool === 'string' && cobertura.ferramentas.includes(tool);
    }
  }
}

interface VeredictoDeAcao {
  action: GuardedAction;
  risk: RiskLevel;
  reason: string;
  /** A ação bateu `pauseOn`, mas quem decide é o gate pré-execução: só registra. */
  peloGate?: true;
}

export interface VigilanciaVeredito {
  outcome: 'ok' | 'flagged' | 'paused';
  /** Ações flagged ANTES da que pausou (ou todas, se não pausou) — na ordem em que ocorreram. */
  flagged: VeredictoDeAcao[];
  /** Presente só quando `outcome === 'paused'`. */
  pausedBy?: VeredictoDeAcao;
}

/**
 * Decide o veredito de vigilância reativa para um evento — extraído de
 * `session-manager.ts#watch` (dívida arquitetural do arquivo grande).
 *
 * Puramente decisão: não emite evento nem abre aprovação (isso continua no
 * daemon, que é quem tem `store`/`bus`). Preserva o comportamento original —
 * short-circuit na primeira ação que bate `pauseOn` (ações seguintes nem são
 * classificadas), mas as ações ANTERIORES que bateram `flagOn` continuam
 * presentes em `flagged`, na mesma ordem, para o chamador emitir antes de
 * tratar a pausa.
 *
 * Evento que o gate pré-execução da sessão decide (`gateDecideOEvento`) nunca
 * pausa: o que bateria `pauseOn` vira só `flagged` com `peloGate`. Pausar ali
 * matava a sessão por uma chamada que o gate ainda ia perguntar (negar deve
 * negar só a chamada, e a sessão seguir) e rotulava de "executou" o que não
 * tinha rodado. Se o daemon não atender o hook, o modo de falha FECHADO das
 * sessões do Hub nega shell/escrita/rede (SECURITY.md, "Daemon
 * indisponível"; `modoDeFalhaEfetivo`) — a vigilância não é a rede de
 * segurança dele.
 */
export function avaliarVigilancia(
  mapped: MappedEvent,
  workdir: string,
  mode: SessionMode,
  engine: PolicyEngine,
  watch: WatchPolicy,
  /** Diretórios de trabalho do próprio agente (ver `agentOwnDirs` no core). */
  agentDirs: readonly string[] = [],
  cobertura: CoberturaDoGate = { tipo: 'nenhuma' },
): VigilanciaVeredito {
  const actions = guardedActionsOf(mapped, workdir);
  const flagged: VeredictoDeAcao[] = [];
  const peloGate = gateDecideOEvento(mapped, cobertura);

  for (const action of actions) {
    const { risk, reason } = engine.classify(action, { workdir, mode, agentDirs });

    if (peloGate && watch.pauseOn.includes(risk)) {
      flagged.push({ action, risk, reason, peloGate: true });
      continue;
    }

    if (watch.pauseOn.includes(risk)) {
      return { outcome: 'paused', flagged, pausedBy: { action, risk, reason } };
    }

    if (watch.flagOn.includes(risk)) {
      flagged.push({ action, risk, reason });
    }
  }

  return { outcome: flagged.length > 0 ? 'flagged' : 'ok', flagged };
}
