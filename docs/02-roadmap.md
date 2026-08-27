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

## Fase 2 — Delegação plena, MCP e painel

### Concluído e validado em 2026-08-27

- [x] **MCP server do Hub** — 11 tools sobre o SDK oficial; validado com um agente
      externo simulado delegando ao Codex e recebendo o resultado
- [x] **Adoção de agente externo**: quando o principal roda fora do Hub, o MCP server
      adota uma sessão-raiz na primeira chamada que precise de identidade
- [x] `packages/client`: cliente HTTP compartilhado por CLI, MCP e Web UI
- [x] `hub mcp` / `show` / `install --write`: registro na config de cada agente,
      com backup e merge; imprime por padrão em vez de gravar
- [x] Mensagens de erro de delegação que dizem ao agente o que fazer
- [x] **Web UI React+Vite** servida pelo próprio daemon: grafo ao vivo como
      navegação, timeline unificada, painel de custo, controles ao vivo
- [x] `scripts/mcp-smoke.py`: harness JSON-RPC que mantém stdin aberto como um
      hospedeiro real faz

### O que o uso real revelou (e já foi corrigido)

| Achado | Correção |
|---|---|
| SSE com `event: <tipo>` fazia o `onmessage` do navegador descartar tudo que não se chamasse `message` — o painel perdia `turn.completed`, `delegation.*` e `error` sem nenhum sinal de erro | Campo `event:` removido; o tipo já viaja no JSON. `id:` só no stream de uma sessão, onde `seq` é inequívoco |
| Fechar stdin matava o MCP server antes de a resposta calculada ser escrita | Carência de 3s no desligamento por stdin; sinal explícito continua saindo na hora |

### Fila de aprovações e retenção — 2026-08-27

Fecha os dois desvios que a auditoria encontrou entre os ADRs e o código.

- [x] **Portão de delegação** (preventivo de verdade): a chamada agente→agente passa
      por dentro do Hub, então é retida ANTES de qualquer processo subir. Validado:
      sessão supervisionada delegando ao Codex ficou em `input_required`, foi liberada
      pela CLI e só então executou
- [x] **Vigilância reativa** sobre comando executado e arquivo alterado, com
      `pauseOn` / `flagOn` por nível de risco
- [x] Rotas `/approvals`, CLI `hub approvals` / `approve` / `deny`, e fila no topo do painel
- [x] **Retenção de worktree** (ADR 06.3): o checkout sobrevive ao fim da sessão e é
      recolhido pelo `WorktreeReaper` depois de 7 dias; `hub prune` força a passada
- [x] 10 testes novos cobrindo vigilância, herança e o portão de delegação

#### Correções que os testes reais expuseram

| Achado | Correção |
|---|---|
| A rota de delegação não devolvia a aprovação e reportava o estado do objeto em memória: quem chamou via "working" numa tarefa que nem começou — um agente ficaria em polling eterno | Estado relido do banco e `approval` propagado até o `hub_agent_call` do MCP, com instrução explícita de não ficar em polling |
| `seq` vivia só em memória: emitir evento numa sessão criada antes de um restart do daemon recomeçava do 1 e colidia com a chave única `(session_id, seq)`, derrubando cancelamento e negação | Semeadura preguiçosa a partir do banco na primeira vez que a sessão é vista |

### Restante da fase 2

- [ ] Pipeline de resiliência completo: retry com backoff → fallback por cadeia → portão de validação
- [ ] Gate PRÉ-execução por agente (hook `PreToolUse` do Claude Code, modos de aprovação do Codex) — hoje comando e arquivo só podem ser vigiados depois do fato
- [ ] Adapter HTTP do OpenCode sobre `opencode serve` (sessões, SSE e custo reais)
- [ ] Mappers dedicados: Cursor, Copilot, Antigravity, Kimi, MiMo
- [ ] Tabela de preços por modelo — Codex reporta tokens mas não USD, então o custo em dólar do fluxo sai incompleto
- [ ] TUI (a Web UI cobriu a necessidade; a TUI virou conveniência, não bloqueio)

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
| Acesso remoto | Expor o daemon na rede/túnel exige authn/authz — desejado? | Fase 3 |

Tudo que bloqueava a Fase 2 foi decidido no [ADR 06](decisoes/06-resiliencia-retencao.md):
falha final termina em `failed` sem travar o fluxo, fallback é `claude → codex → opencode`,
eventos ficam para sempre e worktrees por 7 dias, e o modelo é o default de cada CLI.
