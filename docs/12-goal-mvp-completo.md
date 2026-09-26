# 12 — GOAL: MVP 100% completo e pronto para uso real

> Origem: vistoria de 2026-09-25 com 14 agentes (relatórios completos em
> [`vistoria-2026-09-25/`](vistoria-2026-09-25/)). Totais: **2 CRÍTICOS, 52 ALTOS, 71 MÉDIOS, 66 BAIXOS.**
> Este arquivo é o plano de execução. Cada item aponta o relatório com evidência, impacto e correção.

## O GOAL

Um usuário instala o Agents-Hub numa máquina Windows limpa, roda `hub doctor`, vê seus CLIs
(Claude Code, Codex, OpenCode, Antigravity, Copilot e os demais) reconhecidos com auth e configuração
absorvidas, abre sessões pelo painel ou pela CLI, delega entre agentes, aprova ou nega ações com
segurança, acompanha custo real, e **nada disso perde dados, executa nada sem gate, nem mostra um
botão que não funciona** — comprovado por testes automatizados, por `npm run demo` e por um teste
real mínimo em cada CLI.

## Definição de PRONTO (todas verdadeiras, com evidência colada no relatório final)

1. `npm ci && npm run verify` verde em clone limpo (build do zero + suíte inteira).
2. `npm run demo` 18/18 PASS (ampliado, ver Fase 8).
3. **Zero achado CRÍTICO ou ALTO aberto** dos 14 relatórios; cada um `corrigido` (com teste que fica vermelho sem a correção) ou `rejeitado` (com justificativa técnica escrita em `docs/vistoria-2026-09-25/STATUS.md`).
4. MÉDIOS: corrigidos, ou listados em STATUS.md com decisão explícita e motivo.
5. Painel: nenhum controle fantasma, nenhuma sobreposição em 375/768/1100/1440 px (medida por JS no navegador embutido), todos os modais com foco e Esc, e superfície para toda funcionalidade do daemon (Fase 6).
6. Teste real mínimo passando nos 5 CLIs autorizados (Claude Code, Codex, OpenCode, Antigravity, Copilot) — ver orçamento abaixo.
7. Docs reconciliados com o código (contagens, ADRs, doc 07 como fonte de verdade, roadmap com marcas honestas conforme CONTRIBUTING).
8. Instalação reproduzível documentada e testada num diretório limpo.

## Orçamento de teste real (NÃO estourar a assinatura)

Autorizado pelo usuário: testes mínimos em Claude Code, Codex, OpenCode, Antigravity e Copilot.
- Somente ao final de cada fase que mexa em adapter/gate/custo, e no fechamento (Fase 9).
- Uma sessão trivial por agente ("Responda apenas com a palavra OK. Não use ferramentas."), `--budget-usd 0.10`, projeto temporário com `git init`, **em série**, nunca em paralelo.
- No máximo: 1 retomada (Claude e Codex) e 1 teste de gate/aprovação (Claude). Teto geral ~10 chamadas de modelo por rodada completa; no dia, no máximo **2 rodadas completas**.
- Falhou por auth/limite: registrar e seguir, sem repetir. Qualquer outra chamada a modelo real precisa ser perguntada ao usuário.
- Cursor não está instalado e MiMo/Kimi/OpenClaude não têm autorização de teste real: cobrir só com agentes falsos e `--help`.
- **Daemon do usuário (porta 4747) e `~/.agents-hub` são intocáveis**: usar sempre daemon isolado (`AGENTS_HUB_HOME` temporário, porta própria em `config.json`, `AGENTS_HUB_NO_AUTOSTART=1`, encerrar com `POST /shutdown` com corpo JSON). Não aprovar/negar aprovações pendentes do usuário. Nunca `--write` em configs reais dos CLIs sem pedir.

---

## Plano por fases (ordem obrigatória: segurança e perda de dados antes de tudo)

### Fase 0 — Perda de dados e execução indevida (CRÍTICOS + ALTOS de destruição)
| # | Item | Relatório |
|---|---|---|
| 0.1 | **CRÍTICO**: o reaper apaga o conteúdo do `node_modules` real do projeto ao remover worktree (junction no Windows; reproduzido com git puro). Não seguir junctions: remover o link, nunca o alvo; testar com worktree que tenha `node_modules` junction | 06 |
| 0.2 | **CRÍTICO**: `agy` (Antigravity) nunca recebe o prompt (`-p` engole `--output-format`; manifesto sem `{{prompt}}`). Corrigir manifesto e provar com o binário real | 10, 11 |
| 0.3 | **Injeção de comando** em agentes `.cmd` (copilot, mimo) com prompt em argv; prompt multilinha truncado, >8 KB falha, CJK/emoji viram `?`. Passar prompt por stdin/arquivo ou escapar corretamente; teste com `& echo PWN>x` | 10 |
| 0.4 | `hub hooks install claude --write` apaga `settings.json` que não parseia (o real do usuário tem lixo no fim); segunda execução perde o backup. Parser tolerante ou recusar, backup nunca sobrescrito (versionado por timestamp) | 07, 08 |
| 0.5 | `mcp install --write`: OpenCode gera formato inválido (config inteira rejeitada); Codex gera TOML com chave duplicada; `.bak` sobrescrito a cada execução | 07, 08 |
| 0.6 | Path traversal no client (`hub_agent_cancel` com `../shutdown#` derruba o daemon): `encodeURIComponent` em todo id e validação de formato de id | 07, 08 |
| 0.7 | `validation.command` (e demais campos) do `.agents-hub/config.yaml` do repositório executam código com `shell:true` fora do gate; o clamp "só aperta" é falso para orçamento/timeouts/retries/validation. Restringir a fontes confiáveis (global) ou exigir aprovação explícita/confiança por projeto; corrigir `mergePolicyLayer` | 02, 05, 09 |

### Fase 1 — Gate de permissões confiável
| # | Item | Relatório |
|---|---|---|
| 1.1 | Classificador de comando casa por prefixo: `a && b`, `a; b`, `a | b`, `echo x > .env`, `node -e`, `find -delete`, `rm --recursive`, `git -C x push`, `git stash drop` passam como allow. Tokenizar comandos compostos, classificar pelo pior segmento, redirecionamentos, pipes, subshell; suíte de tabela-verdade | 02, 05, 09, 13 |
| 1.2 | Leitura de segredos (`~/.ssh`, `.env`, credenciais) nunca é protegida; lista de escrita sensível incompleta (`.git/hooks`, `.github/workflows`). `deny` da lista vira `approve` em vez de `deny` | 02, 09 |
| 1.3 | Timeout do hook (10 s Claude / 20 s Codex) < espera do daemon (60 s): o hook estoura e a ferramenta RODA sem aprovação (confirmado com `claude` real). Alinhar: hook com timeout maior que a espera, ou daemon responde antes; falha do hook deve ser **fechada** para ação de risco (com modo explícito e documentado) | 01, 05, 08 |
| 1.4 | Gate falha aberto se o daemon não responde; documentar em SECURITY.md e oferecer modo fail-closed configurável | 02 |
| 1.5 | Caminho bloqueante do gate sem teste, com 3 defeitos: timeout de 60 s mata a sessão, mensagem "política proíbe" errada (`server.ts:650` ignora `verdict.explanation`), `hub approve` retorna erro após já ter liberado | 01, 06 |
| 1.6 | `POST /approvals/:id` sem token e `by` livre: o agente/processo local aprova a própria ação. Token de sessão do daemon (arquivo com permissão do usuário) exigido pela CLI/painel; `by` derivado da origem autenticada | 05 |
| 1.7 | Supervised do Claude dispara aprovação só por gravar plano em `~/.claude/plans`; gate pausa `mkdir/make/cargo build/git fetch/npm install/curl` contra o que o README promete. Calibrar tabela de risco e README | 01, 11 |
| 1.8 | Guard: `Origin: null` com POST `Content-Length: 0` passa; `%` malformado pendura a conexão; JSON malformado/corpo >5 MB → 500 (deve ser 4xx); `/discovery` não mascara `args` de MCP; caminhos de projeto aceitos sem validação; `index.html::$DATA`; `/health` expõe `home` | 02, 05 |
| 1.9 | `*_BASE_URL`/prompts/env vindos do repositório: exigir confirmação (trust-on-first-use) por projeto; documentar em SECURITY.md | 02, 05 |
| 1.10 | Painel/CLI para **editar política** (modos, allow/deny por projeto, limites) e **trilha de auditoria** de decisões | 05 |

### Fase 2 — Ciclo de vida de sessão (corretude do núcleo)
| # | Item | Relatório |
|---|---|---|
| 2.1 | Cancel termina `failed` (6/8) e task nunca `canceled`; cancel durante validação ressuscita como `completed`; durante backoff deixa task em `working` | 06, 13 |
| 2.2 | `interrupt`/`pause` no Windows matam a sessão (`failed`). Implementar pause/interrupt real (ex.: job objects/CTRL_BREAK/suspender) ou desabilitar honestamente no painel/CLI/docs | 06, 13 |
| 2.3 | Falha de launch deixa sessão `running` fantasma + worktree vazado + reserva de orçamento presa (delegação legítima seguinte dá `BUDGET_EXCEEDED`); Codex supervised recusado deixa sessão fantasma | 06, 08, 11 |
| 2.4 | `send` em sessão `waiting_approval` relança o agente por cima da aprovação | 06 |
| 2.5 | Saída de 20 MB trava a API por até 17 s; linha de 60 MB gera resposta de 125 MB; `raw` sem truncar (5 MB por tool_result) | 06, 10 |
| 2.6 | `hub prune` nunca recolhe worktree com escrita e o branch `hub/<id>` fica no commit-base sem o trabalho; worktrees sujos/meio-apagados nunca recolhidos; `sweep()` sem trava de reentrada | 06, 13 |
| 2.7 | Handoff: `agent_id` fora do UPDATE (`repositories.ts:181`); conta a sessão 2x no teto de concorrência | 06, 13 |
| 2.8 | Reconciliação no restart fecha sessões sem emitir evento; adoção externa cacheada com falha; raízes adotadas ficam `running` para sempre; `wait` segue consultando após cancelado | 06, 08 |
| 2.9 | Workflow: fallback reportado como falha do passo; retry de `CONCURRENCY_EXCEEDED` nunca dispara via CLI (`instanceof`); worktree do passo seguinte não recebe o código do anterior; workflow bloqueado por aprovação sem retomada | 13 |
| 2.10 | Overrides de projeto (`retries`, `fallback`, `watch`, `maxConcurrency`) ignorados; `--mode autonomous` capado em silêncio; SSE de tasks não segue fallback; orçamento em `seconds` não aplicado; aprovar estouro após turno concluído relança o agente | 13 |

### Fase 3 — Custo e orçamento corretos
| # | Item | Relatório |
|---|---|---|
| 3.1 | Custo do Claude/OpenClaude/Antigravity contado 2–3x (linhas `assistant` + `result`); teto de US$ 0,10 estoura em 1 turno; Copilot mostra 0 (real 0,53 créditos/56k tokens) | 10, 11 |
| 3.2 | `BudgetLedger`: fatia reservada contada como consumida → `exhausted` falso; aceita NaN/negativo; `reserve` duplicado vaza saldo | 09 |
| 3.3 | Replay/`hub_context_fetch` devolve os PRIMEIROS N eventos, não os últimos; contradiz `condensarHistorico` | 09 |
| 3.4 | Conferir tabela de preços contra fontes atuais (docs/10) | 09 |

### Fase 4 — Adapters e cidadania de cada agente
| # | Item | Relatório |
|---|---|---|
| 4.1 | `resolveBin` corrompe caminhos com acento (UTF-8 vs OEM); cacheia `null` para sempre | 10 |
| 4.2 | OpenCode: modo do Hub não restringe nada (`build` = `allow *`; adapter não envia `agent`); ruído de eventos crus e brief ecoado | 10, 11 |
| 4.3 | `ctx.model` ignorado por 8/9 agentes → conectar modelo por agente (flag/env real de cada CLI) ou remover o controle | 03, 10 |
| 4.4 | Kimi 2.0.0 (`--plan`, mapper do formato antigo); `generic-json` sem sessão/custo (mimo, cursor); discovery do Antigravity lê caminho errado | 10 |
| 4.5 | Atualizar `verified`/versões dos manifestos (agy 1.2.6, copilot 1.0.83, openclaude 0.14.0, opencode 1.18.32); manifesto do Cursor 100% não verificado | 10 |
| 4.6 | `hub doctor`/`status` devem usar auth do `discover` e marcar agente quebrado (Antigravity aparece "disponível" mesmo quebrado); `doctor --smoke` com orçamento mínimo e confirmação | 11, 14 |

### Fase 5 — CLI e primeira execução
| # | Item | Relatório |
|---|---|---|
| 5.1 | **Node 22.5–22.12**: `node:sqlite` exige `--experimental-sqlite`; nem o shim do `npm link` nem o autostart passam a flag. Passar a flag em todos os pontos de entrada (ou subir `engines`) e testar | 01, 14 |
| 5.2 | `hub watch <id-inexistente>` trava; `budget`/`graph` de id inexistente respondem vazio; `watch --root` de fluxo terminado pendura; `send` após `pause` sem resposta | 07, 14 |
| 5.3 | `hub start`: subpasta de projeto registrado → `PROJECT_FOLDER_CONFLICT`; repo sem commit mostra erro cru do git; exit 0 quando a sessão falha; fallback silencioso; `--mode`/`--isolation` inválidos aceitos | 07, 14 |
| 5.4 | `AGENTS_HUB_PORT` ignorada pelo cliente da CLI; `config.json` inválido → stack trace; leitura de env sem validação (`NaN`) | 02, 07, 14 |
| 5.5 | `hooks install codex --write` congela a config padrão no `config.json`; `project env/prompt` descarta política; caminhos 8.3/caixa duplicam projeto; projeto inexistente aceito | 07 |
| 5.6 | Comandos que faltam: `hub init` (onboarding), `open`, `logs`, `restart`, `update`, `--version`, `--json` uniforme, exportar sessão/relatório de custo, `hub merge/apply` do branch da sessão, backup/restore do banco; sem ExperimentalWarning nem 0,6 s de custo por hook | 07, 09, 14 |
| 5.7 | Empacotamento: pacotes `private`, sem LICENSE, caminho absoluto do repo gravado nas configs dos agentes. Definir distribuição (npm/tarball), LICENSE, autostart no login, instalador testado em diretório limpo | 12, 14 |

### Fase 6 — Painel web: zero fantasma, zero sobreposição, cobertura total
| # | Item | Relatório |
|---|---|---|
| 6.1 | **Topbar sem responsivo**: estoura de 768 a ~1116 px e no mobile só a aba Timeline fica clicável; busca sobrepõe o pill "Ao Vivo". Refazer com breakpoints (1200/1000/768/600), overflow controlado, menu compacto | 03, 04 |
| 6.2 | Ctrl/⌘+K só fecha a paleta; setas/Enter não funcionam; `<kbd>N</kbd>` sem handler; rótulos em inglês | 03, 04 |
| 6.3 | Timeline carrega os 500 eventos MAIS ANTIGOS; auto-scroll para após 400; falha de fetch nunca repetida; mensagem enviada pelo usuário nunca aparece (emitir evento no daemon) | 03 |
| 6.4 | Pausar desabilita Encerrar/Interromper/Transferir; UI fica "PAUSADA" após retomada implícita; "Interromper" marca FALHOU; "Encerrar" sem confirmação | 03, 04 |
| 6.5 | Controles fantasma: campo "Modelo" (`MODEL`) em "Modelos locais" e bloco `OPENAI_*` para agentes que não leem | 03, 10 |
| 6.6 | Configurações: projeto que falha ao carregar mantém config do anterior (grava por cima); config salva sem `policy:` gera aviso falso de "inválida"; registrar caminho inexistente aceito | 03, 04, 13 |
| 6.7 | Modais: foco preso, foco inicial, Esc, `aria-*`; gavetas laterais abrem juntas e sobrepõem, focáveis fechadas; compositor cobre a gaveta no mobile; rodapé do modal fixo | 03, 04 |
| 6.8 | `--agent-1..8` nunca definidas (telemetria invisível, avatares sem cor); tema claro (hoje só escuro); contraste `--text-faint`; Google Fonts via `@import` | 03, 04 |
| 6.9 | Grafo DAG sem arestas pai/filho e sem teclado; "ver a sessão" das aprovações não troca de aba; "Nova Sessão" ignora o projeto filtrado; toasts enganosos (interromper sem turno, delegação retida) e que nunca somem | 03, 04 |
| 6.10 | Desempenho: cada evento refaz 4 GETs duas vezes + `/graph` por fluxo (253 req/15 min) — debounce/consolidar | 04 |
| 6.11 | `/discovery` fora do proxy do Vite (aba "Agentes detectados" quebra no `npm run dev`); DiscoveryPanel disponível sem projeto selecionado e conectado ao onboarding | 03, 14 |
| 6.12 | **Superfícies que faltam**: diff, artifacts, tasks, workflow (rodar/validar/acompanhar), prune/sweep, mcp/hooks (estado e instalar com prévia), health/doctor, adopt/detach, re-sondar agentes, editar orçamento, pastas pós-criação, histórico de aprovações, editor de política (1.10) | 03 |

### Fase 7 — Testes, CI, dependências
| # | Item | Relatório |
|---|---|---|
| 7.1 | Cobertura de `reaper.ts`, `project-registry.ts`, `hooks-install`, `workflow-cmd`, `daemon-control`, client, web (testes de componente ou e2e de painel); caminho bloqueante do gate; comandos compostos | 01, 12 |
| 7.2 | ESLint (`no-floating-promises`), formatador, medição de cobertura, `permissions:` no `ci.yml`, job Linux não-informativo se viável | 12 |
| 7.3 | `npm audit fix` (`qs`); LICENSE + campo `license`; testes com `setTimeout` frágeis | 12 |
| 7.4 | Teste e2e do painel (Playwright ou equivalente) cobrindo cada botão e cada viewport medido | 04 |

### Fase 8 — Documentação e demo
| # | Item | Relatório |
|---|---|---|
| 8.1 | Reconciliar contagens (16 tools MCP, 63 arquivos/517+ testes, 9 agentes), doc 01 (módulos inexistentes: Orchestrator, TUI, A2A, `hub_agent_stream`), doc 04 (gate/`approve`), doc 07 (fonte de verdade desatualizada), retenção (`raw_json` compactado em 7 dias), `docs/09` vs leitura de env real, docs/10 (OpenCode reporta USD), marcas `[x]` honestas no roadmap | 01, 02 |
| 8.2 | SECURITY.md: fail-open do gate, vetores do repositório (BASE_URL, prompts, env, validation), token de aprovação, modelo de ameaça atualizado | 02, 05 |
| 8.3 | Ampliar `npm run demo`: aprovação, cancel, fallback, workflow, custo, painel; `.gitignore` para `*.txt` de sessão | 01, 02 |
| 8.4 | Guia de instalação e "primeiros 10 minutos" incluindo `hub discover/import` e `hooks install` | 14 |

### Fase 9 — Fechamento e prova real
1. `npm ci && npm run verify` em clone limpo, 3 rodadas sem flaky.
2. `npm run demo` completo.
3. Painel: percorrer no navegador embutido cada aba/botão em 1440/1100/768/375, sem sobreposição, console limpo.
4. **Uma** rodada de teste real mínimo nos 5 CLIs (orçamento acima), registrando processo/eventos/custo/`nativeSessionId`/retomada/gate.
5. Instalação em diretório limpo, seguindo só o guia.
6. `STATUS.md` com cada achado dos 14 relatórios: corrigido (commit + teste) ou rejeitado (motivo). Roadmap e doc 07 atualizados.

---

## Método de execução (obrigatório)

- Trabalhar em fases, mas **paralelizar ao máximo dentro de cada fase**: um agente por área de arquivos disjunta (`isolation: worktree`), com critérios de aceite e testes que fiquem vermelhos sem a correção. Depois validar cada entrega **você mesmo** (diff, testes, mutação, execução real) antes de mesclar.
- Ordem: Fases 0 e 1 primeiro (perda de dados e gate), depois 2–5 em paralelo onde não houver conflito de arquivo, 6 (web) em paralelo com 2–5, 7–8 contínuas, 9 no fim.
- Após cada merge: `npm run verify`. Se ficar vermelho, é prioridade zero.
- Commits pequenos e frequentes na `main` (sem push, sem publicar, sem tocar no daemon do usuário). Todo commit termina com `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
- Manter `docs/vistoria-2026-09-25/STATUS.md` atualizado a cada item concluído (é a memória entre janelas de contexto).
- Só parar quando a **Definição de PRONTO** estiver 100% satisfeita e comprovada. Bloqueio externo concreto: descrever, contornar o que der e continuar no resto.
