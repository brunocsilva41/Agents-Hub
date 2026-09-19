# 10 — Manutenção da tabela de preços

> Resposta ao item de Fase 4 do [roadmap](02-roadmap.md): "Dono para a tabela de
> preços (`core/pricing.ts`): dependência externa que muda sozinha e sustenta
> todo o orçamento em dólares dos agentes que só reportam tokens. Hoje ninguém
> a mantém." Este documento é processo, não código — não muda `pricing.ts`.

## O problema em uma frase

`packages/core/src/pricing.ts` (929 linhas) é a única razão pela qual o teto de
orçamento em dólares (ADR 03.2) significa alguma coisa para Codex, Cursor,
Copilot, OpenCode, Antigravity, Kimi e MiMo — nenhum deles reporta dólares
nativamente. Só o Claude Code manda `total_cost_usd` de verdade. Toda estimativa
para os outros oito agentes depende de uma tabela que **os provedores mudam sem
avisar o Hub**, e hoje não existe processo nenhum que note quando isso acontece.

## De onde vieram os preços atuais

Cada linha de `MODEL_PRICES` carrega os próprios metadados de procedência —
isso já existia antes deste documento e é o que torna a auditoria possível:

- `source`: URL da página de preços do provedor (`ANTHROPIC_SRC`, `OPENAI_SRC`,
  `GOOGLE_SRC`, `MOONSHOT_SRC`, `XIAOMI_SRC`, `CURSOR_SRC` — constantes no topo
  do arquivo).
- `collectedAt`: data ISO da coleta daquela linha específica.
- `PRICING_COLLECTED_AT` (`'2026-08-27'`): data de referência do lote inteiro,
  exportada e citada em [`docs/referencias/precos-modelos.md`](referencias/precos-modelos.md),
  que documenta o *porquê* da tabela e o significado de `basis`/`confidence`
  (`reported` / `estimated` / `unknown`).

Ou seja: a proveniência já está registrada campo a campo. O que faltava não era
metadado — era **quem olha esse metadado de novo, e quando**.

## Processo de atualização sugerido

Não existe hoje automação que baixe preços de provedor. Até que exista (ver
"bônus" abaixo), o processo é manual e depende de alguém decidir revisitar:

1. **Gatilho de revisão** (qualquer um dos três abaixo, o que vier primeiro):
   - **Trimestral**: a cada ~90 dias corridos desde `PRICING_COLLECTED_AT`,
     alguém confere as URLs em `source` contra o que está publicado agora.
   - **Por evento**: lançamento de modelo novo em qualquer um dos provedores
     cobertos (Anthropic, OpenAI, Google, Moonshot, Xiaomi, Cursor) — um
     modelo sem entrada em `MODEL_PRICES` cai em `basis: 'unknown'`
     silenciosamente (por design — `pricing.ts` não inventa preço para modelo
     desconhecido), mas isso significa orçamento decorativo para quem usa
     esse modelo até alguém notar e adicionar a linha.
   - **Por reclamação**: alguém percebe no painel um custo estimado muito
     distante do que a fatura real do provedor mostrou.
2. **Como atualizar uma linha**: editar o `ModelPrice` correspondente em
   `packages/core/src/pricing.ts`, atualizar `collectedAt` daquela linha (não
   precisa mexer em `PRICING_COLLECTED_AT` se só uma linha mudou — mas
   atualize `PRICING_COLLECTED_AT` se a revisão cobriu a tabela inteira),
   conferir `cacheAccounting` (`disjoint` vs `subset` — trocar isso silenciosamente
   dobra ou zera o custo de cache, ver comentário do tipo no próprio arquivo)
   e rodar `npm test` (há suíte de `pricing.test.ts` cobrindo estimativa).
3. **Como adicionar um modelo novo**: nova entrada em `MODEL_PRICES` com
   `aliases` cobrindo as grafias que os adapters de fato emitem (casamento é
   por prefixo — ver `normalizeModelId`/`findModelPrice`), e se o modelo for o
   novo padrão de algum agente, atualizar `AGENT_FALLBACK_MODEL`.
4. **Antes de mesclar**: nenhuma revisão de preço precisa de aprovação
   especial além do processo normal do repositório, mas quem revisar o PR
   deveria conferir a URL em `source` de próprio punho — copiar o número sem
   abrir o link é como a tabela original ficou desatualizada sem ninguém
   perceber.

## Quem é o dono, hoje

Não há um CODEOWNERS neste repositório e não é este documento que vai criar
um time. Na ausência de um dono nomeado, a regra é: **quem adicionar um agente
novo ou notar uma divergência de preço é responsável por atualizar a linha
correspondente como parte dessa mudança** — do mesmo jeito que a verificação de
manifestos contra binário real (ADR/roadmap Fase 2) virou prática do
repositório. Se este projeto ganhar CODEOWNERS no futuro, `packages/core/src/pricing.ts`
e `docs/referencias/precos-modelos.md` deveriam ter o mesmo dono.

## Bônus considerado e não implementado

O item do roadmap sugere, como bônus opcional, um teste que sinalize preços
"antigos" caso a tabela guarde data de referência por entrada — e ela guarda
(`collectedAt` por linha, `PRICING_COLLECTED_AT` para o lote). Um teste desse
tipo teria que decidir um limiar de "antigo demais" (30 dias? 90? 180?) sem
nenhum incidente real que justifique o número, e um teste que falha sozinho
com a passagem do tempo (sem nenhuma mudança de código) é ruído de CI que
alguém vai aprender a ignorar — o mesmo tipo de alarme falso que este
repositório já evita em outros lugares (ex.: o CI de Linux é informativo, não
bloqueante, porque o Hub nunca rodou lá). Por isso este documento registra a
opção e **não** a implementa: o gatilho por calendário da seção anterior
("trimestral") cobre a mesma necessidade sem um teste que envelhece sozinho.
Se um incidente real acontecer (orçamento estourado por preço desatualizado),
esse é o momento certo para reabrir esta decisão com um limiar informado por
dado, não por chute.
