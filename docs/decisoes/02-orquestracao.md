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

## Estado atual (nota de 2026-09-26 — a decisão acima não foi reescrita)

- **2.1:** os nomes reais são as tools MCP `hub_agent_call`, `hub_agent_status`, `hub_agent_wait` e `hub_agent_events` (não existe `agent.stream`); handoff existe (`hub handoff`, `hub_session_handoff`), mas nunca foi exercido fora do teste.
- **2.3:** "os 8 agentes" — são 9, e 7 têm caminho de config MCP confirmado (o Kimi 2.0.0 não tem mecanismo de MCP; o do MiMo não foi localizado; `packages/daemon/src/mcp-config.ts`). Não há TUI. ACP segue não iniciado.
- **2.4:** além do portão e da vigilância, existe o gate pré-execução bloqueante (Claude, Codex), que também abre aprovação — ver [docs/04](../04-resiliencia-e-politica.md). A tabela de riscos acima é rascunho: a tabela vigente (risco × modo) está no README.
