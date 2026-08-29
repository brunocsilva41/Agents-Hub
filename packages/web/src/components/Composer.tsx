import { useEffect, useRef, useState } from 'react';
import type { SessionSummary } from '@agents-hub/client';
import { hub, STATE_LABEL } from '../hub';

interface Props {
  session: SessionSummary;
  /** Sessão terminada não aceita mais mensagem — o daemon recusa, e com razão. */
  encerrada: boolean;
}

/**
 * Campo para falar com a sessão.
 *
 * É um componente separado porque o texto digitado é estado que só interessa a
 * ele. Enquanto morava no `App`, cada tecla re-renderizava a timeline inteira —
 * numa sessão com milhares de eventos, isso são centenas de milissegundos por
 * caractere.
 */
export function Composer({ session, encerrada }: Props) {
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Trocar de sessão não pode levar junto o rascunho: mandaria para o agente
  // errado uma frase escrita para outro.
  useEffect(() => {
    setMessage('');
    setError(null);
  }, [session.id]);

  // "/" foca o campo, como em toda ferramenta operacional — desde que você não
  // esteja digitando em outro lugar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      if (active instanceof HTMLSelectElement) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const send = async (): Promise<void> => {
    if (encerrada || message.trim().length === 0 || sending) return;
    setSending(true);
    setError(null);
    try {
      await hub.send(session.id, message.trim());
      setMessage('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="composer">
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <div className="composer-row">
        <textarea
          ref={inputRef}
          rows={1}
          className="composer-input"
          aria-label={`Mensagem para ${session.agentId}`}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={
            encerrada
              ? `sessão ${STATE_LABEL[session.state] ?? session.state} — abra uma nova para continuar`
              : `falar com ${session.agentId}…  (/ foca, Enter envia)`
          }
          // Bloquear no campo diz isso antes, em vez de deixar o erro do
          // servidor explicar depois que a pessoa já digitou.
          disabled={sending || encerrada}
        />
        <button
          className="primary"
          onClick={() => void send()}
          disabled={sending || encerrada || message.trim().length === 0}
        >
          {sending ? 'enviando…' : 'Enviar'}
        </button>
      </div>
    </div>
  );
}
