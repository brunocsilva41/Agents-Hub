# Instalação e primeiros 10 minutos

Guia do usuário, passo a passo, do zero até a primeira sessão aprovada. Cada
comando daqui foi rodado numa instalação limpa (tarball num prefixo temporário,
`AGENTS_HUB_HOME` e `USERPROFILE` temporários) antes de entrar no guia; a
distribuição por trás dele está em [13-instalacao.md](13-instalacao.md).

> Os exemplos usam PowerShell. Em PowerShell, **ponha entre aspas** as listas
> com vírgula (`--kinds "instructions,env"`): sem aspas, `a,b` vira um array.
> (A CLI aceita as duas formas desde esta versão, mas as aspas funcionam em
> qualquer shell.)

## 1. Requisitos

| O quê | Versão | Por quê |
|---|---|---|
| Windows | 10 ou 11 | plataforma validada (CI bloqueante). Linux roda, com CI informativo; autostart no login é só Windows |
| Node.js | **≥ 22.5** | `node:sqlite`. Entre 22.5 e 22.12 (e 23.0–23.3) ele exige `--experimental-sqlite`: a CLI se reexecuta com a flag sozinha, você não faz nada. A partir de 22.13 / 23.4 não há flag |
| git | qualquer recente, no PATH | cada sessão roda num git worktree próprio; o projeto precisa ser um repositório git |
| npm | o que vem com o Node | instalar o pacote; o diretório global do npm precisa estar no PATH (o instalador do Node já faz isso) |
| Pelo menos um CLI de agente **logado** | Claude Code, Codex, OpenCode, Copilot, Kimi, MiMo, OpenClaude, Cursor, Antigravity | o Hub não guarda credencial: usa o login que o próprio CLI já tem |

```powershell
node --version   # v22.5.0 ou maior
git --version
```

## 2. Instalar

Não há pacote publicado no registry: você gera o pacote a partir do clone e o
instala. Depois de instalado, o Hub **não depende do clone**.

### Pelo pacote (recomendado)

```powershell
git clone https://github.com/brunocsilva41/Agents-Hub.git
cd Agents-Hub
npm ci
npm run build          # pacotes + painel
npm run pack:dist      # -> dist-pack\agents-hub-0.1.0.tgz
npm i -g .\dist-pack\agents-hub-0.1.0.tgz
hub --version          # 0.1.0
```

O `npm i -g` leva perto de um minuto (o pacote traz tudo junto, sem baixar do
registry). Ele cria `hub` e `agents-hub-mcp` no diretório global do npm.

### Pelo clone (para desenvolver o Hub)

```powershell
npm ci
npm run build
npm link --workspace @agents-hub/cli
```

Aí `hub` aponta para o clone: hooks e MCP gravados nos agentes apontam para
`<clone>\packages\...`, e um `npm run build` já vale (depois de `hub restart`).

## 3. `hub init` — o diagnóstico de largada

Rode dentro do repositório onde os agentes vão trabalhar:

```powershell
cd C:\caminho\do\seu\projeto
hub init
```

Ele confere node e git, **sobe o daemon** (não existe passo "suba o daemon": ele
nasce sozinho quando um comando precisa e sobrevive ao terminal), lista os
agentes que achou (instalado, versão, auth, modelo, MCP, instruções — nunca
mostra segredo) e termina com as próximas linhas em **prévia**:

```
✓ node 24.14.0 (mínimo 22.5.0)
✓ git version 2.53.0.windows.1
● daemon iniciado v0.1.0 · http://127.0.0.1:4747
...
⚠ claude: credencial não encontrada — faça login pelo próprio CLI antes da primeira sessão
4. projeto
C:\...\projeto não está registrado. rode hub project add ou `hub init --yes`
5. gate pré-execução e MCP (prévia — nada é gravado aqui)
  hub hooks install claude
  hub mcp install codex
  ...
```

`hub init --yes` também registra o diretório atual como projeto (o mesmo que
`hub project add`). Nada fora do Hub é gravado pelo `init`.

## 4. `hub doctor` — quem está pronto

```powershell
hub doctor
```

Uma linha por agente: `✓` utilizável, `✗` quebrado (com o motivo e o comando de
login do próprio CLI), `○` não instalado. "auth presente" quer dizer credencial
**encontrada**, não validada; só `hub doctor --smoke` prova com uma chamada real
(e **gasta** tokens — pede confirmação). `hub status` resume o mesmo, mais as
sessões vivas e o que espera sua decisão.

Se um agente aparece `✗ sem auth`, faça login nele (ex.: rode `claude` uma vez,
`codex login`) e rode `hub doctor` de novo.

## 5. Aproveitar o que você já configurou: `hub discover` e `hub import`

```powershell
hub discover                    # todos os agentes
hub discover --agent claude     # um só, em detalhe
```

`hub import` traz a configuração de um agente para o projeto no Hub — instruções
globais (ex.: `~/.claude/CLAUDE.md`), modelo/URL padrão e, com `--to`, os
servidores MCP para outros agentes. **Sem `--write` é só a prévia**:

```powershell
hub import claude --to codex
```
```
plano de importação de claude (dry-run)
  ○ instructions 1 arquivo(s) de instrução global, 56 caracteres, como instrução de "claude"
  ○ mcp          adicionar 1 servidor(es) MCP: docs
      → C:\Users\voce\.codex\config.toml
nada foi gravado. para aplicar: hub import claude --kinds instructions,env,mcp --to codex --write
```

Concordou com o plano? Acrescente `--write`:

```powershell
hub import claude --kinds "instructions,env,mcp" --to codex --write
```

Instruções e env vão para o banco do Hub (não para o repositório). O MCP é
escrito na config do agente de destino com **merge** (nada do que já existe é
perdido) e **backup versionado** — `config.toml.bak-AAAAMMDD-HHMMSS`, um novo a
cada gravação, nunca sobrescrito. Segredo não é copiado: do env dos servidores
MCP vão só os nomes, a menos que você peça `--include-env`. Mais em
[11-descoberta-e-absorcao.md](11-descoberta-e-absorcao.md).

## 6. Ligar o gate e o MCP: prévia, depois `--write`

Os dois comandos seguem a mesma regra: **sem `--write` mostram exatamente o que
gravariam**; com `--write`, fazem merge na config do agente, guardam backup
versionado `.bak-AAAAMMDD-HHMMSS` do arquivo anterior (nunca sobrescrito) e
escrevem de forma atômica. Rodar de novo não duplica nada ("já estava instalado").

**Gate pré-execução** — o agente pergunta ao Hub *antes* de rodar shell, escrita
ou rede, e obedece:

```powershell
hub hooks install claude           # prévia do trecho de ~/.claude/settings.json
hub hooks install claude --write   # grava
hub hooks install codex --write    # Codex: liga o bypass de confiança que o hook dele exige
hub hooks                          # onde o gate está instalado
```

O hook gravado aponta para a CLI instalada (`...\agents-hub\node_modules\@agents-hub\cli\dist\bin.js hook`),
caminho que não muda entre atualizações. Hoje só Claude Code e Codex têm gate
pré-execução; nos outros agentes o Hub vigia depois do fato — ver
[SECURITY.md](../SECURITY.md).

**MCP** — dá ao agente as ferramentas `hub_agent_call` & cia., para ele delegar
a outros agentes:

```powershell
hub mcp                            # o que está registrado onde
hub mcp install codex              # prévia
hub mcp install codex --write      # grava (+ backup)
hub mcp install claude --write     # Claude: grava .mcp.json NO PROJETO (fica versionado)
```

Reinicie o agente para ele carregar o MCP server.

## 7. Abrir o painel

```powershell
hub open            # abre no navegador padrão
hub open --print    # só imprime a URL: http://127.0.0.1:4747
```

O painel tem a mesma capacidade da CLI (sessões ao vivo, grafo, aprovações,
custo, política). Ele recebe o token de operador por cookie quando você o abre;
se uma ação do painel responder "exige o token de operador", recarregue a página.

## 8. A primeira sessão

O `--agent` é obrigatório (você escolhe o principal a cada vez). Ponha um teto
baixo de custo na primeira:

```powershell
hub start --agent claude "liste os arquivos da pasta src e resuma cada um" --budget-usd 0.10
```

A CLI acompanha ao vivo e sai com `0` (concluída), `1` (falhou/cancelada) ou
`2` (parada esperando aprovação). `--detach` só abre a sessão e devolve o id;
`hub watch <id>` acompanha depois. Com um agente falso no lugar do `claude`
(para o teste deste guia), a saída de uma sessão que tentou `git push` foi:

```
sessão iniciada ses_eb556b30... (falso)
worktree: C:\Users\voce\.agents-hub\worktrees\projeto\ses_eb556b30...
23:48:13 falso        vou publicar o branch
23:48:13 falso        $ git push origin main
23:48:13 falso        ⏸ aguardando aprovação executou: git push origin main

⏸ bloqueado, esperando você
   executou: git push origin main [irreversible]
   hub approve apv_9c9ace40...   ou   hub deny apv_9c9ace40...
```

O trabalho do agente fica no branch `hub/<sessionId>` do worktree; traga para o
seu branch com `hub apply <sessionId>` (prévia) e `--write`.

## 9. Aprovar ou negar

```powershell
hub approvals          # o que espera você
hub approve <apv_id>   # libera; a sessão retoma de onde parou
hub deny <apv_id>      # nega
```

Ou pelo painel, na fila de aprovações. Duas situações diferentes:

- **Com gate** (Claude/Codex com hook): a ferramenta ainda **não rodou**; o
  agente fica esperando até 55 s. Negar (ou não responder a tempo) nega só
  aquela chamada, e a sessão segue.
- **Sem gate** (vigilância): a ação **já aconteceu** — a fila diz
  "já executada — sessão parada". Aprovar retoma a sessão; negar a encerra.

Aprovar exige o token de operador; a CLI lê sozinha de
`<AGENTS_HUB_HOME>\operator-token`.

## 10. Acompanhar o custo

```powershell
hub budget <sessionId>    # consumo do fluxo contra o teto
hub cost                  # últimos 7 dias, por agente, projeto, dia e fluxo
hub cost --all
```

```
US$ 0.0123 · 1.2k tokens · 1 fluxo(s), 1 sessão(ões)
por agente
  falso                  US$     0.0123     1.2k tok  1 sessão(ões)
```

O custo é o que o próprio agente informa (o Copilot fatura em créditos, não em
dólares).

## 11. Encerrar

```powershell
hub stop      # encerra o daemon e as sessões vivas
```

Sessão sozinha: `hub cancel <id>`. O daemon volta sozinho no próximo comando
que precisar dele.

## Depois dos 10 minutos

### Subir no login do Windows

```powershell
hub autostart enable    # grava agents-hub-daemon.vbs na pasta Inicializar
hub autostart status
hub autostart disable
```

Desligado por padrão. `AGENTS_HUB_HOME`/`AGENTS_HUB_PORT` definidas no momento
do `enable` vão gravadas no script. Log do daemon: `hub logs` (ou `--follow`).

### Daemon "não está rodando"

Se você definiu `AGENTS_HUB_NO_AUTOSTART=1`, a CLI não sobe o daemon sozinha e
avisa. Três saídas: `hub daemon` **num terminal à parte** (fica em primeiro
plano, mostrando o log), tirar a variável (o daemon volta a subir sozinho em
segundo plano) ou `hub autostart enable`.

### Atualizar

`hub update` diz de onde você está rodando e o que fazer. Instalado pelo pacote:

```powershell
cd <seu clone do Agents-Hub>
git pull --ff-only
npm ci; npm run build; npm run pack:dist
npm i -g .\dist-pack\agents-hub-<versão>.tgz
hub restart     # o daemon sobrevive ao terminal e seguiria no código antigo
```

O `npm i -g` da versão nova substitui no mesmo lugar: hooks e MCP já gravados
nos agentes continuam apontando para o caminho certo. Instalado com `npm link`,
é só `git pull`, `npm ci`, `npm run build` e `hub restart`. `hub restart` recusa
se houver sessão viva (use `--force` para encerrá-las).

### Desinstalar

```powershell
hub autostart disable
hub stop
npm uninstall -g agents-hub        # (instalado com npm link: npm unlink -g @agents-hub/cli)
```

O que fica para trás, de propósito (apague à mão se quiser):

- `%USERPROFILE%\.agents-hub` — banco, worktrees, logs, token de operador
  (faça `hub backup` antes, se quiser guardar o histórico);
- o hook em `~/.claude/settings.json` (entrada `PreToolUse` com `... hook`) e as
  entradas `agents-hub` que `hub mcp install` gravou (`~/.codex/config.toml`,
  `.mcp.json` do projeto...). Os `.bak-*` ao lado de cada arquivo guardam as
  versões anteriores. Sem o Hub instalado, o hook falha e o agente segue
  (fora de sessão do Hub, o gate é aberto) — mas remova-o para não pagar o
  custo de uma chamada inútil a cada ferramenta.
