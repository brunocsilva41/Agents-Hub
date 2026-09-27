import type { EventEnvelope } from '@agents-hub/core';

/**
 * Notificação do navegador quando surge aprovação (vistoria 14, R14-14).
 *
 * A fila de aprovações fica no topo do painel, mas só para quem está olhando
 * a aba. Com a `Notification` API — opt-in: a permissão só é pedida quando a
 * pessoa clica em "Avisar no sistema" — uma aprovação que chega com a aba em
 * segundo plano vira notificação do SO, e clicar nela traz a aba de volta.
 *
 * Com a aba visível não notifica: a fila já está na tela, e o aviso seria
 * ruído. Uma notificação por aprovação (o SSE pode repetir o evento após
 * reconexão). Sem DOM direto aqui: tudo entra por `deps`, para testar em node.
 */
export type PermissaoDeNotificacao = 'default' | 'granted' | 'denied' | 'unsupported';

export interface DepsDeNotificacao {
  permissao: () => PermissaoDeNotificacao;
  /** A aba está em segundo plano? */
  oculta: () => boolean;
  notificar: (titulo: string, opcoes: { body: string; tag: string }, aoClicar: () => void) => void;
  focar: () => void;
}

export function criarNotificadorDeAprovacao(deps: DepsDeNotificacao): (event: EventEnvelope) => boolean {
  const vistos = new Set<string>();
  return (event) => {
    if (event.type !== 'approval.requested') return false;
    const id = typeof event.payload['approvalId'] === 'string' ? event.payload['approvalId'] : null;
    if (!id || vistos.has(id)) return false;
    vistos.add(id);
    if (deps.permissao() !== 'granted' || !deps.oculta()) return false;
    const acao = typeof event.payload['action'] === 'string' ? event.payload['action'] : 'ação retida';
    deps.notificar(
      `Agents-Hub: ${event.agentId} espera sua decisão`,
      { body: acao.length > 180 ? `${acao.slice(0, 179)}…` : acao, tag: id },
      deps.focar,
    );
    return true;
  };
}

/** Dependências reais do navegador (fora de teste). */
export function depsDoNavegador(): DepsDeNotificacao {
  const N = (globalThis as { Notification?: typeof Notification }).Notification;
  return {
    permissao: () => (N ? N.permission : 'unsupported'),
    oculta: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
    notificar: (titulo, opcoes, aoClicar) => {
      if (!N) return;
      try {
        const n = new N(titulo, opcoes);
        n.onclick = () => {
          aoClicar();
          n.close();
        };
      } catch {
        // Alguns navegadores só aceitam notificação via service worker; o
        // painel continua mostrando a fila normalmente.
      }
    },
    focar: () => {
      try {
        window.focus();
      } catch {
        /* sem janela: nada a focar */
      }
    },
  };
}

/** Pede a permissão (só a partir de um clique). Devolve o estado final. */
export async function pedirPermissaoDeNotificacao(): Promise<PermissaoDeNotificacao> {
  const N = (globalThis as { Notification?: typeof Notification }).Notification;
  if (!N) return 'unsupported';
  try {
    return await N.requestPermission();
  } catch {
    return N.permission;
  }
}
