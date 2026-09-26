import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { AgentSummary, SessionSummary } from '@agents-hub/client';
import { agentColor, STATE_LABEL } from '../hub';
import { useDialog, useFecharPeloFundo } from '../useDialog';

interface Props {
  onClose: () => void;
  sessions: SessionSummary[];
  agents: AgentSummary[];
  onSelectSession: (id: string) => void;
  onNewSession: (agentId?: string) => void;
}

/** Um resultado da paleta, já achatado: é o que setas e Enter percorrem. */
interface Item {
  chave: string;
  grupo: 'acoes' | 'agentes' | 'sessoes';
  executar: () => void;
  conteudo: React.ReactNode;
}

/** Rótulo do atalho conforme a plataforma: "⌘K" só faz sentido no Mac. */
export function rotuloAtalhoPaleta(): string {
  const plataforma =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    '';
  return /mac|iphone|ipad/i.test(plataforma) ? '⌘K' : 'Ctrl K';
}

const TITULO_GRUPO: Record<Item['grupo'], string> = {
  acoes: 'Ações rápidas',
  agentes: 'Iniciar com agente',
  sessoes: 'Sessões',
};

/**
 * Paleta de comandos (Ctrl/⌘+K).
 *
 * O atalho que ABRE mora no App (antes morava aqui dentro, num componente que
 * só existia depois de aberto — o atalho anunciado nunca abria nada). Aqui é
 * um combobox: o foco fica no campo, setas movem o item ativo
 * (`aria-activedescendant`) e Enter executa.
 */
export function CommandPalette({
  onClose,
  sessions,
  agents,
  onSelectSession,
  onNewSession,
}: Props): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [ativo, setAtivo] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listaRef = useRef<HTMLDivElement>(null);
  const base = useId();
  const tituloId = `${base}-titulo`;
  const listaId = `${base}-lista`;

  useDialog(dialogRef, onClose, { focoInicial: inputRef });
  const fundo = useFecharPeloFundo(onClose);

  const cleanQuery = query.toLowerCase().trim();

  const itens = useMemo<Item[]>(() => {
    const lista: Item[] = [];
    const casa = (...campos: Array<string | null | undefined>): boolean =>
      cleanQuery === '' || campos.some((c) => (c ?? '').toLowerCase().includes(cleanQuery));

    if (casa('criar nova sessão', 'nova sessão')) {
      lista.push({
        chave: 'nova',
        grupo: 'acoes',
        executar: () => onNewSession(),
        conteudo: (
          <>
            <span className="cmd-icon-action" aria-hidden="true">+</span>
            <span className="cmd-item-label">Criar nova sessão</span>
          </>
        ),
      });
    }

    // Só agentes instalados: iniciar com um ausente monta a sessão inteira para
    // falhar depois com "binário não encontrado".
    for (const agent of agents) {
      if (agent.probe?.installed === false) continue;
      if (!casa(agent.id, agent.name, agent.vendor)) continue;
      lista.push({
        chave: `agente-${agent.id}`,
        grupo: 'agentes',
        executar: () => onNewSession(agent.id),
        conteudo: (
          <>
            <span className="cmd-agent-dot" style={{ background: agentColor(agent.id) }} aria-hidden="true" />
            <span className="cmd-item-label">{agent.name}</span>
            <span className="cmd-item-meta">
              {agent.vendor} · {agent.id}
            </span>
          </>
        ),
      });
    }

    const sessoes = sessions.filter((s) => casa(s.id, s.title, s.agentId)).slice(0, 6);
    for (const session of sessoes) {
      lista.push({
        chave: `sessao-${session.id}`,
        grupo: 'sessoes',
        executar: () => onSelectSession(session.id),
        conteudo: (
          <>
            <span className="cmd-agent-tag" style={{ color: agentColor(session.agentId) }}>
              {session.agentId}
            </span>
            <span className="cmd-item-label">{session.title || session.id}</span>
            <span className={`cmd-status-badge state-${session.state}`}>
              {STATE_LABEL[session.state] ?? session.state}
            </span>
          </>
        ),
      });
    }
    return lista;
  }, [cleanQuery, agents, sessions, onNewSession, onSelectSession]);

  // Filtro novo: volta ao primeiro resultado.
  useEffect(() => setAtivo(0), [cleanQuery]);

  const indiceAtivo = itens.length === 0 ? -1 : Math.min(ativo, itens.length - 1);
  const idDoItem = (i: number): string => `${base}-opcao-${i}`;

  // Item ativo sempre visível na lista rolável.
  useEffect(() => {
    if (indiceAtivo < 0) return;
    listaRef.current
      ?.querySelector(`[id="${CSS.escape(idDoItem(indiceAtivo))}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  });

  const executar = (item: Item): void => {
    onClose();
    item.executar();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (itens.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setAtivo((indiceAtivo + 1) % itens.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setAtivo((indiceAtivo - 1 + itens.length) % itens.length);
    } else if (e.key === 'Home' && e.ctrlKey) {
      e.preventDefault();
      setAtivo(0);
    } else if (e.key === 'End' && e.ctrlKey) {
      e.preventDefault();
      setAtivo(itens.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = itens[indiceAtivo];
      if (item) executar(item);
    }
  };

  const grupos = (['acoes', 'agentes', 'sessoes'] as const)
    .map((g) => ({ grupo: g, itens: itens.map((item, i) => ({ item, i })).filter((x) => x.item.grupo === g) }))
    .filter((g) => g.itens.length > 0);

  return (
    <div className="cmd-backdrop" {...fundo}>
      <div
        ref={dialogRef}
        className="cmd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={tituloId}
      >
        <h2 id={tituloId} className="sr-only">
          Paleta de comandos
        </h2>
        <div className="cmd-input-wrap">
          <svg className="cmd-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="cmd-input"
            role="combobox"
            aria-expanded="true"
            aria-controls={listaId}
            aria-autocomplete="list"
            aria-activedescendant={indiceAtivo >= 0 ? idDoItem(indiceAtivo) : undefined}
            aria-label="Buscar sessões, agentes ou ações"
            placeholder="Buscar sessões, agentes ou ações…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd className="cmd-badge">Esc</kbd>
        </div>

        <div className="cmd-results" id={listaId} role="listbox" aria-label="Resultados" ref={listaRef}>
          {grupos.map(({ grupo, itens: doGrupo }) => (
            <div className="cmd-group" role="group" aria-labelledby={`${base}-g-${grupo}`} key={grupo}>
              <div className="cmd-group-title" id={`${base}-g-${grupo}`} role="presentation">
                {TITULO_GRUPO[grupo]}
                {grupo !== 'acoes' ? ` (${doGrupo.length})` : ''}
              </div>
              {doGrupo.map(({ item, i }) => (
                <div
                  key={item.chave}
                  id={idDoItem(i)}
                  role="option"
                  aria-selected={i === indiceAtivo}
                  className={`cmd-item${i === indiceAtivo ? ' ativo' : ''}`}
                  onMouseMove={() => {
                    if (i !== indiceAtivo) setAtivo(i);
                  }}
                  onClick={() => executar(item)}
                >
                  {item.conteudo}
                </div>
              ))}
            </div>
          ))}

          {itens.length === 0 && (
            <div className="cmd-empty" role="status">
              Nenhum resultado para “{query}”
            </div>
          )}
        </div>
        <div className="cmd-footer" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> navegar</span>
          <span><kbd>Enter</kbd> abrir</span>
          <span><kbd>Esc</kbd> fechar</span>
        </div>
      </div>
    </div>
  );
}
