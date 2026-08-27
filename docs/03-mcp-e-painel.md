# 03 — MCP Server e Painel Web

Documenta a Fase 2 do [roadmap](02-roadmap.md): as duas superfícies que tiram o Hub do terminal.

## 1. MCP server — como qualquer agente vira orquestrador

O Hub se expõe primeiro por **MCP** porque é o único protocolo que os oito agentes do MVP já falam. Registrado uma vez em cada CLI, o Cursor passa a poder chamar o Claude, que chama o Codex, sem que nenhum deles saiba da existência dos outros.

### As 11 tools

| Tool | O que faz |
|---|---|
| `hub_agent_list` | agentes disponíveis, capabilities, o que está instalado |
| `hub_agent_call` | delega e retorna `task_id` na hora — o trabalho roda em background |
| `hub_agent_status` | estado, resultado, custo e orçamento restante |
| `hub_agent_wait` | bloqueia até terminar (com timeout); açúcar sobre o assíncrono |
| `hub_agent_events` | o que o agente delegado está fazendo agora, paginado por `seq` |
| `hub_agent_cancel` | encerra a delegação e tudo abaixo dela |
| `hub_session_send` | corrige o rumo de uma sessão sem perder o trabalho feito |
| `hub_session_list` | reencontra uma delegação cujo id se perdeu |
| `hub_graph` | árvore de quem chamou quem, com custo por nó |
| `hub_context_fetch` | resolve `session:<id>#event:<seq>` do brief |
| `hub_budget` | quanto o fluxo já consumiu e quanto resta |

### Descoberta de identidade: quem está me chamando?

O problema mais sutil da integração. Dois casos, e os dois precisam funcionar:

**Agente rodando dentro do Hub.** O adapter injeta `AGENTS_HUB_SESSION_ID` no processo do agente. O MCP server é filho desse processo, então herda a variável e a identidade vem de graça — o grafo se liga sozinho.

**Agente rodando fora do Hub.** Você abre o Cursor na mão e ele chama `hub_agent_call`. Não existe sessão. O MCP server então **adota** uma sessão-raiz na primeira chamada que precise de identidade:

```
você → Cursor (fora do Hub)
        └─ hub_agent_call → MCP server não tem AGENTS_HUB_SESSION_ID
              └─ POST /sessions/adopt { agentId: "cursor" }
                    → cria sessão-raiz de controle: sem processo, sem
                      isolamento, existe para ser pai
              └─ POST /sessions/:id/delegate → filho nasce com pai, política
                 herdada e orçamento debitado da raiz
```

Sem a adoção, o filho nasceria órfão: sem pai de quem herdar política, sem raiz onde debitar orçamento e sem nó no grafo. A sessão adotada vive na memória do processo do MCP server porque **um processo de MCP server corresponde a uma sessão do agente** — o ciclo de vida já é exatamente o que queremos. Ao fechar, `detach` encerra a raiz sem matar o que ela delegou.

### Registrar em cada agente

```bash
hub mcp                            # o que está registrado onde
hub mcp show codex                 # imprime o trecho para colar
hub mcp install codex --write      # grava, com backup .bak e merge
```

O padrão é **imprimir, não gravar**: são arquivos de configuração de outra ferramenta. Com `--write`, o Hub faz backup e faz merge da própria seção, preservando o que você já tinha ajustado (modelo, sandbox, aprovações).

Caminhos confirmados: Claude Code (`.mcp.json` do projeto), Codex (`~/.codex/config.toml`), Cursor (`~/.cursor/mcp.json`). Os demais são palpite razoável e vêm marcados como não confirmados na saída do comando.

### Mensagens de erro são parte do design

Um agente que não entende por que a delegação falhou tenta de novo em loop — e queima orçamento. Por isso cada erro diz o que fazer:

| Erro | O que o agente lê |
|---|---|
| `DEPTH_EXCEEDED` | "a cadeia já está no limite. Resolva esta parte você mesmo em vez de repassar adiante" |
| `CYCLE_DETECTED` | "este agente já recebeu exatamente este objetivo nesta cadeia. Reformule ou escolha outro" |
| `BUDGET_EXCEEDED` | "peça um teto menor com budget_usd, ou avise seu usuário" |
| `CONCURRENCY_EXCEEDED` | "espere uma das delegações terminar antes de abrir outra" |

## 2. Painel web

Servido pelo próprio daemon em `http://127.0.0.1:4747` (ADR 05.3): um processo para subir, e a UI consome exatamente a mesma API da CLI — nenhuma lógica mora no cliente, então as duas têm a mesma capacidade por construção.

**O grafo é a navegação, não decoração.** Clicar num nó abre a timeline daquele agente. É assim que se desce de "o fluxo inteiro" para "o que exatamente o Codex fez aqui" sem decorar id nenhum.

Quatro coisas na tela, que são exatamente as quatro decididas no ADR 03.3:

1. **Grafo ao vivo** (esquerda) — árvore de quem chamou quem, com estado e custo por nó
2. **Timeline unificada** (centro) — os oito agentes no mesmo formato, alternando entre "só esta sessão" e "fluxo inteiro"
3. **Painel de custo** (direita) — consumo contra o orçamento do fluxo, com pressão visual
4. **Controles ao vivo** — interromper turno, pausar, encerrar, delegar a partir daqui, e um campo para falar com a sessão

### Detalhes que definem o comportamento

- **Um único `EventSource` sem filtro** alimenta tudo. A timeline cresce de forma incremental (barato) e só eventos *estruturais* (`session.*`, `delegation.*`, `turn.completed`, `error`) disparam recarga de grafo e orçamento (caro), com debounce de 400 ms. Recarregar tudo a cada token derrubaria a UI numa sessão falante.
- **Auto-scroll só enquanto você está no fim.** Rolou para cima para ler algo, os eventos novos param de arrancar a página de baixo de você.
- **Deduplicação por `seq`**, porque o `EventSource` reenvia eventos ao reconectar.
- **Cor estável por agente**, derivada de hash do id: a mesma cor sempre, em qualquer sessão ou reload.

### A armadilha do SSE que custou caro

O servidor enviava `event: <tipo>` em cada frame. Parece elegante — e faz o `onmessage` do navegador **ignorar silenciosamente** tudo que não se chame literalmente `message`. O painel recebia as falas do agente e perdia `turn.completed`, `delegation.*` e `error`: a timeline parecia funcionar, mas o estado nunca atualizava e nada indicava erro.

O campo `event:` foi removido. O tipo já viaja dentro do JSON, que é onde todo consumidor o lê. O `id:` ficou apenas no stream de **uma** sessão, porque `seq` é monotônico por sessão — num stream multi-sessão ele seria ambíguo e estragaria o `Last-Event-ID` na reconexão.
