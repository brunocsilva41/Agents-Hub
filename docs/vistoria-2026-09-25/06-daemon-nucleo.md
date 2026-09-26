# 06 - Daemon: nucleo (session-manager, reaper, worktree, gate, reconcile)

Metodo: daemon isolado (porta 48203, home temporario, git 2.53.0.windows.1, Node 24.14, Windows 10) com agentes FALSOS (`node agent.cjs`, modos: sleep, ignore, big, giantline, outside, rate, detached...). Projeto git de teste com `node_modules` real. Nada do daemon do usuario (4747) foi tocado. Tudo abaixo foi reproduzido, salvo quando marcado "leitura".

Resumo: 1 CRITICO, 6 ALTO, 4 MEDIO, 4 BAIXO.

---

### [CRITICO] Reaper apaga o `node_modules` REAL do projeto (git worktree remove atravessa o junction)

**Evidencia**
- `packages/daemon/src/worktree.ts:156-179` liga `node_modules`/`.venv`/`vendor` do projeto dentro do worktree por junction (Windows). `worktree.ts:186-207` (`release`) e `reaper.ts:78` chamam `git worktree remove <dir>` sem antes desfazer os junctions.
- Reproducao pelo Hub: projeto com `node_modules/dep.txt` e `node_modules/sub/z.js`; sessao `fa` (isolation worktree) concluida; `retention.worktreeDays=0`; `POST /maintenance/sweep` -> `removed` contem o worktree. Depois: `ls -R proj/node_modules` -> vazio (dep.txt e sub/ sumiram). Reproduzido 2 vezes (a primeira, sem eu perceber, no sweep de largada do daemon).
- Reproducao SEM o Hub (git puro): `git worktree add ../iso-wt`, junction `iso-wt/node_modules -> iso/node_modules` (`fs.symlinkSync(..., 'junction')`), `git worktree remove ../iso-wt` (exit 0) -> `iso/node_modules` ficou vazio. Ou seja, o Git for Windows segue o junction ao apagar.
- Com a retencao padrao (7 dias) isso acontece em producao para qualquer sessao com worktree, num projeto com `node_modules`, na primeira varredura depois de 7 dias.

**Impacto**: perda de dados no repositorio principal do usuario (dependencias, `.venv`, `vendor`) e quebra de builds do projeto, sem aviso. Nao e "so" reinstalar: `.venv`/`vendor` podem conter pacotes locais/patches.

**Correcao sugerida**: antes de qualquer `git worktree remove` (release e tambem `--force`), remover cada link de `DEPENDENCIAS_LIGADAS` no worktree SEM seguir o link: `fs.rmdir(destino)` / `fs.unlink` apos `lstat().isSymbolicLink()` (em junction do Windows `fs.rmdirSync(link)` remove so o link). So entao chamar o git. Adicionar teste de regressao (cria junction, chama `release`, afirma que o alvo continua intacto) e, como defesa em profundidade, recusar remocao se o `lstat` de qualquer entrada de primeiro nivel for reparse point.

**Esforco**: P

---

### [ALTO] Cancelar sessao viva termina em `failed` (ou `killed`, aleatorio) e a task em `failed`, nunca `canceled`

**Evidencia**
- `session-manager.ts:1133-1166` (`cancel`): mata a run, emite `session.ended{state:killed}` e chama `#finish(...,'killed')`, mas NAO remove a run de `#runs` e nao trata a task. O `#pump` (1656-1691) continua depois de `await handle.done`, ve `outcome.reason==='canceled'`, `#settle` (1708) -> `nextStep` = give_up -> `tasks.update(failed)` -> `#concludeSession(session,'failed')` (1830), sobrescrevendo o estado terminal.
- Teste: 8 sessoes `sleep:20000`, `POST /sessions/:id/cancel` no meio de cada. Resultado: `killed` em 2/8, `failed` em 6/8 (corrida entre `cancel` e o pump). Sempre task `failed`. Eventos da sessao `failed`: `session.ended(killed), error, error("tarefa encerrada sem sucesso - execucao cancelada", priority:high)`.
- O estado `canceled` de TaskState existe (`core/domain.ts:16-19`) e nunca e usado.
- Consequencias: pai recebe `delegation.completed state=failed` para filho cancelado pelo usuario (`#concludeSession` 2026-2041); `daemon encerrando` (`shutdown`, 1448) deixa 4 de 5 sessoes `failed` (verificado); cancel em cascata do pai deixou o neto `failed` (`killed,killed,failed,failed,killed`).
- Eventos emitidos depois de `#finish` perdem o roteamento por `rootId` (`bus.forgetSession`, `session-manager.ts:2240`), entao `watch --root` nao ve o `error` final.

**Impacto**: auditoria mente (cancelado aparece como falha, com alerta de alta prioridade); consumidores da API de tasks e do MCP veem `failed` e podem tentar de novo; a corrida e nao-deterministica.

**Correcao sugerida**: (1) em `cancel`, marcar a intencao antes de matar (`#cancelling` Set) e no `#pump`/`#settle` tratar `canceled` chamando `tasks.update(canceled)` + `#finish('killed')` uma unica vez (e emitir `session.ended` so la); (2) `#finish` deve recusar sobrescrever estado ja terminal (guard `isTerminalSessionState(session.state)` no topo); (3) `cancel` deve deletar a run de `#runs` ou o pump deve conferir `session.state` terminal antes de `#settle`.

**Esforco**: M

---

### [ALTO] Cancelar durante validacao/revisao ou durante backoff de retry: estado terminal ressuscita ou task fica presa em `working`

**Evidencia**
- `session-manager.ts:1664` (`#runs.delete` ANTES de `#settle`): durante `runValidation`/`#revisar` (1730-1755) a sessao nao esta em `#runs`. Teste com `policy.validation.command = node -e setTimeout(...,8000)`: durante a validacao `GET /health` -> `liveSessions:0`; `POST /sessions/:id/cancel` -> 200 e sessao `killed`; 9 s depois: sessao `completed`, task `completed` (eventos `message,turn.completed,session.ended`). O usuario cancelou e o resultado foi entregue como sucesso; o comando de validacao seguiu rodando.
- Retry: `retries.backoffMs=6000`, agente `rate` (429). Cancel durante o backoff -> sessao `killed`, mas `task.state` fica `working` para sempre (`cancel` nunca atualiza tasks; `#retry` 1854 so retorna). So a reconciliacao do proximo restart corrige.
- Consequencia adicional: como a sessao sai de `#runs` durante validacao, o teto de concorrencia (`#assertConcurrency`, 2537) nao conta esses processos: N sessoes terminando ao mesmo tempo rodam N `npm test` em paralelo, sem limite.
- Shutdown durante validacao: `POST /shutdown` com validacao em curso deixou o `node` da validacao ORFAO vivo depois que o daemon saiu (`shutdown()` so cancela `#runs`; `runValidation`/`#executarRevisao` nao registram o processo em lugar nenhum). O revisor (`adapter.start` em `#executarRevisao`, 2456) tem o mesmo problema.

**Impacto**: cancelamento nao e confiavel; task presa em `working` engana quem faz polling em `/api/tasks/:id`; processos de validacao/revisao vazam no desligamento.

**Correcao sugerida**: manter a run em `#runs` (ou uma `#settling` Map com AbortController) ate o fim de `#settle`; `cancel`/`shutdown` abortam validacao/revisao (killProcessTree) e `cancel` sempre fecha a task (`canceled`) na mesma transacao; `#finish` com guard de estado terminal (ver achado anterior).

**Esforco**: M

---

### [ALTO] `interrupt` e `pause` no Windows encerram a sessao como `failed` (nao ha pausa nem retomada)

**Evidencia**
- `process-adapter.ts` `interrupt` no win32 degrada para `cancel`; `session-manager.ts:1168-1175` (`pause`) faz `interrupt` e depois `sessions.update(paused)`; o pump (mesmo caminho do achado de cancel) sobrescreve com `failed`.
- Teste (agentes `fa` e `fb`): `POST /interrupt` -> `{"ok":true,"interrupted":true}`, 1,2 s depois sessao `failed`. `POST /pause` -> 200; `GET /sessions/:id` -> `failed`, task `failed`; `POST /send` -> 400 `ILLEGAL_STATE ... ja terminou (failed)`.
- Nao e o caveat documentado no manifesto ("interrupt degrada para cancelamento"): la se diz que cancela o turno; na pratica mata a sessao de forma irrecuperavel, e a API responde `interrupted:true` sem avisar.

**Impacto**: os botoes Pausar/Interromper da UI/CLI destroem a sessao na plataforma suportada; com `strategy: native` (Claude/Codex) daria para retomar por `resume` e o Hub descarta isso.

**Correcao sugerida**: quando `interrupt` degradar para cancel, marcar a run como `interrupted` (nao `canceled`), fazer o pump tratar desfecho `interrupted` como "turno terminou, sessao `idle`/`paused`" (sem `#settle` de falha) e permitir `send`/resume nesse estado; ou recusar `pause`/`interrupt` com erro explicito 501 no Windows.

**Esforco**: M

---

### [ALTO] Falha ao subir o agente deixa sessao fantasma `running`, worktree vazado e reserva de orcamento presa

**Evidencia**
- `session-manager.ts:1480-1531` (`#launch`): grava `state:'running'` e so depois `await adapter.start(...)`. Se lanca (`AGENT_NOT_INSTALLED`, spawn error, gate do codex), nada desfaz: `start()` (292-507) so libera a vaga de concorrencia. Ja existem no banco sessao `running`, task `working`, worktree e (em delegacao) `ledger.reserve`.
- Teste: agente `fx` com `bin` inexistente. `POST /sessions` -> 424 `AGENT_NOT_INSTALLED`, mas `GET /sessions` mostra a sessao `running`, pid null, task `working`, com worktree em disco (o reaper so coleta sessoes com `endedAt`, entao nunca).
- Delegacao: pai com `budget.usd=10`; 3 delegacoes para `fx` (todas 424) -> `/budget/:root` mostra `reserved.usd = 6`, `remaining.usd = 4`; uma delegacao legitima de 5 USD passa a falhar com `BUDGET_EXCEEDED`. Mesmo vazamento com delegacao para projeto nao-git (400 `ILLEGAL_STATE` do `worktrees.create`): `ledger.reserve` (`session-manager.ts:359-365`) so e liberado no caso `deny` (461), nunca nos `throw`.
- Filhos fantasmas contam no grafo (`fx:running` x3) ate o pai ser cancelado ou o daemon reiniciar.

**Impacto**: sessoes `running` eternas, orcamento do fluxo consumido por delegacoes que nunca rodaram, disco vazado; UI mostra atividade que nao existe.

**Correcao sugerida**: em `start()`/`#launch`, envolver em try/catch: no erro `store.sessions.update(failed, endedAt)`, `tasks.update(failed)`, `ledger.release(taskId)`, `#emit(error)` e `worktrees.release` (o worktree ainda esta limpo); ou gravar `running` somente depois de `adapter.start` devolver o handle.

**Esforco**: M

---

### [ALTO] Timeout do gate pre-execucao MATA a sessao inteira e a explicacao correta nunca chega ao agente

**Evidencia**
- `session-manager.ts:829-836`: no timeout, `#aguardarDecisao` chama `resolveApproval(id,'denied','tempo esgotado')`; `resolveApproval` (932-936) para QUALQUER `denied` faz `tasks.update(rejected)` + `cancel(session)`.
- O texto do proprio codigo (796-801) promete "Siga com o resto da tarefa... nao por proibicao", mas a sessao e encerrada. Teste: sessao `supervised`, `POST /hooks/pretooluse` com `git push --force`; apos 60,4 s: `permission:"deny"`, sessao `killed`, task `rejected`, eventos `approval.resolved(denied,"tempo esgotado")` + `session.ended(killed)`.
- `server.ts:650` monta `explanation` com `explainToAgent(verdict, mode)` e IGNORA `verdict.explanation` do gate. Resposta observada ao agente: "A politica do projeto proibe esta acao. Nao tente contornar" (mensagem de deny por politica) em vez da mensagem de "ninguem respondeu".
- Mesma raiz para negativa humana explicita no gate: o agente e instruido a "explicar ao usuario", mas a run e morta na sequencia.

**Impacto**: um hook lento/usuario ausente derruba todo o trabalho da sessao; agente recebe o motivo errado e pode tentar contornar.

**Correcao sugerida**: separar "negar a chamada" de "cancelar a sessao": para aprovacoes `detail.kind === 'tool-call'` (gate) `denied` deve so registrar a decisao e devolver a sessao a `running`/`input_required` sem `cancel`; usar `verdict.explanation ?? explainToAgent(...)` em `server.ts:650`.

**Esforco**: P

---

### [ALTO] `send` em sessao `waiting_approval` relanca o agente por cima da aprovacao pendente

**Evidencia**
- `session-manager.ts:1062-1110`: `send` so recusa estados terminais e run viva; nao recusa `waiting_approval`.
- Teste: sessao supervised com aprovacao de gate pendente, run ja terminada. `POST /sessions/:id/send` -> 200 `{"mode":"replay"}`; depois: sessao `running` (pid novo), task `input_required`, aprovacao ainda `pending`. Combinacao ilegal (sessao viva + task esperando humano + pendencia aberta).
- O mesmo vale para aprovacao de orcamento (`kind:'budget'`): `send` religa o agente sem aprovar, contornando a parada de custo (leitura; nao reproduzido por falta de agente com custo no mapper generico).

**Impacto**: a retencao por decisao humana e contornavel por uma mensagem; estados inconsistentes para UI e reconciliacao.

**Correcao sugerida**: `#exigirNaoTerminal` + recusar `waiting_approval` em `send`/`handoff` com `ILLEGAL_STATE` ("resolva a aprovacao apv_... primeiro").

**Esforco**: P

---

### [MEDIO] Rajada de saida bloqueia o daemon inteiro (event loop) e nao ha teto de eventos/bytes por sessao

**Evidencia**
- Agente `big:20000` (20000 linhas x 1 KB, 20 MB): durou 19,4 s; durante ele `GET /health` chegou a **17.411 ms** de latencia e uma conexao levou `ECONNRESET`. Causa: uma escrita SQLite sincrona por evento no `#pump` (`#persistMapped` 2152) no mesmo loop do HTTP, dos timers de heartbeat e do cancel das outras sessoes.
- Agente `giantline:60` (uma unica linha de 60 MB): `createInterface` sem limite de linha (`process-adapter.ts:417`); RSS do daemon 92 MB -> 494 MB; `hub.db` cresceu 171 MB -> 298 MB (payload + raw duplicados); `GET /sessions/:id/events` devolveu **125.829.689 bytes** numa resposta unica (1,9 s). A compactacao (`event-retention.ts`) so zera `raw_json`, o `payload_json` gigante fica para sempre.

**Impacto**: um agente ruidoso congela a API e as demais sessoes (heartbeats falsos, cancel lento); um unico evento pode estourar memoria de daemon e de cliente (UI/SSE).

**Correcao sugerida**: truncar linha/payload (ex.: 64 KB, marcando `truncated:true`) no mapper/`#persistMapped`; agrupar inserts em lote (transacao a cada N eventos ou 50 ms) e ceder o loop (`setImmediate`) entre lotes; limite de `limit` em `GET /events` por bytes; teto de eventos por sessao com aviso.

**Esforco**: M

---

### [MEDIO] Reaper: worktrees "sujos" e meio-apagados nunca sao recolhidos; varreduras sem trava de reentrada

**Evidencia**
- `release` (`worktree.ts:186`) usa `git worktree remove` sem `--force`: qualquer worktree com arquivo novo nao rastreado falha para sempre ("contains modified or untracked files, use --force"). Como o caso comum de um agente e justamente criar arquivos, o grosso dos worktrees nunca e coletado (no teste: os que tinham `inside.txt`). Cada varredura reloga o erro (`reaper.ts:90`).
- Sem `--force` seguro (ver CRITICO, o `--force` hoje agravaria a perda de dados) e sem fallback `fs.rm`, restam diretorios meio apagados: log do daemon mostra `failed to delete '.git/worktrees/ses_...': Directory not empty`, `... is not a working tree` e `not a git repository ... /.git`; a partir dai cada sweep falha para sempre no mesmo diretorio (`existsSync` verdadeiro, git nao o reconhece).
- `sweep()` (reaper.ts:58) nao tem mutex: `start()` dispara `void this.sweep()`, ha o `setInterval` e `POST /maintenance/sweep`; sobreposicoes disputam os mesmos diretorios (compativel com os erros "Directory not empty"; a sobreposicao em si nao isolei como causa unica).

**Impacto**: vazamento de disco continuo e ruido de log; quando o CRITICO for corrigido, este passa a ser o proximo bloqueio.

**Correcao sugerida**: apos remover os links de dependencia, `git worktree remove --force` (o branch `hub/<id>` ja preserva o trabalho; capture o diff antes, o que `capturarMudancas` ja faz); se o git recusar com "not a working tree", `fs.rm(dir,{recursive:true})` + `git worktree prune`; serializar `sweep()` com uma promise em andamento.

**Esforco**: M

---

### [MEDIO] Reconciliacao no restart fecha sessoes sem evento, sem fechar a tentativa e sem avisar quem escuta

**Evidencia**
- `session-manager.ts:544-587`: sessao `running` orfa vira `killed` e task `failed`, mas nenhum `session.ended`/`error` e emitido e `attempts[0].endedAt` continua `null`. Verificado apos matar o daemon com 6 sessoes vivas: `GET /sessions/:id/events` so tem o evento 1 (`message`); `task.attempts = [{"n":1,...,"endedAt":null,"outcome":null}]`.
- `sessao.state === 'paused'` (e `idle`) nunca e reconciliado.
- Processos-neto do agente sobrevivem ao crash do daemon: `#matarOrfao` so mata o PID da sessao; se esse PID ja morreu, o `taskkill /T` nao tem arvore para andar. Verificado: neto `detached` do agente ficou vivo (removi na mao). (Os processos-filho diretos dos agentes falsos morreram sozinhos com o daemon neste teste; o caminho de kill de orfao vivo nao foi exercitado.)

**Impacto**: timeline sem explicacao do fim; clientes SSE conectados nao recebem nada; processos-neto orfaos.

**Correcao sugerida**: emitir `session.ended{reason:'daemon reiniciou'}` e fechar a ultima tentativa na transacao da reconciliacao; tratar `paused`; no Windows considerar Job Object (`KILL_ON_JOB_CLOSE`) para amarrar a arvore do agente ao daemon.

**Esforco**: M

---

### [MEDIO] `handoff` conta a mesma sessao duas vezes no teto de concorrencia

**Evidencia**
- `session-manager.ts:1197` reserva vaga para o alvo enquanto a run antiga da MESMA sessao ainda esta em `#runs` (o cancel vem depois, 1201-1204); `#assertConcurrency` (2537) soma `#runs.size + #reserved.size`.
- Teste: `maxConcurrency=8`, 6 sessoes vivas, 6 handoffs simultaneos -> 2 aceitos (200), 4 recusados com `409 CONCURRENCY_EXCEEDED`, embora a concorrencia liquida nao mudasse. No cap, handoff e sempre recusado.
- Outros riscos de leitura: `handoff` aceita `waiting_approval`/`paused` (1187 so bloqueia terminais); a `attempt` continua com o agente original (bookkeeping/fallback errado).

**Impacto**: handoff falha exatamente quando o sistema esta cheio (o cenario em que trocar de agente mais importa).

**Correcao sugerida**: reservar so a diferenca (descontar a run da propria sessao em `#assertConcurrency(agentId, {replacing: sessionId})`).

**Esforco**: P

---

### [BAIXO] Cancel em cascata ignora filhos `paused`/`idle` e mata sem tentar o desfecho de tasks

**Evidencia**: `session-manager.ts:1152-1156` so desce em filhos `running`/`waiting_approval`. Filho `paused` (estado que `pause` gera em POSIX) fica vivo apos o pai ser cancelado. No Windows nao reproduzi (paused vira failed). **Correcao**: usar `!isTerminalSessionState(child.state)`. **Esforco**: P

### [BAIXO] Kill de arvore em POSIX mata so o filho

**Evidencia**: `process-adapter.ts:544-547` (`killTree`): fora do Windows `killProcessTree` chama `fallbackKill` = `child.kill('SIGKILL')` (so o PID direto), sem `detached`+`process.kill(-pgid)`. Leitura; a plataforma suportada e Windows. **Correcao**: spawn `detached:true` e `process.kill(-pid,'SIGKILL')`. **Esforco**: P

### [BAIXO] Artefato de diff so e capturado no caminho de sucesso

**Evidencia**: `capturarMudancas` e chamado apenas em `#settle` quando `outcomeClass==='success'` e a validacao passou (`session-manager.ts:1739`). Sessao cancelada/falha/timeout nao gera artefato; o unico registro do trabalho e o worktree (que o reaper apaga depois). Reexecucoes sobrescrevem `changes.patch` do mesmo id. **Correcao**: capturar tambem em `#concludeSession('failed')` e em cancel. **Esforco**: P

### [BAIXO] Escrita fora do worktree nao e detectada (documentado)

**Evidencia**: agente `outside` gravou `outside.txt` fora do worktree e `inside.txt` dentro; sessao `completed`, artefato so lista `inside.txt`, nenhum evento de alerta. E o que `SECURITY.md:120` ja diz ("O worktree nao e sandbox"), mas `docs/04-resiliencia-e-politica.md:55` lista "escrever fora do worktree" como `escalate`, o que so vale para agentes com eventos estruturados. **Correcao**: deixar a limitacao explicita na doc de politica. **Esforco**: P

---

## Verificado OK

- Teto de concorrencia sob fan-out: 20 starts simultaneos -> exatamente 8 aceitos e 12 `409 CONCURRENCY_EXCEEDED`; sem vaga vazada depois (novo start aceito); `liveSessions` volta a 0.
- Agente que ignora SIGTERM e agente que gera neto: `taskkill /T /F` mata a arvore; nenhum processo de agente restou apos cancel nem apos shutdown gracioso (5 sessoes, encerrou em 1,9 s).
- Shutdown gracioso encerra todas as runs e fecha o banco; nenhum orfao de agente.
- Reinicio com sessao `waiting_approval` + aprovacao pendente (crash duro): sessao e aprovacao sobrevivem ("revividas"); aprovar depois relanca a run e a sessao volta a `running`.
- `handoff` simples entre agentes (3 execucoes): a sessao termina `completed`, uma run viva por vez, sem pump duplicado.
- Cancel em cascata pai -> filhos -> neto: todos encerrados, `liveSessions` 0 (apenas com o desfecho `failed` do achado ALTO).
- Fluxo de `retry` com backoff e sessoes que nao acham binario nao trancam a reserva de concorrencia (`#releaseSlot` no `finally`).
- Barramento e SSE (`bus.ts`, `sse.ts`): assinantes sao removidos ao fechar, fila por conexao com teto, keep-alive `unref`. Reaper e compactador usam `setInterval().unref()`; `stop()` limpa. Sem timers/handles vazando nos cenarios exercitados.
- Rejeicao de start (`409`/`424`) antes de criar qualquer linha nao deixa lixo.
