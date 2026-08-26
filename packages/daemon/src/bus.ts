import type { EventBus, EventEnvelope } from '@agents-hub/core';

interface Subscription {
  sessionId?: string;
  rootId?: string;
  handler: (event: EventEnvelope) => void;
}

/**
 * Barramento em memória.
 *
 * Fonte única para SSE, TUI e Web UI: quem quiser acompanhar um fluxo inteiro
 * assina por `rootId` e recebe também o que os agentes filhos produzirem — é
 * assim que o grafo ao vivo se mantém coerente sem cada cliente ficar
 * perguntando quem são os descendentes.
 */
export class InMemoryEventBus implements EventBus {
  readonly #subs = new Set<Subscription>();
  /** sessionId → rootId, para rotear sem consultar o banco a cada evento. */
  readonly #rootOf = new Map<string, string>();

  registerSession(sessionId: string, rootId: string): void {
    this.#rootOf.set(sessionId, rootId);
  }

  forgetSession(sessionId: string): void {
    this.#rootOf.delete(sessionId);
  }

  publish(event: EventEnvelope): void {
    const rootId = this.#rootOf.get(event.sessionId);
    for (const sub of this.#subs) {
      if (sub.sessionId && sub.sessionId !== event.sessionId) continue;
      if (sub.rootId && sub.rootId !== rootId) continue;
      try {
        sub.handler(event);
      } catch {
        // Um assinante quebrado (cliente SSE que caiu) não pode derrubar a
        // entrega para os demais nem travar o agente que está produzindo.
      }
    }
  }

  subscribe(
    filter: { sessionId?: string; rootId?: string },
    handler: (event: EventEnvelope) => void,
  ): () => void {
    const sub: Subscription = { ...filter, handler };
    this.#subs.add(sub);
    return () => this.#subs.delete(sub);
  }

  get subscriberCount(): number {
    return this.#subs.size;
  }
}
