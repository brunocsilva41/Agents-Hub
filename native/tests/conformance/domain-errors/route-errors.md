# F4-14 — Erros de domínio por rota

Fecha o ponto NÃO DETERMINADO de SPEC-01 §10 ("Erros de domínio por rota"). Numeração das
rotas igual à tabela da SPEC-01 §6. Código TS de referência: commit `c3ecbee` (o
`packages/` não muda desde `82f40cc`, o commit da SPEC-01: `git diff --stat 82f40cc HEAD --
packages` vazio). Caminhos relativos a `packages/`.

## Legenda

- **Código** — `HubErrorCode` (`core/src/errors.ts:6-42`).
- **Status** — `statusFor` (`daemon/src/server.ts:1153-1205`). `ILLEGAL_STATE`,
  `PROJECT_FOLDER_CONFLICT`, `PROJECT_CONFIG_INVALID` e `HUB_CONFIG_INVALID` caem no padrão 400.
- **Lançado em** — `arquivo:linha` do `throw new HubError` (ou do `return new HubError` de uma
  fábrica, quando indicado).
- **Caminho** — chamadas da rota até o `throw`, com `arquivo:linha` de cada salto.
- **Conf.** — `sim`: confirmado num Hub em processo isolado (ver README); `não`: reproduzível pela
  descrição do JSONL, mas não executado; `complexo`: exige estado que não montei de forma
  reproduzível (descrito no JSONL); `n/a`: só por condição de corrida, erro interno ou checagem
  que a borda faz antes, e por isso **sem caso** no JSONL; "coberto pelos casos da rota N (mesmo
  ponto de lançamento: ...)": a rota não tem caso próprio para aquele ponto, e o caso citado
  exercita o mesmo `throw`.
- **Cobertura do JSONL:** todo par (rota, código) desta lista, fora as linhas `n/a`, tem caso
  próprio no `route-errors.jsonl` ou referência explícita a um caso de outra rota com o mesmo
  ponto de lançamento. A única linha fora da regra é a "não determinado" da rota 41 (`#settle`),
  que não traz código.
- Abreviações: `SM` = `daemon/src/session-manager.ts`; `PR` = `daemon/src/project-registry.ts`;
  `REG` = `adapters/src/registry.ts`; `PA` = `adapters/src/process-adapter.ts`;
  `OC` = `adapters/src/opencode/adapter.ts`.
- **Fora do escopo desta lista (já em SPEC-01 §2 e §6):** guarda (403/415 `FORBIDDEN`), 401
  `UNAUTHORIZED`, `INVALID_JSON`, `PAYLOAD_TOO_LARGE`, `INVALID_BRIEF` de schema de corpo,
  `INVALID_ID`/`MALFORMED_URL` de parâmetro, `INVALID_QUERY` de query/cabeçalho validados no
  handler, `INVALID_PATH` de `validarDiretorioDeProjeto` (borda HTTP, `daemon/src/project-path.ts:18-47`,
  fábrica em `:179-184`), 503 `SSE_CONNECTION_LIMIT`, 500 `INTERNAL`.

### Pontos de lançamento compartilhados

| Id | Código | Lançado em | Quando |
|---|---|---|---|
| S1 | `SESSION_NOT_FOUND` | `SM:4308` (`#session`) | id de sessão sem linha no banco; `getSession` (`SM:1929-1931`) delega a ele |
| S2 | `TASK_NOT_FOUND` | `SM:1936` (`getTask`) | id de task sem linha no banco |
| S3 | `TASK_NOT_FOUND` | `SM:4316` (`#latestTask`) | sessão sem nenhuma task (ex.: raiz adotada, que nunca tem task) |
| S4 | `ILLEGAL_STATE` | `SM:360-365` (`#exigirNaoTerminal`) | sessão em `completed`/`failed`/`killed` |
| S5 | `ILLEGAL_STATE` | `SM:1418-1424` (`#exigirSemAprovacaoPendente`) | sessão em `waiting_approval` |
| P1 | `PROJECT_NOT_FOUND` | `PR:111` (`ProjectRegistry.get`) | projeto inexistente; `SessionManager.getProject` (`SM:313-315`) delega a ele |
| A1 | `AGENT_NOT_FOUND` | `REG:88` (`AgentRegistry.get`) | agente da sessão não está mais no registry (manifesto removido entre subidas) |
| A2 | `AGENT_NOT_FOUND` | `REG:188` (`resolveTarget`) | alvo por id direto que não está no registry |
| A3 | `CAPABILITY_UNRESOLVED` | `REG:215` (`resolveTarget`) | `cap:<x>` sem candidato: nem na cadeia `policy.fallback` (filtrada por `has`), nem com a capability, ou todos com probe "não instalado" (`REG:196-213`) |
| C1 | `CONCURRENCY_EXCEEDED` | `SM:4075` | teto global `policy.maxConcurrency` |
| C2 | `CONCURRENCY_EXCEEDED` | `SM:4087` | teto por agente `policy.maxConcurrencyPerAgent` |
| C3 | `CONCURRENCY_EXCEEDED` | `SM:4123`, `SM:4131` | teto do projeto (`.agents-hub/config.yaml`), só quando a reserva leva `projectId` (`SM:4094`) |
| L | (vários) | `#launch` (`SM:2178-2234`) | ver tabela L abaixo |

**Tabela L — o que `#launch` pode lançar** (`SM:2190-2234`). Fora de `send`, o erro passa por
`#falhaAoLancar` (`SM:2232`, `:2285-2329`: sessão `failed`, task `failed`, reserva devolvida) e é
relançado (`SM:2233`).

| Código | Status | Lançado em | Gatilho |
|---|---|---|---|
| `AGENT_NOT_FOUND` | 404 | `REG:88` via `SM:2185` | agente da sessão fora do registry |
| `CODEX_GATE_NOT_GUARANTEED` | 424 | `SM:2405-2409` via `SM:2191` | `agentId === 'codex'`, modo `supervised` e `codexGate.bypassHookTrust` desligado (`daemon/src/codex-gate.ts:181-192`, `:214-216`) |
| `AGENT_NOT_INSTALLED` | 424 | `PA:205-209` via `SM:2230` | binário do manifesto não resolvido no PATH |
| `ADAPTER_FAILURE` | 502 | `PA:694-698` (`modeloDaRun`, chamado em `PA:220`) | modelo do contexto começa com `-`, tem caractere de controle ou > 200 caracteres, com `model.supported` |
| `ADAPTER_FAILURE` | 502 | `PA:242-246` | `montarSpawn` recusa (prompt que não atravessa o `cmd.exe` com segurança) |
| `ADAPTER_FAILURE` | 502 | `PA:123-127` via `SM:2229` | `resume` em agente sem retomada nativa |
| `AGENT_NOT_INSTALLED` | 424 | `OC:569-573`, `OC:613-615` | OpenCode: servidor fora do ar com `autoStart` desligado, ou binário ausente |
| `ADAPTER_FAILURE` | 502 | `OC:171`, `OC:691`, `OC:696-700`, `OC:748` | OpenCode: sem id de sessão, falha ao subir `opencode serve`, servidor saiu, HTTP não-2xx |
| `TIMEOUT` | 504 | `OC:706-710` | OpenCode: `opencode serve` não respondeu no prazo de boot |
| `SESSION_NOT_FOUND` | 404 | `OC:189-193` via `SM:2229` | OpenCode: sessão nativa sumiu do servidor no `resume` |
| (não `HubError`) | 500 | `gravarSettingsDaSessao` via `SM:2207`, `:2423-2430` | falha ao gravar o settings do gate (manifestos com `gate.settingsArgs`) |

**Tabela ST — o que `SessionManager.start` (`SM:403-671`) pode lançar**, na ordem de execução.
Erros depois de `SM:451` passam por `#desfazerInicio` (`SM:658-660`, `:2332-2349`) e são relançados
sem troca de código.

| Ordem | Código | Status | Lançado em | Gatilho |
|---|---|---|---|---|
| 1 | `INVALID_BRIEF` | 422 | `core/src/brief.ts:121` via `SM:404` | brief fora do `BriefSchema` (ex.: `objective` com menos de 8 caracteres após `trim`); mensagem `"Brief inválido"` |
| 2 | `PROJECT_NOT_FOUND` | 404 | `SM:407` | `projectId` sem linha no banco |
| 3 | `SESSION_NOT_FOUND` | 404 | `SM:414` | `requesterSessionId` inexistente |
| 4 | `ILLEGAL_STATE` | 400 | S4 via `SM:423` | solicitante terminal ("delegar a partir dela") |
| 5 | `AGENT_NOT_FOUND` / `CAPABILITY_UNRESOLVED` | 404 / 424 | A2 / A3 via `SM:429` | alvo do brief; usa `fallback` da política do projeto |
| 6 | `CONCURRENCY_EXCEEDED` | 409 | C1, C2, C3 via `SM:441` (`#reserveSlot`, `SM:4146-4149`) | teto atingido; a reserva passa `project.id` |
| 7 | `DEPTH_EXCEEDED` | 409 | `core/src/graph.ts:42-46` via `SM:454` | só com solicitante; `depth > maxDepth` da política do projeto |
| 8 | `CYCLE_DETECTED` | 409 | `core/src/graph.ts:50-54` via `SM:454` | só com solicitante; `pathKey(agente, objetivo)` já está no caminho do pai |
| 9 | `BUDGET_EXCEEDED` | 409 | `core/src/budget.ts:206-210` via `SM:481` | só com solicitante; reserva pedida > saldo da raiz |
| 10 | `SESSION_NOT_FOUND` | 404 | `daemon/src/session-bases.ts:26` via `SM:492` | `baseSessionIds` com id inexistente |
| 11 | `ILLEGAL_STATE` | 400 | `daemon/src/session-bases.ts:29-33` via `SM:492` | sessão-base de outro projeto |
| 12 | `ILLEGAL_STATE` | 400 | `daemon/src/worktree.ts:211` via `SM:493` | `isolation: container` |
| 13 | `ILLEGAL_STATE` | 400 | `daemon/src/worktree.ts:219-223` via `SM:493` | `isolation: worktree` em pasta sem git |
| 14 | `ILLEGAL_STATE` | 400 | `daemon/src/worktree.ts:230-236` via `SM:493` | repositório git sem commit e sem `baseRef` |
| 15 | `ILLEGAL_STATE` | 400 | `daemon/src/worktree.ts:255` via `SM:493` | `git worktree add` falhou |
| 16 | `ILLEGAL_STATE` | 400 | `SM:508-512` | mais de uma sessão-base e `juntarBranches` falhou |
| 17 | `POLICY_DENIED` | 403 | `SM:617` | só com solicitante; política do pai decide `deny` para `{kind:'delegation'}` (risco `exec`, `core/src/policy.ts:801-802`) |
| 18 | tabela L | — | via `SM:650` | só quando a política do pai não retém a delegação (`approve` devolve 201 com `approval`, `SM:623-647`) |

`store.transaction` pode lançar `ILLEGAL_STATE` (`store/src/repositories.ts:868-872`) só por erro de
programação (função assíncrona); não é alcançável por entrada HTTP.

---

## 6.1 Saúde, agentes, descoberta

### 1. `GET /health`
Nenhum erro de domínio (`daemon/src/server.ts:291-301`).

### 2. `GET /agents`
Nenhum `HubError` alcançável. `probeAll` (`REG:112-127`) só consulta ids do próprio registry, e
`probe` (`REG:129-139`) chama `get` com esses ids.

### 3. `POST /agents/probe`
Igual à rota 2 (`daemon/src/server.ts:327-329`).

### 4. `GET /discovery`
Nenhum alcançável. `DiscoveryService.all` (`daemon/src/absorption.ts:260-268`) itera
`registry.ids()`; o `AGENT_NOT_FOUND` de `raw` (`:214`) não dispara com esses ids.

### 5. `GET /discovery/:agentId`

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `AGENT_NOT_FOUND` | 404 | `daemon/src/absorption.ts:214` | `server.ts:346` → `one` (`absorption.ts:256-258`) → `raw` (`:212-214`) | sim |

## 6.2 API REST de tasks

### 6. `GET /api/descriptor.json`
Nenhum erro de domínio.

### 7. `POST /api/tasks`
Caminho: `server.ts:371-377` (`registerProject` só sem `projectId`) → `server.ts:379` `sessions.start`
(tabela ST, sem solicitante: as linhas 3, 4, 7, 8, 9 e 17 não se aplicam; sem `baseSessionIds`:
10, 11 e 16 também não).

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `PROJECT_FOLDER_CONFLICT` | 400 | `PR:77` | `server.ts:373` → `SM:304-306` → `PR:75-78`; `projectPath` dentro de pasta de outro projeto, ou contendo uma | sim |
| `PROJECT_FOLDER_CONFLICT` | 400 | `PR:56` | idem, checagem de formato (`core/src/folders.ts:50-61`) | n/a: `validarDiretorioDeProjeto` recusa antes (vazio, relativo) com `INVALID_PATH` |
| `INVALID_BRIEF` | 422 | `core/src/brief.ts:121` | ST-1; `objective` de 1 a 7 caracteres passa no `CreateTaskSchema` e falha no `BriefSchema` | sim |
| `PROJECT_NOT_FOUND` | 404 | `SM:407` | ST-2 | sim |
| `AGENT_NOT_FOUND` | 404 | `REG:188` | ST-5 | sim |
| `CAPABILITY_UNRESOLVED` | 424 | `REG:215` | ST-5; sem `agent`, o alvo é `cap:code-edit` (`server.ts:383`), resolvido pela cadeia `fallback` padrão (`core/src/policy.ts:672-673`) | sim |
| `CONCURRENCY_EXCEEDED` | 409 | `SM:4087` (também `:4075`, `:4123`, `:4131`) | ST-6 | sim (`:4087`) |
| `ILLEGAL_STATE` | 400 | `worktree.ts:211`, `:219`, `:230`, `:255` | ST-12 a ST-15; `isolation` padrão `worktree` (`server.ts:389`) | sim (`:211`, `:219`, `:230`); `:255` complexo |
| `CODEX_GATE_NOT_GUARANTEED` | 424 | `SM:2405-2409` | ST-18 → L | sim |
| `AGENT_NOT_INSTALLED` | 424 | `PA:205-209` (OpenCode: `OC:569`, `OC:613`) | ST-18 → L | sim (`PA`) |
| `ADAPTER_FAILURE` | 502 | tabela L | ST-18 → L | complexo |
| `TIMEOUT` | 504 | `OC:706-710` | ST-18 → L (OpenCode) | complexo |

### 8. `GET /api/tasks/:id`

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `TASK_NOT_FOUND` | 404 | S2 `SM:1936` | `server.ts:404` | sim |
| `SESSION_NOT_FOUND` | 404 | S1 `SM:4308` | `server.ts:405` | n/a (task sem sessão) |

### 9. `POST /api/tasks/:id/cancel`

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `TASK_NOT_FOUND` | 404 | S2 `SM:1936` | `server.ts:413` | sim |
| `ILLEGAL_STATE` | 400 | S4 `SM:360` | `server.ts:414` → `cancel` `SM:1654-1662` (sessão da task terminal) | sim |
| `AGENT_NOT_FOUND` | 404 | A1 `REG:88` | `SM:1667` (run viva com agente fora do registry) | complexo |
| `SESSION_NOT_FOUND` | 404 | S1 | `SM:1654`, `server.ts:416` | n/a |

### 10. `GET /api/tasks/:id/events`

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `TASK_NOT_FOUND` | 404 | S2 `SM:1936` | `server.ts:424` (e `sessoesDaTask`, `SM:1946`) | sim |
| `SESSION_NOT_FOUND` | 404 | S1 | `server.ts:482` (depois do replay; cabeçalho já enviado) | n/a |

`INVALID_QUERY` do `Last-Event-ID` (`daemon/src/sse.ts:225`, via `server.ts:427`) é de borda: já
em SPEC-01.

## 6.3 Projetos

### 11. `GET /projects`
Nenhum erro de domínio.

### 12. `POST /projects`

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `PROJECT_FOLDER_CONFLICT` | 400 | `PR:77` | `server.ts:511` → `SM:304-306` → `PR:75-78`; caminho dentro de pasta já registrada, ou que contém uma (`core/src/folders.ts:65-95`). O mesmo caminho devolve o projeto existente (`PR:70-73`) | sim |
| `PROJECT_FOLDER_CONFLICT` | 400 | `PR:56` | checagem de formato | n/a (borda recusa antes) |

### 13. `POST /projects/:id/trust`

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `PROJECT_NOT_FOUND` | 404 | P1 `PR:111` | `server.ts:523` → `SM:318-320` → `PR:130` | sim |
| `PROJECT_NOT_FOUND` | 404 | `PR:137` | `setTrusted` do store devolveu vazio | n/a (corrida) |

### 14. `GET /projects/:id/folders`

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `PROJECT_NOT_FOUND` | 404 | P1 `PR:111` | `server.ts:544` → `SM:384-386` → `PR:185` | sim |

### 15. `POST /projects/:id/folders`
Ordem: corpo → `:id` → `validarDiretorioDeProjeto` (argumento avaliado antes da chamada,
`server.ts:555-559`) → `addFolder`. Logo, `INVALID_PATH` vem antes de `PROJECT_NOT_FOUND`.

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `PROJECT_NOT_FOUND` | 404 | P1 `PR:111` | `server.ts:555` → `SM:388-390` → `PR:198` | sim |
| `PROJECT_FOLDER_CONFLICT` | 400 | `PR:208` | `PR:206-209`; pasta dentro/contendo pasta registrada ou pasta de outro projeto | sim |
| `PROJECT_FOLDER_CONFLICT` | 400 | `PR:203` | formato | n/a (borda recusa antes) |

### 16. `DELETE /projects/:id/folders/:folderId`

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `PROJECT_NOT_FOUND` | 404 | P1 `PR:111` | `server.ts:578` → `SM:392-394` → `PR:227` → `PR:185` | sim |
| `FOLDER_NOT_FOUND` | 404 | `PR:230` | `PR:228-234` | sim |
| `FOLDER_IS_PRIMARY` | 400 | `PR:236-240` | `PR:235` | sim |

### 17. `GET /projects/:id/context`

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `PROJECT_NOT_FOUND` | 404 | P1 `PR:111` | `server.ts:600` → `SM:370-372` → `PR:154` (e `repoStatus`, `PR:171`) | sim |

### 18. `PUT /projects/:id/context`

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `PROJECT_NOT_FOUND` | 404 | P1 `PR:111` | `server.ts:612` → `SM:380-382` → `PR:164` | sim |

`PROJECT_CONFIG_INVALID` de `daemon/src/project-config.ts:405` está em `saveProjectContext`, que
nenhum módulo chama fora dos testes (grep em `daemon/src/*.ts` não-teste): não é alcançável.

### 19. `POST /projects/:id/import`

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `PROJECT_NOT_FOUND` | 404 | P1 `PR:111` | `server.ts:636` → `SM:313-315` | sim |
| `INVALID_BRIEF` | 422 | `daemon/src/absorption.ts:326-330` | `server.ts:639` → `ImportService.run` (`absorption.ts:323-331`); `kinds` com `mcp` e `targetAgents` vazio/ausente | sim |
| `AGENT_NOT_FOUND` | 404 | `daemon/src/absorption.ts:214` | `absorption.ts:334` → `raw` | sim |

### 20. `PUT /projects/:id/policy`
Ordem: `:id` → corpo → (prévia ou gravação). A camada é validada por `parsePolicyLayer` antes de
buscar o projeto (`policy-service.ts:158-159`, `:172-173`).

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `INVALID_BRIEF` | 422 | `daemon/src/policy-service.ts:71` | `operator-routes.ts:150` / `:153` → `policy-service.ts:158` / `:172`; mensagem `"política inválida"` | sim |
| `PROJECT_NOT_FOUND` | 404 | `daemon/src/policy-service.ts:218` | `#project` via `:159` (prévia) ou `:173` (gravação) | sim (as duas) |
| `PROJECT_CONFIG_INVALID` | 400 | `daemon/src/policy-service.ts:180-185` | só gravação; `.agents-hub/config.yaml` do projeto não é YAML válido | sim |
| `PROJECT_CONFIG_INVALID` | 400 | `daemon/src/policy-service.ts:193-198` | só gravação; arquivo declara chaves de política no topo, sem `policy:` | sim |

## 6.4 Sessões e tasks

### 21. `GET /sessions`
Nenhum erro de domínio. Filtros com texto arbitrário devolvem `200 {"sessions":[]}` (confirmado).

### 22. `POST /sessions`
Caminho: `server.ts:677` → `sessions.start` — tabela ST inteira (com `requesterSessionId` e
`baseSessionIds` vindos do corpo).

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `INVALID_BRIEF` | 422 | `core/src/brief.ts:121` | ST-1 | sim |
| `PROJECT_NOT_FOUND` | 404 | `SM:407` | ST-2 | sim |
| `SESSION_NOT_FOUND` | 404 | `SM:414` | ST-3 | sim |
| `ILLEGAL_STATE` | 400 | S4 `SM:360` | ST-4 | sim |
| `AGENT_NOT_FOUND` | 404 | `REG:188` | ST-5 | sim |
| `CAPABILITY_UNRESOLVED` | 424 | `REG:215` | ST-5 | sim |
| `CONCURRENCY_EXCEEDED` | 409 | `SM:4075`, `SM:4087`, `SM:4123` (`:4131` análogo) | ST-6 | sim (`:4075`, `:4087`, `:4123`) |
| `DEPTH_EXCEEDED` | 409 | `core/src/graph.ts:42` | ST-7 | sim |
| `CYCLE_DETECTED` | 409 | `core/src/graph.ts:50` | ST-8 | não (confirmado na rota 38) |
| `BUDGET_EXCEEDED` | 409 | `core/src/budget.ts:206` | ST-9 | não (confirmado na rota 38) |
| `SESSION_NOT_FOUND` | 404 | `daemon/src/session-bases.ts:26` | ST-10 | sim |
| `ILLEGAL_STATE` | 400 | `daemon/src/session-bases.ts:29` | ST-11 | sim |
| `ILLEGAL_STATE` | 400 | `worktree.ts:211/:219/:230/:255`, `SM:508` | ST-12 a ST-16 | `worktree.ts`: coberto pelos casos da rota 7 (`r07-07`, `r07-06`, `r07-08`, `r07-09`; mesmos pontos de lançamento: `worktree.ts:211`, `:219`, `:230`, `:255`); `SM:508`: complexo (`r22-14`) |
| `POLICY_DENIED` | 403 | `SM:617` | ST-17 | não (confirmado na rota 38) |
| tabela L | — | — | ST-18 | `AGENT_NOT_INSTALLED`: coberto pelo caso da rota 7 (`r07-10`; mesmo ponto de lançamento: `PA:205`); `CODEX_GATE_NOT_GUARANTEED`: coberto pelo caso da rota 7 (`r07-12`; mesmo ponto de lançamento: `SM:2405`); `ADAPTER_FAILURE` e `TIMEOUT` e `AGENT_NOT_INSTALLED` do OpenCode: cobertos pelos casos `complexo` da rota 7 (`r07-14`, `r07-15`, `r07-16`; mesmos pontos de lançamento: `PA:242`, `PA:694`, `OC:171`, `OC:691`, `OC:696`, `OC:748`, `OC:706`, `OC:569`, `OC:613`); `AGENT_NOT_FOUND` de `SM:2185` não se aplica (o alvo acabou de ser resolvido em `SM:429`); `PA:123` e `OC:189` não se aplicam (só em `resume`; este caminho passa `nativeSessionId` nulo) |

### 23. `POST /sessions/adopt`

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `PROJECT_FOLDER_CONFLICT` | 400 | `PR:77` | `server.ts:697` → `PR:75-78` (só com `projectPath`) | sim |
| `PROJECT_NOT_FOUND` | 404 | `SM:1831` | `server.ts:703` → `adoptExternal` | sim |
| `AGENT_NOT_FOUND` | 404 | `SM:1836` | `adoptExternal`, `registry.has` falso | sim |

### 24. `POST /sessions/:id/detach`

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `SESSION_NOT_FOUND` | 404 | S1 `SM:4308` | `server.ts:716` → `SM:1903` | sim |
| `ILLEGAL_STATE` | 400 | `SM:1908-1912` | sessão não adotada | sim |

Sessão adotada já terminal: 200 sem erro (`SM:1916`).

### 25. `POST /sessions/:id/heartbeat`
`createHub` sempre passa `leases` (`daemon/src/hub.ts:112-115`, `:130`), então o ramo `leaseMs: null`
(`server.ts:726-729`) só existe em servidor montado à mão.

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `SESSION_NOT_FOUND` | 404 | S1 `SM:4308` | `server.ts:730` → `adopted-leases.ts:90` → `SM:1929-1931` | sim (ausente da SPEC-01, linha 25) |
| `ILLEGAL_STATE` | 400 | `daemon/src/adopted-leases.ts:92-96` | não é raiz adotada | sim |
| `ILLEGAL_STATE` | 400 | `daemon/src/adopted-leases.ts:100` | raiz adotada terminal | sim |

### 26. `GET /sessions/:id/artifacts` · 27. `GET /sessions/:id/diff` · 28. `GET /sessions/:id/tasks`
Nenhum erro de domínio: consultam o store sem validar a sessão. Id inexistente devolve
`{"artifacts":[]}`, `{"diff":null,"message":"esta sessão não alterou nenhum arquivo"}` e
`{"tasks":[]}` com 200 (confirmado).

### 29. `GET /tasks/:id`

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `TASK_NOT_FOUND` | 404 | S2 `SM:1936` | `server.ts:770` | sim |
| `SESSION_NOT_FOUND` | 404 | S1 | `server.ts:771` | n/a |

### 30. `GET /context`
Resolve o "depende de `fetchContext`" da SPEC-01.

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `ILLEGAL_STATE` | 400 | `SM:1969-1973` | `server.ts:788` → `fetchContext`; `ref` fora de `^session:([^#]+)(?:#event:(\d+))?$` após `trim`. **Sem `ref`, vale `""` (`server.ts:787`) e também dá 400** | sim |
| `SESSION_NOT_FOUND` | 404 | S1 `SM:4308` | `SM:1977`; id da `ref` sem schema de formato | sim |

### 31. `GET /sessions/:id`

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `SESSION_NOT_FOUND` | 404 | S1 `SM:4308` | `server.ts:793` | sim |

### 32. `GET /sessions/:id/events`
Nenhum erro de domínio: `listEvents` (`SM:2015-2025`) não valida a sessão. Id inexistente devolve
`200 {"events":[]}` (confirmado).

### 33. `POST /sessions/:id/send`
Caminho: `server.ts:824` → `send` (`SM:1477-1561`).

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `SESSION_NOT_FOUND` | 404 | S1 `SM:4308` | `SM:1478` | sim |
| `ILLEGAL_STATE` | 400 | S5 `SM:1418` | `SM:1479` (`waiting_approval`) | sim |
| `AGENT_NOT_FOUND` | 404 | A1 `REG:88` | `SM:1480` | complexo |
| `ADAPTER_FAILURE` | 502 | `PA:140-144`; `OC:221`, `OC:748` | `SM:1485` (envio ao vivo) | complexo |
| `ILLEGAL_STATE` | 400 | `SM:1492-1496` | run viva sem envio ao vivo (one-shot) | sim |
| `ILLEGAL_STATE` | 400 | `daemon/src/session-continuation.ts:21` (fábrica), lançado em `SM:1503` | sessão `killed`/`failed`/`completed` | sim |
| `ILLEGAL_STATE` | 400 | `SM:1510-1515` | sessão fechando o turno (validação/revisão/backoff) | complexo |
| `TASK_NOT_FOUND` | 404 | S3 `SM:4316` | `SM:1518`; sessão sem task, ex.: raiz adotada | sim |
| tabela L | — | — | `SM:1547` com `continuacao: true`: sem `#falhaAoLancar`, a sessão volta a `idle` (`SM:1551-1558`) | complexo, com caso próprio: `AGENT_NOT_INSTALLED` `PA:205` (`r33-09`), `ADAPTER_FAILURE` `PA:123`/`PA:140`/`OC:221`/`OC:748` (`r33-08`), `SESSION_NOT_FOUND` `OC:189` (`r33-10`); `CODEX_GATE_NOT_GUARANTEED`: coberto pelo caso da rota 7 (`r07-12`; mesmo ponto de lançamento: `SM:2405`); `ADAPTER_FAILURE` e `TIMEOUT` e `AGENT_NOT_INSTALLED` do OpenCode: cobertos pelos casos `complexo` da rota 7 (`r07-14`, `r07-15`, `r07-16`; mesmos pontos de lançamento: `PA:242`, `PA:694`, `OC:171`, `OC:691`, `OC:696`, `OC:748`, `OC:706`, `OC:569`, `OC:613`) |

### 34. `POST /sessions/:id/interrupt`

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `SESSION_NOT_FOUND` | 404 | S1 | `server.ts:835` → `SM:1593` | sim |
| `ILLEGAL_STATE` | 400 | S4 `SM:360` | `SM:1594` | sim |
| `ILLEGAL_STATE` | 400 | S5 `SM:1418` | run viva → `#pararTurno` `SM:1614` | complexo |
| `AGENT_NOT_FOUND` | 404 | A1 | `SM:1616` | complexo |
| `ILLEGAL_STATE` | 400 | `SM:1620-1625` | run viva de agente com `session.strategy: none` | sim |

Sem run viva e sessão não terminal: 200 `interrupted:false` (`SM:1596-1597`).

### 35. `POST /sessions/:id/pause`

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `SESSION_NOT_FOUND` | 404 | S1 | `server.ts:841` → `SM:1694` | sim |
| `ILLEGAL_STATE` | 400 | S4 `SM:360` | `SM:1695` | sim |
| `ILLEGAL_STATE` | 400 | `SM:1701-1706` | fechando o turno | complexo |
| `ILLEGAL_STATE` | 400 | S5 `SM:1418` | com run viva: `SM:1711` → `:1614`; sem run: `SM:1715` | sim (sem run) |
| `ILLEGAL_STATE` | 400 | `SM:1620-1625` | run viva, `session.strategy: none` | sim |
| `AGENT_NOT_FOUND` | 404 | A1 | `SM:1616` | complexo |

### 36. `POST /sessions/:id/cancel`

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `SESSION_NOT_FOUND` | 404 | S1 | `server.ts:847` → `SM:1654` | sim |
| `ILLEGAL_STATE` | 400 | S4 `SM:360` | `SM:1660-1661` (só na chamada de topo) | sim |
| `AGENT_NOT_FOUND` | 404 | A1 | `SM:1667` | complexo |

### 37. `POST /sessions/:id/handoff`
Ordem relevante: `resolveTarget` (`SM:1727`) vem **antes** da checagem de terminal (`SM:1729`):
sessão terminal com alvo inexistente dá 404, não 400 (confirmado). Usa `config.policy.fallback`
global, não a do projeto (`SM:1727`). A reserva não leva `projectId` (`SM:1740`): só C1 e C2.

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `SESSION_NOT_FOUND` | 404 | S1 | `server.ts:854` → `SM:1726` | sim |
| `AGENT_NOT_FOUND` | 404 | A2 `REG:188` | `SM:1727` | sim |
| `CAPABILITY_UNRESOLVED` | 424 | A3 `REG:215` | `SM:1727` | sim |
| `ILLEGAL_STATE` | 400 | `SM:1730-1734` | sessão terminal | sim |
| `ILLEGAL_STATE` | 400 | S5 `SM:1418` | `SM:1736` | sim |
| `CONCURRENCY_EXCEEDED` | 409 | C1 `SM:4075`, C2 `SM:4087` | `SM:1740` | não |
| `AGENT_NOT_FOUND` | 404 | A1 | `SM:1757` (run viva) | complexo |
| `TASK_NOT_FOUND` | 404 | S3 `SM:4316` | `SM:1760`; raiz adotada | sim |
| tabela L | — | — | `SM:1800` (sem `continuacao`: sessão termina `failed`) | `AGENT_NOT_INSTALLED`: sim (`r37-08`); `CODEX_GATE_NOT_GUARANTEED`: coberto pelo caso da rota 7 (`r07-12`; mesmo ponto de lançamento: `SM:2405`); `ADAPTER_FAILURE` e `TIMEOUT` e `AGENT_NOT_INSTALLED` do OpenCode: cobertos pelos casos `complexo` da rota 7 (`r07-14`, `r07-15`, `r07-16`; mesmos pontos de lançamento: `PA:242`, `PA:694`, `OC:171`, `OC:691`, `OC:696`, `OC:748`, `OC:706`, `OC:569`, `OC:613`); `AGENT_NOT_FOUND` de `SM:2185` não se aplica (alvo resolvido em `SM:1727`); `PA:123` e `OC:189` não se aplicam (só em `resume`; este caminho passa `nativeSessionId` nulo) |

### 38. `POST /sessions/:id/delegate`
Caminho: `server.ts:865` (`getSession` do solicitante) → `server.ts:866` `start` com
`requesterSessionId` (tabela ST; ST-3 nunca dispara porque o solicitante já foi lido).

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `SESSION_NOT_FOUND` | 404 | S1 `SM:4308` | `server.ts:865` | sim |
| `INVALID_BRIEF` | 422 | `core/src/brief.ts:121` | ST-1 | sim |
| `PROJECT_NOT_FOUND` | 404 | `SM:407` | ST-2 (`projectId` do corpo) | sim |
| `ILLEGAL_STATE` | 400 | S4 `SM:360` | ST-4 | sim |
| `AGENT_NOT_FOUND` | 404 | `REG:188` | ST-5 | sim |
| `CAPABILITY_UNRESOLVED` | 424 | `REG:215` | ST-5 | não |
| `CONCURRENCY_EXCEEDED` | 409 | C1/C2/C3 | ST-6 | sim (C2 `SM:4087`) |
| `DEPTH_EXCEEDED` | 409 | `core/src/graph.ts:42` | ST-7 | sim |
| `CYCLE_DETECTED` | 409 | `core/src/graph.ts:50` | ST-8 | sim |
| `BUDGET_EXCEEDED` | 409 | `core/src/budget.ts:206` | ST-9 | sim |
| `ILLEGAL_STATE` | 400 | `worktree.ts` | ST-12 a ST-15 | coberto pelos casos da rota 7 (`r07-07`, `r07-06`, `r07-08`, `r07-09`; mesmos pontos de lançamento: `worktree.ts:211`, `:219`, `:230`, `:255`) |
| `POLICY_DENIED` | 403 | `SM:617` | ST-17 | sim |
| tabela L | — | — | ST-18 | `AGENT_NOT_INSTALLED`: sim (`r38-07`); `CODEX_GATE_NOT_GUARANTEED`: coberto pelo caso da rota 7 (`r07-12`; mesmo ponto de lançamento: `SM:2405`); `ADAPTER_FAILURE` e `TIMEOUT` e `AGENT_NOT_INSTALLED` do OpenCode: cobertos pelos casos `complexo` da rota 7 (`r07-14`, `r07-15`, `r07-16`; mesmos pontos de lançamento: `PA:242`, `PA:694`, `OC:171`, `OC:691`, `OC:696`, `OC:748`, `OC:706`, `OC:569`, `OC:613`); `AGENT_NOT_FOUND` de `SM:2185` não se aplica (alvo resolvido em `SM:429`); `PA:123` e `OC:189` não se aplicam (só em `resume`; este caminho passa `nativeSessionId` nulo) |

## 6.5 Aprovações e gate

### 39. `GET /approvals`
Nenhum erro de domínio. `sessionId` arbitrário devolve `200 {"approvals":[]}` (confirmado).

### 40. `GET /approvals/:id`

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `APPROVAL_NOT_FOUND` | 404 | `SM:1118` | `server.ts:894` → `getApproval` | sim |

### 41. `POST /approvals/:id`
Caminho: `server.ts:908` → `resolveApproval` (`SM:1131-1294`). A aprovação é gravada (`SM:1137`)
**antes** dos passos que podem lançar depois dela: um erro em `#launch`/`send`/`cancel` sai como
erro HTTP com a decisão já persistida (confirmado para `#launch`: depois do 424, a segunda
chamada dá 400 `ILLEGAL_STATE` de `SM:1134`).

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `APPROVAL_NOT_FOUND` | 404 | `SM:1118` | `SM:1132` | sim |
| `ILLEGAL_STATE` | 400 | `SM:1134` | aprovação não `pending` (inclusive a fechada por `#finish`, `SM:3698-3703`, quando a sessão termina) | sim |
| `SESSION_NOT_FOUND` | 404 | S1 | `SM:1143` | n/a |
| tabela L | — | — | delegação aprovada: `SM:1274` (sem `continuacao`) | `AGENT_NOT_INSTALLED`: sim (`r41-02`); `CODEX_GATE_NOT_GUARANTEED`: coberto pelo caso da rota 7 (`r07-12`; mesmo ponto de lançamento: `SM:2405`); `ADAPTER_FAILURE` e `TIMEOUT` e `AGENT_NOT_INSTALLED` do OpenCode: cobertos pelos casos `complexo` da rota 7 (`r07-14`, `r07-15`, `r07-16`; mesmos pontos de lançamento: `PA:242`, `PA:694`, `OC:171`, `OC:691`, `OC:696`, `OC:748`, `OC:706`, `OC:569`, `OC:613`); `AGENT_NOT_FOUND` de `SM:2185`: coberto pelo caso `complexo` da rota 33 (`r33-07`; mesmo ponto de lançamento: `REG:88`); `PA:123` e `OC:189` não se aplicam (só em `resume`; este caminho passa `nativeSessionId` nulo) |
| erros de `send` (rota 33) | — | — | vigilância aprovada: `SM:1289` | coberto pelos casos da rota 33 (`r33-01` a `r33-10`; mesmos pontos de lançamento: o `send` de `SM:1477-1561`); o estado de vigilância pausada não foi montado |
| `ILLEGAL_STATE` | 400 | S4 `SM:360` | negação: `SM:1180` → `cancel` com sessão terminal | complexo: não reproduzido (`#finish` fecha as pendentes, então a checagem `SM:1134` barra antes) |
| não determinado | — | — | orçamento com turno concluído: `SM:1261` (`#settle`) | não determinado (não percorri `#settle`) |

Aprovação do gate (`detail.kind === 'tool-call'`): `#resolverChamadaDoGate` engole o erro do
`send` e o registra na timeline (`SM:1390-1403`).

### 42. `POST /hooks/pretooluse`
Nenhum `HubError` de domínio identificado em `gateToolCall` (`SM:885-1059`): sessão não achada
devolve `allow` (`SM:899-905`), e o timeout chama `resolveApproval(...).catch` (`SM:1056`).

## 6.6 Manutenção

### 43. `POST /shutdown` · 44. `POST /maintenance/sweep`
Nenhum erro de domínio (`daemon/src/reaper.ts` não lança `HubError`; grep).

### 45. `POST /maintenance/backup`

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `INVALID_PATH` | 400 | `store/src/backup.ts:54` | `maintenance-routes.ts:62` → `backupDatabase`; banco ausente | complexo (o daemon mantém o banco aberto) |
| `ILLEGAL_STATE` | 400 | `store/src/backup.ts:58-64` | destino já existe | sim |
| `ILLEGAL_STATE` | 400 | `store/src/backup.ts:82` | `VACUUM INTO` falhou | complexo |
| `INVALID_PATH` | 400 | `store/src/backup.ts:101`, `:115`, `:124`, `:130` | `conferirBanco` da cópia recém-gerada (`:87`) | complexo |
| `HUB_CONFIG_INVALID` | 400 | `store/src/backup.ts:142-147` | cópia com migração mais nova que o código | n/a na prática (a cópia vem do banco que este código abriu) |

## 6.7 Política e auditoria

### 46. `GET /policy`

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `PROJECT_NOT_FOUND` | 404 | `daemon/src/policy-service.ts:218` | `operator-routes.ts:110` → `view` `:108` → `#projectView` `:224` | sim |

### 47. `PUT /policy`

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `INVALID_BRIEF` | 422 | `daemon/src/policy-service.ts:71` | `operator-routes.ts:122` → `:145` (prévia) / `operator-routes.ts:125` → `:123` (gravação) | sim (as duas) |

### 48. `GET /audit`
Nenhum erro de domínio (só `INVALID_QUERY` do handler, já na SPEC-01).

## 6.8 Orçamento, workflows, integrações, grafo e stream

### 49. `PUT /budget/:rootId`

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `SESSION_NOT_FOUND` | 404 | S1 | `operation-routes.ts:105` → `SM:2041` | sim |
| `ILLEGAL_STATE` | 400 | `SM:2043-2047` | sessão não é raiz | sim |
| `INVALID_QUERY` | 400 | `SM:2062-2066` | novo teto < consumido + reservado | sim |

### 50. `POST /workflows/validate`
Nenhum erro de domínio: `validarWorkflowYaml` nunca lança (`daemon/src/workflow-runs.ts:85-132`).

### 51. `POST /workflows/runs`

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `ILLEGAL_STATE` | 400 | `daemon/src/workflow-runs.ts:210` | `operation-routes.ts:128` → `start`; runner fechado (`server.ts:190`) | complexo (janela de desligamento) |
| `PROJECT_NOT_FOUND` | 404 | P1 `PR:111` | `workflow-runs.ts:212` → `SM:313-315` (o host é o `SessionManager`, `server.ts:162`) | sim |
| `INVALID_BRIEF` | 422 | `daemon/src/workflow-runs.ts:216-218` | YAML que `validarWorkflowYaml` reprova | sim |

Erros dos passos (o `start` de cada passo) acontecem em segundo plano (`workflow-runs.ts:251`) e
não chegam à resposta HTTP.

### 52. `GET /workflows/runs`
Nenhum erro de domínio.

### 53. `GET /workflows/runs/:id`

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `TASK_NOT_FOUND` | 404 | `daemon/src/workflow-runs.ts:194-200` | `operation-routes.ts:141` → `get` | sim |

### 54. `GET /integrations`

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `PROJECT_NOT_FOUND` | 404 | P1 `PR:111` | `integration-routes.ts:68` → `server.ts:1044` → `SM:313-315` | sim |

### 55. `POST /integrations/:agentId/:tipo`
Caminho: `integration-routes.ts:98` (projeto) → `:105` `planejarIntegracao` (prévia) ou `:116`
`aplicarIntegracao` → `calcular` (`daemon/src/integrations.ts:264-359`). Em `aplicarIntegracao` o
`calcular` roda antes da comparação de `base` (`integrations.ts:383-384`).

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `PROJECT_NOT_FOUND` | 404 | P1 `PR:111` | `integration-routes.ts:98` → `server.ts:1044` | sim |
| `CAPABILITY_UNRESOLVED` | 424 | `daemon/src/integrations.ts:274-280` | `hook` para agente sem destino de hook (só `claude` e `openclaude` têm, `daemon/src/hooks-config.ts:81-91`; `codex` tem mensagem própria) | sim |
| `ILLEGAL_STATE` | 400 | `daemon/src/integrations.ts:283-287` | `hook`: `packages/cli/dist/bin.js` ausente | complexo (depende do build) |
| `AGENT_CONFIG_INVALID` | 422 | `daemon/src/integrations.ts:261` (fábrica), lançado em `:295` | `hook`: settings do agente ilegível (`lerJsonDeConfig`, `daemon/src/safe-write.ts:114-142`) | sim |
| `CAPABILITY_UNRESOLVED` | 424 | `daemon/src/integrations.ts:318` | `mcp` para agente sem destino de MCP | sim |
| `INVALID_QUERY` | 400 | `daemon/src/integrations.ts:323-327` | `mcp` de destino por projeto (ex.: `claude`, `configPath: null`) sem `projectId` | sim |
| `ILLEGAL_STATE` | 400 | `daemon/src/integrations.ts:330-334` | `mcp`: `packages/mcp/dist/main.js` ausente | complexo |
| `AGENT_CONFIG_INVALID` | 422 | `daemon/src/integrations.ts:261`, lançado em `:341` | `mcp`: `planUpsertMcpServer` recusa o arquivo | não |
| `CONFIG_CHANGED` | 409 | `daemon/src/integrations.ts:385-389` | `dryRun:false` com `base` diferente do hash atual; nada é gravado | sim |

### 56. `GET /graph/:rootId` · 57. `GET /budget/:rootId`

| Rota | Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|---|
| 56 | `SESSION_NOT_FOUND` | 404 | S1 | `server.ts:1054` | sim |
| 57 | `SESSION_NOT_FOUND` | 404 | S1 | `server.ts:1060` | sim |

### 58. `GET /events`

| Código | Status | Lançado em | Caminho | Conf. |
|---|---|---|---|---|
| `SESSION_NOT_FOUND` | 404 | S1 | `server.ts:1074` (`sessionId`) e `:1075` (`rootId`); texto arbitrário também cai aqui, sem schema | sim |

---

## Códigos que nenhuma rota lança

| Código | Evidência |
|---|---|
| `AGENT_NOT_AUTHENTICATED` | só aparece em `core/src/errors.ts:9` e em `statusFor` (`server.ts:1191`); grep em `core`, `store`, `adapters`, `daemon` (não-teste) |
| `APPROVAL_REQUIRED` | só em `core/src/errors.ts:33` e `server.ts:1170` |
| `HUB_CONFIG_INVALID` | lançado na carga da config (`daemon/src/config.ts:276`, `:284`, `core/src/hub-env.ts:75`, `store/src/db.ts:66`), antes do servidor existir; na API só `store/src/backup.ts:142` (n/a na prática) |
| `PROJECT_CONFIG_INVALID` em `project-config.ts:405` | função sem chamador de produção (rota 18) |

## Erros que não são `HubError` (viram 500 `INTERNAL`)

Observados no caminho, sem enumeração exaustiva:

- `lerJsonDeConfig` lança `Error` simples (`daemon/src/safe-write.ts:127-130`, `:139`). Em
  `PolicyService.globalLayer`/`setGlobalLayer` (`policy-service.ts:95`, `:127`) isso é 500 se o
  `config.json` for corrompido com o daemon no ar (rotas 46 e 47). Na integração ele é convertido
  em `AGENT_CONFIG_INVALID` (`integrations.ts:292-296`).
- `gravarSettingsDaSessao` (tabela L) e escrita de arquivo em `setProjectLayer`
  (`policy-service.ts:209-210`), `gravarComBackup` (`integrations.ts:392`), `mkdirSync`
  (`store/src/backup.ts:66`).

## Divergências com a SPEC-01 §6 (para quem mantém a SPEC)

Comparação da coluna "Erros específicos" da SPEC-01 §6 com as seções acima. Só aparecem as
linhas em que falta código ou em que a SPEC diz apenas "do domínio". Entre parênteses com o
prefixo "complexos:", os códigos cobertos só por casos `complexo`; "origem: tabela L" indica de
onde vem um código já confirmado.

| Linha | A SPEC diz | Falta |
|---|---|---|
| 7 | `INVALID_PATH`; "erros de `sessions.start`" | `PROJECT_FOLDER_CONFLICT` 400; da tabela ST: `INVALID_BRIEF` 422, `PROJECT_NOT_FOUND` 404, `AGENT_NOT_FOUND` 404, `CAPABILITY_UNRESOLVED` 424, `CONCURRENCY_EXCEEDED` 409, `ILLEGAL_STATE` 400 (worktree), `CODEX_GATE_NOT_GUARANTEED` 424, `AGENT_NOT_INSTALLED` 424 (complexos: `ADAPTER_FAILURE` 502, `TIMEOUT` 504) |
| 9 | `TASK_NOT_FOUND` | `ILLEGAL_STATE` 400 (sessão da task terminal) |
| 12 | `INVALID_PATH` | `PROJECT_FOLDER_CONFLICT` 400 |
| 15 | `INVALID_PATH`; `PROJECT_NOT_FOUND` | `PROJECT_FOLDER_CONFLICT` 400 |
| 19 | `PROJECT_NOT_FOUND`, `AGENT_NOT_FOUND` | `INVALID_BRIEF` 422 do domínio (`kinds` com `mcp` sem `targetAgents`, `absorption.ts:326-330`), distinto do 422 de schema |
| 20 | `INVALID_QUERY`; `INVALID_BRIEF` | `PROJECT_NOT_FOUND` 404; `PROJECT_CONFIG_INVALID` 400 |
| 22 | `INVALID_BRIEF`; `PROJECT_NOT_FOUND`; "409/424 do domínio" | `SESSION_NOT_FOUND` 404 (solicitante e sessão-base); `ILLEGAL_STATE` 400 (solicitante terminal, sessão-base de outro projeto, worktree); `POLICY_DENIED` 403; `AGENT_NOT_FOUND` 404 (complexos: `ADAPTER_FAILURE` 502, `TIMEOUT` 504) |
| 23 | `INVALID_PATH` | `PROJECT_FOLDER_CONFLICT` 400; `PROJECT_NOT_FOUND` 404; `AGENT_NOT_FOUND` 404 |
| 24 | `SESSION_NOT_FOUND` | `ILLEGAL_STATE` 400 (sessão não adotada) |
| 25 | `ILLEGAL_STATE` | `SESSION_NOT_FOUND` 404 |
| 30 | "depende de `fetchContext`" | `ILLEGAL_STATE` 400 (inclusive sem `ref`); `SESSION_NOT_FOUND` 404 |
| 33 | "do domínio" | `SESSION_NOT_FOUND` 404; `ILLEGAL_STATE` 400 (aguardando aprovação, run one-shot viva, sessão terminal); `TASK_NOT_FOUND` 404 (raiz adotada) (complexos: `AGENT_NOT_FOUND`, `ADAPTER_FAILURE`, `AGENT_NOT_INSTALLED`, demais da tabela L) |
| 34 | `SESSION_NOT_FOUND` | `ILLEGAL_STATE` 400 (terminal, `session.strategy: none`) (complexos: `AGENT_NOT_FOUND`) |
| 35 | "do domínio" | `SESSION_NOT_FOUND` 404; `ILLEGAL_STATE` 400 (terminal, aguardando aprovação, `session.strategy: none`) (complexos: `AGENT_NOT_FOUND`) |
| 36 | "do domínio" | `SESSION_NOT_FOUND` 404; `ILLEGAL_STATE` 400 (terminal) (complexos: `AGENT_NOT_FOUND`) |
| 37 | "do domínio" | `SESSION_NOT_FOUND` 404; `AGENT_NOT_FOUND` 404; `CAPABILITY_UNRESOLVED` 424; `ILLEGAL_STATE` 400; `TASK_NOT_FOUND` 404; `CONCURRENCY_EXCEEDED` 409; `AGENT_NOT_INSTALLED` 424, origem: tabela L (complexos: demais da tabela L) |
| 38 | `SESSION_NOT_FOUND`; `INVALID_BRIEF`; `DEPTH_EXCEEDED`/`CYCLE_DETECTED`/`BUDGET_EXCEEDED` "etc." | `ILLEGAL_STATE` 400 (pai terminal); `PROJECT_NOT_FOUND` 404; `AGENT_NOT_FOUND` 404; `CAPABILITY_UNRESOLVED` 424; `CONCURRENCY_EXCEEDED` 409; `POLICY_DENIED` 403; `AGENT_NOT_INSTALLED` 424, origem: tabela L (complexos: demais da tabela L) |
| 41 | `APPROVAL_NOT_FOUND` | `ILLEGAL_STATE` 400 (já resolvida); `AGENT_NOT_INSTALLED` 424 ao aprovar delegação, origem: tabela L (complexos: demais da tabela L, erros de `send`) |
| 49 | "do domínio" | `SESSION_NOT_FOUND` 404; `ILLEGAL_STATE` 400; `INVALID_QUERY` 400 |
| 51 | "do domínio" | `PROJECT_NOT_FOUND` 404; `INVALID_BRIEF` 422 ("workflow inválido") (complexos: `ILLEGAL_STATE` no desligamento) |
| 55 | `INVALID_QUERY` (agente/tipo); `INVALID_BRIEF`; `CONFIG_CHANGED`; `AGENT_CONFIG_INVALID` | `PROJECT_NOT_FOUND` 404; `CAPABILITY_UNRESOLVED` 424; `INVALID_QUERY` 400 do domínio (destino por projeto) (complexos: `ILLEGAL_STATE` com entrypoint ausente) |
