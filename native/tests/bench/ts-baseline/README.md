# Harness da linha de base do TS

Cópia, preservada no repositório, do harness que mediu a linha de base de desempenho do Agents-Hub
em TypeScript/Node em 2026-09-30 (commit `ac59745`, idêntico a `ecbb72f` em `packages/`). Os números
estão na [especificação 06](../../../../docs/especificacao/06-desempenho-linha-de-base-e-metas.md);
o relatório completo da medição está em [`relatorio-linha-de-base.md`](relatorio-linha-de-base.md).

Estava só no diretório temporário da sessão de medição; foi copiado para cá para a F9-01 conseguir
reproduzir a linha de base (lacuna L1 da [proposta F0-15](../../../../docs/propostas/F0-15-procedimento-de-medicao.md)).
Os caminhos pessoais dos resultados foram trocados por `<usuario>`/`<projeto>`/`<scratchpad>`.

| Arquivo | O que é |
|---|---|
| `bench.mjs` | harness (seções `startup`, `panel`, `hookcli`, `mcp`, `flood`) |
| `agente.cjs`, `flood.cjs` | agentes falsos em Node (nenhum modelo é chamado) |
| `resultados/res-*.json` | resultados brutos da medição |
| `relatorio-linha-de-base.md` | relatório da medição (ambiente, tabela, ressalvas) |

## Regras de uso

- **Sempre isolado:** o harness exige `AGENTS_HUB_PORT` definida e diferente de 4747 (aborta caso
  contrário) e exporta `AGENTS_HUB_HOME` temporário, `AGENTS_HUB_NO_AUTOSTART=1` e `AGENTS_HUB_URL`
  em cada processo que sobe. Nunca use a porta 4747 nem `~/.agents-hub` (ver `CLAUDE.md`).
- Precisa do TS buildado (`npm run build`, que gera `packages/*/dist`).
- O procedimento oficial de medição das metas do C ainda não está decidido (DA-05; proposta em
  `docs/propostas/F0-15-procedimento-de-medicao.md`). Este harness não foi adaptado: está como foi
  usado na medição.
