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
