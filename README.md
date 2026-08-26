# Agents-Hub

> Plano de controle onde **qualquer** agente de IA pode orquestrar e ser orquestrado.

Claude Code, Codex, Cursor, Copilot, OpenCode, Antigravity, Kimi Code e MiMo — todos reduzidos ao mesmo modelo de sessão, evento, política e orçamento. Nenhum papel é fixo: "principal" é apenas quem detém a sessão-raiz, e você escolhe isso a cada sessão.

## Por que existe

Cada agente é ótimo em algo e cego para o resto. Hoje, fazer um chamar o outro significa copiar contexto na mão, perder o rastro de quem fez o quê e não ter ideia de quanto custou. O Hub resolve as quatro coisas que faltam quando agentes trabalham juntos:

| Problema | O que o Hub faz |
|---|---|
| Cada CLI fala um dialeto | Um adapter por agente normaliza tudo para um `EventEnvelope` único |
| Agentes pisam uns nos outros | Um git worktree isolado por sessão |
| Delegação vira loop caro | Profundidade máxima + detecção de ciclo semântico + orçamento herdado da raiz |
| Ninguém sabe o que aconteceu | Todo evento persistido com o payload original, grafo ao vivo e custo por nó |

## Estado atual

**Fase 1 concluída e testada de ponta a ponta.** Um agente inicia sessão real, produz eventos normalizados, é isolado em worktree, respeita orçamento — e delega para outro agente.

```
claude ✓ concluída US$ 0.7678 · 150 tok
   Responda apenas com a palavra PRONTO.
   └─ codex ✓ concluída US$ 0.0000 · 17.2k tok
      Responda apenas com a palavra DELEGADO.
```

Veja [docs/02-roadmap.md](docs/02-roadmap.md) para o que vem nas fases 2 e 3.

## Começando

```bash
npm install && npm run build
```

Suba o daemon (mantém as sessões vivas independente do terminal):

```bash
node packages/cli/dist/main.js daemon
```

Em outro terminal, veja quais agentes você tem:

```bash
node packages/cli/dist/main.js doctor
```

Abra uma sessão — o `--agent` é obrigatório porque **você escolhe o principal a cada vez**:

```bash
node packages/cli/dist/main.js start --agent claude --budget-usd 2 "refatore o módulo de pagamentos"
```

Faça um agente chamar outro:

```bash
node packages/cli/dist/main.js delegate <sessionId> --agent codex --budget-usd 0.5 "escreva os testes do que foi refatorado"
```

Veja quem chamou quem e quanto custou:

```bash
node packages/cli/dist/main.js graph <rootId>
```

`hub help` lista tudo.

## Arquitetura em uma tela

```
CLIENTES     CLI · TUI · Web UI  ──── HTTP + SSE (API única) ────┐
TRANSPORTS   MCP server · A2A server · REST/SSE                  │
CORE         Orchestrator · SessionManager · CallGraph           │
             PolicyEngine · BudgetLedger · CapabilityRegistry    │
ADAPTERS     claude · codex · opencode · cursor · copilot        │
             antigravity · kimi · mimo   (dirigidos por manifesto)│
INFRA        SQLite · WorktreeManager · ProcessHost              ┘
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

- Escrita fora do worktree da sessão pede aprovação
- Comandos fora da allow list pedem aprovação
- `git push`, deletes e publicações sempre pedem aprovação
- Política de um filho = interseção com a do pai: **delegar nunca aumenta privilégio**
- Orçamento é do fluxo inteiro, consumido pelos descendentes

Detalhes e níveis de risco em [docs/decisoes/03-seguranca-limites.md](docs/decisoes/03-seguranca-limites.md).

## Decisões

Cada escolha estrutural está registrada como ADR em [docs/decisoes/](docs/decisoes/), com a consequência que ela impõe. A pesquisa de mercado que embasou o desenho está em [docs/00-pesquisa-mercado.md](docs/00-pesquisa-mercado.md).

## Testes

```bash
node --test packages/core/dist/*.test.js
```

Cobrem o que não pode quebrar em silêncio: não-escalação de privilégio, herança de orçamento e detecção de ciclo no grafo de delegação.
