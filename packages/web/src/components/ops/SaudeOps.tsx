import { useState } from 'react';
import type React from 'react';
import type { AgentSummary } from '@agents-hub/client';
import { formatAgo, hub } from '../../hub';
import { diagnosticarAgente } from '../../logic/operacao';
import { Cartao, EstadoDaCarga, ResultadoDaAcao } from './Partes';
import { useAcao } from './useAcao';
import { useCarga } from './useCarga';

interface Props {
  agents: AgentSummary[];
  /** Relê o índice (agentes inclusive) depois de re-sondar. */
  onChanged: () => void;
}

const ROTULO_NIVEL = { ok: 'ok', aviso: 'atenção', erro: 'indisponível' } as const;

/**
 * Saúde do daemon e diagnóstico dos agentes — o que `hub status`/`hub doctor`
 * mostram no terminal, com o que a API expõe: `/health` e `/agents` (probe,
 * manifesto conferido, suporte a modelo, dica de login).
 */
export function SaudeOps({ agents, onChanged }: Props): React.JSX.Element {
  const [tick, setTick] = useState(0);
  const saude = useCarga('health', () => hub.health(), String(tick));
  const acao = useAcao();

  const resondar = (): void => {
    void acao
      .executar(
        'probe',
        () => hub.probeAgents(),
        (r) => {
          const instalados = r.probes.filter((p) => p.installed).length;
          return `Sondagem refeita: ${instalados} de ${r.probes.length} agentes encontrados.`;
        },
      )
      .then((r) => {
        if (r) onChanged();
      });
  };

  return (
    <div className="ops-stack">
      <Cartao
        id="saude-daemon"
        titulo="Daemon"
        acoes={
          <button
            type="button"
            onClick={() => setTick((n) => n + 1)}
            disabled={saude.estado === 'carregando' && !saude.dados}
          >
            Atualizar
          </button>
        }
      >
        <EstadoDaCarga
          estado={saude.estado}
          erro={saude.erro}
          temDados={saude.dados !== null}
          oQue="o estado do daemon"
          onTentar={() => setTick((n) => n + 1)}
        />
        {saude.dados && (
          <dl className="ops-kv">
            <div>
              <dt>Estado</dt>
              <dd>{saude.dados.ok ? 'respondendo' : 'com problema'}</dd>
            </div>
            <div>
              <dt>Versão</dt>
              <dd className="ops-mono">{saude.dados.version}</dd>
            </div>
            <div>
              <dt>Sessões vivas</dt>
              <dd>{saude.dados.liveSessions}</dd>
            </div>
            <div>
              <dt>Conexões ao vivo (SSE)</dt>
              <dd>{saude.dados.subscribers}</dd>
            </div>
            <div>
              <dt>Relógio do daemon</dt>
              <dd className="ops-mono">{saude.dados.now.replace('T', ' ').slice(0, 19)}</dd>
            </div>
          </dl>
        )}
      </Cartao>

      <Cartao
        id="saude-agentes"
        titulo="Agentes"
        descricao="Instalação vem da sondagem do daemon (com cache). Instalou ou atualizou um CLI? Re-sonde para o Hub ver agora."
        acoes={
          <button type="button" className="primary" onClick={resondar} disabled={acao.ocupado !== null}>
            {acao.ocupado === 'probe' ? 'Sondando…' : 'Re-sondar agentes'}
          </button>
        }
      >
        <ResultadoDaAcao ok={acao.ok} erro={acao.erro} />
        {agents.length === 0 ? (
          <p className="ops-muted">O daemon não informou nenhum agente.</p>
        ) : (
          <ul className="ops-list">
            {agents.map((a) => {
              const d = diagnosticarAgente(a);
              return (
                <li key={a.id} className="ops-item">
                  <div className="ops-item-head">
                    <span className={`ops-pill nivel-${d.nivel}`}>{ROTULO_NIVEL[d.nivel]}</span>
                    <strong>{a.name}</strong>
                    <span className="ops-mono ops-muted">{a.id}</span>
                    <span className="ops-muted">{d.estado}</span>
                    {a.probe?.checkedAt && (
                      <span className="ops-muted ops-push">sondado {formatAgo(a.probe.checkedAt)}</span>
                    )}
                  </div>
                  {d.notas.length > 0 && (
                    <ul className="ops-notes">
                      {d.notas.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Cartao>
    </div>
  );
}
