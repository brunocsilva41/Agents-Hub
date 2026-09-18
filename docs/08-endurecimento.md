# 08 — Endurecimento: o portão que faltava e o que ele deixou passar

> Vistoria de **processo e operação**, não de funcionalidade. O doc 07 conferiu
> se o que o plano promete existe. Este pergunta outra coisa: *o que impede o
> repositório de quebrar sem ninguém perceber, e o que acontece quando o daemon
> roda por dias em vez de por trinta segundos.*
>
> Data: 2026-09-18 · commit base `1c6d6c7` · `npx tsc -b` **vermelho** ·
> `npm test` **6 arquivos falhando** — e nenhuma das duas coisas era sabida.

---

## 1. O achado que organiza todos os outros

**O commit de topo de `main` não compilava.**

Treze erros de TypeScript num worktree limpo, com `npm ci` do zero — não era
artefato de cache local. Seis arquivos de teste do daemon falhavam na carga,
consequência direta. E a causa estava no próprio commit de topo, que tornou
`gateToolCall` assíncrona (o gate passou a bloquear esperando decisão humana)
mas deixou para trás:

| O que faltava | Efeito |
|---|---|
| `await` em `server.ts` na chamada de `gateToolCall` | o handler respondia ao hook com uma **Promise serializada como `{}`** |
| `#latestTaskOrNull` | referenciado, nunca escrito |
| `resumoDaChamada` | referenciado, nunca escrito |
| `gateWaitMs` | referenciado, nunca escrito |

O primeiro é o grave. Sem o `await`, o hook do agente receberia um corpo sem
`permission`, sem `decision` e sem `reason`. O gate pré-execução — o único
nível de controle que o projeto chama de prevenção real — **falharia aberto,
exatamente no caso que ele existe para pegar.**

Nada disso era sutil. Bastava rodar `tsc -b` num checkout limpo.

## 2. Por que passou: o portão media 10% do que dizia medir

`npm test` era:

```
node --test --experimental-sqlite packages/*/dist/**/*.test.js
```

O resultado **depende de quem expande o glob**:

| Shell | Quem expande | Arquivos coletados |
|---|---|---|
| PowerShell / cmd | o próprio Node, que entende `**` | **30 de 30** |
| bash / sh | o shell; sem `globstar`, `**` vale por um `*` | **3 de 30** |

No bash, `packages/*/dist/**/*.test.js` casa apenas o que está a exatamente dois
níveis abaixo de `dist/` — os três arquivos em `adapters/dist/mappers/` e
`adapters/dist/opencode/`. Todo o domínio (política, orçamento, grafo,
resiliência) e **todo o daemon** ficavam de fora. A saída era verde.

Um CI em `ubuntu-latest` teria rodado essa versão cega, e o veredito verde seria
pior que nenhum veredito: compra confiança sem lastro.

Também explica a discrepância entre documentos: o doc 07 reportou "196/196
verdes (21 arquivos)" e o README dizia "28 testes". O número real, hoje, é **273
testes em 30 arquivos**.

### Correções

- `scripts/run-tests.mjs` — descoberta em JavaScript, onde nenhum shell opina.
  Suíte vazia **falha**, porque quase sempre significa "esqueci de compilar", e
  sair 0 ali devolveria verde a um portão que não testou nada.
- `.github/workflows/ci.yml` — `npm ci` + build limpo + suíte, em Windows com
  Node 22.5 (o piso de `engines`, onde `node:sqlite` ainda exige flag) e 24.
  Linux entra como job **informativo**: o Hub nunca rodou nessa plataforma, e
  marcar suporte sem prova seria repetir o problema que este documento trata.
- `npm run verify` — o mesmo que o CI roda, em um comando local.
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — o **critério de pronto** em cinco
  linhas, e o vocabulário `[x] / [~] / 🕳️ / [ ]` que o doc 07 inaugurou.

---

## 3. Prontidão operacional: 20 achados

O daemon foi projetado para viver por dias, guardando N sessões com processos
filhos e orçamento em consumo. A varredura procurou o que quebra nesse regime —
não o que quebra num teste de trinta segundos.

Legenda: 🔴 perda de dado ou de sessão · 🟡 degradação acumulada · 🟢 menor.

### 3.1 🔴 Um segundo daemon destruía as sessões do primeiro — **corrigido**

`createHub()` chamava `reconcileOnStartup()`, que marca como `killed` toda
sessão que o banco diz `running`, partindo da premissa de que "quem as rodava
morreu". Isso acontecia **antes** do `listen()`.

Com um daemon vivo rodando cinco sessões, bastava um `hub daemon` a mais — ou
uma corrida do autostart — para o segundo processo abrir o mesmo banco, declarar
mortas as cinco, e só então descobrir que a porta estava ocupada. Ele morria; o
estrago ficava. O painel mostrava sessões mortas, o reaper passava a considerar
os worktrees delas recolhíveis, e os processos continuavam gastando token sem
dono. Não existia lock de arquivo, PID ou porta em lugar nenhum.

**Correção:** `hub.start()` liga a porta primeiro. **A porta é o lock** — o
sistema operacional já garante que só um processo segura `127.0.0.1:4747`. Quem
perde a disputa falha em `listen` sem ter tocado no banco. O reaper só começa
depois da reconciliação, porque recolher worktree de sessão ainda não
classificada seria apagar trabalho vivo.

### 3.2 🔴 Zero handler de exceção global — **corrigido**

`#pump` é disparado com `void`, sem ninguém para receber a rejeição. O `for
await` dentro dele tem try/catch, mas **o `catch` emite um evento**, e emitir
escreve no SQLite. Um `catch` não pega o que ele mesmo lança: chave única
violada, `SQLITE_BUSY` além do `busy_timeout`, disco cheio — qualquer um escapa,
vira `unhandledRejection` e, sem handler, mata o processo. Todas as outras
sessões vão junto, e os filhos ficam órfãos.

**Correção:** `packages/daemon/src/safety-net.ts`, com a divisão que importa —
`unhandledRejection` registra e **não derruba** (a origem é quase sempre uma
sessão só; matar tudo é justamente o dano a evitar); `uncaughtException`
**derruba de forma ordenada**, com teto de 10s, porque ali o estado do processo
é suspeito de verdade e seguir servindo é pior que reiniciar.

### 3.3 🔴 Filhos órfãos no desligamento — **corrigido**

No Windows, `killTree` fazia `spawn('taskkill', ...)` e **retornava sem
esperar**; `process.exit(0)` vinha logo atrás. O `taskkill` podia nem ter sido
agendado. A árvore do agente sobrevivia ao daemon, continuava consumindo token e
escrevendo no worktree — e nada no sistema era capaz de pará-la, porque o Hub
não guarda PID.

Somava-se a isso o `Promise.all` em `SessionManager.shutdown()`: **um** `cancel`
que rejeitasse abortava o desligamento inteiro, e o que vem depois dele é
`store.close()`. Uma sessão problemática deixava o banco sem fechar e todos os
outros filhos órfãos.

**Correção:** `killTree` devolve promessa e é esperado, com fallback para
`SIGKILL` se `taskkill` não estiver no PATH (antes, o `'error'` num ChildProcess
sem listener era exceção não tratada) e teto de 5s. `shutdown()` usa
`allSettled` e registra cada falha.

### 3.4 🔴 O `shutdown` fechava o banco com os pumps ainda drenando — **corrigido**

Achado que **só apareceu porque os handlers do 3.2 passaram a existir**. Cancelar
a run não encerra o pump: ele ainda drena o resto do stream e escreve o desfecho.
`store.close()` acontecia no meio disso, e a escrita seguinte falhava com
`database is not open` — perdendo justamente o registro de como a sessão
terminou, em silêncio.

**Correção:** as promessas dos pumps são guardadas e esperadas no desligamento,
com teto de 5s. Perder o último evento é ruim; não desligar é pior.

### 3.5 🔴 O daemon autostartado era completamente cego — **corrigido**

Três fatos que se somavam: não existe logger em lugar nenhum do projeto; o
`logDir` que a config declara e **cria** (`~/.agents-hub/logs`) não era lido por
ninguém, ficando vazio para sempre; e o autostart subia o daemon com
`stdio: 'ignore'`. Como o autostart É o caminho normal de uso, na prática *todo*
`console.error` do daemon ia para o vazio. Quando algo dava errado, a única
evidência era `"o daemon não respondeu a tempo"`.

**Correção:** o autostart escreve em `~/.agents-hub/logs/daemon-AAAA-MM-DD.log`,
em append (o daemon é ressuscitado com frequência; truncar apagaria o registro
da queda anterior, que é o que se quer ler), e a mensagem de timeout aponta para
o arquivo. Um logger estruturado de verdade continua em aberto — ver §4.

### 3.6 🟡 Vazamento de memória em três caches — **corrigido**

`#ledgers`, `#seeded` e `#models` eram preenchidos por sessão e **nunca**
limpos. `#finish` limpava `bus.forgetSession` e `#runs`, e não tocava nesses
três. Num daemon de dias com dezenas de sessões, crescimento monotônico.

**Correção:** os três são descartados em `#finish` — com uma ressalva que quase
virou bug: `#ledgers` é chaveado pela **raiz**, não pela sessão, porque o
orçamento é do fluxo inteiro (ADR 03). Só pode ser esquecido quando nenhum irmão
continua vivo; soltar antes faria os irmãos remontarem o ledger do banco no meio
do consumo, perdendo a reserva ainda não liquidada.

### 3.7 🟡 Achados operacionais ainda em aberto

Verificados, não corrigidos. Entram como Fase 5 no roadmap.

| # | Achado | Evidência |
|---|---|---|
| 1 | `opencode serve` sobe com `stdio: [_, _, 'pipe']` e **ninguém lê o stderr**. Quando o buffer de pipe do SO encher (~64 KB), o servidor bloqueia na escrita e congela — com ele, todas as sessões OpenCode. Falha clássica de "roda 30s, quebra no terceiro dia" | `adapters/src/opencode/adapter.ts:447` |
| 2 | A tabela `events` cresce para sempre, guardando `payload_json` **e** `raw_json` (duas cópias do conteúdo). Zero `DELETE`, zero `VACUUM`. Enquanto isso o reaper faz `sessions.list()` sem WHERE nem LIMIT a cada hora, e a reconciliação faz o mesmo no boot | grep sem resultado; `reaper.ts:55` |
| 3 | Portão de validação spawna com `shell: true` e no timeout chama `child.kill()` — SIGTERM no `cmd.exe` apenas, **sem `/T`**. O `npm`/`node` filho sobrevive a cada validação que estoura | `daemon/src/validation.ts:47,67` |
| 4 | `AGENTS_HUB_PORT` sem validação: `Number('abc')` = `NaN` → o Node escuta numa porta aleatória e a CLI procura na 4747. Pior, **só funciona por um dos dois entrypoints** — o da CLI, que é o do autostart, a ignora | `daemon/main.ts:5` vs `cli/main.ts:344` |
| 5 | SSE com `?since=abc` → `Number` vira `NaN` → `seq > NaN` no SQL → **zero linhas, HTTP 200**. A rota REST irmã valida com `inteiroOpcional`; a SSE não | `server.ts:601` vs `:441` |
| 6 | Replay SSE trunca em 500 eventos sem nenhuma indicação de truncamento | `repositories.ts:379` |
| 7 | `spawn` sem `.on('error')` em quatro pontos, e `child.stdin.write` sem callback (EPIPE quando o CLI sai antes de consumir) → exceção não tratada | `process-adapter.ts:331`; `opencode/adapter.ts:207,444` |
| 8 | SSE do A2A sem keep-alive nem `id:`, divergindo do `/events` que tem ping de 20s. Conexão ociosa cai em proxy sem aviso. E o keep-alive do `/events` faz `res.write` num `setInterval` **sem try/catch** | `server.ts:242-265`, `:614` |
| 9 | Sem limite de conexões SSE nem backpressure: `writeSse` ignora o retorno de `res.write`. Cliente lento + agente verborrágico = buffer crescendo na heap | `server.ts:637` |
| 10 | `config.json` lido com `JSON.parse` + `as Partial<HubConfig>`, **sem schema Zod** — que o projeto usa em todo o resto. E o merge de `policy` é **raso**: escrever `policy.validation` no arquivo global apaga `command` e `commandTimeoutSeconds` do default | `config.ts:102`, `:92` |
| 11 | Autostart spawna sem `--experimental-sqlite`. Com `engines: ">=22.5.0"`, em Node 22.5–22.12 o `import` de `node:sqlite` falha e o daemon morre no boot | `daemon-control.ts` vs `package.json:8` |
| 12 | `AsyncQueue` sem teto: o produtor (readline sobre o stdout do agente) empurra sem parar; o consumidor faz uma escrita SQLite **síncrona** por evento. Existe um `get pending` que ninguém lê | `adapters/src/async-queue.ts:10` |
| 13 | Race no handoff: `#runs.delete` acontece antes do novo `#launch` repovoar, e a guarda `live.handle !== handle` do pump antigo não protege nessa janela | `session-manager.ts` |
| 14 | Arquivos de prompt em `os.tmpdir()/agents-hub/prompts/` — um por spawn, **nunca apagados** | `process-adapter.ts:362` |
| 15 | `execFileAsync` sem `maxBuffer` em `worktree.ts` (default 1 MB). `git worktree list --porcelain` num repo com muitas sessões estoura e cai num `catch` que devolve lista vazia. `diff-capture.ts` faz certo — a inconsistência é local | `worktree.ts:155` vs `diff-capture.ts:64` |
| 16 | Cinco variáveis de ambiente (`AGENTS_HUB_HOME`, `_PORT`, `_NO_AUTOSTART`, `_URL`, `_MCP_*`) **não documentadas em lugar nenhum**. Só `AGENTS_HUB_SESSION_ID` aparece nos docs | grep em `*.md` |
| 17 | Sessões órfãs de um crash: a reconciliação corrige o **registro** no próximo boot, mas **não mata os processos sobreviventes**, porque não há PID no schema | `migrations.ts:24-41` |
| 18 | `catch` que engolem de forma indistinguível de sucesso: assinante de bus quebrado, `git worktree remove` falho (vira "kept" implícito e o disco cresce), junction de `node_modules` que não foi criado, JSON corrompido virando `{}` | `bus.ts:35`, `worktree.ts:147`, `:123`, `store/db.ts:78` |
| 19 | YAML de projeto quebrado cai na política global **em silêncio** — quem editou não recebe sinal de que sua política não está valendo | `project-config.ts:72` |
| 20 | `budget.warning` é o único tipo do vocabulário de eventos **sem emissor**, e a projeção de custo usa `consumed.seconds`, liquidado só no fim da run: durante a execução `elapsedSeconds === 0` e o chip de burn rate **nunca aparece com a sessão viva** | `core/events.ts:28`; `session-manager.ts` |

**O que está genuinamente bom**, e vale registrar para não ser mexido sem
motivo: os PRAGMAs do SQLite (WAL, `foreign_keys`, `busy_timeout`,
`synchronous = NORMAL`), as migrações transacionais com tabela versionada, os
índices — `idx_events_session (session_id, seq)` cobre exatamente a consulta de
replay — a limpeza de listener e timer do SSE principal, e sobretudo a
`reconcileOnStartup`, que é o mecanismo certo com a exceção certa (aprovação
pendente é preservada, porque depende de humano e não de processo).

---

## 4. O diagnóstico em uma frase

O Hub **sabe se recuperar de uma queda** — a reconciliação na subida é boa e bem
pensada. O que ele não sabia era **evitar a queda** (zero handler global, vários
`void promise` expostos), **contar o que aconteceu** (nenhum log persistido) e
**proteger-se de si mesmo** (nenhum lock de instância — cujo efeito colateral era
apagar do banco sessões vivas). Os quatro estão corrigidos. O que resta na §3.7
é, em boa parte, acúmulo silencioso: memória, processos, arquivos temporários e
linhas de evento crescendo até algo estourar.

E a conclusão de processo, que vale mais que qualquer item: **nada disso exigia
ferramenta sofisticada.** Um `tsc -b` num checkout limpo pegava o achado §1. Um
`npm test` que coletasse os arquivos certos pegava os seis testes quebrados. O
que faltava era alguém — uma máquina — rodando isso antes de aceitar a mudança.
