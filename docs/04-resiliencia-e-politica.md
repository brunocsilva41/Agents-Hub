# 04 — Resiliência, Política e Configuração por Projeto

Cobre o que acontece **depois** que um agente é acionado: o que o Hub tolera, o que ele barra e o que ele faz quando dá errado.

## 1. O que o Hub pode e não pode barrar

Esta é a distinção mais importante do documento, porque é onde é fácil se enganar.

O Hub roda os agentes como **processos opacos**. Ele não intercepta syscall: vê o evento *depois* que o comando executou. Então existem dois níveis de controle, com garantias muito diferentes:

| Nível | O que é | Garantia |
|---|---|---|
| **Portão** (preventivo) | Ações que passam por dentro do Hub: delegação agente→agente, reserva de orçamento | Real. A ação **não acontece** sem liberação |
| **Vigilância** (reativa) | Comando executado, arquivo alterado | O comando **já rodou**. O que o Hub impede é o *próximo*, parando a sessão |

Chamar a vigilância de "aprovação prévia" seria mentira, e mentira em recurso de segurança é pior que ausência dele.

**Existe um terceiro nível, e ele é o mais forte:** o *gate pré-execução* por hook do agente. Aí a resposta do Hub decide se a ferramenta roda — o agente pergunta antes, não depois.

| Nível | Como funciona | Cobertura hoje |
|---|---|---|
| **Gate pré-execução** | O agente consulta o Hub antes de executar a ferramenta e obedece à resposta | Claude Code (`PreToolUse`) e Codex (hook compatível, dialeto próprio). OpenClaude: `hub hooks install openclaude` grava o hook, mas o comportamento em runtime nunca foi exercido |
| **Portão** | Ação que passa por dentro do Hub: delegação, reserva de orçamento | Todos |
| **Vigilância** | Evento do que já aconteceu; para a próxima ação | Todos cujo mapper emite `command.executed`/`file.changed` |

O gate só age em sessões criadas pelo Hub (o processo do hook recebe `AGENTS_HUB_SESSION_ID`). Chamada de fora de uma sessão do Hub recebe `allow` — não há política de quem aplicar.

### O gate pré-execução

Contrato confirmado contra o binário, não deduzido da documentação:

- o hook recebe `{ session_id, cwd, tool_name, tool_input, tool_use_id, permission_mode }`;
- no **Claude Code** a resposta é `hookSpecificOutput.permissionDecision` com `allow | deny | ask` (medido no schema embutido no binário 2.1.283; versões anteriores deste documento diziam `escalate`, que não existe nesse vocabulário);
- no **Codex** o dialeto é outro (`toCodexHookOutput`, `packages/daemon/src/pretool-gate.ts`): permitir é **não escrever nada**, e não existe `ask` — o que não é `allow` sai como `deny` com motivo obrigatório. O Codex ignora hook não confiável em silêncio: sem `codexGate.bypassHookTrust` (ligado por `hub hooks install codex --write`), sessão `supervised` do Codex é recusada ao iniciar (`CODEX_GATE_NOT_GUARANTEED`) e `semi`/`autonomous` rodam com aviso na timeline;
- `AGENTS_HUB_SESSION_ID`, injetada pelo Hub ao spawnar o agente, **chega no processo do hook**. É ela que correlaciona a chamada com a sessão.

**O gate é bloqueante.** Quando a política decide `approve`, o daemon abre uma `Approval` (visível em `hub approvals` e no painel), põe a sessão em `waiting_approval` e **segura a resposta do hook** até alguém decidir. O agente recebe `allow` (liberado por humano) ou `deny` (negado por humano, ou ninguém respondeu a tempo) — nunca um "pergunte você". Negar nega **só aquela chamada**: a sessão segue, e a mensagem devolvida ao agente diz o motivo real (negado por humano × tempo esgotado × sessão já encerrada) e que não deve contornar.

**Três relógios, nesta ordem** (constantes em `pretool-gate.ts`):

| Relógio | Valor | O que acontece ao estourar |
|---|---|---|
| espera do daemon por decisão humana | 55 s (`ESPERA_DO_GATE_MS`) | a aprovação fecha como `denied` por "tempo esgotado" e o hook recebe `deny` |
| teto HTTP do processo do hook | 100 s (`TETO_HTTP_DO_HOOK_MS`) | o hook aplica o modo de falha (abaixo) |
| `timeout` gravado na config do agente | 120 s (`TIMEOUT_DO_HOOK_SEC`) | o agente desiste do hook — e, medido com o `claude` real, a ferramenta **roda** |

Quem desiste primeiro é sempre o daemon, e a desistência dele é `deny`. Instalações antigas gravaram `timeout: 10`, o que fazia a ação pendente rodar sem aprovação depois de 10 s; `hub doctor`/`hub hooks` acusam o timeout antigo, e reinstalar corrige.

**Modo de falha (`gate.failMode` no `config.json` global).** Se o daemon não responder (fora do ar, erro, teto HTTP): padrão **fechado** em sessão do Hub (shell, escrita, rede e leitura de segredo negadas; leitura comum passa) e **aberto** fora dela, onde o Hub não está envolvido e bloquear transformaria o daemon numa dependência do editor. `gate.failMode: "open" | "closed"` força um dos dois. Detalhes e modelo de ameaça em [SECURITY.md](../SECURITY.md).

O matcher cobre `Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|WebFetch|Read|Grep` (`MATCHER_DE_RISCO`). `Read`/`Grep` entraram em 2026-09-28 para que ler segredo pela ferramenta de leitura pare no gate como para `cat` pelo shell; a leitura comum é liberada no próprio hook, sem ida ao daemon (~125 ms por chamada, medido — ver [SECURITY.md](../SECURITY.md)). `Glob` fica de fora: só devolve nomes.

```bash
hub hooks install claude --write
hub hooks install codex --write
```

Validado com o Claude Code e com o Codex de verdade (2026-09, versão anterior do gate): mandados a rodar `git push origin main`, o comando foi barrado antes de executar. **O caminho bloqueante atual** (espera de 55 s, deny por tempo, deny que não mata a sessão) é coberto por teste de integração HTTP (`gate-bloqueante.test.ts`) e ainda **não foi exercido contra o binário real** — está na rodada real da Fase 9 do GOAL.

### Níveis de risco

| Nível | Exemplos | Decisão da política padrão (`risk.*`) |
|---|---|---|
| `read` | ler arquivo comum, listar dir, `git status`/`log`/`diff` | permitir |
| `write` | escrever dentro do worktree da sessão | permitir |
| `exec` | comando na allow list (build, testes, lint), delegação | permitir |
| `escalate` | escrever fora do worktree, comando fora da allow list, rede não liberada | aprovação |
| `budget` | estourar o orçamento do fluxo | aprovação |
| `irreversible` | `git push`, `rm -rf`, publish, ler/escrever segredo ou caminho sensível (`.ssh`, `.env`, `.git/hooks`) | aprovação |
| deny list | `sudo`, `shutdown`, `mkfs`, `reg delete`... | negado em todo modo |

Sobre isso vem o modo da sessão, que só endurece (`decisionForMode`): `supervised` pede aprovação para tudo acima de `read`; `semi` para tudo acima de `exec`; `autonomous` só para `irreversible`/`budget`. A tabela completa risco × modo está no [README](../README.md#segurança).

**O que "aprovação" significa depende do nível de controle.** No gate (Claude, Codex) é prévia e bloqueante, como descrito acima. Na vigilância, a decisão vem de `watch.pauseOn` (padrão `irreversible`; em `supervised` também `escalate`) e `watch.flagOn` (padrão `escalate`): o evento já aconteceu, e o Hub para a sessão ou só marca um alerta na timeline.

### Escrita fora do worktree: o que é detectado de verdade

`escalate` para escrita fora do worktree só vale quando o Hub **vê** a escrita:

- no gate, pela ferramenta `Write`/`Edit`/`MultiEdit`/`NotebookEdit` ou pelo alvo de um comando de shell que o classificador entende (`mkdir`, `cp`, `mv`, `touch`, `rm`, redirecionamento `>`);
- na vigilância, pelo `file.changed` com caminho ou pelo `command.executed` que o mapper do agente emite.

Não é detectada a escrita feita por dentro de um programa (`node script.js`, `python x.py` gravando onde quiser) nem a de agente cujo mapper não emite esses eventos. Reproduzido na vistoria de 2026-09-25 (relatório 06): um agente de teste gravou fora do worktree, a sessão terminou `completed` e nenhum alerta saiu. O worktree isola o checkout, **não é sandbox** ([SECURITY.md](../SECURITY.md)).

### Por que a vigilância não para em `escalate` em `semi`

Um agente executa dezenas de comandos legítimos que nenhuma allow list razoável prevê. Parar a sessão *depois do fato* a cada um deles não desfaz nada e faria o recurso ser desligado na primeira hora. Por isso, sem gate, `escalate` em `semi` vira alerta na timeline. **Com gate é diferente:** lá `escalate` pede aprovação em `semi`, porque o gate previne — e por isso a allow list padrão foi ampliada e o classificador passou a separar o que só lê (`read`) do que executa (`exec`), para que `escalate` signifique só o que sai do combinado.

## 2. Fila de aprovações

Quando o gate, um portão ou a vigilância pede decisão, nasce uma `Approval`:

- a sessão vai para `waiting_approval`, a task para `input_required`;
- a fila aparece **no topo do painel** e em `hub approvals`; `hub approve <id>` / `hub deny <id>` decidem pela CLI (exigem o token de operador, ver §6);
- **aprovação do gate** (`detail.kind: tool-call`): liberar devolve `allow` ao hook que está esperando; negar devolve `deny` só para aquela chamada — a sessão volta a `running` e segue;
- **delegação retida**: liberar sobe a sessão filha; negar rejeita a task e encerra a sessão;
- **orçamento**: liberar amplia o teto pelo incremento pedido e retoma;
- **vigilância**: liberar manda à sessão uma mensagem dizendo o que exatamente foi liberado — o agente precisa saber que houve decisão humana, senão repete a ação achando que falhou; negar encerra a sessão e tudo que ela havia delegado.

O `hub_agent_call` do MCP devolve `DELEGAÇÃO RETIDA` em vez de `delegado`, com instrução explícita para o agente não ficar em polling. Sem isso ele consultaria para sempre uma tarefa que nunca começou.

## 3. Pipeline de resiliência

```
executa
  ├─ sucesso → PORTÃO DE VALIDAÇÃO
  │              ├─ passou  → task completed
  │              └─ reprovou → volta ao retry, agora com o erro em mãos
  ├─ falha transitória (rate limit, 5xx, run travada) → retry, backoff exponencial
  ├─ falha permanente ou retries esgotados → FALLBACK para o próximo da cadeia
  └─ cadeia esgotada → failed + evento de prioridade alta
```

### Decisões que valem explicar

**A lista de erros transitórios é curta de propósito.** Repetir um erro determinístico — modelo inválido, binário sem auth, comando inexistente — só queima orçamento. Na dúvida, o Hub trata como permanente e vai para o fallback, que ao menos muda alguma variável.

**O retry retoma a sessão nativa** quando o agente suporta, em vez de reenviar o brief inteiro: é mais barato e o agente já sabe o que tentou. Vai junto o motivo da falha.

**O substituto entra como irmão no grafo, não como filho.** Ele não foi chamado pelo que falhou — está no lugar dele. Ver os dois lado a lado é o que torna a troca auditável; aninhar sugeriria uma delegação que não houve.

**O histórico de falhas viaja com a tarefa.** `failureContext` anexa ao brief do substituto o que cada agente anterior tentou e como falhou. Sem isso o fallback recomeça cego e cai no mesmo buraco — exatamente o desperdício que a cadeia deveria evitar.

**Desistir termina em `failed`, não em espera** (ADR 06.1). O contexto fica preservado e um evento de prioridade alta aparece no stream, mas o fluxo não fica pendurado esperando alguém aparecer.

### O portão de validação

"O agente terminou sem erro" e "o agente entregou o que foi pedido" são coisas diferentes, e só a segunda importa.

O que é verificado de forma determinística é o **comando**: build, testes, lint, rodados no worktree da sessão. É barato, objetivo, e pega a falha mais comum — o agente diz que terminou e o projeto não compila.

Os **critérios de aceite em linguagem natural NÃO são checados por heurística de texto.** Comparar critério com resumo por similaridade produz veredito que parece rigoroso e não é. Quem faz isso de verdade é o portão de revisão por segundo agente, que custa uma sessão de modelo e por isso é opt-in; os critérios seguem no brief dessa revisão.

## 4. Configuração por projeto

Boa parte da política só faz sentido dentro de um repositório: o comando de validação de um projeto Node é `npm test`, o de um Python é `pytest`, e não há padrão global que sirva aos dois. Por isso `<repo>/.agents-hub/config.yaml`, versionado junto do código.

```yaml
policy:
  validation:
    command: npx tsc -b
    commandTimeoutSeconds: 300
  commands:
    deny: [npm publish, gh release]
```

**O projeto só pode APERTAR.** `maxDepth` e `maxConcurrency` só descem; a allow list de comandos só perde itens; a deny list e a vigilância só ganham. Se um repositório pudesse elevar o próprio teto, bastaria um `.agents-hub/config.yaml` malicioso num repo clonado para o Hub virar execução arbitrária na sua máquina. A fusão em `packages/daemon/src/project-config.ts` garante isso, e há teste para cada direção.

O cache é invalidado por `mtime` + tamanho do arquivo: reler a cada evento seria caro, e cachear para sempre obrigaria a reiniciar o daemon depois de editar o arquivo.

Os campos do `config.yaml` que mudam o que a máquina **faz** — `validation.command`/revisão, `env`, `prompts`, `memory` — só valem com `hub project trust` (hash do conteúdo confiado no banco do Hub; se o arquivo mudar, a confiança fica suspensa). Detalhes no [README](../README.md#quando-um-agente-falha) e em [SECURITY.md](../SECURITY.md).

## 5. Como isto é testado

Testar retry e fallback contra agentes de verdade seria caro, lento e dependente de rede — três motivos para o teste nunca rodar. O teste de integração usa **agentes falsos**: scripts Node que falham sob comando, declarados por manifesto como qualquer outro agente. O pipeline não sabe a diferença, e o custo é zero.

```bash
npm run build:packages && npm test    # a suíte inteira (scripts/run-tests.mjs)
# um arquivo só (a flag é exigida no Node 22.5–22.12):
node --experimental-sqlite --test packages/daemon/dist/resilience.integration.test.js
```

## 6. Guarda de borda do daemon

O Hub roda agentes com **todo o privilégio do seu usuário**. Um daemon HTTP em localhost sem guarda é dirigível por qualquer página web que você visitar — e isso não é teórico: um POST com `Origin` de outro site e `Content-Type: text/plain` criava recurso e devolvia `201` contra o daemon real.

O vetor é o `<form enctype="text/plain">`: o navegador **não** faz preflight dele. Qualquer página aberta enquanto o daemon estivesse no ar poderia iniciar sessões de agente, aprovar aprovações pendentes, cancelar trabalho e derrubar o Hub.

Três checagens antes de qualquer rota, cada uma fechando um caminho distinto:

| Checagem | Fecha |
|---|---|
| `Host` precisa ser loopback | **DNS rebinding** — domínio do atacante resolvendo para 127.0.0.1, o que faria o `Origin` parecer legítimo |
| `Origin`, quando presente, precisa ser a nossa | Página remota. Navegador não deixa página forjar esse cabeçalho, e a Web UI é servida por este mesmo daemon, então sempre passa |
| Corpo só como `application/json` | **CSRF por formulário** — formulário HTML não consegue mandar esse content-type sem preflight |

Cliente fora do navegador (CLI, MCP server, `curl`) não manda `Origin` e passa. **Isso é proposital:** um processo local já roda como você e não ganharia nada atacando o Hub. Quem precisa ser barrado é a página remota.

### Token de operador (item 1.6)

As rotas que mudam política ou segurança exigem o token de `<AGENTS_HUB_HOME>/operator-token` (401 `UNAUTHORIZED` sem ele). Lista, modelo de ameaça e limites em [SECURITY.md](../SECURITY.md#o-token-de-operador-não-é-fronteira-contra-o-seu-próprio-usuário). Resumo de quem autentica como:

| Cliente | Como recebe o token | `by`/autor na auditoria |
|---|---|---|
| CLI (`hub approve`, `hub policy`, `hub stop`...) | lê o arquivo a cada chamada (`@agents-hub/client/operator-token`) | `cli:<usuário>` |
| Web UI servida pelo daemon | cookie `hub_operator` (`HttpOnly; SameSite=Strict`) ao carregar `/` | `web` |
| Web UI em `vite dev` (porta 4748) | o proxy do Vite lê o arquivo e injeta `Authorization` + `X-Hub-Client: web` | `web` |
| MCP server, hook do agente, agente | **não recebe** | — |

### Validação na borda

Todo corpo e todo parâmetro de rota passam por schema antes de chegar ao domínio. Ids do Hub têm prefixo (`ses_`, `tsk_`, `apv_`, `prj_`) e são validados por formato — `../../etc/passwd` não chega perto de virar consulta. Os schemas são `strict`: campo desconhecido é **recusado**, não ignorado, para um typo em cliente não passar despercebido. Query param numérico com lixo vira ausência, senão chegaria ao SQL como comparação que nunca casa e devolveria vazio em silêncio.

## 7. Editor de política e auditoria (item 1.10)

A política tem duas camadas editáveis, as mesmas que o daemon funde para decidir:

| Camada | Arquivo | Regra |
|---|---|---|
| Global | `<AGENTS_HUB_HOME>/config.json`, chave `policy` | funde livre sobre o padrão (topo da hierarquia); gravar lista em `loosened` o que ficou mais permissivo |
| Projeto | `<repo>/.agents-hub/config.yaml`, chave `policy` | **só aperta** (clamp do item 0.7, `mergeProjectPolicy`); gravar lista em `clamped` o que não vale e em `ignoredExecFields` os campos de execução sem `hub project trust` |

"Modos" aqui são as decisões por nível de risco (`risk.read|write|exec|escalate|irreversible|budget` → `allow|approve|deny`) e a vigilância (`watch.pauseOn|flagOn`); o modo da sessão (`supervised|semi|autonomous`) continua escolhido ao abrir a sessão. Toda camada passa por `PartialPolicyDocumentSchema.strict()`: campo inexistente é 422, nunca gravado e ignorado.

| Rota | Token | Corpo / query | Resposta |
|---|---|---|---|
| `GET /policy[?projectId=prj_x]` | não | — | `{ policy: { global: {file, layer, effective}, project: {projectId, path, file, trusted, error, layer, effective, clamped, ignoredExecFields} \| null } }` |
| `PUT /policy` | sim | `{ "policy": <camada parcial> }` (substitui a camada inteira; `{}` remove) | `{ policy, loosened: string[], backup: string \| null }` |
| `PUT /projects/:id/policy` | sim | `{ "policy": <camada parcial> }` (preserva memória/prompts/env/comentários do YAML) | `{ project, clamped: string[], ignoredExecFields: string[] }` |
| `GET /audit` | não | `sessionId`, `projectId`, `kind`, `since`, `until` (ISO ou `30m`/`2h`/`7d`), `limit` (≤ 5000, padrão 200) | `{ entries: AuditEntry[] }`, mais recente primeiro |

`AuditEntry` = `{ id, ts, actor, kind, sessionId, projectId, approvalId, action, decision, risk, reason, detail }`. `kind`: `gate.decision` (toda decisão do gate pré-execução numa sessão do Hub, autor `gate`), `approval.requested` (autor `gate` ou `policy`), `approval.resolved` (autor = quem decidiu: `cli:<usuário>`, `web`, `tempo esgotado`), `policy.updated`, `project.trust`, `project.context`, `project.import` (só aplicado), `project.folders`, `maintenance.sweep`, `daemon.shutdown`. Tabela própria (`audit_log`, migração 7), só-acréscimo, fora da retenção de eventos.

No cliente (`@agents-hub/client`): `policy(projectId?)`, `setGlobalPolicy(layer)`, `setProjectPolicy(projectId, layer)`, `audit(query)`. Na CLI:

```bash
hub policy show [--project [p]] [--json]
hub policy set defaultBudget.usd 2 [--project [p]]
hub policy unset maxDepth [--project [p]]
hub policy deny add "npm publish" [--project [p]]
hub policy allow rm "npm install"
hub policy mode exec approve --project
hub audit --since 2h
hub audit ses_abc --kind approval.resolved --json
```
