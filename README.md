# Agents-Hub

> Plano de controle onde **qualquer** agente de IA pode orquestrar e ser orquestrado.

Claude Code, Codex, OpenCode, Copilot, Kimi Code, MiMo, OpenClaude, Cursor e Antigravity — todos reduzidos ao mesmo modelo de sessão, evento, política e orçamento. Nenhum papel é fixo: "principal" é apenas quem detém a sessão-raiz, e você escolhe isso a cada sessão.

## Por que existe

Cada agente é ótimo em algo e cego para o resto. Hoje, fazer um chamar o outro significa copiar contexto na mão, perder o rastro de quem fez o quê e não ter ideia de quanto custou. O Hub resolve as quatro coisas que faltam quando agentes trabalham juntos:

| Problema | O que o Hub faz |
|---|---|
| Cada CLI fala um dialeto | Um adapter por agente normaliza tudo para um `EventEnvelope` único |
| Agentes pisam uns nos outros | Um git worktree isolado por sessão |
| Delegação vira loop caro | Profundidade máxima + detecção de ciclo semântico + orçamento herdado da raiz |
| Ninguém sabe o que aconteceu | Todo evento persistido com o payload original, grafo ao vivo e custo por nó |

## Estado atual

**Fases 1 e 2 rodando e validadas com agentes reais.** Um agente inicia sessão, produz eventos normalizados, roda isolado num worktree, respeita orçamento, passa por portão de validação — e delega para outro agente, pela CLI, pelo painel ou por MCP. Quando falha, o Hub tenta de novo e depois troca de agente.

```
cursor [running]  US$ 0.0000 · 0 tok      ← agente externo, adotado como raiz
  └ codex [completed] US$ 0.0000 · 17.2k tok
    Responda apenas com a palavra MCP_OK.
```

## Começando

```bash
npm install && npm run build && npm link --workspace @agents-hub/cli
```

Pronto — `hub` está no PATH. **Não existe passo "suba o daemon"**: ele nasce sozinho quando algum comando precisa e sobrevive ao terminal que você fechar.

```bash
hub status     # agentes disponíveis, sessões vivas, o que espera sua decisão
hub doctor     # o que está instalado, com versão e caminho
```

O painel fica em **http://127.0.0.1:4747**.

Abra uma sessão — o `--agent` é obrigatório porque **você escolhe o principal a cada vez**:

```bash
hub start --agent claude --budget-usd 2 "refatore o módulo de pagamentos"
```

Faça um agente chamar outro:

```bash
hub delegate <sessionId> --agent codex --budget-usd 0.5 "escreva os testes do que foi refatorado"
```

Veja quem chamou quem e quanto custou:

```bash
hub graph <rootId>
```

Quando quiser encerrar tudo:

```bash
hub stop
```

`hub help` lista o resto.

## Dar aos seus agentes o poder de chamar os outros

O Hub se expõe como **MCP server** — o único protocolo que os oito CLIs já falam. Registrado uma vez, o Cursor pode chamar o Claude, que chama o Codex.

```bash
hub mcp                        # o que está registrado onde
hub mcp install codex --write  # grava, com backup e merge
```

O agente ganha 11 ferramentas: `hub_agent_call` (delega e volta na hora com um `task_id`), `hub_agent_status`, `hub_agent_wait`, `hub_agent_events`, `hub_agent_cancel`, `hub_session_send`, `hub_graph`, `hub_budget` e mais.

Funciona mesmo com o agente rodando **fora** do Hub: nesse caso o MCP server adota uma sessão-raiz na primeira chamada, para o filho ter pai de quem herdar política e raiz onde debitar orçamento. Detalhes em [docs/03-mcp-e-painel.md](docs/03-mcp-e-painel.md).

## Painel

Servido pelo próprio daemon, na mesma API que a CLI consome — nenhuma lógica mora no cliente, então os dois têm a mesma capacidade por construção.

O grafo de chamadas é a **navegação**: clicar num nó abre a timeline daquele agente. Ao lado, o consumo contra o orçamento do fluxo e os controles ao vivo — interromper turno, pausar, encerrar, delegar a partir dali, ou simplesmente falar com a sessão.

```bash
npm run web:dev   # opcional: Vite com hot reload em :4748, proxy para o daemon
```

## Arquitetura em uma tela

```
CLIENTES     CLI · Web UI  ──────── HTTP + SSE (API única) ───────┐
TRANSPORTS   MCP server · A2A server (fase 3) · REST/SSE          │
CORE         Orchestrator · SessionManager · CallGraph            │
             PolicyEngine · BudgetLedger · CapabilityRegistry     │
ADAPTERS     claude · codex · opencode · copilot · kimi · mimo    │
             openclaude · cursor · antigravity (por manifesto)     │
INFRA        SQLite · WorktreeManager · ProcessHost               ┘
```

Dependências apontam só para baixo. O `core` não conhece adapters nem HTTP — recebe portas injetadas, e por isso dá para testar orquestração, política e orçamento sem invocar nenhum agente.

Detalhes em [docs/01-arquitetura.md](docs/01-arquitetura.md).

## Adicionar um agente novo

Escrever um YAML em `manifests/` — não código:

```yaml
id: meu-agente
name: Meu Agente
bin: meu-cli
invoke:
  oneShot: ["-p"]
  stdinPrompt: true
session: { strategy: replay }
stream: { format: text, mapper: generic-text }
capabilities: [code-edit]
auth: { mode: inherit }
```

Só se escreve código quando o agente oferece algo que o genérico não cobre — como o servidor HTTP do OpenCode ou o JSONL de eventos do Codex.

## Segurança

O Hub **nunca** toca nas suas credenciais: cada adapter roda com o login que o próprio CLI já tem. O que ele controla é o resto.

- Cada sessão roda num git worktree próprio — agentes não pisam uns nos outros nem nas suas mudanças locais
- Orçamento é do fluxo inteiro, consumido pelos descendentes: o que um gasta, falta para os outros
- Política de um filho = interseção com a do pai: **delegar nunca aumenta privilégio**
- Profundidade máxima e detecção de ciclo semântico impedem que delegação vire loop caro
- `git push`, `rm -rf`, publish e caminhos sensíveis (`.ssh`, `.env`) param a sessão e abrem uma aprovação

Detalhes e níveis de risco em [docs/decisoes/03-seguranca-limites.md](docs/decisoes/03-seguranca-limites.md).

**Dois níveis de controle, com garantias diferentes** — e é importante não confundi-los:

- **Portão (preventivo):** delegação agente→agente e reserva de orçamento passam por dentro do Hub, então são retidas *antes* de acontecer. Em sessão `supervised`, toda delegação espera seu OK.
- **Vigilância (reativa):** comando executado e arquivo alterado chegam como evento, *depois* do fato. O que o Hub impede é a próxima ação, parando a sessão. Chamar isso de aprovação prévia seria mentira.

Por padrão só o irreversível (`git push`, `rm -rf`, publish, `.ssh`) para a sessão; sair da allow list vira alerta na timeline. Um controle que congela a sessão a cada comando legítimo é desligado na primeira hora, e controle desligado protege zero.

O gate verdadeiramente preventivo para shell e arquivo depende de integração por agente (hook `PreToolUse` do Claude Code, modos de aprovação do Codex) e está na fila.

```bash
hub approvals        # o que espera sua decisão
hub approve <id>     # libera e a sessão continua
```

## Quando um agente falha

O Hub não desiste na primeira: **retry** com backoff no mesmo agente (retomando a sessão nativa, que é mais barato), **fallback** pela cadeia `claude → codex → opencode` levando junto o histórico de falhas, e um **portão de validação** que roda o build/testes do projeto antes de aceitar o resultado — porque "terminou sem erro" e "entregou o que foi pedido" são coisas diferentes.

O substituto entra como irmão no grafo, não como filho: ele não foi chamado por quem falhou, está no lugar dele.

Configure o portão por repositório em `<repo>/.agents-hub/config.yaml`:

```yaml
policy:
  validation:
    command: npx tsc -b
```

O projeto só pode **apertar** a política global, nunca afrouxar — senão um `.agents-hub/config.yaml` num repo clonado viraria execução arbitrária. Detalhes em [docs/04-resiliencia-e-politica.md](docs/04-resiliencia-e-politica.md).

## Decisões

Cada escolha estrutural está registrada como ADR em [docs/decisoes/](docs/decisoes/), com a consequência que ela impõe. A pesquisa de mercado que embasou o desenho está em [docs/00-pesquisa-mercado.md](docs/00-pesquisa-mercado.md).

## Testes

```bash
node --test packages/core/dist/*.test.js   # domínio: 28 testes
python scripts/mcp-smoke.py                # MCP, só leitura, sem custo
python scripts/mcp-smoke.py --delegate codex   # delega de verdade (gasta tokens)
```

Os testes de domínio cobrem o que não pode quebrar em silêncio: não-escalação de privilégio, herança de orçamento e detecção de ciclo no grafo de delegação.
