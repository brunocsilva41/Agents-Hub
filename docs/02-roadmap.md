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

### Pipeline de resiliência — 2026-08-27

Fecha o ADR 04.3 e coloca em uso a cadeia de fallback do ADR 06.2, que até
então estava configurada sem consumidor.

- [x] `packages/core/src/resilience.ts`: classificação de desfecho e decisão
      retry / fallback / desistir, em forma **pura** — a lógica que mais precisa
      de teste é a que menos precisa de processo rodando
- [x] Retry com backoff exponencial no mesmo agente, retomando a sessão nativa
      quando o agente suporta (mais barato que reenviar o brief) e levando junto
      o motivo da falha anterior
- [x] Fallback pela cadeia `claude → codex → opencode`, filtrando quem não está
      instalado. O substituto entra como **irmão** no grafo, não como filho:
      ele não foi chamado pelo que falhou, está no lugar dele — e ver os dois
      lado a lado é o que torna a troca auditável
- [x] `failureContext`: o histórico de falhas vai anexado ao brief do substituto,
      senão ele recomeça cego e cai no mesmo buraco
- [x] **Portão de validação** por comando (build/testes/lint) rodado no worktree;
      reprovar volta ao retry com o detalhe do que falhou — a tentativa com mais
      chance de dar certo de todas
- [x] Desistência termina em `failed` com evento de prioridade alta (ADR 06.1),
      sem pendurar a task esperando alguém
- [x] 15 testes unitários + **teste de integração com agentes falsos**: scripts
      Node que falham sob comando, exercitando retry e fallback com custo zero

**Limite assumido:** os critérios de aceite em linguagem natural NÃO são
verificados por heurística de texto. Comparar critério com resumo por
similaridade produz veredito que parece rigoroso e não é. Quem faz isso de
verdade é o portão de revisão por segundo agente, que custa uma sessão de modelo
e por isso é opt-in; os critérios seguem no brief dessa revisão.

### Adapter HTTP do OpenCode — 2026-08-27

- [x] API real levantada contra o binário (1.17.15) lendo a OpenAPI que o próprio
      servidor publica em `/doc`; spec e resumo em [`docs/referencias/`](referencias/)
- [x] `OpenCodeAdapter`: sessão por `POST /api/session` com `location.directory`
      apontando para o worktree — um servidor só, N sessões isoladas
- [x] Tradutor de eventos SSE puro e testável sem servidor (19 testes)
- [x] **Custo por passo real**, que a CLI headless simplesmente não entrega
- [x] `interrupt` de verdade (`POST /interrupt`), sem a degradação para kill que o
      adapter de processo sofre no Windows
- [x] `send()` ao vivo com `delivery: steer` — a única integração do conjunto que
      injeta mensagem no turno em andamento
- [x] Ciclo de vida do servidor: sobe se não houver, reaproveita se houver, e só
      derruba o que ele mesmo subiu

#### O que o teste real expôs

| Achado | Correção |
|---|---|
| O poll de fim de turno começava junto com a run, antes do prompt ser enviado: três ausências em 3s e a run era encerrada **antes de o turno existir**, com zero token e ar de sucesso | Poll só começa depois do prompt aceito, e ausência só conta como fim depois de o turno ter sido visto ativo |
| Turno que falhava no provedor (401, modelo inválido) saía do adapter como `exit 0` — o pipeline não via falha, mandava para a validação e queimava tentativas culpando o motivo errado | O adapter registra o erro do turno e o reflete no desfecho da run |
| **Worktree isolado não tem `node_modules`**: `npm test` e `tsc` falhavam na primeira linha para todo agente, e o portão de validação reprovava por um motivo alheio ao trabalho | `WorktreeManager` liga `node_modules`/`.venv`/`vendor` por junction (Windows) ou symlink |
| A CLI devolvia o terminal no fim do TURNO, enquanto validação, retry e fallback ainda podiam mudar o resultado | Espera a tarefa chegar a estado terminal e relata o portão de validação |

### Verificação dos manifestos contra os binários reais — 2026-08-27

Os manifestos de cinco agentes tinham sido escritos por dedução. Verificados um a
um contra o binário instalado (`--help` é grátis; uma execução mínima por agente
onde o formato de saída precisava ser visto). **Todos os três verificados estavam
errados**, dois deles de forma que quebraria a invocação:

| Agente | O que o manifesto dizia | O que o binário faz |
|---|---|---|
| **Copilot** | prompt por arquivo (`{{promptFile}}`), saída texto | `-p` recebe o **texto**; `--output-format json` emite **JSONL**; `--resume=<id>` existe |
| **Kimi** | prompt por stdin, saída texto | `-p` recebe o **texto**; `--output-format stream-json`; `--session <id>` |
| **MiMo** | `-p` com prompt por stdin | **`-p` é `--password`** — o prompt teria virado senha. O certo é `run <texto> --format json` |

- [x] Mapper **verificado** do Copilot (JSONL com `ephemeral` marcando bastidor,
      `session.auto_mode_resolved` revelando o modelo escolhido — única base para
      estimar custo, já que o Copilot fatura em créditos e não reporta dólares)
- [x] Mapper **verificado** do Kimi (formato orientado a `role`; `session.resume_hint`
      é a única fonte do id nativo)
- [x] Descoberta: **MiMo é um fork do OpenCode** — o `mimo serve` publica uma OpenAPI
      cujo título é literalmente `opencode`. Mas expõe a **v1 legada** (rotas na raiz,
      sem `/api`), que é justamente a que o adapter HTTP não fala, então ele roda por
      CLI com o mapper genérico
- [x] 14 testes com amostras capturadas da execução real, não inventadas

### Restante da fase 2

- [ ] **Mappers dedicados para Cursor e Antigravity** — os dois binários não estão
      instalados nesta máquina, então os manifestos seguem deduzidos e os `caveats`
      dizem isso. Verificar quando forem instalados
- [ ] Mapper dedicado do MiMo, quando o vocabulário de eventos da v1 for confirmado
- [ ] Gate PRÉ-execução por agente (hook `PreToolUse` do Claude Code, modos de aprovação
      do Codex) — hoje comando e arquivo só podem ser vigiados **depois** do fato
- [ ] TUI (a Web UI cobriu a necessidade; virou conveniência, não bloqueio)

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
