# 13 — Orquestração de ponta a ponta com agentes falsos

Ambiente: daemon isolado (porta 48208, `AGENTS_HUB_HOME` temporário), 5 agentes falsos (`alfa`, `beta`, `gama`, `flaky`, `solo`) por manifesto YAML, mapper `claude` (JSONL com custo), diretivas no prompt (`@FAILALWAYS`, `@ONLY=`, `@SLEEP=`, `@COST=`, `@WRITE=`, `@TOOL=`, `@VERDICT=`). Windows 10, Node 24. Nada foi tocado em ~/.agents-hub nem na porta 4747.

Resumo por área (funciona de ponta a ponta?):

| Área | Estado |
|---|---|
| `hub workflow run` DAG, dependências, fan-in de resumo, falha no meio, `--budget-usd` | Funciona, com 3 defeitos ALTO |
| Retry / backoff / fallback / failureContext | Funciona no daemon; a CLI perde o rastro no fallback |
| Portão de validação por comando | Funciona (worktree e none) |
| Revisão por segundo agente | Funciona; aprovação não deixa rastro |
| Orçamento (estouro, aviso, reserva, herança) | Funciona; `seconds` não é aplicado durante a run; mensagem enganosa |
| Handoff | Quebrado (agentId nunca persiste) |
| pause / interrupt / cancel | cancel em cascata OK; pause/interrupt no Windows destroem a sessão; cancel vira `failed` |
| Aprovações (approve/deny) | Funciona; deny -> task `rejected` |
| Vigilância reativa | Funciona, mas é contornável por encadeamento e ignora `watch`/`retries`/`fallback` do projeto |
| Retenção de worktree / `hub prune` | Só recolhe worktree limpo; o que tem trabalho nunca expira |
| Project env/prompt/folders/context | env/prompt/context OK; folders aceita caminho inexistente; aviso falso de config inválida |
| SSE / replay | `/events?sessionId&since` OK; `/api/tasks/:id/events` não segue o fallback e nunca fecha |

---

### [ALTO] Workflow + fallback: passo reportado como falho ("a sessão não tem tarefa") embora o agente substituto conclua

**Evidência**
- `packages/daemon/src/session-manager.ts:1913-2007` (`#fallback`): a task é reatribuída (`tasks.update(task.id, { sessionId })`) a uma NOVA sessão. A sessão original passa a ter 0 tasks.
- `packages/cli/src/workflow-cmd.ts:173`: `aguardarPasso` consulta `client.tasks(sessionId)` da sessão ORIGINAL; `tasks[0]` vazio -> `state: 'failed', detail: 'a sessão não tem tarefa'`.
- Repro: `hub workflow run wf2.yaml` (passo `agent: flaky` com `@FAILALWAYS @ONLY=flaky`, cadeia `tarefa: [flaky, beta, gama]`):
  ```
  ▶ s1 em flaky ses_b33e...
  ✗ s1 failed — a sessão não tem tarefa · US$ 0.0000
  ⊘ s2 pulado — dependência não concluiu: s1 (failed)
  ```
  Em paralelo, `ses_a6a4202b... beta ✓ concluída` (o substituto terminou com sucesso). `GET /sessions/<orig>/tasks` -> `{"tasks":[]}`.

**Impacto** Fallback e workflow, as duas features de resiliência/orquestração, não funcionam juntas: o DAG aborta e pula tudo que depende do passo, o custo do substituto sai do relatório e a sessão do substituto fica órfã. Como o padrão do Hub é `retries.max=2` + cadeia de fallback, qualquer falha de agente num workflow real cai aqui.

**Correção sugerida** Resolver a task pelo `taskId` devolvido em `startSession` (já existe em `deps.start`), não por `tasks(sessionId)`: usar `GET /tasks/:id` (`server.ts:502`) no `aguardarPasso` e a `task.sessionId` atual para o custo (`gastoDa`).

**Esforço** P

---

### [ALTO] `hub start` / `hub watch <sessionId>` terminam em silêncio quando a tarefa sofre fallback

**Evidência**
- `packages/cli/src/main.ts:936`: `aguardarTaskTerminal` faz `if (!task) return true;` (mesma causa: a task saiu da sessão observada).
- Repro: `hub start --agent flaky ... "@FAILALWAYS @ONLY=flaky"` imprime só a 1ª tentativa e sai em 3 s com "… aguardando o portão de validação"; a task só termina alguns segundos depois, em `beta`, sem que o usuário veja nada. Idem com revisão/validação reprovada: `hub start` volta após a primeira falha.

**Impacto** O usuário conclui que a tarefa falhou enquanto o Hub continua gastando com outro agente.

**Correção sugerida** Em `aguardarTaskTerminal`, quando `tasks(sessionId)` vier vazio e a sessão estiver `failed`, seguir a sessão substituta (mesmo `rootId`), ou acompanhar por `taskId`.

**Esforço** M

---

### [ALTO] Retry de `CONCURRENCY_EXCEEDED` do workflow nunca dispara com a CLI (`instanceof HubError` contra `HubApiError`)

**Evidência**
- `packages/core/src/workflow.ts:353`: `isHubError(err) && err.code === 'CONCURRENCY_EXCEEDED'`; `packages/core/src/errors.ts:49`: `isHubError` é `err instanceof HubError`.
- A CLI só recebe `HubApiError` (`packages/client/src/index.ts:427`), nunca `HubError`, então a condição é sempre falsa.
- Repro (`wf3.yaml`, 3 passos paralelos no mesmo agente, `maxConcurrencyPerAgent=2`):
  ```
  ✗ ok2 failed — não foi possível iniciar: Limite de 2 sessões simultâneas para "solo" atingido
  ```
  (falha imediata; com o retry funcionando a mensagem seria "esgotou tentativas de concorrência".)

**Impacto** Todo fan-out com 3+ passos do mesmo agente falha no passo excedente e derruba o ramo; os testes unitários passam porque lançam `HubError`.

**Correção sugerida** Checagem estrutural: `(err as {code?: string}).code === 'CONCURRENCY_EXCEEDED'` (ou `isHubError` aceitar objeto com `code`). Teste que lança `HubApiError`.

**Esforço** P

---

### [ALTO] Workflow em worktree não entrega o CÓDIGO do passo anterior; só o resumo

**Evidência**
- `examples/multi-agent-pipeline.yaml`: `backend_refactor -> test_suite -> final_review`, todos `isolation: worktree`.
- Repro (`wf1.yaml`): passo `plan` escreveu `plan.txt`; o worktree do dependente `b` contém apenas `README.md`. Só o worktree de `plan` tem `plan.txt`. O branch `hub/<id>` fica em `init` (nada é commitado). O `upstream` no prompt de `b` é só o texto "RESULTADO_alfa_1 ok" (`upstreamDe` em `packages/core/src/workflow.ts` passa `summary` + `sessionRef`).

**Impacto** No pipeline-exemplo, o agente de testes escreve testes para uma refatoração que não existe no checkout dele e o revisor final revisa um worktree vazio. "Passos sequenciais" só fazem sentido com `isolation: none` (abre mão do isolamento) ou lendo o diff por `hub_context_fetch`.

**Correção sugerida** Ao concluir um passo, commitar o worktree em `hub/<sessionId>` e criar o worktree do dependente a partir desse commit (junção de N upstreams: merge com falha explícita). No mínimo, avisar no `workflow validate` quando há `dependsOn` + `worktree`.

**Esforço** G

---

### [ALTO] Handoff nunca persiste o novo agente (`agent_id` fora do UPDATE)

**Evidência**
- `packages/store/src/repositories.ts:181-183`: `UPDATE sessions SET native_session_id, state, mode, isolation, workdir, title, depth, path_json, updated_at, ended_at, pid` — sem `agent_id`.
- `packages/daemon/src/session-manager.ts:1183-` (`handoff`) chama `sessions.update(id, { agentId: resolvedTarget })`: no-op no banco.
- Repro: `hub start --agent alfa ... @SLEEP=8000`, `hub handoff <s> --to gama`: o processo de `gama` roda (evento `session.handoff`, log do agente), mas `GET /sessions/<s>` -> `agentId: alfa` durante e depois; `tasks[0].attempts` -> `[["alfa","success"]]`; `hub sessions`/`hub graph` mostram `alfa`. Repetido 3 vezes, determinístico.
- Efeito de corrida (2 de 3 vezes): o cancel do agente antigo passa por `#settle` e emite `error: tarefa encerrada sem sucesso — execução cancelada` (alta prioridade) + task `failed` no meio do handoff; o resumo injetado no prompt do novo agente traz "ERRO: tarefa encerrada sem sucesso".

**Impacto** Handoff funciona só na superfície: grafo, concorrência por agente, precificação, `send` posterior e reinício do daemon tratam a sessão como do agente antigo; o histórico de tentativas não registra o novo.

**Correção sugerida** Incluir `agent_id = ?` no `UPDATE`; em `handoff`, marcar o run antigo como substituído ANTES do cancel (o `pump` já ignora run substituído, `session-manager.ts:1658-1662`, mas o `#runs.delete` ocorre cedo demais) e registrar `novaTentativa` do novo agente.

**Esforço** P

---

### [ALTO] Vigilância/gate: comando encadeado passa como "allow list" (`echo x && git push --force`)

**Evidência**
- `packages/core/src/policy.ts` `classify` (case `command`): usa `cmd.startsWith(allowed)` e `IRREVERSIBLE_PATTERNS` ancorados em `^`.
- `POST /hooks/pretooluse` com `{"toolName":"Bash","toolInput":{"command":"echo x && git push --force"}}` -> `{"permission":"allow","decision":"allow","risk":"exec","reason":"comando na allow list (echo)"}`.
- Sessão semi com `@TOOL=echo_x_&&_git_push_--force` e outra com `node -e ...; rm -rf /`: ambas concluídas sem aprovação nem alerta. `git push --force` puro pausa com aprovação (irreversível).

**Impacto** O portão pré-execução e a vigilância reativa são contornáveis por qualquer agente (ou prompt injection) com `&&`, `;` ou `|` depois de um prefixo permitido (`echo`, `node`, `git status`, `ls`, `cat`...).

**Correção sugerida** Tokenizar por operadores de shell (`&&`, `||`, `;`, `|`, `&`, `$(...)`, crases, quebras de linha, redirecionamentos), classificar cada segmento e ficar com o pior risco; o que não for analisável -> `escalate`.

**Esforço** M

---

### [ALTO] `hub prune` nunca recolhe worktrees que tiveram trabalho; o branch `hub/<id>` não guarda o trabalho

**Evidência**
- `packages/daemon/src/worktree.ts:186-207`: `release` roda `git worktree remove` sem `--force`; `reaper.ts` só chama sem force.
- Repro (retention `worktreeDays: 0.00003`): 24 sessões examinadas; os 9 worktrees em que o agente escreveu arquivos falham sempre: `fatal: '...ses_a336...' contains modified or untracked files, use --force to delete it` (repete em cada `hub prune` e em cada subida do daemon, `[reaper] falha ao remover worktree` no log). Os limpos foram removidos.
- `git log hub/ses_a336...` -> só `init`; nada commita o trabalho do agente no branch. O texto de `prune` ("os branches hub/<sessionId> continuam intactos") e o comentário de `release` ("o trabalho do agente continua acessível por git log hub/<sessionId>") são falsos: o branch aponta para o commit-base. O único registro é `artifacts/<ses>/changes.patch`.

**Impacto** (1) `hub prune`/retenção não libera disco justamente das sessões úteis, e todo sweep gera erro. (2) Quem "consertar" com `--force` confiando na promessa do branch perde o trabalho.

**Correção sugerida** Ao encerrar a sessão (ou antes do `release`), `git add -A && git commit` no worktree (branch `hub/<id>`) e só então `worktree remove` (limpo, sem `--force`). Enquanto isso, corrigir a mensagem. Observação: no Windows a 1ª passada reportou 13 "falharam" com `Directory not empty`/`Permission denied` transitórios que sumiram na 2ª; vale 1 retry curto no `release`.

**Esforço** M

---

### [MÉDIO] pause e interrupt no Windows destroem a sessão (estado final `failed`); pause não desce para os filhos

**Evidência**
- `packages/adapters/src/process-adapter.ts:146-155`: no win32 `interrupt` = `cancel`. `session-manager.ts:1168-1175` (`pause`): `interrupt()` + `sessions.update({state:'paused'})`; o `#settle` da run cancelada roda depois e sobrescreve.
- Repro: `hub pause <pai>` -> "sessão pausada"; 2 s depois `state: failed`, task `failed`, eventos `error: canceled` + "tarefa encerrada sem sucesso". `hub interrupt <filho>` -> "turno interrompido", sessão `failed`. Retomar não é possível (pause de sessão terminal é recusado).
- Os 2 filhos e 1 neto do pai "pausado" continuaram `rodando` (pause não é recursivo, ao contrário de `cancel`).

**Impacto** "Pausar sem encerrar" e "parar o turno" só valem em POSIX; no Windows o usuário perde a sessão sem aviso, e filhos seguem gastando o orçamento do fluxo.

**Correção sugerida** Recusar `pause`/`interrupt` com mensagem clara onde não há SIGINT, ou fazer o `#settle` tratar `outcome.reason==='canceled'` de sessão `paused` como pausa (sem `failed`, sem evento de erro) e permitir `send` para retomar. Definir se pause cascateia.

**Esforço** M

---

### [MÉDIO] cancel deixa sessão e task `failed` (nunca `canceled`), com evento de erro de alta prioridade

**Evidência**
- `grep "'canceled'" packages/daemon/src` -> nenhum uso; `TaskState 'canceled'` (`core/domain.ts:13`) nunca é gravado.
- Repro: `hub cancel <s>` numa sessão simples -> "sessão encerrada"; nos 3 s seguintes `GET /sessions/<s>` -> `failed`; task `failed`; eventos `session.ended {state:killed}` seguido de `error: tarefa encerrada sem sucesso — execução cancelada` (priority high). `POST /api/tasks/:id/cancel` responde `sessionState:"killed"` e 1 s depois `failed`. Corrida entre `cancel()` e o `#settle` (na subárvore com filhos o resultado foi `killed`: não determinístico).

**Impacto** A API A2A promete `canceled`; a auditoria trata cancelamento do usuário como falha; workflow/MCP/painel não distinguem "cancelei" de "quebrou".

**Correção sugerida** Marcar a run como cancelada pelo usuário antes de matar (flag no `LiveRun`) e gravar task `canceled`/sessão `killed` no `#settle` sem passar pelo pipeline de falha.

**Esforço** M

---

### [MÉDIO] Config de projeto sem bloco `policy:` gera aviso falso de "configuração inválida" em toda sessão

**Evidência**
- `packages/daemon/src/project-config.ts:129`: `const candidato = parsed['policy'] ?? parsed;` com schema `.strict()`. Um `config.yaml` gravado por `hub project prompt --set` / `hub project env --set` tem só `prompts:`/`env:` no topo.
- Repro: `hub project add p2; hub project prompt p2 --agent alfa --set "Seja breve."; hub project env p2 --agent alfa --set OPENAI_BASE_URL=...` e iniciar sessão: evento #1: `configuração do projeto (.agents-hub/config.yaml) inválida — usando política global sem os ajustes do projeto: ... Unrecognized key(s) in object: 'memory', 'prompts'`. O prompt e o env foram aplicados normalmente.
- Variante grave: `validation:` na raiz (forma que o `?? parsed` sugere aceitar) junto de `memory:` descarta a política inteira.

**Impacto** Todo projeto configurado pela CLI/UI mostra um alarme falso, o que ensina a ignorar o aviso que existe para o caso real.

**Correção sugerida** Remover `memory/prompts/env` antes de validar como política (ou exigir `policy:` e não aceitar a forma plana).

**Esforço** P

---

### [MÉDIO] Overrides de projeto para `retries`, `fallback`, `watch` e `maxConcurrency` são ignorados pelo pipeline

**Evidência**
- `ProjectPolicyOverrides` (`project-config.ts`, ~40-55) declara `retries`, `fallback`, `watch`, `maxConcurrency`, `defaultBudget`, e `projectPolicyFor` os funde. Mas o `SessionManager` lê a política GLOBAL: `session-manager.ts:1798-1799` (`this.config.policy.retries`), `:2012` e `:316` (`fallback`), `:2060` (`watchForMode(this.config.policy.watch, ...)`), `:2539-2553` (`maxConcurrency*`), `:354-356` (`defaultBudget`).
- Repro 1: projeto com `retries: {max: 1}` (e depois `max: 0`): o agente rodou 3 vezes (global `max: 2`). Repro 2: `watch: {pauseOn: [escalate]}` no projeto, sessão semi com `curl http://x.example`: só um aviso (`flagOn`), sem pausa nem aprovação.

**Impacto** Regras documentadas em `docs/04` ("o projeto só pode apertar") não apertam nada nesses campos; só `validation`, `commands` e `risk` (via `policyFor`) valem. Projeto sensível que pede `watch.pauseOn: [escalate]` acredita estar protegido.

**Correção sugerida** Usar `this.policyFor(session).policy.*` em todos esses pontos, com teste de integração por campo.

**Esforço** M

---

### [MÉDIO] `--mode autonomous` da CLI é silenciosamente limitado ao padrão do manifesto

**Evidência**
- `session-manager.ts:342-343`: a raiz usa `inheritMode(manifest.defaults.supervision, brief.supervision)` = o mais restritivo dos dois.
- Manifestos reais: `claude/codex/cursor/openclaude/opencode: semi`; `antigravity/copilot/kimi/mimo: supervised`.
- Repro: `hub start --agent alfa --mode autonomous` -> `session.mode: semi` com `brief.supervision: autonomous` (divergentes no JSON). Sem aviso.

**Impacto** `autonomous` (e `semi` para 4 agentes) é inalcançável pela CLI/workflow, embora o help prometa `--mode <supervised|semi|autonomous>`. O usuário acha que o agente roda sem pausas e ele pausa em `escalate`.

**Correção sugerida** Para a RAIZ, o pedido explícito do usuário deve valer (o manifesto é o padrão); "nunca escala" é regra pai->filho. Senão, imprimir o modo efetivo em `hub start` e avisar quando for reduzido.

**Esforço** P

---

### [MÉDIO] `/api/tasks/:id/events` não acompanha o fallback e nunca fecha; `Last-Event-ID` ignorado

**Evidência**
- `server.ts:312-345`: assina `{ sessionId: task.sessionId }` no momento da conexão; após o fallback a task muda de sessão.
- Repro: `POST /api/tasks` cujo 1º agente falha; `curl -N /api/tasks/<id>/events` por 12 s -> 22 eventos, todos da sessão original, o último "passando a tarefa para beta"; nada da sessão do `beta` nem do fim da task. Com a task `completed`, nova conexão fica aberta até o timeout do curl.
- `Last-Event-ID: 20` no header reenviou os 22 eventos (só `?since=` é lido, e só em `/events`).

**Impacto** Cliente de automação da API de tasks nunca vê a conclusão em caso de fallback e precisa fazer polling; reconexão de `EventSource` duplica eventos.

**Correção sugerida** Assinar por `rootId` filtrando `taskId`, fechar o stream no estado terminal da task, honrar `Last-Event-ID`.

**Esforço** M

---

### [MÉDIO] Aprovar estouro de orçamento numa sessão cujo turno JÁ terminou relança o agente

**Evidência** `--budget-usd 0.5`, `@COST=0.9`: o turno termina (exit 0), vira `budget.exceeded` + aprovação; `hub approve` -> "orçamento ampliado: agora US$ 1.00" e a sessão é relançada ("Continue de onde parou"), refaz o trabalho e estoura de novo (custo 1.8 de 1.0, nova aprovação).

**Impacto** Cada aprovação custa um turno extra que ninguém pediu.

**Correção sugerida** Se a run já saiu com sucesso, aprovar deve apenas finalizar (validação + `completed`); relançar só quando o Hub matou o processo.

**Esforço** M

---

### [MÉDIO] Orçamento em `seconds` não é aplicado durante a run; a mensagem de estouro cita só USD

**Evidência**
- `session-manager.ts:1606-1613`: `ledger.charge` na run usa `seconds: 0`; segundos só entram em `settle`.
- Repro: `POST /api/tasks {"budget":{"seconds":3}}` com agente de 9 s: task `completed`, `hub budget` -> `tempo: 9s / 3s`, 300%, "orçamento esgotado" — sem parada nem aprovação.
- Repro tokens: `budget.tokens=20` para no meio da run (correto), mas a aprovação diz `orçamento do fluxo esgotado (US$ 0.0000 de 5.00)` (`session-manager.ts:1631`) — a dimensão estourada era tokens (30/20).

**Impacto** Teto de tempo por fluxo é decorativo; a mensagem de motivo é enganosa.

**Correção sugerida** Timer que debita segundos e dispara o caminho de estouro; mensagem indicar a dimensão (o `snapshot` já traz `remaining` por dimensão).

**Esforço** P

---

### [MÉDIO] Workflow bloqueado por aprovação não tem retomada

**Evidência** `wf4.yaml --budget-usd 1`: o passo `b` bloqueia (`⏸ b blocked ... hub approve apv_...`), o `run` termina com exit 1 e "Sessões ainda vivas no daemon". Aprovar depois não reabre o DAG: `c` nunca roda; reexecutar refaz `a` (custo 0.70 de novo).

**Impacto** Aprovação humana e workflow não compõem; o custo do trabalho feito é jogado fora.

**Correção sugerida** `hub workflow run --resume <runId>` com estado persistido (ou o run seguir esperando a aprovação com timeout configurável).

**Esforço** G

---

### [BAIXO] Aprovação da revisão por segundo agente não deixa registro

**Evidência** `session-manager.ts:1742-1760`: só a reprovação vira evento/`validation`. Com `review.enabled: true`, revisor `gama`, veredito APROVADO: `task.result.validation` = `undefined`, nenhum evento de revisão; só o custo (60 tokens vs 30) denuncia que o revisor rodou; a CLI nada mostra. Reprovação, retry e fallback por revisão funcionam (testado com `@VERDICT=REPROVADO`).

**Correção sugerida** Mesclar os `checks` da revisão em `validation` também quando aprovada e emitir um `log` "revisão (gama): APROVADO ...".

**Esforço** P

---

### [BAIXO] `POST /projects` e `POST /projects/:id/folders` aceitam caminho inexistente ou arquivo; caminhos 8.3 duplicam o projeto

**Evidência**
- `POST /projects {"path":".../naoexiste2"}` e `{"path":".../fake.cjs"}` -> 200 com projeto criado; `POST /projects/:id/folders` com pasta inexistente -> 200.
- O mesmo diretório por `C:\Users\BRUNOS~1\...` e `C:\Users\Bruno Silva\...` gerou dois projetos (`prj_c918...` e `prj_56f5...`); maiúsculas/minúsculas e barra final são normalizadas (409 / mesmo projeto). `%TEMP%` no Windows costuma vir em 8.3.

**Correção sugerida** `fs.realpathSync.native` + `statSync().isDirectory()` na borda.

**Esforço** P

---

### [BAIXO] Códigos de erro imprecisos em aprovações; comentário desatualizado em budget.ts

**Evidência** `hub approve apv_naoexiste` -> `[ILLEGAL_STATE] Aprovação ... não encontrada` (deveria ser NOT_FOUND/404); `hub approve xyz` -> `[INVALID_BRIEF] parâmetro "id" inválido` (código de brief para parâmetro de rota). O comentário de `BudgetLedger.reserve` (`packages/core/src/budget.ts`) diz que a reserva excedida "nasce em input_required", mas a delegação é recusada com `BUDGET_EXCEEDED` e nenhuma aprovação (comportamento sensato; só o comentário está desatualizado).

**Esforço** P

---

## Verificado OK

- `hub workflow validate|run` com o exemplo do repo (agentes trocados por falsos): 4 lotes; o resumo de cada passo chega ao dependente no prompt (`## O que os passos anteriores entregaram`); `b`/`c` rodam em paralelo e a junção espera os dois; passo com falha faz dependentes `skipped` (transitivo) e ramos independentes seguem.
- `--budget-usd` do workflow reparte o saldo por lote (teto US$ 1.00 -> 0.30 no 2º passo) e o excesso vira aprovação de orçamento (`blocked`).
- Retry com backoff (300/600 ms), esgotamento por agente, fallback pela cadeia `flaky -> beta -> gama` e `failureContext` ("Tentativas anteriores desta tarefa") no prompt do substituto; substituto entra como irmão no grafo; `hub graph`/`hub budget` somam os dois.
- Validação por comando (`node check.js`): reprova com detalhe (`saiu com código 3: falta ok.flag`), devolve ao retry com "Corrija exatamente isso", aprova quando o arquivo existe; roda no worktree.
- Revisão por segundo agente (opt-in): revisor diferente do autor, prompt com diff, `REPROVADO` aciona retry/fallback.
- Orçamento: aviso a 80% (`budget.warning`), estouro por USD e por tokens (mid-run) com aprovação, reserva de fatia na delegação (0.6 de 1.0; o segundo filho é recusado com `BUDGET_EXCEEDED`), liberação/`settle` da reserva ao fim do filho, custo do filho debitado do fluxo.
- Cancel em cascata (filho e neto encerrados com "pai ... cancelado"); aprovação pendente é negada automaticamente ao cancelar a sessão.
- Aprovações: vigilância pausa em `irreversible` (`git push --force`, `rm -rf`), `approve` retoma com resumo do que ocorreu, `deny` encerra e a task vira `rejected`; supervised pausa em `escalate` (`curl`); segunda aprovação do mesmo id recusada.
- Project env/prompt/context: a allowlist recusa `MY_VAR` e `NODE_OPTIONS` e aceita `OPENAI_BASE_URL`; instrução e memória entram no prompt do agente certo; pasta duplicada dá 409.
- SSE: `/events?sessionId=X&since=N` reenvia só `seq > N` com `id:`; `since=abc` -> 400; replay por sessão sem lacuna.
- Restart do daemon com sessão viva: sessão `killed` com motivo "daemon encerrando"; sem exceções não tratadas em `daemon.log`.
- Reaper: respeita a janela de retenção ("ainda no prazo"), remove worktrees limpos, nunca apaga branch.
