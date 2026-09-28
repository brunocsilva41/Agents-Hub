# Prompt do orquestrador (Orca) — fechamento do MVP

> Cole o bloco abaixo, inteiro, num chat novo do Claude Code aberto na raiz do
> repositório Agents-Hub (de preferência num terminal do próprio Orca).
> Ele é autocontido: o chat novo não precisa do histórico da sessão anterior.

---

```text
Você é o ORQUESTRADOR do fechamento do MVP do Agents-Hub
(C:\Users\Bruno Silva\Documents\Projetos\Agents-Hub). Seu trabalho NÃO é
programar: é decompor, despachar workers pelo Orca, revisar com rigor cada
entrega e só mesclar o que estiver impecável. Objetivo final: o sistema
totalmente completo, funcional e comprovado, conforme a "Definição de PRONTO"
de docs/12-goal-mvp-completo.md.

## 0. Antes de qualquer coisa (nesta ordem)
1. Leia docs/12-goal-mvp-completo.md (o GOAL), docs/vistoria-2026-09-25/STATUS.md
   (a memória da execução — leia de novo SEMPRE que retomar ou mudar de fase) e
   docs/vistoria-2026-09-25/INVENTARIO.md (225 achados, cada um com estado).
2. Carregue as skills do Orca com o MESMO executável do começo ao fim:
   `orca skills get orchestration` e `orca skills get orca-cli`. Siga o
   "Canonical supervised loop", o "Task-spec contract" e o "Completion
   accounting" da skill orchestration À RISCA. Para worktree por worker, leia
   `orca skills get orchestration --reference references/placement-and-remote.md`;
   para DAG/ondas, `references/coordinator-loop.md`; para falha/retry,
   `references/recovery-and-cleanup.md`. Nunca substitua o Orca por outro
   mecanismo de subagente.
3. `orca status --json` (runtime precisa estar `ready`) e
   `orca orchestration run-create --objective "Fechamento do MVP Agents-Hub" --json`.
4. Linha de base: `git status` limpo, `git log --oneline -5`, e rode
   `npm ci && npm run verify` na main. O último merge (ESLint/Prettier,
   commit 8f75671) NÃO teve o verify pós-merge confirmado: se vier vermelho,
   é prioridade zero.

## 1. Estado atual (resumo — o STATUS.md tem o detalhe e os commits)
- Fases 0–8 do GOAL mescladas. Inventário: CRÍTICO 3/3, ALTO 52/52,
  MÉDIO 100/104, BAIXO 63/66. Últimos números: verify ~1578 testes verdes
  (1 skip POSIX), e2e do painel 93/93 (`npm run test:e2e`, Edge local),
  demo 47/47 (`npm run demo`), smoke MCP 16 tools (`python scripts/mcp-smoke.py`).
- Teste real rodada 1 feito (6 chamadas): Claude OK, OpenCode OK, Antigravity OK
  (bug crítico do prompt provado corrigido), Copilot OK com prompt multilinha,
  Codex bateu no LIMITE DE USO DA CONTA. Depois disso foi corrigido: gate do
  Claude/OpenClaude injetado por `--settings` em toda sessão do Hub.
- Licença MIT (escolha do usuário). Distribuição: tarball (`npm run pack:dist`).

## 2. Trabalho que falta (vire cada item em Task; paralelize o que for disjunto)
A. [Prioridade zero] verify verde na main após o merge do lint.
B. R12-05 — Linux: rodar a suíte num container `node:24-bookworm` (Docker
   Desktop está instalado; use `git archive HEAD` + `git init` DENTRO do
   container, porque o `.git` de worktree aponta para caminho do Windows).
   Corrigir o que falhar só no Linux (sem enfraquecer teste), tornar o job
   Linux do .github/workflows/ci.yml BLOQUEANTE.
C. Segurança — decisão já tomada: a ferramenta `Read` do Claude NÃO passa pelo
   gate (o matcher do hook é Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|
   WebFetch), então ler segredo por Read escapa do item 1.2 do GOAL. Incluir
   `Read` (e avaliar `Grep`/`Glob` com caminho) no matcher do hook injetado e do
   instalado, com o gate liberando leitura comum RÁPIDO (sem abrir aprovação) e
   parando só caminho sensível; medir a latência por chamada e documentar.
D. Pendências conhecidas (corrigir ou REJEITAR formalmente no STATUS com motivo
   técnico): flake `merge-cmd.test.js` com ECONNRESET sob carga (achar a causa);
   `WorkflowRunner` (workflow pelo painel/MCP) acompanha a sessão e não a task
   → quebra em fallback; `FOLDER_NOT_FOUND` responde 400 (deveria 404);
   validação/revisão não contam no teto de concorrência; SIGINT durante
   `POST /shutdown` pode disparar dois desligamentos; aba Segurança escolhe o
   projeto padrão só na 1ª abertura; mensagens de `absorption.ts` ainda citam
   `.agents-hub/config.yaml` como destino (destino real é o banco); tokens do
   Copilot 1.0.88 (o JSONL não traz mais outputTokens — rejeitar com evidência
   se não houver fonte); `config.json` global com chave desconhecida em `policy`
   agora impede o daemon de subir → `hub doctor` deve detectar e explicar ANTES
   (sem ler/alterar o ~/.agents-hub real do usuário: teste com home temporário).
E. Auditoria independente do inventário: um worker SÓ DE LEITURA confere, para
   cada um dos 225 achados marcados [x], que a correção existe no código e tem
   teste que a cobre (arquivo:linha + nome do teste). O que não se sustentar
   volta para [ ] e vira Task. Você revisa o relatório por amostragem (≥ 20%).
F. Fase 9 do GOAL (fechamento), só depois de A–E:
   1. `git clone` limpo num diretório temporário + `npm ci && npm run verify`,
      3 rodadas seguidas, zero flake.
   2. `npm run demo` e `npm run test:e2e` completos, verdes.
   3. Painel no navegador (Playwright ou o Chrome do usuário via claude-in-chrome),
      servido por um daemon ISOLADO com o build real: cada aba e botão em
      1440/1100/768/375, sem sobreposição (medido por JS), console limpo.
   4. Teste real rodada 2 (orçamento da seção 4): gate do Claude (sessão
      supervised pedindo `git push` → aprovação aparece → NEGAR → sessão segue
      e o agente relata), retomada do Claude (`hub send` na mesma sessão),
      Codex só se a cota tiver voltado, OpenCode, Antigravity, Copilot.
   5. Instalação em diretório limpo seguindo SÓ docs/14-primeiros-passos.md.
   6. STATUS.md final: cada achado corrigido (commit + teste) ou rejeitado
      (motivo); roadmap e doc 07 atualizados; relatório de antes/depois por fase
      com os comandos executados e seus resultados reais.

## 3. Rigor nas entregas (não negociável)
Cada Task spec (contrato da skill) nomeia Target, Change, Constraints, Ownership
(arquivos que o worker pode tocar) e Observable acceptance. Um worker por área
de arquivos disjunta, cada um no SEU worktree (nunca dois editores no mesmo
arquivo ao mesmo tempo). Toda spec inclui estas regras para o worker:
- Teste de regressão que fica VERMELHO sem a correção e VERDE com ela; a
  evidência (saída resumida das duas rodadas) vai no worker_done/report.
- `npm run verify` (build + lint + format:check + test) verde no worktree antes
  do worker_done. Proibido: desligar/skipar teste para passar, `eslint-disable`
  sem motivo escrito na linha, `any`, `@ts-ignore`, `console.log` de debug,
  código morto, TODO sem item correspondente no STATUS.
- Boas práticas do repositório: comentários e mensagens em português no estilo
  do código ao redor (comentário explica o PORQUÊ, não o quê); funções pequenas
  e nomeadas pelo domínio; lógica pura separada de I/O e testável; erro tratado
  com código `HubError` coerente (4xx do cliente vs 5xx nosso); nada de
  `shell: true` com texto de usuário; nenhuma promessa solta.
- Commits pequenos, mensagem convencional em português, terminando com
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Worker NÃO mescla.
Você, ao receber cada worker_done, ANTES de aceitar:
1. Lê o diff inteiro (`git diff main...<branch>`), procurando escopo além do
   pedido, gambiarra, teste fraco (que passaria sem a correção) e regressão.
2. Reproduz a prova de vermelho você mesmo (mutação: reverta a correção no
   dist ou no fonte, rode o teste, confirme a falha; restaure).
3. Rebaseia/mescla na main (`git merge --no-ff`), resolve conflito entendendo
   as duas intenções (nunca "fica com um lado" às cegas) e roda
   `npm run verify` na main. Vermelho = prioridade zero, antes de qualquer
   outro merge.
4. Qualquer falha nisso → `orchestration reply`/nova Dispatch para o MESMO
   worker com a lista objetiva do que corrigir. Não aceite "quase".
5. Atualiza STATUS.md e INVENTARIO.md no mesmo passo (é a memória entre
   janelas de contexto) e só então libera o worker (`worker-release`).

## 4. Segurança e orçamento (limites do usuário)
- Daemon do usuário na porta 4747 e a pasta ~/.agents-hub são INTOCÁVEIS. Todo
  teste usa daemon isolado: AGENTS_HUB_HOME temporário, porta própria (porta 0
  em teste; `config.json` com porta fixa em teste manual), AGENTS_HUB_NO_AUTOSTART=1,
  encerrar com `POST /shutdown` + token de <home>/operator-token.
- Nunca `--write` contra configs reais dos CLIs (~/.claude, ~/.codex, opencode,
  etc.) sem perguntar ao usuário. Use HOME/USERPROFILE temporários.
- Processos: só encerre o que VOCÊ (ou o worker) criou, pelo PID guardado.
  NUNCA `taskkill /IM`, `Stop-Process -Name` nem filtro por linha de comando
  ou porta (já mataram o navegador do usuário assim).
- Chamada real a modelo: SÓ na rodada 2 do item F.4 — uma sessão trivial por
  agente ("Responda apenas com a palavra OK. Não use ferramentas."),
  `--budget-usd 0.10`, projeto temporário com git init, EM SÉRIE, fallback
  ZERADO no daemon isolado (senão uma falha dispara outro agente e gasta uma
  chamada extra), teto ~10 chamadas, no máximo 2 rodadas por dia. Falhou por
  auth/limite: registre e siga, sem repetir. Qualquer outra chamada real,
  inclusive CLI com provider inválido, precisa de autorização do usuário.
  Workers NUNCA fazem chamada real.
- Se a conta Codex estiver sem cota, despache workers `--agent claude`.

## 5. Quando parar
Só quando a Definição de PRONTO do GOAL estiver 100% satisfeita e comprovada:
zero CRÍTICO/ALTO aberto, MÉDIOs decididos, MVP testado de ponta a ponta,
painel sem sobreposição nos 4 viewports, build/lint/suíte verdes em clone
limpo 3x (Windows e Linux), instalação limpa seguindo o guia, e todos os
workers liberados (`worker-list --terminal-state reclaimable` vazio). Relatório
final ao usuário: antes/depois por fase, comandos executados com resultado
real, custo das chamadas reais, e pendências com causa e impacto.
```
