# SPEC-04 — Domínio e adapters

Este documento descreve o domínio (`packages/core`) e os adapters de agente
(`packages/adapters`) do Agents-Hub TypeScript como eles existem hoje. É a referência
de comportamento que a reescrita em C precisa reproduzir (ADR 7.8, 7.9 e 7.10 em
[07-reescrita-nativa.md](../decisoes/07-reescrita-nativa.md)). Tudo foi extraído de
`main` (commit `82f40cc`). Cada afirmação traz o `arquivo:linha` de onde saiu.
Caminhos de código são relativos a `packages/`; manifestos, a `manifests/` na raiz.

**Como foi verificado.** Leitura do código-fonte e, onde marcado com "(executado)",
execução das funções reais a partir de `src/` com
`node --experimental-transform-types` (Node 24.14.0) e um hook de resolução
`.js → .ts` no diretório temporário da sessão. Os `dist/` do repositório estão
defasados em relação ao `src/` (arquivos `.ts` mais novos que `core/dist/index.js`),
por isso nenhum teste compilado foi usado como evidência.

**Convenção.** "NÃO DETERMINADO" marca o que o código não permite afirmar, com o
motivo. Onde o comportamento mora no daemon (e não em `core`/`adapters`), a linha do
daemon é citada, porque é ele quem aplica a regra.

---

## Parte A — `packages/core`

### A1. Tipos de domínio

#### Identificadores

| Item | Regra | Fonte |
|---|---|---|
| Prefixos | `prj`, `pfd`, `ses`, `tsk`, `evt`, `apv`, `art`, `run`, `aud` | `core/src/ids.ts:7` |
| Formato | `<prefixo>_` + os 24 primeiros caracteres hex de um UUID v4 sem hífens | `core/src/ids.ts:9-11` |
| Carimbo de tempo | `new Date().toISOString()` (ISO 8601 UTC) | `core/src/ids.ts:31-33` |
| `objectiveHash` | `trim` → minúsculas → espaços colapsados em um → remove a pontuação **final** `[\s.!?;:,…"'`)\]]+$` → SHA-256 → 16 primeiros hex | `core/src/ids.ts:18-29` |

(executado) `objectiveHash('Fix the bug.')` e `objectiveHash('  fix THE   bug ')`
dão o mesmo valor, `280fd7e3571b7c85`.

#### Entidades

| Entidade | Campos | Fonte |
|---|---|---|
| `Project` | `id`, `name`, `path`, `defaultBranch`, `createdAt`, `trusted?` (ausente = `false`), `trustedHash?: string \| null` | `core/src/domain.ts:68-100` |
| `ProjectHubContext` | `memory?`, `prompts?: Record<agentId,string>`, `env?: Record<agentId, Record<string,string>>` | `core/src/domain.ts:108-114` |
| `ProjectFolder` | `id`, `projectId`, `path` (único globalmente), `label \| null`, `isPrimary`, `createdAt` | `core/src/domain.ts:128-137` |
| `Session` | `id`, `projectId`, `agentId`, `nativeSessionId \| null`, `rootId` (raiz: `rootId === id`), `parentId \| null`, `depth` (raiz = 0), `path: string[]` (cadeia `agentId:objectiveHash`), `state`, `mode`, `isolation`, `workdir`, `title \| null`, `createdAt`, `updatedAt`, `endedAt \| null`, `pid \| null` | `core/src/domain.ts:139-172` |
| `TaskAttempt` | `n`, `agentId`, `startedAt`, `endedAt \| null`, `outcome: 'success'\|'error'\|'invalid'\|'timeout'\|null`, `error \| null` | `core/src/domain.ts:174-181` |
| `Task` | `id`, `sessionId`, `requesterSessionId \| null` (null = humano), `brief`, `state`, `attempts[]`, `result \| null`, `createdAt`, `updatedAt` | `core/src/domain.ts:183-194` |
| `TaskResult` | `summary`, `artifacts: string[]`, `usage: BudgetUsage`, `validation?: {passed, checks[{name, passed, detail?}]}` | `core/src/domain.ts:196-202` |
| `Approval` | `id`, `sessionId`, `taskId \| null`, `risk`, `action`, `detail`, `state: 'pending'\|'approved'\|'denied'\|'expired'`, `requestedAt`, `resolvedAt \| null`, `resolvedBy \| null` | `core/src/domain.ts:204-216` |
| `Artifact` | `id`, `sessionId`, `taskId \| null`, `kind: 'diff'\|'file'\|'report'\|'log'\|'transcript'`, `path`, `hash \| null`, `createdAt` | `core/src/domain.ts:218-228` |
| `BudgetRecord` | `rootId`, `limits`, `consumed`, `reserved`, `updatedAt` | `core/src/domain.ts:230-237` |

Enumerações: `SessionMode = supervised | semi | autonomous` com
`MODE_RANK = {supervised:0, semi:1, autonomous:2}` (`core/src/domain.ts:53-59`);
`narrowestMode` devolve o de menor rank (`core/src/domain.ts:62-64`);
`IsolationMode = none | worktree | container` (`core/src/domain.ts:66`).

#### Erros

`HubErrorCode` tem **32 códigos** (`core/src/errors.ts:6-42`). `HubError` carrega
`code`, `message` e `details`, e serializa como `{code, message, details}`
(`core/src/errors.ts:44-58`). Códigos que este documento cita: `INVALID_BRIEF`,
`POLICY_DENIED`, `BUDGET_EXCEEDED`, `DEPTH_EXCEEDED`, `CYCLE_DETECTED`,
`CONCURRENCY_EXCEEDED`, `TIMEOUT`, `ADAPTER_FAILURE`, `AGENT_NOT_FOUND`,
`AGENT_NOT_INSTALLED`, `CAPABILITY_UNRESOLVED`, `SESSION_NOT_FOUND`, `ILLEGAL_STATE`,
`CODEX_GATE_NOT_GUARANTEED`.

#### Portas

O core define as interfaces de persistência e barramento; `store` e `daemon` as
implementam (`core/src/ports.ts:18-22`). `UnitOfWork` agrega `projects`, `sessions`,
`tasks`, `events`, `approvals`, `artifacts`, `budgets`, `audit`, mais
`transaction(fn)` e `close()` (`core/src/ports.ts:126-137`). `EventBus` tem
`publish` e `subscribe(filter {sessionId?, rootId?}, handler)`
(`core/src/ports.ts:140-146`). O filtro de `EventRepository.list` aceita
`sessionId`, `taskId`, `sinceSeq`, `beforeSeq`, `newest`, `types`, `limit` (1..5000,
padrão 500) e `tail` (`core/src/ports.ts:66-99`). `costOf` soma o custo dos eventos
**excluindo** os de `cost.provisional` (`core/src/ports.ts:87-91`).

### A2. Eventos

**São 22 tipos de evento** (`core/src/events.ts:10-37`):

| # | Tipo | # | Tipo |
|---|---|---|---|
| 1 | `session.started` | 12 | `file.changed` |
| 2 | `session.ended` | 13 | `command.executed` |
| 3 | `session.handoff` | 14 | `delegation.requested` |
| 4 | `turn.started` | 15 | `delegation.completed` |
| 5 | `turn.completed` | 16 | `approval.requested` |
| 6 | `message` | 17 | `approval.resolved` |
| 7 | `user.message` | 18 | `budget.updated` |
| 8 | `message.delta` | 19 | `budget.warning` |
| 9 | `reasoning` | 20 | `budget.exceeded` |
| 10 | `tool.call` | 21 | `error` |
| 11 | `tool.result` | 22 | `log` |

A ordem é a do código. `user.message` é a fala do humano (ou de quem chamou `send`);
`message` é sempre fala do agente (`core/src/events.ts:17-22`).

**`EventCost`** (`core/src/events.ts:39-70`): `inputTokens?`, `outputTokens?`,
`cachedTokens?` (lidos do cache), `cacheWriteTokens?` (escritos no cache), `usd?`,
`provisional?` (estimativa parcial do turno, não somada em lugar nenhum), `partId?`
(parciais com o mesmo id se substituem; com ids diferentes somam no turno),
`cumulative?` (`usd` é o acumulado da sessão nativa; sempre com `provisional: true`),
`credits?`.

**`EventEnvelope`** (`core/src/events.ts:72-88`): `id`, `seq` (monotônico por
sessão), `ts`, `sessionId`, `taskId \| null`, `agentId`, `type`, `payload`,
`cost \| null`, `raw` (evento original preservado).

`makeEvent` gera `id = newId('evt')`, `ts = nowIso()` e normaliza ausentes para
`null`/`{}` (`core/src/events.ts:124-137`). `SequenceCounter.next` devolve
`atual + 1` começando em 1; `seed` só sobe o contador (`max`)
(`core/src/events.ts:105-122`). `NARRATIVE_EVENTS` = `message`, `reasoning`,
`tool.call`, `command.executed`, `file.changed`, `error`
(`core/src/events.ts:140-147`).

### A3. Máquinas de estado

**Não existe tabela de transições no código.** O core define os estados e os
conjuntos terminais; as transições são escritas diretas (`store.sessions.update`,
`store.tasks.update`) espalhadas pelo `SessionManager` do daemon. A tabela abaixo é o
levantamento dessas escritas em `daemon/src/session-manager.ts`.

#### Estados

| Máquina | Estados | Terminais | Fonte |
|---|---|---|---|
| Sessão | `idle`, `running`, `waiting_approval`, `paused`, `completed`, `failed`, `killed` | `completed`, `failed`, `killed` | `core/src/domain.ts:40-47` |
| Task | `submitted`, `working`, `input_required`, `auth_required`, `completed`, `failed`, `canceled`, `rejected` | `completed`, `failed`, `canceled`, `rejected` | `core/src/domain.ts:6-25` |

`submitted` e `auth_required` são declarados e **nunca escritos** por código de
produção. Fora de testes e `dist/`, aparecem só no tipo (`core/src/domain.ts:7,10`) e
como rótulos de exibição no painel (`web/src/logic/operacao.ts:190,193`: "na fila",
"precisa de login"); ninguém grava esses valores.

Invariante: operação sobre sessão terminal é recusada com `ILLEGAL_STATE`
(`daemon/src/session-manager.ts:358-367`); `send`, `handoff`, `pause`,
`interrupt` também recusam sessão em `waiting_approval` com aprovação pendente
(`daemon/src/session-manager.ts:1414-1425`).

#### Transições de sessão observadas

| De | Para | Gatilho | Fonte (`daemon/src/session-manager.ts`) |
|---|---|---|---|
| — | `running` | criação em `start` | 516-535 |
| — | `running` | `adoptExternal` (sessão externa, modo = padrão do manifesto, `isolation: none`) | 1845-1856 |
| — | `running` | sessão substituta do fallback | 3152-3165 |
| — | `failed` | delegação negada pela política do pai (task → `rejected`) | 613-615 |
| qualquer não terminal | `running` | `#launch`, antes de chamar o adapter | 2225 |
| `running` | `waiting_approval` | `#requestApproval` (delegação, gate, vigilância, orçamento); task → `input_required` | 1447-1451 (chamado em 624, 987, 3358, 4229) |
| `waiting_approval` | `running` | aprovação do gate resolvida sem outras pendentes; task `input_required` → `working` | 1370-1378 |
| `waiting_approval` | `running` | aprovação de orçamento com turno concluído; task → `working` | 1240-1244 |
| `waiting_approval` | `running` | outras aprovações (exceto delegação) aprovadas; task → `working`; em seguida `send` | 1286-1287 |
| `running` | `paused` / `idle` | turno interrompido por `pause` / `interrupt`; task → `input_required`; `pid` → null | 2778-2785 |
| não-`paused`, sem run viva | `paused` | `pause` sem turno em andamento | 1715-1716 |
| `running` | `idle` | `send` falhou ao relançar (task volta a `input_required` se tinha saído dela) | 1554-1557 |
| qualquer não terminal | `idle` | replay de segurança falhou; task → `input_required` | 2684-2685 |
| não terminal | `running` | `handoff` para outro agente (`nativeSessionId` → null) | 1788-1792 |
| não terminal | `completed` / `failed` / `killed` | `#finish`: grava estado, `endedAt`, `pid: null`; aprovações pendentes → `denied`; apaga o settings do gate | 3670-3700 |
| não terminal | `killed` | `cancel` → `#encerrarCancelada` → `#finish('killed')`; filhos cancelados em cascata | 1646-1684, 2707-2755 |
| não terminal | `completed` | `detach` de sessão adotada | 1902-1925 |
| `running` / `waiting_approval` sem aprovação pendente | `killed` | reconciliação na subida do daemon (tasks → `failed`) | 706-771 |

#### Transições de task observadas

| De | Para | Gatilho | Fonte (`daemon/src/session-manager.ts`) |
|---|---|---|---|
| — | `working` | criação em `start` (tentativa 1 aberta) | 537-547 |
| `working` | `input_required` | `#requestApproval` | 1450 |
| `input_required` | `working` | gate resolvido / aprovação / `send` retomando / `handoff` | 1375-1376, 1242, 1273, 1286, 1543-1545, 1773 |
| `working` | `completed` | `#settle` com sucesso e validação aprovada | 2924-2933 |
| não terminal | `completed` | orçamento estourado e continuação negada com turno já concluído | 1322-1323 |
| `working` | `failed` | `#settle` desiste (`give_up`) | 2986 |
| `working` | `failed` | retry ou fallback sem vaga de concorrência | 3038, 3124 |
| não terminal | `failed` | falha ao lançar o agente | 2292-2296 |
| não terminal | `failed` | reconciliação (sessão dona terminal ou sessão morta no reinício) | 698-704, 746-756 |
| não terminal | `canceled` | cancelamento da sessão | 2715-2720 |
| `input_required` | `rejected` | aprovação negada (depois a sessão é cancelada) | 1178-1181 |
| — | `rejected` | delegação negada pela política | 614 |

### A4. Brief

O Brief é o contrato de delegação, validado por Zod (`core/src/brief.ts:74-111`).
`parseBrief` lança `INVALID_BRIEF` com `issues[{path, message}]`
(`core/src/brief.ts:118-126`).

| Campo | Tipo e limites | Padrão | Fonte |
|---|---|---|---|
| `agent` | string, `trim`, 1..200; id de agente ou `cap:<capability>` | — | `core/src/brief.ts:79` |
| `objective` | string, `trim`, **mínimo 8** (`OBJETIVO_MINIMO_BRIEF`), máximo 50.000 (`LIMITE_OBJETIVO_BRIEF`) | — | `core/src/brief.ts:19-21,82-86` |
| `acceptanceCriteria` | até 200 itens; cada item `trim`, 1..4.000 | `[]` | `core/src/brief.ts:22-24,89` |
| `constraints` | idem | `[]` | `core/src/brief.ts:91` |
| `artifacts` | até 200 de `{path, mode: read\|write (padrão read), note? ≤ 4.000}` | `[]` | `core/src/brief.ts:37-46,93` |
| `contextRefs` | até 200 itens de 1..4.000 | `[]` | `core/src/brief.ts:96` |
| `upstream` | até 200 de `{step 1..64, agent 1..64, summary ≤ 20.000, sessionRef? 1..200}` | `[]` | `core/src/brief.ts:66-72,99` |
| `budget` | `{usd?: finito > 0, tokens?: inteiro > 0, seconds?: inteiro > 0}` | `{}` | `core/src/brief.ts:48-52,101` |
| `isolation` | `none \| worktree \| container` | `worktree` | `core/src/brief.ts:103` |
| `mode` | `async \| stream` | `async` | `core/src/brief.ts:105` |
| `supervision` | `supervised \| semi \| autonomous`, opcional | — | `core/src/brief.ts:108` |
| `labels` | `Record<string,string>` | `{}` | `core/src/brief.ts:110` |

`artifacts[].path`: `trim`, 1..1.000, e recusa NUL, caminho absoluto (`/`, `\`,
`X:`) e `..` em qualquer segmento (`core/src/brief.ts:31-35,38-43`).

`renderBriefAsPrompt(brief, contexto?)` é a única tradução Brief → texto
(`core/src/brief.ts:155-225`). Ordem das seções:

1. Se houver memória ou instruções do projeto: `# Diretrizes do projeto`, a memória,
   `## Instruções para você especificamente` e `---` (`core/src/brief.ts:161-168`).
2. `# Tarefa` + objetivo (`core/src/brief.ts:170`).
3. `## O que os passos anteriores entregaram`: por item, `### <step> (<agent>)` (quebras
   de linha viram espaço), o resumo citado com `> ` em cada linha, e o ponteiro
   `_Detalhe completo em \`<ref>\` (tool \`hub_context_fetch\`)._`
   (`core/src/brief.ts:175-185,228-243`).
4. `## Critérios de aceite`, `## Restrições` (listas `- `), `## Artefatos`
   (`` - `path` (mode) — note ``), `## Contexto disponível` (com a instrução de
   usar `hub_context_fetch`) (`core/src/brief.ts:187-215`).
5. `## Ao terminar` com o pedido de resumo e da lista de arquivos alterados
   (`core/src/brief.ts:217-222`). Linhas unidas por `\n`.

### A5. PolicyEngine

#### Níveis e decisões

| Risco | Rank | Fonte |
|---|---|---|
| `read` | 0 | `core/src/policy.ts:14-21` |
| `write` | 1 | |
| `exec` | 2 | |
| `escalate` | 3 | |
| `budget` | 4 | |
| `irreversible` | 5 | |

Decisões: `allow` (0) < `approve` (1) < `deny` (2) (`core/src/policy.ts:23-25`).
Decisão desconhecida ou ausente vale `approve` (`core/src/policy.ts:32-34`).
`narrowestDecision` fica com a de maior rank (`core/src/policy.ts:37-41`).

#### Algoritmo de `decide`

`decide(action, ctx)` (`core/src/policy.ts:852-862`):

1. `classify` devolve `{risk, reason, denied?}`.
2. Se `denied` (casou a deny list): decisão `deny`, sem olhar modo nem mapa.
3. `base = policy.risk[risk]` (ausente → `approve`).
4. `byMode = decisionForMode(risk, mode)`.
5. Resultado: `narrowestDecision(base, byMode)`.

Overlay por modo (`core/src/policy.ts:921-934`): `supervised` permite só rank ≤
`read`; `semi`, rank ≤ `exec`; `autonomous`, rank ≤ `escalate`. Acima disso,
`approve`.

#### Tabela risco × modo com `DEFAULT_POLICY` (executado)

| Risco | supervised | semi | autonomous |
|---|---|---|---|
| `read` | allow | allow | allow |
| `write` | approve | allow | allow |
| `exec` | approve | allow | allow |
| `escalate` | approve | approve | approve |
| `budget` | approve | approve | approve |
| `irreversible` | approve | approve | approve |
| deny list | **deny** | **deny** | **deny** |

`escalate` é `approve` em `autonomous` porque o mapa padrão já diz `approve`
(`core/src/policy.ts:518-525`), e o overlay só endurece. A linha "deny list" vem de
`core/src/policy.ts:856`.

#### Classificação por tipo de ação

`GuardedAction` (`core/src/policy.ts:710-716`) e `classify`
(`core/src/policy.ts:763-807`):

| Ação | Regra |
|---|---|
| `file.read` | Caminho resolvido. Se o caminho (relativo ao workdir quando dentro dele) casa segredo → `irreversible`; senão `read` (`core/src/policy.ts:814-818`) |
| `file.write` | Em ordem: caminho sensível embutido → `irreversible`; fragmento de `paths.denyFragments` (minúsculas, `/`, fronteira de segmento) → `irreversible`; dentro de `agentDirs` → `read`; fora do workdir sem `allowWriteOutsideWorkdir` → `escalate`; senão `write` (`core/src/policy.ts:820-846`) |
| `command` | `classifyCommand` (A6) com a visão da política (`core/src/policy.ts:771-782`) |
| `network` | URL do daemon do Hub (`alvoDoDaemon`) → `irreversible`; URL inválida → `escalate`; host igual ou subdomínio de `network.allowDomains` → `read`; senão `escalate` (`core/src/policy.ts:784-799`) |
| `delegation` | `exec` (`core/src/policy.ts:801-802`) |
| `budget.overrun` | `budget` (`core/src/policy.ts:804-805`) |

`isInside(pai, alvo)`: `path.relative` vazio, ou que não começa com `..` e não é
absoluto (`core/src/policy.ts:942-945`).

#### `PolicyDocument` e `DEFAULT_POLICY`

| Campo | Validação (`PolicyDocumentSchema`, `.strict()` em todo nível) | Padrão | Fonte do padrão |
|---|---|---|---|
| `maxDepth` | inteiro ≥ 0 | 3 | `core/src/policy.ts:511` |
| `maxConcurrency` | inteiro ≥ 1 | 4 | `:512` |
| `maxConcurrencyPerAgent` | inteiro ≥ 1 | 2 | `:513` |
| `taskTimeoutSeconds` | finito > 0 | 1800 | `:514` |
| `sessionTimeoutSeconds` | finito > 0 | 14400 | `:515` |
| `heartbeatTimeoutSeconds` | finito > 0 | 300 | `:516` |
| `defaultBudget` | `{usd, tokens, seconds}` finitos ≥ 0 | `{5, 2.000.000, 3600}` | `:517` |
| `risk` | mapa **exaustivo** dos 6 níveis | read/write/exec `allow`; escalate/budget/irreversible `approve` | `:518-525` |
| `commands.allow` | string[] | 92 entradas (git, npm, pnpm, yarn, python, go, cargo, make, leitura, PowerShell de leitura) | `:533-626` |
| `commands.deny` | string[] | `sudo`, `doas`, `shutdown`, `reboot`, `halt`, `poweroff`, `mkfs`, `diskpart`, `format`, `reg delete` | `:627-638` |
| `paths.allowWriteOutsideWorkdir` | boolean | `false` | `:641` |
| `paths.denyFragments` | string[] | `.git/config`, `.git/hooks`, `.github/workflows`, `.ssh`, `.aws`, `.env`, `id_rsa`, `credentials` | `:645-654` |
| `network.allowDomains` | string[] | `[]` | `:656-658` |
| `retries` | `max` inteiro ≥ 0; `backoffMs` finito ≥ 0 | `{max: 2, backoffMs: 2000}` | `:659-662` |
| `fallback` | `Record<capability, agentId[]>` | ver A10 | `:672-680` |
| `watch` | `pauseOn`, `flagOn`: níveis de risco | `pauseOn [irreversible]`, `flagOn [escalate]` | `:681-684` |
| `validation` | `command: string\|null`, `commandTimeoutSeconds` > 0, `review {enabled, agent\|null}` | `null`, 600, `{false, null}` | `:685-689` |

Faixas e `.strict()`: `core/src/policy.ts:146-238`. A versão parcial para camadas é
`PolicyDocumentSchema.deepPartial()` (`core/src/policy.ts:245`).

A lista `commands.allow` completa está em `core/src/policy.ts:533-626`: `git status`,
`git diff`, `git log`, `git show`, `git branch`, `git add`, `git commit`, `git stash`,
`git fetch`, `git pull`, `git checkout`, `git switch`, `git merge`, `git rebase`,
`git reset`, `git rev-parse`, `git ls-files`, `git blame`, `git grep`, `git describe`,
`git shortlog`, `git remote`, `git tag`, `git mv`, `git rm`, `git restore`,
`git worktree`, `git cherry-pick`, `npm test`, `npm run`, `npm ci`, `npm install`,
`npm i`, `npm ls`, `npx tsc`, `tsc`, `vitest`, `jest`, `eslint`, `prettier`, `node`,
`pnpm test`, `pnpm run`, `pnpm install`, `pnpm i`, `yarn test`, `yarn install`,
`yarn build`, `python`, `pip install`, `pytest`, `go test`, `go build`, `go vet`,
`go run`, `go mod`, `cargo test`, `cargo build`, `cargo check`, `cargo run`,
`cargo fmt`, `cargo clippy`, `make`, `cmake`, `docker ps`, `docker images`,
`docker build`, `ls`, `dir`, `cat`, `type`, `head`, `tail`, `wc`, `sort`, `uniq`,
`cut`, `diff`, `jq`, `sed`, `awk`, `tree`, `which`, `where`, `rg`, `grep`, `find`,
`echo`, `printf`, `Get-ChildItem`, `Get-Content`, `Select-String`.

`watchForMode`: em `supervised`, `escalate` entra em `pauseOn`
(`core/src/policy.ts:693-699`). O daemon aplica isso na vigilância
(`daemon/src/session-manager.ts:3331`).

#### Camadas: global e projeto

A política global é `DEFAULT_POLICY` ← `config.json` ← overrides, fundidos **sem
clamp** (`daemon/src/config.ts:332-335`). Sem clamp, cada campo da camada substitui o
da base, com fusão campo a campo dentro de `defaultBudget`, `risk`, `retries`,
`fallback`, `validation.review` (`core/src/policy.ts:380-422`).

A camada de projeto (`.agents-hub/config.yaml`) é fundida com
`clampToBase: true` e `trustExecFields = projeto confiável`
(`daemon/src/project-config.ts:486-498`; confiança em
`daemon/src/effective-policy.ts:23-35`). Regra por campo sob clamp
(`core/src/policy.ts:334-367`, implementação `:426-508`):

| Campo | Regra sob clamp |
|---|---|
| `maxDepth`, `maxConcurrency`, `maxConcurrencyPerAgent`, `taskTimeoutSeconds`, `sessionTimeoutSeconds`, `heartbeatTimeoutSeconds` | `min(base, camada)` |
| `defaultBudget.usd/tokens/seconds` | `min` em cada um |
| `risk.<nível>` | `narrowestDecision(base, camada)` |
| `commands.allow`, `network.allowDomains` | só itens que já estão na base |
| `commands.deny`, `paths.denyFragments`, `watch.pauseOn`, `watch.flagOn` | união |
| `paths.allowWriteOutsideWorkdir` | `base AND camada` |
| `retries.max`, `retries.backoffMs` | `min` |
| `fallback.<cap>` | só capabilities da base; cadeia filtrada aos agentes da base, na ordem da camada |
| `validation.commandTimeoutSeconds` | `min` |
| `validation.command` | ignorado sem `trustExecFields`; com ele, string da camada substitui (null não desliga) |
| `validation.review.enabled` | `base OR (trust AND camada === true)` |
| `validation.review.agent` | com `trustExecFields`, camada; senão base |

`EXEC_POLICY_FIELDS` = `validation.command`, `validation.review.enabled`,
`validation.review.agent` (`core/src/policy.ts:266-270`).

#### Não-escalação pai → filho

A política efetiva de uma sessão é a do projeto; num filho, é a interseção
recursiva com a do pai: `policyFor(pai).intersect(base)`
(`daemon/src/effective-policy.ts:44-57`). `intersect` (`core/src/policy.ts:868-917`):

| Campo | Regra |
|---|---|
| tetos numéricos (depth, concorrência, timeouts) | `min(pai, filho)` |
| `risk` | `narrowestDecision` em todos os 6 níveis |
| `commands.allow`, `network.allowDomains` | itens do filho que o pai também tem |
| `commands.deny`, `paths.denyFragments`, `watch.*` | união |
| `allowWriteOutsideWorkdir` | `pai AND filho` |
| `validation.command` | `pai ?? filho` |
| `validation.commandTimeoutSeconds` | `min` |
| `validation.review.enabled` | `pai OR filho` |
| `validation.review.agent` | `filho ?? pai` |
| `defaultBudget`, `retries`, `fallback` | **do filho** (spread `...child`) |

Modo: `inheritMode(pai, pedido)` = pedido ausente → pai; senão o mais restrito
(`core/src/policy.ts:937-940`). Na raiz, o "pai" é o `defaults.supervision` do
manifesto (`daemon/src/session-manager.ts:463-464`). (executado)
`inheritMode('supervised','autonomous') = supervised`;
`inheritMode('autonomous','semi') = semi`.

### A6. Classificador de comandos

`classifyCommand(command, view, depth = 0)` (`core/src/command-classifier.ts:293-322`).

#### Tokenização (`core/src/shell-tokenizer.ts`)

- Produz uma lista **plana** de segmentos `{words[], redirects[]}`, um por comando
  simples; conteúdo de `$(...)`, crases, `<(...)`/`>(...)` e `( ... )` vira segmento
  próprio (`core/src/shell-tokenizer.ts:1-10,80-84`).
- Cada palavra tem duas leituras: `posix` (bash: `\x` → `x`) e `win` (cmd/PowerShell:
  barra invertida literal; `^x` → `x`), mais `dynamic` (houve `$VAR`, `$(...)`, crase)
  e `quoted` (`core/src/shell-tokenizer.ts:27-36,267-283`).
- Separadores de segmento: espaço/tab/`\r` quebram palavra; `\n`, `;`, `&`, `|`
  (e `&&`, `||`, `|&`, `;;`, `;&`) fecham segmento; `\` + quebra de linha é
  continuação; `#` no início de palavra é comentário
  (`core/src/shell-tokenizer.ts:108-164`).
- Redirecionamentos reconhecidos: `&>>`, `&>`, `<<<`, `<<-`, `<<`, `<>`, `<&`, `<`,
  `>>`, `>|`, `>&`, `>`. Dígito ou `*` colado vira descritor. Heredoc e
  here-string não têm alvo; `>&1`/`<&-` (duplicação) não têm alvo
  (`core/src/shell-tokenizer.ts:165-176,419-445`).
- Heredoc sem aspas no delimitador tem o corpo varrido por `$(` e crase
  (`core/src/shell-tokenizer.ts:463-484`). `${...}` e `$((...))` com `$(`/crase
  dentro também (`core/src/shell-tokenizer.ts:334-359`).
- Lança `ShellParseError` (`core/src/shell-tokenizer.ts:62,98,130,181,246,326,337,352,373,412,423,428`) em:
  aninhamento > 12 (`:62,98`); `)` sem `(` (`:130`); `)` esperado e não encontrado,
  isto é, `$(`, `(`, `<(`/`>(` sem fechar (`:181`); aspas simples sem fechar (`:246`);
  aspas duplas sem fechar (`:326`); `$((` sem `))` (`:337`); `${` sem `}` (`:352`);
  `$'...'` sem fechar (`:373`); crase sem par (`:412`); "redirecionamento inválido"
  (`:423`); redirecionamento sem alvo (`:428`).
  O classificador transforma isso em `escalate` "na dúvida, não libera"
  (`core/src/command-classifier.ts:298-304`).

#### Pipeline de classificação

1. Texto vazio → `read`; profundidade > 8 → `escalate`
   (`core/src/command-classifier.ts:67,294-296`).
2. Cada segmento é classificado; vale o **pior** (`worstVerdict`: deny vence tudo;
   empate fica com o primeiro). Com mais de um segmento, a razão ganha
   `[em "<segmento>"]` (`core/src/command-classifier.ts:74-78,307-321`).
3. Segmento: classifica a leitura `posix`; se a leitura `win` diferir, classifica ela
   também e fica com a pior; soma cada redirecionamento
   (`core/src/command-classifier.ts:333-344`).
4. Redirecionamento de escrita (`>`, `>>`, `>|`, `&>`, `&>>`, `>&`, `<>`) é escrita no
   alvo; de leitura (`<`, `<>`, `<&`) é leitura. Alvos `/dev/null`, `nul`, `$null`,
   `/dev/stderr`, `/dev/stdout`, `/dev/tty`, `con` são ignorados
   (`core/src/command-classifier.ts:350-373`).
5. Alvo de escrita dinâmico ou com variável não resolvida sobe para `escalate`
   (`core/src/command-classifier.ts:388-403`). `~`, `$HOME`, `${HOME}`,
   `$env:USERPROFILE`, `$env:HOME`, `%USERPROFILE%`, `%HOMEPATH%` no início viram o
   home (`core/src/command-classifier.ts:376-386`).
6. Atribuições iniciais `VAR=x` são puladas; variável de sequestro (`HIJACK_VARS`)
   vira `escalate` (`core/src/command-classifier.ts:241-242,429-443`).
7. Comando simples (`core/src/command-classifier.ts:445-482`): atribuição PowerShell
   `$x = ...`; nome dinâmico → `escalate`; **deny list** → `irreversible` +
   `denied`; palavras de controle são removidas; `for/case/select/foreach` → `read`;
   regra específica (`classifySpecific`) ou listas; o resultado é piorado pela
   varredura de segredo nos argumentos e pelo bloco `{ ... }`.
8. Listas (`core/src/command-classifier.ts:485-495`): builtin seguro → `read`; na
   allow list → `read` se o comando só lê (`READ_ONLY` ou git de leitura), senão
   `exec`; fora dela → `escalate`.

Casamento de lista **por palavra** (`core/src/command-classifier.ts:501-517`): cada
entrada é quebrada em tokens minúsculos; o primeiro casa o nome normalizado
(igual, ou `nome.` como prefixo — `mkfs` casa `mkfs.ext4`); os seguintes casam os
argumentos na ordem. Nome normalizado: base do caminho, minúsculas, sem
`.exe/.cmd/.bat/.com`; `python3.x`/`py` → `python`; `pip3` → `pip`
(`core/src/command-classifier.ts:417-423`).

#### Tabelas embutidas

| Tabela | Conteúdo | Fonte |
|---|---|---|
| `READ_ONLY` | `ls dir cat type head tail grep egrep fgrep rg find echo printf wc which where tree sort uniq cut diff jq stat file du df sed awk get-childitem gci get-content gc select-string sls get-item test-path resolve-path write-output write-host get-command whoami date basename dirname realpath readlink nl tac column fd ag` | `core/src/command-classifier.ts:92-144` |
| `SAFE_BUILTINS` (sempre `read`) | `cd pwd true false : test [ [[ ]] read set shift local declare typeset unset return exit wait sleep start-sleep set-location sl get-location push-location pop-location pushd popd cls clear shopt setlocal endlocal chcp title rem @echo format-table ft format-list fl format-wide select-object select where-object measure-object measure sort-object group-object out-string out-null out-host convertto-json convertfrom-json test-path` (`get-location` aparece duas vezes no código, `:171,203`; `test-path`, em `:204`, também está em `READ_ONLY`). (executado) `Test-Path x` → read, "builtin sem efeito (test-path)" | `:147-205` |
| `PS_PREDICATE` | `where-object where ? sort-object select-object group-object measure-object` — bloco `{ ... }` desses cmdlets que começa com `$` vale `read` ("predicado de filtro"); em `ForEach-Object` não | `:208-216,543` |
| `CONTROL_WORDS` | `{ } then else do done fi esac ! if elif while until time coproc` | `:219-235` |
| `DATA_ONLY` (sem varredura de segredo) | `echo printf write-host write-output write-error rem` | `:238` |
| `HIJACK_VARS` | `PATH LD_PRELOAD LD_LIBRARY_PATH DYLD_* NODE_OPTIONS NODE_PATH PYTHONPATH PYTHONSTARTUP BASH_ENV ENV PROMPT_COMMAND GIT_SSH GIT_SSH_COMMAND GIT_EXEC_PATH GIT_CONFIG* GIT_DIR GIT_WORK_TREE PERL5OPT RUBYOPT ZDOTDIR IFS` (sem diferenciar maiúsculas) | `:241-242` |
| `SHELLS` | `bash sh zsh dash ksh fish ash mksh busybox` | `:275` |
| `INTERPRETERS` (flags de código inline) | `node`: `-e --eval -p --print -pe -ep`; `bun`: `-e --eval -p --print`; `deno`: subcomando `eval`; `python`: `-c` (e bundle `-[A-Za-z]*c`, `:1032`); `ruby`: `-e`; `perl`: `-e -E`; `php`: `-r`; `rscript`: `-e`; `osascript`: `-e`. Formas `--flag=código` valem para flags longas (`:1026-1030`); em `python`, `-m -W -X` consomem valor e `-m` conta como script (`:1037-1041`) | `:994-1004` |
| `DANGER_API` (código inline sobe para escalate) | regex: `child_process`, `exec/execSync/execFile/execFileSync(`, `spawn/spawnSync(`, `fork(`, `rm rmdir unlink rename writeFile appendFile copyFile cp truncate chmod chown symlink link mkdir mkdtemp` (+`Sync`) seguidos de `(`, `createWriteStream`, `fetch(`, `require('http'/'https'/'net'/'dgram'/'tls'/'http2')` (com ou sem `node:`), `eval(`, `new Function`, `process.kill`, `os.(system remove unlink rmdir removedirs rename renames replace makedirs mkdir chmod chown popen exec* spawn* kill)`, `subprocess`, `shutil`, `Popen`, `open(..., '[wax+]...')`, `urllib`, `requests.`, `http.client`, `socket`, `.write_text(`/`.write_bytes(`, `.unlink(`, `system(`, crase, `File.write/delete/open`, `FileUtils`, `IO.popen`, `Deno.(run remove writeTextFile writeFile Command)`, `Bun.(spawn write $)`, `import(`, `__import__`, `importlib` | `:980-981` |
| `PROCESS_API` (literais viram comando reclassificado) | regex: `child_process`, `exec*(`, `spawn/spawnSync(`, `os.(system popen exec* spawn*)`, `subprocess`, `Popen`, `system(`, `IO.popen`, `Deno.(run Command)`, `Bun.(spawn $)`, crase. Só literais com espaço ou que começam com letra são reclassificados (`:1083`) | `:984-985` |
| `NETWORK` | `curl wget invoke-webrequest iwr invoke-restmethod irm http https xh aria2c` | `:276-287` |

#### Comandos por risco (regras específicas)

**`irreversible` por subsequência de argumentos posicionais**
(`core/src/command-classifier.ts:245-273`, casamento em `:705-712`):
`npm publish`, `npm unpublish`, `pnpm publish`, `yarn publish`, `bun publish`,
`cargo publish`, `twine upload`, `gem push`, `dotnet nuget push`, `docker rm`,
`docker rmi`, `docker prune`, `docker volume rm`, `kubectl delete`,
`terraform apply`, `terraform destroy`, `gh pr merge`, `gh release create`,
`gh release delete`, `gh repo delete`, `gcloud delete`, `az delete`, e sempre
`shred`, `remove-item`, `ri`, `aws`.

**Git** (opções globais `-C -c --git-dir --work-tree --namespace --super-prefix
--config-env --exec-path --list-cmds --attr-source` são puladas;
`core/src/command-classifier.ts:1100-1125,1138-1230`):

| Subcomando | Condição | Risco |
|---|---|---|
| `push` | sempre | irreversible |
| `reset` | `--hard`, `--merge`, `--keep` | irreversible |
| `clean` | `-f`/`--force` | irreversible; senão write |
| `branch` | apagar + forçar (`-D`, `-d -f`) | irreversible; apagar/mover/copiar → write |
| `tag` | `-d`/`--delete` | irreversible |
| `stash` | `drop`, `clear` | irreversible |
| `checkout` | `-f`, `--force`, `--` ou `.` | irreversible |
| `restore` | qualquer, exceto só `--staged` | irreversible |
| `switch` | `-f`, `--force`, `--discard-changes` | irreversible |
| `reflog` | `expire`, `delete` | irreversible |
| `update-ref` | `-d` | irreversible |
| `filter-branch`, `filter-repo`, `prune` | sempre | irreversible |
| `gc` | `--prune` | irreversible |
| `config` | escrita (sem `--get*`/`--list`/`-l`, com > 1 posicional) | escalate |
| sem subcomando | — | read |
| outros | allow list; git de leitura (`status diff log show rev-parse ls-files blame grep describe shortlog`, `branch`/`tag`/`remote` sem posicional, `stash list/show`) → read | `:1233-1260` |
| qualquer | `-c` ou `--config-env` global | piora para escalate |

**Remoção e escrita:**

| Comando | Regra | Fonte |
|---|---|---|
| `rm` | recursivo (`-r`, `-R`, `--recursive`, `-rec*`) ou forçado (`-f`, `--force`) → irreversible; senão escrita em cada alvo | `core/src/command-classifier.ts:1264-1284` |
| `del`, `erase` | `/s /q /f`, `-rec*`, `-force*` → irreversible | `:1286-1295` |
| `rd`, `rmdir` | `/s`, `-rec*`, `-force*` → irreversible | `:1297-1306` |
| `find` | `-delete` → irreversible; `-exec/-execdir/-ok/-okdir` → exec + comando interno; `-fprint*`/`-fls` → escrita | `:1314-1342` |
| `sed` | `-f` → escalate; script com `e/w/W/r/R` → escalate; `-i` → escrita nos arquivos | `:1344-1369` |
| `awk`/`gawk`/`mawk` | `-f` → escalate; `system(`, `\| getline`, `print >` → escalate | `:1371-1381` |
| `sort` | `-o`/`--output` → escrita no alvo | `:687-688,1383-1402` |
| `dd` | `of=` → escrita; sempre pelo menos escalate | `:1404-1410` |
| `mkdir md touch tee truncate unlink` | escrita em cada posicional | `:1452-1462` |
| `new-item ni set-content add-content ac out-file` | escrita no `-Path/-LiteralPath/-FilePath/-Destination/-Target` ou 1º posicional | `:1463-1469` |
| `cp copy copy-item cpi xcopy robocopy` | escrita no destino + leitura das origens | `:1470-1483` |
| `mv move move-item mi ren rename rename-item` | escrita em cada alvo | `:1484-1497` |
| `ln`, `mklink` | escrita no link | `:1498-1506` |
| `rg` | `--pre` → escalate | `:689-693` |

**Wrappers e interpretadores** (conteúdo é desembrulhado e reclassificado):

| Comando | Regra | Fonte |
|---|---|---|
| `sudo doas gsudo runas` | escalate + comando interno | `core/src/command-classifier.ts:585-592` |
| `env` | `-S` reclassifica o texto; variável de sequestro → escalate; sem comando → escalate | `:732-772` |
| `command builtin exec nohup chronic unbuffer call nice ionice timeout stdbuf xargs` | desembrulha (xargs sem comando → read) | `:595-632` |
| `npx bunx pnpx`, `npm/pnpm/yarn exec\|dlx\|x` | exec + comando interno; `-c` reclassifica o texto; sem comando → escalate | `:633-643,774-782` |
| `eval` | exec + texto; `iex`/`invoke-expression` → escalate + texto | `:644-654` |
| `source`, `.` | escalate | `:655-657` |
| `cmd` | `/c`/`/k` → exec + texto; sem `/c` → escalate | `:837-854` |
| `powershell`/`pwsh` | `-EncodedCommand` → escalate + texto decodificado (UTF-16LE); `-File`/`.ps1` → escalate; `-Command` → exec + texto; sem nada → escalate | `:856-926` |
| `wsl` | exec + comando; interativo → escalate | `:928-943` |
| `start start-process saps` | exec; `-Verb RunAs` → escalate | `:945-975` |
| shells (`bash -c` etc.) | `-c` → exec + texto; stdin/sem args → escalate; script em arquivo → allow list | `:786-835` |
| `node bun deno python ruby perl php rscript osascript` | código inline → exec (`osascript` inline é sempre ao menos escalate, "AppleScript inline", `:1068`; executado: `osascript -e "display dialog 1"` → escalate), `escalate` se casar `DANGER_API`, `irreversible` se literal casar segredo ou o daemon; com API de processo, literais são reclassificados como comando; sem script → escalate; `--version/-h` → read | `:980-1096` |
| `hub`, `agents-hub` | `approve deny stop restart`, `policy <≠show>`, `project trust`, `hooks <≠status>` → irreversible | `:575-584,1608-1617` |
| rede (`NETWORK`) | alvo do daemon → irreversible; `-o/--output/-O/-outfile` → escrita; host fora de `allowDomains` → escalate; sem host → escalate; senão exec | `:1513-1553` |

#### Flags que recebem valor (consomem o argumento seguinte)

Levantamento de todos os conjuntos do arquivo. Quem não está na lista conta como flag
sem valor. `skipFlags` para no primeiro posicional e trata `--` como fim das flags
(`core/src/command-classifier.ts:715-724`).

| Comando | Flags com valor | Fonte (`core/src/command-classifier.ts`) |
|---|---|---|
| `sudo doas gsudo runas` | `-u -g -h -p -C -D -U` | 591 |
| `command builtin exec nohup chronic unbuffer call stdbuf` | nenhuma | 602, 611 |
| `nice ionice` | `-n -c --adjustment` | 605 |
| `timeout` | `-s --signal -k --kill-after`; o 1º posicional (duração) é descartado | 607-608 |
| `xargs` | `-n -I -i -P -d -L -E -s -a --max-args --max-procs --delimiter --arg-file` | 613-630 |
| `env` | `-u --unset -C --chdir`; `-S`/`--split-string` reclassifica o texto seguinte | 737-753 |
| `npx bunx pnpx` | `-p --package -c --call` (`-c`/`--call` reclassifica o valor) | 775-779 |
| shells (`bash` etc.) | `-o +o -O +O --rcfile --init-file`; `-c`/`--command`/bundle com `c` liga modo comando; bundle com `s` = stdin | 807-820 |
| `cmd` | `/c` ou `/k` (separado ou colado) inicia o comando | 838-843 |
| `powershell pwsh` (sem diferenciar maiúsculas, `/` vale como `-`) | `-executionpolicy -ep -ex -windowstyle -w -inputformat -if -outputformat -of -o -version -v -configurationname -workingdirectory -wd -settingsfile -psconsolefile -custompipename`; `-encodedcommand -enc -e -ec -en*` decodifica o valor; `-file -f` → escalate; `-command -c -com*` reclassifica o resto | 857-907 |
| `wsl` | `-d --distribution -u --user --cd --shell-type`; `-e --exec --` iniciam o comando | 929-938 |
| `start start-process saps` | `-filepath -verb -workingdirectory -windowstyle -redirectstandard*`; `-argumentlist` (valor anexado ao comando, vírgulas viram espaço) | 959-972 |
| interpretadores | ver `INTERPRETERS`; `python`: `-m -W -X` | 1026-1041 |
| `git` (globais) | `-C -c --git-dir --work-tree --namespace --super-prefix --config-env --exec-path --list-cmds --attr-source` | 1100-1111 |
| `find` | `-exec -execdir -ok -okdir` (até `;`, `\;` ou `+`); `-fprint -fprint0 -fprintf -fls` (alvo de escrita) | 1320-1336 |
| `sed` | `-e --expression` (script); `-f --file` → escalate | 1352-1358 |
| `sort` | `-o --output` (e `=valor`) | 688, 1392-1393 |
| `mkdir md touch tee truncate unlink` | `-m --mode -d -t -r -s --size --reference` | 1459 |
| `cp copy xcopy robocopy`, `mv move ren rename`, `ln` | `-t --target-directory -S --suffix` | 1478, 1494, 1499 |
| cmdlets PowerShell de escrita (`psTargets`) | `-path -literalpath -filepath -destination -target` são o alvo; outra flag consome valor, **exceto** as que começam com `-force -recurse -append -nonewline -passthru -whatif -confirm -noclobber` (casamento por prefixo); sem flag de alvo, o 1º posicional é o alvo | 1435-1449 |
| rede | `-o --output --output-document -outfile` (e `-O` no `wget`) = alvo de escrita; `-uri` = host | 1528-1542 |

Observação: em `positional` a flag é comparada em minúsculas
(`core/src/command-classifier.ts:1427`), então `-S` dos conjuntos de `cp`/`mv`/`ln`
nunca casa como escrito; `-s` minúsculo casa só no conjunto de `mkdir`/`touch`.

`alvoDoDaemon(texto, hubPorts?)`: URL `http(s)/ws(s)` ou `host:porta[/...]`, host
loopback (`localhost`, `*.localhost`, `127.x.x.x`, `0.0.0.0`, `[::1]`, `[::]`,
`[::ffff:7fxx:...]`) e porta efetiva em `hubPorts` (padrão `[4747]`)
(`core/src/command-classifier.ts:1555-1598`).

Varredura de segredo: qualquer argumento que casa `matchSecretPath` →
`irreversible`, exceto em `DATA_ONLY` (`core/src/command-classifier.ts:550-557`).

#### Exemplos (executado, com `DEFAULT_POLICY`)

| Comando | Risco | Razão devolvida |
|---|---|---|
| `git status` | read | comando só de leitura na allow list (git status) |
| `git status && git push` | irreversible | git push publica no remoto [em "git push"] |
| `catalog x` | escalate | comando fora da allow list (catalog) |
| `npm test` | exec | comando na allow list (npm test) |
| `rm -rf x` | irreversible | remoção recursiva (rm -rf) |
| `echo x > .env` | irreversible | redirecionamento ">": caminho sensível (.env) |
| `bash -c "curl http://127.0.0.1:4747/"` | irreversible | curl ao daemon do Hub (...) expõe o token de operador |
| `sudo ls` | irreversible + `denied` | comando na deny list (sudo) |
| `$CMD a` | escalate | nome do comando é dinâmico |
| `cat ~/.ssh/id_rsa` | irreversible | acesso a segredo (.ssh) |
| `curl https://example.com` | escalate | rede: domínio não liberado (example.com) |
| `hub approve apv_1` | irreversible | comando de operador do Hub (hub approve) |
| `git -c core.fsmonitor=x status` | escalate | git -c/--config-env pode executar comando arbitrário |
| `echo "unterminated` | escalate | comando não tokenizável (aspas duplas sem fechamento) |

### A7. Caminhos sensíveis

Casamento por **segmento**, não substring. O caminho é quebrado em minúsculas por
`\ / : = @`, sem aspas e sem segmentos `.` (`core/src/sensitive-paths.ts:106-113`).
A lista não é configurável; `paths.denyFragments` só acrescenta
(`core/src/sensitive-paths.ts:15-16`). Ordem de `matchSensitivePath`
(`core/src/sensitive-paths.ts:160-179`):

| Tipo | Regra | Fonte |
|---|---|---|
| secret | algum segmento é `.ssh`, `.gnupg`, `.aws`, `.azure` | `:29` |
| secret | par consecutivo `.claude/.credentials.json`, `.codex/auth.json`, `.docker/config.json`, `.kube/config`, `gh/hosts.yml`, `.config/gcloud` | `:55-62` |
| secret | nome final `.env .envrc .npmrc .yarnrc.yml .pypirc .netrc _netrc .git-credentials .pgpass credentials credentials.json .credentials.json operator-token` | `:32-47` |
| secret | `.env.<x>`, exceto `x` ∈ `example sample template dist defaults` | `:50,117-120` |
| secret | `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519` (com `_sk`), exceto `.pub` | `:121` |
| secret | extensão `.pem .key .p12 .pfx .ppk .jks .keystore` | `:52,122-123` |
| secret | curinga (`*`, `?`) com parte literal que alcança um dos 12 `GLOB_PROBES`: `.env`, `.env.local`, `.env.production`, `id_rsa`, `id_ed25519`, `server.pem`, `server.key`, `.npmrc`, `.netrc`, `.git-credentials`, `credentials`, `.credentials.json` (curinga no início não alcança nome oculto) | `:91-104,137-145` |
| exec-config | par `.git/hooks`, `.git/config`, `.github/workflows`, `.claude/settings.json`, `.claude/settings.local.json`, `.codex/config.toml` | `:65-72` |
| exec-config | segmento `.husky` ou `.agents-hub` | `:74` |
| exec-config | nome final `.mcp.json .gitlab-ci.yml .pre-commit-config.yaml .gitconfig .bashrc .zshrc .profile .bash_profile .bash_login microsoft.powershell_profile.ps1 profile.ps1` | `:76-88` |

`matchSecretPath` devolve só `secret` (vale para leitura)
(`core/src/sensitive-paths.ts:182-185`). `agentOwnDirs('claude', home, env)` =
`[<CLAUDE_CONFIG_DIR ou home/.claude>/plans]`; outros agentes, `[]`
(`core/src/sensitive-paths.ts:198-211`). `fragmentMatches` exige fronteira: antes,
`/` (ou fragmento começando com `/`); depois, fim, `/` ou `.`
(`core/src/sensitive-paths.ts:218-232`).

### A8. BudgetLedger

Um livro-caixa por **sessão-raiz** (`core/src/budget.ts:81-94`). Três dimensões:
`usd`, `tokens`, `seconds` (`core/src/budget.ts:3-13`). Valor não finito ou ≤ 0 vira
0 em toda entrada (`core/src/budget.ts:24-35`).

| Operação | Comportamento | Fonte |
|---|---|---|
| `snapshot(limiar = 0.8)` | `consumed` = consumo + estimativas abertas; `reserved` = base + Σ(pedido − (gasto + estimativa)) por fatia; `remaining = limite − consumed − reserved`; `pressure` = maior razão `(consumed+reserved)/limite` (limite ≤ 0: ∞ se usado, 0 se não); `exhausted` se `consumed ≥ limite` em alguma dimensão ou `remaining < 0`; `isWarning = pressure ≥ limiar && !exhausted` | `core/src/budget.ts:125-164,282-285` |
| `reserve(taskId, pedido)` | Dimensão não pedida reserva 0. Reservar o mesmo `taskId` substitui a fatia. Pedido > `remaining` em qualquer dimensão → `BUDGET_EXCEEDED` (fatia anterior restaurada) | `core/src/budget.ts:193-215` |
| `charge(valor, taskId?)` | Soma ao consumo; com `taskId`, apaga a estimativa aberta e abate da fatia | `core/src/budget.ts:240-249` |
| `estimate(taskId, parcial)` | Substitui a estimativa aberta do escopo | `core/src/budget.ts:256-259` |
| `settle(taskId, real)` | Estimativa aberta vira consumo; fatia liberada; `real` soma | `core/src/budget.ts:222-231` |
| `release(taskId)` | Libera a fatia | `core/src/budget.ts:261-263` |
| `raiseLimits(delta)` | Soma ao limite | `core/src/budget.ts:266-269` |
| `setLimits(limites)` | Troca o limite; consumo e reservas intactos | `core/src/budget.ts:276-279` |
| `project(decorrido, alvo?)` | taxa = consumo/max(1, decorrido); projeção = taxa × (alvo ou `limits.seconds`) | `core/src/budget.ts:170-182` |

**Herança da raiz** (daemon): na raiz, o teto do fluxo é `brief.budget` com
`defaultBudget` da política do projeto para o que faltar; num filho, o mesmo ledger
da raiz (`rootId = pai.rootId`) e o filho **reserva** a fatia do seu `brief.budget`
(`daemon/src/session-manager.ts:466-488`). Ao recriar o ledger a partir do banco, as
reservas começam em zero: `new BudgetLedger(rootId, record.limits, record.consumed,
ZERO_USAGE)` (`daemon/src/session-manager.ts:4156-4164`).

### A9. Grafo de delegação

`pathKey(agentId, objetivo) = "<agentId>:<objectiveHash>"` (`core/src/graph.ts:19-21`).
`checkDelegation` (`core/src/graph.ts:37-58`): `depth = pai.depth + 1`;
`depth > maxDepth` → `DEPTH_EXCEEDED`; `key` já presente em `parentPath` →
`CYCLE_DETECTED` (ciclo **semântico**: mesmo agente com o mesmo objetivo normalizado);
senão devolve `path = [...parentPath, key]`. Raiz: `depth 0`,
`path = [pathKey(agente, objetivo)]` (`daemon/src/session-manager.ts:453-460`), com
`maxDepth` da política do projeto.

`buildGraph` monta a árvore de uma lista plana; nó inalcançável (ciclo de
`parent_id`) vira raiz, o mais antigo primeiro, com a aresta de volta cortada; irmãos
ordenados por `startedAt` (`core/src/graph.ts:76-116`). `rollupCost` soma `usd` e
`tokens` da subárvore (`core/src/graph.ts:119-128`).

### A10. Resiliência

`classifyOutcome` (`core/src/resilience.ts:69-85`), em ordem:

1. `reason` `canceled` ou `interrupted` → `canceled`.
2. `timeout` ou `heartbeat` → `transient`.
3. Sem erro (`reason !== 'error'` e `exitCode` 0 ou null) → `success`.
4. Texto do erro casa cota → `quota`: `usage limit`, `\bquota\b`,
   `insufficient[_ ]quota`, `insufficient[_ ](credits?|balance|funds)`,
   `credit balance is too low`, `out of credits`, `limite de uso`
   (`core/src/resilience.ts:43-51`).
5. Casa taxa → `rate_limited`: `rate.?limit`, `\b429\b`, `too many requests`
   (`core/src/resilience.ts:53`).
6. Casa transitório → `transient`: `\b50[234]\b`, `overloaded`,
   `temporarily unavailable`, `timed? ?out`, `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`,
   `socket hang ?up`, `connection (reset|closed|refused)`,
   `stream (interrupted|closed)`, `wedged` (`core/src/resilience.ts:55-67`).
7. Senão → `permanent`.

`nextStep(estado, classe, config, origem?)` (`core/src/resilience.ts:112-180`):

- `success` e `canceled` → `give_up`.
- `attemptsHere` = tentativas do agente atual. Teto de retries = `maxRetries`, ou
  `min(maxRetries, 1)` se a origem foi `timeout`.
- `transient` ou `rate_limited` com `attemptsHere ≤ teto` → `retry` no mesmo agente com
  `backoffMs × 2^max(0, attemptsHere − 1)`.
- Senão, primeiro agente da cadeia que ainda não foi tentado → `fallback`. `quota` e
  `permanent` vão direto para cá.
- Sem candidato → `give_up`.

**Cadeia por capability** (daemon + registry): `fallbackFor` junta, na ordem das
`capabilities` do manifesto do agente que falhou, as cadeias de `policy.fallback` de
cada capability, sem o próprio agente, sem não registrados, sem repetição
(`adapters/src/registry.ts:223-230`); o daemon ainda remove quem o probe em cache diz
não instalado (`daemon/src/session-manager.ts:3204-3211`). Cadeias padrão
(`core/src/policy.ts:672-680`):

| Capability | Cadeia |
|---|---|
| `code-edit` | claude → codex → opencode → openclaude |
| `refactor` | claude → codex → opencode → openclaude |
| `test-writing` | claude → codex → opencode → openclaude |
| `code-review` | claude → codex → openclaude |
| `debug` | claude → codex → openclaude |
| `planning` | claude → codex |
| `shell` | codex → opencode → openclaude |

Aplicação no daemon: validação reprovada vira `transient` com tentativa marcada
`invalid` (`daemon/src/session-manager.ts:2950-2955`); retry relança com resume
nativo quando possível, senão o Brief + feedback
(`daemon/src/session-manager.ts:3004-3084`); fallback encerra a sessão como
`failed`, cria sessão substituta e move a task para ela, com
`failureContext(attempts)` anexado ao prompt (`daemon/src/session-manager.ts:3093-3201`).

Auxiliares: `failureContext` (`core/src/resilience.ts:188-208`), `closeLastAttempt`
(`success`→success, `invalid`→invalid, `canceled`→null, resto→error;
`core/src/resilience.ts:230-249`), `novaTentativa` (`core/src/resilience.ts:252-254`).

### A11. Workflow

`WorkflowSchema` (`core/src/workflow.ts:8-40`): `name` 1..200, `description?` ≤ 2.000,
`version` (padrão `1.0`), `steps` 1..200 (`MAX_WORKFLOW_STEPS`). Step: `id` 1..64
`[a-zA-Z0-9_-]`, `agent` 1..64, `objective` 1..50.000, `dependsOn`,
`acceptanceCriteria`, `constraints`, `budget {usd?, tokens?, seconds?}`,
`supervision?`, `isolation` (padrão `worktree`). Erro de schema → `ILLEGAL_STATE`
(`core/src/workflow.ts:46-54`).

`validateWorkflow` (`core/src/workflow.ts:65-133`): recusa id duplicado, dependência
inexistente e auto-referência; ordena por Kahn em lotes; ciclo → inválido.

`runWorkflow(workflow, lotes, deps, opções)` (`core/src/workflow.ts:266-460`):

1. Para cada lote, passo com dependência não `completed` vira `skipped`
   (`:292-317`).
2. Reparte o saldo (`budgetUsd − gasto`) **antes** de despachar: cabendo, cada um
   leva o pedido e os sem pedido dividem o resto; não cabendo, todos encolhem na
   proporção (`:322-324,471-495`). Teto ≤ 0 → `skipped` (`:332-347`).
3. `deps.start` com `upstream` (resumos das dependências concluídas) e
   `baseSessionIds` (sessões finais das dependências, só se `isolation: worktree`)
   (`:349-368,509-539`).
4. `CONCURRENCY_EXCEEDED` (checado pelo campo `code`) é retentado até 5 vezes
   adicionais com backoff `200 ms × 2^tentativa`; outro erro → `failed` (`:361-399`).
5. `deps.settle` espera o estado terminal; exceção → `failed` (`:409-419`).
6. O lote inteiro termina antes do próximo (`Promise.all`, `:328`).
7. `ok` = todos `completed`; passo não alcançado → `skipped` (`:441-459`).

Estados de passo: `completed`, `failed`, `skipped`, `blocked`, `timeout`
(`core/src/workflow.ts:161-169`).

### A12. Custo de turno e preços

`TurnCostTracker` (`core/src/turn-cost.ts:30-121`):

- Custo sem `provisional` → `{kind:'final', cost}` sem as marcas; fecha o turno
  (`:47-51`).
- `provisional + cumulative` → acumulado = `max(anterior, usd)`; o mesmo para
  créditos (`:53-58`).
- `provisional` sem `cumulative` → guarda por `partId` (ou `#n` anônimo) (`:59-62`).
- `pending()`: soma tokens das partes; `usd` = `acumulado − base` se houver
  acumulado, senão soma dos `usd` das partes (`:67-96`).
- `flush()` devolve a estimativa aberta e fecha o turno (`:99-103`). Fechar move a
  base para o último acumulado (`:114-120`).

`usoDoCusto(cost)` = `{usd, tokens: input + output, seconds: 0}`
(`core/src/turn-cost.ts:124-130`).

Preços (`core/src/pricing.ts`):

- `PRICING_COLLECTED_AT = '2026-09-26'` (`:35`); `COPILOT_USD_PER_AI_CREDIT = 0.01`
  (`:45`).
- `cacheAccounting`: `disjoint` (entrada exclui cache; Anthropic) ou `subset` (cache
  dentro da entrada) (`:57`).
- `normalizeModelId`: minúsculas, último segmento após `/`, remove prefixos
  `us. eu. apac. global. anthropic. openai. google. xiaomi. moonshotai. moonshot.
  azure. bedrock. vertex.` em laço, sufixo `[...]`, sufixo `:N`, troca `@ _ .` por `-`,
  colapsa hífens (`:1120-1149`).
- Casamento por alias, do mais longo ao mais curto; igual ou prefixo `alias-`; exato
  se o resto casa `SUFIXO_NEUTRO` (`-\d{2,8}`, `-v\d+`, `-latest`, `-preview`, `-exp`)
  (`:1153-1184`).
- `priceUsage`: em `subset`, `cached = min(cached, input)`,
  `written = min(written, input − cached)`, cobrável = `input − cached − written`;
  USD = (cobrável × entrada + saída × saída + cached × leitura de cache + written ×
  (escrita de cache ?? entrada)) / 1.000.000 (`:1191-1216`).
- `estimateTokenCost`: modelo casado → `estimated` com `model`/`family`; senão modelo
  padrão do agente (`AGENT_FALLBACK_MODEL`) → `agent-default`; senão `unknown`, usd 0
  (`:1225-1250`).
- `resolveEventCost`: `usd` reportado > 0 ganha (`reported`/`exact`); `usd: 0` não
  conta como reportado (`:1260-1272`).
- `combineCostEstimates`: vazio → 0 `reported`; parte desconhecida → `partial`;
  senão a pior confiança (`:1282-1308`).

`AGENT_FALLBACK_MODEL` (`core/src/pricing.ts:1036-1049`): claude →
`claude-opus-5-5`, codex → `gpt-6-sol`, antigravity → `gemini-3-1-pro`, kimi →
`kimi-k2-7-code`, mimo → `mimo-v2-6-pro`, cursor → `cursor-composer-2-5`. Sem entrada
para copilot e opencode.

A tabela `MODEL_PRICES` tem **70 modelos** (`core/src/pricing.ts:105-1023`); ver o
Apêndice.

### A13. Ambiente do projeto para o agente (`agent-env`)

`filtrarEnvDeProjeto` aceita só string, com nome (após `trim`) que comece com
`OPENAI_`, `ANTHROPIC_`, `AZURE_OPENAI_`, `OLLAMA_`, `GOOGLE_`, `GEMINI_`, `MISTRAL_`,
`GROQ_`, `TOGETHER_`, `OPENROUTER_`, `DEEPSEEK_`, `MOONSHOT_`, `LMSTUDIO_`, `VLLM_`, ou
seja exatamente `MODEL` ou `MODEL_BASE_URL`. O resto vai para `recusadas`
(`core/src/agent-env.ts:52-104`). `AGENTS_HUB_` fica fora de propósito
(`core/src/agent-env.ts:48-51`).

Variáveis que cada CLI comprovadamente lê (`core/src/agent-env.ts:139-169`):

| Agente | baseUrl | apiKey | model |
|---|---|---|---|
| claude, openclaude | `ANTHROPIC_BASE_URL` | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` |
| antigravity | `GOOGLE_GEMINI_BASE_URL` | `GEMINI_API_KEY` | `GEMINI_MODEL` |
| codex, opencode | `OPENAI_BASE_URL` | `OPENAI_API_KEY` | — |
| kimi | — | `MOONSHOT_API_KEY` | — |
| copilot, cursor, mimo | — | — | — |

O filtro é aplicado na leitura do YAML do repositório
(`daemon/src/project-config.ts:348-356`), na limpeza do contexto do Hub
(`daemon/src/repo-trust.ts:184-189`) e de novo na fusão repositório + Hub, onde o Hub
vence variável a variável (`daemon/src/repo-trust.ts:213-221`). O repositório só
entra se o projeto estiver confiável (`daemon/src/repo-trust.ts:226-233`).

---

## Parte B — `packages/adapters`

### B1. Contrato do adapter

`AgentAdapter` (`adapters/src/types.ts:321-329`):

| Método | Contrato |
|---|---|
| `manifest` | manifesto validado |
| `probe()` | `ProbeResult {agentId, installed, version, authenticated (sempre null no processo), binPath, error, checkedAt}` (`:239-248`) |
| `start(ctx, prompt)` | nova execução → `RunHandle` |
| `resume(ctx, nativeSessionId, prompt)` | continua a sessão nativa → `RunHandle` |
| `send(handle, text)` | mensagem numa run viva (só se `supportsLiveSend`) |
| `interrupt(handle)` | para o **turno**; desfecho `reason: 'interrupted'` |
| `cancel(handle)` | mata a run; desfecho `reason: 'canceled'` |

`RunContext` (`adapters/src/types.ts:250-274`): `sessionId`, `taskId`, `agentId`,
`workdir`, `mode`, `env`, `timeoutSeconds`, `heartbeatSeconds`, `model?`,
`extraArgs?`, `settingsFile?`.

`RunHandle` (`adapters/src/types.ts:288-308`): `id` (`run_…`), `sessionId`,
`agentId`, `nativeSessionId` (preenchido quando o agente revela), `startedAt`,
`done: Promise<RunOutcome>`, `events: AsyncIterable<MappedEvent>`,
`supportsLiveSend`, `pid` (processo real; sempre `null` no OpenCode).

`RunOutcome` (`adapters/src/types.ts:310-319`): `exitCode`, `signal`,
`reason: exit | timeout | heartbeat | canceled | interrupted | error`, `error`,
`nativeSessionId`, `tail`.

`MappedEvent` (`adapters/src/types.ts:277-284`): `type`, `payload`, `cost?`,
`nativeSessionId?`, `raw`. `EventMapper = (line: unknown) => MappedEvent[]`
(`adapters/src/types.ts:286`).

### B2. Manifestos

#### Schema (`AgentManifestSchema`, `adapters/src/types.ts:63-235`)

| Campo | Tipo | Padrão |
|---|---|---|
| `id`, `name`, `bin` | string ≥ 1 | obrigatórios |
| `vendor` | string | `desconhecido` |
| `description` | string | `''` |
| `detect.args` | string[] | `['--version']` |
| `detect.versionRegex` | string | `(\d+\.\d+\.\d+)` |
| `detect.timeoutMs` | inteiro > 0 | 45.000 |
| `invoke.oneShot` | string[] ≥ 1 | obrigatório |
| `invoke.resume` | string[] | opcional |
| `invoke.stdinPrompt` | boolean | `false` |
| `invoke.interactive` | boolean | `false` |
| `invoke.env` | `Record<string,string>` | `{}` |
| `invoke.extraArgs` | string[] | `[]` |
| `invoke.modeArgs.{supervised,semi,autonomous}` | string[] | `[]` |
| `invoke.resumeModeArgs` | idem, opcional | ausente → usa `modeArgs` |
| `model.supported` / `model.args` / `model.format` | boolean / string[] / string | `false` / `[]` / `''` |
| `gate.settingsArgs` | string[] | `[]` |
| `verified.status` | `verified \| partial \| unverified` | `unverified` |
| `verified.version` / `date` / `notes` | string\|null / string / string | `null` / `''` / `''` |
| `session.strategy` | `native \| replay \| none` | `replay` |
| `session.nativeSessionMissing` | regex[] (precisam compilar) | `[]` |
| `stream.format` | `jsonl \| text` | `text` |
| `stream.mapper` | nome de mapper | `generic-text` |
| `capabilities` | string[] | `[]` |
| `auth.mode` | literal `inherit` | `inherit` |
| `auth.loginHint` | string | `''` |
| `defaults.isolation` | `none \| worktree \| container` | `worktree` |
| `defaults.timeoutSeconds` | inteiro > 0 | 1800 |
| `defaults.supervision` | modo | `semi` |
| `caveats` | string[] | `[]` |

Validações extras: `model.supported: true` exige `{{model}}` em `model.args`, e
`model.args` só vale com `supported: true` (`adapters/src/types.ts:24-38`);
`gate.settingsArgs` não vazio exige `{{settingsFile}}` (`adapters/src/types.ts:169-176`);
cada `nativeSessionMissing` precisa compilar como regex `i`
(`adapters/src/types.ts:5-12,196-202`).

Carga: `loadManifestDir` lê `*.yaml`/`*.yml` em ordem alfabética; manifesto inválido
→ `ILLEGAL_STATE` com `issues` (`adapters/src/registry.ts:14-32`).

#### Placeholders

Aplicados por `applyTemplate` com `/\{\{(\w+)\}\}/g`; chave desconhecida vira `''`, e
argumento que fica vazio é **removido** (`adapters/src/process-adapter.ts:632-639,660-663,706-708`).

| Placeholder | Valor | Uso nos manifestos |
|---|---|---|
| `{{prompt}}` | o prompt, **só** se não for stdin nem arquivo; senão `''` | copilot, kimi, antigravity (6 ocorrências) |
| `{{promptFile}}` | caminho do arquivo do prompt | nenhum manifesto |
| `{{nativeSessionId}}` | id nativo, ou `''` | 9 ocorrências (resume) |
| `{{workdir}}` | `ctx.workdir` | nenhum manifesto |
| `{{model}}` | modelo validado, ou `''` | 8 manifestos (todos menos cursor) |
| `{{settingsFile}}` | `ctx.settingsFile`, ou `''` | claude, openclaude |

#### `session.strategy`

- `native`: `resume` do adapter de processo só funciona com `strategy: native` **e**
  `invoke.resume` definido; senão lança `ADAPTER_FAILURE`
  (`adapters/src/process-adapter.ts:120-130`). O daemon só retoma com
  `nativeSessionId` conhecido (`daemon/src/session-manager.ts:1519,3066-3068`).
- Sem resume possível, o `send` usa **replay**: `rebuildConversation` com Brief +
  histórico recente + mensagem, enviado como execução nova
  (`daemon/src/session-manager.ts:1527-1532`).
- `none`: `pause`/`interrupt` são recusados com `ILLEGAL_STATE`
  (`daemon/src/session-manager.ts:1619-1626`).
- `nativeSessionMissing`: se o resume sai com código ≠ 0, com id nativo, e o stderr ou
  o motivo casam um padrão, o daemon zera o id nativo e refaz o mesmo turno em replay
  uma vez (`adapters/src/failure-reason.ts:84-93`;
  `daemon/src/session-manager.ts:2635-2694`).

Todos os 9 manifestos usam `strategy: native`.

#### Os 9 manifestos (conferido pelo schema real; executado)

| id | bin | stream / mapper | prompt | modo supervised / semi / autonomous | modelo | gate | defaults.supervision | verified | capabilities | Fonte |
|---|---|---|---|---|---|---|---|---|---|---|
| claude | `claude` | jsonl / claude | stdin | `--permission-mode plan` / `acceptEdits` / `acceptEdits` | `--model {{model}}` | `--settings {{settingsFile}}` | semi | verified 2.1.283 | code-edit, refactor, test-writing, code-review, debug, shell, planning, long-context | `manifests/claude.yaml:14-92` |
| codex | `codex` | jsonl / codex | stdin (`-`) | `-c sandbox_mode="read-only"` / `"workspace-write"` / `"workspace-write"` | `-m {{model}}` | — (injetado pelo daemon) | semi | verified 0.155.0 | code-edit, refactor, test-writing, code-review, debug, shell, planning | `manifests/codex.yaml:15-94` |
| copilot | `copilot` | jsonl / copilot | argv `-p {{prompt}}` | `--mode plan` / `--allow-all-tools` / `--allow-all-tools` | `--model {{model}}` | — | supervised | verified 1.0.88 | code-edit, shell, github | `manifests/copilot.yaml:14-92` |
| kimi | `kimi` | jsonl / kimi | argv `-p {{prompt}}` | `--agent plan` / — / —; resume: nada | `-m {{model}}` | — | supervised | verified 2.0.0 | code-edit, refactor, shell, swarm | `manifests/kimi.yaml:14-79` |
| antigravity | `agy` | jsonl / antigravity | argv `-p={{prompt}}` | `--mode plan` / `--mode accept-edits` / `--mode accept-edits` | `--model {{model}}` | — | supervised | verified 1.2.10 | code-edit, refactor, browser, multi-agent | `manifests/antigravity.yaml:14-75` |
| mimo | `mimo` | jsonl / generic-json | stdin | — / — / `--yolo` | `-m {{model}}` | — | supervised | verified 0.1.14 | code-edit, test-writing, shell, low-cost | `manifests/mimo.yaml:15-82` |
| openclaude | `openclaude` | jsonl / claude | stdin | igual ao claude | `--model {{model}}` | `--settings {{settingsFile}}` | semi | verified 0.14.0 | code-edit, refactor, test-writing, code-review, debug, shell, multi-provider | `manifests/openclaude.yaml:17-91` |
| cursor | `cursor-agent` | jsonl / generic-json | stdin | — / — / — | não suportado | — | semi | **unverified** | code-edit, refactor, debug, shell | `manifests/cursor.yaml:14-56` |
| opencode | `opencode` | text / generic-text | stdin | — (modo via agentes `hub-*`, B8) | `-m {{model}}` (só fallback de processo) | — | semi | partial 1.18.32 | code-edit, refactor, test-writing, shell, local-models | `manifests/opencode.yaml:18-84` |

`nativeSessionMissing` só em claude e openclaude:
`["No conversation found with session ID"]` (`manifests/claude.yaml:69`,
`manifests/openclaude.yaml:68`). Todos têm `defaults.isolation: worktree` e
`timeoutSeconds: 1800`.

#### Argv efetivo (executado, `montarInvocacao`)

Linha 1 de cada agente: `supervised`, `oneShot`, sem modelo nem settings. Linha 2:
`semi`, `resume` com id `NID`, modelo `MODELO` e, para quem tem `gate.settingsArgs`,
`settingsFile = SETTINGS.json`. O binário não entra no argv.

| Agente | Entrega | argv |
|---|---|---|
| antigravity | argv | `--output-format stream-json -p=PROMPT --mode plan` |
| antigravity | argv | `--conversation NID --output-format stream-json -p=PROMPT --model MODELO --mode accept-edits` |
| claude | stdin | `-p --output-format stream-json --verbose --permission-mode plan` |
| claude | stdin | `-p --resume NID --output-format stream-json --verbose --model MODELO --permission-mode acceptEdits --settings SETTINGS.json` |
| codex | stdin | `exec --json --skip-git-repo-check - -c sandbox_mode="read-only"` |
| codex | stdin | `exec resume NID --json --skip-git-repo-check - -m MODELO -c sandbox_mode="workspace-write"` |
| copilot | argv | `-p PROMPT --output-format json --no-color --mode plan` |
| copilot | argv | `-p PROMPT --resume NID --output-format json --no-color --model MODELO --allow-all-tools` |
| cursor | stdin | `-p --output-format stream-json` |
| cursor | stdin | `--resume NID -p --output-format stream-json` |
| kimi | argv | `-p PROMPT --output-format stream-json --agent plan` |
| kimi | argv | `-p PROMPT --session NID --output-format stream-json -m MODELO` |
| mimo | stdin | `run --format json` |
| mimo | stdin | `run --session NID --format json -m MODELO` |
| openclaude | stdin | `-p --output-format stream-json --verbose --permission-mode plan` |
| openclaude | stdin | `-p --resume NID --output-format stream-json --verbose --model MODELO --permission-mode acceptEdits --settings SETTINGS.json` |
| opencode | stdin | `run` |
| opencode | stdin | `run --session NID -m MODELO` |

Ordem de montagem: template → `model.args` (só com modelo) → `modeArgs` do modo
(`resumeModeArgs` quando há id nativo e o campo existe) → `invoke.extraArgs` →
`ctx.extraArgs` → `gate.settingsArgs` (só com `settingsFile`)
(`adapters/src/process-adapter.ts:646-659`). No daemon, a sessão de claude/openclaude
sempre recebe `settingsFile` (B10), inclusive em `supervised`.

### B3. Registry

- `register` cria um `ProcessAgentAdapter` por manifesto; id duplicado →
  `ILLEGAL_STATE` (`adapters/src/registry.ts:66-75`). `registerAdapter` substitui
  (usado pelo OpenCode, `daemon/src/hub.ts:82-89`).
- `probeAll(force, concorrência = 2)`: em lotes de 2; `force` limpa o cache de
  binários (`adapters/src/registry.ts:112-127`). Cache de probe em arquivo
  (`<home>/probes.json`, `daemon/src/hub.ts:75-77`) com validade de 24 h para
  instalado e 5 min para não instalado (`adapters/src/registry.ts:48,141-146`).
- `resolveTarget(alvo, cadeias)`: id direto precisa estar registrado
  (`AGENT_NOT_FOUND`); `cap:<x>` percorre a cadeia de fallback de `x` e depois os
  manifestos que declaram `x`, e devolve o primeiro sem probe ou com probe instalado;
  nenhum → `CAPABILITY_UNRESOLVED` (`adapters/src/registry.ts:185-220`).

### B4. `ProcessAgentAdapter` (genérico)

Um processo headless por turno, dirigido pelo manifesto
(`adapters/src/process-adapter.ts:56-71`).

**Probe** (`adapters/src/process-adapter.ts:73-114`): resolve o binário; roda
`detect.args` com stdin fechado, env `{...process.env, ...invoke.env}` e timeout
`detect.timeoutMs` (`:728-763`); versão = 1º grupo de `versionRegex` ou a 1ª linha da
saída; `authenticated: null`.

**Spawn** (`adapters/src/process-adapter.ts:197-568`):

1. Binário não achado → `AGENT_NOT_INSTALLED` (`:203-210`).
2. Valida o modelo antes de gravar o prompt (`:220`). Se o template usa
   `{{promptFile}}`, grava o prompt em `<tmpdir>/agents-hub/prompts/<sessionId>-<ms>.md`
   (`:221,591-597`), apagado no `settle` (`:368-374`).
3. `montarInvocacao` e `montarSpawn`; falha do `montarSpawn` → `ADAPTER_FAILURE`
   (`:223-247`).
4. `spawn(file, args, {cwd: workdir, env, shell: false, windowsVerbatimArguments,
   windowsHide: true, stdio: pipe×3, ...opcoesDeGrupo()})` (`:258-268`).
5. Heartbeat (`heartbeatSeconds`) e teto geral (`timeoutSeconds`) são **rearmados a
   cada linha** de stdout/stderr e durante a pausa por backpressure (`touch`). Estouro
   → desfecho `heartbeat`/`timeout` e árvore morta (`:404-445`).
6. Fila: `HIGH = 1000` pausa o stdout, `LOW = 200` retoma, `HARD_CAP = 5000` encerra a
   run com `error` "fila de eventos saturada". Em pausa, um intervalo de
   `max(250 ms, heartbeat/3)` mantém a run viva enquanto o consumidor anda; sem
   progresso por `heartbeatSeconds`, satura (`:36-38,281-326,457-481`).
7. stdout: cada linha (teto de 16 MiB, B4.1) vira eventos pelo mapper; o primeiro
   `nativeSessionId` visto fica no handle; mensagens de eventos `error` guardadas
   (até 20) (`:486-501`).
8. stderr: cada linha não vazia vira `log {stream:'stderr', text}` e entra no `tail`
   (até 200 linhas) (`:504-510`).
9. `error` do processo → evento `error` e desfecho `error` (`:512-522`). `close` →
   `reason` = `canceled` / `interrupted` / `exit`; `error` = null se código 0,
   cancelado ou interrompido, senão `motivoDaFalha` (`:524-536`).
10. Prompt por stdin: escreve o prompt; falha de escrita → desfecho `error` e árvore
    morta; fecha o stdin se não for `interactive`. Sem stdin e não interativo, fecha o
    stdin logo (`:539-564`).

**Linha → eventos** (`adapters/src/process-adapter.ts:570-588`): `format: text` passa
a linha crua ao mapper. `jsonl`: linha vazia some; linha que não começa com `{` ou `[`
→ `log {stream:'stdout', text}`; JSON inválido →
`log {stream:'stdout', text, unparsed: true}`.

**`motivoDaFalha`** (`adapters/src/failure-reason.ts:60-71`): prefere a última
mensagem de evento `error` do agente; depois a última linha do stderr que pareça erro
e não aviso; depois a última linha útil que não seja aviso; texto
`processo terminou com código N: <motivo>` (cortado em 2.000) ou "(o agente não emitiu
mensagem de erro; ...)". Padrões de aviso e erro: `adapters/src/failure-reason.ts:35-38`.

**`send`**: só com `invoke.interactive: true` (nenhum manifesto usa); escreve
`texto\n` no stdin; senão `ADAPTER_FAILURE` (`adapters/src/process-adapter.ts:137-149`).

**`interrupt`**: Windows → mata a árvore direto; POSIX → `SIGINT`, e mata a árvore
se não sair em 5 s (`adapters/src/process-adapter.ts:41,167-186`).

**`cancel`**: marca cancelado e espera a árvore morrer
(`adapters/src/process-adapter.ts:188-195`).

**`modeloDaRun`** (`adapters/src/process-adapter.ts:687-704`): `ctx.model` ou
`ctx.env.MODEL`, com `trim`; vazio ou `model.supported: false` → sem modelo. Começar
com `-`, ter caractere de controle ou passar de 200 → `ADAPTER_FAILURE`.

#### B4.1 Leitor de linhas

`lerLinhas` (`adapters/src/line-reader.ts:37-102`): quebra em `\n` sobre bytes; remove
`\r` final; `\r` solto também quebra linha; linha acima de 16 MiB (`MAX_LINE_BYTES`)
é cortada e recebe ` [truncado N bytes]` (`adapters/src/line-reader.ts:17-22`);
emite a última linha no `end`.

### B5. Resolução de binário e passagem do prompt

**Cache** (`adapters/src/bin-resolver.ts:75-103`): positivo vale enquanto o arquivo
existir; negativo vale 30 s (`BIN_CACHE_NEGATIVO_MS`); `clearBinCache` zera.

**Windows** (`adapters/src/bin-resolver.ts:111-134,164-192`):

1. Varre `PATH` × `PATHEXT` (lidos sem diferenciar maiúsculas; padrão
   `.COM;.EXE;.BAT;.CMD`), na ordem do PATH, testando o nome exato e depois
   `nome + extensão minúscula`; só arquivos; sem duplicar (comparação minúscula). O
   diretório corrente **não** entra. Nome absoluto testa só ele.
2. Entre os achados: primeiro `.exe`, depois `.cmd`/`.bat`, depois o primeiro.
3. Nada no PATH → fallbacks fixos: `%LOCALAPPDATA%\agy\bin\<bin>.exe`,
   `%LOCALAPPDATA%\Programs\<bin>\<bin>.exe`, `~\.local\bin\<bin>.exe`,
   `~\.kimi-code\bin\<bin>.exe`, `%APPDATA%\npm\<bin>.cmd`
   (`adapters/src/bin-resolver.ts:194-209`).

**POSIX**: `which <bin>`, primeira linha não vazia (`adapters/src/bin-resolver.ts:136-145`).

**Desembrulho do shim npm** (`adapters/src/bin-resolver.ts:268-336`): para `.cmd`/`.bat`,
lê a linha que contém `%*`, pega o último caminho `"%dp0%\..."` (ou `"%~dp0\..."`)
antes dele. Alvo `.exe`/`.com` (que não seja `node.exe`) → spawna o alvo. Script → só
se o interpretador for `node` (via `SET "_prog=..."` ou literal); spawna o
`node.exe` ao lado do shim, ou o `node` do próprio daemon, com o script como 1º
argumento. Não reconhecido → `needsShell: true`.

**`montarSpawn`** (`adapters/src/bin-resolver.ts:409-434`), ponto único de spawn de
agente (run, probe, `opencode serve`):

- Sem shell: `spawn(file ?? path, [...prefixArgs, ...args])`, `shell: false`.
- `.cmd`/`.bat` não reconhecido: `%ComSpec%` (ou `cmd.exe`) com
  `['/d','/s','/c','"<linha>"']` e `windowsVerbatimArguments: true`. Cada argumento
  passa por `escaparArgParaCmd`: aspas pela regra do `CommandLineToArgvW` e `^` antes
  de cada metacaractere `( ) [ ] % ! ^ " \` < > & | ; , espaço * ?`, **duas vezes**
  (`adapters/src/bin-resolver.ts:347,366-386`). Argumento com `\r`, `\n` ou NUL →
  erro. Linha + 16 > 8.191 (`CMD_MAX_LINHA`) → erro. O erro vira `ADAPTER_FAILURE` no
  spawn (`adapters/src/process-adapter.ts:237-247`).

**Riscos do `.cmd`** registrados no código (`adapters/src/bin-resolver.ts:258-267`):
pelo `cmd.exe`, `&`, `|`, `>` e `%VAR%` no prompt viram comando, quebra de linha
trunca o Brief, 8.191 caracteres é o teto e CJK/emoji viram `?`. Mitigações: prompt
por stdin nos manifestos que aceitam; desembrulho do shim; escape duplo; recusa de
multilinha. `quoteForShell` (aspas `CommandLineToArgvW` só no Windows e só se houver
espaço ou aspas) continua exportado (`adapters/src/bin-resolver.ts:232-252`).

Entrega do prompt por agente: stdin em claude, codex, mimo, openclaude, cursor,
opencode; argv em copilot, kimi, antigravity (tabela B2). `montarInvocacao` devolve
`entrega` = `stdin`, `promptFile`, `argv` (template com `{{prompt}}`) ou `nenhuma`
(`adapters/src/process-adapter.ts:600,665-672`).

### B6. Árvore de processos

`killProcessTree(pid, fallback)` (`adapters/src/process-tree.ts:45-86`):

- **Windows**: `taskkill /pid <pid> /T /F`; se `taskkill` não abrir, chama o
  fallback (`child.kill('SIGKILL')`); resolve no `exit` ou em 5 s.
- **POSIX**: pid inválido ou ≤ 1 → só o fallback. Senão, levanta a foto PID→PPID
  **antes** (Linux: `/proc/*/stat`; outros: `ps -A -o pid= -o ppid=`), manda
  `SIGKILL` ao grupo (`kill(-pid)`), depois a cada descendente, e espera todos sumirem
  (sondagem a cada 50 ms, teto 5 s) (`adapters/src/process-tree.ts:88-204`).
- `opcoesDeGrupo()`: POSIX `{detached: true}`; Windows `{}`
  (`adapters/src/process-tree.ts:214-216`).

Identidade de PID órfão (usada na reconciliação): `imagemDoProcesso` via
`tasklist /FI "PID eq <pid>" /FO CSV /NH`, `/proc/<pid>/cmdline` ou `ps -p <pid> -o comm=`
(`adapters/src/process-tree.ts:231-278`); `imagemPareceEsperada` aceita o nome do
`bin`, o executável spawnado ou `cmd`/`sh`/`bash` (`adapters/src/process-tree.ts:303-312`);
`pidPareceReciclado`: processo criado mais de 5 s depois da referência
(`adapters/src/process-tree.ts:323,468-473`); horário de criação via PowerShell
`Get-Process`, `/proc/<pid>/stat` + `btime`, ou `ps -o lstart=`
(`adapters/src/process-tree.ts:341-455`).

### B7. Mappers

Registro: `antigravity`, `claude`, `codex`, `copilot`, `kimi`, `generic-json`,
`generic-text`; nome desconhecido lança erro (`adapters/src/mappers/index.ts:14-30`).
Auxiliares: `firstString` = string não vazia; `numberOf` = número finito
(`adapters/src/mappers/generic.ts:201-207`). Linha que não é objeto → `[]` em todos os
mappers JSON.

#### `claude` (também usado por openclaude) — `adapters/src/mappers/claude.ts`

| Entrada | Saída | Linhas |
|---|---|---|
| `type:system, subtype:init` | `session.started {subtype, tools, model}`; **só aqui** `session_id` vira id nativo | 21-41 |
| `type:system`, outro subtipo | `log {kind:'tecnico', subtype, text}` | 27-32 |
| `type:assistant`, bloco `text` não vazio | `message {text}` | 50-55 |
| bloco `thinking` não vazio | `reasoning {text}` | 56-64 |
| bloco `tool_use` | `Bash`/`PowerShell` → `command.executed` (+`command`); `Write`/`Edit`/`NotebookEdit` → `file.changed` (+`path` para Write/Edit); outros → `tool.call`. Payload `{tool, input, toolUseId}` | 65-76, 181-193 |
| `message.usage` | no **último** evento da linha: `{input, output, cached = cache_read_input_tokens, cacheWrite = cache_creation_input_tokens, provisional: true, partId: message.id}` | 84-95, 162-174 |
| `type:user` com `tool_result` | `tool.result {toolUseId, isError, content}` (string > 4.000 cortada) | 100-114, 195-198 |
| `type:result` | `turn.completed` se `subtype === 'success'` e não `is_error`; senão `error`. Payload `{subtype, summary: result, durationMs, numTurns}`. Custo **final** `{usd: total_cost_usd, tokens}`; `session_id` vira id nativo | 116-137 |
| `rate_limit_event` | `log {kind:'tecnico', text, rateLimit}` | 141-154 |
| outro | `log {data}` | 156-157 |

#### `codex` — `adapters/src/mappers/codex.ts`

| Entrada | Saída | Linhas |
|---|---|---|
| `thread.started` | `session.started {threadId}`; `thread_id` = id nativo | 18-27 |
| `turn.started` | `turn.started {}` | 29-30 |
| `turn.completed` | `turn.completed {summary}`, custo final `{input_tokens, output_tokens, cached_input_tokens}` (sem usd) | 32-46 |
| `turn.failed` | `error {message}` | 48-55 |
| `error` | `error {message}` | 57-64 |
| `item.started` / `item.updated` | `[]` | 67-71 |
| `item.completed`: `agent_message` / `reasoning` | `message` / `reasoning {text}` | 84-88 |
| `command_execution` | `command.executed {command, exitCode, output: aggregated_output, status}` | 90-102 |
| `file_change` | `file.changed {status, files[{path, kind}]}` | 104-119 |
| `mcp_tool_call` / `web_search` | `tool.call` | 121-131 |
| `todo_list` / outro item | `log` | 133-137 |
| outro tipo | `log {data}` | 74-75 |

#### `copilot` — `adapters/src/mappers/copilot.ts`

| Entrada (`type`) | Saída | Linhas |
|---|---|---|
| `session.auto_mode_resolved` | `log {text, model: chosenModel, reasoningBucket}` | 37-48 |
| `user.message` | `[]` (eco do prompt) | 50-52 |
| `assistant.turn_start` | `turn.started {turnId, model?}` | 54-63 |
| `assistant.message_delta` | `message.delta {text}` | 65-68 |
| `assistant.message` | `message {text, model?}` + um evento por `toolRequests[]` (nome com `bash/shell/terminal` → `command.executed`; `write/edit/create` → `file.changed`; senão `tool.call`); `outputTokens` (se existir) vira custo provisório no 1º evento com `partId` | 70-116, 213-231 |
| `session.usage_checkpoint` | `log`; custo `{usd: créditos × 0,01, credits, provisional, cumulative}` com créditos = `totalNanoAiu / 1e9` | 11, 127-147 |
| `assistant.reasoning` | `reasoning` se houver conteúdo | 149-153 |
| `assistant.turn_end` | `log {kind:'tecnico'}` | 158-169 |
| `result` | `turn.completed` se `exitCode === 0`, senão `error`; `sessionId` = id nativo | 172-192 |
| `error` | `error {message}` | 194-201 |
| outro | `ephemeral: true` → `[]`; senão `log {copilotType, data}` | 203-208 |

(executado) `totalNanoAiu: 529821900` → `usd 0.005298219`, `credits 0.5298219`.

#### `kimi` — `adapters/src/mappers/kimi.ts`

| Entrada | Saída | Linhas |
|---|---|---|
| `role:assistant` | `message {text}` + um evento por `tool_calls[]` (argumentos JSON decodificados; nome com `bash/shell/exec` → `command.executed`; `write/edit` → `file.changed`; senão `tool.call`) | 36-41, 174-202 |
| `role:user` | `[]` | 43-45 |
| `role:thinking`/`reasoning` | `reasoning` | 47-49 |
| `role:tool` com `tool_call_id` (formato 2.0.0) | `tool.result {callId, ok: true, content}` (> 4.000 cortado) | 51-63, 217-220 |
| `role:tool` com `name` (formato antigo) | chamada classificada | 65-78 |
| `role:meta` | `turn.step.retrying` → `log` de aviso legível; `system.version` → `log`; outro → `log {kimiType, text}`; `session_id` vira id nativo; `usage` vira custo | 81-82, 108-172 |
| `role:error` | `error {message}` | 84-85 |
| `type:goal.summary` | `log` | 88-100 |
| outro | `log {data}` | 103 |

O id nativo vem de `session.resume_hint` (`role:meta`), no fim da execução
(`adapters/src/mappers/kimi.ts:22-24`).

#### `antigravity` — `adapters/src/mappers/antigravity.ts`

| Entrada (`event`) | Saída | Linhas |
|---|---|---|
| `init` | `session.started {cwd, tools, permissionMode}`; `conversation_id` = id nativo | 20-34 |
| `step_update` `user_input` | `[]` | 41-44 |
| `step_update` `agent_response` | `message` (ou `reasoning` se `is_thinking`/`thought`); `usage` → custo provisório `partId: step:<índice>`; id nativo no 1º evento | 46-83 |
| `step_update` `error_message` ou `state: ERROR` | `error {message, stepIndex}` | 85-98 |
| `step_update` `tool_call`/`tool_use` | `run_command`/`bash`/`shell` → `command.executed`; `write_to_file`/`replace_file_content`/`sed_file`/`multi_replace_file_content` → `file.changed`; senão `tool.call` | 100-106, 166-210 |
| `step_update` `tool_result` | `tool.result {content, isError}` | 108-119 |
| outro `step_update` | `log {step}` | 121 |
| `result` | `turn.completed` ou `error` (status `ERROR` ou campo `error`); custo final só se houver `input_tokens` ou `output_tokens` | 124-159 |
| outro | `log {data}` | 161-162 |

#### `generic-json` (mimo, cursor) — `adapters/src/mappers/generic.ts:46-193`

Um evento por linha; string cai no `generic-text`. Envelope OpenCode (`part`
presente): `text` → `message`; `reasoning` → `reasoning`; `tool_use` → shell
(`bash`/`shell` com `command`) `command.executed`, escrita (`write`/`edit`/`patch` com
caminho) `file.changed`, senão `tool.call`; `step_start` → `turn.started`;
`step_finish` → `log` (`generic.ts:73-101,136-155`). `type:error` → `error` com a
primeira mensagem achada (`:103-114`). `message.content[]` com blocos `text` →
`message` (`:117-125`). Senão `text`/`message`/`content` string → `message`, ou
`log {data}` (`:127-132`). Id nativo: `sessionID`, `session_id` ou `sessionId` de
qualquer linha (`:56-58`). Custo: `part.tokens`/`tokens` → `{usd: part.cost ?? cost,
input, output + reasoning, cached = cache.read + cache.write}`; senão `usage`
(`input_tokens`/`prompt_tokens`/`inputTokens` e equivalentes de saída); sem
`provisional` (`:162-193`).

#### `generic-text` (opencode no fallback de processo) — `adapters/src/mappers/generic.ts:11-26`

Cada linha não vazia vira `message {text}`; vira `error` se contém `error:` ou
`fatal:` ou começa com `error ` (minúsculas).

### B8. `OpenCodeAdapter` (HTTP)

Substitui o adapter de processo do `opencode` no registry, com porta
`config.opencodePort` e `configDir = <home>/opencode-config`
(`daemon/src/hub.ts:82-89`); padrão da porta no daemon: 4790
(`daemon/src/config.ts:324`). Padrões do adapter: host `127.0.0.1`, porta 4790,
`autoStart: true` (`adapters/src/opencode/adapter.ts:129-135`).

| Operação | Comportamento | Fonte (`adapters/src/opencode/adapter.ts`) |
|---|---|---|
| `probe` | probe do binário; sem binário mas com `/api/health` ok → instalado sem versão | 146-155 |
| servidor | `GET /api/health` (timeout 2 s). Sem servidor e `autoStart`: `opencode serve --port <p> --hostname 127.0.0.1`, env `{...process.env, ...ctx.env, OPENCODE_CONFIG_DIR}`, stdio `ignore/ignore/pipe` (stderr drenado para o log), espera até 60 s. Boot concorrente compartilha a mesma promessa. Env diferente depois do boot só gera aviso no log | 563-722 |
| `start` | `POST /api/session {location:{directory: workdir}, agent, model?}`; sem `data.id` → `ADAPTER_FAILURE` | 157-175 |
| `resume` | `GET /api/session/{id}` (ausente → `SESSION_NOT_FOUND`); `POST .../model` se houver modelo; `POST .../agent` com o agente do modo | 177-209 |
| run | abre `GET /api/event` (SSE) **antes** do prompt; filtra por `sessionID`; depois `POST /api/session/{id}/prompt {prompt:{text}, delivery:'steer'}`; depois poll de `/api/session/active` a cada 1 s | 258-421 |
| fim do turno | evento `session.idle` ou `session.status` idle; ou 3 polls seguidos sem a sessão ativa **depois** de ela ter aparecido; 60 polls sem começar → `error`; poll falhou → `error` | 59-60, 83, 354-389, 498 |
| desfecho | `exit` com `exitCode 0`, ou 1 se algum evento `error` apareceu no turno; `heartbeat`/`timeout` como no processo (heartbeat rearmado a cada chunk SSE) | 302-342, 453 |
| `send` | `POST .../prompt` com `delivery: 'steer'` (`supportsLiveSend: true`) | 218-226 |
| `interrupt` | `POST /api/session/{id}/interrupt` (erro ignorado) | 229-234 |
| `cancel` | marca cancelado, `interrupt`, aborta o stream | 236-241 |
| `close` | derruba só o servidor que ele subiu (`killProcessTree`) | 244-254, 788-791 |
| fila | mesmos 1000/200/5000; o loop espera abaixo de 200 mantendo o heartbeat | 72-74, 467-469, 489-493, 818-834 |
| HTTP | timeout 30 s; resposta não-ok → `ADAPTER_FAILURE` com status | 733-755 |
| modelo | `provider/model` cortado na primeira `/`; sem `/` → `providerID: 'opencode'` | 764-768 |

**Modo → agente** (`adapters/src/opencode/permissions.ts:37-51`;
`adapters/src/opencode/adapter.ts:519-542`): pede `hub-supervised`, `hub-semi` ou
`hub-autonomous` se aparecerem em `GET /api/agent`; senão usa o nativo (`plan` em
supervised; `build` nos demais) e emite `log` de aviso na timeline.

**Config dos agentes `hub-*`** (`adapters/src/opencode/permissions.ts:132-188`),
gravada em `<configDir>/opencode.json` só quando muda:

| Permissão | hub-supervised | hub-semi | hub-autonomous |
|---|---|---|---|
| `*` | deny | allow | allow |
| `read` | `*` allow; `*.env`, `*.env.*`, `*/.ssh/*`, `*\.ssh\*` deny; `*.env.example` allow | igual | igual |
| `question`, `external_directory`, `doom_loop` | deny | deny | deny |
| `glob grep list lsp todoread todowrite` | allow | (via `*`) | (via `*`) |
| `edit` | deny | allow, exceto `.env*`, `.git/hooks`, `.github/workflows` (absoluto e relativo, `/` e `\`) | igual ao semi |
| `bash` | deny | allow, exceto 17 padrões irreversíveis (`*git push*`, `*git reset --hard*`, `*git stash drop*`, `*git stash clear*`, `*git clean -f*`, `*rm -rf*`, `*rm -fr*`, `*rm -r -f*`, `*Remove-Item*-Recurse*`, `*find *-delete*`, `*npm publish*`, `*pnpm publish*`, `*yarn publish*`, `*sudo *`, `*shutdown*`, `*mkfs*`, `*reg delete*`) | igual ao semi |
| `webfetch`, `websearch` | deny | (via `*`) | (via `*`) |
| `task` (subagentes) | deny | deny | allow |

Pedidos pendentes (`permission.v2.asked`, `permission.asked`, `question.asked`,
`question.v2.asked`) são recusados na hora (`POST .../permission/{id}/reply
{reply:'reject'}`, `/permission/{id}/reply` na v1, ou `.../question/{id}/reject`)
(`adapters/src/opencode/events.ts:94-124`; `adapters/src/opencode/adapter.ts:545-559`).

**Eventos SSE → Hub** (`adapters/src/opencode/events.ts:157-401`). O decodificador
junta blocos separados por linha em branco, ignora comentários `:` e faz `JSON.parse`
das linhas `data:` (`events.ts:15-55`). Ruído descartado: 17 tipos
(`events.ts:137-155`): `session.next.text.started`, `session.next.reasoning.started`,
`session.next.reasoning.delta`, `session.next.tool.input.started`,
`session.next.tool.input.delta`, `session.next.tool.input.ended`,
`session.next.tool.progress`, `session.next.context.updated`,
`session.next.compaction.started`, `session.next.compaction.delta`, `session.updated`,
`session.diff`, `message.updated`, `message.removed`, `message.part.updated`,
`message.part.delta`, `message.part.removed`. Qualquer evento com `sessionID` define o id nativo
(`events.ts:173-177`).

| Evento OpenCode | Evento Hub |
|---|---|
| `session.created` | `session.started` |
| `session.idle`, `session.status` idle | `session.ended {reason:'idle'}` |
| `session.status` busy | — |
| `session.status` outro | `log` |
| `session.error` | `error` |
| `session.next.prompt.admitted`, `session.next.prompted` | — |
| `session.next.agent.switched`, `.model.switched`, `.compaction.ended` | `log` |
| `session.next.step.started` | `turn.started` |
| `session.next.step.ended` | `file.changed` por arquivo + `log {kind:'tecnico'}` com o custo do passo |
| `session.next.step.failed` | `error` |
| `session.next.text.delta` | `message.delta` |
| `session.next.text.ended` | `message {role:'assistant'}` |
| `session.next.reasoning.ended` | `reasoning` |
| `session.next.tool.called` | `tool.call` |
| `session.next.tool.success` / `.failed` | `tool.result {ok: true/false}` |
| `session.next.shell.started` | `command.executed {kind:'shell'}` |
| `session.next.shell.ended` | `tool.result` |
| `command.executed` | `command.executed {kind:'slash'}` |
| `session.next.retried` | `log` de aviso |
| pedidos de permissão/pergunta | `log` de aviso ("recusado pelo Hub") |
| respostas de permissão/pergunta, `file.edited` | — |
| outro com `sessionID` | `log {opencodeType, data}` |

Custo do passo: `{usd: cost, input, output + reasoning, cached = cache.read +
cache.write}` sem `provisional` (`events.ts:409-429`).

### B9. Ambiente passado ao agente

| Processo | Env | Fonte |
|---|---|---|
| Run do `ProcessAgentAdapter` | `{...process.env do daemon, ...manifest.invoke.env, ...ctx.env, AGENTS_HUB_SESSION_ID, AGENTS_HUB_TASK_ID ('' se nulo), AGENTS_HUB_AGENT_ID}` | `adapters/src/process-adapter.ts:249-256` |
| Probe | `{...process.env, ...manifest.invoke.env}` | `adapters/src/process-adapter.ts:737` |
| `opencode serve` | `{...process.env, ...ctx.env da sessão que subiu o servidor, OPENCODE_CONFIG_DIR = <home>/opencode-config}`; sem `AGENTS_HUB_*` | `adapters/src/opencode/adapter.ts:644-648` |

`ctx.env` = `envForAgent(contexto efetivo do projeto, agentId)`, já filtrado pela lista
de A13 (`daemon/src/session-manager.ts:345-349`; `daemon/src/project-config.ts:458-460`).
Todos os 9 manifestos têm `invoke.env: {}`. `ctx.timeoutSeconds` =
`min(manifest.defaults.timeoutSeconds, config.policy.taskTimeoutSeconds)` e
`ctx.heartbeatSeconds = config.policy.heartbeatTimeoutSeconds`, ambos da política
**global** (`daemon/src/session-manager.ts:2200-2204`). `ctx.model` não é preenchido
em `#launch` (`daemon/src/session-manager.ts:2193-2206`); o modelo chega por
`MODEL` do env do projeto (B4).

### B10. Gate pré-execução por agente

O que o daemon injeta a cada spawn (`#launch`, `daemon/src/session-manager.ts:2191-2218`):

| Agente | Injeção | Condição | Fonte |
|---|---|---|---|
| claude, openclaude | `--settings <home>/run/<sessionId>-settings.json` (via `gate.settingsArgs`) | sempre que o manifesto declara `gate.settingsArgs`; falha ao gravar o arquivo impede o spawn | `daemon/src/session-manager.ts:2207-2208,2423-2430` |
| codex | `-c hooks={PreToolUse=[{matcher="*",hooks=[{type="command",command="<node> <cli bin.js> hook --dialect codex --session <id>",timeoutSec=120}]}]}` em `ctx.extraArgs`, mais `--dangerously-bypass-hook-trust` se `codexGate.bypassHookTrust` | sempre para `agentId === 'codex'` | `daemon/src/session-manager.ts:2387-2413`; `daemon/src/codex-gate.ts:162-205` |
| opencode | nenhum hook; o modo vira agente `hub-*` (B8) | — | `adapters/src/opencode/adapter.ts:519-542` |
| copilot, kimi, antigravity, mimo, cursor | nenhum; só vigilância reativa | — | `daemon/src/session-manager.ts:3317-3325` |

**Settings da sessão (Claude/OpenClaude)**. Conteúdo = `mergeHooks({}, comando)`
(`daemon/src/session-settings.ts:36-38`) (executado):

```json
{"hooks":{"PreToolUse":[{"matcher":"Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|WebFetch|Read|Grep","hooks":[{"type":"command","command":"\"<node>\" \"<cli bin.js>\" hook","timeout":120}]}]}}
```

Matcher: `daemon/src/hooks-config.ts:32-43`. Comando: `daemon/src/hooks-config.ts:115-117`,
com `<node> = process.execPath` e `<cli bin.js> = packages/cli/dist/bin.js` relativo ao
daemon (`daemon/src/config.ts:180-183`). Timeout 120 s = `TIMEOUT_DO_HOOK_SEC`
(`daemon/src/pretool-gate.ts:272`). O arquivo é regravado a cada `#launch`
(`daemon/src/session-settings.ts:45-55`) e apagado em `#finish` e na reconciliação
(`daemon/src/session-manager.ts:768,3684`).

**Codex**. `<node>` e `<cli bin.js>` passam por `segmentoDeComando`: no Windows, com
espaço, viram o nome curto 8.3 (`cmd.exe /d /c for %I in ("…") do @echo %~sI`), e só
ganham aspas se ainda tiverem espaço (`daemon/src/codex-gate.ts:120-153`). A string do
comando é escapada para TOML (`\` e `"`) (`daemon/src/codex-gate.ts:219-221`).
`codexGate.bypassHookTrust` vem só da config global e o padrão é `false`
(`daemon/src/config.ts:52-67,341-345`). Sem ele: args do hook vão, `garantido: false`
e aviso; em `supervised` (`modoExigeGate`) o lançamento falha com
`CODEX_GATE_NOT_GUARANTEED`; nos outros modos o aviso vira `log
{stream:'gate', level:'warn'}` (`daemon/src/codex-gate.ts:181-200,214-216`;
`daemon/src/session-manager.ts:2404-2412,2210-2218`). (executado) com bypass:
`["-c","hooks={PreToolUse=[{matcher=\"*\",hooks=[{type=\"command\",command=\"NODE CLI hook --dialect codex --session ses_X\",timeoutSec=120}]}]}","--dangerously-bypass-hook-trust"]`,
`garantido: true`.

**Cobertura usada pela vigilância** (`daemon/src/session-manager.ts:3317-3325`;
`adapters/src/guarded-actions.ts:87-104`): `hook-por-sessao` com as ferramentas do
matcher (Claude/OpenClaude); `codex-comandos` (só `command.executed`) com bypass
ligado; `nenhuma` no resto. Evento coberto pelo gate que bateria `pauseOn` vira só
alerta (`peloGate`), não pausa (`adapters/src/guarded-actions.ts:142-174`).

**Vigilância reativa** (todos): cada `command.executed` vira ação `command`; cada
`file.changed` vira `file.write` por arquivo, resolvido contra o workdir
(`adapters/src/guarded-actions.ts:17-38`); a primeira ação em `pauseOn` abre aprovação
`kind: 'watch'` e pausa; as de `flagOn` viram `log` de aviso
(`daemon/src/session-manager.ts:3327-3378`).

A resposta do hook (o que o CLI `hub hook` faz com a chamada) está fora deste
documento: mora em `packages/cli` e `daemon/src/pretool-gate.ts`.

---

## Apêndice — Tabela de preços (`MODEL_PRICES`)

Extraída executando `core/src/pricing.ts` (70 linhas, `:105-1023`). USD por milhão de
tokens. "—" = sem preço de escrita de cache (cobrado como entrada).

| id | vendor | entrada | saída | leitura cache | escrita cache | cache | aliases |
|---|---|---|---|---|---|---|---|
| claude-opus-5-5 | Anthropic | 4 | 20 | 0.2 | 5 | disjoint | claude-opus-5-5, claude-5-5-opus |
| claude-fable-5-1 | Anthropic | 10 | 50 | 0.25 | 12.5 | disjoint | claude-fable-5-1, fable-5-1, claude-mythos-5-1 |
| claude-fable-5 | Anthropic | 10 | 50 | 1 | 12.5 | disjoint | claude-fable-5, fable-5, claude-mythos-5 |
| claude-opus-5 | Anthropic | 5 | 25 | 0.5 | 6.25 | disjoint | claude-opus-5, claude-5-opus |
| claude-opus-4-8 | Anthropic | 5 | 25 | 0.5 | 6.25 | disjoint | claude-opus-4-8, claude-4-8-opus |
| claude-opus-4-7 | Anthropic | 5 | 25 | 0.5 | 6.25 | disjoint | claude-opus-4-7, claude-4-7-opus |
| claude-opus-4-6 | Anthropic | 5 | 25 | 0.5 | 6.25 | disjoint | claude-opus-4-6, claude-4-6-opus |
| claude-opus-4-5 | Anthropic | 5 | 25 | 0.5 | 6.25 | disjoint | claude-opus-4-5, claude-4-5-opus |
| claude-opus-4-1 | Anthropic | 15 | 75 | 1.5 | 18.75 | disjoint | claude-opus-4-1, claude-4-1-opus |
| claude-sonnet-5 | Anthropic | 2 | 10 | 0.2 | 2.5 | disjoint | claude-sonnet-5, claude-5-sonnet |
| claude-sonnet-4-6 | Anthropic | 3 | 15 | 0.3 | 3.75 | disjoint | claude-sonnet-4-6, claude-4-6-sonnet |
| claude-sonnet-4-5 | Anthropic | 3 | 15 | 0.3 | 3.75 | disjoint | claude-sonnet-4-5, claude-4-5-sonnet |
| claude-haiku-4-5 | Anthropic | 1 | 5 | 0.1 | 1.25 | disjoint | claude-haiku-4-5, claude-4-5-haiku |
| claude-haiku-3-5 | Anthropic | 0.8 | 4 | 0.08 | 1 | disjoint | claude-haiku-3-5, claude-3-5-haiku |
| gpt-6-sol | OpenAI | 2 | 10 | 0.2 | 2.5 | subset | gpt-6-sol, gpt-6 |
| gpt-6-luna | OpenAI | 0.1 | 0.5 | 0.01 | 0.125 | subset | gpt-6-luna |
| gpt-6-astra | OpenAI | 10 | 50 | 1 | 12.5 | subset | gpt-6-astra |
| gpt-5-5-pro | OpenAI | 30 | 180 | 30 | — | subset | gpt-5-5-pro |
| gpt-5-4-pro | OpenAI | 30 | 180 | 30 | — | subset | gpt-5-4-pro |
| gpt-5-2-pro | OpenAI | 21 | 168 | 21 | — | subset | gpt-5-2-pro |
| gpt-5-pro | OpenAI | 15 | 120 | 15 | — | subset | gpt-5-pro |
| gpt-5-1-codex-max | OpenAI | 1.25 | 10 | 0.125 | — | subset | gpt-5-1-codex-max |
| gpt-5-1-codex | OpenAI | 1.25 | 10 | 0.125 | — | subset | gpt-5-1-codex |
| gpt-5-3-codex | OpenAI | 1.75 | 14 | 0.175 | — | subset | gpt-5-3-codex, gpt-5-3 |
| gpt-5-2-codex | OpenAI | 1.75 | 14 | 0.175 | — | subset | gpt-5-2-codex |
| gpt-5-codex | OpenAI | 1.25 | 10 | 0.125 | — | subset | gpt-5-codex |
| gpt-5-6-sol | OpenAI | 4 | 20 | 0.4 | 5 | subset | gpt-5-6-sol |
| gpt-5-6-terra | OpenAI | 2 | 12 | 0.2 | 2.5 | subset | gpt-5-6-terra, gpt-5-6 |
| gpt-5-6-luna | OpenAI | 0.2 | 1.2 | 0.02 | 0.25 | subset | gpt-5-6-luna |
| gpt-5-5 | OpenAI | 5 | 30 | 0.5 | — | subset | gpt-5-5 |
| gpt-5-4 | OpenAI | 2.5 | 15 | 0.25 | — | subset | gpt-5-4 |
| gpt-5-4-mini | OpenAI | 0.75 | 4.5 | 0.075 | — | subset | gpt-5-4-mini |
| gpt-5-4-nano | OpenAI | 0.2 | 1.25 | 0.02 | — | subset | gpt-5-4-nano |
| gpt-5-2 | OpenAI | 1.75 | 14 | 0.175 | — | subset | gpt-5-2 |
| gpt-5-1 | OpenAI | 1.25 | 10 | 0.125 | — | subset | gpt-5-1 |
| gpt-5-mini | OpenAI | 0.25 | 2 | 0.025 | — | subset | gpt-5-mini |
| gpt-5-nano | OpenAI | 0.05 | 0.4 | 0.005 | — | subset | gpt-5-nano |
| gpt-5 | OpenAI | 1.25 | 10 | 0.125 | — | subset | gpt-5 |
| gemini-3-1-pro | Google | 2 | 12 | 0.2 | — | subset | gemini-3-1-pro, gemini-3-pro |
| gemini-3-8-flash | Google | 0.75 | 3.75 | 0.075 | — | subset | gemini-3-8-flash |
| gemini-3-flash | Google | 0.5 | 3 | 0.05 | — | subset | gemini-3-flash |
| gemini-3-7-flash | Google | 0.75 | 3.75 | 0.075 | — | subset | gemini-3-7-flash |
| gemini-3-6-flash | Google | 0.75 | 3.75 | 0.075 | — | subset | gemini-3-6-flash |
| gemini-3-5-flash | Google | 1.5 | 9 | 0.15 | — | subset | gemini-3-5-flash |
| gemini-3-5-flash-lite | Google | 0.3 | 2.5 | 0.03 | — | subset | gemini-3-5-flash-lite |
| gemini-3-1-flash-lite | Google | 0.25 | 1.5 | 0.025 | — | subset | gemini-3-1-flash-lite |
| gemini-2-5-pro | Google | 1.25 | 10 | 0.125 | — | subset | gemini-2-5-pro |
| gemini-2-5-flash-lite | Google | 0.1 | 0.4 | 0.01 | — | subset | gemini-2-5-flash-lite |
| gemini-2-5-flash | Google | 0.3 | 2.5 | 0.03 | — | subset | gemini-2-5-flash |
| kimi-k3 | Moonshot AI | 3 | 15 | 0.3 | 3 | subset | kimi-k3, k3 |
| kimi-k2-7-code-highspeed | Moonshot AI | 1.9 | 8 | 0.38 | — | subset | kimi-k2-7-code-highspeed |
| kimi-k2-7-code | Moonshot AI | 0.95 | 4 | 0.19 | — | subset | kimi-k2-7-code, kimi-k2-7 |
| kimi-k2-6 | Moonshot AI | 0.95 | 4 | 0.16 | — | subset | kimi-k2-6 |
| kimi-k2-5 | Moonshot AI | 0.6 | 3 | 0.15 | — | subset | kimi-k2-5 |
| kimi-k2 | Moonshot AI | 0.6 | 2.5 | 0.15 | — | subset | kimi-k2 |
| mimo-v2-6-pro-ultraspeed | Xiaomi | 4.35 | 8.7 | 0.036 | — | subset | mimo-v2-6-pro-ultraspeed |
| mimo-v2-6-pro | Xiaomi | 0.435 | 0.87 | 0.0036 | — | subset | mimo-v2-6-pro |
| mimo-v2-6-flash | Xiaomi | 0.14 | 0.28 | 0.0028 | — | subset | mimo-v2-6-flash, mimo-v2-6 |
| mimo-v2-5-pro | Xiaomi | 0.435 | 0.87 | 0.0036 | — | subset | mimo-v2-5-pro |
| mimo-v2-5 | Xiaomi | 0.14 | 0.28 | 0.0028 | — | subset | mimo-v2-5 |
| cursor-composer-2-5 | Anysphere | 0.5 | 2.5 | 0.2 | — | subset | composer-2-5, cursor-composer-2-5 |
| cursor-composer-2-5-fast | Anysphere | 3 | 15 | 0.5 | — | subset | composer-2-5-fast, cursor-composer-2-5-fast |
| grok-4-7-500k-fast | xAI (via Cursor) | 6 | 18 | 1.5 | — | subset | grok-4-7-500k-fast |
| grok-4-7-500k | xAI (via Cursor) | 4 | 12 | 1 | — | subset | grok-4-7-500k |
| grok-4-7-fast | xAI (via Cursor) | 4 | 12 | 1 | — | subset | grok-4-7-fast |
| grok-4-7 | xAI (via Cursor) | 2 | 6 | 0.5 | — | subset | grok-4-7 |
| grok-4-6 | xAI (via Cursor) | 2 | 6 | 0.5 | — | subset | grok-4-6 |
| grok-4-6-fast | xAI (via Cursor) | 4 | 12 | 1 | — | subset | grok-4-6-fast |
| grok-4-5 | xAI (via Cursor) | 2 | 6 | 0.5 | — | subset | grok-4-5 |
| grok-4-5-fast | xAI (via Cursor) | 4 | 18 | 1 | — | subset | grok-4-5-fast |

---

## Observações e divergências encontradas

Registradas como estão; nenhuma foi corrigida.

1. **Estados de task sem uso.** `submitted` e `auth_required` existem no tipo e como
   rótulos do painel (`web/src/logic/operacao.ts:190,193`), mas nunca são escritos (A3).
2. **Reserva perdida ao recriar o ledger.** `#ledger` recria o `BudgetLedger` com
   reservas zeradas, embora `BudgetRecord.reserved` seja gravado
   (`daemon/src/session-manager.ts:4161,4294-4303`). Depois de um reinício do daemon,
   fatias de tasks em andamento não voltam.
3. **`defaults.isolation` do manifesto não tem efeito em `start`.** `BriefSchema`
   preenche `isolation: 'worktree'` por padrão (`core/src/brief.ts:103`), então
   `brief.isolation ?? manifest.defaults.isolation` sempre fica com o do Brief
   (`daemon/src/session-manager.ts:491`).
4. **Timeout e heartbeat da run vêm da política global**, não da efetiva do projeto
   (`daemon/src/session-manager.ts:2200-2204`), embora o clamp do projeto aceite esses
   campos.
5. **`intersect` herda do filho** `defaultBudget`, `retries` e `fallback`
   (`core/src/policy.ts:876-877`, spread `...child`). Não há `min` nesses campos.
6. **Comentários desatualizados** (não afetam comportamento):
   - `manifests/opencode.yaml:29` cita `process-adapter.ts:182` como o lugar que lê
     `modeArgs`; hoje é `adapters/src/process-adapter.ts:646-649`.
   - `adapters/src/opencode/adapter.ts:621-627` fala em `shell: true` e
     `quoteForShell`; o código usa `montarSpawn` com `shell: false` (`:651-661`).
   - `adapters/src/process-tree.ts:284-289` diz que o adapter spawna shims com
     `shell: true`; o spawn usa `shell: false` (`adapters/src/process-adapter.ts:258-268`).
7. **`{{promptFile}}` e `{{workdir}}`** são suportados e nenhum manifesto usa
   (grep em `manifests/*.yaml`).
8. **NÃO DETERMINADO:** como o hook do Claude/OpenClaude identifica a sessão do Hub.
   O processo do agente recebe `AGENTS_HUB_SESSION_ID`
   (`adapters/src/process-adapter.ts:253`), mas o que o comando `hub hook` lê está em
   `packages/cli` e `daemon/src/pretool-gate.ts`, fora do escopo lido aqui.
9. **NÃO DETERMINADO:** o comportamento do `retry` quando a reserva de vaga falha. A
   task vai para `failed` (`daemon/src/session-manager.ts:3038`), mas a sessão não é
   encerrada nesse ramo. O estado final da sessão depende de código não lido nesta
   tarefa.

## Fora deste documento

Não cobertos aqui: `core/src/conversation.ts` (montagem do prompt de replay),
`core/src/folders.ts`, `core/src/policy-edit.ts`, `core/src/audit.ts`,
`core/src/operator-token.ts`, `core/src/hub-env.ts`, `core/src/discovery.ts` e
`adapters/src/discovery/*` (descoberta de config dos CLIs).
