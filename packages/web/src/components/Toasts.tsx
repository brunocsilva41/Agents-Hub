import { dismissToast, useToasts } from '../actions';

/**
 * Fila de avisos, canto inferior direito.
 *
 * `role="status"` e não `alert`: alert interrompe o leitor de tela no meio da
 * frase, e uma ação que falhou não é mais urgente do que terminar de ler o que
 * o agente estava dizendo. Cada aviso também é repetido no lugar onde a ação
 * foi disparada — isto aqui é a rede de segurança para quando esse lugar não
 * está mais visível.
 */
export function Toasts() {
  const toasts = useToasts();
  if (toasts.length === 0) return null;

  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`}>
          <div className="toast-body">
            <div className="toast-title">{toast.title}</div>
            {toast.detail && <div className="toast-detail">{toast.detail}</div>}
          </div>
          <button className="toast-close" aria-label="Dispensar aviso" onClick={() => dismissToast(toast.id)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
