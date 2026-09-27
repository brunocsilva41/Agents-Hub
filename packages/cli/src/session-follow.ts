import { required } from './cmd-util.js';
import {
  HubApiError,
  InvalidHubIdError,
  type HubClient,
  type SessionSummary,
  type TaskSummary,
} from './client.js';
import {
  bold,
  deveExibir,
  dim,
  formatTokens,
  green,
  red,
  renderEvent,
  renderGraph,
  yellow,
} from './render.js';
import type { GraphSummary } from './client.js';
import type { EventEnvelope } from '@agents-hub/core';
import { criarAlertaDeAprovacao } from './approval-alert.js';

/**
 * Acompanhar sessões e fluxos ao vivo (`hub start`, `watch`, `send`) e as
 * consultas por id (`graph`, `budget`).
 *
 * Fica fora de `main.ts` para ser testável sem disparar `main()` no import.
 * Corrige a família de achados da vistoria 2026-09-25 (07, 13 e 14):
 *
 * - `hub watch <id inexistente>` abria o stream e ficava mudo para sempre;
 *   `budget`/`graph` de id inexistente respondiam zeros/"nenhuma sessão".
 * - `watch --root <fluxo terminado>` pendurava: o SSE por raiz não tem replay,
 *   então o evento de fim nunca chegava. Mesma corrida em `hub start` quando o
 *   agente terminava antes do stream abrir.
 * - `hub send` depois de `pause` reimprimia o histórico e parava no PRIMEIRO
 *   evento terminal antigo (o `error` do cancelamento), sem mostrar a resposta.
 * - `hub start` saía com código 0 com a sessão FALHA, e o fallback para outro
 *   agente seguia em segundo plano sem aviso (a task mudava de sessão e
 *   `tasks(sessionId)` vinha vazio, lido como "acabou").
 *
 * A saída agora não depende só do stream: um vigia consulta o estado da task
 * (por id, então segue o fallback) a cada `pollMs` e decide o fim.
 */

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

type Log = (linha: string) => void;

const NEWLINE = String.fromCharCode(10);
const TASK_TERMINAIS = new Set(['completed', 'failed', 'canceled', 'rejected']);
const SESSAO_TERMINAIS = new Set(['completed', 'failed', 'killed']);
const FIM_DE_TURNO = new Set(['turn.completed', 'error', 'session.ended']);

export type EstadoFinal =
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected'
  /** Parado esperando decisão humana (aprovação). */
  | 'blocked'
  /** Pausada por `hub pause`: nada roda até um `hub send`. */
  | 'paused'
  /** Stream caiu ou espera estourou sem estado conclusivo. */
  | 'unknown';

export interface Desfecho {
  estado: EstadoFinal;
  /** Sessão que estava sendo acompanhada no fim (muda num fallback). */
  sessionId: string;
}

/**
 * Código de saída do processo para o desfecho. Scripts e CI dependem disto:
 * 0 só quando a tarefa concluiu (ou foi pausada a pedido); 2 quando está
 * parada esperando você; 1 para falha, cancelamento ou desfecho desconhecido.
 */
export function codigoDeSaida(d: Desfecho): number {
  switch (d.estado) {
    case 'completed':
    case 'paused':
      return 0;
    case 'blocked':
      return 2;
    default:
      return 1;
  }
}

export interface OpcoesDeAcompanhamento {
  sessionId?: string;
  rootId?: string;
  /** Só com `sessionId`: eventos com `seq` maior que este (replay parcial). */
  since?: number;
  /** Task a seguir; sem ela, descobre pela sessão (inclusive após fallback). */
  taskId?: string;
  /** Intervalo do vigia que consulta o estado da task. */
  pollMs?: number;
  /** Quanto tempo aceitar "sem processo vivo e task aberta" antes de desistir. */
  esperaMaximaMs?: number;
  log?: Log;
  /** Chamado a cada evento do stream (alerta de aprovação, R14-14). */
  alertar?: (event: EventEnvelope) => void;
  /** `--verbose`: mostra também deltas, logs técnicos e eventos crus. */
  verbose?: boolean;
}

type Avaliacao =
  | { tipo: 'fim'; desfecho: Desfecho }
  | { tipo: 'trocar'; novaSessao: string; agentId: string }
  | { tipo: 'continuar' };

interface EstadoDoVigia {
  avisouValidacao: boolean;
  paradoDesde: number | null;
}

/**
 * Acompanha o stream até o fluxo ter um desfecho e devolve qual foi.
 *
 * "Terminou" é a TASK chegar a estado terminal (ou parar esperando alguém) —
 * não o turno acabar: depois dele ainda vêm o portão de validação e, se
 * reprovar, retry ou troca de agente.
 */
export async function acompanhar(client: HubClient, opts: OpcoesDeAcompanhamento): Promise<Desfecho> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const pollMs = opts.pollMs ?? 1500;
  const esperaMaximaMs = opts.esperaMaximaMs ?? 600_000;
  const rootId = opts.rootId;
  const porRaiz = rootId !== undefined;
  let alvo = opts.sessionId ?? rootId;
  if (alvo === undefined) throw new Error('acompanhar: informe sessionId ou rootId');

  let taskId = opts.taskId ?? (await taskDaSessao(client, alvo))?.id;
  let since = opts.since;
  const vigia: EstadoDoVigia = { avisouValidacao: false, paradoDesde: null };

  for (;;) {
    const filtro: { sessionId?: string; rootId?: string; since?: number } = porRaiz
      ? { rootId }
      : { sessionId: alvo, ...(since !== undefined ? { since } : {}) };
    const ac = new AbortController();
    const saida: { r: Avaliacao | null } = { r: null };
    let emCurso: Promise<void> | null = null;

    const checar = (): Promise<void> => {
      if (emCurso) return emCurso;
      emCurso = (async () => {
        if (saida.r !== null) return;
        const r = await avaliar(client, alvo as string, taskId, vigia, esperaMaximaMs, log);
        if (r.tipo === 'continuar') return;
        if (r.tipo === 'trocar') {
          log(
            yellow(
              `⚠ fallback: a tarefa saiu de ${alvo} e passou para ${bold(r.agentId)} ${dim(`(sessão ${r.novaSessao})`)} — acompanhando`,
            ),
          );
          alvo = r.novaSessao;
          vigia.paradoDesde = null;
          vigia.avisouValidacao = false;
          // Por raiz, o mesmo stream já traz a sessão substituta (mesmo
          // rootId). Por sessão, é preciso reabrir o stream na nova.
          if (porRaiz) return;
        }
        saida.r = r;
        ac.abort();
      })()
        .catch(() => {
          // consulta falhou neste ciclo (daemon ocupado): o próximo tenta de novo
        })
        .finally(() => {
          emCurso = null;
        });
      return emCurso;
    };

    const timer = setInterval(() => void checar(), pollMs);
    try {
      for await (const event of client.stream(filtro, ac.signal)) {
        if (deveExibir(event, { verbose: opts.verbose === true }))
          log(renderEvent(event, { showAgent: porRaiz }));
        opts.alertar?.(event);
        if (!porRaiz && event.sessionId === alvo) since = event.seq;
        if (
          event.sessionId === alvo &&
          (FIM_DE_TURNO.has(event.type) ||
            (event.type === 'log' && event.payload['fimDoProcesso'] === true))
        ) {
          void checar();
        }
      }
    } catch (err) {
      if (!ac.signal.aborted) throw err;
    } finally {
      clearInterval(timer);
      ac.abort();
    }
    // `emCurso` é atribuído dentro de `checar`; sem o cast o TypeScript o
    // estreita para `null` aqui e o `await` pareceria esperar nada.
    const pendente = emCurso as Promise<void> | null;
    if (pendente) await pendente;

    let r = saida.r;
    if (r === null) {
      // O stream terminou sozinho (daemon encerrando): uma última consulta.
      r = await avaliar(client, alvo, taskId, vigia, 0, log).catch(() => null);
      if (r === null || r.tipo === 'continuar') {
        log(dim('stream encerrado pelo daemon antes de a tarefa terminar.'));
        return { estado: 'unknown', sessionId: alvo };
      }
      if (r.tipo === 'trocar') {
        alvo = r.novaSessao;
        continue;
      }
    }
    if (r.tipo === 'fim') return r.desfecho;
    // Troca por sessão: reabre o stream desde o começo da substituta.
    since = undefined;
    taskId = taskId ?? (await taskDaSessao(client, alvo))?.id;
  }
}

/** Uma consulta do vigia: a tarefa terminou, trocou de sessão, ou segue? */
async function avaliar(
  client: HubClient,
  alvo: string,
  taskId: string | undefined,
  vigia: EstadoDoVigia,
  esperaMaximaMs: number,
  log: Log,
): Promise<Avaliacao> {
  let task: TaskSummary | undefined;
  let session: SessionSummary;
  let live: boolean;

  if (taskId !== undefined) {
    const st = await client.task(taskId);
    task = st.task;
    if (task.sessionId !== alvo) {
      return { tipo: 'trocar', novaSessao: task.sessionId, agentId: st.session.agentId };
    }
    session = st.session;
    live = st.live;
  } else {
    ({ session, live } = await client.session(alvo));
  }

  const fim = (estado: EstadoFinal): Avaliacao => ({
    tipo: 'fim',
    desfecho: { estado, sessionId: alvo },
  });

  if (task?.state === 'input_required' || (!live && session.state === 'waiting_approval')) {
    await relatarBloqueio(client, alvo, log);
    return fim('blocked');
  }

  if (task && TASK_TERMINAIS.has(task.state)) {
    relatarValidacao(task, log);
    await relatarCusto(client, session.rootId, log);
    return fim(task.state as EstadoFinal);
  }

  if (!task && SESSAO_TERMINAIS.has(session.state) && !live) {
    await relatarCusto(client, session.rootId, log);
    return fim(
      session.state === 'completed' ? 'completed' : session.state === 'killed' ? 'canceled' : 'failed',
    );
  }

  if (live) {
    vigia.paradoDesde = null;
    return { tipo: 'continuar' };
  }

  if (session.state === 'paused') {
    log(`${NEWLINE}${yellow('⏸ sessão pausada')} ${dim(`— retome com: hub send ${alvo} "mensagem"`)}`);
    return fim('paused');
  }

  // Sessão sem task (adotada: o agente roda fora do Hub) não tem o que esperar
  // além do stream.
  if (!task) return { tipo: 'continuar' };

  // Sem processo vivo e a task aberta: portão de validação, backoff de retry.
  if (!vigia.avisouValidacao) {
    log(dim('… aguardando o portão de validação'));
    vigia.avisouValidacao = true;
  }
  const agora = Date.now();
  vigia.paradoDesde ??= agora;
  if (agora - vigia.paradoDesde >= esperaMaximaMs) {
    log(
      yellow(
        `a tarefa continua em "${task.state}" sem processo vivo — acompanhe com: hub watch ${alvo}`,
      ),
    );
    return fim('unknown');
  }
  return { tipo: 'continuar' };
}

/**
 * A task da sessão. Depois de um fallback ela mora na sessão substituta
 * (mesmo pai, mesmo rootId) e `tasks(sessionId)` da original vem vazio.
 */
async function taskDaSessao(client: HubClient, sessionId: string): Promise<TaskSummary | undefined> {
  const { tasks } = await client.tasks(sessionId).catch(() => ({ tasks: [] as TaskSummary[] }));
  if (tasks[0]) return tasks[0];
  try {
    const { session } = await client.session(sessionId);
    const { sessions } = await client.sessions({ rootId: session.rootId });
    const substitutas = sessions
      .filter(
        (s) =>
          s.id !== session.id && s.parentId === session.parentId && s.createdAt >= session.createdAt,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const s of substitutas) {
      const { tasks: dela } = await client.tasks(s.id).catch(() => ({ tasks: [] as TaskSummary[] }));
      const achada = dela.find((t) => t.attempts.some((a) => a.agentId === session.agentId));
      if (achada) return achada;
    }
  } catch {
    // sem como descobrir: acompanha só pela sessão
  }
  return undefined;
}

async function relatarBloqueio(client: HubClient, sessionId: string, log: Log): Promise<void> {
  const { approvals } = await client.approvals(sessionId).catch(() => ({ approvals: [] }));
  const pendente = approvals[0];
  log(`${NEWLINE}${yellow('⏸ bloqueado, esperando você')}`);
  if (pendente) {
    log(`   ${pendente.action} ${dim(`[${pendente.risk}]`)}`);
    log(
      `${NEWLINE}   ${bold(`hub approve ${pendente.id}`)}   ${dim('ou')}   ${bold(`hub deny ${pendente.id}`)}`,
    );
  } else {
    log(dim('   nenhuma aprovação registrada — veja `hub approvals`'));
  }
}

function relatarValidacao(task: TaskSummary, log: Log): void {
  const validacao = task.result?.validation;
  if (!validacao) return;
  for (const check of validacao.checks) {
    log(
      `${check.passed ? green('✓') : red('✗')} validação: ${check.name}${check.detail ? dim(` — ${check.detail}`) : ''}`,
    );
  }
}

async function relatarCusto(client: HubClient, rootId: string, log: Log): Promise<void> {
  try {
    const { budget } = await client.budget(rootId);
    log(
      `${NEWLINE}${dim('custo do fluxo:')} US$ ${budget.consumed.usd.toFixed(4)} · ${formatTokens(
        budget.consumed.tokens,
      )} tokens ${dim(`(${Math.round(budget.pressure * 100)}% do orçamento)`)}`,
    );
  } catch {
    // custo é informativo; não derruba o desfecho
  }
}

/** Mensagem final de uma linha para o desfecho (vai para stderr quando é falha). */
export function relatarDesfecho(d: Desfecho, log: Log, logErro: Log): void {
  switch (d.estado) {
    case 'completed':
      log(green('✓ tarefa concluída'));
      return;
    case 'blocked':
    case 'paused':
      return;
    case 'unknown':
      logErro(yellow('desfecho desconhecido — a tarefa pode seguir no daemon (hub sessions)'));
      return;
    default:
      logErro(red(`✗ tarefa terminou como "${d.estado}" (sessão ${d.sessionId})`));
  }
}

// ------------------------------------------------------------- comandos

export interface OpcoesDeComando {
  log?: Log;
  logErro?: Log;
  pollMs?: number;
  /** Alerta de aprovação; padrão: bipe + título no TTY, salvo `--no-bell`. */
  alertar?: (event: EventEnvelope) => void;
}

/** Alerta de aprovação do comando (R14-14). */
export function alertaDe(
  args: Args,
  o: { alertar?: (event: EventEnvelope) => void },
): (event: EventEnvelope) => void {
  return o.alertar ?? criarAlertaDeAprovacao({ desligado: args.flags['no-bell'] === true });
}

/**
 * Sessão por id, ou erro claro. Id malformado e inexistente viram a mesma
 * mensagem com a dica de onde achar os ids — antes, `watch` pendurava e
 * `budget`/`graph` respondiam zeros.
 */
export async function sessaoOuErro(
  client: HubClient,
  id: string,
): Promise<{ session: SessionSummary; live: boolean }> {
  try {
    return await client.session(id);
  } catch (err) {
    if (err instanceof InvalidHubIdError || (err instanceof HubApiError && err.status === 404)) {
      throw new HubApiError(
        `sessão "${id}" não encontrada — veja os ids com: hub sessions`,
        'SESSION_NOT_FOUND',
        404,
      );
    }
    throw err;
  }
}

/** Raiz do fluxo de `id`, avisando quando `id` é uma sessão filha. */
async function raizDoFluxo(client: HubClient, id: string, log: Log): Promise<string> {
  const { session } = await sessaoOuErro(client, id);
  if (session.rootId !== session.id) {
    log(dim(`${id} é uma sessão filha; usando o fluxo da raiz ${session.rootId}`));
  }
  return session.rootId;
}

function aplicarSaida(d: Desfecho, o: OpcoesDeComando): void {
  const log = o.log ?? ((l: string) => console.log(l));
  const logErro = o.logErro ?? ((l: string) => console.error(l));
  relatarDesfecho(d, log, logErro);
  const codigo = codigoDeSaida(d);
  if (codigo !== 0) process.exitCode = codigo;
}

export async function watchCommand(
  client: HubClient,
  args: Args,
  o: OpcoesDeComando = {},
): Promise<Desfecho> {
  const log = o.log ?? ((l: string) => console.log(l));
  const rootFlag = args.flags['root'];
  if (rootFlag === true) throw new Error('--root precisa do id: hub watch --root <rootId>');

  let desfecho: Desfecho;
  if (typeof rootFlag === 'string') {
    const rootId = await raizDoFluxo(client, rootFlag, log);
    const { session, live } = await client.session(rootId);
    if (!live && SESSAO_TERMINAIS.has(session.state)) {
      // O SSE por raiz não tem replay: para um fluxo já encerrado, o resumo.
      log(dim(`o fluxo já terminou (${session.state}) — resumo:`));
      const { graph } = await client.graph(rootId);
      for (const linha of renderGraph(graph)) log(linha);
    }
    desfecho = await acompanhar(client, {
      rootId,
      log,
      pollMs: o.pollMs,
      alertar: alertaDe(args, o),
      verbose: args.flags['verbose'] === true,
    });
  } else {
    const sessionId = required(args.positional[0], 'sessionId');
    await sessaoOuErro(client, sessionId);
    desfecho = await acompanhar(client, {
      sessionId,
      log,
      pollMs: o.pollMs,
      alertar: alertaDe(args, o),
      verbose: args.flags['verbose'] === true,
    });
  }
  aplicarSaida(desfecho, o);
  return desfecho;
}

export async function sendCommand(
  client: HubClient,
  args: Args,
  o: OpcoesDeComando = {},
): Promise<Desfecho | null> {
  const log = o.log ?? ((l: string) => console.log(l));
  const sessionId = required(args.positional[0], 'sessionId');
  const text = args.positional.slice(1).join(' ');
  if (text.length === 0) {
    (o.logErro ?? ((l: string) => console.error(l)))(red('uso: hub send <sessionId> "sua mensagem"'));
    process.exitCode = 1;
    return null;
  }
  await sessaoOuErro(client, sessionId);

  // Marca onde o histórico estava ANTES de mandar: o que interessa é a
  // resposta nova. Sem isto, o replay parava no fim do turno antigo.
  const { events } = await client.events(sessionId, { tail: true, limit: 1 });
  const since = events.at(-1)?.seq ?? 0;

  const { mode } = await client.send(sessionId, text);
  const explicacao: Record<string, string> = {
    live: 'injetada na run em andamento',
    resume: 'sessão nativa retomada',
    replay: 'turno novo (o agente não guarda sessão nativa)',
  };
  log(dim(`${explicacao[mode] ?? mode}${NEWLINE}`));
  const desfecho = await acompanhar(client, {
    sessionId,
    since,
    log,
    pollMs: o.pollMs,
    alertar: alertaDe(args, o),
    verbose: args.flags['verbose'] === true,
  });
  aplicarSaida(desfecho, o);
  return desfecho;
}

export async function graphCommand(
  client: HubClient,
  args: Args,
  o: OpcoesDeComando = {},
): Promise<void> {
  const log = o.log ?? ((l: string) => console.log(l));
  const rootId = await raizDoFluxo(client, required(args.positional[0], 'rootId'), log);
  const { graph } = await client.graph(rootId);
  if (graph.length === 0) {
    log(dim('nenhuma sessão neste fluxo.'));
    return;
  }
  for (const line of renderGraph(graph)) log(line);
  log(`${NEWLINE}${dim('total do fluxo:')} US$ ${totalUsd(graph).toFixed(4)}`);
}

function totalUsd(nodes: GraphSummary[]): number {
  return nodes.reduce((sum, node) => sum + node.usd + totalUsd(node.children), 0);
}

export async function budgetCommand(
  client: HubClient,
  args: Args,
  o: OpcoesDeComando = {},
): Promise<void> {
  const log = o.log ?? ((l: string) => console.log(l));
  const rootId = await raizDoFluxo(client, required(args.positional[0], 'rootId'), log);
  const { budget } = await client.budget(rootId);
  const pct = Math.round(budget.pressure * 100);
  const bar = '█'.repeat(Math.min(30, Math.round(budget.pressure * 30))).padEnd(30, '░');
  const color = pct >= 90 ? red : pct >= 60 ? yellow : green;

  log(`${color(bar)} ${pct}%`);
  log(`${dim('custo:  ')} US$ ${budget.consumed.usd.toFixed(4)} / ${budget.limits.usd.toFixed(2)}`);
  log(
    `${dim('tokens: ')} ${formatTokens(budget.consumed.tokens)} / ${formatTokens(budget.limits.tokens)}`,
  );
  log(`${dim('tempo:  ')} ${budget.consumed.seconds}s / ${budget.limits.seconds}s`);
  if (budget.exhausted) log(red(`${NEWLINE}orçamento esgotado — tasks entram em espera por você`));
}
