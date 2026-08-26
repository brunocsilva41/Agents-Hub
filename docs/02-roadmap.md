# 02 — Roadmap de Implementação

Ordem derivada do ADR 04.4: **vertical fina primeiro**. Cada fase termina com algo que roda de verdade.

## Fase 1 — Vertical fina ✅ concluída e validada em 2026-08-26

Objetivo: uma sessão real com agentes de verdade, ponta a ponta, provando o contrato antes de multiplicar por oito.

- [x] Monorepo (npm workspaces + TS project references), tipos do domínio
- [x] `EventEnvelope` + vocabulário de eventos
- [x] `PolicyEngine`: níveis de risco, overlay de supervisão, não-escalação por interseção
- [x] `BudgetLedger`: orçamento da raiz consumido pelos descendentes
- [x] `CallGraph`: profundidade + detecção de ciclo semântico
- [x] `store`: SQLite via `node:sqlite`, migrações versionadas, repositórios
- [x] Contrato de adapter + registry dirigido por manifesto + cache de probe em disco
- [x] Adapter genérico de CLI (spawn, JSONL, timeout, heartbeat, kill de árvore no Windows)
- [x] Mappers dedicados: Claude Code e Codex
- [x] Manifestos dos 8 agentes
- [x] `WorktreeManager`: isolamento por git worktree, branch preservado ao encerrar
- [x] Daemon HTTP + SSE com replay de eventos
- [x] CLI: `daemon`, `doctor`, `agents`, `project`, `start`, `watch`, `send`, `delegate`, `graph`, `budget`, `cancel`
- [x] Testes do domínio (27, verdes)
- [x] **Teste de fumaça real**: sessão Claude → delegação para Codex, grafo e custo consolidados

### O que o teste real revelou (e já foi corrigido)

| Achado | Correção |
|---|---|
| `where <bin>` no Windows devolve primeiro o shim sem extensão; `spawn` dá ENOENT | O resolver agora prefere `.exe`, depois `.cmd`/`.bat` |
| CLIs travavam no `--version` com stdin aberto | Probe roda com `stdin: ignore` |
| `.exe` a frio no Windows leva até 20s (antivírus + descompressão); 6 em paralelo estouravam o timeout | Timeout de probe para 45s, concorrência limitada a 2, cache em disco |
| Reserva de orçamento sem dimensão explícita sequestrava todo o saldo, travando fan-out | Dimensão não pedida reserva zero; o teto continua garantido no consumo |
| `--detach "objetivo"` engolia o objetivo como valor da flag | Flags booleanas declaradas + suporte a `--chave=valor` |
| Filhos não indentavam sob o pai no grafo | Conector aplicado a todo descendente, não só a partir do nível 2 |

## Fase 2 — Delegação plena e o resto dos agentes

- [ ] **MCP server do Hub** (`hub_agent_call`, `hub_agent_status`, `hub_agent_stream`, `hub_agent_cancel`, `hub_session_send`) — o momento em que *qualquer* agente vira orquestrador
- [ ] Comando `hub install-mcp <agente>`: registra o Hub como MCP server na config de cada CLI
- [ ] Pipeline de resiliência completo: retry com backoff → fallback por cadeia → portão de validação
- [ ] Fila de aprovações com bloqueio real em `input_required` (hoje a política classifica, mas ainda não intercepta a ação)
- [ ] Adapter HTTP do OpenCode sobre `opencode serve` (sessões, SSE e custo reais)
- [ ] Mappers dedicados: Cursor, Copilot, Antigravity, Kimi, MiMo
- [ ] Tabela de preços por modelo — Codex reporta tokens mas não USD, então o custo em dólar do fluxo hoje sai incompleto
- [ ] TUI: grafo ao vivo, streams lado a lado, controles (pausar/interromper/injetar/matar)
- [ ] Web UI React+Vite servida pelo daemon

## Fase 3 — Plataforma

- [ ] **A2A server**: Agent Card assinado em `/.well-known/agent-card.json`, `tasks/get`, `tasks/cancel`, `tasks/resubscribe`
- [ ] Motor de workflows declarativos em YAML (fan-out paralelo, gates, condicionais)
- [ ] Handoff de sessão (A transfere o papel de principal para B em tempo de execução)
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
