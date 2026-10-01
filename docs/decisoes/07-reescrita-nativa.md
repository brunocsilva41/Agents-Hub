# ADR 07 — Reescrita nativa em C, app instalável (decidido em 2026-09-30)

> Rascunho para revisão do dono do projeto. Registra **só** o que foi decidido na
> entrevista de 2026-09-30; o que não foi decidido está em "Em aberto".

## Contexto (fatos conferidos no repositório em 2026-09-30, main @ ac59745)

- O Hub é TypeScript sobre Node ≥ 22.5 (8 pacotes em `packages/`, ~46 mil linhas de
  código de produção), painel React 19 + Vite, SQLite via `node:sqlite`.
- **Não existe deploy web.** Tudo já roda na máquina do usuário: o daemon escuta em
  `127.0.0.1:4747` (`packages/daemon/src/config.ts`) e serve o painel; `hub open` abre
  o painel no navegador padrão (`packages/cli/src/open-cmd.ts`).
- Instalação = tarball `npm i -g` que exige Node e git pré-instalados
  ([docs/13](../13-instalacao.md)); `hub update` só mostra passos manuais; autostart por
  `.vbs` na pasta Inicializar. Não há instalador nem atualização automática.
- Estado do MVP em TS: fases 0–8 do [GOAL](../12-goal-mvp-completo.md) marcadas como
  concluídas; Fase 9 não fechada ([STATUS](../vistoria-2026-09-25/STATUS.md)).

## Decisões

| # | Decisão | Escolha |
|---|---|---|
| 7.1 | Linguagem | **Todo o produto em C** — core, store, adapters, daemon, client, CLI, MCP server e UI. Sem Node e sem JavaScript no produto final. Motivação: leveza e desempenho. |
| 7.2 | Plataformas | **Windows e Linux.** macOS fora. |
| 7.3 | Interface | **Janela nativa, sem navegador**, com **uma biblioteca de UI multiplataforma em C** (mesmo visual nos dois SOs). A biblioteca será escolhida por pesquisa e confirmada pelo dono. |
| 7.4 | Paridade | **Paridade total** com o painel e a CLI atuais (Timeline, Swarm, Grafo DAG, Telemetria, Operação, Segurança, Configurações; os comandos da CLI; as 16 tools MCP). |
| 7.5 | Ciclo de vida | Fechar a janela **não encerra** o serviço: ele segue na **bandeja/área de notificação** e as sessões continuam vivas. |
| 7.6 | Transporte | **Mantém HTTP local em 127.0.0.1** com o mesmo contrato da API atual (rotas, SSE, token de operador). CLI, hook do gate e MCP continuam falando HTTP com o serviço. |
| 7.7 | CLI e MCP | **Continuam existindo**, reimplementados em C e instalados junto com o app. |
| 7.8 | Agentes | **Os 9** manifestos atuais (claude, codex, opencode, copilot, antigravity, kimi, mimo, openclaude, cursor). |
| 7.9 | Comportamento | **Mantém o comportamento que está no código TS hoje** (não o texto original dos ADRs 01–06): worktree git por sessão, tabela de risco × modo, gate pré-execução (Claude, Codex), orçamento herdado da raiz, profundidade/ciclo, retry + fallback por capability, validação/revisão desligadas por padrão, retenção, modelo = padrão do CLI, trust-on-first-use do `config.yaml`. |
| 7.10 | Especificação | O código TS **vira especificação congelada**: fica no repositório como referência, e seus testes definem o que o C precisa provar. **Nenhum trabalho novo em TS**; pendências abertas do TS viram requisitos do C. |
| 7.11 | Repositório | **Mesmo repositório** (`brunocsilva41/Agents-Hub`). |
| 7.12 | Distribuição | Windows: instalador. Linux: **AppImage**. |
| 7.13 | Atualização | **Automática**, a partir de **GitHub Releases** do repositório. |
| 7.14 | Assinatura | **Sem certificado Authenticode por enquanto** (o instalador mostrará o aviso do SmartScreen). A atualização valida os binários com uma **chave própria do projeto**. |
| 7.15 | Dados existentes | Na primeira execução, o app **migra** o banco SQLite de `~/.agents-hub` (esquema atual: migração 10, `packages/store/src/migrations.ts`; o `docs/01` ainda diz 1–8). |
| 7.16 | Segredos | O env por projeto (hoje em texto no banco, ver [SECURITY.md](../../SECURITY.md)) passa para o **cofre do sistema operacional**; o banco guarda só a referência. |
| 7.17 | Roadmap | **Removidos:** TUI, A2A (JSON-RPC), ACP e `isolation: container`. |
| 7.18 | Ordem | **Vertical fina primeiro**: core + store + adapter do Claude + serviço HTTP + CLI de ponta a ponta com sessão real; depois UI, os demais adapters, o instalador e a atualização. |
| 7.19 | Desempenho | As metas do C serão derivadas de uma **medição da linha de base do TS** (RAM, CPU ocioso, tempo de início, latência do hook, tamanho da instalação). |

## O que isto substitui

- **ADR 1.1** (stack TypeScript/Node) → 7.1.
- **ADR 1.2** (daemon + CLI/TUI + Web UI): o daemon e a CLI continuam; a TUI sai (7.17); a Web UI dá lugar à janela nativa (7.3). A regra "sem lógica no cliente" continua valendo.
- **ADR 3.1** (credenciais): "o Hub nunca persiste segredo" passa a valer também para o env por projeto, via cofre do SO (7.16).
- **ADR 5.3** (React + Vite servido pelo daemon) → 7.3.
- **ADR 2.3**: A2A e ACP saem do plano (7.17). **ADR 1.3**: o modo `isolation: container` sai (7.17).
- Os demais ADRs seguem valendo na forma que o código TS implementa (7.9).

## Em aberto (não decidido)

> **Atualização (2026-09-30):** a biblioteca de UI, as metas de desempenho, o instalador, a
> atualização e a pilha C foram decididos no [ADR 08](08-pilha-tecnica-c.md). O esquema exato
> da chave e do manifesto de atualização segue como proposta técnica até o plano.

- Biblioteca de UI em C (7.3), a ser pesquisada.
- Metas numéricas de desempenho (7.19), depois da medição.
- Formato do instalador no Windows e esquema da chave de atualização (7.12, 7.14).
- Acesso remoto ao daemon (segue em aberto, como no roadmap).
- O repositório é **público** hoje (conferido com `gh repo view` em 2026-09-30), então as Releases podem ser baixadas sem token. Se ele virar privado, 7.13 precisa ser revista.
- Versão do padrão C, sistema de build e bibliotecas vendorizadas (SQLite, HTTP, JSON, YAML, TLS para o updater).
