# 19 — Status da reescrita em C

> Estado de cada tarefa do [plano](17-plano-reescrita-c.md) e de cada pendência (DV/DA). Só o
> coordenador edita este arquivo; as tarefas entregam a evidência no relatório (plano, §0, tabela de
> donos). Uma marca só muda com evidência: commit, saída de teste ou medição citada (plano, §5;
> critério de pronto do `CONTRIBUTING.md`). Criado em 2026-09-30; primeira atualização do coordenador em 2026-09-30.

## Legenda

| Marca | Significado (vocabulário do `CONTRIBUTING.md`) |
|---|---|
| `[x]` | passa nas linhas da definição de pronto (plano, §5.1) |
| `[~]` | existe e funciona, mas entrega menos do que a frase diz, ou tem DV/DA aberta no aceite; a coluna Evidência diz o quê |
| `🕳️` | código escrito, nunca exercitado fora do teste unitário |
| `[ ]` | não começou |

Colunas: **Commit** = hash do commit mesclado; **Evidência** = comando executado e saída, ou caminho do relatório.

## Tarefas

### F0 — Fundação (esqueleto, CI, plataforma, vendorização)

| ID | Tarefa | Estado | Commit | Evidência |
|---|---|---|---|---|
| F0-01 | Esqueleto de build (CMake + Ninja) | `[~]` | 008e944, ef81091 | build limpo + ctest 100% em windows-msvc-debug/-release/-clangcl-asan; base comum da leva 1 em ef81091 (ah_status, ah_test.h, alvo ah_platform com fragmentos); executáveis agents-hubd/agents-hub/hub decididos (ADR 09) e ainda não criados |
| F0-02 | CI da reescrita | `[~]` | 008e944 | `.github/workflows/native.yml` com portão agregador; nunca rodou no GitHub (Linux e runners não provados); conformance ainda não ligado ao CI |
| F0-03 | Vendorização das bibliotecas do núcleo | `[x]` | 008e944 | 6 SHA-256 conferidos contra download oficial refeito; 65 arquivos idênticos ao upstream (code-reviewer); `native/third_party/VERSIONS.md` |
| F0-04 | Padrões de código C | `[~]` | cb804af | `docs/18-padroes-c.md` aprovado em auditoria; falta a configuração de formatação (clang-format é PROPOSTA) |
| F0-05 | Plataforma: texto, caminhos e arquivos | `[ ]` | | |
| F0-06 | Plataforma: tempo, aleatoriedade e ambiente | `[x]` | fca9657 | Windows: build limpo + ctest 100% em windows-msvc-debug/-release/-clangcl-asan na main integrada (coordenador); revisão independente aprovada com ressalvas, fechadas em 581d745; Linux: CI native run 36805871526 (ac1c07f) verde em linux-gcc-debug e linux-clang-asan |
| F0-07 | Plataforma: processos (spawn, pipes, ambiente) | `[ ]` | | |
| F0-08 | Plataforma: árvore de processos e identidade de PID | `[ ]` | | |
| F0-09 | Plataforma: sockets loopback, laço de eventos, timers e threads | `[~]` | 137c3de | Windows: build limpo + ctest 5/5 em windows-msvc-debug/-release/-clangcl-asan na integração (coordenador); revisão independente aprovou f921552 com mutações M1–M4 reprovando. Lacunas: mutações M5 (plano B no servidor) e M6 (SID ignorado) sobrevivem; recusa de outro usuário real fica no aceite SEC-R12/R13 (CI Linux com useradd); fila de escuta cheia pode dar REFUSED imediato no Windows (conferir na F1-20). POSIX: aguardando CI Linux |
| F0-10 | Utilitários sem I/O: UTF-8, JSON, YAML, regex | `[ ]` | | |
| F0-11 | Runner de conformidade e utilitários de teste | `[ ]` | | |
| F0-12 | Vendorização da UI (SDL3, SDL_ttf, Clay) | `[ ]` | | |
| F0-13 | Corpus de conformidade gerado do TS | `[~]` | 3fb8721, aa623c6 | classifier/domain/mappers (3fb8721) e erros de domínio por rota (aa623c6) auditados; faltam corpora de HTTP, banco e CLI; DA-30 (variante POSIX) aberta |
| F0-14 | Spike de UI e relatório | `[~]` | c8eaae0 | spike + RELATORIO.md revisados; Windows comprovado; Linux (com/sem appindicator), plutosvg, IME real, menu real da bandeja e escala real não cobertos |
| F0-15 | Proposta do procedimento de medição | `[x]` | 008e944 | `docs/propostas/F0-15-procedimento-de-medicao.md` aprovado em auditoria; decidido no ADR 09 (DA-05) |

### F1 — Vertical fina (ADR 7.18)

| ID | Tarefa | Estado | Commit | Evidência |
|---|---|---|---|---|
| F1-01 | Core: ids, tempo, erros e tipos de domínio | `[ ]` | | |
| F1-02 | Core: eventos e custo de turno | `[ ]` | | |
| F1-03 | Core: Brief | `[ ]` | | |
| F1-04 | Core: documento de política | `[ ]` | | |
| F1-05 | Core: caminhos sensíveis e leitura comum | `[ ]` | | |
| F1-06 | Core: livro-caixa de orçamento | `[ ]` | | |
| F1-07 | Configuração, variáveis de ambiente e token de operador | `[ ]` | | |
| F1-08 | Store: abertura, PRAGMAs e migrações 1 a 10 | `[ ]` | | |
| F1-09 | Store: projetos, pastas, sessões e tasks | `[ ]` | | |
| F1-10 | Store: eventos, aprovações, artefatos, orçamentos e auditoria | `[ ]` | | |
| F1-11 | Adapters: manifesto, registry mínimo e probe | `[ ]` | | |
| F1-12 | Adapters: resolução de binário e montagem do spawn | `[ ]` | | |
| F1-13 | Adapters: adapter genérico de processo | `[ ]` | | |
| F1-14 | Adapters: mapper do Claude | `[ ]` | | |
| F1-15 | Daemon: servidor HTTP, guarda e token | `[ ]` | | |
| F1-16 | Daemon: barramento, SSE comum e `GET /events` | `[ ]` | | |
| F1-17 | Daemon: worktree por sessão e settings do gate | `[ ]` | | |
| F1-18 | Daemon: gerenciador de sessões mínimo | `[ ]` | | |
| F1-19 | Daemon: rotas mínimas | `[ ]` | | |
| F1-20 | Cliente HTTP em C | `[ ]` | | |
| F1-21 | CLI mínima | `[ ]` | | |
| F1-22 | CLI: `hub hook` | `[ ]` | | |
| F1-23 | Ponta a ponta com agente falso | `[ ]` | | |
| F1-24 | Prova real com o Claude | `[ ]` | | |

### F2 — Núcleo completo (paridade com SPEC-04)

| ID | Tarefa | Estado | Commit | Evidência |
|---|---|---|---|---|
| F2-01 | Core: tokenizador de shell | `[ ]` | | |
| F2-02 | Core: classificador, parte 1 | `[ ]` | | |
| F2-03 | Core: classificador, parte 2 | `[ ]` | | |
| F2-04 | Core: motor de política | `[ ]` | | |
| F2-05 | Core: edição de política, pastas e conversa de replay | `[ ]` | | |
| F2-06 | Core: grafo e resiliência | `[ ]` | | |
| F2-07 | Core: workflow | `[ ]` | | |
| F2-08 | Core: preços e custo | `[ ]` | | |
| F2-09 | Core: ambiente do agente e auditoria | `[ ]` | | |
| F2-10 | Daemon: config do projeto, confiança e política efetiva | `[ ]` | | |
| F2-11 | Daemon: delegação e máquina de estados completa | `[ ]` | | |
| F2-12 | Daemon: orçamento do fluxo | `[ ]` | | |
| F2-13 | Daemon: retry, fallback, validação e revisão | `[ ]` | | |
| F2-14 | Daemon: gate pré-execução | `[ ]` | | |
| F2-15 | Daemon: vigilância reativa e aprovações | `[ ]` | | |
| F2-16 | Daemon: send, interrupt, pause, handoff e adoção | `[ ]` | | |
| F2-17 | Daemon: retenção, compactação, espaço do banco e reaper | `[ ]` | | |
| F2-18 | Daemon: captura de diff e artefatos | `[ ]` | | |
| F2-19 | Levantamento de DV-13 no código TS | `[x]` | ba96da0 | `docs/propostas/F2-19-dv13.md`; linhas centrais reconferidas pelo coordenador |

### F3 — Os 9 adapters e o gate (ADR 7.8)

| ID | Tarefa | Estado | Commit | Evidência |
|---|---|---|---|---|
| F3-01 | Codex: mapper e injeção do gate | `[ ]` | | |
| F3-02 | Copilot: mapper | `[ ]` | | |
| F3-03 | Kimi: mapper | `[ ]` | | |
| F3-04 | Antigravity: mapper | `[ ]` | | |
| F3-05 | Mappers genéricos (mimo, cursor, opencode por processo) | `[ ]` | | |
| F3-06 | OpenCode: servidor, sessão, prompt e fim de turno | `[ ]` | | |
| F3-07 | OpenCode: eventos e permissões | `[ ]` | | |
| F3-08 | Registry completo | `[ ]` | | |
| F3-09 | Descoberta e absorção | `[ ]` | | |
| F3-10 | Integração dos 9 no serviço e cobertura do gate | `[ ]` | | |
| F3-11 | Prova real por agente | `[ ]` | | |

### F4 — API HTTP completa (58 rotas, SSE) e MCP (16 tools)

| ID | Tarefa | Estado | Commit | Evidência |
|---|---|---|---|---|
| F4-01 | Rotas de saúde, agentes e descoberta; comportamento fora da tabela | `[ ]` | | |
| F4-02 | API REST de tasks e SSE de task | `[ ]` | | |
| F4-03 | Rotas de projetos | `[ ]` | | |
| F4-04 | Rotas de sessões e tasks | `[ ]` | | |
| F4-05 | Aprovações e manutenção | `[ ]` | | |
| F4-06 | Política e auditoria | `[ ]` | | |
| F4-07 | Orçamento, workflows e grafo | `[ ]` | | |
| F4-08 | Integrações (gate e MCP nas configs dos agentes) | `[ ]` | | |
| F4-09 | Conformidade da tabela de rotas | `[ ]` | | |
| F4-10 | MCP: transporte e ciclo de vida | `[ ]` | | |
| F4-11 | MCP: identidade, adoção, escopo e erros | `[ ]` | | |
| F4-12 | MCP: tools 1 a 8 | `[ ]` | | |
| F4-13 | MCP: tools 9 a 16 | `[ ]` | | |
| F4-14 | Levantamento dos erros de domínio por rota | `[x]` | aa623c6 | `native/tests/conformance/domain-errors/`: 58 rotas, 147 casos (120 executados contra Hub isolado); aprovado em auditoria após duas rodadas |

### F5 — CLI completa (46 comandos)

| ID | Tarefa | Estado | Commit | Evidência |
|---|---|---|---|---|
| F5-01 | Parser, ajuda, erros e `--json` | `[ ]` | | |
| F5-02 | Ciclo de vida do serviço | `[ ]` | | |
| F5-03 | Backup e restauração | `[ ]` | | |
| F5-04 | `hooks` e `mcp` (configuração offline) | `[ ]` | | |
| F5-05 | Agentes, doctor, descoberta e importação | `[ ]` | | |
| F5-06 | Projetos | `[ ]` | | |
| F5-07 | Sessões e acompanhamento | `[ ]` | | |
| F5-08 | Delegação, resultado e custo | `[ ]` | | |
| F5-09 | `merge` e `apply` | `[ ]` | | |
| F5-10 | Aprovações, manutenção, política e auditoria | `[ ]` | | |
| F5-11 | Workflows | `[ ]` | | |
| F5-12 | `init`, `open`, `autostart` e `update` | `[ ]` | | |
| F5-13 | Conformidade dos 46 comandos | `[ ]` | | |

### F6 — UI nativa (SDL3 + SDL_ttf + Clay) e bandeja

| ID | Tarefa | Estado | Commit | Evidência |
|---|---|---|---|---|
| F6-01 | Base da janela | `[ ]` | | |
| F6-02 | Widgets próprios | `[ ]` | | |
| F6-03 | Foco, teclado, diálogos e gavetas | `[ ]` | | |
| F6-04 | Toasts, estados de tela, ocupado e formatação | `[ ]` | | |
| F6-05 | Estado ao vivo | `[ ]` | | |
| F6-06 | Timeline | `[ ]` | | |
| F6-07 | Topbar, abas, menu e paleta | `[ ]` | | |
| F6-08 | Fila de aprovações, boas-vindas e notificação | `[ ]` | | |
| F6-09 | Aba Timeline: fluxos, centro e compositor | `[ ]` | | |
| F6-10 | Painel direito | `[ ]` | | |
| F6-11 | Swarm, Grafo DAG e Telemetria | `[ ]` | | |
| F6-12 | Operação: Sessão e Workflow | `[ ]` | | |
| F6-13 | Operação: Projeto, Saúde e Manutenção | `[ ]` | | |
| F6-14 | Segurança: Política e Confiança | `[ ]` | | |
| F6-15 | Segurança: Gate e MCP, Aprovações e Auditoria | `[ ]` | | |
| F6-16 | Configurações e Agentes detectados | `[ ]` | | |
| F6-17 | Modais e confirmações | `[ ]` | | |
| F6-18 | Bandeja e ciclo de vida | `[ ]` | | |
| F6-19 | Conformidade dos 198 controles e acessibilidade | `[ ]` | | |

### F7 — Migração de dados e cofre do SO

| ID | Tarefa | Estado | Commit | Evidência |
|---|---|---|---|---|
| F7-01 | Proposta de desenho: migração e cofre | `[x]` | 7b33a44 | `docs/propostas/F7-01-migracao-e-cofre.md` revisado pelo security-auditor; decidido no ADR 09 (DA-01/02/03) |
| F7-02 | Migração do banco na primeira execução | `[ ]` | | |
| F7-03 | Cofre no Windows | `[ ]` | | |
| F7-04 | Cofre no Linux | `[ ]` | | |
| F7-05 | Env por projeto no cofre | `[ ]` | | |
| F7-06 | Auditoria de segurança do cofre e da migração | `[ ]` | | |

### F8 — Instalador, atualizador e AppImage

| ID | Tarefa | Estado | Commit | Evidência |
|---|---|---|---|---|
| F8-01 | Layout de instalação | `[ ]` | | |
| F8-02 | Instalador Windows | `[ ]` | | |
| F8-03 | AppImage | `[ ]` | | |
| F8-04 | Proposta do esquema de chave e manifesto de atualização | `[x]` | 008e944 | `docs/propostas/F8-04-chave-e-manifesto-de-atualizacao.md` aprovado em auditoria; decidido no ADR 09 (DA-04) |
| F8-05 | Chave de assinatura e assinatura da release | `[ ]` | | |
| F8-06 | Atualizador | `[ ]` | | |
| F8-07 | Pipeline de release | `[ ]` | | |
| F8-08 | Auditoria do instalador e do atualizador | `[ ]` | | |

### F9 — Desempenho, prova real e corte do TS

| ID | Tarefa | Estado | Commit | Evidência |
|---|---|---|---|---|
| F9-01 | Harness de medição | `[ ]` | | |
| F9-02 | Serviço: RAM, CPU parado, início e vazão | `[ ]` | | |
| F9-03 | Hook do gate e MCP server | `[ ]` | | |
| F9-04 | Tamanho instalado | `[ ]` | | |
| F9-05 | Matriz final de conformidade | `[ ]` | | |
| F9-06 | Prova real final | `[ ]` | | |
| F9-07 | Auditoria de segurança final | `[ ]` | | |
| F9-08 | Corte do TS | `[ ]` | | |

## Pendências DV e DA

Descrição, fonte e tarefas bloqueadas ficam no plano (§2 e §3). Aqui fica só a decisão do dono e a
data. Estado: `aberta`, `decidida` ou `parcial` (decidida em parte; o resto segue aberto).

| ID | Estado | Decisão do dono | Data | Tarefas destravadas |
|---|---|---|---|---|
| DV-01 | `decidida` | ADR 09: definir timeouts explícitos, com os valores da SPEC-08 H3 como ponto de partida, medidos na F1 (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F1-15, F2-14 |
| DV-02 | `decidida` | ADR 09: aceitar `Last-Event-ID` em `GET /events`, além de `?since=` (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F1-16 |
| DV-03 | `decidida` | ADR 09: manter a resposta do `cancel`, com teto e descarte no leitor do corpo (SPEC-08 D12) (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F1-19, F4-04 |
| DV-04 | `decidida` | ADR 09: validar o formato de `sessionId`/`rootId`; formato inválido = inexistente (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F1-16, F1-19, F4-04, F4-05 |
| DV-05 | `decidida` | ADR 09: corrigir o descritor (ele descreve só `/api/tasks/*`) (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F4-02 |
| DV-06 | `decidida` | ADR 09: manter o diretório do daemon como projeto implícito (paridade de contrato) (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F4-02, F4-04 |
| DV-07 | `decidida` | ADR 09: restaurar as reservas (`reserved_json`) ao recriar o ledger no reinício (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F2-12 |
| DV-08 | `decidida` | ADR 09: interseção pai → filho com mínimo também em `defaultBudget`, `retries` e `fallback` (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F2-04, F2-11 |
| DV-09 | `decidida` | ADR 09: reconhecer `-S` de `cp`/`mv`/`ln` como flag com valor (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F2-03 |
| DV-10 | `decidida` | ADR 09: remover o campo `defaults.isolation` do manifesto do C (motivo corrigido no adendo: o campo nunca teve efeito, e o isolamento continua escolhido no Brief, `worktree` ou `none`); compatibilidade com os manifestos atuais na DA-33 (ADR 09 (ad60a9f) + adendo (91fff0c)) | 2026-09-30 | aceite: F1-18, F2-11 |
| DV-11 | `decidida` | ADR 09: timeout e heartbeat da run vêm da política efetiva do projeto (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F1-18, F2-10 |
| DV-12 | `decidida` | ADR 09: manter `submitted`, `auth_required` e `expired` no esquema (banco migrado), sem gerá-los (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F2-11, F6-12 (rótulos "na fila"/"precisa de login"), F6-15 (rótulo "expirada") |
| DV-13 | `decidida` | ADR 09: retry sem vaga conclui a sessão como `failed`, com `session.ended` e liberação do worktree (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F2-13 |
| DV-14 | `decidida` | ADR 09: corrigir (`hub --version --json` respeita `--json`) (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F5-02 |
| DV-15 | `decidida` | ADR 09: corrigir (`workflow validate` e a ajuda do workflow não sobem o serviço) (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F5-11 |
| DV-16 | `decidida` | ADR 09: corrigir (`doctor --json` sai como JSON puro) (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F5-05 |
| DV-17 | `decidida` | ADR 09: corrigir (`hub logs -n` aceito) (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F5-02 |
| DV-18 | `decidida` | ADR 09: corrigir o texto `instructions` do MCP para 9 agentes (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F4-11 |
| DV-19 | `decidida` | ADR 09: autostart também no Linux (XDG); remover o ramo de macOS do `hub open` (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F5-12, F8-02 |
| DV-20 | `decidida` | ADR 09: `hub update` checa e aplica a atualização na hora, com confirmação (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F5-12, F8-06 |
| DV-21 | `decidida` | ADR 09: novo formato apontando para o executável C, com a regra "é nosso" redefinida e migração das entradas antigas (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F1-17, F3-01, F4-08, F5-04, F8-01 |
| DV-22 | `decidida` | ADR 09: validar na UI o modelo que começa com `-` (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F6-16 |
| DV-23 | `decidida` | ADR 09: tudo deriva do home efetivo (inclusive `dbFile`, `worktreeRoot`, `artifactRoot`, `logDir`) (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F1-07 |
| DV-24 | `decidida` | ADR 09: corrigir (a ajuda cita `--json` de `import` e `restore`) (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F5-01 |
| DV-25 | `aberta` |  |  |  |
| DV-26 | `decidida` | ADR 09: corrigir (`hub help` não cria pastas) (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F5-01 |
| DV-27 | `decidida` | ADR 09: manter (MCP termina `blocked`; CLI espera a aprovação) (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F4-13, F5-11 |
| DV-28 | `decidida` | ADR 09: recusar todo `Origin` e todo `Sec-Fetch-Site` ≠ `none` em método que muda estado (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F1-15 |
| DV-29 | `decidida` | ADR 09: recusar `host` não loopback no `config.json` (`HUB_CONFIG_INVALID`) (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F1-07 |
| DV-30 | `decidida` | ADR 09: conferir que quem conecta é o mesmo usuário do SO; outro usuário → 403 (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F0-09, F1-15 |
| DV-31 | `decidida` | ADR 09: o cliente confere o dono do socket antes de mandar o token; `SO_EXCLUSIVEADDRUSE` no Windows (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F0-09, F1-20 |
| DV-32 | `decidida` | ADR 09: DACL por SID na criação do token, reconferida a cada subida (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F0-05, F1-07 |
| DV-33 | `decidida` | ADR 09: pasta 0700, arquivos 0600, `umask(077)` (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F0-05, F1-07, F1-08 |
| DV-34 | `decidida` | ADR 09: sanear C0/C1/ESC do texto do agente no terminal (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F1-21, F5-07 |
| DV-35 | `decidida` | ADR 09: limpar o env antigo na migração (`secure_delete` → `VACUUM` → checkpoint), detalhe na proposta F7-01 (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F7-02, F7-05 |
| DV-36 | `decidida` | ADR 09: pasta de instalação e locais de autostart na lista de caminhos sensíveis; `reg add …\Run` = `irreversible` (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F1-05, F2-02 |
| DV-37 | `decidida` | ADR 09: Job Object por sessão no Windows, em vez de `taskkill /T` (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F0-08 |
| DV-38 | `decidida` | ADR 09: 400 para `Content-Length` repetido, não decimal ou > 2^53, `Transfer-Encoding` ≠ `chunked` ou junto de CL, `Host` repetido (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F1-15 |
| DV-39 | `decidida` | ADR 09: 414 para linha de pedido > 8 KiB; 431 para cabeçalhos > 16 KiB ou > 64 (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F1-15 |
| DV-40 | `decidida` | ADR 09: `Host` só com caracteres de `[A-Za-z0-9.:\[\]-]`, além da paridade M2 (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F1-15 |
| DV-41 | `decidida` | ADR 09: `-t`/`--target-directory` entra como alvo de escrita (escrita fora do worktree vira `escalate`) (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F2-03 |
| DV-42 | `decidida` | ADR 09: cortar em fronteira de code point UTF-8, mesmo teto (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F1-13, F1-14, F3-03 |
| DV-43 | `decidida` | ADR 09: recusar prompt vazio antes do spawn (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F1-13, F3-02, F3-03, F3-04 |
| DV-44 | `decidida` | ADR 09: sanear `limits` no construtor como o `setLimits` (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F1-06 |
| DV-45 | `decidida` | ADR 09: reproduzir as tolerâncias dos mappers (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F1-14, F3-02, F3-05, F3-07 |
| DV-46 | `decidida` | ADR 09: sem token, `GET /projects/:id/context` devolve só os nomes das variáveis; com token, os valores (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F4-03 (e SEC-R12) |
| DA-01 | `decidida` | ADR 09: opção 1 da F7-01: arquivo 0600 em pasta 0700, com aviso permanente (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | início de F7-04 |
| DA-02 | `decidida` | ADR 09: tabela própria no banco (R-C) com nome opaco (N-D); no Windows, DPAPI em arquivo (W-B), sem o teto de 2560 bytes (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | início de F7-03 e F7-04 |
| DA-03 | `decidida` | ADR 09: cópia de segurança antes e migração no lugar (M-C), com o TS parado e a porta presa; marca dentro do banco (migração 11) (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | início de F7-02 |
| DA-04 | `decidida` | ADR 09: envelope único; Ed25519 puro; Windows troca os binários com rollback (W2); chave diária local cifrada (O2) e a de recuperação em mídia separada; revogação só pela chave de recuperação; expiração de 30 dias (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | início de F8-05 |
| DA-05 | `decidida` | ADR 09: procedimento da proposta F0-15 (mediana de ≥ 5, mesma máquina, harness do C em `native/tests/bench/c/`) (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | início de F9-01 |
| DA-06 | `decidida` | ADR 09: Bearer + `X-Hub-Client: ui` → `ui:<usuário>` (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F6-05, F6-08, F6-13, F6-14, F6-15 |
| DA-07 | `decidida` | ADR 09: diálogos nativos de confirmação; tema salvo no `config.json`; notificação do SO quando a janela está oculta; seletor de pasta nativo. O restante foi decidido no adendo 2: área de transferência do SO (C074), diálogo nativo de abrir arquivo (C083) e diálogo nativo de salvar no lugar do download (C140) (ADR 09 (ad60a9f) + adendo 2 (2068c80)) | 2026-09-30 | aceite: F6-01, F6-03, F6-08, F6-12, F6-15, F6-16 |
| DA-08 | `decidida` | ADR 09: depois da paridade (backlog PP-01, §7); a primeira versão mostra texto cru (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F6-06 (só a parte nova) |
| DA-09 | `decidida` | ADR 09: depois da paridade (backlog PP-02, §7); a primeira versão é a árvore indentada (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F6-11 (só a parte nova) |
| DA-10 | `decidida` | ADR 09: ícone próprio encomendado; até lá, um provisório gerado (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F6-18, F8-02, F8-03 |
| DA-11 | `decidida` | ADR 09: confirmadas (C17 sem VLA/`stdatomic`, CMake ≥ 3.22, UI só sob evento, linuxdeploy + appimagetool) (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F0-01, F0-04, F0-09, F6-01, F8-03 |
| DA-12 | `parcial` | ADR 09: HarfBuzz sim (vem com o SDL_ttf); emoji colorido COLR sem plutosvg no Windows. **Linux segue aberto** (plutosvg e tray sem appindicator) (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F0-12, F6-01 (evidência vem de F0-14) |
| DA-13 | `parcial` | ADR 09: proxy do sistema (WinHTTP); CA do sistema no Linux. **Segue aberto: verificar na F8** (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F8-03, F8-06 |
| DA-14 | `decidida` | ADR 09: serviço `agents-hubd` (sobe no login, sem janela); janela e bandeja em `agents-hub`, cliente da mesma API HTTP; CLI `hub`, com MCP e hook como subcomandos (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F0-01, F1-21, F4-10, F5-02, F5-12, F6-01, F6-18, F8-01, F8-02 |
| DA-15 | `decidida` | ADR 09: `GET` sem rota → 404 JSON; sem cookie e sem arquivos estáticos (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F4-01 |
| DA-16 | `decidida` | ADR 09: texto de erro próprio; versão do protocolo igual à negociada pelo SDK TS na data (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F4-10, F4-13 |
| DA-17 | `decidida` | ADR 09: parar de distribuir o tarball e tirar o TS do CI depois da F9; o código fica no repositório (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | início de F9-08 |
| DA-18 | `aberta` |  |  |  |
| DA-19 | `decidida` | ADR 09: manter o repositório público (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F8-06 |
| DA-20 | `decidida` | ADR 09: remover os comportamentos ligados a Node (sem Node no produto) (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F5-02, F5-12 |
| DA-21 | `decidida` | ADR 09: recusar `container` com erro claro na entrada; ler linhas antigas como estão (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F1-03, F1-08, F1-18, F1-21, F4-02, F5-07, F7-02 |
| DA-22 | `decidida` | ADR 09: leitor e gravador mínimos próprios, só para as chaves que o Hub edita, com teste de ida e volta (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F3-09, F4-08, F5-04 |
| DA-23 | `decidida` | ADR 09: reproduzir só o código e o caminho do campo; texto próprio em pt-BR (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F1-03, F1-15, F2-07, F4-07 |
| DA-24 | `decidida` | ADR 09: manter a macro de teste própria do esqueleto (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F0-01, F0-11 |
| DA-25 | `decidida` | ADR 09: FreeType e HarfBuzz vendorizados com o SDL_ttf; libcurl do sistema no Linux, empacotada no AppImage (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F0-12, F8-03, F8-06 |
| DA-26 | `decidida` | ADR 09: adotar: fuzz curto no PR e longo noturno; flags de endurecimento no release (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F0-02 (parte de fuzzing e endurecimento) |
| DA-27 | `decidida` | ADR 09: confirmada a ordem do plano (F3 antes da F6) (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: nenhuma tarefa (confirmação da ordem) |
| DA-28 | `decidida` | ADR 09: não apagar `~/.agents-hub`; remover o autostart; oferecer remover os hooks gravados (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F8-02 |
| DA-29 | `decidida` | ADR 09: adotar todos os endurecimentos listados (ADR 09 (ad60a9f); recomendações 89ca3e0) | 2026-09-30 | aceite: F0-07, F0-10, F1-12, F1-22, F5-05, F5-10, F5-12, F6-08, F7-05, F8-02, F8-03, F8-08, F9-07 |
| DA-30 | `aberta` |  |  |  |
| DA-31 | `decidida` | ADR 09 (adendo): o MCP por stdio é `hub mcp serve` (o `hub mcp` continua listando e instalando a configuração); `hub daemon` executa o `agents-hubd` instalado em primeiro plano; o autostart sob demanda sobe o `agents-hubd` em segundo plano (ADR 09 adendo (91fff0c)) | 2026-09-30 | aceite: F4-10, F5-02, F8-01 |
| DA-32 | `decidida` | ADR 09 (adendo 2): `hub open` abre ou traz para frente a janela `agents-hub`, iniciando o serviço se preciso (ADR 09 adendo 2 (2068c80)) | 2026-09-30 | aceite: F5-12 |
| DA-33 | `decidida` | ADR 09 (adendo 2): o schema de manifesto do C aceita `defaults.isolation` com aviso de obsoleto e não o usa; os manifestos empacotados são limpos; manifestos de usuário continuam válidos (ADR 09 adendo 2 (2068c80)) | 2026-09-30 | aceite: F1-11, F8-01 |

## Registros

Resultados que não são de uma tarefa só (relatório do spike F0-14, medições, provas reais), com data e
caminho.

| Data | O quê | Onde |
|---|---|---|
| 2026-09-30 | ADR 09: dono aceita todas as recomendações da rodada 1 (45 DV + 29 DA) | `docs/decisoes/09-rodada-1-divergencias-e-decisoes.md` (ad60a9f); recomendações `docs/propostas/decisoes-rodada-1.md` (89ca3e0) |
| 2026-09-30 | ADR 09 adendo: DA-31 (hub mcp serve; hub daemon executa o agents-hubd) e motivo da DV-10 | 91fff0c |
| 2026-09-30 | ADR 09 adendo 2: DA-07 restante, DA-32 (hub open abre a janela), DA-33 (defaults.isolation aceito e ignorado) | 2068c80 |
| 2026-09-30 | Relatório do spike de UI (F0-14) | `native/spikes/ui/RELATORIO.md` (c8eaae0) |
| 2026-09-30 | Base comum da leva 1 de implementação | ef81091 |
| 2026-09-30 | Exceção do coordenador: F0-12 iniciada com F0-14 em `[~]` (Windows comprovado; Linux validado pelo CI da F0-12) | este arquivo |
| 2026-09-30 | Backlog pós-paridade fora das 137 tarefas: PP-01 (markdown), PP-02 (grafo desenhado) | plano §7 |
