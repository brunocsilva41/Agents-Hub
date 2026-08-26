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
