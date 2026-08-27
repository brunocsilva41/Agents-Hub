# 04 — Resiliência, Política e Configuração por Projeto

Cobre o que acontece **depois** que um agente é acionado: o que o Hub tolera, o que ele barra e o que ele faz quando dá errado.

## 1. O que o Hub pode e não pode barrar

Esta é a distinção mais importante do documento, porque é onde é fácil se enganar.

O Hub roda os agentes como **processos opacos**. Ele não intercepta syscall: vê o evento *depois* que o comando executou. Então existem dois níveis de controle, com garantias muito diferentes:

| Nível | O que é | Garantia |
|---|---|---|
| **Portão** (preventivo) | Ações que passam por dentro do Hub: delegação agente→agente, reserva de orçamento | Real. A ação **não acontece** sem liberação |
| **Vigilância** (reativa) | Comando executado, arquivo alterado | O comando **já rodou**. O que o Hub impede é o *próximo*, parando a sessão |

Chamar a vigilância de "aprovação prévia" seria mentira, e mentira em recurso de segurança é pior que ausência dele. O gate verdadeiramente preventivo para shell e arquivo depende de integração por agente — o hook `PreToolUse` do Claude Code, os modos de aprovação do Codex — e está na fila da fase 2.

Enquanto isso, o controle real e verificável é: **worktree isolado**, **orçamento do fluxo**, **portão de delegação** e **botão de encerrar**.

### Níveis de risco

| Nível | Exemplos | Padrão |
|---|---|---|
| `read` | ler arquivo, listar dir, `git status`/`log`/`diff` | permitir |
| `write` | escrever dentro do worktree da sessão | permitir |
| `exec` | comando na allow list (build, testes, lint), delegação | permitir |
| `escalate` | escrever fora do worktree, comando fora da allow list, rede não liberada | alertar |
| `budget` | estourar o orçamento do fluxo | aprovação |
| `irreversible` | `git push`, `rm -rf`, publish, deletes, caminho sensível (`.ssh`, `.env`) | **parar a sessão** |

O modo de supervisão da sessão é um *overlay* que só endurece: em `supervised`, `escalate` também para a sessão e **toda** delegação passa por você.

### Por que o padrão não para em `escalate`

Um agente executa dezenas de comandos legítimos que nenhuma allow list razoável prevê. Se cada um deles congelasse a sessão, o recurso seria desligado na primeira hora — e um controle de segurança desligado protege zero. O padrão pausa só no irreversível; o resto vira alerta visível na timeline. Quem quer o rigor máximo usa `supervised`.

## 2. Fila de aprovações

Quando um portão retém ou a vigilância para uma sessão, nasce uma `Approval`:

- a sessão vai para `waiting_approval`, a task para `input_required`;
- a fila aparece **no topo do painel**, sem como ignorar — sessão parada é trabalho congelado e orçamento reservado sem uso;
- `hub approvals`, `hub approve <id>`, `hub deny <id>` fazem o mesmo pela CLI;
- **liberar** retoma de onde parou: delegação retida vira execução, sessão vigiada recebe uma mensagem dizendo o que exatamente foi liberado — o agente precisa saber que houve decisão humana, senão repete a ação achando que falhou;
- **negar** encerra a sessão e tudo que ela havia delegado.

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

O cache é invalidado por `mtime`: reler a cada evento seria caro, e cachear para sempre obrigaria a reiniciar o daemon depois de editar o arquivo.

## 5. Como isto é testado

Testar retry e fallback contra agentes de verdade seria caro, lento e dependente de rede — três motivos para o teste nunca rodar. O teste de integração usa **agentes falsos**: scripts Node que falham sob comando, declarados por manifesto como qualquer outro agente. O pipeline não sabe a diferença, e o custo é zero.

```bash
node --test packages/core/dist/*.test.js packages/daemon/dist/*.test.js
```
