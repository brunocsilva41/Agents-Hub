# ADR 03 — Segurança, Limites, Observabilidade e Contexto (decidido em 2026-08-26)

| # | Decisão | Escolha | Consequência |
|---|---|---|---|
| 3.1 | Credenciais | **Herdar o login nativo de cada CLI** | O Hub NUNCA persiste segredo. Cada adapter roda com o perfil de auth que o CLI já possui (`~/.claude`, `~/.codex`, `~/.config/opencode`, ...). Manifesto pode declarar env vars extras vindas do ambiente do usuário. Interface `CredentialProvider` fica preparada para um cofre futuro, mas não é implementada agora. |
| 3.2 | Limites | **Todos os quatro** | (a) profundidade máx. + detecção de ciclo no grafo; (b) orçamento de custo/tokens da sessão-raiz, consumido pelos descendentes; (c) timeout por task e por sessão + heartbeat de stream; (d) concorrência máxima global e por agente. |
| 3.3 | Observabilidade | **Todos os quatro** | Grafo de chamadas ao vivo; stream de eventos normalizado; painel de custo/tokens; controles ao vivo (pausar, interromper, injetar mensagem, matar). Define os requisitos da Web UI e da TUI. |
| 3.4 | Passagem de contexto | **Brief explícito + artefatos referenciados** | `agent.call` exige um brief estruturado: `objective`, `acceptance_criteria`, `constraints`, `artifacts[]`, `context_refs[]`. O filho começa com contexto limpo. Sem repasse de transcript no MVP. |

## Contrato do Brief (payload de `agent.call`)

```jsonc
{
  "agent": "codex",                      // alvo: id de agente OU capability (ex.: "cap:refactor")
  "objective": "string, imperativo e único",
  "acceptance_criteria": ["string", "..."],   // como o pai valida o resultado
  "constraints": ["não tocar em migrations", "..."],
  "artifacts": [{ "path": "src/x.ts", "mode": "read|write" }],
  "context_refs": ["session:abc#event:42"],   // ponteiros, não conteúdo
  "budget": { "usd": 2.0, "tokens": 200000, "seconds": 900 },  // <= orçamento restante do pai
  "isolation": "worktree",
  "mode": "async"                        // async | stream
}
```

## Orçamento: regra de herança
O orçamento é **da sessão-raiz**, não do agente. Todo `agent.call` reserva uma fatia do saldo restante da raiz. Filho não pode reservar mais do que o pai tem. Ao esgotar: task entra em `input_required` aguardando decisão humana (aumentar orçamento ou cancelar).

## Anti-loop: regra do grafo
Cada task carrega `root_id`, `parent_id`, `depth` e `path[]` (cadeia de agentes). Rejeita a chamada se: `depth > max_depth` **ou** o par `(agent, objective_hash)` já aparece em `path[]` (ciclo semântico, não só ciclo de identidade).

## Estado atual (nota de 2026-09-26 — a decisão acima não foi reescrita)

Conferido no código para o item 8.1 do [GOAL](../12-goal-mvp-completo.md):

- **3.1 Credenciais:** o Hub continua sem ler os arquivos de credencial dos CLIs, mas **persiste** o env que o usuário configura por projeto (`hub project env`, painel, `hub import`) em texto no banco do Hub. `CredentialProvider` não existe no código. Ver [SECURITY.md](../../SECURITY.md).
- **3.3 Observabilidade:** "requisitos da Web UI e da TUI" — **não há TUI**; tudo foi entregue na Web UI e na CLI.
- **3.4 Brief:** os nomes reais são `camelCase` no contrato interno (`acceptanceCriteria`, `contextRefs`, `packages/core/src/brief.ts`) e `snake_case` só na tool MCP (`acceptance_criteria`, `context_refs`, `budget_usd`). `agent.call` é a tool `hub_agent_call`. O brief também tem `upstream` (fan-in de workflow), `supervision` e `labels`; `isolation: container` é aceito no schema mas recusado ao executar.
- **Controle de rede** (citado no doc 01 §7 a partir deste ADR): aplicado pelo gate (`WebFetch`/`WebSearch`) e pelo classificador de comando (`curl`, `wget`...); agentes sem gate e sem eventos de comando não têm controle de rede.
