# Corpus de conformidade: classificador, tokenizador e caminhos sensíveis (CONF-01)

Saída **gerada** a partir do TS congelado (`packages/core/src`). Não edite à mão: regenere.
A conformidade do C (`native/src/core/`) se prova reproduzindo cada linha destes arquivos.

## Origem

| Item | Valor |
|---|---|
| `git rev-parse --short HEAD` na geração | `ba96da0` (sem diferença em `packages/` desde `c3ecbee`) |
| Último commit que mexeu nas fontes | `b10bcb4` (2026-09-28): `command-classifier.ts`, `shell-tokenizer.ts`, `sensitive-paths.ts`, `policy.ts` |
| SHA-256 das fontes | `corpus-meta.json` → `fontesSha256` (calculado sobre o texto normalizado para LF; não muda com `core.autocrlf`) |
| Plataforma / Node | `win32` (`corpus-meta.json`) / gerado com Node v24.14.0 (a versão exata não vai para o `corpus-meta.json`; requisito: Node ≥ 22.15 com `--experimental-transform-types`) |
| Home fixo / cwd / workdir padrão | `C:\Users\conformance` / `C:\` / `C:\tmp\hub\worktree` |

O `dist/` não é usado: o gerador importa o `.ts` direto, com `node --experimental-transform-types`
e o hook de resolução `.js → .ts` em `../tools/ts-hook.mjs`.

## Como regenerar

Na raiz do repositório:

```
node --experimental-transform-types native/tests/conformance/tools/gen-classifier.mjs
```

- `--saida <dir>` grava em outro diretório (para comparar sem sobrescrever).
- `--listar` imprime no stderr cada conferência com teste TS (`OK`/`FALHA`, `arquivo:linha`).
- Termina com código 1 se algum caso extraído dos testes TS não der o resultado que o teste espera.
  Nesse caso **nada é gravado**: o corpus existente fica intacto.
- Não escreve em `packages/`, não sobe daemon e não acessa rede. Fixa `HOME`/`USERPROFILE` e o
  cwd dentro do próprio processo, então a saída não depende de quem roda nem de onde.

Determinismo: duas execuções seguidas dão bytes idênticos (os hashes ficam em
`corpus-meta.json` → `arquivosSha256`).

## Arquivos

Todos em UTF-8, uma linha por registro (JSON Lines), `\n` no fim de cada linha. Em todos:
`id` (estável enquanto a lista de casos não mudar), `spec` (seção da SPEC-04 coberta),
`origem` (opcional: `arquivo:linha` de teste TS ou da SPEC de onde o caso veio) e `teste`
(opcional: o que aquele teste TS afirma; o gerador confere cada afirmação).

### `classifier.jsonl` — 2759 casos

```json
{"id":"teste-001","spec":"…","cmd":"git status && git push","opts":{"workdir":"C:\\tmp\\hub\\worktree"},
 "risk":"irreversible","reason":"git push publica no remoto [em \"git push\"]","origem":["…:30"],"teste":[…]}
```

- `cmd`: texto passado a `PolicyEngine.classify({kind:'command', command}, ctx)`, que monta o
  `CommandPolicyView` e chama `classifyCommand` (`policy.ts:771-781`).
- `opts`: os parâmetros reais da chamada. Campo ausente = valor de `default-policy.json` (para
  `allow`, `deny`, `allowDomains`, `denyFragments`, `allowWriteOutsideWorkdir`) ou ausente no
  contexto (`hubPorts` ausente = porta 4747; `agentDirs` ausente = nenhum).
  - `workdir` (sempre): `ctx.workdir`, diretório da sessão (worktree).
  - `hubPorts`: `ctx.hubPorts`, portas do daemon para `alvoDoDaemon`.
  - `agentDirs`: `ctx.agentDirs` (diretórios do próprio agente, ver `agentOwnDirs`).
  - `allow`, `deny`: `commands.allow/deny` da política.
  - `allowDomains`: `network.allowDomains`.
  - `denyFragments`, `allowWriteOutsideWorkdir`: `paths.*` (usados por `classifyWrite`).
- `risk`, `reason`: o veredito. `denied: true` só aparece quando casou a deny list (o `decide`
  devolve `deny` em qualquer modo).
- `teste[]`: `{origem, campo: "risk"|"reason"|"denied"|"decision", op: "equal"|"notEqual"|"in"|
  "notIn"|"startsWith", valor, mode?}`. `decision` é `PolicyEngine.decide` no `mode` dado com
  `DEFAULT_POLICY.risk`.
- `divergencia` (opcional): o caso codifica uma divergência conhecida (lista abaixo).

Casos por grupo (o prefixo do `id`): `corpus-meta.json` → `contagem.classifierPorGrupo`.
224 casos vêm de testes TS (`command-classifier.test.ts`, `daemon-loopback.test.ts`,
`policy.test.ts`, `watch.test.ts`, `policy-schema.test.ts`, `policy-edit.test.ts`); os 14
exemplos da SPEC-04 A6 estão marcados com `origem` em `docs/especificacao/04-dominio-e-adapters.md:591-604`;
o resto são casos de borda por regra, com o resultado **atual** do TS.

### `tokenizer.jsonl` — 2784 entradas

```json
{"id":"T0001","spec":"SPEC-04 A6 Tokenização","input":"…","tokens":[{"words":[{"posix":"echo","win":"echo","dynamic":false,"quoted":false}],"redirects":[{"op":">","fd":"2","target":{…}|null}]}]}
{"id":"T0049","spec":"SPEC-04 A6 Tokenização","input":"a >","error":"redirecionamento \">\" sem alvo"}
```

- Saída de `parseShell(input)`: `tokens` (lista plana de segmentos) **ou** `error` (mensagem
  da `ShellParseError`).
- A substituição de comando aparece no texto da palavra como o marcador `SUBST_PLACEHOLDER`
  (`"\u0000subst\u0000"`, `shell-tokenizer.ts:60`).
- Inclui os testes do tokenizador (`command-classifier.test.ts:406-433`), bordas de cada regra e
  de cada erro, e **todos** os `cmd` de `classifier.jsonl` (o classificador chama
  `parseShell(cmd.trim())`; aqui a entrada vai sem `trim`).
- `teste[]` aqui é a lista das linhas de teste TS conferidas (as projeções conferidas estão no
  gerador).

### `sensitive.jsonl` — 1659 registros

```json
{"id":"S0002","spec":"SPEC-04 A7","kind":"matchSensitivePath","path":"a/.env","resultado":{"kind":"secret","label":".env"}}
```

`kind` diz qual função foi chamada:

| `kind` | Chamada | `resultado` |
|---|---|---|
| `matchSensitivePath` | `matchSensitivePath(path)` | `{kind, label}` ou `null` |
| `matchSecretPath` | `matchSecretPath(path)` | `{kind:"secret", label}` ou `null` |
| `pathSegments` | `pathSegments(path)` | lista de segmentos |
| `fragmentMatches` | `fragmentMatches(path, fragment)` (campo extra `fragment`) | booleano |
| `agentOwnDirs` | `agentOwnDirs(agent, path, env)` (`path` = home; campos extras `agent`, `env`) | lista |
| `policy.file.read` / `policy.file.write` | `PolicyEngine.classify({kind:'file.read'/'file.write', path}, ctx)` com `opts` (mesmo formato do classificador) | `{risk, reason}` |

### `default-policy.json`

`commands`, `paths` e `network` de `DEFAULT_POLICY` (`policy.ts:510-659`), lidos do módulo na
geração. É a base sobre a qual `opts` aplica as diferenças.

### `corpus-meta.json`

Plataforma, versão do Node, ambiente fixo, SHA-256 das fontes TS e dos arquivos gerados, contagens.

## Divergências conhecidas codificadas (decisão do dono: reproduzir ou corrigir)

1. **`-S` de `cp`/`mv`/`ln` (e aliases `copy`, `xcopy`, `robocopy`, `move`, `ren`, `rename`).**
   Registrada na SPEC-04 A6 (observação após "Flags que recebem valor"): `-S` está no conjunto de
   flags com valor (`command-classifier.ts:1478,1494,1499`), mas `positional` compara a flag em
   minúsculas (`:1427`), então `-S` nunca casa e o valor dele vira posicional. Casos com o campo
   `divergencia`: `divergencia-S-001` a `divergencia-S-019`. Onde isso muda o risco hoje:
   `divergencia-S-007` (`mv -S /etc/bak a b` → `escalate`, porque `/etc/bak` vira alvo de escrita),
   `-015` (`move`), `-016` (`ren`), `-017` (`rename`), `-003`/`-012` (o destino real está fora; o
   risco seria o mesmo com a flag consumida). `divergencia-S-020` a `-022` são contraste
   (`--suffix`, que casa); `divergencia-S-023` (`mv -t /etc/x a`) é da divergência 2.

### Observado nesta geração, não registrado na SPEC (a confirmar pelo dono)

2. **Valor de `-t`/`--target-directory` é descartado.** Em `cp`/`mv`/`ln`, `positional` consome o
   valor de `-t`/`--target-directory` (`command-classifier.ts:1427,1478,1494,1499`) e ele não entra
   como alvo de escrita; `--target-directory=<dir>` (com `=`) é tratado como flag sem valor, e o
   diretório também não é classificado. Resultado atual: `write` (razão: só o nome do comando),
   embora todos escrevam em `/etc`. Casos com o campo `divergencia`: `escrita-144`
   (`cp -t /etc a b`), `escrita-145` (`cp --target-directory /etc a`), `escrita-157`
   (`mv -t /etc a`), `escrita-168` (`ln -t /etc a`), `divergencia-S-023` (`mv -t /etc/x a`),
   `divergencia-t-001` a `-003` (`cp`/`mv`/`ln --target-directory=/etc a`).
3. **Razões abreviadas na SPEC-04 A6 "Exemplos".** Para `$CMD a`, `echo "unterminated` e
   `bash -c "curl http://127.0.0.1:4747/"`, a coluna "Razão devolvida" da SPEC é um prefixo (ou usa
   `(...)`) da razão real. O corpus guarda a razão completa; o gerador confere a SPEC por prefixo/
   sufixo. Casos: `spec-004`, `spec-007`, `spec-003`.

## Substituições feitas ao extrair os testes TS

- Home: os testes usam `os.homedir()` real; aqui é `C:\Users\conformance` (fixo).
- `policy-edit.test.ts:74,79` usa `workdir = os.tmpdir()`; `policy-schema.test.ts:71` usa
  `process.cwd()`: aqui, o workdir padrão. Nos dois o caminho classificado fica fora do workdir, como
  no teste.
- `policy-schema.test.ts:63-71` e `command-classifier.test.ts:240-249` usam políticas com outro mapa
  `risk`; o mapa não entra na classificação (só no `decide`), então o caso usa os `opts` padrão.

## Fora deste corpus

- Ação `network` (WebFetch) do `PolicyEngine` (`daemon-loopback.test.ts:101-104`,
  `policy.test.ts:74`): não passa pelo classificador de comandos.
- `adapters/src/guarded-actions.test.ts`: testa a extração de ações de eventos, não a classificação.
- **Variante POSIX (Linux): falta.** O `path` do Node muda com a plataforma (`path.resolve`,
  `isInside`), então os resultados que dependem de caminho valem só para `win32`. Ela não foi
  gerada de propósito. Rodar o mesmo comando no Linux gravaria a variante POSIX (home
  `/home/conformance`, workdir `/tmp/hub/worktree`) **por cima** destes arquivos. Onde guardar as
  duas variantes (subpasta por plataforma, sufixo no nome, ou só uma plataforma no CTest) depende
  de decisão do dono: a tabela de decisões em aberto de `docs/17-plano-reescrita-c.md` (DA-01 a
  DA-29) não tem item para isso, e o F0-13 não define o formato.
