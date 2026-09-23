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
- [x] **`resolveBin`/`lookup` ganharam teste automatizado** (2026-09-22): até aqui,
      a camada que causou os dois incidentes acima — `where <bin>` devolvendo
      primeiro o shim sem extensão, e o quoting do `codex.cmd` — não tinha
      NENHUM teste próprio; `bin-resolver.test.ts` cobria só `quoteForShell`.
      `resolveBin`/`lookup` chamavam `execFileAsync`/`existsSync` direto, sem
      ponto de injeção, então `packages/adapters/src/bin-resolver.ts` ganhou um
      `LookupDeps` (execFileAsync + existsSync) opcional com default de
      produção inalterado — nenhum call site existente precisou mudar.
      Cobertura nova em `packages/adapters/src/bin-resolver-lookup.test.ts`
      (15 testes): preferência de ordem `.exe` > `.cmd`/`.bat` > primeira linha
      crua entre múltiplos candidatos do Windows; ramo POSIX (`which`, sem
      lógica de extensão); cache por `Map` (segunda chamada não rechama
      `execFileAsync`) e `clearBinCache()` limpando de fato; fallback dos 5
      caminhos hardcoded na ordem certa quando `where`/`which` falha ou
      devolve vazio. Confirmado que os testes não são de fachada: revertendo a
      ordem de preferência (`.cmd` antes de `.exe`) no `dist/` compilado, os 2
      testes de ordem falham como esperado antes de reconstruir. Build limpo e
      suíte inteira em 380 testes (365 anteriores + 15 novos) verde
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
- [x] **`session.idFrom` removido do schema e dos 9 manifestos** (2026-09-22): era
      dead code puro — nenhum código lia o campo; a extração de id nativo, quando
      acontece, já é feita pelo mapper dedicado de cada agente
      (`mapped.nativeSessionId` em `packages/adapters/src/process-adapter.ts`), nunca
      por `idFrom`. Em vez de implementar a leitura, a promessa foi removida do
      schema Zod (`packages/adapters/src/types.ts`) e de `claude.yaml`, `codex.yaml`,
      `antigravity.yaml`, `copilot.yaml`, `kimi.yaml`, `opencode.yaml`,
      `openclaude.yaml`, `cursor.yaml` e `mimo.yaml`. Build limpo e suíte inteira
      (365 testes) verde depois da remoção — confirma que ninguém dependia do campo.
      **Não confundir com o item de mapper dedicado do Cursor/MiMo (linhas 200-201),
      que continua aberto separadamente** — aquele é sobre extrair id nativo de
      verdade via mapper; este era sobre um campo de schema que nunca foi lido por
      nenhum mecanismo
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
- [~] **Configurar ambiente (modelo/provedor/endpoint) ponta a ponta, por
      agente** — auditoria de 2026-09-19 achou o controle do OpenCode
      **fachada** (salvava, mas nunca chegava ao processo real) e a Web UI
      cega para 12 dos 14 prefixos de provedor que `agent-env.ts` já permite.
      Fechado parcialmente:
      - 🕳️→[~] **`OpenCodeAdapter` não lia `ctx.env`** (achado crítico): nenhum
        método do adapter (`start`/`resume`/`#bootServer`/`#prompt`) repassava
        ambiente ao `opencode serve` real — configurar `OPENAI_BASE_URL` para
        este agente na UI "salvava com sucesso" e não tinha efeito nenhum,
        sem aviso em lugar nenhum. Corrigido: `#bootServer` agora sobe o
        processo com `{ ...process.env, ...ctx.env }`
        (`packages/adapters/src/opencode/adapter.ts`). Continua `[~]`, não
        `[x]`, porque o servidor é **um só, compartilhado por todas as
        sessões** — só a PRIMEIRA sessão a subir o servidor consegue de fato
        influenciar o ambiente; sessões seguintes com `env` diferente não têm
        efeito sobre um servidor já no ar. Não existe hoje mecanismo do
        `opencode serve` para configurar isso por REQUISIÇÃO (confirmado em
        `docs/referencias/opencode-api.md` §5). O adapter agora detecta essa
        divergência e avisa no log do daemon
        (`[opencode] servidor já está no ar com outro ambiente...`), em vez de
        falhar em silêncio; resolver de verdade exigiria um servidor por
        projeto (custo de boot medido em ~20s no Windows). Documentado em
        `manifests/opencode.yaml` (`caveats`). Coberto por um teste de
        integração novo (`adapter.test.ts`, servidor falso que ecoa a
        variável recebida via `spawn()`) — **não testado contra dois
        projetos concorrentes com `opencode serve` real** nesta tarefa
      - [x] **Web UI só oferecia `OPENAI_*`** para qualquer um dos 9 agentes,
        mesmo para `claude`/`antigravity`, que não leem essas variáveis.
        `SettingsView.tsx` ganhou um editor de "outras variáveis de
        ambiente" (chave livre + valor), com a lista de prefixos aceitos
        exibida como referência e um aviso client-side quando a chave digitada
        não bate com nenhum prefixo permitido (o daemon já recusava
        server-side; isto só evita a surpresa de salvar achando que colou).
        Também avisa quando a variável não é mencionada no manifesto do
        agente selecionado (best-effort, não bloqueia)
      - [x] **Nenhum caminho de CLI configurava env/prompt por projeto** — só a
        Web UI chamava `saveProjectContext`. Adicionados `hub project env
        [projeto] [--agent <id>] [--set CHAVE=VALOR|--unset CHAVE]` e `hub
        project prompt [projeto] --agent <id> [--set "texto"|--clear]`
        (`packages/cli/src/main.ts`), reaproveitando `client.projectContext`/
        `saveProjectContext` já existentes — nenhuma rota HTTP nova.
        Smoke-testado manualmente ponta a ponta (registrar projeto, setar e
        listar env, variável recusada pelo filtro do daemon avisando na hora,
        setar/ler/limpar prompt, conferindo o `config.yaml` final)
      - 🐛 **Achado colateral, corrigido**: `saveProjectContext`
        (`packages/daemon/src/project-config.ts`) quebrava com "Expected a
        YAML collection as document contents" na PRIMEIRA gravação de
        qualquer projeto sem `.agents-hub/config.yaml` ainda — o caminho
        normal de configurar só `env` num projeto novo, pela Web UI ou pela
        CLI nova. Causa: `Document#delete` da lib `yaml` (ao contrário de
        `Document#set`) lança nesse estado, e `saveProjectContext` sempre
        chama `.delete('memory')`/`.delete('prompts')` quando esses campos
        vêm vazios. Corrigido inicializando `doc.contents` como mapa vazio
        antes de aplicar as mudanças. Testado em `project-context.test.ts`
      - [x] **Aviso de arquivo versionado perto do campo de chave de API**,
        na Web UI (mais específico que a nota genérica que já existia) e na
        CLI (impresso ao usar `--set` numa chave cujo nome sugere segredo)

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

### Auditoria de segurança — 2026-09-19

- [x] **Bypass de `denyFragments`/`IRREVERSIBLE_PATTERNS` por diferença de
      maiúscula/minúscula (achado ALTO)**: `packages/core/src/policy.ts`
      comparava `denyFragments` (`.ssh`, `.aws`, `.env`, `id_rsa`,
      `credentials`, `.git/config`) com `.includes()` sensível a caixa, e 12
      dos 13 `IRREVERSIBLE_PATTERNS` não tinham a flag `i`. Em Windows e no
      padrão do macOS (APFS), sistema de arquivos é insensível a
      maiúsculas/minúsculas: um `.ENV`/`ID_RSA`/`Credentials` escrito por um
      agente (de boa-fé ou por prompt injection) era o MESMO arquivo físico
      que `.env`/`id_rsa`/`credentials`, mas caía como `allow` comum em vez de
      `irreversible`, gravado sem aprovação — quebrando a garantia que
      `SECURITY.md` documenta. Corrigido normalizando `target`/`fragment` para
      minúsculas antes do `.includes()`, e adicionando `i` a todos os regexes
      de `IRREVERSIBLE_PATTERNS` (cobria variações tipo `Git Push`/`NPM
      PUBLISH` em PowerShell, case-insensitive). Teste de regressão em
      `policy.test.ts` cobrindo `.ENV`, `ID_RSA`, `Credentials`, `.SSH/id_rsa`
      e `Git Push`/`NPM PUBLISH`
- [x] **`SECURITY.md` deixa explícito que `escalate` só pausa de verdade com
      gate pré-execução (achado MÉDIO, só documentação)**: `WatchPolicy`
      padrão (`pauseOn: ['irreversible']`) não incluía `escalate` — decisão de
      produto deliberada (ruído), mantida como estava. O texto agora nomeia os
      9 agentes e diz, por linha, quais dos 2 com gate (Claude Code, Codex) e
      quais dos 7 sem gate (opencode, openclaude, copilot, kimi, antigravity,
      mimo, cursor) só recebem vigilância reativa que não impede a ação
- [x] **Comentário sobre sequestro de `*_BASE_URL` em `agent-env.ts`** (achado
      MÉDIO): documentado ao lado dos riscos já descritos de
      `NODE_OPTIONS`/`PATH`/etc. que um `.agents-hub/config.yaml` malicioso
      pode redirecionar `OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL`/etc. para um
      endpoint controlado por atacante, vazando a credencial nativa do CLI já
      autenticado. Aviso na Web UI (`SettingsView.tsx`) foi avaliado e
      **deliberadamente não implementado** nesta tarefa, para não arriscar
      conflito de merge com outro trabalho em andamento nesse componente —
      fica registrado aqui como sugestão pendente
- Nota de execução: `npm test` teve uma falha isolada em
  `runValidation mata a árvore inteira quando o comando estoura o timeout`
  (`packages/daemon/src/validation.test.ts`) na primeira rodada da suíte
  completa. Roda limpo isolado e limpo numa segunda rodada completa da suíte
  — é kill de árvore de processo sob concorrência no Windows, teste flaky
  pré-existente, sem relação com as mudanças desta auditoria

### Auditoria de segurança — 2026-09-22

- [x] **`mergePolicyLayer` não travava `risk`/`allowWriteOutsideWorkdir` por
      projeto (achado CRÍTICO, dois campos, mesma causa raiz)** — fechado no
      mesmo commit. `packages/core/src/policy.ts` fazia
      `{ ...base.risk, ...(layer.risk ?? {}) }` incondicionalmente, mesmo sob
      `clampToBase: true` — diferente de `commands.allow/deny`,
      `watch.pauseOn/flagOn` e `network.allowDomains`, que já tinham ramo de
      clamp. Como `loadProjectOverrides` (`project-config.ts`) faz só um cast
      TypeScript de `parsed['policy']` sem validação Zod em runtime, um
      `.agents-hub/config.yaml` de um repositório clonado com
      `policy.risk.irreversible: allow` / `policy.risk.escalate: allow`
      desativava a aprovação de `git push --force`, `rm -rf`, escrita em
      `.env`/`.ssh`/`id_rsa` e qualquer ação `escalate` — para QUALQUER
      agente, inclusive os dois com gate pré-execução (Claude Code, Codex),
      cuja resposta ao hook deriva da mesma `verdict.decision`. Isso
      contradizia diretamente a garantia documentada em `SECURITY.md`
      ("config de projeto hostil só pode apertar, nunca afrouxar") e o
      comentário no próprio código, uma função abaixo do bug. O segundo
      campo, `paths.allowWriteOutsideWorkdir`, tinha o mesmo problema: era
      sempre "layer vence" (`layer.paths?.allowWriteOutsideWorkdir ??
      base...`), então `policy.paths.allowWriteOutsideWorkdir: true` no
      config do projeto ligava escrita fora do worktree mesmo com a política
      global desligada — uma escrita que seria classificada `escalate`
      passava a `write` comum (risco padrão `allow`), sem aprovação e sem
      aparecer na vigilância. Corrigido: `risk` sob clamp agora usa
      `narrowestDecision` (já existente, mesma regra da herança pai→filho na
      delegação) campo a campo, nunca deixando a camada de projeto afrouxar
      uma decisão da base; `allowWriteOutsideWorkdir` sob clamp usa AND
      lógico (`base.paths.allowWriteOutsideWorkdir && (layer... ?? base...)`),
      espelhando o merge pai→filho já correto (`parent.paths.allow... &&
      child.paths.allow...`). 4 testes de regressão novos em
      `project-config.test.ts`, **confirmados como falhando sem a correção**
      (revertida temporariamente com `git stash` para provar: `actual: allow,
      expected: approve` e `actual: true, expected: false`) antes de
      restaurar o fix — não é cobertura de fachada. Build limpo, suíte
      inteira (410 testes) verde em duas rodadas.
      **Ressalva de defesa em profundidade, não corrigida agora**: o cast
      cego em `loadProjectOverrides` (sem validação Zod de
      `ProjectPolicyOverrides`) significa que QUALQUER campo de
      `PolicyDocument` presente no YAML — não só os que o tipo TypeScript
      declara — chega ao `mergePolicyLayer`. A correção acima neutraliza o
      caminho que importava (o merge agora trava certo mesmo recebendo campos
      não declarados), mas adicionar validação Zod real no lugar do cast
      fecharia a classe inteira de "campo não documentado, mas lido em
      runtime" de uma vez — fica registrado como sugestão pendente
- Achados verificados e descartados nesta rodada (sem correção necessária):
  guarda de borda (`guard.ts`) continua cobrindo toda rota via `#dispatch`;
  `http-schemas.ts` continua `.strict()` em todo schema; traversal em
  `static.ts` continua por caminho relativo, não prefixo; `worktree.ts` só
  recebe `sessionId` gerado internamente, nunca id bruto de requisição;
  `quoteForShell` continua correto para os 3 call sites reais de hoje (nenhum
  passa valor attacker-controlled sem espaço mas com metacaractere de
  `cmd.exe` por esse caminho); nenhum vazamento de valor de env sensível em
  log/evento (só nomes de chave aparecem em `console.error`). O aviso de
  sequestro de `*_BASE_URL` na Web UI (`SettingsView.tsx`) continua **não
  implementado** — mesma pendência registrada em 2026-09-19, reconfirmada,
  não é achado novo

### Auditoria do motor de workflows (re-auditoria) — 2026-09-23

Reauditoria confirmou `runWorkflow` (`packages/core/src/workflow.ts`)
majoritariamente correto: lote inteiro espera estado terminal antes do
próximo começar, fan-in real via `upstream`, pulo propagado
transitivamente, `--budget-usd` lido e repartido, aprovação
pendente/timeout como desfechos distintos — nada disso regrediu. Um achado
novo, específico:

- [x] **`CONCURRENCY_EXCEEDED` num lote paralelo era tratado como falha
      permanente, sem retry (ALTO)**. Cenário: dois ou mais passos do MESMO
      lote (`Promise.all` em `runWorkflow`) delegam ao MESMO agente, e a
      política efetiva tem `maxConcurrencyPerAgent` baixo (padrão 2, ou 1 se
      configurado). `SessionManager#start` (chamado como `deps.start`)
      reserva a vaga de concorrência de forma SÍNCRONA — ver a correção do
      TOCTOU documentada acima (`#reserveSlot`/`#releaseSlot`) — e o segundo
      `start()` concorrente para o mesmo agente lança `CONCURRENCY_EXCEEDED`
      (`HubError`) IMEDIATAMENTE, antes de qualquer tarefa existir. Esse
      erro caía no `catch` de `deps.start` dentro de `runWorkflow` e o passo
      era marcado `failed` PERMANENTEMENTE — mesmo tratamento dado a um erro
      genuinamente definitivo (agente inexistente, política negada). Mas
      `CONCURRENCY_EXCEEDED` é transitório por natureza: a vaga libera assim
      que o OUTRO passo do mesmo lote (que já estava rodando) termina,
      tipicamente em segundos. Como a condição nasce ANTES de qualquer
      tarefa existir (na reserva de vaga, não na execução de uma tentativa
      já iniciada), ela nunca entrava no pipeline de resiliência
      (`resilience.ts`, `nextStep`/`classifyOutcome`), que só atua depois
      que uma tentativa de tarefa já está rodando.

      **Mecanismo escolhido**: retry com backoff exponencial, dentro do
      próprio `runWorkflow`, sem tocar `SessionManager` nem a CLI (fora do
      escopo desta correção). Quando `deps.start` falha com
      `isHubError(err) && err.code === 'CONCURRENCY_EXCEEDED'`, o laço espera
      via `deps.sleep` (nova dependência injetável de `WorkflowRunDeps`,
      padrão `sleep` de `resilience.ts` — timer real; testes injetam uma
      versão sem espera de verdade, controlando tempo e contagem) e chama
      `deps.start` de novo, com backoff `concurrencyRetryBackoffMs * 2^tentativa`
      (padrão base 200ms, dobrando a cada tentativa — mesmo formato de
      `resilience.ts#nextStep`). Teto de tentativas
      (`WorkflowRunOptions.concurrencyRetryMaxAttempts`, padrão 5 tentativas
      ADICIONAIS) evita loop infinito se a vaga nunca liberar por algum
      motivo real (ex.: concorrência ocupada por processo externo); ao
      esgotar, o passo é marcado `failed` com mensagem distinta —
      "esgotou tentativas de concorrência" — em vez da mensagem genérica
      "não foi possível iniciar", para que quem lê o relatório do workflow
      saiba que não foi um erro definitivo do agente. Qualquer outro erro
      de `deps.start` (inclusive outros `HubError` com código diferente)
      continua falhando o passo de imediato, sem retry — comportamento
      antigo preservado.

      2 testes novos em `packages/core/src/workflow.test.ts`: (a)
      `CONCURRENCY_EXCEEDED` na primeira chamada, sucesso na segunda —
      confirma que o passo termina `completed`, não `failed`; (b) a vaga
      nunca libera — confirma esgotamento das tentativas configuradas
      (`concurrencyRetryMaxAttempts: 3` no teste, 4 chamadas totais, 3
      esperas) e o passo termina `failed` com a mensagem distinta. Os dois
      testes foram confirmados como **falhando sem a correção** (revertida
      temporariamente com `git stash`, restaurada depois — sem
      `git stash pop`/stash bare, seguindo o protocolo deste worktree
      compartilhado). Build limpo, suíte inteira verde (426 testes, mais os
      2 novos = 428 no total do repositório; 14/14 em `workflow.test.ts`).

      **Escopo desta correção, e o que ficou fora dele, de propósito**: só
      `packages/core/src/workflow.ts` e `packages/core/src/workflow.test.ts`
      foram tocados. `packages/daemon/src/session-manager.ts` (dono da
      reserva de vaga em si) e `packages/cli/src/workflow-cmd.ts` (quem
      chamaria `runWorkflow` com `deps.sleep` real em produção) não foram
      tocados — a correção resolve o problema inteiro no nível do motor de
      workflows (a política de retry vive em `workflow.ts`, testável sem
      processo real), mas quem constrói o `WorkflowRunDeps` de verdade na
      CLI precisa, em algum momento, passar (ou aceitar o padrão de)
      `deps.sleep` — não é urgente porque o padrão já usa timer real, mas
      fica registrado que a CLI não foi auditada/tocada para confirmar que
      não sobrescreve `sleep` com algo incompatível.

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
- [x] **Retenção de eventos**: o ADR 06.3 ("eventos para sempre") foi mantido
      para `payload_json` — é o que sustenta replay, timeline e auditoria.
      `raw_json` (só serve para depurar mapper errado, nunca lido no dia a dia)
      passa a ser compactado (`NULL`), nunca deletado. `EventRepository.compactRawBefore`
      (`packages/core/src/ports.ts`, `packages/store/src/repositories.ts`) faz
      `UPDATE ... SET raw_json = NULL WHERE ... session_id IN (SELECT id FROM
      sessions WHERE ended_at IS NOT NULL AND ended_at < ?)`. Migração versão 4
      cria `idx_sessions_ended` (a compactação filtra por sessão encerrada, e não
      havia índice nesse campo). `RetentionPolicy.rawEventDays` (padrão 7, igual
      a `worktreeDays`) e o novo `EventRetentionCompactor`
      (`packages/daemon/src/event-retention.ts`, mesmo padrão de timer com
      `unref()` do `WorktreeReaper`), ligado em `hub.ts` depois da reconciliação.
      **Decisão explícita: sem `VACUUM` automático no loop periódico** —
      bloquearia o banco inteiro por tempo proporcional ao tamanho do arquivo,
      uma categoria nova de trava num daemon vivo por dias; `PRAGMA
      auto_vacuum=INCREMENTAL` ficou de fora por ora, o compactamento de
      `raw_json` sozinho já entrega o essencial. Testado em
      `repositories.test.ts` (dentro/fora da janela, sessão viva, idempotência)
      e `event-retention.test.ts` (corte calculado certo; passada na largada não
      trava consulta concorrente)
- [x] **Matar a árvore no portão de validação**: `child.kill()` com `shell: true`
      deixava o `npm`/`node` filho vivo a cada timeout no Windows. A lógica de
      matar árvore (duplicada em `killTree` de `process-adapter.ts` e
      `killServerTree` de `opencode/adapter.ts`) foi extraída para
      `packages/adapters/src/process-tree.ts` (`killProcessTree`), reexportada
      de `index.ts`, e `packages/daemon/src/validation.ts` passa a usá-la no
      timeout — aceitando que o `resolve` espere até +5s (teto da função) em
      troca de matar a árvore de verdade antes de liberar o worktree. Testado em
      `process-tree.test.ts` (mata raiz + neto que ignora SIGTERM) e
      `validation.test.ts` (árvore de 3 níveis morta no timeout do portão do
      validador)
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
- [x] **`.on('error')` nos `spawn`** que não têm, e callback no `stdin.write`
      (EPIPE quando o CLI sai antes de consumir). Auditoria dos 5 `spawn()` do
      repositório (`packages/adapters`, `packages/daemon`, `packages/cli`):
      4 já tinham `.on('error')` de correções anteriores; faltava em
      `opencode/adapter.ts#bootServer` (uma falha de spawn do servidor só seria
      percebida depois do timeout de boot inteiro de 60s) — adicionado.
      `process-adapter.ts#spawnRun` escrevia o prompt inicial em
      `child.stdin.write(prompt)` sem callback: uma falha de escrita (EPIPE)
      sumia em silêncio e a run ficava pendurada até heartbeat/timeout. Agora
      tem callback que assenta a run como erro e mata a árvore, no mesmo padrão
      que `send()` já usava. **Ressalva**: não foi possível reproduzir de forma
      determinística, neste Windows, o EPIPE via teste automatizado —
      `process.stdin.destroy()` no processo filho não fecha o handle de PIPE no
      nível do SO até o processo sair, e um processo que sai rápido sempre
      vence a corrida contra o callback assíncrono de erro da escrita. O fix
      ficou coberto por revisão de código (mesmo padrão de `send()`, já em
      produção) em vez de teste automatizado
- [x] **PID por sessão no schema**: `Session.pid` (migração versão 3) e
      `RunHandle.pid` (`ProcessAgentAdapter` preenche com o PID real; `OpenCodeAdapter`
      sempre `null` — documentado que a sessão roda num servidor HTTP
      compartilhado, não um processo dedicado). `reconcileOnStartup`
      (`packages/daemon/src/session-manager.ts`) agora tenta matar o processo
      antes de zerar o registro, **confirmando por `tasklist /FI "PID eq
      <pid>"` que o processo vivo naquele PID ainda bate com o binário
      esperado pelo manifesto do agente** antes de mandar `taskkill` — sem essa
      checagem um daemon reiniciado dias depois podia matar um PID que o SO já
      reciclou para outro processo qualquer do usuário. Testado em
      `reconcile.test.ts` (processo vivo do binário esperado é morto e a sessão
      cai; PID inexistente não lança erro; PID vivo de binário diferente do
      esperado NÃO é morto)
      - **Reforço (auditoria):** a checagem por nome sozinha não fechava o
        caso de reciclagem com o MESMO nome de binário (outro `node.exe`/shim
        `.cmd` do usuário — `imagemPareceEsperada` aceita `cmd`/`sh`/`bash`
        como wrapper plausível para qualquer `bin` alvo). Adicionada uma
        segunda checagem, só no Windows: `horarioDeCriacaoDoProcesso` lê o
        `StartTime` do processo vivo via PowerShell (`Get-Process -Id <pid>`)
        e `pidPareceReciclado` rejeita o kill se esse horário for mais novo
        que o último `updatedAt` da sessão no banco (com folga de 5s para
        diferença de relógio) — um órfão de verdade só pode ter nascido
        antes do daemon anterior morrer. POSIX continua sem cobertura de
        kill nesta reconciliação (limitação já assumida, não resolvida
        agora). Testado em `reconcile.test.ts` (processo nascido depois do
        último registro da sessão NÃO é morto).
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
- [x] **TOCTOU no teto de concorrência por agente** (`session-manager.ts`).
      `#assertConcurrency` só lia `this.#runs` (tamanho do `Map`), e a escrita
      que registra a run (`#runs.set`) só acontecia dentro de `#launch`, depois
      de vários `await` (worktree, baseline, possível portão de aprovação de
      delegação, e só então `adapter.start()` — já com processo real de pé). Um
      fan-out (`Promise.all`) para o mesmo agente fazia todas as tentativas
      lerem o mesmo `#runs` vazio antes de qualquer uma escrever nele,
      furando `maxConcurrencyPerAgent` de verdade, com custo já gasto (worktree
      + processo) antes de qualquer coisa perceber o excesso. Corrigido
      transformando checagem-e-reserva numa única operação síncrona: novo
      `#reserved` (`Map<sessionId, agentId>`), somado a `#runs` em
      `#assertConcurrency`, e `#reserveSlot`/`#releaseSlot` chamados sem
      `await` entre a checagem e o registro em `start()`, `#retry()`,
      `#fallback()` e `handoff()` — cada um envolvendo o trecho até e incluindo
      o `await this.#launch(...)` num `try/finally` que libera a reserva em
      todo caminho de saída (negado, retido para aprovação, erro no meio,
      ou run nascida de verdade). Testado em
      `packages/daemon/src/session-manager-audit.test.ts` (achado 1): cinco
      chamadas de `start()` disparadas com `Promise.allSettled` sem esperar
      uma pela outra, teto por agente em 1 — só uma vaga concedida, as outras
      quatro recusadas com `CONCURRENCY_EXCEEDED`, contra o daemon real (agente
      de teste que de fato sobe como processo via `node`, worktree real).
      Isto resolve a metade "teto de sessões simultâneas" do item de dívida
      "Concorrência sob corrida" — a reserva de orçamento
      (`BudgetLedger.reserve`/`settle`) continua sem teste de concorrência.
- [x] **`resolveApproval` ressuscitava sessão terminal** (`session-manager.ts`).
      No ramo de aprovação não-delegação, o código escrevia
      `state: 'running'` incondicionalmente e só DEPOIS relia a sessão do banco
      para checar se ela já era terminal — checagem morta por construção, já
      que sempre lia de volta o próprio `'running'` recém-escrito. Cenário real:
      uma sessão-filha em `waiting_approval` (estouro de orçamento ou
      vigilância) cujo pai é cancelado antes de a aprovação ser resolvida —
      `cancel()` mata filhos `running` OU `waiting_approval`, mas `#finish` não
      tocava a tabela de aprovações, deixando a `Approval` `pending` e órfã;
      aprová-la depois reescrevia a sessão morta de volta para `running` e
      chamava `send()`, lançando um processo de agente novo para uma sessão que
      o resto do sistema já tratava como encerrada — e o mesmo buraco existia,
      pior ainda, no ramo de delegação (`#launch` direto, sem checagem
      nenhuma). Corrigido em duas frentes: (a) a checagem de terminalidade
      (`isTerminalSessionState`, relendo o banco) agora vem ANTES de qualquer
      escrita ou `#launch`, cobrindo os dois ramos; (b) `#finish` agora nega
      toda aprovação `pending` da sessão que está sendo encerrada — fecha a
      causa-raiz, não só o sintoma, porque `resolveApproval` passa a barrar na
      própria checagem de `state !== 'pending'` do topo da função antes de
      chegar perto de reviver algo. Testado em
      `packages/daemon/src/session-manager-audit.test.ts` (achados 2a e 2b):
      sessão forçada a `killed` com aprovação ainda `pending` não volta a
      `running` nem gera run nova; cancelar uma sessão em `waiting_approval`
      nega a aprovação pendente automaticamente, e resolvê-la depois é
      recusado de cara.
- [x] **Teto no `AsyncQueue`** — fechado em 2026-09-19. `AsyncQueue`
      (`packages/adapters/src/async-queue.ts`) ganhou `highWaterMark`/
      `lowWaterMark` configuráveis, `onPressureChange(aboveHigh)` disparado ao
      cruzar cada teto, e `whenBelow(threshold)` para quem não tem
      `.pause()`/`.resume()` de stream de SO e precisa se auto-segurar com
      `await`. Os dois produtores reais ganharam backpressure:
      - `ProcessAgentAdapter#spawnRun` (`process-adapter.ts`) pausa/retoma
        `child.stdout` no cruzar dos tetos, e chama `handle.touch()` não só
        nas bordas da pausa mas EM INTERVALOS durante ela
        (`backpressureKeepAlive`, a cada ~⅓ de `heartbeatSeconds`) — sem
        isto, drenar de HIGH até LOW num consumidor lento (o cenário exato em
        que a pausa existe) levaria mais tempo que o heartbeat e derrubaria a
        run como "travada" no meio de uma pausa saudável;
      - `OpenCodeAdapter#consume` (`opencode/adapter.ts`, único arquivo
        tocado desta parte que outro agente mexia em paralelo — mudança
        restrita ao loop de consumo SSE, não a `#bootServer`/env/sessão) usa
        `await waitBelowKeepingHeartbeat(...)` antes do próximo chunk, com o
        mesmo cuidado de `touch()` periódico durante a espera.
      - **Teto duro** (`QUEUE_HARD_CAP = 5000`, exportado de
        `process-adapter.ts`) como rede de segurança independente do
        `pause()`: checado a cada push individual (não por chunk), então a
        fila matematicamente nunca ultrapassa o teto — o pior caso é parar
        exatamente nele. Ao disparar, a run é encerrada com
        `reason: 'error'` e mensagem "fila de eventos saturada — consumidor
        não acompanhou o agente", nos dois adapters.
      **Achado real rodando contra o processo de verdade nesta máquina
      Windows** (não só teste com binário falso — o plano pediu
      explicitamente para não assumir que `pause()`/`resume()` funciona sem
      medir): um produtor que despeja tudo de uma vez, num `write()` só, é
      rápido demais para o `pause()` reagir a tempo — os `data` chunks já
      estavam enfileirados no event loop antes da pausa surtir efeito, e quem
      segura a fila nesse caso é o TETO DURO, não o `pause()` sozinho. Um
      produtor que escreve em lotes pequenos com `setTimeout` real entre eles
      (mais perto de como um CLI de agente fala de verdade) fica bem
      protegido pelo `pause()`/`resume()` sozinho, sem chegar perto do teto.
      Ou seja: os dois mecanismos são necessários, não redundantes — achado
      que só apareceu rodando contra I/O real, teoria sozinha não bastava.
      4 testes de carga contra o `ProcessAgentAdapter` real (spawn de `node`,
      sem mock) em
      `packages/adapters/src/process-adapter.backpressure.test.ts`:
      despejo único estourando o teto duro; escrita em lotes nunca chegando
      perto dele; consumidor que nunca lê a fila (teto duro é quem encerra a
      run); e consumidor com `heartbeatSeconds` bem menor que o tempo real de
      dreno, confirmando que a pausa por backpressure NÃO dispara falso
      "travada". Os quatro passam de verdade nesta máquina, não só em CI.
- [x] **Timeout geral do run não considerava throughput de escrita, matando
      agentes de saída muito volumosa (achado MÉDIO de auditoria de
      carga)** — fechado em 2026-09-22. Medido de verdade contra o daemon
      real: um agente falso emitindo 50.000 linhas sem delay era processado
      pelo consumidor síncrono (`SessionManager` escrevendo cada evento no
      SQLite) a ~41 eventos/s — bem abaixo da taxa de produção. O timeout
      geral (`ctx.timeoutSeconds * 1000`, em `process-adapter.ts`) era um
      único `setTimeout` armado no spawn e NUNCA reconsiderado, diferente do
      heartbeat, que já é rearmado por `handle.touch()` a cada sinal de
      atividade (linha processada, ou `backpressureKeepAlive` batendo
      enquanto `child.stdout` está pausado por backpressure). Resultado: um
      agente vivo, só mais devagar do que o daemon consegue persistir, era
      classificado como `timeout` → `transient` pela resiliência
      (`packages/core/src/resilience.ts`) e reprocessado do zero com o
      MESMO agente — fadado a repetir o mesmo timeout em toda tentativa
      (`policy.retries.max`, padrão 2 + a primeira = 3), porque o gargalo é
      a taxa de escrita do daemon, não a tentativa em si. Corrigido
      convertendo o timeout geral (`overall`, em `#spawnRun`) no mesmo
      padrão do heartbeat: `armOverall()` rearma o timer a cada chamada de
      `handle.touch()`, então atividade sustentada (mesmo que lenta, mesmo
      que só via `backpressureKeepAlive` durante uma pausa) estende o teto
      geral, não só o heartbeat. O teto geral NÃO foi eliminado: um agente
      sem NENHUMA atividade por `timeoutSeconds` ainda cai nele (normalmente
      antes, no heartbeat, que é mais curto). Dois testes de integração
      novos contra o `ProcessAgentAdapter` real (spawn de `node`, sem mock)
      em `packages/adapters/src/process-adapter.overall-timeout.test.ts`:
      um produtor vivo e devagar (`timeoutSeconds` bem menor que a duração
      real da run) termina em `exit`, não em `timeout`; um produtor
      genuinamente travado (zero atividade, `heartbeatSeconds` bem maior
      que `timeoutSeconds`, para provar que é o teto geral resolvendo, não
      o heartbeat) ainda termina em `timeout` no tempo configurado — ambos
      confirmados como falhando (o primeiro) antes da correção e passando
      depois, rodados de ponta a ponta contra processo real nesta máquina.

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

- [~] **`session-manager.ts` tinha 2978 linhas** (não 2258 — o número no roadmap
      estava desatualizado; cresceu ~32% desde que o item foi escrito, e uma
      auditoria de 2026-09-22 não achou registro de nenhuma análise anterior
      com "5 fatias mapeadas" apesar de uma nota antiga citar isso — tratada
      como premissa falsa). Acumula sessões, tarefas, orçamento, portão de
      política, vigilância, resiliência, revisão, diff, projetos, pastas e
      contexto. Não é bug; é onde os bugs se escondem — os três esquecimentos
      do invariante de estado terminal (`3f40028`) aconteceram exatamente por
      isso. Uma auditoria mapeou 8 fatias candidatas à extração, ordenadas por
      risco; as duas mais seguras (funções de módulo sem `this`, zero estado)
      foram extraídas em 2026-09-22, cada uma com teste próprio novo (nenhuma
      tinha teste isolado antes, só cobertura indireta via integração):
      - **Identidade/reconciliação de PID** (`imagemDoProcesso`,
        `imagemPareceEsperada`, `horarioDeCriacaoDoProcesso`,
        `pidPareceReciclado`, `TOLERANCIA_RELOGIO_MS`) → movidas para
        `packages/adapters/src/process-tree.ts`, ao lado de `killProcessTree`
        (mesma preocupação: identidade e ciclo de vida de processo no SO).
        11 testes novos em `process-tree.test.ts`, incluindo os casos que já
        causaram bug real antes (wrapper `cmd`/`sh`/`bash` aceito, `node`
        deliberadamente recusado, tolerância de relógio).
      - **Tradução de evento em ação vigiada** (`guardedActionsOf`,
        `describeAction`) → novo arquivo `packages/adapters/src/guarded-actions.ts`
        (não foi para `core`: depende de `MappedEvent`, tipo do adapter, e
        `core` não pode conhecer `adapters` — regra do CONTRIBUTING). 9 testes
        novos em `guarded-actions.test.ts`.
      - **Fechamento/abertura de tentativa e espera de backoff**
        (`closeLastAttempt`, `novaTentativa`, `sleep`) → foram para
        `packages/core/src/resilience.ts`, ao lado de `failureContext`/
        `nextStep` (mesma lógica de `TaskAttempt` que o retry/fallback já
        trata ali). 8 testes novos em `resilience.test.ts`.
      Build limpo e suíte inteira (410 testes, +27 desde antes desta rodada)
      verde em duas rodadas completas depois da extração. `session-manager.ts`
      caiu para 2781 linhas (~200 linhas movidas, mesmo comportamento — nenhum
      teste de integração pré-existente mudou de resultado).
      **Terceira fatia, mesma rodada**: CRUD de projetos e pastas
      (`registerProject`, `listProjects`, `#project`, `getProjectContext`,
      `setProjectContext`, `listProjectFolders`, `addProjectFolder`,
      `removeProjectFolder`) → nova classe `ProjectRegistry`
      (`packages/daemon/src/project-registry.ts`, não `core`: depende de
      `UnitOfWork`/I/O de arquivo). `SessionManager` guarda uma instância
      privada (`#projects`) e os métodos públicos viraram delegações finas —
      a API que `server.ts`/CLI/MCP chamam não mudou, então os 30 testes já
      existentes (`projects.test.ts`, `project-config.test.ts`,
      `project-context.test.ts`) passaram sem alteração, provando que a
      extração não mudou comportamento. `session-manager.ts` caiu para 2684
      linhas. `#contextoDoProjeto`/`#envDoProjeto`/`#projectPolicy`
      continuam no `SessionManager` (são chamados de 7+ lugares diferentes
      do arquivo, não isolados como o CRUD) — próxima fatia natural, junto
      com `policyFor`, que é recursivo sobre `session.parentId`.
      **Quarta fatia, mesma rodada**: diff/artefatos (`#capturarMudancas`) →
      nova função `capturarMudancas` em `packages/daemon/src/artifact-capture.ts`,
      recebendo `store`/`artifactRoot`/`emit` por parâmetro em vez de a lógica
      pertencer à classe — a leitura/escrita de diff já era externa
      (`diff-capture.ts`); só a cola (criar `Artifact`, persistir, emitir
      evento) estava presa em `session-manager.ts`. `#capturarMudancas` na
      classe agora é uma delegação de 4 linhas. `listArtifacts` (um-liner
      sobre `store.artifacts.list`) foi deixado como está — baixo valor em
      extrair um repasse trivial. 3 testes novos em `artifact-capture.test.ts`
      (repositório git real por teste, sem mock), cobrindo árvore sem
      mudança, arquivo alterado, e sessão sem baseline salvo — nenhum teste
      isolado existia antes, só integração. `session-manager.ts` caiu para
      2650 linhas. Build limpo, suíte (413 testes, +3) verde em duas rodadas.
      **Quinta fatia, mesma rodada**: resolução de política efetiva
      (`policyFor`, `#projectPolicy`) → novo `packages/daemon/src/effective-policy.ts`
      (`policyFor`/`projectPolicyFor`, dependências injetadas via
      `EffectivePolicyDeps`). `SessionManager.policyFor` (método público,
      usado em 5 lugares do arquivo) e `#projectPolicy` viraram delegações de
      1 linha. `#contextoDoProjeto`/`#envDoProjeto` continuam na classe —
      são só dois `if (!project) return {}` de uma linha cada, baixo valor em
      extrair. 7 testes novos em `effective-policy.test.ts` (fake mínimo de
      `store`, sem banco): interseção pai→filho nunca supera o teto do pai,
      projeto sem override cai no global, pai referenciado mas ausente não
      lança, ciclo de sessões não trava em loop infinito. **O primeiro
      rascunho do teste de herança pai→filho continha um bug de teste** (dois
      projetos de fixture com o mesmo id hardcoded, colidindo no fake
      `store`) que fez a asserção falhar com o valor errado — corrigido
      gerando id único por chamada da fixture antes de aceitar o teste como
      válido; fica registrado porque é exatamente o tipo de falso-negativo
      que torna um teste inútil se não for percebido. `session-manager.ts`
      caiu para 2632 linhas. Suíte (420 testes, +7) verde em duas rodadas.
      **Sexta fatia, mesma rodada**: vigilância reativa (`#watch`) — a
      DECISÃO (classificar risco de cada `GuardedAction` contra
      `pauseOn`/`flagOn`) foi para `avaliarVigilancia`, nova função em
      `packages/adapters/src/guarded-actions.ts` (ao lado de
      `guardedActionsOf`/`describeAction`, que ela já usa internamente).
      Os EFEITOS (`#emit` do alerta, `#requestApproval` da pausa) continuam
      em `session-manager.ts#watch`, porque dependem de `store`/`bus` — não
      dava para levar isso para `adapters` sem violar a regra de camadas.
      Preservado byte a byte o comportamento original, inclusive o
      short-circuit (a primeira ação que bate `pauseOn` interrompe a
      avaliação — ações seguintes nem são classificadas) e a ORDEM dos
      efeitos colaterais (alertas de ações anteriores são emitidos antes da
      aprovação da ação que pausou, nunca depois). Esta é a fatia de maior
      sensibilidade de segurança da rodada — é o mecanismo que decide se uma
      ação `irreversible`/`escalate` pausa a sessão de verdade, e a mesma
      auditoria que achou o bug crítico de `mergePolicyLayer` nesta esteira
      motivou o cuidado extra de teste direto. 6 testes novos em
      `guarded-actions.test.ts`: ação não vigiada é `ok`; escrita em `.env`
      pausa (`irreversible`, `pauseOn` padrão); ação comum dentro do workdir
      não pausa nem alerta; `watch` customizado com `flagOn` alerta sem
      pausar; short-circuit confirmado (duas escritas, a política pausa em
      `write`, e a segunda nunca é avaliada); e a ordem exata dos efeitos
      (uma ação `flagged` antes de uma `paused` aparece em `flagged`, não é
      descartada pelo short-circuit). `session-manager.ts` caiu para 2630
      linhas — pouco, de propósito: só a decisão saiu, os efeitos (que são a
      maior parte do método) ficaram, porque tocam `store`/`bus` direto.
      Suíte (426 testes, +6) verde em duas rodadas.
      As 2 fatias restantes (revisão cruzada, e o núcleo de sessão/execução
      que não é extraível) continuam mapeadas, não atacadas — revisão
      cruzada é a mais arriscada (orquestra um agente real, cobra
      orçamento, aplica o gate do Codex — ver ressalva da auditoria
      original sobre resolver `#summarize` primeiro, usado por ela e por
      `#settle`, antes de extrair)
- [x] **Teste flaky pego pelo CI no meio desta esteira, corrigido**: o push
      da sexta fatia (vigilância) reprovou o portão de qualidade —
      inicialmente pareceu ser o mesmo flaky de `runValidation`/kill de
      árvore já documentado (apareceu junto, numa rodada), mas um SEGUNDO
      teste também caiu, de forma nova: "N chamadas concorrentes de
      delegação contra orçamento insuficiente" (`session-manager-audit.test.ts`,
      achado da fase 5) — `usadoTotal !== 10` (às vezes 9, numa repetição
      local caiu até 8). Investigado a fundo antes de aceitar como flaky
      (achado que parecia crítico — furo na reserva síncrona de orçamento —
      não podia ser descartado sem prova): reproduzido localmente 3 de 5
      vezes antes da correção, então NÃO era exclusivo do runner de CI.
      Causa raiz real, confirmada por leitura de código: `SCRIPT_AGENTE`
      (o agente-de-mentira do teste) sai quase instantaneamente com "AGENTE
      OK" e zero eventos de custo; `#launch` só espera o processo SUBIR, não
      terminar, e o `#pump` que drena o resto roda solto (fire-and-forget) —
      ele pode `settle()` (devolvendo a reserva não usada, já que o custo
      real virou US$0) para qualquer subconjunto das 10 tarefas aceitas, em
      qualquer momento entre o spawn e o instante em que o teste lê o
      snapshot final do ledger. A invariante de segurança real (a reserva
      síncrona nunca deixa passar mais que o orçamento) permanecia intacta
      em toda repetição — confirmado por `aceitas.length === 10` estável em
      15 rodadas locais seguidas depois da correção — só a leitura POSTERIOR
      do total (que depende de quando cada processo termina) variava.
      Corrigido removendo a asserção de igualdade exata sobre
      `consumed+reserved` (uma tentativa intermediária de afrouxar para uma
      faixa estreita, 10 ou 9, ainda falhou numa 8ª repetição local — o
      valor real não tem piso previsível), mantendo as duas asserções que
      de fato provam o achado: `aceitas.length === 10` (exatamente) e
      `usadoTotal <= LIMITE_USD` (nunca excede). Nenhuma mudança em código
      de produção — só a asserção do teste. 15 rodadas locais seguidas
      depois da correção, todas verdes; suíte completa (426 testes) verde
      em duas rodadas
- [ ] **83 blocos `catch`** em `packages/*/src` — separar os que tratam dos que engolem
- [x] **Concorrência sob corrida**: reserva de orçamento (`BudgetLedger.reserve`/
      `settle`) não tinha teste de regressão — resolvido em 2026-09-22. Uma
      auditoria de carga anterior já tinha confirmado por HTTP real contra o
      daemon (20 `POST /sessions` verdadeiramente concorrentes via
      `Promise.all`, delegando de uma raiz com orçamento US$10, pedido total
      US$20) que não havia corrida: exatamente 10/20 aceitas,
      `consumed+reserved` nunca excedeu o teto — porque `session-manager.ts#start`
      faz a leitura do saldo (`snapshot()`) e a reserva (`reserve()`) como
      uma única operação síncrona, sem `await` entre elas (comentário
      explícito por volta da linha 482-486). Isso era uma invariante de
      código sem regressão automatizada: um `await` inserido no futuro entre
      a leitura e a reserva quebraria a proteção em silêncio. Fechado com um
      teste em `packages/daemon/src/session-manager-audit.test.ts`
      ("auditoria: concorrência do BudgetLedger") no mesmo estilo do achado 1
      de concorrência por agente acima — 20 chamadas de `start()` disparadas
      via `Promise.allSettled` sem esperar uma pela outra, contra uma raiz
      com orçamento insuficiente para todas, confirmando que exatamente as
      N que cabem são aceitas e o resto é recusado com `BUDGET_EXCEEDED`,
      com `consumed+reserved` nunca excedendo o limite. Diferença importante
      em relação à auditoria por HTTP: este teste roda num único processo
      Node, exercitando a reserva síncrona simulada via `Promise.allSettled`
      — não múltiplos processos/conexões batendo no daemon real como a
      auditoria HTTP fez. A outra metade deste item — o teto de sessões
      simultâneas por agente — já tinha sido corrigida e testada (fase 5,
      "TOCTOU no teto de concorrência por agente")
- [ ] **Crescimento de RSS sob churn de sessão — inconclusivo, precisa de
      investigação melhor instrumentada.** Uma auditoria de carga rodou 300
      ciclos de churn de sessão (criar → concluir) contra o daemon real e
      mediu RSS subindo de ~78MB para ~96MB (+~20MB). Isto NÃO é um achado
      confirmado de vazamento — 300 ciclos é pouco para separar
      aquecimento normal (cache de módulo, pools internos do V8, páginas de
      SQLite ainda residentes) de retenção real de memória por sessão
      encerrada. Para virar um achado de verdade precisaria de milhares de
      ciclos com heap snapshot antes/depois (`--expose-gc` + comparação de
      snapshot, ou `node --prof`) para atribuir o crescimento a SQLite, V8
      ou a algum objeto de domínio (`#ledgers`, `#seeded`, `#models` já
      foram fechados como vazamento conhecido nesta fase — ver "Concluído em
      2026-09-18" — então se ainda houver retenção, é em outro lugar).
      Deliberadamente não investigado mais a fundo nesta tarefa: sem essa
      instrumentação, qualquer correção seria adivinhação
- [x] **Cache de config de projeto invalidado só por `mtimeMs` colidia sob
      escrita rápida em sucessão (achado real, pego pelo próprio CI, não por
      auditoria)** — fechado em 2026-09-22. Depois de mesclar três lotes de
      correção em sequência nesta sessão, o portão de qualidade (Windows,
      Node 22.5) reprovou `project-context.test.ts` (`YAML quebrado não
      derruba nada`): o teste escreve YAML válido, depois quebrado, no MESMO
      arquivo, em sucessão rápida — e a segunda leitura voltou com
      `error: null` em vez da mensagem esperada. Causa raiz em
      `packages/daemon/src/project-config.ts`: `loadProjectOverrides` e
      `loadProjectContext` cacheavam por `mtimeMs` sozinho; a resolução do
      relógio do sistema de arquivos (mais grosseira em alguns runners de CI
      do que na máquina de desenvolvimento — reproduziu no Windows do CI, não
      localmente em duas rodadas completas da suíte) deu o MESMO `mtimeMs`
      para duas `writeFileSync` síncronas consecutivas, servindo a segunda
      leitura do cache da primeira. Isto não é só flakiness de teste: é o
      MESMO cache que guarda `policy` por projeto — duas edições rápidas de
      `.agents-hub/config.yaml` (ex.: `hub project env --set` chamado duas
      vezes em sequência por um script) podiam servir a política velha depois
      da segunda escrita. Corrigido acrescentando `size` (do mesmo `statSync`,
      sem custo extra) à checagem de invalidação nos dois caches — duas
      escritas com conteúdo de tamanho diferente (o caso comum) não colidem
      mais; três rodadas isoladas do arquivo de teste + duas rodadas completas
      da suíte (383/383) confirmaram a correção antes do push seguinte
- [x] `pause` tinha rota HTTP e client (`HubClient.pause`) mas nenhuma superfície a
      expunha. Agora tem `hub pause <sessionId>` na CLI (`packages/cli/src/pause-cmd.ts`),
      a tool MCP `hub_session_pause` (`packages/mcp/src/server.ts`) e um botão "Pausar"
      dedicado no painel (`SidePanel.tsx`, distinto do botão "Interromper" que já existia
      e que na verdade chamava `interrupt`, não `pause` — os dois nomes colidiam)
- [~] O painel (Web) ainda não expõe `workflow`, `prune`, `mcp` nem `hooks` — mas o
      motor de workflow declarativo passou a ter equivalente MCP (`hub_workflow_run`
      em `packages/mcp/src/server.ts`, mesmo `runWorkflow` de `packages/core/src/workflow.ts`
      que a CLI usa), então um agente externo já consegue disparar um workflow sem passar
      pela CLI. `prune`, `mcp` e `hooks` continuam só na CLI

## Decisões ainda em aberto

| Tema | Pergunta | Bloqueia |
|---|---|---|
| Acesso remoto | Expor o daemon na rede/túnel exige authn/authz — desejado? | Fase 3 |

Tudo que bloqueava a Fase 2 foi decidido no [ADR 06](decisoes/06-resiliencia-retencao.md):
falha final termina em `failed` sem travar o fluxo, fallback é `claude → codex → opencode`,
eventos ficam para sempre e worktrees por 7 dias, e o modelo é o default de cada CLI.

## Auditoria da Web UI — 2026-09-22

Seis achados de uma auditoria real do painel React (`packages/web/src`), todos corrigidos
no mesmo lote. O pacote web não tem suíte de teste de componente (`packages/web/package.json`
não tem script `test`, e não há `*.test.*`/`*.spec.*` em `src/`); onde não havia como escrever
um teste automatizado, a verificação foi por leitura de código + passos manuais descritos
abaixo, não por execução visual nesta sessão.

- [x] **CRÍTICO — painel de orçamento lia o ledger errado para sessões delegadas.**
      `App.tsx` chamava `hub.budget(selected.id)`, mas `GET /budget/:rootId`
      (`packages/daemon/src/session-manager.ts`, método `#ledger`) é chaveado pela
      sessão-RAIZ, não pela sessão selecionada — se a chave não existir, `#ledger` cria um
      ledger órfão novo com orçamento cheio e consumo zero. Qualquer sub-sessão delegada
      selecionada no painel mostrava esse ledger falso. Corrigido reusando o hook
      `useBudget(rootId, revision)` de `useHubState.ts`, que já buscava pela raiz e nunca
      tinha sido importado em lugar nenhum (confirmado por `Grep` antes da correção).
      Verificação: leitura de código confirmando que `#ledger` no daemon é chaveado por
      `rootId` e que `useBudget` já recebia esse parâmetro; sem harness de teste de
      componente no pacote web, os passos manuais equivalentes são: `hub start` numa
      sessão, delegar para outro agente, selecionar a sub-sessão delegada no painel e
      confirmar que o orçamento mostrado é o mesmo da sessão-raiz (não um valor
      zerado/cheio novo). Esses passos não foram executados nesta sessão — não há
      ambiente de browser interativo disponível aqui.
- [x] **MÉDIO — timeline "fluxo inteiro" embaralhava eventos entre agentes diferentes.**
      `App.tsx` intercalava eventos de sessões distintas ordenando por `seq`, que só é
      monotônico DENTRO de uma sessão. Corrigido trocando por `mergeFlowEvents` de
      `useHubState.ts` (ordena por timestamp entre sessões), que já existia com o
      comentário explicando exatamente esse problema e também nunca tinha sido importada
      (confirmado por `Grep`).
- [x] **MÉDIO — grafo DAG podia rotular o nó errado como "Root Coordinator".**
      `DagCanvasView.tsx` assumia que a raiz do fluxo está sempre na última posição de
      `flow.sessions` (ordenado por `updatedAt` decrescente) — falha quando a raiz
      continua ativa depois de uma sub-sessão já ter terminado. Corrigido com
      `flow.sessions.find((s) => s.id === flow.rootId) ?? ...`, mesmo padrão já usado em
      `useHubState.ts` (`flows`, linha ~210).
- [x] **BAIXO — falha silenciosa ao carregar projetos no modal de nova sessão.**
      `SessionModal.tsx` engolia o erro de `hub.projects()` com `.catch(() => {})`, e a UI
      mostrava "Nenhum projeto registrado" indistinguível de rede/daemon fora do ar.
      Corrigido com um estado `projectsFailed` e aviso explícito, mesmo padrão de
      `projectContextFailed` em `SidePanel.tsx`.
- [x] **BAIXO — chave de API em texto plano.** `SettingsView.tsx` tinha o campo
      `#api-key` como `type="text"`. Corrigido para `type="password"` com um botão de
      mostrar/ocultar local (`mostrarChaveApi`), mantendo o aviso já existente sobre o
      arquivo versionado.
- [x] **BAIXO — texto estático incorreto na visão Swarm.** `AgentSwarmView.tsx` tinha
      "8 de 9 agentes..." fixo no JSX. Corrigido para uma contagem real a partir de
      `agents.filter((a) => a.probe?.installed === true).length` sobre `agents.length`.

## Auditoria da Web UI (segunda rodada, mais profunda) — 2026-09-22

Seis achados adicionais, todos corrigidos no mesmo lote sobre o estado deixado pela auditoria
acima (`packages/web/src`). Mesma ressalva: sem harness de teste de componente no pacote web
(`packages/web/package.json` não tem script `test`), a verificação de UI é por leitura de
código + passos manuais descritos abaixo — não executados nesta sessão por falta de browser
interativo.

- [x] **ALTO — troca rápida de projeto em `SettingsView.tsx` podia salvar configuração de um
      projeto sob o ID de outro.** `carregar(projectId)` não tinha guarda de cancelamento: se
      o usuário selecionasse o Projeto A e trocasse para o Projeto B antes da resposta de A
      chegar, e a resposta de A chegasse DEPOIS da de B, `setCtx` aplicava os dados de A sob o
      `projectId` de B — um "Salvar" nesse estado gravava `OPENAI_API_KEY`/prompts de A no
      `.agents-hub/config.yaml` de B. Corrigido com uma flag `cancelado` no mesmo padrão já
      usado em `SidePanel.tsx` (`projectContext`). Verificação manual: abrir Configurações,
      selecionar Projeto A, trocar rapidamente para Projeto B antes da resposta chegar (rede
      throttled no DevTools ajuda a reproduzir), confirmar que o formulário mostrado corresponde
      sempre ao projeto selecionado no dropdown, nunca a um projeto anterior.
- [x] **MÉDIO/ALTO — falha de rede na timeline principal era indistinguível de "sessão sem
      eventos".** `useHubState.ts` (`eventsOf`) já marcava `eventsFailed[sessionId]` e expunha
      `eventsFailedFor`, mas nada em `App.tsx`/`Timeline.tsx` lia esse sinal — uma falha de
      `hub.events()` no momento de selecionar uma sessão mostrava a mesma mensagem de "nenhum
      evento" que uma sessão genuinamente vazia. Corrigido propagando `eventsFailedFor` (para
      `scope === 'session'`) ou `siblings.some(eventsFailedFor)` (para `scope === 'flow'`) de
      `App.tsx` até uma nova prop `failed` em `Timeline.tsx`, que agora mostra um aviso
      explícito no lugar da mensagem de "vazio". Verificação manual: com o daemon rodando,
      selecionar uma sessão, matar a conexão de rede momentaneamente (offline no DevTools) e
      selecionar outra sessão ainda não cacheada — deve aparecer "Falha ao carregar os eventos
      desta sessão", não "Nenhum evento".
- [x] **MÉDIO — lane de sub-nós em `DagCanvasView.tsx` ainda assumia raiz na última posição.**
      A correção da primeira auditoria já buscava a raiz certa (`root`) para o card principal,
      mas a lane de sub-nós, ~60 linhas abaixo, ainda fazia
      `flow.sessions.slice(0, flow.sessions.length - 1)` — removendo por posição em vez de por
      id. Com a raiz ativa (por isso no início do array) e duas sub-sessões terminadas em
      momentos diferentes, isso duplicava a raiz na lane (rotulada "Sub-agent/Task") e escondia
      a sub-sessão mais antiga. Corrigido para `flow.sessions.filter((s) => s.id !== root.id)`.
      Verificação manual: abrir a aba Grafo DAG num fluxo com uma raiz ainda ativa e 2+
      sub-sessões já terminadas em momentos diferentes; confirmar que a raiz aparece só no card
      principal e todas as sub-sessões aparecem na lane, nenhuma duplicada nem faltando.
- [x] **MÉDIO — `useFlowGraph` mascarava falha de rede como "grafo vazio".** O `.catch` fazia
      `setGraph([])`, indistinguível de um fluxo sem sessões; `FlowTree.tsx` mostrava sempre
      "Este fluxo não possui sessões registradas". Corrigido: `useFlowGraph` agora devolve
      `{ graph, failed }`, propagado por `FlowList.tsx` até uma nova prop `failed` em
      `FlowTree.tsx`, que mostra um aviso distinto quando a busca falhou. Verificação manual:
      na lista de fluxos da coluna esquerda, abrir um fluxo (dispara `/graph`) durante uma
      queda de rede simulada; confirmar o aviso de falha em vez de "não possui sessões".
- [x] **BAIXO — busca de eventos do "Fluxo inteiro" era ilimitada.** `App.tsx` disparava
      `state.eventsOf(s.id)` para toda sessão-irmã do fluxo sem teto — um fluxo com 30+
      sub-sessões dispara ~30 requisições simultâneas ao abrir "Fluxo inteiro". Corrigido
      reaproveitando `MAX_FLOW_HISTORIES` (agora exportado de `useHubState.ts`) para limitar a
      lista de irmãos às `N` sessões mais recentes por `updatedAt`, antes de chamar `eventsOf`.
      Verificação manual: abrir um fluxo com muitas sub-sessões, alternar para "Fluxo inteiro" e
      confirmar na aba Rede do DevTools que o número de requisições a `/events` fica limitado
      (não uma por sessão-irmã).
- [x] **BAIXO (informativo) — 3 exports mortos em `useHubState.ts` removidos.**
      `useSessionHistory`, `useFlowHistories` e `mergeEvents` nunca eram importados fora do
      próprio arquivo (confirmado por `Grep` em todo o repositório, não só em `src/`) — o mesmo
      padrão que causou o achado CRÍTICO da primeira auditoria (hook correto, nunca importado).
      Removidos; `MAX_FLOW_HISTORIES` foi preservado (agora exportado) porque passou a ser usado
      de fato pelo achado do teto de "Fluxo inteiro" acima.

## Auditoria da Web UI (terceira rodada) — 2026-09-23

Dois achados, escopo restrito a `packages/web/src/actions.ts` e
`packages/web/src/components/SettingsView.tsx`. Mesma ressalva das rodadas anteriores: o
pacote web não tem harness de teste de componente (`packages/web/package.json` só declara
`dev`/`build`/`preview`/`typecheck`, nenhum script `test`, e não há `*.test.*`/`*.spec.*` em
`src/`). A verificação desta rodada foi por leitura de código + `npm run build && npm test`
(build limpo, suíte inteira do monorepo verde) — não houve interação visual com a interface
nesta sessão, sem ambiente de browser disponível aqui.

- [x] **CRÍTICO (parte que cabia neste escopo) — mensagem de validação por campo descartada
      na Web UI.** `HubApiError` (`packages/client/src/index.ts`) já captura
      `error.details` da resposta do daemon — inclusive `details.issues`, a lista
      `{path, message}` por campo que `readBody`/`param` em
      `packages/daemon/src/server.ts` produzem em todo erro 422 de validação — mas
      `describeError()` em `actions.ts` só usava `err.message`/`err.code`, nunca
      `err.details`. O toast mostrava só "corpo da requisição inválido" ou o código, sem
      dizer qual campo. Corrigido com uma função nova, `formatIssues()`, que lê
      `details.issues` de forma defensiva (tipo é `unknown` no cliente) e devolve uma string
      `"campo: mensagem; campo: mensagem"`; `describeError()` agora anexa essa string ao
      `detail` já existente em vez de descartá-la. Não mudei a assinatura de retorno de
      `describeError()` (ainda `{ title, detail: string | null }`) — o único chamador é
      `useAction()` no mesmo arquivo, então o ajuste ficou inteiro dentro do escopo
      permitido, sem precisar tocar em `SidePanel`/`App.tsx`/etc. Verificação manual
      equivalente (não executada aqui): abrir o modal de nova sessão, submeter um brief sem
      `objective` (campo obrigatório) e confirmar que o toast de erro mostra algo como
      `objective: <mensagem de validação do Zod>`, não só "corpo da requisição inválido".
- [x] **MÉDIO (item B6 do plano de MVP) — aviso de sequestro de `*_BASE_URL` ausente na Web
      UI.** Pendência registrada nas auditorias de segurança de 2026-09-19 e 2026-09-22 (ver
      acima): `packages/core/src/agent-env.ts` documenta que uma variável `*_BASE_URL`
      (`OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, etc. — qualquer uma dos 14 prefixos em
      `PREFIXOS_PERMITIDOS`, mais o nome exato `MODEL_BASE_URL`) num
      `.agents-hub/config.yaml` de um repositório clonado redireciona o canal de API inteiro:
      o CLI do agente, já autenticado localmente, manda a credencial nativa para o endpoint
      que essa URL apontar. `SettingsView.tsx` já tinha um aviso (`help help-warn`) sobre o
      risco DIFERENTE de vazamento de chave versionada, ao lado do campo `#api-key`, mas
      nada alertava sobre sequestro de URL no editor de "Outras variáveis de ambiente" (onde
      o usuário digita uma chave livre, ex. `ANTHROPIC_BASE_URL`). Corrigido com uma função
      `chaveEhBaseUrl()` (checa se a chave digitada termina em `_BASE_URL`,
      case-insensitive) e um novo bloco `<div className="help help-warn">` abaixo do aviso
      já existente de prefixo não permitido, mesma classe CSS reaproveitada — sem inventar
      estilo novo. Verificação manual equivalente (não executada aqui): abrir Configurações
      → aba "Modelos locais", digitar `ANTHROPIC_BASE_URL` no campo "NOME_DA_VARIAVEL" de
      "Outras variáveis de ambiente" e confirmar que aparece o aviso "Redirecionar esta URL
      pode enviar a credencial nativa do CLI... para um endpoint que você não controla",
      sumindo quando o campo é limpo ou trocado por uma chave que não termina em
      `_BASE_URL` (ex. `ANTHROPIC_API_KEY`).

## Auditoria da CLI (`packages/cli/src/main.ts`) — 2026-09-23

Quatro achados, todos corrigidos no mesmo lote, escopo restrito a `main.ts` (leitura de
`hooks-install.ts` e `workflow-cmd.ts` para replicar padrão, sem editar nenhum dos dois).
Sem harness de teste de comando de CLI que importe `main.ts` (o arquivo dispara `main()`
por `await main()` de topo de módulo — é por isso que `pause-cmd.ts`/`workflow-cmd.ts`
vivem em arquivos próprios, testáveis sem esse efeito colateral; ver `pause-cmd.test.ts`).
Como o escopo desta tarefa não permitia extrair para um novo arquivo, a verificação foi
**manual, contra um daemon real** (`AGENTS_HUB_HOME` apontado para um diretório temporário,
`node packages/cli/dist/main.js <comando>`), não só leitura de código:

- [x] **CRÍTICO (parte que cabe na CLI) — mensagem de validação por campo descartada.**
      `withDaemon` (catch em torno da falha de qualquer comando) imprimia só `[código]
      mensagem` de um `HubApiError`, e `err.details?.issues` — o array `{path, message}`
      por campo que o daemon já manda (`parseBrief` em `packages/core/src/brief.ts`, e o
      client já preserva em `HubApiError.details`, `packages/client/src/index.ts`) — nunca
      era lido. Resultado real: `hub start --agent claude "x"` (objetivo curto demais)
      mostrava só `[INVALID_BRIEF] Brief inválido`, sem dizer qual campo nem por quê.
      Corrigido com `extractIssues(details)` (lê `details.issues` sem confiar no formato —
      é `unknown`) e uma linha extra por issue depois da linha principal. Verificado contra
      daemon real: `[INVALID_BRIEF] Brief inválido` agora vem seguido de
      `  - objective: o objetivo precisa ser descritivo`.
- [x] **MÉDIO — `--budget-usd` não validado localmente em `start`/`delegate`.** Os dois
      comandos faziam `Number(args.flags['budget-usd'])` sem checar `NaN`/negativo,
      delegando 100% da validação ao round-trip HTTP — que só ficou com detalhe claro
      depois do achado anterior corrigido; antes disso, dava "Brief inválido" genérico
      depois de subir o daemon e fazer a chamada. `workflow-cmd.ts` (`lerOrcamento`, não
      alterado por este lote, só lido como referência) já validava localmente. Replicado
      como `lerBudgetUsd` em `main.ts` (não importado de `workflow-cmd.ts` para não criar
      acoplamento entre os dois comandos por um helper de 6 linhas) — falha imediata, sem
      chamada de rede, quando o valor não é finito e positivo. Verificado contra daemon
      real: `hub start --agent claude --budget-usd abc "teste"` sai com `--budget-usd
      inválido: "abc"` e `exitCode 1` **sem** subir sessão nem tocar a rede.
- [x] **MÉDIO — `hub hooks install --write` sem try/catch, ao contrário de `hub mcp install
      --write`.** `case 'hooks'` chamava `hooksCommand` direto; `gravarConfig`/
      `installCodexGate`/`saveConfig`, chamados por dentro (I/O de arquivo real —
      `mkdirSync`/`copyFileSync`/`writeFileSync`), podem lançar por permissão negada, disco
      cheio ou caminho inválido, e o processo crashava com stack trace bruto em vez do erro
      formatado que `mcpCommand` já mostra para o mesmo tipo de falha. Corrigido com
      `hooksCommandSeguro`, mesmo padrão de try/catch de `mcpCommand`. **Não reproduzido
      contra uma falha de I/O real nesta sessão** (forçar permissão negada em disco exigiria
      tocar o ambiente do jeito que o sandbox desta tarefa recusou) — a garantia aqui é por
      leitura de código (o `try` cobre exatamente a chamada que faz todo o I/O) e pelo
      espelho comprovado (`mcpCommand`) fazer a mesma coisa para o mesmo tipo de exceção.
- [x] **ALTO — pastas extra de projeto e artefatos não-diff inacessíveis por qualquer
      superfície.** O client já tinha `folders`/`removeFolder`/`artifacts`
      (`packages/client/src/index.ts`) e o daemon já tinha as rotas, mas nenhuma CLI, MCP
      ou Web os expunha (escopo desta correção: só CLI). Quem vinculava uma pasta extra a
      um projeto pela Web (`ProjectModal`) não tinha como listá-la ou desvincular depois; e
      artefato com `kind !== 'diff'` (`file`/`report`/`log`/`transcript`) era inacessível
      por completo, já que só `hub diff` existia. Adicionados `hub project folders
      [projeto]` (lista, `isPrimary` marcado com `●`), `hub project folders remove
      [projeto] <folderId>` (mesmo estilo posicional-opcional de `hub project env`/`hub
      project prompt`) e `hub artifacts <sessionId>` (lista id/kind/path/createdAt).
      Verificado contra daemon real: projeto registrado aparece com sua pasta principal
      (`isPrimary`); tentar remover a pasta principal devolve
      `[FOLDER_IS_PRIMARY] a pasta principal não pode ser removida...` (formatado pelo
      `withDaemon`, sem crash); folderId inexistente devolve `[FOLDER_NOT_FOUND] pasta ...
      não pertence a este projeto`; `hub artifacts` numa sessão sem artefatos devolve
      "nenhum artefato registrado", sem erro.

## Auditoria do MCP server — 2026-09-23

Três achados sobre `packages/mcp/src/server.ts`, todos corrigidos no mesmo lote e cobertos por
teste novo em `packages/mcp/src/server.test.ts` (suíte inteira: 432/432).

- [x] **CRÍTICO — `HubApiError.details.issues` (mensagem de validação por campo) era descartado
      pelo MCP.** `describe()` só devolvia `code: message` (ex.: "INVALID_BRIEF: Brief inválido"),
      mesmo quando o daemon mandava `details.issues` com o campo e a mensagem exatos (o client já
      captura isso em `HubApiError.details` — ver `packages/client/src/index.ts:370-382`). O agente
      chamador via só o código genérico e nunca descobria qual campo do brief falhou.
      `explainDelegationFailure` (usado por `hub_agent_call`) tinha o mesmo problema no seu `default`:
      devolvia `err.message` puro, sem nem o código. Corrigido com `formatIssues()`, que formata
      `issues: [{ path, message }]` como lista "campo: problema" e é chamado tanto por `describe()`
      quanto pelo `default` de `explainDelegationFailure`. Teste
      (`hub_agent_call com brief inválido devolve o campo e a mensagem, não só o código genérico`)
      chama `hub_agent_call` com `agent: ""` (passa pelo schema solto da tool MCP, rejeitado pelo
      `BriefSchema.agent.min(1)` do daemon) e confirma que o texto devolvido tem `INVALID_BRIEF`,
      "campos inválidos" e o nome do campo `agent`.
- [x] **ALTO — não havia tool MCP equivalente a `POST /sessions/:id/interrupt`.** A rota existe no
      daemon e o client já tinha `HubClient.interrupt` (`packages/client/src/index.ts:131-133`,
      exposto na CLI como `hub interrupt`), mas um agente orquestrando via MCP só tinha
      `hub_agent_cancel` — que mata a sessão inteira e tudo que ela delegou. Não havia como parar só
      o turno atual sem perder o estado da sessão. Adicionada `hub_session_interrupt`, seguindo a
      mesma convenção de `hub_session_pause`/`hub_session_send` (nome, `annotations`, tratamento de
      erro via `describe()`); a descrição da tool deixa explícito que ela difere de
      `hub_agent_cancel` por não encerrar a sessão. Dois testes novos: um confirma que a sessão
      continua `running` depois da interrupção (`interrupted: false` no fake de teste, sem turno
      nativo em andamento) e outro confirma erro descritivo (`SESSION_NOT_FOUND`) para sessão
      inexistente.
- [x] **ALTO — não havia tool MCP equivalente a `GET /sessions/:id/diff`.** A rota e o client
      (`HubClient.diff`) já existiam (CLI expõe via `hub diff`, `packages/cli/src/main.ts` função
      `showDiff`), mas um agente que delegou trabalho só tinha `hub_agent_events` (log verboso) para
      validar o que foi de fato alterado antes de reportar ao usuário. Adicionada `hub_session_diff`,
      que devolve o patch unificado ou a mensagem que o próprio daemon já manda quando não há diff
      (`"esta sessão não alterou nenhum arquivo"` — a rota não distingue "sessão sem mudanças" de
      "sessão inexistente"; documentado assim no teste em vez de fingir um erro que a rota não
      produz). Acrescentada truncagem por linha (`DIFF_MAX_CHARS = 12_000`) porque a CLI imprime o
      patch inteiro para um humano no terminal, mas aqui quem lê é outro agente — um diff gigante
      (ex.: lockfile regenerado) queimaria orçamento de tokens sem ajudar em nada. Três testes novos:
      "sem mudanças", "devolve o patch quando há diff capturado" (semeia um artefato `kind: 'diff'`
      de verdade e confirma o conteúdo do patch no texto devolvido) e o caso de sessão inexistente.

