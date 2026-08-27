# Preços de modelos

Referência dos preços usados por `packages/core/src/pricing.ts` para estimar custo em dólares a partir de tokens.

**Coleta: 27/08/2026.** Preço envelhece rápido — se você está lendo isto muito depois dessa data, confira as fontes antes de confiar no número.

## Por que o Hub precisa estimar

O orçamento do Hub é do fluxo inteiro e é em dólares (ADR 03.2). Só que cada agente reporta custo de um jeito:

- **Claude Code** manda `total_cost_usd` no evento `result` — dólar de verdade, cobrado pelo provedor.
- **Codex** manda só tokens no `turn.completed` (`input_tokens`, `output_tokens`, `cached_input_tokens`) — **nenhum dólar**.
- **Cursor, Copilot, OpenCode, Antigravity, Kimi e MiMo** hoje não reportam nem uma coisa nem outra: o mapper genérico não extrai custo.

O resultado aparecia no painel assim:

```
cursor [running]  US$ 0.0000 · 0 tok
  └ codex [completed] US$ 0.0000 · 17.2k tok
```

Zero dólares numa sessão que obviamente gastou. Com o teto em dólares valendo só para o Claude, o orçamento do fluxo era inaplicável a metade dos agentes — e um fan-out para três Codex não consumia nada do saldo.

A tabela abaixo fecha esse buraco. Ela **não** transforma estimativa em medição: o custo estimado continua sendo estimado, e o módulo obriga quem consome a saber a diferença.

## O que cada `basis` significa

Toda função de `pricing.ts` devolve um `CostEstimate` com dois campos de procedência:

| `basis` | Significado | Quando aparece |
|---|---|---|
| `reported` | O agente informou dólares. É o valor que o provedor vai cobrar. | Claude Code, evento `result` com `total_cost_usd > 0` |
| `estimated` | Calculado de tokens × tabela de preços. | Codex e qualquer agente que informe tokens |
| `unknown` | Não dá para saber. **`usd` vale 0 e isso não significa "de graça".** | Modelo fora da tabela e agente sem modelo padrão apurado |

E um `confidence`, porque duas estimativas podem ser muito diferentes em qualidade:

| `confidence` | Significado |
|---|---|
| `exact` | Veio do agente. |
| `model` | Tabela, com o modelo identificado pelo nome que o agente emitiu. |
| `agent-default` | Tabela, mas pelo modelo **padrão do agente** — o modelo real não foi reconhecido. Estimativa grosseira; mostre com ressalva. |
| `none` | Sem base nenhuma. |

Regra de agregação (`combineCostEstimates`): um total só é `reported` se **toda** parcela for. Basta um filho estimado para o custo do fluxo inteiro virar estimativa — senão o grafo mostraria como medido um número que é meio chute.

Regra do zero: `usd: 0` vindo do agente **não** conta como reportado. Um turno com 17,2k tokens e custo zero é campo ausente, não sessão gratuita. Custo zero de verdade (nenhum evento) é representado por um agregado vazio.

## Tabela

Todos os valores em **USD por milhão de tokens**.

### Anthropic — Claude Code

Fonte: <https://platform.claude.com/docs/en/about-claude/pricing> · coletado em 27/08/2026

| Modelo | Entrada | Saída | Leitura de cache | Escrita de cache (5min) |
|---|---|---|---|---|
| Claude Fable 5 | 10,00 | 50,00 | 1,00 | 12,50 |
| Claude Opus 5 | 5,00 | 25,00 | 0,50 | 6,25 |
| Claude Opus 4.8 | 5,00 | 25,00 | 0,50 | 6,25 |
| Claude Opus 4.7 | 5,00 | 25,00 | 0,50 | 6,25 |
| Claude Opus 4.6 | 5,00 | 25,00 | 0,50 | 6,25 |
| Claude Opus 4.5 | 5,00 | 25,00 | 0,50 | 6,25 |
| Claude Opus 4.1 | 15,00 | 75,00 | 1,50 | 18,75 |
| Claude Sonnet 5 | 2,00 | 10,00 | 0,20 | 2,50 |
| Claude Sonnet 4.6 | 3,00 | 15,00 | 0,30 | 3,75 |
| Claude Sonnet 4.5 | 3,00 | 15,00 | 0,30 | 3,75 |
| Claude Haiku 4.5 | 1,00 | 5,00 | 0,10 | 1,25 |
| Claude Haiku 3.5 | 0,80 | 4,00 | 0,08 | 1,00 |

Leitura de cache é 0,1x a entrada e escrita de 5min é 1,25x — os valores acima já vêm expandidos para não depender do multiplicador continuar valendo. O *fast mode* do Opus 5/4.8 (10,00/50,00) e o multiplicador 1,1x de `inference_geo: "us"` **não** estão modelados.

### OpenAI — Codex

Fonte: <https://developers.openai.com/api/docs/pricing> · coletado em 27/08/2026

| Modelo | Entrada | Saída | Entrada em cache |
|---|---|---|---|
| GPT-5.3-Codex | 1,75 | 14,00 | 0,175 |
| GPT-5.2-Codex † | 1,75 | 14,00 | 0,175 |
| GPT-5-Codex † | 1,25 | 10,00 | 0,125 |
| GPT-5.6 Sol | 4,00 | 20,00 | 0,40 |
| GPT-5.6 Terra | 2,00 | 12,00 | 0,20 |
| GPT-5.6 Luna | 0,20 | 1,20 | 0,02 |
| GPT-5.5 | 5,00 | 30,00 | 0,50 |
| GPT-5.4 | 2,50 | 15,00 | 0,25 |
| GPT-5.4 mini | 0,75 | 4,50 | 0,075 |
| GPT-5.4 nano | 0,20 | 1,25 | 0,02 |
| GPT-5.2 | 1,75 | 14,00 | 0,175 |
| GPT-5.1 | 1,25 | 10,00 | 0,125 |
| GPT-5 | 1,25 | 10,00 | 0,125 |
| GPT-5 mini | 0,25 | 2,00 | 0,025 |
| GPT-5 nano | 0,05 | 0,40 | 0,005 |

† Não aparecem na página oficial de preços; valores de <https://pricepertoken.com/pricing-page/model/openai-gpt-5-codex> (27/08/2026), coerentes com o modelo base de mesma geração.

GPT-5.5 e GPT-5.4 têm tarifa maior acima de 272k tokens de contexto — não modelada.

### Google — Antigravity

Fonte: <https://ai.google.dev/gemini-api/docs/pricing> · coletado em 27/08/2026

| Modelo | Entrada | Saída | Entrada em cache |
|---|---|---|---|
| Gemini 3.1 Pro | 2,00 | 12,00 | 0,20 |
| Gemini 3.7 Flash ‡ | 0,75 | 3,75 | 0,075 |
| Gemini 3.6 Flash ‡ | 0,75 | 3,75 | 0,075 |
| Gemini 3.5 Flash | 1,50 | 9,00 | 0,15 |
| Gemini 3.5 Flash-Lite | 0,30 | 2,50 | 0,03 |
| Gemini 3.1 Flash-Lite | 0,25 | 1,50 | 0,025 |
| Gemini 2.5 Pro | 1,25 | 10,00 | 0,125 |

‡ Preço promocional até 31/12/2026; dobra em 01/01/2027. Acima de 200k tokens de contexto, o Pro passa a 4,00/18,00 — não modelado. Armazenamento de cache (cobrado por hora) também não é modelado.

### Moonshot AI — Kimi Code

Fonte: <https://benchlm.ai/moonshot/api-pricing> (agregador; a página oficial <https://platform.kimi.ai/docs/pricing/chat> não expõe a tabela em HTML fetchável) · coletado em 27/08/2026

| Modelo | Entrada (cache miss) | Saída | Entrada em cache |
|---|---|---|---|
| Kimi K3 | 3,00 | 15,00 | 0,30 |
| Kimi K2.7 Code | 0,95 | 4,00 | 0,19 |
| Kimi K2.6 | 0,95 | 4,00 | 0,19 * |
| Kimi K2.5 | 0,60 | 3,00 | 0,15 * |
| Kimi K2 | 0,60 | 2,50 | 0,15 |

\* Cache-hit não publicado para esse modelo; assumido igual ao do irmão de mesma geração.

### Xiaomi — MiMo Code

Fonte: <https://mimo.mi.com/docs/en-US/price/pay-as-you-go> · coletado em 27/08/2026 · **tarifa internacional (USD)**

| Modelo | Entrada (cache miss) | Saída | Entrada em cache |
|---|---|---|---|
| MiMo-V2.5-Pro | 0,435 | 0,87 | 0,0036 |
| MiMo-V2.5 | 0,14 | 0,28 | 0,0028 |

A tarifa doméstica chinesa é em CNY e bem diferente (¥3,00/¥6,00 para o Pro). **Não modelada:** quem roda o MiMo pela conta chinesa vai ver estimativa errada.

### Anysphere — Cursor

Fonte: <https://cursor.com/docs/account/pricing> · coletado em 27/08/2026

| Modelo | Entrada | Saída | Leitura de cache |
|---|---|---|---|
| Composer 2.5 | 0,50 | 2,50 | 0,20 |
| Composer 2.5 (Fast) | 3,00 | 15,00 | 0,50 |
| Grok 4.6 | 2,00 | 6,00 | 0,50 |
| Grok 4.6 (Fast) | 4,00 | 12,00 | 1,00 |
| Grok 4.5 | 2,00 | 6,00 | 0,50 |
| Grok 4.5 (Fast) | 4,00 | 18,00 | 1,00 |

Os modelos de terceiros que o Cursor revende (Claude, GPT, Gemini) saem pelo mesmo preço de tabela do provedor original e já estão nas seções acima. O Cursor cobra **US$ 0,25/MTok adicionais** de "Cursor Token Rate" sobre terceiros — essa taxa **não** está aplicada, então a estimativa do Cursor com modelo de terceiro sai levemente para baixo.

### GitHub Copilot e OpenCode — sem preço

Desde 01/06/2026 o Copilot fatura em **AI Credits** (1 crédito = US$ 0,01), convertidos a partir do consumo de tokens pelas tarifas de API de cada modelo (<https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/>). Ou seja: sabendo o modelo, os preços das tabelas acima valem. Só que o Copilot CLI não diz qual modelo usou, e não achei documentação do modelo padrão — então **não existe fallback por agente para o `copilot`**.

O OpenCode é model-agnostic por construção: o modelo é escolhido pelo usuário em `opencode auth login`. Também **não tem fallback**.

Para os dois, modelo desconhecido devolve `unknown`. Chutar uma família aqui seria inventar número com quatro casas decimais, que é pior que não ter número nenhum.

## Fallback por agente

Quando o modelo não é reconhecido mas o agente é, `estimateTokenCost` usa o modelo padrão do agente e marca `confidence: 'agent-default'`.

| Agente | Modelo assumido |
|---|---|
| `claude` | Claude Opus 5 |
| `codex` | GPT-5.3-Codex |
| `antigravity` | Gemini 3.1 Pro |
| `kimi` | Kimi K2.7 Code |
| `mimo` | MiMo-V2.5-Pro |
| `cursor` | Composer 2.5 |
| `copilot` | — (`unknown`) |
| `opencode` | — (`unknown`) |

Na dúvida entre dois tiers, o fallback aponta para o **mais caro**: estourar o orçamento sem aviso é pior que reservar demais.

## Contabilidade de cache: a pegadinha que muda o número

Os provedores discordam sobre o que `input_tokens` inclui:

- **Anthropic (`disjoint`)** — `input_tokens` já exclui o que veio do cache; `cache_read_input_tokens` é um número à parte. Somar os dois cheios está certo.
- **OpenAI e compatíveis (`subset`)** — `cached_input_tokens` está **dentro** de `input_tokens`. Somar os dois cobraria o cache duas vezes.

Cada linha da tabela carrega esse regime em `cacheAccounting`, e o estimador desconta o cache da entrada só onde é `subset`. Como cache costuma ser a maior fatia de uma sessão longa, ignorar isso não é erro marginal — chega a dobrar a estimativa de uma sessão do Codex com prefixo grande.

## Onde a estimativa erra, de propósito

Coisas conhecidas e não modeladas, todas puxando o número **para baixo** (exceto onde indicado):

1. **Escrita de cache.** Nenhum adapter reporta tokens de escrita de cache hoje, então o estimador ignora `cacheWritePerMTok`. A primeira volta de uma sessão longa custa 1,25x a entrada e é contada como 1x.
2. **Tarifa de contexto longo.** GPT-5.5/5.4 acima de 272k e Gemini Pro acima de 200k custam mais. O Hub não sabe o tamanho do contexto do turno.
3. **Taxa do Cursor** sobre modelos de terceiros (US$ 0,25/MTok).
4. **Ferramentas de servidor.** Web search da Anthropic custa US$ 10 por 1.000 buscas; execução de código tem cobrança por hora de container. Nada disso passa por tokens.
5. **Modalidade.** Áudio custa o dobro do texto em alguns modelos Gemini; o `EventCost` do Hub não distingue modalidade.
6. **Tarifa doméstica do MiMo** (CNY), que é maior que a internacional — aqui o erro é **para baixo** também.
7. **Variante nova de família conhecida.** O casamento é por prefixo: um `gpt-5-7` hipotético cairia em `gpt-5` e sairia com preço da geração anterior. Prefira acrescentar a linha nova a confiar no prefixo.

Quando o valor precisa estar certo — cobrança, rateio, auditoria —, use apenas os eventos com `basis: 'reported'`. O resto é para o orçamento não ficar cego, não para fechar conta.
