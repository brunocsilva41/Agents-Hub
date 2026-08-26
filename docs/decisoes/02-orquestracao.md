# ADR 02 — Orquestração, Sessões e Superfícies (decidido em 2026-08-26)

| # | Decisão | Escolha | Consequência |
|---|---|---|---|
| 2.1 | Semântica de delegação | **Assíncrona (task_id) + Streaming (observação em tempo real)** | Toda chamada agente→agente retorna `task_id` imediatamente. O chamador pode fazer polling (`agent.status`) OU abrir stream (`agent.stream`). Modelo idêntico ao A2A: `tasks/get`, `tasks/resubscribe`. Síncrono é apenas açúcar: async + await do terminal. Handoff fica para fase 2. |
| 2.2 | Persistência | **SQLite (sessões, tasks, eventos, custos) + disco (artefatos, transcripts, logs brutos)** | Consultas analíticas ("quanto gastei com Codex esta semana") desde o dia 1. Acesso via camada de repositório para não amarrar o domínio ao SQLite. |
| 2.3 | Superfícies de entrada | **MCP server + A2A server + HTTP/REST+SSE** | Três portas para o mesmo núcleo. MCP = como os 8 agentes chamam o Hub. A2A = como peers externos falam com o Hub. HTTP+SSE = espinha dorsal dos clientes (CLI/TUI/Web) e de scripts/CI. ACP fica para fase 3. |
| 2.4 | Aprovação humana | **Política por nível de risco, configurável por agente** | Toda ação é classificada em níveis de risco antes de executar; níveis acima do limiar geram um evento de aprovação pendente que bloqueia a task (estado `input_required` do A2A) até resposta na UI/CLI. |

## Níveis de risco (rascunho — a refinar no ADR 03)

| Nível | Exemplos | Padrão |
|---|---|---|
| `read` | ler arquivo, listar dir, buscar código, git status/log/diff | permitir |
| `write` | escrever/editar arquivo **dentro do worktree da sessão** | permitir |
| `exec` | rodar build, testes, linters (comandos em allowlist) | permitir |
| `escalate` | escrever fora do worktree, instalar dependência, comando fora da allowlist, acesso de rede | **pedir aprovação** |
| `irreversible` | git push, git reset --hard, delete de arquivo/branch, publicar, enviar mensagem externa | **pedir aprovação sempre** |
| `budget` | exceder orçamento de tokens/custo/tempo/profundidade | **pedir aprovação** |

## Regra de não-escalação
Uma sessão filha **nunca** recebe permissão maior que a da sessão pai. A política efetiva é a interseção entre a política do agente e a política herdada.
