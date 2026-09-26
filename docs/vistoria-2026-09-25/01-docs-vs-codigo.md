# 01 — Docs vs código (vistoria somente-leitura)

Escopo: docs/00, 01, 02, 03, 04, 05, 07, 08 e README.md, conferidos contra o HEAD `6e2730e`.
Método: leitura do código + execução. Reproduzido contra daemon isolado (porta 47611, home temporária, encerrado e apagado no fim), `node scripts/run-tests.mjs` (517 testes, 0 falhas) e `node scripts/demo-e2e.mjs` (18/18 PASS). Nada foi editado, buildado ou commitado; o daemon do usuário (4747) não foi tocado.

Convenção: "LIDO" = só leitura de código; "REPRODUZIDO" = executado.

---

## Parte A — Achados (afirmações que o código contradiz, ou defeitos que os docs escondem)

### [ALTO] O gate pré-execução bloqueia quase todo comando fora da allow list e o README diz o contrário
**Evidência (REPRODUZIDO).** Daemon isolado, sessão `claude` adotada (modo `semi`, política padrão), `POST /hooks/pretooluse` com `toolName: Bash`:
```
"ls -la" / "cat package.json" / "grep -r foo ."   -> allow/exec
"curl https://example.com"  "docker ps"  "make build"  "npm install left-pad"
"pip install requests"  "cargo build"  "mkdir foo"  "git fetch"  "npx vitest run"  "rm foo.txt"
                                                    -> BLOQUEIA (a chamada fica pendurada aguardando humano)
```
Causa: `DEFAULT_POLICY.risk.escalate = 'approve'` (`packages/core/src/policy.ts:329`) e `PolicyEngine.classify` devolve `escalate` para qualquer comando fora da lista (`policy.ts:504`). O gate (`session-manager.ts:gateToolCall`, ~l.756-778) transforma `approve` em espera bloqueante de 60 s por decisão humana.
Docs em contradição: `README.md:184` ("Por padrão só o irreversível ... interrompe; sair da allow list vira alerta na timeline. Um controle que congela a sessão a cada comando legítimo é desligado na primeira hora"); `docs/04-resiliencia-e-politica.md` tabela de risco (`escalate` -> "alertar") e §"Por que o padrão não para em `escalate`". Quem descreve certo é o `SECURITY.md:62-72`, que admite que nos 2 agentes com gate o `escalate` "é impedido de verdade". Ou seja, a promessa de "não congelar" vale só para a vigilância reativa (`watch.pauseOn`), não para o gate, que usa `risk.escalate`.
**Impacto.** Com o hook instalado, um Claude Code/Codex rodando `mkdir`, `make`, `cargo build`, `npx vitest`, `git fetch` para em cada chamada e espera o usuário. O agente não segue sem `hub approve`; é exatamente o cenário que o README diz ter evitado e que leva à desinstalação do hook.
**Correção sugerida.** (1) Decidir a política: ou o gate trata `escalate` como `flag` (allow + evento, `risk.escalate: allow` para o gate, mantendo `approve` só para `irreversible`/`budget`), ou o README/doc 04 passam a dizer o que acontece. (2) Ampliar a allow list padrão (`make`, `cargo build`, `mkdir`, `git fetch`, `npx vitest`, `docker ps` etc.) ou tornar o critério por token, não prefixo. (3) Corrigir README:184 e doc 04 no mesmo commit.
**Esforço.** P (decisão + 1 linha de política + docs); M se refizer a allow list por token.

### [ALTO] Gate: o hook instalado desiste em 10 s, mas o daemon espera 60 s — a "prevenção" pode falhar aberta justamente quando pede aprovação
**Evidência.** `packages/cli/src/hooks-install.ts:98` grava `timeout: 10` para o hook do Claude (Codex: `TIMEOUT_PADRAO_SEC = 20`, `codex-gate.ts:104`). `session-manager.ts:170-183` (`ESPERA_PADRAO_DO_GATE_MS = 60_000`) justifica os 60 s com "60s é o timeout padrão de hook do Claude Code" — mas o Hub instala 10. LIDO; não testei o comportamento do binário do Claude ao estourar o timeout do hook (a documentação pública o trata como erro não bloqueante, não confirmei aqui).
**Impacto.** O humano tem 10 s (Claude) / 20 s (Codex) para aprovar, não 60. Se o agente tratar timeout de hook como "seguir", a ação irreversível pedida para aprovação roda sem decisão — o oposto do que docs 04/README/SECURITY prometem. Nenhum teste cobre isso (ver achado seguinte).
**Correção sugerida.** Alinhar: instalar o hook com `timeout` >= `gateWaitMs/1000 + margem` (ex. 70) e/ou reduzir `gateWaitMs` para < timeout do hook; exercitar contra o Claude real (esperar >10 s num `git push`) e registrar o resultado no doc 04.
**Esforço.** P.

### [ALTO] Fluxo bloqueante do gate nunca foi testado e tem três defeitos reproduzidos/lidos
`gateToolCall` foi tornado bloqueante (poll de `approvals`), mas **nenhum teste referencia `gateToolCall`, `gateWaitMs` ou `/hooks/pretooluse`** (grep em `packages/*/src/*.test.ts`: zero); `pretool-gate.test.ts` cobre só funções puras. O roadmap marca o gate `[x]` (l.202, 206). Defeitos encontrados rodando o caminho:

1. **Timeout do gate mata a sessão (REPRODUZIDO).** Sessão adotada, `git push origin main`, ninguém responde: após 60,3 s a resposta foi `permission: deny` e a sessão terminou `state: "killed"`. Causa: `#aguardarDecisao` chama `resolveApproval(id,'denied','tempo esgotado')` (`session-manager.ts:834`), e `resolveApproval` com `denied` faz `cancel(session)` (l.932-935). Mas a mensagem escrita para o agente em caso de timeout diz "Siga com o resto da tarefa" (l.797-801).
2. **A explicação específica (timeout / negado por humano / liberado por humano) é descartada (REPRODUZIDO).** `server.ts:646-651` responde `explanation: explainToAgent(verdict, ...)` e ignora `verdict.explanation`. Resposta observada no timeout: `"...A política do projeto proíbe esta ação. Não tente contornar..."` — texto errado e oposto ao pretendido ("não por proibição"). Doc 04 promete "a mensagem devolvida diz explicitamente para não contornar" só para `escalate`; o caminho novo deu outra semântica sem atualizar o doc.
3. **`hub approve` de uma aprovação do gate falha depois de liberar (REPRODUZIDO em sessão adotada: HTTP 404 `TASK_NOT_FOUND`; LIDO para sessão real).** O gate lê `state='approved'` e devolve `allow` (a ferramenta roda, confirmado: `gate result ... "permission":"allow"`), mas `resolveApproval` cai no ramo genérico "vigilância" e chama `send(session, "A ação ... foi aprovada. Continue de onde parou.")` (l.1002-1008). Para os manifestos reais (`interactive: false` em todos os 9) com run viva, `send` lança `ILLEGAL_STATE` "turno que não aceita mensagem ao vivo" (l.1075-1079); para o OpenCode (live send) injetaria uma mensagem espúria no turno. Quem aprova vê erro mesmo com a ação já liberada.
**Impacto.** O modo mais forte de controle tem UX incorreta e nenhuma rede de teste; doc 04 ("Níveis de risco", "Fila de aprovações") descreve o comportamento pré-bloqueio (`approve` -> `escalate`; hoje `toHookPermission` nunca recebe `approve` do gate).
**Correção sugerida.** (a) Em `resolveApproval`, ramo `detail.kind === 'tool-call'`: não chamar `send`, não cancelar em `denied` por tempo (apenas fechar a aprovação e devolver a sessão a `running`); (b) `server.ts` devolver `verdict.explanation ?? explainToAgent(...)`; (c) testes de integração com agente falso: aprovado, negado, timeout (`gateWaitMs` é público justamente para isso); (d) atualizar doc 04.
**Esforço.** M.

### [ALTO] Política de comando por prefixo: `cat`/`ls`/`node`/`python` liberam qualquer coisa; README/SECURITY prometem `.ssh`/`.env` parados
**Evidência (REPRODUZIDO, gate).**
```
Bash: echo x > .env                                    -> allow/exec
Bash: cat foo | tee ~/.ssh/authorized_keys             -> allow/exec
Bash: cat ~/.ssh/id_rsa                                -> allow/exec
Bash: node -e "require('fs').writeFileSync('.env','x')" -> allow/exec
Write {file_path:'.env'}                               -> BLOQUEIA (correto)
```
Causa: `policy.ts:501` `commands.allow.find(a => cmd.startsWith(a))` (allow inclui `cat`, `ls`, `node`, `python`, `npm run`, `rg`...) sem separar `|`, `>`, `&&`, `;` nem checar `denyFragments` em comandos. `denyFragments` só é aplicado a `file.write` (l.480-485).
Docs: `README.md:155` ("caminhos sensíveis (.ssh, .env) param a sessão"); `docs/01 §7` ("escrita fora dele é escalate; allowlist declarativa por agente"). SECURITY.md não menciona a limitação (grep por pipe/redirect/composto: zero).
**Impacto.** Um agente (ou prompt injection) contorna o "gate" com shell comum; a garantia documentada não vale para `Bash`. Isto é o vetor mais óbvio para quem ler o README como promessa.
**Correção sugerida.** Tokenizar o comando (dividir por `; && || | \n` e redirecionamentos), exigir que TODOS os segmentos casem a allow list por token (não prefixo), aplicar `denyFragments` a qualquer argumento/alvo de redirecionamento, remover `node`/`python` da allow (executam código arbitrário) ou classificar `-e/-c` como `escalate`. Enquanto isso, documentar em SECURITY.md como limitação conhecida.
**Esforço.** M.

### [MÉDIO] Autostart do daemon sobe sem `--experimental-sqlite` (doc 08 §3.7 #11 nunca foi corrigido nem entrou no roadmap)
**Evidência (LIDO).** `packages/cli/src/daemon-control.ts:67` `spawn(process.execPath, [entrada,'daemon'], ...)` sem flag; `package.json` `engines: ">=22.5.0"`; o `grep` da flag só acha `package.json:18` (script), `run-tests.mjs`, `demo-e2e.mjs`. O CI roda Node 22.5 mas a suíte adiciona a flag, então o caminho de produção (autostart) em 22.5–22.12 nunca é exercitado. Não reproduzi (esta máquina: Node 24.14).
**Impacto.** README "Começando" (`hub status` sobe o daemon sozinho) morre no boot em Node 22.5–22.12; `docs/08` #11 segue "verificado, não corrigido" e o roadmap "Restante" (l.753+) não o lista como feito nem aberto.
**Correção sugerida.** Passar `--experimental-sqlite` no spawn do autostart (inofensivo em Node novo) ou subir `engines` para o primeiro Node sem a flag; ou detectar e emitir mensagem clara.
**Esforço.** P.

### [MÉDIO] Documentação "fonte de verdade" (doc 07) está defasada em pontos centrais e o roadmap manda confiar nele
`02-roadmap.md:7-13` diz "onde os dois discordarem, o 07 é a fonte". Mas `07-progresso-real.md` (data 2026-08-28) ainda afirma, sem marca de "corrigido":
- §2.2 "o gate emite uma aprovação que não existe" — já corrigido (`session-manager.ts:679-695` documenta a correção; REPRODUZIDO: `GET /approvals` mostra a aprovação do gate).
- §2.4 "o motor de workflows valida o DAG e depois o ignora" — o roadmap (l.294-310) diz corrigido (`runWorkflow` em `core/workflow.ts`); §7 ("três coisas para amanhã") ainda manda consertá-lo.
- §2.5 "modo de supervisão só é real para 2 dos 9" — roadmap l.344 diz 6 dos 7 restantes têm `modeArgs`.
- §2.7 "openclaude não está em `MCP_TARGETS`/`HOOK_TARGETS`/fallback" — hoje está nos três (`daemon/src/mcp-config.ts` tem `openclaude` `verified: true`; `hooks-install.ts:41`; `policy.ts:385-393`).
- §2.8/§3.3 "`pause` tem rota HTTP mas não tem comando na CLI" — existe `hub pause` e `hub_session_pause`.
- §1 "hub mcp cobre 8 dos 9", "MCP 11/12 tools", "196 testes/21 arquivos" e tabela §5 (`Fase 3 ~35%`, "gate instalado: 0") — todas defasadas.
Só os itens A2A, projeção de orçamento e `budget.warning` ganharam marca "**corrigido**".
**Impacto.** Quem seguir o "leia o 07 primeiro" recebe uma lista de problemas já resolvidos e perde os abertos (achados acima).
**Correção sugerida.** Marcar cada seção do 07 com `[CORRIGIDO em <commit>]`/`[ABERTO]` ou congelar o 07 como "foto de 2026-08-28" e retirar do roadmap a frase de "fonte". **Esforço.** P.

### [MÉDIO] Contagens de ferramentas MCP e de testes divergem entre README, docs e código
| Onde | Diz | Real (verificado) |
|---|---|---|
| README:106 | "11 ferramentas" | **16** (`grep` de `hub_*` em `packages/mcp/src/server.ts`: agent_call/cancel/events/list/status/wait, budget, context_fetch, graph, session_diff/handoff/interrupt/list/pause/send, workflow_run) |
| docs/03 §1 | "As 11 tools" (tabela com 11) | 16; faltam `hub_agent_wait` (citado só no roadmap), `hub_session_handoff`, `hub_session_pause`, `hub_session_interrupt`, `hub_session_diff`, `hub_workflow_run` |
| roadmap:64 | "hoje são 12" | 16 |
| README:216, CONTRIBUTING | "273 testes em 30 arquivos" | **517 testes, 111 suítes, 63 arquivos `*.test.ts`**, 0 falhas (REPRODUZIDO) |
| roadmap 278/632/738 | 380 / 410 / 432 testes | idem 517 |
**Correção sugerida.** Nunca escrever contagem literal em prosa; ou gerar por script (`npm test` já imprime) ou remover. **Esforço.** P.

### [MÉDIO] `docs/01-arquitetura.md` descreve uma arquitetura que não é a implementada
Fatos verificados (grep em `packages/*/src`):
- "Orchestrator", "CapabilityRegistry", "ResiliencePipeline", "ArtifactStore", "Logger", "A2A Server", "TUI" — **nenhum existe** como classe/módulo (o orquestrador é `SessionManager`; resiliência é `core/resilience.ts` + `session-manager.ts`; A2A foi removido; TUI `[ ]`; não há logger — só arquivo de log do autostart).
- §6: tool `hub_agent_stream` — **não existe** (a real é `hub_agent_events`); `hub_agent_call { agent, objective, budget }` cita nomes que não conferi um a um.
- §6 último parágrafo: "pelo A2A server, publica `/.well-known/agent-card.json`" — rota **removida** deliberadamente (`server.ts:245-252`); README também lista "A2A server (fase 3)" no diagrama (README:~137).
- §5 Manifesto: `stream.format: jsonl | text | sse` (schema só `jsonl|text`, `types.ts:76`); exemplo com `cost: from: "$.usage"` (o schema não tem `cost`; passa silenciosamente porque o Zod do manifesto não é `strict` — REPRODUZIDO: o exemplo do README valida; um campo desconhecido também valeria).
- §4 lista 19 tipos de evento; o código tem 21 (faltam `session.handoff`, `budget.warning`).
- §8 layout: diz que `daemon` contém "MCP server, A2A server"; MCP é o pacote `packages/mcp`, e faltam `client`, `web` (só mencionado como "fase 2").
- §2 diagrama: "Camada ADAPTERS ... cursor/copilot/..." ok, mas `openclaude` ausente na lista de manifestos.
**Impacto.** O doc de arquitetura (ponto de entrada de quem contribui) promete componentes inexistentes. **Correção sugerida.** Revisão única do 01 com o inventário real; marcar o que é intenção futura. **Esforço.** M.

### [MÉDIO] `docs/04` e `docs/03` com afirmações defasadas
- 04 §1 tabela "Cobertura hoje: Claude Code (PreToolUse)" e "implementado para o Claude Code" — Codex também tem gate (roadmap l.206, SECURITY.md:55, README:161-171). O doc 04 nem descreve o dialeto de resposta do Codex (`approve` -> `deny`), `CODEX_GATE_NOT_GUARANTEED` nem `codexGate.bypassHookTrust`.
- 04 "**`approve` do Hub vira `escalate`, nunca `deny`**" — hoje o gate bloqueia e devolve `allow` ou `deny` (nunca `escalate`, ver achado do gate); no Codex sempre `deny`.
- 04 §4 "cache invalidado por `mtime`" — agora `mtime`+`size` (roadmap l.1301-1323). Menor.
- 04 §5 comando de teste `node --test packages/core/dist/*.test.js packages/daemon/dist/*.test.js` — sem `--experimental-sqlite` (falha em Node 22.5–22.12) e não é o runner oficial (`npm test`).
- 03 §1 "Caminhos confirmados: Claude Code, Codex, Cursor. Os demais são palpite" — hoje claude, codex, cursor, opencode, copilot, antigravity, openclaude `verified: true`; só kimi e mimo `false` (`daemon/src/mcp-config.ts`). O caminho do Antigravity mudou (`~/.gemini/config/mcp_config.json`) e o OpenCode usa chave `mcp`.
- 03 §2 "Quatro coisas na tela" — o painel tem também Configurações, Telemetria, Swarm, DAG canvas, paleta de comandos, painel de descoberta (ver Parte C).
**Esforço.** P.

### [MÉDIO] O roadmap usa `[x]` em itens que violam o próprio critério de pronto (CONTRIBUTING linha 4: "exercido fora do teste")
Itens `[x]` cuja própria descrição admite não ter sido executada:
- **Handoff de sessão** (l.311): "nunca executado fora do teste unitário" -> pela legenda é 🕳️, não `[x]`. (Nem README nem doc 03 mencionam handoff.)
- **Auditoria Web UI, 3 rodadas** (l.1353-1517, 14 itens `[x]`): todos "verificação manual ... não executada nesta sessão"; `packages/web` não tem teste de componente.
- **CLI `hooksCommandSeguro`** (l.1552): "Não reproduzido contra falha de I/O real".
- **EPIPE no `stdin.write`** (l.828-844): "não foi possível reproduzir ... coberto por revisão de código".
- **Gate Claude Code** (l.202) e **Codex** (l.206): ver achados do gate — o caminho bloqueante (o que o item promete) não tem teste.
- **Painel de custos** (l.316): ainda `[~]` descrevendo defeitos que o próprio "Restante" (l.920) marca `[x]` — contradição interna.
**Correção sugerida.** Rebaixar para 🕳️/`[~]` ou registrar a execução real. **Esforço.** P.

### [BAIXO] Outras divergências pontuais
1. README:15 "Fases 1 e 2 rodando e validadas com agentes reais" e o texto de `Estado atual` — o próprio doc 07 §3.1 lista 6 de 9 agentes que o Hub nunca executou (cursor sem binário na máquina), e o roadmap Fase 4 mantém `hub doctor --smoke` como 🕳️. "validadas" é forte demais; deveria dizer "validadas com claude, codex, opencode".
2. README:~112 "cadeia `claude → codex → opencode`" — o padrão por capability é `['claude','codex','opencode','openclaude']`, e `planning: [claude, codex]`, `shell: [codex, opencode, openclaude]` (`policy.ts:384-392`).
3. README não lista pré-requisitos (Node >= 22.5, git, ao menos um CLI de agente); só aparecem em `package.json`/CI.
4. README "Quando um agente falha ... o substituto entra como irmão" ok, mas não avisa que o padrão de revisão cruzada/validação é desligado (`validation.command: null`, `review.enabled: false`, `policy.ts:402-406`) — quem seguir o README acha que há portão de validação por padrão.
5. doc 05 §2 (send em sessão encerrada) bate com `session-manager.ts:1083-1089`; os 7 achados existem no código (registerSession em l.416/1296/1519/1988, `#assertConcurrency` em l.2537-2567, preferência por sessão viva em l.871-874). Sem divergência, só nota: não há teste citado para "gate escolhe sessão viva".
6. doc 08 §3.7: 20 itens "verificados, não corrigidos". Roadmap "Restante" marca [x] 17; os que ficam sem registro de resolução: **#11** (acima), **#13** (race no handoff `#runs.delete` antes do novo `#launch`), **#18 parcial** ("83 blocos catch" segue `[ ]`), **#16** (variáveis: coberto por doc 09). O doc 08 em si não foi atualizado ("Entram como Fase 5").
7. roadmap l.198/l.343: "Mapper dedicado do Antigravity `[x]`" convive com "o agente nunca rodou uma sessão" (doc 07 l.75, 132); não há execução real registrada no roadmap.

---

## Parte B — Funcionalidades documentadas que não existem (ou existem só parcialmente)

| Documentado | Onde | Realidade |
|---|---|---|
| A2A server / Agent Card `/.well-known/agent-card.json` | 00 §1, 01 §2/§6, README arquitetura | Removido (`server.ts:245-252`); existe `/api/tasks/*` + `/api/descriptor.json`. Docs 00/01/README ainda o apresentam como componente |
| Tool MCP `hub_agent_stream` | 01 §6 | Não existe (é `hub_agent_events`) |
| Orchestrator, CapabilityRegistry, ResiliencePipeline, ArtifactStore, Logger, TUI | 01 §2/§8 | Não existem como módulos (ver Parte A) |
| Manifesto `cost.from`, `stream.format: sse` | 01 §5 | Não existem no schema (ignorados/inválidos) |
| Controle de rede "domínios permitidos, nega o resto" | 01 §7, ADR 03 | Só existe no gate para `WebFetch`/`WebSearch` (`pretool-gate.ts:63`, única origem de `kind:'network'`); nenhum mapper emite ação de rede; nos agentes sem gate não há controle (doc 07 §2.6 continua verdadeiro) |
| Isolamento por container | 01/roadmap | Recusa explícita (`worktree.ts:101`), corretamente marcado `[ ]` |
| ACP | 00, roadmap | Inexistente, marcado `[ ]` |
| "hub hooks install codex" | README:161 | Existe (via `installCodexGate`), mas `HOOK_TARGETS` só tem claude/openclaude — o Codex tem caminho próprio; ok |
| "Validação por padrão" (README "portão de validação que roda o build/testes") | README "Quando um agente falha" | Desligado por padrão (`command: null`) |
| Gate do OpenClaude | roadmap l.394 `[~]`, `hub hooks install openclaude` | Instala o hook, comportamento runtime nunca exercido (o roadmap admite) |

---

## Parte C — Funcionalidades que existem e não têm documentação (nos docs da minha área)

- **API HTTP** (~45 rotas em `server.ts`): não há doc de referência. Só `/sessions/adopt`, `/approvals` e `/api/tasks` aparecem esparsos em roadmap/03. Rotas sem doc nenhuma: `/discovery*`, `/projects/:id/folders|context|import`, `/sessions/:id/diff|artifacts|handoff|pause|interrupt`, `/maintenance/sweep`, `/hooks/pretooluse`, `/context`, `/agents/probe`, `/api/descriptor.json`.
- **CLI**: `hub sessions`, `health`, `pause`, `interrupt`, `handoff`, `diff`, `artifacts`, `workflow`, `prune`, `project env|prompt|folders`, `doctor --smoke` — README só cita ~12 comandos e manda para `hub help`. `hub handoff`/`hub workflow` não têm uma linha nos docs 01/03/04/README (workflow: só roadmap + `examples/multi-agent-pipeline.yaml`).
- **MCP**: `hub_session_handoff`, `hub_session_pause`, `hub_session_interrupt`, `hub_session_diff`, `hub_workflow_run`, `hub_agent_wait` (doc 03/README).
- **Web UI**: visões `SettingsView`, `TelemetryView`, `AgentSwarmView`, `DagCanvasView`, `CommandPalette`, `DiscoveryPanel`, `ProjectModal`, edição de env/prompt por projeto — docs 03 e README descrevem só grafo/timeline/custo/controles.
- **Configuração por projeto além de `policy`**: `env`, `memory`, `prompts`, pastas extras (multipasta), modelo local por agente — só no roadmap ("Incorporado ao produto sem passar pelo plano") e doc 09/11.
- **Retenção**: `RetentionPolicy.rawEventDays`, `EventRetentionCompactor`, `maxSseConnections` (config) — só no roadmap.
- **Revisão cruzada** (`validation.review`) — descrita no doc 04 §3 só em uma frase; sem exemplo de configuração.
- `docs/09`, `10`, `11` existem mas README só linka o 11.

---

## Parte D — Contradições entre documentos

1. **Cobertura do gate:** README:161/SECURITY.md:55/roadmap:206 = Claude **e** Codex; doc 04 §1 = só Claude; comentário de `gateWaitMs` = "único agente com gate ligado hoje" = Claude.
2. **`escalate` por padrão:** README:184 e doc 04 = "alerta, não para"; SECURITY.md:62-72 = "impedido de verdade nos agentes com gate" (correto, ver achado ALTO).
3. **Gate e aprovação:** doc 07 §2.2 = "não abre `Approval`"; código/roadmap = abre e bloqueia; doc 04 §2 = "quando um portão retém ou a vigilância para" (sem citar o gate).
4. **Workflow:** doc 07 §2.4 (quebrado) x roadmap l.294 (`[x]`, corrigido).
5. **Nº de ferramentas MCP:** README 11 / doc 03 11 / roadmap 12 / doc 07 12 / código 16.
6. **Nº de testes:** README/CONTRIBUTING 273 (30 arq.), doc 07 196 (21), roadmap 380/410/428/432, real 517 (63).
7. **Nº de agentes:** ADR/01 "8", roadmap Fase 1 "8 (hoje 9)", README lista os 9 na intro mas o diagrama de arquitetura e doc 01 §5 citam 8.
8. **Painel de custos:** roadmap l.316 `[~]` (defeitos) x l.920 `[x]` (corrigido) x doc 07 "✅ corrigido".
9. **Doc 08 x roadmap:** doc 08 §3.7 "verificados, não corrigidos" x roadmap "Restante" [x] (o doc 08 não recebeu marca de resolução).
10. **Doc 03 "Caminhos confirmados: 3"** x roadmap l.423 (7 verificados) x `mcp-config.ts`.

---

## Parte E — Inventário completo de `[~]`, 🕳️ e `[ ]` do roadmap + prioridade para um MVP "100% utilizável"

Critério de MVP: um usuário instala, abre sessões com claude/codex/opencode, delega, controla custo e segurança sem se prejudicar. P0 = bloqueia essa jornada; P1 = necessário para confiar no que o README promete; P2 = qualidade/conveniência; P3 = fora do MVP.

| # | Linha | Marca | Item | Avaliação para o MVP | Prio |
|---|---|---|---|---|---|
| 1 | 200 | `[ ]` | Mapper dedicado do Cursor | Cursor sem binário; genérico funciona como texto. Sem vigilância nem resume. Fora do MVP se declarado "suporte básico" | P3 |
| 2 | 201 | `[ ]` | Mapper dedicado do MiMo (v1) | Idem; documentar limitação em manifesto/README | P3 |
| 3 | 279 | `[ ]` | Gate pré-execução para os demais agentes | 7 agentes sem prevenção. MVP: aceitável se README/UI avisarem claramente (SECURITY já faz); README:155 hoje sugere o contrário | P1 (só o aviso) |
| 4 | 280 | `[ ]` | TUI | Web UI cobre; conveniência | P3 |
| 5 | 316 | `[~]` | Painel de custos com projeção e alertas | Já corrigido pelo item l.920; a caixa está errada. Marcar `[x]` após confirmar visualmente | P2 (higiene) |
| 6 | 322 | `[ ]` | Isolamento por container | Worktree não é sandbox (SECURITY admite). MVP: não | P3 |
| 7 | 323 | `[ ]` | ACP (Zed/JetBrains/Neovim) | Não | P3 |
| 8 | 332 | 🕳️ | `hub doctor --smoke` | Falta rodar UMA vez com claude/codex/opencode e registrar; prova que os 3 agentes do MVP realmente funcionam de ponta a ponta. Barato | P0 |
| 9 | 344 | `[~]` | `modeArgs` (6 de 7; opencode vazio; cursor não verificado) | `--mode supervised` no OpenCode não restringe nada (adapter HTTP ignora `modeArgs`). Para MVP com OpenCode: aviso ou enviar `agent` na criação de sessão | P1 |
| 10 | 394 | `[~]` | `openclaude` cidadão pleno (gate runtime não verificado) | Entra no MVP só como "experimental"; `hub hooks install openclaude` não deve ser recomendado | P2 |
| 11 | 415 | `[~]` | Provar profundidade 2 com agentes reais | Provado com falsos + demo (reproduzi 18/18). Uma rodada real com claude->codex->opencode fecha | P1 |
| 12 | 421 | `[ ]` | Matriz de pares A->B | Todo destino já usado foi codex. Fazer ao menos claude<->codex<->opencode (6 pares) | P1 |
| 13 | 423 | `[~]` | Caminhos de config MCP (kimi/mimo `false`, cursor não instalado) | claude/codex/opencode/copilot/agy/openclaude verificados; kimi (sem mecanismo) e mimo não. MVP: aceitável; `hub mcp install kimi|mimo` deve recusar com o motivo | P2 |
| 14 | 466/471 | `[~]`/🕳️->`[~]` | Env ponta a ponta por agente / OpenCode servidor compartilhado (só a 1ª sessão define o ambiente) | Para usuário com 2 projetos e ambientes diferentes o env do OpenCode é silenciosamente ignorado na 2ª sessão (há aviso só no log do daemon). Documentar na UI ou um servidor por ambiente | P1 |
| 15 | 1115 | `[~]` | `session-manager.ts` grande (2632+ linhas, 6 de 8 fatias) | Dívida; risco de regressão, não bloqueia uso | P2 |
| 16 | 1260 | `[ ]` | 83 blocos `catch` engolindo erro | Auditar ao menos `bus.ts`, `worktree.ts`, `store/db.ts` (doc 08 #18); afeta diagnóstico | P2 |
| 17 | 1286 | `[ ]` | RSS sob churn de sessão (inconclusivo) | Daemon "por dias": medir com >=5k ciclos antes de dizer "estável" | P2 |
| 18 | 1329 | `[~]` | Web não expõe workflow/prune/mcp/hooks | CLI cobre; MVP aceita | P3 |
| 19 | 311 | `[x]` com ressalva = 🕳️ | Handoff nunca executado real | Testar 1 handoff claude->codex real; funcionalidade anunciada no painel | P1 |
| 20 | 1339 | (decisão em aberto) | Acesso remoto/authn | Sem auth, só loopback — manter e documentar | P3 |
| 21 | não listado | — | Doc 08 #11 (flag do SQLite no autostart) e #13 (race handoff) | Sem registro no roadmap; #11 pode impedir o primeiro uso em Node 22.5–22.12 | P0/P1 |
| 22 | não listado | — | Defeitos do gate (Parte A: escalate bloqueante, timeout 10 s vs 60 s, timeout mata sessão, approve retorna erro, política por prefixo) | Sem eles o gate não é "utilizável" nem confiável; não constam no roadmap | P0 |

Resumo P0 para o MVP: (a) resolver política do gate (`escalate`) + timeout do hook + timeout matando sessão + `approve` com erro; (b) `--experimental-sqlite` no autostart; (c) rodar `hub doctor --smoke` para claude/codex/opencode; (d) allow list por token/segmentos.

---

## Verificado OK

- Build e suíte: `node scripts/run-tests.mjs` -> 517 testes, 0 falhas (nada de flakiness observada nesta rodada).
- `npm run demo` (`scripts/demo-e2e.mjs`): 18/18 PASS — o fluxo raiz->filho->neto (profundidade 2) e o grafo funcionam com agentes falsos, exatamente como o README descreve.
- Manifesto de exemplo do README valida contra `AgentManifestSchema`.
- 9 manifestos em `manifests/`, 9 agentes reportados no boot do daemon; `openclaude` presente em `MCP_TARGETS`, `HOOK_TARGETS` e fallback.
- Doc 05: os 7 achados estão implementados (send recusa sessão terminal com mensagem citada; sessão viva tem prioridade em `#localizarSessao`; `registerSession` na retomada; concorrência checada no fallback; `rebuildConversation` usado por `send`).
- Guarda de borda, `EventType` (21), estados de task/sessão, container recusado, `hub doctor --smoke`, `hub pause`, `hub project env|prompt|folders`, `hub artifacts`, retenção de eventos (`EventRetentionCompactor` ligado em `hub.ts`) existem como descritos.
- Gate: `allow` para leituras/comandos da allow list, bloqueio de `git push` e de `Write .env`, aprovação pelo caminho `/approvals` -> gate libera (a liberação em si funciona); `approval.requested` agora cria linha em `approvals` (a divergência do doc 07 §2.2 está corrigida no código).
- `MATCHER_DE_RISCO` (`Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|WebFetch`) igual ao doc 04; hook falha aberto com daemon fora do ar como descrito.
- Limpeza: daemon de teste encerrado por `/shutdown` e diretório temporário removido; o daemon do usuário (4747) e `~/.agents-hub` não foram tocados.
