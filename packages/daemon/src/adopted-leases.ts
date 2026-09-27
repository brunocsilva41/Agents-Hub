import { HubError, isTerminalSessionState, pathKey, type Session } from '@agents-hub/core';

/** Sem sinal de vida por mais que isto, a raiz adotada é encerrada. */
export const ADOPTED_LEASE_MS = 3 * 60_000;

/** Intervalo em que o MCP server manda o sinal de vida (bem abaixo do prazo). */
export const ADOPTED_HEARTBEAT_MS = 30_000;

/** O pedaço do `SessionManager` de que o controle de prazo precisa. */
export interface LeaseSessions {
  getSession(sessionId: string): Session;
  detach(sessionId: string, reason?: string): Promise<void>;
}

/** Sessão-raiz adotada de um agente externo (ver `SessionManager.adoptExternal`). */
export function isAdoptedRoot(session: Session): boolean {
  return (
    session.parentId === null &&
    session.pid === null &&
    session.path[0] === pathKey(session.agentId, `external:${session.agentId}`)
  );
}

/**
 * Prazo (lease) das raízes adotadas por agentes externos (vistoria
 * 2026-09-25, 08-mcp-hooks achado 13).
 *
 * A raiz adotada só era encerrada quando o MCP server fechava direito
 * (`detach` no fim do stdin). Se o hospedeiro matava o processo (no Windows,
 * `TerminateProcess` não roda handler nenhum), a raiz ficava `running` para
 * sempre: aparecia viva no painel e no `hub_session_list` e atraía o
 * casamento por `cwd` do gate de hooks.
 *
 * Agora o MCP server manda um sinal de vida periódico
 * (`POST /sessions/:id/heartbeat`); a raiz que passa `leaseMs` sem sinal é
 * encerrada como `completed` pelo mesmo caminho do `detach` — o trabalho que
 * ela delegou continua valendo.
 *
 * O registro vive em memória: depois de um restart do daemon a reconciliação
 * já encerra toda sessão `running` sem processo, inclusive as adotadas.
 */
export class AdoptedRootLeases {
  readonly #vistoPorUltimo = new Map<string, number>();
  #timer: NodeJS.Timeout | null = null;
  readonly #leaseMs: number;
  readonly #checkMs: number;
  readonly #agora: () => number;

  constructor(
    private readonly sessions: LeaseSessions,
    opts: { leaseMs?: number; checkMs?: number; now?: () => number } = {},
  ) {
    this.#leaseMs = opts.leaseMs ?? ADOPTED_LEASE_MS;
    this.#checkMs = opts.checkMs ?? Math.max(1000, Math.floor(this.#leaseMs / 3));
    this.#agora = opts.now ?? Date.now;
  }

  get leaseMs(): number {
    return this.#leaseMs;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.expire(), this.#checkMs);
    // Um controle de prazo não pode ser o motivo de o processo não sair.
    this.#timer.unref?.();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Começa (ou renova) o prazo de uma raiz recém-adotada. */
  track(sessionId: string): void {
    this.#vistoPorUltimo.set(sessionId, this.#agora());
  }

  forget(sessionId: string): void {
    this.#vistoPorUltimo.delete(sessionId);
  }

  /**
   * Sinal de vida do MCP server. Recusa (`ILLEGAL_STATE`) quando a sessão não
   * é uma raiz adotada ou já terminou — é o que avisa o MCP de que a raiz dele
   * expirou e ele precisa adotar outra, em vez de delegar para uma raiz morta.
   */
  heartbeat(sessionId: string): { leaseMs: number } {
    const session = this.sessions.getSession(sessionId);
    if (!isAdoptedRoot(session)) {
      throw new HubError(
        'ILLEGAL_STATE',
        `A sessão ${sessionId} não é uma raiz adotada de agente externo`,
        { sessionId },
      );
    }
    if (isTerminalSessionState(session.state)) {
      this.forget(sessionId);
      throw new HubError('ILLEGAL_STATE', `A raiz adotada ${sessionId} já terminou (${session.state})`, {
        sessionId,
        state: session.state,
      });
    }
    this.track(sessionId);
    return { leaseMs: this.#leaseMs };
  }

  /** Encerra as raízes cujo prazo venceu. Devolve os ids encerrados. */
  async expire(now: number = this.#agora()): Promise<string[]> {
    const vencidas: string[] = [];
    for (const [sessionId, visto] of this.#vistoPorUltimo) {
      if (now - visto > this.#leaseMs) vencidas.push(sessionId);
    }

    const encerradas: string[] = [];
    for (const sessionId of vencidas) {
      this.#vistoPorUltimo.delete(sessionId);
      try {
        await this.sessions.detach(
          sessionId,
          `agente externo sem sinal de vida há mais de ${Math.round(this.#leaseMs / 1000)}s ` +
            '(MCP server encerrado sem aviso)',
        );
        encerradas.push(sessionId);
      } catch (err) {
        // Sessão apagada ou erro de banco: não há o que renovar — só registra.
        console.error(`[leases] falha ao encerrar raiz adotada ${sessionId}: ${(err as Error).message}`);
      }
    }
    return encerradas;
  }
}
