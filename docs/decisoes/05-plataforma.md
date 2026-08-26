# ADR 05 — Plataforma e Escopo (decidido em 2026-08-26)

| # | Decisão | Escolha | Consequência |
|---|---|---|---|
| 5.1 | Sessões | **Espelhar a sessão nativa quando existir** | O Hub guarda `native_session_id` por sessão e usa o resume real do CLI (`claude --resume`, `codex exec resume`, `PATCH /session/{id}` do OpenCode). Onde não existir, degrada para replay do brief. O manifesto do agente declara `session.strategy: native \| replay \| none`. |
| 5.2 | Escopo de projeto | **Multiprojeto com registro central** | Um daemon serve N repositórios. Estado global em `~/.agents-hub/` (SQLite, logs, worktrees, config). Config por projeto em `<repo>/.agents-hub/config.yaml`, versionável. |
| 5.3 | Web UI | **React + Vite + TypeScript**, servida pelo daemon | SPA buildada como estático e servida pelo próprio daemon: um processo só para rodar. Consome a mesma API HTTP+SSE da CLI/TUI. |
| 5.4 | Workflows declarativos | **Sim, fase 3** | Fases 1–2 provam delegação ad-hoc; o motor de workflow YAML é desenhado depois, a partir dos padrões que realmente aparecerem no uso. |
