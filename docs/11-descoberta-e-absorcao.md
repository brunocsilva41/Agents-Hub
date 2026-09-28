# 11 — Descoberta e absorção do ambiente dos CLIs

O Hub não pede que você reconfigure tudo do zero: ele **descobre** o que cada CLI
já tem (versão, autenticação, modelo padrão, servidores MCP, instruções globais) e
pode **absorver** parte disso para o projeto ou compartilhar as ferramentas entre
agentes. Descobrir é só leitura. Importar é dry-run por padrão.

## CLI

```
hub discover                      # tabela: instalado, versão, auth, modelo, nº de MCP, instruções
hub discover --agent claude       # detalhe de um agente
hub discover --json [--refresh]   # JSON; --refresh ignora o cache de 30s

hub import claude                                   # plano (dry-run): instructions + env
hub import claude --kinds instructions,env,mcp --to codex,cursor
hub import claude --to codex,cursor --write         # grava (merge + backup versionado .bak-<data>)
hub import claude --to cursor --include-env --write # também copia env dos servidores MCP
hub import claude --overwrite --write               # substitui instrução/env que o projeto já tem
```

Sem `--write` nada é gravado; o comando imprime o plano e o que rodar para aplicar.
`--kinds` padrão é `instructions,env`; `mcp` exige `--to`.

## API do daemon

| Rota | O que faz |
|---|---|
| `GET /discovery[?refresh=1]` | `{ agents: AgentDiscovery[] }` de todos os agentes |
| `GET /discovery/:agentId[?refresh=1]` | `{ agent: AgentDiscovery }` (404 se o agente não existe) |
| `POST /projects/:id/import` | `ImportResult` (contrato em `packages/core/src/discovery.ts`). **Exige o token de operador** (`<AGENTS_HUB_HOME>/operator-token`), inclusive no dry-run, porque a prévia expõe o que os CLIs têm; `hub import` lê o token sozinho. Aplicado (não dry-run) vai para a trilha de auditoria como `project.import` |

Descoberta combina o probe do registry (versão/binPath) com `discoverAgent`
(`packages/adapters/src/discovery`), com cache de 30s por agente.

Corpo de `POST /projects/:id/import` (`strict`; campo desconhecido = 422):

```json
{ "agentId": "claude",
  "kinds": ["instructions", "env", "mcp"],
  "dryRun": true,
  "targetAgents": ["codex", "cursor"],
  "overwrite": false,
  "includeEnv": false }
```

- `dryRun` tem padrão **`true`**; só `dryRun: false` escreve.
- `instructions`: grava CLAUDE.md/AGENTS.md globais como instrução do projeto para
  aquele agente (o mesmo que `hub project prompt`). Não sobrescreve sem `overwrite`.
  Recusa (em `skipped`) conteúdo com cara de credencial ou acima de 8000 caracteres
  (limite por agente; nunca trunca em silêncio).
- `env`: só `model` e `baseUrl` descobertos, mapeados para a variável do agente
  (`ANTHROPIC_MODEL`/`ANTHROPIC_BASE_URL` no Claude, `OPENAI_BASE_URL` no Codex/OpenCode,
  `MODEL`/`MODEL_BASE_URL` como padrão para os demais). Cada uma passa por
  `filtrarEnvDeProjeto` (lista de permissão de `core/agent-env.ts`); o que não passa,
  ou parece credencial, ou é URL com usuário/senha/`?key=`, vai em `skipped` com o motivo.
  Não sobrescreve variável já definida sem `overwrite`.
- `mcp`: copia os servidores MCP da origem (exceto o próprio Hub) para a config MCP dos
  `targetAgents`, com os mesmos alvos/formatos de `hub mcp install`. Nome que já existe
  no destino é mantido; nunca duplica nem apaga; backup versionado (`.bak-YYYYMMDD-HHMMSS`, nunca sobrescrito) antes de escrever. Destino sem
  caminho/formato confirmado (`verified: false`, ex. kimi, mimo) é pulado, não adivinhado.

## Modelo de segurança

1. **Segredo nunca sai.** A resposta de `/discovery` é sanitizada no daemon mesmo que o
   leitor de um agente vaze: todo valor de env de servidor MCP vira `***` (só os nomes
   ficam) e credenciais embutidas em URL são mascaradas.
2. **Dry-run não escreve nada** — nem o contexto do projeto no Hub, nem config de outro agente.
3. **Env do projeto pela lista de permissão.** Instruções e env importados vão para o
   contexto do projeto no banco do Hub (fora do repositório, item 1.9 do GOAL, migração 6),
   e por isso valem **sem** `hub project trust` — a confiança só é exigida para o que vem do
   `.agents-hub/config.yaml` do repositório. Mesmo assim só entram nomes aceitos pelo filtro
   e nunca valores com cara de segredo: no banco eles ficam em texto puro e seguem para toda
   sessão do agente.
4. **Env de servidor MCP é opt-in.** Sem `includeEnv: true` nenhuma variável é copiada
   (o `skipped` diz quais nomes ficaram de fora). Com `includeEnv`, o valor real é relido
   do arquivo de origem só na hora de gravar, e só se existir ali (a máscara `***` não
   conta); vai direto para o arquivo de destino (config do próprio usuário) e nunca
   aparece em resposta, plano ou log — só os nomes.
5. **Config alheia é tratada com cuidado:** merge, backup versionado `.bak-<data>`, recusa a sobrescrever
   JSON inválido, nunca remove entrada existente.
6. Só leitura e escrita locais; o daemon continua aceitando apenas localhost (`guard.ts`).

## Onde está o código

- `packages/daemon/src/absorption.ts` — `DiscoveryService` (cache + sanitização) e `ImportService`.
- `packages/daemon/src/mcp-config.ts` — alvos MCP por agente e `addMcpServers` (extraídos de
  `packages/cli/src/mcp-install.ts`, que os reexporta).
- `packages/daemon/src/hub.ts` — `createHub(overrides, { discoverAgent, homeDir })` para injetar
  um leitor falso em testes.
- `packages/cli/src/discover-cmd.ts` — `hub discover` e `hub import`.
