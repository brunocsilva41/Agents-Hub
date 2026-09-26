# 12 - Qualidade da suite e do CI (HEAD 6e2730e, Node v24.14.0, npm 11.12.0, Windows 10)

Metodo: `git clone` local para diretorio temporario, `npm ci`, `npm run build` (do zero, sem dist/tsbuildinfo), suite 3x.
Observacao: o script `verify` = `npm run build && npm test`; rodei o build e depois a suite 3x diretamente com `node --test` (mesmos arquivos que run-tests.mjs descobre), variando `--test-concurrency`.

## Resultados medidos
- `npm ci`: 26 s. Aviso: "1 moderate severity vulnerability".
- `npm run build` (tsc -b de 7 pacotes + tsc --noEmit + vite build da web) do zero: 30 s. Sem warnings de TypeScript nem do vite. Web: 289 kB JS (87 kB gzip).
- Suite: 517 testes, 517 pass, 0 fail, 0 skipped, 0 todo, em todas as 3 execucoes.
  - concorrencia 16: 2m21s; concorrencia 1: 3m39s; concorrencia 16: 2m14s.
  - Nenhum teste flaky observado em 3 rodadas (nao prova ausencia; ver MEDIO abaixo sobre timers).

---

### [MÉDIO] Sem LICENSE, sem campo `license` nos package.json
**Evidência**: `ls LICENSE*` -> "No such file"; `grep license package.json packages/*/package.json` -> nada; `git ls-files | grep LICENSE` vazio.
**Impacto**: sem licenca o codigo e "todos os direitos reservados" por padrao; impede uso/contribuicao por terceiros e o `npm` avisa sobre licenca ausente em publicacao. O README/CONTRIBUTING convidam a clonar.
**Correção sugerida**: escolher licenca (MIT/Apache-2.0), adicionar LICENSE e `"license"` no package.json raiz e nos pacotes.
**Esforço**: P

### [MÉDIO] Modulos relevantes sem nenhum teste (nem direto nem por nome)
**Evidência**: heuristica arquivo-par `*.test.ts` + grep de simbolos exportados nos testes:
- `packages/daemon/src/reaper.ts` (WorktreeReaper, 99 linhas): 0 referencias em testes.
- `packages/daemon/src/project-registry.ts` (ProjectRegistry, 151 linhas): 0 referencias em testes.
- `packages/cli/src/workflow-cmd.ts` (319), `hooks-install.ts` (136), `daemon-control.ts` (107), `render.ts` (169; so aparece via daemon-run.test.ts, sem teste de formatacao): sem teste dedicado.
- `packages/client/src/index.ts` (448 linhas, cliente HTTP/SSE usado por cli, mcp e web): sem teste proprio (so exercitado indiretamente em cli/doctor-smoke e mcp/server.test.ts).
- `packages/web` (4 arquivos, `useHubState.ts` 356 linhas, `eventView.ts`, `actions.ts`): zero testes; so typecheck+vite build.
- `packages/adapters/src/registry.ts` (AgentRegistry, 222 linhas): so tocado indiretamente por daemon/absorption.test.ts e api-tasks.test.ts.
- `packages/cli/src/main.ts` 1327 linhas e `daemon/src/session-manager.ts` 2667 linhas: sem teste par; session-manager e referenciado em 6 testes (cobertura indireta razoavel, mas o arquivo e enorme e sem cobertura medida).
**Impacto**: reaper (limpeza de worktrees, operacao destrutiva) e hooks-install (escreve em configs do usuario) sao codigo de risco sem rede de seguranca; regressao na web/client so aparece em uso real.
**Correção sugerida**: testes de unidade para WorktreeReaper (com repo git temporario), ProjectRegistry, hooks-install (diretorio HOME temporario), workflow-cmd; testes de contrato do client contra um daemon in-process; considerar vitest/jsdom (ou node:test) para eventView/useHubState.
**Esforço**: G

### [MÉDIO] Nao ha medicao de cobertura nem gate de cobertura
**Evidência**: `npm test` = `node scripts/run-tests.mjs` que roda `node --test --experimental-sqlite <arquivos>` sem `--experimental-test-coverage`; ci.yml nao tem passo de cobertura.
**Impacto**: a lista acima e por heuristica; nada impede queda de cobertura.
**Correção sugerida**: rodar `node --test --experimental-test-coverage` (disponivel no Node 22) num job informativo e publicar o resumo; definir limiar minimo por pacote depois.
**Esforço**: P

### [MÉDIO] Sem lint nem formatador
**Evidência**: `git ls-files | grep -E "eslint|prettier|editorconfig"` vazio; nenhum script `lint`/`format` no package.json.
**Impacto**: erros que tsc nao pega (promises flutuantes - o incidente de 2026-09-18 citado no ci.yml foi exatamente uma Promise serializada como `{}` -, `no-misused-promises`, imports mortos) passam. Estilo depende de disciplina.
**Correção sugerida**: ESLint com typescript-eslint (regras `no-floating-promises`, `no-misused-promises`, `await-thenable`) como passo do CI + Prettier/.editorconfig.
**Esforço**: M

### [MÉDIO] Job Linux e informativo (continue-on-error) e nao roda a Web build isolada; portao so exige Windows
**Evidência**: `.github/workflows/ci.yml`: `verificar` roda apenas `windows-latest` (Node 22.5 e 24); `explorar-linux` tem `continue-on-error: true` e so Node 24; `portao-de-qualidade` tem `needs: [verificar]` apenas. O README declara Linux como nao suportado ate estabilizar.
**Impacto**: regressao em Linux/macOS nao bloqueia; nao ha visibilidade de se o job Linux esta verde (nao consegui ver historico de Actions - somente leitura local). Pontos positivos: Node minimo 22.5 e testado, web build coberto (`npm run build --workspace @agents-hub/web`).
**Correção sugerida**: verificar historico do explorar-linux; se verde de forma estavel, promover a bloqueante e incluir Node 22.5 no Linux. Confirmar que branch protection exige o check `portão de qualidade` (o proprio workflow avisa que sem isso nao bloqueia nada; nao verificavel localmente).
**Esforço**: P

### [BAIXO] `npm audit`: 1 vulnerabilidade moderada (qs), transitiva
**Evidência**: `npm audit` -> `qs 2.2.5 - 6.15.3 moderate` (GHSA-x5fp-wj9c-mxmx array-limit bypass; GHSA-4mjr-xmp4-gh2g DoS via isBuffer), `node_modules/qs`, "fix available via `npm audit fix`". Vem via @modelcontextprotocol/sdk (express) - nao verifiquei o caminho exato de dependencia. O job de CI usa `--omit=dev` e e informativo.
**Impacto**: baixo se o daemon nao parseia query string com `qs` de fontes nao confiaveis; ainda assim o daemon escuta em localhost.
**Correção sugerida**: `npm audit fix` / bump do @modelcontextprotocol/sdk para 1.30.1 e commitar o lockfile.
**Esforço**: P

### [BAIXO] Dependencias com patch/minor pendentes; majors adiante
**Evidência**: `npm outdated`: sdk 1.30.0->1.30.1, yaml 2.9.0->2.9.1, react/react-dom 19.2.8->19.3.0, @types/react(-dom) ->19.3.0, @types/node 22.20.1->22.20.4 (ok, alinhado ao piso 22). Majors disponiveis: zod 3.25.76->4.6.5, vite 6.4.3->8.3.1, @vitejs/plugin-react 4.7.0->6.1.1, typescript 5.9.3->7.0.2.
**Impacto**: dividas menores; zod 4 e vite 8 exigem migracao.
**Correção sugerida**: habilitar Dependabot/Renovate; aplicar patches/minors agora.
**Esforço**: P (patches) / M (majors)

### [BAIXO] Testes dependem de timers reais (risco latente de flakiness)
**Evidência**: `grep -rn "setTimeout\|sleep(" packages/*/src --include=*.test.ts | wc -l` -> 30 ocorrencias. Suite leva 2m14s-3m39s. 3 execucoes (concorrencia 16, 1, 16) sem falha.
**Impacto**: em runners Windows lentos do GitHub, esperas fixas podem falhar de forma intermitente; a suite ficou estavel aqui.
**Correção sugerida**: trocar sleeps por polling com condicao (`waitFor`) e timeout generoso; rodar a suite com `--test-concurrency=1` num job noturno.
**Esforço**: M

### [BAIXO] `verify` nao roda o typecheck/erros da web separadamente; `typecheck` duplica o build
**Evidência**: `build` = `tsc -b && npm run build --workspace web` e `verify` = `build && test`; funciona (build do zero passou), so ha redundancia (`typecheck` e subconjunto de `build`). Sem impacto funcional.
**Impacto**: nenhum relevante.
**Correção sugerida**: nenhuma necessaria.
**Esforço**: P

---

## Verificado OK
- Clone limpo: `npm ci` + build completo do zero passam sem erros nem warnings (30 s); 517/517 testes verdes em 3 rodadas, concorrencia alta e baixa; sem `.skip`/`.only`/`.todo` nos testes.
- `scripts/run-tests.mjs` descobre recursivamente todos os `*.test.js` sob `packages/*/dist`, falha (exit 1) se achar zero, independe do shell; passa `--experimental-sqlite` (necessario no Node 22.5). O CI roda build antes dos testes, entao o dist esta presente.
- Nenhum arquivo de teste sem assercao (checagem: contagem de assert/expect >= contagem de it/test em todos os `*.test.ts`); sem `assert(true)`.
- TypeScript estrito: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `isolatedModules`, `composite`; web tambem `strict`.
- `engines.node >= 22.5.0` no package.json e CI cobre exatamente 22.5 e 24; usa `npm ci`; concorrencia com cancel-in-progress; passo que garante checkout limpo apos build/testes; gate unico `portao-de-qualidade`; `npm audit --omit=dev` reportado (informativo); web build coberto no CI.
- `.gitignore` cobre node_modules, dist, tsbuildinfo, .env, exports de sessao; git status do clone limpo apos build+testes (checagem do ultimo passo do CI reproduzida localmente: o clone nao ficou sujo pelo build; a suite nao foi checada com `git status` apos testes no clone - nao verificado).
- Nao consegui verificar: historico real de execucoes no GitHub Actions e regras de branch protection (sem acesso).
