import React, { useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useDialog, useFecharPeloFundo } from '../useDialog';

interface Props {
  titulo: string;
  /** Uma linha sob o título: o que vai acontecer. */
  resumo?: string;
  children?: React.ReactNode;
  confirmarRotulo: string;
  /** Ação que afrouxa segurança ou grava fora do Hub: botão vermelho. */
  perigo?: boolean;
  /** Confirmar desabilitado (ex.: prévia sem nada a gravar). */
  confirmarDesabilitado?: boolean;
  ocupado?: boolean;
  onConfirmar: () => void;
  onCancelar: () => void;
}

/**
 * Confirmação explícita para as ações da área de Segurança (confiar num
 * repositório, gravar política, escrever na config de um CLI).
 *
 * `window.confirm` não serve: não mostra o diff nem a lista do que muda, e é
 * exatamente isso que a pessoa precisa ver para decidir. O foco inicial vai
 * para "Cancelar" — Enter por reflexo não pode gravar nada.
 *
 * Renderizado em portal na raiz `.app`: aberto de dentro de uma aba, o fundo
 * que `useDialog` torna inerte seriam só os irmãos locais, e a topbar
 * continuaria clicável por trás do modal.
 */
export function ConfirmDialog(props: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const cancelarRef = useRef<HTMLButtonElement>(null);
  const base = useId();
  useDialog(ref, props.onCancelar, { focoInicial: cancelarRef });
  const fundo = useFecharPeloFundo(props.onCancelar);

  return createPortal(
    <div className="modal-backdrop" {...fundo}>
      <div
        ref={ref}
        className="modal sec-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${base}-titulo`}
        aria-describedby={props.resumo ? `${base}-resumo` : undefined}
      >
        <div className="modal-body">
          <h2 id={`${base}-titulo`}>{props.titulo}</h2>
          {props.resumo && (
            <p className="hint" id={`${base}-resumo`}>
              {props.resumo}
            </p>
          )}
          {props.children}
        </div>
        <div className="modal-actions">
          <button ref={cancelarRef} type="button" onClick={props.onCancelar} disabled={props.ocupado}>
            Cancelar
          </button>
          <button
            type="button"
            className={props.perigo ? 'danger' : 'primary'}
            onClick={props.onConfirmar}
            disabled={props.ocupado || props.confirmarDesabilitado}
          >
            {props.ocupado ? 'gravando…' : props.confirmarRotulo}
          </button>
        </div>
      </div>
    </div>,
    document.querySelector('.app') ?? document.body,
  );
}
