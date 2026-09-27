/**
 * Quais controles da sessão fazem sentido em cada estado, e o que dizer depois
 * de cada ação — derivado SÓ do que o daemon informou.
 *
 * Antes, `active = running || waiting_approval` valia para os quatro botões: ao
 * pausar, Encerrar e Transferir sumiam junto, e uma sessão pausada (que ocupa
 * vaga de concorrência e segura orçamento) não podia mais ser encerrada pelo
 * painel. O daemon aceita cancelar e transferir em qualquer estado não
 * terminal; o painel agora acompanha.
 */

export const TERMINAL_STATES: ReadonlySet<string> = new Set(['completed', 'failed', 'killed']);

export function isTerminalState(state: string): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * "Ao vivo": ocupa vaga e ainda pode mudar (inclui pausada e ociosa). Uma só
 * definição para a pílula do topo, a lista de fluxos e a telemetria — antes
 * cada tela contava de um jeito.
 */
export function isLiveState(state: string): boolean {
  return state === 'running' || state === 'waiting_approval' || state === 'paused' || state === 'idle';
}

export interface ControlState {
  enabled: boolean;
  /** Por que está desabilitado (vira `title` do botão). `null` quando habilitado. */
  reason: string | null;
}

export interface SessionControls {
  interrupt: ControlState;
  pause: ControlState;
  handoff: ControlState;
  cancel: ControlState;
  /** Dica para sessão pausada: retomar é mandar mensagem. */
  resumeHint: string | null;
}

const on: ControlState = { enabled: true, reason: null };
const off = (reason: string): ControlState => ({ enabled: false, reason });

export function deriveControls(input: {
  state: string;
  /** Ação em andamento neste painel: tudo espera ela voltar. */
  busy: boolean;
  /** Há outro agente instalado para receber a sessão? */
  hasHandoffTarget: boolean;
}): SessionControls {
  const { state, busy, hasHandoffTarget } = input;

  if (isTerminalState(state)) {
    const reason = 'sessão já terminou';
    return {
      interrupt: off(reason),
      pause: off(reason),
      handoff: off(reason),
      cancel: off(reason),
      resumeHint: null,
    };
  }

  const turnoVivo = state === 'running';
  const ocupado = busy ? off('aguardando a ação anterior') : null;
  // O daemon recusa parar o turno com aprovação pendente (a pendência ficaria
  // aberta numa sessão ociosa): o botão diz o porquê em vez de dar erro.
  const semTurno =
    state === 'waiting_approval'
      ? off('resolva a aprovação pendente primeiro')
      : off(state === 'paused' ? 'já está pausada' : 'nenhum turno em andamento');

  return {
    interrupt: ocupado ?? (turnoVivo ? on : state === 'paused' ? off('nenhum turno em andamento') : semTurno),
    pause: ocupado ?? (turnoVivo ? on : semTurno),
    handoff: ocupado ?? (hasHandoffTarget ? on : off('nenhum outro agente instalado')),
    cancel: ocupado ?? on,
    resumeHint: state === 'paused' ? 'Pausada — envie uma mensagem para retomar.' : null,
  };
}

export interface ActionFeedback {
  kind: 'ok' | 'warn';
  title: string;
  detail: string | null;
}

/**
 * O daemon responde `{ ok: true, interrupted: false }` quando não havia turno:
 * não é erro, mas também não é "turno interrompido". Mostrar sucesso ali era
 * ensinar a confiar num botão que não fez nada.
 */
export function interruptFeedback(
  result: { interrupted?: boolean; state?: string } | null | undefined,
): ActionFeedback {
  if (result && result.interrupted === false) {
    return {
      kind: 'warn',
      title: 'Nada foi interrompido',
      detail: 'A sessão não tinha turno em andamento.',
    };
  }
  // O turno parou e a sessão segue viva (ociosa): retomar é mandar mensagem.
  return {
    kind: 'ok',
    title: 'Turno interrompido.',
    detail: 'A sessão continua viva e ociosa — envie uma mensagem para retomar.',
  };
}

/**
 * Delegação que a política reteve NÃO começou: fica esperando decisão humana.
 * "Delegação iniciada." nesse caso é mentira.
 */
export function delegationFeedback(result: {
  approval?: { id: string; action?: string } | null;
  agentId?: string;
}): ActionFeedback {
  if (result.approval) {
    return {
      kind: 'warn',
      title: 'Delegação retida pela política',
      detail: `Aguardando sua decisão na fila de aprovações${result.approval.action ? `: ${result.approval.action}` : ''}.`,
    };
  }
  return {
    kind: 'ok',
    title: result.agentId ? `Delegação iniciada para ${result.agentId}.` : 'Delegação iniciada.',
    detail: null,
  };
}

/** Como o daemon entregou a mensagem — `resume`/`replay` abrem um turno novo. */
export function sendFeedback(mode: string | undefined): ActionFeedback | null {
  if (mode === 'replay') {
    return {
      kind: 'ok',
      title: 'Mensagem enviada em um turno novo.',
      detail: 'O agente não retoma a sessão nativa: recebeu o histórico resumido junto.',
    };
  }
  return null;
}
