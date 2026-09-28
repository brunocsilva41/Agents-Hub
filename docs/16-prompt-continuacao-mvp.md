# Prompt de continuação — fechamento do MVP (2ª sessão do orquestrador)

> Cole o bloco abaixo, inteiro, num chat novo do Claude Code aberto na raiz do
> repositório Agents-Hub. Ele é autocontido: o chat novo não precisa do
> histórico da sessão anterior. Substitui o de docs/15 (que já foi executado
> em boa parte — ver STATUS.md).

---

```text
Você é o ORQUESTRADOR da 2ª sessão de fechamento do MVP do Agents-Hub
(C:\Users\Bruno Silva\Documents\Projetos\Agents-Hub). Seu trabalho NÃO é
programar: é decompor, despachar workers pelo Orca, revisar com rigor cada
entrega (diff inteiro + prova de mutação reproduzida por você + verify na main
após cada merge) e só mesclar o que estiver impecável. Objetivo: a "Definição
de PRONTO" de docs/12-goal-mvp-completo.md 100% satisfeita e comprovada.

## 0. Antes de qualquer coisa (nesta ordem)
1. Leia docs/12-goal-mvp-completo.md (o GOAL) e docs/vistoria-2026-09-25/STATUS.md
   — em especial as seções "Auditoria independente do inventário",
   "Execução do orquestrador (run_81daa95a2983)" e "Passagem 2" (o estado exato
   em que a sessão anterior parou). INVENTARIO.md tem o estado por achado.
2. Carregue as skills do Orca com o MESMO executável do começo ao fim:
   `orca skills get orchestration` e `orca skills get orca-cli`. Siga o
   "Canonical supervised loop", o "Task-spec contract" e o "Completion
   accounting" À RISCA. Referências sob demanda: placement-and-remote.md
   (worktree por worker), coordinator-loop.md (ondas), recovery-and-cleanup.md
   (falha/retry). Nunca substitua o Orca por outro mecanismo de subagente.
3. `orca status --json` (runtime `ready`) e
   `orca orchestration run-create --objective "Fechamento do MVP — sessão 2" --json`.
4. Linha de base: `git status` limpo, `git log --oneline -8` (a main local tem
   TODOS os merges das ondas 1–3; nada foi enviado a remoto), e rode
   `npm ci && npm run verify` na main (última medição: 1747 testes, 0 falhas,
   1 skip POSIX). Se vier vermelho, prioridade zero.
   Atenção: se o seu shell exportar FORCE_COLOR, testes de "stderr limpo"
   podem acusar aviso do Node — o bin.test já se protege; padrão a seguir se
   aparecer outro caso.

## 1. Estado herdado (resumo — STATUS.md tem o detalhe)
- Ondas 1–3 da sessão anterior CONCLUÍDAS e mescladas: auditoria independente
  dos 225 achados (3 workers só-leitura; 22 amostras conferidas pelo
  coordenador, 100% batendo), gate com Read/Grep no matcher (caminho rápido
  ~125 ms p50, SECURITY.md tem a tabela), lista D inteira do doc 15 (WorkflowRunner
  segue a task, FOLDER_NOT_FOUND 404, teto de concorrência no fechamento,
  shutdown idempotente, auto_vacuum incremental 203→112 MB, flake merge-cmd com
  causa raiz provada, doctor explica config.json inválido, absorção cita o
  banco, aba Segurança segue o filtro, tokens do Copilot 1.0.88 REJEITADO com
  evidência), segurança da auditoria (R05-03 gate fecha loopback ao daemon e
  CLI de operador; R05-07 import não grava segredo; R05-10 raízes proibidas;
  R05-05 mcp__* com segredo), watch×fallback pelo caminho real (follow-task.ts
  removido), OpenCode provider/model, web (Nova Sessão validada e preservada,
  ARIA, 375px, e2e 101/101).
- Job Linux do CI agora é BLOQUEANTE e o smoke MCP roda nele — mas a suíte no
  Linux está VERMELHA (7 falhas, lista na Passagem 2 do STATUS). Nada foi
  pushado, então o CI remoto ainda não quebrou: conserte antes de qualquer push.
- Orçamento de chamadas reais já gasto: vistoria ~9 + rodada 1 = 6. A rodada 2
  do teste real AINDA NÃO FOI FEITA.

## 2. Trabalho que falta (vire cada item em Task; paralelize o que for disjunto)
A. [Prioridade zero] As 7 falhas do Linux (Passagem 2 do STATUS lista 6; rode o
   container para capturar a 7ª). Corrigir SEM enfraquecer teste — só skip por
   plataforma quando o teste é intrinsecamente de outra plataforma, com motivo
   na linha. Receita do container (o .git de worktree aponta para caminho
   Windows, por isso o archive):
   git archive HEAD | docker run --rm -i --init node:24-bookworm bash -c
   "mkdir /app && tar -x -C /app && cd /app && git init -q &&
    git config user.email ci@local && git config user.name ci &&
    git add -A -f && git commit -qm base && npm ci && npm run verify"
   Atenção ao caso event-flood ("/health < 500 ms" levou 67 s no container):
   decidir com medição se é recurso do container ou regressão real no Linux.
B. Daemon (restos): R13-13 reaberto (SSE /api/tasks/:id/events ignora
   Last-Event-ID — implementar replay a partir dele ou rejeitar formalmente
   com motivo técnico no STATUS); R02-10 resíduo (AGENTS_HUB_MCP_HEARTBEAT_MS
   lido com Number cru em packages/mcp/src/main.ts:43); PID reciclado POSIX na
   reconciliação (resíduo apontado pelo worker do Linux — investigar
   imagemDoProcesso/session-manager e corrigir ou rejeitar com motivo).
C. Limpeza de testes: R12-08 reaberto (esperas fixas com setTimeout em ~37
   arquivos — os piores estão listados na Passagem 2; trocar por espera por
   condição/relógio falso, sem enfraquecer); resíduos do R02-09
   (scripts/run-tests.mjs diz "29 arquivos" no comentário; decidir
   cancel-in-progress na main do ci.yml). Alinhar OBJETIVO_MINIMO do web
   (packages/web/src/logic/session-form.ts, hoje 6) com o min(8) do
   core/brief.ts, para o formulário não aceitar o que o daemon recusa.
D. Fase 9 do GOAL (fechamento), só depois de A–C:
   1. `git clone` limpo em diretório temporário + `npm ci && npm run verify`,
      3 rodadas seguidas, zero flake — no Windows E no container Linux.
   2. `npm run demo` e `npm run test:e2e` completos, verdes.
   3. Painel no navegador (Playwright ou o Chrome do usuário via
      claude-in-chrome), servido por daemon ISOLADO com o build real: cada aba
      e botão em 1440/1100/768/375, sem sobreposição (medida por JS), console
      limpo.
   4. Teste real rodada 2 (orçamento da seção 4 abaixo): gate do Claude
      (sessão supervised pedindo `git push` → aprovação aparece → NEGAR →
      sessão segue e o agente relata), retomada do Claude (`hub send` na mesma
      sessão), Codex só se a cota da conta tiver voltado, OpenCode,
      Antigravity, Copilot. ATENÇÃO: desde a rodada 1 o gate do Claude é
      injetado por --settings em toda sessão do Hub, e Read/Grep entraram no
      matcher — o teste do gate deve provar exatamente isso no binário real.
   5. Instalação em diretório limpo seguindo SÓ docs/14-primeiros-passos.md.
   6. STATUS.md final: cada achado corrigido (commit + teste) ou rejeitado
      (motivo); roadmap e doc 07 atualizados; relatório de antes/depois por
      fase com os comandos executados e seus resultados reais.

## 3. Rigor nas entregas (não negociável)
Cada Task spec nomeia Target, Change, Constraints, Ownership (arquivos que o
worker pode tocar) e Observable acceptance. Um worker por área de arquivos
disjunta, cada um no SEU worktree. EXIJA na spec que o worker comece com
`git fetch` + `git merge --ff-only` da main local do repositório principal
(worktrees do Orca podem nascer defasados — já causou retrabalho de integração
na sessão 1) e reporte o SHA base. Toda spec inclui:
- Teste de regressão VERMELHO sem a correção e VERDE com ela; evidência das
  duas rodadas no report.
- `npm run verify` verde no worktree antes do worker_done (se o verify for
  morto por falta de memória — acontece com vários workers em paralelo —,
  esperar 5 min e repetir; nunca reportar sem verify verde).
- Proibido: desligar/skipar teste para passar, eslint-disable sem motivo na
  linha, any, @ts-ignore, console.log de debug, código morto, TODO sem item no
  STATUS.
- Boas práticas do repositório: comentários e mensagens em português (o
  comentário explica o PORQUÊ); funções pequenas nomeadas pelo domínio; lógica
  pura separada de I/O; HubError coerente (4xx do cliente vs 5xx nosso); nada
  de shell:true com texto de usuário; nenhuma promessa solta.
- Commits pequenos, mensagem convencional em português, terminando com
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Worker NÃO mescla.
Você, ao receber cada worker_done, ANTES de aceitar: (1) lê o diff inteiro
(`git diff main...<branch>`) procurando escopo além do pedido, gambiarra e
teste fraco; (2) reproduz a prova de vermelho por mutação no dist do worktree
do worker (reverta a correção, rode o teste, confirme a falha, restaure — na
sessão 1 todo merge passou por isso); (3) mescla com `git merge --no-ff`,
resolve conflito entendendo as DUAS intenções (na sessão 1 um worker partiu de
base velha e o merge exigiu recombinar as duas soluções — leia o caso do
process-tree no STATUS) e roda `npm run verify` na main; (4) falhou algo →
`orchestration reply` com a lista objetiva do que corrigir; (5) atualiza
STATUS.md e INVENTARIO.md no mesmo passo e só então `worker-release`.

## 4. Segurança e orçamento (limites do usuário)
- Daemon do usuário na porta 4747 e a pasta ~/.agents-hub são INTOCÁVEIS. Todo
  teste usa daemon isolado: AGENTS_HUB_HOME temporário, porta 0 (ou fixa em
  config.json de teste manual), AGENTS_HUB_NO_AUTOSTART=1, encerrar com
  `POST /shutdown` + token de <home>/operator-token.
- Nunca `--write` contra configs reais dos CLIs (~/.claude, ~/.codex, etc.)
  sem perguntar ao usuário. Use HOME/USERPROFILE temporários.
- Processos: só encerre o que VOCÊ (ou o worker) criou, pelo PID guardado.
  NUNCA taskkill /IM, Stop-Process -Name nem filtro por linha de comando ou
  porta (já mataram o navegador do usuário assim).
- Chamada real a modelo: SÓ na rodada 2 do item D.4 — uma sessão trivial por
  agente ("Responda apenas com a palavra OK. Não use ferramentas."),
  `--budget-usd 0.10`, projeto temporário com git init, EM SÉRIE, fallback
  ZERADO no daemon isolado, teto ~10 chamadas, no máximo 2 rodadas por dia.
  Falhou por auth/limite: registre e siga, sem repetir. Qualquer outra chamada
  real precisa de autorização do usuário. Workers NUNCA fazem chamada real.
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
