import type { HubClient, SessionSummary, TaskStatus } from '@agents-hub/client';
import type { CallerIdentity } from './caller.js';

/**
 * Escopo por fluxo das tools do MCP (vistoria 2026-09-25, 08-mcp-hooks
 * achado 14).
 *
 * Antes, toda tool que recebe `session_id`/`task_id`/`root_id` operava sobre
 * QUALQUER sessão do Hub: o MCP do `openclaude` cancelou uma sessão de outra
 * raiz (`kimi`), `hub_agent_events`/`hub_graph` liam fluxos alheios e
 * `hub_session_list` listava o hub inteiro (título = objetivo, possivelmente
 * sensível). Um agente delegado — ou um prompt injetado nele — podia cancelar
 * o pai e os irmãos ou espiar outros projetos.
 *
 * A regra agora:
 *
 * - **Ler** (status, eventos, diff, grafo, orçamento, contexto, lista): só
 *   sessões do MESMO fluxo (`rootId`) de quem chama.
 * - **Controlar** (cancelar, interromper, pausar, mandar mensagem, transferir):
 *   só sessões ABAIXO de quem chama — o que ele delegou, direta ou
 *   indiretamente. Um filho não cancela o pai nem os irmãos.
 * - Sessões que ESTE processo abriu fora da árvore (os passos de
 *   `hub_workflow_run`, que nascem como raízes próprias) contam como do
 *   chamador: ele as criou e precisa acompanhá-las.
 *
 * O operador humano não passa por aqui: CLI e painel falam com o daemon
 * direto, com o token de operador, e continuam vendo tudo.
 *
 * O que isto NÃO fecha: um processo que chame a API HTTP do daemon por fora
 * do MCP. As rotas de sessão não exigem token (a CLI de automação e a API de
 * tasks dependem disso), e uma identidade declarada num cabeçalho seria
 * forjável pelo mesmo processo. O vetor que a vistoria reproduziu — o agente
 * usando as PRÓPRIAS tools que o Hub lhe deu — é o que fica fechado.
 */
export class FlowScopeError extends Error {
  readonly code = 'OUT_OF_FLOW';
}

export class FlowScope {
  #chamador: { id: string; rootId: string } | null = null;
  /** Raízes criadas por este processo (passos de workflow). */
  readonly #raizesProprias = new Set<string>();

  constructor(
    private readonly client: HubClient,
    private readonly caller: CallerIdentity,
  ) {}

  /** Id e raiz do fluxo de quem chama (adota uma raiz se ainda não tiver). */
  async chamador(): Promise<{ id: string; rootId: string }> {
    const id = await this.caller.resolve();
    // A identidade pode mudar (raiz adotada expirou e foi readotada): o cache
    // vale só para o mesmo id.
    if (this.#chamador?.id === id) return this.#chamador;
    const { session } = await this.client.session(id);
    this.#chamador = { id, rootId: session.rootId };
    return this.#chamador;
  }

  /** Registra uma raiz que este processo abriu (ex.: passo de workflow). */
  registrarRaiz(rootId: string): void {
    this.#raizesProprias.add(rootId);
  }

  /** Raízes que quem chama enxerga: a do próprio fluxo e as que abriu. */
  async raizesVisiveis(): Promise<string[]> {
    const { rootId } = await this.chamador();
    return [rootId, ...[...this.#raizesProprias].filter((r) => r !== rootId)];
  }

  /** Recusa ler uma raiz que não é do fluxo de quem chama. */
  async exigirRaiz(rootId: string): Promise<void> {
    const visiveis = await this.raizesVisiveis();
    if (!visiveis.includes(rootId)) {
      throw new FlowScopeError(foraDoFluxo(`o fluxo ${rootId}`, visiveis[0] as string));
    }
  }

  /** A sessão, se ela for do fluxo de quem chama; erro claro se não for. */
  async exigirLeitura(sessionId: string): Promise<SessionSummary> {
    const { session } = await this.client.session(sessionId);
    const visiveis = await this.raizesVisiveis();
    if (!visiveis.includes(session.rootId)) {
      throw new FlowScopeError(foraDoFluxo(`a sessão ${sessionId}`, visiveis[0] as string));
    }
    return session;
  }

  /** Mesmo teste, para o status de uma task (a sessão já vem junto). */
  async exigirLeituraDaTask(status: TaskStatus): Promise<void> {
    const visiveis = await this.raizesVisiveis();
    if (!visiveis.includes(status.session.rootId)) {
      throw new FlowScopeError(foraDoFluxo(`a task ${status.task.id}`, visiveis[0] as string));
    }
  }

  /**
   * A sessão, se ela estiver ABAIXO de quem chama (ou numa raiz que este
   * processo abriu). A própria sessão de quem chama também fica de fora:
   * cancelar/pausar a si mesmo pelo Hub não é controle de delegação.
   */
  async exigirControle(sessionId: string): Promise<SessionSummary> {
    const alvo = await this.exigirLeitura(sessionId);
    if (this.#raizesProprias.has(alvo.rootId)) return alvo;

    const chamador = await this.chamador();
    if (alvo.id !== chamador.id) {
      const { sessions } = await this.client.sessions({ rootId: alvo.rootId });
      const paiDe = new Map(sessions.map((s) => [s.id, s.parentId]));
      // Sobe pelos pais do alvo até achar quem chama. O teto de passos só
      // protege contra um ciclo impossível de dados corrompidos.
      let atual: string | null = alvo.parentId;
      for (let passos = 0; atual !== null && passos < 256; passos += 1) {
        if (atual === chamador.id) return alvo;
        atual = paiDe.get(atual) ?? null;
      }
    }
    throw new FlowScopeError(
      `a sessão ${sessionId} não está abaixo de você (${chamador.id}): pelo MCP você só ` +
        'cancela, interrompe, pausa, manda mensagem ou transfere sessões que você delegou ' +
        '(direta ou indiretamente). Se precisa agir sobre ela, peça ao seu usuário.',
    );
  }
}

function foraDoFluxo(oQue: string, raizDoChamador: string): string {
  return (
    `${oQue} é de outro fluxo: pelo MCP você só alcança o seu (raiz ${raizDoChamador}). ` +
    'O operador humano vê todos os fluxos no painel ou na CLI.'
  );
}
