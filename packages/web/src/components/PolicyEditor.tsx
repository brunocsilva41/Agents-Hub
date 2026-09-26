import React, { useEffect, useMemo, useState } from 'react';
import type { PolicySummary } from '@agents-hub/client';
import { describeError, pushToast, useAction } from '../actions';
import { hub } from '../hub';
import {
  analisarCamada,
  avisosDePolitica,
  temAvisos,
  textoDaCamada,
  type AvisosDePolitica,
} from '../logic/security';
import { ConfirmDialog } from './ConfirmDialog';

interface Props {
  /** Projeto escolhido no topo da área; `''` = só a camada global. */
  projectId: string;
  projectName: string;
  onSujoChange: (sujo: boolean) => void;
}

type Escopo = 'global' | 'project';

/**
 * Editor de política (itens 1.10 e 6.12 do GOAL).
 *
 * Edita a CAMADA — o que o arquivo declara, sem os padrões — em JSON, com a
 * política efetiva ao lado. O fluxo é revisar -> confirmar -> gravar:
 * "Revisar" manda a camada ao daemon com `?dryRun=1` (mesma validação Zod e
 * mesmo clamp que decidem de verdade) e mostra, ANTES de gravar, o que
 * afrouxa (global) ou o que ficaria sem efeito (projeto). Gravar só fica
 * disponível para o texto exatamente revisado.
 */
export function PolicyEditor({ projectId, projectName, onSujoChange }: Props): React.JSX.Element {
  const [escopo, setEscopo] = useState<Escopo>('global');
  const [resumo, setResumo] = useState<PolicySummary | null>(null);
  const [erroCarga, setErroCarga] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);
  const [texto, setTexto] = useState('');
  const [original, setOriginal] = useState('');
  const [previa, setPrevia] = useState<{ texto: string; avisos: AvisosDePolitica } | null>(null);
  const [resultado, setResultado] = useState<{ avisos: AvisosDePolitica; backup: string | null } | null>(
    null,
  );
  const [confirmando, setConfirmando] = useState(false);
  const action = useAction();

  const escopoEfetivo: Escopo = projectId === '' ? 'global' : escopo;
  const sujo = texto !== original;

  useEffect(() => {
    onSujoChange(sujo);
  }, [sujo, onSujoChange]);
  useEffect(() => () => onSujoChange(false), [onSujoChange]);

  useEffect(() => {
    let cancelado = false;
    setResumo(null);
    setErroCarga(null);
    setPrevia(null);
    hub
      .policy(projectId === '' ? undefined : projectId)
      .then(({ policy }) => {
        if (cancelado) return;
        setResumo(policy);
        const camada =
          escopoEfetivo === 'project' && policy.project ? policy.project.layer : policy.global.layer;
        const t = textoDaCamada(camada);
        setTexto(t);
        setOriginal(t);
      })
      .catch((err: unknown) => {
        if (cancelado) return;
        const { title, detail } = describeError(err);
        setErroCarga(detail ? `${title} (${detail})` : title);
      });
    return () => {
      cancelado = true;
    };
  }, [projectId, escopoEfetivo, recarga]);

  const analise = useMemo(() => analisarCamada(texto), [texto]);
  const revisadoEAtual = previa !== null && previa.texto === texto;

  const trocarEscopo = (novo: Escopo): void => {
    if (novo === escopoEfetivo) return;
    if (sujo && !window.confirm('Há alterações não revisadas nesta camada. Descartar e trocar?')) return;
    setResultado(null);
    setEscopo(novo);
  };

  const revisar = async (): Promise<void> => {
    if (!analise.ok) return;
    const camada = analise.camada;
    const alvo = texto;
    await action.run('revisar', async () => {
      const r =
        escopoEfetivo === 'project'
          ? await hub.previewProjectPolicy(projectId, camada)
          : await hub.previewGlobalPolicy(camada);
      setPrevia({ texto: alvo, avisos: avisosDePolitica(r) });
      setResultado(null);
    });
  };

  const gravar = async (): Promise<void> => {
    if (!analise.ok || !revisadoEAtual) return;
    const camada = analise.camada;
    const ok = await action.run('gravar', async () => {
      if (escopoEfetivo === 'project') {
        const r = await hub.setProjectPolicy(projectId, camada);
        setResultado({ avisos: avisosDePolitica(r), backup: null });
      } else {
        const r = await hub.setGlobalPolicy(camada);
        setResultado({ avisos: avisosDePolitica(r), backup: r.backup });
        if (r.loosened.length > 0) {
          pushToast({
            kind: 'warn',
            title: 'Política global gravada — e AFROUXADA',
            detail: r.loosened.join(', '),
          });
        }
      }
    }, 'política gravada');
    setConfirmando(false);
    if (ok) {
      setPrevia(null);
      setRecarga((n) => n + 1);
    }
  };

  const projeto = resumo?.project ?? null;
  const efetiva = escopoEfetivo === 'project' && projeto ? projeto.effective : resumo?.global.effective;
  const arquivo = escopoEfetivo === 'project' && projeto ? projeto.file : resumo?.global.file;

  return (
    <div className="settings-card sec-policy">
      <h3 className="card-title">Editor de política</h3>
      <p className="card-desc">
        A camada <strong>global</strong> (<code>config.json</code> do Hub) vale para todos os
        projetos e pode afrouxar. A camada do <strong>projeto</strong> (
        <code>.agents-hub/config.yaml</code>) só aperta: o que tentar afrouxar é gravado, mas não
        vale aqui.
      </p>

      <div className="seg sec-seg" role="group" aria-label="Camada da política">
        <button
          className={escopoEfetivo === 'global' ? 'on' : ''}
          aria-pressed={escopoEfetivo === 'global'}
          onClick={() => trocarEscopo('global')}
        >
          Global
        </button>
        <button
          className={escopoEfetivo === 'project' ? 'on' : ''}
          aria-pressed={escopoEfetivo === 'project'}
          disabled={projectId === ''}
          title={projectId === '' ? 'Escolha um projeto no topo' : undefined}
          onClick={() => trocarEscopo('project')}
        >
          Projeto{projectName ? `: ${projectName}` : ''}
        </button>
      </div>

      {erroCarga && (
        <div className="settings-erro" role="alert">
          Não foi possível ler a política: {erroCarga}
          <button className="ghost" onClick={() => setRecarga((n) => n + 1)}>
            tentar de novo
          </button>
        </div>
      )}

      {escopoEfetivo === 'project' && projeto && (
        <div className="sec-status-projeto">
          {projeto.error && (
            <div className="settings-erro" role="alert">
              O YAML do projeto é inválido e a camada não está valendo: {projeto.error}
            </div>
          )}
          {!projeto.trusted && (
            <p className="help help-warn">
              Projeto não confiável: campos que executam processo (<code>validation.command</code>,
              revisão) são ignorados. Veja "Confiança do projeto".
            </p>
          )}
          <ListaDeAvisos
            avisos={avisosDePolitica(projeto)}
            titulo="Na camada gravada hoje"
          />
        </div>
      )}

      <div className="field">
        <label htmlFor="sec-camada">
          Camada {escopoEfetivo === 'global' ? 'global' : 'do projeto'} (JSON)
        </label>
        <textarea
          id="sec-camada"
          className="sec-editor"
          rows={14}
          spellCheck={false}
          disabled={resumo === null}
          aria-invalid={!analise.ok}
          aria-describedby="sec-camada-ajuda"
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
        />
        <div className="help" id="sec-camada-ajuda">
          {arquivo ? (
            <>
              Grava em <code>{arquivo}</code>
              {escopoEfetivo === 'global' ? ' (com backup versionado).' : ' (o resto do arquivo é preservado).'}
            </>
          ) : (
            'carregando…'
          )}{' '}
          Ex.: <code>{'{"commands": {"allow": ["npm test"]}, "risk": {"high": "approve"}}'}</code>
        </div>
        {!analise.ok && (
          <div className="aviso-inline" role="alert">
            {analise.erro}
          </div>
        )}
      </div>

      {action.error && (
        <div className="settings-erro" role="alert">
          {action.error}
          <button className="ghost" onClick={action.clearError}>
            dispensar
          </button>
        </div>
      )}

      {revisadoEAtual && previa && (
        <div className="sec-previa" role="status">
          <ListaDeAvisos avisos={previa.avisos} titulo="Prévia" />
          {!temAvisos(previa.avisos) && (
            <p className="sec-ok">Nada nesta camada afrouxa a política atual nem fica sem efeito.</p>
          )}
        </div>
      )}

      {resultado && (
        <div className="sec-previa" role="status">
          <ListaDeAvisos avisos={resultado.avisos} titulo="Gravado" />
          {resultado.backup && (
            <p className="help">
              Backup do arquivo anterior: <code>{resultado.backup}</code>
            </p>
          )}
        </div>
      )}

      <div className="sec-acoes">
        <button
          onClick={() => {
            setTexto(original);
            setPrevia(null);
          }}
          disabled={!sujo || action.busy !== null}
        >
          Descartar
        </button>
        <button
          onClick={() => void revisar()}
          disabled={!analise.ok || resumo === null || action.busy !== null}
        >
          {action.busy === 'revisar' ? 'revisando…' : 'Revisar alterações'}
        </button>
        <button
          className={revisadoEAtual && previa!.avisos.afrouxa.length > 0 ? 'danger' : 'primary'}
          onClick={() => setConfirmando(true)}
          disabled={!revisadoEAtual || !sujo || action.busy !== null}
          title={revisadoEAtual ? undefined : 'Revise antes de gravar'}
        >
          Gravar…
        </button>
      </div>

      {efetiva && (
        <details className="sec-efetiva">
          <summary>Política efetiva agora ({escopoEfetivo === 'global' ? 'global' : 'neste projeto'})</summary>
          <pre>{JSON.stringify(efetiva, null, 2)}</pre>
        </details>
      )}

      {confirmando && previa && (
        <ConfirmDialog
          titulo={
            escopoEfetivo === 'global' ? 'Gravar a política global?' : 'Gravar a política do projeto?'
          }
          resumo={
            escopoEfetivo === 'global'
              ? 'Passa a valer na hora, para todos os projetos e sessões.'
              : `Grava no config.yaml de "${projectName}" — um arquivo versionado do repositório.`
          }
          perigo={previa.avisos.afrouxa.length > 0}
          confirmarRotulo={previa.avisos.afrouxa.length > 0 ? 'Afrouxar e gravar' : 'Gravar'}
          ocupado={action.busy === 'gravar'}
          onCancelar={() => setConfirmando(false)}
          onConfirmar={() => void gravar()}
        >
          <ListaDeAvisos avisos={previa.avisos} titulo="O que muda" />
          {!temAvisos(previa.avisos) && <p className="sec-ok">Nada afrouxa nem fica sem efeito.</p>}
        </ConfirmDialog>
      )}
    </div>
  );
}

function ListaDeAvisos({
  avisos,
  titulo,
}: {
  avisos: AvisosDePolitica;
  titulo: string;
}): React.JSX.Element | null {
  if (!temAvisos(avisos)) return null;
  return (
    <div className="sec-avisos">
      {avisos.afrouxa.length > 0 && (
        <div className="sec-aviso sec-aviso-perigo" role="alert">
          <strong>{titulo}: isto AFROUXA a política</strong>
          <ul>
            {avisos.afrouxa.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {avisos.semEfeito.length > 0 && (
        <div className="sec-aviso sec-aviso-alerta">
          <strong>{titulo}: sem efeito aqui (clamp — a camada do projeto só aperta)</strong>
          <ul>
            {avisos.semEfeito.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {avisos.execIgnorados.length > 0 && (
        <div className="sec-aviso sec-aviso-alerta">
          <strong>{titulo}: ignorado — executa processo e o projeto não é confiável</strong>
          <ul>
            {avisos.execIgnorados.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
