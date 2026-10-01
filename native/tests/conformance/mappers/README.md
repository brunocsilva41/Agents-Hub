# Corpus de conformidade: mappers de eventos e invocação dos adapters (CONF-02)

Saída **real** do código TypeScript congelado para cada entrada, para a reescrita em C
reproduzir byte a byte (ADR 7.8–7.10, [SPEC-04 parte B](../../../../docs/especificacao/04-dominio-e-adapters.md)).
Nenhum valor esperado foi escrito à mão: o gerador importa `packages/adapters/src` e
`packages/core/src` direto (os `dist/` podem estar defasados) e grava o que as funções
devolvem.

## Origem

- Commit: `c3ecbee83749e2d8637f30501a91679354164c0c` (`main`, árvore limpa em `packages/` e `manifests/`).
- Gerado com Node 24 (`--experimental-transform-types`), hook de resolução `.js → .ts` e
  `@agents-hub/core → packages/core/src/index.ts` (embutido no gerador). A versão
  exata do Node não é gravada.
- `sources.json`: sha256 de cada arquivo-fonte lido (sobre o texto **normalizado
  para LF**: o repositório usa `core.autocrlf=true`) e de cada `.jsonl` gravado.

## Travas contra mudança no TS

O gerador **para com exit 1**, sem gravar nada, em dois casos:

1. **Hash das fontes**: alguma fonte listada em `sources.json` diverge do texto
   atual (LF). Para aceitar fontes novas de propósito (depois de revisar o
   corpus), rode com `--aceitar-fontes`, que regrava os hashes.
2. **Blocos replicados**: o gerador copia trechos privados do TS. Cada um é
   conferido como texto exato e contíguo, na linha onde a SPEC o cita. Uma mudança
   dentro do bloco, ou uma mudança que o desloque, faz o gerador falhar. Os blocos:
   `process-adapter.ts:212` (`usesStdin`), `:249-256` (env), `:486-501` (id nativo e
   erros do agente), `:539-564` (stdin), `:570-588` (`#mapLine`);
   `opencode/adapter.ts:307-333` (`recordError`/`erroDoTurno`/`finish`), `:471-498`
   (laço de `#consume`), `:793-798` (`describeErrorPayload`);
   `async-queue.ts:64-65` (`push` ignora fila fechada).

## Regenerar e conferir

Da raiz do repositório:

```sh
node --experimental-transform-types native/tests/conformance/tools/gen-mappers.mjs
node native/tests/conformance/mappers/crosscheck-ts-asserts.mjs
```

O gerador aceita `--out <dir>` (útil para comparar duas execuções; a trava de hash
sempre compara com `mappers/sources.json`) e `--aceitar-fontes`. Não spawna
processo, não sobe daemon, não chama agente nem modelo.

`crosscheck-ts-asserts.mjs` reaplica 189 asserts de 11 arquivos `*.test.ts`
(cada um com `arquivo:linha`) sobre os registros do corpus.

## Semântica de comparação (vale para todos os arquivos)

- Cada linha é um JSON. Os valores esperados estão na forma de `JSON.stringify`:
  **chave com valor `undefined` não aparece** (ex.: `cost: {usd: undefined}` vira
  `"cost":{}`, que existe e é vazio, e isso é diferente de não ter `cost`).
- A ordem das chaves é a de inserção do TS. Ela é informativa e não entra na
  comparação; compare por igualdade estrutural.
- Números são doubles IEEE-754. O texto é o round-trip mais curto do JS. `-0`
  serializa como `0`; `1e400` no JSON de entrada vira `Infinity` e é descartado
  (`numberOf` exige finito); inteiro > 2^53 perde precisão.
- Strings são UTF-16 do JS. Surrogate isolado sai escapado (`"\ud83d"`).
- `raw` faz parte do evento esperado: é o valor JSON parseado da linha, ou o bloco
  (claude `assistant`/`user`, copilot `toolRequests[]`), ou a string crua da linha
  (log de linha não-JSON, `generic-text`).

## Arquivos e formato

Todo caso, em todos os arquivos, tem `spec`: as seções de
`docs/especificacao/04-dominio-e-adapters.md` que ele exercita.

| Arquivo | `spec` |
|---|---|
| `<mapper>.jsonl` | B7 › seção do mapper; B4 › Linha → eventos; A12 quando há `turn_cost` |
| `opencode-sse.jsonl` | B8 › Eventos SSE → Hub e tabela run/fim do turno/desfecho |
| `invocation.jsonl` | B2 › Placeholders e Argv efetivo; B4 › Spawn (stdin); B5 › Entrega do prompt; B9 (`env_overlay`). Casos com `expected_error`: B4 › `modeloDaRun` |
| `manifest-schema.jsonl` | B2 › Schema e Os 9 manifestos |
| `failure-reason.jsonl` | B4 › `motivoDaFalha` (e Spawn item 7 para `mensagemDoEventoDeErro`); `sessaoNativaInexistente`: B2 › `session.strategy` |

### `<mapper>.jsonl` (`claude`, `codex`, `copilot`, `kimi`, `antigravity`, `generic-json`, `generic-text`)

| Campo | Conteúdo |
|---|---|
| `id` | `<mapper>/<slug>` |
| `mapper`, `format` | nome registrado; `jsonl` ou `text` (o do manifesto que usa o mapper) |
| `source` | `arquivo:linha` do teste/fonte de onde vem a entrada, ou `borda` |
| `notes` | o que o caso prova; `DIVERGÊNCIA CONHECIDA` quando aplicável |
| `input_lines` | linhas brutas do stdout do agente, **já** separadas pelo leitor de linhas (sem `\n`, sem `\r` final) |
| `expected_events` | todos os `MappedEvent` emitidos, em ordem (`type`, `payload`, `cost?`, `nativeSessionId?`, `raw`) |
| `events_per_line` | quantos eventos cada linha gerou (localiza a falha) |
| `native_session_id` | o 1º `nativeSessionId` visto (o que o handle guarda), ou `null` |
| `agent_errors` | `mensagemDoEventoDeErro` de cada evento `error`, as últimas 20 (o que alimenta `motivoDaFalha`) |
| `turn_cost` | só se algum evento tem `cost`: `TurnCostTracker` real, **sem precificação** — `base`, `steps[{event_index, kind, cost|total}]`, `flush` |

A linha passa pelo `#mapLine` do `ProcessAgentAdapter` (`process-adapter.ts:570-588`),
replicado no gerador porque é privado:
`text` → mapper(linha crua). `jsonl` → `trim()` (JS: inclui BOM, NBSP, U+2028, U+3000);
vazia → nada; não começa com `{` nem `[` → `log {stream:'stdout', text}`;
`JSON.parse` + mapper dentro do **mesmo** `try`; qualquer exceção →
`log {stream:'stdout', text, unparsed:true}`.

### `opencode-sse.jsonl`

| Campo | Conteúdo |
|---|---|
| `chunks` **ou** `chunks_hex` | pedaços do corpo `text/event-stream` como chegam do `fetch` (strings UTF-8, ou bytes em hex quando o caso parte um caractere UTF-8) |
| `session_filter` | `nativeSessionId` da run (`ses_abc123`) |
| `expected_decoded` | JSONs que o `SseDecoder` devolve (com `TextDecoder` em modo stream, como o adapter) |
| `expected_per_decoded[]` | por evento decodificado: `session_id` (`openCodeSessionId`), `passes_filter`, `pending_request` (`openCodePendingRequest`), `idle_signal`, `events` (`translateOpenCodeEvent`, **sem** filtro) |
| `expected_events` | o que vai para a fila da run: só eventos da sessão, e nada depois do 1º `idle_signal` (a fila fecha no `finish`; `async-queue.ts:65`) |
| `outcome_at_idle` | `{exitCode: 0 \| 1, reason:'exit', error}` no idle (1 + última mensagem se houve `error` no turno), ou `null` |

O laço de `#consume` (`opencode/adapter.ts:471-498`), o `finish`/`erroDoTurno`
(`:307-333`) e `describeErrorPayload` (`:793-798`) estão replicados e travados
(ver "Travas").

### `invocation.jsonl` (9 manifestos + 3 sintéticos)

| Campo | Conteúdo |
|---|---|
| `manifest` | id do manifesto em `manifests/` (`sintetico` = manifesto inline em `manifest_inline`) |
| `scenario` | `template` (`oneShot`/`resume`), `prompt`, `nativeSessionId`, `mode`, `workdir`, `model`, `env`, `extraArgs`, `settingsFile`, `promptFile` |
| `expected.args` | argv de `montarInvocacao` (sem o binário) |
| `expected.entrega` | `stdin` / `argv` / `promptFile` / `nenhuma` |
| `expected.stdin` | `write`: o prompt (só com `stdinPrompt`) ou `null`; `close_after_write`: `!interactive` (`process-adapter.ts:539-564`) |
| `expected.env_overlay` | `{...invoke.env, ...ctx.env, AGENTS_HUB_SESSION_ID:'ses_conf', AGENTS_HUB_TASK_ID:'', AGENTS_HUB_AGENT_ID}` sobre o `process.env` do daemon (`process-adapter.ts:249-256`); `taskId` nulo nos cenários |
| `expected_error` | em vez de `expected`, quando `montarInvocacao` lança (`code`, `message`) |

O escape do `.cmd` (`montarSpawn`) e a resolução de binário não estão aqui. No
daemon, o `opencode` roda pelo `OpenCodeAdapter` HTTP; o argv do manifesto só vale
no fallback de processo.

### `manifest-schema.jsonl`

`manifest/<id>`: os 9 YAML de `manifests/` carregados por `loadManifestFile`
(defaults aplicados, chaves desconhecidas removidas). `schema/<slug>`: entradas
avulsas no `AgentManifestSchema.safeParse` → `{success, data}` ou
`{success:false, issues[{path, message}]}`. O texto de `message` é o do zod e
serve só como referência; o C precisa casar `success` e os `path`.

### `failure-reason.jsonl`

`{fn, args, expected}` para `motivoDaFalha(exitCode, errosDoAgente, stderr)`,
`ultimaLinhaDeErro(stderr)`, `mensagemDoEventoDeErro(evento)` e
`sessaoNativaInexistente(padroes, stderr, motivo)`.

## Casos

| Arquivo | Casos | de testes TS / código | bordas | linhas de entrada | eventos esperados |
|---|---|---|---|---|---|
| `claude.jsonl` | 30 | 11 | 19 | 62 | 67 |
| `codex.jsonl` | 8 | 1 (cabeçalho de `codex.ts`; não há teste) | 7 | 43 | 38 |
| `copilot.jsonl` | 22 | 14 | 8 | 58 | 52 |
| `kimi.jsonl` | 19 | 12 | 7 | 48 | 50 |
| `antigravity.jsonl` | 16 | 10 | 6 | 46 | 41 |
| `generic-json.jsonl` | 15 | 8 | 7 | 48 | 47 |
| `generic-text.jsonl` | 17 | 17 (uma linha por caso, regra de `generic.ts:11-26`; não há teste) | 0 | 17 | 13 |
| `opencode-sse.jsonl` | 36 | 22 | 14 | — | 51 |
| `invocation.jsonl` | 169 | 139 | 30 | — | — |
| `manifest-schema.jsonl` | 21 | 13 | 8 | — | — |
| `failure-reason.jsonl` | 26 | 12 | 14 | — | — |

As amostras reais estão nos testes: o stream do Claude e o do Copilot (sessão
3b14c0e2, 1.0.83) do teste de integração do daemon
(`packages/daemon/src/turn-cost.integration.test.ts:28-127`), as linhas `meta` do Kimi
2.0.0, o formato 1.0.88 do Copilot e os eventos do `agy`. As bordas cobrem: linhas
inválidas (vazias, escalares JSON, banner, JSON truncado, lixo depois do JSON,
array), linha cortada pelo leitor (`[truncado N bytes]`), linha de ~70 KB, tetos de
4.000 (tool_result) e 2.000 (motivo) com CJK e emoji na fronteira, espaço
Unicode antes do `{`, chave duplicada, surrogate isolado, números extremos, custo
parcial × final × acumulado (`turn_cost`).

## Divergências conhecidas codificadas no corpus

O C deve reproduzir estes comportamentos (são o comportamento congelado), ou a
divergência tem de virar decisão explícita:

1. **Corte por unidade UTF-16, não por caractere nem byte**:
   `claude/tool-result-corte-utf16-emoji` (sobra surrogate alto isolado; o contador
   `[N chars]` conta UTF-16), `kimi/tool-sem-id-nem-nome-e-teto` (4ª linha),
   `motivoDaFalha/corte-utf16-emoji`, `claude/modelo-100-emojis` e
   `claude/modelo-101-emojis` (o teto de 200 do modelo conta UTF-16).
2. **Exceção no mapper vira `log … unparsed`** (o `try` do `#mapLine` envolve o
   mapper): `claude/excecao-no-mapper-vira-unparsed`,
   `codex/excecao-no-mapper-vira-unparsed`, `copilot/excecao-no-mapper-vira-unparsed`.
3. **Array JSON chega ao mapper como objeto** (`typeof [] === 'object'`) e vira
   `log {data:[…]}`: `claude/tipo-desconhecido-e-array`, linhas `[]` em `*/invalidas`
   e `*/linhas-invalidas`.
4. **Ramo string do `generic-json` inalcançável** pelo pipeline `jsonl`:
   `generic-json/string-json-nao-chega-ao-texto`.
5. **`trim()` do JS** aceita BOM/NBSP/U+2028/U+3000 antes do `{`:
   `claude/espaco-unicode-antes-do-json`.
6. **Prompt vazio em argv some** junto com o argumento, e `-p` fica sem valor:
   `*/oneShot-prompt-vazio` (copilot, kimi; antigravity sobra `-p=`).
   `nativeSessionId` `""` escolhe `resumeModeArgs` e some do argv: `*/resume-id-vazio`.
7. **SSE fora da especificação**: `\r\n` normalizado por chunk
   (`opencode-sse/cr-partido-entre-chunks`), `\r` solto não termina linha
   (`opencode-sse/cr-solto-nao-separa`), `trimStart` remove todo espaço depois de
   `data:` (`opencode-sse/trimstart-agressivo`).
8. **`text()` do OpenCode aceita `""`** e os mappers de linha (`firstString`) não:
   `opencode-sse/texto-vazio-vs-null`.
9. **Custo vazio presente**: `claude/result-sem-usage-nem-custo`,
   `codex/turn-completed-sem-usage`, `generic-json/custo-variantes` (`usage {}`)
   emitem `"cost":{}`, que no `TurnCostTracker` é um custo **final** e fecha o turno.

## Fora deste corpus

- O teto de 16 MiB por linha e a quebra em `\r` do `lerLinhas`: aqui as linhas já
  chegam separadas (só o efeito downstream da marca `[truncado N bytes]` está
  coberto).
- Precificação (`resolveEventCost`/`MODEL_PRICES`): `turn_cost` usa o custo como o
  mapper emite. Os asserts de `turn-cost.test.ts` que dependem de preço foram
  conferidos na parte que não depende dele (ver `:100` adaptado no crosscheck).
- `montarSpawn`/escape do `cmd.exe`, resolução de binário, árvore de processos,
  heartbeat/timeout/backpressure, transporte HTTP do OpenCode.
- Codex: não há `*.test.ts` nem amostra real do `codex exec --json` no repositório;
  as entradas seguem os tipos documentados no cabeçalho de `codex.ts`.
