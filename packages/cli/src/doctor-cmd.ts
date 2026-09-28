import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { isHubError, PartialPolicyDocumentSchema, type AgentDiscovery } from '@agents-hub/core';
import { loadConfig } from '@agents-hub/daemon';
import type { AgentSummary, HubClient, ProbeSummary } from './client.js';
import { avisoDeTimeoutDoHook, HOOK_TARGETS, lerConfig } from './hooks-install.js';
import { bold, cyan, dim, green, red, stateBadge, yellow } from './render.js';
import { SMOKE_ORCAMENTO_USD, smokeTestAll, type SmokeOutcome } from './doctor-smoke.js';

/**
 * `hub doctor` e `hub status` — fora de `main.ts` para ser testável.
 *
 * Antes, "disponível" era só "o binário respondeu a `--version`": o
 * Antigravity aparecia disponível com um manifesto que não servia mais para a
 * versão instalada, e agente sem login também. O `hub discover` já sabia a
 * auth (presença de credencial) e o manifesto sabe contra qual versão foi
 * conferido — agora os dois entram no veredito (vistoria 2026-09-25, 11 e 14).
 */

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

type Log = (linha: string) => void;
const NEWLINE = String.fromCharCode(10);

export type EstadoDoAgente = 'pronto' | 'atencao' | 'quebrado' | 'ausente';

export interface SaudeDoAgente {
  agentId: string;
  estado: EstadoDoAgente;
  versao: string | null;
  binPath: string | null;
  auth: 'present' | 'absent' | 'unknown' | null;
  /** Por que não está `pronto` (vazio quando está). */
  motivos: string[];
  /** O que fazer: login, instalação, conferir versão. */
  dica: string | null;
}

/** `1.2.10` -> `1.2`; `null` quando não há número de versão reconhecível. */
function majorMinor(v: string | null | undefined): string | null {
  const m = /(\d+)\.(\d+)/.exec(v ?? '');
  return m ? `${m[1]}.${m[2]}` : null;
}

/**
 * Junta probe (`--version`), descoberta (auth) e manifesto (versão
 * conferida) num veredito por agente. Puro, para ser testado sem daemon.
 *
 * - `ausente`: binário não encontrado.
 * - `quebrado`: o probe acusou erro, ou nenhuma credencial foi encontrada
 *   (a primeira sessão falharia pedindo login).
 * - `atencao`: funciona até onde dá para ver sem gastar, mas a versão
 *   instalada difere da conferida no manifesto (flags podem ter mudado — foi
 *   o que quebrou o Antigravity) ou a versão é desconhecida.
 * - `pronto`: nada contra. "auth presente" é presença de credencial, não
 *   validade: só `--smoke` prova com uma chamada real.
 */
export function avaliarAgentes(
  probes: readonly ProbeSummary[],
  agents: readonly AgentSummary[],
  descobertas: readonly AgentDiscovery[],
): SaudeDoAgente[] {
  const porAgente = new Map(agents.map((a) => [a.id, a]));
  const porDescoberta = new Map(descobertas.map((d) => [d.agentId, d]));
  const ids = new Set([...agents.map((a) => a.id), ...probes.map((p) => p.agentId)]);

  const resultado: SaudeDoAgente[] = [];
  for (const id of ids) {
    const agente = porAgente.get(id);
    const probe = probes.find((p) => p.agentId === id) ?? agente?.probe ?? null;
    const desc = porDescoberta.get(id);
    const saude: SaudeDoAgente = {
      agentId: id,
      estado: 'pronto',
      versao: probe?.version ?? desc?.version ?? null,
      binPath: probe?.binPath ?? desc?.binPath ?? null,
      auth: desc?.auth.state ?? null,
      motivos: [],
      dica: null,
    };

    if (!probe?.installed) {
      saude.estado = 'ausente';
      saude.dica = agente?.loginHint || null;
      resultado.push(saude);
      continue;
    }

    const quebrar = (motivo: string): void => {
      saude.estado = 'quebrado';
      saude.motivos.push(motivo);
    };
    const atencao = (motivo: string): void => {
      if (saude.estado === 'pronto') saude.estado = 'atencao';
      saude.motivos.push(motivo);
    };

    if (probe.error) quebrar(probe.error);

    if (desc?.auth.state === 'absent') {
      quebrar('nenhuma credencial encontrada (login/chave): a sessão falharia ao autenticar');
      saude.dica = agente?.loginHint || null;
    }

    const conferida = agente?.verified.version ?? null;
    if (saude.versao === null) {
      atencao('versão desconhecida (o binário não informou --version)');
    } else if (conferida !== null && majorMinor(conferida) !== majorMinor(saude.versao)) {
      atencao(
        `instalada ${saude.versao}, manifesto conferido na ${conferida}: as flags podem ter mudado ` +
          '(confirme com hub doctor --smoke)',
      );
    } else if (agente?.verified.status === 'unverified') {
      atencao('manifesto não conferido contra o binário real');
    }

    resultado.push(saude);
  }

  const ordem: Record<EstadoDoAgente, number> = { pronto: 0, atencao: 1, quebrado: 2, ausente: 3 };
  return resultado.sort(
    (a, b) => ordem[a.estado] - ordem[b.estado] || a.agentId.localeCompare(b.agentId),
  );
}

function icone(estado: EstadoDoAgente): string {
  return { pronto: green('✓'), atencao: yellow('!'), quebrado: red('✗'), ausente: dim('○') }[estado];
}

function rotuloAuth(auth: SaudeDoAgente['auth']): string {
  if (auth === null) return dim('auth ?');
  return { present: green('auth presente'), absent: red('sem auth'), unknown: dim('auth ?') }[auth];
}

/** Descoberta é best-effort: daemon antigo ou leitor quebrado não derruba o doctor. */
async function descobrir(client: HubClient, refresh: boolean): Promise<AgentDiscovery[]> {
  try {
    return (await client.discovery(refresh)).agents;
  } catch {
    return [];
  }
}

export interface ProblemaDeConfig {
  /** Caminho do campo com pontos (`policy.maxDepht`), ou `(arquivo)` para JSON quebrado. */
  campo: string;
  problema: string;
  dica: string | null;
}

export interface DiagnosticoDeConfig {
  arquivo: string;
  /** Vazio quando o arquivo é válido (ou não existe: valem os padrões). */
  problemas: ProblemaDeConfig[];
}

/** Distância de edição — só para sugerir a chave certa num erro de digitação. */
function distancia(a: string, b: string): number {
  let anterior = Array.from({ length: b.length + 1 }, (_v, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const atual = [i];
    for (let j = 1; j <= b.length; j++) {
      const custo = a[i - 1]!.toLowerCase() === b[j - 1]!.toLowerCase() ? 0 : 1;
      atual[j] = Math.min(atual[j - 1]! + 1, anterior[j]! + 1, anterior[j - 1]! + custo);
    }
    anterior = atual;
  }
  return anterior[b.length]!;
}

/**
 * Chaves que o schema da política aceita em `caminho` (relativo a `policy`).
 * Anda pelo schema do zod por duck typing (`shape`, `unwrap`, `innerType`)
 * porque a CLI não depende do zod diretamente; o schema é a fonte da verdade
 * e o `DEFAULT_POLICY` não serve, porque omite os campos opcionais.
 */
function chavesAceitas(caminho: readonly (string | number)[]): string[] {
  const desembrulhar = (no: unknown): unknown => {
    for (;;) {
      const s = no as { unwrap?: () => unknown; innerType?: () => unknown } | null | undefined;
      if (typeof s?.unwrap === 'function') no = s.unwrap();
      else if (typeof s?.innerType === 'function') no = s.innerType();
      else return no;
    }
  };
  const forma = (no: unknown): Record<string, unknown> | undefined =>
    (desembrulhar(no) as { shape?: Record<string, unknown> } | null | undefined)?.shape;
  let no: unknown = PartialPolicyDocumentSchema;
  for (const parte of caminho) no = forma(no)?.[String(parte)];
  return Object.keys(forma(no) ?? {});
}

/** Traduz o erro de validação em campo + problema + como corrigir. */
function problemasDaConfig(arquivo: string, issuesDoDaemon: unknown): ProblemaDeConfig[] {
  let bruto: unknown;
  try {
    bruto = JSON.parse(readFileSync(arquivo, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    return [
      {
        campo: '(arquivo)',
        problema: `não é JSON válido — ${(err as Error).message}`,
        dica: 'corrija a sintaxe (vírgula sobrando, aspas, chave sem fechar) e rode hub doctor de novo',
      },
    ];
  }

  const problemas: ProblemaDeConfig[] = [];
  const policy = (bruto as { policy?: unknown } | null)?.policy;
  if (policy !== undefined) {
    // Revalida `policy` aqui só para ter os issues ESTRUTURADOS (caminho e
    // chaves), que o daemon achata em texto no HubError.
    const r = PartialPolicyDocumentSchema.safeParse(policy);
    for (const issue of r.success ? [] : r.error.issues) {
      const base = ['policy', ...issue.path.map(String)];
      if (issue.code !== 'unrecognized_keys') {
        problemas.push({ campo: base.join('.'), problema: issue.message, dica: null });
        continue;
      }
      const aceitas = chavesAceitas(issue.path);
      for (const chave of issue.keys) {
        const parecida = aceitas
          .map((c) => ({ c, d: distancia(chave, c) }))
          .filter(({ d }) => d <= 2)
          .sort((a, b) => a.d - b.d)[0]?.c;
        problemas.push({
          campo: [...base, chave].join('.'),
          problema: 'chave desconhecida',
          dica: parecida
            ? `você quis dizer "${[...base, parecida].join('.')}"?`
            : `chaves aceitas em ${base.join('.')}: ${aceitas.join(', ')}`,
        });
      }
    }
  }

  // O resto (porta fora da faixa, caminho vazio...) vem pronto do daemon,
  // como "campo: mensagem"; `policy` já foi detalhado acima.
  const issues = Array.isArray(issuesDoDaemon) ? issuesDoDaemon : [];
  for (const linha of issues) {
    if (typeof linha !== 'string' || /^policy(\.|:)/.test(linha)) continue;
    const corte = linha.indexOf(': ');
    problemas.push({
      campo: corte > 0 ? linha.slice(0, corte) : '(raiz)',
      problema: corte > 0 ? linha.slice(corte + 2) : linha,
      dica: null,
    });
  }
  return problemas;
}

/**
 * Valida o `config.json` global do Hub do jeito que o daemon vai validar ao
 * subir (`loadConfig`), sem falar com o daemon.
 *
 * Existe porque, desde R09-12, chave desconhecida em `policy` impede o daemon
 * de subir — de propósito: política é segurança, e um `maxDepht` digitado
 * errado não pode virar o padrão em silêncio. O custo era o usuário descobrir
 * isso só no crash do daemon (ou num stack trace do próprio `hub doctor`, que
 * também chamava `loadConfig` sem tratar). Outros erros (variável de ambiente
 * malformada, por exemplo) seguem lançando: não são do arquivo.
 */
export function diagnosticarConfig(env: NodeJS.ProcessEnv = process.env): DiagnosticoDeConfig {
  try {
    const config = loadConfig({}, env);
    return { arquivo: path.join(config.home, 'config.json'), problemas: [] };
  } catch (err) {
    if (!isHubError(err) || err.code !== 'HUB_CONFIG_INVALID') throw err;
    const arquivo = typeof err.details['path'] === 'string' ? err.details['path'] : 'config.json';
    const problemas = problemasDaConfig(arquivo, err.details['issues']);
    // Nunca devolver "inválido" sem dizer o quê: se a tradução não achou
    // nada, a mensagem do daemon vai inteira.
    if (problemas.length === 0)
      problemas.push({ campo: '(arquivo)', problema: err.message, dica: null });
    return { arquivo, problemas };
  }
}

/**
 * Primeira seção do `hub doctor`. Devolve `false` com a config inválida: aí
 * o doctor para, porque o daemon não subiria para responder o resto.
 */
export function doctorDaConfig(o: { log?: Log; env?: NodeJS.ProcessEnv } = {}): boolean {
  const log = o.log ?? ((l: string) => console.log(l));
  const d = diagnosticarConfig(o.env);
  if (d.problemas.length === 0) {
    log(
      `${green('✓')} ${bold('config.json')} ${dim(existsSync(d.arquivo) ? d.arquivo : `${d.arquivo} (ausente: valem os padrões)`)}`,
    );
    return true;
  }
  log(
    `${red('✗')} ${bold('config.json global inválido')} ${red('— o daemon NÃO sobe com este arquivo')}`,
  );
  log(`   ${dim(d.arquivo)}`);
  for (const p of d.problemas) {
    log(`   ${red(p.campo)}: ${p.problema}`);
    if (p.dica) log(`     ${dim(p.dica)}`);
  }
  log(
    dim(
      `${NEWLINE}"policy" é validada campo a campo: um limite digitado errado não pode virar o padrão em silêncio. ` +
        'Corrija ou remova o campo e rode hub doctor de novo. Um daemon que já está no ar segue com a config ' +
        'que leu ao subir; o próximo start/restart falharia.',
    ),
  );
  return false;
}

export interface OpcoesDeDoctor {
  log?: Log;
  /** Pergunta sim/não; o padrão lê do terminal. Injetável para teste. */
  confirmar?: (pergunta: string) => Promise<boolean>;
  /** Terminal interativo? Sem TTY e sem `--yes`, o smoke recusa. */
  interativo?: boolean;
  /** Home do Hub, onde fica o projeto descartável do smoke. */
  home: string;
  /** Repassado ao smoke (testes usam valores curtos). */
  smoke?: { pollMs?: number; timeoutMs?: number };
}

export async function doctorCommand(
  client: HubClient,
  args: Args,
  o: OpcoesDeDoctor,
): Promise<SaudeDoAgente[]> {
  const log = o.log ?? ((l: string) => console.log(l));
  log(dim(`checando agentes…${NEWLINE}`));
  const [{ probes }, { agents }, descobertas] = await Promise.all([
    client.probeAgents(),
    client.agents(),
    descobrir(client, true),
  ]);
  const saude = avaliarAgentes(probes, agents, descobertas);

  for (const s of saude) {
    if (s.estado === 'ausente') {
      log(`${icone(s.estado)} ${bold(s.agentId.padEnd(13))} ${red('não instalado')}`);
      if (s.dica) log(`   ${dim(s.dica)}`);
      continue;
    }
    log(
      `${icone(s.estado)} ${bold(s.agentId.padEnd(13))} ${dim(s.versao ?? 'versão desconhecida')}  ${rotuloAuth(s.auth)}`,
    );
    if (s.binPath) log(`   ${dim(s.binPath)}`);
    for (const motivo of s.motivos) log(`   ${s.estado === 'quebrado' ? red(motivo) : yellow(motivo)}`);
    if (s.estado === 'quebrado' && s.dica) log(`   ${dim(s.dica)}`);
  }

  const prontos = saude.filter((s) => s.estado === 'pronto' || s.estado === 'atencao').length;
  const quebrados = saude.filter((s) => s.estado === 'quebrado').length;
  log(
    `${NEWLINE}${prontos} de ${saude.length} agentes utilizáveis${quebrados > 0 ? `, ${red(`${quebrados} quebrado(s)`)}` : ''}. ${dim(
      '"auth presente" é credencial encontrada, não validada: só --smoke prova com uma chamada real.',
    )}`,
  );

  // Gate pré-execução: instalação antiga (timeout 10 s) deixa a ação que pede
  // aprovação rodar sem ela. Só leitura das configs dos agentes.
  for (const alvo of HOOK_TARGETS) {
    const aviso = avisoDeTimeoutDoHook(lerConfig(alvo.configUsuario));
    if (aviso) {
      log(
        `${NEWLINE}${yellow(`⚠ ${alvo.id}: ${aviso}`)}${NEWLINE}   ${dim('corrija com:')} ${bold(`hub hooks install ${alvo.id} --write`)}`,
      );
    }
  }

  if (args.flags['smoke'] === true) {
    await doctorSmoke(client, args, saude, o);
  }
  return saude;
}

/**
 * Pasta descartável do smoke: `git init` com um commit (o worktree isolado
 * nasce de um commit). Fica no home do Hub e é reaproveitada entre execuções
 * — o registro no daemon é idempotente, então não acumula projetos.
 */
export function prepararProjetoDeSmoke(home: string): string {
  const dir = path.join(home, 'smoke-projeto');
  mkdirSync(dir, { recursive: true });
  if (!existsSync(path.join(dir, '.git'))) {
    const git = (...a: string[]): void => {
      execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    };
    git('init');
    writeFileSync(
      path.join(dir, 'README.md'),
      '# smoke do Agents-Hub\n\nProjeto descartável usado por `hub doctor --smoke`.\n',
      'utf8',
    );
    git('add', '-A');
    git(
      '-c',
      'user.name=agents-hub',
      '-c',
      'user.email=smoke@agents-hub.invalid',
      'commit',
      '-q',
      '-m',
      'smoke: commit inicial',
    );
  }
  return dir;
}

async function confirmarNoTerminal(pergunta: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const resposta = (await rl.question(pergunta)).trim().toLowerCase();
    return resposta === 's' || resposta === 'sim' || resposta === 'y' || resposta === 'yes';
  } finally {
    rl.close();
  }
}

/**
 * `hub doctor --smoke`: uma sessão REAL e trivial por agente, em série, com
 * teto de US$ 0,10 cada, num projeto descartável. Gasta tokens/créditos:
 * pede confirmação (ou `--yes`) e nunca roda sem terminal para perguntar.
 */
async function doctorSmoke(
  client: HubClient,
  args: Args,
  saude: SaudeDoAgente[],
  o: OpcoesDeDoctor,
): Promise<void> {
  const log = o.log ?? ((l: string) => console.log(l));
  const filtro = typeof args.flags['agent'] === 'string' ? args.flags['agent'] : undefined;
  const ids = saude
    .filter((s) => s.estado !== 'ausente' && (filtro === undefined || s.agentId === filtro))
    .map((s) => s.agentId);
  if (ids.length === 0) {
    log(
      `${NEWLINE}${dim(filtro ? `agente "${filtro}" não está instalado — nada para testar.` : 'nenhum agente instalado — nada para testar com --smoke.')}`,
    );
    return;
  }

  const teto = SMOKE_ORCAMENTO_USD;
  log(
    `${NEWLINE}${bold(yellow('⚠ --smoke abre sessões REAIS'))} com ${ids.length} agente(s), um por vez: ${ids.join(', ')}.`,
  );
  log(
    dim(
      `Cada uma pede "responda OK" com teto de US$ ${teto.toFixed(2)} (até ~US$ ${(teto * ids.length).toFixed(2)} no total). ` +
        'O Copilot fatura em créditos, não em dólares — confira seu plano.',
    ),
  );

  if (args.flags['yes'] !== true) {
    const interativo = o.interativo ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
    if (!interativo) {
      log(red('sem terminal interativo para confirmar: rode de novo com --yes para aceitar o gasto.'));
      process.exitCode = 1;
      return;
    }
    const confirmar = o.confirmar ?? confirmarNoTerminal;
    if (!(await confirmar('Continuar? [s/N] '))) {
      log(dim('cancelado — nenhuma sessão aberta.'));
      return;
    }
  }

  const dir = prepararProjetoDeSmoke(o.home);
  const { project } = await client.addProject(dir);
  log(dim(`projeto descartável: ${dir}${NEWLINE}`));

  const outcomes = await smokeTestAll(
    client,
    ids,
    { projectId: project.id, budgetUsd: teto, ...o.smoke },
    1,
    (outcome) => log(renderSmokeOutcome(outcome)),
  );

  const ok = outcomes.filter((x) => x.finalState === 'completed').length;
  log(`${NEWLINE}${ok} de ${outcomes.length} agentes completaram uma sessão real com sucesso.`);
  if (ok < outcomes.length) process.exitCode = 1;
}

export function renderSmokeOutcome(outcome: SmokeOutcome): string {
  const icon = outcome.finalState === 'completed' ? green('✓') : red('✗');
  const flag = (v: boolean): string => (v ? green('sim') : red('não'));
  const linhas = [
    `${icon} ${bold(outcome.agentId.padEnd(13))} processo:${flag(outcome.processStarted)}  ` +
      `turn.completed:${flag(outcome.turnCompleted)}  custo:${flag(outcome.costCaptured)}  ` +
      `nativeSessionId:${flag(outcome.nativeSessionIdCaptured)}`,
  ];
  if (outcome.finalState) linhas.push(`   ${dim(`estado final: ${outcome.finalState}`)}`);
  if (outcome.error) linhas.push(`   ${yellow(outcome.error)}`);
  return linhas.join(NEWLINE);
}

/** Uma tela com tudo que importa saber antes de começar a trabalhar. */
export async function statusCommand(
  client: HubClient,
  home: string,
  o: { log?: Log } = {},
): Promise<SaudeDoAgente[]> {
  const log = o.log ?? ((l: string) => console.log(l));
  const [saudeDaemon, { agents }, { sessions }, { approvals }, descobertas] = await Promise.all([
    client.health(),
    client.agents(),
    client.sessions(),
    client.approvals(),
    descobrir(client, false),
  ]);

  // Probe em cache do `/agents` (o status não reexecuta binários).
  const probes = agents.flatMap((a) => (a.probe ? [a.probe] : []));
  const saude = avaliarAgentes(probes, agents, descobertas);
  const utilizaveis = saude.filter((s) => s.estado === 'pronto' || s.estado === 'atencao');
  const quebrados = saude.filter((s) => s.estado === 'quebrado');
  const vivas = sessions.filter((s) => s.state === 'running' || s.state === 'waiting_approval');

  // `home` vem do config local da CLI: o `/health` deixou de expor o caminho
  // do usuário.
  log(`${green('●')} daemon no ar ${dim(`v${saudeDaemon.version} · ${home}`)}`);
  log(
    `${dim('agentes:  ')} ${utilizaveis.length}/${saude.length} disponíveis ${dim(utilizaveis.map((a) => a.agentId).join(', '))}`,
  );
  for (const q of quebrados) {
    log(`   ${red('✗')} ${bold(q.agentId)} ${dim(q.motivos[0] ?? 'quebrado')}`);
  }
  if (quebrados.length > 0) log(`   ${dim('detalhes: hub doctor')}`);
  log(`${dim('sessões:  ')} ${vivas.length} ativa(s) de ${sessions.length} no histórico`);

  for (const sessao of vivas.slice(0, 8)) {
    log(
      `   ${stateBadge(sessao.state)} ${bold(sessao.id)} ${cyan(sessao.agentId)} ${dim(sessao.title ?? '')}`,
    );
  }

  if (approvals.length > 0) {
    log(
      `${NEWLINE}${yellow(`⏸ ${approvals.length} aprovação(ões) esperando você`)} ${dim('— hub approvals')}`,
    );
  }
  return saude;
}
