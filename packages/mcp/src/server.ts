import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { HubApiError, type BriefInput, type HubClient } from '@agents-hub/client';
import type { CallerIdentity } from './caller.js';
import { formatBudget, formatEvents, formatGraph, formatTaskStatus, formatTokens } from './format.js';

const TERMINAL_STATES = new Set(['completed', 'failed', 'canceled', 'rejected']);

/** Formato de `CallToolResult` do MCP — a index signature é exigida pelo SDK. */
interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

/**
 * As tools que o Hub dá a QUALQUER agente.
 *
 * MCP é o único denominador comum entre os oito CLIs do MVP — é por isso que
 * o Hub se expõe primeiro por aqui, e não por A2A ou ACP: uma vez registrado,
 * o Cursor passa a poder chamar o Claude, que chama o Codex, sem que nenhum
 * deles saiba da existência dos outros.
 */
export function buildMcpServer(client: HubClient, caller: CallerIdentity): McpServer {
  const server = new McpServer(
    { name: 'agents-hub', version: '0.1.0' },
    {
      instructions: [
        'O Agents-Hub deixa você delegar trabalho para outros agentes de IA',
        '(Claude Code, Codex, Cursor, Copilot, OpenCode, Antigravity, Kimi, MiMo).',
        '',
        'Como usar bem:',
        '- Delegue quando outro agente for claramente melhor na tarefa, ou quando',
        '  duas frentes independentes puderem correr em paralelo. Não delegue o que',
        '  você resolve mais rápido sozinho: cada delegação custa tempo e tokens.',
        '- `hub_agent_call` retorna na hora com um task_id; o trabalho roda em',
        '  background, num git worktree isolado. Siga trabalhando e consulte depois',
        '  com `hub_agent_status`, ou bloqueie de propósito com `hub_agent_wait`.',
        '- Escreva o objetivo como se o outro agente não soubesse nada do que você',
        '  está fazendo — porque ele realmente não sabe. Ele começa com contexto',
        '  limpo, recebendo apenas o que você colocar no brief.',
        '- O orçamento é do fluxo inteiro e é compartilhado: o que você gastar,',
        '  falta para os outros.',
      ].join('\n'),
    },
  );

  // ------------------------------------------------------------------ listar
  server.registerTool(
    'hub_agent_list',
    {
      title: 'Listar agentes disponíveis',
      description:
        'Lista os agentes de IA que o Hub pode acionar, com suas capabilities, se estão ' +
        'instalados e limitações conhecidas. Use antes de delegar quando não souber quem ' +
        'é o melhor alvo para a tarefa.',
      inputSchema: {
        capability: z
          .string()
          .optional()
          .describe('filtra por capability, ex.: "test-writing", "refactor", "shell"'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ capability }): Promise<ToolResult> => {
      try {
        const { agents } = await client.agents();
        const filtered = capability
          ? agents.filter((a) => a.capabilities.includes(capability))
          : agents;

        if (filtered.length === 0) {
          return ok(`nenhum agente com a capability "${capability ?? ''}"`);
        }

        return ok(
          filtered
            .map((agent) => {
              const status = agent.probe?.installed === true ? 'disponível' : 'NÃO INSTALADO';
              const caveats =
                agent.caveats.length > 0 ? `\n  limitações: ${agent.caveats.join('; ')}` : '';
              return `${agent.id} [${status}] — ${agent.name}\n  capabilities: ${agent.capabilities.join(', ')}${caveats}`;
            })
            .join('\n'),
        );
      } catch (err) {
        return fail(describe(err));
      }
    },
  );

  // ----------------------------------------------------------------- delegar
  server.registerTool(
    'hub_agent_call',
    {
      title: 'Delegar tarefa a outro agente',
      description:
        'Delega uma tarefa a outro agente de IA e retorna IMEDIATAMENTE com um task_id — ' +
        'o trabalho roda em background, num git worktree isolado, sem interferir no seu. ' +
        'Acompanhe depois com hub_agent_status/hub_agent_wait. ' +
        'O agente que receber a tarefa começa com contexto limpo: escreva o objetivo ' +
        'de forma autossuficiente. Use "cap:<capability>" no lugar do id para deixar o ' +
        'Hub escolher o agente (ex.: "cap:test-writing").',
      inputSchema: {
        agent: z
          .string()
          .describe('id do agente (ex.: "codex", "claude") ou "cap:<capability>"'),
        objective: z
          .string()
          .min(8)
          .describe('a tarefa, no imperativo e autossuficiente. Um objetivo por chamada'),
        acceptance_criteria: z
          .array(z.string())
          .optional()
          .describe('como você vai validar a entrega; também alimenta o portão de validação'),
        constraints: z
          .array(z.string())
          .optional()
          .describe('o que o agente NÃO deve fazer, ex.: "não tocar em migrations"'),
        artifacts: z
          .array(
            z.object({
              path: z.string(),
              mode: z.enum(['read', 'write']).optional(),
              note: z.string().optional(),
            }),
          )
          .optional()
          .describe('arquivos relevantes para a tarefa'),
        context_refs: z
          .array(z.string())
          .optional()
          .describe(
            'ponteiros de contexto no formato "session:<id>#event:<seq>". O agente destino ' +
              'pode buscá-los com hub_context_fetch se precisar',
          ),
        budget_usd: z
          .number()
          .positive()
          .optional()
          .describe('teto de custo desta delegação, descontado do orçamento do fluxo'),
        isolation: z
          .enum(['worktree', 'none'])
          .optional()
          .describe('"worktree" (padrão) isola em checkout próprio; "none" usa o repo direto'),
        supervision: z
          .enum(['supervised', 'semi', 'autonomous'])
          .optional()
          .describe('nunca aumenta o nível de autonomia acima do seu'),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async (args): Promise<ToolResult> => {
      try {
        const callerSessionId = await caller.resolve();

        const brief: BriefInput = {
          agent: args.agent,
          objective: args.objective,
          acceptanceCriteria: args.acceptance_criteria,
          constraints: args.constraints,
          artifacts: args.artifacts,
          contextRefs: args.context_refs,
          isolation: args.isolation,
          supervision: args.supervision,
          budget: args.budget_usd === undefined ? undefined : { usd: args.budget_usd },
        };

        const result = await client.delegate(callerSessionId, brief);

        return ok(
          [
            `delegado para ${result.agentId}`,
            `task_id: ${result.taskId}`,
            `session_id: ${result.sessionId}`,
            `estado: ${result.state} (rodando em background)`,
            formatBudget(result.budget),
            '',
            'Siga com seu trabalho. Consulte com hub_agent_status(task_id) quando quiser,',
            'ou use hub_agent_wait(task_id) se precisar do resultado para continuar.',
          ].join('\n'),
        );
      } catch (err) {
        return fail(explainDelegationFailure(err));
      }
    },
  );

  // ------------------------------------------------------------------ status
  server.registerTool(
    'hub_agent_status',
    {
      title: 'Consultar uma tarefa delegada',
      description:
        'Estado atual de uma tarefa delegada: se terminou, o que produziu, quanto custou ' +
        'e quanto resta do orçamento do fluxo. Não bloqueia.',
      inputSchema: { task_id: z.string().describe('o task_id devolvido por hub_agent_call') },
      annotations: { readOnlyHint: true },
    },
    async ({ task_id }): Promise<ToolResult> => {
      try {
        return ok(formatTaskStatus(await client.task(task_id)));
      } catch (err) {
        return fail(describe(err));
      }
    },
  );

  // ------------------------------------------------------------------ esperar
  server.registerTool(
    'hub_agent_wait',
    {
      title: 'Esperar uma tarefa delegada terminar',
      description:
        'Bloqueia até a tarefa chegar a um estado terminal ou até estourar o timeout. ' +
        'Use quando você REALMENTE precisa do resultado para continuar — se puder seguir ' +
        'trabalhando, prefira hub_agent_status, que não desperdiça tempo de parede. ' +
        'Ao estourar o timeout, a tarefa continua rodando: só a espera termina.',
      inputSchema: {
        task_id: z.string(),
        timeout_seconds: z
          .number()
          .int()
          .positive()
          .max(1800)
          .optional()
          .describe('padrão 300s'),
      },
    },
    async ({ task_id, timeout_seconds }): Promise<ToolResult> => {
      const timeoutMs = (timeout_seconds ?? 300) * 1000;
      const deadline = Date.now() + timeoutMs;

      try {
        // Backoff crescente: tarefas longas não precisam ser consultadas a cada
        // segundo, e cada consulta é uma requisição no daemon.
        let intervalMs = 1500;
        for (;;) {
          const status = await client.task(task_id);
          if (TERMINAL_STATES.has(status.task.state) || status.task.state === 'input_required') {
            return ok(formatTaskStatus(status));
          }
          if (Date.now() >= deadline) {
            return ok(
              `${formatTaskStatus(status)}\n\n` +
                `A espera de ${timeout_seconds ?? 300}s terminou, mas a TAREFA CONTINUA RODANDO. ` +
                `Consulte de novo com hub_agent_status("${task_id}").`,
            );
          }
          await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
          intervalMs = Math.min(intervalMs * 1.4, 10_000);
        }
      } catch (err) {
        return fail(describe(err));
      }
    },
  );

  // ------------------------------------------------------------------ eventos
  server.registerTool(
    'hub_agent_events',
    {
      title: 'Ver o que um agente está fazendo',
      description:
        'Eventos de uma sessão: mensagens, comandos executados, arquivos alterados e erros. ' +
        'Use para acompanhar de perto uma delegação em andamento e interromper cedo se ' +
        'ela estiver indo para o lado errado.',
      inputSchema: {
        session_id: z.string().describe('o session_id devolvido por hub_agent_call'),
        since: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('só eventos com seq maior que este — para paginar sem reler tudo'),
        verbose: z
          .boolean()
          .optional()
          .describe('inclui raciocínio e logs internos (bem mais caro em tokens)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ session_id, since, verbose }): Promise<ToolResult> => {
      try {
        const { events } = await client.events(session_id, { since, limit: 200 });
        const lastSeq = events.at(-1)?.seq;
        const body = formatEvents(events, verbose === true);
        return ok(lastSeq === undefined ? body : `${body}\n\n[último seq: ${lastSeq}]`);
      } catch (err) {
        return fail(describe(err));
      }
    },
  );

  // ----------------------------------------------------------------- cancelar
  server.registerTool(
    'hub_agent_cancel',
    {
      title: 'Cancelar uma delegação',
      description:
        'Encerra uma sessão delegada e tudo que ela tiver delegado abaixo. Use quando o ' +
        'agente estiver claramente no caminho errado — deixar rodando só queima orçamento ' +
        'do fluxo, que é compartilhado com você.',
      inputSchema: {
        session_id: z.string(),
        reason: z.string().optional().describe('por que está cancelando (fica na auditoria)'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ session_id, reason }): Promise<ToolResult> => {
      try {
        await client.cancel(session_id, reason ?? 'cancelado pelo agente chamador');
        return ok(`sessão ${session_id} encerrada, junto com o que ela havia delegado`);
      } catch (err) {
        return fail(describe(err));
      }
    },
  );

  // ------------------------------------------------------------------ falar
  server.registerTool(
    'hub_session_send',
    {
      title: 'Enviar mensagem a uma sessão',
      description:
        'Manda uma mensagem para uma sessão delegada — corrigir o rumo, dar contexto novo ' +
        'ou responder uma dúvida — sem perder o trabalho já feito.',
      inputSchema: { session_id: z.string(), text: z.string().min(1) },
    },
    async ({ session_id, text }): Promise<ToolResult> => {
      try {
        const { mode } = await client.send(session_id, text);
        const explanation = {
          live: 'injetada na execução em andamento',
          resume: 'sessão nativa do agente retomada com a mensagem',
          replay: 'novo turno aberto (este agente não guarda sessão nativa)',
        }[mode];
        return ok(`mensagem entregue — ${explanation}`);
      } catch (err) {
        return fail(describe(err));
      }
    },
  );

  // ----------------------------------------------------------------- sessões
  server.registerTool(
    'hub_session_list',
    {
      title: 'Listar sessões',
      description:
        'Sessões conhecidas pelo Hub, com agente, estado e profundidade. Útil para ' +
        'reencontrar uma delegação cujo id você perdeu.',
      inputSchema: {
        only_active: z.boolean().optional().describe('só as que ainda estão rodando'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ only_active }): Promise<ToolResult> => {
      try {
        const { sessions } = await client.sessions();
        const filtered = only_active
          ? sessions.filter((s) => s.state === 'running' || s.state === 'waiting_approval')
          : sessions;

        if (filtered.length === 0) return ok('nenhuma sessão');

        return ok(
          filtered
            .slice(0, 40)
            .map(
              (s) =>
                `${'  '.repeat(s.depth)}${s.id} · ${s.agentId} · ${s.state}` +
                (s.title ? `\n${'  '.repeat(s.depth)}  ${s.title}` : ''),
            )
            .join('\n'),
        );
      } catch (err) {
        return fail(describe(err));
      }
    },
  );

  // ------------------------------------------------------------------- grafo
  server.registerTool(
    'hub_graph',
    {
      title: 'Ver o grafo do fluxo',
      description:
        'Árvore de quem chamou quem no fluxo atual, com estado e custo por nó. ' +
        'Mostra também quanto do orçamento compartilhado já foi consumido.',
      inputSchema: {
        root_id: z
          .string()
          .optional()
          .describe('raiz do fluxo; se omitido, usa o fluxo do qual você faz parte'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ root_id }): Promise<ToolResult> => {
      try {
        let rootId = root_id;
        if (!rootId) {
          const sessionId = await caller.resolve();
          rootId = (await client.session(sessionId)).session.rootId;
        }

        const [{ graph }, { budget }] = await Promise.all([
          client.graph(rootId),
          client.budget(rootId),
        ]);

        if (graph.length === 0) return ok('fluxo sem sessões registradas');
        return ok(`${formatGraph(graph)}\n\n${formatBudget(budget)}`);
      } catch (err) {
        return fail(describe(err));
      }
    },
  );

  // ---------------------------------------------------------------- contexto
  server.registerTool(
    'hub_context_fetch',
    {
      title: 'Buscar contexto referenciado',
      description:
        'Resolve uma referência de contexto ("session:<id>#event:<seq>") que veio no seu ' +
        'brief e devolve os eventos ao redor dela. A delegação passa ponteiros em vez de ' +
        'texto: busque só o que você realmente precisar ver.',
      inputSchema: {
        ref: z.string().describe('ex.: "session:ses_abc#event:42" ou "session:ses_abc"'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ ref }): Promise<ToolResult> => {
      try {
        const { events } = await client.context(ref);
        return ok(formatEvents(events, true));
      } catch (err) {
        return fail(describe(err));
      }
    },
  );

  // ---------------------------------------------------------------- orçamento
  server.registerTool(
    'hub_budget',
    {
      title: 'Consultar o orçamento do fluxo',
      description:
        'Quanto o fluxo inteiro já consumiu e quanto resta. O orçamento é compartilhado ' +
        'entre você e todos os agentes que você acionar — consulte antes de delegar tarefas caras.',
      inputSchema: { root_id: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ root_id }): Promise<ToolResult> => {
      try {
        let rootId = root_id;
        if (!rootId) {
          const sessionId = await caller.resolve();
          rootId = (await client.session(sessionId)).session.rootId;
        }
        const { budget } = await client.budget(rootId);
        return ok(
          `${formatBudget(budget)}\nrestante: US$ ${budget.remaining.usd.toFixed(4)} · ${formatTokens(
            budget.remaining.tokens,
          )} tokens`,
        );
      } catch (err) {
        return fail(describe(err));
      }
    },
  );

  return server;
}

/**
 * Erros de delegação são os que o agente chamador mais precisa entender — se a
 * mensagem for críptica, ele tenta de novo em loop e queima o orçamento.
 */
function explainDelegationFailure(err: unknown): string {
  if (!(err instanceof HubApiError)) return describe(err);

  switch (err.code) {
    case 'DEPTH_EXCEEDED':
      return `${err.message}\nA cadeia de delegação já está no limite. Resolva esta parte você mesmo em vez de repassar adiante.`;
    case 'CYCLE_DETECTED':
      return `${err.message}\nEste agente já recebeu exatamente este objetivo nesta cadeia. Reformule a tarefa ou escolha outro agente.`;
    case 'BUDGET_EXCEEDED':
      return `${err.message}\nPeça um teto menor com budget_usd, ou avise seu usuário de que o orçamento do fluxo acabou.`;
    case 'CONCURRENCY_EXCEEDED':
      return `${err.message}\nEspere uma das delegações em andamento terminar (hub_session_list com only_active) antes de abrir outra.`;
    case 'AGENT_NOT_FOUND':
    case 'CAPABILITY_UNRESOLVED':
      return `${err.message}\nUse hub_agent_list para ver quem está realmente disponível.`;
    case 'AGENT_NOT_INSTALLED':
      return `${err.message}\nEste agente não está instalado nesta máquina. Escolha outro.`;
    default:
      return err.message;
  }
}

function describe(err: unknown): string {
  if (err instanceof HubApiError) return `${err.code}: ${err.message}`;
  const message = (err as Error)?.message ?? String(err);
  if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
    return 'O daemon do Agents-Hub não está rodando. Peça ao seu usuário para executar "hub daemon".';
  }
  return message;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
