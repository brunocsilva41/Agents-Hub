# 07 — Progresso real: conferência item a item

> Vistoria de **verificação**, não de resumo. Cada linha abaixo foi conferida contra o
> código, contra o binário, contra o daemon rodando em `127.0.0.1:4747` ou contra o
> histórico de sessões no banco. Onde não deu para verificar, está dito que não deu.
>
> Data: 2026-08-28 · commit base `baec236` · build `npx tsc -b` **verde** ·
> `npm test` **196/196 verdes** (21 arquivos de teste).

---

## Veredito em três linhas

1. **A Fase 1 é real e a Fase 2 entregou o que a lista dela promete** — o núcleo
   (política, orçamento, grafo, worktree, daemon, MCP, painel, resiliência, guarda de
   borda) está construído, testado e roda de verdade.
2. **O que a documentação não diz é que quase tudo isso foi provado com três agentes.**
   De 9 agentes, o Hub jamais executou 6. Toda delegação que já aconteceu na vida deste
   repositório teve o **Codex** como destino, e a profundidade máxima já atingida é **1**.
3. **A Fase 3 é onde o plano está mais adiantado que o código.** Dos 5 itens marcados
   `[x]` ali, um está inteiro, um nunca rodou, e três entregam menos do que a frase
   sugere — em especial o motor de workflows, que **valida o DAG e depois o ignora na
   execução**.

---

## 1. Tabela item a item

Legenda de status real: **✅ confere** · **⚠️ parcial** (existe, faz menos do que a frase
diz) · **❌ não confere** · **🕳️ código escrito, nunca exercitado**.

### Fase 1 — Vertical fina

| Item do plano | Declarado | Real | Evidência |
|---|---|---|---|
| Monorepo + tipos do domínio | `[x]` | ✅ | `npx tsc -b` verde; 8 workspaces em `packages/` |
| `EventEnvelope` + vocabulário | `[x]` | ✅ **corrigido** | 21 tipos em `packages/core/src/events.ts`; os 21 agora são emitidos — `budget.warning` ganhou emissor em `SessionManager#checkBudgetWarning` (ver §2.8) |
| `PolicyEngine` (risco, overlay, interseção) | `[x]` | ✅ | `packages/core/src/policy.ts`; `intersect()` estreita risco, comandos, paths, rede, timeouts; testes `policy.test.ts` |
| `BudgetLedger` (raiz consumida por descendentes) | `[x]` | ✅ | `packages/core/src/budget.ts`; reserva por task filha, `charge` incremental, `raiseLimits` na aprovação |
| `CallGraph` (profundidade + ciclo semântico) | `[x]` | ✅ | `packages/core/src/graph.ts`, `checkDelegation` com `(agent, objective_hash)` no `path[]` |
| `store` SQLite + migrações + repositórios | `[x]` | ✅ | `packages/store/`; 1 migração versionada (`schema inicial`) |
| Contrato de adapter + registry por manifesto + cache de probe | `[x]` | ✅ | `packages/adapters/src/registry.ts`; cache com TTL diferente para instalado/ausente |
| Adapter genérico de CLI | `[x]` | ✅ | `process-adapter.ts`: JSONL, heartbeat, `taskkill /T` no Windows, prompt por stdin/arquivo |
| Mappers dedicados Claude e Codex | `[x]` | ✅ | `mappers/claude.ts`, `mappers/codex.ts` |
| Manifestos dos 8 agentes | `[x]` | ✅ | são **9** hoje (`openclaude` entrou depois); `GET /agents` devolve 9 |
| `WorktreeManager` | `[x]` | ✅ | branch `hub/<sessionId>` preservado; junction de `node_modules`/`.venv`/`vendor` |
| Daemon HTTP + SSE com replay | `[x]` | ✅ | `GET /health` responde; `/events` faz replay por `seq` |
| CLI com 12 comandos | `[x]` | ✅ | hoje são 27 comandos em `packages/cli/src/main.ts` |
| Testes do domínio (27) | `[x]` | ✅ | hoje **196** |

**Fase 1: 14/14 conferem.** É a parte mais sólida do repositório.

### Fase 2 — Delegação plena, MCP e painel

| Item do plano | Declarado | Real | Evidência |
|---|---|---|---|
| MCP server, "11 tools" | `[x]` | ✅ | são **12** (`hub_session_handoff` entrou na fase 3); doc 03 desatualizada por um |
| Adoção de agente externo | `[x]` | ✅ | `POST /sessions/adopt`; 3 sessões `cursor (principal externo)` no banco, concluídas |
| `packages/client` compartilhado | `[x]` | ✅ | CLI, MCP e Web consomem o mesmo cliente |
| `hub mcp` / `show` / `install --write` | `[x]` | ⚠️ | funciona, mas cobre **8 dos 9** agentes: `openclaude` não existe em `MCP_TARGETS` (ver §2.1) |
| Mensagens de erro acionáveis | `[x]` | ✅ | `packages/mcp/src/server.ts` traduz `DEPTH_EXCEEDED`, `CYCLE_DETECTED`, `BUDGET_EXCEEDED`, `CONCURRENCY_EXCEEDED` |
| Web UI React+Vite servida pelo daemon | `[x]` | ✅ | `packages/web/dist/` buildado e servido; grafo navegável, timeline, custo, controles, handoff |
| `scripts/mcp-smoke.py` | `[x]` | ✅ | presente |
| Portão de delegação (preventivo) | `[x]` | ✅ | `session-manager.ts:353-380`; retém ANTES do spawn, relê do banco e devolve `approval` |
| Vigilância reativa com `pauseOn`/`flagOn` | `[x]` | ✅ | `#watch()`; `watchForMode` endurece em `supervised` |
| `/approvals`, CLI e fila no painel | `[x]` | ✅ | `GET /approvals` responde com 1 aprovação pendente real (orçamento estourado) |
| Retenção de worktree 7 dias + `hub prune` | `[x]` | ✅ | `reaper.ts`; branch nunca apagado |
| Pipeline de resiliência (retry/fallback/validação) | `[x]` | ✅ | `core/resilience.ts` puro + integração com agentes falsos (3 testes, 3s reais) |
| Substituto entra como **irmão** no grafo | `[x]` | ✅ | teste "o substituto entra como irmão no grafo, não como filho" |
| `failureContext` no brief do substituto | `[x]` | ✅ | `resilience.ts` |
| Portão de validação por comando | `[x]` | ✅ | `.agents-hub/config.yaml` deste repo define `npx tsc -b` |
| Adapter HTTP do OpenCode | `[x]` | ✅ | `opencode/adapter.ts` (539 linhas), tradutor SSE com 19 testes; 2 sessões reais no banco |
| Manifestos verificados (Copilot, Kimi, MiMo) | `[x]` | ✅ | `-p` é `--password` no MiMo está corrigido; mappers com amostras capturadas |
| Guarda de borda + validação de contrato + `static` | `[x]` | ✅ | **testado ao vivo agora**: `Origin` externa → **403**; `Content-Type: text/plain` → **415**; `Host: evil.example` → **403** |
| Mapper dedicado do Antigravity | `[x]` | ⚠️ | mapper existe e é bom (187 linhas, 8 testes com amostras); **o agente nunca rodou uma sessão** |
| Gate PRÉ-execução (Claude Code) | `[x]` | ⚠️ | código correto e testado, mas **não está instalado nesta máquina** e **não abre aprovação no Hub** (ver §2.2) |
| Gate pré-execução do Codex | `[~]` | ✅ honesto | `toCodexHookOutput` + 3 testes; falta emitir a config na invocação — **o roadmap já diz isso** |
| Mapper dedicado Cursor / MiMo | `[ ]` | — | corretamente aberto |
| Gate para os demais agentes | `[ ]` | — | corretamente aberto |
| TUI | `[ ]` | — | corretamente aberto |

**Fase 2: 30 itens `[x]`, todos com código real por trás.** Nenhum é falso. O problema
não está nos itens — está na palavra **"plena"** do título da fase (§3).

### Fase 3 — Plataforma

| Item do plano | Declarado | Real | Evidência |
|---|---|---|---|
| **A2A server** | `[x]` | ✅ **corrigido** | Era uma API REST com forma do Hub servida em caminhos com nome A2A. Renomeada para `/api/tasks/*` (Opção B do §2.3: renomear em vez de implementar JSON-RPC 2.0), com `/.well-known/agent-card.json` removida. Ver §2.3 |
| **Motor de workflows YAML** (fan-out/fan-in) | `[x]` | ❌ **o mais grave** | A validação do DAG é real; a **execução ignora as dependências**. Ver §2.4 |
| **Handoff de sessão** | `[x]` | 🕳️ | Código completo e correto (`session-manager.ts:809-873`), rota, CLI, tool MCP e botão no painel. **Zero eventos `session.handoff` no banco**: nunca foi executado fora do teste unitário |
| **Validação por revisão cruzada** | `[x]` | ✅ | `#revisar`/`#executarRevisao`; revisor nunca é o próprio autor, custo debitado do mesmo orçamento, diff vazio não aprova sozinho. Desligado por padrão (deliberado) |
| **Painel de custos com projeção e alertas** | `[x]` | ✅ **corrigido** | `projectedUsd`/`projectedTokens` agora são exibidos no painel, o evento `budget.warning` é emitido na transição para 80% de pressão (detecção de borda, com rearme em `raiseLimits()`), e a projeção passou a usar o tempo de parede da sessão-raiz em vez de `consumed.seconds` — que só era liquidado no fim da run. Ver §2.8 |
| Isolamento por container | `[ ]` | ✅ honesto | `worktree.ts:68` recusa explicitamente com `ILLEGAL_STATE`. Não finge |
| ACP | `[ ]` | — | corretamente aberto |

---

## 2. Divergências, por gravidade

### 2.1 🔴 Grave — o mapper genérico finge suporte a sessão nativa

`cursor.yaml` e `mimo.yaml` declaram `session.strategy: native` e `session.idFrom`
(`$.session_id`, `$.sessionID`). Mas:

- **`idFrom` não é lido por ninguém.** Único uso em todo o repositório:
  `packages/adapters/src/types.ts:72`, onde ele é apenas *declarado* no schema Zod.
- O `nativeSessionId` só existe se o **mapper** o preencher
  (`process-adapter.ts:317`), e os mappers genéricos **nunca** preenchem.

Consequência: para Cursor e MiMo, `resume()` nunca é possível, e todo turno seguinte
cai em `rebuildConversation` (replay). O manifesto promete retomada nativa e o código não
tem como cumprir. O banco confirma o padrão: `cursor` 0/3 sessões com id nativo,
`kimi` 0/2, `copilot` 0/2 — contra `codex` 14/16 e `opencode` 2/2.

**Parece esquecimento**, não decisão: os caveats de Cursor e MiMo falam de custo e
eventos de ferramenta, mas nenhum menciona que o resume não funciona.

**O que mais se perde no genérico:** `genericTextMapper`/`genericJsonMapper`
(`mappers/generic.ts`) emitem só `message`, `log` e `error`. Nunca emitem `turn.completed`,
`tool.call`, `tool.result`, `file.changed` nem `command.executed`. Isso significa que,
para Cursor e MiMo, **a vigilância reativa não tem o que vigiar** — `#watch()` deriva
ações de eventos de comando e de arquivo que nunca chegam. O agente é observado apenas
no sentido de aparecer texto na timeline.

| Agente | Mapper | Dedicado? | O que perde |
|---|---|---|---|
| claude | `claude` | ✅ | — |
| codex | `codex` | ✅ | — |
| copilot | `copilot` | ✅ verificado contra binário | id nativo só no evento final |
| kimi | `kimi` | ✅ verificado contra binário | não reporta tokens; id só no final |
| antigravity | `antigravity` | ✅ verificado contra binário 1.1.22 | — (nunca executado) |
| openclaude | `claude` (reuso) | ✅ por herança | risco de divergência entre versões do fork |
| opencode | adapter HTTP próprio | ✅ | — |
| **cursor** | `generic-json` | ❌ | resume nativo, custo, ferramentas, vigilância |
| **mimo** | `generic-json` | ❌ | resume nativo, custo, ferramentas, vigilância |

### 2.2 🔴 Grave — o gate pré-execução emite uma aprovação que não existe

`SessionManager.gateToolCall()` (`session-manager.ts:446-500`), quando a decisão é
`approve` ou `deny`, emite um evento `type: 'approval.requested'` — mas **não chama
`#requestApproval()`**. Os três chamadores reais de `#requestApproval` são o portão de
delegação (l. 363), o estouro de orçamento (l. 1140) e a vigilância (l. 1556). O gate
não está entre eles.

Consequência concreta: a timeline mostra "aprovação solicitada", mas
- nenhuma linha entra na tabela `approvals`;
- nada aparece em `GET /approvals` nem em `hub approvals`;
- `hub approve <id>` não tem id para receber;
- a sessão **não** vai para `waiting_approval`.

A decisão fica inteiramente com o `escalate` dentro do agente. Para o Claude Code em
modo `-p` headless — que é como o Hub o roda — não há humano no terminal para responder
o `escalate`. O doc 04 diz "quando um portão retém **ou a vigilância para** uma sessão,
nasce uma `Approval`"; o gate pré-execução, que o mesmo doc chama de "o nível mais forte",
é justamente o que não faz nascer.

**Além disso, o gate está desligado.** `hub hooks` agora responde:

```
○ claude Claude Code
   C:\Users\Bruno Silva\.claude\settings.json
instale com: hub hooks install claude --write
```

Ou seja: o único nível de controle verdadeiramente preventivo sobre ações de ferramenta
não está ativo em nenhum agente desta máquina.

### 2.3 🔴 Grave (corrigido) — o "A2A server" não era A2A

**Status: corrigido nesta passagem.** O ADR 02.3 escolhera A2A como "a porta por onde
peers externos falam com o Hub", e o ADR 02.1 citava nominalmente os métodos
`tasks/get` e `tasks/resubscribe`. O que existia em `packages/daemon/src/a2a.ts` +
rotas era uma API REST desenhada em torno dos tipos do Hub:

- não havia superfície JSON-RPC 2.0 — nem `message/send`, nem `tasks/get`, nem
  `tasks/resubscribe`; eram `POST /a2a/tasks`, `GET /a2a/tasks/:id`, `.../cancel`,
  `.../events`;
- o Agent Card tinha `capabilities` como **array de strings** (os capabilities dos
  manifestos), um objeto `endpoints` próprio e `authentication: { mode: 'none' }`;
- o corpo de task devolvido era o `Task` do Hub achatado (`brief`, `attempts`,
  `result`), com o vocabulário de estados do Hub;
- o SSE era `data: <EventEnvelope do Hub>`, não eventos de task do protocolo;
- pior ainda: `GET /.well-known/agent-card.json` respondia — esse caminho é
  **reservado pela spec A2A para descoberta automática**, e um scanner que o
  encontrasse assumiria compatibilidade que não existia.

Um peer que fale A2A de verdade não conversava com isto. Não era fraude — era uma boa
API REST com o nome errado —, mas a divergência não estava assumida em comentário
nenhum, ao contrário do que o repositório faz em toda parte quando degrada algo de
propósito (`container`, `interrupt` no Windows, `acceptance_criteria`).

**A correção escolheu a Opção B do plano**: renomear em vez de implementar JSON-RPC
2.0. Hoje:

- as rotas moraram para `/api/tasks/*` (`packages/daemon/src/api-tasks.ts`, antes
  `a2a.ts`);
- `GET /.well-known/agent-card.json` foi **removida por completo**;
- o descritor da API (antes "Agent Card") vive em `GET /api/descriptor.json` e se
  chama `ApiDescriptor`, sem alegar `protocolVersion` de coisa nenhuma;
- `A2aCreateTaskSchema` virou `CreateTaskSchema` em `http-schemas.ts`;
- o ADR 02.3 registra explicitamente que "A2A de verdade" continua em aberto,
  gated por aparecer um consumidor real que precise do protocolo canônico.

> Ressalva honesta, ainda válida: comparei a implementação com o que os ADRs deste
> repositório afirmavam sobre A2A v1.0 e com a forma canônica do protocolo. **Não
> testei contra um cliente A2A real** — ver §5. A correção não muda essa ressalva:
> ela renomeia uma API REST, não implementa o protocolo.

### 2.4 🔴 O mais grave — o motor de workflows valida o DAG e depois o ignora

`packages/core/src/workflow.ts` faz Kahn corretamente e produz lotes topológicos.
`hub workflow validate examples/multi-agent-pipeline.yaml` roda e imprime os 4 lotes
certos. Até aqui, tudo verdadeiro.

O problema está em `packages/cli/src/workflow-cmd.ts`. O laço por lote faz:

```ts
await Promise.all(batch.map(async (stepId) => {
  const res = await client.startSession({ ... });   // <- só cria a sessão
  stepSessions.set(step.id, { sessionId: res.session.id, taskId: res.task.id });
}));
```

`startSession` é **assíncrono por contrato** (ADR 02.1): `SessionManager.#launch()`
termina em `void this.#pump(...)` — "o pump roda solto: quem chamou `start` não deve
esperar o agente terminar" (`session-manager.ts:1078`). Então `await` aqui espera a
sessão **nascer**, não o passo **terminar**.

Consequência: no `examples/multi-agent-pipeline.yaml`, `plan`, `backend_refactor`,
`test_suite` e `final_review` são disparados praticamente ao mesmo tempo. O agente que
deveria "refatorar conforme o plano" começa antes de o plano existir. A ordenação
topológica serve apenas para escolher a ordem dos `console.log`.

Três consequências derivadas, todas verificáveis no mesmo arquivo:

- **Não há fan-in.** `stepSessions` é preenchido e nunca lido — nenhum resultado de um
  passo chega ao brief do passo seguinte.
- **A flag `--budget-usd` é documentada no `--help` e nunca lida.** Só
  `args.flags['project']` é consultado. O "orçamento global do workflow" não existe.
- **Cada passo vira uma sessão-raiz independente**, cada uma com seu próprio
  `BudgetLedger` — logo o teto do ADR 03 ("orçamento é da sessão-raiz") não se aplica ao
  workflow como um todo.

O roadmap descreve este item como "ordenação topológica em lotes paralelos
(fan-out/fan-in)". Metade disso não acontece.

### 2.5 🟡 Médio — o modo de supervisão só é real para 2 dos 9 agentes

O commit `12343bf` ("o modo do Hub passa a governar o sandbox do próprio agente") é
verdadeiro, mas `modeArgs` só existe em `claude.yaml` e `codex.yaml`. O schema
(`types.ts:59-65`) faz `modeArgs` cair para `{supervised: [], semi: [], autonomous: []}`
quando ausente.

Resultado: uma sessão `supervised` com **copilot, kimi, mimo, antigravity, cursor,
opencode ou openclaude** sobe o agente sem nenhuma restrição nativa. Nesses 7 casos,
"supervised" significa apenas: a vigilância pausa também em `escalate`, e delegação pede
aprovação. O agente continua livre para escrever e executar.

Agrava a ironia: `copilot`, `kimi`, `mimo` e `antigravity` declaram
`defaults.supervision: supervised` — o modo que mais promete e menos entrega neles.

### 2.6 🟡 Médio — o controle de rede não tem por onde ser aplicado

O ADR 03 e o doc 01 §7 definem: "domínios permitidos por política; padrão nega o que não
estiver listado". `DEFAULT_POLICY.network.allowDomains` é `[]` e `PolicyEngine.classify`
implementa a regra corretamente.

Mas a ação `network` só é produzida em um lugar: `actionsOfToolCall()` para as
ferramentas `webfetch`/`websearch` — isto é, **exclusivamente pelo gate pré-execução**,
que existe só para o Claude Code e está desinstalado (§2.2). Nenhum mapper emite evento
de rede, então a vigilância reativa também não vê nada. Na prática, hoje, **o controle
de rede não é exercido para nenhum agente**.

### 2.7 🟡 Médio — `openclaude` é cidadão de segunda classe

O agente está instalado (0.13.0), tem manifesto verificado e reusa o mapper do Claude.
Mas:

- **não está em `MCP_TARGETS`** (`mcp-install.ts:29-88`), então `hub mcp install
  openclaude` não existe → ele **não pode ser orquestrador externo**;
- não está em `HOOK_TARGETS` → não tem gate pré-execução, embora seja um fork do Claude
  Code e provavelmente aceite o mesmo formato de hook;
- não aparece em nenhuma cadeia de fallback de `DEFAULT_POLICY`.

Parece esquecimento puro: ele entrou depois (`2e228b1`) e as duas listas não foram
atualizadas.

### 2.8 🟢 Menor — inconsistências de contagem e um evento que ganhou emissor

- ~~`budget.warning` está no `EventType` e **nunca é emitido**~~ **Corrigido**:
  `SessionManager#checkBudgetWarning` agora o emite na transição false→true de
  `snapshot.isWarning`, com detecção de borda (não repete a cada evento de custo
  acima de 80%) e rearme em `raiseLimits()`. A projeção de `budget()` também deixou
  de depender de `consumed.seconds` (só liquidado no fim da run) e passou a usar o
  tempo de parede da sessão-raiz, então aparece com a sessão ainda viva.
- Doc 03 diz "as 11 tools"; são 12.
- Roadmap Fase 1 diz "Manifestos dos 8 agentes"; são 9.
- `MCP_TARGETS` marca `verified: true` só para claude, codex e cursor — e **cursor não
  está instalado**. Dos caminhos verificados, apenas 2 são úteis nesta máquina. Os
  caminhos de `~/.copilot/mcp-config.json`, `~/.mimo/` e `~/.cursor/mcp.json` **não
  existem no disco** — o próprio `hub mcp` já os marca com "⚠ caminho não confirmado",
  o que é honesto.
- `handoff()` não verifica se o agente de destino está instalado quando o alvo é um id
  direto (`resolveTarget` só filtra por probe no caminho `cap:`). Transferir para
  `cursor` falharia só no spawn.

---

## 3. A promessa original × o que existe

> *"um hub onde qualquer agente pode chamar qualquer outro, ser orquestrador e
> orquestrado, poder definir qualquer um como principal, controlar o trabalho, controlar
> as sessões, tudo que possa ser usado, ajustado, mexido"*

### 3.1 "Definir qualquer um como principal" — depende de qual dos dois sentidos

**Sentido A: principal rodando *dentro* do Hub (`hub start --agent X`).**
A CLI exige `--agent` (ADR 04.1 honrado, `main.ts:481-486`) e aceita qualquer id
registrado; o painel oferece um `<select>` com todos os instalados. Não há caminho
privilegiado no código — o agente é só uma chave no registry.
**Veredito: verdadeiro por construção, provado para 3.**

| Agente | Pode ser principal? | Já foi executado pelo Hub? |
|---|---|---|
| claude | sim | ✅ 3 sessões com worktree, 1 concluída |
| codex | sim | ✅ 16 sessões, 9 concluídas |
| opencode | sim | ✅ 2 sessões (1 falhou, 1 morta) |
| copilot | sim, em tese | ❌ nunca — as 2 sessões são adoções externas |
| kimi | sim, em tese | ❌ nunca — idem |
| antigravity | sim, em tese | ❌ **nunca**, apesar do mapper dedicado novo |
| mimo | sim, em tese | ❌ nunca |
| openclaude | sim, em tese | ❌ nunca |
| cursor | **não** | ❌ binário `cursor-agent` ausente do PATH |

**Sentido B: principal rodando *fora* do Hub, adotando uma sessão-raiz.**
Este é o sentido que o doc 03 chama de "como qualquer agente vira orquestrador", e ele
depende de o Hub estar registrado como MCP server na config daquele agente. Hoje:

```
✓ codex        registrado
○ claude       não registrado   (.mcp.json ausente neste repo)
○ cursor  ○ opencode  ○ copilot  ○ kimi  ○ mimo  ○ antigravity   não registrados
(openclaude nem aparece na lista)
```

**Veredito: hoje, exatamente um agente — o Codex — pode de fato orquestrar os outros.**
Sete estão a um `hub mcp install <id> --write` de distância (cinco deles por caminho de
config **não confirmado**), e um (openclaude) não tem comando nenhum.

### 3.2 "Qualquer um pode chamar qualquer outro" — o caminho existe; a prova, não

Não há nada no código que restrinja pares (A→B): `POST /sessions/:id/delegate` e
`hub_agent_call` resolvem o alvo pelo mesmo `registry.resolveTarget()`, e a sessão filha
nasce pelo mesmo `start()` do principal. A restrição é factual, não estrutural.

O que o banco mostra sobre **todas as delegações que já aconteceram**:

| Par exercitado | Vezes |
|---|---|
| claude → codex | 1 |
| copilot → codex | 2 |
| cursor → codex | 1 |
| kimi → codex | 1 |

- **Profundidade máxima já atingida: 1.** Nunca houve A→B→C, embora `maxDepth` seja 3.
  A detecção de ciclo e a herança de política em segundo nível nunca foram exercidas
  num fluxo real.
- **Todo destino já usado foi o Codex.** Ninguém nunca delegou para claude, opencode,
  copilot, kimi, mimo, antigravity ou openclaude.
- Os quatro "chamadores" acima (claude, copilot, cursor, kimi) eram todos **sessões
  adotadas do harness de fumaça** (`ses_*` com título `"... (externo)"`), não agentes
  reais chamando de dentro.

Ou seja: dos 72 pares possíveis (9×8), **1 par foi exercitado por um agente de verdade**
(claude→codex, o teste de fumaça da Fase 1). Os outros 3 vieram de um simulador.

### 3.3 "Controlar o trabalho, controlar as sessões"

Aqui a promessa está bem servida, e é a parte mais forte depois do núcleo:

- `interrupt`, `pause`, `cancel` (recursivo nos filhos), `send` ao vivo, `handoff`,
  `delegate`, aprovações, `diff`, `graph`, `budget`, `prune` — tudo por HTTP, tudo
  na CLI, quase tudo no painel.
- A regra "nenhuma lógica no cliente" (ADR 01.2) é real: `packages/client` é
  compartilhado e a Web UI não reimplementa nada.
- **Onde falta paridade:** a Web UI não expõe `workflow`, `prune`, `mcp`/`hooks` nem
  configuração de projeto. A TUI não existe (assumido no roadmap). `pause` tem rota
  HTTP mas não tem comando na CLI.

### 3.4 "Tudo que possa ser usado, ajustado, mexido"

Ajustável hoje: política global (`~/.agents-hub/config.json`), política por projeto
(`<repo>/.agents-hub/config.yaml`, que só pode apertar — com teste para cada direção),
manifestos por YAML, orçamento por sessão, modo de supervisão, isolamento, comando de
validação, revisão cruzada.

Não ajustável, e provavelmente deveria ser: a **cadeia de fallback é global e por
capability**, sem override por projeto; o `matcher` do hook é uma constante
(`MATCHER_DE_RISCO`); os `IRREVERSIBLE_PATTERNS` são hardcoded em `policy.ts` — um
projeto não consegue declarar "aqui `terraform apply` é rotina" nem "aqui `curl` é
irreversível".

---

## 4. O que foi construído e não está no plano

Nem tudo aqui é problema; parte indica que **o plano ficou para trás do código**.

| O que existe | Situação no plano |
|---|---|
| **`openclaude`, o 9º agente** | Não aparece em nenhum documento. ADR 01.4 lista 8. Deveria virar item — e, junto, entrar em `MCP_TARGETS`, `HOOK_TARGETS` e nas cadeias de fallback (§2.7) |
| **`hub_agent_wait`** (12ª tool) | Não está na tabela do doc 03 |
| **Daemon que sobe sozinho + `hub` no PATH + reconciliação na subida** | Commit `661db71`; nenhum item de roadmap. A reconciliação (sessão `running` sem processo é encerrada; `waiting_approval` sobrevive) tem 5 testes e é infraestrutura séria |
| **`diff-capture` + artefatos persistidos** | Não previsto como item; foi o que fez `TaskResult.artifacts` deixar de ser sempre `[]` |
| **Precificação estimada por tabela de modelos** (`core/pricing.ts`, 929 linhas, 217 de teste) | Nenhum item de plano. É o que faz o orçamento em dólares valer para agentes que só reportam tokens. Merece item próprio — inclusive porque **tabela de preços envelhece** e ninguém marcou quem a mantém |
| **`conversation.ts` / `rebuildConversation`** | Nasceu como correção da vistoria (doc 05, achado 1). Hoje é o que sustenta handoff e todo agente sem id nativo — virou peça de arquitetura sem ter item |
| **`hub hooks` como comando** | O roadmap fala do gate, não do comando que o instala |
| **`review-verdict.ts`** (leitura do veredito com acento, caixa e ambiguidade) | 8 testes; parte da revisão cruzada, sem item próprio |

E o inverso — **o que o usuário pediu e ninguém transformou em item de plano**:

1. **"Qualquer um pode ser o principal" nunca virou tarefa de cobertura.** Existe como
   propriedade do código, mas não há item "provar cada um dos 9 como principal", e o
   resultado é que 6 nunca rodaram. Um `hub doctor --smoke` que abrisse uma sessão
   trivial por agente instalado fecharia isso em minutos e é o item que falta.
2. **"Qualquer um pode chamar qualquer outro" nunca virou matriz.** Não existe item que
   diga "exercitar A→B para os pares que importam", nem sequer "provar profundidade 2".
3. **Registro de MCP em todos os agentes** aparece como comando, nunca como meta. Cinco
   dos oito caminhos de config são palpite — item de verificação faltando, exatamente o
   mesmo trabalho que já foi feito para os manifestos em `470a605` e que revelou 3 erros
   em 3.
4. **Gate pré-execução como cobertura, não como feature.** Está no plano por agente
   (claude ✅, codex `[~]`, "demais" `[ ]`) — mas falta o item que diz o que acontece com
   quem **nunca** terá hook: hoje esses agentes simplesmente não têm prevenção, e nada
   na UI avisa isso.
5. **Manutenção da tabela de preços** — item inexistente para uma dependência externa que
   muda sozinha.

---

## 5. Onde estamos, em porcentagem honesta

Contando apenas as caixas do roadmap e verificando cada uma:

| Fase | Declarado | Verificado | Honesto |
|---|---|---|---|
| **Fase 1** | 14/14 = 100% | 14 conferem | **100%** |
| **Fase 2** | 30 de 35 caixas = 86% | 30 conferem como código real | **~85%**, com a ressalva de §3 |
| **Fase 3** | 5 de 7 = 71% | 1 inteiro (revisão), 1 nunca rodado (handoff), 3 parciais (A2A, workflow, projeção) | **~35%** |

**Onde a porcentagem não mede nada, e por quê.**

O número acima conta *caixas*, e a unidade real deste projeto é **agente × capacidade**.
Nessa unidade a foto muda:

| Capacidade | Agentes cobertos | de 9 |
|---|---|---|
| Manifesto verificado contra o binário | claude, codex, copilot, kimi, mimo, antigravity, openclaude, opencode | 8 |
| Mapper dedicado (timeline rica, custo, ferramentas) | claude, codex, copilot, kimi, antigravity, openclaude, opencode | 7 |
| Sessão nativa realmente capturável | claude, codex, opencode (+copilot/kimi a partir do 2º turno) | 3–5 |
| Modo de supervisão aplicado no próprio agente | claude, codex | **2** |
| Gate pré-execução implementado | claude (codex pela metade) | **1** |
| Gate pré-execução **instalado nesta máquina** | nenhum | **0** |
| Pode orquestrar (MCP registrado hoje) | codex | **1** |
| Já executou uma sessão de verdade | claude, codex, opencode | **3** |

**Por isso não dou um número único para "o Hub".** As duas medições discordam em uma
ordem de grandeza — 85% das caixas da Fase 2, mas 2 de 9 agentes com supervisão real — e
qualquer média entre elas seria um número inventado. A leitura correta é: **o plano de
controle está construído; a cobertura dele sobre a frota, não.**

---

## 6. O que eu não consegui verificar

Digo com clareza para que ninguém leia ausência de achado como aprovação.

1. **Se o "A2A server" interopera com um cliente A2A real.** Comparei com o que os ADRs
   deste repositório afirmam e com a forma canônica do protocolo, mas não rodei um SDK
   A2A contra o daemon. A conclusão de §2.3 é sólida quanto à **ausência de JSON-RPC e
   dos métodos citados no ADR 02.1**; a incompatibilidade total com a spec v1.0 é
   inferência.
2. **Se os 6 agentes nunca executados de fato funcionam.** Não abri sessão com nenhum
   deles — seria gastar tokens do usuário e escrever no estado do Hub, e a tarefa é
   somente leitura. Sei que os binários respondem `--version` (probe verde para 8 de 9);
   não sei se `agy -p --output-format stream-json` produz o que
   `mappers/antigravity.ts` espera **em execução**, só que produz nas amostras
   capturadas nos testes.
3. **Se o gate pré-execução do Claude realmente bloqueia hoje.** O hook não está
   instalado; validei a lógica (testes + `POST /hooks/pretooluse` respondendo `allow`
   corretamente para chamada fora de sessão), mas não o efeito ponta a ponta, que
   exigiria instalar o hook — escrita fora do escopo.
4. **Se a execução de um workflow se comporta como descrevi.** A conclusão de §2.4 é
   leitura de código (`await` sobre `startSession`, que é assíncrona por contrato do
   `#launch`), não observação. Rodar `hub workflow run` dispararia 4 sessões reais.
   É a primeira coisa a confirmar empiricamente, e provavelmente a correção mais barata
   do relatório.
5. **Se a projeção de orçamento aparece durante uma run.** Deduzi do fato de
   `budget()` usar `snapshot.consumed.seconds`, que só é alimentado por `ledger.settle()`
   no fim da run. Não observei o painel com uma sessão longa em andamento.
6. **O conteúdo de `packages/web` e `packages/daemon`/`core` em edição por outras
   pessoas neste momento.** Li o estado em disco às 00h58 de 2026-08-29; havia
   `M packages/cli/src/hook.ts` não commitado. Se algo mudou depois, meus trechos de
   linha podem ter deslizado.
7. **`session-export-1787950654279/` e o `.zip` na raiz** — não fazem parte do produto e
   não foram inspecionados; parecem resíduo de exportação e deveriam entrar no
   `.gitignore`.

---

## 7. Se eu tivesse de escolher três coisas para fazer amanhã

1. **Consertar a execução do workflow** (§2.4) — hoje o `dependsOn` é decorativo, e é o
   único lugar do repositório onde o código promete uma garantia e entrega outra sem
   nenhum comentário admitindo a degradação.
2. **Fazer o gate pré-execução abrir uma `Approval` de verdade** (§2.2), e instalá-lo.
   Sem isso, o nível de controle que a documentação chama de "o mais forte" é o único
   que não tem como ser respondido.
3. **Rodar uma sessão trivial com cada um dos 8 agentes instalados** e registrar o
   resultado. É barato, e responde de uma vez a pergunta que este relatório só conseguiu
   responder por ausência: *qualquer um pode mesmo ser o principal?*

---

*Relatório produzido em modo somente-leitura: nenhum arquivo existente foi alterado,
nenhuma sessão foi criada, nenhum commit foi feito.*
