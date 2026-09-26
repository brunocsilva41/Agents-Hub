# 10 - Vistoria: manifests, adapters, mappers, bin-resolver, discovery

Escopo: `manifests/*.yaml`, `packages/adapters/src` (process-adapter, mappers, registry, bin-resolver, opencode, discovery).
Método: somente leitura. Binários reais só com `--help`/`--version`/subcomandos de ajuda, mais execuções com `HTTPS_PROXY=http://127.0.0.1:9` (proxy morto) para validar o parsing de argv SEM chamada de modelo (custo zero). A suíte `packages/adapters/dist/**/*.test.js` roda verde (122 pass, 0 fail) e, justamente por isso, NÃO cobre nenhum dos achados abaixo.

Versões instaladas x manifesto:

| agente | instalado | manifesto diz | situação |
|---|---|---|---|
| claude | 2.1.281 (claude.exe) | sem versão | ok |
| codex | 0.155.0 (.cmd) | sem versão | ok |
| copilot | 1.0.83 (.cmd) | "1.0.70" (oneShot/mapper) e "1.1.17" (modeArgs/caveat) | incoerente (ver BAIXO) |
| cursor-agent | NÃO INSTALADO | "NAO VERIFICADO" | só 8 de 9 instalados |
| agy | 1.2.6 (.exe) | "verificado 1.1.22" | drift |
| kimi | 2.0.0 (.exe) | mapper "capturado do binário real" (formato antigo, Python) | reescrita Bun/TS |
| mimo | 0.1.14 (.cmd) | sem versão | ok |
| openclaude | 0.14.0 (.cmd) | "0.13.0" | drift menor |
| opencode | 1.18.32 (.cmd) | caveat cita 1.17.15 | drift |

---

### [CRÍTICO] Antigravity (`agy`) nunca recebe o prompt: o agente está 100% quebrado
**Evidência**
- `manifests/antigravity.yaml:16-19`: `oneShot: ["-p","--output-format","stream-json"]`, `stdinPrompt: false`, e nenhum `{{prompt}}` no manifesto. Em `process-adapter.ts:206-214` o prompt só entra nos args se o template tiver `{{prompt}}`; com `stdinPrompt:false` nada vai para stdin (`child.stdin.end()` vazio). Argv efetivo calculado por script sobre o dist: `agy -p --output-format stream-json --mode plan`.
- Histórico: `git log -p` mostra que antes era `oneShot: ["-p"]` + `stdinPrompt: true`; a mudança para `stdinPrompt:false` (commit ea678f9) não acrescentou `{{prompt}}`.
- Reprodução (proxy morto, zero custo), `agy -p --output-format stream-json </dev/null`:
  `Error: -p took "--output-format" as its prompt, so the intended prompt was left as an argument and ignored. Attach the prompt to the flag (-p='your prompt') and move --output-format elsewhere on the command line.` Idem com o prompt por stdin (`echo "diga oi" | agy -p ...`).
- A forma correta é aceita (só falhou na checagem de rede por causa do proxy morto): `agy --output-format stream-json --mode plan -p "diga oi"` e `agy --output-format stream-json -p="diga oi"`.

**Impacto** Toda sessão com `antigravity` falha na hora (exit != 0). O caveat "VERIFICADO" do manifesto é falso para esta versão. Bloqueia roteamento/fallback para Google.

**Correção sugerida** `oneShot: ["--output-format","stream-json","-p","{{prompt}}"]` e `resume: ["--conversation","{{nativeSessionId}}","--output-format","stream-json","-p","{{prompt}}"]`, `stdinPrompt:false`. Adicionar teste de contrato que monta o argv efetivo de cada manifesto e exige que o prompt esteja presente (arg, stdin ou promptFile).

**Esforço** P

### [CRÍTICO] Injeção de comando via prompt nos agentes `.cmd` cujo prompt vai em argv (copilot, mimo; opencode no fallback)
**Evidência**
- `bin-resolver.ts:129-147` (`quoteForShell`) só põe aspas se o valor tem espaço ou `"`, e escapa `"` como `\"`, que o `cmd.exe` NÃO entende como escape. `process-adapter.ts:220-231` usa `shell:true` + `args.map(quoteForShell)`; `copilot.yaml` e `mimo.yaml` passam `{{prompt}}` por argv e `where` os resolve para `.cmd` (`needsShell:true`, confirmado por script sobre o dist).
- Reproduzido em cmd.exe real com um `fakeagent.cmd` que só faz `echo %*`, chamando exatamente `spawnSync(quoteForShell(bin), args.map(quoteForShell), {shell:true})`:
  - prompt `x" & echo PWN>PWNED.txt & "` => `PWNED.txt` CRIADO no cwd.
  - prompt `a&echo>PWNED.txt` (sem espaço, nem chega a ser citado) => `PWNED.txt` CRIADO.
  - prompt `valor %USERNAME% fim` => o agente recebe `valor Bruno Silva fim` (expansão de variável de ambiente do daemon dentro do prompt).

**Impacto** Qualquer texto que chegue ao prompt (título de tarefa, conteúdo de arquivo/issue colado no Brief, saída de outro agente em delegação/handoff) executa comando arbitrário com o usuário do daemon, FORA do agente, do modo de permissão e do gate de aprovação. Derrota `supervised`.

**Correção sugerida** (a) Não passar prompt por argv em `.cmd`: usar stdin/`{{promptFile}}` onde o CLI suporta (opencode/mimo `run` leem stdin quando não há mensagem, a verificar; copilot precisa ser verificado); (b) melhor: resolver o shim npm para o script real e spawnar `node.exe <script.js> ...args` com `shell:false` (o shim em `%APPDATA%\npm\*.cmd` aponta para `node_modules\...`), eliminando o cmd.exe de todos os agentes npm; (c) se mantiver `shell:true`, escapar `^ & | < > % !` e `"` pelas regras do cmd (não as do CommandLineToArgvW) e rejeitar `\r\n\0`. Teste: prompts hostis com marcador em arquivo.

**Esforço** M

### [ALTO] Prompt por argv em `.cmd` também é truncado em quebra de linha, limitado a ~8 KB e perde Unicode
**Evidência** Mesmo harness em cmd.exe real:
- `linha1\nlinha2\nlinha3` (e `\r\n`) => o filho recebe só `-p "linha1` (o resto some em silêncio; o comentário de `bin-resolver.ts:104-109` admite que Brief multilinha não atravessa o cmd.exe).
- 9000 caracteres => `Linha de comando muito longa.` (limite 8191 do cmd), status 1.
- `olá ção 日本語 🚀` => chega como `ol� ��o ??? ??` (CJK/emoji viram `?`).

**Impacto** Copilot e MiMo recebem Brief truncado na primeira linha ou nem sobem se o Brief passar de ~8 KB. O Brief do Hub é multilinha por construção: é o caso normal.

**Correção sugerida** Mesma do achado anterior (node.exe + script direto, sem cmd.exe; para Brief muito grande, arquivo via `{{promptFile}}` + instrução "leia este arquivo" nos CLIs sem stdin). Registrar no manifesto quais CLIs aceitam stdin.

**Esforço** M

### [ALTO] `resolveBin` corrompe caminhos com acento (saída do `where` decodificada como UTF-8)
**Evidência** `bin-resolver.ts:70` usa `execFile('where')` com encoding utf8, mas o `where` imprime em code page OEM. Reproduzido: criei `...\João Açaí\fooagent.cmd`, pus no PATH e chamei `resolveBin('fooagent')` do dist => `path: "...\\Jo�o A�a�\\fooagent.cmd"`, `existsSync(path)` = false. (O usuário desta máquina é ASCII; "João"/"André" em pt-BR são comuns.)

**Impacto** Em perfis com acento o probe acha o candidato e o spawn falha com ENOENT, ou cai no `lookupFallback` e só acha parte dos agentes. Diagnóstico enganoso.

**Correção sugerida** Não usar `where`: percorrer `PATH` + `PATHEXT` em JS (`existsSync`), preferindo `.exe` > `.cmd`; ou `execFile(..., {encoding:'buffer'})` + decoder cp850. Teste com PATH acentuado.

**Esforço** P

### [ALTO] Custo contado em duplicidade/triplicidade (Claude, OpenClaude, Antigravity)
**Evidência**
- `mappers/claude.ts:60-70` anexa `cost` (tokens de `message.usage`) ao último bloco de CADA linha `assistant`, e `claude.ts:107-115` anexa outro `cost` (usd + tokens) ao `result`. `session-manager.ts:1605-1610` faz `ledger.charge` para todo `mapped.cost`, e `store/repositories.ts:243,421` somam `cost_json.usd` de todos os eventos.
- No transcript real do Claude a mesma `message.id` é dividida em uma linha por bloco, todas repetindo o `usage` completo (`~/.claude/projects/*/*.jsonl`: 2107 linhas assistant com usage, 1094 message.id distintos, 741 ids em mais de uma linha; ex.: `[["thinking",470],["tool_use",470]]`). Amostra sintética pelo mapper real (2 linhas da mesma mensagem com 100 in/50 out + result): 450 tokens contabilizados contra 150 reais (3x), além do usd estimado por token nas linhas assistant somado ao `total_cost_usd` do result.
- `mappers/antigravity.ts:49-63` (usage por step) + `:119-128` (usage no result) têm o mesmo desenho.
- Ressalva: a duplicação no stream-json em si foi inferida do transcript, não capturada de execução (custaria modelo).

**Impacto** Orçamento (`budget.exceeded`), painel e dashboards superestimados (2x a 3x); sessões pausadas por estouro falso.

**Correção sugerida** Cobrar custo só no evento terminal (`result`) para Claude/OpenClaude/Antigravity, ou deduplicar por `message.id` mantendo o último `usage`; remover `cost` das linhas `assistant`. Teste: soma de custos do stream sintético == usage do result.

**Esforço** P

### [ALTO] OpenCode: o modo do Hub não restringe nada, e o agente padrão tem `allow *`
**Evidência** `opencode agent list` (1.18.32): agente `build (primary)` com `{"permission":"*","action":"allow","pattern":"*"}`; também existe `plan (primary)`. A OpenAPI (`GET /doc` de um `opencode serve` isolado na porta 47913, depois encerrado) mostra `POST /api/session` com campo `agent` e `POST /api/session/{id}/agent` (`v2.session.switchAgent`). `opencode/adapter.ts:144-149` só envia `location` e `model`. O próprio `manifests/opencode.yaml` admite (modeArgs vazios + caveat).

**Impacto** Em `supervised` o OpenCode escreve e executa comandos sem restrição; a promessa central do Hub (modo -> política nativa) é falsa para o único agente HTTP.

**Correção sugerida** Em `OpenCodeAdapter#start/#resume` mapear `ctx.mode`: supervised -> `agent:"plan"`, semi/autonomous -> `agent:"build"` (no resume, `POST /api/session/{id}/agent`). Atualizar o caveat.

**Esforço** P

### [MÉDIO] `ctx.model` é ignorado por 8 dos 9 agentes; no OpenCode o providerID é fixo
**Evidência** `grep '{{model}}' manifests/*.yaml` => nada; `process-adapter.ts:210-216` só define `model` para template. Todos os CLIs têm flag (`claude --model`, `codex -m`, `copilot --model`, `agy --model`, `kimi -m`, `mimo/opencode -m provider/model`). `opencode/adapter.ts:146,168`: `model:{providerID:'opencode', id: ctx.model}` fixo (aqui o usuário usa `zai-coding-plan/glm-4.6`, `omniroute`).

**Impacto** Escolha de modelo por sessão/projeto/roteamento não tem efeito (só `ctx.extraArgs` manual); modelo de outro provedor no OpenCode falha.

**Correção sugerida** Campo `invoke.modelArgs: ["--model","{{model}}"]` por manifesto (o filtro de vazios já descarta sem modelo); no OpenCode parsear `provider/model`.

**Esforço** M

### [MÉDIO] Kimi 2.0.0: mapper escrito contra o formato antigo; supervised pode travar; existe `--plan`
**Evidência** Captura real (proxy morto) de `kimi -p hi --output-format stream-json`: `{"role":"meta","type":"system.version","version":"2.0.0"}` e `{"role":"meta","type":"turn.step.retrying","failed_attempt":1,"max_attempts":10,"delay_ms":602,"error_name":"APIConnectionError","error_message":"Connection error."}` repetido até 10 tentativas (estourou meu `timeout 90`, exit 124: retenta por minutos sem erro terminal). O mapper (`kimi.ts:56-76`) vira tudo `log` com `text: undefined` (o `error_message` só sobrevive em `raw`). `kimi --help` 2.0.0 tem `--plan` ("Start in plan mode"); o manifesto afirma que não há modo restritivo e deixa supervised sem flag.

**Impacto** Falha de rede/provedor vira minutos de logs sem erro até o heartbeat; supervised sem restrição real.

**Correção sugerida** `supervised: ["--plan"]`; mapear `turn.step.retrying` para `log` legível e, no último `max_attempts`, para `error`; reverificar `role:tool/assistant` contra a 2.0.0 (só eventos meta foram capturados aqui).

**Esforço** P

### [MÉDIO] `resolveBin` cacheia `null` para sempre; agente instalado depois do boot não é detectado
**Evidência** `bin-resolver.ts:47-51` `cache.set(bin, resolved)` inclui `null`; `clearBinCache` só é exportado (nenhum call site fora de testes). O registry reprova não-instalados a cada 5 min (`registry.ts` `#isFresh`), mas `probe()` chama `resolveBin`, que devolve o `null` cacheado. Relevante agora: `cursor-agent` não está instalado.

**Impacto** Instalar o Cursor CLI (ou corrigir PATH) exige reiniciar o daemon.

**Correção sugerida** Não cachear `null` (ou TTL curto) e chamar `clearBinCache()` em `probeAll(force=true)`/`hub doctor`.

**Esforço** P

### [MÉDIO] Mapper `generic-json` (mimo, cursor) não extrai texto, sessão nem custo
**Evidência** `mappers/generic.ts:35-60` só olha `text|message|content|usage` no topo. O `mimo run --format json` segue o formato do OpenCode (envelope com `part`/`sessionID`; NÃO capturado aqui porque a execução poderia chamar provedor local pago; isto é inferência de código). Os manifestos (`mimo.yaml`, `cursor.yaml`) admitem que `session.strategy: native` é "aspiracional": sem `nativeSessionId` todo turno cai em replay.

**Impacto** MiMo/Cursor: timeline majoritariamente `log`, sem custo, sem resume.

**Correção sugerida** Capturar um stream real e escrever `mimo.ts` reaproveitando `opencode/events.ts`; para Cursor, mapper próprio após instalar o binário.

**Esforço** M

### [MÉDIO] Discovery do Antigravity lê o lugar errado: nenhum modelo/permissão descobertos
**Evidência** `discovery/antigravity.ts` lê `~/.gemini/settings.json` e `~/.gemini/config/*.json` (herança do Gemini CLI). O `agy` 1.2.6 grava em `~/.gemini/antigravity-cli/settings.json` (existe aqui, com `"model":"Gemini 3.1 Pro (Low)"` e lista `permissions.allow`). `discover-all` mostra `antigravity defaults: {"provider":"google"}` sem modelo. `agy models` lista os ids (`gemini-3.1-pro-low`...) usados por `--model`, diferentes do nome de exibição gravado.

**Impacto** Sem modelo default a estimativa de custo cai em "agent-default"; config/permissões do agy invisíveis ao Hub.

**Correção sugerida** Ler `antigravity-cli/settings.json` (model, permissions) e normalizar nome de exibição -> id via `agy models`.

**Esforço** P

### [MÉDIO] `raw` do evento não é truncado: 5 MB persistidos por tool_result
**Evidência** `claude.ts:88-97` trunca `payload.content` a 4000 chars mas `raw: b` guarda o bloco inteiro. Teste com `tool_result` de 5 MiB: `payload.content` = 4017 chars, `JSON.stringify(raw)` = 5.242.933 bytes. `session-manager.ts:2158-2162` persiste `raw` e publica no bus; `repositories.ts:433-445` só compacta `raw_json` depois de a sessão encerrar. Não há teto de linha no `readline` (`process-adapter.ts:378`) nem de evento no store (grep por truncate/MAX em store/daemon: nada).

**Impacto** Ler um arquivo grande incha o SQLite e o bus/SSE durante a sessão; linha gigante sem `\n` cresce sem limite na memória do daemon.

**Correção sugerida** Truncar `raw` no adapter (ex. 16 KB) ou nulificar para `tool.result`; impor tamanho máximo de linha acumulada.

**Esforço** P

### [MÉDIO] Cursor: manifesto 100% não verificado e binário ausente
**Evidência** `where cursor-agent` => não encontrado. `cursor.yaml`: caveat "NAO VERIFICADO", sem `modeArgs` (os três modos rodam iguais, sem restrição), `stdinPrompt:true` com `-p` (suposição), mapper genérico. Não dá para validar `--output-format stream-json`/`--resume`/stdin sem instalar.

**Impacto** Agente cadastrado que provavelmente não funciona; supervised inexistente.

**Correção sugerida** Instalar, rodar `cursor-agent --help`, definir `modeArgs` e trocar o mapper.

**Esforço** M

### [BAIXO] OpenCode: `probe()` não devolve versão e afirma `authenticated:true`
**Evidência** `opencode/adapter.ts:126-140`: servidor no ar => `version:'servidor no ar', authenticated:true`; senão `version:null` (nunca roda `--version`, que responde `1.18.32`). `#healthy()` (`:592`) aceita qualquer processo que responda `/api/health` OK na 4790, sem checar que é o opencode. `/api/agent` na 1.18.32 devolve `data: []`, embora o manifesto/doc diga que lista agentes.

**Impacto** Painel sem versão; "autenticado" sem base; mudança de API v2 sem alarme.

**Correção sugerida** Rodar `--version` sempre e validar a assinatura do servidor (`/doc`); `authenticated:null` como nos demais.

**Esforço** P

### [BAIXO] Manifesto do Copilot cita duas versões que não batem com a instalada
**Evidência** `copilot.yaml`: "binário 1.0.70" (oneShot) e "1.1.17" (modeArgs/caveats); instalado 1.0.83 (1.1.17 é MAIOR que a instalada, então não pode ter sido verificado aqui). Flags conferidas na 1.0.83: `-p`, `--output-format json`, `--no-color`, `--mode plan|interactive|autopilot`, `--allow-all-tools`, `--resume[=value]` (o argv com espaço `--resume <uuid>` foi aceito: o erro "No session ... matched" prova que o valor foi consumido), `--session-id`, `--deny-tool`. Mapper: os 4 eventos reais capturados (`session.mcp_server_status_changed`, `ephemeral:true`) são descartados corretamente.

**Correção sugerida** Uniformizar para "verificado em 1.0.83"; campo `verifiedVersion` no manifesto e `hub doctor` comparando com `--version`.

**Esforço** P

### [BAIXO] Codex falha em diretório não-git
**Evidência** `echo hi | codex exec resume <uuid> --json - -c sandbox_mode="read-only"` num diretório vazio => `Not inside a trusted directory and --skip-git-repo-check was not specified.` (o worktree do Hub é git; só afeta `isolation: none` em pasta sem repositório). `codex exec resume --help` 0.155.0 realmente não tem `-s/--sandbox` (confirma o comentário do manifesto sobre `-c sandbox_mode`).

**Correção sugerida** Acrescentar `--skip-git-repo-check` quando o workdir não for repositório.

**Esforço** P

### [BAIXO] Ruído `DEP0190` do Node; `~/.claude/settings.json` com conteúdo extra
**Evidência** Cada `spawn(..., {shell:true, args})` imprime `DeprecationWarning DEP0190` (visto nos meus testes com o dist; é exatamente a rota do achado CRÍTICO de injeção). Discovery do Claude: `! ...\.claude\settings.json: conteúdo extra após o primeiro objeto JSON foi ignorado` (arquivo do usuário com JSON malformado).

**Esforço** P (o primeiro se resolve com a correção da injeção)

---

## Casos-limite dos mappers (executados sobre o dist)
Entradas: `null`, string, número, array, `{}`, tipo desconhecido, `content` não-array, `item:null`, `error` objeto, tool sem `name`.
- Nenhum mapper (claude, codex, copilot, kimi, antigravity, generic-json) lançou exceção; tipos desconhecidos viram `log` com o objeto inteiro (bom).
- Perdas silenciosas (viram `[]`): `claude` `assistant.message.content` string; `kimi` `content` como array de blocos; `codex` `item.completed` com `item:null`.
- Processo: `#mapLine` (`process-adapter.ts`): linha não-JSON => `log`; `{...` inválido/truncado => `log` com `unparsed:true`; UTF-8 partido entre chunks (`ção 日本語 🚀` cortado dentro do emoji) chegou íntegro pelo `readline`.
- Evento gigante: ver achado MÉDIO de `raw`.
- Copilot: `result` com `exitCode:null` vira `error` (aceitável).

## O que falta para cada agente ser "cidadão pleno"

| agente | auto-detecção | configuração (discovery) | modo | custo | retomada |
|---|---|---|---|---|---|
| claude | ok | ok (auth, model, MCP) | ok (`plan`/`acceptEdits`); novo na 2.1.281: `--permission-prompts none` nega prompts sem travar | usd real, mas duplicado (ALTO) | ok (`--resume`) |
| codex | ok | ok | ok (`-c sandbox_mode`); falta `--skip-git-repo-check` fora de git | tokens, estimado | ok |
| copilot | ok (versão incoerente no manifesto) | ok | supervised ok; semi == autonomous (sem alternativa nativa) | só outputTokens (subestima) | ok, só do 2º turno |
| agy | ok | falta `antigravity-cli/settings.json` | plan/accept-edits ok no papel, mas o prompt nunca chega (CRÍTICO) | tokens, duplicado | `--conversation` ok, porém com id inexistente o agy só avisa `conversation "abc" not found` e abre conversa NOVA (medido): o resume vira sessão nova em silêncio |
| cursor | falta (não instalado) | quase nada | falta | falta | falta |
| kimi | ok | ok (config.toml) | falta `--plan` em supervised | usage não confirmado na 2.0.0 | só no evento final; kill/timeout perde o id |
| mimo | ok | parcial (sem modelo default) | supervised == semi | falta (mapper genérico) | falta (aspiracional) |
| openclaude | ok (0.14.0 vs 0.13.0) | ok | ok (`--permission-mode`) | mesma duplicidade do Claude | ok; `--session-id <uuid>` permitiria fixar o id antes |
| opencode | probe sem versão | ok | NÃO restringe (ALTO) | custo por passo (bom) | ok (sessão HTTP durável) |

Transversais: nenhum manifesto usa `{{model}}`; `interactive:false` em todos os CLIs (envio ao vivo só no OpenCode); `probe` sempre devolve `authenticated:null` (a discovery sabe, o probe não).

## Verificado OK
- Flags de manifesto existentes e com o significado declarado: claude (`-p`, `--output-format stream-json`, `--verbose`, `--resume`, `--permission-mode plan|acceptEdits`), codex (`exec --json -`, `exec resume`, `-c` nos dois subcomandos, `--sandbox` só em `exec`), copilot (acima), kimi (`-p`, `--output-format stream-json`, `-S/--session`, `-y`, `--auto`), mimo (`run <msg> --format json`, `-s/--session`, `--yolo`; `-p` é mesmo `--password`), openclaude (mesma superfície do Claude), agy (`--mode plan|accept-edits`, `--conversation`; só o `-p` está errado).
- Resume de Claude com id inexistente devolve `result` `error_during_execution` com `session_id` (mapper vira `error`).
- bin-resolver: prefere `.exe` a `.cmd`, ignora o script sem extensão do npm (codex/copilot/mimo/opencode/openclaude resolvidos para `.cmd`; claude/agy/kimi para `.exe`); caminho com espaço (`C:\Users\Bruno Silva\...`) sai citado corretamente para o binário.
- Backpressure, timeouts geral/heartbeat, `killProcessTree` e limpeza de `{{promptFile}}`: 122 testes passam.
- Discovery: só leitura, nunca carrega valores de credencial (conferido na saída de `discover-all`), nunca lança.
- Nenhum daemon do usuário foi tocado; o `opencode serve` que subi na porta 47913 foi encerrado (PID próprio); o da 4790 (do Hub) ficou intacto. Nenhum arquivo do repositório foi alterado (artefatos de teste ficaram só no scratchpad).
