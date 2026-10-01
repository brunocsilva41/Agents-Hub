# domain-errors — erros de domínio por rota (F4-14)

Dados para o corpus HTTP de F0-13 e para o aceite de F4-09. Fecham o ponto NÃO DETERMINADO
"Erros de domínio por rota" da SPEC-01 §10 (`docs/especificacao/01-api-http.md`).

| Arquivo | Conteúdo |
|---|---|
| `route-errors.md` | por rota (as 58, numeração da SPEC-01 §6): código, status HTTP, `arquivo:linha` do lançamento e caminho até a rota |
| `route-errors.jsonl` | um caso por linha: (rota, código) com pré-condição, requisição e resposta esperada |

## Origem

- Código TS lido: commit `c3ecbee83749e2d8637f30501a91679354164c0c`. O `packages/` é idêntico entre
  `c3ecbee` e o HEAD atual (`git diff --stat c3ecbee HEAD -- packages` sai vazio).
- `packages/` não mudou desde `82f40cc` (commit de onde a SPEC-01 foi extraída):
  `git diff --stat 82f40cc HEAD -- packages` sai vazio.
- Nada em `packages/` foi alterado.

## Método

1. **Inventário dos lançamentos.** Grep de `HubError(` e de cada literal de `HubErrorCode`
   (`core/src/errors.ts:6-42`) em `core/src`, `store/src`, `adapters/src` e `daemon/src`, sem
   `*.test.ts`. Também foram buscadas as fábricas que devolvem `HubError`
   (`invalido` em `project-path.ts`, `recusaDeSessaoTerminada`, `recusaDeConfig`, `cursorInvalido`,
   `corpoGrande` em `http-body.ts`).
2. **Rota a rota.** Leitura do handler em `daemon/src/server.ts` e nos módulos de rota
   (`operator-routes.ts`, `maintenance-routes.ts`, `operation-routes.ts`, `integration-routes.ts`) e
   de cada método de domínio chamado: `session-manager.ts`, `policy-service.ts`,
   `workflow-runs.ts`, `integrations.ts`, `project-registry.ts`, `adopted-leases.ts`,
   `absorption.ts`, `session-bases.ts`, `worktree.ts`, `store/src/backup.ts`,
   `adapters/src/registry.ts`, `adapters/src/process-adapter.ts`,
   `adapters/src/opencode/adapter.ts` e `core` (`brief.ts`, `graph.ts`, `budget.ts`). O status vem
   de `statusFor` (`daemon/src/server.ts:1153-1205`).
3. **Confirmação em processo.** Cada caso marcado `verified: true` foi executado contra um Hub
   montado em processo a partir do `src` (Node 24.14.0, `--experimental-transform-types` e um hook
   de resolução `.js`→`.ts` / `dist`→`src`), com:
   - `AGENTS_HUB_HOME` temporário (sob o scratchpad da sessão), `AGENTS_HUB_PORT` 47997/47998,
     `AGENTS_HUB_NO_AUTOSTART=1`, `createHub({ home, manifestsDir, port: 0, webRoot })`;
   - `deps.homeDir` (home do "usuário", usado por descoberta e integrações) também temporário;
   - só agentes falsos (ver "Ambiente"). Nenhum modelo foi chamado; a porta 4747 e o
     `~/.agents-hub` não foram tocados.

   Resultado: três execuções (a principal e duas da execução extra, a segunda ampliada na
   auditoria). Os 120 casos `verified: true` do JSONL foram cruzados com os resultados gravados
   (rota, status, código): nenhum sem execução correspondente. Há ainda checagens auxiliares
   (montagem de estado e rotas sem erro). Uma hipótese foi
   refutada e está registrada: negar/aprovar uma aprovação depois de cancelar a sessão dá
   `ILLEGAL_STATE` "já foi denied" (`SM:1134`), porque `#finish` fecha as pendentes
   (`daemon/src/session-manager.ts:3698-3703`); o ramo de `cancel` em `SM:1180` não foi alcançado.

   Os scripts de confirmação ficaram fora do repositório (scratchpad da sessão): a área é de dados
   e o ADR 7.10 veda trabalho novo em TS. Ver "Lacunas e reprodução".

## Convenção de linhas

- `route-errors.md`, coluna "Lançado em": linha do `throw new HubError(` (ou faixa do `throw`);
  para fábrica, a linha do `return new HubError(` e a linha do `throw` que a usa.
- `route-errors.jsonl`, campo `thrown_at`: linha onde aparece o **literal do código**
  (`grep -n "'CODIGO'" <arquivo>`). Em lançamentos de várias linhas ela fica uma linha abaixo do
  `throw`.
- `thrown_at` com mais de um ponto (casos `complexo` com alternativas): ` | ` separa
  alternativas; `:N` sozinho é outra linha **do mesmo arquivo** da entrada anterior; `; ` troca de
  arquivo. Exemplo (`r07-14`): `adapters/src/process-adapter.ts:243 | :695;
  adapters/src/opencode/adapter.ts:171 | :691` = `process-adapter.ts:243`, `process-adapter.ts:695`,
  `opencode/adapter.ts:171`, `opencode/adapter.ts:691`. Usado em `r07-14`, `r07-16`, `r33-08`,
  `r45-02` e `r55-08`.

## Ambiente dos casos (`precondition`)

**Hub base:** Hub isolado como acima, com cinco manifestos falsos em `manifestsDir` (YAML no
formato de `daemon/src/delegation-depth.integration.test.ts:66-95`):

| id | `bin` | `session.strategy` | `defaults.supervision` | Uso |
|---|---|---|---|---|
| `fakeok` | `node` + script que não emite nada e fica vivo até ser cancelado (teto 60 s) | `replay` | `semi` | run viva; pai que deixa a delegação passar |
| `fakesup` | idem | `replay` | `supervised` | pai que retém a delegação para aprovação |
| `ghost` | binário inexistente | `replay` | `semi` | `AGENT_NOT_INSTALLED` sem subir processo |
| `nostrat` | idem `fakeok` | `none` | `semi` | interrupt/pause sem retomada |
| `codex` | idem `fakeok` (id falso, não é o Codex) | `replay` | `supervised` | `CODEX_GATE_NOT_GUARANTEED` antes do spawn |

Todos com `defaults.isolation: none`, `stream.format: jsonl`, `mapper: claude`,
`capabilities: [tarefa-falsa]`. O manifesto `codex` entra na cadeia `fallback` de `code-edit`
(`core/src/policy.ts:672-673`): para o caso `CAPABILITY_UNRESOLVED` com `cap:code-edit` o Hub sobe
sem ele (o caso diz isso).

**Placeholders** usados em `precondition` e `request` (definidos na própria `precondition`):
`{{pid}}`/`{{P}}` (projeto base e sua pasta, sem git), `{{adotada}}` (raiz adotada de `fakeok`,
orçamento US$ 1), `{{C}}` (filho de `{{adotada}}` que falhou ao subir com `ghost`: estado
`failed`), `{{sup}}`/`{{retido}}`/`{{apv}}` (raiz `fakesup`, filho retido em `waiting_approval` e
sua aprovação, reserva US$ 0,5), `{{viva}}` (run viva de `fakeok`), `{{ns}}` (run viva de
`nostrat`). Ids como `ses_naoexiste` são bem formados e inexistentes.

## Esquema de `route-errors.jsonl`

| Campo | Tipo | Significado |
|---|---|---|
| `id` | texto | `r<rota>-<n>` |
| `route` | inteiro | número da rota na SPEC-01 §6 |
| `route_path`, `method` | texto | padrão registrado e método |
| `precondition` | texto | estado necessário antes da requisição |
| `request` | objeto | `{method, path, body?, operator_token?}`; `operator_token: true` = enviar `Authorization: Bearer <token>`; com `body`, `Content-Type: application/json` |
| `expected_status` | inteiro | status HTTP |
| `expected_code` | texto | `error.code` do corpo |
| `thrown_at` | texto | `arquivo:linha` (relativo a `packages/`) do literal do código; formato com alternativas em "Convenção de linhas" |
| `via` | texto | salto relevante até a rota (abreviações `SM`, `PR`, `PA` como no `.md`) |
| `scenario` | texto | `reproduzivel` ou `complexo` |
| `verified` | booleano | executado no Hub em processo |
| `description` | texto | só em `complexo`: o estado que falta montar |

Casos `complexo` não têm `body` quando a requisição em si é trivial e o difícil é o estado.

## Contagens

- Rotas: 58. Com erro de domínio: 40. Sem nenhum erro de domínio alcançável: 18 (1, 2, 3, 4, 6,
  11, 21, 26, 27, 28, 32, 39, 42, 43, 44, 48, 50, 52).
- `route-errors.jsonl`: 147 casos, 114 pares (rota, código) distintos; 126 `reproduzivel`
  (120 `verified`; 6 não executados: `r22-08` `CYCLE_DETECTED`, `r22-09` `BUDGET_EXCEEDED`,
  `r22-10` `POLICY_DENIED`, `r37-09` `CONCURRENCY_EXCEEDED`, `r38-11` `CAPABILITY_UNRESOLVED`,
  `r55-07` `AGENT_CONFIG_INVALID`) e 21 `complexo`.
- Cobertura: todo par (rota, código) do `route-errors.md`, fora as linhas `n/a` (corrida, erro
  interno ou checagem que a borda faz antes; sem caso de propósito), tem caso próprio no JSONL ou,
  na coluna "Conf.", referência explícita a um caso de outra rota com o mesmo ponto de lançamento
  ("coberto pelos casos da rota N (mesmo ponto de lançamento: ...)"). As referências cruzadas
  ficam nas linhas da tabela L das rotas 22, 33, 37, 38 e 41, nos erros de `send` da rota 41 e no
  `ILLEGAL_STATE` de worktree das rotas 22 e 38. Linhas `n/a`: 10 (rotas 7, 8, 9, 10, 12, 13, 15,
  29, 41 e 45). Fora da regra fica só a linha "não determinado" da rota 41 (`SM:1261`, `#settle`):
  não é um par com código conhecido, e por isso não tem caso.
- Códigos que nenhuma rota lança: `AGENT_NOT_AUTHENTICATED`, `APPROVAL_REQUIRED`;
  `HUB_CONFIG_INVALID` só em caminho não alcançável na prática (`route-errors.md`).

## Lacunas e reprodução

- **Scripts de confirmação fora do repositório.** O hook de resolução e os scripts que montaram
  os Hubs ficaram no scratchpad da sessão do agente, que é temporário. Motivo: esta pasta é de
  dados para o corpus, e o ADR 7.10 veda trabalho novo em TS; um harness JS/TS versionado aqui
  seria código novo sem tarefa no plano. Se o coordenador quiser o harness versionado, é uma
  decisão a tomar fora da F4-14.
- **Como reproduzir sem os scripts.** Cada linha do JSONL é autossuficiente:
  1. numa chamada de shell só, defina `AGENTS_HUB_HOME` (pasta temporária),
     `AGENTS_HUB_PORT` (porta alta livre, nunca 4747) e `AGENTS_HUB_NO_AUTOSTART=1`;
  2. monte o Hub com `createHub({ home, manifestsDir, port: 0, webRoot }, { homeDir })`
     (`daemon/src/hub.ts:72`), com `homeDir` temporário e os cinco manifestos de "Ambiente";
     `hub.start()` devolve a porta real e `hub.operatorToken` o token;
  3. monte a `precondition` com as requisições que ela descreve, troque os placeholders pelos ids
     devolvidos e envie `request`: com `body`, `Content-Type: application/json`; com
     `operator_token`, `Authorization: Bearer <token>`;
  4. compare status e `error.code` com `expected_status` e `expected_code`;
  5. encerre com `hub.shutdown()` e cancele as runs vivas antes (`POST /sessions/:id/cancel`).
  Executar o TS a partir do `src` exige Node 24 com `--experimental-transform-types` e um hook
  que mapeie `packages/*/dist/*.js` para `packages/*/src/*.ts` e imports relativos `.js` para
  `.ts`; o `dist/` do clone pode estar defasado em relação ao `src`.
- **Casos `complexo`** dependem de estado que não montei de forma reproduzível (descrição em cada
  caso); o corpus precisa de injeção (adapter falso que falha) ou fica sem eles.
