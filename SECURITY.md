# Segurança

O Agents-Hub é um daemon local que **executa CLIs de agentes de IA com o seu
usuário, no seu repositório**. O modelo de ameaça não é o de uma biblioteca: é o
de um processo que spawna outros processos com privilégio total do dono da
máquina. Este documento diz o que ele garante, o que ele explicitamente não
garante, e como relatar uma falha. Cada afirmação cita o arquivo onde ela é
verdade; se o código e este texto divergirem, o texto está errado — relate.

## Como relatar

Abra um **security advisory privado** em
<https://github.com/brunocsilva41/Agents-Hub/security/advisories/new>. Não abra
issue pública para falha explorável.

Inclua: versão (`hub --version`, `hub doctor`), sistema operacional, e o menor
caminho que reproduza. Se o relato envolver um agente específico, diga qual
binário e qual versão — metade das falhas desta categoria vem do dialeto de um
CLI, não do Hub.

Este é um projeto pessoal, sem SLA de resposta. O que existe é o compromisso de
não fechar relato sem explicação.

---

## Modelo de ameaça

| Quem | O que pode tentar | Fronteira que o Hub mantém |
|---|---|---|
| **Página web** que você visita | dirigir o daemon em `127.0.0.1` (CSRF, DNS rebinding) para abrir sessão, aprovar, derrubar | borda HTTP (abaixo) |
| **O agente** que o Hub roda (modelo confuso ou sob prompt injection) | rodar comando destrutivo, ler segredo, escrever fora do worktree, aprovar a própria ação pela API, afrouxar a política, derrubar o daemon para passar sem gate | gate pré-execução (onde existe), política, token de operador, orçamento |
| **Repositório hostil** que você clona | `.agents-hub/config.yaml` que executa comando, desvia o tráfego do agente ou injeta instruções | confiança por hash (TOFU) nos campos sensíveis |
| **Outro usuário** do sistema operacional | ler o token de operador | arquivo só do seu usuário |
| **Processo local do seu usuário** decidido a atacar | qualquer coisa, inclusive obter o token de operador | **nenhuma** — não é fronteira; ver "Processo local do mesmo usuário não é fronteira" |

---

## O que o Hub garante

| Vetor | Controle | Onde |
|---|---|---|
| Página web dirigindo o daemon | `Host` só loopback; `Origin` precisa ser a do daemon (host loopback **e** a mesma porta) e `Origin: null` é recusado; sem `Origin`, `Sec-Fetch-Site` de outro site barra todo método que muda estado; corpo só `application/json` (415) | `packages/daemon/src/guard.ts` |
| Corpo ou URL malformados | JSON inválido → `400 INVALID_JSON` (sem ecoar o parser); corpo > 5 MB → `413 PAYLOAD_TOO_LARGE`, recusado pelo `Content-Length` antes de ler; `%` malformado → `400 MALFORMED_URL`; corpo e parâmetros por schema Zod | `packages/daemon/src/http-body.ts`, `packages/daemon/src/http-schemas.ts` |
| Traversal na Web UI servida | caminho relativo resolvido; recusa `..`, `\`, `:` (inclui `::$DATA`, ADS do NTFS), nome terminado em ponto/espaço e nomes reservados do Windows (`CON`, `NUL`, `COM1`...) | `packages/daemon/src/static.ts` |
| Vazamento por `/health` | não expõe `home` (caminho com o nome da conta) | `packages/daemon/src/server.ts` (`GET /health`) |
| Segredo em `/discovery` | `--api-key`, `--token=`, `Authorization:` em args, headers e valores de query mascarados | `packages/daemon/src/absorption.ts` |
| Id forjado virando outra rota (`session_id: "../shutdown#"`) | ids validados por padrão (`ses_…`, `apv_…`, `prj_…`) no client e no schema das tools MCP, e codificados no caminho | `packages/client/src/ids.ts`, `packages/mcp/src/server.ts` |
| Pedido gigante pelo MCP | `hub_agent_call`: objetivo ≤ 20 000 caracteres, ≤ 50 itens por lista, ≤ 2 000 por item; artefato só relativo ao projeto, sem `..` | `packages/mcp/src/server.ts` |
| Saída de agente enchendo disco/memória | teto por evento e por sessão (64 MB), página de eventos ≤ 8 MB; o excedente é cortado com `[truncado N bytes]` | `packages/daemon/src/event-limits.ts` |
| Escalação por delegação | política efetiva do filho = interseção com a do pai; modo do filho nunca mais permissivo | `packages/core/src/policy.ts` (`intersect`, `inheritMode`) |
| Delegação em loop | profundidade máxima + ciclo semântico por `(agente, hash do objetivo)` | `packages/core/src/graph.ts` |
| Gasto descontrolado | orçamento é da sessão-raiz, consumido pelos descendentes | `packages/core/src/budget.ts` |
| Ação arriscada | classificação de risco + decisão por modo (tabela abaixo); deny list é sempre `deny` | `packages/core/src/policy.ts` |
| Comando composto para driblar a allow list | comando tokenizado; vale o pior segmento; o que não tokeniza vira `escalate` | `packages/core/src/command-classifier.ts`, `packages/core/src/shell-tokenizer.ts` |
| Agente aprovando a própria ação, afrouxando política ou derrubando o daemon | token de operador nas rotas de política/segurança; `by` vem da origem autenticada | `packages/daemon/src/operator-auth.ts` |
| Config de projeto hostil | só aperta a política; campos sensíveis só com `hub project trust`, suspensa se o conteúdo mudar | `packages/core/src/policy.ts` (`mergePolicyLayer`), `packages/daemon/src/repo-trust.ts` |
| Config de agente alheia destruída por `--write` | merge, escrita atômica e backup versionado `.bak-AAAAMMDD-HHMMSS`, nunca sobrescrito | `packages/daemon/src/safe-write.ts` |

### Classificação de risco e decisão por modo

O classificador é o mesmo para o gate pré-execução e para a vigilância
(`PolicyEngine.decide`, `packages/core/src/policy.ts`):

- **Comando** (`packages/core/src/command-classifier.ts`): tokenizado; cada
  segmento de `a && b`, `a ; b`, `a | b`, `$(...)`, crase, e o conteúdo de
  `bash -c`/`cmd /c`/`powershell -Command`/`env`/`xargs`/`npx` é classificado, e
  **vale o pior** (`git status && git push` é `git push`). Redirecionamento é
  escrita/leitura no alvo (`echo x > .env` escreve em `.env`). Código inline
  (`node -e`, `python -c`) é `exec`, sobe a `escalate` se usa API de
  processo/arquivo/rede e a `irreversible` se menciona segredo. Entrada que não
  tokeniza com segurança, comando dinâmico (`$CMD args`) e script pela entrada
  padrão viram `escalate` — nunca `allow`. Allow/deny list casam por palavra
  (`cat` não casa `catalog`).
- **Segredo em leitura**: ler `.ssh`, `.env*` (menos `.env.example` e afins),
  `*.pem`/`*.key`, `credentials`, `.npmrc`, `.git-credentials`, credenciais de
  CLI (`~/.claude/.credentials.json`, `~/.codex/auth.json`, `gh/hosts.yml`...) e
  o próprio `operator-token` do Hub é `irreversible` — vazar não se desfaz
  (`packages/core/src/sensitive-paths.ts`, `#classifyRead`).
- **Escrita**: em segredo ou config que executa código (`.git/hooks`,
  `.git/config`, `.github/workflows`, `.husky`, `.agents-hub`, `.mcp.json`,
  settings do Claude, config do Codex, perfis de shell) é `irreversible`; fora
  do worktree da sessão é `escalate`; dentro, `write`. A lista embutida vale
  sempre; `paths.denyFragments` só soma.
- **Rede**: domínio fora de `network.allowDomains` (vazio por padrão) é `escalate`.
- **Deny = deny**: comando da deny list (`sudo`, `doas`, `shutdown`, `reboot`,
  `mkfs`, `diskpart`, `format`, `reg delete`...) é negado em **todos** os modos;
  nenhum modo e nenhum `policy.risk` o transforma em aprovação
  (`decide`: `if (denied) return ... 'deny'`).

A decisão é a mais restritiva entre `policy.risk[risco]` e o overlay do modo
(`decisionForMode`). Com a política padrão:

| Risco | Exemplos | supervised | semi | autonomous |
|---|---|---|---|---|
| `read` | `ls`, `cat`, `git status`, ler arquivo comum | passa | passa | passa |
| `write` | editar no worktree, `mkdir`, `cp`, `rm arquivo` | aprovação | passa | passa |
| `exec` | `npm test`, `make`, `git commit`, `node script.js` | aprovação | passa | passa |
| `escalate` | fora da allow list, rede não liberada, escrita fora do worktree, não tokeniza | aprovação | aprovação | aprovação |
| `irreversible` | `git push`, `rm -rf`, `git reset --hard`, publish, ler/escrever segredo, escrever `.git/hooks` | aprovação | aprovação | aprovação |
| deny list | `sudo`, `shutdown`, `mkfs`, `reg delete` | **negado** | **negado** | **negado** |

(`escalate` em `autonomous` é `aprovação` porque `policy.risk.escalate` padrão
é `approve`, que é mais restritivo que o overlay do modo; conferido rodando
`PolicyEngine.decide` sobre a política padrão.)

"Aprovação" só é **prévia** onde há gate pré-execução. Na vigilância reativa
(agentes sem gate) a mesma decisão vira: pausar a sessão **depois** do fato para
o que está em `watch.pauseOn` (padrão: `irreversible`; em `supervised` também
`escalate` — `watchForMode`) e só marcar na timeline o que está em
`watch.flagOn` (padrão: `escalate`). Ou seja: sem gate, uma ação `escalate` em
`semi`/`autonomous` **executa até o fim** e vira alerta. É decisão de produto
(pausar depois do fato não desfaz nada e gera ruído), dita aqui para não ser
confundida com prevenção.

### Gate pré-execução

O agente pergunta ao Hub (`POST /hooks/pretooluse`) **antes** de rodar a
ferramenta. Shell (`Bash`, `PowerShell`), escrita (`Write`, `Edit`,
`MultiEdit`, `NotebookEdit`) e rede (`WebFetch`, `WebSearch`) viram ações
classificadas, assim como leitura (`Read`, `Glob`, `Grep`), para pegar segredo;
ferramenta desconhecida não vira ação (`actionsOfToolCall`,
`packages/daemon/src/pretool-gate.ts`) — com uma exceção: ferramenta de
servidor MCP (`mcp__*`) cujo input traz caminho de segredo vira leitura dele
(ver "Ferramenta desconhecida no gate"). Várias ações na mesma chamada: vence a
pior (`combineVerdicts`).

Requisição HTTP ao **próprio daemon** — `curl`/`wget`/`Invoke-WebRequest`/
`Invoke-RestMethod`, `fetch`/`urlopen` em código inline, ou `WebFetch` para
`localhost`, `127.0.0.0/8`, `0.0.0.0` ou `::1` na porta do daemon — é
`irreversible`, como ler `operator-token`, e `network.allowDomains` com
`localhost` não a libera. Outra porta local segue a regra de rede de sempre
(um servidor de dev do projeto não pede aprovação a cada `curl`). Idem para a
CLI de operador rodada pelo agente: `hub approve|deny|stop|restart`,
`hub policy <qualquer coisa além de show>`, `hub project trust` e
`hub hooks <install…>` (`alvoDoDaemon` e `comandoDeOperador`,
`packages/core/src/command-classifier.ts`; a porta real chega por
`SessionManager.hubPorts`).

Quais ferramentas chegam ao gate depende do agente. No **Claude Code** o hook —
o injetado por sessão (`--settings`, `packages/daemon/src/session-settings.ts`)
e o instalado por `hub hooks install claude --write` — vai com `matcher`
`Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|WebFetch|Read|Grep`
(`MATCHER_DE_RISCO`, `packages/daemon/src/hooks-config.ts`). No **Codex** o hook
vai com `matcher="*"` (`packages/daemon/src/codex-gate.ts`).

**Leitura no gate (desde 2026-09-28).** `Read` e `Grep` entraram no matcher:
antes, ler `~/.ssh/id_rsa` ou `.env` pela ferramenta de leitura do Claude nem
chamava o hook (só a vigilância via), enquanto o mesmo `cat` pelo shell parava.
Agora a leitura de segredo (`matchSecretPath`, `packages/core/src/sensitive-paths.ts`
— a mesma regra de `#classifyRead`) vai ao daemon, é `irreversible` e pede
aprovação em todos os modos; no modo de falha fechado, é negada. A leitura
**comum** sai no próprio hook (`leituraComum`, `packages/daemon/src/pretool-gate.ts`):
sem ida ao daemon, sem aprovação, e com **silêncio** na resposta — o gate não
emite `allow` para leitura, então não atropela a permissão do próprio agente.
A checagem local é conservadora (testa o caminho absoluto e o texto cru; errar
só manda uma leitura a mais ao daemon). `Grep` com filtro (`glob: ".env*"`)
conta como leitura do que o filtro alcança.

- `Glob` fica **de fora**: devolve só nomes de arquivo; o conteúdo de qualquer
  achado passa por `Read`, que é gateado.
- Limite aceito: a checagem local não lê a política, então um `risk.read`
  endurecido além de `allow` não vale para leitura comum pela ferramenta (antes
  desta mudança nenhuma leitura chegava ao gate).
- Instalação antiga (matcher sem `Read`/`Grep`) é acusada por `hub hooks` e
  `hub doctor` (`avisoDeTimeoutDoHook`, mesmo aviso do timeout antigo);
  reinstale com `hub hooks install claude --write`. Sessões subidas pelo Hub já
  recebem o matcher novo pelo `--settings`, sem reinstalar.

**Custo medido por chamada** (hook completo: processo `node` + `bin.js hook`,
stdin → stdout; loop local intercalado, n=100 por caso, Node 24.14, Windows 10,
Xeon E5-2650 v4, daemon falso que responde na hora):

| Caso | p50 | p95 |
|---|---|---|
| `node -e ""` (piso do processo) | 75 ms | 90 ms |
| `Read` comum (caminho rápido, sem daemon) | 124 ms | 139 ms |
| `Read` de segredo (vai ao daemon) | 276 ms | 309 ms |
| `Bash ls` (vai ao daemon; referência) | 275 ms | 306 ms |

Ou seja: cada `Read` comum passa a custar ~125 ms (≈50 ms acima do piso de
subir um `node`), metade do que custaria mandar toda leitura ao daemon. O
caminho rápido responde antes de carregar a config (que puxa o zod). Leitura de
segredo custa o mesmo que qualquer chamada de shell — e, em seguida, a espera
pela decisão humana.

Desfecho (`SessionManager.gateToolCall`, `packages/daemon/src/session-manager.ts`):
`allow` passa; `deny` nega sem perguntar a ninguém (e registra na timeline);
`approve` abre uma aprovação **real** (aparece em `hub approvals` e no painel) e
a chamada do hook **fica bloqueada** até alguém decidir. Negar (por humano ou
por tempo) nega **só aquela chamada**: o agente recebe o motivo real e a sessão
segue. Sessão já encerrada não reabre aprovação: nega. Toda decisão sobre uma
sessão do Hub entra na trilha de auditoria (`hub audit`).

O gate só aplica política a chamadas que consegue ligar a uma sessão do Hub:
pelo id (`AGENTS_HUB_SESSION_ID`, que o Hub injeta no Claude —
`packages/adapters/src/process-adapter.ts`; `--session`, que o Hub põe no
comando do hook do Codex), pelo id nativo, ou pelo diretório de uma sessão viva.
Fora disso — o Claude que você abre na mão, inclusive num projeto registrado — a
resposta é `allow` "fora de uma sessão do Hub".

**Tempos.** Três relógios, nesta ordem (`packages/daemon/src/pretool-gate.ts`):

| Relógio | Valor | Quando estoura |
|---|---|---|
| Espera do daemon por decisão humana (`ESPERA_DO_GATE_MS`) | 55 s | o daemon responde `deny` "ninguém respondeu — não por proibição"; a sessão **continua** |
| Teto HTTP do processo do hook (`TETO_HTTP_DO_HOOK_MS`) | 100 s | o hook aplica o modo de falha (abaixo) |
| Timeout do hook na config do agente (`TIMEOUT_DO_HOOK_SEC`) | 120 s | o agente desiste do hook e **roda a ferramenta** |

A ordem é o contrato: foi medido com o `claude` real que hook estourado é erro
não bloqueante — a ferramenta roda. Instalações antigas gravaram `timeout: 10`
(Claude) e `timeoutSec = 20` (Codex) contra 60 s de espera do daemon, e com
isso **toda ação que pedia aprovação rodava sem ela depois de 10/20 s**.
`hub hooks` e `hub doctor` acusam hook com timeout antigo
(`avisoDeTimeoutDoHook`, `packages/daemon/src/hooks-config.ts`); reinstale com
`hub hooks install claude --write`. O Codex recebe o timeout a cada sessão, sem
reinstalar.

**Daemon indisponível** (fora do ar, erro, resposta inválida, mais de 100 s): o
hook não tem política para consultar e escolhe um lado (`modoDeFalhaEfetivo`,
`packages/cli/src/hook.ts`). "Sessão do Hub" aqui é: o hook recebeu um id de
sessão válido (ambiente ou `--session`).

| `~/.agents-hub/config.json` | Sessão do Hub | Fora do Hub |
|---|---|---|
| `gate.failMode` ausente (**padrão**) | **fechado**: nega shell, escrita, rede e leitura de segredo; leitura comum passa | aberto |
| `"gate": { "failMode": "closed" }` | fechado | fechado |
| `"gate": { "failMode": "open" }` | aberto | aberto |

- **Numa sessão do Hub** o daemon é quem a roda e ela prometeu passar pela
  política. Liberar no silêncio transformaria derrubar (ou só atrasar) o daemon
  no jeito de passar um `git push --force` por um gate `supervised`.
- **Fora do Hub** o hook está instalado globalmente e dispara em todo uso do
  agente. Fechar ali faria o Hub desligado travar o seu editor, e a reação
  natural seria desinstalar o hook — perdendo o gate também nas sessões do Hub.
- O `failMode` é lido pelo hook da config **global** (`packages/cli/src/hook-run.ts`);
  config de projeto não o altera.

### Token de operador

Protege a API contra o próprio agente (e qualquer script) que tente aprovar a
própria ação, afrouxar política, confiar num repositório ou derrubar o daemon
(`packages/daemon/src/operator-auth.ts`).

- **Arquivo**: segredo aleatório de 32 bytes em
  `<AGENTS_HUB_HOME>/operator-token`, criado em arquivo temporário com modo
  0600 e, no Windows, ACL sem herança só com o seu usuário (`icacls
  /inheritance:r /grant:r <usuário>:F`), e só então renomeado — nunca existe em
  disco com a permissão herdada da pasta. É reaproveitado entre subidas; para
  trocar, apague o arquivo e reinicie o daemon.
- **Onde é exigido**: toda rota registrada com `operator: true` responde `401`
  sem ele, antes de ler corpo ou parâmetro (`packages/daemon/src/server.ts`,
  `#dispatch`; o teste `operator-routes-table.test.ts` percorre a tabela de
  rotas inteira). Hoje:
  - `POST /approvals/:id`;
  - `POST /shutdown`, `POST /maintenance/sweep`, `POST /maintenance/backup`;
  - `PUT /policy`, `PUT /projects/:id/policy` (também com `?dryRun=1`);
  - `PUT /projects/:id/context`, `POST /projects/:id/trust`,
    `POST /projects/:id/import` (também a prévia);
  - `POST /projects/:id/folders`, `DELETE /projects/:id/folders/:folderId`;
  - `PUT /budget/:rootId`, `POST /integrations/:agentId/:tipo` (hooks/MCP pelo painel).
- **Como se apresenta**: `Authorization: Bearer <token>` ou `X-Hub-Token`
  (a CLI lê o arquivo sozinha); a Web UI servida pelo daemon recebe um cookie
  `HttpOnly; SameSite=Strict` só quando o **navegador** carrega o documento
  (`Sec-Fetch-Dest: document`, `Sec-Fetch-Mode: navigate`, vindo de você ou da
  própria origem); em `vite dev` o proxy lê o arquivo e injeta o header.
  Comparação em tempo constante.
- **`by` autenticado**: quem aprovou/negou/mudou a política é
  `cli:<usuário>` ou `web`, derivado da credencial — o corpo da requisição não
  participa. É o que vai para a auditoria.
- **Fora do alcance do agente**: o token não é variável de ambiente do daemon,
  então não chega ao ambiente do agente (há teste); o MCP server e o hook não o
  têm; o arquivo é segredo para o classificador — agente com gate que tenta
  lê-lo pelo shell ou pela ferramenta `Read`/`Grep` do Claude cai em aprovação
  (`operator-token` é nome de segredo; ver "Leitura no gate").

**Limites, sem rodeio.** Um **processo do seu usuário que leia o arquivo por
fora do gate** (agente sem hook, script qualquer) tem o token; sem sandbox de
sistema, nada no espaço do usuário fecha isso. O mesmo vale para o cookie:
`GET /` com `Sec-Fetch-Dest: document`, `Sec-Fetch-Mode: navigate` e
`Sec-Fetch-Site: none` devolve o token em `Set-Cookie`, e esses cabeçalhos o
`curl` forja — não há cabeçalho que separe navegador de processo local (ver
"Processo local do mesmo usuário não é fronteira"). Criar, delegar, cancelar e
mandar mensagem a sessões **não** exige token — é o que o MCP do agente usa. E
cookie não isola por porta: outro servidor local em `127.0.0.1` recebe o cookie
do painel se você o abrir no mesmo navegador.

### Importação de config de agente e registro de projeto

- **Importação MCP não grava segredo em claro** (`packages/daemon/src/absorption.ts`).
  A importação lê a descoberta **crua** (precisa do comando real), então
  mascarar `/discovery` não bastava: `--api-key sk-...` ia parar no `.mcp.json`
  do projeto, que é versionado. Servidor com segredo em args ou URL (mesmo
  critério de `redactArgs`/`redactUrl`) vai para `skipped`, com motivo, também
  no dry-run. **Pular, não mascarar**: `--api-key ***` gravado seria um
  servidor que sobe e falha na autenticação — um arquivo quebrado com cara de
  certo. A credencial tem caminho próprio: `env` do servidor com `includeEnv`.
- **Pasta de projeto não pode ser raiz nem sistema**
  (`packages/daemon/src/project-path.ts`, `raizProibida`). Projeto é o
  `workdir` contra o qual o gate decide "escrita dentro do diretório da
  sessão"; registrar `C:\Windows` transformava `System32` em "dentro do
  projeto". `POST /projects` (e pastas vinculadas) responde 400 para: raiz de
  unidade/filesystem e de compartilhamento UNC, o próprio home, `%WINDIR%`,
  Program Files (x64/x86), ProgramData, compartilhamento administrativo
  (`\\host\C$`, `ADMIN$`, `IPC$`) e, no POSIX, `/etc /bin /sbin /boot /proc
  /sys /dev /usr/{bin,sbin,lib}` com tudo abaixo e `/usr`, `/var`, `/root`,
  `/home` só exatos (`/var/folders` é o tmpdir do macOS, `/var/www` guarda
  projeto). A checagem roda no texto (antes do `stat`, para UNC não esperar a
  rede) e de novo na grafia canônica (junction, nome 8.3).

### Vetores do repositório (`<repo>/.agents-hub/config.yaml`)

O arquivo é versionado: quem clona o repositório herda-o. Trate-o como qualquer
script do repositório — **não confiável** até você revisá-lo
(`packages/daemon/src/repo-trust.ts`, `packages/daemon/src/project-config.ts`).

| Campo do repo | O que um repo hostil faria | Sem `hub project trust` |
|---|---|---|
| `policy.validation.command` | executar processo arbitrário (`shell: true`) | ignorado, com aviso |
| `policy.validation.review.*` | ligar/escolher o agente revisor (outro binário, outro gasto) | ignorado, com aviso |
| `env.<agente>.*_BASE_URL`, `*_API_BASE`, `*_ENDPOINT`... | desviar a API do agente para um servidor do atacante — o CLI autenticado envia código, prompt e credencial para lá | ignorado, com aviso que mostra o destino |
| `env.<agente>.*_API_KEY`, `GOOGLE_*`... | trocar a conta/credencial do agente | ignorado, com aviso |
| `prompts.<agente>`, `memory` | injetar instruções no prompt de todo agente | ignorado, com aviso |
| `env` fora da lista de permissão (`NODE_OPTIONS`, `PATH`, `HTTP(S)_PROXY`, `NODE_EXTRA_CA_CERTS`, `LD_PRELOAD`, `GIT_SSH_COMMAND`...) | execução arbitrária, troca de binário, interceptação TLS | recusado **sempre**, mesmo com `trust` (`packages/core/src/agent-env.ts`) |
| resto da política (allow/deny, orçamento, timeouts, `maxDepth`, `fallback`...) | afrouxar limites | só aperta, campo a campo (`mergePolicyLayer`); não precisa de `trust` |

**Trust-on-first-use.** `hub project trust` grava no banco do Hub, junto da
marca, o hash do conteúdo sensível **de agora** e lista o que está sendo
confiado. Se o repositório mudar qualquer campo sensível depois — um `git pull`
que troca a `ANTHROPIC_BASE_URL`, um `validation.command` novo —, o hash não
bate e a confiança fica **suspensa**: os campos voltam a ser ignorados, com aviso
na timeline e em `GET /projects/:id/context`, até você rodar `hub project trust`
de novo. Confiança dada antes do hash existir conta como suspensa. A rota de
confiança exige o token de operador.

**O que você configura pelo Hub é outra camada.** Memória, instruções e env
definidos pelo painel, por `hub project env|prompt` ou por `hub import` ficam no
banco do Hub (`~/.agents-hub`), fora do repositório, e valem sem `trust` (ainda
passando pela lista de permissão de env). Quando as duas camadas existem, a do
Hub vence variável a variável.

**Credenciais.** O Hub não lê os arquivos de credencial dos CLIs: cada adapter
roda com o login que o próprio CLI já tem (`~/.claude`, `~/.codex`, ...). O env
que **você** informa pelo Hub (ex.: uma `*_API_KEY` em `hub project env`) fica
em **texto puro** no banco do Hub e é repassado ao agente. Não existe cofre; a
interface `CredentialProvider` está preparada mas não implementada, de propósito.

---

## O que o Hub NÃO garante

Esta seção importa mais que a anterior. Confundir os níveis abaixo é como se
perde a proteção de verdade.

### Prevenção só existe onde há gate pré-execução

| Nível | Como funciona | Cobertura |
|---|---|---|
| **Gate pré-execução** | O agente pergunta *antes* de rodar a ferramenta e obedece. Prevenção real | **Claude Code** (com `hub hooks install claude --write`) e **Codex** (com `hub hooks install codex --write`) |
| **Permissão nativa** | O Hub traduz o modo em regras de permissão do próprio agente | **OpenCode**, quando o Hub sobe o servidor: agentes `hub-*` por modo; "aprovação" vira `deny` (não há canal para responder `ask`). Com servidor subido por você, só `plan`/`build` nativos, com aviso (`packages/adapters/src/opencode/permissions.ts`) |
| **Portão** | Ação que passa por dentro do Hub (delegação, reserva de orçamento). Retida antes de acontecer | Todos |
| **Vigilância** | Evento do que **já aconteceu**; para a *próxima* ação | Todos que emitem eventos de comando/arquivo (abaixo) |

| Agente | Gate pré-execução | Vigilância de comando/arquivo |
|---|---|---|
| Claude Code | Sim (hook instalado) | Sim |
| Codex | Sim (bypass de confiança ligado) | Sim |
| opencode | Não (permissão nativa, acima) | Sim |
| openclaude | Não — o hook é gravável, mas o binário consultá-lo não foi exercido | Sim (mapper do Claude) |
| copilot, kimi, antigravity | Não | Sim (mappers próprios) |
| mimo | Não | Sim para o envelope `tool_use` do `run --format json` (`packages/adapters/src/mappers/generic.ts`), conferido no bundle, não em execução real |
| cursor | Não | **Não**: o mapper `generic-json` só extrai texto do stream no estilo Claude; nenhum `command.executed`/`file.changed` é emitido, então não há o que vigiar |

**Codex.** Hook não confiável é **ignorado em silêncio** pelo binário: sem
`--dangerously-bypass-hook-trust` (ligado por `hub hooks install codex --write`,
escolha explícita sua nesta máquina) não há prevenção nenhuma. O Hub recusa
abrir sessão `--mode supervised` do Codex sem isso, em vez de fingir
(`packages/daemon/src/codex-gate.ts`); `semi`/`autonomous` rodam com aviso.

**Claude Code.** Sem `hub hooks install claude --write` (que grava o hook em
`~/.claude/settings.json`) não há gate, só vigilância.

O modo de falha não cobre: um agente que apaga ou reescreve o próprio hook
(escrever `~/.claude/settings.json` é `irreversible`, mas só onde há gate), que
roda o comando fora do agente gateado, ou processo local que fala direto com a
API do daemon.

### Processo local do mesmo usuário não é fronteira

Qualquer processo que roda com o seu usuário consegue o token de operador — e
com ele aprovar, afrouxar a política, confiar num repositório ou derrubar o
daemon. Há três caminhos e nenhum fecha no espaço do usuário: ler
`operator-token`; rodar a CLI (`hub approve`), que lê o arquivo sozinha; e
pedir `GET /` ao daemon imitando um navegador (os `Sec-Fetch-*` são proibidos
para uma **página**, não para o `curl`).

As camadas que existem, e o que cada uma segura:

| Camada | Segura | Não segura |
|---|---|---|
| ACL do arquivo (0600 / `icacls` só do usuário) | outro usuário do SO | o seu usuário |
| Gate: `operator-token` é segredo no `Read`/`Grep` e no shell | agente **com gate** lendo o arquivo | script em arquivo (`node x.js`): o classificador não lê o conteúdo |
| Gate: HTTP ao daemon e CLI de operador são `irreversible` | agente **com gate** fazendo `curl` forjado, `fetch` inline, `WebFetch` ou `hub approve` — para em todo modo, inclusive `autonomous` | o mesmo pedido de dentro de um script em arquivo; alvo que só se resolve em tempo de execução (`curl $URL` cai na regra de rede, não nesta) |
| Aprovação para rede não liberada | `supervised`/`semi` param em `curl` para host fora de `allowDomains` | `autonomous` libera `escalate` |

O que **não** é defendido: agente **sem gate** (openclaude, copilot, kimi,
cursor, mimo e qualquer um sem `hub hooks install`), inclusive em
`autonomous` — lá só há vigilância, que vê o fato consumado; e qualquer
processo seu fora do Hub. Em `vite dev` o proxy injeta o token em toda
requisição: o servidor de dev é, ele mesmo, uma porta sem token.

**Decisão registrada (R05-03, bilhete de uso único).** Avaliamos trocar os
`Sec-Fetch-*` por um bilhete de uso único (`hub open` pede ao daemon, com o
token, um bilhete curto; o navegador abre `/?ticket=…` e só então recebe o
cookie). **Rejeitado**: (1) não fecha nada — o processo que conseguiria o
bilhete é o que roda a CLI ou um script, e esse lê `operator-token` do mesmo
jeito; o bilhete troca um caminho sem token por outro que exige o arquivo,
que esse processo já tem; (2) quebra o painel para quem digita o endereço ou
usa favorito — o cookie morre com o navegador, então cada reinício pediria
`hub open`, e o painel precisaria de um estado novo "sem credencial". Custo
certo por um ganho que não existe contra o atacante real deste cenário. Se um
dia houver sandbox de SO para o agente (arquivo fora do alcance dele), o
bilhete passa a valer e esta decisão deve ser revista.

### Ferramenta desconhecida no gate

Ferramenta que o gate não sabe classificar (`Task`, ferramenta nova do agente,
`mcp__*` em geral) **não vira ação**: o gate não tem opinião e a permissão do
próprio agente decide. É a opção conservadora de verdade: negar o que não se
entende faria cada ferramenta nova virar um bloqueio misterioso, e a resposta
de quem usa é desligar o hook inteiro — o que tira também a proteção do shell e
da escrita. Na prática:

- **Claude Code**: o hook só é chamado para `MATCHER_DE_RISCO`
  (`packages/daemon/src/hooks-config.ts`); ferramentas fora dele nunca chegam
  ao Hub e seguem as regras de permissão do Claude. **Não alargue o matcher à
  mão** (ex.: `.*`): para ferramenta sem ação o daemon responde `allow`, e no
  Claude um `allow` explícito pula a pergunta de permissão do próprio agente.
- **Codex**: o hook vai com `matcher="*"`, e `allow` é silêncio — a
  permissão do Codex decide.
- **Exceção**: ferramenta `mcp__*` cujo input traz, num valor com cara de
  caminho (sem espaço), um caminho de segredo vira leitura desse caminho —
  `mcp__filesystem__read_file {path: ~/.ssh/id_rsa}` é o `cat` do mesmo
  arquivo. Texto livre que só menciona `.env` não conta. Onde o hook não é
  chamado para `mcp__*` (Claude, pelo matcher), a exceção não tem efeito.

### O classificador é análise estática, não sandbox

Ele lê o texto do comando; não vê o conteúdo de um script em arquivo
(`bash deploy.sh`, `node build.js`, `npm run x`), e código inline é avaliado por
heurística. O que ele garante é que **composição não esconde nada** e que o que
ele não entende nunca vira `allow`.

### O worktree não é sandbox

Cada sessão roda num git worktree próprio, o que impede agentes de pisarem uns
nos outros e nas suas mudanças locais. **Não** impede um agente de escrever fora
dele — isso é `escalate` e depende da política ser aplicada, o que nos agentes
sem gate acontece *depois* do fato. Isolamento de verdade exige container, que
não existe. `node_modules`, `.venv` e `vendor` são **ligados por junction** ao
projeto principal (para o portão de validação rodar): dois agentes escrevendo em
`node_modules/.cache` colidem de verdade.

### Loopback não é autenticação

A borda HTTP barra páginas web; o token barra as rotas de operador. As demais
rotas (abrir, delegar, cancelar sessão; ler eventos) aceitam qualquer processo
local. Isso é aceitável para um daemon em `127.0.0.1` e **não é aceitável
exposto na rede ou por túnel**: o daemon escuta em `127.0.0.1` por padrão
(`packages/daemon/src/config.ts`), e mudar `host` no `config.json` ou publicar
a porta por proxy/túnel abre a máquina. Acesso remoto está em
aberto no roadmap justamente por isso.

### O agente executa código não confiável por natureza

Um repositório hostil pode conter instruções destinadas ao agente (prompt
injection) que o Hub não filtra e não sabe detectar. Os controles do Hub limitam
o **dano** (política, orçamento, aprovação para o irreversível); não impedem o
agente de ser convencido a tentar.

### Retenção local, sem criptografia

O banco vive em `~/.agents-hub/hub.db`, sem criptografia. O payload normalizado
dos eventos (`payload_json`) fica **para sempre** (ADR 06.3) — inclui trechos de
arquivo que o agente leu e o que ele imprimiu. O bruto do agente (`raw_json`) é
zerado 7 dias depois de a sessão terminar (`retention.rawEventDays`,
`packages/daemon/src/event-retention.ts`), sem `VACUUM`. Não há comando de
expurgo de sessão. `hub backup` copia o banco inteiro, com tudo isso dentro.

---

## Fora de escopo

- Falhas dos CLIs dos agentes (reporte ao projeto do agente).
- Um processo local malicioso rodando com o seu usuário — nesse ponto a máquina
  já está comprometida e o Hub não é a fronteira (ver "Processo local do mesmo
  usuário não é fronteira" para o que as camadas seguram mesmo assim).
- Falta de authn nas rotas que não são de operador, no daemon loopback —
  decisão declarada acima. Um relato de "o daemon não pede senha para abrir
  sessão" será fechado com um link para esta seção; um relato de "consegui
  chegar no daemon de outra máquina", "uma página web conseguiu mudar estado"
  ou "uma rota de operador respondeu sem token" não.
