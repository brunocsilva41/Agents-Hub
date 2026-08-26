#!/usr/bin/env node
import path from 'node:path';
import { baseUrl, createHub, loadConfig } from '@agents-hub/daemon';
import { HubClient, type GraphSummary, type ProbeSummary } from './client.js';
import {
  bold,
  cyan,
  dim,
  formatTokens,
  green,
  red,
  renderEvent,
  renderGraph,
  stateBadge,
  yellow,
} from './render.js';

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Flags sem valor precisam ser declaradas: sem isso, `--detach "objetivo"`
 * consome o objetivo como valor de `--detach` e o comando falha dizendo que
 * faltou o objetivo — que estava lá o tempo todo.
 */
const BOOLEAN_FLAGS = new Set(['detach', 'json', 'force', 'help', 'quiet']);

function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] ?? '';
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    // Forma explícita `--chave=valor` sempre vence a heurística.
    const equals = token.indexOf('=');
    if (equals > 2) {
      flags[token.slice(2, equals)] = token.slice(equals + 1);
      continue;
    }

    const key = token.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }

    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }

  return { command, positional, flags };
}

const HELP = `
${bold('hub')} — plano de controle do Agents-Hub

${bold('Daemon')}
  hub daemon                        sobe o daemon em primeiro plano
  hub health                        verifica se o daemon responde

${bold('Agentes')}
  hub doctor                        checa quais agentes estão instalados
  hub agents                        lista agentes, capabilities e limitações

${bold('Projetos')}
  hub projects                      lista projetos registrados
  hub project add [caminho]         registra um repositório (padrão: diretório atual)

${bold('Sessões')}
  hub start --agent <id> "objetivo"          abre uma sessão-raiz e acompanha ao vivo
      --project <caminho>    projeto (padrão: diretório atual)
      --budget-usd <n>       teto de custo do fluxo inteiro
      --mode <supervised|semi|autonomous>
      --isolation <worktree|none>
      --detach               não acompanha o stream
  hub sessions                                lista sessões
  hub watch <sessionId>                       acompanha uma sessão ao vivo
  hub watch --root <rootId>                   acompanha o fluxo inteiro, todos os agentes
  hub send <sessionId> "texto"                fala com uma sessão
  hub interrupt <sessionId>                   para o turno atual
  hub cancel <sessionId>                      encerra a sessão e seus filhos

${bold('Delegação e custo')}
  hub delegate <sessionId> --agent <id> "objetivo"   um agente pede a outro
  hub graph <rootId>                                  árvore de quem chamou quem
  hub budget <rootId>                                 consumo contra o orçamento

${dim('Alvo do --agent aceita id (codex) ou capability (cap:test-writing).')}
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const client = new HubClient(baseUrl(config));

  switch (args.command) {
    case 'daemon':
      return runDaemon();
    case 'health':
      return withDaemon(async () => {
        console.log(JSON.stringify(await client.health(), null, 2));
      });
    case 'doctor':
      return withDaemon(() => doctor(client));
    case 'agents':
      return withDaemon(() => listAgents(client));
    case 'projects':
      return withDaemon(() => listProjects(client));
    case 'project':
      return withDaemon(() => projectCommand(client, args));
    case 'start':
      return withDaemon(() => start(client, args));
    case 'sessions':
      return withDaemon(() => listSessions(client));
    case 'watch':
      return withDaemon(() => watch(client, args));
    case 'send':
      return withDaemon(() => send(client, args));
    case 'interrupt':
      return withDaemon(async () => {
        await client.interrupt(required(args.positional[0], 'sessionId'));
        console.log(green('turno interrompido'));
      });
    case 'cancel':
      return withDaemon(async () => {
        await client.cancel(required(args.positional[0], 'sessionId'));
        console.log(green('sessão encerrada'));
      });
    case 'delegate':
      return withDaemon(() => delegate(client, args));
    case 'graph':
      return withDaemon(() => showGraph(client, args));
    case 'budget':
      return withDaemon(() => showBudget(client, args));
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    default:
      console.error(red(`comando desconhecido: ${args.command}`));
      console.log(HELP);
      process.exitCode = 1;
  }
}

// ---------------------------------------------------------------- daemon

async function runDaemon(): Promise<void> {
  const hub = createHub();
  const { host, port } = await hub.server.listen();
  console.log(green(`daemon ouvindo em ${baseUrl({ host, port })}`));
  console.log(dim(`home: ${hub.config.home}`));
  console.log(dim(`agentes: ${hub.registry.ids().join(', ')}`));

  const stop = async (): Promise<void> => {
    console.log(dim('\nencerrando sessões vivas…'));
    await hub.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

/** Mensagem útil em vez de um ECONNREFUSED cru quando o daemon não está de pé. */
async function withDaemon(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const message = (err as Error).message ?? '';
    if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
      console.error(red('daemon não está rodando.'), dim('suba com:'), bold('hub daemon'));
      process.exitCode = 1;
      return;
    }
    console.error(red(message));
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------- comandos

async function doctor(client: HubClient): Promise<void> {
  console.log(dim('checando agentes…\n'));
  const { probes } = await client.probeAgents();
  const { agents } = await client.agents();
  const hints = new Map(agents.map((a) => [a.id, a]));

  const ordered = [...probes].sort((a, b) => Number(b.installed) - Number(a.installed));
  for (const probe of ordered) {
    const agent = hints.get(probe.agentId);
    console.log(
      `${statusIcon(probe)} ${bold(probe.agentId.padEnd(13))} ${
        probe.installed ? dim(probe.version ?? 'versão desconhecida') : red('não instalado')
      }`,
    );
    if (probe.installed && probe.binPath) console.log(`   ${dim(probe.binPath)}`);
    if (!probe.installed && agent?.loginHint) console.log(`   ${dim(agent.loginHint)}`);
    if (probe.error) console.log(`   ${yellow(probe.error)}`);
  }

  const installed = probes.filter((p) => p.installed).length;
  console.log(
    `\n${installed} de ${probes.length} agentes disponíveis. ${dim(
      'Autenticação não é verificada aqui: checar custaria uma chamada real ao provedor.',
    )}`,
  );
}

function statusIcon(probe: ProbeSummary): string {
  if (!probe.installed) return red('✗');
  return probe.error ? yellow('!') : green('✓');
}

async function listAgents(client: HubClient): Promise<void> {
  const { agents } = await client.agents();
  for (const agent of agents) {
    const status = agent.probe?.installed === true ? green('●') : dim('○');
    console.log(`${status} ${bold(agent.id)} ${dim(`— ${agent.name} (${agent.vendor})`)}`);
    console.log(`   ${dim('capabilities:')} ${agent.capabilities.join(', ') || dim('nenhuma')}`);
    console.log(
      `   ${dim('sessão:')} ${agent.sessionStrategy}  ${dim('stream:')} ${agent.streamFormat}`,
    );
    for (const caveat of agent.caveats) console.log(`   ${yellow('⚠')} ${dim(caveat)}`);
    console.log();
  }
}

async function listProjects(client: HubClient): Promise<void> {
  const { projects } = await client.projects();
  if (projects.length === 0) {
    console.log(dim('nenhum projeto registrado. use:'), bold('hub project add'));
    return;
  }
  for (const project of projects) {
    console.log(`${bold(project.name)} ${dim(project.id)}\n   ${dim(project.path)}`);
  }
}

async function projectCommand(client: HubClient, args: Args): Promise<void> {
  const [sub, dir] = args.positional;
  if (sub !== 'add') {
    console.error(red('uso: hub project add [caminho]'));
    process.exitCode = 1;
    return;
  }
  const { project } = await client.addProject(path.resolve(dir ?? process.cwd()));
  console.log(`${green('registrado')} ${bold(project.name)} ${dim(project.id)}`);
}

async function resolveProjectId(client: HubClient, flag: string | boolean | undefined): Promise<string> {
  const target = path.resolve(typeof flag === 'string' ? flag : process.cwd());
  const { projects } = await client.projects();
  const found = projects.find((p) => p.path === target || p.id === flag);
  if (found) return found.id;
  // Registrar na hora evita o passo cerimonial de "adicione o projeto antes".
  const { project } = await client.addProject(target);
  return project.id;
}

async function start(client: HubClient, args: Args): Promise<void> {
  const objective = args.positional.join(' ').trim();
  if (objective.length === 0) {
    console.error(red('faltou o objetivo: hub start --agent claude "refatore o módulo X"'));
    process.exitCode = 1;
    return;
  }

  const agent = args.flags['agent'];
  if (typeof agent !== 'string') {
    console.error(red('--agent é obrigatório: você escolhe o principal a cada sessão (ADR 04.1)'));
    process.exitCode = 1;
    return;
  }

  const projectId = await resolveProjectId(client, args.flags['project']);
  const brief: Record<string, unknown> = {
    agent,
    objective,
    isolation: typeof args.flags['isolation'] === 'string' ? args.flags['isolation'] : 'worktree',
  };
  if (typeof args.flags['mode'] === 'string') brief['supervision'] = args.flags['mode'];
  if (typeof args.flags['budget-usd'] === 'string') {
    brief['budget'] = { usd: Number(args.flags['budget-usd']) };
  }

  const result = await client.startSession({ projectId, brief });
  console.log(`${green('sessão iniciada')} ${bold(result.session.id)} ${dim(`(${agent})`)}`);
  console.log(dim(`worktree: ${result.session.workdir}`));

  if (args.flags['detach'] === true) {
    console.log(dim(`acompanhe com: hub watch ${result.session.id}`));
    return;
  }

  console.log();
  await streamUntilDone(client, { rootId: result.session.rootId });
}

async function listSessions(client: HubClient): Promise<void> {
  const { sessions } = await client.sessions();
  if (sessions.length === 0) {
    console.log(dim('nenhuma sessão ainda.'));
    return;
  }
  for (const session of sessions.slice(0, 40)) {
    const indent = '  '.repeat(session.depth);
    console.log(
      `${indent}${bold(session.id)} ${cyan(session.agentId)} ${stateBadge(session.state)} ${dim(
        session.createdAt.slice(0, 19).replace('T', ' '),
      )}`,
    );
    if (session.title) console.log(`${indent}   ${dim(session.title)}`);
  }
}

async function watch(client: HubClient, args: Args): Promise<void> {
  const rootFlag = args.flags['root'];
  if (typeof rootFlag === 'string') {
    await streamUntilDone(client, { rootId: rootFlag });
    return;
  }
  const sessionId = required(args.positional[0], 'sessionId');
  await streamUntilDone(client, { sessionId });
}

/**
 * Acompanha o stream e devolve o terminal quando o fluxo termina.
 *
 * "Terminou" aqui é o fim da sessão-raiz — não o fim do primeiro agente:
 * num fluxo com delegação, o pai fecha depois dos filhos.
 */
async function streamUntilDone(
  client: HubClient,
  filter: { sessionId?: string; rootId?: string },
): Promise<void> {
  const rootId = filter.rootId;
  const showAgent = rootId !== undefined;

  for await (const event of client.stream(filter)) {
    console.log(renderEvent(event, { showAgent }));

    const isRootEnd =
      event.type === 'session.ended' &&
      (rootId === undefined || event.sessionId === rootId);
    const isTerminalTurn =
      (event.type === 'turn.completed' || event.type === 'error') &&
      (rootId === undefined ? true : event.sessionId === rootId);

    if (isRootEnd || isTerminalTurn) {
      if (rootId) {
        const { budget } = await client.budget(rootId);
        console.log(
          `\n${dim('custo do fluxo:')} US$ ${budget.consumed.usd.toFixed(4)} · ${formatTokens(
            budget.consumed.tokens,
          )} tokens ${dim(`(${Math.round(budget.pressure * 100)}% do orçamento)`)}`,
        );
      }
      return;
    }
  }
}

async function send(client: HubClient, args: Args): Promise<void> {
  const sessionId = required(args.positional[0], 'sessionId');
  const text = args.positional.slice(1).join(' ');
  if (text.length === 0) {
    console.error(red('uso: hub send <sessionId> "sua mensagem"'));
    process.exitCode = 1;
    return;
  }
  const { mode } = await client.send(sessionId, text);
  const explanation: Record<string, string> = {
    live: 'injetada na run em andamento',
    resume: 'sessão nativa retomada',
    replay: 'turno novo (o agente não guarda sessão nativa)',
  };
  console.log(dim(`${explanation[mode] ?? mode}\n`));
  await streamUntilDone(client, { sessionId });
}

async function delegate(client: HubClient, args: Args): Promise<void> {
  const sessionId = required(args.positional[0], 'sessionId');
  const objective = args.positional.slice(1).join(' ').trim();
  const agent = args.flags['agent'];

  if (typeof agent !== 'string' || objective.length === 0) {
    console.error(red('uso: hub delegate <sessionId> --agent <id|cap:x> "objetivo"'));
    process.exitCode = 1;
    return;
  }

  const brief: Record<string, unknown> = { agent, objective };
  if (typeof args.flags['budget-usd'] === 'string') {
    brief['budget'] = { usd: Number(args.flags['budget-usd']) };
  }

  const result = await client.delegate(sessionId, brief);
  console.log(
    `${green('delegado')} para ${bold(result.agentId)} ${dim(`sessão ${result.sessionId}`)}`,
  );
  console.log(dim(`acompanhe com: hub watch ${result.sessionId}`));
}

async function showGraph(client: HubClient, args: Args): Promise<void> {
  const rootId = required(args.positional[0], 'rootId');
  const { graph } = await client.graph(rootId);
  if (graph.length === 0) {
    console.log(dim('nenhuma sessão neste fluxo.'));
    return;
  }
  for (const line of renderGraph(graph)) console.log(line);
  console.log(`\n${dim('total do fluxo:')} US$ ${totalUsd(graph).toFixed(4)}`);
}

function totalUsd(nodes: GraphSummary[]): number {
  return nodes.reduce((sum, node) => sum + node.usd + totalUsd(node.children), 0);
}

async function showBudget(client: HubClient, args: Args): Promise<void> {
  const rootId = required(args.positional[0], 'rootId');
  const { budget } = await client.budget(rootId);
  const pct = Math.round(budget.pressure * 100);
  const bar = '█'.repeat(Math.min(30, Math.round(budget.pressure * 30))).padEnd(30, '░');
  const color = pct >= 90 ? red : pct >= 60 ? yellow : green;

  console.log(`${color(bar)} ${pct}%`);
  console.log(
    `${dim('custo:  ')} US$ ${budget.consumed.usd.toFixed(4)} / ${budget.limits.usd.toFixed(2)}`,
  );
  console.log(
    `${dim('tokens: ')} ${formatTokens(budget.consumed.tokens)} / ${formatTokens(budget.limits.tokens)}`,
  );
  console.log(`${dim('tempo:  ')} ${budget.consumed.seconds}s / ${budget.limits.seconds}s`);
  if (budget.exhausted) console.log(red('\norçamento esgotado — tasks entram em espera por você'));
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`argumento obrigatório ausente: ${name}`);
  }
  return value;
}

await main();
