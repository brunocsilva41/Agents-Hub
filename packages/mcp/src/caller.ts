import { HubApiError, type HubClient, type SessionSummary } from '@agents-hub/client';

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
    //
    // Mas a promessa REJEITADA não pode ficar guardada: com o daemon fora do
    // ar na primeira chamada, toda tool que precisa de identidade seguia
    // dizendo "o daemon não está rodando" mesmo depois de ele voltar, até
    // reiniciar o MCP server (vistoria 2026-09-25, 08-mcp-hooks achado 7).
    const adocao = (this.#adopting ??= this.client
      .adopt({
        agentId: this.agentId,
        projectPath: this.projectPath,
        title: `${this.agentId} (principal externo)`,
      })
      .then((result) => result.session));

    let session: SessionSummary;
    try {
      session = await adocao;
    } catch (err) {
      if (this.#adopting === adocao) this.#adopting = null;
      throw err;
    }
    // Uma raiz esquecida (expirou) entre a adoção e aqui não pode ressuscitar.
    if (this.#adopting !== adocao) return this.resolve();
    this.#adopted = session;
    this.#sessionId = session.id;
    return session.id;
  }

  /**
   * Sinal de vida da raiz adotada. Sem ele, o daemon encerra a raiz depois do
   * prazo — é o que evita raiz `running` para sempre quando o hospedeiro mata
   * este processo sem fechar stdin (achado 13). Se o daemon diz que a raiz
   * não existe mais ou já terminou (expirou, daemon reiniciou), esquece a
   * identidade adotada: a próxima tool adota uma raiz nova em vez de delegar
   * para uma morta. Falha de rede é só ignorada — o daemon pode estar
   * reiniciando.
   */
  async heartbeat(): Promise<void> {
    const adotada = this.#adopted;
    if (!adotada) return;
    try {
      await this.client.heartbeat(adotada.id);
    } catch (err) {
      if (
        err instanceof HubApiError &&
        (err.code === 'SESSION_NOT_FOUND' || err.code === 'ILLEGAL_STATE') &&
        this.#adopted === adotada
      ) {
        this.#adopted = null;
        this.#sessionId = null;
        this.#adopting = null;
      }
    }
  }

  /** Liga o sinal de vida periódico. Devolve a função que o desliga. */
  startHeartbeat(intervalMs: number): () => void {
    const timer = setInterval(() => void this.heartbeat(), intervalMs);
    // O sinal de vida não pode ser o motivo de o processo não sair.
    timer.unref?.();
    return () => clearInterval(timer);
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
