# STATUS — execução do GOAL (docs/12-goal-mvp-completo.md)

> Atualize este arquivo a cada item concluído. É a memória entre janelas de contexto:
> antes de continuar o trabalho, leia isto primeiro para saber o que já foi feito.
> Estado de cada achado: `[ ] pendente` | `[~] em andamento` | `[x] corrigido (commit: <sha>)` | `[rejeitado] <motivo>`.

Última atualização: 2026-09-26, por Claude Opus 5.5 (sessão de execução do GOAL).

## Inventário
Checklist por achado (225: 3 CRÍT / 52 ALTO / 104 MÉD / 66 BAIXO — o GOAL contou só grafias acentuadas) em [INVENTARIO.md](INVENTARIO.md), com ID R<nn>-<seq> e item do GOAL. Estado marcado a partir dos itens concluídos. Placar atual: CRÍT 3/3, ALTO 16/52, MÉD 11/104, BAIXO 7/66.

## Log da execução
- 2026-09-26 onda 1 disparada (agentes em worktree): 0.1 | 0.2+0.3 | 0.4+0.5 | 0.6 | 0.7 | 1.1+1.2+1.7 | 1.8. Onda 1 mesclada; verify 880/880.
- Onda 2: 1.3+1.4+1.5+2.4 (gate) | 1.6+1.10 (token + política/auditoria API/CLI) | 1.9 (TOFU env/prompts) | Fase 3 | 4.1+4.3+4.5 | 4.2+4.4 | web 6.1/6.2/6.7/6.8 | web 6.3/6.4/6.9/6.10 | web 6.5/6.6/6.11.
- Nota de integração: o teste %E0 da 0.6 passou a esperar MALFORMED_URL (código da 1.8); ambos 400.

## Linha de base confirmada nesta data
- `npm ci && npm run verify`: verde, 517/517 testes, build limpo.
- `npm run demo`: 18/18 PASS.
- `main` local 15 commits à frente de `origin/main`; sem push feito.
- Daemon do usuário (porta 4747) tinha 2 aprovações pendentes de sessões antigas (`git push origin main`) — não tocadas.

## Fase 0 — Perda de dados e execução indevida
- [x] 0.1 Reaper apaga node_modules real via junction (CRÍTICO, relatório 06) — merge 7e7a7a7; worktree-links.test.ts (6 testes; mutação: 0/6 sem a correção)
- [x] 0.2 `agy` nunca recebe prompt (CRÍTICO, relatórios 10/11) — merge e3474b3→main; prompt-delivery.test.ts (39 casos; 23 vermelhos sem a correção). agy -p=<prompt>. Teste real pendente (Fase 9)
- [x] 0.3 Injeção de comando em agentes `.cmd` com prompt em argv (relatório 10) — mesmo merge; shim npm desembrulhado (node script/.exe real, sem shell); .cmd desconhecido com escape e recusa de multilinha/>8K; mimo por stdin
- [x] 0.4 `hooks install claude --write` destrói settings.json não-canônico (relatórios 07/08) — merge 49bee3a; install-write.test.ts + safe-write.test.ts; settings com lixo → recusa sem gravar; JSONC preservado; backup .bak-YYYYMMDD-HHMMSS
- [x] 0.5 `mcp install --write` gera config inválida (OpenCode) / TOML duplicado (Codex) / `.bak` sobrescrito (relatórios 07/08) — mesmo merge; OpenCode {type:local,command,environment,enabled}; Codex substitui tabela inteira e reparseia; validado com `opencode debug config` e `codex mcp list` em HOME temporário
- [x] 0.6 Path traversal no client MCP (`../shutdown#`) (relatórios 07/08) — merge 0437199; ids.test.ts, route-ids.test.ts, mcp server.test; idSegment em todo segmento do client (inclui trust/import); 400 INVALID_ID no daemon
- [x] 0.7 `validation.command` do repo executa com shell:true fora do gate (relatórios 02/05/09) — merge 7174e16; policy-merge.test.ts + project-trust.test.ts (12 vermelhos sem a correção); clamp monotônico campo a campo; validation/review do repo só com `hub project trust` (migração 5, padrão desligado)

## Fase 1 — Gate de permissões
- [x] 1.1 Classificador de comando por prefixo (comandos compostos passam) (relatórios 02/05/09/13) — merge b5279e1; command-classifier.test.ts 238 testes (177 vermelhos com o classificador antigo); tokenizador bash/cmd/PS, pior segmento, desembrulha sudo/env/bash -c/cmd /c/powershell
- [x] 1.2 Leitura de segredos não protegida; deny list vira approve (relatório 02/09) — mesmo merge; leitura de segredo = irreversible (Read e cat/type/Get-Content); escrita sensível inclui .git/hooks, .github/workflows, .git/config; deny = deny em todo modo
- [ ] 1.3 Timeout do hook < espera do daemon (relatórios 01/05/08)
- [ ] 1.4 Gate falha aberto não documentado (relatório 02)
- [ ] 1.5 Caminho bloqueante do gate: 3 defeitos (relatório 01/06)
- [ ] 1.6 Aprovação sem token (relatório 05)
- [x] 1.7 Calibrar tabela de risco supervised vs README (relatório 01/11) — mesmo merge; ~/.claude/plans não pede aprovação; ls/cat/git status = read; mkdir/make/npm install passam em semi; README com tabela risco×modo
- [x] 1.8 Guard: Origin null, JSON malformado→500, args MCP não mascarados, etc (relatório 02/05) — merge 639dd11; http-hardening.test.ts (10 vermelhos sem a correção) + guard.test; Origin null/sem porta/Sec-Fetch-Site; %→400; JSON→400; >5MB→413; args/url/headers mascarados; caminho de projeto validado; ADS/reservados→400; /health sem home
- [x] 1.9 Trust-on-first-use para BASE_URL/prompts/env do repo (relatório 02/05) — merge 77f7e21; repo-trust.test.ts (7 testes, 6 vermelhos sem a correção); env/prompts/memória/validation do repo só com confiança + hash (TOFU, suspende se mudar); contexto do Hub no banco (migração 6). Pendente p/ 6.12: UI de confiança no painel
- [ ] 1.10 Editor de política + trilha de auditoria no painel/CLI (relatório 05)

## Fase 2 — Ciclo de vida de sessão
- [ ] 2.1 a 2.10 — ver docs/12-goal-mvp-completo.md (relatórios 06/13)

## Fase 3 — Custo e orçamento
- [ ] 3.1 a 3.4 (relatórios 09/10/11)

## Fase 4 — Adapters
- [ ] 4.1 a 4.6 (relatórios 10/11/03)

## Fase 5 — CLI e primeira execução
- [ ] 5.1 a 5.7 (relatórios 01/02/07/09/12/14)

## Fase 6 — Painel web
- [x] 6.5 6.6 6.11 — merge fa7ee18; testes de lógica do web (packages/web/src/logic, runner dist-test), 10 vermelhos sem a correção; onboarding sem projeto; tabela de env por agente no core. Pendências: trocar de aba no topo descarta edição sem aviso (App.tsx); classes .settings-vazio/.settings-erro sem CSS
- [ ] 6.1 6.2 6.3 6.4 6.7 6.8 6.9 6.10 6.12

## Fase 7 — Testes/CI
- [ ] 7.1 a 7.4 (relatórios 01/04/12)

## Fase 8 — Documentação/demo
- [ ] 8.1 a 8.4 (relatórios 01/02/14)

## Fase 9 — Fechamento
- [ ] Não iniciado

## Orçamento de chamadas reais a modelo usado até agora
- Vistoria de 2026-09-25: ~9 chamadas (relatório 11), dentro do teto combinado com o usuário.
- Nenhuma chamada real adicional feita depois disso.
