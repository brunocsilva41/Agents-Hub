# 08 - MCP server, registro nos agentes e gate de hooks

Escopo: `packages/mcp`, `packages/cli/src/{mcp-install,hooks-install,hook}.ts`, `scripts/mcp-smoke.py`.
Metodo: daemon isolado (porta 48205, `AGENTS_HUB_HOME` temporario), `scripts/mcp-smoke.py` (copia com URL corrigida, ver achado 12), cliente proprio com `@modelcontextprotocol/sdk` 1.30.0 exercitando as 16 tools (o enunciado dizia 12; `tools/list` devolve 16), HOME/USERPROFILE temporarios para `--write`, binarios reais `claude` 2.1.281, `codex` e `opencode` para validar as configs geradas. Tudo foi apagado e o daemon encerrado no fim.

Nota de transparencia: ao testar `hub_agent_call` com entradas "validas" (achados 5 e 6) sessoes reais do `claude` foram iniciadas no daemon isolado (uma rodou ~21s antes de eu cancelar) e a de 2 MB de objetivo foi rejeitada pelo Claude e repassada por failover para `codex` e `opencode`. Custo real: centavos, nenhum arquivo do repo alterado. Nada foi feito no daemon 4747 nem em ~/.agents-hub.

---

### [ALTO] 1. Path traversal no client: `session_id="../shutdown#"` em `hub_agent_cancel` derruba o daemon (e a tool responde sucesso)
**Evidencia**
- `packages/client/src/index.ts:129,152-172,185-198,259,304,308` interpolam o id na URL sem `encodeURIComponent` (so `projectId`/`ref` sao codificados). Os schemas MCP (`packages/mcp/src/server.ts:238,262,312,349,376,402,433,455,481,543`) sao `z.string()` sem padrao.
- Reproduzido: `hub_agent_cancel {"session_id":"../shutdown#","reason":"audit-traversal"}` -> resposta `sessao ../shutdown# encerrada, junto com o que ela havia delegado` (isError=false); em seguida `curl /health` -> daemon fora do ar. O `fetch` normaliza `/sessions/../shutdown#/cancel` para `POST /shutdown`.
- `hub_session_pause {"session_id":"../maintenance/sweep#"}` -> `sessao ../maintenance/sweep# pausada` (na verdade executou `POST /maintenance/sweep`).
- GETs: `hub_agent_status {"task_id":"../../health"}` -> `Cannot read properties of undefined (reading 'id')`; `hub_graph {"root_id":"../health"}` -> `Cannot read properties of undefined (reading 'length')`; `hub_agent_events {"session_id":"../agents"}` -> `RESPOSTA_NAO_JSON ... <!doctype html>` (cai no fallback SPA).
**Impacto** Qualquer agente (ou texto injetado no contexto dele) chama uma tool "inocente" e desliga o hub inteiro, matando todas as sessoes e o trabalho de todos os fluxos, ou dispara a varredura de worktrees; a tool ainda afirma que "encerrou a sessao". Bypassa a ideia de que o MCP so tem o poder das tools.
**Correcao sugerida** (a) `encodeURIComponent` em todo id interpolado no `HubClient` (`#get/#post` com helper `seg(id)`); (b) nos schemas MCP validar `z.string().regex(/^(ses|tsk|apv)_[a-z0-9]+$/i)` (o daemon ja usa `SessionIdSchema`), o que tambem troca os erros cripticos por mensagem clara; (c) teste de regressao com `../shutdown#`.
**Esforco** P

### [ALTO] 2. Timeout do hook instalado (10s Claude / 20s Codex) e menor que a espera do gate (60s): acao que exige aprovacao humana EXECUTA sem aprovacao
**Evidencia**
- `packages/cli/src/hooks-install.ts:98` grava `timeout: 10`; `packages/daemon/src/codex-gate.ts:104` `TIMEOUT_PADRAO_SEC = 20`; `packages/daemon/src/session-manager.ts:89,183,778` espera a decisao humana por `60_000` ms (o comentario em 170-177 afirma que 60s e o timeout padrao do Claude, mas o instalador escreve 10).
- Reproduzido com o binario real: `claude -p "... echo AUDIT_MARK > mark.txt" --settings s.json --allowedTools Bash` com hook `PreToolUse` = `node -e "setTimeout(()=>{},20000)"` e `"timeout": 2` -> terminou em 24s, resposta `done` e o arquivo `mark.txt` foi criado. Ou seja, estouro de timeout de hook = ferramenta roda (falha aberta).
- No fluxo do Hub: `Write` fora do worktree gera aprovacao `pending` (apv_...) e o processo do hook fica bloqueado; o Claude desiste aos 10s e roda a acao enquanto a aprovacao segue pendente ate o Hub negar por tempo aos 60s.
**Impacto** O caminho `approve` do gate (o unico que pede humano) nunca protege na pratica com o hook instalado por `hub hooks install claude --write`: a acao roda depois de 10s sem resposta. Apenas `deny` imediato e respeitado.
**Correcao sugerida** Alinhar: instalar o hook com `timeout` >= `gateWaitMs/1000 + folga` (ex.: 75) e/ou reduzir `gateWaitMs` para menos que o timeout do hook (ex.: 8s no Claude, 15s no Codex, por dialeto). Enviar o teto do hook no corpo (`hookTimeoutSec`) para o daemon ajustar a espera. Teste de integracao que rode `claude -p` real com aprovacao pendente.
**Esforco** P-M

### [ALTO] 3. `hub mcp install opencode --write` gera config que o OpenCode REJEITA por inteiro
**Evidencia**
- `packages/cli/src/mcp-install.ts:33-44,60,84-85` grava `mcp["agents-hub"] = { command:"node.exe", args:[..], env:{..} }` (formato do Claude). Com HOME temporario e o binario real: `opencode mcp list` -> `Error: Configuration is invalid at ...opencode.json ... Expected { readonly "type": "local", ... } | { readonly "type": "remote", ... }, got {"command":"C:\\Program Files\\nodejs\\node.exe","args":[...],"env":{...}} mcp.agents-hub / Missing key mcp.agents-hub.enabled`.
- Existe o comentario "confirmado contra o binario real" em `writeConfig`, mas so a CHAVE `mcp` foi confirmada, nao o formato do valor (OpenCode quer `type:"local"`, `command:[...]` como array, `environment`, `enabled`).
**Impacto** A instalacao "com backup e merge" quebra o OpenCode inteiro (nao so o MCP do Hub) ate o usuario editar o arquivo a mao. O mesmo `MCP_TARGETS/serverSpec` e reutilizado por `POST /projects/:id/import` no daemon.
**Correcao sugerida** `serverSpec` por formato: para `json-mcp` emitir `{type:"local", command:[node, main.js], environment:{...}, enabled:true}`; validar em teste rodando `opencode mcp list` (ou o schema) sobre a saida; `renderSnippet` idem.
**Esforco** P

### [ALTO] 4. `hub mcp install codex --write` corrompe `config.toml` quando o servidor foi registrado via `codex mcp add` (env como sub-tabela)
**Evidencia**
- `packages/cli/src/mcp-install.ts:137-147`: o regex `\[mcp_servers\.agents-hub\][\s\S]*?(?=\n\[|\s*$)` para na linha `[mcp_servers.agents-hub.env]` e injeta `env = {...}` inline, deixando a sub-tabela antiga.
- `codex mcp add agents-hub --env AGENTS_HUB_URL=http://x -- node foo.js` grava exatamente `[mcp_servers.agents-hub]` + `[mcp_servers.agents-hub.env]`. Depois de `hub mcp install codex --write`: `python tomllib` -> `Cannot declare ('mcp_servers','agents-hub','env') twice` e `codex mcp list` -> `Error: failed to load bootstrap configuration ... duplicate key`.
**Impacto** O Codex deixa de iniciar por causa de um comando que promete "merge seguro".
**Correcao sugerida** Remover tambem sub-tabelas `[mcp_servers.agents-hub.*]` na substituicao (regex ate o proximo cabecalho que NAO comece com `mcp_servers.agents-hub`), ou usar um parser TOML (smol-toml) para editar; teste com a saida de `codex mcp add`. Aproveitar para honrar `CODEX_HOME` (o instalador ignora, `resolveConfigPath` usa `~/.codex`).
**Esforco** M

### [ALTO] 5. `hub hooks install claude --write` apaga a config do usuario quando o settings.json nao e JSON estrito
**Evidencia**
- `packages/cli/src/hooks-install.ts:115-122` `lerConfig` engole o erro de parse e devolve `{}`; `gravarConfig` (125-136) sobrescreve. Diferente de `mcp-install.ts:99-107`, que aborta.
- Reproduzido com `~/.claude/settings.json` contendo comentario `//`, `model`, `permissions.allow` (virgula final) e um hook proprio: apos `--write` o arquivo ficou so com `{"hooks":{"PreToolUse":[<hook do Hub>]}}` (perdeu model, permissions e o hook existente). O dry-run (sem `--write`) tambem mostra so o hook do Hub, sem avisar que nao conseguiu ler o arquivo.
- Segunda execucao de `--write` sobrescreve `settings.json.bak` com o arquivo ja truncado: o original some de vez.
**Impacto** Perda silenciosa de permissoes/hooks do usuario, e remocao das travas de permissao dele.
**Correcao sugerida** Se o arquivo existe e nao parseia, abortar com erro (como o MCP); aceitar JSONC (`jsonc-parser`) preservando comentarios; backup com timestamp ou so se o `.bak` nao existir.
**Esforco** P

### [MEDIO] 6. Sessao/tarefa "fantasma" quando a delegacao falha ao iniciar (agente nao instalado, projeto nao-git)
**Evidencia** `hub_agent_call {"agent":"cursor",...}` retorna `AGENT_NOT_INSTALLED ... Escolha outro`, mas `GET /sessions` mostra a sessao `running` e a task `working` (attempt sem `endedAt`) ate cancelamento manual. `hub_agent_wait` nela (`timeout_seconds:0`) nunca volta (o cliente estourou em 70s com `-32001`). Idem `hub_workflow_run` com passo `cursor`: o passo e reportado `failed` mas a sessao `[t] Step: a` ficou `running`. Origem: erro do adapter em `process-adapter.ts:177` depois de sessao/task criadas.
**Impacto** Ocupa slots de concorrencia/orcamento, polui o grafo e faz o agente que segue a instrucao "escolha outro" ainda esperar por uma task morta.
**Correcao sugerida** No `delegate/startSession`, capturar falha de spawn e marcar sessao `failed`/task `failed` na mesma transacao; teste com agente ausente.
**Esforco** P

### [MEDIO] 7. `CallerIdentity` cacheia para sempre uma adocao que falhou: apos o daemon voltar, tools continuam dizendo "daemon nao esta rodando"
**Evidencia** `packages/mcp/src/caller.ts:50-56`: `this.#adopting ??= client.adopt(...)`; a Promise rejeitada fica guardada. Reproduzido: com daemon desligado `hub_budget` falha; daemon reiniciado -> `hub_agent_list` funciona, mas `hub_budget` e `hub_graph` (e `hub_agent_call`) seguem com `O daemon do Agents-Hub nao esta rodando...` com o daemon no ar.
**Impacto** O agente hospedeiro precisa reiniciar o MCP server; a mensagem e enganosa.
**Correcao sugerida** Limpar `#adopting` no `.catch` (`this.#adopting = null` antes de relancar).
**Esforco** P

### [MEDIO] 8. `hub_agent_wait` ignora cancelamento/timeout do cliente e continua consultando o daemon para sempre
**Evidencia** `packages/mcp/src/server.ts:272-299`: o handler nao usa `extra.signal`. Medido com proxy contador: apos o cliente estourar/cancelar `hub_agent_wait(timeout_seconds:0)` a 3s, as consultas `GET /tasks/:id` seguiram (2 -> 6 em 20s). `timeout_seconds` padrao 300s e maximo 1800s tambem excedem o timeout tipico de request MCP (SDK: 60s).
**Impacto** Cada espera cancelada vaza um laco infinito (com `0`) ate a task terminar; hospedeiros que mantem o MCP vivo acumulam pollers.
**Correcao sugerida** Receber `extra` e sair em `extra.signal.aborted`; emitir `notifications/progress` a cada poll (mantem o timeout do cliente vivo); rejeitar `0` ou impor teto.
**Esforco** P

### [MEDIO] 9. Mensagem elaborada de "negado por falta de resposta" e descartada; o agente recebe "a politica proibe... nao tente contornar"
**Evidencia** `session-manager.ts:795-800` monta `explanation` distinta para timeout/negacao humana, mas `packages/daemon/src/server.ts:643-651` ignora `verdict.explanation` e recalcula `explainToAgent(verdict, mode)`. Saida real do hook para `Write` fora do worktree que expirou: `"...escalate: escrita fora do diretorio da sessao. A politica do projeto proibe esta acao. Nao tente contornar..."`.
**Impacto** Exatamente o comportamento que o comentario tenta evitar (agente conclui que e proibicao) e o `approvalId` some da mensagem. `toHookPermission` devolve `escalate` para `approve`, mas o gate nunca devolve `approve` (so allow/deny apos a espera), e o Claude Code 2.1.281 aceita apenas `allow|deny|ask|defer` (`escalate` nao existe no binario): codigo morto/invalido.
**Correcao sugerida** Usar `verdict.explanation ?? explainToAgent(...)` na rota; trocar `escalate` por `ask` em `HookPermission` e `hook.ts:54`.
**Esforco** P

### [MEDIO] 10. O gate aplica politica de sessao do Hub ao Claude "normal" do usuario por casamento de `cwd` (inclusive com sessoes mortas)
**Evidencia** `session-manager.ts:838-878` (`#localizarSessao`): sem `AGENTS_HUB_SESSION_ID`, casa por `nativeSessionId` e depois por `cwd`, preferindo sessao viva e, se nao ha, a mais recente qualquer. O MCP adota raiz com `workdir = process.cwd()` (`caller.ts`) e essa raiz fica `running` (ver achado 13). Reproduzido: hook com `cwd` do projeto, sem env, `session_id` desconhecido: `ls`/`git status` liberados por "allow list", `npm install` bloqueou 15s e voltou `deny` ("fora da allow list"), `curl ...` e `rm -rf build` ficaram pendentes >20s aguardando aprovacao que nunca chegara ao usuario.
**Impacto** Depois de registrar o MCP + hook global, o uso interativo do proprio Claude naquele projeto passa a ser barrado/atrasado por uma sessao "principal externo" que nao e ele; com o achado 2 vira um misto de atrito e nenhuma protecao.
**Correcao sugerida** Exigir `AGENTS_HUB_SESSION_ID` (ou `nativeSessionId` conhecido) para aplicar politica; usar `cwd` so para sessoes com worktree unico (`isolation:'worktree'`) e nunca para raizes adotadas/encerradas.
**Esforco** M

### [MEDIO] 11. Sem limite de tamanho no `objective` e demais campos de `hub_agent_call`; failover em cascata sem aviso ao chamador
**Evidencia** `server.ts:131-134` `objective: z.string().min(8)`; um objetivo de 2.000.000 caracteres foi aceito pelo MCP e pelo daemon, enviado ao Claude real (`Prompt is too long ... ~2038248 tokens`), e o Hub fez failover para `codex` (falhou) e depois `opencode` (subiu `opencode serve` em 4790) com o mesmo payload; o MCP respondeu `delegado para claude ... estado: working` e o chamador nao ve a cascata (`hub_graph` mostra tres filhos). Mesmo vale para `acceptance_criteria/constraints/artifacts` (arrays sem `.max`) e `artifacts[].path` aceitou `../../../etc/passwd` com `mode:"write"`.
**Impacto** Queima de tokens/tempo por uma unica chamada (loop de agente ou injecao), spawn de processos alheios ao pedido.
**Correcao sugerida** `.max()` (ex.: objective 20k chars, arrays 50 x 2k), rejeitar `path` com `..`/absoluto fora do projeto, e nao fazer failover automatico quando o erro e `Prompt is too long`/4xx permanente do payload; devolver na resposta do MCP que houve troca de agente.
**Esforco** P

### [MEDIO] 12. `scripts/mcp-smoke.py` nao consegue apontar para outro daemon; roda sempre contra 4747
**Evidencia** `mcp-smoke.py:38` `hub_url: str = "http://127.0.0.1:4747"` como default do construtor, e `McpSession(agent_id=args.agent)` (linha 144) sobrescreve `AGENTS_HUB_URL` do ambiente (linhas 39-41). Rodando `AGENTS_HUB_URL=http://127.0.0.1:48205 python scripts/mcp-smoke.py`: stderr do servidor mostrou `hub: http://127.0.0.1:4747` e falhou com "daemon nao esta rodando". Tambem so exige 4 das 16 tools (`expected`, linha 165) e nao valida nenhuma das 12 restantes.
**Impacto** Um "teste de fumaca" so testa o daemon do usuario (adotando sessao real nele); nao serve para CI isolado e nao detecta tool ausente/regressao.
**Correcao sugerida** `hub_url = os.environ.get("AGENTS_HUB_URL", ...)` + flag `--hub-url`; comparar `expected` com a lista completa de 16; adicionar chamadas de erro (id invalido) para cobrir os achados 1 e 6.
**Esforco** P

### [MEDIO] 13. Raizes adotadas ficam `running` para sempre se o hospedeiro matar o MCP sem fechar stdin
**Evidencia** `mcp/src/main.ts:56-60`: `release()` so roda em `shutdown()`; com fechamento de stdin espera 3s e sai (medido 3055ms, ok, sessao vira `completed`). Com `kill('SIGTERM')` no Windows (TerminateProcess) o processo morre em 16ms sem executar handlers: `ses_..._kimi running` ficou no daemon. Varias dessas raizes "running" alimentam o casamento por `cwd` do achado 10 e a lista de `hub_session_list`.
**Correcao sugerida** Reaper do daemon: marcar `completed` raizes adotadas sem atividade/heartbeat; ou MCP mandar heartbeat periodico e o daemon expirar sem ele.
**Esforco** M

### [MEDIO] 14. Sem escopo por fluxo: qualquer agente le/cancela/manda mensagem a sessoes de outros fluxos e projetos
**Evidencia** As tools de `session_id` nao checam pertencimento. Reproduzido: MCP do agente `openclaude` (raiz propria) executou `hub_agent_cancel` em sessao de outra raiz (`kimi`): `sessao ... encerrada`, estado passou a `killed`; `hub_agent_events`/`hub_graph {root_id}` leem qualquer fluxo; `hub_session_list` (`server.ts:509-531`) lista TODAS as sessoes do hub (titulo = objetivo, possivelmente sensivel) e corta em 40 sem avisar.
**Impacto** Agente delegado (ou prompt injetado) pode cancelar o pai/irmaos ou espiar outros projetos.
**Correcao sugerida** Enviar o `callerSessionId` no cabecalho e o daemon validar que o alvo esta na subarvore do chamador (cancel/send/interrupt/pause/handoff) e no mesmo `rootId` (read); avisar truncamento em `hub_session_list`.
**Esforco** M

### [BAIXO] 15. `hub_workflow_run`: erro de validacao sem motivo e leitura de arquivo arbitrario com eco de trecho
**Evidencia** `server.ts:672-674` usa so `(err as Error).message`: `yaml:"not: a workflow"` -> `nao foi possivel ler/validar o workflow: Workflow invalido` sem os `issues` que `parseWorkflow` coloca em `HubError.details` (`core/src/workflow.ts:38`). `path` aceita qualquer arquivo do disco; para um arquivo com YAML quebrado o erro devolve o trecho do arquivo (`bad: [unclosed` no meu teste). `project` aceita qualquer diretorio.
**Correcao sugerida** Reusar `formatIssues(err.details)`; restringir `path` a dentro de `project`/cwd e nao ecoar o trecho do parser (`prettyErrors:false`).
**Esforco** P

### [BAIXO] 16. Saidas e mensagens que custam tokens ou confundem o agente
**Evidencia** `hub_agent_list` sem filtro devolve 8.727 caracteres (caveats completos de cada manifesto, incluindo notas internas de verificacao); `hub_agent_events` mostra `ERRO: ` vazio quando o evento traz `summary` em vez de `message` (ex.: "Prompt is too long" aparece como linha solta e depois `ERRO: `); `hub_session_send` usa `{...}[mode]` sem fallback (modo inesperado -> "mensagem entregue - undefined"); `hub_agent_wait` mistura descricao em ingles (`server.ts:260`); nenhuma tool declara `outputSchema` (16/16 `outputSchema=false`), so texto livre; `hub_agent_wait`/`send`/`handoff` sem `annotations`.
**Correcao sugerida** Resumir caveats (1 linha) com `verbose`; formatador de erro le `payload.message ?? payload.summary ?? payload.error`; fallback de `mode`; padronizar idioma.
**Esforco** P

### [BAIXO] 17. Detalhes de instalacao/hook
**Evidencia**
- `hooks-install.ts:93,112` identifica "nosso" hook por `command.includes('main.js" hook')` (fragil: qualquer script terminado em `main.js" hook`); `mcp-install.ts:1-4` importa `os`/`existsSync` nao usados em partes.
- `main.ts:1308-1313` `isRegistered` = `includes('agents-hub')` (falso positivo em qualquer arquivo que cite o nome, ex.: `.mcp.json` do proprio repo).
- `mcp-install.ts:70-75`: `.bak` e regravado a cada `--write` (inclusive `unchanged` e falha de parse), destruindo o backup original (comprovado: `opencode.json.bak` identico ao atual apos 2a execucao).
- Alvo `claude`/`openclaude` do `hub mcp` grava `.mcp.json` no cwd (versionado) com caminho absoluto da maquina e do usuario embutido; `AGENTS_HUB_URL` (porta) fica fixa no config do agente (o adapter injeta so `AGENTS_HUB_SESSION_ID`, `process-adapter.ts:215`), entao mudar a porta do daemon quebra todos os registros.
- `hook.ts:98-103` falha aberta em qualquer excecao inclusive HTTP 400 (ex.: `tool_input` string -> `Agents-Hub indisponivel` + `allow`); e `HubClient` nao tem timeout proprio (depende do timeout do hook, ver achado 2).
- Cada chamada de hook sobe `node` com `--experimental-sqlite` warning em stderr (~500ms por chamada medida: 510-560ms).
**Esforco** P

---

## Verificado OK
- Handshake MCP (protocolo 2025-06-18), stdout sem lixo (0 linhas nao-JSON em varias execucoes), `hub_agent_list/budget/graph` e adocao de sessao externa: 5 chamadas concorrentes na largada criaram 1 unica raiz (sem duplicar orcamento).
- Validacao Zod das entradas: campos faltando, tipos errados, `budget_usd<=0`/nao finito, `isolation` invalido, `timeout_seconds` negativo/>1800/float, `since<0`, `text` vazio produzem erro -32602 legivel; tool inexistente -> `-32602 Tool ... not found`.
- Erros de dominio traduzidos com orientacao ao agente (`AGENT_NOT_FOUND`, `CAPABILITY_UNRESOLVED`, `INVALID_BRIEF` com campos, `ILLEGAL_STATE` em sessao terminada) e Host guard do daemon (`FORBIDDEN ... DNS rebinding`) funcionando.
- `hub_agent_wait` respeita `timeout_seconds` (3s -> 3009ms com aviso "a TAREFA CONTINUA RODANDO"); tarefa inexistente falha rapido.
- Encerramento por stdin fechado: sai em ~3,05s com `release()` (raiz vira `completed`); `hub_workflow_run` valida ciclos/passos vazios e devolve relatorio por passo; `hub_agent_call` retorna imediatamente com task_id.
- `hub mcp`/`show`/`install` sem `--write` nao gravam nada; `--write` com JSON invalido aborta sem tocar no arquivo (so o `.bak`, ver 17); merge preserva chaves alheias em JSON (`theme`, outros servidores) e escolhe a chave `mcp` vs `mcpServers` conforme o alvo; `hub mcp install codex --write` em config limpa produz TOML valido e `codex mcp get agents-hub` o reconhece.
- Gate de hooks: dialetos corretos (Claude: JSON `allow/deny`; Codex: stdout vazio para permitir, `deny` com motivo); `rm -rf /` e `curl|sh` negados na hora; `ls`/`git status`/`python`/escrita dentro do worktree liberados; stdin vazio/lixo/sem `tool_name`/ferramenta desconhecida liberados (falha aberta por decisao documentada); sessao inexistente -> `allow` sem opinar; daemon fora do ar -> `allow`.
- `hooks install claude --write` com JSON estrito preserva demais chaves e substitui so o proprio hook (idempotente); `hub hooks install codex` sem `--write` so explica; o instalador do Codex grava no `config.json` do home do Hub, nao em config de projeto.
