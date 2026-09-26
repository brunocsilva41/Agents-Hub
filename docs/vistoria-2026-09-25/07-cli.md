# Vistoria 07 - CLI `hub` (packages/cli/src, packages/client)

Método: daemon isolado na porta 48204 (home em scratchpad), agente FALSO `fake` (manifest com `bin: node` + script que imita o stream-json do Claude), projeto de teste git com espaço e acento no caminho. Todos os comandos/subcomandos de `hub help` foram executados (válidos, inválidos, sem argumento, com bogus). Node v24.14.0, Windows 10, Git Bash e PowerShell 7 (console UTF-8).

Não executado, por regra: `doctor --smoke`, `hooks install --write` / `mcp install --write` / `import --write --to` contra o home real. `--write` foi exercitado só em diretórios temporários (`--project`) e em `AGENTS_HUB_HOME` temporário.

Observações operacionais (transparência):
- Um `hub handoff --agent cap:code-edit` do meu teste resolveu para o `claude` REAL e iniciou uma sessão real (~US$ 0,40 no home isolado). Um `FAILNOW` no agente falso também disparou o fallback para o `claude` real (2 sessões, canceladas em segundos). Nenhum efeito fora das worktrees temporárias.
- Ao limpar um processo `hub watch --root` meu que ficou pendurado, meu filtro também encerrou um processo `hub ... watch zzz` de OUTRO agente da vistoria (só leitura de stream). Sem dano, mas o outro agente pode ter visto o watch cair.

---

## ALTO

### [ALTO] `hub hooks install claude --write` apaga o conteúdo de um settings.json que não parseia (e a config real desta máquina está nesse estado)
**Evidência**
- `packages/cli/src/hooks-install.ts:113-120` (`lerConfig`): `catch { return {}; }` engole o erro de JSON. `main.ts:388-398` faz `mergeHooks(atual={}, ...)` e `gravarConfig` grava só `{hooks:...}`.
- `packages/cli/src/hooks-install.ts:127-131`: `copyFileSync(file, file+'.bak')` roda a CADA `--write`, então uma segunda execução sobrescreve o `.bak` bom com o arquivo já reduzido.
- Reprodução (projeto temporário): `.claude/settings.json` com `permissions`, `model` e um comentário `//` no fim. `hub hooks install claude --write --project <tmp>` saiu com exit 0, "gate instalado", e o arquivo ficou só com `{"hooks":{"PreToolUse":...}}`. `permissions` e `model` sumiram do arquivo ativo (só sobraram no `.bak`).
- A config REAL do usuário está assim: `node -e JSON.parse(~/.claude/settings.json)` -> `Unexpected non-whitespace character after JSON at position 413 (line 11 column 2)`; e `hub discover` já avisa "conteúdo extra após o primeiro objeto JSON foi ignorado". Rodar `hub hooks install claude --write` nesta máquina destruiria `~/.claude/settings.json` (não executei).
**Impacto** Perda das permissões/env/modelo/MCP do Claude Code do usuário, silenciosamente, com mensagem de sucesso. Uma segunda execução perde também o backup. `mcp install` faz certo (para com erro claro); `hooks install` não.
**Correção sugerida** Em `lerConfig`, lançar erro quando o arquivo existe e não parseia (mesma mensagem do `writeJson` do mcp-install: "não é JSON válido... corrija ou cole manualmente"); nunca gravar. Fazer o backup só se o conteúdo vai mudar e sem sobrescrever um `.bak` existente (usar `.bak`, `.bak.1` ou timestamp). Idem em `mcp-install.ts:74-75` (ver item MÉDIO de backup).
**Esforço** P

### [ALTO] Timeout do hook instalado (10s) é menor que a espera do daemon por aprovação humana (60s): o gate de "approve" tende a falhar aberto
**Evidência**
- `packages/cli/src/hooks-install.ts:98`: `hooks: [{ type:'command', command, timeout: 10 }]`.
- `packages/daemon/src/session-manager.ts:88 e 170-183`: `ESPERA_PADRAO_DO_GATE_MS = 60_000`, com o comentário "60s é o timeout padrão de hook do Claude Code" (premissa que não vale para o que o instalador grava).
- Reprodução: sessão viva + `AGENTS_HUB_SESSION_ID=<id> echo '{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}' | timeout 12 hub hook` -> o hook fica bloqueado, sem responder (exit 124 aos 13s) e `hub approvals` mostra a aprovação "retida antes de executar".
**Impacto** Para ações que exigem aprovação (`approve`), o Claude Code desiste do hook aos 10s. Pela documentação de hooks do Claude Code, timeout de hook é erro NÃO bloqueante, então a ferramenta roda antes de o humano decidir, enquanto a CLI continua dizendo "retida antes de executar". Não reproduzi contra o binário do Claude (custaria tokens); a parte comprovada é o descompasso 10s x 60s e o hook pendurado. Só `deny` imediato é seguro.
**Correção sugerida** Alinhar: instalar `timeout` >= `gateWaitMs + margem` (ex.: 70) ou reduzir `gateWaitMs` para < 10s e responder `deny` "aguardando aprovação humana (apv_x)" rápido; testar contra o binário real. Idem `timeoutSec` do Codex.
**Esforço** P (config) / M (validar empiricamente)

---

## MÉDIO

### [MÉDIO] `hub start` (e `project env/prompt/folders`, `import`, `workflow run`) dentro de uma SUBPASTA de projeto registrado falha com PROJECT_FOLDER_CONFLICT
**Evidência** `main.ts:807-815` (`resolveProjectId`): `path.resolve(cwd)`, procura igualdade exata em `projects`, senão `addProject`. Reprodução: `cd <projeto>/sub && hub start --agent fake "objetivo..."` -> `[PROJECT_FOLDER_CONFLICT] "...\sub" está DENTRO de "...\proj com espaço", já registrada no projeto prj_...`. Idem `hub project env` e `hub project add sub`.
**Impacto** O help promete "padrão: diretório atual"; na prática só funciona na raiz exata. Usar a CLI de `src/` é o caso normal.
**Correção sugerida** Em `resolveProjectId`, subir da cwd procurando o projeto registrado que a contém (ou o toplevel do git) antes de tentar registrar; comparar caminhos normalizados (ver item de caminhos).
**Esforço** P

### [MÉDIO] Referência de projeto desconhecida vira "registrar um diretório com esse nome"
**Evidência** `main.ts:807-815`: se `flag` (id ou caminho) não bate, faz `path.resolve(flag)` e `addProject`. Reprodução: `cd /tmp && hub project env prj_doesnotexist` -> exit 0 "nenhuma variável..." e `hub projects` passa a listar `prj_doesnotexist -> C:\Users\Bruno Silva\AppData\Local\Temp\prj_doesnotexist` (pasta inexistente). Também: `hub project add <caminho-inexistente>` (exit 0 "registrado"), `hub start --project <inexistente>` e `hub workflow run --project <inexistente>` registram lixo; o workflow ainda inicia sessões e falha com "a sessão não tem tarefa" (sem causa).
**Impacto** Erro de digitação de id/caminho polui o registro e mascara o erro. Um id `prj_...` inexistente deveria dar "projeto não encontrado".
**Correção sugerida** Se o argumento casa `^prj_` e não existe -> erro PROJECT_NOT_FOUND. Validar `existsSync`/`statSync().isDirectory()` antes de registrar (no CLI e no daemon).
**Esforço** P

### [MÉDIO] Sem normalização de caminho: mesmo diretório vira 2 projetos ou erro enganoso
**Evidência** Registrar o mesmo diretório por nome 8.3 (`C:\Users\BRUNOS~1\...`) e por nome longo criou dois projetos (`prj_f507dc63...` e `prj_c985d57b...`). Variação só de caixa: `hub project add "C:\USERS\bruno silva\documents\projetos\agents-hub"` -> `[PROJECT_FOLDER_CONFLICT] ... está DENTRO de "C:\Users\Bruno Silva\...\Agents-Hub"` (é o MESMO diretório, não "dentro"). Barra final e `.` funcionam (idempotentes).
**Impacto** Em Windows (FS case-insensitive) o registro duplica projetos/worktrees/contextos ou dá mensagem errada.
**Correção sugerida** `fs.realpathSync.native` + comparação case-insensitive em `win32` no daemon (project-registry) e no `resolveProjectId`.
**Esforço** M

### [MÉDIO] Escrever `hub project env|prompt` num `config.yaml` que também tem política plana faz a política do projeto ser descartada
**Evidência** `packages/daemon/src/project-config.ts:~131-146`: `candidato = parsed['policy'] ?? parsed` validado com schema `.strict()`. Teste direto com `loadProjectOverrides`: (A) `maxDepth: 1` -> ok; (B) `maxDepth: 1` + `prompts: {fake: oi}` -> `overrides:{}`, erro `(raiz): Unrecognized key(s) in object: 'prompts'`; (C) com chave `policy:` -> ok. Efeito visível: qualquer arquivo criado só por `hub project env`/`prompt` (só `env:`/`prompts:`) emite em TODA sessão o aviso `configuração do projeto (.agents-hub/config.yaml) inválida — usando política global...` (visto no `hub watch`).
**Impacto** Ruído falso em todo projeto usando os comandos da própria CLI; e, para quem usa política plana, o próprio `hub project prompt --set` desliga os overrides (fail-safe para global, mas os ajustes de aperto somem).
**Correção sugerida** Separar as chaves de contexto (`memory|prompts|env|folders`) antes de validar a política (`const {memory,prompts,env,...rest}=parsed`).
**Esforço** P

### [MÉDIO] Erros de config viram stack trace bruto em QUALQUER comando (inclusive `help` e `hook`)
**Evidência** `main.ts:182-184` chama `loadConfig()` antes do `switch`, fora de try/catch. `config.json` com `{bad json` ou `{"port":"abc"}` -> `HubError: ... não é JSON válido` com stack completo, exit 1, até em `hub help` e `hub hook`. Também `hub daemon` com porta ocupada: stack `Error: listen EADDRINUSE 127.0.0.1:48204` (daemon-run.ts) e, na corrida de autostart simultâneo, o segundo daemon morre com esse stack no log.
**Impacto** Mensagem ilegível; o hook (chamado a cada ferramenta) explode com stack no stderr.
**Correção sugerida** Envolver `main()` num try/catch global que imprime `err.message` (e `code`) e sai 1; tratar EADDRINUSE em `runDaemon` com "já há um daemon em <url>" (exit 0/1 documentado).
**Esforço** P

### [MÉDIO] `AGENTS_HUB_PORT` é lida só por `hub daemon`; todos os outros comandos da CLI ignoram e falam com a 4747
**Evidência** `daemon-run.ts:18-20` usa `readHubEnv()`; `main.ts:183-184` usa `baseUrl(loadConfig())` sem override. Reprodução: `AGENTS_HUB_PORT=48206 hub daemon` sobe em 48206; `AGENTS_HUB_PORT=48206 hub status` -> "daemon não está rodando" (consultou 4747). `docs/09-variaveis-de-ambiente.md:24-33` só documenta o lado do daemon. Com autostart ligado, o filho herda a env e sobe em outra porta enquanto o cliente espera 30s pela 4747; ou, pior, fala silenciosamente com o daemon do usuário na 4747.
**Impacto** A variável não funciona de ponta a ponta; risco de agir no daemon errado.
**Correção sugerida** Aplicar `resolveDaemonOverrides(readHubEnv())` em `loadConfig()` na CLI (uma função compartilhada) e no `hook`.
**Esforço** P

### [MÉDIO] `hub watch --root`/`send`/`start` sem replay: `watch --root <fluxo já terminado>` pendura para sempre; `hub send` após `pause` não mostra a resposta
**Evidência**
- Daemon `server.ts:713-721`: replay só quando `sessionId`; para `rootId` não há. Reprodução: `hub watch --root <id de sessão concluída>` -> nenhuma saída e não termina (timeout externo 124). `hub watch <id inexistente>` idem: pendura sem erro.
- `hub send` numa sessão pausada: imprime "sessão nativa retomada", faz replay do histórico e para no PRIMEIRO evento terminal antigo (`error` do cancel do pause, `main.ts:908-921`). A resposta nova ("olá, recebi: mensagem com acentuação") existe nos eventos mas nunca é exibida; custo mostrado US$ 0,0000.
- Corrida latente em `hub start` sem `--detach`: a conexão SSE por `rootId` abre depois do `startSession`; se o agente terminar antes, os eventos passam sem replay e o comando pendura (não reproduzido: node de startup mais lento que o SSE).
**Impacto** Comandos "acompanhe ao vivo" que travam ou omitem a resposta. O uso pause -> send é justamente o fluxo anunciado.
**Correção sugerida** Passar `since` (último id visto / `ts` da chamada `send`) e ignorar eventos terminais anteriores ao momento do comando; adicionar replay por `rootId` no `/events`; validar existência da sessão (404) antes de abrir o stream.
**Esforço** M

### [MÉDIO] `hub start` (sem `--detach`) sai com exit 0 quando a sessão FALHA, e o fallback para OUTRO agente roda em segundo plano sem aviso
**Evidência** Nenhum `process.exitCode` em `streamUntilDone`/`aguardarTaskTerminal` (`main.ts:899-987`). Reprodução: agente falso que sai com código 3: saída termina em `✗ processo terminou com código 3: boom` + `… aguardando o portão de validação`, `exit=0`, em ~4s. Ao mesmo tempo o daemon abriu `ses_15bf...` no agente `claude` (real) — a CLI não mostra isso e o comando já retornou; `GET /sessions/<id>/tasks` da sessão falha devolveu `[]`, o que faz `aguardarTaskTerminal` retornar em silêncio (`if (!task) return true`).
**Impacto** Scripts/CI não detectam falha; custo real em fallback invisível.
**Correção sugerida** exit 1 se o estado final da sessão-raiz não for `completed`; ao ver `session.handoff/fallback` continuar acompanhando o novo filho; imprimir o aviso de fallback. (`hub workflow run` já faz exit 1 - replicar o padrão.)
**Esforço** M

### [MÉDIO] Flags de valor inválido são aceitas em silêncio: `--mode`, `--isolation`, `--set`, `--agent`, `--project`
**Evidência** `main.ts:842-850`: `--mode bogus` e `--isolation bogus` iniciam a sessão normalmente com o padrão (worktree/semi do agente); `--mode autonomus` (erro de digitação) cai em silêncio no default. `hub project env --agent fake --set` (sem valor) lista em vez de reclamar; `hub project prompt --set "a" --clear` limpa sem avisar do conflito; `hub discover --agent` (sem valor) lista todos; `--unset NOPE` diz "removido"; `--agent naoexiste --set OPENAI_BASE_URL=x` grava no arquivo.
**Impacto** Uma flag de supervisão digitada errada não protege como o usuário espera.
**Correção sugerida** Validar enum de `--mode`/`--isolation` (erro com valores válidos), tratar flag-de-valor sem valor como erro, validar `--agent` contra `client.agents()`, avisar quando `--unset` não removeu nada.
**Esforço** P

### [MÉDIO] `hub mcp install --write` sobrescreve o `.bak` a cada execução (inclusive "já estava correto" e arquivo inválido)
**Evidência** `mcp-install.ts:74-75`: `copyFileSync(configPath, backup)` antes de ler/validar/comparar. Reprodução (dir temp): 1º `--write` cria `.bak` do original; 2º `--write` ("já estava correto") sobrescreve o `.bak` com o arquivo já mesclado; 3º com o arquivo quebrado (`{broken`) falha com erro correto, mas o `.bak` virou o `{broken`. O original se perde na 2ª execução.
**Impacto** O "backup .bak" anunciado no help não preserva o estado original.
**Correção sugerida** Backup só se for gravar, e só se não existir `.bak` (ou versionar `.bak.<n>`).
**Esforço** P

### [MÉDIO] `hub hooks install codex --write` congela TODA a config padrão (incluindo `policy` completa e caminhos absolutos do repo) em `~/.agents-hub/config.json`
**Evidência** `main.ts:430`: `saveConfig({ ...config, codexGate })`; `config.ts:saveConfig` serializa o objeto inteiro. Reprodução (home temporário com `{"port":48204}`): o arquivo passou a 3610 bytes com `dbFile, worktreeRoot, artifactRoot, logDir, manifestsDir` (=`...\Agents-Hub\manifests`), `webRoot`, `opencodePort`, `maxSseConnections`, `policy` (15 chaves com todos os defaults), `retention`, `codexGate`.
**Impacto** Mudanças futuras nos defaults de segurança do `DEFAULT_POLICY` deixam de valer (o arquivo do usuário vence); mover o repositório quebra `manifestsDir`/`webRoot`. É gravação de "escolha explícita" que vira snapshot de tudo.
**Correção sugerida** Ler o JSON cru do disco, alterar só `codexGate.bypassHookTrust` e regravar (merge mínimo).
**Esforço** P

### [MÉDIO] Ids de sessão/raiz nos caminhos HTTP sem `encodeURIComponent` no client (afeta CLI, MCP e Web) e `budget`/`graph` com id errado dão zeros/crash
**Evidência** `packages/client/src/index.ts:152-180,303-308`: `/sessions/${sessionId}/...`, `/graph/${rootId}`, `/budget/${rootId}`, `/approvals/${id}` sem encode (o projeto já usa encode em outros métodos). Reprodução: `hub graph ../health` -> `Cannot read properties of undefined (reading 'length')`; `hub budget ../health` -> `... (reading 'pressure')`; `hub cancel ../health` bateu em `/health/cancel`; `hub diff "ses_x?a=b"` virou query. Além disso `hub budget <id-de-filho>` e `hub graph <id-de-filho>` devolvem zeros/"nenhuma sessão" e `hub sessions` nunca mostra o `rootId` (o help pede `<rootId>` em `graph/budget/watch --root`).
**Impacto** Path traversal dentro da API local (baixo impacto, mas o MCP usa o mesmo client com ids vindos do agente); respostas enganosas para id de filho.
**Correção sugerida** `encodeURIComponent` em todos os segmentos; mostrar `root:` em `hub sessions` para sessões filhas; tratar `budget`/`graph` de sessão inexistente como 404.
**Esforço** P

---

## BAIXO

### [BAIXO] Ao pedir human-deny/timeout no gate, o agente recebe a explicação errada ("A política do projeto proíbe esta ação")
**Evidência** `server.ts:645-646` (`explanation: explainToAgent(verdict, ...)`) ignora `verdict.explanation` produzida em `session-manager.ts:~780-800` ("Um humano negou explicitamente..." / "ninguém respondeu em 60s ... ficou pendente"). Reprodução: `hub deny <apv>` durante `POST /hooks/pretooluse` -> resposta `"explanation":"... A política do projeto proíbe esta ação. Não tente contornar..."`.
**Impacto** O agente conclui que é proibição permanente, que é justamente o que o texto de timeout queria evitar.
**Correção sugerida** `explanation: verdict.explanation ?? explainToAgent(...)`.
**Esforço** P

### [BAIXO] `hub interrupt` (e `cancel`/`send`) sempre diz sucesso; no Windows o interrupt mata a sessão
**Evidência** `main.ts:225-228` imprime "turno interrompido" sem checar estado: numa sessão já concluída também imprime "turno interrompido" (exit 0). Numa sessão viva no Windows o estado final foi `✗ falhou` (documentado no caveat do claude: degrada para cancelamento) e depois `hub cancel` responde `ILLEGAL_STATE ... já terminou (failed)`.
**Impacto** Mensagem enganosa; usuário perde a sessão achando que só pausou o turno.
**Correção sugerida** Ler o estado retornado e imprimir "sessão encerrada (Windows não entrega SIGINT)".
**Esforço** P

### [BAIXO] Eventos `error` aparecem como `✗ ` vazio
**Evidência** `render.ts:82-83` só lê `message|error|text`; o daemon emite `{reason:"canceled",exitCode:1,error:null,...}`. Visto em `hub watch`/`send` (`04:08:15 ✗ `).
**Correção sugerida** Fallback para `reason`/`outcomeClass`/`exitCode`.
**Esforço** P

### [BAIXO] Horários exibidos em UTC sem rótulo
**Evidência** `render.ts:28` e `main.ts:876,1181` usam `ts.slice(11,19)`/`createdAt.slice(0,19)`. Relógio local 01:10 apareceu como `04:10:03` em `hub approvals`/`sessions`/`watch` (fuso -03).
**Correção sugerida** Converter para hora local (ou acrescentar `UTC`).
**Esforço** P

### [BAIXO] Cada invocação do `hub` (incluindo o hook a cada ferramenta) carrega o daemon/SQLite: ~0,6s e aviso ExperimentalWarning no stderr
**Evidência** `main.ts:4` importa `@agents-hub/daemon` (que arrasta store/adapters/`node:sqlite`). Medido em PowerShell: `hub hook` 581-653 ms, `hub help` 543 ms, `node -e ""` 122 ms. Em todo comando aparece `(node) ExperimentalWarning: SQLite is an experimental feature...` (2 linhas em stderr; visto sem `NODE_NO_WARNINGS`). `package.json` declara `engines >=22.5.0`, mas o CLI/autostart não passam `--experimental-sqlite` (necessário em 22.5-22.12).
**Impacto** +0,5s por Bash/Edit/Write do agente; ruído; risco de crash em Node 22.5-22.12 (não testado).
**Correção sugerida** Extrair `loadConfig/baseUrl` para um módulo leve (ou import dinâmico só em `daemon`), suprimir o warning no entrypoint do daemon, e importar o resto lazy.
**Esforço** M

### [BAIXO] Help x implementação
**Evidência**
- `hub project` sem subcomando: `uso: hub project <add|env|prompt> ...` (omite `folders`, `main.ts:622`).
- Não documentados no help mas implementados: `handoff --reason`, `handoff --agent`, `delegate --budget-usd`, `start --isolation container` (aceito pela CLI, daemon responde "ainda não implementado"), `hooks install --project`, `doctor --smoke --project`, `hooks install` sem agente (assume claude).
- `hub <cmd> --help` não existe (`hub start --help` -> "faltou o objetivo"); só `hub workflow --help`. `hub --version`/`version` não existem (imprime "comando desconhecido" + o help inteiro); `hub HELP` idem (case-sensitive); `hub help start` imprime o help geral.
- `--json` só existe em `discover`; nenhum outro comando de listagem (`status/sessions/approvals/projects/agents/budget`) tem saída máquina-legível. As flags `quiet`/`force` estão em `BOOLEAN_FLAGS` mas nada as usa.
- `--` não é suportado: `hub start --agent fake -- "objetivo"` -> "faltou o objetivo"; objetivo iniciado com `--` vira flag.
- `hub workflow validate|run` e `hub workflow` (help) exigem/sobem o daemon sem necessidade.
- `hub sessions` corta em 40 sem avisar (`main.ts:872`).
- `hub discover` avisa "projectDir não informado: MCP de escopo de projeto não foi lido" mas não há `--project` para corrigir (o help de `import` tem, o de `discover` não).
**Correção sugerida** Atualizar help/usage; suportar `--`; `--help` por comando; `--version`.
**Esforço** P

### [BAIXO] Mensagens/códigos de erro inconsistentes
**Evidência** Id inexistente: `pause bogus` -> `SESSION_NOT_FOUND`; `interrupt/cancel bogus` -> `[INVALID_BRIEF] parâmetro "id" inválido`; `diff bogus` -> "esta sessão não alterou nenhum arquivo" (exit 0); `budget bogus` -> barra 0% com limites padrão (exit 0); `watch bogus` pendura; `approve apv_bogus` -> `[ILLEGAL_STATE] Aprovação ... não encontrada` (deveria ser NOT_FOUND). `required()` mostra "argumento obrigatório ausente: sessionId" sem a linha de uso. `hub mcp show` sem agente: `agente "" desconhecido`. `--budget-usd 0.001` aparece como "US$ 0.0123 de 0.00" (toFixed(2)); `hub budget` mostra 1230%.
**Correção sugerida** Normalizar 404 em todas as rotas por id; imprimir uso nos `required`.
**Esforço** P

### [BAIXO] `hub project env` mostra e ecoa valores de variáveis com cara de segredo
**Evidência** `main.ts:668-670,704`: lista `OPENAI_API_KEY=abc` e o `--set` ecoa `gravado fake OPENAI_API_KEY=abc`. O aviso sobre arquivo versionado existe, mas o valor é impresso em claro no terminal/logs.
**Correção sugerida** Mascarar valores de chaves que casam KEY/TOKEN/SECRET (`abc…` -> `****`).
**Esforço** P

### [BAIXO] `hub mcp` (status) usa `includes('agents-hub')` como critério de "registrado"; `claude` e `openclaude` compartilham o mesmo `.mcp.json`
**Evidência** `main.ts:1308-1314`; qualquer arquivo que contenha a string (comentário, caminho de outro projeto) conta como registrado.
**Correção sugerida** Parsear JSON/TOML e checar a chave `agents-hub`.
**Esforço** P

### [BAIXO] Nome da worktree perde acentos
**Evidência** Projeto "proj com espaço" -> `worktrees\proj-com-espa-o\ses_...`.
**Correção sugerida** `normalize('NFD').replace(/\p{M}/gu,'')` antes do slug.
**Esforço** P

### [BAIXO] `hub hooks install codex` (sem `--write`) descreve o efeito mas a barreira de confiança é uma flag "dangerously"; e o `hub hooks` só lê o `settings.json` real
**Evidência** Apenas observação: o texto explica o risco corretamente (`main.ts:418-428`). Nada a corrigir além de tornar `hub hooks` (listagem) tolerante ao JSON inválido do item ALTO: hoje `lerConfig` devolve `{}` e mostra "○ não instalado" mesmo com o hook instalado num arquivo com lixo no fim.
**Esforço** P

---

## Verificado OK
- Sem daemon: `AGENTS_HUB_NO_AUTOSTART=1` dá mensagem clara e exit 1; `hub stop` sem daemon exit 0 "já não estava rodando". Autostart (sem a env) sobe o daemon desacoplado, escreve `logs/daemon-YYYY-MM-DD.log`, funciona com caminho com espaço; dois comandos simultâneos funcionam (o segundo daemon morre com EADDRINUSE apenas no log).
- `--budget-usd abc|0|-1|(vazio)` validado localmente em `start`, `delegate` e `workflow run`; `--kinds` inválido e `--kinds mcp` sem `--to` rejeitados em `import`.
- UTF-8/acentos/emoji: `project prompt --set`, `start` com objetivo acentuado e saída de `projects` corretos no PowerShell 7 (console UTF-8) e no Git Bash; caminho com espaço e `ç` OK em `project add`, `start`, `mcp install`, `hooks install --project`.
- `hub hook`: stdin vazio/ilegível -> allow (fail-open documentado), dialeto `--dialect codex` responde vazio para allow; comando de hook gerado (`"node.exe" "main.js" hook`) funciona quando executado por `bash -c` com caminho com espaço.
- Gate: `git push` fica retido e `hub approvals`/`hub deny` funcionam; `deny` encerra a sessão; segundo `deny/approve` responde ILLEGAL_STATE claro.
- `hub delegate`, `hub handoff`, `hub graph`, `hub budget` (raiz correta), `hub pause`, `hub cancel`, `hub prune`, `hub artifacts`, `hub diff`, `hub agents`, `hub doctor`, `hub health`, `hub status`, `hub sessions` funcionam para o caso feliz.
- `hub workflow validate` detecta step duplicado, dependência inexistente e ciclo; `workflow run` executa lotes paralelos, pula dependentes de falha e devolve exit 1 quando algo falha.
- `hub discover --json` não expõe valores de credenciais (só nomes de campo/evidência); `mcp install --write` faz merge preservando chaves alheias e recusa JSON inválido.
- `bin` do `packages/cli/package.json` aponta para `dist/main.js` com shebang `#!/usr/bin/env node`. `hub` NÃO está no PATH desta máquina (README:31 pede `npm link --workspace @agents-hub/cli`; não executei `npm link`).
- Vazamento de eventos: `hub watch <sessionId>` faz replay + acompanha ao vivo e encerra corretamente ao terminar; encerramento do daemon no meio do watch termina o comando de forma limpa ("sessão encerrada (daemon encerrando)").
