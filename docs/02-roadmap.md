# 02 — Roadmap de Implementação

Ordem derivada do ADR 04.4: **vertical fina primeiro**. Cada fase termina com algo que roda de verdade.

> **Leia junto:** [07 — Progresso real](07-progresso-real.md) confere cada caixa deste
> arquivo contra o código, o binário e o banco. Onde os dois discordarem, o 07 é a
> fonte — ele foi verificado, este aqui foi declarado. As caixas da Fase 3 abaixo já
> foram corrigidas a partir dele. [08 — Endurecimento](08-endurecimento.md) faz o
> mesmo pelo processo e pela operação: o que impede o repositório de quebrar sem
> ninguém perceber, e o que quebra quando o daemon roda por dias.

## O que cada marca significa

Este roadmap já marcou como `[x]` coisas que não estavam prontas — um "A2A server" que
nenhum peer A2A conversa, um motor de workflows que validava o DAG e o ignorava na
execução, um evento de alerta de orçamento sem nenhum emissor. Enquanto o plano mentir,
toda decisão tomada em cima dele nasce errada. Por isso as marcas passaram a ter
definição, e o critério completo mora em [`CONTRIBUTING.md`](../CONTRIBUTING.md):

| Marca | Significado |
|---|---|
| `[x]` | compila do zero, tem teste que falharia sem a mudança, tem consumidor, foi exercido fora do teste, e a frase descreve o que existe |
| `[~]` | existe e funciona, mas entrega **menos** do que a frase sugere — e a frase diz o quê |
| `🕳️` | código escrito, nunca exercitado fora do teste unitário |
| `[ ]` | não começou |

`🕳️` é informação legítima, não confissão. O que não é legítimo é `[x]` sem ter rodado.

## Fase 1 — Vertical fina ✅ concluída e validada em 2026-08-26

Objetivo: uma sessão real com agentes de verdade, ponta a ponta, provando o contrato antes de multiplicar por oito.

- [x] Monorepo (npm workspaces + TS project references), tipos do domínio
- [x] `EventEnvelope` + vocabulário de eventos
- [x] `PolicyEngine`: níveis de risco, overlay de supervisão, não-escalação por interseção
- [x] `BudgetLedger`: orçamento da raiz consumido pelos descendentes
- [x] `CallGraph`: profundidade + detecção de ciclo semântico
- [x] `store`: SQLite via `node:sqlite`, migrações versionadas, repositórios
- [x] Contrato de adapter + registry dirigido por manifesto + cache de probe em disco
- [x] Adapter genérico de CLI (spawn, JSONL, timeout, heartbeat, kill de árvore no Windows)
- [x] Mappers dedicados: Claude Code e Codex
- [x] Manifestos dos agentes — eram 8 no plano; hoje são **9** (`openclaude` entrou depois)
- [x] `WorktreeManager`: isolamento por git worktree, branch preservado ao encerrar
- [x] Daemon HTTP + SSE com replay de eventos
- [x] CLI: `daemon`, `doctor`, `agents`, `project`, `start`, `watch`, `send`, `delegate`, `graph`, `budget`, `cancel`
- [x] Testes do domínio (27, verdes)
- [x] **Teste de fumaça real**: sessão Claude → delegação para Codex, grafo e custo consolidados

### O que o teste real revelou (e já foi corrigido)

| Achado | Correção |
|---|---|
| `where <bin>` no Windows devolve primeiro o shim sem extensão; `spawn` dá ENOENT | O resolver agora prefere `.exe`, depois `.cmd`/`.bat` |
| CLIs travavam no `--version` com stdin aberto | Probe roda com `stdin: ignore` |
| `.exe` a frio no Windows leva até 20s (antivírus + descompressão); 6 em paralelo estouravam o timeout | Timeout de probe para 45s, concorrência limitada a 2, cache em disco |
| Reserva de orçamento sem dimensão explícita sequestrava todo o saldo, travando fan-out | Dimensão não pedida reserva zero; o teto continua garantido no consumo |
| `--detach "objetivo"` engolia o objetivo como valor da flag | Flags booleanas declaradas + suporte a `--chave=valor` |
| Filhos não indentavam sob o pai no grafo | Conector aplicado a todo descendente, não só a partir do nível 2 |

## Fase 2 — Delegação plena, MCP e painel

### Concluído e validado em 2026-08-27

- [x] **MCP server do Hub** — 11 tools sobre o SDK oficial (hoje são **12**, com `hub_session_handoff`); validado com um agente
      externo simulado delegando ao Codex e recebendo o resultado
- [x] **Adoção de agente externo**: quando o principal roda fora do Hub, o MCP server
      adota uma sessão-raiz na primeira chamada que precise de identidade
- [x] `packages/client`: cliente HTTP compartilhado por CLI, MCP e Web UI
- [x] `hub mcp` / `show` / `install --write`: registro na config de cada agente,
      com backup e merge; imprime por padrão em vez de gravar
- [x] Mensagens de erro de delegação que dizem ao agente o que fazer
- [x] **Web UI React+Vite** servida pelo próprio daemon: grafo ao vivo como
      navegação, timeline unificada, painel de custo, controles ao vivo
- [x] `scripts/mcp-smoke.py`: harness JSON-RPC que mantém stdin aberto como um
      hospedeiro real faz

### O que o uso real revelou (e já foi corrigido)

| Achado | Correção |
|---|---|
| SSE com `event: <tipo>` fazia o `onmessage` do navegador descartar tudo que não se chamasse `message` — o painel perdia `turn.completed`, `delegation.*` e `error` sem nenhum sinal de erro | Campo `event:` removido; o tipo já viaja no JSON. `id:` só no stream de uma sessão, onde `seq` é inequívoco |
| Fechar stdin matava o MCP server antes de a resposta calculada ser escrita | Carência de 3s no desligamento por stdin; sinal explícito continua saindo na hora |

### Fila de aprovações e retenção — 2026-08-27

Fecha os dois desvios que a auditoria encontrou entre os ADRs e o código.

- [x] **Portão de delegação** (preventivo de verdade): a chamada agente→agente passa
      por dentro do Hub, então é retida ANTES de qualquer processo subir. Validado:
      sessão supervisionada delegando ao Codex ficou em `input_required`, foi liberada
      pela CLI e só então executou
- [x] **Vigilância reativa** sobre comando executado e arquivo alterado, com
      `pauseOn` / `flagOn` por nível de risco
- [x] Rotas `/approvals`, CLI `hub approvals` / `approve` / `deny`, e fila no topo do painel
- [x] **Retenção de worktree** (ADR 06.3): o checkout sobrevive ao fim da sessão e é
      recolhido pelo `WorktreeReaper` depois de 7 dias; `hub prune` força a passada
- [x] 10 testes novos cobrindo vigilância, herança e o portão de delegação

#### Correções que os testes reais expuseram

| Achado | Correção |
|---|---|
| A rota de delegação não devolvia a aprovação e reportava o estado do objeto em memória: quem chamou via "working" numa tarefa que nem começou — um agente ficaria em polling eterno | Estado relido do banco e `approval` propagado até o `hub_agent_call` do MCP, com instrução explícita de não ficar em polling |
| `seq` vivia só em memória: emitir evento numa sessão criada antes de um restart do daemon recomeçava do 1 e colidia com a chave única `(session_id, seq)`, derrubando cancelamento e negação | Semeadura preguiçosa a partir do banco na primeira vez que a sessão é vista |

### Pipeline de resiliência — 2026-08-27

Fecha o ADR 04.3 e coloca em uso a cadeia de fallback do ADR 06.2, que até
então estava configurada sem consumidor.

- [x] `packages/core/src/resilience.ts`: classificação de desfecho e decisão
      retry / fallback / desistir, em forma **pura** — a lógica que mais precisa
      de teste é a que menos precisa de processo rodando
- [x] Retry com backoff exponencial no mesmo agente, retomando a sessão nativa
      quando o agente suporta (mais barato que reenviar o brief) e levando junto
      o motivo da falha anterior
- [x] Fallback pela cadeia `claude → codex → opencode`, filtrando quem não está
      instalado. O substituto entra como **irmão** no grafo, não como filho:
      ele não foi chamado pelo que falhou, está no lugar dele — e ver os dois
      lado a lado é o que torna a troca auditável
- [x] `failureContext`: o histórico de falhas vai anexado ao brief do substituto,
      senão ele recomeça cego e cai no mesmo buraco
- [x] **Portão de validação** por comando (build/testes/lint) rodado no worktree;
      reprovar volta ao retry com o detalhe do que falhou — a tentativa com mais
      chance de dar certo de todas
- [x] Desistência termina em `failed` com evento de prioridade alta (ADR 06.1),
      sem pendurar a task esperando alguém
- [x] 15 testes unitários + **teste de integração com agentes falsos**: scripts
      Node que falham sob comando, exercitando retry e fallback com custo zero

**Limite assumido:** os critérios de aceite em linguagem natural NÃO são
verificados por heurística de texto. Comparar critério com resumo por
similaridade produz veredito que parece rigoroso e não é. Quem faz isso de
verdade é o portão de revisão por segundo agente, que custa uma sessão de modelo
e por isso é opt-in; os critérios seguem no brief dessa revisão.

### Adapter HTTP do OpenCode — 2026-08-27

- [x] API real levantada contra o binário (1.17.15) lendo a OpenAPI que o próprio
      servidor publica em `/doc`; spec e resumo em [`docs/referencias/`](referencias/)
- [x] `OpenCodeAdapter`: sessão por `POST /api/session` com `location.directory`
      apontando para o worktree — um servidor só, N sessões isoladas
- [x] Tradutor de eventos SSE puro e testável sem servidor (19 testes)
- [x] **Custo por passo real**, que a CLI headless simplesmente não entrega
- [x] `interrupt` de verdade (`POST /interrupt`), sem a degradação para kill que o
      adapter de processo sofre no Windows
- [x] `send()` ao vivo com `delivery: steer` — a única integração do conjunto que
      injeta mensagem no turno em andamento
- [x] Ciclo de vida do servidor: sobe se não houver, reaproveita se houver, e só
      derruba o que ele mesmo subiu

#### O que o teste real expôs

| Achado | Correção |
|---|---|
| O poll de fim de turno começava junto com a run, antes do prompt ser enviado: três ausências em 3s e a run era encerrada **antes de o turno existir**, com zero token e ar de sucesso | Poll só começa depois do prompt aceito, e ausência só conta como fim depois de o turno ter sido visto ativo |
| Turno que falhava no provedor (401, modelo inválido) saía do adapter como `exit 0` — o pipeline não via falha, mandava para a validação e queimava tentativas culpando o motivo errado | O adapter registra o erro do turno e o reflete no desfecho da run |
| **Worktree isolado não tem `node_modules`**: `npm test` e `tsc` falhavam na primeira linha para todo agente, e o portão de validação reprovava por um motivo alheio ao trabalho | `WorktreeManager` liga `node_modules`/`.venv`/`vendor` por junction (Windows) ou symlink |
| A CLI devolvia o terminal no fim do TURNO, enquanto validação, retry e fallback ainda podiam mudar o resultado | Espera a tarefa chegar a estado terminal e relata o portão de validação |

### Verificação dos manifestos contra os binários reais — 2026-08-27

Os manifestos de cinco agentes tinham sido escritos por dedução. Verificados um a
um contra o binário instalado (`--help` é grátis; uma execução mínima por agente
onde o formato de saída precisava ser visto). **Todos os três verificados estavam
errados**, dois deles de forma que quebraria a invocação:

| Agente | O que o manifesto dizia | O que o binário faz |
|---|---|---|
| **Copilot** | prompt por arquivo (`{{promptFile}}`), saída texto | `-p` recebe o **texto**; `--output-format json` emite **JSONL**; `--resume=<id>` existe |
| **Kimi** | prompt por stdin, saída texto | `-p` recebe o **texto**; `--output-format stream-json`; `--session <id>` |
| **MiMo** | `-p` com prompt por stdin | **`-p` é `--password`** — o prompt teria virado senha. O certo é `run <texto> --format json` |

- [x] Mapper **verificado** do Copilot (JSONL com `ephemeral` marcando bastidor,
      `session.auto_mode_resolved` revelando o modelo escolhido — única base para
      estimar custo, já que o Copilot fatura em créditos e não reporta dólares)
- [x] Mapper **verificado** do Kimi (formato orientado a `role`; `session.resume_hint`
      é a única fonte do id nativo)
- [x] Descoberta: **MiMo é um fork do OpenCode** — o `mimo serve` publica uma OpenAPI
      cujo título é literalmente `opencode`. Mas expõe a **v1 legada** (rotas na raiz,
      sem `/api`), que é justamente a que o adapter HTTP não fala, então ele roda por
      CLI com o mapper genérico
- [x] 14 testes com amostras capturadas da execução real, não inventadas

### Endurecimento — 2026-08-28

- [x] **Guarda de borda do daemon**: falha confirmada rodando contra o daemon real —
      um POST com `Origin` de outro site e `Content-Type: text/plain` criava recurso e
      devolvia 201. Qualquer página web que você visitasse podia dirigir o Hub com o
      seu privilégio. Fechado por checagem de `Host` (DNS rebinding), `Origin` e
      content-type
- [x] Validação de contrato na borda: todo corpo e parâmetro de rota por schema
      `strict`, com id do Hub validado por formato
- [x] `static`: traversal comparado por caminho relativo, não por prefixo de string

### Restante da fase 2

- [x] **Mapper dedicado e manifesto verificado do Antigravity (agy)** — validado
      contra o binário real `agy.exe` (1.1.22), com stream-json e retomada nativa via `--conversation`
- [ ] Mapper dedicado para Cursor (aguardando disponibilidade de CLI headless independente)
- [ ] Mapper dedicado do MiMo, quando o vocabulário de eventos da v1 for confirmado
- [x] **Gate PRÉ-execução** (Claude Code) — contrato confirmado por sonda contra o
      binário, não deduzido: a decisão de perguntar é `escalate` (não `ask`), e
      `AGENTS_HUB_SESSION_ID` chega no hook, o que resolve a correlação de sessão.
      Validado com o agente real: `git push` barrado antes de executar
- [x] **Gate pré-execução para o Codex** — fechado em 2026-09-18, verificado
      contra o binário real (0.155.0) nesta máquina, não só contra o falso.
      Contrato: sistema de hooks compatível com o do Claude (`PreToolUse`,
      `hookSpecificOutput`), mas **dialeto de resposta oposto** (permitir é
      não escrever nada; não existe `ask`, `approve` vira `deny` com motivo
      obrigatório) — isso já estava em `toCodexHookOutput` + 3 testes puros.
      O que fechou antes: `RunContext.extraArgs` (em `@agents-hub/adapters`)
      deixa o `ProcessAgentAdapter` agnóstico de agente enquanto o
      `SessionManager` monta, só para o Codex, a config de
      `montarConfigDoGate` a cada `#launch` — a função pura já existia,
      testada, e nada em produção a chamava. `codexGate.bypassHookTrust` é
      config GLOBAL (`~/.agents-hub/config.json`, nunca config de projeto —
      é bypass de revisão de hook, não política a apertar), ligada por
      `hub hooks install codex --write`. Sessão `supervised` sem o bypass é
      RECUSADA ao iniciar (`CODEX_GATE_NOT_GUARANTEED`) em vez de rodar
      calada sem a prevenção que o modo promete; `semi`/`autonomous` rodam
      sem o bypass mas com aviso `log`/`stream:"gate"` na timeline — o Codex
      ignora hook não confiável em silêncio, e não avisar repetiria o erro
      que a vistoria (doc 05, achado 3) já corrigiu para outro caminho. A
      correlação de sessão por `cwd` (`#localizarSessao`) já preferia sessão
      viva sobre a mais recente desde a vistoria #5 — o "falta" que esta linha
      dizia antes estava desatualizado.
      **O que a primeira tentativa contra o binário real revelou** (por isso
      o item ficou `🕳️` até hoje, e por isso valeu a pena rodar de verdade em
      vez de confiar só no teste com binário falso): `codex.cmd`, como todo
      shim que o npm instala no Windows, repassa argumentos com `%*` — uma
      SEGUNDA passada do tokenizer do `cmd.exe` sobre a mesma linha, que não
      entende `\"` como aspas escapadas (só alterna dentro/fora de aspas a
      cada `"` literal). O valor de `-c hooks=...` embutia dois caminhos
      entre aspas (`Program Files`, o perfil do usuário — ambos com espaço),
      e se partia num espaço que essa segunda passada achava "fora de aspas":
      `codex` recusava com `unexpected argument`, ANTES de sequer tentar
      registrar o hook — falha aberta, silenciosa em qualquer sessão que não
      fosse `supervised` (que ao menos recusa ao iniciar quando o gate não
      fica garantido). Corrigido em duas partes: `quoteForShell`
      (`packages/adapters/src/bin-resolver.ts`) trocava `"` por `\"` sem
      dobrar as barras que já vinham antes de uma aspas — quebra sempre que
      um valor já escapado (como o TOML do gate) tem barra colada em aspas;
      agora segue a regra de quoting do `CommandLineToArgvW` (contagem de
      barras, não substituição ingênua). Isso não bastava sozinho: o
      `codex.cmd` reprocessa a linha de novo via `%*`, e nenhuma quantidade de
      escape sobrevive a duas aspas aninhadas nessa segunda passada. A
      correção que fechou de verdade foi não precisar de aspas: os caminhos
      do comando do hook agora viram o nome curto 8.3 do Windows
      (`C:\PROGRA~1\...`, sem espaço) quando disponível — ver achado #4 em
      `codex-gate.ts`. Sem 8.3 no volume (raro fora de servidor endurecido),
      cai no caminho original, mesmo risco de antes desta correção.
      3 testes de integração contra um binário `codex` falso (recusa em
      `supervised`, aviso em `semi`, argumentos reais de spawn com e sem
      bypass) + testes novos para o quoting (`bin-resolver.test.ts`) e para o
      nome curto (`codex-gate.test.ts`). **Exercido contra o binário real**:
      sessão `codex --mode supervised` instruída a rodar `git push origin
      main` — o Hub pausou a sessão em `waiting_approval` ANTES da execução
      (`hub approve`/`hub deny`), `deny` confirmado, `origin/main` confirmado
      intocado depois. Mesmo critério já usado para o Claude
- [ ] Gate pré-execução para os demais agentes
- [ ] TUI (a Web UI cobriu a necessidade; virou conveniência, não bloqueio)

## Fase 3 — Plataforma

- [x] **"A2A server" renomeado para o que é: API REST de tasks**. Era uma API REST
      simples em torno dos tipos do Hub, servida em caminhos com nome A2A
      (`/a2a/tasks`, `/.well-known/agent-card.json`) sem nunca ter implementado
      JSON-RPC 2.0, `message/send`, `tasks/get` ou `tasks/resubscribe` — um scanner de
      descoberta automática que achasse `/.well-known/agent-card.json` assumiria
      compatibilidade que não existia. Optou-se pela Opção B: renomear em vez de
      implementar o protocolo de verdade. Agora é `/api/tasks/*` (`packages/daemon/src/api-tasks.ts`),
      a rota `/.well-known/agent-card.json` foi removida, e o descritor da API vive em
      `GET /api/descriptor.json`. "A2A de verdade" (JSON-RPC 2.0 completo) continua em
      aberto no [ADR 02.3](decisoes/02-orquestracao.md), gated por um consumidor real
- [x] **Motor de workflows declarativos em YAML** — validação E execução.
      A execução era o defeito mais grave da vistoria: o laço dava `await` em
      `startSession`, que é assíncrona por contrato, então esperava a sessão
      *nascer* e não o passo *terminar*; tudo disparava junto e o `dependsOn` era
      decorativo. Agora `runWorkflow` vive em `packages/core/src/workflow.ts`, em
      forma pura com dependências injetadas (mesmo remédio de `resilience.ts`), e
      garante:
      - o lote inteiro chega a **estado terminal** antes de o próximo começar;
      - **fan-in real** pelo campo `upstream` do Brief — o resumo do passo anterior
        entra no prompt do seguinte, e **não** no `objective`, que alimenta o
        `objectiveHash` da detecção de ciclo;
      - dependência que não conclui **pula** o dependente, transitivamente;
      - **`--budget-usd` passou a ser lido**: o saldo é repartido entre os passos de
        um lote antes do despacho, então a soma dos tetos nunca passa do que sobrou;
      - aprovação pendente e estouro de espera são desfechos próprios (`blocked`,
        `timeout`) — a sessão continua viva no daemon e o relatório diz onde ela está.
      11 testes novos; verificado também contra o daemon real
- [x] **Handoff de sessão**: transferência de controle em tempo de execução entre
      agentes (`POST /sessions/:id/handoff`), evento de domínio `session.handoff`, CLI
      `hub handoff` e MCP tool `hub_session_handoff`. **Ressalva: nunca executado fora
      do teste unitário** — zero eventos `session.handoff` no banco
- [x] **Validação por revisão cruzada** (segundo agente revisa o resultado do primeiro) — implementada na fase 2
- [~] **Painel de custos com projeção e alertas de orçamento**: `project()` e
      `isWarning` existem, e o painel mostra taxa de queima e aviso de 80%. Mas
      `projectedUsd`/`projectedTokens` **não são exibidos**, o evento `budget.warning`
      é o **único tipo do vocabulário sem emissor**, e a projeção usa
      `consumed.seconds`, que só é liquidado no `settle()` do fim da run — ou seja,
      ela não existe enquanto seria útil
- [ ] Isolamento por container como modo opcional (`isolation: container`)
- [ ] ACP: expor o Hub como agente dentro de Zed/JetBrains/Neovim

## Fase 4 — Cobertura da frota

O que o usuário pediu desde o primeiro dia e **nunca virou item de plano**. Não é
funcionalidade nova: é provar, agente por agente, o que o código já permite em tese. A
[§5 do doc 07](07-progresso-real.md) mede isto e a foto é dura — 2 de 9 agentes com
supervisão real, 1 capaz de orquestrar, 3 que já executaram alguma sessão.

- 🕳️ **`hub doctor --smoke`**: abre uma sessão trivial com cada agente instalado e
      registra (processo subiu, `turn.completed` chegou, custo e `nativeSessionId`
      foram capturados). Implementado em `packages/cli/src/doctor-smoke.ts`
      (`smokeTestAgent`/`smokeTestAll`, concorrência 2 — mesma justificativa de
      `Registry.probeAll`) e ligado à CLI em `hub doctor --smoke`
      (`packages/cli/src/main.ts`), com aviso de custo real antes de rodar
      (Copilot fatura em créditos, os demais em USD estimado). Coberto por 4 testes
      unitários contra um daemon HTTP falso (`doctor-smoke.test.ts`) — **nunca
      rodado contra um binário real nesta tarefa**, de propósito: gasta
      tokens/créditos reais de até 9 provedores e exigiria autorização explícita
      por execução, não por implementação. Continua **6 dos 9 agentes nunca
      executaram nada pelo Hub** até alguém rodar o comando de verdade
- [~] **`modeArgs` para os 7 agentes que não têm** — fechado em 2026-09-18 para
      **6 dos 7** instalados nesta máquina, cada um verificado contra `--help`
      do binário real, não deduzido:
      - **copilot** (1.1.17): `--mode plan` restringe de verdade em supervised
        (analisa, não age); semi/autonomous são IDÊNTICOS (`--allow-all-tools`,
        que o próprio `--help` documenta como "required for non-interactive
        mode" — sem ela o CLI trava esperando confirmação que nunca chega).
        Copilot não tem meio-termo nativo entre os dois
      - **kimi**: os três modos do Hub batem 1:1 com os três níveis nativos —
        supervised sem flag (padrão mais restritivo), semi `-y` ("Ask When
        Needed"), autonomous `--auto` ("Never Ask"). Ressalva: supervised roda
        headless via `-p`, sem terminal, e o binário não tem "recusa sozinho o
        que pediria pergunta" — uma ação de risco pode pendurar até o timeout
        do Hub em vez de ser negada
      - **mimo**: `mimo run --help` só tem uma flag de permissão
        (`--dangerously-skip-permissions`/`--yolo`); supervised e semi ficam
        idênticos (sem flag), só autonomous usa `--yolo` — confirmado que não
        há meio-termo no subcomando `run`, não é omissão
      - **antigravity (agy)** (1.1.22): `--mode plan` (supervised) vs
        `--mode accept-edits` (semi/autonomous), mesmo padrão do Claude/Codex
      - **openclaude** (0.13.0): `--permission-mode` com o MESMO vocabulário do
        Claude Code, confirmado no `--help` (não só suposto por ser fork) —
        `plan`/`acceptEdits`, nunca `bypassPermissions`
      - **opencode**: **deliberadamente vazio nos três modos**, com comentário
        no manifesto explicando por quê — este agente roda pelo
        `OpenCodeAdapter` (HTTP), que nunca lê `invoke.modeArgs`
        (só `ProcessAgentAdapter` lê). O mecanismo real de restrição existe
        (`agent` no corpo de `POST /api/session`, confirmado em
        `docs/referencias/opencode-api.md`), mas o adapter nunca o envia —
        fechar isso de verdade é mudar código do adapter, não o manifesto.
        Fica registrado como o que falta, não escondido atrás de flags que
        não fariam nada
      - **cursor**: fora desta passagem — binário `cursor-agent` não está
        instalado nesta máquina, nada para verificar contra
      Onde não achou equivalente nativo (mimo em supervised/semi, kimi em
      supervised, opencode nos três), o manifesto deixou `modeArgs` vazio e
      documentou a ausência em `caveats`, em vez de inventar flag
- [ ] **`session.idFrom` é declarado no schema e lido por ninguém**: Cursor e MiMo
      prometem `session.strategy: native` que o mapper genérico nunca cumpre — todo
      turno seguinte cai em replay. Ou o adapter passa a ler `idFrom`, ou a promessa
      sai do manifesto
- [~] **`openclaude` como cidadão pleno**: entrou em `MCP_TARGETS`
      (`packages/cli/src/mcp-install.ts`), `HOOK_TARGETS`
      (`packages/cli/src/hooks-install.ts`) e nas cadeias de fallback por
      capability que o Claude já tinha (`DEFAULT_POLICY.fallback`,
      `packages/core/src/policy.ts`) — por herança das mesmas capabilities do
      manifesto (`code-edit`, `refactor`, `test-writing`, `code-review`, `debug`,
      `shell`), sempre depois dos agentes já comprovados na cadeia.
      **Atualizado em 2026-09-18**: `MCP_TARGETS` passou para `verified: true`
      por round-trip real (`openclaude mcp add --scope project` gravou
      `.mcp.json` com chave `mcpServers`, igual ao Claude — achado colateral:
      o escopo PADRÃO da CLI não é "project", é "local", que grava em
      `~/.openclaude.json`; não afeta a escrita direta do Hub, mas é pegadinha
      pra quem usar `openclaude mcp add` manualmente). `HOOK_TARGETS` ficou
      **parcialmente** verificado: `~/.openclaude/settings.json` existe de
      verdade nesta máquina com `hooks.PreToolUse`/`SessionStart` no mesmo
      formato do Claude — confirmado por leitura direta do arquivo —, mas o
      comportamento em runtime (o binário consulta o hook antes de
      Bash/Write/Edit? propaga `AGENTS_HUB_SESSION_ID`? dialeto de resposta
      igual ao Claude ou oposto como o Codex?) segue **não exercido**. Ainda
      não vira `[x]`: falta a mesma vistoria comportamental que o gate do
      Codex recebeu (ver Fase 2)
- [ ] **Provar profundidade 2** (A→B→C): `maxDepth` é 3 e a profundidade máxima já
      atingida na vida do repositório é **1**. Detecção de ciclo e herança de política
      em segundo nível nunca foram exercidas num fluxo real
- [ ] **Matriz de pares A→B** para os pares que importam: todo destino já delegado foi
      o Codex, e 3 dos 4 chamadores eram sessões adotadas do harness de fumaça
- [~] **Verificar os caminhos de config de MCP** — fechado em 2026-09-18 para os
      6 agentes marcados `verified: false` e instalados nesta máquina (mesmo
      trabalho que a verificação de manifestos fez em `470a605`, e o resultado
      foi na mesma direção: **3 erros reais encontrados, mais 1 bug de código**):
      - **copilot** → `verified: true`. `copilot mcp --help` documenta
        `~/.copilot/mcp-config.json` ipsis litteris, e o arquivo já existe no
        disco com chave `mcpServers`. O palpite anterior estava certo
      - **antigravity (agy)** → `verified: true`, **caminho corrigido**. O
        palpite anterior (`~/.antigravity/mcp.json`) estava ERRADO — esse
        arquivo nem existe. Por round-trip real (`agy mcp add`/`list`/`remove`,
        entrada de teste removida), o caminho de verdade é
        `~/.gemini/config/mcp_config.json` (o `agy` é sucessor do Gemini CLI e
        herda o diretório de config dele), chave `mcpServers`
      - **opencode** → `verified: true`, **bug de código corrigido**. O
        caminho estava certo (`~/.config/opencode/opencode.json`, confirmado
        pela própria mensagem da CLI ao registrar), mas a chave real é `mcp`
        — **não** `mcpServers`. O código de escrita (`writeJson` em
        `mcp-install.ts`) gravava sempre sob `mcpServers`: `hub mcp install
        opencode --write` teria criado uma entrada que o OpenCode
        simplesmente ignora em silêncio, sem erro nenhum. Corrigido com um
        formato dedicado (`ConfigFormat: 'json-mcp'`) só pra este agente
      - **openclaude** → `verified: true` (ver item "cidadão pleno" acima)
      - **kimi** → continua `verified: false`, mas a nota deixou de ser
        genérica: `kimi --help` (raiz e subcomandos) não tem NENHUM comando
        `mcp`, e nenhum arquivo em `~/.kimi-code/` (`config.toml`,
        `workspaces.json`, `tui.toml`) tem seção de MCP. Não é "não
        confirmado" — é ausência de mecanismo nesta versão do binário
      - **mimo** → continua `verified: false`, nota também mais específica:
        `mimo mcp add <nome> <comando>` (testado com e sem `--`) só reimprime
        o help fora de terminal interativo — não é scriptável por argumentos.
        `mimo mcp list` revelou que o MiMo **importa** config de outros
        agentes (achou o `~/.claude.json` do Claude Code) em vez de manter
        arquivo próprio previsível; `~/.mimo/mcp.json` (o palpite anterior)
        não existe no disco
      - **cursor** já estava `verified: true` desde antes desta vistoria, mas
        segue **não instalado** nesta máquina (`cursor-agent` ausente do
        PATH) — fora do escopo desta rodada, que só cobriu instalados
- [x] **Dono para a tabela de preços** (`core/pricing.ts`) — fechado em
      2026-09-18 como item de PROCESSO, não de código: proveniência de cada
      linha (`source`, `collectedAt`), gatilho de revisão (trimestral, por
      lançamento de modelo novo, ou por reclamação de custo destoante) e regra
      de dono na ausência de CODEOWNERS, documentados em
      [`docs/10-manutencao-de-precos.md`](10-manutencao-de-precos.md)

## Fase 5 — Endurecimento operacional

O que quebra quando o daemon roda por dias em vez de por trinta segundos. A
vistoria está em [`08-endurecimento.md`](08-endurecimento.md), que também
registra o achado que organiza todos os outros: **o commit de topo de `main` não
compilava**, e o `npm test` coletava 3 dos 30 arquivos de teste quando rodado em
bash. Nenhuma das duas coisas era sabida, porque nenhuma máquina compilava o
repositório do zero antes de aceitar mudança.

### Concluído em 2026-09-18

- [x] **Portão de qualidade**: `scripts/run-tests.mjs` (descoberta em JavaScript,
      idêntica em todo shell), CI no GitHub Actions com `npm ci` + build limpo +
      suíte em Windows/Node 22.5 e 24, e `npm run verify` como espelho local.
      Linux entra como job **informativo** — o Hub nunca rodou nessa plataforma
- [x] **Critério de pronto** em [`CONTRIBUTING.md`](../CONTRIBUTING.md), com o
      vocabulário `[x] / [~] / 🕳️ / [ ]` que o doc 07 inaugurou
- [x] **Build consertado**: três identificadores nunca escritos e um `await`
      esquecido que fazia o gate pré-execução **falhar aberto**
- [x] **Lock de instância pela porta**: `hub.start()` liga a porta antes de
      reconciliar. Um segundo daemon declarava mortas as sessões vivas do
      primeiro e só depois descobria que a porta estava ocupada
- [x] **Rede de segurança de processo** (`safety-net.ts`): `unhandledRejection`
      registra sem derrubar, `uncaughtException` derruba de forma ordenada
- [x] **Desligamento confiável**: `killTree` esperado (era fire-and-forget antes
      do `process.exit`, deixando a árvore do agente gastando token),
      `allSettled` em vez de `all`, e espera dos pumps antes de fechar o banco
- [x] **Vazamento de memória** em `#ledgers` / `#seeded` / `#models`
- [x] **Daemon deixou de ser cego**: o autostart escreve em
      `~/.agents-hub/logs/`, que a config criava vazio desde sempre

### Restante

Ordenado por dano, não por esforço. Detalhe e evidência na §3.7 do doc 08.

- [x] **Drenar o stderr do `opencode serve`** — `createInterface` sobre
      `child.stderr`, ecoado como `[opencode serve] <linha>`. Achou dois
      problemas a mais no caminho, os dois verificados contra o binário real
      (`opencode.cmd` desta máquina, cujo caminho tem espaço — `C:\Users\Bruno
      Silva\...`):
      - **`#bootServer` nunca quotava o caminho pro `shell: true`**: o
        autostart do OpenCode FALHAVA SEMPRE em qualquer máquina com espaço
        no perfil do usuário — não era um caso raro, era o caso comum no
        Windows. Reproduzido isolado contra o `opencode.cmd` real antes da
        correção (`'C:\Users\Bruno' não é reconhecido...`), corrigido com o
        mesmo `quoteForShell` que `process-adapter.ts` já usa;
      - **`close()` matava o `cmd.exe` antes do `taskkill /T`**: a ordem
        errada deixava o `node.exe` real do servidor reparentado e vivo — o
        `/T` precisa do pai ainda de pé pra andar a árvore. Mesma classe de
        achado do `killTree` já corrigido em `process-adapter.ts`, replicada
        aqui como `killServerTree`.
      Teste de integração cobrindo o dreno (`packages/adapters/src/opencode/adapter.test.ts`,
      binário falso — o bloqueio em si não reproduziu de forma determinística
      neste Windows, então o teste prova o que É determinístico: que o Hub
      drena de verdade, não só declara `pipe`). **Exercido contra o binário
      real**: `hub start --agent opencode` de ponta a ponta nesta máquina —
      autostart do `opencode serve` real, sessão completa, turno concluído
      ("teste ok", US$0, 3.5k tokens), `close()` sem processo órfão depois
- [ ] **Retenção de eventos**: a tabela cresce para sempre com `payload_json` e
      `raw_json`, sem `DELETE` nem `VACUUM`, enquanto reaper e reconciliação
      fazem full scan. O ADR 06.3 decidiu "eventos para sempre" — e essa decisão
      precisa ser reexaminada ou ganhar compactação do `raw`
- [ ] **Matar a árvore no portão de validação**: `child.kill()` com `shell: true`
      deixa o `npm`/`node` filho vivo a cada timeout
- [x] **Validar a config com Zod** e merge profundo de `policy`. `HubConfigOnDiskSchema`
      valida `config.json` antes do merge (`packages/daemon/src/config.ts`), com
      `HUB_CONFIG_INVALID` legível em vez de `NaN` silencioso. `mergePolicyLayer`
      (`packages/core/src/policy.ts`) substitui o spread raso por merge campo a
      campo, corrigindo tanto a config global quanto `mergeProjectPolicy`
      (`project-config.ts`) — o mesmo bug existia um nível abaixo: só
      `validation.review.enabled` no YAML do projeto apagava `review.agent` do
      global. Testado em `config.test.ts` e `project-config.test.ts`
- [x] **Validar as variáveis de ambiente** e documentar as seis que não estavam
      em lugar nenhum (`packages/daemon/src/env.ts`,
      [`docs/09-variaveis-de-ambiente.md`](09-variaveis-de-ambiente.md)).
      Achado no caminho: `AGENTS_HUB_PORT` só era lido pelo entrypoint
      alternativo (`daemon/src/main.ts`) — o caminho normal do autostart
      (`runDaemon()`, `packages/cli/src/daemon-run.ts`) não lia a variável
      nenhuma vez, então `AGENTS_HUB_PORT=abc` fazia o Node escutar numa porta
      aleatória só nesse caminho. Corrigido nos dois. `env.test.ts` +
      `daemon-run.test.ts` cobrem os dois entrypoints
- [ ] **`.on('error')` nos quatro `spawn`** que não têm, e callback no
      `stdin.write` (EPIPE quando o CLI sai antes de consumir)
- [ ] **PID por sessão no schema**: a reconciliação corrige o registro na subida
      e não mata os processos que sobreviveram ao crash, porque não sabe quais são
- [x] **Keep-alive e `id:` no SSE de `/api/tasks/*`**, try/catch no keep-alive do
      `/events`, e teto de conexões com backpressure. As duas rotas
      (`/events` e `/api/tasks/:id/events`) divergiam na origem: só `/events`
      tinha `setInterval` de ping e `id:`; nenhuma das duas tratava erro de
      escrita nem cliente lento. Extraído para `packages/daemon/src/sse.ts`
      (`startSseChannel`), usado pelas duas — eliminando a divergência na
      origem em vez de remendar cada rota. Cobre:
      - keep-alive com `try/catch` + checagem de `writableEnded`/`destroyed`
        ANTES de escrever, tratando falha como a mesma desconexão do
        `req.on('close')` (mesmo `cleanup`, uma vez só);
      - teto de conexões SSE simultâneas (`config.maxSseConnections`,
        `packages/daemon/src/config.ts`, default 100): acima do teto, 503
        ANTES de `res.writeHead`;
      - backpressure real usando o retorno de `res.write()`: fila local por
        conexão (`queueCap`) enfileira o que não coube, um listener de
        `'drain'` esvazia, e estourar o teto encerra a conexão em vez de
        crescer sem limite na heap. **Achado rodando contra o daemon real**:
        o cap não pode ser menor que o maior replay legítimo — com o default
        de 200 sugerido inicialmente, o PRÓPRIO replay de uma sessão longa
        (até 500 eventos, síncrono, antes de qualquer live event) se
        autoclassificava como "cliente lento" e derrubava a conexão no
        primeiro segundo. Corrigido com `SSE_QUEUE_CAP = SSE_REPLAY_LIMIT +
        200` nas duas rotas (`server.ts`) — o cap de `sse.ts` continua 200
        por padrão para quem não faz replay grande.
      9 testes unitários de `startSseChannel` com timers falsos
      (`packages/daemon/src/sse.test.ts`) + 4 testes de integração contra o
      daemon HTTP real, incluindo o cenário de 503 acima do teto
      (`packages/daemon/src/sse-http.test.ts`)
- [x] **`since` inválido no SSE** devolvendo 200 com zero linhas; truncamento de
      replay em 500 eventos sem sinal de que truncou.
      `parseSseSince` (`packages/daemon/src/http-schemas.ts`) rejeita com 400
      (`INVALID_QUERY`, novo código em `packages/core/src/errors.ts`) ANTES de
      `res.writeHead` quando `since` está presente e não é um inteiro
      não-negativo — deliberadamente DIFERENTE de `inteiroOpcional` (usado por
      `/sessions/:id/events`), que trata inválido como "sem filtro": para uma
      conexão SSE de longa duração, devolver replay completo em silêncio
      quando o cliente pediu um filtro que não foi aplicado é pior que negar.
      Truncamento: em vez de mudar a assinatura de `EventRepository.list`
      (tocaria `session-manager.ts` em 3 lugares e a rota REST de eventos —
      avaliado via `grep -rn "\.events\.list\|listEvents" packages/`), as
      rotas SSE passam um `SSE_REPLAY_LIMIT` (500, igual ao default do
      repositório) explícito para `listEvents` e comparam
      `past.length === SSE_REPLAY_LIMIT`: se bateu no teto, quase certamente
      cortou. Quando corta, um evento sintético `type: 'log'`
      (`payload: { truncated: true, sentCount, sessionId }`, nunca persistido,
      sem `id:` de propósito — não tem `seq` real e reconectar com
      `Last-Event-ID` igual ao dele perderia eventos de verdade) é escrito
      antes dos live events. Coberto em `sse-http.test.ts` contra uma sessão
      com 520 eventos reais no banco.
- [x] **Emissor para `budget.warning`** e projeção que funciona **durante** a run.
      `SessionManager.budget()` usava `consumed.seconds`, só liquidado em
      `ledger.settle()` no FIM da run — a projeção nunca aparecia com a sessão viva.
      Agora usa o tempo de parede da sessão-raiz (`Date.now() - createdAt`), com a
      ressalva de que mede o fluxo inteiro, não só a execução ativa. O emissor
      dispara na transição false→true da pressão de 80% (`SessionManager#checkBudgetWarning`),
      rearma em `raiseLimits()` e no fim do fluxo raiz. Painel mostra a projeção
      (`SidePanel.tsx`) e reage ao vivo (`useHubState.ts`)
- [x] **Limpar os prompts em `tmpdir`** (um arquivo por spawn, para sempre) e pôr
      `maxBuffer` nos `execFileAsync` de `worktree.ts`. `writePromptFile`
      (`packages/adapters/src/process-adapter.ts`) grava um arquivo por spawn com
      timestamp único, nunca reaproveitado, e nada apagava. Agora o caminho fica no
      `InternalHandle` e `settle()` chama `unlink` antes de resolver `handle.done`
      (encadeado, não fire-and-forget — sem isso o teste não teria como observar o
      arquivo já removido de forma determinística). `maxBuffer: 10 * 1024 * 1024`
      em todo `execFileAsync('git', ...)` de `worktree.ts` (`isGitRepo`, `create`,
      `release`, `listStale`, `prune`, `currentRef`) — `listStale` era o que mais
      importava, por crescer com o número de worktrees acumulados. Testado em
      `packages/adapters/src/process-adapter.test.ts` (arquivo some depois que
      `handle.done` resolve)
- [x] **Sinalizar o que hoje é engolido em silêncio**: YAML de projeto quebrado
      caindo na política global, `git worktree remove` que falhou virando "kept"
      implícito, junction de `node_modules` não criado. `loadProjectOverrides` e
      `loadProjectContext` (`packages/daemon/src/project-config.ts`) agora devolvem
      `{ overrides/ctx, error }`: sempre `console.error`, e o `SessionManager`
      (`#avisarConfigDoProjetoQuebrada`) anexa um evento `log` na sessão recém-criada
      quando o YAML do projeto está quebrado. `release()` em `worktree.ts` devolve
      `{ removed, reason? }` com a mensagem real do `git worktree remove`, e
      `WorktreeReaper.sweep()` (`reaper.ts`) expõe `SweepResult` como
      `{ examined, removed, retained, failed: Array<{ path, reason }> }` — `failed`
      distingue "tentei remover e falhou de verdade" de "ainda dentro da janela de
      retenção", logando cada falha. A junção de dependências
      (`#ligarDependencias` em `worktree.ts`) loga a falha real (`console.error`) e
      devolve `dependencyWarnings`, que o `SessionManager`
      (`#avisarDependenciasNaoLigadas`) também anexa como evento `log` na sessão.
      Testado em `packages/daemon/src/project-config.test.ts` (YAML quebrado expõe
      `error`, não só `{}`) e `packages/daemon/src/worktree.test.ts` (`release()`
      forçado a falhar com worktree sujo devolve `removed: false` + motivo real do
      git; falha de `symlink` injetada loga e aparece em `dependencyWarnings`)
- [ ] **Teto no `AsyncQueue`**, que hoje cresce sem limite contra um consumidor
      que faz escrita SQLite síncrona por evento

### Decidido aqui

| Tema | Decisão | Por quê |
|---|---|---|
| Lock de instância | **A porta**, não pidfile | O sistema operacional já garante exclusividade em `127.0.0.1:4747`. Arquivo de lock traz problema próprio (lock órfão após crash) sem resolver nada que a porta não resolva |
| `unhandledRejection` | **Não derruba** | A origem é quase sempre uma sessão específica; matar o daemon inteiro é o dano que se quer evitar. `uncaughtException` derruba, porque ali o estado do processo é suspeito de verdade |
| Linux | **Informativo até provar** | O Hub nunca rodou nessa plataforma. Marcar suporte antes de ter prova é o mesmo erro que este documento trata |

## Incorporado ao produto sem passar pelo plano

Construído, testado e em uso — o plano é que ficou para trás. Fica registrado para que
nada aqui seja tratado como acidente na próxima vistoria.

| O que existe | Onde |
|---|---|
| `openclaude`, o 9º agente | `manifests/openclaude.yaml`, mapper do Claude reusado |
| `hub_agent_wait`, a 12ª tool MCP | `packages/mcp/src/server.ts` |
| Daemon que sobe sozinho, `hub` no PATH e **reconciliação de estado na subida** | `661db71`; 5 testes |
| Captura de diff + artefatos persistidos | o que fez `TaskResult.artifacts` deixar de ser sempre `[]` |
| Precificação estimada por tabela de modelos | `core/pricing.ts` (929 linhas) |
| `conversation.ts` / `rebuildConversation` | sustenta handoff e todo agente sem id nativo |
| `hub hooks` como comando | o plano falava do gate, não de quem o instala |
| `review-verdict.ts` | leitura do veredito com acento, caixa e ambiguidade |
| Projetos multipasta, memória e prompts por projeto, modelo local por agente | `1d27378`, `1568988`, `f8727e9`, `32eb1be` |

## Dívida conhecida, ainda não atacada

- [ ] **`session-manager.ts` tem 2258 linhas** — quase o dobro do segundo maior arquivo.
      Acumula sessões, tarefas, orçamento, portão de política, vigilância, resiliência,
      revisão, diff, projetos, pastas e contexto. Não é bug; é onde os bugs se escondem.
      Os três esquecimentos do invariante de estado terminal (`3f40028`) aconteceram
      exatamente por isso
- [ ] **83 blocos `catch`** em `packages/*/src` — separar os que tratam dos que engolem
- [ ] **Concorrência sob corrida**: reserva de orçamento (`BudgetLedger.reserve`/
      `settle`) e o teto de sessões simultâneas nunca foram testados com chamadas
      concorrentes
- [ ] `pause` tem rota HTTP e não tem comando na CLI
- [ ] O painel não expõe `workflow`, `prune`, `mcp` nem `hooks`

## Decisões ainda em aberto

| Tema | Pergunta | Bloqueia |
|---|---|---|
| Acesso remoto | Expor o daemon na rede/túnel exige authn/authz — desejado? | Fase 3 |

Tudo que bloqueava a Fase 2 foi decidido no [ADR 06](decisoes/06-resiliencia-retencao.md):
falha final termina em `failed` sem travar o fluxo, fallback é `claude → codex → opencode`,
eventos ficam para sempre e worktrees por 7 dias, e o modelo é o default de cada CLI.

