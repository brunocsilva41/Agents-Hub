import { execFile } from 'node:child_process';
import { chaveDeCaminho } from './project-resolve.js';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';
import type { AgentDiscovery } from '@agents-hub/core';
import type { HubClient } from './client.js';
import { flagOn, type Args } from './cmd-util.js';
import { renderDiscoveryTable } from './discover-cmd.js';
import { HOOK_TARGETS, hookInstalado, lerConfig } from './hooks-install.js';
import { MCP_TARGETS } from './mcp-install.js';
import { bold, dim, green, red, yellow } from './render.js';

const execFileAsync = promisify(execFile);

/** O mesmo piso do `engines` do package.json raiz. */
const NODE_MINIMO: [number, number, number] = [22, 5, 0];

export interface InitDeps {
  /** Sobe/confere o daemon (em produção, `ensureDaemon`). */
  ensureDaemon: () => Promise<'ja-estava' | 'iniciado'>;
  /** URL do painel/API. */
  url: string;
  /** Diretório a oferecer como projeto (padrão: `process.cwd()`). */
  cwd?: string;
  /**
   * Pergunta sim/não. `undefined` = sem terminal interativo: nada é feito que
   * precise de resposta (só sugerido), a menos que haja `--yes`.
   */
  ask?: (pergunta: string) => Promise<boolean>;
  nodeVersion?: string;
  /** Estado do gate por agente (padrão: lê as configs reais, só leitura). */
  hookInstalado?: (agentId: string) => boolean | null;
}

export interface InitReport {
  node: { version: string; ok: boolean };
  git: { version: string | null };
  daemon: 'ja-estava' | 'iniciado';
  agents: Array<{ id: string; installed: boolean; version: string | null; auth: string }>;
  project: {
    path: string;
    id: string | null;
    action: 'ja-registrado' | 'registrado' | 'sugerido' | 'recusado';
    git: boolean;
    commits: boolean;
  };
  /** Comandos sugeridos — todos em modo prévia; nada foi gravado em config de agente. */
  suggestions: string[];
}

export function versaoAtende(versao: string, minimo: [number, number, number] = NODE_MINIMO): boolean {
  const partes = versao.replace(/^v/, '').split('.').map((p) => Number.parseInt(p, 10));
  for (let i = 0; i < 3; i += 1) {
    const a = partes[i] ?? 0;
    const b = minimo[i]!;
    if (a !== b) return a > b;
  }
  return true;
}

async function git(argv: string[], cwd?: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', argv, { cwd, windowsHide: true, timeout: 15_000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Canônico (8.3 → longo, caixa no Windows): o mesmo critério do registro (item 5.5). */
function mesmoCaminho(a: string, b: string): boolean {
  return chaveDeCaminho(a) === chaveDeCaminho(b);
}

/** Pergunta no terminal; Enter = sim. Só usado quando stdin e stdout são TTY. */
export async function perguntarNoTerminal(pergunta: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const resposta = (await rl.question(`${pergunta} [S/n] `)).trim().toLowerCase();
    return resposta === '' || resposta === 's' || resposta === 'sim' || resposta === 'y' || resposta === 'yes';
  } finally {
    rl.close();
  }
}

function hookPadrao(agentId: string): boolean | null {
  const alvo = HOOK_TARGETS.find((t) => t.id === agentId);
  if (!alvo) return null;
  try {
    return hookInstalado(lerConfig(alvo.configUsuario));
  } catch {
    return null;
  }
}

function passo(n: number, titulo: string): void {
  console.log(`\n${bold(`${n}. ${titulo}`)}`);
}

/**
 * `hub init [--yes]` — o primeiro uso numa tela só (achado MÉDIO da vistoria
 * 14: doctor, discover e painel não se conversavam e não havia onboarding).
 *
 * 1. Node e git; 2. daemon; 3. o que cada CLI de agente já tem (descoberta,
 *    só leitura, sem segredo); 4. o diretório atual como projeto; 5. gate e
 *    MCP — SÓ sugeridos, em modo prévia: gravar em config de outro CLI é
 *    decisão explícita (`--write`), nunca efeito colateral do init.
 *
 * Com `--yes`, responde "sim" sem perguntar (só o registro do projeto muda
 * estado). Sem TTY e sem `--yes`, nada é perguntado: tudo vira sugestão.
 */
export async function initCommand(client: HubClient, args: Args, deps: InitDeps): Promise<InitReport> {
  const sim = flagOn(args, 'yes');
  const cwd = path.resolve(deps.cwd ?? process.cwd());
  const nodeVersion = deps.nodeVersion ?? process.versions.node;
  const sugestoes: string[] = [];

  console.log(bold('Agents-Hub — primeiros passos'));

  // 1. ambiente
  passo(1, 'ambiente');
  const nodeOk = versaoAtende(nodeVersion);
  console.log(
    `${nodeOk ? green('✓') : red('✗')} node ${nodeVersion} ${dim(`(mínimo ${NODE_MINIMO.join('.')})`)}`,
  );
  if (!nodeOk) {
    console.log(`   ${yellow('atualize o Node: o banco do Hub usa node:sqlite, que não existe antes do 22.5')}`);
  } else if (!versaoAtende(nodeVersion, [22, 13, 0])) {
    console.log(`   ${yellow('entre 22.5 e 22.12 o node:sqlite exige --experimental-sqlite; prefira Node 24')}`);
  }
  const gitVersion = await git(['--version']);
  console.log(
    gitVersion
      ? `${green('✓')} ${gitVersion}`
      : `${red('✗')} git não encontrado ${dim('— sessões com isolamento (worktree) precisam dele')}`,
  );

  // 2. daemon
  passo(2, 'daemon');
  const daemon = await deps.ensureDaemon();
  const saude = await client.health();
  console.log(
    `${green('●')} ${daemon === 'iniciado' ? 'daemon iniciado' : 'daemon já estava no ar'} ${dim(`v${saude.version} · ${deps.url}`)}`,
  );

  // 3. agentes
  passo(3, 'agentes (descoberta — só leitura, nunca mostra segredo)');
  const { agents } = await client.discovery();
  const instalados = agents.filter((a) => a.installed);
  console.log(renderDiscoveryTable(agents));
  if (instalados.length === 0) {
    console.log(yellow('nenhum CLI de agente encontrado no PATH. Instale ao menos um (ex.: Claude Code, Codex).'));
  }
  const semAuth = instalados.filter((a) => a.auth.state === 'absent');
  for (const a of semAuth) {
    console.log(`${yellow('⚠')} ${a.agentId}: credencial não encontrada — faça login pelo próprio CLI antes da primeira sessão`);
  }

  // 4. projeto
  passo(4, 'projeto');
  const { projects } = await client.projects();
  const ja = projects.find((p) => mesmoCaminho(p.path, cwd));
  const ehGit = (await git(['rev-parse', '--is-inside-work-tree'], cwd)) === 'true';
  const temCommit = ehGit && (await git(['rev-parse', '--verify', 'HEAD'], cwd)) !== null;
  const projeto: InitReport['project'] = {
    path: cwd,
    id: ja?.id ?? null,
    action: 'sugerido',
    git: ehGit,
    commits: temCommit,
  };
  if (ja) {
    projeto.action = 'ja-registrado';
    console.log(`${green('✓')} ${bold(ja.name)} já registrado ${dim(ja.id)}`);
  } else {
    const pergunta = `registrar ${cwd} como projeto?`;
    const aceitar = sim ? true : deps.ask ? await deps.ask(pergunta) : null;
    if (aceitar === true) {
      const { project } = await client.addProject(cwd);
      projeto.action = 'registrado';
      projeto.id = project.id;
      console.log(`${green('registrado')} ${bold(project.name)} ${dim(project.id)}`);
    } else if (aceitar === false) {
      projeto.action = 'recusado';
      console.log(dim('não registrado. quando quiser:'), bold('hub project add'));
    } else {
      sugestoes.push(`hub project add "${cwd}"`);
      console.log(dim(`${cwd} não está registrado. rode`), bold('hub project add'), dim('ou `hub init --yes`'));
    }
  }
  if (!ehGit) {
    console.log(`${yellow('⚠')} não é um repositório git: sessões com isolamento (worktree) não funcionam aqui`);
  } else if (!temCommit) {
    console.log(`${yellow('⚠')} repositório sem nenhum commit: faça um commit inicial — o worktree da sessão parte do HEAD`);
  }

  // 5. gate e MCP (só prévia)
  passo(5, 'gate pré-execução e MCP (prévia — nada é gravado aqui)');
  const estadoHook = deps.hookInstalado ?? hookPadrao;
  const idsInstalados = new Set(instalados.map((a) => a.agentId));
  for (const alvo of HOOK_TARGETS) {
    if (!idsInstalados.has(alvo.id)) continue;
    const estado = estadoHook(alvo.id);
    if (estado === true) {
      console.log(`${green('✓')} gate instalado em ${alvo.id}`);
    } else {
      sugestoes.push(`hub hooks install ${alvo.id}`);
    }
  }
  if (idsInstalados.has('codex')) sugestoes.push('hub hooks install codex');
  for (const alvo of MCP_TARGETS) {
    if (idsInstalados.has(alvo.agentId)) sugestoes.push(`hub mcp install ${alvo.agentId}`);
  }
  const semPrevia = sugestoes.filter((s) => s.startsWith('hub hooks') || s.startsWith('hub mcp'));
  if (semPrevia.length > 0) {
    console.log(dim('cada comando abaixo só MOSTRA o que gravaria; acrescente --write quando concordar:'));
    for (const s of semPrevia) console.log(`  ${s}`);
  } else if (instalados.length > 0) {
    console.log(dim('nada a sugerir para os agentes instalados.'));
  }

  console.log(`\n${bold('pronto.')} painel: ${bold(deps.url)} ${dim('(hub open)')}`);
  console.log(dim('primeira sessão:'), bold('hub start --agent <id> "objetivo"'));

  return {
    node: { version: nodeVersion, ok: nodeOk },
    git: { version: gitVersion },
    daemon,
    agents: agents.map((a: AgentDiscovery) => ({
      id: a.agentId,
      installed: a.installed,
      version: a.version,
      auth: a.auth.state,
    })),
    project: projeto,
    suggestions: sugestoes,
  };
}
