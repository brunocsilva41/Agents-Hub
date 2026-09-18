#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { baseUrl, createHub, instalarRedeDeSeguranca, loadConfig } from '@agents-hub/daemon';
import { HubClient, type BriefInput, type GraphSummary, type ProbeSummary } from './client.js';
import { ensureDaemon } from './daemon-control.js';
import { decideToolCall, lerStdin, type HookInput } from './hook.js';
import {
  HOOK_TARGETS,
  MATCHER_DE_RISCO,
  gravarConfig,
  hookCommand,
  hookInstalado,
  lerConfig,
  mergeHooks,
} from './hooks-install.js';
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
import {
  MCP_TARGETS,
  mcpEntrypoint,
  renderSnippet,
  resolveConfigPath,
  serverSpec,
  writeConfig,
} from './mcp-install.js';
import { workflowCommand } from './workflow-cmd.js';

/** Quebra de linha literal, para não brigar com escapes em template string. */
const NEWLINE = String.fromCharCode(10);

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
const BOOLEAN_FLAGS = new Set(['detach', 'json', 'force', 'help', 'quiet', 'write']);

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

${bold('Daemon')} ${dim('(sobe sozinho quando algum comando precisa)')}
  hub status                        agentes, sessões vivas e o que espera você
  hub daemon                        roda em primeiro plano, para ver os logs
  hub stop                          encerra o daemon e as sessões vivas
  hub health                        resposta crua da API

${bold('Gate pré-execução')} ${dim('(bloqueia a ferramenta ANTES de ela rodar)')}
  hub hooks install claude --write   registra o hook PreToolUse no Claude Code
  hub hooks                          mostra onde o gate está instalado
  hub hook [--dialect codex]         uso interno: o agente chama, não você

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
  hub handoff <sessionId> --to <id>                  transfere a liderança da sessão
  hub diff <sessionId>                                o que o agente mudou no código
  hub graph <rootId>                                  árvore de quem chamou quem
  hub budget <rootId>                                 consumo contra o orçamento

${bold('Aprovações e manutenção')}
  hub approvals                      o que está esperando sua decisão
  hub approve <id>                   libera e a sessão continua de onde parou
  hub deny <id>                      nega e encerra a sessão
  hub prune                          recolhe worktrees de sessões já expiradas

${bold('Workflows (DAG de múltiplos agentes)')}
  hub workflow validate <arquivo.yaml>       valida sintaxe, dependências e ciclos
  hub workflow run <arquivo.yaml>            executa o workflow em lotes paralelos

${bold('MCP — dar ao agente o poder de chamar os outros')}
  hub mcp                            mostra o estado do registro em cada agente
  hub mcp show <agente>              imprime o trecho de config para colar
  hub mcp install <agente> --write   grava a config (com backup .bak e merge)
      --project <caminho>    para agentes com config por projeto (Claude Code)

${dim('Alvo do --agent aceita id (codex) ou capability (cap:test-writing).')}
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const client = new HubClient(baseUrl(config));

  switch (args.command) {
    case 'daemon':
      return runDaemon();
    case 'hook':
      // NAO passa por withDaemon: subir o daemon de dentro de um hook faria
      // isso acontecer a cada chamada de ferramenta do agente.
      return runHook(config, args);
    case 'hooks':
      // Offline como o `mcp`: mexer em config não precisa do daemon.
      return hooksCommand(args);
    case 'stop':
      return stopDaemon(client);
    case 'status':
      return withDaemon(() => status(client));
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
    case 'handoff':
      return withDaemon(async () => {
        const sessionId = required(args.positional[0], 'sessionId');
        const targetAgent = required(
          typeof args.flags['to'] === 'string'
            ? args.flags['to']
            : typeof args.flags['agent'] === 'string'
              ? args.flags['agent']
              : undefined,
          '--to <agente>',
        );
        const reason = typeof args.flags['reason'] === 'string' ? args.flags['reason'] : undefined;
        const res = await client.handoff(sessionId, targetAgent, reason);
        console.log(green(`\n✓ Controle da sessão ${res.session.id} transferido para o agente "${res.session.agentId}".`));
      });
    case 'approvals':
      return withDaemon(() => listApprovals(client));
    case 'approve':
      return withDaemon(() => decide(client, args, 'approved'));
    case 'deny':
      return withDaemon(() => decide(client, args, 'denied'));
    case 'prune':
      return withDaemon(() => prune(client));
    case 'mcp':
      // Não exige daemon: registrar a config é offline.
      return mcpCommand(args, config);
    case 'diff':
      return withDaemon(() => showDiff(client, args));
    case 'graph':
      return withDaemon(() => showGraph(client, args));
    case 'budget':
      return withDaemon(() => showBudget(client, args));
    case 'workflow':
      return withDaemon(() => workflowCommand(client, args));
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

/**
 * Responde ao hook do agente. Silencioso por construção: qualquer coisa fora do
 * JSON no stdout confunde quem está lendo a resposta.
 */
async function runHook(
  config: ReturnType<typeof loadConfig>,
  args: Args,
): Promise<void> {
  // O dialeto é DECLARADO por quem instala o hook, nunca farejado do payload.
  // Codex e Claude mandam entrada quase idêntica e esperam saídas opostas para
  // "permitir"; adivinhar por formato daria um erro silencioso no dia em que os
  // dois payloads convergirem — e o erro cairia justamente no caminho feliz.
  const dialeto = args.flags['dialect'] === 'codex' ? 'codex' : 'claude';

  let entrada: HookInput = {};
  try {
    const bruto = await lerStdin();
    entrada = bruto.trim().length > 0 ? (JSON.parse(bruto) as HookInput) : {};
  } catch {
    // stdin ilegível não pode virar bloqueio: o agente ficaria travado.
    entrada = {};
  }

  const { saida, codigo } = await decideToolCall(entrada, baseUrl(config), dialeto);
  process.stdout.write(saida);
  process.exitCode = codigo;
}

// ------------------------------------------------------ gate pré-execução

async function hooksCommand(args: Args): Promise<void> {
  const [sub, alvoId] = args.positional;

  if (sub === undefined) {
    for (const alvo of HOOK_TARGETS) {
      const config = lerConfig(alvo.configUsuario);
      const instalado = hookInstalado(config);
      console.log(`${instalado ? green('●') : dim('○')} ${bold(alvo.id)} ${dim(alvo.nome)}`);
      console.log(`   ${dim(alvo.configUsuario)}`);
      console.log(`   ${dim(alvo.nota)}`);
    }
    console.log(
      `${NEWLINE}${dim('instale com:')} ${bold('hub hooks install claude --write')}`,
    );
    console.log(
      dim(`o gate cobre ${MATCHER_DE_RISCO.split('|').length} ferramentas de risco; leitura passa direto`),
    );
    return;
  }

  if (sub !== 'install') {
    console.error(red('uso: hub hooks [install <agente> [--write]]'));
    process.exitCode = 1;
    return;
  }

  const alvo = HOOK_TARGETS.find((t) => t.id === (alvoId ?? 'claude'));
  if (!alvo) {
    console.error(
      red(`agente "${String(alvoId)}" não suporta gate pré-execução`),
      dim(`(disponíveis: ${HOOK_TARGETS.map((t) => t.id).join(', ')})`),
    );
    process.exitCode = 1;
    return;
  }

  const projeto = typeof args.flags['project'] === 'string' ? args.flags['project'] : undefined;
  const destino =
    projeto && alvo.configProjeto ? alvo.configProjeto(path.resolve(projeto)) : alvo.configUsuario;

  const atual = lerConfig(destino);
  const novo = mergeHooks(atual, hookCommand());

  if (args.flags['write'] !== true) {
    console.log(dim(`destino: ${destino}${NEWLINE}`));
    console.log(JSON.stringify(novo['hooks'], null, 2));
    console.log(`${NEWLINE}${dim('para gravar:')} ${bold(`hub hooks install ${alvo.id} --write`)}`);
    return;
  }

  const backup = gravarConfig(destino, novo);
  console.log(`${green('gate instalado')} em ${bold(destino)}`);
  if (backup) console.log(dim(`backup: ${backup}`));
  console.log(
    dim(
      'a partir da próxima sessão, Bash/Write/Edit passam pela política do Hub antes de rodar.',
    ),
  );
}

// ---------------------------------------------------------------- daemon

async function runDaemon(): Promise<void> {
  const hub = createHub();
  // `start()` e não `server.listen()`: ligar a porta é o que impede um segundo
  // daemon de reconciliar o banco e declarar mortas as sessões do primeiro.
  // Este é o caminho que o autostart executa, então é o que mais precisa disto.
  const { host, port } = await hub.start();
  const url = baseUrl({ host, port });
  console.log(green(`daemon ouvindo em ${url}`));
  console.log(`painel: ${bold(url)}`);
  console.log(dim(`home: ${hub.config.home}`));
  console.log(dim(`agentes: ${hub.registry.ids().join(', ')}`));

  // A guarda de reentrância existia só no outro entrypoint — e é este aqui que
  // o autostart usa. Dois Ctrl-C rodavam dois desligamentos concorrentes sobre
  // o mesmo banco.
  let encerrando = false;
  const stop = async (): Promise<void> => {
    if (encerrando) return;
    encerrando = true;
    console.log(dim('\nencerrando sessões vivas…'));
    await hub.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());

  instalarRedeDeSeguranca(stop);
}

/**
 * Garante o daemon no ar antes de qualquer comando.
 *
 * O daemon é detalhe de implementação do Hub: exigir que você lembre de subir
 * um processo antes de usar a ferramenta era o atrito número um. Agora ele
 * nasce sozinho na primeira necessidade e sobrevive ao terminal.
 */
async function withDaemon(fn: () => Promise<void>): Promise<void> {
  const client = new HubClient(baseUrl(loadConfig()));

  try {
    await ensureDaemon(client);
  } catch (err) {
    console.error(red((err as Error).message));
    process.exitCode = 1;
    return;
  }

  try {
    await fn();
  } catch (err) {
    const message = (err as Error).message ?? '';
    if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
      console.error(red('o daemon caiu no meio da operação.'), dim('veja:'), bold('hub daemon'));
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
  const brief: BriefInput = {
    agent,
    objective,
    isolation:
      args.flags['isolation'] === 'none'
        ? 'none'
        : args.flags['isolation'] === 'container'
          ? 'container'
          : 'worktree',
  };
  if (isSupervision(args.flags['mode'])) brief.supervision = args.flags['mode'];
  if (typeof args.flags['budget-usd'] === 'string') {
    brief.budget = { usd: Number(args.flags['budget-usd']) };
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

  const alvo = filter.sessionId ?? rootId;

  for await (const event of client.stream(filter)) {
    console.log(renderEvent(event, { showAgent }));

    const doAlvo = alvo === undefined || event.sessionId === alvo;
    const fimDeTurno =
      doAlvo && (event.type === 'turn.completed' || event.type === 'error' || event.type === 'session.ended');

    if (!fimDeTurno) continue;

    // O turno acabar NÃO quer dizer que a tarefa acabou: ainda faltam o portão
    // de validação e, se ele reprovar, retry ou troca de agente. Devolver o
    // terminal aqui mostraria "concluído" para algo que pode falhar em seguida.
    if (alvo !== undefined && (await aguardarTaskTerminal(client, alvo))) return;
  }
}

/**
 * Espera a tarefa da sessão chegar a um estado terminal, relatando o portão de
 * validação. Devolve `false` quando a tarefa continua viva (retry ou fallback),
 * para o chamador seguir acompanhando o stream.
 */
async function aguardarTaskTerminal(client: HubClient, sessionId: string): Promise<boolean> {
  const terminais = new Set(['completed', 'failed', 'canceled', 'rejected']);
  let avisou = false;

  for (let i = 0; i < 600; i += 1) {
    const { tasks } = await client.tasks(sessionId).catch(() => ({ tasks: [] }));
    const task = tasks[0];
    if (!task) return true;

    // Bloqueio por decisão humana NÃO é espera: ninguém vai destravar enquanto
    // o terminal está preso. Antes, a CLI ficava dez minutos calada aqui.
    if (task.state === 'input_required') {
      const { approvals } = await client.approvals(sessionId).catch(() => ({ approvals: [] }));
      const pendente = approvals[0];

      console.log(`${NEWLINE}${yellow('⏸ bloqueado, esperando você')}`);
      if (pendente) {
        console.log(`   ${pendente.action} ${dim(`[${pendente.risk}]`)}`);
        console.log(
          `${NEWLINE}   ${bold(`hub approve ${pendente.id}`)}   ${dim('ou')}   ${bold(`hub deny ${pendente.id}`)}`,
        );
      } else {
        console.log(dim('   nenhuma aprovação registrada — veja `hub approvals`'));
      }
      return true;
    }

    if (!terminais.has(task.state)) {
      if (!avisou) {
        console.log(dim('… aguardando o portão de validação'));
        avisou = true;
      }
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }

    const validacao = task.result?.validation;
    if (validacao) {
      for (const check of validacao.checks) {
        console.log(
          `${check.passed ? green('✓') : red('✗')} validação: ${check.name}${
            check.detail ? dim(` — ${check.detail}`) : ''
          }`,
        );
      }
    }

    const { session } = await client.session(sessionId);
    const { budget } = await client.budget(session.rootId);
    console.log(
      `\n${dim('custo do fluxo:')} US$ ${budget.consumed.usd.toFixed(4)} · ${formatTokens(
        budget.consumed.tokens,
      )} tokens ${dim(`(${Math.round(budget.pressure * 100)}% do orçamento)`)}`,
    );
    return true;
  }

  return true;
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

  const brief: BriefInput = { agent, objective };
  if (typeof args.flags['budget-usd'] === 'string') {
    brief.budget = { usd: Number(args.flags['budget-usd']) };
  }

  const result = await client.delegate(sessionId, brief);
  console.log(
    `${green('delegado')} para ${bold(result.agentId)} ${dim(`sessão ${result.sessionId}`)}`,
  );
  console.log(dim(`acompanhe com: hub watch ${result.sessionId}`));
}

/** Mostra o patch da sessão — a pergunta que sempre vem primeiro. */
async function showDiff(client: HubClient, args: Args): Promise<void> {
  const sessionId = required(args.positional[0], 'sessionId');
  const { diff, message } = await client.diff(sessionId);

  if (!diff) {
    console.log(dim(message ?? 'nada a mostrar'));
    return;
  }

  for (const linha of diff.split(NEWLINE)) {
    if (linha.startsWith('+++') || linha.startsWith('---')) console.log(bold(linha));
    else if (linha.startsWith('+')) console.log(green(linha));
    else if (linha.startsWith('-')) console.log(red(linha));
    else if (linha.startsWith('@@')) console.log(cyan(linha));
    else if (linha.startsWith('#')) console.log(dim(linha));
    else console.log(linha);
  }
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

/** Encerra o daemon sem caçar PID — ele sobe sozinho, então precisa morrer sozinho. */
async function stopDaemon(client: HubClient): Promise<void> {
  try {
    await client.shutdown();
    console.log(green('daemon encerrado'));
  } catch (err) {
    const message = (err as Error).message ?? '';
    if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
      console.log(dim('o daemon já não estava rodando.'));
      return;
    }
    console.error(red(message));
    process.exitCode = 1;
  }
}

/** Uma tela com tudo que importa saber antes de começar a trabalhar. */
async function status(client: HubClient): Promise<void> {
  const [saude, { agents }, { sessions }, { approvals }] = await Promise.all([
    client.health(),
    client.agents(),
    client.sessions(),
    client.approvals(),
  ]);

  const disponiveis = agents.filter((a) => a.probe?.installed === true);
  const vivas = sessions.filter((s) => s.state === 'running' || s.state === 'waiting_approval');

  console.log(`${green('●')} daemon no ar ${dim(saude.home)}`);
  console.log(
    `${dim('agentes:  ')} ${disponiveis.length}/${agents.length} disponíveis ${dim(
      disponiveis.map((a) => a.id).join(', '),
    )}`,
  );
  console.log(`${dim('sessões:  ')} ${vivas.length} ativa(s) de ${sessions.length} no histórico`);

  for (const sessao of vivas.slice(0, 8)) {
    console.log(
      `   ${stateBadge(sessao.state)} ${bold(sessao.id)} ${cyan(sessao.agentId)} ${dim(
        sessao.title ?? '',
      )}`,
    );
  }

  if (approvals.length > 0) {
    console.log(
      `
${yellow(`⏸ ${approvals.length} aprovação(ões) esperando você`)} ${dim(
        '— hub approvals',
      )}`,
    );
  }
}

// -------------------------------------------------------- aprovações

async function listApprovals(client: HubClient): Promise<void> {
  const { approvals } = await client.approvals();
  if (approvals.length === 0) {
    console.log(dim('nada esperando você.'));
    return;
  }

  for (const approval of approvals) {
    const posterior = approval.detail['alreadyExecuted'] === true;
    console.log(
      `${yellow('⏸')} ${bold(approval.id)} ${dim(`[${approval.risk}]`)} ${
        posterior ? red('(já executada — sessão parada)') : dim('(retida antes de executar)')
      }`,
    );
    console.log(`   ${approval.action}`);
    if (typeof approval.detail['reason'] === 'string') {
      console.log(`   ${dim(String(approval.detail['reason']))}`);
    }
    console.log(`   ${dim(`sessão ${approval.sessionId} · ${approval.requestedAt.slice(11, 19)}`)}`);
  }

  console.log(`${NEWLINE}${dim('libere com:')} ${bold('hub approve <id>')}  ${dim('ou')}  ${bold('hub deny <id>')}`);
}

async function decide(
  client: HubClient,
  args: Args,
  decision: 'approved' | 'denied',
): Promise<void> {
  const id = required(args.positional[0], 'approvalId');
  const { approval } = await client.resolveApproval(id, decision);
  const verb = decision === 'approved' ? green('aprovada') : red('negada');
  console.log(`${verb}: ${approval.action}`);
  console.log(
    dim(
      decision === 'approved'
        ? `a sessão ${approval.sessionId} retoma de onde parou`
        : `a sessão ${approval.sessionId} foi encerrada`,
    ),
  );
}

async function prune(client: HubClient): Promise<void> {
  const { sweep } = await client.sweep();
  console.log(
    `${sweep.examined} sessão(ões) encerrada(s) examinada(s) · ${sweep.removed.length} worktree(s) recolhido(s) · ${sweep.kept} ainda no prazo`,
  );
  for (const removed of sweep.removed) console.log(`   ${dim(removed)}`);
  if (sweep.removed.length > 0) {
    console.log(dim(NEWLINE + 'os branches hub/<sessionId> continuam intactos.'));
  }
}

// ---------------------------------------------------------------- MCP

function mcpCommand(args: Args, config: { host: string; port: number }): void {
  const hubUrl = baseUrl(config);
  const [sub, agentId] = args.positional;
  const projectPath = path.resolve(
    typeof args.flags['project'] === 'string' ? args.flags['project'] : process.cwd(),
  );

  if (sub === undefined) return mcpStatus(hubUrl, projectPath);

  const target = MCP_TARGETS.find((t) => t.agentId === agentId);
  if (!target) {
    console.error(
      red(`agente "${agentId ?? ''}" desconhecido.`),
      dim(`disponíveis: ${MCP_TARGETS.map((t) => t.agentId).join(', ')}`),
    );
    process.exitCode = 1;
    return;
  }

  const spec = serverSpec(target.agentId, hubUrl);
  const configPath = resolveConfigPath(target, projectPath);

  if (sub === 'show') {
    console.log(`${bold(target.label)}\n${dim(configPath)}\n`);
    console.log(renderSnippet(target, spec));
    if (!target.verified) {
      console.log(`\n${yellow('⚠')} ${dim('caminho/formato não confirmado — verifique na doc do agente')}`);
    }
    return;
  }

  if (sub !== 'install') {
    console.error(red('uso: hub mcp [show|install] <agente>'));
    process.exitCode = 1;
    return;
  }

  if (args.flags['write'] !== true) {
    // Escrever em config de outra ferramenta é ação persistente e fora do
    // nosso território: por padrão só mostramos o que faríamos.
    console.log(`${bold(target.label)}\n${dim(configPath)}\n`);
    console.log(renderSnippet(target, spec));
    console.log(
      `\n${dim('nada foi gravado. para aplicar:')} ${bold(
        `hub mcp install ${target.agentId} --write`,
      )}`,
    );
    return;
  }

  try {
    const outcome = writeConfig(target, spec, configPath);
    const verb = { created: 'criado', merged: 'atualizado', unchanged: 'já estava correto' }[
      outcome.action
    ];
    console.log(`${green('✓')} ${target.label}: ${verb}`);
    console.log(`   ${dim(outcome.path)}`);
    if (outcome.backup) console.log(`   ${dim(`backup: ${outcome.backup}`)}`);
    if (!target.verified) {
      console.log(
        `   ${yellow('⚠')} ${dim('formato não confirmado para este agente — teste antes de confiar')}`,
      );
    }
    console.log(`\n${dim('reinicie o agente para ele carregar o MCP server.')}`);
  } catch (err) {
    console.error(red((err as Error).message));
    process.exitCode = 1;
  }
}

function mcpStatus(hubUrl: string, projectPath: string): void {
  console.log(`${dim('MCP server:')} ${mcpEntrypoint()}`);
  console.log(`${dim('daemon:    ')} ${hubUrl}\n`);

  for (const target of MCP_TARGETS) {
    const configPath = resolveConfigPath(target, projectPath);
    const registered = isRegistered(configPath);
    const icon = registered ? green('✓') : dim('○');
    const status = registered ? green('registrado') : dim('não registrado');
    console.log(`${icon} ${bold(target.agentId.padEnd(12))} ${status}`);
    console.log(`   ${dim(configPath)}`);
    if (target.note) console.log(`   ${dim(target.note)}`);
    if (!target.verified) console.log(`   ${yellow('⚠')} ${dim('caminho não confirmado')}`);
  }

  console.log(`\n${dim('para registrar:')} ${bold('hub mcp install <agente> --write')}`);
}

function isRegistered(configPath: string): boolean {
  try {
    return readFileSync(configPath, 'utf8').includes('agents-hub');
  } catch {
    return false;
  }
}

function isSupervision(value: unknown): value is 'supervised' | 'semi' | 'autonomous' {
  return value === 'supervised' || value === 'semi' || value === 'autonomous';
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`argumento obrigatório ausente: ${name}`);
  }
  return value;
}

await main();
