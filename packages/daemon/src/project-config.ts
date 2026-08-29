import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseDocument, parse as parseYaml, type Document } from 'yaml';
import { HubError, type ContextoDoProjeto, type PolicyDocument } from '@agents-hub/core';

/**
 * Configuração por projeto (ADR 05.2).
 *
 * O Hub é multiprojeto, mas boa parte da política só faz sentido dentro de um
 * repositório específico: o comando de validação de um projeto Node é `npm
 * test`, o de um Python é `pytest`, e não existe padrão global que sirva para
 * os dois. Sem este arquivo o portão de validação seria inutilizável na prática
 * — é por isso que ele existe.
 *
 * Fica em `<repo>/.agents-hub/config.yaml`, versionado junto do código: quem
 * clona o repositório herda as regras que valem ali.
 */
export const PROJECT_CONFIG_RELATIVE = path.join('.agents-hub', 'config.yaml');

/** Só um subconjunto da política é ajustável por projeto — veja a nota abaixo. */
export interface ProjectPolicyOverrides {
  validation?: Partial<PolicyDocument['validation']>;
  commands?: Partial<PolicyDocument['commands']>;
  watch?: Partial<PolicyDocument['watch']>;
  retries?: Partial<PolicyDocument['retries']>;
  fallback?: PolicyDocument['fallback'];
  defaultBudget?: Partial<PolicyDocument['defaultBudget']>;
  maxDepth?: number;
  maxConcurrency?: number;
}

interface Cached {
  mtimeMs: number;
  overrides: ProjectPolicyOverrides;
}

const cache = new Map<string, Cached | null>();

export function projectConfigPath(projectPath: string): string {
  return path.join(projectPath, PROJECT_CONFIG_RELATIVE);
}

/**
 * Lê os overrides do projeto, com cache invalidado por mtime.
 *
 * Reler a cada evento seria caro (a vigilância classifica ação por ação), e
 * cachear para sempre obrigaria a reiniciar o daemon depois de editar o
 * arquivo — o mtime resolve os dois.
 */
export function loadProjectOverrides(projectPath: string): ProjectPolicyOverrides {
  const file = projectConfigPath(projectPath);

  if (!existsSync(file)) {
    cache.set(file, null);
    return {};
  }

  const mtimeMs = statSync(file).mtimeMs;
  const cached = cache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.overrides;

  try {
    const parsed = (parseYaml(readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>;
    const overrides = (parsed['policy'] ?? parsed) as ProjectPolicyOverrides;
    cache.set(file, { mtimeMs, overrides });
    return overrides;
  } catch {
    // Um YAML quebrado não pode derrubar o daemon nem, pior, silenciosamente
    // afrouxar a política: caímos no global, que é o lado seguro.
    cache.set(file, null);
    return {};
  }
}

/**
 * Contexto do projeto: memória e instruções por agente.
 *
 * Mora aqui, e não no navegador, porque precisa valer nos três caminhos que
 * abrem sessão — interface, CLI e **delegação de um agente para outro**. Uma
 * configuração guardada em `localStorage` só existe para quem abriu aquela aba;
 * o agente que recebeu a tarefa delegada não a veria, e é justamente ele quem
 * mais precisa saber as regras da casa.
 *
 * Formato em `<repo>/.agents-hub/config.yaml`:
 *
 * ```yaml
 * memory: |
 *   Este repositório usa npm workspaces. Nunca comite em main.
 * prompts:
 *   codex: "Prefira mudanças pequenas e testáveis."
 *   claude: "Explique a decisão antes de aplicar."
 * ```
 */
export interface ProjectContext {
  memory?: string;
  /** Instruções por `agentId`. */
  prompts?: Record<string, string>;
}

const contextCache = new Map<string, { mtimeMs: number; ctx: ProjectContext } | null>();

/**
 * Lê memória e prompts do projeto, com o mesmo cache por mtime da política.
 *
 * Devolve `{}` em qualquer falha — YAML quebrado não pode derrubar o daemon, e
 * aqui nem sequer há risco de afrouxar política: contexto é texto que vai no
 * prompt, não permissão.
 */
export function loadProjectContext(projectPath: string): ProjectContext {
  const file = projectConfigPath(projectPath);

  if (!existsSync(file)) {
    contextCache.set(file, null);
    return {};
  }

  const mtimeMs = statSync(file).mtimeMs;
  const cached = contextCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.ctx;

  try {
    const parsed = (parseYaml(readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>;
    const ctx: ProjectContext = {};

    const memory = parsed['memory'];
    if (typeof memory === 'string' && memory.trim().length > 0) ctx.memory = memory;

    const prompts = parsed['prompts'];
    if (prompts !== null && typeof prompts === 'object' && !Array.isArray(prompts)) {
      const limpos: Record<string, string> = {};
      for (const [agentId, valor] of Object.entries(prompts as Record<string, unknown>)) {
        // Só string entra. Um número ou objeto aqui viraria "[object Object]"
        // no prompt do agente, que é ruído sem nenhum sinal.
        if (typeof valor === 'string' && valor.trim().length > 0) limpos[agentId] = valor;
      }
      if (Object.keys(limpos).length > 0) ctx.prompts = limpos;
    }

    contextCache.set(file, { mtimeMs, ctx });
    return ctx;
  } catch {
    contextCache.set(file, null);
    return {};
  }
}

/**
 * Grava memória e prompts, preservando o resto do arquivo.
 *
 * Reescrever o YAML inteiro a partir do que a tela conhece apagaria o bloco
 * `policy` — que é onde vivem os limites de segurança do projeto e que nenhuma
 * tela de configurações edita. Uma tela que salva o que ela sabe e descarta o
 * que ela ignora é como se perde configuração sem ninguém notar.
 *
 * Por isso: lê o que está lá, muda só as duas chaves, grava de volta.
 */
export function saveProjectContext(projectPath: string, ctx: ProjectContext): void {
  const file = projectConfigPath(projectPath);

  // `parseDocument`, não `parse`.
  //
  // O ciclo `parse` -> objeto -> `stringify` preserva as CHAVES e destrói os
  // COMENTÁRIOS. Medido: salvar o contexto uma vez apagou 17 linhas deste
  // arquivo, incluindo a explicação de que o projeto só pode apertar a política
  // global, nunca afrouxar. As chaves continuavam lá, então nada quebrava — a
  // documentação da regra é que sumia, e ninguém notaria até precisar dela.
  //
  // O `Document` do `yaml` mantém comentários, ordem e formatação.
  let doc: Document;
  if (existsSync(file)) {
    const bruto = readFileSync(file, 'utf8');
    doc = parseDocument(bruto);
    if (doc.errors.length > 0) {
      // YAML quebrado: sobrescrever apagaria a política junto. Recusar é o
      // único caminho honesto.
      throw new HubError(
        'PROJECT_CONFIG_INVALID',
        `${file} não é YAML válido. Corrija o arquivo antes de salvar por aqui — ` +
          'sobrescrevê-lo apagaria a política do projeto junto.',
        { path: file },
      );
    }
  } else {
    doc = parseDocument('');
  }

  const memoria = ctx.memory?.trim();
  if (memoria) doc.set('memory', memoria);
  else doc.delete('memory');

  const prompts = ctx.prompts ?? {};
  const limpos: Record<string, string> = {};
  for (const [agentId, valor] of Object.entries(prompts)) {
    if (typeof valor === 'string' && valor.trim().length > 0) limpos[agentId] = valor.trim();
  }
  if (Object.keys(limpos).length > 0) doc.set('prompts', limpos);
  else doc.delete('prompts');

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, String(doc), 'utf8');

  // O cache é por mtime, mas gravar e ler no mesmo milissegundo devolveria o
  // valor velho. Invalidar explicitamente evita esse ponto cego.
  contextCache.delete(file);
  cache.delete(file);
}

/** O contexto que este agente deve receber neste projeto. */
export function contextForAgent(ctx: ProjectContext, agentId: string): ContextoDoProjeto {
  return {
    memoria: ctx.memory,
    instrucoesDoAgente: ctx.prompts?.[agentId],
  };
}

/**
 * Funde os overrides do projeto sobre a política global.
 *
 * REGRA: o projeto pode APERTAR, nunca afrouxar o que é limite de segurança.
 * `maxDepth` e `maxConcurrency` só descem; a allow list de comandos só perde
 * itens; a deny list só ganha. Se um repositório pudesse elevar o próprio teto,
 * bastaria um `.agents-hub/config.yaml` malicioso num repo clonado para o Hub
 * passar a executar o que ele quisesse.
 */
export function mergeProjectPolicy(
  global: PolicyDocument,
  overrides: ProjectPolicyOverrides,
): PolicyDocument {
  return {
    ...global,
    maxDepth: Math.min(global.maxDepth, overrides.maxDepth ?? global.maxDepth),
    maxConcurrency: Math.min(
      global.maxConcurrency,
      overrides.maxConcurrency ?? global.maxConcurrency,
    ),
    defaultBudget: { ...global.defaultBudget, ...(overrides.defaultBudget ?? {}) },
    retries: { ...global.retries, ...(overrides.retries ?? {}) },
    fallback: { ...global.fallback, ...(overrides.fallback ?? {}) },
    commands: {
      allow: overrides.commands?.allow
        ? overrides.commands.allow.filter((c) => global.commands.allow.includes(c))
        : global.commands.allow,
      deny: [...new Set([...global.commands.deny, ...(overrides.commands?.deny ?? [])])],
    },
    watch: {
      pauseOn: [...new Set([...global.watch.pauseOn, ...(overrides.watch?.pauseOn ?? [])])],
      flagOn: [...new Set([...global.watch.flagOn, ...(overrides.watch?.flagOn ?? [])])],
    },
    validation: { ...global.validation, ...(overrides.validation ?? {}) },
  };
}

export function clearProjectConfigCache(): void {
  cache.clear();
}
