# ADR 06 — Resiliência, Retenção e Modelos (decidido em 2026-08-26)

Fecha as pendências que o ADR 04 havia deixado em aberto e destrava a Fase 2.

| # | Decisão | Escolha | Consequência |
|---|---|---|---|
| 6.1 | Falha final | **Task morre em `failed`, com evento de alta prioridade** | Confirma a assunção do ADR 04. Esgotados retry + fallback + validação, a task termina — o fluxo não fica pendurado esperando alguém olhar. Contexto e tentativas ficam preservados; o evento aparece no stream, no grafo e na UI. Só orçamento estourado vai para `input_required` (ADR 03), porque ali a decisão é inerentemente humana. |
| 6.2 | Cadeia de fallback | **`claude → codex → opencode`**, global | Os três com melhor superfície programável. Cadeia curta de propósito: se os três falharem, o problema está no brief, não no agente — insistir em mais agentes só queimaria orçamento. Copilot, Kimi e MiMo ficam disponíveis para chamada explícita, fora da cadeia automática. |
| 6.3 | Retenção | **Eventos para sempre; worktrees por 7 dias** | O banco guarda a história inteira (custo por trimestre, auditoria antiga, replay de qualquer sessão). Os checkouts em disco são recolhidos após 7 dias — mas o **branch `hub/<sessionId>` é preservado**, então o trabalho do agente nunca se perde, só deixa de ocupar disco. |
| 6.4 | Modelo por agente | **Default de cada CLI** | O Hub não opina sobre modelo. Você troca de modelo onde já está acostumado a trocar (config do próprio agente), e o Hub não vira mais um lugar para manter sincronizado a cada lançamento. O campo `{{model}}` do manifesto continua existindo para quem quiser fixar depois. |

## Configuração resultante (`~/.agents-hub/config.json`)

```jsonc
{
  "policy": {
    "retries": { "max": 2, "backoffMs": 2000 },
    "fallback": {
      "code-edit":    ["claude", "codex", "opencode"],
      "refactor":     ["claude", "codex", "opencode"],
      "test-writing": ["claude", "codex", "opencode"],
      "debug":        ["claude", "codex"],
      "shell":        ["codex", "opencode"]
    }
  },
  "retention": {
    "events": "forever",
    "rawPayloads": "forever",
    "worktreeDays": 7
  }
}
```

## Ordem do pipeline de falha (final)

```
executa
  ├─ erro transitório (rate limit, rede, run travada) → retry com backoff, até 2x
  ├─ retries esgotados → próximo da cadeia (claude → codex → opencode)
  │     brief reenviado intacto + histórico de falhas anexado como contexto
  ├─ resultado produzido → portão de validação
  │     ├─ critérios de aceite do brief
  │     ├─ comando declarado na política (build/testes/lint)
  │     └─ revisão por segundo agente (opt-in, por custo)
  │     reprovou → volta ao retry
  └─ tudo esgotado → state = failed + evento de alta prioridade
                     (fluxo NÃO trava esperando humano)
```

## Estado atual (nota de 2026-09-26 — a decisão acima não foi reescrita)

Conferido no código para o item 8.1 do [GOAL](../12-goal-mvp-completo.md). **O exemplo de `config.json` acima está superado e não deve ser copiado**: `retention.events` e `retention.rawPayloads` não existem no schema (`packages/daemon/src/config.ts`), e como o nível superior do `config.json` não é `strict`, seriam ignoradas em silêncio.

- **6.2 Cadeia de fallback** — emendada. `DEFAULT_POLICY.fallback` (`packages/core/src/policy.ts`) tem 7 capabilities e inclui `openclaude` (acrescentado por dedução, **nunca exercitado** como fallback real):

  | Capability | Cadeia |
  |---|---|
  | `code-edit`, `refactor`, `test-writing` | claude → codex → opencode → openclaude |
  | `code-review`, `debug` | claude → codex → openclaude |
  | `planning` | claude → codex |
  | `shell` | codex → opencode → openclaude |

  A política de projeto só pode encurtar a cadeia (subconjunto, na ordem), nunca acrescentar agente.
- **6.3 Retenção** — emendada. "Eventos para sempre" vale para o `payload_json`. O `raw_json` (bruto do agente, só para depurar mapper) é **compactado para `NULL`** `rawEventDays` dias depois do fim da sessão (padrão **7**), pelo `EventRetentionCompactor` (`packages/daemon/src/event-retention.ts`), a cada `sweepIntervalMinutes` (padrão 60), sem `VACUUM`. Worktrees seguem por `worktreeDays` (7), branch `hub/<id>` preservado (o recolhimento commita no branch o trabalho não salvo antes de remover o checkout). A trilha de auditoria (`audit_log`) fica fora dessa retenção. Não há comando de expurgo. Chaves reais:

  ```jsonc
  {
    "retention": { "worktreeDays": 7, "sweepIntervalMinutes": 60, "rawEventDays": 7 }
  }
  ```
- **6.4 Modelo por agente** — emendada. O padrão continua sendo o default de cada CLI, mas existe modelo opcional por agente/projeto (variável `MODEL` do env do projeto ou o campo "Modelo" do painel), aplicado só onde o manifesto declara `model.supported: true` com a flag conferida no `--help` ([docs/01 §5](../01-arquitetura.md)).
- **Pipeline:** "critérios de aceite do brief" não são checados por heurística; ver a nota do ADR 04.
