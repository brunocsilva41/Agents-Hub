# 14 - Jornada do usuario novo e completude do MVP

Escopo: caminho clonar -> npm install -> build -> npm link -> hub doctor -> registrar projeto -> start -> delegar -> painel -> aprovar -> custo -> encerrar.
Metodo: leitura de codigo/docs + execucao real contra daemon isolado (porta 48209, AGENTS_HUB_HOME temporario, NO_AUTOSTART=1, encerrado via POST /shutdown). Nenhum agente real foi iniciado (todas as tentativas de `hub start` falharam antes do spawn, por desenho do teste), nada em ~/.agents-hub nem na 4747 foi tocado. Nao rodei `npm install`/build/link (proibido/desnecessario): o dist ja existia. Onde o achado e so de leitura de codigo, esta dito.

## Mapa da jornada (o que funciona)

| Passo | Estado |
|---|---|
| build + link | documentado numa linha no README; `bin.hub` OK |
| `hub doctor` | funciona (testado): lista 8/9 agentes com versao e caminho; nao verifica auth |
| registrar projeto | `hub project add` OK; `hub start` registra sozinho |
| autostart do daemon | existe, com log em `~/.agents-hub/logs/daemon-AAAA-MM-DD.log` |
| `hub discover` | funciona (testado), tabela boa, nunca mostra segredo |
| `hub approvals/approve/deny`, `hub graph`, `hub budget` | existem |
| `hub stop` | existe |

Pontos fortes reais: autostart sem cerimonia, mensagem de erro do worktree em repo nao-git orienta a correcao, avisos de segredo em `project env`, `hub help` completo, demo sem custo (`npm run demo`).

---

## Achados

### [ALTO] Node 22.5-22.12 (piso declarado em `engines`) nao consegue nem rodar `hub help`
**Evidencia:** `package.json` declara `"node": ">=22.5.0"`. `packages/store/src/db.ts:1` faz `import { DatabaseSync } from 'node:sqlite'`, e a CLI importa `@agents-hub/daemon` (-> store) no topo de `packages/cli/src/main.ts`. Comentarios do proprio repo (`store/src/repositories.ts:39`, `scripts/run-tests.mjs:18`) admitem que no 22.5 `node:sqlite` exige `--experimental-sqlite`. Nenhum lugar do caminho do usuario passa a flag: o shim gerado por `npm link` chama `node main.js` puro, e o autostart em `daemon-control.ts` faz `spawn(process.execPath, [entrada, 'daemon'])` sem flag. So `npm run daemon`, `demo-e2e.mjs` e os testes passam `--experimental-sqlite`. (Deduzido do codigo; nao testado por ter so Node 24.)
**Impacto:** quem tem Node 22.5-22.12 (LTS antigo comum) recebe `ERR_UNKNOWN_BUILTIN_MODULE` em qualquer comando `hub`, sem mensagem util. CI so cobre 22.5 via `--test --experimental-sqlite`, o que mascara o problema.
**Correcao sugerida:** ou subir o piso para `>=22.13` (sqlite sem flag), ou re-executar o proprio processo com a flag; adicionar checagem de versao com mensagem clara no inicio de `main.ts` (antes dos imports estaticos, via import dinamico).
**Esforco:** P

### [ALTO] Nao ha empacotamento nem instalacao fora do clone (paths presos ao repositorio)
**Evidencia:** todos os pacotes `"private": true`, sem `LICENSE`, sem `files`/`publishConfig`. `packages/daemon/src/config.ts:76-108`: `repoRoot()` sobe tres niveis a partir de `dist/` e dele derivam `manifests/`, `packages/web/dist` (painel) e `packages/cli/dist/main.js` (hook do Codex). `hub mcp` grava no `.mcp.json`/config dos agentes o caminho absoluto `...\Agents-Hub\packages\mcp\dist\main.js` (visto em `hub mcp`, linha "MCP server:"). O README documenta `npx agents-hub-mcp` em `docs/09` (AGENTS_HUB_URL), mas o pacote nao e publicavel/instalavel.
**Impacto:** mover/recolonar/rebuildar o repo quebra silenciosamente as configs MCP e hooks ja gravadas nos CLIs dos agentes (apontam para caminho antigo); nao ha `npm i -g agents-hub`, instalador, nem binario; `npm link` em Windows depende do prefixo global estar no PATH (nao documentado). Sem LICENSE o projeto nao pode ser adotado por terceiros.
**Correcao sugerida:** publicar um pacote unico `agents-hub` (bundle com manifests + web dist embutidos; resolver por `import.meta.url` do pacote instalado); `hub mcp install` deve gravar `npx -y agents-hub mcp` ou `hub mcp-serve` (comando estavel no PATH) em vez de caminho absoluto; adicionar LICENSE; `hub doctor` deve detectar config MCP/hook apontando para caminho inexistente.
**Esforco:** G

### [ALTO] `hub watch <id-inexistente>` trava para sempre, sem erro
**Evidencia:** testado: `hub watch zzz` ficou pendurado ate o timeout (o comando de teste estourou 120s e um segundo com `timeout 20` retornou sem nenhuma saida). `watch()` em `main.ts:883-891` nao valida a existencia da sessao antes de `client.stream`. Relacionado: `hub budget abc` responde sucesso com barra 0% e "US$ 0.0000 / 5.00" para raiz inexistente; `hub graph zzz` diz "nenhuma sessao neste fluxo".
**Impacto:** typo no id vira terminal congelado, e o usuario novo acha que o Hub travou; budget/graph inexistentes parecem "vazio" em vez de "nao encontrado".
**Correcao sugerida:** `watch`/`budget`/`graph`/`send` chamam `client.session(id)` primeiro e mostram `SESSION_NOT_FOUND` com dica `hub sessions`; ou o daemon retorna 404 nas rotas de budget/graph de raiz desconhecida.
**Esforco:** P

### [MEDIO] `hub start` a partir de subpasta de projeto ja registrado falha com PROJECT_FOLDER_CONFLICT
**Evidencia:** testado: com `emptygit` registrado, `cd emptygit/sub; hub project add` -> `[PROJECT_FOLDER_CONFLICT] ... esta DENTRO de ... ja registrada`. `resolveProjectId` (`main.ts:807-815`) compara `p.path === target` e cai em `addProject`, entao `hub start` na subpasta (uso muito comum, ex.: `cd src`) falha com esse erro em vez de resolver para o projeto-pai. O mesmo vale para diretorios com casing diferente no Windows (comparacao case-sensitive de string).
**Impacto:** primeiro atrito real de quem trabalha em monorepo/subpasta; mensagem e boa mas o comando deveria "simplesmente funcionar".
**Correcao sugerida:** resolver o projeto por prefixo (normalizando casing/`git rev-parse --show-toplevel`) e passar o subdir como `cwd`/escopo.
**Esforco:** P

### [MEDIO] Repositorio git sem commits: erro cru do git
**Evidencia:** testado: `git init` vazio + `hub start` -> `[ILLEGAL_STATE] Falha ao criar worktree: Command failed: git worktree add -b hub/ses_... HEAD  fatal: invalid reference: HEAD`. Nao ha dica ("faca um commit inicial").
**Impacto:** cenario tipico de "projeto novo" (git init recem-feito); mensagem confunde.
**Correcao sugerida:** em `worktree.ts`, antes de `worktree add`, checar `rev-parse --verify HEAD` e lancar erro acionavel; considerar `--isolation none` sugerido.
**Esforco:** P

### [MEDIO] Objetivo curto e rejeitado (`min(8)`), e a validacao de agente vem depois
**Evidencia:** testado: `hub start --agent claude "teste"` -> `[INVALID_BRIEF] ... objective: o objetivo precisa ser descritivo` (`core/src/brief.ts:51`, `.min(8)`). `--agent nope` com objetivo curto reclama do objetivo, nao do agente inexistente; so com objetivo valido vem `[AGENT_NOT_FOUND] Agente "nope" nao registrado` (sem listar os agentes validos).
**Impacto:** primeiro teste do usuario ("oi", "teste", "ls") e barrado por regra de qualidade arbitraria; erro de agente nao lista `hub agents`.
**Correcao sugerida:** baixar o minimo (1-3) ou avisar em vez de recusar; `AGENT_NOT_FOUND` deve listar os ids validos e sugerir `hub doctor`.
**Esforco:** P

### [MEDIO] `AGENTS_HUB_PORT` e ignorada pelo cliente da CLI
**Evidencia:** `docs/09-variaveis-de-ambiente.md` diz que a variavel vale para `hub daemon`/autostart. `main.ts:183` faz `loadConfig()` sem overrides e cria `HubClient(baseUrl(config))`; so `runDaemon()` aplica `resolveDaemonOverrides`. Testado: com `AGENTS_HUB_PORT=48210` e `config.json` porta 48209, `hub mcp` mostrou `daemon: http://127.0.0.1:48209`. Em `withDaemon` o mesmo `loadConfig()` e usado.
**Impacto:** com a variavel definida, o autostart sobe o daemon na porta da variavel e a CLI fica sondando a porta padrao por 30s, terminando em "o daemon nao respondeu a tempo" (deduzido do codigo). A porta do MCP gravado nos agentes tambem sai errada.
**Correcao sugerida:** aplicar `resolveDaemonOverrides(readHubEnv())` em `main()` e em `withDaemon`/`mcpCommand`.
**Esforco:** P

### [MEDIO] `ExperimentalWarning: SQLite` em todo comando, ate `hub help`
**Evidencia:** testado em Node 24.14: cada execucao (help, status, comando desconhecido) imprime `(node:NNN) ExperimentalWarning: SQLite is an experimental feature...` + `(Use node --trace-warnings ...)` no stderr, porque a CLI importa o daemon/store estaticamente so para ler config.
**Impacto:** ruido em toda saida, parece defeito; atrapalha scripts que capturam stderr. Tambem deixa a CLI lenta para comandos simples (carrega sqlite/daemon inteiro).
**Correcao sugerida:** `process.removeAllListeners('warning')`/filtro para esse aviso especifico, ou separar `config` do pacote daemon para a CLI nao carregar sqlite (import dinamico so em `hub daemon`).
**Esforco:** P

### [MEDIO] Nao ha onboarding: sem `hub init`/wizard; `doctor`, `discover` e painel nao se conversam
**Evidencia:** `HELP` (`main.ts:96-179`) nao tem `init`, `setup`, `open`, `logs`, `update`, `version`, `export`. `hub --version` retorna "comando desconhecido" (testado; e imprime o HELP inteiro para qualquer comando desconhecido). O daemon reporta `version: '0.1.0'` fixo em `server.ts:193`. `hub doctor` diz "Autenticacao nao e verificada aqui" enquanto `hub discover` (recem-adicionado) JA mostra auth por agente (`presente`/`?`), modelo padrao, MCP e instrucoes: a informacao existe mas `doctor` e `status` nao a usam. O README so apresenta `discover/import` numa secao propria depois do "Comecando"; nao ha linha na jornada que diga "rode discover, depois import, depois mcp install, depois hooks install". Na Web, `DiscoveryPanel` so existe dentro de `SettingsView` e exige um projeto selecionado (`SettingsView.tsx:236`: "Nenhum projeto cadastrado. Estas configuracoes vivem dentro de um projeto"); nao ha tela de boas-vindas na primeira abertura (empty states so no DAG e na Timeline). `hub discover` na CLI nao passa `projectDir`, entao avisa "MCP de escopo de projeto (.mcp.json) nao foi lido" para claude/openclaude (testado).
**Impacto:** o modo "usar CLIs existentes" e funcional mas fica escondido: quem recem-instalou nao descobre que da para reaproveitar MCP/instrucoes, nem que precisa de `hooks install` para ter prevencao real (o README so diz isso na secao Seguranca, lida depois de `start`).
**Correcao sugerida:** `hub init` (ou `hub setup`) interativo: doctor + discover + oferta de `project add`, `mcp install`, `hooks install` (sempre dry-run primeiro) + link do painel; `hub doctor` incorporar auth/versao do discover; `hub status` mostrar URL do painel e se os hooks/MCP estao instalados; painel com tela de primeiro uso quando `projects.length === 0` (detectar agentes -> registrar projeto -> primeira sessao); `discover` passar `projectDir` = cwd.
**Esforco:** M

### [MEDIO] Sem `hub logs`, sem reinicio/atualizacao, sem autostart no login
**Evidencia:** logs do daemon existem em `~/.agents-hub/logs/daemon-DATA.log` (`daemon-control.ts`) mas a unica pista e a mensagem de falha do autostart; nenhum comando os lista/segue. Nao existe `hub restart`: o daemon sobrevive ao terminal (detached), entao apos `git pull && npm run build` o usuario continua rodando codigo antigo ate `hub stop` (que tambem encerra sessoes vivas). Nao ha comando de atualizacao nem checagem de versao. Nao ha registro de inicio no login (Task Scheduler/Startup no Windows, launchd/systemd), entao apos reboot o painel/aprovacoes so voltam quando algum comando `hub` roda. O arquivo de log diario nao tem rotacao/retencao (append por dia, sem limpeza; so ha retencao de worktree e raw_json).
**Impacto:** depuracao depende de saber o caminho; upgrades silenciosamente ineficazes; aprovacoes pendentes nao aparecem ate voltar ao terminal.
**Correcao sugerida:** `hub logs [-f] [--daemon]`, `hub restart` (stop gracioso + start, opcionalmente preservando sessoes), `hub open` (abre o painel), `hub autostart enable/disable`, e `hub update`/aviso de versao; rotacao de logs.
**Esforco:** M

### [MEDIO] Defaults: `hub start` sem `--mode` usa `semi` (Claude/Codex/OpenCode/Cursor/OpenClaude) e politica com `exec: allow`; nao ha aviso na primeira execucao
**Evidencia:** `manifests/*.yaml` `defaults.supervision`: `semi` em 5 agentes e `supervised` nos outros 4. `DEFAULT_POLICY.risk` (`core/src/policy.ts:324+`): `read/write/exec: allow`, so `escalate/budget/irreversible: approve`; `defaultBudget` US$5/2M tokens/1h, aplicado sem o usuario pedir (o README mostra `--budget-usd` opcional). O README ja explica a decisao (so o irreversivel interrompe), e o Claude nunca usa `bypassPermissions`. Mas o gate pre-execucao (a unica prevencao real) exige `hub hooks install claude --write` manual; sem isso, `git push` so gera "vigilancia" (aprovacao posterior, `alreadyExecuted`). Isso esta descrito no README, porem so na secao Seguranca.
**Impacto:** o default surpreendente e que a primeira sessao de Claude/Codex roda sem prevencao real do irreversivel ate o usuario instalar o hook; nada na saida de `hub start` diz "gate nao instalado" (o `hub hooks` mostra `○ nao instalado`, mas so se o usuario o rodar).
**Correcao sugerida:** `hub start` (e `hub status`) avisar em uma linha quando o gate pre-execucao do agente escolhido nao esta instalado; `hub init` oferecer instalar; deixar `--mode` visivel na saida de `start` ("modo: semi, teto US$5").
**Esforco:** P

### [BAIXO] Aviso de "daemon" nao orienta o Windows/terminal bloqueante
**Evidencia:** com NO_AUTOSTART a mensagem manda "Rode: hub daemon", que ocupa o terminal (primeiro plano). Para o usuario comum (autostart ligado) a saida "subindo o daemon..." e boa. README nao lista pre-requisitos (Node >=22.5, git no PATH, pelo menos um CLI de agente logado, e no Windows PATH global do npm), nem cita que `npm link --workspace @agents-hub/cli` cria o shim `hub.cmd`.
**Correcao sugerida:** secao "Requisitos" no README + verificacao de `git --version` no `hub doctor`.
**Esforco:** P

### [BAIXO] `hub doctor` marca `opencode` como instalado com "versao desconhecida" e `--smoke` e o unico teste de auth
**Evidencia:** `hub doctor` testado: `opencode  versao desconhecida`. Auth so pode ser verificada via `--smoke` (gasta tokens) ou `discover` (presenca de credencial, sem validar).
**Correcao sugerida:** unificar `doctor`+`discover`; documentar que "auth presente" nao e "auth valida".
**Esforco:** P

### [BAIXO] Aprovacao nao e visivel para quem nao esta olhando o terminal
**Evidencia:** aprovacao pendente so aparece em `hub approvals`, no painel (`Approvals.tsx`) ou como aviso dentro de `hub start`/`watch`. Nao ha notificacao (toast do SO, som, webhook, e-mail) nem `hub approvals --watch`. `hub approve <id>` exige copiar o id (nao ha `hub approve --last`/interativo).
**Correcao sugerida:** notificacao nativa opcional; `hub approve` sem id interativo.
**Esforco:** M

---

## O que um "MVP 100% completo de todas as funcionalidades" ainda precisa e NAO existe (verificado por ausencia no HELP, no roteador de `server.ts` e no roadmap)

Distribuicao e ciclo de vida
- Pacote publicavel (npm/instalador/binario unico), LICENSE, versionamento real (`--version`, `/health` com versao do build), canal de atualizacao e `hub update`.
- `hub init`/wizard, `hub open`, `hub logs`, `hub restart`, autostart no login, rotacao de logs.
- Desinstalacao/limpeza: `hub uninstall` (remover hooks/MCP gravados nos CLIs, `~/.agents-hub`).
- Backup/exportacao/importacao do banco `hub.db` e da config.

Sessao e relatorios
- Exportar sessao/fluxo (transcript, timeline, custo, diff) para arquivo (markdown/JSON/HTML); `hub artifacts` lista, mas nao ha `hub export` nem download no painel (nenhuma ocorrencia de export/download em `packages/web/src`).
- Relatorio de custo por periodo/projeto/agente (historico agregado); alertas por e-mail/webhook.
- Merge/aplicacao do resultado: `hub diff` mostra, mas nao ha `hub merge/apply/accept` do branch `hub/<sessionId>` (o worktree expira em 7 dias; o branch fica).
- Busca/filtro no historico de sessoes; `hub sessions` mostra so as 40 primeiras sem paginacao.

Funcionalidades do roadmap ainda abertas (`docs/02-roadmap.md`, itens `[ ]`)
- Isolamento por container (`isolation: container` e recusado com ILLEGAL_STATE; a CLI aceita `--isolation container` mesmo assim).
- Gate pre-execucao para os demais agentes (so Claude e Codex tem prevencao real).
- Mapper dedicado de Cursor e MiMo (sessao nativa/retomada nao funciona neles; ver doc 07 secao 2.1).
- ACP (Zed/JetBrains/Neovim); TUI.
- Motor de workflows: doc 07 apontava que a execucao ignorava dependencias (verificar estado atual antes de tratar como fechado).
- Handoff nunca exercitado fora de teste unitario (doc 07).

Seguranca/operacao multiusuario
- Autenticacao do painel/API (hoje so guarda de borda loopback+Origin+JSON; qualquer processo local dirige o Hub).
- Modo remoto/equipe (uma instancia compartilhada), permissoes por usuario.
- Notificacoes de aprovacao (SO/mobile).

Qualidade da CLI
- Autocompletar de shell, saida `--json` uniforme nos comandos (so `discover` e `doctor --smoke` tratam), codigos de saida documentados, ajuda por subcomando (`hub start --help` imprime o HELP geral).
- `hub start` sem terminal interativo/`--wait` com exit code refletindo o estado final da tarefa (util em CI/scripts).

## Resumo executivo
A jornada base funciona sem cerimonia (autostart, doctor, discover, projeto auto-registrado, aprovacoes, custo). Os bloqueios de adocao sao: (1) nao e instalavel fora do clone e as configs gravadas nos CLIs apontam para caminho absoluto do repo; (2) Node 22.5-22.12, declarado suportado, falha por sqlite sem flag; (3) inexistencia de onboarding/`init`, `logs`, `restart`, `open`, `version`, `update`; (4) `hub watch` em id inexistente trava; (5) atritos pequenos de primeira execucao (objetivo min 8 chars, repo sem commit, subpasta de projeto, AGENTS_HUB_PORT ignorada pela CLI, ExperimentalWarning em todo comando). O modo "usar CLIs existentes" (discover/import) esta correto e seguro, mas nao esta conectado a `doctor`, `status`, ao README da jornada nem a uma tela de primeiro uso no painel (so vive em Configuracoes, exige projeto).
