# Especificação 03 — CLI `hub` e MCP server

> Extraída do código TypeScript em 2026-09-30 (main @ 82f40cc), para a reescrita
> em C (ADR 07, decisões 7.4, 7.7 e 7.10). Descreve **o que o código TS faz hoje**,
> não o que deveria fazer. Toda afirmação traz `arquivo:linha`; caminhos relativos
> à raiz do repositório. Onde o código não permite concluir, está marcado
> **NÃO DETERMINADO**.

## Contagem

**CLI: 46 comandos de topo, mais `help`.** São os 45 `case` do `switch` de
`packages/cli/src/main.ts:104-231` mais `version`, tratado antes do `switch`
(`packages/cli/src/main.ts:73`). Como contei:

- `grep -o "case '...'"` em `main.ts:104-228` dá 45 nomes distintos (`hook`
  aparece também no atalho de `main.ts:71`; `merge` e `apply` são dois `case`
  para a mesma função, `main.ts:220-222`).
- `grep "^  hub <nome>"` no texto de ajuda (`packages/cli/src/ajuda.ts:10-120` +
  `packages/cli/src/lifecycle-help.ts:7-36`) dá 46 nomes: os 45 do `switch` + `version`.
- Conferido na saída real de `hub help` (build em `packages/cli/dist`, home
  temporário, porta 48999, `AGENTS_HUB_NO_AUTOSTART=1`): 46 nomes distintos.
- `help`, `--help` e `-h` são atalhos de ajuda (`main.ts:237`), não comandos
  com efeito. `--version` e `-v` são atendidos por `bin.ts` antes de `main.ts`
  (`packages/cli/src/bin.ts:49-52`).

Subcomandos: `autostart` (4: `status`, `enable`, `disable`, `run`), `hooks` (1:
`install`), `mcp` (2: `show`, `install`), `project` (6: `add`, `env`, `prompt`,
`folders` [+`remove`], `trust`, `untrust`), `policy` (6: `show`, `set`, `unset`,
`allow`, `deny`, `mode`, `packages/cli/src/policy-cmd.ts:36-69`; `allow`/`deny` com `add`/`rm`), `workflow` (3:
`validate`, `run`, `help`).

**MCP: 16 tools.** `grep -c "server.registerTool("` em
`packages/mcp/src/server.ts` = 16 (linhas 113–746). Bate com a decisão 7.4 do ADR 07.

---

## Parte 1 — CLI `hub`

### 1.1 Entrada, processo e parser

**Duas entradas.** `bin.ts` é o executável; `main.ts` é carregado por `import()`
dinâmico (`packages/cli/src/bin.ts:76`).

`bin.ts`, nesta ordem:

1. `argv[0]` = `--version` ou `-v`: imprime só a versão do `package.json` e sai
   (`bin.ts:49-52`). Não passa por `main.ts`.
2. Node abaixo de 22.5: `hub: o Agents-Hub precisa do Node 22.5.0 ou mais novo (este é …)`, saída 1 (`bin.ts:54-61`; piso em `packages/cli/src/node-runtime.ts:15`).
3. `argv[0]` = `hook`: vai direto para `hook-run.ts`, sem carregar daemon nem
   `node:sqlite` (`bin.ts:65-69`). Ver 1.5.
4. Node 22.5–22.12 ou 23.0–23.3 sem `--experimental-sqlite`: reexecuta o mesmo
   Node com a flag e herda o código de saída do filho (`bin.ts:71-74`, `bin.ts:88-110`; regra em `node-runtime.ts:35-42`). Específico de Node; sem equivalente no C.
5. Erro não tratado: `hub: <mensagem>` no stderr, saída 1. Com `code`, só
   `[CODE] mensagem`; sem `code`, o stack (`bin.ts:112-117`, `node-runtime.ts:99-108`).

`main.ts`, antes do `switch`:

- `hook` → `runHook` (`main.ts:71`; só alcançado por instalações antigas que
  chamam `main.js … hook`, ver `packages/daemon/src/hooks-config.ts:51-53`).
- `--version`, `-v`, `version` → `versionCommand` com cliente sem token; config
  quebrada não impede (`main.ts:73-82`).
- Pedido de ajuda → ajuda, antes de `loadConfig` (`main.ts:85`). Ver 1.3.
- `doctor` valida o `config.json` antes de `loadConfig`; inválido → saída 1
  (`main.ts:89-92`).
- `loadConfig()`; cliente com token de operador lido de
  `<home>/operator-token` a cada requisição (`main.ts:93-97`;
  `packages/client/src/operator-token.ts:17-30`). O token vai como
  `Authorization: Bearer <token>` (`packages/client/src/index.ts:109-112`).
- `--json` num comando de `JSON_COMMANDS` → `jsonCommand` (`main.ts:100-102`). Ver 1.4.

**Parser** (`packages/cli/src/args.ts:46-85`):

- Primeiro token = comando; ausente → `help` (`args.ts:47`).
- `--` encerra as flags; o resto é posicional (`args.ts:53-56`).
- `--chave=valor` sempre vira string (`args.ts:63-67`).
- Flags booleanas declaradas não consomem o próximo token (`args.ts:13-38`):
  `detach, json, force, help, quiet, write, smoke, clear, overwrite,
  include-env, refresh, yes, follow, dry-run, list, print, check, all, raw,
  no-bell, verbose`.
- Outra `--chave`: consome o próximo token se ele não começar com `--`; senão
  vale `true` (`args.ts:75-81`).
- Token com um só `-` (ex.: `-n`) é posicional. Só `-h` como primeiro posicional
  conta como ajuda (`main.ts:244`).

**Cor.** ANSI só quando stdout é TTY e `NO_COLOR` não está definida
(`packages/cli/src/render.ts:5`).

### 1.2 Erros e códigos de saída

**Formato único de erro** (`packages/cli/src/erro-cli.ts:66-102`), no stderr:

```
hub: [CODIGO] mensagem          (CODIGO só se o erro tiver code /^[A-Z][A-Z0-9_]*$/)
  - campo: problema             (um por item de details.issues)
uso:                            (só em erro de uso)
<linhas do help do comando>
veja: hub <cmd> --help
```

Todo erro que passa por `mostrarErro` sai com **código 1**
(`erro-cli.ts:101`). O código 2 é reservado para "parada esperando aprovação"
em `start`/`watch`/`send` (`erro-cli.ts:16-19`;
`packages/cli/src/session-follow.ts:83-93`).

Bordas de erro:

- `withDaemon(fn)` (`main.ts:424-448`): garante o daemon (1.6) e roda `fn`.
  Mensagem com `ECONNREFUSED` ou `fetch failed` durante `fn` → `o daemon caiu no meio da operação. veja: hub daemon`, saída 1. Outro erro → `mostrarErro`.
- `comErro(fn)` (`packages/cli/src/cmd-util.ts:53-59`): mesmo formato, sem subir daemon.
- Comando desconhecido: `hub: comando desconhecido: <cmd>` no stderr, help
  inteiro no stdout, saída 1 (`main.ts:228-231`).
- Argumento obrigatório ausente: `argumento obrigatório ausente: <nome>` como
  erro de uso (`cmd-util.ts:23-28`).
- Erro HTTP do daemon vira `HubApiError(message, code, status, details)`; sem
  `error.code` no corpo, o code é o status HTTP em texto. Corpo não-JSON →
  code `RESPOSTA_NAO_JSON` (`packages/client/src/index.ts:610-647`).
- Id malformado é recusado antes da requisição, code `INVALID_ID`
  (`packages/client/src/ids.ts:50-69`). Formatos aceitos (`ids.ts:21-29`):
  `ses_`, `tsk_`, `apv_`, `prj_` e `wfr_` + 1–60 alfanuméricos
  (`/^<prefixo>_[a-z0-9]{1,60}$/i`, `ids.ts:22-25`, `:28`); `pfd_` segue
  `/^pfd_(?:prj_)?[a-z0-9]{1,56}$/i` (`ids.ts:26`).

Alguns comandos imprimem erro fora desse formato (sem prefixo `hub:`), sempre
com saída 1: `start` (`packages/cli/src/start-cmd.ts:129-133`), `import`
(`packages/cli/src/discover-cmd.ts:191-195`), `autostart` com subcomando
inválido (`packages/cli/src/autostart-cmd.ts:157-161`), `send` sem texto
(`session-follow.ts:497-501`), `workflow` (`packages/cli/src/workflow-cmd.ts:68-79`, `:179-180`).

### 1.3 Ajuda

- `hub help`, `hub --help`, `hub -h` → help inteiro (`main.ts:237-268`).
- `hub help <cmd>`, `hub <cmd> --help`, `hub <cmd> -h` → só as linhas do help
  que começam com `hub <cmd>` e suas continuações mais indentadas
  (`packages/cli/src/ajuda.ts:127-150`). Sem linhas: aviso no stderr e help inteiro (`main.ts:259-265`).
- Config inválida não impede a ajuda: aviso no stderr, saída 0 (`main.ts:249-256`).
- `workflow` é exceção: tem ajuda própria em `workflow-cmd.ts:51-65` e **não**
  passa por `pedeAjuda` (`main.ts:243`).
- Efeito colateral observado: `hub help` chama `loadConfig()`
  (`main.ts:250`), que cria `logs`, `artifacts` e `worktrees` no home (visto no
  home temporário do teste; `mkdirSync` em `packages/daemon/src/config.ts:355`).

### 1.4 `--json`

`JSON_COMMANDS` = `status, health, sessions, projects, agents, approvals,
budget, graph, doctor` (`packages/cli/src/json-cmd.ts:15-25`). Com `--json`,
só `JSON.stringify(valor, null, 2)` no stdout (`cmd-util.ts:62-64`).
Mensagem de autostart vai para o stderr (`packages/cli/src/daemon-control.ts:50-52`).

| Comando | Saída `--json` | Onde |
|---|---|---|
| `status` | `{daemon:{ok,version,url,home}, agents:{total,available[]}, sessions:{total,live[]}, approvals:{pending,items[]}}`; `live` = estados `running`/`waiting_approval` | `json-cmd.ts:37-54` |
| `health` | corpo de `GET /health` | `json-cmd.ts:55-56` |
| `sessions`, `projects`, `agents`, `approvals` | corpo da rota, sem filtro | `json-cmd.ts:57-64` |
| `budget <rootId>` | corpo de `GET /budget/:rootId` | `json-cmd.ts:65-66` |
| `graph <rootId>` | `{graph, totalUsd}` | `json-cmd.ts:67-70` |
| `doctor` | `{probes, installed, total, loginHints, hookWarnings[]}`; com `--smoke` → erro `--smoke não aceita --json …` | `json-cmd.ts:71-92` |

Comandos com `--json` próprio (fora de `JSON_COMMANDS`): `discover`, `import`,
`policy show`, `audit`, `cost`, `update`, `version`, `backup`, `restore --write`
(ver cada um). O help (`lifecycle-help.ts:34-35`) lista `discover`, `policy show`,
`audit`, `cost`, `update`, `version` e `backup`; **não** cita `import` nem
`restore`, embora as duas aceitem `--json` (`packages/cli/src/discover-cmd.ts:201`,
`packages/cli/src/backup-cmd.ts:87`).

`graph`/`budget` com `--json` **não** trocam sessão filha pela raiz (chamam a
rota direto, `json-cmd.ts:65-70`); sem `--json`, trocam (1.8).

### 1.5 `hub hook` — o gate pré-execução

**Uso interno: o agente chama, não a pessoa.** Lê um JSON do stdin, pergunta ao
daemon e responde no dialeto do agente. Pela entrada normal (`bin.ts:65-69`)
não usa o parser geral: só `--chave valor`/`--chave=valor`
(`packages/cli/src/hook-run.ts:16-35`). O atalho legado de `main.ts:71`
(instalações que chamam `main.js … hook`) recebe as flags já processadas por
`parseArgs` (`main.ts:65`).

Flags:

| Flag | Tipo | Padrão | Efeito |
|---|---|---|---|
| `--dialect` | `codex` ou outro | `claude` | Só o valor exato `codex` muda o dialeto (`hook-run.ts:46`). |
| `--session` | string | `AGENTS_HUB_SESSION_ID` | Id da sessão do Hub; Codex passa aqui porque só repassa `CODEX_*` ao hook (`hook-run.ts:79-81`; `packages/cli/src/hook.ts:42-44`). |

Entrada (stdin, `hook.ts:49-56`): `{session_id?, cwd?, tool_name?, tool_input?, tool_use_id?}`.
stdin vazio ou ilegível vira `{}` (`hook-run.ts:48-55`).

Fluxo (`hook-run.ts:41-89`, `hook.ts:146-216`):

1. **Caminho rápido.** Leitura que não toca segredo → saída vazia, código 0,
   sem carregar config nem falar com o daemon (`hook-run.ts:59-62`;
   `hook.ts:139-144`; critério `leituraComum` em
   `packages/daemon/src/pretool-gate.ts:131`).
2. Config: tenta `loadConfig()` para URL e `gate.failMode`; se falhar, usa
   `http://127.0.0.1:4747` e modo padrão (`hook-run.ts:67-75`;
   `packages/daemon/src/config.ts:85`, `:233`).
3. Sem `tool_name` → "permitir" com motivo `chamada sem nome de ferramenta` (`hook.ts:153-155`).
4. Sessão do Hub só conta se o id casar `/^ses_[a-z0-9]+$/i` (`hook.ts:128`, `:161-162`).
5. `POST /hooks/pretooluse` com `{sessionId?, nativeSessionId? (=session_id), cwd?, toolUseId? (1–200 chars), toolName, toolInput}`, **sem token** (`hook.ts:167-192`; rota em `packages/client/src/index.ts:401-419`).
6. Teto próprio: `TETO_HTTP_DO_HOOK_MS` = 100 000 ms (`pretool-gate.ts:269`).
   O daemon espera decisão humana até 55 000 ms (`pretool-gate.ts:262`); o
   timeout gravado na config do agente é 120 s (`pretool-gate.ts:272`).
7. Sai com `process.exit(codigo)` assim que escreve (`hook-run.ts:87-88`). O código é **sempre 0** em todos os caminhos de `decideToolCall` (`hook.ts:154`, `:157`, `:194`, `:206`, `:211`).

**Dialetos** (`hook.ts:218-257`):

| Veredito do daemon | Claude (padrão) | Codex |
|---|---|---|
| `allow` | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":<explanation>}}` | saída vazia |
| `ask` | mesmo JSON com `"ask"` | JSON de `deny` |
| `escalate` (nome antigo) | traduzido para `"ask"` | JSON de `deny` |
| `deny` | JSON com `"deny"` | mesmo JSON com `"deny"` |

**Modo de falha** — quando o daemon não responde, erra, devolve lixo ou estoura
o teto (`hook.ts:195-212`):

- Modo efetivo = `gate.failMode` da config, senão **fechado** em sessão do Hub e
  **aberto** fora dela (`hook.ts:102-107`).
- Fechado + chamada de risco → `deny` com o texto `Agents-Hub não deu um veredito (<erro>) e o gate desta sessão falha FECHADO: …`. "Risco" = qualquer ação que não seja `file.read`, leitura de segredo, ou `tool_input` que não é objeto (`hook.ts:118-126`).
- Caso contrário → "permitir" com motivo `Agents-Hub indisponível — sem política a aplicar` (Claude: JSON `allow`; Codex: vazio).

Quem gera a linha de comando do hook:

- Claude/OpenClaude, instalado pela pessoa: `"<node>" "<…/cli/dist/bin.js>" hook`
  (`packages/daemon/src/hooks-config.ts:115-117`; `packages/cli/src/hooks-install.ts:46-52`).
- Codex, montado pelo daemon a cada spawn: `<node> <bin.js> hook --dialect codex --session <sessionId>` (`packages/daemon/src/session-manager.ts:2398`).

### 1.6 Autostart sob demanda (`ensureDaemon`) e `AGENTS_HUB_NO_AUTOSTART`

**Todo comando que passa por `withDaemon` sobe o daemon se ele não responder.**
Código em `packages/cli/src/daemon-control.ts:30-108`:

1. `GET /health` responde → `'ja-estava'` (`daemon-control.ts:34`, `:115-122`).
2. `AGENTS_HUB_NO_AUTOSTART=1` → erro (saída 1): `daemon não está rodando e AGENTS_HUB_NO_AUTOSTART=1 impede subir sozinho. Suba-o num terminal à parte com `hub daemon` …, ou tire AGENTS_HUB_NO_AUTOSTART …; para subir no login do Windows: `hub autostart enable`.` (`daemon-control.ts:38-48`). A variável só aceita `0` ou `1`; outro valor é recusado com o nome dela (`packages/core/src/hub-env.ts:30`, `:72-78`).
3. Sem `quiet`: `subindo o daemon…` no stderr (`daemon-control.ts:50-52`).
4. Spawn desacoplado de `<node> [--experimental-sqlite] <bin.js> daemon`, janela
   oculta, stdout+stderr em append em `<logDir>/daemon-AAAA-MM-DD.log` (data
   UTC de `toISOString`) (`daemon-control.ts:57`, `:72-90`, `:111-113`).
   `logDir` padrão = `<home>/logs` (`config.ts:319`).
5. Poll de `/health` a cada 300 ms por até 30 000 ms → `'iniciado'`; senão erro
   `o daemon não respondeu a tempo. O que ele escreveu está em <arquivo> — ou rode `hub daemon` num terminal para ver ao vivo.` (`daemon-control.ts:98-107`).

Sobem o daemon: todos os comandos em `withDaemon`, mais `init` e `restart` (via
`ensureDaemon` injetado, `main.ts:200-213`) e `autostart run`.
**Não** sobem: `help`, `version`, `hook`, `hooks`, `mcp`, `stop`, `logs`,
`update`, `backup`, `restore`, `autostart status|enable|disable`, `daemon`
(`main.ts:105-227`).

### 1.7 Endereço, porta e variáveis lidas pela CLI

- Base URL = `http://<host>:<port>` (`config.ts:399`); padrão `127.0.0.1:4747`
  (`config.ts:321-322`), sobrescrito por `AGENTS_HUB_PORT` ou `port` no `config.json`.
- Variáveis validadas por `readHubEnv` (`hub-env.ts:19-52`): `AGENTS_HUB_HOME`,
  `AGENTS_HUB_PORT` (inteiro 1–65535), `AGENTS_HUB_NO_AUTOSTART` (`0`|`1`).
  Valor inválido → `HubError HUB_CONFIG_INVALID` `variável de ambiente inválida — …` (`hub-env.ts:72-78`).
- Lidas cruas pela CLI: `AGENTS_HUB_SESSION_ID` (hook, `hook-run.ts:81`),
  `AGENTS_HUB_HOME` (arquivo do token, `packages/client/src/operator-token.ts:18`), `NO_COLOR`
  (`render.ts:5`), `APPDATA` (autostart, `autostart-cmd.ts:42`).

### 1.8 Referência de comandos

Legenda: **D** = passa por `withDaemon` (sobe o daemon); **T** = o cliente manda
token de operador (todos os comandos, exceto `hook` e `version`, `main.ts:97`).
Rotas pelo `HubClient` (`packages/client/src/index.ts`).

#### Daemon e ciclo de vida

| Comando | Args/flags | Rotas | Saída e código | Fonte |
|---|---|---|---|---|
| `hub daemon` | — | nenhuma (é o servidor) | Primeiro plano. Imprime `daemon ouvindo em <url>`, `painel: <url>`, `home:`, `agentes:`. `AGENTS_HUB_PORT` respeitada. Porta ocupada por outro Hub → `[DAEMON_ALREADY_RUNNING] já há um daemon em <url> — …`; por outro programa → `[PORT_IN_USE] …` (sonda `GET /health` com teto de 1500 ms). SIGINT/SIGTERM → encerra sessões. | `packages/cli/src/daemon-run.ts:21-93`, `main.ts:105-106` |
| `hub stop` | — | `POST /shutdown` | `daemon encerrado`; conexão recusada → `o daemon já não estava rodando.` (saída 0). Não sobe daemon. | `main.ts:704-716`, `index.ts:422-424` |
| `hub status` | `--json` | `GET /health`, `/agents`, `/sessions`, `/approvals`, `/discovery` | Daemon, agentes utilizáveis/quebrados, até 8 sessões vivas, aprovações pendentes. Descoberta falha em silêncio. D | `packages/cli/src/doctor-cmd.ts:503-548` |
| `hub health` | `--json` | `GET /health` | JSON indentado com ou sem `--json`. D | `main.ts:120-123` |
| `hub restart` | `--force` (bool) | `GET /health`, `POST /shutdown` | Sessões vivas (`health.liveSessions > 0`) sem `--force` → erro `N sessão(ões) viva(s) seriam encerradas pelo reinício. …` (saída 1). Espera o antigo parar (até 20 000 ms, poll 200 ms), sobe com `ensureDaemon`, `daemon reiniciado v<versão>`. Não voltou → `o daemon não voltou. Veja: hub logs`. | `packages/cli/src/restart-cmd.ts:35-71`, `main.ts:212-213` |
| `hub autostart [sub]` | `status` (padrão), `enable`, `disable`, `run` | só `run`: `GET /health` | Ver 1.10. | `autostart-cmd.ts:138-215` |
| `hub version` / `hub --version` / `hub -v` | `--json` | `GET /health` (sem subir daemon) | `version`: `hub <cli>`, `node <ver> · <plataforma>-<arch>`, `daemon: <ver>` ou `daemon: não está rodando`; `--json` → `{cli,node,platform,daemon}`. `--version`/`-v` como primeiro argumento: **só a versão**, `--json` ignorado (atendido por `bin.ts:49-52`). | `packages/cli/src/version-cmd.ts:35-59` |
| `hub update` | `--check`, `--json` | nenhuma | Ver 1.11. Sem daemon. | `packages/cli/src/update-cmd.ts:100-211` |
| `hub init` | `--yes` | `GET /health`, `/discovery`, `/projects`; `POST /projects` | Ver 1.12. | `packages/cli/src/init-cmd.ts:118-269` |
| `hub open` | `--print` | nenhuma além do `/health` do autostart | Abre `<url>` no navegador (`rundll32 url.dll,FileProtocolHandler` no Windows, `open` no macOS, `xdg-open` no resto). `--print` só imprime a URL. Falha ao abrir → imprime a URL, saída 0. D | `packages/cli/src/open-cmd.ts:14-53` |
| `hub logs` | `--lines N` (alias `--n`; inteiro ≥ 0; padrão 50), `--follow`, `--list` | nenhuma | Lê `<logDir>/daemon-AAAA-MM-DD.log` (o mais novo). `--list`: nome e tamanho de cada. `--follow`: poll de 500 ms, troca de arquivo à meia-noite. `--lines` inválido → `--lines inválido: …` (saída 1). Sem daemon. | `packages/cli/src/logs-cmd.ts:13-121` |
| `hub backup` | `--out <arquivo>` (padrão `<home>/backups/<nome>`), `--json` | daemon no ar: `POST /maintenance/backup {out}`; parado: `VACUUM INTO` local | `backup gravado <path>`, KB, schema; `--json` → `{path,bytes,schemaVersion,via:"daemon"|"local"}`. Não sobe daemon. | `packages/cli/src/backup-cmd.ts:30-52`, `index.ts:437-440` |
| `hub restore <arquivo>` | `--write`, `--dry-run`, `--json` | `GET /health` | Daemon no ar → erro `o daemon está rodando — pare antes com `hub stop` …`. Arquivo ausente → `arquivo não encontrado: …`. Sem `--write` (ou com `--dry-run`): prévia. Com `--write`: guarda o atual em `hub.db.pre-restore-<data>` e troca; `--json` → resultado de `restoreDatabase`. | `backup-cmd.ts:60-98` |

#### Gate e MCP (configuração offline)

| Comando | Args/flags | Rotas | Saída | Fonte |
|---|---|---|---|---|
| `hub hook` | `--dialect codex`, `--session <id>` | `POST /hooks/pretooluse` | Ver 1.5. | `hook-run.ts`, `hook.ts` |
| `hub hooks` | — | nenhuma | Estado do gate em cada alvo (claude, openclaude) + linha do Codex (`codexGate.bypassHookTrust`). | `main.ts:291-331` |
| `hub hooks install [alvo]` | alvo `claude` (padrão), `openclaude`, `codex`; `--project <dir>`, `--write` | nenhuma | Ver 1.9. | `main.ts:333-415` |
| `hub mcp` | `--project <dir>` | nenhuma | Caminho do MCP server, URL do daemon e estado do registro em cada um dos 9 alvos. | `main.ts:841-865` |
| `hub mcp show <agente>` | `--project <dir>` | nenhuma | Trecho para colar. | `main.ts:799-808` |
| `hub mcp install <agente>` | `--project <dir>`, `--write` | nenhuma | Ver 1.9. | `main.ts:810-839` |

#### Agentes, descoberta e importação

| Comando | Args/flags | Rotas | Saída | Fonte |
|---|---|---|---|---|
| `hub agents` | `--json` | `GET /agents` | Por agente: instalado (●/○), capabilities, `sessionStrategy`, `streamFormat`, caveats. D | `main.ts:452-464` |
| `hub doctor` | `--smoke`, `--agent <id>` (só com smoke), `--yes`, `--json` | `POST /agents/probe`, `GET /agents`, `GET /discovery?refresh=1`; smoke: `POST /projects`, `POST /sessions`, `GET /sessions/:id/events`, `GET /sessions/:id`, `GET /sessions/:id/tasks`, `POST /sessions/:id/cancel`, `GET /budget/:root` | Primeiro valida o `config.json` (inválido → lista campo/problema/dica, saída 1, sem daemon). Depois veredito por agente: `pronto`, `atencao`, `quebrado`, `ausente`, e avisos de hook antigo. `--smoke`: uma sessão real por agente, em série, `supervised` + `worktree`, teto US$ 0,10, objetivo `responda apenas com a palavra OK`, espera até 90 s (poll 1,5 s), em `<home>/smoke-projeto`; sem TTY e sem `--yes` → recusa (saída 1); algum agente sem `completed` → saída 1. D | `doctor-cmd.ts:64-130`, `:269-314`, `:328-487`; `packages/cli/src/doctor-smoke.ts:41-84` |
| `hub discover` | `--agent <id>`, `--refresh`, `--json` | `GET /discovery[?refresh=1]` ou `GET /discovery/:agentId[?refresh=1]` | Tabela `AGENTE INSTALADO VERSÃO AUTH MODELO PADRÃO MCP INSTRUÇÕES` ou detalhe de um agente; `--json` → array/objeto cru. D | `discover-cmd.ts:99-143`, `:170-183` |
| `hub import <agente>` | `--project <id\|dir>`, `--kinds` (lista de `instructions,env,mcp`, separada por vírgula ou espaço), `--to <a,b>`, `--overwrite`, `--include-env`, `--write`, `--json` | `GET /projects` (+ `POST /projects` se preciso), `POST /projects/:id/import` | Sem `--write` = `dryRun: true`. `--kinds` padrão: `instructions,env`; com `--to`: os três. `mcp` sem `--to` → erro. Kind desconhecido → `kind desconhecido "<x>" (válidos: …)`. Imprime plano/resultado e o comando para aplicar. D | `discover-cmd.ts:26-90`, `:185-216`; `index.ts:147-159` |

#### Projetos

`[projeto]` aceita id `prj_…` ou caminho; sem ele, o diretório atual. Caminho
dentro de um projeto registrado usa esse projeto; pasta fora de todos é
**registrada na hora** (`POST /projects`). Id `prj_…` desconhecido → erro `projeto "<id>" não encontrado — veja os registrados com: hub projects` (`packages/cli/src/project-resolve.ts:84-112`). No Windows a comparação ignora caixa e expande nomes 8.3 (`project-resolve.ts:21-46`).

| Comando | Args/flags | Rotas | Saída | Fonte |
|---|---|---|---|---|
| `hub projects` | `--json` | `GET /projects` | Nome, id, `[confiável]`, caminho. D | `main.ts:466-476` |
| `hub project add [dir]` | dir padrão = cwd | `POST /projects {path}` | `registrado <nome> <id>`. D | `main.ts:502-505` |
| `hub project env [projeto]` | `--agent <id>`, `--set CHAVE=VALOR`, `--unset CHAVE` | `GET /agents` (se `--agent`), `GET /projects/:id/context`, `PUT /projects/:id/context` | Lista por agente com valores mascarados (`****`) quando a chave casa `KEY\|TOKEN\|SECRET\|PASSWORD\|PASSWD\|CREDENTIAL\|AUTH` ou o valor parece credencial. Erros de uso: flag sem valor, `--set` sem `=`, `--set/--unset` sem `--agent`, agente não registrado, `--unset` de chave inexistente. Chave descartada pelo daemon → erro `"<chave>" foi recusada pelo daemon …`. D | `packages/cli/src/project-env-cmd.ts:28-157` |
| `hub project prompt [projeto] --agent <id>` | `--set "texto"` ou `--clear` | `GET`/`PUT /projects/:id/context` | Mostra, grava ou apaga `prompts[agent]`. `--agent` obrigatório; `--set` e `--clear` juntos → erro de uso. D | `main.ts:548-582` |
| `hub project folders [projeto]` | — | `GET /projects/:id/folders` | ● principal / ○ extra, id, caminho, rótulo. D | `main.ts:609-623` |
| `hub project folders remove [projeto] <folderId>` | — | `DELETE /projects/:id/folders/:folderId` | `desvinculada pasta …`. D | `main.ts:593-607` |
| `hub project trust [projeto]` / `untrust` | — | `POST /projects/:id/trust {trusted}` | Lista os campos sensíveis que passam a valer (ou que serão ignorados). D | `main.ts:517-545` |

Sem subcomando ou com subcomando desconhecido → erro de uso (`main.ts:493-498`).

#### Sessões

| Comando | Args/flags | Rotas | Saída e código | Fonte |
|---|---|---|---|---|
| `hub start "objetivo"` | `--agent <id\|cap:x>` (obrigatório), `--project`, `--budget-usd <n>` (número finito > 0), `--mode supervised\|semi\|autonomous`, `--isolation worktree\|none` (padrão `worktree`; `container` recusado), `--detach`, `--from <sessionId>`, `--no-bell`, `--verbose`, `--` | `GET /agents`, `GET /projects` (+`POST /projects`), `POST /sessions {projectId, brief, baseSessionIds?}`, `GET /integrations`, depois SSE `GET /events?rootId=`, `GET /tasks/:id`, `GET /sessions/:id`, `GET /budget/:root`, `GET /approvals?sessionId=` | Validação local na ordem: `--agent`, `--mode`, `--isolation`, `--budget-usd`, `--project` sem valor; depois agente existe (exceto `cap:`), objetivo não vazio, objetivo ≥ 8 caracteres. `--from`: nova sessão com `upstream` e `contextRefs` da anterior e worktree a partir do branch dela. Avisa se o agente ou o modo real diferem do pedido e se falta gate. Com `--detach` sai logo; senão acompanha. **Saída: 0 concluída ou pausada; 2 parada esperando aprovação; 1 falha, cancelamento, rejeição ou desfecho desconhecido.** D | `start-cmd.ts:33-217`; `packages/cli/src/continue-from.ts:25-46`; `session-follow.ts:83-93`, `:130-226` |
| `hub sessions` | `--json` | `GET /sessions` | Até 40, indentadas por profundidade, com estado e hora local. D | `main.ts:626-641` |
| `hub watch <sessionId>` | `--no-bell`, `--verbose` | `GET /sessions/:id`, SSE `GET /events?sessionId=`, vigia (`/tasks/:id`, `/sessions/:id`) | Id inexistente → `[SESSION_NOT_FOUND] sessão "<id>" não encontrada — veja os ids com: hub sessions`. Mesmos códigos de `start`. D | `session-follow.ts:413-429`, `:448-487` |
| `hub watch --root <id>` | idem | idem + `GET /graph/:root` | Id de filha → usa a raiz, com aviso. Fluxo já encerrado → imprime o grafo antes. D | `session-follow.ts:454-473` |
| `hub send <sessionId> "texto"` | `--no-bell`, `--verbose` | `GET /sessions/:id`, `GET /sessions/:id/events?limit=1&tail=1`, `POST /sessions/:id/send {text}`, SSE | Explica o modo (`live`, `resume`, `replay`) e acompanha só o que vem depois. Mesmos códigos. D | `session-follow.ts:489-526` |
| `hub interrupt <sessionId>` | — | `POST /sessions/:id/interrupt` | `interrupted:false` → `nenhum turno em andamento — nada foi interrompido`; senão `turno interrompido — sessão <estado>`. D | `packages/cli/src/interrupt-cmd.ts:23-38` |
| `hub pause <sessionId>` | — | `POST /sessions/:id/pause` | Estado ≠ `paused` → aviso; senão `sessão pausada — …`. D | `packages/cli/src/pause-cmd.ts:19-29` |
| `hub cancel <sessionId>` | — | `POST /sessions/:id/cancel` | `sessão encerrada`. D | `main.ts:148-152` |

Acompanhamento (`start`/`watch`/`send`), `session-follow.ts:130-306`: SSE
filtrado; um vigia consulta a task a cada 1500 ms; o fim é a **task** em
estado terminal (`completed`, `failed`, `canceled`, `rejected`) ou
`input_required`, não o fim do turno. Segue fallback para outra sessão. Sem
processo vivo e task aberta por 600 000 ms → desfecho `unknown`. Stream
encerrado sem desfecho → `unknown`. Em TTY e sem `--no-bell`, `approval.requested`
escreve BEL + OSC 0 com `hub: aprovação pendente <id>` (`packages/cli/src/approval-alert.ts:17-45`).
Sem `--verbose`, esconde `message.delta`, mensagens vazias e `log` técnico
(`render.ts:123-139`).

#### Delegação, resultado e custo

| Comando | Args/flags | Rotas | Saída | Fonte |
|---|---|---|---|---|
| `hub delegate <sessionId> "objetivo"` | `--agent <id\|cap:x>` (obrigatório), `--budget-usd <n>` | `POST /sessions/:id/delegate {brief}` | `delegado para <agente> sessão <id>`. D | `main.ts:643-662` |
| `hub handoff <sessionId>` | `--to <id>` (ou `--agent`), `--reason <texto>` | `POST /sessions/:id/handoff {agentId, reason}` | `✓ Controle da sessão … transferido para o agente "<id>".` D | `main.ts:155-173` |
| `hub diff <sessionId>` | — | `GET /sessions/:id/diff` | Patch colorido; sem diff → `message` do daemon ou `nada a mostrar`. D | `main.ts:665-682` |
| `hub artifacts <sessionId>` | — | `GET /sessions/:id/artifacts` | id, kind, caminho, data. D | `main.ts:690-701` |
| `hub graph <rootId>` | `--json` | `GET /sessions/:id`, `GET /graph/:root` | Árvore e `total do fluxo: US$ …`. D | `session-follow.ts:528-542` |
| `hub budget <rootId>` | `--json` | `GET /sessions/:id`, `GET /budget/:root` | Barra de 30 posições, US$, tokens, segundos; `orçamento esgotado …`. D | `session-follow.ts:548-567` |
| `hub export <sessionId>` | `--format md\|json` (padrão `json` se `--out` termina em `.json`, senão `md`), `--out <arquivo>`, `--raw`, `--force` | `GET /sessions/:id`, `/sessions/:id/tasks`, `/sessions/:id/events?since&limit=5000` (paginado), `/sessions/:id/artifacts`, `/sessions/:id/diff`, `/graph/:root`, `/budget/:root` | Sem `--out` → stdout. Arquivo existente sem `--force` → erro. Sem `--raw`, tira o campo `raw` dos eventos. D | `packages/cli/src/export-cmd.ts:57-212` |
| `hub cost` | `--since <7d\|12h\|30m\|30s\|ISO>` (padrão `7d`), `--all`, `--project <id\|caminho\|nome>`, `--json` | `GET /projects`, `GET /sessions[?projectId=]`, `GET /graph/:root` por raiz | Totais por agente, projeto, dia e 5 fluxos mais caros (JSON: 10). `--project` não registra nada; desconhecido → erro. D | `packages/cli/src/cost-cmd.ts:47-164`; `cmd-util.ts:70-84` |
| `hub merge <sessionId>` / `hub apply <sessionId>` | `--strategy merge\|cherry-pick\|squash` (padrão: `merge` em `merge`, `squash` em `apply`), `--write`, `--dry-run` | `GET /sessions/:id`, `GET /projects`, `GET /sessions/:id/diff`; git local | Prévia sem `--write`. Bloqueios (saída 1): sessão viva, `isolation none`, repo inválido, branch `hub/<id>` em checkout, árvore suja, MERGE/CHERRY_PICK/REBASE pendente, nada a aplicar. Conflito → desfaz e erro. Nunca `push`. D | `packages/cli/src/merge-cmd.ts:13-295` |

#### Aprovações, manutenção, política e auditoria

| Comando | Args/flags | Rotas | Saída | Fonte |
|---|---|---|---|---|
| `hub approvals` | `--json` | `GET /approvals` | Id, risco, se já executou, ação, motivo, sessão. D | `main.ts:720-744` |
| `hub approve <id>` / `hub deny <id>` | — | `POST /approvals/:id {decision}` (exige token) | `aprovada:`/`negada:` + ação. D | `main.ts:746-758`, `index.ts:284-289` |
| `hub prune` | — | `POST /maintenance/sweep` | Examinadas, removidos, no prazo, falhas. D | `main.ts:760-771` |
| `hub policy [show]` | `--project [p]`, `--json` | `GET /policy[?projectId=]` | Camada global, camada do projeto, efetiva. D | `packages/cli/src/policy-cmd.ts:73-119` |
| `hub policy set <campo> <valor>` | `--project [p]` | `GET /policy`, `PUT /policy` ou `PUT /projects/:id/policy` | Valor passa por `JSON.parse` (senão texto). Imprime backup e campos afrouxados/anulados. D | `policy-cmd.ts:39-43`, `:121-150`, `:175-193` |
| `hub policy unset <campo>` | `--project [p]` | idem | Remove o campo e pais vazios. D | `policy-cmd.ts:44-47`, `:196-211` |
| `hub policy allow\|deny add\|rm <prefixo>` | `--project [p]` | idem | Edita `commands.allow`/`commands.deny`. D | `policy-cmd.ts:48-59`, `:161-172` |
| `hub policy mode <risco> <decisão>` | `--project [p]` | idem | Grava `risk.<risco> = <decisão>` (sem validação local). D | `policy-cmd.ts:60-67` |
| `hub audit [sessionId]` | `--session`, `--project [p]`, `--kind`, `--since`, `--until`, `--limit`, `--json` | `GET /projects` (se caminho), `GET /audit?...` | Mais antigo em cima. `--project` não registra; caminho sem projeto → erro. D | `policy-cmd.ts:233-283` |

`policy` com subcomando desconhecido → `subcomando desconhecido: "<x>". Use show, set, unset, allow, deny ou mode.` (`policy-cmd.ts:68-69`).

#### Workflows

| Comando | Args/flags | Rotas | Saída | Fonte |
|---|---|---|---|---|
| `hub workflow` / `help` / `--help` | — | — | Ajuda própria. | `workflow-cmd.ts:51-65` |
| `hub workflow validate <arquivo>` | — | nenhuma: validação **local** (YAML + `parseWorkflow` + `validateWorkflow` do core) | Lotes da ordem de execução; inválido → erros, saída 1. | `workflow-cmd.ts:67-89`, `:377-396` |
| `hub workflow run <arquivo>` | `--project <dir>`, `--budget-usd <n>` | `GET /projects` (+`POST`), `POST /sessions` por passo, `GET /tasks/:id` a cada 2000 ms | Orquestração **na CLI** (não usa `/workflows/runs`). Passo espera até 45 min; aprovação pendente não encerra o passo. Algum passo sem sucesso → saída 1. | `workflow-cmd.ts:91-177`, `:200-304` |

Todos os subcomandos de `workflow`, inclusive `validate` e a ajuda, passam por
`withDaemon` (`main.ts:197-198`) e portanto sobem o daemon.

### 1.9 `hooks install` e `mcp install` — arquivos de config alheios

**Regra comum: sem `--write`, só mostra.** Com `--write`, grava com backup e
escrita atômica.

- Backup: cópia para `<arquivo>.bak-AAAAMMDD-HHMMSS` (hora local), com `-2`,
  `-3`… se já existir; nunca sobrescreve backup (`packages/daemon/src/safe-write.ts:46-60`).
- Escrita: arquivo temporário no mesmo diretório + `rename` (`safe-write.ts:63-73`).
- Backup só se o arquivo existia; nada é gravado se o conteúdo já é o desejado.
- Leitura para editar aceita JSON e JSONC; conteúdo extra, sintaxe quebrada ou
  raiz que não é objeto → erro, nada gravado. JSONC gera aviso de que os
  comentários se perdem (`safe-write.ts:114-142`).

#### `hub hooks install [claude|openclaude] [--project <dir>] [--write]`

| Alvo | Arquivo de usuário | Com `--project <dir>` |
|---|---|---|
| `claude` | `~/.claude/settings.json` | `<dir>/.claude/settings.json` |
| `openclaude` | `~/.openclaude/settings.json` | `<dir>/.openclaude/settings.json` |

Fonte: `packages/daemon/src/hooks-config.ts:78-109`; destino em `main.ts:346-348`.

Formato gravado (`hooks-config.ts:135-154`): a chave `hooks.PreToolUse` ganha a
entrada abaixo; entradas antigas do Hub (comando casando
`/(?:main|bin)\.js" hook\b/`) são removidas; o resto do arquivo fica.

```json
{
  "matcher": "Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|WebFetch|Read|Grep",
  "hooks": [{ "type": "command", "command": "\"<node>\" \"<.../cli/dist/bin.js>\" hook", "timeout": 120 }]
}
```

Matcher em `hooks-config.ts:32-43`; timeout em `pretool-gate.ts:272`.

Saídas (`main.ts:353-373`): sem `--write`, `destino: <arquivo>` e o JSON de
`hooks`; com `--write`, `gate instalado em <arquivo>` + `backup: …`, ou
`gate já estava instalado … (nada gravado)`. Alvo desconhecido → erro de uso
`agente "<x>" não suporta gate pré-execução (disponíveis: claude, openclaude, codex)`.
Erros de I/O saem pelo formato único (`main.ts:280-286`).

`hub hooks` (sem sub) lê os arquivos de modo tolerante e mostra, por alvo:
instalado ou não, a nota de que sessões do Hub já são gateadas por
`--settings`, e aviso de timeout < 120 s ou matcher sem `Read`/`Grep`
(`main.ts:291-310`; `hooks-config.ts:188-214`).

#### `hub hooks install codex [--write]`

Não mexe em config do Codex. Liga `codexGate.bypassHookTrust: true` em
`<home>/config.json`, mexendo só nessa chave, com backup
(`packages/daemon/src/config.ts:380-396`; `main.ts:383-415`). Já ligado →
`gate do Codex já estava ligado … (nada gravado)`. `codexGate` que não é objeto
→ erro, nada gravado. Com a chave ligada, o daemon acrescenta
`--dangerously-bypass-hook-trust` e o hook inline a cada invocação do Codex
(`main.ts:388-391`; `session-manager.ts:2378-2410`).

#### `hub mcp install <agente> [--project <dir>] [--write]`

Servidor gravado com o nome `agents-hub` (`packages/cli/src/mcp-install.ts:31`):
comando = o Node em uso; args = `[<raiz>/packages/mcp/dist/main.js]`; env =
`AGENTS_HUB_URL=<url do daemon>` e `AGENTS_HUB_MCP_AGENT=<agente>`
(`mcp-install.ts:40-57`).

| Agente | Arquivo | Formato | Verificado |
|---|---|---|---|
| `claude` | `<projeto>/.mcp.json` | `mcpServers` | sim |
| `codex` | `~/.codex/config.toml` | TOML `[mcp_servers.agents-hub]` | sim |
| `cursor` | `~/.cursor/mcp.json` | `mcpServers` | sim |
| `opencode` | `~/.config/opencode/opencode.json` | `mcp` | sim |
| `copilot` | `~/.copilot/mcp-config.json` | `mcpServers` | sim |
| `kimi` | `~/.kimi-code/mcp.json` | `mcpServers` | **não** (nota: o binário não tem mecanismo de MCP) |
| `mimo` | `~/.mimo/mcp.json` | `mcpServers` | **não** |
| `antigravity` | `~/.gemini/config/mcp_config.json` | `mcpServers` | sim |
| `openclaude` | `<projeto>/.mcp.json` | `mcpServers` | sim |

Fonte: `packages/daemon/src/mcp-config.ts:35-124`. `<projeto>` = `--project` ou
o diretório atual (`main.ts:778-780`; `mcp-config.ts:128-131`).

Formato da entrada (`mcp-config.ts:167-212`):

- `mcpServers`: `{"command": "<node>", "args": ["<main.js>"], "env": {…}}`.
- `mcp` (OpenCode): `{"type": "local", "command": ["<node>", "<main.js>"], "environment": {…}, "enabled": true}`.
- TOML: `command = "…"`, `args = ["…"]`, `env = { AGENTS_HUB_URL = "…", AGENTS_HUB_MCP_AGENT = "…" }`. A tabela inteira do servidor, sub-tabelas incluídas, é substituída; o resto do arquivo é preservado, exceto as quebras de linha finais, que são normalizadas para uma só (`mcp-config.ts:385-386`); o TOML gerado é reparseado antes de gravar (`mcp-config.ts:340-387`, `:413-442`).

Saídas (`main.ts:799-839`): `show` e `install` sem `--write` imprimem rótulo,
caminho e trecho (`install` acrescenta `nada foi gravado. para aplicar: …`).
Com `--write`: `✓ <rótulo>: criado|atualizado|já estava correto`, caminho,
backup, avisos, e `reinicie o agente para ele carregar o MCP server.` Alvo não
verificado recebe aviso. Sem agente ou agente desconhecido → erro de uso com a
lista dos 9.

`hub mcp` (sem sub) compara o registro de cada arquivo com o que `--write`
gravaria: `registrado`, `registrado com outro caminho/porta — rode install --write de novo`, `config ilegível: …` ou `não registrado` (`main.ts:841-865`; `mcp-install.ts:125-138`).

### 1.10 `hub autostart`

**Só Windows.** Grava um `.vbs` na pasta Inicializar do usuário. Fonte:
`packages/cli/src/autostart-cmd.ts`.

- Pasta: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup` (sem
  `APPDATA`: `~\AppData\Roaming\…`); fora do Windows, indefinida (`:37-44`).
- Arquivo: `agents-hub-daemon.vbs` (`:34`), UTF-16LE com BOM (`:89-91`).
- Conteúdo (`:66-83`): comentário, `Set sh = CreateObject("WScript.Shell")`,
  uma linha `sh.Environment("PROCESS")("<VAR>") = "<valor>"` para cada
  `AGENTS_HUB_HOME`/`AGENTS_HUB_PORT` definida no `enable` (`:98-110`), e
  `sh.Run """<node>"" [""--experimental-sqlite""] ""<bin.js>"" autostart run", 0, False`.
- `enable`: grava (sobrescreve) e imprime o caminho (`:178-184`).
- `disable`: apaga; ausente → `autostart no login já estava desligado` (`:186-195`).
- `status` (padrão): ligado/desligado; avisa se o `.vbs` aponta outra instalação (`:197-214`).
- `run`: `ensureDaemon` silencioso; erro no stderr, saída 1 (`:145-155`).
- Fora do Windows: `status` diz `só implementado no Windows.` (saída 0);
  `enable`/`disable` dão erro e saída 1 (`:163-176`). `run` funciona em qualquer SO.
- Sub desconhecido → `uso: hub autostart [status|enable|disable]`, saída 1 (`:136`, `:157-161`).

### 1.11 `hub update`

**Não atualiza nada: diz como atualizar.** Fonte: `packages/cli/src/update-cmd.ts`.

- Detecta o método (`:100-126`): `pacote` se a CLI está em
  `…/node_modules/agents-hub/node_modules/@agents-hub/cli` com `package.json`
  de nome `agents-hub` (`:55-73`); `git` se há `.git` acima (`:39-48`); senão `desconhecido`.
- `git`: lê branch, commit, upstream e arquivos modificados. `--check` roda
  `git fetch --quiet` e conta commits à frente/atrás (`:128-142`). Cada `git`
  tem teto de 60 s e falha vira `null` (`:75-85`).
- Passos impressos: pacote → reempacotar + `npm i -g … --prefix …` + `hub restart`
  (`:121-126`); git → `pull --ff-only`, `npm ci`, `npm run build`, `hub restart` (`:144-149`).
- `--json` → `{version, method, repo, installRoot, npmPrefix, branch, commit, upstream, dirty, behind, ahead, steps[]}` (`:17-37`, `:158-161`).
- Saída 0 sempre que não lança.

A decisão 7.13 do ADR 07 troca isto por atualização automática; o C não herda
este comportamento.

### 1.12 `hub init`

**Onboarding em cinco passos; só o registro do projeto muda estado.** Fonte:
`packages/cli/src/init-cmd.ts:118-269`.

1. Node (mínimo 22.5.0; aviso entre 22.5 e 22.12) e `git --version` (`:124-146`).
2. `ensureDaemon` + `GET /health` (`:148-155`).
3. `GET /discovery`: tabela e aviso de agente sem credencial (`:157-171`).
4. `GET /projects`; cwd já registrado → nada; senão pergunta `registrar <cwd> como projeto? [S/n]` (Enter = sim; só com stdin e stdout TTY), `--yes` aceita, sem TTY vira sugestão; aceito → `POST /projects` (`:173-208`; pergunta em `:80-90`; TTY em `main.ts:205`). Avisa se não é git ou não tem commit (`:209-217`).
5. Só sugere `hub hooks install <id>` e `hub mcp install <id>` para os agentes
   instalados, sem `--write` (`:219-251`).

Erro em qualquer passo → formato único, saída 1 (`main.ts:200-207`).

---

## Parte 2 — MCP server

### 2.1 Processo e transporte

**stdio, JSON-RPC do SDK `@modelcontextprotocol/sdk`.** Executável
`packages/mcp/dist/main.js` (bin `agents-hub-mcp` em
`packages/mcp/package.json`). Servidor `{name: "agents-hub", version: "0.1.0"}`
com um texto de `instructions` (`packages/mcp/src/server.ts:89-110`).

- stdout é só do protocolo; diagnóstico vai para o stderr
  (`packages/mcp/src/main.ts:11-14`).
- Variável inválida → `agents-hub mcp: <mensagem>` no stderr, saída 1
  (`main.ts:21-27`; testado em `packages/mcp/src/main-env.test.ts:28-39`).
- Ao conectar: `agents-hub mcp conectado — hub: <url>, agente: <id>, sessão: <id|(adota ao primeiro uso)>` no stderr (`main.ts:50-53`).
- Cliente HTTP **sem token de operador** (`main.ts:36`;
  `packages/client/src/index.ts:46-47`).
- Encerramento (`main.ts:63-82`): as duas vias chamam `shutdown(grace)`, que
  roda uma vez só e, nesta ordem, desliga o heartbeat, espera `grace` ms (se
  > 0), faz `detach` da raiz adotada, fecha o servidor e sai com 0
  (`main.ts:66-74`). SIGINT/SIGTERM → `shutdown(0)`, sem carência
  (`main.ts:77-78`); `close`/`end` do stdin → `shutdown(AGENTS_HUB_MCP_GRACE_MS)`,
  padrão 3000 ms (`main.ts:63`, `:81-82`). O heartbeat é desligado **antes** da carência.

### 2.2 Variáveis de ambiente lidas

| Variável | Validação | Padrão | Uso | Fonte |
|---|---|---|---|---|
| `AGENTS_HUB_URL` | URL válida | `http://127.0.0.1:4747` | Base do daemon | `main.ts:29`; `hub-env.ts:32` |
| `AGENTS_HUB_MCP_AGENT` | string ≥ 1 | — | Identidade quando roda fora do Hub | `main.ts:34`; `hub-env.ts:34` |
| `AGENTS_HUB_MCP_GRACE_MS` | inteiro ≥ 0 | 3000 | Carência após fechar stdin | `main.ts:63`; `hub-env.ts:36-40` |
| `AGENTS_HUB_MCP_HEARTBEAT_MS` | inteiro 1–2 147 483 647 | 30 000 | Intervalo do heartbeat | `main.ts:45`; `hub-env.ts:46-51` |
| `AGENTS_HUB_SESSION_ID` | lida crua | — | Sessão do chamador (agente dentro do Hub) | `main.ts:33` |
| `AGENTS_HUB_AGENT_ID` | lida crua | — | Tem prioridade sobre `AGENTS_HUB_MCP_AGENT`; ausente as duas → `externo` | `main.ts:34` |

`readHubEnv` também valida `AGENTS_HUB_HOME`, `AGENTS_HUB_PORT` e
`AGENTS_HUB_NO_AUTOSTART` se estiverem no ambiente (`hub-env.ts:62-78`); o MCP
não as usa.

### 2.3 Identidade do chamador e adoção de sessão-raiz

**Dentro do Hub, a identidade vem de `AGENTS_HUB_SESSION_ID`. Fora dele, o MCP
adota uma sessão-raiz na primeira tool que precisa de identidade.** Fonte:
`packages/mcp/src/caller.ts`.

- `resolve()` (`caller.ts:45-75`): com sessão conhecida, devolve. Senão
  `POST /sessions/adopt {agentId, projectPath: <cwd do processo MCP>, title: "<agentId> (principal externo)"}`.
  Chamadas concorrentes compartilham a mesma adoção; adoção que falhou não fica
  guardada (a próxima tenta de novo).
- O daemon registra o projeto pelo `projectPath`, cria a raiz e começa o prazo
  (`packages/daemon/src/server.ts:692-711`).
- Pedem identidade: `hub_agent_call` e toda tool que passa pelo escopo de fluxo
  (2.5). `hub_agent_list` e `hub_workflow_run` não.

### 2.4 Heartbeat e prazo (lease) da raiz adotada

- O MCP chama `POST /sessions/:id/heartbeat` a cada
  `AGENTS_HUB_MCP_HEARTBEAT_MS` (padrão 30 000 ms), só depois de adotar; o
  timer não segura o processo (`caller.ts:86-110`; `main.ts:45`).
- Resposta `SESSION_NOT_FOUND` ou `ILLEGAL_STATE` → esquece a raiz; a próxima
  tool adota outra. Outros erros são ignorados (`caller.ts:92-100`).
- Daemon: prazo padrão `ADOPTED_LEASE_MS` = 180 000 ms; checagem a cada
  `max(1000, lease/3)` ms; raiz sem sinal além do prazo é encerrada pelo
  caminho do `detach` (`packages/daemon/src/adopted-leases.ts:4`, `:54`, `:109-130`).
  Heartbeat de sessão que não é raiz adotada, ou já terminou → `ILLEGAL_STATE`
  (`adopted-leases.ts:89-107`). Resposta: `{ok: true, leaseMs}`; sem controle
  de prazo no daemon, `{ok: true, leaseMs: null}` (`server.ts:724-731`).
- No encerramento normal, `POST /sessions/:id/detach` (`caller.ts:113-122`;
  rota em `server.ts:713`).

### 2.5 Escopo por fluxo

**O MCP só alcança o fluxo de quem chama.** Fonte: `packages/mcp/src/scope.ts`.

- Raízes visíveis = a raiz do chamador (via `GET /sessions/:callerId`) + as
  raízes que este processo abriu com `hub_workflow_run` (`scope.ts:50-69`).
- **Ler** (status, wait, events, diff, graph, budget, context_fetch, session_list):
  a sessão precisa estar numa raiz visível (`scope.ts:72-95`).
- **Controlar** (cancel, interrupt, pause, send, handoff): a sessão precisa
  estar **abaixo** do chamador (subida por `parentId` via
  `GET /sessions?rootId=`, até 256 passos) ou numa raiz aberta pelo processo;
  a própria sessão do chamador é recusada (`scope.ts:102-124`).
- Recusa → erro `OUT_OF_FLOW: …` (`scope.ts:35-37`, `:126-131`; formatação em `server.ts:1024`).

### 2.6 Resposta e erros das tools

- Sucesso: `{content: [{type: "text", text}]}`; falha: o mesmo com
  `isError: true` (`server.ts:43-44`). Texto compacto, não JSON
  (`packages/mcp/src/format.ts:4-10`).
- `describe(err)` (`server.ts:1023-1033`): `OUT_OF_FLOW: …`; `HubApiError` →
  `<CODE>: <mensagem>` + `campos inválidos:` com `- caminho: mensagem`; conexão
  recusada → `O daemon do Agents-Hub não está rodando. Peça ao seu usuário para executar "hub daemon".`
- Ids: validados no schema de entrada pelos mesmos padrões do cliente, mensagem
  `id inválido: esperado "<prefixo>_" seguido de letras e números`
  (`server.ts:73-76`). O teste `server.test.ts:639-661` prova que id inválido
  gera `isError` sem nenhuma requisição. **NÃO DETERMINADO:** o texto exato do
  erro de validação de entrada, que é montado pelo SDK, não por este código.

### 2.7 As 16 tools

Descrições copiadas do código. Limites: `LIMITE_OBJETIVO` = 20 000,
`LIMITE_ITENS` = 50, `LIMITE_ITEM` = 2 000, `LIMITE_LISTA` = 40
(`server.ts:54-58`). "Escopo L" = leitura (2.5); "Escopo C" = controle.

#### 1. `hub_agent_list` (`server.ts:113-166`)

- Descrição: `Lista os agentes de IA que o Hub pode acionar, com suas capabilities, se estão instalados e limitações conhecidas. Use antes de delegar quando não souber quem é o melhor alvo para a tarefa.`
- Entrada: `capability?: string`, `verbose?: boolean`.
- Anotações: `readOnlyHint: true` (`server.ts:131`).
- Daemon: `GET /agents`.
- Resposta: por agente, `<id> [disponível|NÃO INSTALADO] — <nome>` + capabilities + limitações (só a primeira, cortada em 140 caracteres, sem `verbose`). Nenhum agente com a capability → `nenhum agente com a capability "<x>"`.

#### 2. `hub_agent_call` (`server.ts:169-293`)

- Descrição: `Delega uma tarefa a outro agente de IA e retorna IMEDIATAMENTE com um task_id — o trabalho roda em background, num git worktree isolado, sem interferir no seu. Acompanhe depois com hub_agent_status/hub_agent_wait. O agente que receber a tarefa começa com contexto limpo: escreva o objetivo de forma autossuficiente. Use "cap:<capability>" no lugar do id para deixar o Hub escolher o agente (ex.: "cap:test-writing").`
- Entrada:
  - `agent: string` (id ou `cap:<capability>`, sem limite de tamanho no schema);
  - `objective: string` 8–20 000;
  - `acceptance_criteria?`, `constraints?`, `context_refs?`: até 50 strings de até 2 000;
  - `artifacts?`: até 50 de `{path, mode?: "read"|"write", note?}`; `path` até 2 000, relativo, sem letra de unidade e sem `..`;
  - `budget_usd?: number > 0`;
  - `isolation?: "worktree"|"none"`;
  - `supervision?: "supervised"|"semi"|"autonomous"`.
- Anotações: `destructiveHint: false`, `openWorldHint: true` (`server.ts:233`).
- Daemon: adoção se preciso (2.3); `POST /sessions/:callerId/delegate {brief}`.
- Resposta: `delegado para <agente>`, aviso se o agente real difere, `task_id`, `session_id`, `estado`, orçamento, instruções de acompanhamento. Retida pela política → `DELEGAÇÃO RETIDA — aguardando aprovação humana.` com motivo, ids e a instrução de não fazer polling.
- Erros com explicação própria (`server.ts:951-976`): `DEPTH_EXCEEDED`, `CYCLE_DETECTED`, `BUDGET_EXCEEDED`, `CONCURRENCY_EXCEEDED`, `AGENT_NOT_FOUND`, `CAPABILITY_UNRESOLVED`, `AGENT_NOT_INSTALLED`, `CODEX_GATE_NOT_GUARANTEED`; outros → `<CODE>: <mensagem>` + campos.

#### 3. `hub_agent_status` (`server.ts:296-315`)

- Descrição: `Estado atual de uma tarefa delegada: se terminou, o que produziu, quanto custou e quanto resta do orçamento do fluxo. Não bloqueia.`
- Entrada: `task_id: tsk_…`.
- Anotações: `readOnlyHint: true` (`server.ts:304`).
- Daemon: `GET /tasks/:id`; escopo L.
- Resposta: `formatTaskStatus` (`format.ts:21-79`): estado, agente, sessão, worktree, objetivo, aviso de fallback, tentativas com falha, resultado e custo, orçamento, validação e, se `input_required`, `AÇÃO NECESSÁRIA` com o `hub approve <id>`.

#### 4. `hub_agent_wait` (`server.ts:318-398`)

- Descrição: `Bloqueia até a tarefa chegar a um estado terminal ou até estourar o timeout. Use quando você REALMENTE precisa do resultado para continuar — se puder seguir trabalhando, prefira hub_agent_status, que não desperdiça tempo de parede. Ao estourar o timeout, a tarefa continua rodando: só a espera termina. Padrão: 300 s; 0 espera sem limite (use com cuidado).`
- Entrada: `task_id: tsk_…`; `timeout_seconds: int 0–1800`, padrão 300, `0` = sem limite.
- Anotações: `readOnlyHint: true` (`server.ts:338`).
- Daemon: `GET /tasks/:id` em laço; intervalo começa em 1500 ms e cresce ×1,4 até 10 000 ms; escopo L a cada consulta.
- Para em `completed`, `failed`, `canceled`, `rejected` ou `input_required`. Com `progressToken`, manda `notifications/progress` a cada consulta. Cancelamento pelo cliente → erro `espera cancelada pelo cliente; a TAREFA CONTINUA RODANDO`. Timeout → status + `A espera de Ns terminou, mas a TAREFA CONTINUA RODANDO. …` (sem `isError`).

#### 5. `hub_agent_events` (`server.ts:401-435`)

- Descrição: `Eventos de uma sessão: mensagens, comandos executados, arquivos alterados e erros. Use para acompanhar de perto uma delegação em andamento e interromper cedo se ela estiver indo para o lado errado.`
- Entrada: `session_id: ses_…`, `since?: int ≥ 0`, `verbose?: boolean`.
- Anotações: `readOnlyHint: true` (`server.ts:422`).
- Daemon: escopo L; `GET /sessions/:id/events?since=<n>&limit=200`.
- Resposta: um evento por linha `[HH:MM:SS] …` (`format.ts:106-143`); sem `verbose` omite `log`, `message.delta` e `reasoning`; fim com `[último seq: N]`; vazio → `nenhum evento novo`.

#### 6. `hub_session_diff` (`server.ts:438-464`)

- Descrição: ``Patch unificado do que a sessão efetivamente mudou no código — o mesmo que `hub diff` na CLI. Use antes de reportar uma delegação como concluída, para validar o que foi de fato alterado em vez de confiar só no resumo da task (hub_agent_status) ou no log de eventos (hub_agent_events).``
- Entrada: `session_id: ses_…`.
- Anotações: `readOnlyHint: true` (`server.ts:450`).
- Daemon: escopo L; `GET /sessions/:id/diff`.
- Resposta: patch cortado por linha em 12 000 caracteres, com `… [diff truncado — N caracteres no total, mostrando os primeiros M]` (`server.ts:1093-1111`); sem diff → `message` do daemon ou `esta sessão não tem diff disponível`.

#### 7. `hub_agent_cancel` (`server.ts:467-490`)

- Descrição: `Encerra uma sessão delegada e tudo que ela tiver delegado abaixo. Use quando o agente estiver claramente no caminho errado — deixar rodando só queima orçamento do fluxo, que é compartilhado com você.`
- Entrada: `session_id: ses_…`, `reason?: string`.
- Anotações: `destructiveHint: true` (`server.ts:479`).
- Daemon: escopo C; `POST /sessions/:id/cancel {reason}` (padrão `cancelado pelo agente chamador`).
- Resposta: `sessão <id> encerrada, junto com o que ela havia delegado`.

#### 8. `hub_session_interrupt` (`server.ts:493-523`)

- Descrição: `Para o turno em andamento de uma sessão SEM encerrá-la — diferente de hub_agent_cancel, que mata a sessão e tudo que ela delegou. Use quando quiser que o agente pare o que está fazendo agora mas continue disponível para receber uma nova instrução com hub_session_send, sem perder o estado acumulado.`
- Entrada: `session_id: ses_…`.
- Anotações: `destructiveHint: false` (`server.ts:505`).
- Daemon: escopo C; `POST /sessions/:id/interrupt`.
- Resposta: `interrupted` verdadeiro → `turno da sessão <id> interrompido — …`; senão `sessão <id> não tinha turno em andamento — nada para interromper`.

#### 9. `hub_session_pause` (`server.ts:526-548`)

- Descrição: `Pausa uma sessão sem encerrá-la — diferente de hub_agent_cancel, que mata a sessão e tudo que ela delegou. Use quando quiser segurar o trabalho por um tempo sem perder o estado, para retomar depois com hub_session_send.`
- Entrada: `session_id: ses_…`.
- Anotações: `destructiveHint: false` (`server.ts:537`).
- Daemon: escopo C; `POST /sessions/:id/pause`.
- Resposta: `sessão <id> pausada — retome com hub_session_send` (não confere o estado devolvido, ao contrário do `hub pause` da CLI).

#### 10. `hub_session_send` (`server.ts:551-576`)

- Descrição: `Manda uma mensagem para uma sessão delegada — corrigir o rumo, dar contexto novo ou responder uma dúvida — sem perder o trabalho já feito.`
- Entrada: `session_id: ses_…`, `text: string` (mínimo 1).
- Anotações: `destructiveHint: false`, `openWorldHint: true` (`server.ts:559`).
- Daemon: escopo C; `POST /sessions/:id/send {text}`.
- Resposta: `mensagem entregue — <explicação do modo live|resume|replay>`; modo desconhecido → `modo <x>`.

#### 11. `hub_session_handoff` (`server.ts:579-604`)

- Descrição: `Transfere o controle da sessão para outro agente em tempo de execução. O agente anterior é interrompido e o novo agente assume a sessão com todo o histórico acumulado como contexto.`
- Entrada: `session_id: ses_…`, `target_agent: string`, `reason?: string`.
- Anotações: `destructiveHint: true`, `openWorldHint: true` (`server.ts:593`).
- Daemon: escopo C; `POST /sessions/:id/handoff {agentId, reason}`.
- Resposta: `controle da sessão <id> transferido para o agente "<agente>"`.

#### 12. `hub_session_list` (`server.ts:607-651`)

- Descrição: `Sessões do SEU fluxo (e dos workflows que você rodou), com agente, estado e profundidade. Útil para reencontrar uma delegação cujo id você perdeu.`
- Entrada: `only_active?: boolean` (`running` ou `waiting_approval`).
- Anotações: `readOnlyHint: true` (`server.ts:617`).
- Daemon: `GET /sessions?rootId=<r>` para cada raiz visível.
- Resposta: até 40 sessões, cada uma `<id> · <agente> · <estado>` indentada pela profundidade, com o título numa linha abaixo (mais 2 espaços) quando existe (`server.ts:632-638`), + `… mais N sessões não mostradas …`; vazio → `nenhuma sessão no seu fluxo`.

#### 13. `hub_graph` (`server.ts:654-681`)

- Descrição: `Árvore de quem chamou quem no fluxo atual, com estado e custo por nó. Mostra também quanto do orçamento compartilhado já foi consumido.`
- Entrada: `root_id?: ses_…` (padrão: a raiz do chamador).
- Anotações: `readOnlyHint: true` (`server.ts:666`).
- Daemon: escopo de raiz; `GET /graph/:root` e `GET /budget/:root`.
- Resposta: árvore (`format.ts:145-154`) + linha de orçamento; vazio → `fluxo sem sessões registradas`.

#### 14. `hub_context_fetch` (`server.ts:684-716`)

- Descrição: `Resolve uma referência de contexto ("session:<id>#event:<seq>") que veio no seu brief e devolve os eventos ao redor dela. A delegação passa ponteiros em vez de texto: busque só o que você realmente precisar ver.`
- Entrada: `ref: string`; precisa casar `/^session:(ses_[A-Za-z0-9]+)(?:#|$)/`, senão erro `referência inválida: …`.
- Anotações: `readOnlyHint: true` (`server.ts:699`).
- Daemon: escopo L na sessão citada; `GET /context?ref=<ref>`.
- Resposta: eventos com `verbose` ligado.

#### 15. `hub_budget` (`server.ts:719-743`)

- Descrição: `Quanto o fluxo inteiro já consumiu e quanto resta. O orçamento é compartilhado entre você e todos os agentes que você acionar — consulte antes de delegar tarefas caras.`
- Entrada: `root_id?: ses_…`.
- Anotações: `readOnlyHint: true` (`server.ts:727`).
- Daemon: escopo de raiz; `GET /budget/:root`.
- Resposta: `orçamento do fluxo: US$ … de … · … tokens · N% consumido[ — ESGOTADO]` + `restante: US$ … · … tokens`.

#### 16. `hub_workflow_run` (`server.ts:746-863`)

- Descrição: ``Valida e executa um workflow YAML — o mesmo formato de `hub workflow validate/run` da CLI — despachando cada passo como uma sessão e respeitando `dependsOn`. BLOQUEIA até o workflow inteiro chegar a um desfecho (pode levar minutos: cada passo é uma tarefa completa de agente). Prefira isto a orquestrar manualmente vários hub_agent_call quando os passos têm dependências entre si — o motor cuida de esperar cada lote terminar antes do próximo e de repartir o orçamento.``
- Entrada: `yaml?: string`, `path?: string`, `project?: string` (padrão: cwd do processo MCP), `budget_usd?: number > 0`. Um de `yaml`/`path` é obrigatório.
- `path` só é lido se terminar em `.yaml`/`.yml` e estiver dentro do projeto, com links resolvidos (`server.ts:983-1002`). YAML malformado → `YAML malformado na linha N (<código>): …`, sem trecho do texto (`server.ts:1010-1021`).
- Anotações: `destructiveHint: false`, `openWorldHint: true` (`server.ts:773`).
- Daemon: `POST /projects {path}`; por passo `POST /sessions` (supervisão padrão `semi`, teto repartido arredondado a centavos, mínimo 0,01, `baseSessionIds` das dependências); espera por passo com `GET /sessions/:id/tasks` a cada 2000 ms por até 45 min, `GET /approvals?sessionId=` e `GET /budget/:sessionId` (`server.ts:874-945`). Cada raiz de passo entra nas raízes visíveis.
- Diferença da CLI: aqui um passo em `input_required` termina **na hora** como `blocked`; na CLI ele espera a aprovação (`workflow-cmd.ts:240-252`).
- Resposta: `workflow "<nome>": X/Y passos concluídos · US$ …`, uma linha por passo, sessões ainda vivas, e `ATENÇÃO: …` se algum não concluiu (`format.ts:157-182`). Não conclusão **não** é `isError`.

---

## Divergências e pontos para decidir

Encontrados ao ler o código; não corrigidos (fora do escopo desta tarefa).

1. **`hub --version --json` ignora `--json`.** `bin.ts:49-52` responde antes
   de `main.ts`; o help promete `hub version | hub --version [--json]`
   (`lifecycle-help.ts:16`). `hub version --json` funciona.
2. **`hub workflow validate` e a ajuda do workflow sobem o daemon.** O
   comentário de `main.ts:242` diz que a ajuda do workflow "não sobe o daemon",
   mas o `case` passa por `withDaemon` (`main.ts:197-198`), e a validação é local.
3. **`hub doctor --json` provavelmente não sai como JSON puro.** `doctorDaConfig`
   imprime a linha `✓ config.json …` no stdout (`doctor-cmd.ts:293-296`) antes
   do desvio para `--json` (`main.ts:89` roda antes de `main.ts:100`). O teste
   de `json-cmd.test.ts:93-97` chama `jsonCommand` direto e não cobre isso.
   **Não verificado em execução.**
4. **`hub logs -n 10` não funciona.** Só `--n` é aceito como alias
   (`logs-cmd.ts:66`); `-n` vira posicional (`args.ts:57-60`).
5. **O texto `instructions` do MCP cita 8 agentes** (`server.ts:94`); o
   ADR 07 (7.8) fala em 9 (falta OpenClaude).
6. **`hub autostart` só existe no Windows** (`autostart-cmd.ts:37-44`), e
   `hub open` tem ramo de macOS (`open-cmd.ts:17-21`). O ADR 07 (7.2) pede
   Windows e Linux; o equivalente Linux do autostart não existe no TS.
7. **`hub update` só dá instruções manuais** (`update-cmd.ts:100-211`); o
   ADR 07 (7.13) pede atualização automática.
8. **`hub hook` e `hub mcp install` gravam caminhos de Node** (`"<node>" "<bin.js>"`,
   `hooks-config.ts:115-117`; `mcp-install.ts:46-57`). No C, o formato da linha
   de comando gravada muda; `comandoDoHub` reconhece só `main.js"`/`bin.js"`
   (`hooks-config.ts:51-53`), então a regra de "é nosso?" precisa ser redefinida.
