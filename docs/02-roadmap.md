# 02 — Roadmap de Implementação

Ordem derivada do ADR 04.4: **vertical fina primeiro**. Cada fase termina com algo que roda de verdade.

## Fase 1 — Vertical fina (em andamento)

Objetivo: uma sessão real com UM agente, ponta a ponta, provando o contrato antes de multiplicar por oito.

- [x] Monorepo, tooling, tipos do domínio
- [x] `EventEnvelope` + tipos de evento
- [x] `PolicyEngine` (níveis de risco, não-escalação)
- [x] `BudgetLedger` (herança do orçamento da raiz)
- [x] `CallGraph` (profundidade + detecção de ciclo semântico)
- [x] `store`: SQLite via `node:sqlite`, migrações, repositórios
- [x] Contrato de adapter + registry dirigido por manifesto
- [x] Adapter genérico de CLI (spawn + JSONL + mappers)
- [x] Mappers: Claude Code, Codex
- [x] Daemon HTTP + SSE
- [x] CLI `hub` (doctor, agents, start, send, watch, sessions, cancel)
- [ ] `WorktreeManager` (isolamento por sessão)
- [ ] Teste de fumaça com agente real instalado

## Fase 2 — Delegação e o resto dos agentes

- [ ] `Orchestrator`: `agent.call` completo com Brief, task lifecycle A2A, pipeline de resiliência
- [ ] **MCP server do Hub** (`hub_agent_call` e cia.) — o momento em que agente-chama-agente passa a existir
- [ ] Comando de instalação: registrar o Hub como MCP server em cada agente automaticamente
- [ ] Mappers restantes: OpenCode (HTTP+SSE), Cursor, Copilot, Antigravity, Kimi, MiMo
- [ ] Fila de aprovações (bloqueio real em `input_required`) na CLI
- [ ] TUI: grafo ao vivo, streams lado a lado, controles (pausar/interromper/injetar/matar)
- [ ] Web UI React+Vite servida pelo daemon

## Fase 3 — Plataforma

- [ ] **A2A server**: Agent Card assinado, `tasks/get`, `tasks/cancel`, `tasks/resubscribe`
- [ ] Motor de workflows declarativos em YAML (fan-out paralelo, gates, condicionais)
- [ ] Handoff de sessão (A transfere o principal para B em tempo de execução)
- [ ] Validação por revisão cruzada (segundo agente revisa o resultado do primeiro)
- [ ] Painel de custos com projeção e alertas de orçamento
- [ ] Isolamento por container como modo opcional (`isolation: container`)
- [ ] ACP: expor o Hub como agente dentro de Zed/JetBrains/Neovim

## Decisões ainda em aberto

| Tema | Pergunta | Bloqueia |
|---|---|---|
| Escalação humana em falha | Quando retry + fallback + validação se esgotam, a task morre em `failed` (assunção do ADR 04). Confirmar ou trocar por `input_required`. | Fase 2 |
| Cadeias de fallback | Qual a ordem por capability? (ex.: `code-edit: claude → codex → opencode`) | Fase 2 |
| Retenção | Por quanto tempo guardar eventos brutos e worktrees de sessões encerradas? | Fase 2 |
| Acesso remoto | Expor o daemon na rede/túnel exige authn/authz — desejado? | Fase 3 |
| Modelos por agente | Fixar modelo por agente no manifesto ou deixar o default de cada CLI? | Fase 2 |
