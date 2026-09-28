#!/usr/bin/env node
import path from 'node:path';
import { baseUrl, loadConfig, ligarBypassDoGateCodex, modoExigeGate } from '@agents-hub/daemon';
import { HubClient, type BriefInput } from './client.js';
import { ensureDaemon } from './daemon-control.js';
import { runDaemon } from './daemon-run.js';
import { runHook } from './hook-run.js';
import { autostartCommand } from './autostart-cmd.js';
import {
  HOOK_TARGETS,
  MATCHER_DE_RISCO,
  avisoDeTimeoutDoHook,
  gravarConfig,
  hookCommand,
  hookInstalado,
  NOTA_GATE_POR_SESSAO,
  lerConfig,
  lerConfigParaGravar,
  mergeHooks,
} from './hooks-install.js';
import { bold, cyan, dim, green, red, stateBadge, yellow } from './render.js';
import {
  MCP_TARGETS,
  estadoDoRegistro,
  mcpEntrypoint,
  renderSnippet,
  resolveConfigPath,
  serverSpec,
  writeConfig,
} from './mcp-install.js';
import { workflowCommand } from './workflow-cmd.js';
import { pauseCommand } from './pause-cmd.js';
import { interruptCommand } from './interrupt-cmd.js';
import { discoverCommand, importCommand } from './discover-cmd.js';
import { auditCommand, policyCommand } from './policy-cmd.js';
import { readOperatorToken } from '@agents-hub/client/operator-token';
import { doctorCommand, doctorDaConfig, statusCommand } from './doctor-cmd.js';
import { resolveProjectId } from './project-resolve.js';
import { budgetCommand, graphCommand, sendCommand, watchCommand } from './session-follow.js';
import { lerBudgetUsd, startCommand } from './start-cmd.js';
// Item 5.6: comandos de ciclo de vida, exportação e manutenção.
import { versionCommand } from './version-cmd.js';
import { JSON_COMMANDS, jsonCommand } from './json-cmd.js';
import { initCommand, perguntarNoTerminal } from './init-cmd.js';
import { openCommand } from './open-cmd.js';
import { logsCommand } from './logs-cmd.js';
import { restartCommand } from './restart-cmd.js';
import { updateCommand } from './update-cmd.js';
import { exportCommand } from './export-cmd.js';
import { costCommand } from './cost-cmd.js';
import { mergeCommand } from './merge-cmd.js';
import { backupCommand, restoreCommand } from './backup-cmd.js';
import { comErro, required, type Args } from './cmd-util.js';
// Vistoria 07/14 (R07-07, R07-11, R07-18, R07-20..24, R14-11).
import { parseArgs } from './args.js';
import { HELP, ajudaDoComando } from './ajuda.js';
import { definirComandoAtual, erroDeUso, mostrarErro } from './erro-cli.js';
import { dataHoraLocal } from './hora.js';
import { projectEnvCommand } from './project-env-cmd.js';

/** Quebra de linha literal, para não brigar com escapes em template string. */
const NEWLINE = String.fromCharCode(10);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  definirComandoAtual(args.command);
  // O hook vem antes de `loadConfig`: config inválida lançava aqui, o processo
  // saía com stack trace e código 1 — que o agente trata como erro NÃO
  // bloqueante e roda a ferramenta. O hook lê a config por conta própria e
  // aplica o modo de falha se ela não abrir.
  if (args.command === 'hook') return runHook(args);
  // `--version` responde mesmo com config quebrada; só pergunta ao daemon se der.
  if (args.command === '--version' || args.command === '-v' || args.command === 'version') {
    let cliente: HubClient | null = null;
    try {
      cliente = new HubClient(baseUrl(loadConfig()));
    } catch {
      cliente = null;
    }
    await versionCommand(args, cliente);
    return;
  }
  // Ajuda antes de `loadConfig` (R07-07): com config.json inválido, `hub help`
  // saía com o erro da config e nenhuma ajuda. Agora mostra a ajuda e avisa.
  if (pedeAjuda(args)) return mostrarAjuda(args);
  // `hub doctor` confere o config.json ANTES do `loadConfig` abaixo: com
  // chave inválida em `policy`, o `loadConfig` lançaria e o doctor morreria
  // com stack trace — justo o comando que deveria explicar o problema.
  if (args.command === 'doctor' && !doctorDaConfig()) {
    process.exitCode = 1;
    return;
  }
  const config = loadConfig();
  // Token de operador (item 1.6): lido a cada requisição, do arquivo que o
  // daemon cria — ele pode nascer depois deste cliente (autostart). O hook
  // do agente (`runHook`) NÃO usa este cliente: monta o próprio, sem token.
  const client = new HubClient(baseUrl(config), { token: () => readOperatorToken(config.home) });

  // `--json` uniforme nos comandos de leitura (item 5.6): só JSON no stdout.
  if (args.flags['json'] === true && JSON_COMMANDS.has(args.command)) {
    return withDaemon(() => jsonCommand(client, args, { home: config.home, url: baseUrl(config) }));
  }

  switch (args.command) {
    case 'daemon':
      return runDaemon();
    case 'autostart':
      return autostartCommand(args, client);
    case 'hook':
      // NAO passa por withDaemon: subir o daemon de dentro de um hook faria
      // isso acontecer a cada chamada de ferramenta do agente.
      return runHook(args);
    case 'hooks':
      // Offline como o `mcp`: mexer em config não precisa do daemon.
      return hooksCommandSeguro(args, config);
    case 'stop':
      return stopDaemon(client);
    case 'status':
      return withDaemon(async () => void (await statusCommand(client, config.home)));
    case 'health':
      return withDaemon(async () => {
        console.log(JSON.stringify(await client.health(), null, 2));
      });
    case 'doctor':
      return withDaemon(async () => void (await doctorCommand(client, args, { home: config.home })));
    case 'agents':
      return withDaemon(() => listAgents(client));
    case 'discover':
      return withDaemon(() => discoverCommand(client, args));
    case 'import':
      return withDaemon(() => importCommand(client, args, (flag) => resolveProjectId(client, flag)));
    case 'projects':
      return withDaemon(() => listProjects(client));
    case 'project':
      return withDaemon(() => projectCommand(client, args));
    case 'start':
      return withDaemon(async () => void (await startCommand(client, args)));
    case 'sessions':
      return withDaemon(() => listSessions(client));
    case 'watch':
      return withDaemon(async () => void (await watchCommand(client, args)));
    case 'send':
      return withDaemon(async () => void (await sendCommand(client, args)));
    case 'interrupt':
      return withDaemon(() => interruptCommand(client, args));
    case 'pause':
      return withDaemon(() => pauseCommand(client, args));
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
        console.log(
          green(
            `\n✓ Controle da sessão ${res.session.id} transferido para o agente "${res.session.agentId}".`,
          ),
        );
      });
    case 'approvals':
      return withDaemon(() => listApprovals(client));
    case 'approve':
      return withDaemon(() => decide(client, args, 'approved'));
    case 'deny':
      return withDaemon(() => decide(client, args, 'denied'));
    case 'prune':
      return withDaemon(() => prune(client));
    case 'policy':
      return withDaemon(() => policyCommand(client, args, resolveProjectId));
    case 'audit':
      return withDaemon(() => auditCommand(client, args));
    case 'mcp':
      // Não exige daemon: registrar a config é offline.
      return comErro(async () => mcpCommand(args, config));
    case 'diff':
      return withDaemon(() => showDiff(client, args));
    case 'artifacts':
      return withDaemon(() => showArtifacts(client, args));
    case 'graph':
      return withDaemon(() => graphCommand(client, args));
    case 'budget':
      return withDaemon(() => budgetCommand(client, args));
    case 'workflow':
      return withDaemon(() => workflowCommand(client, args));
    // ------------------------------------------- item 5.6 (ver *-cmd.ts)
    case 'init':
      return comErro(() =>
        initCommand(client, args, {
          ensureDaemon: () => ensureDaemon(client),
          url: baseUrl(config),
          ...(process.stdin.isTTY && process.stdout.isTTY ? { ask: perguntarNoTerminal } : {}),
        }).then(() => undefined),
      );
    case 'open':
      return withDaemon(() => openCommand(baseUrl(config), args));
    case 'logs':
      return comErro(() => logsCommand(config.logDir, args));
    case 'restart':
      return comErro(() => restartCommand(client, args, { start: () => ensureDaemon(client) }));
    case 'update':
      return comErro(() => updateCommand(args).then(() => undefined));
    case 'export':
      return withDaemon(() => exportCommand(client, args));
    case 'cost':
      return withDaemon(() => costCommand(client, args).then(() => undefined));
    case 'merge':
    case 'apply':
      return withDaemon(() => mergeCommand(client, args).then(() => undefined));
    case 'backup':
      // Não sobe o daemon: parado, o backup é feito aqui mesmo.
      return comErro(() => backupCommand(client, config, args));
    case 'restore':
      return comErro(() => restoreCommand(client, config, args));
    default:
      console.error(red(`hub: comando desconhecido: ${args.command}`));
      console.log(HELP);
      process.exitCode = 1;
  }
}

// ---------------------------------------------------------------- ajuda

const COMANDOS_DE_AJUDA = new Set(['help', '--help', '-h']);

/** `hub help [cmd]`, `hub --help`, `hub <cmd> --help` / `-h` (R07-20). */
function pedeAjuda(args: Args): boolean {
  if (COMANDOS_DE_AJUDA.has(args.command.toLowerCase())) return true;
  // O `workflow` tem ajuda própria, mais completa (e que não sobe o daemon).
  if (args.command === 'workflow') return false;
  return args.flags['help'] === true || args.positional[0] === '-h';
}

function mostrarAjuda(args: Args): void {
  // A ajuda não depende da config; só avisa que ela está quebrada.
  try {
    loadConfig();
  } catch (err) {
    console.error(
      yellow('aviso: a configuração não carrega — os outros comandos vão falhar até corrigir:'),
    );
    console.error(yellow(`  ${(err as Error).message}`));
  }
  const alvo = COMANDOS_DE_AJUDA.has(args.command.toLowerCase()) ? args.positional[0] : args.command;
  const linhas = alvo === undefined ? [] : ajudaDoComando(alvo);
  if (alvo !== undefined && linhas.length === 0) {
    console.error(yellow(`sem ajuda específica para "${alvo}" — a ajuda completa:`));
  }
  if (linhas.length === 0) {
    console.log(HELP);
    return;
  }
  console.log(linhas.join(NEWLINE));
  console.log(NEWLINE + dim('ajuda completa: hub help'));
}

// ------------------------------------------------------ gate pré-execução

/**
 * `hub mcp install --write` já protege sua escrita de config com try/catch
 * (ver `mcpCommand`) — `gravarConfig`/`installCodexGate`/`ligarBypassDoGateCodex`, chamados
 * dentro de `hooksCommand`, fazem o mesmo tipo de I/O (`mkdirSync`,
 * `copyFileSync`, `writeFileSync`) e podem lançar por permissão negada, disco
 * cheio ou caminho inválido. Sem esta borda, o processo crashava com stack
 * trace bruto em vez do erro formatado que as outras superfícies mostram.
 */
async function hooksCommandSeguro(args: Args, config: ReturnType<typeof loadConfig>): Promise<void> {
  try {
    await hooksCommand(args, config);
  } catch (err) {
    mostrarErro(err);
  }
}

async function hooksCommand(args: Args, config: ReturnType<typeof loadConfig>): Promise<void> {
  const [sub, alvoId] = args.positional;

  if (sub === undefined) {
    for (const alvo of HOOK_TARGETS) {
      const alvoConfig = lerConfig(alvo.configUsuario);
      const instalado = hookInstalado(alvoConfig);
      console.log(`${instalado ? green('●') : dim('○')} ${bold(alvo.id)} ${dim(alvo.nome)}`);
      console.log(`   ${dim(alvo.configUsuario)}`);
      if (alvo.gateNasSessoesDoHub) {
        // O arquivo não decide mais se as sessões do Hub são gateadas: o hook
        // vai por sessão em `--settings`. Dizer "○ não instalado" sem isto
        // levava a crer que a sessão do Hub rodava sem prevenção.
        console.log(`   ${green('✓')} ${dim(NOTA_GATE_POR_SESSAO)}`);
      }
      console.log(`   ${dim(alvo.nota)}`);
      const aviso = avisoDeTimeoutDoHook(alvoConfig);
      if (aviso) {
        console.log(
          `   ${yellow(`⚠ ${aviso}`)} ${dim('— reinstale:')} ${bold(`hub hooks install ${alvo.id} --write`)}`,
        );
      }
    }
    const codexLigado = config.codexGate.bypassHookTrust;
    console.log(`${codexLigado ? green('●') : dim('○')} ${bold('codex')} ${dim('Codex CLI')}`);
    console.log(`   ${dim(path.join(config.home, 'config.json'))} (codexGate.bypassHookTrust)`);
    console.log(
      `   ${dim('config inline por invocação, não arquivo do agente — ver `hub hooks install codex`')}`,
    );
    if (!codexLigado && modoExigeGate('supervised')) {
      console.log(
        `   ${yellow('sem isto, sessões --mode supervised do Codex são recusadas ao iniciar')}`,
      );
    }
    console.log(
      `${NEWLINE}${dim('instale com:')} ${bold('hub hooks install claude --write')} ${dim('ou')} ${bold('hub hooks install codex --write')}`,
    );
    console.log(
      dim(
        `o gate cobre ${MATCHER_DE_RISCO.split('|').length} ferramentas de risco; leitura passa direto`,
      ),
    );
    return;
  }

  if (sub !== 'install') throw erroDeUso(`subcomando desconhecido: "${sub}" (use install)`);

  if (alvoId === 'codex') {
    return installCodexGate(args, config);
  }

  const alvo = HOOK_TARGETS.find((t) => t.id === (alvoId ?? 'claude'));
  if (!alvo) {
    throw erroDeUso(
      `agente "${String(alvoId)}" não suporta gate pré-execução (disponíveis: ${HOOK_TARGETS.map((t) => t.id).join(', ')}, codex)`,
    );
  }

  const projeto = typeof args.flags['project'] === 'string' ? args.flags['project'] : undefined;
  const destino =
    projeto && alvo.configProjeto ? alvo.configProjeto(path.resolve(projeto)) : alvo.configUsuario;

  // Lança (sem gravar nada) se o arquivo existe e não parseia por inteiro —
  // `hooksCommandSeguro` mostra o erro e sai com 1. Vale também para o dry-run:
  // mostrar "só o hook do Hub" escondia que a config da pessoa seria perdida.
  const { doc: atual, avisos } = lerConfigParaGravar(destino);
  const novo = mergeHooks(atual, hookCommand());
  for (const aviso of avisos) console.log(yellow(`⚠ ${aviso}`));

  if (args.flags['write'] !== true) {
    console.log(dim(`destino: ${destino}${NEWLINE}`));
    console.log(JSON.stringify(novo['hooks'], null, 2));
    console.log(`${NEWLINE}${dim('para gravar:')} ${bold(`hub hooks install ${alvo.id} --write`)}`);
    return;
  }

  const gravacao = gravarConfig(destino, atual, novo);
  if (gravacao.acao === 'inalterado') {
    console.log(`${green('gate já estava instalado')} em ${bold(destino)} ${dim('(nada gravado)')}`);
    return;
  }
  console.log(`${green('gate instalado')} em ${bold(destino)}`);
  if (gravacao.backup) console.log(dim(`backup: ${gravacao.backup}`));
  console.log(
    dim('a partir da próxima sessão, Bash/Write/Edit passam pela política do Hub antes de rodar.'),
  );
}

/**
 * O gate do Codex não se instala numa config do agente (ver `hub hooks` para
 * o porquê): o Hub monta `-c hooks={...}` a cada invocação. "Instalar" aqui
 * significa uma coisa só — gravar a escolha explícita do usuário em
 * `~/.agents-hub/config.json`, nunca em config de projeto versionada, porque
 * um repositório clonado não pode ligar sozinho um bypass de revisão de hook.
 */
async function installCodexGate(args: Args, config: ReturnType<typeof loadConfig>): Promise<void> {
  const destino = path.join(config.home, 'config.json');

  if (args.flags['write'] !== true) {
    console.log(dim(`destino: ${destino}${NEWLINE}`));
    console.log('O Codex ignora hook não confiável EM SILÊNCIO: a ferramenta roda como se');
    console.log('não houvesse gate nenhum. Só existe um jeito comprovado de evitar isso — a');
    console.log('flag `--dangerously-bypass-hook-trust` em toda invocação, que o Hub passa a');
    console.log('acrescentar depois deste comando.');
    console.log(`${NEWLINE}A flag dispensa a revisão do SCRIPT do hook (que é o próprio Hub, não`);
    console.log('algo escrito no seu projeto) — nunca permissão do agente: o hook só sabe NEGAR.');
    console.log(`${NEWLINE}${dim('para gravar:')} ${bold('hub hooks install codex --write')}`);
    return;
  }

  // Só a chave `codexGate.bypassHookTrust` muda; o resto do config.json fica
  // como a pessoa escreveu (sem congelar defaults), com backup versionado.
  const gravacao = ligarBypassDoGateCodex(config.home);
  if (gravacao.action === 'unchanged') {
    console.log(
      `${green('gate do Codex já estava ligado')} em ${bold(destino)} ${dim('(nada gravado)')}`,
    );
    return;
  }
  console.log(`${green('gate do Codex ligado')} — gravado em ${bold(destino)}`);
  if (gravacao.backup) console.log(dim(`backup: ${gravacao.backup}`));
  console.log(
    dim(
      'a partir da próxima sessão do Codex, cada invocação leva --dangerously-bypass-hook-trust ' +
        'e Bash/Write/Edit passam pela política do Hub antes de rodar.',
    ),
  );
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
    mostrarErro(err);
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
    // O MCP (`describe()`) e a Web (`HubApiError.code`) já mostram o código do
    // domínio; `mostrarErro` imprime `[CODIGO] mensagem`, os `details.issues`
    // (qual campo falhou) e, em erro de uso, a linha de uso do comando.
    mostrarErro(err);
  }
}

// ---------------------------------------------------------------- comandos

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
    const confianca = project.trusted ? ` ${yellow('[confiável]')}` : '';
    console.log(`${bold(project.name)} ${dim(project.id)}${confianca}\n   ${dim(project.path)}`);
  }
}

async function projectCommand(client: HubClient, args: Args): Promise<void> {
  const [sub, ...rest] = args.positional;
  switch (sub) {
    case 'add':
      return projectAdd(client, rest[0]);
    case 'env':
      return projectEnvCommand(client, args, rest[0]);
    case 'prompt':
      return projectPrompt(client, args, rest[0]);
    case 'folders':
      return projectFolders(client, rest);
    case 'trust':
      return projectTrust(client, rest[0], true);
    case 'untrust':
      return projectTrust(client, rest[0], false);
    default:
      throw erroDeUso(
        sub === undefined
          ? 'faltou o subcomando (add, env, prompt, folders, trust ou untrust)'
          : `subcomando desconhecido: "${sub}" (use add, env, prompt, folders, trust ou untrust)`,
      );
  }
}

async function projectAdd(client: HubClient, dir: string | undefined): Promise<void> {
  const { project } = await client.addProject(path.resolve(dir ?? process.cwd()));
  console.log(`${green('registrado')} ${bold(project.name)} ${dim(project.id)}`);
}

/**
 * `hub project trust|untrust [projeto]` — confiança explícita NESTA máquina.
 *
 * Sem ela, os campos sensíveis do `.agents-hub/config.yaml` do repositório
 * (`validation.command`, revisão, `env` — ex. `ANTHROPIC_BASE_URL` —,
 * `prompts`, `memory`) são ignorados: o arquivo é versionado, e clonar um repo
 * malicioso não pode bastar para executar código nem desviar o tráfego do
 * agente. A marca fica no banco do Hub, fora do repositório, com o hash do
 * conteúdo confiado: se ele mudar, a confiança fica suspensa até rodar de novo.
 */
async function projectTrust(
  client: HubClient,
  projectRef: string | undefined,
  trusted: boolean,
): Promise<void> {
  const projectId = await resolveProjectId(client, projectRef);
  const { project, repo } = await client.setProjectTrusted(projectId, trusted);
  const campos = repo?.sensitiveFields ?? [];
  if (trusted) {
    console.log(`${green('confiável')} ${bold(project.name)} ${dim(project.id)}`);
    if (campos.length === 0) {
      console.log(dim('o .agents-hub/config.yaml deste projeto não declara campos sensíveis agora.'));
    } else {
      // Mostrar O QUE foi confiado: é o conteúdo de agora que fica valendo.
      console.log(dim('passam a valer (conteúdo de agora do .agents-hub/config.yaml):'));
      for (const campo of campos) console.log(`  ${campo}`);
    }
    console.log(
      dim('se o repositório mudar esses campos, a confiança fica suspensa até você rodar isto de novo.'),
    );
  } else {
    console.log(`${yellow('não confiável')} ${bold(project.name)} ${dim(project.id)}`);
    console.log(
      dim(
        'validation.command, revisão, env, prompts e memory do .agents-hub/config.yaml deste projeto serão ignorados.',
      ),
    );
  }
}

/** `hub project prompt` — mostra, grava ou apaga a instrução de um agente. */
async function projectPrompt(
  client: HubClient,
  args: Args,
  projectRef: string | undefined,
): Promise<void> {
  const projectId = await resolveProjectId(client, projectRef);
  const agentId = typeof args.flags['agent'] === 'string' ? args.flags['agent'] : undefined;
  if (agentId === undefined)
    throw erroDeUso('--agent é obrigatório: hub project prompt [projeto] --agent <id>');

  if (args.flags['set'] === true)
    throw erroDeUso('--set precisa do texto: --set "instrução para o agente"');
  const setFlag = typeof args.flags['set'] === 'string' ? args.flags['set'] : undefined;
  const clearFlag = args.flags['clear'] === true;
  if (setFlag !== undefined && clearFlag) throw erroDeUso('use --set OU --clear, não os dois');

  const { context } = await client.projectContext(projectId);

  if (setFlag === undefined && !clearFlag) {
    const atual = context.prompts?.[agentId];
    console.log(atual ? atual : dim('(nenhuma instrução salva para este agente)'));
    return;
  }

  const prompts = { ...(context.prompts ?? {}) };
  if (clearFlag) delete prompts[agentId];
  else if (setFlag !== undefined) prompts[agentId] = setFlag;

  const { context: salvo } = await client.saveProjectContext(projectId, { ...context, prompts });
  if (clearFlag) console.log(`${green('removida')} instrução de ${bold(agentId)}`);
  else
    console.log(
      `${green('gravada')} instrução de ${bold(agentId)}: ${dim(salvo.prompts?.[agentId] ?? '')}`,
    );
}

/**
 * `hub project folders` — o client já tinha `folders`/`removeFolder` e o
 * daemon já tinha as rotas (a Web usa `folders` via `ProjectModal` para
 * vincular pastas extras a um projeto), mas nenhuma CLI as expunha: quem
 * vinculava uma pasta pela Web não tinha como listá-las ou desvincular
 * depois. Segue o mesmo estilo de `hub project env`/`hub project prompt`:
 * `[projeto]` é opcional (id ou caminho; sem ele, usa o diretório atual).
 */
async function projectFolders(client: HubClient, rest: string[]): Promise<void> {
  if (rest[0] === 'remove') {
    const argumentos = rest.slice(1);
    // Com dois argumentos, o primeiro é o projeto; com um só, é o folderId e
    // o projeto vem do diretório atual — mesma convenção de `resolveProjectId`.
    const projectRef = argumentos.length >= 2 ? argumentos[0] : undefined;
    const folderId = argumentos.length >= 2 ? argumentos[1] : argumentos[0];

    if (folderId === undefined || folderId.length === 0)
      throw erroDeUso('faltou o folderId: hub project folders remove [projeto] <folderId>');

    const projectId = await resolveProjectId(client, projectRef);
    await client.removeFolder(projectId, folderId);
    console.log(`${green('desvinculada')} pasta ${bold(folderId)} do projeto ${dim(projectId)}`);
    return;
  }

  const projectId = await resolveProjectId(client, rest[0]);
  const { folders } = await client.folders(projectId);
  if (folders.length === 0) {
    console.log(dim('nenhuma pasta vinculada a este projeto.'));
    return;
  }
  for (const folder of folders) {
    console.log(
      `${folder.isPrimary ? green('●') : dim('○')} ${bold(folder.id)} ${dim(folder.path)}${
        folder.label ? ` ${dim(`(${folder.label})`)}` : ''
      }`,
    );
  }
  if (!folders.some((f) => !f.isPrimary)) return;
  console.log(`${NEWLINE}${dim('desvincule com:')} ${bold('hub project folders remove <folderId>')}`);
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
        dataHoraLocal(session.createdAt),
      )}`,
    );
    if (session.title) console.log(`${indent}   ${dim(session.title)}`);
  }
}

async function delegate(client: HubClient, args: Args): Promise<void> {
  const sessionId = required(args.positional[0], 'sessionId');
  const objective = args.positional.slice(1).join(' ').trim();
  const agent = args.flags['agent'];

  if (typeof agent !== 'string')
    throw erroDeUso('--agent é obrigatório: hub delegate <sessionId> --agent <id|cap:x> "objetivo"');
  if (objective.length === 0)
    throw erroDeUso('faltou o objetivo: hub delegate <sessionId> --agent <id|cap:x> "objetivo"');

  const budgetUsd = lerBudgetUsd(args.flags['budget-usd']);
  if (budgetUsd instanceof Error) throw erroDeUso(budgetUsd.message);

  const brief: BriefInput = { agent, objective };
  if (budgetUsd !== undefined) brief.budget = { usd: budgetUsd };

  const result = await client.delegate(sessionId, brief);
  console.log(`${green('delegado')} para ${bold(result.agentId)} ${dim(`sessão ${result.sessionId}`)}`);
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

/**
 * `hub artifacts` — o client já tinha `artifacts(sessionId)` e o daemon já
 * tinha a rota, mas só `diff` (kind === 'diff') era acessível por qualquer
 * superfície. Artefatos de outro `kind` (`file`, `report`, `log`,
 * `transcript`) ficavam inacessíveis por completo; isto lista todos.
 */
async function showArtifacts(client: HubClient, args: Args): Promise<void> {
  const sessionId = required(args.positional[0], 'sessionId');
  const { artifacts } = await client.artifacts(sessionId);
  if (artifacts.length === 0) {
    console.log(dim('nenhum artefato registrado para esta sessão.'));
    return;
  }
  for (const artifact of artifacts) {
    console.log(`${bold(artifact.id)} ${cyan(artifact.kind)} ${dim(artifact.path)}`);
    console.log(`   ${dim(dataHoraLocal(artifact.createdAt))}`);
  }
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
    mostrarErro(err);
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
    console.log(`   ${dim(`sessão ${approval.sessionId} · ${dataHoraLocal(approval.requestedAt)}`)}`);
  }

  console.log(
    `${NEWLINE}${dim('libere com:')} ${bold('hub approve <id>')}  ${dim('ou')}  ${bold('hub deny <id>')}`,
  );
}

async function decide(client: HubClient, args: Args, decision: 'approved' | 'denied'): Promise<void> {
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
    `${sweep.examined} sessão(ões) encerrada(s) examinada(s) · ${sweep.removed.length} worktree(s) recolhido(s) · ${sweep.retained} ainda no prazo` +
      (sweep.failed.length > 0 ? ` · ${sweep.failed.length} falharam ao remover` : ''),
  );
  for (const removed of sweep.removed) console.log(`   ${dim(removed)}`);
  for (const falha of sweep.failed) console.log(`   ${dim(`${falha.path}: ${falha.reason}`)}`);
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
  if (sub !== 'show' && sub !== 'install')
    throw erroDeUso(`subcomando desconhecido: "${sub}" (use show ou install)`);
  if (agentId === undefined || agentId === '') {
    throw erroDeUso(`faltou o agente (disponíveis: ${MCP_TARGETS.map((t) => t.agentId).join(', ')})`);
  }

  const target = MCP_TARGETS.find((t) => t.agentId === agentId);
  if (!target) {
    throw erroDeUso(
      `agente "${agentId}" desconhecido (disponíveis: ${MCP_TARGETS.map((t) => t.agentId).join(', ')})`,
    );
  }

  const spec = serverSpec(target.agentId, hubUrl);
  const configPath = resolveConfigPath(target, projectPath);

  if (sub === 'show') {
    console.log(`${bold(target.label)}\n${dim(configPath)}\n`);
    console.log(renderSnippet(target, spec));
    if (!target.verified) {
      console.log(
        `\n${yellow('⚠')} ${dim('caminho/formato não confirmado — verifique na doc do agente')}`,
      );
    }
    return;
  }

  if (args.flags['write'] !== true) {
    // Escrever em config de outra ferramenta é ação persistente e fora do
    // nosso território: por padrão só mostramos o que faríamos.
    console.log(`${bold(target.label)}\n${dim(configPath)}\n`);
    console.log(renderSnippet(target, spec));
    console.log(
      `\n${dim('nada foi gravado. para aplicar:')} ${bold(`hub mcp install ${target.agentId} --write`)}`,
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
    for (const aviso of outcome.avisos) console.log(`   ${yellow('⚠')} ${dim(aviso)}`);
    if (!target.verified) {
      console.log(
        `   ${yellow('⚠')} ${dim('formato não confirmado para este agente — teste antes de confiar')}`,
      );
    }
    console.log(`\n${dim('reinicie o agente para ele carregar o MCP server.')}`);
  } catch (err) {
    mostrarErro(err);
  }
}

function mcpStatus(hubUrl: string, projectPath: string): void {
  console.log(`${dim('MCP server:')} ${mcpEntrypoint()}`);
  console.log(`${dim('daemon:    ')} ${hubUrl}\n`);

  for (const target of MCP_TARGETS) {
    const configPath = resolveConfigPath(target, projectPath);
    // R07-23: servidor `agents-hub` parseado do JSON/TOML e comparado com o
    // que `--write` gravaria — não mais "o arquivo contém a string".
    const registro = estadoDoRegistro(target, configPath, serverSpec(target.agentId, hubUrl));
    const [icon, status] =
      registro.estado === 'atualizado'
        ? [green('✓'), green('registrado')]
        : registro.estado === 'desatualizado'
          ? [yellow('⚠'), yellow('registrado com outro caminho/porta — rode install --write de novo')]
          : registro.estado === 'ilegivel'
            ? [red('✗'), red(`config ilegível: ${registro.erro}`)]
            : [dim('○'), dim('não registrado')];
    console.log(`${icon} ${bold(target.agentId.padEnd(12))} ${status}`);
    console.log(`   ${dim(configPath)}`);
    if (target.note) console.log(`   ${dim(target.note)}`);
    if (!target.verified) console.log(`   ${yellow('⚠')} ${dim('caminho não confirmado')}`);
  }

  console.log(`\n${dim('para registrar:')} ${bold('hub mcp install <agente> --write')}`);
}

await main();
