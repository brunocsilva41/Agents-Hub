import type { BriefInput, HubClient } from './client.js';

/**
 * `hub doctor --smoke`: abre uma sessão real e trivial com cada agente
 * instalado, para provar que o Hub consegue de fato CONVERSAR com ele — não
 * só localizar o binário (o que `hub doctor` sem `--smoke` já faz).
 *
 * GASTA TOKENS/CRÉDITOS REAIS de cada provedor a cada execução. Isolado neste
 * módulo para que a lógica seja testável com um `HubClient` falso, sem nunca
 * precisar subir um agente de verdade — ver `doctor-smoke.test.ts`.
 */

export interface SmokeOutcome {
  agentId: string;
  /** A sessão chegou a existir no Hub (POST /sessions não rejeitou). */
  processStarted: boolean;
  /** Algum evento `turn.completed` apareceu na timeline da sessão. */
  turnCompleted: boolean;
  /** Custo (USD ou tokens) maior que zero foi capturado — na task ou no orçamento agregado. */
  costCaptured: boolean;
  /** `nativeSessionId` deixou de ser `null` — prova que o id nativo foi extraído do agente. */
  nativeSessionIdCaptured: boolean;
  /** Estado terminal da task, quando a espera não estourou o timeout. */
  finalState: string | null;
  /** Mensagem de erro, quando `processStarted` é falso ou a espera estourou. */
  error: string | null;
}

export interface SmokeOptions {
  projectId: string;
  /** Objetivo trivial e determinístico — fácil de julgar se a resposta veio. */
  objective?: string;
  /** Teto de espera pelo estado terminal, por agente. */
  timeoutMs?: number;
  /** Intervalo entre polls. */
  pollMs?: number;
}

export const SMOKE_OBJECTIVE_PADRAO = 'responda apenas com a palavra OK';
const TIMEOUT_PADRAO_MS = 90_000;
const POLL_PADRAO_MS = 1500;
const TERMINAIS = new Set(['completed', 'failed', 'canceled', 'rejected']);

/** Roda o smoke test de um único agente. Nunca lança — erro vira `outcome.error`. */
export async function smokeTestAgent(
  client: HubClient,
  agentId: string,
  options: SmokeOptions,
): Promise<SmokeOutcome> {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_PADRAO_MS;
  const pollMs = options.pollMs ?? POLL_PADRAO_MS;
  const objective = options.objective ?? SMOKE_OBJECTIVE_PADRAO;

  const outcome: SmokeOutcome = {
    agentId,
    processStarted: false,
    turnCompleted: false,
    costCaptured: false,
    nativeSessionIdCaptured: false,
    finalState: null,
    error: null,
  };

  const brief: BriefInput = {
    agent: agentId,
    objective,
    // Isolado em worktree: mesmo sendo um objetivo trivial, um smoke test não
    // deveria correr o risco de escrever no repositório real caso o agente
    // decida "ajudar" além do pedido.
    isolation: 'worktree',
    // O modo mais restritivo de propósito (ver doc do comando): se o agente
    // falhar em supervised por alguma restrição própria, isso também é sinal
    // útil — não queremos mascarar isso rodando em modo mais permissivo.
    supervision: 'supervised',
  };

  let sessionId: string;
  let rootId: string;
  try {
    const started = await client.startSession({ projectId: options.projectId, brief });
    sessionId = started.session.id;
    rootId = started.session.rootId;
    outcome.processStarted = true;
  } catch (err) {
    outcome.error = mensagemDeErro(err);
    return outcome;
  }

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { events } = await client.events(sessionId).catch(() => ({ events: [] }));
    if (events.some((e) => e.type === 'turn.completed')) outcome.turnCompleted = true;

    try {
      const { session } = await client.session(sessionId);
      if (session.nativeSessionId) outcome.nativeSessionIdCaptured = true;
    } catch {
      // sessão pode não estar consultável num poll específico — tenta de novo
    }

    const { tasks } = await client.tasks(sessionId).catch(() => ({ tasks: [] }));
    const task = tasks[0];
    if (task?.result?.usage && (task.result.usage.usd > 0 || task.result.usage.tokens > 0)) {
      outcome.costCaptured = true;
    }

    if (task && TERMINAIS.has(task.state)) {
      outcome.finalState = task.state;
      break;
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }

  if (outcome.finalState === null) {
    outcome.error = `sem estado terminal em ${Math.round(timeoutMs / 1000)}s`;
  }

  if (!outcome.costCaptured) {
    // O custo às vezes só se consolida no orçamento agregado do fluxo, não na
    // task individual — ex.: quando o agente reporta custo por evento em vez
    // de no resultado final.
    try {
      const { budget } = await client.budget(rootId);
      if (budget.consumed.usd > 0 || budget.consumed.tokens > 0) outcome.costCaptured = true;
    } catch {
      // sem orçamento consultável, o veredito de custo fica no que já foi capturado
    }
  }

  return outcome;
}

/**
 * Roda o smoke test de vários agentes com concorrência baixa — mesma
 * justificativa de `Registry.probeAll` (`packages/adapters/src/registry.ts`):
 * no Windows, subir vários CLIs de uma vez faz eles se atropelarem em disco e
 * antivírus.
 */
export async function smokeTestAll(
  client: HubClient,
  agentIds: string[],
  options: SmokeOptions,
  concurrency = 2,
): Promise<SmokeOutcome[]> {
  const results: SmokeOutcome[] = [];
  for (let i = 0; i < agentIds.length; i += concurrency) {
    const batch = agentIds.slice(i, i + concurrency);
    results.push(...(await Promise.all(batch.map((id) => smokeTestAgent(client, id, options)))));
  }
  return results;
}

function mensagemDeErro(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
