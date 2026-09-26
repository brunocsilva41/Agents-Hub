import { createHash } from 'node:crypto';
import {
  filtrarEnvDeProjeto,
  type Project,
  type ProjectHubContext,
  type UnitOfWork,
} from '@agents-hub/core';
import {
  loadProjectContext,
  projectConfigPath,
  rawRepoExecFields,
  type ProjectContext,
} from './project-config.js';

/**
 * Confiança no conteúdo sensível do `.agents-hub/config.yaml` do repositório
 * (item 1.9 do GOAL; achados ALTO de 05-permissoes-seguranca e MÉDIO de
 * 02-adrs-seguranca-docs da vistoria 2026-09-25).
 *
 * O arquivo é versionado: quem clona o repo herda-o. Os campos que ele pode
 * declarar e que mudam o que a máquina de quem clonou FAZ são:
 *
 * | campo                         | vetor                                             |
 * |-------------------------------|---------------------------------------------------|
 * | `policy.validation.command`   | executa processo (`shell: true`)                  |
 * | `policy.validation.review.*`  | liga/escolhe o agente revisor (outro binário)     |
 * | `env.<agente>.*`              | destino de rede e credenciais: `*_BASE_URL`,      |
 * |                               | `*_API_BASE`, `*_API_KEY`, `GOOGLE_*`...          |
 * | `prompts.<agente>`            | instruções injetadas no prompt do agente          |
 * | `memory`                      | idem, para todos os agentes                       |
 *
 * O resto do arquivo (`policy.commands`, orçamento, `maxDepth`, `fallback`...)
 * só consegue APERTAR a política global (`mergePolicyLayer` com
 * `clampToBase`), então não precisa de confiança. `NODE_OPTIONS`, `PATH`,
 * `HTTP(S)_PROXY`, `NODE_EXTRA_CA_CERTS` etc. nem com confiança passam: a lista
 * de permissão de `agent-env.ts` recusa qualquer nome fora dos prefixos de
 * provedor.
 *
 * Sem confiança, os campos da tabela são IGNORADOS (com aviso). Com confiança,
 * vale trust-on-first-use: o hash do conteúdo sensível é gravado junto da
 * marca; se o repositório mudar esse conteúdo (um `git pull` que troca a
 * `ANTHROPIC_BASE_URL`), o hash deixa de bater e a confiança fica SUSPENSA
 * até o usuário reconfirmar com `hub project trust`.
 *
 * O que o usuário configura PELO HUB (painel, `hub project env|prompt`,
 * `hub import`) não passa por aqui: mora no banco (`ProjectHubContext`), fora
 * do repositório, e é confiável por construção.
 */

export type RepoTrustState = 'untrusted' | 'trusted' | 'suspended';

export interface RepoTrust {
  state: RepoTrustState;
  /** Hash do conteúdo sensível ATUAL do arquivo do repositório. */
  contentHash: string;
  /**
   * Campos sensíveis que o arquivo declara, legíveis para o usuário (ex.:
   * `env.claude.ANTHROPIC_BASE_URL = http://...`, `prompts.codex`, `memory`,
   * `validation.command = npm test`). O valor aparece para destino/comando,
   * que é o que o usuário precisa ver para decidir; texto de prompt não.
   */
  sensitiveFields: string[];
}

/** Conteúdo sensível do repositório, na forma que entra no hash. */
function conteudoSensivel(projectPath: string): {
  conteudo: Record<string, unknown>;
  campos: string[];
} {
  const ctx = loadProjectContext(projectPath).ctx;
  const exec = rawRepoExecFields(projectPath);
  const campos: string[] = [];

  if (exec.command !== undefined) campos.push(`validation.command = ${String(exec.command)}`);
  if (exec.reviewEnabled !== undefined) {
    campos.push(`validation.review.enabled = ${String(exec.reviewEnabled)}`);
  }
  if (exec.reviewAgent !== undefined) {
    campos.push(`validation.review.agent = ${String(exec.reviewAgent)}`);
  }
  for (const [agentId, vars] of Object.entries(ctx.env ?? {})) {
    for (const [nome, valor] of Object.entries(vars)) {
      // Destino de rede aparece com o valor: é exatamente o que decide se o
      // `*_BASE_URL` é o seu Ollama ou o servidor de outra pessoa. Chave de
      // API não aparece (não é para ecoar segredo em log).
      campos.push(
        /URL|BASE|ENDPOINT|HOST/i.test(nome) && !/KEY|TOKEN|SECRET/i.test(nome)
          ? `env.${agentId}.${nome} = ${valor}`
          : `env.${agentId}.${nome}`,
      );
    }
  }
  for (const agentId of Object.keys(ctx.prompts ?? {})) campos.push(`prompts.${agentId}`);
  if (ctx.memory !== undefined) campos.push('memory');

  return {
    conteudo: {
      validation: exec,
      env: ctx.env ?? {},
      prompts: ctx.prompts ?? {},
      memory: ctx.memory ?? null,
    },
    campos,
  };
}

/** JSON com chaves ordenadas: o hash não pode depender da ordem no YAML. */
function canonico(valor: unknown): string {
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(',')}]`;
  if (valor !== null && typeof valor === 'object') {
    const chaves = Object.keys(valor as Record<string, unknown>).sort();
    return `{${chaves
      .map((k) => `${JSON.stringify(k)}:${canonico((valor as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(valor ?? null);
}

/** Hash e lista dos campos sensíveis do `config.yaml` do repositório, agora. */
export function repoSensitiveContent(projectPath: string): {
  contentHash: string;
  sensitiveFields: string[];
} {
  const { conteudo, campos } = conteudoSensivel(projectPath);
  return {
    contentHash: `sha256:${createHash('sha256').update(canonico(conteudo)).digest('hex')}`,
    sensitiveFields: campos,
  };
}

/**
 * Estado da confiança no conteúdo do repositório deste projeto.
 *
 * `trusted` só se o usuário confiou E o conteúdo sensível é o mesmo que ele
 * confiou. Confiança sem hash (dada antes do hash existir) conta como
 * suspensa: o usuário nunca viu ESTE conteúdo aprovado.
 */
export function evaluateRepoTrust(project: Project): RepoTrust {
  const { contentHash, sensitiveFields } = repoSensitiveContent(project.path);
  let state: RepoTrustState = 'untrusted';
  if (project.trusted === true) {
    state = project.trustedHash === contentHash ? 'trusted' : 'suspended';
  }
  return { state, contentHash, sensitiveFields };
}

/**
 * Aviso para quando campos sensíveis do repositório foram ignorados, ou
 * `null` quando não há nada ignorado (confiável, ou arquivo sem esses campos).
 */
export function repoTrustWarning(projectPath: string, trust: RepoTrust): string | null {
  if (trust.state === 'trusted' || trust.sensitiveFields.length === 0) return null;
  const arquivo = projectConfigPath(projectPath);
  const campos = trust.sensitiveFields.join('; ');
  if (trust.state === 'suspended') {
    return (
      `${arquivo} MUDOU desde que você confiou neste projeto — confiança SUSPENSA. ` +
      `Campos do repositório IGNORADOS até você reconfirmar: ${campos}. ` +
      'Revise o arquivo e, se confiar no conteúdo novo, rode "hub project trust <projeto>" de novo.'
    );
  }
  return (
    `${arquivo} declara ${campos} — execução de processo, destino de rede/credenciais do ` +
    'agente ou instruções ao agente, IGNORADO(S) porque este projeto não está marcado como ' +
    'confiável. Revise o arquivo e, se confiar nele, rode "hub project trust <projeto>".'
  );
}

/** Contexto do usuário (Hub) limpo: memória aparada, prompts não vazios, env filtrado. */
export function sanitizeHubContext(ctx: ProjectHubContext): ProjectHubContext {
  const limpo: ProjectHubContext = {};
  const memoria = ctx.memory?.trim();
  if (memoria) limpo.memory = memoria;

  const prompts: Record<string, string> = {};
  for (const [agentId, valor] of Object.entries(ctx.prompts ?? {})) {
    if (typeof valor === 'string' && valor.trim().length > 0) prompts[agentId] = valor.trim();
  }
  if (Object.keys(prompts).length > 0) limpo.prompts = prompts;

  // A lista de permissão vale também para o que o usuário digita: confiável
  // quanto à ORIGEM não quer dizer que `NODE_OPTIONS` deva chegar ao agente.
  const env: Record<string, Record<string, string>> = {};
  for (const [agentId, bloco] of Object.entries(ctx.env ?? {})) {
    if (bloco === null || typeof bloco !== 'object') continue;
    const { aceitas } = filtrarEnvDeProjeto(bloco);
    if (Object.keys(aceitas).length > 0) env[agentId] = aceitas;
  }
  if (Object.keys(env).length > 0) limpo.env = env;
  return limpo;
}

/**
 * Contexto efetivo: o do repositório (SÓ se confiável e não suspenso) com o
 * do usuário (Hub) por cima.
 *
 * Memória: as duas, repositório primeiro. Instrução por agente: a do Hub
 * vence. Env: variável a variável, a do Hub vence.
 */
export function mergeContexts(
  repo: ProjectContext | null,
  hub: ProjectHubContext,
): ProjectContext {
  const base = repo ?? {};
  const efetivo: ProjectContext = {};

  const memorias = [base.memory?.trim(), hub.memory?.trim()].filter(
    (m): m is string => typeof m === 'string' && m.length > 0,
  );
  if (memorias.length > 0) efetivo.memory = memorias.join('\n\n');

  const prompts = { ...(base.prompts ?? {}), ...(hub.prompts ?? {}) };
  if (Object.keys(prompts).length > 0) efetivo.prompts = prompts;

  const env: Record<string, Record<string, string>> = {};
  for (const agentId of new Set([...Object.keys(base.env ?? {}), ...Object.keys(hub.env ?? {})])) {
    const { aceitas } = filtrarEnvDeProjeto({
      ...(base.env?.[agentId] ?? {}),
      ...(hub.env?.[agentId] ?? {}),
    });
    if (Object.keys(aceitas).length > 0) env[agentId] = aceitas;
  }
  if (Object.keys(env).length > 0) efetivo.env = env;
  return efetivo;
}

/** Contexto que o agente recebe neste projeto, com o estado da confiança. */
export function effectiveProjectContext(
  store: Pick<UnitOfWork, 'projects'>,
  project: Project,
): { ctx: ProjectContext; trust: RepoTrust } {
  const trust = evaluateRepoTrust(project);
  const repo = trust.state === 'trusted' ? loadProjectContext(project.path).ctx : null;
  return { ctx: mergeContexts(repo, store.projects.getHubContext(project.id)), trust };
}
