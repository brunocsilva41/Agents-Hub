# ADR 01 — Fundamentos (decidido em 2026-08-26)

| # | Decisão | Escolha | Consequência |
|---|---|---|---|
| 1.1 | Stack do núcleo | **TypeScript / Node 25** | SDKs oficiais (MCP, A2A, Claude Agent SDK, OpenCode) disponíveis; adapters = spawn + parse JSONL. Monorepo com workspaces. |
| 1.2 | Topologia | **Daemon local + CLI/TUI + Web UI** | Daemon mantém sessões vivas independente do terminal. Três clientes sobre a MESMA API interna (HTTP+SSE/WS) — nada de lógica no cliente. |
| 1.3 | Isolamento | **Git worktree por sessão + allowlist declarativa** | Cada sessão roda em worktree próprio; política de tools/paths/comandos por agente. Container fica como modo opcional futuro (`isolation: container`). |
| 1.4 | Agentes no MVP | **Todos**: Claude Code, Codex, OpenCode, Cursor, Copilot, Antigravity, Kimi Code, MiMo | Exige **adapter genérico dirigido por manifesto** desde o dia 1. Adicionar agente = arquivo YAML/TS de manifesto, não código novo. Adapters especializados só onde há ganho real (OpenCode HTTP, Codex MCP, Claude stream-json). |

## Implicações de projeto

- **Arquitetura em camadas obrigatória:** `core (domínio) → adapters (agentes) → transports (MCP/A2A/HTTP) → clients (CLI/TUI/Web)`. Nenhuma camada superior é importada por uma inferior.
- **Sem lógica no cliente:** CLI, TUI e Web UI são consumidores burros da API do daemon. Isso garante paridade de funcionalidade entre os três.
- **Contrato de adapter:** todo agente é reduzido a `start | send | stream | interrupt | resume | cancel | status`. Quem não suportar nativamente, o Hub emula (ex.: resume via replay de contexto).

## Estado atual (nota de 2026-09-26 — a decisão acima não foi reescrita)

Conferido no código para o item 8.1 do [GOAL](../12-goal-mvp-completo.md):

- **1.1 Stack:** o piso declarado é **Node ≥ 22.5** (`engines` no `package.json`), não Node 25; o CI testa 22.5 e 24. No 22.5–22.12 a CLI reexecuta o Node com `--experimental-sqlite` (`packages/cli/src/bin.ts`).
- **1.2 Topologia:** **não existe TUI** (roadmap `[ ]`; a Web UI cobriu a necessidade). Os clientes são a CLI `hub` e a Web UI, sobre `@agents-hub/client`. Não há WebSocket: HTTP + SSE.
- **1.4 Agentes:** são **9**, não 8 — `openclaude` entrou depois (`manifests/`). Adapters especializados: OpenCode (HTTP) e mappers dedicados de Claude/OpenClaude, Codex, Copilot, Kimi e Antigravity; Cursor e MiMo usam o `generic-json`. O Codex não é integrado por MCP: roda por `codex exec --json`.
- **Implicações:** a camada "transports (MCP/A2A/HTTP)" não tem A2A — `/api/tasks/*` é REST simples (ver ADR 02.3). O contrato de adapter real é `probe | start | resume | send | interrupt | cancel`, com o stream em `RunHandle.events` (`packages/adapters/src/types.ts`); não há `status` no adapter.
