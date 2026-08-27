import type { HubClient, SessionSummary } from '@agents-hub/client';

/**
 * Descobre QUEM está chamando — o problema mais sutil do MCP server.
 *
 * Dois casos, e os dois precisam funcionar para "qualquer um pode ser o
 * principal" ser verdade:
 *
 * 1. **Agente rodando dentro do Hub.** O adapter injeta `AGENTS_HUB_SESSION_ID`
 *    no processo do agente; o MCP server, sendo filho dele, herda a variável.
 *    A identidade vem de graça e o grafo se liga sozinho.
 *
 * 2. **Agente rodando fora do Hub** (você abriu o Cursor na mão). Não há
 *    sessão. Adotamos uma sessão-raiz na primeira chamada que precise de
 *    identidade — sem isso o filho nasceria órfão, sem pai para herdar
 *    política, sem raiz para debitar orçamento e sem nó no grafo.
 *
 * A sessão adotada vive na memória DESTE processo, e não em disco, porque um
 * processo de MCP server corresponde a uma sessão do agente: o ciclo de vida
 * já é exatamente o que queremos.
 */
export class CallerIdentity {
  #sessionId: string | null;
  #adopted: SessionSummary | null = null;
  #adopting: Promise<SessionSummary> | null = null;

  constructor(
    private readonly client: HubClient,
    private readonly agentId: string,
    private readonly projectPath: string,
    sessionIdFromEnv?: string,
  ) {
    this.#sessionId = sessionIdFromEnv && sessionIdFromEnv.length > 0 ? sessionIdFromEnv : null;
  }

  get known(): boolean {
    return this.#sessionId !== null;
  }

  get adoptedSession(): SessionSummary | null {
    return this.#adopted;
  }

  /** Id da sessão do chamador, adotando uma raiz se ele vier de fora. */
  async resolve(): Promise<string> {
    if (this.#sessionId) return this.#sessionId;

    // Chamadas concorrentes na largada não podem adotar duas raízes: o fluxo
    // ficaria partido em duas árvores com dois orçamentos.
    this.#adopting ??= this.client
      .adopt({
        agentId: this.agentId,
        projectPath: this.projectPath,
        title: `${this.agentId} (principal externo)`,
      })
      .then((result) => result.session);

    const session = await this.#adopting;
    this.#adopted = session;
    this.#sessionId = session.id;
    return session.id;
  }

  /** Encerra a raiz adotada sem matar o que ela delegou. */
  async release(): Promise<void> {
    if (!this.#adopted) return;
    try {
      await this.client.detach(this.#adopted.id);
    } catch {
      // O daemon pode já ter caído; não há o que fazer e não vale poluir stderr
      // do agente que nos hospeda.
    }
  }
}
