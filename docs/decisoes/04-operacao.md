# ADR 04 — Modelo Operacional (decidido em 2026-08-26)

| # | Decisão | Escolha | Consequência |
|---|---|---|---|
| 4.1 | Agente principal | **Sempre explícito ao iniciar a sessão** | Não existe principal implícito. `hub start --agent <id>` é obrigatório (a UI/TUI força a escolha). "Principal" = dono da sessão-raiz, papel puramente runtime — qualquer um dos 8 pode assumi-lo. |
| 4.2 | Roteamento | **Agente explícito, com capabilities opcionais** | `agent.call` aceita `agent: "codex"` (padrão) ou `agent: "cap:test-writing"`, resolvido por um registro de capabilities declarado no manifesto de cada agente. Sem escolha automática silenciosa. |
| 4.3 | Tratamento de falha | **Retry com backoff → fallback para outro agente → validação do resultado** | Pipeline de resiliência por task, configurável por política. |
| 4.4 | Ordem de construção | **Vertical fina primeiro** | Fase 1 = daemon + core + 1 adapter (Claude Code) + CLI, ponta a ponta, com sessão real, stream e persistência. Só depois multiplicar adapters. |

## Pipeline de resiliência (ordem de execução)

1. **Executa** a task no agente alvo.
2. **Erro transitório** (rate limit, rede, `wedged run`, timeout de heartbeat) → `retry` com backoff exponencial, até `max_retries` (padrão 2).
3. **Esgotou retries** → `fallback` para o próximo agente da cadeia definida na política (ex.: `claude → codex → opencode`). O brief é reenviado intacto; o histórico de tentativas vai anexado como contexto de falha.
4. **Resultado produzido** → `validation gate` antes de devolver ao pai:
   - `criteria`: checagem dos `acceptance_criteria` do brief;
   - `command`: rodar build/testes/lint (comando declarado na política);
   - `review`: um segundo agente revisa o resultado (opt-in por custo).
5. **Validação reprova** → conta como falha e volta ao passo 2.

> **Assunção registrada (falta decisão explícita):** como *escalar para humano* NÃO foi marcado, quando retry + fallback + validação se esgotam a task termina em `failed`, com todo o contexto preservado e um evento de alta prioridade no stream/UI — o fluxo não fica pendurado esperando você. Orçamento estourado continua indo para `input_required` (ADR 03), pois ali a decisão é inerentemente humana.
