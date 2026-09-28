# STATUS — execução do GOAL (docs/12-goal-mvp-completo.md)

> Atualize este arquivo a cada item concluído. É a memória entre janelas de contexto:
> antes de continuar o trabalho, leia isto primeiro para saber o que já foi feito.
> Estado de cada achado: `[ ] pendente` | `[~] em andamento` | `[x] corrigido (commit: <sha>)` | `[rejeitado] <motivo>`.

Última atualização: 2026-09-26, por Claude Opus 5.5 (sessão de execução do GOAL).

## PAUSA (2026-09-27, pedida pelo usuário) — RETOMADA no mesmo dia: os 8 agentes foram retomados com contexto (SendMessage), cada um do ponto em que parou
Onda 4 interrompida no meio: 8 agentes parados, NADA dela mesclado na main. Os worktrees ficam em .claude/worktrees/ com o trabalho parcial (podem ter commits ou mudanças não commitadas):
- 8.1 docs reconciliadas → worktree-agent-a30e0a2e8e1d1a585
- 8.2/8.4 SECURITY + guia de instalação → worktree-agent-ab29ef9421e9e3906
- 8.3 demo ampliada + smoke MCP + verify sem typecheck duplicado → worktree-agent-ad414d227ae286ab6
- MCP escopo por fluxo (R08-14), R08-11/15/16, R11-05 codex supervised, R14-14 → worktree-agent-ac1689ba843343ec9
- BAIXOs core/store/daemon (R09-08/12/13/16/17/19, R13-17/19, R02-12, R06-13/14) → worktree-agent-af469884fcc640a66
- BAIXOs CLI (R14-11, R07-18/21/22/23/24, R07-11/20/07 resto) → worktree-agent-a9933f24877fff844
- MÉDIO/BAIXO web (R03-12/16/24/25/27/28, DAG) → worktree-agent-aa75a8055376c3aa2
- Correções do teste real (gate do Claude por --settings [ALTO], motivo de erro/quota, deny de orçamento pós-turno, ruído da CLI, tokens do Copilot) → worktree-agent-a552bbd98674e83c4
Ao retomar: ver o que cada worktree já tem (git -C <wt> log main..HEAD; git -C <wt> status) e relançar/terminar; depois 7.2 (ESLint/formatador), rodada 2 de teste real (gate Claude + retomada), instalação limpa, verify 3x.

## Passagem para o orquestrador Orca (2026-09-28)
A pedido do usuário, a continuação passa para um chat orquestrador que usa a skill `orchestration` do Orca. O prompt autocontido está em docs/15-prompt-orquestrador-orca.md. Estado na passagem: main em 8f75671 (+ este commit), merge do lint SEM verify pós-merge confirmado (primeira tarefa do orquestrador). Faltam: R12-05 (job Linux bloqueante), Read no matcher do gate, pendências D do prompt, auditoria do inventário, Fase 9.

## Execução do orquestrador (2026-09-28, run Orca run_81daa95a2983)
- **A (prioridade zero) FEITO**: `npm ci && npm run verify` na main @ 9448acf → verde: 1578 testes,
  1577 pass, 0 fail, 1 skip (POSIX), build+lint+format ok. O merge do lint está são.
- Onda de auditoria (3 workers só-leitura) concluída — ver seção "Auditoria independente" acima.
- Onda 2 (editores em worktree próprio, em andamento): B=Linux/CI bloqueante+smoke MCP no CI;
  C=Read/Grep/Glob no matcher do gate (injetado e instalado) + latência medida; D1=daemon (WorkflowRunner
  segue task, FOLDER_NOT_FOUND 404, teto p/ validação-revisão, SIGINT×shutdown idempotente, R09-07 vacuum);
  D2=CLI (flake merge-cmd ECONNRESET com causa raiz, doctor detecta policy inválida do config.json global,
  absorption.ts sem citar config.yaml, testes R07-17/R07-25); D3=web (aba Segurança segue projeto corrente)
  + Copilot 1.0.88 tokens (corrigir ou rejeitar com evidência do JSONL).
- Onda 2 MESCLADA (todas as 5 entregas revisadas com diff completo + prova de mutação reproduzida
  pelo coordenador; verify na main após cada merge):
  - C gate-read (merge da revisao/gate-read): Read|Grep no MATCHER_DE_RISCO (injetado E instalado),
    Glob fora com justificativa; leitura comum liberada no próprio hook (caminho rápido antes da
    config, ~125 ms p50 vs ~275 ms indo ao daemon; tabela em SECURITY.md); Grep com glob .env* é
    segredo; doctor/hooks acusam matcher antigo; fail-closed nega leitura de segredo. verify 1588.
  - D1 daemon (6a041ba..275aab5): WorkflowRunner segue a TASK (sobrevive a fallback, herda branch
    do substituto); FOLDER_NOT_FOUND 404; validação/revisão ocupam vaga no teto (exceção: fallback);
    shutdown idempotente (SIGINT×POST /shutdown); R09-07 auto_vacuum incremental com conversão
    medida na subida (teto de tamanho) — 203,1→112,5 MB. verify 1607.
  - D2 cli (08826ce..3d59db6): flake merge-cmd com CAUSA RAIZ (git síncrono do teste travava o event
    loop além do keep-alive de 5s do daemon no MESMO processo → RST no socket reusado; 20/60 falhas
    sob carga antes, 0/60 depois); hub doctor valida config.json antes do loadConfig e sugere a chave
    certa (distância de edição); absorption.ts cita o destino real (banco); testes R07-17/R07-25.
    verify 1615.
  - D3 web/adapters (250c112..39ad1d5): aba Segurança segue o projeto do filtro a cada abertura
    (preserva edição suja com pergunta); tokens do Copilot 1.0.88 REJEITADO com evidência (JSONL sem
    outputTokens desde 1.0.81; chaves listadas no teste copilot.test.ts); tokens desconhecidos não
    aparecem como "0" (CLI e painel). verify 1630; e2e 94/94.
  - B linux-ci (a016437..5f4a497 + integração 117e214): 3 bugs Linux reais em adapters
    (killProcessTree POSIX, imagemDoProcesso órfão, consumidor travado com stdout pausado);
    job `verificar-linux` BLOQUEANTE no portão rodando npm run verify + smoke MCP isolado (R12-05,
    R08-12). O branch partiu de base antiga: o coordenador refez a integração (process-tree combina
    kill de grupo R06-13 + varredura PID→PPID + espera de morte; mcp-smoke da main mantido; passo de
    CI simplificado — o manual lia `home` do /health, removido pela 1.8). verify 1631; smoke local
    21/21 PASS; suíte no container node:24-bookworm contra a main integrada em validação.
  - Pendência do B para a onda 3: checagem POSIX de PID reciclado na reconciliação (depende de
    session-manager.ts, fora do escopo dele).
- Onda 3 (em despacho): W3A segurança (R05-03 defesa em camadas + teste negativo + SECURITY.md,
  R05-07 import sem segredo cru, R05-10 raízes proibidas, R05-05 tools mcp__*/Task), W3B daemon resto
  (R13-13 Last-Event-ID, R02-10 HEARTBEAT_MS, PID reciclado POSIX), W3C cli/adapters (R13-02 watch
  fallback real + destino do follow-task.ts, R10-07 providerID OpenCode, R10-16 teste da flag do
  Codex), W3D web (R03-06/R03-11/R03-15/R03-21/R04-12/R04-14), W3E limpeza (R12-08 esperas fixas,
  R02-09 resíduos). Depois: Fase 9.

## Inventário
Checklist por achado (225: 3 CRÍT / 52 ALTO / 104 MÉD / 66 BAIXO — o GOAL contou só grafias acentuadas) em [INVENTARIO.md](INVENTARIO.md), com ID R<nn>-<seq> e item do GOAL. Estado marcado a partir dos itens concluídos. Placar atual: CRÍT 3/3, ALTO 16/52, MÉD 11/104, BAIXO 7/66.

## Auditoria independente do inventário (2026-09-28, orquestrador Orca)
Três workers SÓ-DE-LEITURA conferiram, achado a achado, correção no código + teste que a cobre
(relatórios completos no scratchpad da sessão do orquestrador; método e evidência arquivo:linha por item).
Resultado: 186 CONFIRMADO, 36 NAO-SUSTENTADO, 3 itens `[ ]`. O coordenador revisou por amostragem
(22 conferências diretas no código, 100% batendo, cobrindo evidências repetidas em ~30 linhas do inventário).
Triagem do coordenador sobre os 36 não sustentados:
- **REABERTOS no INVENTARIO (viram trabalho)**: R05-03 (ALTO — cookie de operador via Sec-Fetch forjado),
  R05-07 (importação grava segredo cru no .mcp.json), R05-10 (raízes proibidas), R13-02 (teste do watch usa
  módulo morto follow-task.ts), R13-13 (Last-Event-ID), R10-07 (providerID fixo OpenCode), R10-16 (sem teste
  da flag do Codex), R07-17/R07-25 (na Task do worker CLI), R08-12 (na Task do worker Linux/CI), R09-07 (na
  Task do worker daemon), R03-06/R04-12 (sem teste), R03-11/R03-15/R03-21/R04-14 (web parcial), R12-08 (esperas fixas).
- **Mantidos [x] por decisão (correção documental: teste automatizado não se aplica a prosa)**: R01-06..R01-11,
  R02-07, R02-08, R02-13, R02-14, R02-15, R12-01 (metadado de licença). Resíduos do R02-09 (run-tests.mjs
  cita "29 arquivos"; cancel-in-progress na main) vão para a onda de limpeza.
- **Decisões explícitas (MÉDIOs, regra 4 do GOAL)**: R06-15 — o item do GOAL era reconciliar a doc (8.1) e ela
  foi reconciliada; a detecção de escrita fora do worktree fica como limitação documentada (docs/04:76-83,
  SECURITY.md:314). R13-08 — pause não cascateia: decisão documentada em docs/01:90. R14-06 — min(8) do
  objetivo mantido de propósito (a mensagem explica e dá exemplo). R03-20 — as superfícies 12–15 da seção F
  (contexto por ref, busca/export de eventos na UI, eventos por fluxo, renomear sessão) ficam de fora do MVP:
  todas têm equivalente na CLI (hub export/cost/watch); registrado aqui como decisão. R10-13 — Cursor segue
  não verificado por falta do binário (autorizado pelo GOAL: cobrir só com agentes falsos e --help).
- Marcados como resolvidos (faltava marcar): R12-04 e R12-07 (merge 8f75671).

## Log da execução
- 2026-09-26 onda 1 disparada (agentes em worktree): 0.1 | 0.2+0.3 | 0.4+0.5 | 0.6 | 0.7 | 1.1+1.2+1.7 | 1.8. Onda 1 mesclada; verify 880/880.
- Onda 2: 1.3+1.4+1.5+2.4 (gate) | 1.6+1.10 (token + política/auditoria API/CLI) | 1.9 (TOFU env/prompts) | Fase 3 | 4.1+4.3+4.5 | 4.2+4.4 | web 6.1/6.2/6.7/6.8 | web 6.3/6.4/6.9/6.10 | web 6.5/6.6/6.11.
- Onda 2 mesclada; verify 1098/1098; e2e 24/24.
- INCIDENTE (onda 2): o agente de 4.2/4.4 matou por engano um processo brave.exe (PID 15884) ao limpar processos por padrão de porta. Regra 9 adicionada às instruções dos agentes. Informar o usuário.
- FLAKE operator-auth: resolvido na onda 3 (ver Fase 7). A hipótese de "outro processo na porta" estava errada.
- Onda 4 concluída: + painel (f99810f: estados de erro/vazio em todas as telas, e2e 93/93) + correções do teste real (388d34f: gate do Claude/OpenClaude injetado por --settings em TODA sessão do Hub, sem tocar no settings.json do usuário; motivo de falha = evento error do agente; quota/rate_limited; deny de orçamento pós-turno = completed; CLI sem ruído, --verbose). verify 1569/1569 (1 skip POSIX). Não corrigido: tokens do Copilot 1.0.88 (o JSONL não traz mais outputTokens; só AI Credits chegam).
- Onda 4 (retomada após pausa): mesclados CLI BAIXOs (f33a35f), 8.1, 8.2/8.4, 8.3, MCP escopo (22beb13..7696f71), core/store (3e6d2ec..c7a9447); verify 1527/1527 (1 skip POSIX). Mudança de comportamento: config.json global com chave desconhecida em policy agora impede o daemon de subir (aponta o campo) — mais seguro que ignorar typo.
- Onda 3 mesclada (9 agentes + investigação do flake); verify 1411/1411; e2e 64/64. Integrações feitas pelo coordenador: teto de concorrência (2.7 × 2.10), start/watch extraídos (5.2) + aviso de modo (2.9), canonização de caminhos (5.5) em cost/init e testes, detach idempotente (2.8 × 6.12a), detecção de hook main.js|bin.js movida ao daemon (5.7 × 6.12b), mcpServerEntrypoint relativo ao pacote.
- Nota de integração: o teste %E0 da 0.6 passou a esperar MALFORMED_URL (código da 1.8); ambos 400.

## Linha de base confirmada nesta data
- `npm ci && npm run verify`: verde, 517/517 testes, build limpo.
- `npm run demo`: 18/18 PASS.
- `main` local 15 commits à frente de `origin/main`; sem push feito.
- Daemon do usuário (porta 4747) tinha 2 aprovações pendentes de sessões antigas (`git push origin main`) — não tocadas.

## Fase 0 — Perda de dados e execução indevida
- [x] 0.1 Reaper apaga node_modules real via junction (CRÍTICO, relatório 06) — merge 7e7a7a7; worktree-links.test.ts (6 testes; mutação: 0/6 sem a correção)
- [x] 0.2 `agy` nunca recebe prompt (CRÍTICO, relatórios 10/11) — merge e3474b3→main; prompt-delivery.test.ts (39 casos; 23 vermelhos sem a correção). agy -p=<prompt>. Teste real pendente (Fase 9)
- [x] 0.3 Injeção de comando em agentes `.cmd` com prompt em argv (relatório 10) — mesmo merge; shim npm desembrulhado (node script/.exe real, sem shell); .cmd desconhecido com escape e recusa de multilinha/>8K; mimo por stdin
- [x] 0.4 `hooks install claude --write` destrói settings.json não-canônico (relatórios 07/08) — merge 49bee3a; install-write.test.ts + safe-write.test.ts; settings com lixo → recusa sem gravar; JSONC preservado; backup .bak-YYYYMMDD-HHMMSS
- [x] 0.5 `mcp install --write` gera config inválida (OpenCode) / TOML duplicado (Codex) / `.bak` sobrescrito (relatórios 07/08) — mesmo merge; OpenCode {type:local,command,environment,enabled}; Codex substitui tabela inteira e reparseia; validado com `opencode debug config` e `codex mcp list` em HOME temporário
- [x] 0.6 Path traversal no client MCP (`../shutdown#`) (relatórios 07/08) — merge 0437199; ids.test.ts, route-ids.test.ts, mcp server.test; idSegment em todo segmento do client (inclui trust/import); 400 INVALID_ID no daemon
- [x] 0.7 `validation.command` do repo executa com shell:true fora do gate (relatórios 02/05/09) — merge 7174e16; policy-merge.test.ts + project-trust.test.ts (12 vermelhos sem a correção); clamp monotônico campo a campo; validation/review do repo só com `hub project trust` (migração 5, padrão desligado)

## Fase 1 — Gate de permissões
- [x] 1.1 Classificador de comando por prefixo (comandos compostos passam) (relatórios 02/05/09/13) — merge b5279e1; command-classifier.test.ts 238 testes (177 vermelhos com o classificador antigo); tokenizador bash/cmd/PS, pior segmento, desembrulha sudo/env/bash -c/cmd /c/powershell
- [x] 1.2 Leitura de segredos não protegida; deny list vira approve (relatório 02/09) — mesmo merge; leitura de segredo = irreversible (Read e cat/type/Get-Content); escrita sensível inclui .git/hooks, .github/workflows, .git/config; deny = deny em todo modo
- [x] 1.3 Timeout do hook < espera do daemon (relatórios 01/05/08) — merge 4fff125; daemon espera 55 s < hook HTTP 100 s < timeout instalado 120 s; timeout do daemon = deny; gate.failMode (fechado em sessão do Hub, aberto fora); hub doctor/hooks acusam timeout antigo; gate-bloqueante.test.ts + hook.test.ts
- [x] 1.4 Gate falha aberto não documentado (relatório 02) — mesmo merge; SECURITY.md "Quando o gate falha: aberto ou fechado"
- [x] 1.5 Caminho bloqueante do gate: 3 defeitos (relatório 01/06) — mesmo merge; negar nega só a chamada (sessão segue), explicação real ao agente, approve responde 200; teste HTTP ponta a ponta (8 casos)
- [x] 1.6 Aprovação sem token (relatório 05) — merge 75fc500; <home>/operator-token (ACL só do usuário) exigido em aprovações/shutdown/sweep/política/contexto/trust/import/pastas; by = cli:<user>|web; cookie HttpOnly na navegação; token nunca no env do agente; operator-auth.test.ts 17 testes
- [x] 1.7 Calibrar tabela de risco supervised vs README (relatório 01/11) — mesmo merge; ~/.claude/plans não pede aprovação; ls/cat/git status = read; mkdir/make/npm install passam em semi; README com tabela risco×modo
- [x] 1.8 Guard: Origin null, JSON malformado→500, args MCP não mascarados, etc (relatório 02/05) — merge 639dd11; http-hardening.test.ts (10 vermelhos sem a correção) + guard.test; Origin null/sem porta/Sec-Fetch-Site; %→400; JSON→400; >5MB→413; args/url/headers mascarados; caminho de projeto validado; ADS/reservados→400; /health sem home
- [x] 1.9 Trust-on-first-use para BASE_URL/prompts/env do repo (relatório 02/05) — merge 77f7e21; repo-trust.test.ts (7 testes, 6 vermelhos sem a correção); env/prompts/memória/validation do repo só com confiança + hash (TOFU, suspende se mudar); contexto do Hub no banco (migração 6). Pendente p/ 6.12: UI de confiança no painel
- [x] 1.10 Editor de política + trilha de auditoria no painel/CLI (relatório 05) — mesmo merge; GET/PUT /policy, PUT /projects/:id/policy (clamp), GET /audit + tabela audit_log (migração 7); hub policy/hub audit. UI no painel pendente → 6.12

## Fase 2 — Ciclo de vida de sessão
- [x] 2.4 — junto do merge 4fff125 (send/handoff em waiting_approval → ILLEGAL_STATE citando apv)
- [x] 2.1 2.2 2.3 — merge 468ce58/af8c04a; session-lifecycle.integration.test.ts (16; corrida cancel 20/20 killed/canceled; 15 vermelhos na main); cancel→canceled, interrupt/pause = fim de turno retomável (resume nativo), falha de launch desfaz sessão/task/worktree/reserva. Não feito: validação não conta no teto de concorrência; pause não cascateia (documentado)
- [x] 2.5 2.6 2.7 2.8 — merge 494f026; tetos por evento/linha/sessão/página, AsyncQueue cede o loop (/health responde na rajada), prune commita o trabalho em hub/<id> antes de recolher, órfãos/meio-apagados, trava de reentrada, handoff persiste agent_id e não conta 2x, reconciliação com evento, leases de raízes adotadas (heartbeat MCP), wait cancelável, limites no hub_agent_call; migração 8 (índices parciais)
- [x] 2.9 2.10 — merge 4a20fe0; workflow segue fallback, retry por código, passo seguinte herda o código (commit em hub/<id> + baseSessionIds, fan-in por merge), espera aprovação e retoma; overrides de projeto valem (retries/fallback/watch/maxDepth/maxConcurrency por projeto), aviso de modo capado, SSE de task segue fallback, orçamento em segundos, aprovar estouro não relança — ver docs/12-goal-mvp-completo.md (relatórios 06/13)

## Fase 3 — Custo e orçamento
- [x] 3.1 3.2 3.3 3.4 — merge 559db1f; turn-cost (final = verdade, parciais estimam), Copilot por AI Credits (nano-AIU→US$0,01), BudgetLedger (fatia própria, NaN/negativo, reserve idempotente), replay pelos últimos N (tail), preços verificados online 2026-09-26 (Opus 5.5 4/20 etc.). Não verificados: kimi-k2-5/k2, modelo padrão do agy/kimi. Pendente: tokens de cache fora do teto de tokens (decisão de produto)

## Fase 4 — Adapters
- [x] 4.1 4.3 4.5 — merge f88df96; PATH×PATHEXT em JS (acentos), cache negativo 30 s; manifest.model {supported,args}; /agents expõe model/verified; versões verificadas por --version. Pendente: OpenCodeAdapter usar modeloDaRun/provider
- [x] 4.2 4.4 — merge 3fdc4a4; OpenCode com agentes hub-supervised/semi/autonomous via OPENCODE_CONFIG_DIR (regras conferidas no avaliador do opencode serve); Kimi 2.0.0 (--agent plan; -p recusa -y/--auto/--plan); generic-json com sessão/custo; discovery do agy no caminho real
- [x] 4.6 — merge 6f231e2; doctor/status com auth do discover (quebrado vs atenção por versão), doctor --smoke com confirmação/--yes, US$0,10, série, projeto git temporário (smoke real não executado)

## Fase 5 — CLI e primeira execução
- [x] 5.1 5.4 5.7 — merge 2c75f7b; bin.js reexecuta com --experimental-sqlite só no Node 22.5–22.12 (testado com binários reais 22.5.0/22.12.0), sem ExperimentalWarning, hook leve (~250 ms), AGENTS_HUB_PORT e config.json validados (arquivo:linha:coluna), tarball autocontido (npm run pack:dist / test:install), hooks/MCP apontam para a instalação, hub autostart enable|disable|status (não ativado aqui). Licença MIT aplicada depois (8f64fc4) por escolha do usuário
- [x] 5.2 5.3 5.5 — merge 6f231e2; watch/budget/graph de id inexistente = erro/404, watch --root de fluxo terminado, send após pause; start em subpasta, repo sem commit, exit≠0, fallback avisado, --mode/--isolation validados; caminhos 8.3/caixa canônicos
- [x] 5.6 — merge 3881e98; hub init/open/logs/restart/update/version, --json uniforme, export, cost, merge/apply (prévia, sem push), backup/restore (VACUUM INTO, WAL-safe)

## Fase 6 — Painel web
- [x] 6.5 6.6 6.11 — merge fa7ee18; testes de lógica do web (packages/web/src/logic, runner dist-test), 10 vermelhos sem a correção; onboarding sem projeto; tabela de env por agente no core. Pendências: trocar de aba no topo descarta edição sem aviso (App.tsx); classes .settings-vazio/.settings-erro sem CSS
- [x] 6.1 6.2 6.7 6.8 — merge 9979203; e2e Playwright (Edge local) `npm run test:e2e` 24/24 em 375/768/1100/1440 (22 vermelhos no código antigo)
- [x] 6.3 6.4 6.9 6.10 — merge 1e29f83; timeline pelos recentes + paginação, user.message, controles honestos, DAG com arestas/teclado, refetch agrupado (50 eventos → 1 busca). 6.4 "Interromper marca FALHOU" depende do 2.2
- [x] 6.12 — merges c5fb763 (aba Operação: tasks, diff, artefatos, orçamento editável PUT /budget/:root, workflow validar/rodar/acompanhar, pastas, adopt/detach, saúde, re-sondar, sweep) e 4dc9650 (aba Segurança: política com prévia dryRun e aviso "afrouxa", confiança do projeto, gate/MCP com diff e hash base, histórico de aprovações, auditoria com filtros/export; modelo por agente; aviso de edição não salva). e2e 64/64 em 4 viewports

## Fase 7 — Testes/CI
- [x] 7.1 7.3 — merge ab3a0af; listen(port 0) grava a porta real, testes sem portaLivre, esperas por condição, cobertura de reaper/project-registry/hooks-install/workflow-cmd/daemon-control/client/gate composto, npm run coverage (84,7% linhas), npm audit 0 vulnerabilidades, LICENSE MIT
- [~] 7.2 — (ESLint + Prettier + deps em andamento, agente único) CI com permissions: contents: read, job Linux roda verify (informativo), job de cobertura. Falta ESLint (no-floating-promises) e formatador
- [x] 7.4 — e2e Playwright (Edge local) npm run test:e2e, 64 testes
- Flake do operator-auth: RESOLVIDO (merge 03f4c4d) — era do teste: o token "quase certo" era o certo quando o aleatório terminava em 0 (1/16); o /shutdown autenticado derrubava o processo. Produto sem falha. Nova operator-routes-table.test.ts percorre TODAS as rotas operator:true

## Fase 8 — Documentação/demo
- [x] 8.1 — merge 75afd04; docs reconciliadas com contagens medidas (142 arquivos de teste, 16 tools MCP, 22 eventos, 9 manifestos, 46 comandos), docs/01 sem módulos inexistentes, 03/04 com gate bloqueante e tempos, roadmap com 9 marcas rebaixadas, ADRs com notas datadas, retenção real, docs/09/10/11. Pendente de 8.1: R01-11(3) pré-requisitos "ao menos um CLI" (coberto pelo README Requisitos da 8.4)
- [x] 8.2 8.4 — merges f46ce0e/c3e9a51; SECURITY.md reescrito com fonte em cada afirmação (corrigiu rotas protegidas faltantes, Read do Claude fora do matcher, retenção, host); docs/14-primeiros-passos.md seguido de verdade com tarball em prefixo/HOME temporários (3 bugs achados e corrigidos: listas do PowerShell, hub update com tarball, aviso do daemon)
- [x] 8.3 — merges 75746f6/79d8ec2; demo 47/47 (3x verde, < 1 min), smoke MCP com as 16 tools em daemon isolado; achou e corrigiu: workflow via painel/MCP sem código do passo anterior, handoff de sessão pausada

## Fase 9 — Fechamento
- [ ] Não iniciado

## Teste real — rodada 1 (2026-09-26 23:38–23:42, daemon isolado porta 48511, home temporário, projeto git temporário)
Prompt: "Responda apenas com a palavra OK. Não use ferramentas." `--budget-usd 0.10`, em série. Versões: claude 2.1.283, codex 0.155.0, opencode 1.18.32, agy 1.2.11, copilot 1.0.88.
| # | Agente | Resultado | Custo registrado | Observações |
|---|---|---|---|---|
| 1 | claude | OK, nativeSessionId c644e32e… | US$ 0,1323 (contagem única) | turno real custa > 0,10 → aprovação de orçamento aberta corretamente; negar após turno concluído marcou `killed` (defeito); ruído: linhas vazias e rate_limit_event cru |
| 2 | codex | FALHA por limite de uso da conta ("You've hit your usage limit") — registrado, não repetido | — | adapter ok até o modelo (threadId capturado); defeitos: motivo exibido = 1ª linha do stderr (aviso de SKILL.md), limite tratado como permanente → fallback automático |
| 3 | claude (fallback automático do #2) | OK | US$ 0,1321 | chamada não planejada, causada pelo fallback; fallback zerado no daemon isolado depois disso |
| 4 | opencode | OK, tarefa concluída, exit 0 | US$ 0,0000 · 2,8k tokens | modelo grátis do provedor opencode; ruído: message.delta cru, turno concluído 2x |
| 5 | antigravity | OK — CRÍTICO 0.2 provado no binário real | US$ 0,0348 · 14,8k tokens | turno concluído 2x |
| 6 | copilot | OK com prompt MULTILINHA (0.3 provado) | 0,37 AI Credits = US$ 0,0037 | tokens 0 (entrada não vem no JSONL); turno concluído 3x |
Achado novo (ALTO, segurança): sessão do Claude subida pelo Hub só tem gate se o usuário instalou o hook no ~/.claude/settings.json; o Claude aceita `--settings <arquivo-ou-json>` → injetar o hook por sessão (como já é feito no Codex). Teste do gate e retomada do Claude ficam para a rodada 2, depois da correção. Codex: retomada impossível hoje (limite da conta).
Chamadas reais na rodada 1: 6 (dentro do teto de ~10).

## Orçamento de chamadas reais a modelo usado até agora
- Vistoria de 2026-09-25: ~9 chamadas (relatório 11), dentro do teto combinado com o usuário.
- 2026-09-26: rodada 1 = 6 chamadas (ver acima). Resta no dia: 1 rodada.
