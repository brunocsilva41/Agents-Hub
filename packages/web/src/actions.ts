import { useCallback, useEffect, useState } from 'react';
import { HubApiError } from '@agents-hub/client';

export interface Toast {
  id: number;
  kind: 'error' | 'ok';
  title: string;
  detail: string | null;
}

/**
 * Toda ação que falha vira um aviso visível.
 *
 * O caso que motivou isto foi real: o proxy de desenvolvimento respondia 403 a
 * todo POST e a interface não mudava em nada — os botões estavam lá e não
 * faziam nada. Erro de ação não pode depender de o painel certo estar aberto
 * para aparecer, então além do estado local de cada botão existe esta fila
 * global, que sobrevive ao painel da direita sumir numa janela estreita.
 */
let nextId = 1;
let toasts: Toast[] = [];
const listeners = new Set<(list: Toast[]) => void>();

function emit(): void {
  for (const listener of listeners) listener(toasts);
}

export function pushToast(toast: Omit<Toast, 'id'>): number {
  const id = nextId++;
  toasts = [...toasts, { ...toast, id }];
  emit();
  // Sucesso é confirmação passageira; erro fica até alguém fechar, porque é o
  // único registro de que a ação não aconteceu.
  if (toast.kind === 'ok') window.setTimeout(() => dismissToast(id), 4000);
  return id;
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function useToasts(): Toast[] {
  const [list, setList] = useState<Toast[]>(toasts);
  useEffect(() => {
    listeners.add(setList);
    setList(toasts);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  return list;
}

/**
 * Mensagem que serve para quem está olhando a tela sob pressão.
 *
 * Os códigos do daemon já foram escritos para dizer o que fazer (ADR do MCP),
 * então o `message` costuma bastar. O que não basta é o que chega quando a
 * resposta nem era JSON: o cliente estoura um `SyntaxError` de parser, que não
 * significa nada para quem opera.
 */
export function describeError(err: unknown): { title: string; detail: string | null } {
  if (err instanceof HubApiError) {
    if (err.status === 403) {
      return {
        title: 'O Hub recusou a ação (403)',
        detail: `${err.message} — a origem da página não é a que o daemon aceita.`,
      };
    }
    return { title: err.message, detail: err.code === String(err.status) ? null : err.code };
  }
  if (err instanceof SyntaxError) {
    return {
      title: 'Resposta inválida do Hub',
      detail: 'A rota respondeu algo que não é JSON — o daemon pode estar fora do ar.',
    };
  }
  if (err instanceof TypeError) {
    return { title: 'Não foi possível falar com o Hub', detail: 'A conexão falhou.' };
  }
  return { title: (err as Error).message || 'Falha desconhecida', detail: null };
}

export interface ActionRunner {
  /** Rótulo da ação em curso, ou `null`. Serve para desabilitar e mostrar "…". */
  busy: string | null;
  error: string | null;
  clearError: () => void;
  run: (label: string, fn: () => Promise<unknown>, okMessage?: string) => Promise<boolean>;
}

/** Estado de uma ação: ocupado, erro local e aviso global, num lugar só. */
export function useAction(): ActionRunner {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (label: string, fn: () => Promise<unknown>, okMessage?: string): Promise<boolean> => {
      setBusy(label);
      setError(null);
      try {
        await fn();
        if (okMessage) pushToast({ kind: 'ok', title: okMessage, detail: null });
        return true;
      } catch (err) {
        const { title, detail } = describeError(err);
        setError(detail ? `${title} (${detail})` : title);
        pushToast({ kind: 'error', title, detail });
        return false;
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  return { busy, error, clearError: () => setError(null), run };
}
