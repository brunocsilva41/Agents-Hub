# Referência — API HTTP do OpenCode (`opencode serve`)

> Levantada contra o binário real, **opencode 1.17.15** (Windows), lendo a OpenAPI que o
> próprio servidor publica em `GET /doc`. A spec íntegra está em
> [`opencode-openapi.json`](./opencode-openapi.json) (OpenAPI 3.1.0, 162 paths, 472 schemas).
>
> Este documento não repete a spec: registra **o que o `OpenCodeAdapter` usa, por que
> escolheu isso, e onde a realidade contraria o que a spec sugere**. Só o que foi
> confirmado contra o servidor rodando está afirmado como fato.

## 1. Duas APIs no mesmo servidor

O servidor expõe dois conjuntos de rotas convivendo:

| | Prefixo | Exemplo |
|---|---|---|
| Legado (v1) | raiz | `POST /session`, `GET /event`, `POST /session/{id}/abort` |
| Atual (v2) | `/api` | `POST /api/session`, `GET /api/event`, `POST /api/session/{id}/interrupt` |

O adapter fala **exclusivamente v2**. A v2 é a única que expõe o modelo de eventos
`session.next.*` — que é onde vivem custo, tokens, chamadas de ferramenta e passos.
A v1 entrega `message.part.updated`, um formato de patch incremental de partes de
mensagem, muito mais caro de traduzir e sem custo por passo.

## 2. Ciclo de vida da sessão

### Criar — `POST /api/session`

```jsonc
// request
{
  "agent": "build",                                        // opcional
  "model": { "providerID": "opencode", "id": "<model>" },   // opcional
  "location": { "directory": "C:\\caminho\\do\\worktree" }  // opcional
}
// response
{ "data": { "id": "ses_...", "projectID": "...", "cost": 0, "tokens": {...},
            "location": { "directory": "..." }, "title": "..." } }
```

Três coisas confirmadas na prática e que decidem o desenho do adapter:

- **`location.directory` é o `workdir` da sessão.** É assim que o Hub honra o worktree
  isolado sem precisar de um servidor por sessão: um servidor só, N sessões, cada uma
  presa ao seu diretório.
- **Criar sessão não invoca modelo nenhum.** Custo zero, resposta imediata.
- **`agent` e `model` só entram aqui** (ou pelos endpoints `POST /api/session/{id}/agent`
  e `POST /api/session/{id}/model`). Ver §5.

### Prompt — `POST /api/session/{sessionID}/prompt`

```jsonc
// request
{ "prompt": { "text": "..." }, "delivery": "steer" | "queue", "resume": true|false }
// response 200
{ "data": { "admittedSeq": 1, "id": "msg_...", "sessionID": "ses_...",
            "delivery": "steer", "timeCreated": 1787855763153 } }
```

Retorna **assim que o prompt é admitido**, não quando o turno acaba — o resultado vem
todo pelo stream de eventos. `delivery` é o que dá ao Hub duas semânticas distintas com
o mesmo endpoint:

- `steer` — injeta a mensagem no turno em andamento. É o `send()` ao vivo do contrato de
  adapter, que o `ProcessAgentAdapter` só consegue quando o CLI aceita stdin interativo.
- `queue` — enfileira para depois do turno atual.

### Retomar

**Não existe endpoint de resume.** Retomar é mandar outro `prompt` no mesmo `sessionID`;
o servidor carrega o histórico. `GET /api/session/{id}` recupera uma sessão criada em
outro processo do servidor (confirmado), então o id nativo é um handle durável — é o que
autoriza `session.strategy: native` no manifesto.

### Interromper e abortar

- `POST /api/session/{sessionID}/interrupt` → `204`. Para o turno **preservando a
  sessão**. É o `interrupt()` de verdade, sem a degradação para `kill` que o
  `ProcessAgentAdapter` sofre no Windows.
- Não há "matar sessão": `cancel()` = `interrupt` + parar de consumir o stream.

### Armadilha: `POST /api/session/{id}/wait`

A spec descreve "Wait for a session agent loop to become idle" e sugere ser o sinal de
fim de turno. **Não serve**: numa sessão ociosa devolve `503 ServiceUnavailableError`
imediatamente (confirmado), ou seja, não distingue "acabou" de "nunca começou". O adapter
não usa. Ver §4.

## 3. Stream de eventos

### O que funciona: `GET /api/event`

SSE global do servidor. Formato de fio confirmado:

```
data: {"id":"evt_...","type":"server.connected","data":{}}

: heartbeat

data: {"id":"evt_...","type":"session.next.step.started","durable":{...},"location":{...},"data":{...}}
```

- Linhas `data: ` com um JSON por evento; blocos separados por linha em branco.
- Comentários SSE `: heartbeat` mantêm a conexão viva — e servem de sinal de vida para o
  heartbeat do `RunContext`.
- Todo evento tem `{ id, type, data }`; os de sessão trazem `data.sessionID`, e a maioria
  também `durable: { aggregateID, seq, version }` e `location.directory`.

O adapter abre **um** stream global e **filtra por `data.sessionID`**. Um servidor
compartilhado por N runs do Hub custa uma conexão só.

### O que não funciona: `GET /api/session/{sessionID}/event`

A spec anuncia um stream por sessão com replay durável (`?after=<seq>`) — exatamente o
que a gente queria. **Na 1.17.15 essa rota derruba a conexão sem devolver resposta**
(`socket hang up`, com e sem `after`, com e sem `Accept: text/event-stream`). Testado
contra duas sessões, em dois diretórios diferentes. O stream global no mesmo servidor
respondia normalmente no mesmo instante.

Consequência de projeto: sem replay por sessão, o adapter **abre o stream antes de mandar
o prompt**. Não é otimização, é correção — abrir depois perderia os primeiros eventos.

## 4. Quando o turno terminou

Este foi o ponto mais caro de descobrir e o que mais afeta a resiliência.

`session.idle` e `session.status` com `status.type === "idle"` existem no vocabulário e
são o caminho feliz. Mas numa execução real observada, um turno que falhou emitiu
`session.next.step.failed` e **em seguida só heartbeats** — nenhum `session.idle`, nenhum
`session.error`. Quem esperasse só pelo idle ficaria pendurado até o timeout.

Por isso o adapter usa **duas fontes**, e a segunda é a autoridade:

1. **Rápida** — `session.idle` / `session.status{idle}` no stream encerra o turno na hora.
2. **Autoridade** — poll de `GET /api/session/active`, que devolve
   `{"data":{"ses_...":{"type":"running"}}}` só com as sessões com loop ativo. A sessão
   sumir dali significa turno encerrado, tenha o evento vindo ou não.

O poll exige ausências **consecutivas** antes de concluir, porque logo depois do prompt
admitido existe uma janela (~1s medido) em que o loop ainda não começou e a sessão
legitimamente não aparece em `active`. Ver `TURN_SETTLE_POLLS` no adapter.

## 5. Modelo e agente **não** vão no corpo do prompt

Confirmado por execução real: enviar `model` dentro do corpo de
`POST /api/session/{id}/prompt` é **silenciosamente ignorado** — o campo não existe no
schema `PromptInput` e o servidor não reclama. O turno rodou com o modelo default da
sessão e falhou com `HTTP 401 ... Model x-preview-f-free is not supported`.

Portanto o adapter passa `model` (e `agent`) **na criação da sessão**, e para uma sessão
retomada usa `POST /api/session/{id}/model` antes do prompt.

## 6. Eventos que o adapter traduz

`data.*` abaixo é o conteúdo de `data` do evento; `→` é o `MappedEvent.type` do Hub.

| Evento OpenCode | → Hub | Campos usados |
|---|---|---|
| `session.created` | `session.started` | `sessionID`, `info` |
| `session.next.prompt.admitted` | `log` | `messageID`, `prompt.text` |
| `session.next.step.started` | `turn.started` | `assistantMessageID`, `agent`, `model` |
| `session.next.step.ended` | `turn.completed` (+ `file.changed`) | `finish`, `cost`, `tokens`, `files` |
| `session.next.step.failed` | `error` | `error.message` |
| `session.next.text.delta` | `message.delta` | `delta` |
| `session.next.text.ended` | `message` | `text` |
| `session.next.reasoning.ended` | `reasoning` | `text` |
| `session.next.tool.called` | `tool.call` | `tool`, `input`, `callID` |
| `session.next.tool.success` | `tool.result` | `callID`, `content`, `outputPaths` |
| `session.next.tool.failed` | `tool.result` (`ok:false`) | `callID`, `error.message` |
| `session.next.shell.started` | `command.executed` | `command`, `callID` |
| `session.next.shell.ended` | `tool.result` | `callID`, `output` |
| `session.next.retried` | `log` | `attempt`, `error` |
| `session.next.compaction.ended` | `log` | `reason` |
| `session.error` | `error` | `error.name`, `error.data.message` |
| `session.idle` | `session.ended` | `sessionID` |
| `session.status` (`idle`/`retry`) | `session.ended` / `log` | `status` |
| `permission.asked`, `permission.v2.asked` | `approval.requested` | `action`, `resources` |
| `permission.replied`, `permission.v2.replied` | `approval.resolved` | `reply` |
| `command.executed` | `command.executed` | `name`, `arguments` |
| `todo.updated` | `log` | `todos` |

### Custo — o ganho principal sobre a CLI

`session.next.step.ended` traz, por passo:

```jsonc
{ "finish": "stop", "cost": 0.0123,
  "tokens": { "input": 1200, "output": 340, "reasoning": 0,
              "cache": { "read": 800, "write": 0 } } }
```

Mapeia direto para `EventCost`: `usd` ← `cost`, `inputTokens` ← `tokens.input`,
`outputTokens` ← `tokens.output` + `tokens.reasoning`, `cachedTokens` ←
`cache.read + cache.write`. Pela CLI nada disso existia.

### `file.edited` é descartado, de propósito

`file.edited` tem `data: { file }` e **nenhum `sessionID`**. Num servidor com várias
sessões do Hub, atribuí-lo a uma delas seria chute. Os arquivos alterados vêm de
`session.next.step.ended.files`, que é por sessão e por passo.

## 7. Descoberta e saúde

- `GET /api/health` → `{"healthy":true}`. É o que o adapter usa para decidir entre
  reaproveitar um servidor existente e subir o seu.
- `GET /api/model` → catálogo com `cost` por modelo (há entradas com custo zero).
- `GET /api/agent` → agentes configurados (`build`, etc.), com permissões.
- `GET /doc` → esta spec.

O servidor avisa no boot: `OPENCODE_SERVER_PASSWORD is not set; server is unsecured`.
O adapter sobe sempre em `127.0.0.1`, nunca em `0.0.0.0`.
