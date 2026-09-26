# STATUS — execução do GOAL (docs/12-goal-mvp-completo.md)

> Atualize este arquivo a cada item concluído. É a memória entre janelas de contexto:
> antes de continuar o trabalho, leia isto primeiro para saber o que já foi feito.
> Estado de cada achado: `[ ] pendente` | `[~] em andamento` | `[x] corrigido (commit: <sha>)` | `[rejeitado] <motivo>`.

Última atualização: 2026-09-26, por Claude Opus 5.5 (sessão de execução do GOAL).

## Log da execução
- 2026-09-26 onda 1 disparada (agentes em worktree): 0.1 | 0.2+0.3 | 0.4+0.5 | 0.6 | 0.7 | 1.1+1.2+1.7 | 1.8. Próxima onda: 1.3–1.6, 1.9, 1.10, depois Fases 2–6.

## Linha de base confirmada nesta data
- `npm ci && npm run verify`: verde, 517/517 testes, build limpo.
- `npm run demo`: 18/18 PASS.
- `main` local 15 commits à frente de `origin/main`; sem push feito.
- Daemon do usuário (porta 4747) tinha 2 aprovações pendentes de sessões antigas (`git push origin main`) — não tocadas.

## Fase 0 — Perda de dados e execução indevida
- [~] 0.1 Reaper apaga node_modules real via junction (CRÍTICO, relatório 06)
- [~] 0.2 `agy` nunca recebe prompt (CRÍTICO, relatórios 10/11)
- [~] 0.3 Injeção de comando em agentes `.cmd` com prompt em argv (relatório 10)
- [~] 0.4 `hooks install claude --write` destrói settings.json não-canônico (relatórios 07/08)
- [~] 0.5 `mcp install --write` gera config inválida (OpenCode) / TOML duplicado (Codex) / `.bak` sobrescrito (relatórios 07/08)
- [~] 0.6 Path traversal no client MCP (`../shutdown#`) (relatórios 07/08)
- [~] 0.7 `validation.command` do repo executa com shell:true fora do gate (relatórios 02/05/09)

## Fase 1 — Gate de permissões
- [~] 1.1 Classificador de comando por prefixo (comandos compostos passam) (relatórios 02/05/09/13)
- [~] 1.2 Leitura de segredos não protegida; deny list vira approve (relatório 02/09)
- [ ] 1.3 Timeout do hook < espera do daemon (relatórios 01/05/08)
- [ ] 1.4 Gate falha aberto não documentado (relatório 02)
- [ ] 1.5 Caminho bloqueante do gate: 3 defeitos (relatório 01/06)
- [ ] 1.6 Aprovação sem token (relatório 05)
- [~] 1.7 Calibrar tabela de risco supervised vs README (relatório 01/11)
- [~] 1.8 Guard: Origin null, JSON malformado→500, args MCP não mascarados, etc (relatório 02/05)
- [ ] 1.9 Trust-on-first-use para BASE_URL/prompts/env do repo (relatório 02/05)
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
- [ ] 6.1 a 6.12 (relatórios 03/04/13/10/14)

## Fase 7 — Testes/CI
- [ ] 7.1 a 7.4 (relatórios 01/04/12)

## Fase 8 — Documentação/demo
- [ ] 8.1 a 8.4 (relatórios 01/02/14)

## Fase 9 — Fechamento
- [ ] Não iniciado

## Orçamento de chamadas reais a modelo usado até agora
- Vistoria de 2026-09-25: ~9 chamadas (relatório 11), dentro do teto combinado com o usuário.
- Nenhuma chamada real adicional feita depois disso.
