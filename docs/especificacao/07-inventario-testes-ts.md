# 07 — Inventário da suíte de testes do TS

> Insumo para o critério de aceite da reescrita em C: o TS é especificação congelada e "seus
> testes definem o que o C precisa provar" ([ADR 07](../decisoes/07-reescrita-nativa.md), 7.10).
> Levantado em 2026-09-30 sobre a `main`, só por leitura: a suíte **não** foi executada, e a
> classificação veio dos imports, de palavras-chave (`createHub`, `hub.start()`, `fetch(`,
> `spawn`, `mock.timers`, `git`) e dos títulos de `test`/`describe`, sem leitura integral dos 191
> arquivos.

## 0. O que a suíte de fato roda

- `npm test` → `node scripts/run-tests.mjs`, que roda `node --test --experimental-sqlite` sobre os
  arquivos de `descobrirTestes()` (`scripts/run-tests.mjs:23-45`).
- `descobrirTestes()` pega todo `*.test.js` em `packages/*/dist` e `packages/*/dist-test`
  (`scripts/test-files.mjs:14-40`); se não achar nada, sai com código 1 (`run-tests.mjs:32-35`).
- Os sete pacotes Node compilam `src/**/*.ts` (testes incluídos) para `dist`. O web compila só
  `src/logic/**` e `src/lib/**` para `dist-test` (`packages/web/tsconfig.test.json`).
- O e2e **não** entra no `npm test` (precisa de navegador, `packages/web/playwright.config.ts:7`):
  roda com `npm run test:e2e`, `testDir: './e2e'`, `workers: 1`.

**Como foi contado:** `test(`, `it(`, `test.skip(`, `test.only(` e `test.todo(` no início da linha
são casos; `describe(` e `test.describe(` são describes; subtestes `await t.test(` vêm à parte.
Teste gerado em laço conta **uma vez** (kimi, gate-settings, opencode/permissions,
command-classifier, daemon-loopback, policy-merge, gate-composto, gate-daemon-loopback,
operator-auth, pretool-gate-mcp, project-path-raizes, route-ids, terminal-state, session-form,
e2e/estados, e2e/painel), então em execução o número é maior.

## 1. Totais

| Pacote | Arquivos | Casos `test`/`it` | `describe` | Subtestes `t.test` | Roda em |
|---|---:|---:|---:|---:|---|
| core | 20 | 230 | 51 | 0 | npm test |
| store | 5 | 42 | 14 | 0 | npm test |
| client | 3 | 18 | 4 | 0 | npm test |
| adapters | 22 | 205 | 29 | 30 | npm test |
| daemon | 82 | 506 | 124 | 0 | npm test |
| mcp | 5 | 41 | 9 | 0 | npm test |
| cli | 36 | 226 | 58 | 0 | npm test |
| web (lógica, dist-test) | 14 | 141 | 38 | 0 | npm test |
| **Subtotal npm test** | **187** | **1409** | **327** | **30** | |
| web e2e (Playwright) | 4 | 47 | 12 | 0 | test:e2e |
| **Total** | **191** | **1456** | **339** | **30** | |

## 2. Legenda

- **Categoria:** **DOM** unitário puro de domínio; **ADP** adapter/mapper; **DPI** integração com
  o daemon em processo (`createHub`) sem HTTP; **HTTP** daemon escutando (`hub.start()`) ou
  servidor falso com requisições reais; **STO** store sobre SQLite real; **CLI**; **WEB** lógica do
  painel; **E2E** navegador.
- **Portabilidade:** **DADOS** entrada→saída pura (dá corpus JSON); **DADOS+FS** igual, com pasta
  de fixture; **CENÁRIO** reimplementar em C (processo, tempo, rede, git, banco, concorrência);
  **MISTO**; **NÃO PORTAR** específico de Node ou substituído por ADR (seção 4).
- **SPEC:** 01 API, 02 banco, 03 CLI/MCP, 04 domínio/adapters, 05 painel; "sem SPEC" = nenhuma SPEC
  cobre o tema de forma dedicada.

## 3. Por arquivo

### core (`packages/core/src`)

| Arquivo | test | desc | Cat. | SPEC | Port. | Obs. |
|---|---:|---:|---|---|---|---|
| agent-env.test.ts | 11 | 2 | DOM | 04 A13 | DADOS | |
| brief.test.ts | 8 | 2 | DOM | 04 A4 | DADOS | |
| budget.test.ts | 17 | 1 | DOM | 04 A8 | DADOS | corpus = sequência de operações e estado esperado |
| command-classifier.test.ts | 21 | 5 | DOM | 04 A6/A7 | DADOS | casos em laço; usa `os.homedir` nos caminhos sensíveis |
| conversation.test.ts | 7 | 1 | DOM | sem SPEC (fora do 04) | DADOS | |
| daemon-loopback.test.ts | 10 | 2 | DOM | 04 A6, 01 §9 | DADOS | casos em laço |
| folders.test.ts | 11 | 2 | DOM | sem SPEC; 01 §6.3 parcial | DADOS | semântica de caminho win32/posix |
| graph.test.ts | 7 | 2 | DOM | 04 A9 | DADOS | |
| hub-env.test.ts | 3 | 1 | DOM | 03 §2.2 | DADOS | teto 2^31-1 vem do Node (seção 4) |
| policy-edit.test.ts | 6 | 2 | DOM | sem SPEC (fora do 04) | DADOS | |
| policy-merge.test.ts | 14 | 2 | DOM | 04 A5 | DADOS | casos em laço |
| policy-schema.test.ts | 6 | 1 | DOM | 04 A5 | DADOS | só aceita/recusa |
| policy.test.ts | 16 | 4 | DOM | 04 A5 | DADOS | |
| pricing.test.ts | 29 | 7 | DOM | 04 A12 + apêndice | DADOS | |
| resilience-cota.test.ts | 2 | 0 | DOM | 04 A10 | DADOS | |
| resilience.test.ts | 21 | 6 | DOM | 04 A10 | MISTO | classifyOutcome/nextStep DADOS; `sleep` usa `mock.timers` (:213) |
| resiliencia-grafo.test.ts | 8 | 3 | DOM | 04 A9/A10 | DADOS | |
| texto.test.ts | 3 | 1 | DOM | sem SPEC | NÃO PORTAR literalmente | semântica de JS (seção 4) |
| watch.test.ts | 10 | 4 | DOM | 04 A5/A6 | DADOS | |
| workflow.test.ts | 20 | 3 | DOM | 04 A11 | MISTO | validação DADOS; execução usa `setImmediate` (:141) |

### store (`packages/store/src`) — lista oficial da SPEC-02 (`02-banco-e-dados.md:611-614`)

| Arquivo | test | desc | Cat. | SPEC | Port. |
|---|---:|---:|---|---|---|
| backup.test.ts | 7 | 2 | STO | 02 §8 | CENÁRIO |
| db.test.ts | 4 | 2 | STO | 02 §1-2 | CENÁRIO |
| events-page.test.ts | 3 | 1 | STO | 02 §3.5 | CENÁRIO |
| integridade.test.ts | 9 | 3 | STO | 02 §3 | CENÁRIO |
| repositories.test.ts | 19 | 6 | STO | 02 §3-4, §7 | CENÁRIO |

### client (`packages/client/src`) — servidor HTTP falso

| Arquivo | test | desc | Cat. | SPEC | Port. |
|---|---:|---:|---|---|---|
| hub-client.test.ts | 11 | 1 | HTTP | 01 §8.4, 03 | CENÁRIO |
| ids.test.ts | 4 | 1 | HTTP | 01 §5 | CENÁRIO |
| operator-client.test.ts | 3 | 2 | HTTP | 01 §4, 02 §6.2 | CENÁRIO |

### adapters (`packages/adapters/src`)

| Arquivo | test | desc | Cat. | SPEC | Port. | Obs. |
|---|---:|---:|---|---|---|---|
| bin-resolver-lookup.test.ts | 6 (+13 sub) | 0 | ADP | 04 B5 | CENÁRIO | PATH, `which`, TTL; 2 só no Windows |
| bin-resolver.test.ts | 1 (+6 sub) | 0 | ADP | 04 B5 | DADOS | quoteForShell |
| discovery/discovery.test.ts | 27 | 12 | ADP | sem SPEC (fora do 04); 01 §6.1 | DADOS+FS | |
| failure-reason.test.ts | 7 | 0 | ADP | 04 B7 | DADOS | |
| gate-settings.test.ts | 2 | 0 | ADP | 04 B10 | DADOS | casos em laço |
| guarded-actions.test.ts | 23 | 0 | ADP | 04 B | DADOS | |
| line-reader.test.ts | 4 | 2 | ADP | 04 B4 | MISTO | linhas DADOS; AsyncQueue não se porta |
| manifest-model.test.ts | 7 | 0 | ADP | 04 B2 | DADOS | argv efetivo de cada manifesto |
| mappers/antigravity.test.ts | 8 | 1 | ADP | 04 B7 | DADOS | |
| mappers/claude.test.ts | 3 | 0 | ADP | 04 B7 | DADOS | |
| mappers/copilot.test.ts | 16 | 2 | ADP | 04 B7 | DADOS | |
| mappers/generic.test.ts | 8 | 2 | ADP | 04 B7 | DADOS | |
| mappers/kimi.test.ts | 11 | 2 | ADP | 04 B7 | DADOS | casos em laço |
| mappers/turn-cost.test.ts | 8 | 1 | ADP | 04 B7/A12 | DADOS | |
| opencode/adapter.test.ts | 2 | 0 | ADP | 04 B8 | CENÁRIO | spawn e servidor HTTP |
| opencode/events.test.ts | 23 | 4 | ADP | 04 B8 | DADOS | |
| opencode/permissions.test.ts | 9 | 3 | ADP | 04 B8 | MISTO | config DADOS; servidor CENÁRIO |
| process-adapter.backpressure.test.ts | 5 | 0 | ADP | 04 B4 | CENÁRIO | |
| process-adapter.overall-timeout.test.ts | 2 | 0 | ADP | 04 B4 | CENÁRIO | tempo |
| process-adapter.test.ts | 1 | 0 | ADP | 04 B4/B5 | CENÁRIO | |
| process-tree.test.ts | 22 | 0 | ADP | 04 B6 | CENÁRIO | 1 só em POSIX |
| prompt-delivery.test.ts | 10 (+11 sub) | 0 | ADP | 04 B5 | MISTO | contrato de argv DADOS; shims .cmd CENÁRIO; 5 só no Windows |

### daemon (`packages/daemon/src`)

| Arquivo | test | desc | Cat. | SPEC | Port. |
|---|---:|---:|---|---|---|
| absorption-http.test.ts | 5 | 1 | HTTP | 01 §6.1 | CENÁRIO |
| absorption.test.ts | 25 | 4 | DOM | 01 §6.1 | DADOS+FS (cache depende de tempo) |
| adopted-leases.test.ts | 3 | 1 | HTTP | 01, 03 §2.4 | CENÁRIO |
| agent-error-text.test.ts | 4 | 2 | DPI | 04 B7 | MISTO |
| agents-model.test.ts | 1 | 1 | HTTP | 01 §6.1 | CENÁRIO |
| api-tasks.test.ts | 3 | 1 | DOM | 01 §6.2 | DADOS |
| artifact-capture.test.ts | 3 | 1 | DOM+git | sem SPEC | CENÁRIO |
| budget-warning.test.ts | 3 | 1 | DPI | 04 A8 | CENÁRIO |
| codex-gate.integration.test.ts | 3 | 1 | DPI | 04 B10 | CENÁRIO |
| codex-gate.test.ts | 9 | 1 | DOM | 04 B10 | DADOS |
| codigos-http.test.ts | 5 | 1 | HTTP (socket cru) | 01 §2-3 | CENÁRIO |
| concorrencia-fechamento.integration.test.ts | 3 | 3 | DPI | sem SPEC | CENÁRIO |
| config.test.ts | 14 | 3 | DOM+FS | 02 §6.1 | MISTO (mensagem do V8, seção 4) |
| context-tail.test.ts | 1 | 1 | DPI | 03 | CENÁRIO |
| custo-turno-parada.integration.test.ts | 7 | 1 | DPI | 04 A12 | CENÁRIO |
| delegation-depth.integration.test.ts | 5 | 1 | DPI | 04 A9 | CENÁRIO |
| diff-baseline.test.ts | 3 | 1 | DOM+git | sem SPEC | CENÁRIO |
| effective-policy.test.ts | 7 | 2 | DOM+FS | 04 A5 | DADOS+FS |
| env.test.ts | 5 | 1 | DOM | 03 §1.7 | DADOS |
| espaco-do-banco.test.ts | 2 | 1 | DPI | 02 §7 | CENÁRIO |
| event-flood-http.test.ts | 2 | 1 | HTTP | 01 §8, 02 | CENÁRIO |
| event-limits.test.ts | 5 | 1 | DOM | 02/01 | DADOS |
| event-retention.test.ts | 8 | 3 | DPI (store e timer) | 02 §7 | CENÁRIO |
| events-page-http.test.ts | 3 | 1 | HTTP | 01 §6.4 | CENÁRIO |
| gate-bloqueante.test.ts | 8 | 1 | HTTP | 01 §9 | CENÁRIO |
| gate-composto.test.ts | 2 | 1 | HTTP | 01 §9, 04 A6 | CENÁRIO |
| gate-daemon-loopback.test.ts | 3 | 1 | HTTP | 01 §9 | CENÁRIO |
| gate-leitura.test.ts | 1 | 1 | HTTP | 01 §9 | CENÁRIO |
| gate-por-sessao.test.ts | 3 | 1 | HTTP | 01 §9, 04 B10 | CENÁRIO |
| guard.test.ts | 18 | 2 | DOM (req falsa) | 01 §3 | DADOS (cabeçalhos → decisão) |
| handoff-concorrencia.test.ts | 1 | 1 | DPI | sem SPEC | CENÁRIO |
| handoff-pausada.test.ts | 1 | 1 | DPI | sem SPEC | CENÁRIO |
| handoff.test.ts | 1 | 1 | DPI | sem SPEC | CENÁRIO |
| http-hardening.test.ts | 11 | 1 | HTTP (cru) | 01 §3, §5 | CENÁRIO |
| http-schemas.test.ts | 13 | 3 | DOM | 01 §6.9 | DADOS |
| hub-shutdown.test.ts | 2 | 1 | HTTP | 01 §1 | CENÁRIO |
| integrations.test.ts | 14 | 3 | MISTO | 01 §6.8 | MISTO (line-diff DADOS) |
| interrupt.test.ts | 2 | 1 | DPI | 01 §6.4 | CENÁRIO |
| maintenance-routes.test.ts | 4 | 1 | HTTP | 01 §6.6 | CENÁRIO |
| mcp-config.test.ts | 14 | 3 | DOM+FS | 03 §1.9 | DADOS+FS |
| operation-routes.test.ts | 8 | 4 | HTTP | 01 §6.8 | CENÁRIO |
| operator-auth.test.ts | 8 | 1 | HTTP | 01 §4 | CENÁRIO (casos em laço) |
| operator-routes-table.test.ts | 5 | 1 | HTTP | 01 §4, §6 | CENÁRIO |
| orquestracao.integration.test.ts | 12 | 1 | HTTP | sem SPEC dedicada | CENÁRIO |
| policy-audit.test.ts | 10 | 1 | HTTP | 01 §6.7 | CENÁRIO |
| porta-zero.test.ts | 3 | 1 | HTTP | 01 §1 | CENÁRIO |
| pretool-gate-mcp.test.ts | 3 | 1 | DOM | 01 §9 | DADOS |
| pretool-gate.test.ts | 27 | 8 | DOM | 01 §9, 04 A6 | DADOS |
| project-canonical.test.ts | 4 | 1 | DPI | 01 §6.3 | CENÁRIO (3 só no Windows) |
| project-config.test.ts | 21 | 2 | DOM+FS | 04 A5, 01 | DADOS+FS |
| project-context.test.ts | 9 | 1 | DOM+FS | 04 | DADOS+FS |
| project-path-raizes.test.ts | 7 | 2 | MISTO | 01 §6.3 | MISTO (caminho puro DADOS; resto HTTP) |
| project-registry.test.ts | 7 | 1 | DOM+git | 01 §6.3 | CENÁRIO |
| project-trust.test.ts | 3 | 1 | DPI | 01, 04 | CENÁRIO |
| projects.test.ts | 6 | 1 | DPI | 01 §6.3 | CENÁRIO |
| promessas-soltas.test.ts | 5 | 2 | DOM (fakes) | sem SPEC | NÃO PORTAR (parcial, seção 4) |
| reaper-preserva.test.ts | 4 | 1 | git | 01 §6.6 | CENÁRIO |
| reaper.test.ts | 4 | 2 | timer + FS | 01 §6.6 | CENÁRIO |
| reconcile.test.ts | 10 | 2 | DPI + spawn | sem SPEC | CENÁRIO |
| repo-trust.test.ts | 7 | 1 | HTTP | 01, 04 | CENÁRIO |
| resilience.integration.test.ts | 3 | 1 | DPI | 04 A10 | CENÁRIO |
| retomada-sem-conversa.integration.test.ts | 2 | 1 | DPI | sem SPEC | CENÁRIO |
| review.test.ts | 8 | 1 | DOM | 04 | DADOS |
| revisao-e-diff.integration.test.ts | 3 | 1 | DPI | sem SPEC | CENÁRIO |
| route-ids.test.ts | 4 | 1 | HTTP (cru) | 01 §5 | CENÁRIO (casos em laço) |
| safe-write.test.ts | 4 | 1 | FS | sem SPEC | CENÁRIO |
| server.test.ts | 3 | 1 | DOM | 01 §2 | DADOS (statusFor) |
| session-lifecycle.integration.test.ts | 16 | 5 | HTTP | 01 §6.4, 04 A3 | CENÁRIO |
| session-manager-audit.test.ts | 6 | 4 | DPI | sem SPEC | CENÁRIO (concorrência) |
| sse-http.test.ts | 4 | 1 | HTTP | 01 §8 | CENÁRIO |
| sse-task-http.test.ts | 7 | 1 | HTTP | 01 §8.3 | CENÁRIO |
| sse.test.ts | 15 | 3 | DOM (res falsa) | 01 §8 | CENÁRIO (+ partes de Node) |
| terminal-state.test.ts | 5 | 1 | DPI | 04 A3 | CENÁRIO (casos em laço) |
| teste-real-rodada1.test.ts | 3 | 1 | DPI | 04 A10/B7 | CENÁRIO |
| turn-cost.integration.test.ts | 2 | 1 | DPI | 04 A12 | CENÁRIO |
| user-message.test.ts | 1 | 1 | DPI | sem SPEC | CENÁRIO |
| validation.test.ts | 3 | 0 | spawn | 04 | CENÁRIO |
| vigilancia-gate.test.ts | 2 | 1 | DPI + git | 01 §9, 04 A5 | CENÁRIO |
| workflow-runs.test.ts | 13 | 2 | MISTO | 01 §6.8, 04 A11 | MISTO (validação DADOS; runner CENÁRIO) |
| worktree-links.test.ts | 6 | 1 | git | sem SPEC | CENÁRIO |
| worktree-nome.test.ts | 3 | 1 | DOM | sem SPEC | DADOS |
| worktree.test.ts | 3 | 1 | git | sem SPEC | CENÁRIO |

### mcp (`packages/mcp/src`) — SPEC-03 parte 2

| Arquivo | test | desc | Cat. | Port. | Obs. |
|---|---:|---:|---|---|---|
| caller-wait.test.ts | 6 | 3 | HTTP falso + SDK MCP em memória | CENÁRIO | `mock.timers` (:99) |
| format.test.ts | 6 | 2 | DOM | DADOS | |
| main-env.test.ts | 3 | 1 | processo (spawn) | CENÁRIO | |
| main-heartbeat.test.ts | 2 | 1 | processo (spawn) | CENÁRIO | |
| server.test.ts | 24 | 2 | HTTP (daemon real) + SDK em memória | CENÁRIO | as 16 tools |

### cli (`packages/cli/src`) — SPEC-03 parte 1 ("daemon" = daemon real isolado via `test-kit.ts`/`hub-de-teste.ts`)

| Arquivo | test | desc | Port. | Obs. |
|---|---:|---:|---|---|
| args-ajuda-erro.test.ts | 9 | 3 | DADOS | §1.1-1.3 |
| autostart-cmd.test.ts | 5 | 1 | MISTO | `.vbs`, flags do Node (seção 4) |
| backup-cmd.test.ts | 2 | 1 | CENÁRIO | daemon e `node:sqlite` |
| bin.test.ts | 12 | 1 | CENÁRIO | spawn de `bin.js`; partes de Node |
| continue-from.test.ts | 7 | 2 | CENÁRIO | daemon |
| cost-cmd.test.ts | 4 | 1 | CENÁRIO | daemon com dados semeados |
| daemon-control.test.ts | 2 | 1 | CENÁRIO | fakes; §1.6 |
| daemon-run.test.ts | 5 | 2 | CENÁRIO | porta ocupada |
| discover-cmd.test.ts | 12 | 4 | CENÁRIO | daemon |
| doctor-cmd.test.ts | 12 | 4 | CENÁRIO | |
| doctor-smoke.test.ts | 4 | 1 | CENÁRIO | HTTP falso |
| export-cmd.test.ts | 4 | 1 | CENÁRIO | daemon |
| gate-aviso.test.ts | 9 | 2 | CENÁRIO | daemon |
| hook.test.ts | 23 | 6 | CENÁRIO | §1.5 e 01 §9; servidor falso |
| hooks-install.test.ts | 11 | 2 | MISTO | merge DADOS; spawn; `process.execPath` |
| hora.test.ts | 5 | 1 | DADOS | o caso de `:40` depende do fuso da máquina |
| init-cmd.test.ts | 4 | 1 | CENÁRIO | daemon e git |
| install-write.test.ts | 6 | 3 | MISTO (DADOS+FS) | §1.9; spawn com `--experimental-sqlite` |
| json-cmd.test.ts | 6 | 1 | CENÁRIO | §1.4 |
| logs-cmd.test.ts | 3 | 1 | CENÁRIO | `--follow` |
| mcp-registro.test.ts | 5 | 1 | DADOS+FS | |
| merge-cmd.test.ts | 9 | 2 | CENÁRIO | git e HTTP |
| node-runtime.test.ts | 10 | 4 | NÃO PORTAR | seção 4 |
| open-cmd.test.ts | 3 | 1 | DADOS | abridor injetado |
| pause-cmd.test.ts | 5 | 1 | CENÁRIO | daemon |
| policy-cmd.test.ts | 4 | 1 | DADOS | |
| project-env-cmd.test.ts | 5 | 1 | CENÁRIO | substituído em parte pelo ADR 7.16 |
| project-resolve.test.ts | 5 | 1 | CENÁRIO | 1 só no Windows |
| render-ruido.test.ts | 3 | 0 | DADOS | |
| render-tokens.test.ts | 3 | 1 | DADOS | |
| restart-cmd.test.ts | 4 | 1 | CENÁRIO | |
| session-follow.test.ts | 5 | 1 | CENÁRIO | |
| start-cmd.test.ts | 7 | 1 | CENÁRIO | caso container cai pelo ADR 7.17 |
| update-cmd.test.ts | 4 | 1 | NÃO PORTAR | ADR 7.13; 2 `t.skip` condicionais |
| version-cmd.test.ts | 3 | 1 | CENÁRIO | informa a versão do Node |
| workflow-cmd.test.ts | 6 | 1 | CENÁRIO | daemon |

### web — lógica (`packages/web/src`), SPEC-05

| Arquivo | test | desc | Port. |
|---|---:|---:|---|
| lib/approvalNotice.test.ts | 3 | 1 | DADOS |
| lib/eventHistory.test.ts | 11 | 2 | CENÁRIO com relógio falso (`fakeClock`) |
| lib/panelLogic.test.ts | 18 | 6 | DADOS |
| lib/panelStates.test.ts | 12 | 4 | DADOS |
| lib/refetchScheduler.test.ts | 5 | 1 | CENÁRIO com relógio falso |
| lib/telemetry.test.ts | 7 | 1 | DADOS |
| lib/tokens.test.ts | 4 | 1 | DADOS |
| logic/api-routes.test.ts | 4 | 1 | NÃO PORTAR (proxy do Vite) |
| logic/operacao.test.ts | 16 | 6 | DADOS |
| logic/project-path.test.ts | 4 | 1 | DADOS |
| logic/project-registration.test.ts | 4 | 1 | DADOS |
| logic/security.test.ts | 26 | 8 | DADOS |
| logic/session-form.test.ts | 8 | 1 | DADOS (casos em laço) |
| logic/settings-form.test.ts | 19 | 4 | DADOS |

### web — e2e (`packages/web/e2e`), contra servidor falso (`servidor-falso.ts`)

| Arquivo | test | desc | Port. |
|---|---:|---:|---|
| estados.spec.ts | 18 | 4 | não portável como está; referência para os testes da UI nativa |
| operacao.spec.ts | 4 | 1 | idem |
| painel.spec.ts | 18 | 3 | idem |
| reaberturas.spec.ts | 7 | 4 | idem |

## 4. Específico de Node/JS ou substituído por ADR

### 4.A Específico do runtime (portar só a intenção)

| Onde | O que | Proposta para o C |
|---|---|---|
| `daemon/src/config.test.ts:117-124`, `config.ts:259-263` | extrai `position N` da mensagem do `JSON.parse` do V8 | manter só `arquivo:linha:coluna`; o motivo será outro texto |
| `daemon/src/workflow-runs.test.ts:44-46`, `core/src/workflow.ts:50`, `daemon/src/config.ts:283` | caminho do erro no formato do zod (`steps.0.objective`) | **decidir**: o formato aparece na API de validação de workflow |
| `core/src/policy-schema.test.ts:54` | `error.issues` do zod na mensagem de diagnóstico | nada a portar |
| `daemon/src/http-schemas.test.ts` | só `safeParse().success` | portar aceita/recusa, não as mensagens do zod |
| `core/src/resilience.test.ts:213`, `mcp/src/caller-wait.test.ts:99`, `daemon/src/sse.test.ts` | `t.mock.timers` | relógio injetável no C |
| `adapters/src/line-reader.test.ts:58-65`; `setImmediate` em `core/src/resilience.test.ts:218`, `core/src/workflow.test.ts:141`, `cli/src/merge-cmd.test.ts:8` | AsyncQueue cede o event loop; esperas por microtarefa | não reproduzir |
| `daemon/src/sse.test.ts` (backpressure) | `res.write()` → false e evento `drain` | portar o limite (fila acima do teto fecha a conexão), não a API de streams |
| `daemon/src/promessas-soltas.test.ts:21-31` | `process.on('unhandledRejection')` | portar só "falha no desligamento sai com código 1" |
| `cli/src/node-runtime.test.ts` | versão do Node, `--experimental-sqlite`, `ExperimentalWarning`, `execArgv` | não portar (ADR 7.1) |
| `cli/src/bin.test.ts:57-61`, `:169` | ausência de `ExperimentalWarning`; hook não carrega `node:sqlite` | equivalente no C: o hook não abre o banco |
| `cli/src/hooks-install.test.ts:111` (e `cli/src/install-write.test.ts:48`, que executa a CLI com `--experimental-sqlite`) | comando do hook começa com `"${process.execPath}"`; o teste roda com flags do Node | no C, aponta para o executável do Hub |
| `core/src/hub-env.ts:43-50`, `hub-env.test.ts:25` | teto 2^31-1 do `setInterval` | redefinir no C |
| `core/src/texto.test.ts` | `"[object Object]"`, `String()`, referência circular | semântica de JS |
| `web/src/logic/api-routes.test.ts` | proxy do Vite | não existe no C |
| `cli/src/restart-cmd.test.ts:102`, `mcp/src/caller-wait.test.ts:76`, `cli/src/daemon-control.test.ts:31`, `cli/src/daemon-run.test.ts:86` | erros com texto do Node (`fetch failed`, `ECONNREFUSED`, `EADDRINUSE`) | mapear erros nativos; não copiar o texto |
| `adapters/src/prompt-delivery.test.ts:187` e seguintes | shims `.cmd` do npm | **continua relevante**: os CLIs de agente são instalados via npm |

### 4.B Substituído por ADR (decisão do dono antes de portar)

| Onde | Comportamento do TS | ADR |
|---|---|---|
| `cli/src/start-cmd.test.ts:57-59` | `--isolation container` responde "ainda não está implementado" | 7.17 |
| `cli/src/update-cmd.test.ts` | `hub update` só mostra passos manuais | 7.13 |
| `cli/src/project-env-cmd.test.ts` | grava o valor real no banco | 7.16 |
| `cli/src/autostart-cmd.test.ts` | `.vbs` na pasta Inicializar com flags do Node | 7.5, 7.12, ADR 08 |
| `cli/src/version-cmd.test.ts` | `--json` informa a versão do Node | 7.1 |

## 5. Testes pulados

Nenhum `test.skip`, `.todo`, `.only` ou `fixme` fixo. Todos os pulos dependem da plataforma ou do
ambiente:

| Onde | Condição | Motivo |
|---|---|---|
| `adapters/src/bin-resolver-lookup.test.ts:308`, `:328` | `skip: !ehWindows` | caminho acentuado no PATH; registry |
| `adapters/src/process-tree.test.ts:141` | pula no win32 | kill de grupo é POSIX |
| `adapters/src/prompt-delivery.test.ts:187`, `:369`, `:383`, `:395`, `:409` | `skip: platform !== 'win32'` | shims `.cmd` e escape do cmd.exe |
| `cli/src/project-resolve.test.ts:35` | só win32 | caixa do caminho |
| `cli/src/update-cmd.test.ts:87` | `t.skip` fora do win32 | prefixo global do npm no Windows |
| `cli/src/update-cmd.test.ts:108` | `t.skip` se o tmp estiver num repo git | ambiente |
| `daemon/src/project-canonical.test.ts:63`, `:76`, `:91` | `skip: !win` | caixa e nome 8.3 |
| `daemon/src/project-canonical.test.ts:80` | `t.skip` | volume sem nomes 8.3 |

Como o ADR 7.2 vale para Windows e Linux, cada pulo precisa de equivalente no C rodando nos dois
SOs da CI.

## 6. Lacunas

- **Não há SPEC dedicada à orquestração interna do daemon** (session manager, worktree, reaper,
  reconcile, handoff, retenção). Na tabela do daemon, 17 arquivos aparecem como "sem SPEC" (ou
  "sem SPEC dedicada").
- A SPEC-04 deixa fora do escopo conversation, folders, policy-edit, hub-env e
  `adapters/src/discovery/*` (`04-dominio-e-adapters.md:1545-1550`). Desses, só hub-env tem
  cobertura em outra SPEC (03 §2.2, `AGENTS_HUB_MCP_HEARTBEAT_MS`); os demais não têm SPEC.
- A suíte web só vale para o C se a UI nativa mantiver a mesma lógica (ADR 7.3); o e2e exige
  navegador.
- Totais por categoria e portabilidade não foram somados; o número de casos em execução não foi
  verificado.
