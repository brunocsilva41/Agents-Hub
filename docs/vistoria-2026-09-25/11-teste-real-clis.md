# 11 - Teste real minimo dos CLIs (Claude, Codex, OpenCode, Antigravity, Copilot)

Ambiente: daemon isolado (porta 48207, home temporario, projeto temporario com `git init`), apagado ao final. Daemon do usuario (4747) e ~/.agents-hub nao foram tocados. Prompt: "Responda apenas com a palavra OK. Nao use ferramentas." Versoes instaladas: claude 2.1.281, codex 0.155.0, opencode (versao desconhecida), agy 1.2.6, copilot 1.0.83.

Chamadas de modelo efetivamente feitas: Claude 4 (1 start + 1 turno disparado pelo `send` + 1 turno re-executado apos `approve` + 1 gate), Codex 1, OpenCode 1 (modelo gratuito), Antigravity 1 (chamada manual, fora do hub, para validar a correcao), Copilot 1. Total 8 mais o extra do Claude descrito no achado sobre `send`/`approve` (que gerou chamadas nao pedidas).

## Resumo por agente

| Agente | Processo subiu | turn.completed | Custo/tokens | nativeSessionId | Tempo | Auth herdada | Observacao |
|---|---|---|---|---|---|---|---|
| Claude | sim | sim | US$ 0.1378 reportado (exato), hub contabilizou 0.1642; tokens 141 (cache ignorado) | sim (c44c9fea-...) | 11 s | sim | estourou o teto de 0.10 num unico turno trivial |
| Codex (supervised) | NAO (recusado pelo gate) | n/a | n/a | n/a | 1 s | n/a | sessao orfa "running" |
| Codex (semi, fallback) | sim | sim | US$ 0.0313 estimado (agent-default), 21.1k tok | sim (01a0d6bb-...) | 9 s | sim | `send` posterior recusado |
| OpenCode | sim | sim | US$ 0.0000 / 3.2k tok (modelo `space-bunny-free`) | sim (ses_f2943dc3...) | 15 s | sim | eventos brutos ruidosos |
| Antigravity | processo subiu e morreu, exit 2 | nao | 0 | nao | 1 s | nao testado via hub | flags incompativeis com agy 1.2.6 |
| Copilot | sim | so o turn.completed sintetico de saida | US$ 0.00 / 0 tok, embora tenha gasto 0.53 AI Credits | nao (so no texto de stderr) | 88 s | sim | prompt truncado, saida nao mapeada |

O que o painel/CLI mostraria: `hub graph`/`hub budget` mostraram Claude 164% do orcamento (US$ 0.1642 / 0.10), sessao em "aguardando"; Codex 31% (US$ 0.0313, 21.1k tok, 7 s); OpenCode 0% (US$ 0, 3.2k tok, 12 s); Copilot 2% (US$ 0.00, 0 tokens, 85 s), ou seja, os numeros do Copilot sao falsos por baixo; Antigravity nem chegou a ter custo.

`hub doctor` (uma vez, sem --smoke): 8 de 9 agentes disponiveis, 9,5 s; cursor nao instalado. Saida correta, mas o warning experimental do sqlite e o `(Use node --trace-warnings...)` poluem a saida de todo comando do CLI.

---

### [ALTO] Antigravity totalmente quebrado com agy 1.2.6 (`-p` engole `--output-format`)
**Evidencia:** `hub start --agent antigravity ... --mode supervised` retornou em 1 s:
`Error: -p took "--output-format" as its prompt, so the intended prompt was left as an argument and ignored. Attach the prompt to the flag (-p='your prompt') and move --output-format elsewhere` e `processo terminou com codigo 2`. O manifesto (`manifests/antigravity.yaml`) usa `oneShot: ["-p", "--output-format", "stream-json"]` com o prompt anexado depois. Chamada manual com a ordem invertida funcionou: `agy -p "Responda apenas com a palavra OK..." --output-format stream-json --mode plan` devolveu eventos `init`, `step_update` (com `usage`) e `result` com `"response":"OK\n"`, `usage.total_tokens=15305`, 10,4 s, `conversation_id` presente. O manifesto declara "VERIFICADO contra agy 1.1.22"; a maquina tem 1.2.6.
**Impacto:** o agente Antigravity nao executa nenhuma sessao. O `doctor` o marca como disponivel (`1.2.6`), entao o usuario so descobre ao usar. O mesmo vale para o `resume` (`--conversation <id> -p --output-format ...`).
**Correcao sugerida:** reordenar o template para `["--output-format","stream-json","-p","{{prompt}}"]` (ou `-p={{prompt}}`) no `oneShot` e no `resume`; adicionar teste que monta a linha de comando final e verifica que o argumento apos `-p` e o prompt; declarar versao minima do agy e fazer o `doctor` avisar quando a versao diferir da verificada.
**Esforco:** P

### [ALTO] Copilot: prompt multilinha truncado pelo cmd.exe, saida nao mapeada e custo/tokens zerados
**Evidencia:** o Copilot respondeu "Nao ha uma descricao da tarefa nem arquivos no repositorio para modificar... envie os requisitos" e chamou 4 ferramentas (glob, git status, ls-tree, Get-ChildItem), apesar de o prompt pedir "Nao use ferramentas". Duracao 88 s; consumo real no stderr: `AI Credits 0.53 (1m 18s)` e `Tokens up 56.5k (37.5k cached, 19.0k written) / down 322`. O hub registrou `custo do fluxo: US$ 0.0000 - 0 tokens`. Todos os eventos foram `log` (`stream: stdout/stderr`); o unico `turn.completed` foi o de saida do processo (`reason: exit`). `nativeSessionId` ficou `null`. Causa provavel: `manifests/copilot.yaml` passa `{{prompt}}` como argumento (`-p {{prompt}} --output-format json --no-color`) e o binario e um shim `.cmd` (`shell: true`); o brief e multilinha ("# Tarefa\n\n...") e o proprio `packages/adapters/src/process-adapter.ts` (linha ~185) documenta que "um prompt multilinha atravessando o cmd.exe quebra o comando" e oferece `{{promptFile}}`, que o Copilot nao usa. Nao verifiquei o formato do `--output-format json` na 1.0.83 (nao repeti a chamada para nao gastar); a saida recebida foi texto de terminal, nao JSONL, o que sugere que o mapper tambem nao casa com a versao instalada (manifesto cita 1.0.70 e 1.1.17; instalado 1.0.83). A causa do truncamento e inferencia pelo codigo e pela resposta do modelo, nao foi confirmada inspecionando a linha de comando real.
**Impacto:** o agente age sobre um prompt provavelmente truncado (gasto de credito sem finalidade), o budget do hub nao enxerga o consumo (2%, so por tempo) e nenhum teto dispararia para o Copilot; o fluxo de aprovacao/observabilidade nao ve eventos de ferramenta.
**Correcao sugerida:** enviar o brief por arquivo/stdin (verificar se `-p` aceita arquivo ou usar stdin); spawn direto do `node` + script do npm em vez de `.cmd` com `shell: true`; confirmar contra o binario o formato de saida e mapear o `result` (id de sessao, tokens, `AI Credits`); alinhar a versao verificada.
**Esforco:** M

### [ALTO] Orcamento: um turno trivial de Claude estoura o teto de US$ 0.10 e o hub contabiliza acima do custo real (dupla contagem)
**Evidencia:** `hub start --agent claude --budget-usd 0.10` -> `turno concluido - US$ 0.1378` e `orcamento do fluxo esgotado (US$ 0.1642 de 0.10) [budget]`. Eventos: seq 4 `reasoning` (usd 0.013189, estimado), seq 5 `message` (usd 0.013189, mesmo usage: inputTokens 2, outputTokens 4, cachedTokens 26158), seq 8 `turn.completed` (usd 0.1378276, `costBasis: reported`). 0.013189 x 2 + 0.1378276 = 0.16421 = valor consumido. Ou seja, as estimativas por mensagem (reasoning e message, mesmo usage duplicado) foram somadas ao custo reportado final em vez de substituidas. O `total_cost_usd` real do Claude foi 0.1378276. Tokens registrados: 141 (nao inclui 26158 cache read nem 16256 cache creation).
**Impacto:** (1) custo em `hub budget`/`graph` diverge do reportado (+19% aqui) e pode barrar fluxos prematuramente; (2) teto de US$ 0.10 e inatingivel para o Claude nesta maquina (o preambulo com muitos MCPs/ferramentas ja custa ~US$ 0.14 num turno de uma palavra), entao qualquer teto baixo gera aprovacao de orcamento no primeiro turno; (3) os tokens exibidos sao enganosos (141 contra ~42k processados).
**Correcao sugerida:** quando o evento final trouxer custo `reported`, substituir (nao somar) as estimativas parciais da mesma resposta; nao emitir o mesmo `cost` em `reasoning` e `message` do mesmo assistant message; incluir cache read/creation no contador de tokens (ou exibir separado); documentar um piso realista de orcamento por agente.
**Esforco:** M

### [MEDIO] Sessao orfa "running" (pid null, zero eventos) apos recusa CODEX_GATE_NOT_GUARANTEED
**Evidencia:** `hub start --agent codex --mode supervised` respondeu `[CODEX_GATE_NOT_GUARANTEED] Sessao em modo "supervised", mas o gate pre-execucao do Codex nao esta garantido...` em 1 s, sem chamada ao modelo. Depois, `hub status`: `1 ativa(s) de 4 no historico: rodando ses_0dca09b6... codex Responda apenas...`. API: `"state":"running","pid":null,"nativeSessionId":null,"endedAt":null` e `GET /sessions/<id>/events` -> `{"events":[]}`. So sumiu com `hub cancel` manual.
**Impacto:** cada recusa de gate deixa uma sessao fantasma "viva" (conta como ativa, pode ocupar limite de concorrencia e nunca expira sozinha).
**Correcao sugerida:** criar a sessao somente depois da checagem do gate, ou marcar como `failed` com `session.ended` no ramo do erro.
**Esforco:** P

### [MEDIO] Codex supervised e recusado nesta maquina; `hub send` em sessao concluida e recusado (retomada nativa nao validada)
**Evidencia:** o gate exige confianca de hook concedida no TUI do Codex ou bypass explicito (comportamento seguro). O teste foi feito em `--mode semi` (prompt sem ferramentas, nenhum arquivo alterado): `turn.completed` com 21077 input / 31 output / 3840 cached, US$ 0.0313 `estimated`, `costConfidence: agent-default`, `costModel: gpt-5-3-codex`, thread id 01a0d6bb-... capturado, 7 s. O `hub send` posterior: `[ILLEGAL_STATE] A sessao ses_08d6... ja terminou (completed). Abra uma sessao nova ou delegue a partir de outra.` (sem chamada ao modelo). O final do `hub start` dizia `aguardando o portao de validacao`, sugerindo sessao ainda aberta, mas o estado era `completed`.
**Impacto:** a retomada nativa do Codex nao pode ser exercida por `send` em sessao concluida; a mensagem de fim de turno e contraditoria com o estado real.
**Correcao sugerida:** ou permitir `send` em `completed` usando o `nativeSessionId` salvo (promessa de `session.strategy: native`), ou corrigir o texto do CLI e sugerir o caminho correto.
**Esforco:** M

### [MEDIO] Supervised do Claude sempre dispara aprovacao por escrever o arquivo de plano em ~/.claude/plans
**Evidencia:** pedido "Crie um arquivo chamado teste.txt ... usando a ferramenta Write" em supervised (Claude entra em plan mode). Resultado: `file.changed` (`Write`) em `C:\Users\Bruno Silva\.claude\plans\tarefa-crie-um-atomic-tulip.md`, `approval.requested` com `risk: escalate`, `reason: escrita fora do diretorio da sessao`, `kind: watch`, `alreadyExecuted`; sessao encerrada como `aguardando aprovacao`. O arquivo de plano ja existia (553 bytes) quando a aprovacao apareceu; `hub deny` (no daemon isolado) encerrou a sessao (`killed`) mas nao reverteu o arquivo (removi manualmente depois). `teste.txt` nao foi criado (plan mode). O gasto real nao foi capturado: `hub budget` mostrou US$ 0.0002 / 10 tokens porque a sessao foi morta antes do `turn.completed`.
**Impacto:** (1) supervised do Claude gera aprovacao inutil no primeiro turno de qualquer pedido de mudanca (o plano e do proprio Claude), treinando o usuario a aprovar sem ler; (2) aprovacao retroativa: negar nao desfaz; (3) custo real perdido quando a sessao e morta no meio do turno; (4) o teste de gate com escrita no projeto nao chega a acontecer em supervised porque o plan mode impede a escrita. O mecanismo de aprovacao/negacao em si funcionou.
**Correcao sugerida:** tratar `~/.claude/plans/**` como caminho permitido em plan mode (allowlist por agente); mostrar o plano como artefato e pedir uma aprovacao para executar; ao negar/matar, ainda coletar o custo final.
**Esforco:** M

### [MEDIO] `send` em sessao bloqueada por orcamento e `approve` disparam turnos extras nao pedidos e aprovacoes duplicadas
**Evidencia:** `hub send <id> "Qual foi a palavra..."` com sessao em `waiting_approval` imprimiu `sessao nativa retomada` e reimprimiu o stream antigo (04:01:29..33, "turno concluido - US$ 0.1378") sem resposta nova. Nos eventos, um novo `session.started` apareceu ~40 s depois (04:02:15), respondeu "OK" (US$ 0.0213 estimado) e gerou outra aprovacao de budget (0.1855). Ao `hub approve` do primeiro budget, o hub "ampliou" o orcamento para US$ 0.20 e rodou OUTRO turno nativo (04:02:29, US$ 0.0227 estimado), que estourou de novo (0.2083 de 0.20) e criou uma terceira aprovacao; `hub approvals` listou duas delas ao mesmo tempo, uma obsoleta. O `session.ended` antigo (seq 17) reaparece com a razao do budget anterior.
**Impacto:** (1) aprovar orcamento re-executa turno e gasta assinatura; (2) fila de aprovacoes duplicadas/obsoletas; (3) o CLI mostra saida antiga como se fosse resposta; (4) o teto "ampliado" dobra silenciosamente (0.10 -> 0.20, tokens e tempo tambem) sem o usuario escolher o valor.
**Correcao sugerida:** `send` em sessao bloqueada deve responder na hora "bloqueada pela aprovacao X" e nao enfileirar; resolver/expirar aprovacoes obsoletas do mesmo `sessionId` e `kind`; deixar o usuario informar o novo teto no `approve`; nao reexecutar turno ao aprovar se o turno anterior ja concluiu com sucesso.
**Esforco:** M

### [BAIXO] Saida do CLI/stream: eventos crus, linhas vazias e brief ecoado
**Evidencia:** OpenCode: `hub start` imprimiu duas vezes o brief inteiro ("# Tarefa ... ## Ao terminar Responda com um resumo curto...") como mensagem de agente (eventos `log` `session.next.prompt.admitted`/`prompted`), linhas JSON cruas (`{"timestamp":...,"sessionID":...,"reasoningID":...}`) e `message.delta {"text":"OK","textId":"text-0"}` antes do `OK`; dos 13 eventos, 8 sao `log` `session.next.*` nao mapeados. Claude: 4 linhas vazias antes do `OK` (`thinking_tokens` e reasoning vazio) e uma linha `{"type":"rate_limit_event",...}` crua. Todo comando do CLI imprime `ExperimentalWarning: SQLite is an experimental feature` e `(Use node --trace-warnings ...)`. Codex e OpenCode emitem dois `turn.completed` por turno (um com custo, outro `reason: exit`). O Codex mostrou `failed to load skill ...universal-agent-guide\SKILL.md: missing YAML frontmatter` como log (vem do ambiente do usuario, nao do hub).
**Impacto:** ruido no terminal/painel; risco de contar `turn.completed` em duplicidade em consumidores que assumem 1 por turno.
**Correcao sugerida:** rebaixar para `debug` os `session.next.*`, `thinking_tokens` e `rate_limit_event`; nao ecoar o prompt do usuario como mensagem de agente; suprimir o warning do sqlite (`--disable-warning=ExperimentalWarning`); usar tipo distinto para o fim de processo (ex.: `process.exited`).
**Esforco:** P

### [BAIXO] Manifestos apontam para versoes verificadas diferentes das instaladas
**Evidencia:** antigravity "verificado 1.1.22" vs agy 1.2.6 instalado (quebrado); copilot cita 1.0.70 (comentario do invoke) e 1.1.17 (caveat de modeArgs) vs 1.0.83 instalado; opencode aparece como "versao desconhecida" no `doctor`.
**Impacto:** o `doctor` diz "disponivel" mesmo com manifesto desatualizado para a versao instalada; deriva silenciosa como a do Antigravity.
**Correcao sugerida:** campo `verifiedVersions` no manifesto, aviso no `doctor` fora da faixa e teste de montagem de linha de comando por agente (sem chamar o modelo).
**Esforco:** P

---

## Verificado OK

- `hub doctor` (sem --smoke): 9,5 s, detectou 8/9 agentes com versao e caminho, cursor ausente reportado com dica.
- Daemon isolado subiu com `AGENTS_HUB_HOME`/porta 48207; `/shutdown` encerrou limpo (health retornou `down`); tmp removido.
- Claude: processo subiu, eventos normalizados (`session.started`, `reasoning`, `message`, `turn.completed` com `costBasis: reported`, `costConfidence: exact`), `nativeSessionId` capturado, auth herdada do login existente funcionou, 11 s; o teto `--budget-usd` detectou o estouro e bloqueou com aprovacao (mecanismo funciona, apesar da contagem inflada).
- Gate de aprovacao: aparece em `hub approvals` com risco/motivo; `hub deny` encerrou a sessao (`killed`) e registrou `approval.resolved: denied`; `hub approve` retomou a sessao com o mesmo nativeSessionId (resume nativo do Claude confirmado: 26158 tokens de cache lidos).
- Codex: em supervised o hub recusa em vez de rodar sem prevencao (mensagem clara). Em semi, turno completo com tokens, custo estimado, modelo e thread id corretos; sem ferramentas nem alteracao de arquivos.
- OpenCode: `turn.started`, `reasoning`, `message`, `turn.completed` (3184 in / 62 out / 130 cache), modelo identificado (`space-bunny-free`), custo 0 coerente com modelo gratuito, id nativo capturado, 12 s.
- Antigravity: binario e autenticacao funcionam (chamada manual com a ordem certa devolveu `OK`, `usage` e `conversation_id`); o problema e so a linha de comando do manifesto.
- `hub graph` e `hub budget` renderizam custo, tokens e tempo coerentes com os eventos armazenados.
- Nenhum arquivo do repositorio foi alterado; o arquivo de plano criado em `~/.claude/plans/` pelo teste do gate foi removido; nenhuma sessao/aprovacao do usuario foi tocada.
