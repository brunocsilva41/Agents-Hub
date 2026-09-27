import { HubError, type Session } from '@agents-hub/core';

/**
 * `send` numa sessão que já terminou (vistoria 11, achado R11-05).
 *
 * Decisão: NÃO reabrir. Uma sessão `completed` já entregou: a task tem
 * resultado aceito pelo portão de validação, o pai já recebeu
 * `delegation.completed`, o custo foi fechado no ledger e o trabalho foi
 * commitado em `hub/<id>`. Retomar a sessão nativa ali reescreveria um
 * desfecho que outros já consumiram — e ressuscitar estado terminal é
 * exatamente o que `terminal-state.test.ts` proíbe (a cadeia pause → resume →
 * falha → fallback sobre uma conversa que tinha terminado bem).
 *
 * Continuar a partir dela é outra coisa, e tem caminho: sessão NOVA, com o
 * resumo da anterior no brief (`upstream`), o ponteiro para a timeline dela
 * (`contextRefs`) e o worktree partindo do branch dela (`baseSessionIds`).
 * É o que `hub start --from <id>` monta; pelo MCP, `hub_agent_call` com
 * `context_refs`. A recusa ensina esse caminho em vez de só dizer "não".
 */
export function recusaDeSessaoTerminada(session: Session): HubError {
  return new HubError(
    'ILLEGAL_STATE',
    `A sessão ${session.id} já terminou (${session.state}) e não é reaberta: o resultado dela já foi entregue. ` +
      `Para continuar a partir dela, abra uma sessão nova com o contexto e o código dela: ` +
      `hub start --from ${session.id} --agent ${session.agentId} "sua mensagem" ` +
      `(pelo MCP: hub_agent_call com context_refs ["session:${session.id}"]).`,
    {
      sessionId: session.id,
      state: session.state,
      continuarCom: { from: session.id, agentId: session.agentId },
    },
  );
}
