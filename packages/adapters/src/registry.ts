import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { HubError } from '@agents-hub/core';
import { ProcessAgentAdapter } from './process-adapter.js';
import { AgentManifestSchema, type AgentAdapter, type AgentManifest, type ProbeResult } from './types.js';

export function loadManifestFile(file: string): AgentManifest {
  const raw = parseYaml(readFileSync(file, 'utf8')) as unknown;
  const result = AgentManifestSchema.safeParse(raw);
  if (!result.success) {
    throw new HubError('ILLEGAL_STATE', `Manifesto inválido em ${file}`, {
      file,
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

export function loadManifestDir(dir: string): AgentManifest[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort()
    .map((f) => loadManifestFile(path.join(dir, f)));
}

/**
 * Registro de agentes.
 *
 * Concentra três coisas que o resto do sistema não deveria precisar saber:
 * quais agentes existem, se estão realmente instalados, e como resolver uma
 * capability (`cap:test-writing`) em um agente concreto.
 */
export class AgentRegistry {
  readonly #adapters = new Map<string, AgentAdapter>();
  readonly #probes = new Map<string, ProbeResult>();

  static fromDirectory(dir: string): AgentRegistry {
    const registry = new AgentRegistry();
    for (const manifest of loadManifestDir(dir)) registry.register(manifest);
    return registry;
  }

  register(manifest: AgentManifest): AgentAdapter {
    if (this.#adapters.has(manifest.id)) {
      throw new HubError('ILLEGAL_STATE', `Agente "${manifest.id}" registrado duas vezes`, {
        agentId: manifest.id,
      });
    }
    const adapter = new ProcessAgentAdapter(manifest);
    this.#adapters.set(manifest.id, adapter);
    return adapter;
  }

  registerAdapter(adapter: AgentAdapter): void {
    this.#adapters.set(adapter.manifest.id, adapter);
  }

  has(agentId: string): boolean {
    return this.#adapters.has(agentId);
  }

  get(agentId: string): AgentAdapter {
    const adapter = this.#adapters.get(agentId);
    if (!adapter) {
      throw new HubError('AGENT_NOT_FOUND', `Agente "${agentId}" não registrado`, {
        agentId,
        available: this.ids(),
      });
    }
    return adapter;
  }

  ids(): string[] {
    return [...this.#adapters.keys()];
  }

  manifests(): AgentManifest[] {
    return [...this.#adapters.values()].map((a) => a.manifest);
  }

  /** Roda o probe de todos em paralelo — é o `hub doctor`. */
  async probeAll(force = false): Promise<ProbeResult[]> {
    const results = await Promise.all(
      [...this.#adapters.values()].map((adapter) => this.probe(adapter.manifest.id, force)),
    );
    return results;
  }

  async probe(agentId: string, force = false): Promise<ProbeResult> {
    if (!force) {
      const cached = this.#probes.get(agentId);
      if (cached) return cached;
    }
    const result = await this.get(agentId).probe();
    this.#probes.set(agentId, result);
    return result;
  }

  cachedProbe(agentId: string): ProbeResult | null {
    return this.#probes.get(agentId) ?? null;
  }

  /**
   * Resolve o alvo de um Brief. Aceita id direto (`"codex"`) ou capability
   * (`"cap:test-writing"`), que é resolvida na ordem da cadeia de fallback
   * configurada — e, na falta dela, na ordem de declaração dos manifestos.
   *
   * Só devolve agente que o probe confirmou instalado: delegar para um CLI
   * ausente falharia lá na frente, com mensagem muito pior.
   */
  resolveTarget(target: string, fallbackChains: Record<string, string[]> = {}): string {
    if (!target.startsWith('cap:')) {
      if (!this.has(target)) {
        throw new HubError('AGENT_NOT_FOUND', `Agente "${target}" não registrado`, {
          target,
          available: this.ids(),
        });
      }
      return target;
    }

    const capability = target.slice('cap:'.length);
    const chain = fallbackChains[capability] ?? [];
    const candidates = [
      ...chain.filter((id) => this.has(id)),
      ...this.manifests()
        .filter((m) => m.capabilities.includes(capability))
        .map((m) => m.id),
    ];

    const seen = new Set<string>();
    for (const id of candidates) {
      if (seen.has(id)) continue;
      seen.add(id);
      const probe = this.#probes.get(id);
      // Sem probe ainda, damos o benefício da dúvida: melhor tentar do que
      // recusar uma delegação por falta de informação cacheada.
      if (!probe || probe.installed) return id;
    }

    throw new HubError(
      'CAPABILITY_UNRESOLVED',
      `Nenhum agente instalado atende à capability "${capability}"`,
      { capability, candidates: [...seen] },
    );
  }

  /** Cadeia de fallback efetiva para uma task, já filtrando o agente que falhou. */
  fallbackFor(
    agentId: string,
    capabilities: Record<string, string[]>,
  ): string[] {
    const manifest = this.get(agentId).manifest;
    const chains = manifest.capabilities
      .map((cap) => capabilities[cap] ?? [])
      .flat()
      .filter((id) => id !== agentId && this.has(id));
    return [...new Set(chains)];
  }
}
