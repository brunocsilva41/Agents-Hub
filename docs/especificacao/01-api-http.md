# SPEC-01 — Contrato HTTP do daemon

Este documento descreve a API HTTP local do daemon TypeScript como ela existe hoje.
É o contrato que a reescrita em C precisa manter (ADR 7.6 e 7.10 em
[07-reescrita-nativa.md](../decisoes/07-reescrita-nativa.md)). Tudo aqui foi
extraído do código em `main` (commit `82f40cc`); cada afirmação traz o `arquivo:linha`
de onde saiu. Os caminhos são relativos a `packages/`.

**Contagem: 58 rotas, 13 delas com token de operador.** Como foram contadas:

1. `HubServer.routeTable()` (`daemon/src/server.ts:213-215`) foi executado num Hub
   montado em processo, com `AGENTS_HUB_HOME` temporário, `port: 0` e
   `AGENTS_HUB_NO_AUTOSTART=1`, sem `listen`. Saída: `TOTAL 58 OPERATOR 13`.
2. Grep dos registros: 46 em `daemon/src/server.ts` (43 antes dos módulos e 3 depois
   deles: `GET /graph/:rootId`, `GET /budget/:rootId` e `GET /events`), 4 em
   `operator-routes.ts`, 1 em `maintenance-routes.ts`, 5 em `operation-routes.ts` e 2 em
   `integration-routes.ts`. Total: 46 + 4 + 1 + 5 + 2 = 58.
3. Conferência com `daemon/src/operator-routes-table.test.ts`. A lista fixa dele
   (linhas 105-116) cita 10 das 13 rotas de operador. As outras três
   (`POST /maintenance/backup`, `PUT /budget/:rootId` e
   `POST /integrations/:agentId/:tipo`) entram no teste dinâmico, que percorre a tabela
   inteira (linhas 153-179). Todo par método + caminho citado nos `*.test.ts` do daemon
   está na tabela.

Fora da tabela existe um único comportamento: servir o painel estático em `GET`
(seção 7).

---

## 1. Bind, porta e ciclo de vida

O daemon escuta HTTP/1.1 sem TLS em `127.0.0.1:4747` por padrão.

| Item | Valor | Onde |
|---|---|---|
| Host padrão | `127.0.0.1` | `daemon/src/config.ts:321` |
| Porta padrão | `4747` | `daemon/src/config.ts:322` |
| Precedência | padrão < `config.json` < `AGENTS_HUB_PORT` < override no código | `daemon/src/config.ts:314-328` |
| `config.json` | `<AGENTS_HUB_HOME>/config.json`, chaves `host` (texto ≥ 1) e `port` (inteiro 1–65535) | `daemon/src/config.ts:307`, `:213-214` |
| `AGENTS_HUB_PORT` | inteiro 1–65535; valor inválido impede a subida (`HUB_CONFIG_INVALID`) | `core/src/hub-env.ts:23-28` |
| `AGENTS_HUB_HOME` | padrão `~/.agents-hub` | `daemon/src/config.ts:306` |
| `port: 0` | o SO escolhe a porta; a porta real volta para a config, porque a guarda valida `Host`/`Origin` contra ela | `daemon/src/server.ts:182-184` |
| Teto de conexões SSE | `maxSseConnections`, padrão 100, faixa 1–100000 em `config.json` | `daemon/src/config.ts:88`, `:217` |

`main.ts` repassa `AGENTS_HUB_PORT` a `createHub` e chama `hub.start()`
(`daemon/src/main.ts:7-12`). `SIGINT` e `SIGTERM` disparam o desligamento
(`daemon/src/main.ts:27-28`).

**A porta é o lock de instância.** `start()` liga a porta antes de tocar no banco.
Um segundo daemon falha no `listen` e sai sem reconciliar nada
(`daemon/src/hub.ts:154-174`).

**Timeouts do servidor HTTP.** O código não define `keepAliveTimeout`,
`requestTimeout`, `headersTimeout` nem `maxHeaderSize` (grep em `daemon/src/*.ts`
sem resultado). Os valores efetivos são os padrões do Node. Quais valores o C deve
adotar: NÃO DETERMINADO pelo código.

**Não há CORS.** Nenhum cabeçalho `Access-Control-*` é emitido (grep em
`daemon/src/*.ts` sem resultado). `OPTIONS` e `HEAD` não têm rota: caem no 404 JSON,
porque o despacho compara o método exato (`daemon/src/server.ts:236`) e o painel
estático só atende `GET` (`daemon/src/server.ts:278`).

### `GET /health`

Rota aberta. Resposta `200` (`daemon/src/server.ts:291-301`):

```json
{ "ok": true, "version": "0.1.0", "now": "<ISO 8601>", "liveSessions": 0, "subscribers": 0 }
```

`liveSessions` vem de `sessions.liveCount()`. `subscribers` é o número de assinantes
do barramento, ou seja, conexões SSE ativas. Os observadores internos (auditoria) não
entram nessa conta (`daemon/src/bus.ts:30-35`, `:72-74`). O caminho de `home` não sai
de propósito (`daemon/src/server.ts:296-297`).

### `POST /shutdown`

Exige token de operador (`daemon/src/server.ts:976-990`). Grava `daemon.shutdown` na
auditoria, responde `200 {"ok":true,"message":"encerrando"}` e só **100 ms depois**
chama `onShutdown` (`daemon/src/server.ts:985-987`). `onShutdown` roda
`hub.shutdown()` e encerra o processo com código 0, ou 1 se o desligamento falhar
(`daemon/src/hub.ts:239`, `daemon/src/safety-net.ts:91-108`). O corpo não é lido.

---

## 2. Formato das respostas e dos erros

**Toda resposta JSON** sai com `Content-Type: application/json; charset=utf-8` e
`Content-Length` (`daemon/src/server.ts:1130-1137`). Depois da guarda, todas as
respostas levam `Vary: Origin` (`daemon/src/server.ts:231`).

**Corpo de erro.** Sempre `{"error": {...}}`. Há duas formas:

| Origem | Corpo | Onde |
|---|---|---|
| `HubError` lançado por rota | `{"error":{"code","message","details"}}` (`details` é objeto, `{}` se vazio) | `daemon/src/server.ts:1140-1142`, `core/src/errors.ts:55-57` |
| Guarda de borda | `{"error":{"code":"FORBIDDEN","message"}}` com status 403 **ou 415** (o código é `FORBIDDEN` nos dois) | `daemon/src/server.ts:221-227` |
| Sem token de operador | `401 {"error":{"code":"UNAUTHORIZED","message"}}` + `WWW-Authenticate: Bearer realm="agents-hub"` | `daemon/src/server.ts:243-256` |
| Rota inexistente | `404 {"error":{"code":"NOT_FOUND","message":"Rota <path> não existe"}}` | `daemon/src/server.ts:286` |
| Teto de SSE | `503 {"error":{"code":"SSE_CONNECTION_LIMIT","message"}}` | `daemon/src/server.ts:1118-1127` |
| URL inválida (não `HubError`) | `400 {"error":{"code":"MALFORMED_URL","message":"URL malformada"}}` | `daemon/src/server.ts:1144-1146` |
| Qualquer outra exceção | `500 {"error":{"code":"INTERNAL","message":<mensagem da exceção>}}` | `daemon/src/server.ts:1148-1150` |

Só a primeira forma tem `details`. Método errado num caminho existente dá 404, não 405
(`daemon/src/server.ts:236`, `:286`).

Uma exceção fora do `try` das rotas (por exemplo, no `new URL` de
`daemon/src/server.ts:233`) cai em `falhaDeDespacho`. Não identifiquei um `Host` que
passe pela guarda (`daemon/src/guard.ts:117-123`) e ainda quebre `new URL`: o tratamento
existe como rede de segurança. Ele responde com
`sendError` ou, se o cabeçalho já saiu, destrói o socket
(`daemon/src/server.ts:172`, `:1253-1263`).

**Tabela código → status** (`statusFor`, `daemon/src/server.ts:1153-1205`):

| Status | Códigos |
|---|---|
| 404 | `AGENT_NOT_FOUND`, `SESSION_NOT_FOUND`, `TASK_NOT_FOUND`, `PROJECT_NOT_FOUND`, `APPROVAL_NOT_FOUND`, `FOLDER_NOT_FOUND` |
| 422 | `INVALID_BRIEF`, `AGENT_CONFIG_INVALID` |
| 403 | `POLICY_DENIED` |
| 428 | `APPROVAL_REQUIRED` |
| 409 | `BUDGET_EXCEEDED`, `DEPTH_EXCEEDED`, `CYCLE_DETECTED`, `CONCURRENCY_EXCEEDED`, `CONFIG_CHANGED` |
| 504 | `TIMEOUT` |
| 400 | `INVALID_QUERY`, `INVALID_ID`, `INVALID_JSON`, `INVALID_PATH`, `MALFORMED_URL` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 424 | `AGENT_NOT_INSTALLED`, `AGENT_NOT_AUTHENTICATED`, `CAPABILITY_UNRESOLVED`, `CODEX_GATE_NOT_GUARANTEED` |
| 502 | `ADAPTER_FAILURE` |
| 400 (padrão) | todos os outros, entre eles `ILLEGAL_STATE`, `FOLDER_IS_PRIMARY`, `PROJECT_FOLDER_CONFLICT`, `PROJECT_CONFIG_INVALID`, `HUB_CONFIG_INVALID` |

A lista completa de `HubErrorCode` está em `core/src/errors.ts:6-42`.

**Validação de corpo** (`readBody`, `daemon/src/server.ts:1211-1220`). Corpo que não
passa no schema zod vira `422 INVALID_BRIEF`, com a mensagem
`"corpo da requisição inválido"` e
`details.issues = [{ "path": "a.b", "message": "..." }]`. Os módulos de rota fazem o
mesmo com as próprias mensagens (`daemon/src/operator-routes.ts:67-75`,
`daemon/src/maintenance-routes.ts:51-56`, `daemon/src/operation-routes.ts:70-78`,
`daemon/src/integration-routes.ts:91-96`). Todos os schemas de corpo são `.strict()`:
uma chave desconhecida é erro 422. Os schemas estão em `daemon/src/http-schemas.ts`.

**Validação de parâmetro de caminho** (`param`, `daemon/src/server.ts:1228-1237`).
Um id fora do formato vira
`400 INVALID_ID "parâmetro \"<nome>\" inválido"`, com
`details = { valor, message }`. Exceção: os módulos de política e de integrações usam
`INVALID_QUERY` (400), não `INVALID_ID`. Isso vale para o `:id` de
`PUT /projects/:id/policy`, para a query de `GET /policy`, `GET /audit` e
`GET /integrations`, e para os parâmetros de caminho de
`POST /integrations/:agentId/:tipo` (`daemon/src/operator-routes.ts:56-65`,
`daemon/src/integration-routes.ts:63-67`, `:81-90`). Formatos de id (`daemon/src/http-schemas.ts:14-33`):

| Schema | Regex (sem distinção de caixa) | Tamanho |
|---|---|---|
| `SessionIdSchema` | `^ses_[a-z0-9]+$` | 1–64 |
| `TaskIdSchema` | `^tsk_[a-z0-9]+$` | 1–64 |
| `ApprovalIdSchema` | `^apv_[a-z0-9]+$` | 1–64 |
| `ProjectIdSchema` | `^prj_[a-z0-9]+$` | 1–64 |
| `FolderIdSchema` | `^pfd_(?:prj_)?[a-z0-9]+$` | 1–64 |
| `AgentIdParamSchema` | `^[a-z0-9][a-z0-9_-]*$` | 1–64 (`http-schemas.ts:201-205`) |
| `RunIdSchema` | `^wfr_[a-z0-9]{1,60}$` | — (`operation-routes.ts:59`) |
| `AgentIdSchema` (integrações) | `^[a-z0-9][a-z0-9-]{0,39}$` (sensível a caixa) | — (`integration-routes.ts:30`) |

**Ordem de validação.** O token vem antes de tudo (`daemon/src/server.ts:240-258`).
Depois disso, a ordem entre corpo e parâmetro varia por rota. `POST /projects/:id/trust`,
`POST /projects/:id/folders` e `PUT /projects/:id/context` leem o corpo antes de
validar `:id` (`daemon/src/server.ts:521-522`, `:553-554`, `:610-611`).
`POST /projects/:id/import` e `PUT /projects/:id/policy` validam `:id` primeiro
(`daemon/src/server.ts:634-635`, `daemon/src/operator-routes.ts:147-148`).

**Query strings numéricas.** `inteiroOpcional` (`daemon/src/http-schemas.ts:170-175`)
trata `NaN` e negativos como ausência e aplica um teto. `parseSseSince`
(`daemon/src/http-schemas.ts:189-199`) é estrito: `since` presente e fora de `^\d+$`
vira `400 INVALID_QUERY`.

---

## 3. Guarda de borda (Host, Origin, CSRF, Content-Type)

`guardRequest` roda antes de qualquer rota e de qualquer arquivo estático
(`daemon/src/server.ts:221-227`). As checagens, em ordem
(`daemon/src/guard.ts:50-114`):

1. **Host.** Se o cabeçalho `Host` existir, o nome sem porta precisa ser `127.0.0.1`,
   `localhost` ou `::1` (colchetes removidos). Se trouxer porta, ela precisa ser a
   porta do daemon. Senão: `403`, motivo "possível DNS rebinding"
   (`daemon/src/guard.ts:54-61`, `:117-123`). `Host` ausente passa.
2. **Origin.** Se existir, `Origin: null` é recusado. Os demais valores precisam usar o
   esquema `http:` ou `https:`, o host `127.0.0.1`, `localhost` ou `[::1]` e a **porta
   efetiva** igual à do daemon. A porta implícita é 80 (http) ou 443 (https), nunca
   "qualquer uma". Senão: `403` (`daemon/src/guard.ts:66-73`, `:125-138`).
3. **Sec-Fetch-Site.** Vale para métodos que mudam estado, isto é, tudo que não é `GET`,
   `HEAD` ou `OPTIONS`, inclusive métodos desconhecidos. Se o cabeçalho existir e não
   for `same-origin` nem `none`: `403` (`daemon/src/guard.ts:42-48`, `:78-87`).
4. **Content-Type.** Vale só para `POST`, `PUT` e `PATCH`. Conta como "tem corpo"
   quando há `Transfer-Encoding`, `Content-Length` diferente de `"0"` ou, sem
   `Content-Length`, algum `Content-Type` declarado. Com corpo, o tipo base precisa
   ser `application/json`; parâmetros como `; charset=utf-8` são aceitos. Senão:
   **`415`** com código `FORBIDDEN` (`daemon/src/guard.ts:89-111`, `:140-144`). Um
   `POST` sem `Content-Length` e sem `Content-Type` passa (ex.:
   `curl -X POST .../shutdown`).

Cabeçalho repetido: vale o primeiro valor (`daemon/src/guard.ts:146-149`).

---

## 4. Token de operador

**Geração.** `createHub` chama `ensureOperatorToken(config.home)`
(`daemon/src/hub.ts:111`). O arquivo é `<AGENTS_HUB_HOME>/operator-token`
(`core/src/operator-token.ts:15`, `daemon/src/operator-auth.ts:54-56`):

- Um token existente é reaproveitado se, depois de `trim`, casar com `^[0-9a-f]{64}$`
  (`core/src/operator-token.ts:30`, `daemon/src/operator-auth.ts:71-77`, `:98-106`).
  No POSIX, reaplica `chmod 0600` a cada subida.
- Se não existir ou for inválido, o daemon gera 32 bytes aleatórios em hex. Grava
  `<token>\n` num temporário `operator-token.tmp-<pid>-<base36>` com modo `0600` e flag
  `wx`, restringe a permissão e faz `rename` para o nome final
  (`daemon/src/operator-auth.ts:79-91`). No Windows, a restrição é
  `icacls <arq> /inheritance:r /grant:r <principal>:F`. O `<principal>` é
  `DOMINIO\usuário` quando `USERDOMAIN` está definido e só `usuário` quando não está
  (`daemon/src/operator-auth.ts:122-136`, `:124-125`). Se a restrição falhar, o token funciona
  assim mesmo e o daemon emite um aviso no log (`daemon/src/operator-auth.ts:85-90`).
- Para rotacionar, apague o arquivo e reinicie o daemon
  (`daemon/src/operator-auth.ts:61-63`).
- Não existe variável de ambiente para o token (`client/src/operator-token.ts:13-15`).

**Como o cliente apresenta o token** (`authenticateOperator`,
`daemon/src/operator-auth.ts:166-180`). Ordem:

1. `Authorization: Bearer <token>`: regex `^Bearer\s+(\S+)\s*$`, sem distinção de caixa.
2. `X-Hub-Token: <token>` (`core/src/operator-token.ts:21`). Só é lido se não houver
   um Bearer válido.
3. Cookie `hub_operator=<token>` (`core/src/operator-token.ts:18`).

Se veio um token por cabeçalho (passo 1 ou 2) e ele está errado, a resposta é `null`
(401). O cookie **não** é consultado nesse caso (`daemon/src/operator-auth.ts:170-171`).
A comparação é em tempo constante (`timingSafeEqual`,
`daemon/src/operator-auth.ts:154-158`).

**Identidade (`by` na auditoria).** Por cabeçalho, `X-Hub-Client: web` produz `web`; o
cabeçalho `X-Hub-Client` sozinho não autentica nada
(`core/src/operator-token.ts:23-27`). Qualquer outro valor produz
`cli:<usuário do SO do daemon>`. Pelo cookie, o resultado é `web`
(`daemon/src/operator-auth.ts:172-178`). O campo `by` do corpo de
`POST /approvals/:id` é aceito pelo schema e **ignorado**
(`daemon/src/server.ts:898-901`, `:911`).

**Cookie do painel.** Um `GET` que não casa com nenhuma rota ganha
`Set-Cookie: hub_operator=<token>; HttpOnly; SameSite=Strict; Path=/`, sem `Secure` e
sem `Max-Age` (`daemon/src/operator-auth.ts:223-225`), quando valem ao mesmo tempo
(`daemon/src/operator-auth.ts:210-216`):

- `Sec-Fetch-Dest: document`
- `Sec-Fetch-Mode: navigate`
- `Sec-Fetch-Site` igual a `none` ou `same-origin`

Se o arquivo estático não for servido, o `Set-Cookie` é removido antes do 404
(`daemon/src/server.ts:279-283`).

**Rota de operador sem credencial válida:** `401 UNAUTHORIZED`, checado antes de ler
corpo ou parâmetro (`daemon/src/server.ts:240-256`).

**Clientes** (`client/src/index.ts:38-51`, `:109-112`). A CLI manda
`Authorization: Bearer`, com o token lido do arquivo
(`client/src/operator-token.ts:17-30`). O navegador usa o cookie. O MCP server e o hook
do gate não mandam token, de propósito.

---

## 5. Limites de corpo, `%` malformado e URL

- **Teto de corpo: 5.000.000 bytes** (`daemon/src/http-body.ts:19`). Se o
  `Content-Length` declarado passar do teto, a resposta é `413 PAYLOAD_TOO_LARGE`
  antes de ler um byte. Sem tamanho declarado (chunked), o corte acontece no primeiro
  pedaço que passa do limite (`daemon/src/http-body.ts:39-65`).
  `details = { limiteBytes }`, mensagem `"corpo da requisição maior que 5 MB"`
  (`daemon/src/http-body.ts:21-27`).
- Depois do 413, o resto do corpo é **descartado** sem ser guardado, até 64.000.000
  bytes; passando disso, o socket é destruído (`daemon/src/http-body.ts:93-113`).
- Corpo vazio ou só com espaços é lido como `{}` (`daemon/src/http-body.ts:69-72`).
  JSON inválido dá `400 INVALID_JSON` sem ecoar a mensagem do parser
  (`daemon/src/http-body.ts:73-79`).
- **`%` malformado** num segmento que vira parâmetro: `400 MALFORMED_URL`, mensagem
  `"URL com codificação percentual (%) malformada"`,
  `details.segmento` = os primeiros 200 caracteres
  (`daemon/src/http-body.ts:116-124`, `daemon/src/server.ts:264-267`). O casamento
  de rota usa o caminho ainda codificado, e cada parâmetro casa `[^/]+`
  (`daemon/src/server.ts:199-204`). Por isso `%2F` dentro de um id não cria segmento
  novo: ele é decodificado e reprovado pelo schema do id (teste
  `GET /workflows/runs/..%2Fshutdown`).
- Os parâmetros de query são lidos com `URLSearchParams`, sem schema geral. Cada rota
  valida os seus.

---

## 6. Tabela de rotas

Legenda:

- **Op.**: "sim" = `operator: true`, exige o token (401 sem ele).
- **Erros comuns** valem para todas as rotas e não são repetidos na tabela: 403/415
  `FORBIDDEN` da guarda, 500 `INTERNAL`, 404 `NOT_FOUND` para caminho inexistente.
- Rota com corpo lido também pode dar **400 `INVALID_JSON`**, **413
  `PAYLOAD_TOO_LARGE`** e **422 `INVALID_BRIEF`**.
- Rota com parâmetro de caminho também pode dar **400 `INVALID_ID`** e **400
  `MALFORMED_URL`**.
- Nas colunas de erro aparecem só os erros específicos visíveis no handler. Os códigos
  que a camada de domínio (`SessionManager`, `PolicyService` etc.) pode lançar além
  desses **não foram enumerados rota a rota**. A lista exaustiva por rota é NÃO
  DETERMINADA neste documento (exigiria percorrer `daemon/src/session-manager.ts`,
  com mais de 3700 linhas). O status de qualquer código segue a seção 2.
- Os tipos de objeto estão em `core/src/domain.ts`: `Project` (`:68`), `ProjectFolder`
  (`:128`), `Session` (`:139`), `Task` (`:183`), `Approval` (`:204`) e `Artifact` (`:220`).
  `BudgetSnapshot` está em `core/src/budget.ts:61`, `GraphNode` em
  `core/src/graph.ts:61`, `EventEnvelope` em `core/src/events.ts:72-88` e
  `AuditEntry` em `core/src/audit.ts:25`. Este documento não expande esses tipos.

### 6.1 Saúde, agentes, descoberta

| # | Método e caminho | Op. | Entrada | Sucesso | Erros específicos | Onde |
|---|---|---|---|---|---|---|
| 1 | `GET /health` | não | — | 200 `{ok,version,now,liveSessions,subscribers}` | — | `daemon/src/server.ts:291-301` |
| 2 | `GET /agents` | não | — | 200 `{agents:[{id,name,vendor,description,capabilities,sessionStrategy,streamFormat,caveats,loginHint,model:{supported,format},verified,probe}]}`; `probe` é `ProbeResult` (`adapters/src/types.ts:239`) ou `null` | — | `daemon/src/server.ts:304-325` |
| 3 | `POST /agents/probe` | não | corpo ignorado | 200 `{probes:[ProbeResult]}` (força novo probe) | — | `daemon/src/server.ts:327-329` |
| 4 | `GET /discovery` | não | query `refresh=1\|true` força releitura (cache de 30 s) | 200 `{agents:[AgentDiscovery]}` (`core/src/discovery.ts:31`) | — | `daemon/src/server.ts:335-342`, `daemon/src/absorption.ts:206` |
| 5 | `GET /discovery/:agentId` | não | `:agentId` = `AgentIdParamSchema`; query `refresh` | 200 `{agent:AgentDiscovery}` | 404 `AGENT_NOT_FOUND` (agente fora do registry) | `daemon/src/server.ts:344-347`, `daemon/src/absorption.ts:214` |

### 6.2 API REST de tasks (automação externa)

Esta API **não** é o protocolo A2A. Não existe `/.well-known/agent-card.json`
(`daemon/src/server.ts:349-359`).

| # | Método e caminho | Op. | Entrada | Sucesso | Erros específicos | Onde |
|---|---|---|---|---|---|---|
| 6 | `GET /api/descriptor.json` | não | — | 200 `ApiDescriptor` (`daemon/src/api-tasks.ts:14-32`); `url` e `endpoints.*` montados com o `Host` da requisição (`daemon/src/server.ts:360-363`); `authentication.mode` é sempre `"none"` (`api-tasks.ts:63-65`); `version` `"0.1.0"`, `apiVersion` `"1.0"` | — | `daemon/src/server.ts:365-367`, `daemon/src/api-tasks.ts:34-68` |
| 7 | `POST /api/tasks` | não | `CreateTaskSchema` (`http-schemas.ts:154-167`), ver 6.9 | 201 `{task:TaskResponse, session, budget, approval\|null}` | 400 `INVALID_PATH` (`projectPath`); erros de `sessions.start` | `daemon/src/server.ts:369-400` |
| 8 | `GET /api/tasks/:id` | não | `:id` = `TaskIdSchema` | 200 `{task:TaskResponse}` | 404 `TASK_NOT_FOUND` | `daemon/src/server.ts:402-409` |
| 9 | `POST /api/tasks/:id/cancel` | não | `:id` = `TaskIdSchema`; corpo ignorado | 200 `{task:TaskResponse}` (depois do cancelamento) | 404 `TASK_NOT_FOUND` | `daemon/src/server.ts:411-420` |
| 10 | `GET /api/tasks/:id/events` | não | `:id` = `TaskIdSchema`; cabeçalho `Last-Event-ID` | 200 SSE (seção 8.3) | 400 `INVALID_QUERY` (`Last-Event-ID` malformado); 404 `TASK_NOT_FOUND`; 503 `SSE_CONNECTION_LIMIT` | `daemon/src/server.ts:422-501` |

`POST /api/tasks` em detalhe. Sem `projectId`, a rota registra um projeto a partir de
`projectPath` ou, na falta dele, do **`process.cwd()` do daemon**
(`daemon/src/server.ts:371-377`). Sem `agent`, o brief usa `"cap:code-edit"`.
`supervision` padrão é `semi`, `isolation` padrão é `worktree`; `acceptanceCriteria`,
`constraints` e `budget` vazios por padrão (`daemon/src/server.ts:382-390`).

`TaskResponse` (`daemon/src/api-tasks.ts:71-97`):
`{id, sessionId, requesterSessionId, state, sessionState|null,
brief:{agent,objective,acceptanceCriteria,constraints,budget}, attempts,
result:{summary,artifacts,usage,validation}|null, createdAt, updatedAt}`.

### 6.3 Projetos

| # | Método e caminho | Op. | Entrada | Sucesso | Erros específicos | Onde |
|---|---|---|---|---|---|---|
| 11 | `GET /projects` | não | — | 200 `{projects:[Project]}` | — | `daemon/src/server.ts:504-506` |
| 12 | `POST /projects` | não | `CreateProjectSchema`: `path` texto 1–4096, `name?` 1–200 | 201 `{project}` | 400 `INVALID_PATH` | `daemon/src/server.ts:508-512`, `http-schemas.ts:43-48` |
| 13 | `POST /projects/:id/trust` | **sim** | `ProjectTrustSchema`: `trusted` booleano obrigatório | 200 `{project, repo}` (`repo`: `RepoConfigStatus`, `daemon/src/project-registry.ts:20`); audita `project.trust` | 404 `PROJECT_NOT_FOUND` | `daemon/src/server.ts:517-538`, `http-schemas.ts:51-55` |
| 14 | `GET /projects/:id/folders` | não | `:id` = `ProjectIdSchema` | 200 `{folders:[ProjectFolder]}` | 404 `PROJECT_NOT_FOUND` | `daemon/src/server.ts:542-546` |
| 15 | `POST /projects/:id/folders` | **sim** | `AddFolderSchema`: `path` 1–4096, `label?` 1–200 | 201 `{folder}`; audita `project.folders` | 400 `INVALID_PATH`; 404 `PROJECT_NOT_FOUND` | `daemon/src/server.ts:549-570`, `http-schemas.ts:57-62` |
| 16 | `DELETE /projects/:id/folders/:folderId` | **sim** | `:id` = `ProjectIdSchema`, `:folderId` = `FolderIdSchema`; sem corpo | 200 `{ok:true}`; audita `project.folders` | 404 `FOLDER_NOT_FOUND`/`PROJECT_NOT_FOUND`; 400 `FOLDER_IS_PRIMARY` (padrão de `statusFor`) | `daemon/src/server.ts:572-589` |
| 17 | `GET /projects/:id/context` | não | `:id` | 200 `{context:ProjectContext, repo:RepoConfigStatus}` (`daemon/src/project-config.ts:282`) | 404 `PROJECT_NOT_FOUND` | `daemon/src/server.ts:597-603` |
| 18 | `PUT /projects/:id/context` | **sim** | `ProjectContextSchema` (ver 6.9) | 200 `{context}`; audita `project.context` com `detail.envAgents` (só as chaves) | 404 `PROJECT_NOT_FOUND` | `daemon/src/server.ts:606-624`, `http-schemas.ts:64-76` |
| 19 | `POST /projects/:id/import` | **sim** | `ImportSchema` (ver 6.9); `dryRun` padrão `true` | 200 `ImportResult` (`core/src/discovery.ts:57`); só com `dryRun:false` audita `project.import` | 404 `PROJECT_NOT_FOUND`, `AGENT_NOT_FOUND` | `daemon/src/server.ts:630-659`, `http-schemas.ts:213-225` |
| 20 | `PUT /projects/:id/policy` | **sim** | `:id` validado com `INVALID_QUERY`; corpo `{policy:<qualquer>}` estrito; query `dryRun=1\|true` = prévia | 200 `{project, clamped, ignoredExecFields}`; prévia: 200 `{dryRun:true, clamped, ignoredExecFields, effective}`; audita `policy.updated` fora da prévia | 400 `INVALID_QUERY`; 422 `INVALID_BRIEF` (`"política inválida"`, `daemon/src/policy-service.ts:67-79`) | `daemon/src/operator-routes.ts:143-176`, `daemon/src/policy-service.ts:154-171` |

### 6.4 Sessões e tasks

| # | Método e caminho | Op. | Entrada | Sucesso | Erros específicos | Onde |
|---|---|---|---|---|---|---|
| 21 | `GET /sessions` | não | query `projectId?`, `rootId?` (sem validação de formato) | 200 `{sessions:[Session & {adopted:boolean}]}` | — | `daemon/src/server.ts:662-673` |
| 22 | `POST /sessions` | não | `StartSessionSchema` (ver 6.9) | 201 `StartSessionResult` = `{session, task, budget, approval?}` (`daemon/src/session-manager.ts:154-160`) | 422 `INVALID_BRIEF` (`parseBrief`, `core/src/brief.ts:118-126`); 404 `PROJECT_NOT_FOUND`; 409/424 do domínio | `daemon/src/server.ts:675-686` |
| 23 | `POST /sessions/adopt` | não | `AdoptSessionSchema` (ver 6.9) | 201 `{session}`; passa a controlar o prazo da raiz | 400 `INVALID_PATH` | `daemon/src/server.ts:692-711` |
| 24 | `POST /sessions/:id/detach` | não | `:id` = `SessionIdSchema`; corpo ignorado | 200 `{ok:true}` | 404 `SESSION_NOT_FOUND` | `daemon/src/server.ts:713-718` |
| 25 | `POST /sessions/:id/heartbeat` | não | `:id`; corpo ignorado | 200 `{ok:true, leaseMs}` (`leaseMs` = 180000 por padrão; `null` se o servidor foi montado sem controle de prazo) | 400 `ILLEGAL_STATE` (não é raiz adotada, ou já terminou) | `daemon/src/server.ts:724-731`, `daemon/src/adopted-leases.ts:4`, `:89-106` |
| 26 | `GET /sessions/:id/artifacts` | não | `:id` | 200 `{artifacts:[Artifact]}` | — | `daemon/src/server.ts:733-737` |
| 27 | `GET /sessions/:id/diff` | não | `:id` | 200 `{diff:<texto>, path}`; sem diff: 200 `{diff:null, message}`; arquivo sumiu: 200 `{diff:null, message}` | — | `daemon/src/server.ts:740-761` |
| 28 | `GET /sessions/:id/tasks` | não | `:id` | 200 `{tasks:[Task]}` | — | `daemon/src/server.ts:763-767` |
| 29 | `GET /tasks/:id` | não | `:id` = `TaskIdSchema` | 200 `{task, approval:Approval\|null, session, live:boolean, budget}` (`budget` da raiz) | 404 `TASK_NOT_FOUND` | `daemon/src/server.ts:769-783` |
| 30 | `GET /context` | não | query `ref` (padrão `""`) | 200 `{ref, events:[EventEnvelope]}` | depende de `fetchContext` | `daemon/src/server.ts:785-789`, `daemon/src/session-manager.ts:1966` |
| 31 | `GET /sessions/:id` | não | `:id` | 200 `{session: Session & {adopted}, live:boolean}` | 404 `SESSION_NOT_FOUND` | `daemon/src/server.ts:791-798` |
| 32 | `GET /sessions/:id/events` | não | query `since` (inteiro ≥ 0, teto `MAX_SAFE_INTEGER`, exclusivo), `limit` (teto 5000, padrão 500), `before` (exclusivo), `tail=1` (os N mais recentes); lixo = ausente | 200 `{events:[EventEnvelope]}`, sempre em `seq` crescente; a contagem não é cortada por bytes: depois de 8 MiB acumulados, os eventos seguintes vêm sem `raw` e com texto curto (ver 8.1) | — | `daemon/src/server.ts:800-817`, `store/src/repositories.ts:433-489`, `daemon/src/event-limits.ts:33`, `:200-212` |
| 33 | `POST /sessions/:id/send` | não | `SendMessageSchema`: `text` 1–200000 | 200 `{mode:"live"\|"resume"\|"replay"}` | do domínio | `daemon/src/server.ts:819-826`, `daemon/src/session-manager.ts:1477` |
| 34 | `POST /sessions/:id/interrupt` | não | `:id`; corpo ignorado | 200 `{ok:true, interrupted:boolean, state}` | 404 `SESSION_NOT_FOUND` | `daemon/src/server.ts:828-837` |
| 35 | `POST /sessions/:id/pause` | não | `:id`; corpo ignorado | 200 `{ok:true, state}` | do domínio | `daemon/src/server.ts:839-843` |
| 36 | `POST /sessions/:id/cancel` | não | `CancelSchema`: `reason?` ≤ 1000. **Qualquer erro de leitura ou validação do corpo é engolido** (inclusive 413 e JSON inválido) e vira `reason` ausente | 200 `{ok:true}` | do domínio | `daemon/src/server.ts:845-849`, `http-schemas.ts:117` |
| 37 | `POST /sessions/:id/handoff` | não | `HandoffSessionSchema`: `agentId` 1–64, `reason?` ≤ 1000 | 200 `{ok:true, session}` | do domínio | `daemon/src/server.ts:851-856`, `http-schemas.ts:119-124` |
| 38 | `POST /sessions/:id/delegate` | não | `DelegateSchema`: `brief` objeto, `projectId?` | 201 `{taskId, sessionId, agentId, state, budget, approval\|null}` | 404 `SESSION_NOT_FOUND`; 422 `INVALID_BRIEF`; 409 `DEPTH_EXCEEDED`/`CYCLE_DETECTED`/`BUDGET_EXCEEDED` etc. | `daemon/src/server.ts:863-882`, `http-schemas.ts:102-107` |

A rota `POST /sessions/adopt` é registrada antes de `/sessions/:id/...`. Não há conflito
de método + padrão, mas a ordem é intencional (`daemon/src/server.ts:688-692`). O
despacho percorre a lista na ordem de registro e usa a primeira que casar
(`daemon/src/server.ts:235-274`).

### 6.5 Aprovações e gate

| # | Método e caminho | Op. | Entrada | Sucesso | Erros específicos | Onde |
|---|---|---|---|---|---|---|
| 39 | `GET /approvals` | não | query `sessionId?` (sem validação de formato) | 200 `{approvals:[Approval]}` (só pendentes) | — | `daemon/src/server.ts:885-890` |
| 40 | `GET /approvals/:id` | não | `:id` = `ApprovalIdSchema` | 200 `{approval}` | 404 `APPROVAL_NOT_FOUND` | `daemon/src/server.ts:892-896` |
| 41 | `POST /approvals/:id` | **sim** | `ResolveApprovalSchema`: `decision` `"approved"\|"denied"`, `by?` 1–200 (ignorado) | 200 `{approval}`; `by` = identidade autenticada | 404 `APPROVAL_NOT_FOUND` | `daemon/src/server.ts:902-916`, `http-schemas.ts:126-131` |
| 42 | `POST /hooks/pretooluse` | não | `PreToolGateSchema` (seção 9) | 200 (seção 9) | 422 `INVALID_BRIEF` | `daemon/src/server.ts:926-966` |

### 6.6 Manutenção

| # | Método e caminho | Op. | Entrada | Sucesso | Erros específicos | Onde |
|---|---|---|---|---|---|---|
| 43 | `POST /shutdown` | **sim** | corpo ignorado | 200 `{ok:true, message:"encerrando"}`; encerra em 100 ms | — | `daemon/src/server.ts:976-990` |
| 44 | `POST /maintenance/sweep` | **sim** | corpo ignorado | 200 `{sweep:SweepResult}` (`daemon/src/reaper.ts:6`); o cliente tipa como `{examined, removed[], retained, failed[{path,reason}]}` (`client/src/index.ts:426-435`); audita `maintenance.sweep` | — | `daemon/src/server.ts:993-1007` |
| 45 | `POST /maintenance/backup` | **sim** | `{out?}` estrito; `out` texto 1–4096, caminho **absoluto**; padrão `<home>/backups/<backupFileName()>` | 200 `{backup:{path,bytes,schemaVersion}}` (`store/src/backup.ts:19`); audita `maintenance.backup` | 400 `INVALID_PATH` (relativo, ou banco ausente); 400 `ILLEGAL_STATE` (destino já existe; o backup nunca sobrescreve) | `daemon/src/maintenance-routes.ts:25-30`, `:47-73`, `store/src/backup.ts:52-64` |

### 6.7 Política e auditoria

| # | Método e caminho | Op. | Entrada | Sucesso | Erros específicos | Onde |
|---|---|---|---|---|---|---|
| 46 | `GET /policy` | não | query `projectId?` (validado com `INVALID_QUERY`) | 200 `{policy:PolicyView}` = `{global, project\|null}` (`daemon/src/policy-service.ts:62-65`) | 400 `INVALID_QUERY`; 404 `PROJECT_NOT_FOUND` | `daemon/src/operator-routes.ts:106-114` |
| 47 | `PUT /policy` | **sim** | `{policy:<qualquer>}` estrito; query `dryRun=1\|true` = prévia | 200 `{policy:PolicyView, loosened:string[], backup:string\|null}`; prévia: 200 `{dryRun:true, loosened, effective}`; audita `policy.updated` (`decision` `loosened` ou `updated`) | 422 `INVALID_BRIEF` | `daemon/src/operator-routes.ts:116-141`, `daemon/src/policy-service.ts:118`, `:144` |
| 48 | `GET /audit` | não | query: `sessionId`, `projectId` (formatos de id), `kind` (enum `AUDIT_KINDS`), `since`/`until` (ISO 8601 ou relativo `^\d+\s*(s\|m\|h\|d)$` com flag `i`, testado no valor após `trim`; `2H` vale), `limit` (inteiro 1–5000) | 200 `{entries:[AuditEntry]}` | 400 `INVALID_QUERY` | `daemon/src/operator-routes.ts:178-198`, `:82-98` |

`PUT /projects/:id/policy` está na linha 20 da tabela 6.3.

### 6.8 Orçamento, workflows, integrações, grafo e stream

| # | Método e caminho | Op. | Entrada | Sucesso | Erros específicos | Onde |
|---|---|---|---|---|---|---|
| 49 | `PUT /budget/:rootId` | **sim** | `:rootId` = `SessionIdSchema`; `BudgetEditSchema`: `limits` com ao menos um de `usd` (> 0, ≤ 1e6), `tokens` (inteiro > 0, ≤ 1e9), `seconds` (inteiro > 0, ≤ 2592000) | 200 `{budget}`; audita `budget.updated` | do domínio (não é raiz, abaixo do comprometido) | `daemon/src/operation-routes.ts:28-45`, `:97-117` |
| 50 | `POST /workflows/validate` | não | `{yaml}` estrito; texto 1–200000 | 200 `WorkflowValidationView` (`{valid,errors,workflow,executionOrder}`); YAML inválido **não** é erro HTTP | — | `daemon/src/operation-routes.ts:47-49`, `:119-123`, `daemon/src/workflow-runs.ts:33`, `:72-83` |
| 51 | `POST /workflows/runs` | não | `{yaml, projectId, budgetUsd?}` estrito; `budgetUsd` > 0, ≤ 1e6 | 201 `{run:WorkflowRunView}` (`daemon/src/workflow-runs.ts:54-70`) | do domínio | `daemon/src/operation-routes.ts:51-57`, `:125-134` |
| 52 | `GET /workflows/runs` | não | — | 200 `{runs:[WorkflowRunView]}`, mais recente primeiro; registro em memória | — | `daemon/src/operation-routes.ts:136-138`, `daemon/src/workflow-runs.ts:185-189` |
| 53 | `GET /workflows/runs/:id` | não | `:id` = `RunIdSchema` | 200 `{run}` | 404 `TASK_NOT_FOUND` (código usado para execução inexistente) | `daemon/src/operation-routes.ts:140-142`, `daemon/src/workflow-runs.ts:191-199` |
| 54 | `GET /integrations` | não | query `projectId?` (`INVALID_QUERY` se malformado) | 200 `{entrypoints, integrations}` | 400 `INVALID_QUERY`; 404 `PROJECT_NOT_FOUND` | `daemon/src/integration-routes.ts:59-75` |
| 55 | `POST /integrations/:agentId/:tipo` | **sim** | `:tipo` = `hook`\|`mcp`; corpo `{projectId?, dryRun?, base?}` estrito, `base` 1–200; `dryRun` ausente = prévia | prévia: 200 `{dryRun:true, plan}`; gravação: 200 `{dryRun:false, plan, backup}` (`PlanoDeIntegracao`, `daemon/src/integrations.ts:106`); audita `integration.install` | 400 `INVALID_QUERY` (agente/tipo); 422 `INVALID_BRIEF` (`base` ausente com `dryRun:false`); 409 `CONFIG_CHANGED`; 422 `AGENT_CONFIG_INVALID` | `daemon/src/integration-routes.ts:30-39`, `:77-129` |
| 56 | `GET /graph/:rootId` | não | `:rootId` = `SessionIdSchema` | 200 `{graph:[GraphNode]}` | 404 `SESSION_NOT_FOUND` | `daemon/src/server.ts:1052-1056` |
| 57 | `GET /budget/:rootId` | não | `:rootId` | 200 `{budget}` (`BudgetSnapshot` + `projection?`, `daemon/src/session-manager.ts:2092`) | 404 `SESSION_NOT_FOUND` | `daemon/src/server.ts:1058-1062` |
| 58 | `GET /events` | não | query `sessionId?`, `rootId?`, `since?` | 200 SSE (seção 8.2) | 400 `INVALID_QUERY` (`since`); 404 `SESSION_NOT_FOUND`; 503 `SSE_CONNECTION_LIMIT` | `daemon/src/server.ts:1065-1107` |

### 6.9 Schemas de corpo com vários campos

Todos são `.strict()` e ficam em `daemon/src/http-schemas.ts`.

- **`BudgetInputSchema`** (`:35-41`): `usd?` > 0, ≤ 10000; `tokens?` inteiro > 0,
  ≤ 1e9; `seconds?` inteiro > 0, ≤ 86400.
- **`CreateTaskSchema`** (`:154-167`): `projectId?`, `projectPath?` ≤ 4096,
  `agent?` 1–64, `objective` 1–50000, `acceptanceCriteria?` e `constraints?` (listas de
  texto ≤ 500 cada, sem teto de itens neste schema), `budget?` (`BudgetInputSchema`),
  `supervision?` `supervised|semi|autonomous`, `isolation?` `none|worktree|container`,
  `title?` ≤ 500.
- **`StartSessionSchema`** (`:78-90`): `projectId`; `brief` (objeto qualquer, validado
  depois por `BriefSchema`); `requesterSessionId?` (id de sessão ou `null`);
  `title?` ≤ 500; `baseSessionIds?` (até 50 ids de sessão).
- **`AdoptSessionSchema`** (`:92-100`): `agentId` 1–64, `projectPath?` ≤ 4096,
  `projectId?`, `title?` ≤ 500, `budget?` (`BudgetInputSchema`). Sem `projectId`, usa
  `projectPath` ou o `process.cwd()` do daemon (`daemon/src/server.ts:695-701`).
- **`DelegateSchema`** (`:102-107`): `brief` (objeto), `projectId?`. Sem `projectId`,
  vale o da sessão solicitante (`daemon/src/server.ts:867`).
- **`ProjectContextSchema`** (`:64-76`): `memory?` ≤ 20000;
  `prompts?` registro chave (≤ 64) → texto (≤ 8000);
  `env?` registro agente (≤ 64) → registro nome (≤ 128) → valor (≤ 2000).
- **`ImportSchema`** (`:213-225`): `agentId` (`AgentIdParamSchema`), `kinds` 1–3 de
  `instructions|env|mcp`, `dryRun` (padrão `true`), `targetAgents?` (até 32),
  `overwrite?`, `includeEnv?`.
- **`BriefSchema`** (`core/src/brief.ts:74-111`): **não** é `.strict()` (chaves
  desconhecidas são descartadas). `agent` 1–200 após `trim`; `objective` 8–50000 após
  `trim`; `acceptanceCriteria`, `constraints` e `contextRefs` com até 200 itens de
  1–4000; `artifacts` com até 200 itens `{path` relativo sem `..`, 1–1000;
  `mode` `read|write`; `note?`}; `upstream` com até 200 itens; `budget`
  `{usd?,tokens?,seconds?}` positivos; `isolation` (padrão `worktree`); `mode`
  `async|stream` (padrão `async`); `supervision?`; `labels` (registro de textos).
  Falha: 422 `INVALID_BRIEF` com a mensagem `"Brief inválido"`.

---

## 7. Painel estático

O painel React é servido pelo próprio daemon. Na reescrita ele dá lugar à janela
nativa (ADR 7.3), mas o comportamento atual é este.

- **Quando.** Só se nenhuma rota casou e o método é `GET`
  (`daemon/src/server.ts:276-284`). A guarda de borda roda antes.
- **Raiz.** `webRoot` vem de `config.json` ou é descoberta: `<instalação>/web` se
  existir `index.html` lá; senão `packages/web/dist`
  (`daemon/src/config.ts:158-164`). Se a pasta não existir, a resposta é 404 JSON
  (`daemon/src/static.ts:28`).
- **Decodificação.** O caminho é decodificado uma vez. Se a decodificação falhar, a
  resposta é `400` com corpo texto `bad request`, sem JSON
  (`daemon/src/static.ts:33-39`).
- **Caminhos recusados** com `400 bad request` (`daemon/src/static.ts:40-44`, `:85-98`):
  - NUL, `\`, `:`;
  - segmento `.` ou `..`;
  - segmento terminado em ponto ou espaço;
  - caracteres `<>"|?*` ou de controle;
  - nomes reservados do Windows (`CON`, `PRN`, `AUX`, `NUL`, `CONIN$`, `CONOUT$`,
    `COM0-9¹²³`, `LPT0-9¹²³`, com ou sem extensão).
- **Fuga da raiz.** Se o caminho resolvido sair de `webRoot`: `403` com corpo texto
  `forbidden` (`daemon/src/static.ts:53-56`, `:100-103`).
- **Arquivo.** `/` vira `index.html`. Um arquivo existente é servido. Se o arquivo não
  existe, o fallback da SPA devolve `index.html` só quando o **caminho absoluto
  resolvido** (`webRoot` + caminho pedido) não contém `.`; o teste é
  `!candidate.includes('.')` (`daemon/src/static.ts:111`). O resto dá 404 JSON
  (`daemon/src/static.ts:46`, `:105-114`). Consequência: se `webRoot` tiver um ponto em
  qualquer parte do caminho (ex.: uma pasta de usuário `a.b`), o fallback da SPA
  **nunca** acontece, e toda rota de cliente inexistente como arquivo dá 404.
- **Cabeçalhos.** `Content-Type` pela extensão (`daemon/src/static.ts:5-18`); extensão
  desconhecida vira `application/octet-stream`. `Cache-Control: no-cache` para `.html`
  e `public, max-age=31536000, immutable` para o resto (`daemon/src/static.ts:62-67`).
  Não há `Content-Length`: o arquivo segue por stream (`daemon/src/static.ts:68`).
- **Cookie de operador.** Vai junto quando os cabeçalhos `Sec-Fetch-*` indicam
  navegação (seção 4).

---

## 8. SSE

### 8.1 Canal comum

`/events` e `/api/tasks/:id/events` usam o mesmo canal (`daemon/src/sse.ts:72-198`).

- **Cabeçalhos de resposta:** `200`, `Content-Type: text/event-stream`,
  `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`,
  `X-Accel-Buffering: no` (`daemon/src/server.ts:431-436`, `:1079-1084`).
- **Primeira linha:** um comentário. Em `/events` é `: conectado em <ISO>\n\n`
  (`daemon/src/server.ts:1085`); em `/api/tasks/:id/events` é
  `: conectado ao stream de eventos da task <id>\n\n` (`daemon/src/server.ts:437`).
- **Evento:** `[id: <id>\n]data: <JSON do EventEnvelope>\n\n`. Não há linha `event:`
  (`daemon/src/sse.ts:62-65`). O JSON ocupa uma linha só.
- **Heartbeat:** comentário `: ping\n\n` a cada **20 000 ms**
  (`daemon/src/sse.ts:15`, `:166-170`).
- **Cliente lento:** as duas rotas usam uma fila de **700** eventos
  (`SSE_REPLAY_LIMIT` 500 + 200, `daemon/src/server.ts:66`, `:79`). Quando o socket não
  drena e a fila chega ao teto, o canal fecha com `res.end()` e perde a fila
  (`daemon/src/sse.ts:145-156`).
- **Fechamento pelo cliente:** `close` da requisição limpa o timer, a fila e a
  assinatura (`daemon/src/sse.ts:85-93`, `:188`). O fim normal (`end`) entrega a
  fila antes de fechar (`daemon/src/sse.ts:172-186`).
- **Teto de conexões:** o teto é conferido antes do `writeHead`, contra
  `bus.subscriberCount < maxSseConnections`. Acima dele: 503
  (`daemon/src/server.ts:1118-1127`). A assinatura no barramento só acontece depois do
  replay (`daemon/src/server.ts:483`, `:1106`). Por isso, uma conexão ainda em replay
  não conta no teto.
- **Aviso de truncamento:** um evento sintético que nunca é gravado, com
  `id "evt_truncated_<sessionId>"`, `seq 0`, `taskId null`, `agentId "daemon"`,
  `type "log"`, `payload {truncated:true, sentCount, sessionId}`, `cost null`,
  `raw null` (`daemon/src/server.ts:82-95`). Sai sempre **sem** linha `id:`.
- **Página em bytes:** o replay passa por `listEvents`, que aplica `limitarPagina`.
  Depois de 8 MiB, os eventos seguem sem `raw` e com texto curto; a contagem não muda
  (`daemon/src/session-manager.ts:2015-2025`, `daemon/src/event-limits.ts:193-212`).

`EventEnvelope` (`core/src/events.ts:72-88`):
`{id, seq, ts, sessionId, taskId|null, agentId, type, payload, cost|null, raw}`.
Os tipos de evento estão em `core/src/events.ts:10-37`.

### 8.2 `GET /events`

- **Filtros:** `sessionId` e `rootId`, opcionais e combináveis. Sem nenhum, a conexão
  recebe todos os eventos ao vivo. `rootId` casa todas as sessões da árvore
  (`daemon/src/bus.ts:50-53`). Uma sessão ou raiz inexistente dá 404 antes de abrir o
  stream (`daemon/src/server.ts:1074-1075`). O formato do id nesses filtros não é
  validado por schema: o id vai direto para `getSession`.
- **`id:`** só é emitido quando há `sessionId`, e vale o `seq` do evento
  (`daemon/src/server.ts:1087-1091`, `daemon/src/sse.ts:143`).
- **Replay:** só com `sessionId`. Manda até 500 eventos com `seq > since`, em ordem
  crescente (`daemon/src/server.ts:1098-1104`). Se vierem exatamente 500, envia o aviso
  de truncamento e **continua** ao vivo, sem fechar.
- **`since`:** parâmetro de query; ausente = desde o começo; inválido = 400
  (`daemon/src/http-schemas.ts:189-199`).
- **`Last-Event-ID`:** esta rota **não** lê o cabeçalho (o handler em
  `daemon/src/server.ts:1065-1107` não o consulta). A retomada é feita pelo cliente com
  `?since=`.
- **Fechamento:** só pelo cliente, por cliente lento ou por desligamento. A rota não
  tem fim por conta própria.

### 8.3 `GET /api/tasks/:id/events`

- **Sessões observadas:** a task pode trocar de sessão num fallback. A rota assina a
  **raiz** e filtra pelas sessões por onde a task passou. O conjunto começa com
  `sessoesDaTask(taskId)` e cresce com a sessão atual da task a cada evento
  (`daemon/src/server.ts:425`, `:482-487`).
- **`id:`** é o cursor de todas as sessões, `ses_a:12,ses_b:5`, na ordem em que as
  sessões apareceram (`daemon/src/sse.ts:217-222`, `daemon/src/server.ts:461-465`).
- **`Last-Event-ID`:** se houver mais de um cabeçalho, os valores são juntados com
  `", "` (`daemon/src/server.ts:1244-1247`). Ausente ou vazio = sem cursor. Cada
  entrada precisa casar `^(ses_[a-z0-9]{1,60}):(\d{1,15})$` com flag `i` (sem distinção
  de caixa, `daemon/src/sse.ts:217`), sem sessão repetida e
  só com sessões da task. Senão: `400 INVALID_QUERY "Last-Event-ID inválido: ..."`,
  validado **antes** do `writeHead` (`daemon/src/sse.ts:238-254`,
  `daemon/src/server.ts:426-427`).
- **Entrega:** um evento só sai se `seq` for maior que o cursor da sessão dele, e o
  cursor avança a cada envio (`daemon/src/server.ts:461-465`).
- **Replay:** até 501 eventos por sessão, intercalados por `ts` sem inverter o `seq`
  dentro de cada sessão (`daemon/src/sse.ts:265-280`). Entrega os 500 primeiros. Se
  sobrar algum, envia o aviso de truncamento e **fecha** com `end()`; o cliente
  reconecta com o cursor e recebe a página seguinte (`daemon/src/server.ts:468-480`).
- **Fechamento automático:** quando a task entra em `completed`, `failed`, `canceled`
  ou `rejected`. A checagem roda logo depois do replay e depois a cada **500 ms**, e o
  fechamento é por `end()` (`daemon/src/server.ts:138-140`, `:489-500`).

### 8.4 Cliente Node

`HubClient.stream` (`client/src/index.ts:548-581`) usa só `/events`. Ele manda
`Accept: text/event-stream`, separa os frames por `\n\n`, lê a primeira linha que
começa com `data: ` e ignora comentários. Não usa `id:`.

---

## 9. Gate pré-execução: `POST /hooks/pretooluse`

A rota é aberta, sem token (`daemon/src/server.ts:926`). O MCP e o hook não carregam
token de propósito (`client/src/index.ts:46-47`).

**Pedido** (`PreToolGateSchema`, `daemon/src/http-schemas.ts:139-151`, estrito). Os
campos estão em camelCase. É o hook da CLI que traduz o `snake_case` do agente
(`cli/src/hook.ts:178-190`).

| Campo | Tipo | Limite |
|---|---|---|
| `sessionId?` | id `ses_` | `SessionIdSchema` |
| `nativeSessionId?` | texto | 1–200 |
| `cwd?` | texto | ≤ 4096 |
| `toolName` | texto | 1–200 |
| `toolInput` | objeto | padrão `{}` |
| `toolUseId?` | texto | 1–200 |

**Como o daemon acha a sessão** (`daemon/src/session-manager.ts:1068-1107`), em ordem:

1. `sessionId`, se existir no banco;
2. sessão cujo `nativeSessionId` bata;
3. `cwd` igual ao `workdir` de uma sessão **viva** (`running` ou `waiting_approval`),
   não adotada; em empate, a mais recente.

Se nenhuma bater, a resposta é imediata: `allow`, `risk "read"`,
`reason "chamada fora de uma sessão do Hub — sem política a aplicar"`
(`daemon/src/session-manager.ts:899-905`).

**Idempotência.** A chave é `"<sessão>|<toolUseId>"`. Uma segunda chamada com a mesma
chave espera a mesma decisão (em voo) ou recebe a já tomada. Uma decisão fica guardada
por 10 min, com teto de 2000 entradas; as que ainda estão em voo não expiram
(`daemon/src/session-manager.ts:911-915`, `daemon/src/gate-idempotencia.ts:23-75`).
Uma chamada repetida não é auditada de novo (`daemon/src/server.ts:937`).

**Decisão** (`daemon/src/session-manager.ts:918-1027`):

- `deny` da política: resposta imediata, com um evento `log` na timeline.
- `allow`: resposta imediata.
- `approve` com a sessão em estado terminal: `deny` imediato, com explicação própria.
- `approve` com a sessão viva: o daemon abre uma aprovação e **bloqueia a resposta
  HTTP**, consultando o banco a cada 500 ms, por até `gateWaitMs` = **55 000 ms**
  (`daemon/src/pretool-gate.ts:262`, `daemon/src/session-manager.ts:260`, `:1000`,
  `:1037-1059`). Se for aprovada: `allow`. Se for negada: `deny`. Se o tempo esgotar, o
  daemon chama `resolveApproval(id, 'denied', 'tempo esgotado')`: `"tempo esgotado"` é
  o argumento `by` (quem decidiu), não um motivo (`daemon/src/session-manager.ts:1056`;
  assinatura `by = 'você'` em `:1131`). A resposta é `deny`, com uma explicação que diz
  "falta de resposta, não proibição".

**Resposta `200`** (`daemon/src/server.ts:952-965`):

```json
{
  "permission": "allow | deny | ask",
  "decision": "allow | approve | deny",
  "risk": "read | write | exec | escalate | irreversible | budget",
  "reason": "...",
  "explanation": "...",
  "approvalId": "apv_... | null",
  "sessionId": "ses_... | null",
  "agentId": "... | null"
}
```

- `permission` = `toHookPermission(decision)`: `approve` vira `ask`
  (`daemon/src/pretool-gate.ts:228-237`). Como a espera bloqueante sempre termina em
  `allow` ou `deny`, `ask` não aparece na prática (`daemon/src/pretool-gate.ts:216-219`).
- `explanation`: vem do veredito quando existe; senão, é calculada por `explainToAgent`
  (`daemon/src/server.ts:961`, `daemon/src/pretool-gate.ts:322-338`).
- Os valores de `risk` e `decision` estão em `core/src/policy.ts:12`, `:23`.
- A tradução de ferramenta em ação (shell, escrita, leitura, rede, `mcp__*` com caminho
  de segredo) está em `actionsOfToolCall` (`daemon/src/pretool-gate.ts:44-87`). Uma
  ferramenta desconhecida não gera ação e resulta em `allow`
  (`daemon/src/pretool-gate.ts:200-205`).
- Toda decisão sobre uma sessão do Hub grava `gate.decision` na auditoria com o ator
  `gate` (`daemon/src/server.ts:937-950`).

**Tempos** (`daemon/src/pretool-gate.ts:239-272`). A ordem entre eles é o contrato:

| Relógio | Valor | Constante |
|---|---|---|
| Espera do daemon por decisão humana | 55 s | `ESPERA_DO_GATE_MS` (`:262`) |
| Teto HTTP do processo do hook | 100 s | `TETO_HTTP_DO_HOOK_MS` (`:269`) |
| Timeout gravado na config do agente | 120 s | `TIMEOUT_DO_HOOK_SEC` (`:272`) |

**Lado do hook (CLI).** Este lado não faz parte da API HTTP, mas é o cliente do gate e
depende dos tempos acima.

- `hub hook` responde sozinho à leitura comum, sem chamar o daemon
  (`cli/src/hook-run.ts:59-62`).
- O endereço sai de `loadConfig`, com `http://127.0.0.1:4747` quando a config falha
  (`cli/src/hook-run.ts:67-75`).
- O `sessionId` vem de `--session` ou de `AGENTS_HUB_SESSION_ID`, e só é enviado se
  casar `^ses_[a-z0-9]+$` (`cli/src/hook-run.ts:79-81`, `cli/src/hook.ts:128`,
  `:161-162`).
- Qualquer falha (rede, status não-2xx, teto de 100 s) cai no **modo de falha**:
  `gate.failMode` do `config.json` ou, sem ele, `closed` quando há `sessionId` e `open`
  fora de uma sessão (`cli/src/hook.ts:195-212`, `:102-107`,
  `daemon/src/config.ts:84-86`).
- Em modo `closed`, uma ação de risco é negada.
- Saída no dialeto do Claude: `{"hookSpecificOutput":{"hookEventName":"PreToolUse",
  "permissionDecision","permissionDecisionReason"}}`. No dialeto do Codex, "permitir" é
  saída vazia (`cli/src/hook.ts:218-257`).

---

## 10. Pontos NÃO DETERMINADOS e observações para o C

- **Erros de domínio por rota:** a seção 6 lista só os erros visíveis no handler. A
  enumeração completa de códigos lançados por `SessionManager`, `PolicyService`,
  `WorkflowRunner` e integrações não foi feita.
- **Formato interno de `Session`, `Task`, `Approval`, `PolicyView`, `AgentDiscovery`,
  `ImportResult`, `PlanoDeIntegracao` e `SweepResult`:** o documento só aponta onde cada
  tipo é definido; os campos não foram transcritos.
- **Timeouts de socket HTTP:** o código usa os padrões do Node (seção 1). Quais valores
  o C deve adotar não está decidido.
- **Filtros sem validação de formato:** `sessionId`/`rootId` de `GET /sessions`,
  `GET /approvals` e `GET /events` não passam por schema de id. O TS aceita qualquer
  texto (em `/events`, um id inexistente dá 404 via `getSession`). O comportamento
  para texto arbitrário em `GET /sessions` e `GET /approvals` (lista vazia ou erro)
  depende do repositório e não foi verificado.
- **`/api/descriptor.json` declara `authentication.mode: "none"`** mesmo com 13 rotas
  que exigem token. O descritor cobre só `/api/tasks/*`, que é aberta; o texto é
  literal no código (`daemon/src/api-tasks.ts:63-65`).
- **`POST /sessions/:id/cancel` engole erros de corpo**, inclusive 413
  (`daemon/src/server.ts:846`). Se o C deve reproduzir isso é decisão de contrato;
  hoje é o comportamento.
- **`process.cwd()` do daemon** como projeto implícito em `POST /api/tasks` e
  `POST /sessions/adopt` (`daemon/src/server.ts:376`, `:700`): depende de onde o daemon
  foi iniciado.
