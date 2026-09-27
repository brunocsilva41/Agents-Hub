# 01 — Arquitetura do Agents-Hub

## 1. Conceito central

> O Hub não é "mais um agente". É o **plano de controle** onde qualquer agente pode ser orquestrador e orquestrado, através de um único modelo de sessão, evento, política e orçamento.

Três invariantes que sustentam tudo:

1. **Nenhum papel é fixo.** "Principal" é apenas quem detém a sessão-raiz. O Cursor pode ser principal hoje e subordinado amanhã, sem mudar uma linha de código.
2. **Todo agente é reduzido ao mesmo contrato.** `start · send · stream · interrupt · resume · cancel · status`. Onde o CLI não suporta, o Hub emula e o manifesto declara a degradação.
3. **Todo evento é normalizado.** Nove agentes com formatos de saída diferentes viram UM `EventEnvelope`. Sem isso não existe grafo, custo consolidado nem UI unificada.

> **Revisado em 2026-09-26 contra o código** (item 8.1 do [GOAL](12-goal-mvp-completo.md)). A
> versão anterior deste documento descrevia módulos que nunca existiram como tal
> (`Orchestrator`, `CapabilityRegistry`, `ResiliencePipeline`, `ArtifactStore`, `Logger`),
> um A2A server (removido; ver §6) e uma TUI (não existe). O que segue é o que está em
> `packages/`; o que é intenção futura está marcado como tal.

## 2. Camadas

```
┌──────────────────────────────────────────────────────────────────┐
│  CLIENTES   CLI (`hub`, packages/cli)   Web UI (React, packages/web)│
│             └──────── @agents-hub/client (packages/client) ────────┘│
│                       HTTP + SSE (API única do daemon)             │
├──────────────────────────────────────────────────────────────────┤
│  ENTRADAS   MCP server stdio (packages/mcp, 16 tools)              │
│             REST/SSE do daemon: /sessions, /events, /approvals,    │
│             /api/tasks/* (REST simples, NÃO é A2A), /hooks/...     │
├──────────────────────────────────────────────────────────────────┤
│  DAEMON (packages/daemon)                                          │
│   HubServer · SessionManager (orquestração, retry/fallback,       │
│   validação, gate) · WorktreeManager · WorktreeReaper ·            │
│   EventRetentionCompactor · WorkflowRunner · AuditTrail            │
├──────────────────────────────────────────────────────────────────┤
│  CORE (packages/core — domínio, puro, sem I/O)                     │
│   PolicyEngine · BudgetLedger · checkDelegation (grafo) ·          │
│   resilience.ts · workflow.ts (runWorkflow) · command-classifier   │
├──────────────────────────────────────────────────────────────────┤
│  ADAPTERS (packages/adapters — dirigidos por manifesto)            │
│   ProcessAgentAdapter (genérico) · OpenCodeAdapter (HTTP+SSE) ·    │
│   mappers: claude · codex · copilot · kimi · antigravity ·         │
│   generic-json · generic-text · AgentRegistry                      │
├──────────────────────────────────────────────────────────────────┤
│  STORE (packages/store)  SQLite (node:sqlite), migrações 1–8       │
└──────────────────────────────────────────────────────────────────┘
```

Não existe TUI (roadmap `[ ]`; a Web UI cobre a necessidade) nem servidor A2A.

**Regra de dependência:** setas apontam só para baixo. `core` não conhece adapters nem HTTP — recebe portas (interfaces) injetadas. É o que torna o Hub testável sem invocar nenhum agente de verdade.

## 3. Modelo de domínio

| Entidade | Descrição | Chaves |
|---|---|---|
| `Project` | Repositório registrado no Hub | `id`, `path`, `defaultBranch`, `config` |
| `Session` | Conversa contínua com UM agente | `id`, `projectId`, `agentId`, `nativeSessionId`, `rootId`, `parentId`, `depth`, `state`, `mode` |
| `Task` | Unidade de trabalho delegada (8 estados, vocabulário inspirado no A2A) | `id`, `sessionId`, `brief`, `state`, `attempts[]`, `result` |
| `Event` | Fato normalizado emitido por qualquer agente | `id`, `sessionId`, `taskId`, `seq`, `type`, `payload`, `ts` |
| `Approval` | Ação bloqueada aguardando decisão humana | `id`, `taskId`, `risk`, `action`, `state` |
| `BudgetLedger` | Consumo (tokens/USD/tempo) por sessão-raiz | `rootId`, `limits`, `consumed` |
| `Artifact` | Saída material (diff, arquivo, relatório, log) | `id`, `taskId`, `kind`, `path`, `hash` |

### Estados de Task (nomes do A2A v1.0; o Hub não fala o protocolo A2A)

`submitted → working → (input_required | auth_required) → completed | failed | canceled | rejected`

### Estados de Session

`idle · running · waiting_approval · paused · completed · failed · killed`

### Parar uma sessão: cancel, interrupt, pause

| Ação | Processo do turno | Sessão | Task | Pai (delegação) |
|---|---|---|---|---|
| `cancel` | morto (árvore), inclusive validação/revisão/backoff em curso | `killed` | `canceled` | `delegation.completed` com `state: canceled` |
| `interrupt` | encerrado (Windows: árvore morta; POSIX: SIGINT, árvore morta após 5 s) | `idle` | `input_required` | nada — a tarefa segue viva |
| `pause` | idem `interrupt` | `paused` | `input_required` | nada |

- O pedido é anotado **antes** de mexer no processo (`packages/daemon/src/session-lifecycle.ts`):
  o fim do processo sozinho não distingue cancelamento de interrupção de falha, e sem a
  anotação o pump tratava tudo como falha (`failed`, com retry).
- Retomar `idle`/`paused` é mandar mensagem (`hub send`, `hub_session_send`): resume nativo quando
  o manifesto declara `session.strategy: native` e o id nativo já apareceu, replay do histórico
  quando não. A tentativa da task continua aberta — interromper não é falhar e não gasta retry.
- Recusas explícitas (`ILLEGAL_STATE`, nunca "interrompido" seguido de morte): agente com
  `session.strategy: none` (não há como retomar), sessão com aprovação pendente
  (`waiting_approval`) e, para `pause`, sessão cujo processo já saiu e está em validação/revisão.
- `pause` não desce para os filhos (ao contrário de `cancel`): cada sessão é pausada e retomada
  por conta própria.
- Falha ao subir o agente (binário ausente, spawn, gate do Codex recusado, projeto não-git) não
  deixa nada para trás: sessão `failed` com o motivo, task `failed`, reserva do orçamento
  devolvida ao fluxo e worktree liberado. Numa continuação (`send`), a sessão volta ao estado
  anterior e segue retomável.

## 4. O EventEnvelope

Todo adapter traduz a saída nativa do agente para este formato. É o coração da observabilidade.

```ts
// packages/core/src/events.ts (resumido)
interface EventEnvelope {
  id: string;
  seq: number;              // monotônico por sessão — garante ordem e replay
  ts: string;               // ISO-8601
  sessionId: string;
  taskId: string | null;
  agentId: string;
  type: EventType;
  payload: Record<string, unknown>;
  cost: EventCost | null;   // tokens (entrada/saída/cache), usd, créditos, parcial/acumulado
  raw: unknown;             // evento original do agente (ver retenção abaixo)
}
```

Tipos de evento (22, `EventType`): `session.started`, `session.ended`, `session.handoff`, `turn.started`, `turn.completed`, `message`, `user.message`, `message.delta`, `reasoning`, `tool.call`, `tool.result`, `file.changed`, `command.executed`, `delegation.requested`, `delegation.completed`, `approval.requested`, `approval.resolved`, `budget.updated`, `budget.warning`, `budget.exceeded`, `error`, `log`.

**Retenção do `raw`.** O `payload` fica no banco sem prazo. O `raw` (bruto do agente, só
para depurar mapper) é compactado para `NULL` depois de `retention.rawEventDays` dias
(padrão 7) do fim da sessão, pelo `EventRetentionCompactor` (`packages/daemon/src/event-retention.ts`).

Mapeamento de referência (mapper declarado em cada manifesto):

| Agente | Fonte | Mapper |
|---|---|---|
| Claude Code / OpenClaude | `-p --output-format stream-json --verbose` | `claude` (dedicado; `result` traz `total_cost_usd`) |
| Codex | `codex exec --json` (JSONL) | `codex` (dedicado) |
| OpenCode | `opencode serve` + SSE (`OpenCodeAdapter`, HTTP) | tradutor próprio em `packages/adapters/src/opencode/` |
| Copilot | `-p ... --output-format json` | `copilot` (dedicado; custo em AI Credits) |
| Kimi | `-p ... --output-format stream-json` | `kimi` (dedicado) |
| Antigravity (`agy`) | `--output-format stream-json -p=<prompt>` | `antigravity` (dedicado) |
| MiMo | `mimo run --format json` | `generic-json` |
| Cursor | `cursor-agent -p --output-format stream-json` | `generic-json`; manifesto **não verificado** (binário ausente) |

## 5. O contrato de Adapter

```ts
// packages/adapters/src/types.ts
interface AgentAdapter {
  readonly manifest: AgentManifest;
  probe(): Promise<ProbeResult>;                        // instalado? versão? autenticado?
  start(ctx: RunContext, prompt: string): Promise<RunHandle>;
  resume(ctx: RunContext, nativeSessionId: string, prompt: string): Promise<RunHandle>;
  send(handle: RunHandle, text: string): Promise<void>; // só onde supportsLiveSend
  interrupt(handle: RunHandle): Promise<void>;          // parar turno atual, manter sessão
  cancel(handle: RunHandle): Promise<void>;             // matar
}
// O stream é `RunHandle.events: AsyncIterable<MappedEvent>`; o fim do processo,
// `RunHandle.done: Promise<RunOutcome>`. O brief vira prompt no SessionManager.
```

Nenhum dos 9 manifestos declara `interactive: true` hoje: `send` numa run viva só existe
no OpenCode (servidor HTTP); nos demais, falar com a sessão abre um turno novo (resume
nativo ou replay).

### Manifesto (adicionar agente = escrever isto, não código)

```yaml
id: codex
name: OpenAI Codex CLI
bin: codex
detect:
  args: ["--version"]
  versionRegex: "(\\d+\\.\\d+\\.\\d+)"
invoke:
  oneShot: ["exec", "--json", "--skip-git-repo-check", "-"]   # `-`: prompt por stdin
  resume:  ["exec", "resume", "{{nativeSessionId}}", "--json", "--skip-git-repo-check", "-"]
  stdinPrompt: true
  modeArgs:                   # como --mode do Hub vira a política nativa do agente
    supervised: ["-c", "sandbox_mode=\"read-only\""]
    semi: ["-c", "sandbox_mode=\"workspace-write\""]
    autonomous: ["-c", "sandbox_mode=\"workspace-write\""]
session:
  strategy: native            # native | replay | none
stream:
  format: jsonl               # jsonl | text
  mapper: codex               # mapper registrado no código
capabilities: [code-edit, refactor, test-writing, code-review, debug, shell, planning]
auth:
  mode: inherit               # o Hub não toca em segredo
model:                        # como o modelo do Hub chega ao CLI
  supported: true             # false = o CLI não aceita (ou não foi conferido)
  args: ["-m", "{{model}}"]   # só entra quando há modelo
  format: "id do modelo"
verified:                     # contra qual binário o manifesto foi conferido
  status: verified            # verified | partial | unverified
  version: "0.155.0"
  date: "2026-09-26"
```

O schema (`AgentManifestSchema`) não é `strict`: campo desconhecido é ignorado sem erro.
Não existe campo `cost` (versões antigas deste documento mostravam `cost.from`) nem
`stream.format: sse` — custo é extraído pelo mapper.

**Modelo por agente.** O modelo de uma run é `ctx.model` ou, na falta dele, a
variável `MODEL` do env do projeto para aquele agente (o campo "Modelo" das
Configurações). Ele só chega ao CLI se o manifesto declarar `model.supported:
true` com a flag real conferida no `--help`; os `model.args` entram inteiros
ou não entram (uma `--model` sem valor engoliria o argumento seguinte), e um
valor que comece com `-` ou tenha caractere de controle é recusado. O
`GET /agents` expõe `model: { supported, format }` e `verified` por agente:
painel e CLI **não devem oferecer** o controle de modelo onde `supported` é
`false`. Contrato fixado em `packages/adapters/src/manifest-model.test.ts`.

## 6. Como "qualquer um chama qualquer um"

O Hub expõe um **MCP server** (`packages/mcp`, stdio) — o denominador comum mais largo entre os agentes (o Kimi 2.0.0 não tem mecanismo de MCP; o caminho do MiMo não foi confirmado — ver `packages/daemon/src/mcp-config.ts`). Cada agente registra o Hub como MCP server em sua própria config e ganha 16 tools (lista completa em [03 §1](03-mcp-e-painel.md)): `hub_agent_list`, `hub_agent_call`, `hub_agent_status`, `hub_agent_wait`, `hub_agent_events`, `hub_agent_cancel`, `hub_session_list`, `hub_session_send`, `hub_session_interrupt`, `hub_session_pause`, `hub_session_handoff`, `hub_session_diff`, `hub_graph`, `hub_budget`, `hub_context_fetch`, `hub_workflow_run`.

Fluxo (Cursor como principal chamando Codex; o Cursor em si nunca foi exercitado — binário ausente nesta máquina):

```
você → Cursor (fora do Hub)
        └─ MCP: hub_agent_call { agent: "codex", objective: "...", budget_usd: 0.5 }
              └─ MCP server sem AGENTS_HUB_SESSION_ID → POST /sessions/adopt (raiz de controle)
              └─ Hub: valida política → checa grafo (depth/ciclo) → reserva orçamento
                    → cria Session filha → WorktreeManager cria worktree isolado
                    → ProcessAgentAdapter + manifesto codex: codex exec --json
                    → normaliza eventos → SQLite + SSE (CLI/Web veem ao vivo)
              ← task_id na hora
        └─ Cursor segue trabalhando; consulta hub_agent_status/hub_agent_wait quando quiser
```

**Não existe servidor A2A.** A rota `/.well-known/agent-card.json` foi removida de propósito
(ver [07 §2.3](07-progresso-real.md)); o que existe é uma API REST simples em `/api/tasks/*`
com descritor em `GET /api/descriptor.json`. "A2A de verdade" (JSON-RPC 2.0) é decisão em
aberto no [ADR 02.3](decisoes/02-orquestracao.md).

## 7. Segurança segregada

| Vetor | Controle (o que existe hoje) |
|---|---|
| Sistema de arquivos | Um git worktree por sessão em `<AGENTS_HUB_HOME>/worktrees/<projeto>/<sessão>`. Escrita fora dele é `escalate` **quando o Hub a vê**: no gate (Claude/Codex) pela ferramenta `Write`/`Edit` ou pelo alvo de comando de shell que o classificador reconhece (`mkdir`, `cp`, `mv`, `touch`, redirecionamento); na vigilância, pelo `file.changed`/`command.executed` do mapper. Escrita feita por dentro de um programa (`node script.js`, `python x.py`) ou por agente cujo mapper não emite esses eventos **não é detectada** — o worktree não é sandbox |
| Comandos shell | Allow/deny list da política (global em `config.json`, projeto só aperta), casada por palavra e segmento a segmento (`command-classifier.ts`); fora da allow list é `escalate` |
| Rede | `network.allowDomains` (padrão vazio). Vale para `WebFetch`/`WebSearch` no gate e para `curl`/`wget`/`Invoke-WebRequest` em shell, pelo classificador de comando (no gate, ou na vigilância quando o mapper emite o `command.executed`). Acesso de rede feito de dentro de um programa ou pela ferramenta de busca embutida de um agente sem gate não é visto |
| Credenciais | O Hub não lê os arquivos de credencial dos CLIs: cada agente roda com o login que já tem (ADR 03.1). Variáveis de ambiente que **você** configura por projeto ficam no banco do Hub ([SECURITY.md](../SECURITY.md)) |
| Escalação de privilégio | Política efetiva = interseção(política do filho, política do pai). Filho nunca supera o pai |
| Loop / recursão | `depth` máx. + detecção de ciclo por `(agent, objective_hash)` no `path[]` |
| Gasto | Orçamento da sessão-raiz consumido pelos descendentes; estouro → aprovação de orçamento (`input_required`) |
| Ações irreversíveis | `git push`, `rm -rf`, publish, leitura/escrita de segredo: aprovação em todos os modos (prévia só nos agentes com gate; nos demais a vigilância para depois do fato) |
| Auditoria | `payload` de todo evento persistido sem prazo; `raw` compactado após `rawEventDays` (7); decisões de gate/aprovação/política em `audit_log` (migração 7, só-acréscimo) |

## 8. Layout do repositório

```
agents-hub/
├── docs/                      # esta documentação + ADRs (docs/decisoes)
├── packages/
│   ├── core/                  # domínio puro: tipos, eventos, política, orçamento, grafo, workflow
│   ├── store/                 # SQLite (node:sqlite) + repositórios + migrações
│   ├── adapters/              # contrato, registry, adapter genérico, OpenCode HTTP, mappers, descoberta
│   ├── daemon/                # SessionManager, HTTP+SSE, gate, worktrees, retenção, auditoria
│   ├── client/                # cliente HTTP compartilhado (CLI, MCP, Web)
│   ├── mcp/                   # MCP server stdio (as 16 tools)
│   ├── cli/                   # `hub` (sem TUI)
│   └── web/                   # Web UI React+Vite, servida pelo daemon
├── manifests/                 # manifestos YAML dos 9 agentes
├── examples/                  # workflow YAML de exemplo
├── scripts/                   # run-tests, demo, coverage, pack-dist, mcp-smoke
└── package.json               # npm workspaces
```
