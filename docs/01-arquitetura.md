# 01 — Arquitetura do Agents-Hub

## 1. Conceito central

> O Hub não é "mais um agente". É o **plano de controle** onde qualquer agente pode ser orquestrador e orquestrado, através de um único modelo de sessão, evento, política e orçamento.

Três invariantes que sustentam tudo:

1. **Nenhum papel é fixo.** "Principal" é apenas quem detém a sessão-raiz. O Cursor pode ser principal hoje e subordinado amanhã, sem mudar uma linha de código.
2. **Todo agente é reduzido ao mesmo contrato.** `start · send · stream · interrupt · resume · cancel · status`. Onde o CLI não suporta, o Hub emula e o manifesto declara a degradação.
3. **Todo evento é normalizado.** Oito agentes com oito formatos de saída viram UM `EventEnvelope`. Sem isso não existe grafo, custo consolidado nem UI unificada.

## 2. Camadas

```
┌──────────────────────────────────────────────────────────────┐
│  CLIENTES        CLI          TUI           Web UI (React)   │
│                    └────────────┴──────────────┘             │
│                       HTTP + SSE (API única)                 │
├──────────────────────────────────────────────────────────────┤
│  TRANSPORTS   MCP Server    A2A Server    REST/SSE           │
│   (entrada)   agent.call    Agent Card    /sessions /tasks   │
│               agent.status  tasks/*       /events (SSE)      │
├──────────────────────────────────────────────────────────────┤
│  CORE (domínio, puro, sem I/O)                               │
│   Orchestrator · SessionManager · CallGraph · PolicyEngine   │
│   BudgetLedger · ResiliencePipeline · CapabilityRegistry     │
├──────────────────────────────────────────────────────────────┤
│  ADAPTERS (um por agente, dirigidos por manifesto)           │
│   claude · codex · opencode · cursor · copilot               │
│   antigravity · kimi · mimo · <manifesto genérico>           │
├──────────────────────────────────────────────────────────────┤
│  INFRA   SQLite (node:sqlite) · WorktreeManager · ProcessHost│
│          ArtifactStore · Logger                              │
└──────────────────────────────────────────────────────────────┘
```

**Regra de dependência:** setas apontam só para baixo. `core` não conhece adapters nem HTTP — recebe portas (interfaces) injetadas. É o que torna o Hub testável sem invocar nenhum agente de verdade.

## 3. Modelo de domínio

| Entidade | Descrição | Chaves |
|---|---|---|
| `Project` | Repositório registrado no Hub | `id`, `path`, `defaultBranch`, `config` |
| `Session` | Conversa contínua com UM agente | `id`, `projectId`, `agentId`, `nativeSessionId`, `rootId`, `parentId`, `depth`, `state`, `mode` |
| `Task` | Unidade de trabalho delegada (ciclo A2A de 8 estados) | `id`, `sessionId`, `brief`, `state`, `attempts[]`, `result` |
| `Event` | Fato normalizado emitido por qualquer agente | `id`, `sessionId`, `taskId`, `seq`, `type`, `payload`, `ts` |
| `Approval` | Ação bloqueada aguardando decisão humana | `id`, `taskId`, `risk`, `action`, `state` |
| `BudgetLedger` | Consumo (tokens/USD/tempo) por sessão-raiz | `rootId`, `limits`, `consumed` |
| `Artifact` | Saída material (diff, arquivo, relatório, log) | `id`, `taskId`, `kind`, `path`, `hash` |

### Estados de Task (alinhado ao A2A v1.0)

`submitted → working → (input_required | auth_required) → completed | failed | canceled | rejected`

### Estados de Session

`idle · running · waiting_approval · paused · completed · failed · killed`

## 4. O EventEnvelope

Todo adapter traduz a saída nativa do agente para este formato. É o coração da observabilidade.

```ts
type EventEnvelope = {
  id: string;
  seq: number;              // monotônico por sessão — garante ordem e replay
  ts: string;               // ISO-8601
  sessionId: string;
  taskId?: string;
  agentId: string;
  type: EventType;
  payload: unknown;         // tipado por discriminação em `type`
  cost?: { inputTokens?: number; outputTokens?: number; usd?: number };
  raw?: unknown;            // evento original do agente, preservado para depuração
};
```

Tipos de evento: `session.started`, `session.ended`, `turn.started`, `turn.completed`, `message.delta`, `message`, `reasoning`, `tool.call`, `tool.result`, `file.changed`, `command.executed`, `delegation.requested`, `delegation.completed`, `approval.requested`, `approval.resolved`, `budget.updated`, `budget.exceeded`, `error`, `log`.

Mapeamento de referência (o que cada agente já emite):

| Agente | Fonte | Exemplo de tradução |
|---|---|---|
| Claude Code | `claude -p --output-format stream-json` | `assistant` → `message`, `tool_use` → `tool.call`, `result` → `turn.completed` + `cost` |
| Codex | `codex exec --json` (JSONL) | `thread.started` → `session.started`, `item.command_execution` → `command.executed`, `turn.completed` → `turn.completed` |
| OpenCode | `opencode serve` + SSE | eventos de sessão via `/event` → mapeados 1:1 |
| Cursor | `cursor-agent -p --output-format stream-json` | deltas → `message.delta` |
| Copilot / Kimi / MiMo / Antigravity | `-p` + parse de stdout/JSON | mínimo: `message`, `turn.completed`, `error` |

## 5. O contrato de Adapter

```ts
interface AgentAdapter {
  readonly manifest: AgentManifest;
  probe(): Promise<ProbeResult>;                       // instalado? versão? autenticado?
  start(ctx: RunContext, brief: Brief): Promise<RunHandle>;
  send(handle: RunHandle, text: string): Promise<void>; // injetar mensagem ao vivo
  stream(handle: RunHandle): AsyncIterable<EventEnvelope>;
  interrupt(handle: RunHandle): Promise<void>;          // parar turno atual, manter sessão
  cancel(handle: RunHandle): Promise<void>;             // matar
  resume(ctx: RunContext, nativeSessionId: string, text: string): Promise<RunHandle>;
}
```

### Manifesto (adicionar agente = escrever isto, não código)

```yaml
id: codex
name: OpenAI Codex CLI
bin: codex
detect:
  args: ["--version"]
  versionRegex: "(\\d+\\.\\d+\\.\\d+)"
invoke:
  oneShot: ["exec", "--json", "{{prompt}}"]
  resume:  ["exec", "resume", "{{nativeSessionId}}", "--json", "{{prompt}}"]
session:
  strategy: native            # native | replay | none
stream:
  format: jsonl               # jsonl | text | sse
  mapper: codex               # mapper registrado no código
capabilities: [code-edit, test-writing, refactor, shell]
auth:
  mode: inherit               # o Hub não toca em segredo
cost:
  from: "$.usage"
```

## 6. Como "qualquer um chama qualquer um"

O Hub expõe um **MCP server** — o único denominador comum entre os 8 agentes. Cada agente registra o Hub como MCP server em sua própria config e ganha estas tools:

| Tool | Efeito |
|---|---|
| `hub_agent_list` | lista agentes disponíveis, capabilities e estado de saúde |
| `hub_agent_call` | delega um Brief; retorna `task_id` imediatamente (assíncrono) |
| `hub_agent_status` | consulta estado/resultado da task |
| `hub_agent_stream` | acompanha eventos da task em andamento |
| `hub_agent_cancel` | cancela a task |
| `hub_session_list` / `hub_session_send` | inspeciona e injeta mensagem em sessões vivas |

Fluxo real (Cursor como principal chamando Codex):

```
você → Cursor (sessão-raiz)
        └─ MCP: hub_agent_call { agent: "codex", objective: "...", budget: {...} }
              └─ Hub: valida política → checa grafo (depth/ciclo) → reserva orçamento
                    → cria Session filha → WorktreeManager cria worktree isolado
                    → CodexAdapter: codex exec --json
                    → normaliza eventos → SQLite + SSE (CLI/TUI/Web veem ao vivo)
              ← task_id na hora
        └─ Cursor segue trabalhando; consulta hub_agent_status quando quiser
```

O mesmo Hub, pelo **A2A server**, publica `/.well-known/agent-card.json` para peers externos — quem falar A2A v1.0 orquestra o Hub sem saber o que existe dentro.

## 7. Segurança segregada

| Vetor | Controle |
|---|---|
| Sistema de arquivos | Um git worktree por sessão em `~/.agents-hub/worktrees/<project>/<session>`; escrita fora dele é `escalate` (pede aprovação) |
| Comandos shell | Allowlist declarativa por agente; fora dela é `escalate` |
| Rede | Domínios permitidos por política; padrão nega o que não estiver listado |
| Credenciais | Herdadas do CLI nativo — o Hub nunca lê nem persiste segredo (ADR 03) |
| Escalação de privilégio | Política efetiva = interseção(política do agente, política herdada do pai). Filho nunca supera o pai |
| Loop / recursão | `depth` máx. + detecção de ciclo por `(agent, objective_hash)` no `path[]` |
| Gasto | Orçamento da sessão-raiz consumido pelos descendentes; estouro → `input_required` |
| Ações irreversíveis | `git push`, delete, publish, envio externo: sempre pedem aprovação |
| Auditoria | Todo evento persistido com `raw` original; trilha completa de quem pediu o quê, com que política e a que custo |

## 8. Layout do repositório

```
agents-hub/
├── docs/                      # esta documentação + ADRs
├── packages/
│   ├── core/                  # domínio puro: tipos, eventos, política, orçamento, grafo
│   ├── store/                 # SQLite (node:sqlite) + repositórios + migrações
│   ├── adapters/              # contrato, registry, manifesto genérico, adapters por agente
│   ├── daemon/                # orquestrador, HTTP+SSE, MCP server, A2A server
│   ├── cli/                   # `hub` (CLI + TUI)
│   └── web/                   # Web UI React+Vite (fase 2)
├── manifests/                 # manifestos YAML dos 8 agentes
└── package.json               # npm workspaces
```
