import { textoDe, type EventEnvelope } from '@agents-hub/core';

/**
 * Alerta de aprovação no terminal (vistoria 14, R14-14): quem deixou um
 * `hub start`/`watch` rodando numa aba e foi fazer outra coisa não via que a
 * sessão parou esperando decisão.
 *
 * O que dá para fazer sem dependência e sem permissão nenhuma: o caractere BEL
 * (o terminal bipa ou pisca a aba, conforme a configuração dele — o Windows
 * Terminal marca a aba) e o título da janela via OSC 0, que continua visível
 * na barra de tarefas. Notificação nativa do SO ficou de fora: no Windows ela
 * exige módulo de terceiros (BurntToast) ou COM, sem garantia de funcionar.
 *
 * Só em TTY — em pipe/arquivo esses bytes virariam lixo no log — e desligável
 * com `--no-bell`.
 */
export function sinalDeAprovacao(
  event: Pick<EventEnvelope, 'type' | 'payload'>,
  o: { tty: boolean; desligado: boolean },
): string | null {
  if (event.type !== 'approval.requested' || !o.tty || o.desligado) return null;
  const id = typeof event.payload['approvalId'] === 'string' ? ` ${event.payload['approvalId']}` : '';
  // Título sem caracteres de controle vindos do payload (só o id, que é [a-z0-9_]).
  const titulo = `hub: aprovação pendente${id.replace(/[^\w ]/g, '')}`;
  return `\u0007\u001b]0;${titulo}\u0007`;
}

/** Alertador com memória: a mesma aprovação (replay do stream) não bipa duas vezes. */
export function criarAlertaDeAprovacao(o: {
  desligado?: boolean;
  tty?: boolean;
  escrever?: (s: string) => void;
}): (event: Pick<EventEnvelope, 'type' | 'payload'>) => void {
  const vistos = new Set<string>();
  const tty = o.tty ?? process.stdout.isTTY === true;
  const escrever = o.escrever ?? ((s: string) => void process.stdout.write(s));
  return (event) => {
    const sinal = sinalDeAprovacao(event, { tty, desligado: o.desligado === true });
    if (!sinal) return;
    const chave = textoDe(event.payload['approvalId']);
    if (chave && vistos.has(chave)) return;
    if (chave) vistos.add(chave);
    escrever(sinal);
  };
}
