/**
 * Mesma chamada de ferramenta, mesma decisão — uma aprovação só.
 *
 * O Hub injeta o hook do gate em toda sessão do Claude por `--settings`
 * (`session-settings.ts`). Se o usuário TAMBÉM tem o hook no
 * `~/.claude/settings.json`, o Claude soma as duas fontes: com o comando
 * idêntico ele mesmo deduplica, mas com comandos diferentes (instalação antiga
 * com `main.js`, outro Node) os dois hooks rodam, em paralelo, para a MESMA
 * chamada. Sem isto, cada um abriria a sua aprovação e o humano teria de
 * decidir duas vezes a mesma coisa — ou, pior, aprovar uma e ver a ferramenta
 * negada pela outra, que expirou.
 *
 * A chave é `(sessão do Hub, tool_use_id)`: o id que o agente dá à chamada é
 * o mesmo nos dois hooks. A segunda chegada espera a MESMA promessa (em voo)
 * ou recebe a decisão já tomada (guardada por `ttlMs`). Sem `tool_use_id`
 * não há como reconhecer a repetição, e cada chamada é decidida por si.
 */
export class DecisoesDoGate<T> {
  readonly #entradas = new Map<string, { promessa: Promise<T>; expira: number }>();
  readonly #ttlMs: number;
  readonly #teto: number;

  constructor(opcoes: { ttlMs?: number; teto?: number } = {}) {
    this.#ttlMs = opcoes.ttlMs ?? 10 * 60_000;
    this.#teto = opcoes.teto ?? 2_000;
  }

  /**
   * Decide uma vez por chave. `repetida: true` quando a decisão veio de uma
   * chamada anterior (ou ainda em voo) com a mesma chave.
   */
  async decidir(
    chave: string | null,
    produzir: () => Promise<T>,
  ): Promise<{ valor: T; repetida: boolean }> {
    if (chave === null) return { valor: await produzir(), repetida: false };

    const agora = Date.now();
    this.#podar(agora);

    const existente = this.#entradas.get(chave);
    if (existente && existente.expira > agora) {
      return { valor: await existente.promessa, repetida: true };
    }

    const promessa = produzir();
    // Em voo não expira: a espera por um humano pode passar do TTL.
    this.#entradas.set(chave, { promessa, expira: Number.POSITIVE_INFINITY });
    try {
      const valor = await promessa;
      this.#entradas.set(chave, { promessa, expira: Date.now() + this.#ttlMs });
      return { valor, repetida: false };
    } catch (err) {
      // Falha não é decisão: a próxima chegada tenta de novo.
      this.#entradas.delete(chave);
      throw err;
    }
  }

  get tamanho(): number {
    return this.#entradas.size;
  }

  #podar(agora: number): void {
    for (const [chave, e] of this.#entradas) {
      if (e.expira <= agora) this.#entradas.delete(chave);
    }
    // Teto de memória: descarta as mais antigas já decididas (a ordem de
    // inserção do Map é a ordem de chegada). As em voo nunca saem.
    if (this.#entradas.size <= this.#teto) return;
    for (const [chave, e] of this.#entradas) {
      if (this.#entradas.size <= this.#teto) break;
      if (Number.isFinite(e.expira)) this.#entradas.delete(chave);
    }
  }
}
