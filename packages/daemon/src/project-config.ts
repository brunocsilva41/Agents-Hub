import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { PolicyDocument } from '@agents-hub/core';

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
