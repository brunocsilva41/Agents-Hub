# Variáveis de ambiente

Seis variáveis `AGENTS_HUB_*` configuram o Hub de fora — todas lidas e
validadas num lugar só, [`packages/core/src/hub-env.ts`](../packages/core/src/hub-env.ts)
(`readHubEnv`), usado pelo daemon, pela CLI (via `loadConfig`) e pelo MCP
server. Valor inválido é recusado com o nome da variável, em uma linha (sem
stack trace), por qualquer comando.
Antes deste módulo existir, cada entrypoint lia `process.env` cru, e uma
variável mal formada (ex. `AGENTS_HUB_PORT=abc`) virava `NaN` silencioso em vez
de erro — o daemon subia mesmo assim, só que numa porta aleatória escolhida
pelo SO.

Duas outras, `AGENTS_HUB_SESSION_ID` e `AGENTS_HUB_AGENT_ID`/`AGENTS_HUB_TASK_ID`,
**não aparecem aqui** de propósito: são internas, injetadas pelo Hub no
processo do agente (ver `packages/adapters/src/process-adapter.ts`), não algo
que você configura.

## `AGENTS_HUB_HOME`

Raiz do estado global do Hub — banco, worktrees, artefatos, logs, manifestos e
`config.json`. Padrão: `~/.agents-hub`.

```bash
AGENTS_HUB_HOME=/mnt/dados/agents-hub hub daemon
```

## `AGENTS_HUB_PORT`

Porta em que o daemon escuta. Padrão: `4747` (ou o que `config.json` disser).
Precisa ser um inteiro entre 1 e 65535 — qualquer outro valor faz o daemon
recusar subir com um erro explícito, em vez de escutar numa porta aleatória.

```bash
AGENTS_HUB_PORT=5050 hub daemon
```

Vale para TODOS os comandos, não só para o daemon: `loadConfig` aplica a
variável (precedência: padrão < `config.json` < `AGENTS_HUB_PORT` < override
explícito no código). Então `AGENTS_HUB_PORT=5050 hub status` fala com a 5050,
o autostart sobe o daemon na 5050, o hook do gate consulta a 5050 e
`hub mcp install` grava `AGENTS_HUB_URL` com a 5050. Antes, só `hub daemon`
lia a variável e o resto da CLI ficava sondando a 4747.

## `AGENTS_HUB_NO_AUTOSTART`

Quando o daemon não está no ar, todo comando da CLI sobe ele sozinho (ver
`packages/cli/src/daemon-control.ts`). `AGENTS_HUB_NO_AUTOSTART=1` desliga essa
conveniência — útil em CI ou quando você quer controlar o ciclo de vida do
daemon manualmente. `0` ou ausente mantém o autostart ligado; qualquer outro
valor (`sim`, `true`) é recusado, em vez de ser lido como "não" em silêncio.

Não confundir com `hub autostart enable`, que sobe o daemon **no login do
Windows** (ver [docs/13-instalacao.md](13-instalacao.md)).

```bash
AGENTS_HUB_NO_AUTOSTART=1 hub status   # falha em vez de subir o daemon sozinho
```

## `AGENTS_HUB_URL`

Base URL do daemon, para quem fala com ele de fora do processo: o MCP server
(`packages/mcp/src/main.ts`) e o proxy de dev da Web UI
(`packages/web/vite.config.ts`). Padrão: `http://127.0.0.1:4747`.

```bash
AGENTS_HUB_URL=http://127.0.0.1:5050 npx agents-hub-mcp
```

## `AGENTS_HUB_MCP_AGENT`

Identidade do agente principal quando o MCP server roda **fora** do Hub — por
exemplo, você abriu o Cursor na mão e ele chama `hub_agent_call` sem que exista
uma sessão do Hub por trás. Sem isto, a sessão adotada aparece no grafo como
`"externo"`. `hub mcp install` já grava esta variável automaticamente na config
de cada agente (ver `packages/cli/src/mcp-install.ts`).

## `AGENTS_HUB_MCP_GRACE_MS`

Carência, em milissegundos, que o MCP server espera antes de sair depois que o
hospedeiro fecha o stdin — dá tempo de uma resposta já calculada terminar de
ser escrita em stdout antes do processo morrer. Padrão: `3000`.

```bash
AGENTS_HUB_MCP_GRACE_MS=500 npx agents-hub-mcp
```
