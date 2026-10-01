# Corpus de conformidade — domínio (CONF-03)

Casos de entrada → saída esperada do **domínio** do Agents-Hub (política, orçamento,
grafo de delegação, Brief, resiliência, preços/custo de turno, `objectiveHash`, ids),
gerados executando as funções reais do TS congelado (`packages/`, ADR 7.10). O C é
comparado a estes arquivos. Referência de comportamento: SPEC-04, parte A
([04-dominio-e-adapters.md](../../../../docs/especificacao/04-dominio-e-adapters.md)).

Nenhum arquivo deste diretório é escrito à mão, exceto este README. Para mudar um caso,
mude o gerador e regenere.

## Origem

| Item | Valor |
|---|---|
| Commit do TS | `c3ecbee83749e2d8637f30501a91679354164c0c` (`main`; `packages/` e `manifests/` sem alteração local) |
| Último commit que tocou os fontes lidos | `7233374779ba6b038a1e2a6034247650c3086758` |
| Node | com `--experimental-transform-types` (a geração registrada usou 24.14.0; a versão não entra no `meta.json`) |
| zod (raiz `node_modules`) | 3.25.76 |
| Plataforma da geração | win32 (ver "Dependências de plataforma") |

Fontes importadas (de `src/`, nunca de `dist/`, que está defasado):
`packages/core/src/{policy,domain,budget,graph,brief,resilience,pricing,turn-cost,ids,errors}.ts`,
`packages/daemon/src/http-schemas.ts` (validação de id de rota),
`packages/client/src/ids.ts` (`isHubId`) e `packages/adapters/src/registry.ts`
(`fallbackFor`, com os manifestos reais de `manifests/`).

`meta.json` (gerado) registra o SHA-256 de cada fonte lido — `core`, `daemon`, `client`,
`adapters`, os 9 manifestos, `daemon/src/session-manager.ts` (travas) e o próprio gerador —
calculado sobre o texto com CRLF/CR normalizados para LF. O mesmo checkout dá o mesmo meta
em Windows e Linux. Sem versão do Node, data nem commit: o meta só muda quando a entrada
muda. Também registra a versão do zod e as travas abaixo, com as linhas onde foram achadas.

### Travas

`sequence` (resilience.jsonl) **replica** dois trechos do TS em vez de chamá-los. O gerador
confere o texto antes de gerar e sai com código 1 (`TRAVA ROMPIDA`) se algum mudar:

| Arquivo | Trecho exigido | Mínimo |
|---|---|---:|
| `packages/daemon/src/session-manager.ts` | `novaTentativa(anterior.attempts.length + 1, agentId)` (retry e fallback; hoje linhas 3055 e 3178) | 2 |
| `packages/core/src/resilience.ts` | `const nextAttempt = state.attempts.length + 1;` (hoje linha 135) | 1 |

## Regenerar

Da raiz do repositório, com `npm ci` já feito na raiz (só `zod` e `yaml` são usados):

```
node --experimental-transform-types native/tests/conformance/tools/gen-domain.mjs
```

`--out <dir>` grava em outro diretório. O gerador não compila, não sobe daemon, não usa
rede nem modelo. Ele registra um hook de resolução (`./x.js` → `./x.ts` quando o
importador é `.ts`; `@agents-hub/core` → `packages/core/src/index.ts`).

Saída no stdout: contagem de casos por arquivo, SHA-256 de cada arquivo e o número de
cruzamentos com asserts TS. Se algum cruzamento falhar, o gerador imprime
`FALHA no cruzamento ...`, não grava nenhum arquivo e sai com código 1.

## Formato

Um JSON por linha (JSONL, UTF-8, `\n`). Cada linha:

```json
{"id":"budget/0012","kind":"ledger","rule":"...","spec":"SPEC-04 A8","source":["packages/core/src/budget.test.ts:167"],
 "divergence":"...","input":{...},"expect":{...}}
```

| Campo | Significado |
|---|---|
| `id` | `<arquivo>/<nnnn>`, estável enquanto o gerador não mudar |
| `kind` | função/cenário exercitado (tabelas abaixo) |
| `rule` | a regra que o caso prova, em português |
| `spec` | seção da especificação que o caso cobre (aceite de F0-13 no plano) |
| `source` | asserts TS (`arquivo:linha`) que o caso reproduz; `[]` = borda derivada da regra |
| `divergence` | presente só em caso que codifica divergência conhecida (ver abaixo) |
| `input` | entrada, na codificação abaixo |
| `expect` | saída real do TS, na mesma codificação |

### Codificação

JSON não representa tudo que o domínio recebe. Marcadores (objeto com **uma** chave):

| Marcador | Valor JS |
|---|---|
| `{"$num":"NaN"}`, `{"$num":"Infinity"}`, `{"$num":"-Infinity"}` | número não finito |
| `{"$repeat":["x",50000]}` | `"x".repeat(50000)` |
| `{"$fill":{"n":200,"value":V}}` | lista de 200 cópias de `V` (decodificado) |
| `{"$seq":{"n":10000,"template":"critério {i}"}}` | lista `critério 0` … `critério 9999` |

`-0` é gravado como `0`. Chave com valor `undefined` não aparece (ausente = não passada).
Strings com mais de 200 caracteres iguais e listas com mais de 20 elementos iguais são
gravadas com `$repeat`/`$fill` também em `expect`.

Erros: `{"error":{"code","message","details"}}` (`HubError`, `code` estável de
`core/src/errors.ts`); sucesso de chamada que pode lançar: `{"ok": valor}` (`null` quando a
função não devolve nada, ex.: `release`).

Números: `JSON.stringify` do double do JS (menor representação que faz ida e volta).
`0.30000000000000004` é o valor real, não arredondamento.

### Políticas

`{"ref":"DEFAULT_POLICY","patch":{...}}` = `{...DEFAULT_POLICY, ...patch}` (substituição
**rasa** de chaves de topo, como nos testes TS). O `DEFAULT_POLICY` completo está em
`policy-merge.jsonl`, caso `kind: "defaultPolicy"`. Um `patch` pode montar política
inválida para o schema (ex.: `risk` incompleto, decisão `"maybe"`): é de propósito, prova o
"ausente/desconhecido vale `approve`" (R09-12).

## Arquivos

| Arquivo | Casos | Com fonte TS | Conteúdo (`kind`) |
|---|---:|---:|---|
| `policy-decide.jsonl` | 266 | 20 | `decide` (matriz 7 ações × 3 modos × 7 políticas + casos de `policy.test.ts` + bordas de classificação), `narrowestDecision`, `isInside`, `watchForMode` |
| `policy-merge.jsonl` | 85 | 43 | `defaultPolicy`, `merge` (`mergePolicyLayer`, com e sem `clampToBase`/`trustExecFields`), `execFieldsDeclared`, `withoutExecFields` |
| `policy-intersect.jsonl` | 45 | 5 | `intersect` (`PolicyEngine.intersect`), `inheritMode`, `narrowestMode` |
| `budget.jsonl` | 269 | 23 | `ledger` (sequência de operações), `sanitizeUsage`, `addUsage`, `subUsage` |
| `graph.jsonl` | 29 | 13 | `checkDelegation`, `pathKey`, `buildGraph`, `rollupCost` |
| `brief.jsonl` | 107 | 20 | `parseBrief`, `caminhoDeArtefatoValido`, `renderBriefAsPrompt`, `objectiveHashOfBrief` |
| `resilience.jsonl` | 125 | 34 | `classifyOutcome`, `nextStep`, `sequence`, `closeLastAttempt`, `novaTentativa`, `failureContext`, `validationPassed`, `fallbackFor` |
| `pricing.jsonl` | 254 | 53 | `constants`, `tableInvariants`, `modelPrice` (as 70 linhas de `MODEL_PRICES`), `findModelPrice`, `normalizeModelId`, `estimateTokenCost`, `resolveEventCost`, `combineCostEstimates`, `turnCost`, `usoDoCusto` |
| `objective-hash.jsonl` | 33 | 4 | `objectiveHash`, `objectiveHashPair` |
| `ids.jsonl` | 379 | 11 | `newIdShape`, `daemonRouteId`, `clientIsHubId` |
| **Total** | **1592** | **226** | |

A contagem e o SHA-256 de cada arquivo saem no stdout do gerador; a tabela acima é a da
geração registrada no relatório da tarefa.

### Entrada e saída por `kind`

| `kind` | `input` | `expect` |
|---|---|---|
| `decide` | `{policy, action: GuardedAction, ctx: {workdir, mode, agentDirs?, hubPorts?}}` | `{risk, decision, reason}` |
| `narrowestDecision` | `{a?, b?}` | decisão |
| `watchForMode` | `{watch, mode}` | `WatchPolicy` |
| `isInside` | `{parentDir, target}` | booleano |
| `merge` | `{base: política, layer: PartialPolicyDocument, opts?: {clampToBase?, trustExecFields?}}` | `PolicyDocument` completo |
| `intersect` | `{parent: política, child: política}` | `PolicyDocument` completo |
| `inheritMode` / `narrowestMode` | `{parent, requested?}` / `{a, b}` | modo |
| `ledger` | `{rootId, limits, consumed?, reserved?, ops: [...]}` | `{steps: [{ok} ou {error}], final: snapshot}` |
| `checkDelegation` | `DelegationCheck` (`parentPath` já em chaves `agente:hash`) | `{ok: {depth, path, key}}` ou `{error}` |
| `pathKey` | `{pairs: [[agente, objetivo], ...]}` | lista de chaves |
| `buildGraph` / `rollupCost` | `{rows}` | árvore / `{usd, tokens}` da primeira raiz |
| `parseBrief` | `{input}` | `{ok: Brief normalizado}` ou `{error: INVALID_BRIEF com details.issues[{path,message}]}` |
| `renderBriefAsPrompt` | `{brief (passa por parseBrief), contexto?}` | texto |
| `nextStep` | `{state, outcome, config, origem?}` | `ResilienceStep` |
| `sequence` | `{agent, outcomes[], config, origens?[]}` | `{plan: ResilienceStep[], attempts: [{n, agentId, outcome}]}` |
| `closeLastAttempt` | `{attempts, outcome, error}` | por tentativa: `{n, agentId, outcome, error, endedAtSet, unchanged}` |
| `fallbackFor` | `{agentId, capabilities, registered, fallback}` | cadeia efetiva |
| `tableInvariants` | `{}` | booleanos das invariantes da tabela de preços |
| `turnCost` | `{base?, ops}` com op `observe {cost}`, `pending`, `flush` ou `cumulative` | `{steps}` |
| `daemonRouteId` | `{prefix, value}` | `{valid: true, value}` ou `{valid: false, firstIssueMessage}` |
| `clientIsHubId` | `{prefix, value}` | `{valid}` |

Operações de `ledger` (nomes reais dos métodos de `BudgetLedger`): `reserve {taskId,
request}`, `charge {usage, taskId?}` (o "consumo"), `estimate {taskId, usage}`, `settle
{taskId, usage}`, `release {taskId}`, `raiseLimits {delta}`, `setLimits {limits}`,
`snapshot {threshold?}`, `project {elapsed, target?}`.

`sequence` encadeia chamadas reais: fecha a última tentativa com `closeLastAttempt`, chama
`nextStep` e, em `retry`/`fallback`, abre `novaTentativa(step.attempt, step.agentId)` — o
mesmo que o daemon faz (`daemon/src/session-manager.ts:3055,3178`). Para no primeiro
`give_up`; outcomes restantes são ignorados.

## Divergências conhecidas codificadas

O corpus reproduz o comportamento do TS **como ele é**, inclusive onde ele diverge do que
parece pretendido. Decidir se o C copia ou corrige é do dono do plano; até lá, o corpus é
a referência.

1. **`intersect` herda do filho `defaultBudget`, `retries` e `fallback`** (SPEC-04,
   "Observações e divergências", item 5; `core/src/policy.ts:876-877`, spread
   `...child`, sem `min`). Casos com campo `divergence` em `policy-intersect.jsonl`
   (4 casos): filho com orçamento maior que o pai, retries maiores, fallback com agente e
   capability que o pai não tem, e o inverso (pai mais permissivo, filho fica com os seus).
2. **DV-44 — o construtor de `BudgetLedger` não saneia `limits`** (`core/src/budget.ts:116`),
   mas `setLimits` saneia (`budget.ts:277`). Casos com `divergence` em `budget.jsonl`
   (5 casos), mais um controle sem marca:
   - limite `usd: NaN` com 1 USD gasto: `remaining.usd` e `pressure` viram NaN e a dimensão
     `usd` **nunca** esgota;
   - NaN só em `usd`, com `tokens` 10/10: `exhausted = true`. As outras dimensões continuam
     esgotando, então "nunca esgota" (como DV-44 está escrita no plano) vale **só para a
     dimensão com NaN**;
   - NaN só em `usd`, com `tokens` 9/10: `pressure` é NaN (`Math.max` com NaN) e
     `isWarning = false`. O controle sem NaN (limites 10/10/10, mesmo uso) dá `pressure 0.9`
     e `isWarning = true`. O NaN numa dimensão **suprime o alerta de todas**;
   - `setLimits` com NaN/negativo saneia para 0; com uso > 0, a dimensão 0 dá
     `pressure` Infinity e `exhausted`.

Comportamentos de borda registrados sem marca de divergência (são o código, não
contradizem documento): limite `0` numa dimensão já nasce `exhausted`; `charge` sem `taskId` não abate a fatia reservada;
`subconjunto` do clamp preserva duplicatas da camada (`commands.allow`); `isInside("/w/proj", "/w/proj/..x")` é `false` (o relativo `..x` começa com `..`).

Fora deste corpus (comportamento do daemon, não do domínio): a perda de reservas ao
recriar o ledger (SPEC-04, item 2).

## Dependências de plataforma e de runtime

O C precisa reproduzir a semântica abaixo, não a do sistema onde roda:

- **Caminhos.** As ações de arquivo usam caminhos absolutos POSIX (`/w/proj/...`,
  `/tmp/hub/worktree/...`, como os testes TS). No win32, `path.resolve` os ancora no drive
  atual; a classificação (dentro/fora do workdir, fragmentos) é a mesma. Os `reason` não
  contêm caminho. Nenhum caso de política usa `\` em caminho de arquivo.
- **`objectiveHash`**: `trim`/`\s` do ECMAScript (inclui NBSP, U+3000, U+2028, BOM) e
  `toLowerCase` Unicode completo (`İ` → `i` + U+0307, `ß` fica). Sem normalização NFC/NFD.
- **Brief**: limites contam unidades UTF-16 (`😀` = 2). Mensagens de `issues` são as do
  zod 3.25.76 (em inglês) ou as personalizadas do schema (em português).
- **`buildGraph`** ordena por `String.prototype.localeCompare`; os casos usam só datas ISO
  ASCII, onde o resultado coincide com a comparação byte a byte.
- **`newId`** é aleatório: `ids.jsonl` registra só a forma (`<prefixo>_` + 24 hex), com
  50 amostras por prefixo.

## Verificação registrada

- Determinismo: duas execuções seguidas produzem os mesmos SHA-256 (comando e saída no
  relatório da tarefa CONF-03).
- Cruzamento: cada caso com `source` reafirma, durante a geração, o assert TS citado.
- Travas: a geração para se os trechos replicados do TS mudarem (seção "Travas").
