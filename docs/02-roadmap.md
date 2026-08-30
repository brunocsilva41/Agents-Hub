# 02 — Roadmap de Implementação

Ordem derivada do ADR 04.4: **vertical fina primeiro**. Cada fase termina com algo que roda de verdade.

> **Leia junto:** [07 — Progresso real](07-progresso-real.md) confere cada caixa deste
> arquivo contra o código, o binário e o banco. Onde os dois discordarem, o 07 é a
> fonte — ele foi verificado, este aqui foi declarado. As caixas da Fase 3 abaixo já
> foram corrigidas a partir dele.

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
- [~] **Gate pré-execução para o Codex** — contrato VERIFICADO contra o binário
      real (0.149.1), sondando com um hook próprio em diretório isolado. O
      Codex tem sistema de hooks completo e vocabulário compatível com o do
      Claude (`PreToolUse`, `hook_event_name`, `hookSpecificOutput`,
      `tool_name: "Bash"`), então `actionsOfToolCall` serve sem mudança. Mas o
      **dialeto de resposta é oposto**:
      - permitir é **não escrever nada** — `permissionDecision: "allow"` faz o
        Codex marcar `hook: PreToolUse Failed`, o que quebraria justamente o
        caminho feliz;
      - **não existe `ask`**: a decisão `approve` do Hub precisa virar `deny`
        com motivo que mande o agente falar com o humano;
      - `deny` exige motivo não vazio.
      Também exige confiança persistida no hook (ou
      `--dangerously-bypass-hook-trust`), e **não recebe variável de ambiente
      do Hub** — a correlação de sessão terá de sair do `cwd` do payload, que
      no Hub é o worktree da sessão.
      Implementado: `toCodexHookOutput` + 3 testes. **Falta**: emitir a config
      de hook na invocação e correlacionar sessão por `cwd`.
- [ ] Gate pré-execução para os demais agentes
- [ ] TUI (a Web UI cobriu a necessidade; virou conveniência, não bloqueio)

## Fase 3 — Plataforma

- [~] **"A2A server" — o nome está errado**: existe e funciona, mas é uma API REST
      desenhada em torno dos tipos do Hub, servida em caminhos com nome A2A. Não há
      superfície JSON-RPC 2.0, nem `message/send`, `tasks/get` ou `tasks/resubscribe`,
      que o [ADR 02.1](decisoes/02-orquestracao.md) cita nominalmente. O Agent Card
      traz `capabilities` como array de strings e o SSE carrega `EventEnvelope` do Hub,
      não eventos de task do protocolo. **Um peer que fale A2A de verdade não conversa
      com isto.** Decidir: implementar JSON-RPC ou renomear para o que é
- [~] **Motor de workflows declarativos em YAML** — a validação é real, a execução não:
      `packages/core/src/workflow.ts` faz Kahn corretamente e produz os lotes
      topológicos certos. Mas `packages/cli/src/workflow-cmd.ts` dá `await` em
      `startSession`, que é **assíncrono por contrato** (o `#launch` termina em
      `void this.#pump(...)`): o `await` espera a sessão *nascer*, não o passo
      *terminar*. Todos os passos disparam praticamente juntos e o `dependsOn` é
      decorativo. Derivados: **não há fan-in** (`stepSessions` é preenchido e nunca
      lido) e **`--budget-usd` está no `--help` e nunca é lido**
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

- [ ] **`hub doctor --smoke`**: abre uma sessão trivial com cada agente instalado e
      registra o resultado. **6 dos 9 agentes nunca executaram nada pelo Hub**, e a
      pergunta "qualquer um pode ser o principal?" só tem hoje resposta por ausência
- [ ] **`modeArgs` para os 7 agentes que não têm**: existe só em `claude.yaml` e
      `codex.yaml`. Nos outros, `supervised` não restringe nada no próprio agente — e
      copilot, kimi, mimo e antigravity declaram `supervised` como padrão. Onde o CLI
      não oferecer equivalente, a UI precisa dizer isso, não silenciar
- [ ] **`session.idFrom` é declarado no schema e lido por ninguém**: Cursor e MiMo
      prometem `session.strategy: native` que o mapper genérico nunca cumpre — todo
      turno seguinte cai em replay. Ou o adapter passa a ler `idFrom`, ou a promessa
      sai do manifesto
- [ ] **`openclaude` como cidadão pleno**: fora de `MCP_TARGETS` (logo, não pode ser
      orquestrador externo), fora de `HOOK_TARGETS` e fora das cadeias de fallback
- [ ] **Provar profundidade 2** (A→B→C): `maxDepth` é 3 e a profundidade máxima já
      atingida na vida do repositório é **1**. Detecção de ciclo e herança de política
      em segundo nível nunca foram exercidas num fluxo real
- [ ] **Matriz de pares A→B** para os pares que importam: todo destino já delegado foi
      o Codex, e 3 dos 4 chamadores eram sessões adotadas do harness de fumaça
- [ ] **Verificar os caminhos de config de MCP**: 5 dos 8 são palpite (`hub mcp` já os
      marca como não confirmados). É o mesmo trabalho que a verificação de manifestos
      fez em `470a605` e que revelou 3 erros em 3
- [ ] **Dono para a tabela de preços** (`core/pricing.ts`): dependência externa que
      muda sozinha e sustenta todo o orçamento em dólares dos agentes que só reportam
      tokens. Hoje ninguém a mantém

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

