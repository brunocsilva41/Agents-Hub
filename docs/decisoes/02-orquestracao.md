# ADR 02 — Orquestração, Sessões e Superfícies (decidido em 2026-08-26)

| # | Decisão | Escolha | Consequência |
|---|---|---|---|
| 2.1 | Semântica de delegação | **Assíncrona (task_id) + Streaming (observação em tempo real)** | Toda chamada agente→agente retorna `task_id` imediatamente. O chamador pode fazer polling (`agent.status`) OU abrir stream (`agent.stream`). O modelo se **inspira** na semântica do A2A (`tasks/get`, `tasks/resubscribe`), mas a API REST implementada (`/api/tasks/*`) não é JSON-RPC 2.0 e não fala o protocolo A2A — ver 2.3. Síncrono é apenas açúcar: async + await do terminal. Handoff fica para fase 2. |
| 2.2 | Persistência | **SQLite (sessões, tasks, eventos, custos) + disco (artefatos, transcripts, logs brutos)** | Consultas analíticas ("quanto gastei com Codex esta semana") desde o dia 1. Acesso via camada de repositório para não amarrar o domínio ao SQLite. |
| 2.3 | Superfícies de entrada | **MCP server + HTTP/REST+SSE (`/api/tasks/*`)** | MCP = como os 8 agentes chamam o Hub. HTTP+SSE = espinha dorsal dos clientes (CLI/TUI/Web), de scripts/CI, e de qualquer peer externo que só fale HTTP — inclusive `/api/tasks/*`, que existe hoje como API REST simples em torno dos tipos do Hub. **"A2A de verdade" (JSON-RPC 2.0 completo, com `message/send`, `tasks/get`, `tasks/resubscribe`) é decisão em aberto**, gated por aparecer um consumidor real que precise falar o protocolo canônico — até lá, a API REST cobre a necessidade de automação externa sem prometer uma compatibilidade que não existe. Ver `docs/07-progresso-real.md` §2.3. ACP fica para fase 3. |
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
