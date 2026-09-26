import { useState } from 'react';
import type React from 'react';
import { hub } from '../../hub';
import { Cartao, ResultadoDaAcao } from './Partes';
import { useAcao } from './useAcao';

type Varredura = Awaited<ReturnType<typeof hub.sweep>>['sweep'];

/**
 * `hub prune` pelo painel: recolhe os worktrees de sessões encerradas há mais
 * tempo que a retenção. Não há prévia no daemon — a confirmação diz
 * exatamente a regra, e o resultado lista o que saiu e o que falhou.
 */
export function ManutencaoOps(): React.JSX.Element {
  const acao = useAcao();
  const [confirmar, setConfirmar] = useState(false);
  const [resultado, setResultado] = useState<Varredura | null>(null);

  const varrer = (): void => {
    setConfirmar(false);
    void acao
      .executar('sweep', () => hub.sweep(), (r) =>
        `${r.sweep.examined} sessão(ões) encerrada(s) examinada(s) · ${r.sweep.removed.length} worktree(s) recolhido(s) · ${r.sweep.retained} ainda no prazo` +
        (r.sweep.failed.length > 0 ? ` · ${r.sweep.failed.length} falharam` : ''),
      )
      .then((r) => setResultado(r?.sweep ?? null));
  };

  return (
    <div className="ops-stack">
      <Cartao
        id="manutencao-worktrees"
        titulo="Recolher worktrees expirados"
        descricao="Remove o checkout (git worktree) de sessões com isolamento em worktree que terminaram há mais tempo que a retenção configurada. Os branches hub/<sessão> ficam intactos. Exige o token de operador (o painel servido pelo Hub já o tem)."
      >
        {!confirmar ? (
          <button type="button" className="danger" onClick={() => setConfirmar(true)} disabled={acao.ocupado !== null}>
            {acao.ocupado === 'sweep' ? 'Recolhendo…' : 'Recolher worktrees…'}
          </button>
        ) : (
          <div className="subform ops-confirm" role="alertdialog" aria-label="Confirmar recolher worktrees">
            <span>
              Apagar do disco os worktrees expirados? Quem ainda estiver dentro da janela de retenção não é tocado.
            </span>
            <div className="subform-actions">
              <button type="button" className="danger" autoFocus onClick={varrer}>
                Recolher agora
              </button>
              <button type="button" onClick={() => setConfirmar(false)}>
                Cancelar
              </button>
            </div>
          </div>
        )}
        <ResultadoDaAcao ok={acao.ok} erro={acao.erro} />
        {resultado && resultado.removed.length > 0 && (
          <ul className="ops-notes" aria-label="Worktrees recolhidos">
            {resultado.removed.map((p) => (
              <li key={p} className="ops-mono">
                {p}
              </li>
            ))}
          </ul>
        )}
        {resultado && resultado.failed.length > 0 && (
          <ul className="ops-errors" aria-label="Falhas ao recolher">
            {resultado.failed.map((f) => (
              <li key={f.path}>
                <span className="ops-mono">{f.path}</span>: {f.reason}
              </li>
            ))}
          </ul>
        )}
      </Cartao>
    </div>
  );
}
