# Instalação — seção técnica

> O guia de instalação para o usuário final é o item 8.4 do GOAL. Esta página
> registra **como** o Hub é distribuído e instalado, e por quê.

## Requisitos

- **Node ≥ 22.5.** Em 22.5–22.12 (e 23.0–23.3) `node:sqlite` só existe atrás de
  `--experimental-sqlite`; a CLI cuida disso sozinha (ver abaixo). A partir de
  22.13 / 23.4 a flag não é mais necessária. Conferido contra os binários
  (`npx node@22.5.0`, `@22.12.0`, `@22.13.0`).
- **git** no PATH (worktrees por sessão).
- Windows é a plataforma validada (CI bloqueante); Linux roda em job
  informativo.

## Distribuição: tarball `agents-hub-<versão>.tgz`

```bash
npm ci && npm run build        # compila pacotes + painel
npm run pack:dist              # -> dist-pack/agents-hub-<versão>.tgz
npm i -g ./dist-pack/agents-hub-0.1.0.tgz
hub --version && hub doctor
```

`scripts/pack-dist.mjs` monta um pacote único porque os pacotes do workspace
(`@agents-hub/*`) são `private` e se enxergam por symlink — não dá para
`npm pack` do monorepo. O tarball é **autocontido**: `npm i -g` dele não
precisa de registry.

```
agents-hub/
  package.json           bin: hub, agents-hub-mcp · license: MIT · private
  bin/hub.js             -> node_modules/@agents-hub/cli/dist/bin.js
  bin/agents-hub-mcp.js  -> node_modules/@agents-hub/mcp/dist/main.js
  manifests/             manifestos dos agentes
  web/                   painel (build do Vite)
  node_modules/@agents-hub/{core,store,adapters,client,daemon,mcp,cli}   (só dist/*.js)
  node_modules/<terceiros>                                                (zod, yaml, SDK do MCP…)
```

Tudo vai em `bundleDependencies`. Não é só conveniência: com só os pacotes
internos no bundle, o `npm pack` marca as dependências deles como "do bundle"
sem incluí-las, e o `npm i -g` cria pastas vazias no lugar (visto no primeiro
teste: `ERR_MODULE_NOT_FOUND` de `zod` no `hub help`).

`private: true` fica no pacote gerado de propósito: publicar no registry é
decisão explícita do dono do projeto, não efeito colateral de um `npm publish`. `npm pack` e
`npm i -g <tgz>` funcionam normalmente com `private`.

### Onde o Hub se acha depois de instalado

`installRoot()` (`packages/daemon/src/config.ts`) reconhece os dois layouts:

| Layout | daemon em | raiz | painel |
|---|---|---|---|
| clone | `packages/daemon/dist` | raiz do repo | `packages/web/dist` |
| instalado | `agents-hub/node_modules/@agents-hub/daemon/dist` | `agents-hub/` | `agents-hub/web` |

Hook do gate (`hub hooks install claude`, gate do Codex) e MCP server
(`hub mcp install`) são resolvidos **relativos à própria CLI instalada**
(`@agents-hub/cli` e `@agents-hub/mcp` são irmãos de `@agents-hub/daemon` nos
dois layouts). Instalado pelo tarball, o que vai para as configs dos agentes é
`"<node>" "<prefixo npm>/node_modules/agents-hub/node_modules/@agents-hub/cli/dist/bin.js" hook`
— um caminho que não muda entre atualizações (`npm i -g` de uma versão nova
substitui no mesmo lugar) e não depende do clone. Rodando a partir do clone
(`npm link`), aponta para o clone, como antes.

Instalações antigas gravaram `.../main.js" hook`; reinstalar
(`hub hooks install claude --write`) substitui essa entrada em vez de duplicar.

## A entrada `bin.js`

O `bin` do pacote é `packages/cli/dist/bin.js`, não `main.js`. Ele existe
porque três coisas precisam acontecer antes de qualquer import estático que
chegue em `node:sqlite`:

1. **Flag do SQLite.** Em Node 22.5–22.12 a CLI se reexecuta com
   `--experimental-sqlite` (mesmo Node, mesmos argumentos, `stdio` herdado).
   O autostart do daemon passa a flag direto no `spawn`, sem processo
   intermediário. Nas versões novas, nada muda.
2. **`ExperimentalWarning` do SQLite** é filtrado (só ele — outros avisos
   passam) em todo comando, inclusive no daemon autostartado.
3. **`hub hook`** vai direto para `hook-run.js`, que não carrega o índice do
   daemon (store, `node:sqlite`, adapters, servidor HTTP): ~480 ms → ~250 ms
   por chamada de ferramenta do agente nesta máquina (Node 24), e nunca
   reexecuta.

Erro de ambiente (`config.json` inválido, variável inválida, porta ocupada)
vira uma linha — `hub: [HUB_CONFIG_INVALID] <arquivo>:<linha>:<coluna>: ...` —
sem stack trace. Erro sem código (bug) mantém o stack.

`hub --version` imprime a versão do pacote sem carregar o resto.

## Autostart no login (Windows)

Desligado por padrão. Comandos:

```bash
hub autostart status    # ligado/desligado e onde está o arquivo
hub autostart enable    # grava o item de login
hub autostart disable   # remove
```

`enable` grava `agents-hub-daemon.vbs` na pasta Inicializar do usuário
(`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`), em UTF-16 com BOM
(caminho com acento sobrevive). Ele roda, com janela oculta,
`"<node>" "<bin.js>" autostart run`, que usa o mesmo `ensureDaemon` do
autostart sob demanda — log em `<home>/logs/daemon-AAAA-MM-DD.log`.
`AGENTS_HUB_HOME`/`AGENTS_HUB_PORT` definidas no momento do `enable` vão
gravadas no script.

Por que não `schtasks /sc onlogon` (exige terminal elevado na maioria das
máquinas), nem `.cmd` (abre console a cada login), nem chave `Run` do registro
(menos visível, mais difícil de desfazer à mão). Ressalva: a Microsoft anunciou
o VBScript como recurso opcional a ser removido; quando isso acontecer o `.vbs`
simplesmente não roda, e o mecanismo precisa trocar.

Fora do Windows, `enable` recusa e sugere registrar `hub autostart run` no
gerenciador de sessão (systemd `--user`, launchd).

## Teste de instalação em diretório limpo

```bash
npm run build && npm run test:install
# com um Node antigo (ex.: 22.12, que exige a flag do SQLite):
npm run test:install -- --node "<caminho do node.exe>"   # npx -y node@22.12.0 -p process.execPath
```

`scripts/test-install.mjs`: empacota, instala com `npm i -g --prefix <tmp>`
(o prefixo global real não é tocado), e com `AGENTS_HUB_HOME` temporário,
`AGENTS_HUB_NO_AUTOSTART=1` e `AGENTS_HUB_PORT` numa porta livre verifica
`hub --version`, `hub help` (sem `ExperimentalWarning`), `hub mcp` e
`hub hooks install claude` em dry-run apontando para a instalação, `hub hook`;
sobe `hub daemon` da instalação, espera `/health`, confere painel e
manifestos, roda `hub agents`/`status`/`doctor` (só `--version` dos agentes,
nenhuma chamada a modelo) e encerra com `POST /shutdown` usando o token de
`<home>/operator-token`. Passou em Node 24.14 e 22.12.0 nesta máquina.

## Licença

**TODO — decisão do dono do projeto.** Todos os `package.json` declaram
`"license": "UNLICENSED"` e não há arquivo `LICENSE`: até a decisão, nenhuma
licença de uso é concedida a terceiros.
