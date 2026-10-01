# 17 — Plano de execução da reescrita em C

> Plano das tarefas da reescrita do Agents-Hub em C ([ADR 07](decisoes/07-reescrita-nativa.md),
> [ADR 08](decisoes/08-pilha-tecnica-c.md)). Toda exigência funcional aponta a especificação ou o
> ADR de onde vem. O que não está decidido aparece como pendência com ID (`DV-nn` para
> divergência do TS, `DA-nn` para decisão aberta), e nenhuma delas é decidida aqui.
>
> **Fontes:** ADR 07, ADR 08 e as especificações extraídas do TS:
> [SPEC-01](especificacao/01-api-http.md) (API HTTP), [SPEC-02](especificacao/02-banco-e-dados.md)
> (banco e dados), [SPEC-03](especificacao/03-cli-e-mcp.md) (CLI e MCP),
> [SPEC-04](especificacao/04-dominio-e-adapters.md) (domínio e adapters),
> [SPEC-05](especificacao/05-painel-inventario.md) (painel),
> [SPEC-06](especificacao/06-desempenho-linha-de-base-e-metas.md) (desempenho),
> [SPEC-07](especificacao/07-inventario-testes-ts.md) (inventário dos testes TS) e
> [SPEC-08](especificacao/08-modelo-de-ameacas-c.md) (modelo de ameaças; tudo o que ela marca
> PROPOSTA continua proposta aqui). Propostas de tarefas para decisão do dono ficam em
> `docs/propostas/<id>.md`. O código TS em
> `packages/` é a especificação congelada, e seus testes definem o que o C precisa provar
> (ADR 7.10). Quando uma SPEC não cobre um ponto, a fonte é o arquivo TS citado na tarefa.
>
> **Status:** este documento não guarda status. O estado de cada tarefa fica em
> `docs/19-status-reescrita-c.md` (ver §5).

## 0. Como ler

- **Fases** na ordem do ADR 7.18: vertical fina primeiro (F1), depois o núcleo, os adapters, a API, a
  CLI, a UI, a migração, a distribuição e o fechamento.
- **Tarefa** = 1 a 3 dias de trabalho de um agente. Campos de cada uma:
  - **Entrega:** arquivos e módulos.
  - **Aceite:** critérios testáveis, com a seção da SPEC e, quando existe, o teste TS equivalente.
  - **Depende:** IDs que precisam estar `[x]` antes de **começar**. Pendências marcadas
    "bloqueia o aceite" não impedem o início, mas impedem o `[x]` (ver §5).
  - **Agente:** um dos seis papéis (c-engineer, build-release-engineer, test-engineer, docs-writer,
    security-auditor, performance-auditor).
  - **Área:** pastas e arquivos que a tarefa toca. Duas tarefas com áreas disjuntas podem rodar em
    paralelo. Os grupos paralelos de cada fase estão no fim da fase.
- **Decisões do ADR 09:** a rodada 1 decidiu quase todas as pendências
  ([ADR 09](decisoes/09-rodada-1-divergencias-e-decisoes.md)). Cada tarefa afetada tem a linha
  **Decisões (ADR 09)** com o que vale; onde o Aceite ainda diz "conforme DV/DA-nn", "depende de" ou
  "PROPOSTA" para um item decidido, vale a decisão dessa linha, e o trabalho que ela cria entra na
  própria tarefa. Só as pendências abertas (§2, §3) seguem em "bloqueia o aceite".
- **Testes do C:** `native/tests/unit/` (unitários), `native/tests/integration/` (serviço isolado) e
  `native/tests/conformance/` (corpus gerado do TS, tarefa F0-13). "Teste TS equivalente" = os casos
  do arquivo citado (caminho relativo a `packages/`) reproduzidos no C. Reproduzir os casos não
  quer dizer copiar o arquivo.
- **Teste real sempre isolado:** toda execução do `hub` (TS ou C) leva, na mesma chamada,
  `AGENTS_HUB_HOME=<temporário>`, `AGENTS_HUB_PORT=<porta livre>` e `AGENTS_HUB_NO_AUTOSTART=1`
  (regras do `CLAUDE.md`). Chamar um modelo real exige autorização explícita do dono.

Estrutura de pastas (definida pelo coordenador): `native/CMakeLists.txt`, `native/cmake/`,
`native/third_party/<lib>/`, `native/src/{platform,core,store,adapters,daemon,client,cli,mcp,ui,updater}/`,
`native/tests/{unit,integration,conformance}/`, `native/spikes/`. O esqueleto também criou
`native/tests/bench/` (o harness da linha de base TS está em `native/tests/bench/ts-baseline/`).

**Fora do escopo (ADR 7.17):** TUI, A2A (JSON-RPC), ACP e `isolation: container`. Nenhuma tarefa os
implementa. A API REST de tasks (`/api/tasks/*`, rotas 6–10) **não** é A2A (SPEC-01 §6.2) e continua
no escopo (F4-02). Onde o valor `container` ainda aparece (Brief, API, CLI), o C o recusa
na entrada com erro claro, e linhas antigas do banco são lidas como estão (DA-21, decidida no ADR 09).
No manifesto, `defaults.isolation` (qualquer valor) é aceito com aviso de obsoleto e ignorado (DA-33).

**Arquivos de registro comuns e seus donos.** Quando tarefas paralelas precisariam editar o mesmo
arquivo, vale esta regra: o código novo de cada tarefa fica em arquivo próprio, e o arquivo comum
tem um único dono por vez. A entrada de uma tarefa nesse arquivo (uma linha de registro) é entregue
como trecho separado e aplicada pelo coordenador, em série, na ordem de mesclagem.

| Arquivo comum | Dono | Regra para as demais tarefas |
|---|---|---|
| `native/CMakeLists.txt`, `native/cmake/`, `native/third_party/CMakeLists.txt` | F0-01 (depois o coordenador) | cada tarefa entrega a linha do seu alvo/fonte |
| `native/src/platform/CMakeLists.txt` e `ah_platform.h` | base comum do coordenador (commit `ef81091`) | F0-05, F0-06, F0-07 e F0-09 são donas, cada uma, do seu fragmento: `fs.cmake`, `time.cmake`, `proc.cmake` e `net.cmake` em `native/src/platform/` (inclusive os testes da área, em `native/tests/unit/platform/`) |
| `native/tests/unit/CMakeLists.txt` | F0-10 nesta leva | as outras tarefas entregam a sua linha, aplicada em série; os testes de plataforma entram pelos fragmentos acima |
| `native/tests/unit/ui_smoke/` | F0-12 | — |
| `native/tests/conformance/runner/` e `native/tests/integration/` | F0-11 | as tarefas de correção acrescentam entradas na tabela de "esperado decidido" (F0-11) |
| `native/src/updater/` e `native/tools/ahsign/` | F8-05 (cria o módulo de verificação e a ferramenta de assinatura) | F8-06 estende o `updater/` |
| `native/src/<módulo>/CMakeLists.txt` e o header comum do módulo (demais módulos) | primeira tarefa do módulo: `core/` F0-10; `store/` F1-08; `adapters/` F1-11; `daemon/` F1-15; `client/` F1-20; `cli/` F1-21; `mcp/` F4-10; `ui/` F6-01; `updater/` F8-05 (ver linha própria acima) | entrada aplicada em série pelo coordenador |
| Arquivo central do gerenciador de sessões em `native/src/daemon/` (no TS, `packages/daemon/src/session-manager.ts`) | F1-18, depois F2-11 | as tarefas que o editam rodam em **série**, e a ordem está no campo "Depende": F2-11 → F2-12 → F2-16 → F2-13 → F2-14 → F2-15 → F3-01 (F3-01 injeta o hook do Codex no spawn, `session-manager.ts:2398` no TS); o resto de cada tarefa fica em arquivo próprio |
| Tabela nome → mapper dos adapters (no TS, `packages/adapters/src/mappers/index.ts`) | F1-14 | F3-02, F3-03, F3-04 e F3-05 só acrescentam a sua entrada, aplicadas em série na ordem dos IDs |
| Roteamento das abas da janela (no TS, o tipo `ActiveTab` e o `switch` em `packages/web/src/App.tsx:42`, `:520`) | F6-07 | as tarefas de tela (F6-08 a F6-17) entregam a sua entrada, aplicada em série pelo coordenador |
| Tabela de despacho HTTP (ordem de registro) | F1-19, depois F4-09 | F4-01..F4-08 entregam blocos de rotas em arquivo próprio; o coordenador os registra na ordem do TS (SPEC-01 "Contagem", item 2, e §6.4: `POST /sessions/adopt` antes de `/sessions/:id/...`); F4-09 confere a ordem |
| Tabela de comandos e texto de ajuda da CLI | F5-01 | F5-02..F5-12 entregam a entrada e as linhas de ajuda do seu comando; aplicação em série |
| `native/tests/conformance/` | F0-13 (`classifier/`, `domain/`, `mappers/`, `tools/` e as pastas que criar) | F4-14 escreve só em `native/tests/conformance/domain-errors/` |
| `docs/19-status-reescrita-c.md` | coordenador | nenhuma tarefa edita; cada uma entrega a evidência no relatório, e o coordenador registra |
| `docs/propostas/<id>.md` | a tarefa `<id>` | um arquivo por tarefa |

---

## 1. Fases e tarefas

### F0 — Fundação (esqueleto, CI, plataforma, vendorização)

> Em 2026-09-30 já existem: o esqueleto em `native/` (CMake com `CMakePresets.json`,
> `native/third_party/VERSIONS.md`, `.github/workflows/native.yml`), que cobre parte de F0-01 a
> F0-03; `CLAUDE.md` e `docs/18-padroes-c.md` (F0-04); o corpus de conformidade em
> `native/tests/conformance/{classifier,domain,mappers,tools}/` (F0-13); o spike de UI em andamento
> (F0-14); as propostas de F0-15, F2-19 e F8-04 em `docs/propostas/` (F7-01 em andamento). Os
> critérios abaixo definem quando cada uma recebe `[x]`.

#### F0-01 — Esqueleto de build (CMake + Ninja)
- **Entrega:** `native/CMakeLists.txt`, `native/cmake/`, um alvo de biblioteca por pasta de
  `native/src/` e os três executáveis decididos no ADR 09 (9.1): `agents-hubd` (serviço), `agents-hub`
  (janela e bandeja) e `hub` (CLI; MCP como `hub mcp serve` e hook como `hub hook`, adendo do ADR 09);
  integração com CTest.
- **Aceite:** padrão C17 (ADR 8.1); CMake + Ninja (ADR 8.3); configura e compila do zero com MSVC,
  clang-cl, GCC e Clang (ADR 8.2), sem nenhum warning no nível definido em `docs/18-padroes-c.md`; um
  teste trivial roda no CTest nos quatro; comandos reais registrados na tabela "Comandos" do
  `CLAUDE.md`; CMake ≥ 3.22 e C17 sem VLA e sem `<stdatomic.h>` (DA-11, confirmadas); testes com a
  macro `CHECK` própria do projeto (`native/tests/unit/ah_test.h`, DA-24), sem framework externo.
- **Decisões (ADR 09):** DA-11: confirmadas (C17 sem VLA/`stdatomic`, CMake ≥ 3.22, UI só sob evento, linuxdeploy + appimagetool); DA-24: manter a macro de teste própria do esqueleto; DA-14: serviço `agents-hubd` (sobe no login, sem janela); janela e bandeja em `agents-hub`, cliente da mesma API HTTP; CLI `hub`, com MCP e hook como subcomandos.
- **Depende:** —.
- **Agente:** build-release-engineer · **Área:** `native/CMakeLists.txt`, `native/cmake/`.

#### F0-02 — CI da reescrita
- **Entrega:** workflow de CI para `native/`.
- **Aceite:** matriz com MSVC (release Windows), clang-cl com **ASan + UBSan**, GCC e Clang no Linux
  (ADR 8.2); warnings tratados como erro; job Linux no Ubuntu 22.04, a base do AppImage (ADR 8.14);
  roda CTest (unit + integration + conformance); um job agregador é o portão (o mesmo modelo do CI
  atual, descrito no CONTRIBUTING.md). Ponto de partida: os presets de `native/CMakePresets.json`
  (`windows-msvc-debug`, `windows-msvc-release`, `windows-clangcl-asan`, `linux-gcc-debug`,
  `linux-clang-asan`) e `.github/workflows/native.yml`. Todo teste TS pulado por plataforma
  (SPEC-07 §5) tem equivalente no C rodando nos dois SOs da matriz (ADR 7.2).
  **Decidido (DA-26):** infraestrutura de fuzzing (libFuzzer com clang no Linux; fuzz curto por PR,
  longo noturno; achado vira regressão; quebra em sanitizer falha o job, SEC-R34); flags de
  endurecimento do release com conferência automática no binário e grep contra
  `system(`/`popen(`/`strcpy(`/`sprintf(` (SEC-R35). Cada alvo FZ01–FZ15 é escrito na tarefa dona do
  parser (FZ01, FZ02 e FZ10 → F1-15; FZ03 → F0-10; FZ04 e FZ12 → F2-03; FZ05 → F1-05; FZ06 → F1-13;
  FZ07 → F1-16, F3-07 e F4-02; FZ08 → F1-22; FZ09 → F4-10; FZ11 → F8-05; FZ13 e FZ15 → F1-12;
  FZ14 → F4-08); a F0-02 só monta a infraestrutura e registra os alvos no CI.
  **Ainda PROPOSTA:** checagem de formatação no CI (`docs/18-padroes-c.md` §11).
- **Decisões (ADR 09):** DA-26: adotar: fuzz curto no PR e longo noturno; flags de endurecimento no release.
- **Depende:** F0-01.
- **Agente:** build-release-engineer · **Área:** `.github/workflows/` (arquivo novo, sem mexer no CI do TS).

#### F0-03 — Vendorização das bibliotecas do núcleo
- **Entrega:** `native/third_party/{sqlite,picohttpparser,cjson,libyaml,pcre2,monocypher}/` com
  versão, hash e licença registrados.
- **Aceite:** SQLite 3.53 (ADR 8.5), picohttpparser (8.6), cJSON (8.7), libyaml (8.8), PCRE2 (8.9),
  Monocypher com os arquivos opcionais de Ed25519 (8.10); compila nos quatro compiladores; licenças
  de acordo com a tabela do ADR 08. As versões exatas que o `docs/18-padroes-c.md` §14 deixa ao plano
  são as registradas em `native/third_party/VERSIONS.md`: SQLite 3.53.4, picohttpparser 1.4, cJSON
  1.7.19, libyaml 0.2.5, PCRE2 10.49 (sem JIT) e Monocypher 4.0.3, cada uma com URL, SHA-256 e
  licença. A libcurl (8.11, Linux) e a sua biblioteca TLS não entram aqui (DA-25, F8-03).
- **Depende:** F0-01.
- **Agente:** build-release-engineer · **Área:** `native/third_party/` (exceto SDL3, SDL_ttf e Clay).

#### F0-04 — Padrões de código C
- **Entrega:** `docs/18-padroes-c.md` e a configuração de formatação.
- **Aceite:** registra como PROPOSTA o que o ADR 08 deixou sem decisão (C17 sem VLA e sem
  `<stdatomic.h>`, DA-11); define o nível de warning que F0-01 aplica; descreve a regra de camadas
  (`platform` é a única que chama o SO; `core` não faz I/O), coerente com o `CLAUDE.md`.
- **Decisões (ADR 09):** DA-11: confirmadas (C17 sem VLA/`stdatomic`, CMake ≥ 3.22, UI só sob evento, linuxdeploy + appimagetool).
- **Depende:** —.
- **Agente:** docs-writer · **Área:** `docs/18-padroes-c.md`, arquivo de formatação na raiz de `native/`.

#### F0-05 — Plataforma: texto, caminhos e arquivos
- **Entrega:** `native/src/platform/` (fs, caminhos, conversão UTF-8 ↔ UTF-16 no Windows).
- **Aceite:** escrita atômica por temporário + `rename` (SPEC-02 §6, `*.tmp-<pid>-…`; SPEC-03 §1.9);
  restrição de permissão do arquivo com o efeito do `chmod 0600` no POSIX e de
  `icacls /inheritance:r /grant:r <principal>:F` no Windows (SPEC-01 §4, SPEC-02 §6.2); resolução do
  home (`AGENTS_HUB_HOME` ou `~/.agents-hub`, SPEC-02 §1); criação de diretório com pais; caminhos
  não ASCII funcionando no Windows. Ligado a SEC-R15 e SEC-R16 (DACL por SID; 0700/0600), que
  dependem de DV-32 e DV-33. Teste TS equivalente: `daemon/src/safe-write.test.ts` (parte atômica).
- **Decisões (ADR 09):** DV-32: DACL por SID na criação do token, reconferida a cada subida; DV-33: pasta 0700, arquivos 0600, `umask(077)`.
- **Depende:** F0-01, F0-04.
- **Agente:** c-engineer · **Área:** `native/src/platform/` (arquivos de fs/caminho).

#### F0-06 — Plataforma: tempo, aleatoriedade e ambiente
- **Entrega:** `native/src/platform/` (relógio, CSPRNG, variáveis de ambiente, usuário do SO).
- **Aceite:** carimbo ISO 8601 UTC com milissegundos e `Z` (SPEC-02 §4.1); hora local para nomes de
  backup `AAAAMMDD-HHMMSS` (SPEC-02 §6); relógio monotônico; 32 bytes aleatórios do SO para o token
  (SPEC-01 §4) e para os ids derivados de UUID v4 (SPEC-04 A1); leitura do usuário do SO, usado em
  `cli:<usuário>` (SPEC-01 §4).
- **Depende:** F0-01, F0-04.
- **Agente:** c-engineer · **Área:** `native/src/platform/` (tempo/aleatório/env).

#### F0-07 — Plataforma: processos (spawn, pipes, ambiente)
- **Entrega:** `native/src/platform/` (spawn sem shell, stdin/stdout/stderr em pipe, cwd, env,
  janela oculta, grupo de processos).
- **Aceite:** equivalente ao `spawn` de SPEC-04 B4 passo 4 (`shell: false`, `windowsHide`,
  `windowsVerbatimArguments` quando pedido, POSIX `detached`, SPEC-04 B6 `opcoesDeGrupo`); leitura sem
  bloquear o laço; código de saída e sinal. Teste com um executável auxiliar de teste, sem agente real.
  Ligado a SEC-R26 (caminho absoluto sempre, sem busca no diretório corrente, SPEC-08 P1) e SEC-R28
  (filho herda só os três pipes, SPEC-08 P4), ambos PROPOSTA da SPEC-08.
- **Decisões (ADR 09):** DA-29: adotar todos os endurecimentos listados.
- **Depende:** F0-01, F0-04.
- **Agente:** c-engineer · **Área:** `native/src/platform/` (processos).

#### F0-08 — Plataforma: árvore de processos e identidade de PID
- **Entrega:** `native/src/platform/` (kill da árvore, imagem e horário de criação do processo).
- **Aceite:** no Windows, o mecanismo é **Job Object por sessão** (DV-37): o processo do agente
  entra no job ao nascer, o job usa `KILL_ON_JOB_CLOSE`, e o cancelamento chama `TerminateJobObject`
  (SPEC-08 P5); um teste confere que o Claude e o Codex funcionam dentro do job (jobs aninhados). No
  POSIX, como o TS (SPEC-04 B6): foto PID→PPID antes, SIGKILL ao grupo e aos descendentes, sonda a
  cada 50 ms. Nos dois SOs, a espera pela árvore continua com teto de 5 s. Continuam também
  `imagemDoProcesso`, `imagemPareceEsperada` e `pidPareceReciclado` (janela de 5 s): servem à
  reconciliação de PID órfão na subida (SPEC-04 B6; SPEC-02 §4.2), não ao kill, e valem nos dois SOs.
  SEC-R29: agente falso com netos, cancelar mata todos; daemon morto à força → filhos mortos (job) ou
  recolhidos na subida. Teste TS
  equivalente: `adapters/src/process-tree.test.ts`.
- **Decisões (ADR 09):** DV-37: Job Object por sessão no Windows, em vez de `taskkill /T`.
- **Depende:** F0-07.
- **Agente:** c-engineer · **Área:** `native/src/platform/` (árvore de processos).

#### F0-09 — Plataforma: sockets loopback, laço de eventos, timers e threads
- **Entrega:** `native/src/platform/` (TCP em 127.0.0.1, I/O não bloqueante, timers, thread, mutex,
  condição).
- **Aceite:** escuta numa porta, inclusive `port: 0` com leitura da porta real (SPEC-01 §1); falha
  clara com a porta ocupada (a porta é o lock de instância, SPEC-01 §1); laço que dorme sem trabalho,
  sem polling periódico ocioso (meta de CPU parado ≈ 0, ADR 08); cliente TCP para o `client`.
  Nenhum uso de `<stdatomic.h>` enquanto DA-11 estiver aberta. Ligado a SEC-R12 e SEC-R14 (dono da
  conexão; `SO_EXCLUSIVEADDRUSE`), que dependem de DV-30 e DV-31.
- **Decisões (ADR 09):** DA-11: confirmadas (C17 sem VLA/`stdatomic`, CMake ≥ 3.22, UI só sob evento, linuxdeploy + appimagetool); DV-30: conferir que quem conecta é o mesmo usuário do SO; outro usuário → 403; DV-31: o cliente confere o dono do socket antes de mandar o token; `SO_EXCLUSIVEADDRUSE` no Windows.
- **Depende:** F0-01, F0-04.
- **Agente:** c-engineer · **Área:** `native/src/platform/` (rede/laço/threads).

#### F0-10 — Utilitários sem I/O: UTF-8, JSON, YAML, regex
- **Entrega:** `native/src/core/` (camada fina sobre cJSON, libyaml e PCRE2; buffers e texto).
- **Aceite:** serialização JSON compatível com `JSON.stringify` nos casos que o banco e a API usam
  (SPEC-02 §4.1; SPEC-01 §2); leitura de JSON tolerante, em que vazio ou inválido vira o padrão
  (SPEC-02 §4.1); YAML com escalares sem tag entregues como texto e tipagem feita pelo Hub (fato do
  ADR 08 sobre a libyaml); regex com flag `i` para manifestos e classificador (SPEC-04 B2, A6).
  Ligado a SEC-R36 (tetos de alias, documento e profundidade no YAML) e SEC-R37 (limites de casamento
  no PCRE2), PROPOSTA da SPEC-08 (C2, C3).
- **Fuzz (SPEC-08 C4; DA-26):** FZ03 (carregador YAML: config de repositório, manifestos, workflows; oráculo: teto de aliases e tipagem igual à do TS); o alvo roda na infraestrutura da F0-02.
- **Decisões (ADR 09):** DA-29: adotar todos os endurecimentos listados.
- **Depende:** F0-03, F0-04.
- **Agente:** c-engineer · **Área:** `native/src/core/` (utilitários).

#### F0-11 — Runner de conformidade e utilitários de teste
- **Entrega:** integração do corpus de `native/tests/conformance/` com o CTest; helper que sobe o
  serviço C isolado (home temporário, porta livre, `NO_AUTOSTART=1`).
- **Aceite:** CTest executa o corpus e informa caso a caso o que passou e o que falhou; casos com
  marca de divergência (`divergencia`/`divergence`/`DIVERGÊNCIA CONHECIDA` nos READMEs do corpus)
  aparecem com o ID da DV correspondente; o helper nunca usa a porta 4747 nem `~/.agents-hub` (há um
  teste que prova isso); testes com a macro própria (DA-24). **Esperado decidido:** para DV decidida
  como "corrigir" no ADR 09, o esperado do C é o decidido, não o do corpus; o runner mantém uma tabela
  de "esperado decidido" em `native/tests/conformance/runner/` (caso → DV → esperado novo), e o caso
  sem entrada nessa tabela compara com o corpus. Quem implementa a correção (a tarefa da linha
  Decisões) acrescenta as entradas dos casos afetados; DV decidida como "manter"/"reproduzir" (DV-03,
  DV-06, DV-27, DV-45) compara com o corpus.
- **Decisões (ADR 09):** DA-24: manter a macro de teste própria do esqueleto.
- **Depende:** F0-01, F0-13.
- **Agente:** test-engineer · **Área:** `native/tests/conformance/runner/`, `native/tests/integration/` (helper).

#### F0-12 — Vendorização da UI (SDL3, SDL_ttf, Clay)
- **Entrega:** `native/third_party/{sdl3,sdl_ttf,clay}/` e, com o SDL_ttf, FreeType e HarfBuzz
  (DA-25), com versão, hash e licença registrados em `native/third_party/VERSIONS.md`; sem plutosvg no
  Windows (emoji colorido COLR, DA-12 parte Windows); a parte Linux (plutosvg) espera a DA-12; um teste
  de fumaça em `native/tests/unit/ui_smoke/`.
- **Aceite:** ADR 8.4 (Zlib nos três); compila nos quatro compiladores; uma janela vazia abre no
  Windows e no Linux; texto com shaping (HarfBuzz) e emoji COLR renderizados no Windows; licenças de
  FreeType e HarfBuzz registradas.
- **Decisões (ADR 09):** DA-25: FreeType e HarfBuzz vendorizados com o SDL_ttf; libcurl do sistema no Linux, empacotada no AppImage; DA-12 (parte Windows): HarfBuzz vem com o SDL_ttf; emoji colorido COLR sem plutosvg no Windows.
- **Depende:** F0-01, F0-14 · bloqueia o aceite: DA-12 (parte Linux).
- **Agente:** build-release-engineer · **Área:** `native/third_party/` (UI), `native/tests/unit/ui_smoke/`.

#### F0-13 — Corpus de conformidade gerado do TS
- **Entrega:** `native/tests/conformance/` (casos de entrada e saída gerados com o TS isolado).
- **Aceite:** cada caso cita a seção da SPEC que cobre; geração reproduzível com o hub TS isolado
  (regra de §0); nenhum caso grava no daemon real nem chama modelo real; cobertura mínima: contrato
  HTTP (SPEC-01 §2–§9), esquema do banco após a migração 10 (SPEC-02 §3, procedimento do §9),
  classificador e política (SPEC-04 A5–A7), mappers (SPEC-04 B7), saídas da CLI (SPEC-03); inclui os
  casos de segurança do TS que SEC-R01 exige (guarda, 401 antes do corpo, 413, `MALFORMED_URL`, ids,
  classificador, caminhos sensíveis, gate, modo de falha). O corpus continua registrando o
  comportamento do TS **como ele é**, inclusive nos casos de DV decidida como "corrigir": esses casos
  não são regerados com o valor novo; o esperado decidido mora na tabela do runner (F0-11).
- **Depende:** — · bloqueia o aceite: DA-30.
- **Agente:** test-engineer · **Área:** `native/tests/conformance/` (dados do corpus).

#### F0-14 — Spike de UI e relatório
- **Entrega:** protótipo descartável em `native/spikes/ui/`, com o relatório do resultado na mesma
  pasta (o coordenador registra em `docs/19-status-reescrita-c.md`).
- **Aceite:** responde, com evidência (captura e medição), os pontos que o ADR 08 manda confirmar no
  primeiro protótipo: shaping com HarfBuzz pelo SDL_ttf e emoji colorido com plutosvg (DA-12); laço
  redesenhando só sob evento, com CPU parado medido (proposta do ADR 08, DA-11); `SDL_CreateTray` na
  thread principal no Windows e no Linux, com e sem `libayatana-appindicator3`/`libappindicator3`
  (risco aceito no ADR 08); entrada de texto com IME. O código do spike nunca entra no produto.
- **Decisões (ADR 09):** DA-12 (parte Windows): HarfBuzz vem com o SDL_ttf; emoji colorido COLR sem plutosvg no Windows (a parte Linux, plutosvg e tray sem appindicator, segue aberta).
- **Depende:** —.
- **Agente:** c-engineer (medição: performance-auditor) · **Área:** `native/spikes/ui/`.

#### F0-15 — Proposta do procedimento de medição
- **Entrega:** proposta escrita do procedimento de medição das metas, para o dono decidir (DA-05).
- **Aceite:** cobre as 7 metas do ADR 08 e as definições de medida da SPEC-06 ("Ambiente da medição":
  `WorkingSet64`/`PrivateMemorySize64`, tempo do spawn até o evento); diz o equivalente no Linux;
  parte da proposta não decidida da SPEC-06 ("mediana de pelo menos 5 execuções na mesma máquina de
  referência e serviço isolado"); parte do harness da linha de base preservado em
  `native/tests/bench/ts-baseline/`; aponta onde o harness do C vai morar (`native/tests/bench/`
  existe, mas não está na estrutura original do coordenador, ver §6).
- **Depende:** —.
- **Agente:** performance-auditor · **Área:** `docs/propostas/F0-15-procedimento-de-medicao.md`.

**Paralelo na F0:** {F0-01, F0-04, F0-13, F0-14, F0-15} já; depois de F0-01: {F0-02, F0-03} ∥
{F0-05, F0-06, F0-07, F0-09} (arquivos distintos em `platform/`; o `CMakeLists.txt` e o header comum
de `platform/` são da F0-05, conforme a tabela de donos do §0) ∥ F0-11; depois F0-08, F0-10 e F0-12.

---

### F1 — Vertical fina (ADR 7.18)

Objetivo: uma sessão real do Claude de ponta a ponta. A CLI pede, o serviço HTTP cria a sessão, o
store grava, o adapter roda o `claude` e os eventos voltam por SSE.

**Limite da F1 (para não antecipar):** a rota do gate (`POST /hooks/pretooluse`) e o classificador
de comandos são da F2. Na F1, o `hub hook` existe (F1-22), mas o daemon responde 404 nessa rota, e o
hook cai no modo de falha de SPEC-03 §1.5 (fechado dentro de sessão do Hub, ou seja, nega ação de
risco). A prova de F1 usa um objetivo sem ferramenta.

#### F1-01 — Core: ids, tempo, erros e tipos de domínio
- **Entrega:** `native/src/core/` (ids, `objectiveHash`, `HubErrorCode`, entidades e enumerações).
- **Aceite:** prefixos e formato `<prefixo>_<24 hex>` (SPEC-04 A1; SPEC-02 §4.1); `objectiveHash`
  com a normalização de A1, e o exemplo executado da SPEC (`'Fix the bug.'` e `'  fix THE   bug '` →
  `280fd7e3571b7c85`) passa; os 32 códigos de `HubErrorCode` (SPEC-04 A1); entidades `Project` a
  `BudgetRecord` (A1); `SessionMode`, `MODE_RANK`, `narrowestMode`, `IsolationMode` (A1). Teste TS
  equivalente: `core/src/brief.test.ts` (casos de `objectiveHash`).
- **Depende:** F0-06, F0-10.
- **Agente:** c-engineer · **Área:** `native/src/core/` (ids, erros, domínio).

#### F1-02 — Core: eventos e custo de turno
- **Entrega:** `native/src/core/` (22 tipos de evento, `EventCost`, `EventEnvelope`, `makeEvent`,
  `SequenceCounter`, `NARRATIVE_EVENTS`, `TurnCostTracker`, `usoDoCusto`).
- **Aceite:** SPEC-04 A2 (22 tipos, na ordem do código); `SequenceCounter` começa em 1 e `seed` só
  sobe; SPEC-04 A12 (`TurnCostTracker`: final, provisório cumulativo, parciais por `partId`,
  `pending`, `flush`); regra "provisional não soma" (SPEC-02 §4.4). Teste TS equivalente:
  `adapters/src/mappers/turn-cost.test.ts`.
- **Depende:** F1-01.
- **Agente:** c-engineer · **Área:** `native/src/core/` (eventos, custo de turno).

#### F1-03 — Core: Brief
- **Entrega:** `native/src/core/` (schema do Brief, `parseBrief`, `renderBriefAsPrompt`).
- **Aceite:** limites e padrões da tabela de SPEC-04 A4 (objetivo de 8 a 50.000 após `trim`; listas
  até 200; `artifacts[].path` sem absoluto nem `..`); o Brief **não** é estrito, então chave
  desconhecida é descartada (SPEC-01 §6.9); falha → `INVALID_BRIEF` com `issues[{path,message}]` e a
  mensagem `"Brief inválido"` (`packages/core/src/brief.ts:121`); cada item de
  `issues` reproduz o código e o caminho do campo do TS, com texto próprio em pt-BR (DA-23);
  `isolation: container` é recusado na entrada com erro claro (DA-21);
  limites contados em unidades UTF-16, como no corpus (`native/tests/conformance/domain/README.md`);
  `renderBriefAsPrompt` com as seções na ordem de A4. Teste TS equivalente: `core/src/brief.test.ts`;
  corpus `native/tests/conformance/domain/brief.jsonl`.
- **Decisões (ADR 09):** DA-21: recusar `container` com erro claro na entrada; ler linhas antigas como estão; DA-23: reproduzir só o código e o caminho do campo; texto próprio em pt-BR.
- **Depende:** F1-01.
- **Agente:** c-engineer · **Área:** `native/src/core/` (brief).

#### F1-04 — Core: documento de política
- **Entrega:** `native/src/core/` (`PolicyDocument`, `DEFAULT_POLICY`, validação estrita, versão
  parcial, fusão sem clamp).
- **Aceite:** campos, faixas e padrões da tabela "PolicyDocument e DEFAULT_POLICY" de SPEC-04 A5
  (incluindo as 92 entradas de `commands.allow` e as 10 de `commands.deny`); `.strict()` em todo
  nível, com chave desconhecida = erro; versão parcial (`deepPartial`) para `config.json`
  (SPEC-02 §6.1); fusão global sem clamp, campo a campo dentro de `defaultBudget`, `risk`, `retries`,
  `fallback` e `validation.review` (A5 "Camadas"). Testes TS equivalentes:
  `core/src/policy-schema.test.ts`; `core/src/policy-merge.test.ts` (casos sem clamp).
- **Depende:** F1-01.
- **Agente:** c-engineer · **Área:** `native/src/core/` (documento de política).

#### F1-05 — Core: caminhos sensíveis e leitura comum
- **Entrega:** `native/src/core/` (`matchSensitivePath`, `matchSecretPath`, `agentOwnDirs`,
  `fragmentMatches`; critério `leituraComum`).
- **Aceite:** casamento por segmento e a ordem de SPEC-04 A7 (secret, exec-config, `.env.<x>` com as
  exceções, chaves, extensões, os 12 `GLOB_PROBES`); `leituraComum` igual a
  `daemon/src/pretool-gate.ts:131` (fonte citada em SPEC-03 §1.5). Testes TS equivalentes: casos de
  caminho sensível em `core/src/command-classifier.test.ts` e `core/src/policy-edit.test.ts`;
  `daemon/src/pretool-gate.test.ts` (casos de `leituraComum`); corpus
  `native/tests/conformance/classifier/sensitive.jsonl`. Acréscimos à lista embutida (pasta de
  instalação, Inicializar, `~/.config/autostart`; SEC-R39) dependem de DV-36.
- **Fuzz (SPEC-08 C4; DA-26):** FZ05 (`matchSensitivePath`, normalização de caminho e `raizProibida`; diferencial contra o TS); o alvo roda na infraestrutura da F0-02.
- **Decisões (ADR 09):** DV-36: pasta de instalação e locais de autostart na lista de caminhos sensíveis; `reg add …\Run` = `irreversible`.
- **Depende:** F1-01.
- **Agente:** c-engineer · **Área:** `native/src/core/` (caminhos sensíveis).

#### F1-06 — Core: livro-caixa de orçamento
- **Entrega:** `native/src/core/` (`BudgetLedger`).
- **Aceite:** todas as operações da tabela de SPEC-04 A8 (`snapshot` com limiar 0,8, `reserve` com
  `BUDGET_EXCEEDED` e restauração da fatia, `charge`, `estimate`, `settle`, `release`, `raiseLimits`,
  `setLimits`, `project`); entrada não finita ou ≤ 0 vira 0; limite `0` numa dimensão nasce
  `exhausted` (SPEC-04 A8: `exhausted` se `consumed ≥ limite`; confirmado no corpus,
  `native/tests/conformance/domain/README.md`). Isso responde ao NÃO DETERMINADO de SPEC-02 §3.8 sobre o
  significado do limite 0: bloqueado, não ilimitado. O construtor saneia `limits` como o `setLimits` (DV-44): limite não
  finito ou ≤ 0 vira 0 e, como todo limite 0, nasce `exhausted`; o caso do corpus com limite `NaN` usa o
  esperado decidido (regra do F0-11). Teste TS equivalente: `core/src/budget.test.ts`; corpus
  `native/tests/conformance/domain/budget.jsonl`.
- **Decisões (ADR 09):** DV-44: sanear `limits` no construtor como o `setLimits`.
- **Depende:** F1-01.
- **Agente:** c-engineer · **Área:** `native/src/core/` (orçamento).

#### F1-07 — Configuração, variáveis de ambiente e token de operador
- **Entrega:** parse e validação puros em `native/src/core/`, leitura de arquivos via
  `native/src/platform/`; `config.json`, `readHubEnv`, diretórios do home, `operator-token`.
- **Aceite:** precedência padrão < `config.json` < env < override (SPEC-01 §1, SPEC-02 §6.1); BOM
  removido; erro `HUB_CONFIG_INVALID` com linha e coluna; chaves desconhecidas aceitas e `policy`
  estrita (SPEC-02 §6.1); `AGENTS_HUB_PORT` 1–65535 e `AGENTS_HUB_NO_AUTOSTART` só `0`/`1`
  (SPEC-03 §1.7); cria `home`, `worktrees/`, `artifacts/` e `logs/` (SPEC-02 §6); token reaproveitado
  se casar `^[0-9a-f]{64}$` após `trim`, senão gerado em temporário `0600`, restringido e renomeado,
  com aviso se a restrição falhar (SPEC-01 §4, SPEC-02 §6.2). Ligado a SEC-R11 (`host` só loopback,
  DV-29), SEC-R15 (DACL por SID, DV-32) e SEC-R16 (0700/0600, DV-33). A mensagem de erro de JSON
  inválido mantém `arquivo:linha:coluna`, sem o texto do V8 (SPEC-07 §4.A). Testes TS equivalentes:
  `daemon/src/config.test.ts`, `core/src/hub-env.test.ts`, `daemon/src/env.test.ts`,
  `daemon/src/operator-auth.test.ts` (geração do token).
- **Decisões (ADR 09):** DV-23: tudo deriva do home efetivo (inclusive `dbFile`, `worktreeRoot`, `artifactRoot`, `logDir`); DV-29: recusar `host` não loopback no `config.json` (`HUB_CONFIG_INVALID`); DV-32: DACL por SID na criação do token, reconferida a cada subida; DV-33: pasta 0700, arquivos 0600, `umask(077)`.
- **Depende:** F0-05, F0-06, F1-04.
- **Agente:** c-engineer · **Área:** `native/src/core/` (config), `native/src/platform/` (só chamadas já existentes).

#### F1-08 — Store: abertura, PRAGMAs e migrações 1 a 10
- **Entrega:** `native/src/store/` (abertura, executor de migrações, as 10 migrações).
- **Aceite:** PRAGMAs na ordem de SPEC-02 §1.1; tabela `migrations`, guarda contra downgrade
  (`HUB_CONFIG_INVALID`), cada migração em transação (SPEC-02 §1.2); SQL das migrações 1 a 10 idêntico
  em efeito (SPEC-02 §2, §2.1); um banco novo do C, despejado pelo procedimento de SPEC-02 §9
  (`sqlite_master`, `table_xinfo`, `foreign_key_list`, `index_list`), é igual ao do TS; abre um banco
  v10 gerado pelo TS e migra um banco v<10; linhas antigas com `sessions.isolation = 'container'`
  (SPEC-02 §3.3) são lidas conforme DA-21; permissão dos arquivos `hub.db*` conforme DV-33 (SEC-R16). Testes TS
  equivalentes: `store/src/db.test.ts`, `store/src/integridade.test.ts`.
- **Decisões (ADR 09):** DA-21: recusar `container` com erro claro na entrada; ler linhas antigas como estão; DV-33: pasta 0700, arquivos 0600, `umask(077)`.
- **Depende:** F0-03, F0-05, F1-01.
- **Agente:** c-engineer · **Área:** `native/src/store/` (db, migrações).

#### F1-09 — Store: projetos, pastas, sessões e tasks
- **Entrega:** `native/src/store/` (repositórios `projects`, `project_folders`, `sessions`, `tasks`).
- **Aceite:** colunas, booleanos (só `1` é verdadeiro) e JSON tolerante de SPEC-02 §3.1–§3.4 e §4;
  `hub_context` ilegível vira `{}` (SPEC-02 §5); `project_folders` é a única tabela com `DELETE`;
  `updated_at` reescrito em todo `update`; "ativa" = `running` ou `waiting_approval`. Teste TS
  equivalente: `store/src/repositories.test.ts` (partes dessas tabelas).
- **Depende:** F1-08.
- **Agente:** c-engineer · **Área:** `native/src/store/` (repos de projeto/sessão/task).

#### F1-10 — Store: eventos, aprovações, artefatos, orçamentos e auditoria
- **Entrega:** `native/src/store/` (repositórios `events`, `approvals`, `artifacts`, `budgets`, `audit_log`).
- **Aceite:** filtro de `EventRepository.list` (`sessionId`, `taskId`, `sinceSeq`, `beforeSeq`,
  `newest`, `types`, `limit` 1..5000 com padrão 500, `tail`; SPEC-04 A1 "Portas"); resultado sempre em
  `seq` crescente; página limitada em 8 MiB, com os eventos seguintes sem `raw` e com texto curto
  (SPEC-01 §6.4 linha 32, §8.1); `costOf` sem provisórios; `budgets` com
  `INSERT … ON CONFLICT DO UPDATE` e JSON ilegível → `{0,0,0}` (SPEC-02 §3.8); auditoria só por
  acréscimo, ordenada por `ts DESC, rowid DESC`, limite 200 e teto 5000 (SPEC-02 §3.9). Testes TS
  equivalentes: `store/src/events-page.test.ts`, `store/src/repositories.test.ts`,
  `daemon/src/event-limits.test.ts`.
- **Depende:** F1-08, F1-02.
- **Agente:** c-engineer · **Área:** `native/src/store/` (repos de evento/aprovação/artefato/orçamento/auditoria).

#### F1-11 — Adapters: manifesto, registry mínimo e probe
- **Entrega:** `native/src/adapters/` (schema do manifesto, carga de diretório, registry, probe,
  cache `probes.json`).
- **Aceite:** campos e padrões de SPEC-04 B2 "Schema"; validações extras (`{{model}}`,
  `{{settingsFile}}`, regex `nativeSessionMissing` que compila); carga de `*.yaml`/`*.yml` em ordem
  alfabética, manifesto inválido → `ILLEGAL_STATE` com `issues`; id duplicado → `ILLEGAL_STATE`
  (SPEC-04 B3); probe com `detect.args`, timeout e `versionRegex` (SPEC-04 B4 "Probe"); cache de 24 h
  para instalado e 5 min para não instalado, arquivo corrompido ignorado (SPEC-02 §6.3); os 9
  manifestos de `manifests/` validam; `defaults.isolation` (qualquer valor, inclusive `container`) é
  aceito com aviso de obsoleto e ignorado (DA-33, DV-10); um manifesto de usuário com o campo continua
  válido. Teste TS equivalente: `adapters/src/manifest-model.test.ts`; corpus
  `native/tests/conformance/mappers/manifest-schema.jsonl`.
- **Decisões (ADR 09):** DA-33: o schema do manifesto aceita `defaults.isolation` com aviso de obsoleto e não o usa; manifestos empacotados limpos; manifestos de usuário continuam válidos.
- **Depende:** F0-07, F0-10, F1-01.
- **Agente:** c-engineer · **Área:** `native/src/adapters/` (manifesto, registry).

#### F1-12 — Adapters: resolução de binário e montagem do spawn
- **Entrega:** `native/src/adapters/` (busca no PATH, fallbacks, desembrulho do shim npm, `montarSpawn`).
- **Aceite:** SPEC-04 B5 inteira: PATH × PATHEXT no Windows com a ordem `.exe` > `.cmd`/`.bat`, sem o
  diretório corrente, fallbacks fixos; `which` no POSIX; cache positivo/negativo de 30 s; desembrulho
  do shim; via `cmd.exe`, escape duplo, recusa de `\r`/`\n`/NUL e teto de 8.191 caracteres →
  `ADAPTER_FAILURE`. Ligado a SEC-R26 (executável falso no worktree nunca executado) e SEC-R27
  (`.bat`/`.cmd` só pelo caminho explícito de `cmd.exe /d /s /c`), PROPOSTA da SPEC-08 (P1, P2).
  Testes TS equivalentes: `adapters/src/bin-resolver.test.ts`,
  `adapters/src/bin-resolver-lookup.test.ts`, `adapters/src/prompt-delivery.test.ts` (inclusive os
  casos só-Windows, SPEC-07 §5).
- **Fuzz (SPEC-08 C4; DA-26):** FZ13 (desembrulho de shim `.cmd`/`.bat`); FZ15 (`escaparArgParaCmd`; o argv reconstruído por `CommandLineToArgvW` depois do `cmd.exe` é igual ao original); o alvo roda na infraestrutura da F0-02.
- **Decisões (ADR 09):** DA-29: adotar todos os endurecimentos listados.
- **Depende:** F0-07.
- **Agente:** c-engineer · **Área:** `native/src/adapters/` (bin resolver).

#### F1-13 — Adapters: adapter genérico de processo
- **Entrega:** `native/src/adapters/` (`ProcessAgentAdapter`, leitor de linhas, placeholders,
  `montarInvocacao`, ambiente da run).
- **Aceite:** contrato de SPEC-04 B1 (`start`, `resume`, `send`, `interrupt`, `cancel`, `RunOutcome`);
  spawn em 10 passos (B4), com heartbeat e teto rearmados a cada linha, fila 1000/200/5000 e
  "fila de eventos saturada"; leitor de linhas com teto de 16 MiB e ` [truncado N bytes]` (B4.1);
  placeholders e remoção de argumento vazio (B2 "Placeholders"); ordem de montagem do argv, que
  reproduz a tabela "Argv efetivo" de B2 para os 9 agentes; `motivoDaFalha`; `modeloDaRun`
  (B4); ambiente da run com `AGENTS_HUB_SESSION_ID`/`TASK_ID`/`AGENT_ID` (B9); `interrupt` no POSIX
  com SIGINT e 5 s; comportamento do código TS (ADR 7.9), com duas correções decididas: os cortes nos
  tetos são feitos em fronteira de code point UTF-8, com o mesmo teto (DV-42), e prompt vazio é
  recusado antes do spawn (DV-43); os casos do corpus afetados usam o esperado decidido (F0-11). Testes TS equivalentes:
  `adapters/src/process-adapter.test.ts`, `adapters/src/process-adapter.backpressure.test.ts`,
  `adapters/src/process-adapter.overall-timeout.test.ts`, `adapters/src/line-reader.test.ts`,
  `adapters/src/failure-reason.test.ts`, `daemon/src/teste-real-rodada1.test.ts` (parte de mapper e
  desfecho); corpus `native/tests/conformance/mappers/{invocation,failure-reason}.jsonl`.
- **Fuzz (SPEC-08 C4; DA-26):** FZ06 (leitor de linhas + cada mapper; linha > 16 MiB truncada com marcador); o alvo roda na infraestrutura da F0-02.
- **Decisões (ADR 09):** DV-42: cortar em fronteira de code point UTF-8, mesmo teto; DV-43: recusar prompt vazio antes do spawn.
- **Depende:** F0-08, F1-02, F1-11, F1-12.
- **Agente:** c-engineer · **Área:** `native/src/adapters/` (processo).

#### F1-14 — Adapters: mapper do Claude
- **Entrega:** `native/src/adapters/` (mapper `claude`, usado também por openclaude).
- **Aceite:** tabela "claude" de SPEC-04 B7 (id nativo só em `system/init` e `result`; `usage` no
  último evento da linha como provisório com `partId`; custo final em `result`; `tool_result` cortado
  em 4.000); linha que não é objeto → `[]`. Teste TS equivalente: `adapters/src/mappers/claude.test.ts`;
  corpus `native/tests/conformance/mappers/claude.jsonl`.
- **Decisões (ADR 09):** DV-42: cortar em fronteira de code point UTF-8, mesmo teto; DV-45: reproduzir as tolerâncias dos mappers.
- **Depende:** F1-02.
- **Agente:** c-engineer · **Área:** `native/src/adapters/` (mapper claude).

#### F1-15 — Daemon: servidor HTTP, guarda e token
- **Entrega:** `native/src/daemon/` (servidor próprio sobre picohttpparser, despacho por tabela,
  respostas, guarda de borda, autenticação de operador).
- **Aceite:** bind `127.0.0.1:4747` e precedência da porta, lock pela porta antes de tocar no banco
  (SPEC-01 §1); formato de erro, tabela código → status e 404 para método errado (SPEC-01 §2);
  validação de corpo estrita (422 `INVALID_BRIEF` com `details.issues`) e de parâmetro (400
  `INVALID_ID` ou `INVALID_QUERY`, conforme o módulo) (SPEC-01 §2); guarda Host/Origin/Sec-Fetch-Site/
  Content-Type na ordem, com 415 `FORBIDDEN` (SPEC-01 §3); token por Bearer, `X-Hub-Token` e cookie, na
  ordem e com comparação em tempo constante, e identidade `by` (SPEC-01 §4); teto de 5.000.000 bytes,
  descarte até 64.000.000 e `%` malformado (SPEC-01 §5); despacho na ordem de registro (SPEC-01 §6.4).
  Os schemas de corpo provam aceita/recusa como o TS; o texto de cada `issue` depende de DA-23
  (SPEC-07 §4.A). Requisitos de segurança ligados (SPEC-08 §3): SEC-R04 (DV-28), SEC-R05 (DV-40),
  SEC-R06 (DV-38), SEC-R07 (DV-39), SEC-R08 e SEC-R10 (DV-01), SEC-R09 (com F2-14), SEC-R12 (DV-30).
  Testes TS equivalentes: `daemon/src/guard.test.ts`, `daemon/src/codigos-http.test.ts`,
  `daemon/src/http-hardening.test.ts`, `daemon/src/http-schemas.test.ts`,
  `daemon/src/operator-auth.test.ts`, `daemon/src/porta-zero.test.ts`, `daemon/src/route-ids.test.ts`,
  `daemon/src/server.test.ts` (`statusFor`).
- **Fuzz (SPEC-08 C4; DA-26):** FZ01 (máquina de estados da conexão: pedido + guarda + leitor de corpo; oráculo: guarda e leitor concordam sobre "tem corpo", nunca lê além do teto); FZ02 (cJSON + validadores estritos de cada rota; mesmo veredito que o corpus); FZ10 (decodificação `%`, query e inteiros `since`/`limit`/`before`); o alvo roda na infraestrutura da F0-02.
- **Decisões (ADR 09):** DV-01: definir timeouts explícitos, com os valores da SPEC-08 H3 como ponto de partida, medidos na F1; DV-28: recusar todo `Origin` e todo `Sec-Fetch-Site` ≠ `none` em método que muda estado; DV-30: conferir que quem conecta é o mesmo usuário do SO; outro usuário → 403; DV-38: 400 para `Content-Length` repetido, não decimal ou > 2^53, `Transfer-Encoding` ≠ `chunked` ou junto de CL, `Host` repetido; DV-39: 414 para linha de pedido > 8 KiB; 431 para cabeçalhos > 16 KiB ou > 64; DV-40: `Host` só com caracteres de `[A-Za-z0-9.:\[\]-]`, além da paridade M2; DA-23: reproduzir só o código e o caminho do campo; texto próprio em pt-BR.
- **Depende:** F0-09, F1-01, F1-07.
- **Agente:** c-engineer · **Área:** `native/src/daemon/` (http, guarda, auth).

#### F1-16 — Daemon: barramento, SSE comum e `GET /events`
- **Entrega:** `native/src/daemon/` (barramento de eventos, canal SSE, rota 58).
- **Aceite:** cabeçalhos, comentário inicial, frame sem `event:`, heartbeat de 20.000 ms, fila de 700
  para cliente lento, teto `maxSseConnections` com 503 conferido antes do `writeHead`, aviso de
  truncamento sintético (SPEC-01 §8.1); filtros `sessionId`/`rootId`, `id:` só com `sessionId`, replay
  de até 500 eventos e `since` estrito (SPEC-01 §8.2); `subscribers` do `/health` sem contar os
  observadores internos (SPEC-01 §1). Testes TS equivalentes: `daemon/src/sse.test.ts`,
  `daemon/src/sse-http.test.ts`, `daemon/src/event-flood-http.test.ts`.
- **Fuzz (SPEC-08 C4; DA-26):** FZ07, parte do parser de `Last-Event-ID` de `GET /events` (aceito pela DV-02); o alvo roda na infraestrutura da F0-02.
- **Decisões (ADR 09):** DV-02: aceitar `Last-Event-ID` em `GET /events`, além de `?since=`; DV-04: validar o formato de `sessionId`/`rootId`; formato inválido = inexistente.
- **Depende:** F1-10, F1-15.
- **Agente:** c-engineer · **Área:** `native/src/daemon/` (bus, sse).

#### F1-17 — Daemon: worktree por sessão e settings do gate
- **Entrega:** `native/src/daemon/` (worktree git e arquivo de settings por sessão).
- **Aceite:** worktree em `<home>/worktrees/<projeto>/<sessionId>/` com o branch `hub/<sessionId>` e o
  nome de pasta de `daemon/src/worktree.ts:616-625` (SPEC-02 §6; ADR 7.9); settings em
  `<home>/run/<sessionId>-settings.json` com o conteúdo de SPEC-04 B10 (matcher, timeout de 120 s),
  regravado a cada lançamento e apagado no fim e na reconciliação; falha ao gravar impede o spawn
  (B10). Testes TS equivalentes: `daemon/src/worktree.test.ts`, `daemon/src/worktree-nome.test.ts`,
  `daemon/src/worktree-links.test.ts`, `adapters/src/gate-settings.test.ts`.
- **Decisões (ADR 09):** DV-21: novo formato apontando para o executável C, com a regra "é nosso" redefinida e migração das entradas antigas.
- **Depende:** F0-07, F1-07.
- **Agente:** c-engineer · **Área:** `native/src/daemon/` (worktree, settings).

#### F1-18 — Daemon: gerenciador de sessões mínimo
- **Entrega:** `native/src/daemon/` (início de sessão-raiz, lançamento, persistência e publicação de
  eventos, custo de turno, fim, cancelamento, reconciliação na subida).
- **Aceite:** transições de A3 para criação → `running`, `#finish` (`completed`/`failed`/`killed`,
  `endedAt`, `pid: null`, aprovações pendentes → `denied`) e `cancel` → `killed`; task `working` →
  `completed`/`failed`/`canceled` (SPEC-04 A3); raiz com `depth 0`, `path = [pathKey]` e teto
  `brief.budget` + `defaultBudget` (A8, A9); `ctx.timeoutSeconds` e `ctx.heartbeatSeconds` como em
  B9; reconciliação na subida: `running`/`waiting_approval` sem aprovação pendente → `killed`, órfão
  morto antes, tasks → `failed` (SPEC-02 §4.2); `isolation` gravado segundo DA-21 e DV-10. Testes TS equivalentes:
  `daemon/src/session-lifecycle.integration.test.ts`, `daemon/src/reconcile.test.ts`,
  `daemon/src/terminal-state.test.ts`, `daemon/src/turn-cost.integration.test.ts`.
- **Decisões (ADR 09):** DV-10: remover o campo `defaults.isolation` do manifesto do C; DV-11: timeout e heartbeat da run vêm da política efetiva do projeto; DA-21: recusar `container` com erro claro na entrada; ler linhas antigas como estão.
- **Depende:** F1-03, F1-06, F1-09, F1-10, F1-13, F1-14, F1-16, F1-17.
- **Agente:** c-engineer · **Área:** `native/src/daemon/` (sessões).

#### F1-19 — Daemon: rotas mínimas
- **Entrega:** `native/src/daemon/` (rotas 1, 2, 3, 11, 12, 21, 22, 29, 31, 32, 36, 39, 43, 57 e 58 da
  tabela de SPEC-01 §6; a 58 vem de F1-16).
- **Aceite:** entrada, sucesso e erros específicos de cada linha da tabela de SPEC-01 §6; `POST /shutdown`
  responde e encerra 100 ms depois (SPEC-01 §1); `GET /health` sem o caminho do home. Casos do corpus
  F0-13 dessas rotas passam. Teste TS equivalente: `daemon/src/server.test.ts` (casos dessas rotas).
- **Decisões (ADR 09):** DV-03: manter a resposta do `cancel`, com teto e descarte no leitor do corpo (SPEC-08 D12); DV-04: validar o formato de `sessionId`/`rootId`; formato inválido = inexistente.
- **Depende:** F1-15, F1-18.
- **Agente:** c-engineer · **Área:** `native/src/daemon/` (rotas).

#### F1-20 — Cliente HTTP em C
- **Entrega:** `native/src/client/` (transporte HTTP/1.1 para 127.0.0.1, JSON, token, leitor SSE).
- **Aceite:** token lido de `<home>/operator-token` a cada requisição e enviado como
  `Authorization: Bearer` (SPEC-03 §1.1; SPEC-01 §4); erro HTTP → erro com `message`, `code`, `status`
  e `details`, sem `error.code` → status em texto, corpo não JSON → `RESPOSTA_NAO_JSON`; id malformado
  recusado antes da requisição com `INVALID_ID` e os formatos de `client/src/ids.ts` (SPEC-03 §1.2);
  leitor SSE como o `HubClient.stream` (SPEC-01 §8.4); modo sem token para MCP e hook. SEC-R13
  (não entregar o token a um impostor na porta) depende de DV-31. Erros de conexão mapeados a partir do
  erro nativo, sem copiar o texto do Node (SPEC-07 §4.A). Testes TS equivalentes:
  `client/src/hub-client.test.ts`, `client/src/ids.test.ts`, `client/src/operator-client.test.ts`.
- **Decisões (ADR 09):** DV-31: o cliente confere o dono do socket antes de mandar o token; `SO_EXCLUSIVEADDRUSE` no Windows.
- **Depende:** F0-09, F1-07.
- **Agente:** c-engineer · **Área:** `native/src/client/`.

#### F1-21 — CLI mínima
- **Entrega:** `native/src/cli/` (parser, formato de erro, autostart sob demanda e os comandos
  `daemon`, `stop`, `health`, `version`, `agents`, `projects`, `project add`, `start`, `sessions`,
  `watch`, `cancel`).
- **Aceite:** parser de SPEC-03 §1.1 (flags booleanas declaradas, `--`, `--chave=valor`); formato
  único de erro e códigos de saída 0/1/2 (SPEC-03 §1.2); `ensureDaemon` (que sobe o `agents-hubd`,
  DA-14) com a mensagem de
  `NO_AUTOSTART`, poll de 300 ms até 30.000 ms e log diário em `logs/` (SPEC-03 §1.6); cada comando
  conforme a sua linha em SPEC-03 §1.8, inclusive a saída 2 de `start`/`watch` parados esperando
  aprovação. Fica fora da F1 o aviso de gate do `start` (usa `GET /integrations`, rota 54); ele entra
  na F5-07 e, até lá, o `start` fica `[~]`. `--isolation container` tratado conforme DA-21 (SPEC-03
  §1.8; SPEC-07 §4.B, `cli/src/start-cmd.test.ts:57-59`). A impressão do texto do agente no terminal
  segue DV-34 (SEC-R32). Testes TS equivalentes: `cli/src/args-ajuda-erro.test.ts`,
  `cli/src/daemon-control.test.ts`, `cli/src/start-cmd.test.ts`, `cli/src/session-follow.test.ts`.
- **Decisões (ADR 09):** DA-21: recusar `container` com erro claro na entrada; ler linhas antigas como estão; DV-34: sanear C0/C1/ESC do texto do agente no terminal; DA-14: serviço `agents-hubd` (sobe no login, sem janela); janela e bandeja em `agents-hub`, cliente da mesma API HTTP; CLI `hub`, com MCP e hook como subcomandos.
- **Depende:** F1-20.
- **Agente:** c-engineer · **Área:** `native/src/cli/` (núcleo e esses comandos).

#### F1-22 — CLI: `hub hook`
- **Entrega:** `native/src/cli/` (entrada do hook, sem carregar o resto da CLI).
- **Aceite:** SPEC-03 §1.5 inteira: caminho rápido sem config nem daemon; URL padrão quando a config
  falha; sessão só com id `^ses_[a-z0-9]+$`; `POST /hooks/pretooluse` sem token, com teto de 100 s;
  saída sempre 0; dialetos Claude/Codex; modo de falha (`gate.failMode`, senão fechado em sessão e
  aberto fora) com os textos da SPEC. Lado do hook em SPEC-01 §9. O hook não abre o banco (SPEC-07
  §4.A, `cli/src/bin.test.ts:169`). SEC-R31 (DLL plantada no cwd não é carregada) é PROPOSTA da SPEC-08
  (P7). Teste TS equivalente: `cli/src/hook.test.ts`.
- **Fuzz (SPEC-08 C4; DA-26):** FZ08 (`hub hook`: stdin → dialeto Claude/Codex; saída sempre JSON válido ou vazia no Codex); o alvo roda na infraestrutura da F0-02.
- **Decisões (ADR 09):** DA-29: adotar todos os endurecimentos listados.
- **Depende:** F1-05, F1-20.
- **Agente:** c-engineer · **Área:** `native/src/cli/` (hook).

#### F1-23 — Ponta a ponta com agente falso
- **Entrega:** `native/tests/integration/` (manifesto de teste que aponta para um executável falso
  que emite o stream do Claude).
- **Aceite:** com o serviço C isolado: `hub start` → sessão `completed`, eventos em `GET /events`,
  custo gravado e visível em `GET /budget/:rootId`, `hub cancel` leva a `killed`, reinício do serviço
  reconcilia a sessão viva (SPEC-02 §4.2); roda no CI nos quatro compiladores e no job com sanitizers.
- **Depende:** F0-11, F1-19, F1-21, F1-22.
- **Agente:** test-engineer · **Área:** `native/tests/integration/` (e2e F1).

#### F1-24 — Prova real com o Claude
- **Entrega:** registro da execução em `docs/19-status-reescrita-c.md`.
- **Aceite:** com **autorização explícita do dono**, serviço C isolado e o objetivo do smoke de
  SPEC-03 §1.8 (`responda apenas com a palavra OK`, `supervised` + `worktree`, teto US$ 0,10): a
  sessão termina `completed`, o custo é gravado e os eventos chegam pela CLI. Comando e saída reais
  citados.
- **Depende:** F1-23.
- **Agente:** test-engineer · **Área:** nenhuma de código.

**Paralelo na F1:** {F1-01} → {F1-02, F1-03, F1-04, F1-05, F1-06} (arquivos distintos em `core/`) ∥
{F1-08 → F1-09 ∥ F1-10} (`store/`) ∥ {F1-11, F1-12 → F1-13; F1-14} (`adapters/`) ∥ F1-20 (`client/`);
depois {F1-15 → F1-16, F1-17} (`daemon/`) ∥ {F1-21, F1-22} (`cli/`); por fim F1-18 → F1-19 → F1-23
→ F1-24.

---

### F2 — Núcleo completo (paridade com SPEC-04)

#### F2-01 — Core: tokenizador de shell
- **Entrega:** `native/src/core/` (segmentos planos `{words[], redirects[]}`).
- **Aceite:** SPEC-04 A6 "Tokenização": leituras `posix`/`win`, `dynamic`, `quoted`; separadores;
  continuação; comentário; os 12 redirecionamentos; heredoc varrido; todos os casos de
  `ShellParseError` listados (aninhamento > 12 etc.). Teste TS equivalente:
  `core/src/command-classifier.test.ts` (casos de tokenização).
- **Depende:** F0-10, F1-01.
- **Agente:** c-engineer · **Área:** `native/src/core/` (tokenizador).

#### F2-02 — Core: classificador, parte 1
- **Entrega:** `native/src/core/` (pipeline, listas, tabelas, redirecionamentos, git, remoção e escrita).
- **Aceite:** SPEC-04 A6 "Pipeline" (passos 1–8, pior veredito, `[em "<segmento>"]`); casamento de
  lista por palavra e nome normalizado; tabelas `READ_ONLY`, `SAFE_BUILTINS`, `PS_PREDICATE`,
  `CONTROL_WORDS`, `DATA_ONLY`, `HIJACK_VARS`; irreversíveis por subsequência; git (subcomandos,
  globais, `-c`); remoção/escrita (`rm` … `ln`, `rg --pre`); varredura de segredo. `reg add` em
  `…\CurrentVersion\Run` como `irreversible` (SEC-R39) depende de DV-36. Teste TS equivalente:
  `core/src/command-classifier.test.ts`; corpus `native/tests/conformance/classifier/classifier.jsonl`.
- **Decisões (ADR 09):** DV-36: pasta de instalação e locais de autostart na lista de caminhos sensíveis; `reg add …\Run` = `irreversible`.
- **Depende:** F1-04, F1-05, F2-01.
- **Agente:** c-engineer · **Área:** `native/src/core/` (classificador: base, git, fs).

#### F2-03 — Core: classificador, parte 2
- **Entrega:** `native/src/core/` (wrappers, shells, `cmd`, PowerShell, interpretadores, rede, `hub`,
  `alvoDoDaemon`, flags com valor).
- **Aceite:** tabelas "Wrappers e interpretadores" e "Flags que recebem valor" de SPEC-04 A6;
  `DANGER_API` e `PROCESS_API` em PCRE2; `-EncodedCommand` decodificado em UTF-16LE; `alvoDoDaemon`
  com as formas de loopback e `hubPorts`; os 14 exemplos executados de A6 dão risco e razão iguais.
  Teste TS equivalente: `core/src/command-classifier.test.ts`; `core/src/daemon-loopback.test.ts`;
  corpus `native/tests/conformance/classifier/` (casos `divergencia-S-*` = DV-09; `escrita-144`,
  `-145`, `-157`, `-168` = DV-41).
- **Fuzz (SPEC-08 C4; DA-26):** FZ04 (tokenizer + classificador; diferencial contra o TS, ajustado às correções decididas DV-09/DV-41; nunca `allow` onde o TS dá `escalate`); FZ12 (`-EncodedCommand`: base64 → UTF-16LE → UTF-8); o alvo roda na infraestrutura da F0-02.
- **Decisões (ADR 09):** DV-09: reconhecer `-S` de `cp`/`mv`/`ln` como flag com valor; DV-41: `-t`/`--target-directory` entra como alvo de escrita (escrita fora do worktree vira `escalate`).
- **Depende:** F2-02.
- **Agente:** c-engineer · **Área:** `native/src/core/` (classificador: wrappers, rede).

#### F2-04 — Core: motor de política
- **Entrega:** `native/src/core/` (`decide`, `classify`, overlay por modo, fusão com clamp,
  `intersect`, `inheritMode`, `watchForMode`).
- **Aceite:** algoritmo de `decide` e a tabela risco × modo com `DEFAULT_POLICY` de SPEC-04 A5;
  classificação por tipo de ação (`file.read`, `file.write`, `command`, `network`, `delegation`,
  `budget.overrun`); regras sob clamp e `EXEC_POLICY_FIELDS`; `intersect` pai → filho; `inheritMode`
  com os exemplos executados de A5. Testes TS equivalentes: `core/src/policy.test.ts`,
  `core/src/policy-merge.test.ts`, `core/src/watch.test.ts`.
- **Decisões (ADR 09):** DV-08: interseção pai → filho com mínimo também em `defaultBudget`, `retries` e `fallback`.
- **Depende:** F2-03.
- **Agente:** c-engineer · **Área:** `native/src/core/` (motor de política).

#### F2-05 — Core: edição de política, pastas e conversa de replay
- **Entrega:** `native/src/core/` (equivalentes de `core/src/policy-edit.ts`, `core/src/folders.ts`,
  `core/src/conversation.ts`).
- **Aceite:** sem SPEC escrita (SPEC-04 "Fora deste documento"); a fonte é o código TS congelado
  (ADR 7.10). Testes TS equivalentes: `core/src/policy-edit.test.ts`, `core/src/folders.test.ts`,
  `core/src/conversation.test.ts`.
- **Depende:** F1-03, F1-04.
- **Agente:** c-engineer · **Área:** `native/src/core/` (policy-edit, folders, conversation).

#### F2-06 — Core: grafo e resiliência
- **Entrega:** `native/src/core/` (`pathKey`, `checkDelegation`, `buildGraph`, `rollupCost`,
  `classifyOutcome`, `nextStep`, auxiliares).
- **Aceite:** SPEC-04 A9 (profundidade, ciclo semântico, nó inalcançável vira raiz); SPEC-04 A10
  (ordem de classificação, padrões de cota/taxa/transitório, backoff `× 2^max(0, n−1)`, teto de retry
  com origem `timeout`, cadeias padrão por capability). Testes TS equivalentes:
  `core/src/graph.test.ts`, `core/src/resilience.test.ts`, `core/src/resilience-cota.test.ts`,
  `core/src/resiliencia-grafo.test.ts`.
- **Depende:** F1-01.
- **Agente:** c-engineer · **Área:** `native/src/core/` (grafo, resiliência).

#### F2-07 — Core: workflow
- **Entrega:** `native/src/core/` (schema, `validateWorkflow`, `runWorkflow` com dependências injetadas).
- **Aceite:** SPEC-04 A11: limites do schema, erro → `ILLEGAL_STATE`, Kahn em lotes, repartição do
  saldo antes do despacho, `CONCURRENCY_EXCEEDED` retentado até 5 vezes com `200 ms × 2^n`, estados
  de passo. O caminho do erro no formato do zod (`steps.0.objective`) aparece na API de validação e
  depende de DA-23 (SPEC-07 §4.A). Testes TS equivalentes: `core/src/workflow.test.ts`;
  `daemon/src/workflow-runs.test.ts` (parte de validação).
- **Decisões (ADR 09):** DA-23: reproduzir só o código e o caminho do campo; texto próprio em pt-BR.
- **Depende:** F0-10, F1-01.
- **Agente:** c-engineer · **Área:** `native/src/core/` (workflow).

#### F2-08 — Core: preços e custo
- **Entrega:** `native/src/core/` (`MODEL_PRICES` com 70 modelos, `normalizeModelId`, casamento por
  alias, `priceUsage`, `estimateTokenCost`, `resolveEventCost`, `combineCostEstimates`,
  `AGENT_FALLBACK_MODEL`).
- **Aceite:** SPEC-04 A12 e o Apêndice (70 linhas idênticas). Teste TS equivalente:
  `core/src/pricing.test.ts`.
- **Depende:** F1-02.
- **Agente:** c-engineer · **Área:** `native/src/core/` (preços).

#### F2-09 — Core: ambiente do agente e auditoria
- **Entrega:** `native/src/core/` (`filtrarEnvDeProjeto`, variáveis por agente, `AuditKind`, entrada
  de auditoria).
- **Aceite:** SPEC-04 A13 (prefixos aceitos, `MODEL`/`MODEL_BASE_URL`, `AGENTS_HUB_` fora, tabela por
  agente); os 13 `AuditKind` e os atores de SPEC-02 §3.9 (a fonte de `core/src/audit.ts` é o código
  TS, que a SPEC-04 deixa de fora). Teste TS equivalente: `core/src/agent-env.test.ts`.
- **Depende:** F1-01.
- **Agente:** c-engineer · **Área:** `native/src/core/` (agent-env, audit).

#### F2-10 — Daemon: config do projeto, confiança e política efetiva
- **Entrega:** `native/src/daemon/` (`.agents-hub/config.yaml`, trust-on-first-use com hash,
  contexto do Hub, política efetiva por sessão).
- **Aceite:** camada de projeto com clamp e `trustExecFields` = projeto confiável (SPEC-04 A5
  "Camadas"); `trusted_hash` com `NULL` = confiança suspensa (SPEC-02 §3.1); fusão repositório + Hub
  com o Hub vencendo variável a variável, e o repositório só entrando com o projeto confiável
  (SPEC-04 A13); política de um filho = interseção recursiva com a do pai (SPEC-04 A5). Testes TS
  equivalentes: `daemon/src/project-config.test.ts`, `daemon/src/repo-trust.test.ts`,
  `daemon/src/project-trust.test.ts`, `daemon/src/effective-policy.test.ts`,
  `daemon/src/project-context.test.ts`.
- **Decisões (ADR 09):** DV-11: timeout e heartbeat da run vêm da política efetiva do projeto.
- **Depende:** F1-09, F2-04, F2-09.
- **Agente:** c-engineer · **Área:** `native/src/daemon/` (projeto, política efetiva).

#### F2-11 — Daemon: delegação e máquina de estados completa
- **Entrega:** `native/src/daemon/` (delegação, concorrência, todas as transições de A3).
- **Aceite:** todas as linhas das tabelas "Transições de sessão observadas" e "Transições de task
  observadas" de SPEC-04 A3, inclusive a recusa de operação em sessão terminal (`ILLEGAL_STATE`);
  `checkDelegation` com `maxDepth` da política (A9); delegação negada → sessão `failed` e task
  `rejected`; `maxConcurrency`/`maxConcurrencyPerAgent` → `CONCURRENCY_EXCEEDED`; modo herdado por
  `inheritMode`, com `defaults.supervision` do manifesto na raiz (A5). Testes TS equivalentes:
  `daemon/src/delegation-depth.integration.test.ts`, `daemon/src/orquestracao.integration.test.ts`,
  `daemon/src/concorrencia-fechamento.integration.test.ts`, `daemon/src/session-manager-audit.test.ts`
  (parte de delegação e concorrência).
- **Decisões (ADR 09):** DV-08: interseção pai → filho com mínimo também em `defaultBudget`, `retries` e `fallback`; DV-10: remover o campo `defaults.isolation` do manifesto do C; DV-12: manter `submitted`, `auth_required` e `expired` no esquema (banco migrado), sem gerá-los.
- **Depende:** F1-18, F2-04, F2-06, F2-10.
- **Agente:** c-engineer · **Área:** `native/src/daemon/` (sessões: delegação/estados).

#### F2-12 — Daemon: orçamento do fluxo
- **Entrega:** `native/src/daemon/` (ledger por raiz, reserva do filho, alertas, aprovação de
  orçamento, persistência de `budgets`).
- **Aceite:** herança da raiz e reserva da fatia do filho (SPEC-04 A8); eventos `budget.updated`,
  `budget.warning` e `budget.exceeded` (A2); aprovação de orçamento com as transições de A3
  (`waiting_approval` → `running` com turno concluído; task → `completed` quando a continuação é
  negada); recriação do ledger a partir do banco (A8). Testes TS equivalentes:
  `daemon/src/budget-warning.test.ts`, `daemon/src/custo-turno-parada.integration.test.ts`.
- **Decisões (ADR 09):** DV-07: restaurar as reservas (`reserved_json`) ao recriar o ledger no reinício.
- **Depende:** F2-11.
- **Agente:** c-engineer · **Área:** `native/src/daemon/` (orçamento).

#### F2-13 — Daemon: retry, fallback, validação e revisão
- **Entrega:** `native/src/daemon/` (aplicação de A10, validação por comando, revisão por agente).
- **Aceite:** validação reprovada → `transient` com tentativa `invalid`; retry com resume nativo ou
  Brief + feedback; fallback encerra como `failed`, cria a substituta, move a task e anexa
  `failureContext`; cadeia por capability sem o próprio agente nem os não instalados (SPEC-04 A10);
  validação e revisão desligadas por padrão (ADR 7.9; SPEC-04 A5 `validation`). Testes TS
  equivalentes: `daemon/src/resilience.integration.test.ts`, `daemon/src/validation.test.ts`,
  `daemon/src/review.test.ts`, `daemon/src/revisao-e-diff.integration.test.ts`,
  `daemon/src/teste-real-rodada1.test.ts` (parte de resiliência). O ramo de DV-13 (retry com vaga
  recusada) não tem teste TS (`docs/propostas/F2-19-dv13.md`).
- **Decisões (ADR 09):** DV-13: retry sem vaga conclui a sessão como `failed`, com `session.ended` e liberação do worktree.
- **Depende:** F2-06, F2-11, F2-16, F2-19.
- **Agente:** c-engineer · **Área:** `native/src/daemon/` (resiliência).

#### F2-14 — Daemon: gate pré-execução
- **Entrega:** `native/src/daemon/` (rota 42 e decisão do gate).
- **Aceite:** SPEC-01 §9 inteira: pedido estrito; busca da sessão em 3 passos; fora de sessão →
  `allow`/`read` com a razão literal; idempotência `"<sessão>|<toolUseId>"` por 10 min com teto de 2000
  e entradas em voo que não expiram; `approve` com sessão viva → espera bloqueante de até 55.000 ms com
  consulta a cada 500 ms; tempo esgotado → `resolveApproval(id,'denied','tempo esgotado')`; resposta com
  os 8 campos e `approve` → `ask`; `actionsOfToolCall`; auditoria `gate.decision` com ator `gate`, sem
  repetir. SEC-R09 (com 64 gates esperando, `POST /approvals/:id` responde em < 1 s) é PROPOSTA da
  SPEC-08 (H3); trocar o poll de 500 ms do TS por evento esbarra na razão registrada em
  `daemon/src/session-manager.ts:1033-1035` (lacuna de H3), e isso fica dentro de DV-01. Testes TS
  equivalentes: `daemon/src/pretool-gate.test.ts`,
  `daemon/src/gate-bloqueante.test.ts`, `daemon/src/gate-composto.test.ts`,
  `daemon/src/gate-leitura.test.ts`, `daemon/src/gate-daemon-loopback.test.ts`,
  `daemon/src/gate-por-sessao.test.ts`, `daemon/src/pretool-gate-mcp.test.ts`.
- **Decisões (ADR 09):** DV-01: definir timeouts explícitos, com os valores da SPEC-08 H3 como ponto de partida, medidos na F1.
- **Depende:** F1-18, F2-04, F2-09, F2-13 · bloqueia o aceite: DV-25.
- **Agente:** c-engineer · **Área:** `native/src/daemon/` (gate).

#### F2-15 — Daemon: vigilância reativa e aprovações
- **Entrega:** `native/src/daemon/` (vigilância por evento, abertura e resolução de aprovações).
- **Aceite:** SPEC-04 B10 "Vigilância reativa" (ações de `command.executed` e `file.changed`; primeira
  em `pauseOn` abre aprovação `watch` e pausa; `flagOn` vira `log`) e "Cobertura" (evento coberto pelo
  gate só gera alerta); transições de aprovação de A3; `by` = identidade autenticada (SPEC-01 §4).
  Testes TS equivalentes: `daemon/src/vigilancia-gate.test.ts`, `daemon/src/session-manager-audit.test.ts`
  (parte de aprovações e auditoria).
- **Depende:** F2-11, F2-14.
- **Agente:** c-engineer · **Área:** `native/src/daemon/` (vigilância, aprovações).

#### F2-16 — Daemon: send, interrupt, pause, handoff e adoção
- **Entrega:** `native/src/daemon/` (modos `live`/`resume`/`replay`, `nativeSessionMissing`,
  interrupt, pause, handoff, adoção, detach, prazos das raízes adotadas).
- **Aceite:** SPEC-04 B2 "session.strategy" (replay com `rebuildConversation`; refazer em replay uma
  vez; `none` recusa pause/interrupt); transições de A3 para pause/interrupt/handoff/detach; prazo
  padrão de 180.000 ms, checagem `max(1000, lease/3)`, heartbeat `ILLEGAL_STATE` fora de raiz adotada
  (SPEC-03 §2.4; SPEC-01 §6.4 linhas 23–25, 33–37). Testes TS equivalentes:
  `daemon/src/handoff.test.ts`, `daemon/src/handoff-concorrencia.test.ts`,
  `daemon/src/handoff-pausada.test.ts`, `daemon/src/interrupt.test.ts`,
  `daemon/src/adopted-leases.test.ts`, `daemon/src/retomada-sem-conversa.integration.test.ts`,
  `daemon/src/user-message.test.ts`.
- **Depende:** F2-05, F2-11, F2-12.
- **Agente:** c-engineer · **Área:** `native/src/daemon/` (send/handoff/adoção).

#### F2-17 — Daemon: retenção, compactação, espaço do banco e reaper
- **Entrega:** `native/src/daemon/` (compactador de eventos, conversão de `auto_vacuum`, reaper de worktrees).
- **Aceite:** SPEC-02 §7 inteira (passada na largada e a cada `sweepIntervalMinutes`, lotes de 2000, SQL
  literal, `incremental_vacuum(128)` + checkpoint `TRUNCATE`, conversão ≤ 64 MiB na subida sem
  derrubar, reaper por `worktreeDays` preservando o branch). Testes TS equivalentes:
  `daemon/src/event-retention.test.ts`, `daemon/src/espaco-do-banco.test.ts`,
  `daemon/src/reaper.test.ts`, `daemon/src/reaper-preserva.test.ts`,
  `daemon/src/promessas-soltas.test.ts` (só a intenção: falha no desligamento sai com código 1,
  SPEC-07 §4.A).
- **Depende:** F1-10, F1-17.
- **Agente:** c-engineer · **Área:** `native/src/daemon/` (retenção, reaper).

#### F2-18 — Daemon: captura de diff e artefatos
- **Entrega:** `native/src/daemon/` (`baseline.json`, `changes.patch`, registro do artefato `diff`).
- **Aceite:** caminhos de SPEC-02 §6; `kind = diff` e `hash = NULL` (SPEC-02 §3.7); resposta de
  `GET /sessions/:id/diff` nos três casos (SPEC-01 §6.4 linha 27). Testes TS equivalentes:
  `daemon/src/diff-baseline.test.ts`, `daemon/src/artifact-capture.test.ts`.
- **Depende:** F1-10, F1-17.
- **Agente:** c-engineer · **Área:** `native/src/daemon/` (diff, artefatos).

#### F2-19 — Levantamento de DV-13 no código TS
- **Entrega:** nota com `arquivo:linha` sobre o estado final da sessão quando a reserva de vaga do
  retry falha (SPEC-04 obs. 9), para o dono decidir.
- **Aceite:** fatos lidos de `packages/daemon/src/session-manager.ts` (e, se preciso, teste TS
  executado com hub isolado), sem propor correção.
- **Depende:** —.
- **Agente:** test-engineer · **Área:** `docs/propostas/F2-19-dv13.md`.

**Paralelo na F2:** {F2-01 → F2-02 → F2-03 → F2-04} (cadeia do classificador) ∥ {F2-05, F2-06,
F2-07, F2-08, F2-09} (arquivos distintos em `core/`) ∥ {F2-17, F2-18} ∥ F2-19; depois F2-10 → F2-11 →
F2-12 → F2-16 → F2-13 → F2-14 → F2-15, **em série** (todas editam o arquivo central do gerenciador de
sessões; a ordem está no "Depende", e a F3-01 entra depois da F2-15).

---

### F3 — Os 9 adapters e o gate (ADR 7.8)

> **Ordem frente ao ADR 7.18.** O 7.18 diz "depois UI, os demais adapters, o instalador e a
> atualização". Neste plano a F3 vem antes da F6 porque as telas dependem da API completa (F4), e
> F4-01/F4-03 dependem do registry e da descoberta (F3-08, F3-09). Nada na F6 depende dos mappers
> (F3-02..F3-05), e a base da UI (F6-01 a F6-04) pode começar logo depois da F1 (a F6-05 depende de
> F4-04 e F4-05).
> Essa leitura do 7.18 precisa da confirmação do dono (DA-27).

#### F3-01 — Codex: mapper e injeção do gate
- **Entrega:** `native/src/adapters/` (mapper `codex`), `native/src/daemon/` (injeção do hook inline).
- **Aceite:** tabela "codex" de SPEC-04 B7; injeção de SPEC-04 B10 "Codex" (`-c hooks=…` com
  `timeoutSec=120`, segmento de comando com nome 8.3 no Windows, escape TOML,
  `--dangerously-bypass-hook-trust` só com `codexGate.bypassHookTrust`; sem bypass em `supervised` →
  `CODEX_GATE_NOT_GUARANTEED`, nos outros modos `log {stream:'gate', level:'warn'}`). Testes TS
  equivalentes: `daemon/src/codex-gate.test.ts`, `daemon/src/codex-gate.integration.test.ts`.
- **Decisões (ADR 09):** DV-21: novo formato apontando para o executável C, com a regra "é nosso" redefinida e migração das entradas antigas.
- **Depende:** F1-13, F2-14, F2-15.
- **Agente:** c-engineer · **Área:** `native/src/adapters/` (codex), `native/src/daemon/` (codex-gate).

#### F3-02 — Copilot: mapper
- **Entrega:** `native/src/adapters/` (mapper `copilot`).
- **Aceite:** tabela "copilot" de SPEC-04 B7, inclusive o exemplo executado (`totalNanoAiu: 529821900`
  → `usd 0.005298219`, `credits 0.5298219`). Teste TS equivalente: `adapters/src/mappers/copilot.test.ts`;
  corpus `native/tests/conformance/mappers/copilot.jsonl`.
- **Decisões (ADR 09):** DV-43: recusar prompt vazio antes do spawn; DV-45: reproduzir as tolerâncias dos mappers.
- **Depende:** F1-02.
- **Agente:** c-engineer · **Área:** `native/src/adapters/` (copilot).

#### F3-03 — Kimi: mapper
- **Entrega:** `native/src/adapters/` (mapper `kimi`).
- **Aceite:** tabela "kimi" de SPEC-04 B7 (formatos 2.0.0 e antigo; id nativo de `session.resume_hint`).
  Teste TS equivalente: `adapters/src/mappers/kimi.test.ts`; corpus
  `native/tests/conformance/mappers/kimi.jsonl`.
- **Decisões (ADR 09):** DV-42: cortar em fronteira de code point UTF-8, mesmo teto; DV-43: recusar prompt vazio antes do spawn.
- **Depende:** F1-02.
- **Agente:** c-engineer · **Área:** `native/src/adapters/` (kimi).

#### F3-04 — Antigravity: mapper
- **Entrega:** `native/src/adapters/` (mapper `antigravity`).
- **Aceite:** tabela "antigravity" de SPEC-04 B7. Teste TS equivalente:
  `adapters/src/mappers/antigravity.test.ts`; corpus `native/tests/conformance/mappers/antigravity.jsonl`.
- **Decisões (ADR 09):** DV-43: recusar prompt vazio antes do spawn.
- **Depende:** F1-02.
- **Agente:** c-engineer · **Área:** `native/src/adapters/` (antigravity).

#### F3-05 — Mappers genéricos (mimo, cursor, opencode por processo)
- **Entrega:** `native/src/adapters/` (`generic-json`, `generic-text`).
- **Aceite:** SPEC-04 B7 "generic-json" e "generic-text". Teste TS equivalente:
  `adapters/src/mappers/generic.test.ts`; corpus
  `native/tests/conformance/mappers/{generic-json,generic-text}.jsonl`.
- **Decisões (ADR 09):** DV-45: reproduzir as tolerâncias dos mappers.
- **Depende:** F1-02.
- **Agente:** c-engineer · **Área:** `native/src/adapters/` (generic).

#### F3-06 — OpenCode: servidor, sessão, prompt e fim de turno
- **Entrega:** `native/src/adapters/` (adapter HTTP do OpenCode).
- **Aceite:** tabela de operações de SPEC-04 B8 (probe; servidor com `GET /api/health` de 2 s, boot
  `opencode serve` compartilhado e espera de 60 s; `start`/`resume`; SSE aberto antes do prompt; fim de
  turno pelas três regras; desfecho; `send` com `steer`; `interrupt`; `cancel`; `close` derruba só o
  servidor que subiu; HTTP de 30 s; modelo `provider/model`); env de `opencode serve` (B9). Teste TS
  equivalente: `adapters/src/opencode/adapter.test.ts`.
- **Depende:** F0-09, F1-13, F1-20.
- **Agente:** c-engineer · **Área:** `native/src/adapters/` (opencode: adapter).

#### F3-07 — OpenCode: eventos e permissões
- **Entrega:** `native/src/adapters/` (decodificador SSE, mapeamento de eventos, `opencode.json` dos
  agentes `hub-*`).
- **Aceite:** SPEC-04 B8: 17 tipos de ruído descartados, tabela "Eventos SSE → Hub", custo do passo,
  recusa imediata de pedidos de permissão/pergunta, tabela de permissões por modo gravada só quando
  muda, modo → agente com aviso. Testes TS equivalentes: `adapters/src/opencode/events.test.ts`,
  `adapters/src/opencode/permissions.test.ts`; corpus `native/tests/conformance/mappers/opencode-sse.jsonl`.
- **Fuzz (SPEC-08 C4; DA-26):** FZ07, parte do decodificador SSE cliente do OpenCode; o alvo roda na infraestrutura da F0-02.
- **Decisões (ADR 09):** DV-45: reproduzir as tolerâncias dos mappers.
- **Depende:** F3-06.
- **Agente:** c-engineer · **Área:** `native/src/adapters/` (opencode: eventos, permissões).

#### F3-08 — Registry completo
- **Entrega:** `native/src/adapters/` (`probeAll` em lotes de 2, `resolveTarget` com `cap:`,
  `fallbackFor`, `registerAdapter`).
- **Aceite:** SPEC-04 B3 e a "Cadeia por capability" de A10; os 9 manifestos (B2 "Os 9 manifestos")
  carregados com os campos da tabela. Sem teste TS dedicado (`daemon/src/agents-model.test.ts` não
  cobre `probeAll`, `resolveTarget` nem `fallbackFor`); a fonte é o código
  `packages/adapters/src/registry.ts` (ADR 7.10), e os casos são escritos a partir dele.
- **Depende:** F1-11, F2-04.
- **Agente:** c-engineer · **Área:** `native/src/adapters/` (registry).

#### F3-09 — Descoberta e absorção
- **Entrega:** `native/src/adapters/` (descoberta das configs dos CLIs), `native/src/daemon/`
  (absorção, cache de 30 s, importação).
- **Aceite:** sem seção escrita na SPEC-04 (está em "Fora deste documento"); a fonte é
  `packages/core/src/discovery.ts`, `packages/adapters/src/discovery/*` e
  `packages/daemon/src/absorption.ts` (ADR 7.10); máscara `***` de SPEC-02 §4.3; contratos das rotas
  4, 5 e 19 (SPEC-01 §6.1, §6.3); leitura de configs TOML e JSONC dos CLIs conforme DA-22. Testes TS
  equivalentes: `adapters/src/discovery/discovery.test.ts`, `daemon/src/absorption.test.ts`,
  `daemon/src/absorption-http.test.ts`.
- **Decisões (ADR 09):** DA-22: leitor e gravador mínimos próprios, só para as chaves que o Hub edita, com teste de ida e volta.
- **Depende:** F0-10, F1-11.
- **Agente:** c-engineer · **Área:** `native/src/adapters/` (discovery), `native/src/daemon/` (absorção).

#### F3-10 — Integração dos 9 no serviço e cobertura do gate
- **Entrega:** `native/src/daemon/` (escolha de adapter por agente, cobertura do gate);
  `native/tests/integration/` (um agente falso por formato de stream).
- **Aceite:** tabela de injeção por agente de SPEC-04 B10; cobertura `hook-por-sessao` /
  `codex-comandos` / `nenhuma`; argv efetivo dos 9 igual à tabela de B2; uma sessão por agente com
  agente falso termina com o desfecho esperado. Testes TS equivalentes: `daemon/src/gate-por-sessao.test.ts`,
  `adapters/src/guarded-actions.test.ts`, `daemon/src/agent-error-text.test.ts`.
- **Depende:** F2-15, F3-01, F3-02, F3-03, F3-04, F3-05, F3-07, F3-08.
- **Agente:** c-engineer (testes: test-engineer) · **Área:** `native/src/daemon/` (seleção de adapter), `native/tests/integration/` (agentes falsos).

#### F3-11 — Prova real por agente
- **Entrega:** registro em `docs/19-status-reescrita-c.md`, um agente por vez.
- **Aceite:** com **autorização explícita do dono** e serviço isolado, o smoke de SPEC-03 §1.8 por
  agente instalado na máquina de teste; agente ausente fica registrado como "não exercitado" (🕳️).
- **Depende:** F3-10.
- **Agente:** test-engineer · **Área:** nenhuma de código.

**Paralelo na F3:** {F3-02, F3-03, F3-04, F3-05} (um arquivo de mapper cada) ∥ {F3-06 → F3-07} ∥
F3-08 ∥ F3-09 ∥ F3-01; depois F3-10 → F3-11. Os mappers só dependem da F1, então podem começar já
na F2.

---

### F4 — API HTTP completa (58 rotas, SSE) e MCP (16 tools)

#### F4-01 — Rotas de saúde, agentes e descoberta; comportamento fora da tabela
- **Entrega:** `native/src/daemon/` (rotas 1–5 completas; resposta para `GET` sem rota).
- **Aceite:** SPEC-01 §6.1 (`GET /agents` com `probe`, descoberta com cache de 30 s e `refresh`);
  comportamento de `GET` sem rota conforme DA-15 (SPEC-01 §7; SPEC-08 D1 e SEC-R03 propõem 404 JSON
  sem cookie nem arquivos estáticos). Teste TS equivalente:
  `daemon/src/server.test.ts`, `daemon/src/agents-model.test.ts`.
- **Decisões (ADR 09):** DA-15: `GET` sem rota → 404 JSON; sem cookie e sem arquivos estáticos.
- **Depende:** F1-19, F3-08, F3-09.
- **Agente:** c-engineer · **Área:** `native/src/daemon/` (rotas 6.1).

#### F4-02 — API REST de tasks e SSE de task
- **Entrega:** `native/src/daemon/` (rotas 6–10).
- **Aceite:** SPEC-01 §6.2 (descritor com `Host` da requisição, `TaskResponse`, padrões de
  `POST /api/tasks`); SPEC-01 §8.3 (sessões observadas, cursor `ses_a:12,ses_b:5`, `Last-Event-ID`
  validado antes do `writeHead`, replay de 501 por sessão com corte e `end()`, fechamento automático a
  cada 500 ms); `isolation: container` aceito pelo `CreateTaskSchema` do TS (SPEC-01 §6.9) e tratado
  conforme DA-21. Esta API não é A2A (SPEC-01 §6.2). Testes TS equivalentes:
  `daemon/src/api-tasks.test.ts`, `daemon/src/sse-task-http.test.ts`.
- **Fuzz (SPEC-08 C4; DA-26):** FZ07, parte do parser de `Last-Event-ID` de `GET /api/tasks/:id/events`; o alvo roda na infraestrutura da F0-02.
- **Decisões (ADR 09):** DV-05: corrigir o descritor (ele descreve só `/api/tasks/*`); DV-06: manter o diretório do daemon como projeto implícito (paridade de contrato); DA-21: recusar `container` com erro claro na entrada; ler linhas antigas como estão.
- **Depende:** F1-16, F2-11.
- **Agente:** c-engineer · **Área:** `native/src/daemon/` (api-tasks).

#### F4-03 — Rotas de projetos
- **Entrega:** `native/src/daemon/` (rotas 11–19).
- **Aceite:** SPEC-01 §6.3, inclusive a ordem corpo × parâmetro de cada rota (SPEC-01 §2 "Ordem de
  validação"), auditorias `project.trust`/`project.folders`/`project.context` (só as chaves de env) e
  `project.import` só com `dryRun:false`. Testes TS equivalentes: `daemon/src/projects.test.ts`,
  `daemon/src/project-registry.test.ts`, `daemon/src/project-canonical.test.ts`,
  `daemon/src/project-path-raizes.test.ts`.
- **Decisões (ADR 09):** DV-46: sem token, `GET /projects/:id/context` devolve só os nomes das variáveis; com token, os valores.
- **Depende:** F2-10, F3-09.
- **Agente:** c-engineer · **Área:** `native/src/daemon/` (rotas 6.3).

#### F4-04 — Rotas de sessões e tasks
- **Entrega:** `native/src/daemon/` (rotas 21–38 completas).
- **Aceite:** SPEC-01 §6.4 linha a linha (adopt registrado antes de `/sessions/:id/...`; `adopted` em
  cada sessão; `leaseMs`; paginação de eventos; cancel com o comportamento de DV-03). Testes TS
  equivalentes: `daemon/src/server.test.ts`, `daemon/src/events-page-http.test.ts`,
  `daemon/src/context-tail.test.ts`.
- **Decisões (ADR 09):** DV-03: manter a resposta do `cancel`, com teto e descarte no leitor do corpo (SPEC-08 D12); DV-04: validar o formato de `sessionId`/`rootId`; formato inválido = inexistente; DV-06: manter o diretório do daemon como projeto implícito (paridade de contrato).
- **Depende:** F2-11, F2-16, F2-18.
- **Agente:** c-engineer · **Área:** `native/src/daemon/` (rotas 6.4).

#### F4-05 — Aprovações e manutenção
- **Entrega:** `native/src/daemon/` (rotas 39–41, 43–45).
- **Aceite:** SPEC-01 §6.5 (só pendentes; `by` do corpo ignorado) e §6.6 (sweep auditado; backup com
  `out` absoluto, sem sobrescrever, `VACUUM INTO` em conexão própria, `conferirBanco`, SPEC-02 §8.1–§8.2).
  Testes TS equivalentes: `daemon/src/maintenance-routes.test.ts`, `store/src/backup.test.ts`,
  `daemon/src/hub-shutdown.test.ts`.
- **Decisões (ADR 09):** DV-04: validar o formato de `sessionId`/`rootId`; formato inválido = inexistente.
- **Depende:** F2-15, F2-17.
- **Agente:** c-engineer · **Área:** `native/src/daemon/` (rotas 6.5, 6.6), `native/src/store/` (backup).

#### F4-06 — Política e auditoria
- **Entrega:** `native/src/daemon/` (rotas 20, 46–48).
- **Aceite:** SPEC-01 §6.3 linha 20 e §6.7 (prévia `dryRun`, `loosened`, backup versionado de
  `config.json`, `clamped`/`ignoredExecFields`, filtros de `GET /audit` com relativo `^\d+\s*(s|m|h|d)$`
  sem distinção de caixa). Testes TS equivalentes: `daemon/src/policy-audit.test.ts`,
  `daemon/src/operator-routes-table.test.ts` (parte destas rotas).
- **Depende:** F2-04, F2-09, F2-10.
- **Agente:** c-engineer · **Área:** `native/src/daemon/` (rotas 6.7).

#### F4-07 — Orçamento, workflows e grafo
- **Entrega:** `native/src/daemon/` (rotas 49–53, 56, 57; registro de execuções em memória).
- **Aceite:** SPEC-01 §6.8 (limites de `BudgetEditSchema`; YAML inválido não é erro HTTP; execução
  inexistente → `TASK_NOT_FOUND`; `projection` no orçamento); `errors` de `POST /workflows/validate`
  no formato decidido em DA-23. Testes TS equivalentes: `daemon/src/operation-routes.test.ts`,
  `daemon/src/workflow-runs.test.ts`.
- **Decisões (ADR 09):** DA-23: reproduzir só o código e o caminho do campo; texto próprio em pt-BR.
- **Depende:** F2-06, F2-07, F2-12.
- **Agente:** c-engineer · **Área:** `native/src/daemon/` (rotas 6.8 exceto integrações).

#### F4-08 — Integrações (gate e MCP nas configs dos agentes)
- **Entrega:** `native/src/daemon/` (rotas 54–55; escrita segura de JSON/JSONC/TOML com backup).
- **Aceite:** SPEC-01 §6.8 linhas 54–55 (`dryRun` ausente = prévia, `base` obrigatório para gravar,
  `CONFIG_CHANGED`, `AGENT_CONFIG_INVALID`); regras de escrita de SPEC-03 §1.9 (backup
  `.bak-AAAAMMDD-HHMMSS[-N]`, temporário + `rename`, JSONC com aviso, TOML reparseado); leitor e
  escritor de JSONC e TOML conforme DA-22 (o ADR 08 não traz biblioteca para eles); todo teste com
  gravação roda com `HOME`/`USERPROFILE` (e `APPDATA` no Windows) apontando para pasta temporária, nunca
  para as configs reais dos CLIs (`CLAUDE.md`, regra 4). Testes TS equivalentes:
  `daemon/src/integrations.test.ts`, `daemon/src/mcp-config.test.ts`, `daemon/src/safe-write.test.ts`.
- **Fuzz (SPEC-08 C4; DA-26):** FZ14 (leitores JSONC/TOML de `hooks install`/`mcp install`; reler o gerado dá o mesmo conteúdo); o alvo roda na infraestrutura da F0-02.
- **Decisões (ADR 09):** DV-21: novo formato apontando para o executável C, com a regra "é nosso" redefinida e migração das entradas antigas; DA-22: leitor e gravador mínimos próprios, só para as chaves que o Hub edita, com teste de ida e volta.
- **Depende:** F0-05, F1-19.
- **Agente:** c-engineer · **Área:** `native/src/daemon/` (integrações, escrita segura).

#### F4-09 — Conformidade da tabela de rotas
- **Entrega:** `native/tests/conformance/` (tabela de rotas) e `native/tests/integration/`.
- **Aceite:** a tabela do C tem **58 rotas, 13 de operador**, com o mesmo par método + caminho de
  SPEC-01 §6; toda rota de operador dá 401 sem credencial antes de ler corpo ou parâmetro (SPEC-01 §4);
  os erros de domínio por rota levantados em F4-14 estão no corpus; todo o corpus HTTP de F0-13 passa;
  a ordem de registro da tabela de despacho é a do TS (tabela de donos do §0). Cobre SEC-R01 (paridade
  M1–M18, com F0-13) e SEC-R02 (SPEC-08 §3). Teste TS equivalente:
  `daemon/src/operator-routes-table.test.ts`.
- **Depende:** F4-01, F4-02, F4-03, F4-04, F4-05, F4-06, F4-07, F4-08, F4-14.
- **Agente:** test-engineer · **Área:** `native/tests/conformance/`, `native/tests/integration/` (rotas).

#### F4-10 — MCP: transporte e ciclo de vida
- **Entrega:** `native/src/mcp/` (stdio JSON-RPC, `initialize`, listagem e chamada de tools,
  `notifications/progress`, cancelamento, encerramento), exposto como `hub mcp serve` (DA-14 e DA-31); o
  `hub mcp` sem `serve` continua sendo o comando de configuração (SPEC-03 §1.8).
- **Aceite:** SPEC-03 §2.1 (servidor `{name:"agents-hub", version:"0.1.0"}` com `instructions`; stdout
  só para o protocolo; mensagem de conexão no stderr; `shutdown(grace)` uma vez, com heartbeat
  desligado antes da carência; SIGINT/SIGTERM sem carência) e §2.2 (variáveis e validações). Testes TS
  equivalentes: `mcp/src/main-env.test.ts`, `mcp/src/main-heartbeat.test.ts`.
- **Fuzz (SPEC-08 C4; DA-26):** FZ09 (enquadramento JSON-RPC do MCP por stdio); o alvo roda na infraestrutura da F0-02.
- **Decisões (ADR 09):** DA-16: texto de erro próprio; versão do protocolo igual à negociada pelo SDK TS na data; DA-14: serviço `agents-hubd` (sobe no login, sem janela); janela e bandeja em `agents-hub`, cliente da mesma API HTTP; CLI `hub`, com MCP e hook como subcomandos; DA-31: `hub mcp serve` roda o MCP por stdio; `hub daemon` executa o `agents-hubd` em primeiro plano; o autostart sob demanda sobe o `agents-hubd` em segundo plano.
- **Depende:** F1-20.
- **Agente:** c-engineer · **Área:** `native/src/mcp/` (transporte).

#### F4-11 — MCP: identidade, adoção, escopo e erros
- **Entrega:** `native/src/mcp/` (resolução do chamador, heartbeat, escopo por fluxo, formatação).
- **Aceite:** SPEC-03 §2.3 (adoção única compartilhada; falha não fica guardada), §2.4 (heartbeat;
  `SESSION_NOT_FOUND`/`ILLEGAL_STATE` esquecem a raiz; `detach` no encerramento), §2.5 (leitura,
  controle, subida até 256 passos, `OUT_OF_FLOW`) e §2.6 (texto compacto, `describe`, id inválido sem
  requisição). Testes TS equivalentes: `mcp/src/server.test.ts` (escopo/erros),
  `mcp/src/caller-wait.test.ts`, `mcp/src/format.test.ts`.
- **Decisões (ADR 09):** DV-18: corrigir o texto `instructions` do MCP para 9 agentes.
- **Depende:** F4-10.
- **Agente:** c-engineer · **Área:** `native/src/mcp/` (chamador, escopo, formato).

#### F4-12 — MCP: tools 1 a 8
- **Entrega:** `native/src/mcp/` (`hub_agent_list`, `hub_agent_call`, `hub_agent_status`,
  `hub_agent_wait`, `hub_agent_events`, `hub_session_diff`, `hub_agent_cancel`, `hub_session_interrupt`).
- **Aceite:** descrição, entrada, anotações, rotas e resposta de cada tool em SPEC-03 §2.7, itens 1–8,
  com os limites `LIMITE_OBJETIVO`/`ITENS`/`ITEM`/`LISTA`; `hub_agent_wait` com intervalo 1500 → ×1,4 →
  10.000 ms; diff cortado em 12.000. Teste TS equivalente: `mcp/src/server.test.ts`.
- **Depende:** F4-04, F4-11.
- **Agente:** c-engineer · **Área:** `native/src/mcp/` (tools 1–8).

#### F4-13 — MCP: tools 9 a 16
- **Entrega:** `native/src/mcp/` (`hub_session_pause`, `hub_session_send`, `hub_session_handoff`,
  `hub_session_list`, `hub_graph`, `hub_context_fetch`, `hub_budget`, `hub_workflow_run`).
- **Aceite:** SPEC-03 §2.7, itens 9–16 (`hub_workflow_run`: `path` só `.yaml`/`.yml` dentro do projeto
  com links resolvidos, YAML malformado sem trecho, teto repartido em centavos com mínimo de 0,01,
  passo `input_required` → `blocked`); total de **16 tools** registradas. Teste TS equivalente:
  `mcp/src/server.test.ts`.
- **Decisões (ADR 09):** DA-16: texto de erro próprio; versão do protocolo igual à negociada pelo SDK TS na data; DV-27: manter (MCP termina `blocked`; CLI espera a aprovação).
- **Depende:** F4-07, F4-11.
- **Agente:** c-engineer · **Área:** `native/src/mcp/` (tools 9–16).

#### F4-14 — Levantamento dos erros de domínio por rota
- **Entrega:** lista, por rota, dos códigos que a camada de domínio lança, com `arquivo:linha` do TS,
  entregue como casos para o corpus de F0-13.
- **Aceite:** cobre o ponto NÃO DETERMINADO de SPEC-01 §10 ("Erros de domínio por rota") lendo
  `daemon/src/session-manager.ts`, `policy-service.ts`, `workflow-runs.ts` e `integrations.ts`; não
  altera nada em `packages/`.
- **Depende:** —.
- **Agente:** test-engineer · **Área:** `native/tests/conformance/domain-errors/` (só essa subpasta; o resto de `conformance/` é da F0-13).

**Paralelo na F4:** {F4-01, F4-02, F4-03, F4-04, F4-05, F4-06, F4-07, F4-08} (um arquivo de rotas cada;
o registro na tabela de despacho é aplicado em série pelo coordenador, na ordem do TS, conforme o §0)
∥ {F4-10 → F4-11 → F4-12 ∥ F4-13} (`mcp/`) ∥ F4-14 (já); F4-09 fecha a fase.

---

### F5 — CLI completa (46 comandos)

#### F5-01 — Parser, ajuda, erros e `--json`
- **Entrega:** `native/src/cli/` (ajuda completa, `--json` de `JSON_COMMANDS`).
- **Aceite:** SPEC-03 §1.1–§1.4 (ajuda por comando com as linhas e continuações; ajuda com config
  inválida → aviso e saída 0; `JSON_COMMANDS` e as formas de saída; cor só com TTY e sem `NO_COLOR`);
  texto da ajuda igual ao de `cli/src/ajuda.ts` e `cli/src/lifecycle-help.ts`; comando desconhecido →
  mensagem, ajuda no stdout e saída 1. Testes TS equivalentes: `cli/src/args-ajuda-erro.test.ts`,
  `cli/src/json-cmd.test.ts`, `cli/src/render-ruido.test.ts`, `cli/src/render-tokens.test.ts`,
  `cli/src/hora.test.ts`.
- **Decisões (ADR 09):** DV-24: corrigir (a ajuda cita `--json` de `import` e `restore`); DV-26: corrigir (`hub help` não cria pastas).
- **Depende:** F1-21.
- **Agente:** c-engineer · **Área:** `native/src/cli/` (parser, ajuda, json).

#### F5-02 — Ciclo de vida do serviço
- **Entrega:** `native/src/cli/` (`daemon`, `stop`, `status`, `health`, `restart`, `version`, `logs`).
- **Aceite:** linhas de SPEC-03 §1.8 "Daemon e ciclo de vida" (`DAEMON_ALREADY_RUNNING` e `PORT_IN_USE`
  com sonda de 1500 ms; `hub daemon` executa o `agents-hubd` instalado em primeiro plano (DA-31); `restart` sem
  `--force` com sessões vivas → erro, espera de 20.000 ms; `logs`
  com `--lines`, `--follow` a 500 ms e troca à meia-noite, `--list`); spawn desacoplado do serviço com
  janela oculta (SPEC-03 §1.6). Testes TS equivalentes: `cli/src/daemon-run.test.ts`,
  `cli/src/restart-cmd.test.ts`, `cli/src/version-cmd.test.ts`, `cli/src/logs-cmd.test.ts`,
  `cli/src/bin.test.ts`.
- **Decisões (ADR 09):** DV-14: corrigir (`hub --version --json` respeita `--json`); DV-17: corrigir (`hub logs -n` aceito); DA-20: remover os comportamentos ligados a Node (sem Node no produto); DA-14: serviço `agents-hubd` (sobe no login, sem janela); janela e bandeja em `agents-hub`, cliente da mesma API HTTP; CLI `hub`, com MCP e hook como subcomandos; DA-31: `hub mcp serve` roda o MCP por stdio; `hub daemon` executa o `agents-hubd` em primeiro plano; o autostart sob demanda sobe o `agents-hubd` em segundo plano.
- **Depende:** F4-01, F5-01.
- **Agente:** c-engineer · **Área:** `native/src/cli/` (ciclo de vida).

#### F5-03 — Backup e restauração
- **Entrega:** `native/src/cli/` (`backup`, `restore`).
- **Aceite:** SPEC-03 §1.8 (backup pelo serviço quando ele está no ar, local quando parado; restore
  recusado com o serviço no ar, prévia sem `--write`) e SPEC-02 §8 (pré-restauração com `VACUUM INTO` ou
  cópia crua, temporário + `rename`). Testes TS equivalentes: `cli/src/backup-cmd.test.ts`,
  `store/src/backup.test.ts`.
- **Depende:** F1-08, F4-05, F5-01.
- **Agente:** c-engineer · **Área:** `native/src/cli/` (backup).

#### F5-04 — `hooks` e `mcp` (configuração offline)
- **Entrega:** `native/src/cli/` (`hooks`, `hooks install`, `mcp`, `mcp show`, `mcp install`).
- **Aceite:** SPEC-03 §1.9 inteira (alvos claude/openclaude/codex; os 9 alvos de MCP com arquivo,
  formato e "verificado"; saídas; comparação "registrado com outro caminho/porta"); JSONC e TOML
  conforme DA-22; todo teste de `--write` roda com `HOME`/`USERPROFILE` (e `APPDATA` no Windows) em
  pasta temporária, nunca contra as configs reais dos CLIs (`CLAUDE.md`, regra 4). Testes TS
  equivalentes: `cli/src/hooks-install.test.ts`, `cli/src/mcp-registro.test.ts`,
  `cli/src/install-write.test.ts`, `cli/src/gate-aviso.test.ts`.
- **Decisões (ADR 09):** DV-21: novo formato apontando para o executável C, com a regra "é nosso" redefinida e migração das entradas antigas; DA-22: leitor e gravador mínimos próprios, só para as chaves que o Hub edita, com teste de ida e volta.
- **Depende:** F4-08, F5-01.
- **Agente:** c-engineer · **Área:** `native/src/cli/` (hooks, mcp).

#### F5-05 — Agentes, doctor, descoberta e importação
- **Entrega:** `native/src/cli/` (`agents`, `doctor`, `discover`, `import`).
- **Aceite:** linhas de SPEC-03 §1.8 "Agentes, descoberta e importação" (`doctor` valida o
  `config.json` antes do serviço; vereditos; `--smoke` em série, teto US$ 0,10, 90 s, recusa sem TTY
  nem `--yes`; `import` sem `--write` = `dryRun`). O `doctor` confere o SHA-512 dos binários instalados
  contra o manifesto assinado da versão corrente e acusa divergência (SEC-R40; DA-04, DA-29), avisa de
  manifesto antigo ou vencido (expiração de 30 dias, SEC-R18; DA-04) e mostra o estado do cofre no
  Linux, com o aviso permanente quando não há keyring (SEC-R25; DA-01). O texto diz que a conferência
  detecta troca acidental, mas não detém atacante decidido (SPEC-08 A6). Testes TS equivalentes:
  `cli/src/doctor-cmd.test.ts`,
  `cli/src/doctor-smoke.test.ts`, `cli/src/discover-cmd.test.ts`.
- **Decisões (ADR 09):** DV-16: corrigir (`doctor --json` sai como JSON puro); DA-01: opção 1 da F7-01: arquivo 0600 em pasta 0700, com aviso permanente; DA-04: envelope único; Ed25519 puro; Windows troca os binários com rollback (W2); chave diária local cifrada (O2) e a de recuperação em mídia separada; revogação só pela chave de recuperação; expiração de 30 dias; DA-29: adotar todos os endurecimentos listados.
- **Depende:** F4-01, F4-03, F5-01.
- **Agente:** c-engineer · **Área:** `native/src/cli/` (agentes, doctor).

#### F5-06 — Projetos
- **Entrega:** `native/src/cli/` (`projects`, `project add|env|prompt|folders|trust|untrust`).
- **Aceite:** SPEC-03 §1.8 "Projetos" (resolução de `[projeto]` com registro na hora; no Windows,
  comparação sem caixa e com nomes 8.3; máscara `****` no env; erros de uso). Testes TS equivalentes:
  `cli/src/project-resolve.test.ts`, `cli/src/project-env-cmd.test.ts`.
- **Depende:** F4-03, F5-01.
- **Agente:** c-engineer · **Área:** `native/src/cli/` (projetos).

#### F5-07 — Sessões e acompanhamento
- **Entrega:** `native/src/cli/` (`start` completo, `sessions`, `watch` com `--root`, `send`,
  `interrupt`, `pause`, `cancel`).
- **Aceite:** SPEC-03 §1.8 "Sessões" e o parágrafo "Acompanhamento" (vigia de 1500 ms, fim pela task,
  desfecho `unknown` após 600.000 ms, BEL + OSC 0 em `approval.requested`, filtros sem `--verbose`);
  validação local do `start` na ordem; `--from`; aviso de gate (rota 54); `--isolation container`
  conforme DA-21; saída do texto do agente no terminal conforme DV-34 (SEC-R32). Testes TS
  equivalentes: `cli/src/start-cmd.test.ts`, `cli/src/session-follow.test.ts`,
  `cli/src/continue-from.test.ts`, `cli/src/pause-cmd.test.ts`.
- **Decisões (ADR 09):** DA-21: recusar `container` com erro claro na entrada; ler linhas antigas como estão; DV-34: sanear C0/C1/ESC do texto do agente no terminal.
- **Depende:** F4-04, F4-08, F5-01.
- **Agente:** c-engineer · **Área:** `native/src/cli/` (sessões).

#### F5-08 — Delegação, resultado e custo
- **Entrega:** `native/src/cli/` (`delegate`, `handoff`, `diff`, `artifacts`, `graph`, `budget`,
  `export`, `cost`).
- **Aceite:** SPEC-03 §1.8 "Delegação, resultado e custo" (`graph`/`budget` sem `--json` trocam a filha
  pela raiz; `export` paginado com `limit=5000`, sem `raw` por padrão; `cost` com `--since` e os 5
  fluxos mais caros, 10 no JSON). Testes TS equivalentes: `cli/src/export-cmd.test.ts`,
  `cli/src/cost-cmd.test.ts`.
- **Depende:** F4-07, F5-07.
- **Agente:** c-engineer · **Área:** `native/src/cli/` (delegação, custo).

#### F5-09 — `merge` e `apply`
- **Entrega:** `native/src/cli/` (`merge`, `apply`).
- **Aceite:** SPEC-03 §1.8 (estratégias e padrões; prévia sem `--write`; os 7 bloqueios; conflito
  desfeito; nunca `push`). Teste TS equivalente: `cli/src/merge-cmd.test.ts`.
- **Depende:** F4-04, F5-01.
- **Agente:** c-engineer · **Área:** `native/src/cli/` (merge).

#### F5-10 — Aprovações, manutenção, política e auditoria
- **Entrega:** `native/src/cli/` (`approvals`, `approve`, `deny`, `prune`, `policy` com 6
  subcomandos, `audit`).
- **Aceite:** SPEC-03 §1.8 "Aprovações, manutenção, política e auditoria" (valor de `policy set` passa
  por parse JSON e cai para texto; `unset` remove pais vazios; mensagem de subcomando desconhecido).
  SEC-R33 (a aprovação mostra a ação inteira, inclusive o fim de um comando longo) é PROPOSTA da
  SPEC-08 (U3). Teste TS equivalente: `cli/src/policy-cmd.test.ts`.
- **Decisões (ADR 09):** DA-29: adotar todos os endurecimentos listados.
- **Depende:** F4-05, F4-06, F5-01.
- **Agente:** c-engineer · **Área:** `native/src/cli/` (aprovações, política).

#### F5-11 — Workflows
- **Entrega:** `native/src/cli/` (`workflow`, `validate`, `run`, ajuda própria).
- **Aceite:** SPEC-03 §1.8 "Workflows" (validação local; orquestração na CLI sem `/workflows/runs`;
  poll de 2000 ms; passo até 45 min; aprovação pendente não encerra o passo). Teste TS equivalente:
  `cli/src/workflow-cmd.test.ts`.
- **Decisões (ADR 09):** DV-15: corrigir (`workflow validate` e a ajuda do workflow não sobem o serviço); DV-27: manter (MCP termina `blocked`; CLI espera a aprovação).
- **Depende:** F2-07, F4-04, F5-01.
- **Agente:** c-engineer · **Área:** `native/src/cli/` (workflow).

#### F5-12 — `init`, `open`, `autostart` e `update`
- **Entrega:** `native/src/cli/` (os quatro comandos).
- **Aceite:** `init` em cinco passos (SPEC-03 §1.12); `open` e `autostart` (SPEC-03 §1.8, §1.10) com o
  comportamento no C definido pelas pendências; `update` conforme ADR 7.13 (SPEC-03 §1.11 diz que o C
  não herda as instruções manuais); como a DV-20 decidiu que `hub update` checa e aplica a
  atualização na hora, o comando usa o atualizador da F8-06 (por isso depende dela); autostart ligado a SEC-R38 (entrada `Run` entre aspas, `.desktop`
  escapado, detecção do `.vbs` do TS; PROPOSTA da SPEC-08, G2/G3). Testes TS equivalentes:
  `cli/src/init-cmd.test.ts`,
  `cli/src/open-cmd.test.ts`, `cli/src/autostart-cmd.test.ts`, `cli/src/update-cmd.test.ts`.
- **Decisões (ADR 09):** DV-19: autostart também no Linux (XDG); remover o ramo de macOS do `hub open`; DV-20: `hub update` checa e aplica a atualização na hora, com confirmação; DA-14: serviço `agents-hubd` (sobe no login, sem janela); janela e bandeja em `agents-hub`, cliente da mesma API HTTP; CLI `hub`, com MCP e hook como subcomandos; DA-20: remover os comportamentos ligados a Node (sem Node no produto); DA-29: adotar todos os endurecimentos listados; DA-32: `hub open` abre ou traz para frente a janela `agents-hub`, iniciando o serviço se preciso.
- **Depende:** F5-02, F8-06.
- **Agente:** c-engineer · **Área:** `native/src/cli/` (init, open, autostart, update).

#### F5-13 — Conformidade dos 46 comandos
- **Entrega:** `native/tests/integration/` e `native/tests/conformance/` (CLI).
- **Aceite:** `hub help` do C lista os **46** comandos de topo e os subcomandos de SPEC-03 "Contagem";
  todo caso de CLI do corpus de F0-13 passa; os comandos que sobem e os que não sobem o serviço batem
  com SPEC-03 §1.6; executado com hub isolado.
- **Depende:** F5-02, F5-03, F5-04, F5-05, F5-06, F5-07, F5-08, F5-09, F5-10, F5-11, F5-12.
- **Agente:** test-engineer · **Área:** `native/tests/` (CLI).

**Paralelo na F5:** depois de F5-01, {F5-02, F5-03, F5-04, F5-05, F5-06, F5-07, F5-09, F5-10, F5-11}
(um arquivo de comando cada; a tabela de comandos e o texto de ajuda são da F5-01, com as entradas
aplicadas em série conforme o §0); F5-08 depois de F5-07; F5-12 depois de F5-02; F5-13 fecha a fase.

---

### F6 — UI nativa (SDL3 + SDL_ttf + Clay) e bandeja

Paridade com os **198 controles** de SPEC-05 (C001–C198), sem lógica de domínio no cliente (ADR 07
"O que isto substitui", ADR 1.2). Decidido (ADR 09, 9.1; DA-14, DA-06): a janela e a bandeja são o
executável `agents-hub`, cliente da mesma API HTTP do `agents-hubd` pelo `native/src/client/`, com
Bearer + `X-Hub-Client: ui`; fechar ou travar a janela não encerra as sessões (ADR 7.5).
Toda tarefa de tela cita os controles da SPEC-05 que entrega.

#### F6-01 — Base da janela
- **Entrega:** `native/src/ui/` (janela, laço, layout Clay, fontes, tema, DPI, faixas de largura).
- **Aceite:** tokens claro/escuro de SPEC-05 §13.1 (valores idênticos), seguindo o sistema sem escolha
  salva; a escolha explícita de tema é gravada no `config.json` (DA-07), no lugar do `localStorage`; faixas de largura de §13.2 (1200/1000/900/768/600 px); "reduzir movimento" anula animações;
  laço sem redesenho ocioso, com CPU parado medido (DA-11); cor por agente com o hash de §13.1.
- **Decisões (ADR 09):** DA-07: diálogos nativos de confirmação; tema salvo no `config.json`; notificação do SO quando a janela está oculta; seletor de pasta nativo; DA-11: confirmadas (C17 sem VLA/`stdatomic`, CMake ≥ 3.22, UI só sob evento, linuxdeploy + appimagetool); DA-14: serviço `agents-hubd` (sobe no login, sem janela); janela e bandeja em `agents-hub`, cliente da mesma API HTTP; CLI `hub`, com MCP e hook como subcomandos; DA-12 (parte Windows): HarfBuzz vem com o SDL_ttf; emoji colorido COLR sem plutosvg no Windows.
- **Depende:** F0-12, F0-14, F1-20 · bloqueia o aceite: DA-12 (parte Linux).
- **Agente:** c-engineer · **Área:** `native/src/ui/` (janela, tema, layout).

#### F6-02 — Widgets próprios
- **Entrega:** `native/src/ui/` (botão, campo, área de texto com IME, seleção, caixa de marcar,
  segmento, chip, divulgação, barra de progresso, dica, lista com rolagem).
- **Aceite:** cada widget com estados desabilitado/ocupado/foco; foco visível de 2 px em `--accent`
  (SPEC-05 §14); texto não ASCII e IME funcionando (riscos do ADR 08).
- **Depende:** F6-01.
- **Agente:** c-engineer · **Área:** `native/src/ui/` (widgets).

#### F6-03 — Foco, teclado, diálogos e gavetas
- **Entrega:** `native/src/ui/` (pilha de diálogos, foco preso, gavetas, atalhos globais).
- **Aceite:** SPEC-05 §14 (tabela de atalhos; diálogo com foco inicial, foco preso, Esc só no topo,
  fundo inerte com toasts dispensáveis, foco devolvido); gaveta aberta tira o resto da janela da ordem
  de foco (K2, SPEC-05 §15); confirmações de troca de aba/seção/camada/projeto com equivalente nativo.
- **Decisões (ADR 09):** DA-07: diálogos nativos de confirmação; tema salvo no `config.json`; notificação do SO quando a janela está oculta; seletor de pasta nativo.
- **Depende:** F6-02.
- **Agente:** c-engineer · **Área:** `native/src/ui/` (foco, diálogos).

#### F6-04 — Toasts, estados de tela, ocupado e formatação
- **Entrega:** `native/src/ui/` (fila de toasts, `EstadoDaTela`, rótulos de ocupado, formatadores,
  tradução de erros).
- **Aceite:** SPEC-05 §13.3 (3 tipos, 4/8/12 s, até 3 na tela; tradução de 403, validação, não JSON e
  conexão), §12.5 (C195; "falha nunca vira vazio"), §12.6 (todos os rótulos), §13.4 (formatos de US$,
  tokens, duração e tempo relativo); C012.
- **Depende:** F6-02.
- **Agente:** c-engineer · **Área:** `native/src/ui/` (toasts, estados, formato).

#### F6-05 — Estado ao vivo
- **Entrega:** `native/src/ui/` (carga do índice, assinatura SSE, reconexão, recarga agrupada,
  revisões, fluxos).
- **Aceite:** SPEC-05 §3.1 (4 recursos, situação por recurso, banner só para recarga), §3.2 (um SSE
  sem filtro, reconexão que repõe o buraco com `since`), §3.3 (eventos estruturais, patch imediato sem
  dedução, debounce de 300 ms com teto de 1500 ms, nunca duas buscas em voo, revisão por fluxo), §3.4
  (fluxo por `rootId`, estado mais urgente, ordem).
- **Decisões (ADR 09):** DA-06: Bearer + `X-Hub-Client: ui` → `ui:<usuário>`.
- **Depende:** F4-04, F4-05, F6-01.
- **Agente:** c-engineer · **Área:** `native/src/ui/` (estado).

#### F6-06 — Timeline
- **Entrega:** `native/src/ui/` (histórico paginado, janela de desenho, renderização dos eventos).
- **Aceite:** SPEC-05 §3.5 (página mais recente, mescla por `seq`, teto de 3000, anteriores, 5
  tentativas 1/2/4/8/16 s, fluxo inteiro com até 12 sessões; janela de 400/800 eventos, a 80 px e a
  60 px; posição preservada) e §3.6 (tabela de texto/tipo/"só em Detalhado"; ANSI removido); C035–C039.
  Texto cru, como o painel atual (SPEC-05 §3.6; paridade, ADR 7.4). Markdown fica para depois da
  paridade (ADR 09, 9.4; backlog PP-01, §7).
- **Decisões (ADR 09):** DA-08: depois da paridade (backlog PP-01, §7); a primeira versão mostra texto cru.
- **Depende:** F6-02, F6-05.
- **Agente:** c-engineer · **Área:** `native/src/ui/` (timeline).

#### F6-07 — Topbar, abas, menu e paleta
- **Entrega:** `native/src/ui/` (topbar, 7 abas, menu ⋮, paleta Ctrl+K).
- **Aceite:** SPEC-05 §1, §1.1 (abas na ordem; pergunta de "alterações não salvas"; filtro de projeto e
  sessão selecionada compartilhados), §4 (C001–C012), §12.3 (C191, C192, grupos, rodapé), C198.
- **Depende:** F6-03, F6-04, F6-05.
- **Agente:** c-engineer · **Área:** `native/src/ui/` (topbar, paleta).

#### F6-08 — Fila de aprovações, boas-vindas e notificação
- **Entrega:** `native/src/ui/` (fila de aprovações em todas as abas, cartão de boas-vindas,
  notificação do SO).
- **Aceite:** SPEC-05 §4.1 (C013–C016, selos de risco em português, toasts), §4.2 (C017–C019), §3.7
  (uma notificação por `approvalId`, título e corpo de até 180 caracteres). SEC-R33 (a aprovação mostra
  a ação inteira) é PROPOSTA da SPEC-08 (U3).
- **Decisões (ADR 09):** DA-06: Bearer + `X-Hub-Client: ui` → `ui:<usuário>`; DA-07: diálogos nativos de confirmação; tema salvo no `config.json`; notificação do SO quando a janela está oculta; seletor de pasta nativo; DA-29: adotar todos os endurecimentos listados.
- **Depende:** F6-07.
- **Agente:** c-engineer · **Área:** `native/src/ui/` (aprovações, onboarding).

#### F6-09 — Aba Timeline: fluxos, centro e compositor
- **Entrega:** `native/src/ui/` (coluna de fluxos, cabeçalho e área central, compositor).
- **Aceite:** SPEC-05 §5.1 (C020–C030; o contador "Todos" conta todos os fluxos, independente do
  segmento marcado: K3, §15) e §5.2 (C031–C041; estados da área central; placeholders do compositor;
  toast de `replay`).
- **Depende:** F6-06, F6-07.
- **Agente:** c-engineer · **Área:** `native/src/ui/` (aba timeline: colunas esquerda/centro).

#### F6-10 — Painel direito
- **Entrega:** `native/src/ui/` (orçamento do fluxo, memória e contexto, controles da sessão,
  detalhes técnicos).
- **Aceite:** SPEC-05 §5.3 (C042–C055; habilitação derivada só do estado do daemon; níveis
  `danger`/`warn`/`ok`; confirmação de encerramento em linha).
- **Depende:** F4-07, F6-09.
- **Agente:** c-engineer · **Área:** `native/src/ui/` (painel direito).

#### F6-11 — Swarm, Grafo DAG e Telemetria
- **Entrega:** `native/src/ui/` (três abas).
- **Aceite:** SPEC-05 §6 (C056, C057), §7 (C058–C062; arestas `delegation`/`handoff`/`root`, rótulos,
  até 4 `/graph` em paralelo, navegação de árvore), §8 (C063–C065; KPIs, custo por agente, custo no
  tempo com 24/7/30/12 faixas). Árvore indentada com os marcadores `↳`/`⇄` de SPEC-05 §7 (paridade,
  ADR 7.4). O grafo desenhado fica para depois da paridade (ADR 09, 9.4; backlog PP-02, §7).
- **Decisões (ADR 09):** DA-09: depois da paridade (backlog PP-02, §7); a primeira versão é a árvore indentada.
- **Depende:** F4-07, F6-07.
- **Agente:** c-engineer · **Área:** `native/src/ui/` (swarm, dag, telemetria).

#### F6-12 — Operação: Sessão e Workflow
- **Entrega:** `native/src/ui/` (subnav, seções Sessão e Workflow).
- **Aceite:** SPEC-05 §9 (C066, C067; sucesso só ao lado do botão, erro também em toast), §9.1
  (C068–C079; validação do teto com os textos), §9.2 (C080–C089; recusa acima de 200 kB, releitura a
  cada 2 s com execução `running`). C074 (copiar) usa a área de transferência do SO e C083 (abrir arquivo) usa o diálogo nativo de abrir arquivo (DA-07).
- **Decisões (ADR 09):** DA-07: diálogos nativos de confirmação; tema salvo no `config.json`; notificação do SO quando a janela está oculta; seletor de pasta nativo; DV-12: manter `submitted`, `auth_required` e `expired` no esquema (banco migrado), sem gerá-los; DA-07 (adendo 2): área de transferência do SO para C074, diálogo nativo de abrir arquivo para C083.
- **Depende:** F4-04, F4-07, F6-07.
- **Agente:** c-engineer · **Área:** `native/src/ui/` (operação: sessão, workflow).

#### F6-13 — Operação: Projeto, Saúde e Manutenção
- **Entrega:** `native/src/ui/` (três seções).
- **Aceite:** SPEC-05 §9.3 (C090–C103), §9.4 (C104, C105), §9.5 (C106–C108), com os textos de
  confirmação.
- **Decisões (ADR 09):** DA-06: Bearer + `X-Hub-Client: ui` → `ui:<usuário>`.
- **Depende:** F4-03, F4-05, F6-07.
- **Agente:** c-engineer · **Área:** `native/src/ui/` (operação: projeto, saúde, manutenção).

#### F6-14 — Segurança: Política e Confiança
- **Entrega:** `native/src/ui/` (seletor da aba, editor de camada, confiança do projeto).
- **Aceite:** SPEC-05 §10 (C109, C110; projeto da aba), §10.1 (C111–C120; revisão obrigatória antes de
  gravar, só o texto revisado, avisos de afrouxar/clamp/ignorado), §10.2 (C121–C125; estados
  `confiável`/`confiança suspensa`/`não confiável`).
- **Decisões (ADR 09):** DA-06: Bearer + `X-Hub-Client: ui` → `ui:<usuário>`.
- **Depende:** F4-03, F4-06, F6-07.
- **Agente:** c-engineer · **Área:** `native/src/ui/` (segurança: política, confiança).

#### F6-15 — Segurança: Gate e MCP, Aprovações e Auditoria
- **Entrega:** `native/src/ui/` (três seções).
- **Aceite:** SPEC-05 §10.3 (C126–C130; prévia com diff linha a linha), §10.4 (C131–C134; junção por
  `approvalId`), §10.5 (C135–C142; consulta `limit=200`). C140 (exportar JSON) usa o diálogo nativo de salvar arquivo (DA-07); o
  rótulo `expirada` depende de DV-12.
- **Decisões (ADR 09):** DA-06: Bearer + `X-Hub-Client: ui` → `ui:<usuário>`; DA-07: diálogos nativos de confirmação; tema salvo no `config.json`; notificação do SO quando a janela está oculta; seletor de pasta nativo; DV-12: manter `submitted`, `auth_required` e `expired` no esquema (banco migrado), sem gerá-los; DA-07 (adendo 2): diálogo nativo de salvar arquivo no lugar do download para C140.
- **Depende:** F4-06, F4-08, F6-07.
- **Agente:** c-engineer · **Área:** `native/src/ui/` (segurança: gate/mcp, aprovações, auditoria).

#### F6-16 — Configurações e Agentes detectados
- **Entrega:** `native/src/ui/` (5 subabas, descoberta e importação).
- **Aceite:** SPEC-05 §11 (C143–C160; formulário travado quando a carga falha; valor vazio remove a
  variável; máscara `••••`; sugestões Ollama/LM Studio/vLLM só para `OPENAI_*`), §11.1 (C161–C173;
  prévia e confirmação).
- **Decisões (ADR 09):** DA-07: diálogos nativos de confirmação; tema salvo no `config.json`; notificação do SO quando a janela está oculta; seletor de pasta nativo; DV-22: validar na UI o modelo que começa com `-`.
- **Depende:** F4-01, F4-03, F6-07.
- **Agente:** c-engineer · **Área:** `native/src/ui/` (configurações, descoberta).

#### F6-17 — Modais e confirmações
- **Entrega:** `native/src/ui/` (Nova Sessão/Delegar, Registrar projeto, diálogo de confirmação, fundos).
- **Aceite:** SPEC-05 §12.1 (C174–C184; validação com faixa 0,10–50,00; brief enviado; clique no fundo
  não fecha com texto), §12.2 (C185–C190; etapas retomáveis; validação de caminho absoluto), §12.4
  (C193, C194; foco inicial em "Cancelar"), §12.7 (C196, C197).
- **Depende:** F4-03, F4-04, F6-03, F6-05.
- **Agente:** c-engineer · **Área:** `native/src/ui/` (modais).

#### F6-18 — Bandeja e ciclo de vida
- **Entrega:** `native/src/ui/` (bandeja, fechar sem encerrar o serviço).
- **Aceite:** a bandeja fica no `agents-hub`, e o serviço é o `agents-hubd` (DA-14); fechar a janela
  **não** encerra o serviço, que segue com as sessões vivas (ADR 7.5); `SDL_CreateTray` só na thread principal (ADR 08); comportamento sem
  `libayatana-appindicator3`/`libappindicator3` no Linux conforme o resultado de F0-14 (risco aceito no
  ADR 08).
- **Decisões (ADR 09):** DA-10: ícone próprio encomendado; até lá, um provisório gerado; DA-14: serviço `agents-hubd` (sobe no login, sem janela); janela e bandeja em `agents-hub`, cliente da mesma API HTTP; CLI `hub`, com MCP e hook como subcomandos.
- **Depende:** F0-14, F6-01.
- **Agente:** c-engineer · **Área:** `native/src/ui/` (bandeja).

#### F6-19 — Conformidade dos 198 controles e acessibilidade
- **Entrega:** matriz C001–C198 → tarefa → evidência (teste ou captura), em `native/tests/` e
  registrada em `docs/19-status-reescrita-c.md`.
- **Aceite:** os 198 controles com evidência ou com a pendência (DA/DV) que os bloqueia; os equivalentes
  de acessibilidade de SPEC-05 §14 conferidos um a um (papéis, anúncios, rótulos escondidos por
  largura, estado não só por cor), registrando a limitação de leitor de tela aceita no ADR 08; as
  faixas de 1440, 1100, 768 e 375 px sem sobreposição, corte nem rolagem horizontal (SPEC-05 §13.2).
  Matriz própria dos testes de `packages/web` (SPEC-07 §1 e §3): os 14 arquivos de lógica
  (`lib/*.test.ts`, `logic/*.test.ts`), com `logic/api-routes.test.ts` justificado como não portável
  (proxy do Vite, SPEC-07 §4.A), e os 4 e2e (`estados`, `operacao`, `painel`, `reaberturas`) usados
  como referência de cenário para os testes da UI nativa.
- **Depende:** F6-07, F6-08, F6-09, F6-10, F6-11, F6-12, F6-13, F6-14, F6-15, F6-16, F6-17, F6-18.
- **Agente:** test-engineer · **Área:** `native/tests/` (UI).

**Paralelo na F6:** F6-01 → F6-02 → {F6-03, F6-04} ∥ F6-05 ∥ F6-18; depois F6-06 e F6-07; em seguida
{F6-08, F6-09, F6-11, F6-12, F6-13, F6-14, F6-15, F6-16, F6-17} (um arquivo de tela cada); F6-10 depois
de F6-09; F6-19 fecha a fase.

---

### F7 — Migração de dados e cofre do SO

#### F7-01 — Proposta de desenho: migração e cofre
- **Entrega:** proposta escrita para o dono decidir DA-01, DA-02 e DA-03.
- **Aceite:** parte dos fatos de SPEC-02 §5 e §10 (origem v1–v10; colunas geradas; órfãos de
  `events.task_id`; `pfd_prj_…`; `auto_vacuum = none` possível; caminhos absolutos em
  `sessions.workdir` e `artifacts.path`; único segredo = `projects.hub_context → $.env`); apresenta
  opções sem escolher; cobre também SPEC-08 V1–V5 e D10 como opções; revisada por security-auditor.
- **Depende:** —.
- **Agente:** docs-writer (revisão: security-auditor) · **Área:** `docs/propostas/F7-01-migracao-e-cofre.md`.

#### F7-02 — Migração do banco na primeira execução
- **Entrega:** `native/src/store/` (rotina de migração conforme DA-03).
- **Aceite:** ADR 7.15; banco real **nunca** usado em teste, só cópias geradas pelo TS em home
  temporário; cada fato de SPEC-02 §10 tem um teste; falha não perde dado (cópia de segurança antes,
  como no restore de SPEC-02 §8.3, se DA-03 assim decidir); linhas antigas com `container` conforme
  DA-21. SEC-R24 (o valor migrado não fica em `hub.db`, `-wal` nem páginas livres) depende de DV-35.
- **Decisões (ADR 09):** DA-03: cópia de segurança antes e migração no lugar (M-C), com o TS parado e a porta presa; marca dentro do banco (migração 11); DA-21: recusar `container` com erro claro na entrada; ler linhas antigas como estão; DV-35: limpar o env antigo na migração (`secure_delete` → `VACUUM` → checkpoint), detalhe na proposta F7-01.
- **Depende:** F1-08, F7-01.
- **Agente:** c-engineer · **Área:** `native/src/store/` (migração).

#### F7-03 — Cofre no Windows
- **Entrega:** `native/src/platform/` (acesso ao cofre do SO no Windows).
- **Aceite:** ADR 7.16; nome das entradas e formato da referência conforme DA-02; teste com entradas
  descartáveis, removidas no fim; SEC-R23 (valor de 2000 caracteres multibyte gravado e relido igual,
  ou recusado com erro, nunca truncado; PROPOSTA da SPEC-08, V1).
- **Decisões (ADR 09):** DA-02: tabela própria no banco (R-C) com nome opaco (N-D); no Windows, DPAPI em arquivo (W-B), sem o teto de 2560 bytes.
- **Depende:** F0-05, F7-01.
- **Agente:** c-engineer · **Área:** `native/src/platform/` (cofre Windows).

#### F7-04 — Cofre no Linux
- **Entrega:** `native/src/platform/` (Secret Service e a política sem keyring).
- **Aceite:** ADR 7.16; comportamento sem Secret Service conforme DA-01; testado com e sem keyring;
  SEC-R25 (nenhum caminho grava segredo em texto sem aviso; `hub doctor` mostra o estado).
- **Decisões (ADR 09):** DA-01: opção 1 da F7-01: arquivo 0600 em pasta 0700, com aviso permanente; DA-02: tabela própria no banco (R-C) com nome opaco (N-D); no Windows, DPAPI em arquivo (W-B), sem o teto de 2560 bytes.
- **Depende:** F0-05, F7-01.
- **Agente:** c-engineer · **Área:** `native/src/platform/` (cofre Linux).

#### F7-05 — Env por projeto no cofre
- **Entrega:** `native/src/daemon/` (gravação e leitura do env via cofre), migração dos valores
  existentes, atualização do `SECURITY.md`.
- **Aceite:** o banco guarda só a referência (ADR 7.16); a sanitização por lista de permissão continua
  (SPEC-02 §5; SPEC-04 A13); a auditoria registra só as chaves (SPEC-01 §6.3 linha 18); `SECURITY.md`
  deixa de dizer "Não existe cofre" e descreve o que o C faz (parte de SEC-R41); resíduos do texto
  antigo conforme DV-35 (SEC-R24).
- **Decisões (ADR 09):** DA-03: cópia de segurança antes e migração no lugar (M-C), com o TS parado e a porta presa; marca dentro do banco (migração 11); DV-35: limpar o env antigo na migração (`secure_delete` → `VACUUM` → checkpoint), detalhe na proposta F7-01; DA-29: adotar todos os endurecimentos listados; DA-02: tabela própria no banco (R-C) com nome opaco (N-D); no Windows, DPAPI em arquivo (W-B).
- **Depende:** F2-10, F7-02, F7-03, F7-04.
- **Agente:** c-engineer (`SECURITY.md`: docs-writer) · **Área:** `native/src/daemon/` (contexto do projeto), `SECURITY.md`.

#### F7-06 — Auditoria de segurança do cofre e da migração
- **Entrega:** relatório de achados priorizados.
- **Aceite:** nenhum segredo em log, evento, auditoria ou arquivo temporário; nenhum valor de env em
  texto no banco depois da migração; achados críticos corrigidos antes do `[x]` de F7-05.
- **Depende:** F7-05.
- **Agente:** security-auditor · **Área:** nenhuma de código.

**Paralelo na F7:** F7-01 (já) → {F7-02, F7-03, F7-04} (áreas disjuntas) → F7-05 → F7-06.

---

### F8 — Instalador, atualizador e AppImage

#### F8-01 — Layout de instalação
- **Entrega:** definição e alvo de instalação no CMake (binários, manifestos dos 9 agentes, recursos de
  UI), com os caminhos que o `hub` grava nas configs dos agentes.
- **Aceite:** instala `agents-hubd`, `agents-hub` e `hub` (MCP e hook como subcomandos do `hub`;
  ADR 09, 9.1), cumprindo o ADR 7.7; o que é instalado e onde,
  coerente com DA-14 e DV-21; `manifestsDir` com override do usuário preservado (SPEC-02 §6); recursos
  de UI (fontes e o que F0-12 vendorizar) incluídos.
- **Decisões (ADR 09):** DA-14: serviço `agents-hubd` (sobe no login, sem janela); janela e bandeja em `agents-hub`, cliente da mesma API HTTP; CLI `hub`, com MCP e hook como subcomandos; DV-21: novo formato apontando para o executável C, com a regra "é nosso" redefinida e migração das entradas antigas; DA-31: `hub mcp serve` e `hub daemon` (executa o `agents-hubd`); DA-33: manifestos empacotados sem `defaults.isolation`; manifestos de usuário com o campo continuam válidos.
- **Depende:** F5-13, F6-19.
- **Agente:** build-release-engineer · **Área:** `native/cmake/` (instalação).

#### F8-02 — Instalador Windows
- **Entrega:** script do Inno Setup.
- **Aceite:** instalação por usuário com `PrivilegesRequired=lowest` (ADR 8.12, ADR 08 "Fatos"); sem
  Authenticode, com o aviso do SmartScreen aceito (ADR 7.14); o que a desinstalação faz com os dados
  do usuário segue a DA-28 (não apaga `~/.agents-hub`, remove o autostart, oferece remover os hooks
  gravados); o autostart sobe o `agents-hubd` (DA-14), ligado a SEC-R38; ícone provisório até o
  próprio (DA-10).
- **Decisões (ADR 09):** DA-10: ícone próprio encomendado; até lá, um provisório gerado; DA-14: serviço `agents-hubd` (sobe no login, sem janela); janela e bandeja em `agents-hub`, cliente da mesma API HTTP; CLI `hub`, com MCP e hook como subcomandos; DA-28: não apagar `~/.agents-hub`; remover o autostart; oferecer remover os hooks gravados; DV-19: autostart também no Linux (XDG); remover o ramo de macOS do `hub open`; DA-29: adotar todos os endurecimentos listados.
- **Depende:** F8-01.
- **Agente:** build-release-engineer · **Área:** pasta do instalador sob `native/` (indicada em F0-01).

#### F8-03 — AppImage
- **Entrega:** empacotamento AppImage compilado no Ubuntu 22.04.
- **Aceite:** ADR 8.14; ferramenta de montagem conforme DA-11 (proposta: linuxdeploy + appimagetool);
  certificados da libcurl conforme DA-13; tray funcionando ou com falha explicada nas distribuições sem
  appindicator (risco do ADR 08); roda num Ubuntu 22.04 limpo; libcurl e sua biblioteca TLS conforme
  DA-25; SEC-R30 (o ambiente do agente sob AppImage é o de login mais `AGENTS_HUB_*`; PROPOSTA da
  SPEC-08, P6).
- **Decisões (ADR 09):** DA-10: ícone próprio encomendado; até lá, um provisório gerado; DA-11: confirmadas (C17 sem VLA/`stdatomic`, CMake ≥ 3.22, UI só sob evento, linuxdeploy + appimagetool); DA-25: FreeType e HarfBuzz vendorizados com o SDL_ttf; libcurl do sistema no Linux, empacotada no AppImage; DA-29: adotar todos os endurecimentos listados; DA-13 (parte decidida): proxy do sistema pelo WinHTTP; CA do sistema no Linux (a verificação na F8 segue aberta).
- **Depende:** F0-02, F8-01 · bloqueia o aceite: DA-13 (verificar na F8).
- **Agente:** build-release-engineer · **Área:** empacotamento Linux sob `native/`.

#### F8-04 — Proposta do esquema de chave e manifesto de atualização
- **Entrega:** proposta para o dono decidir DA-04.
- **Aceite:** parte da proposta do ADR 08 (manifesto assinado com Ed25519, hash SHA-512 porque o
  Monocypher não tem SHA-256, fonte em `/releases/latest/download/`) e dos riscos aceitos (60
  requisições por hora sem token; troca de executável em uso no Windows); diz onde a chave privada fica
  guardada sem nunca expô-la (regra de segredos do `CLAUDE.md`); considera SPEC-08 A1–A8, SEC-R17 a
  SEC-R22 (inclusive SEC-R18, anti-rollback e expiração) e SEC-R40 como opções.
- **Depende:** —.
- **Agente:** security-auditor (com build-release-engineer) · **Área:** `docs/propostas/F8-04-chave-e-manifesto-de-atualizacao.md`.

#### F8-05 — Chave de assinatura e assinatura da release
- **Entrega:** ferramenta de assinatura em `native/tools/ahsign/`, módulo de verificação em
  `native/src/updater/` (o F8-06 o estende), lugar para as chaves públicas embutidas e o passo de
  assinatura no pipeline. **A geração da chave real é ação do dono**, fora do repositório (DA-04: chave
  diária local cifrada e a de recuperação em mídia separada); a tarefa entrega a ferramenta e prova a
  verificação só com chaves de teste.
- **Aceite:** conforme DA-04; a chave privada nunca aparece em log, artefato ou commit; a verificação
  com Monocypher (ADR 8.10) aceita a assinatura boa e recusa a adulterada; SEC-R22 (sem material de
  chave privada no repositório nem nos workflows).
- **Fuzz (SPEC-08 C4; DA-26):** FZ11 (parser do manifesto de atualização + verificação; nenhum caminho aceita assinatura inválida); o alvo roda na infraestrutura da F0-02.
- **Decisões (ADR 09):** DA-04: envelope único; Ed25519 puro; Windows troca os binários com rollback (W2); chave diária local cifrada (O2) e a de recuperação em mídia separada; revogação só pela chave de recuperação; expiração de 30 dias.
- **Depende:** F0-03, F8-04.
- **Agente:** build-release-engineer · **Área:** `native/tools/ahsign/`, `native/src/updater/` (verificação), pipeline de release.

#### F8-06 — Atualizador
- **Entrega:** `native/src/updater/`.
- **Aceite:** atualização automática a partir do GitHub Releases (ADR 7.13, 8.13); download por
  WinHTTP no Windows e libcurl no Linux (8.11); assinatura e hash conferidos antes de qualquer troca;
  binário que não confere nunca é executado; troca do executável em uso no Windows sem admin (risco
  aceito no ADR 08); proxy conforme DA-13; parte da premissa de repositório público (DA-19);
  SEC-R17 a SEC-R21 conforme o esquema decidido em DA-04. O acesso a WinHTTP e libcurl é chamada ao SO
  e fica em `native/src/platform/` (regra de camadas, `CLAUDE.md`); TLS da libcurl conforme DA-25.
- **Decisões (ADR 09):** DA-04: envelope único; Ed25519 puro; Windows troca os binários com rollback (W2); chave diária local cifrada (O2) e a de recuperação em mídia separada; revogação só pela chave de recuperação; expiração de 30 dias; DA-19: manter o repositório público; DA-25: FreeType e HarfBuzz vendorizados com o SDL_ttf; libcurl do sistema no Linux, empacotada no AppImage; DV-20: `hub update` checa e aplica a atualização na hora, com confirmação; DA-13 (parte decidida): proxy do sistema pelo WinHTTP; CA do sistema no Linux (a verificação na F8 segue aberta).
- **Depende:** F0-09, F8-05 · bloqueia o aceite: DA-13 (verificar na F8).
- **Agente:** c-engineer · **Área:** `native/src/updater/`, `native/src/platform/` (download HTTPS).

#### F8-07 — Pipeline de release
- **Entrega:** workflow que gera instalador, AppImage, manifesto assinado e publica no GitHub Releases.
- **Aceite:** release de teste (rascunho ou pré-release) instalável nos dois SOs; o atualizador de uma
  versão anterior encontra, confere e aplica a nova; SEC-R20 (troca do binário com o processo vivo e
  restauração do anterior se o novo não responder `/health`) no que DA-04 adotar.
- **Decisões (ADR 09):** DA-04: envelope único; Ed25519 puro; Windows troca os binários com rollback (W2); chave diária local cifrada (O2) e a de recuperação em mídia separada; revogação só pela chave de recuperação; expiração de 30 dias.
- **Depende:** F8-02, F8-03, F8-05, F8-06.
- **Agente:** build-release-engineer · **Área:** `.github/workflows/` (release).

#### F8-08 — Auditoria do instalador e do atualizador
- **Entrega:** relatório de achados priorizados.
- **Aceite:** sem caminho de executar binário não verificado; permissões dos arquivos instalados;
  conferência de SEC-R17 a SEC-R22 e SEC-R40 conforme a DA-04 decidida (anti-downgrade,
  expiração de 30 dias e revogação pela chave de recuperação — SEC-R18); achados críticos corrigidos antes do `[x]` de
  F8-07.
- **Decisões (ADR 09):** DA-04: envelope único; Ed25519 puro; Windows troca os binários com rollback (W2); chave diária local cifrada (O2) e a de recuperação em mídia separada; revogação só pela chave de recuperação; expiração de 30 dias; DA-29: adotar todos os endurecimentos listados.
- **Depende:** F8-07.
- **Agente:** security-auditor · **Área:** nenhuma de código.

**Paralelo na F8:** F8-04 (já); F8-01 → {F8-02, F8-03} ∥ F8-05 → F8-06; F8-07 → F8-08.

---

### F9 — Desempenho, prova real e corte do TS

#### F9-01 — Harness de medição
- **Entrega:** scripts de medição conforme o procedimento decidido em DA-05.
- **Aceite:** mede as 7 métricas do ADR 08 com serviço isolado; roda também contra o TS, reproduzindo
  a linha de base da SPEC-06 dentro da tolerância que DA-05 definir.
- **Decisões (ADR 09):** DA-05: procedimento da proposta F0-15 (mediana de ≥ 5, mesma máquina, harness do C em `native/tests/bench/c/`).
- **Depende:** F0-15, F1-19.
- **Agente:** performance-auditor · **Área:** `native/tests/bench/c/` (DA-05).

#### F9-02 — Serviço: RAM, CPU parado, início e vazão
- **Entrega:** medições e as otimizações necessárias.
- **Aceite:** RAM parado ≤ 15 MB; início até `/health` ≤ 150 ms; CPU parado ≈ 0; vazão em rajada ≥ 5.000
  eventos/s sem perda (ADR 08; SPEC-06), medidos pelo procedimento de DA-05, com os números registrados
  em `docs/19-status-reescrita-c.md`.
- **Decisões (ADR 09):** DA-05: procedimento da proposta F0-15 (mediana de ≥ 5, mesma máquina, harness do C em `native/tests/bench/c/`).
- **Depende:** F4-09, F9-01.
- **Agente:** performance-auditor (otimização: c-engineer) · **Área:** a que a otimização exigir, uma tarefa filha por área.

#### F9-03 — Hook do gate e MCP server
- **Entrega:** medições e otimizações.
- **Aceite:** hook do gate ≤ 30 ms no caminho rápido e no comando de shell; MCP com início até responder
  `initialize` ≤ 50 ms e RAM ≤ 10 MB (ADR 08; SPEC-06).
- **Decisões (ADR 09):** DA-05: procedimento da proposta F0-15 (mediana de ≥ 5, mesma máquina, harness do C em `native/tests/bench/c/`).
- **Depende:** F1-22, F2-14, F4-13, F9-01.
- **Agente:** performance-auditor · **Área:** idem.

#### F9-04 — Tamanho instalado
- **Entrega:** medição do tamanho instalado nos dois SOs.
- **Aceite:** ≤ 20 MB (ADR 08; SPEC-06), medido com a UI e seus recursos dentro do pacote (F8-01).
- **Decisões (ADR 09):** DA-05: procedimento da proposta F0-15 (mediana de ≥ 5, mesma máquina, harness do C em `native/tests/bench/c/`).
- **Depende:** F8-02, F8-03, F9-01.
- **Agente:** performance-auditor · **Área:** nenhuma de código (otimização vira tarefa filha).

#### F9-05 — Matriz final de conformidade
- **Entrega:** matriz "teste TS → caso no C" para todos os `*.test.ts` de `packages/` (exceto
  `packages/web`, coberto pela matriz de F6-19), em `docs/19-status-reescrita-c.md`.
- **Aceite:** a matriz parte da tabela por arquivo de SPEC-07 §3 (187 arquivos no `npm test`); cada
  arquivo de teste TS tem equivalente no C ou a justificativa de SPEC-07 §4.A (específico de Node/JS,
  como `cli/src/node-runtime.test.ts` e `core/src/texto.test.ts`, que testa semântica de JS) ou §4.B
  (substituído por ADR, decisão do dono antes de portar); todo pulo por plataforma de SPEC-07 §5 tem
  equivalente nos dois SOs; os 17 arquivos do daemon "sem SPEC" (SPEC-07 §6) estão ligados a uma
  tarefa; 100% do corpus de F0-13 passando.
- **Depende:** F3-10, F4-09, F5-13, F6-19.
- **Agente:** test-engineer · **Área:** `native/tests/`.

#### F9-06 — Prova real final
- **Entrega:** registro em `docs/19-status-reescrita-c.md`.
- **Aceite:** com **autorização explícita do dono**, o app instalado pelo instalador/AppImage de F8-07,
  num home isolado: smoke por agente disponível, UI exercitada nas 7 abas, atualização aplicada.
- **Depende:** F8-07, F9-05.
- **Agente:** test-engineer · **Área:** nenhuma de código.

#### F9-07 — Auditoria de segurança final
- **Entrega:** relatório contra o modelo de ameaça do `SECURITY.md`.
- **Aceite:** toda garantia do `SECURITY.md` vale no C (guarda de borda, token, gate, segredos, cofre,
  atualização); cada SEC-R da tabela do §3.1 tem evidência ou a pendência que a bloqueia; SEC-R41
  (`SECURITY.md` do C republicado com M18 e as novas premissas); achados críticos corrigidos.
- **Decisões (ADR 09):** DA-29: adotar todos os endurecimentos listados.
- **Depende:** F7-06, F8-08, F9-05.
- **Agente:** security-auditor · **Área:** nenhuma de código.

#### F9-08 — Corte do TS
- **Entrega:** documentação de instalação e uso apontando o app em C (`docs/13-instalacao.md`,
  `docs/14-primeiros-passos.md`, `README`, `CONTRIBUTING.md`) e o que mais DA-17 decidir.
- **Aceite:** o TS continua no repositório como referência (ADR 7.10); o que deixa de ser distribuído
  ou testado no CI segue DA-17.
- **Decisões (ADR 09):** DA-17: parar de distribuir o tarball e tirar o TS do CI depois da F9; o código fica no repositório.
- **Depende:** F9-02, F9-03, F9-04, F9-06, F9-07.
- **Agente:** docs-writer · **Área:** os documentos citados.

**Paralelo na F9:** F9-01 → {F9-02, F9-03, F9-04} ∥ F9-05 → F9-06; F9-07; F9-08 fecha.

---

## 2. Divergências do TS: reproduzir ou corrigir

Cada item foi registrado em uma SPEC como divergência, ponto NÃO DETERMINADO ou observação que exige
escolha. **O dono decidiu a rodada 1 no [ADR 09](decisoes/09-rodada-1-divergencias-e-decisoes.md)**
(recomendações em `docs/propostas/decisoes-rodada-1.md`, commit `89ca3e0`). A coluna "Decisão" traz o
que vale; a coluna "Tarefas" mostra onde a decisão entra (linha **Decisões (ADR 09)** de cada tarefa).
Para o que segue aberto vale a regra antiga: a tarefa pode ser implementada, mas o comportamento fica
isolado e coberto por um teste que cita o ID, e a tarefa fica `[~]` até a decisão.

| ID | Divergência | Fonte | Tarefas | Decisão |
|---|---|---|---|---|
| DV-01 | Timeouts de socket HTTP (`keepAliveTimeout`, `requestTimeout`, `headersTimeout`, `maxHeaderSize`) não definidos no TS, que usa os padrões do Node; quais valores o C adota. É a mesma divergência que SPEC-08 D8 (H2/H3; SEC-R08, SEC-R10), e inclui a lacuna de H3: trocar o poll de 500 ms do gate por evento esbarra na razão de `daemon/src/session-manager.ts:1033-1035` (SEC-R09) | SPEC-01 §1, §10; SPEC-08 D8, H3 | aceite de F1-15, F2-14 | decidida — ADR 09: definir timeouts explícitos, com os valores da SPEC-08 H3 como ponto de partida, medidos na F1 |
| DV-02 | `GET /events` ignora `Last-Event-ID`; a retomada é por `?since=` | SPEC-01 §8.2 | aceite de F1-16 | decidida — ADR 09: aceitar `Last-Event-ID` em `GET /events`, além de `?since=` |
| DV-03 | `POST /sessions/:id/cancel` engole qualquer erro de leitura e validação do corpo, inclusive 413 e JSON inválido. É a SPEC-08 D12 (recomenda manter a resposta, com teto e descarte no leitor) | SPEC-01 §6.4 linha 36, §10; SPEC-08 D12 | aceite de F1-19, F4-04 | decidida — ADR 09: manter a resposta do `cancel`, com teto e descarte no leitor do corpo (SPEC-08 D12) |
| DV-04 | `sessionId`/`rootId` sem validação de formato em `GET /sessions`, `GET /approvals` e `GET /events`; resposta a texto arbitrário em `/sessions` e `/approvals` não verificada. É a SPEC-08 D11 | SPEC-01 §10; SPEC-08 D11 | aceite de F1-16, F1-19, F4-04, F4-05 | decidida — ADR 09: validar o formato de `sessionId`/`rootId`; formato inválido = inexistente |
| DV-05 | `/api/descriptor.json` declara `authentication.mode: "none"` embora existam 13 rotas de operador | SPEC-01 §10 | aceite de F4-02 | decidida — ADR 09: corrigir o descritor (ele descreve só `/api/tasks/*`) |
| DV-06 | `process.cwd()` do daemon como projeto implícito em `POST /api/tasks` e `POST /sessions/adopt` | SPEC-01 §6.2, §10 | aceite de F4-02, F4-04 | decidida — ADR 09: manter o diretório do daemon como projeto implícito (paridade de contrato) |
| DV-07 | Reservas de orçamento zeradas ao recriar o ledger (depois de reiniciar o daemon, as fatias de tasks em andamento não voltam), embora `reserved_json` seja gravado | SPEC-04 A8, obs. 2; SPEC-02 §3.8 | aceite de F2-12 | decidida — ADR 09: restaurar as reservas (`reserved_json`) ao recriar o ledger no reinício |
| DV-08 | `intersect` pai → filho herda do filho `defaultBudget`, `retries` e `fallback`, sem `min` | SPEC-04 A5, obs. 5 | aceite de F2-04, F2-11 | decidida — ADR 09: interseção pai → filho com mínimo também em `defaultBudget`, `retries` e `fallback` |
| DV-09 | `-S` dos conjuntos de `cp`/`mv`/`ln` nunca casa, porque a flag é comparada em minúsculas | SPEC-04 A6 (observação em "Flags que recebem valor") | aceite de F2-03 | decidida — ADR 09: reconhecer `-S` de `cp`/`mv`/`ln` como flag com valor |
| DV-10 | `defaults.isolation` do manifesto sem efeito em `start` (o Brief já preenche `worktree`) | SPEC-04 obs. 3 | aceite de F1-18, F2-11 | decidida — ADR 09: remover o campo `defaults.isolation` do manifesto do C (motivo corrigido no adendo: o campo nunca teve efeito, e o isolamento continua escolhido no Brief, `worktree` ou `none`); compatibilidade com os manifestos atuais na DA-33 |
| DV-11 | Timeout e heartbeat da run vêm da política **global**, não da efetiva do projeto, embora o clamp do projeto aceite esses campos | SPEC-04 B9, obs. 4 | aceite de F1-18, F2-10 | decidida — ADR 09: timeout e heartbeat da run vêm da política efetiva do projeto |
| DV-12 | Estados declarados e nunca gravados: task `submitted` e `auth_required`; aprovação `expired` | SPEC-04 A3, obs. 1; SPEC-02 §4.2 | aceite de F2-11, F6-12 (rótulos "na fila"/"precisa de login"), F6-15 (rótulo "expirada") | decidida — ADR 09: manter `submitted`, `auth_required` e `expired` no esquema (banco migrado), sem gerá-los |
| DV-13 | Retry quando a reserva de vaga falha: a task vai para `failed`, e a sessão **fica `running` sem processo**, sem `endedAt`, com o `pid` da run anterior, sem `session.ended` nem liberação do worktree; só sai com `cancel` ou no reinício do daemon; nenhum teste TS cobre o ramo (levantado em F2-19) | SPEC-04 obs. 9; `docs/propostas/F2-19-dv13.md` (`daemon/src/session-manager.ts:3037-3046`) | aceite de F2-13 | decidida — ADR 09: retry sem vaga conclui a sessão como `failed`, com `session.ended` e liberação do worktree |
| DV-14 | `hub --version --json` ignora `--json` (o help promete o contrário) | SPEC-03 "Divergências" 1 | aceite de F5-02 | decidida — ADR 09: corrigir (`hub --version --json` respeita `--json`) |
| DV-15 | `hub workflow validate` e a ajuda do workflow sobem o daemon, embora a validação seja local e o comentário diga que não | SPEC-03 "Divergências" 2 | aceite de F5-11 | decidida — ADR 09: corrigir (`workflow validate` e a ajuda do workflow não sobem o serviço) |
| DV-16 | `hub doctor --json` provavelmente imprime uma linha antes do JSON (não verificado em execução) | SPEC-03 "Divergências" 3 | aceite de F5-05 | decidida — ADR 09: corrigir (`doctor --json` sai como JSON puro) |
| DV-17 | `hub logs -n 10` não funciona; só `--n` é alias | SPEC-03 "Divergências" 4 | aceite de F5-02 | decidida — ADR 09: corrigir (`hub logs -n` aceito) |
| DV-18 | O texto `instructions` do MCP cita 8 agentes; o ADR 7.8 fala em 9 (falta OpenClaude) | SPEC-03 "Divergências" 5 | aceite de F4-11 | decidida — ADR 09: corrigir o texto `instructions` do MCP para 9 agentes |
| DV-19 | `hub autostart` só existe no Windows (`.vbs`), sem equivalente Linux; `hub open` tem ramo de macOS, fora do ADR 7.2 | SPEC-03 "Divergências" 6, §1.10 | aceite de F5-12, F8-02 | decidida — ADR 09: autostart também no Linux (XDG); remover o ramo de macOS do `hub open` |
| DV-20 | `hub update` só imprime instruções; o ADR 7.13 decide a atualização automática, mas o que o comando `hub update` faz no C não está especificado | SPEC-03 "Divergências" 7, §1.11 | aceite de F5-12, F8-06 | decidida — ADR 09: `hub update` checa e aplica a atualização na hora, com confirmação |
| DV-21 | Hook e MCP gravam caminhos de Node nas configs dos agentes (`"<node>" "<bin.js>" hook`, `main.js`); no C o formato muda, e a regra de "é nosso?" (`comandoDoHub`) precisa ser redefinida; o mesmo vale para o settings por sessão e o hook inline do Codex | SPEC-03 "Divergências" 8, §1.5, §1.9; SPEC-04 B10 | aceite de F1-17, F3-01, F4-08, F5-04, F8-01 | decidida — ADR 09: novo formato apontando para o executável C, com a regra "é nosso" redefinida e migração das entradas antigas |
| DV-22 | C156: a ajuda do campo de modelo diz que ele não pode começar com `-`, mas o painel não valida (o daemon recusa com `ADAPTER_FAILURE`, SPEC-04 B4) | SPEC-05 §11 (C156) | aceite de F6-16 | decidida — ADR 09: validar na UI o modelo que começa com `-` |
| DV-23 | `home` no `config.json` muda `config.home`, mas não `dbFile`, `worktreeRoot`, `artifactRoot` e `logDir`, já derivados do home original (registrado como observação, não como divergência) | SPEC-02 §6.1 | aceite de F1-07 | decidida — ADR 09: tudo deriva do home efetivo (inclusive `dbFile`, `worktreeRoot`, `artifactRoot`, `logDir`) |
| DV-24 | A ajuda não cita `--json` em `import` e `restore`, embora os dois aceitem | SPEC-03 §1.4 | aceite de F5-01 | decidida — ADR 09: corrigir (a ajuda cita `--json` de `import` e `restore`) |
| DV-25 | Ponto NÃO DETERMINADO de SPEC-04 obs. 8 (como o hook do Claude identifica a sessão): SPEC-01 §9 e SPEC-03 §1.5 descrevem `--session`/`AGENTS_HUB_SESSION_ID` e a busca por `nativeSessionId`/`cwd`; confirmar em F2-14 que isso fecha o ponto | SPEC-04 obs. 8; SPEC-01 §9; SPEC-03 §1.5 | aceite de F2-14 | **aberta** (confirmação em F2-14, não é decisão) |
| DV-26 | `hub help` cria `logs/`, `artifacts/` e `worktrees/` no home (efeito colateral observado) | SPEC-03 §1.3 | aceite de F5-01 | decidida — ADR 09: corrigir (`hub help` não cria pastas) |
| DV-27 | Passo em `input_required`: o `hub_workflow_run` do MCP termina na hora como `blocked`; o `hub workflow run` da CLI espera a aprovação | SPEC-03 §2.7 item 16 | aceite de F4-13, F5-11 | decidida — ADR 09: manter (MCP termina `blocked`; CLI espera a aprovação) |
| DV-28 | `Origin` da própria porta é aceito (o painel era servido lá); sem painel no C, a SPEC-08 recomenda recusar todo `Origin` e todo `Sec-Fetch-Site` ≠ `none` em método que muda estado (muda o contrato HTTP, ADR 7.6) | SPEC-08 D2, H5; SPEC-01 §3 | aceite de F1-15 | decidida — ADR 09: recusar todo `Origin` e todo `Sec-Fetch-Site` ≠ `none` em método que muda estado |
| DV-29 | `host` arbitrário aceito no `config.json`; recomendação: recusar host não loopback (SEC-R11) | SPEC-08 D3, H8; SPEC-01 §1 | aceite de F1-07 | decidida — ADR 09: recusar `host` não loopback no `config.json` (`HUB_CONFIG_INVALID`) |
| DV-30 | Rotas abertas aceitam qualquer processo local, inclusive de outro usuário do SO; recomendação: conferir o dono da conexão (SEC-R12) | SPEC-08 D4, H7 | aceite de F0-09, F1-15 | decidida — ADR 09: conferir que quem conecta é o mesmo usuário do SO; outro usuário → 403 |
| DV-31 | O cliente manda o token para o que estiver na porta; recomendação: conferir o dono do socket antes e usar `SO_EXCLUSIVEADDRUSE` (SEC-R13, SEC-R14) | SPEC-08 D5, H6 | aceite de F0-09, F1-20 | decidida — ADR 09: o cliente confere o dono do socket antes de mandar o token; `SO_EXCLUSIVEADDRUSE` no Windows |
| DV-32 | ACL do token por `icacls` chamado por nome, principal de `USERDOMAIN`, token existente sem reconferência, falha só gera aviso; recomendação: DACL por SID, conferida a cada subida (SEC-R15) | SPEC-08 D6; SPEC-01 §4 | aceite de F0-05, F1-07 | decidida — ADR 09: DACL por SID na criação do token, reconferida a cada subida |
| DV-33 | Pasta e banco criados sem modo explícito (0755 com `umask 022`); recomendação: 0700/0600 e `umask(077)` (SEC-R16) | SPEC-08 D7, V5 | aceite de F0-05, F1-07, F1-08 | decidida — ADR 09: pasta 0700, arquivos 0600, `umask(077)` |
| DV-34 | Texto do agente impresso cru no terminal (sequências ANSI/OSC); recomendação: sanear C0/C1/ESC (SEC-R32) | SPEC-08 D9, U3 | aceite de F1-21, F5-07 | decidida — ADR 09: sanear C0/C1/ESC do texto do agente no terminal |
| DV-35 | Env em texto puro sem `secure_delete`; a retenção só devolve páginas inteiramente livres; o env antigo fica em páginas, no `-wal` e nos backups; recomendação para a migração: `secure_delete` + checkpoint + `VACUUM` e aviso sobre backups (SEC-R24) | SPEC-08 D10, V4 | aceite de F7-02, F7-05 | decidida — ADR 09: limpar o env antigo na migração (`secure_delete` → `VACUUM` → checkpoint), detalhe na proposta F7-01 |
| DV-36 | Caminhos sensíveis sem a pasta de instalação nem os locais de autostart; `reg add` em `Run` não é `irreversible`; recomendação: acrescentar à lista embutida (SEC-R39) | SPEC-08 D13, G4 | aceite de F1-05, F2-02 | decidida — ADR 09: pasta de instalação e locais de autostart na lista de caminhos sensíveis; `reg add …\Run` = `irreversible` |
| DV-37 | Árvore de processos no Windows por `taskkill /T /F` (PPID, sujeito a reciclagem de PID); a recomendação de Job Object por sessão conflita com o aceite literal de SPEC-04 B6 (SEC-R29) | SPEC-08 D14, P5; SPEC-04 B6 | aceite de F0-08 | decidida — ADR 09: Job Object por sessão no Windows, em vez de `taskkill /T` |
| DV-38 | Cabeçalho repetido vale pelo primeiro valor (inclusive `Host` e `Content-Length`) e "tem corpo" é decidido pela presença de CL/TE; recomendação: 400 para CL repetido/não decimal/> 2^53, TE ≠ `chunked` ou junto de CL, `Host` repetido (SEC-R06; muda o contrato HTTP) | SPEC-08 D16, H1 | aceite de F1-15 | decidida — ADR 09: 400 para `Content-Length` repetido, não decimal ou > 2^53, `Transfer-Encoding` ≠ `chunked` ou junto de CL, `Host` repetido |
| DV-39 | Limites de linha de pedido e de cabeçalhos não definidos; recomendação: 414 e 431 próprios (SEC-R07; muda o contrato HTTP) | SPEC-08 D17, H2 | aceite de F1-15 | decidida — ADR 09: 414 para linha de pedido > 8 KiB; 431 para cabeçalhos > 16 KiB ou > 64 |
| DV-40 | `Host` aceito só pela comparação do nome; recomendação: recusar caractere fora de `[A-Za-z0-9.:\[\]-]`, além da paridade M2 (SEC-R05; muda o contrato HTTP) | SPEC-08 D18, H4 | aceite de F1-15 | decidida — ADR 09: `Host` só com caracteres de `[A-Za-z0-9.:\[\]-]`, além da paridade M2 |
| DV-41 | O valor de `-t`/`--target-directory` de `cp`/`mv`/`ln` é consumido e não entra como alvo de escrita (`mv -t /etc a` → `write`); observado na geração do corpus, não registrado na SPEC, **a confirmar** | `native/tests/conformance/classifier/README.md` (item 2); `core/src/command-classifier.ts:1427` | aceite de F2-03 | decidida — ADR 09: `-t`/`--target-directory` entra como alvo de escrita (escrita fora do worktree vira `escalate`) |
| DV-42 | Cortes por unidade UTF-16 (não por caractere nem byte): `tool_result` com teto de 4.000 parte emoji e deixa surrogate isolado; o teto de 200 do modelo e o `motivoDaFalha` também contam UTF-16 | `native/tests/conformance/mappers/README.md` (item 1) | aceite de F1-13, F1-14, F3-03 | decidida — ADR 09: cortar em fronteira de code point UTF-8, mesmo teto |
| DV-43 | Prompt vazio em argv some junto com o argumento e deixa `-p` sem valor (antigravity fica com `-p=`); `nativeSessionId` `""` escolhe `resumeModeArgs` e some do argv | `native/tests/conformance/mappers/README.md` (item 6) | aceite de F1-13, F3-02, F3-03, F3-04 | decidida — ADR 09: recusar prompt vazio antes do spawn |
| DV-44 | O construtor do `BudgetLedger` não saneia `limits`: limite `NaN` dá `pressure` NaN e nunca esgota (o `setLimits` saneia). O `domain/README.md` (linhas 161-165) o classifica como "comportamento de borda, sem marca de divergência" | `native/tests/conformance/domain/README.md:161-165` | F1-06 | decidida — ADR 09: sanear `limits` no construtor como o `setLimits` |
| DV-45 | Demais comportamentos codificados no corpus de mappers como "reproduzir ou decisão explícita": exceção no mapper vira `log … unparsed`; array JSON tratado como objeto; ramo string do `generic-json` inalcançável; `trim()` do JS antes do `{`; SSE do OpenCode fora da especificação (`\r\n` por chunk, `\r` solto, `trimStart`); `text()` aceita `""`; `"cost":{}` fecha o turno | `native/tests/conformance/mappers/README.md` (itens 2–5, 7–9) | aceite de F1-14, F3-02, F3-05, F3-07 | decidida — ADR 09: reproduzir as tolerâncias dos mappers |
| DV-46 | `GET /projects/:id/context` é rota aberta e devolve o env por agente (chaves de API) sem token; outro usuário do SO o lê (achado S6) | `docs/propostas/F7-01-migracao-e-cofre.md` (S6); `packages/daemon/src/server.ts:597-603`; SPEC-01 §6.3 linha 17 | F4-03 (e SEC-R12) | decidida — ADR 09: sem token, `GET /projects/:id/context` devolve só os nomes das variáveis; com token, os valores |

Equivalências com a SPEC-08 §4, sem duplicar: D1 ↔ DA-15; D8 = DV-01; D11 = DV-04; D12 = DV-03;
D15 ↔ DA-06; as demais (D2–D7, D9, D10, D13, D14, D16–D18) são DV-28 a DV-40. Confirmado, sem
pendência: o limite `0` de orçamento é bloqueio (nasce `exhausted`), o que fecha o NÃO DETERMINADO de
SPEC-02 §3.8 (SPEC-04 A8 e corpus `domain/`; ver F1-06).

Divergências do painel que a SPEC-05 já converte em requisito, sem pendência: K2 (gaveta aberta tira o
fundo da ordem de foco) e K3 (contador "Todos"), SPEC-05 §15, aplicados em F6-03 e F6-09. K1 e K4
estão em §3 (DA-10 e DA-08). Sobre K4 havia duas leituras (requisito pela SPEC-05 §15 via ADR 7.10, ou
requisito novo frente à paridade do ADR 7.4); o ADR 09 (9.4) decidiu: markdown entra **depois da
paridade** (backlog PP-01, §7).

---

## 3. Decisões do plano (decididas no ADR 09, salvo as marcadas abertas)

Perguntas que os ADRs 07 e 08 deixaram em aberto. A coluna "Tarefas" diz onde cada uma entra; a coluna
"Decisão" traz a resposta do [ADR 09](decisoes/09-rodada-1-divergencias-e-decisoes.md) ou **aberta**.
Só as abertas seguem bloqueando aceite.

| ID | Decisão (pergunta) | Fonte | Tarefas | Decisão |
|---|---|---|---|---|
| DA-01 | Cofre de segredos no Linux sem keyring (Secret Service ausente): política | ADR 08 "Em aberto" | início de F7-04; aceite de F5-05 (SEC-R25) | decidida — ADR 09: opção 1 da F7-01: arquivo 0600 em pasta 0700, com aviso permanente |
| DA-02 | Formato da referência ao segredo no banco, nome das entradas no cofre e destino de `memory`/`prompts` (que não são segredo) | SPEC-02 §5; ADR 7.16 | início de F7-03, F7-04; F7-05 | decidida — ADR 09: tabela própria no banco (R-C) com nome opaco (N-D); no Windows, DPAPI em arquivo (W-B), sem o teto de 2560 bytes |
| DA-03 | Desenho da migração do banco na primeira execução (ADR 7.15): in-place ou cópia, se o C cria migração 11, tratamento dos fatos de SPEC-02 §10 | SPEC-02 §10 ("o desenho da migração não está decidido") | início de F7-02; aceite de F7-05 | decidida — ADR 09: cópia de segurança antes e migração no lugar (M-C), com o TS parado e a porta presa; marca dentro do banco (migração 11) |
| DA-04 | Esquema da chave e do manifesto de atualização (proposta do ADR 08: Ed25519 + SHA-512, fonte em `/releases/latest/download/`), incluindo onde fica a chave privada e se há anti-rollback/expiração (SPEC-08 A1–A3, L3; SEC-R17 a SEC-R22, SEC-R40); proposta em `docs/propostas/F8-04-chave-e-manifesto-de-atualizacao.md` | ADR 07 "Em aberto" (atualização); ADR 08 "Consequências técnicas propostas"; SPEC-08 §2a | início de F8-05; aceite de F5-05 (SEC-R18, SEC-R40), F8-06, F8-07, F8-08 | decidida — ADR 09: envelope único; Ed25519 puro; Windows troca os binários com rollback (W2); chave diária local cifrada (O2) e a de recuperação em mídia separada; revogação só pela chave de recuperação; expiração de 30 dias |
| DA-05 | Procedimento de medição das metas (proposta da SPEC-06: mediana de pelo menos 5 execuções, mesma máquina, serviço isolado) | ADR 08 "Em aberto"; SPEC-06 "Como as metas serão conferidas" | início de F9-01; F9-02, F9-03, F9-04 | decidida — ADR 09: procedimento da proposta F0-15 (mediana de ≥ 5, mesma máquina, harness do C em `native/tests/bench/c/`) |
| DA-06 | Identidade da janela nativa perante o serviço: como apresenta o token e o que aparece em `by`/"decidida por" na auditoria (o painel usa cookie e vira `web`). A SPEC-08 D15/U1 propõe `X-Hub-Client: ui` → `ui:<usuário>` | SPEC-05 §16; SPEC-01 §4; SPEC-08 D15, U1 | aceite de F6-05, F6-08, F6-13, F6-14, F6-15 | decidida — ADR 09: Bearer + `X-Hub-Client: ui` → `ui:<usuário>` |
| DA-07 | Recursos do navegador sem equivalente: confirmações `window.confirm` e `beforeunload` (e "fechar com edição não salva" sob o ADR 7.5); persistência da escolha de tema; condição "janela em segundo plano" da notificação; seletor de arquivo, área de transferência e download | SPEC-05 §16 | F6-01, F6-03, F6-08, F6-12, F6-15, F6-16 | decidida — ADR 09: diálogos nativos de confirmação; tema salvo no `config.json`; notificação do SO quando a janela está oculta; seletor de pasta nativo. O restante foi decidido no adendo 2: área de transferência do SO (C074), diálogo nativo de abrir arquivo (C083) e diálogo nativo de salvar no lugar do download (C140) |
| DA-08 | Markdown nas mensagens do agente (K4). Havia duas leituras: (a) requisito, porque a SPEC-05 §15 lista K4 entre as pendências do TS que viram requisito (ADR 7.10); (b) requisito novo, porque o painel atual mostra texto cru e a paridade do ADR 7.4 é essa. Quais elementos e em quais tipos de evento (`message`? `reasoning`?) é NÃO DETERMINADO na SPEC-05. A SPEC-08 U3 propõe sem HTML, sem imagem remota e com link só após confirmação | SPEC-05 §3.6, §15 (K4); SPEC-08 U3 | aceite de F6-06 (só a parte nova) | decidida — ADR 09: depois da paridade (backlog PP-01, §7); a primeira versão mostra texto cru |
| DA-09 | Grafo DAG: a SPEC-05 §7 descreve a árvore indentada com marcadores `↳`/`⇄`, e é isso que a paridade do ADR 7.4 exige; desenhar arestas gráficas seria requisito novo, que só o dono decide. Trava só a parte nova da F6-11 | SPEC-05 §7; ADR 7.4 | aceite de F6-11 (só a parte nova) | decidida — ADR 09: depois da paridade (backlog PP-02, §7); a primeira versão é a árvore indentada |
| DA-10 | Ícone de janela, bandeja e instalador (K1: o painel não declara ícone; o nativo não está especificado) | SPEC-05 §15 (K1) | aceite de F6-18, F8-02, F8-03 | decidida — ADR 09: ícone próprio encomendado; até lá, um provisório gerado |
| DA-11 | Propostas técnicas do ADR 08 ainda não confirmadas: C17 sem VLA e sem `<stdatomic.h>` no MSVC; versão mínima do CMake entre 3.21 e 3.31; laço de UI só sob evento (`SDL_WaitEvent`); AppImage com linuxdeploy + appimagetool | ADR 08 "Consequências técnicas propostas" | aceite de F0-01, F0-04, F0-09, F6-01, F8-03 | decidida — ADR 09: confirmadas (C17 sem VLA/`stdatomic`, CMake ≥ 3.22, UI só sob evento, linuxdeploy + appimagetool) |
| DA-12 | Shaping com HarfBuzz pelo SDL_ttf e emoji colorido com plutosvg: confirmar no primeiro protótipo | ADR 08 "Em aberto" | aceite de F0-12, F6-01 (evidência vem de F0-14) | decidida — ADR 09: HarfBuzz sim (vem com o SDL_ttf); emoji colorido COLR sem plutosvg no Windows. **Linux segue aberto** (plutosvg e tray sem appindicator) |
| DA-13 | Proxy corporativo no WinHTTP e caminho dos certificados da libcurl dentro do AppImage (não verificados) | ADR 08 "Em aberto" | aceite de F8-03, F8-06 | decidida — ADR 09: proxy do sistema (WinHTTP); CA do sistema no Linux. **Segue aberto: verificar na F8** |
| DA-14 | Arquitetura de processos da janela, da bandeja e do serviço: o ADR 7.5 diz que fechar a janela não encerra o serviço, mas nenhum ADR diz se a UI e o serviço são o mesmo processo; disso dependem os executáveis, o autostart e o instalador. Também depende disto a PROPOSTA de a UI usar o `native/src/client/` por HTTP (introdução da F6), já que o ADR 7.6 não cita a UI; a SPEC-08 U4 trata de um eventual canal janela ↔ bandeja | ADR 7.5, 7.6 (lacuna); SPEC-08 U4 | F0-01, F1-21, F4-10, F5-02, F5-12, F6-01, F6-18, F8-01, F8-02 | decidida — ADR 09: serviço `agents-hubd` (sobe no login, sem janela); janela e bandeja em `agents-hub`, cliente da mesma API HTTP; CLI `hub`, com MCP e hook como subcomandos |
| DA-15 | `GET` sem rota no C: a SPEC-01 §7 descreve o painel estático e o cookie `hub_operator`, que o ADR 7.3 substitui pela janela; o que o serviço C responde (404 JSON?) e se o cookie deixa de existir. A SPEC-08 D1/U2 recomenda não implementar cookie nem arquivos estáticos (SEC-R03) | SPEC-01 §4 (cookie), §7; ADR 7.3; SPEC-08 D1, U2 | aceite de F4-01 | decidida — ADR 09: `GET` sem rota → 404 JSON; sem cookie e sem arquivos estáticos |
| DA-16 | MCP: o texto exato do erro de validação de entrada é montado pelo SDK (NÃO DETERMINADO); a versão do protocolo MCP negociada pelo SDK também não está na SPEC | SPEC-03 §2.6 | aceite de F4-10, F4-13 | decidida — ADR 09: texto de erro próprio; versão do protocolo igual à negociada pelo SDK TS na data |
| DA-17 | O que significa "corte do TS": o ADR 7.10 mantém o TS no repositório; falta decidir o que deixa de ser distribuído (tarball `npm i -g`, docs/13) e testado no CI | ADR 7.10; ADR 07 "Contexto" | início de F9-08 | decidida — ADR 09: parar de distribuir o tarball e tirar o TS do CI depois da F9; o código fica no repositório |
| DA-18 | Acesso remoto ao daemon | ADR 07 "Em aberto" | nenhuma tarefa (fora do escopo deste plano) | **aberta** (fora do escopo) |
| DA-19 | Premissa de repositório público para o download anônimo das Releases; se ele virar privado, o ADR 7.13 precisa ser revisto | ADR 07 "Em aberto" | aceite de F8-06 | decidida — ADR 09: manter o repositório público |
| DA-20 | Equivalentes no C dos comportamentos ligados a Node e ao painel web na CLI: reexecução com `--experimental-sqlite` e piso de versão do Node (SPEC-03 §1.1, passos 2 e 4); linha `node <ver>` do `hub version`; checagem de Node no passo 1 do `hub init`; `hub open` (abre o navegador no painel, que deixa de existir); linha `painel: <url>` do `hub daemon` | SPEC-03 §1.1, §1.8, §1.12; ADR 7.3 | aceite de F5-02, F5-12 | decidida — ADR 09: remover os comportamentos ligados a Node (sem Node no produto) |
| DA-21 | `isolation: container` saiu (ADR 7.17), mas o valor ainda aparece: enum do Brief (SPEC-04 A4), `CreateTaskSchema` da API (SPEC-01 §6.9), `defaults.isolation` do manifesto (SPEC-04 B2; tratado pela DA-33), linhas antigas de `sessions.isolation` no banco (SPEC-02 §3.3) e `hub start --isolation container`, que hoje responde "ainda não está implementado" (SPEC-03 §1.8; SPEC-07 §4.B, `cli/src/start-cmd.test.ts:57-59`). Como o C recusa (código e mensagem) e como lê linhas antigas | ADR 7.17; fontes ao lado | aceite de F1-03, F1-08, F1-18, F1-21, F4-02, F5-07, F7-02 | decidida — ADR 09: recusar `container` com erro claro na entrada; ler linhas antigas como estão |
| DA-22 | Leitura e escrita de TOML e JSONC: o ADR 08 não traz biblioteca para eles, e o `docs/18-padroes-c.md` §14 exige decisão do dono para qualquer biblioteca fora da lista; o TS relê o TOML gerado e aceita JSONC (SPEC-03 §1.9) | SPEC-08 L1; `docs/18-padroes-c.md` §14; SPEC-03 §1.9 | aceite de F3-09, F4-08, F5-04 | decidida — ADR 09: leitor e gravador mínimos próprios, só para as chaves que o Hub edita, com teste de ida e volta |
| DA-23 | Mensagens geradas pelo zod no TS: texto e caminho de `details.issues` dos 422 `INVALID_BRIEF` (ex.: caminho `steps.0.objective` na validação de workflow; mensagens em inglês do zod 3.25.76 no Brief). Reproduzir o texto, só o caminho, ou nenhum dos dois. O caso do MCP fica em DA-16 | SPEC-07 §4.A; SPEC-01 §2; `native/tests/conformance/domain/README.md` | aceite de F1-03, F1-15, F2-07, F4-07 | decidida — ADR 09: reproduzir só o código e o caminho do campo; texto próprio em pt-BR |
| DA-24 | Framework de teste do C (não está no ADR 08); o esqueleto usa uma macro `CHECK` sem framework (`native/tests/unit/test_smoke.c`) | `docs/18-padroes-c.md` §12 | aceite de F0-01, F0-11 | decidida — ADR 09: manter a macro de teste própria do esqueleto |
| DA-25 | Dependências transitivas: FreeType do SDL_ttf (HarfBuzz e plutosvg estão em DA-12); biblioteca TLS da libcurl; libcurl vendorizada ou do sistema | `docs/18-padroes-c.md` §14; ADR 8.11 | aceite de F0-12, F8-03, F8-06 | decidida — ADR 09: FreeType e HarfBuzz vendorizados com o SDL_ttf; libcurl do sistema no Linux, empacotada no AppImage |
| DA-26 | Fuzzing FZ01–FZ15 (curto por PR e longo noturno), sanitizers também no Linux e flags de endurecimento do release; nenhuma tarefa os implementa antes da decisão | SPEC-08 C4; SEC-R34, SEC-R35 | aceite de F0-02 (parte de fuzzing e endurecimento) | decidida — ADR 09: adotar: fuzz curto no PR e longo noturno; flags de endurecimento no release |
| DA-27 | Ordem F3 antes de F6: o ADR 7.18 diz "depois UI, os demais adapters, o instalador e a atualização"; o plano põe os adapters antes das telas porque estas dependem da F4 (ver a introdução da F3) | ADR 7.18 | nenhuma tarefa (confirmação da ordem) | decidida — ADR 09: confirmada a ordem do plano (F3 antes da F6) |
| DA-28 | O que a desinstalação faz com os dados do usuário (`~/.agents-hub`, autostart, configs dos CLIs alteradas por `--write`); PROPOSTA de F8-02: não apagar o home | ADR 7.12, 8.12 (lacuna); SPEC-08 G2 (remover o `Run`) | aceite de F8-02 | decidida — ADR 09: não apagar `~/.agents-hub`; remover o autostart; oferecer remover os hooks gravados |
| DA-29 | Adoção das PROPOSTAS de endurecimento da SPEC-08 que não mudam o contrato e não têm D próprio: P1–P4, P6, P7 (spawn, handles, ambiente, DLL), C2/C3 (tetos de YAML e PCRE2), U3 (aprovação mostra a ação inteira), G1–G3 (AppImage e autostart), A6 (integridade instalada) e as premissas novas do `SECURITY.md` (V2, A6, A1). Bloqueia só os critérios SEC-R marcados PROPOSTA nas tarefas, não o resto do aceite | SPEC-08 §2, §3 | aceite de F0-07, F0-10, F1-12, F1-22, F5-05, F5-10, F5-12, F6-08, F7-05, F8-02, F8-03, F8-08, F9-07 | decidida — ADR 09: adotar todos os endurecimentos listados |
| DA-30 | Onde guardar a variante POSIX do corpus de conformidade do classificador (o corpus atual fixa home e caminhos de uma plataforma) | ADR 09 "Continua em aberto"; `native/tests/conformance/classifier/README.md` | aceite de F0-13 | **aberta** |
| DA-31 | Nome do subcomando que roda o MCP server no `hub` (`hub mcp` já é o comando de configuração, SPEC-03 §1.8) e o que `hub daemon` faz com o serviço separado `agents-hubd` | ADR 09, 9.1 e adendo; SPEC-03 §1.8 | F4-10, F5-02, F8-01 | decidida — ADR 09 (adendo): o MCP por stdio é `hub mcp serve` (o `hub mcp` continua listando e instalando a configuração); `hub daemon` executa o `agents-hubd` instalado em primeiro plano; o autostart sob demanda sobe o `agents-hubd` em segundo plano |
| DA-32 | O que `hub open` faz no C: a DA-20 decide "remover" os comportamentos ligados a Node e ao painel web (o `hub open` abre o painel no navegador), e a DV-19 decide "remover só o ramo de macOS" do `hub open`; as duas leituras se contradizem | ADR 09 (DA-20, DV-19); SPEC-03 §1.8 | F5-12 | decidida — ADR 09 (adendo 2): `hub open` abre ou traz para frente a janela `agents-hub`, iniciando o serviço se preciso |
| DA-33 | Compatibilidade da remoção de `defaults.isolation` (DV-10) com os 9 manifestos atuais (todos declaram `defaults.isolation: worktree`, SPEC-04 B2) e com manifestos de usuário em `<home>/manifests/` (SPEC-02 §6): ignorar o campo, recusar o manifesto ou mudar os manifestos | ADR 09 (DV-10); SPEC-04 B2; SPEC-02 §6 | F1-11, F8-01 | decidida — ADR 09 (adendo 2): o schema de manifesto do C aceita `defaults.isolation` com aviso de obsoleto e não o usa; os manifestos empacotados são limpos; manifestos de usuário continuam válidos |

### 3.1 Requisitos de segurança da SPEC-08 ligados às tarefas

Cada SEC-R da SPEC-08 §3 aponta a tarefa que o prova e a pendência que decide se ele vale (quase todos
nascem de uma PROPOSTA da SPEC-08, e nenhum está decidido). Conferido um a um contra o texto da SPEC-08.
F8-04 é uma proposta para o dono decidir DA-04: aparece nas linhas porque propõe a opção, e não tem
aceite bloqueado por elas (o bloqueio fica nas tarefas que implementam ou auditam). **Com o ADR 09
(9.2), todas as pendências desta tabela estão decididas como "corrigir/adotar", exceto DA-13 (R21,
verificar na F8)**: os SEC-R passam a ser critério de aceite das tarefas listadas.

| SEC-R | Requisito (resumo) | Tarefas | Pendência |
|---|---|---|---|
| R01 | Paridade das garantias M1–M18 | F0-13, F4-09 | — |
| R02 | 13 rotas de operador exigem token antes do corpo | F4-09 | — |
| R03 | Sem cookie e sem painel estático | F4-01 | DA-15 (D1) |
| R04 | CSRF sem origem legítima | F1-15 | DV-28 (D2) |
| R05 | DNS rebinding (paridade M2 + `Host` estrito) | F1-15 | DV-40 (D18) para a parte nova |
| R06 | Ambiguidade de corpo | F1-15 | DV-38 (D16) |
| R07 | Limites de cabeçalho (414/431) | F1-15 | DV-39 (D17) |
| R08 | Timeouts definidos | F1-15 | DV-01 (D8) |
| R09 | Gate não esgota o servidor | F1-15, F2-14 | DV-01 (lacuna de H3) |
| R10 | Teto global de conexões | F1-15 | DV-01 |
| R11 | Só loopback | F1-07 | DV-29 (D3) |
| R12 | Dono da conexão (servidor); rota de contexto sem token não expõe o env (S6) | F0-09, F1-15, F4-03 | DV-30 (D4), DV-46 (S6) |
| R13 | Cliente não entrega token a impostor | F1-20 | DV-31 (D5) |
| R14 | `SO_EXCLUSIVEADDRUSE` | F0-09 | DV-31 (D5) |
| R15 | Token restrito por SID | F0-05, F1-07 | DV-32 (D6) |
| R16 | Pasta e arquivos privados | F0-05, F1-07, F1-08 | DV-33 (D7) |
| R17 | Manifesto de atualização assinado | F8-04, F8-06, F8-08 | DA-04 |
| R18 | Anti-rollback e expiração | F8-04, F8-06, F8-08, F5-05 (aviso no `hub doctor`) | DA-04 |
| R19 | Verificar e instalar os mesmos bytes | F8-06 | DA-04 |
| R20 | Troca do binário com rollback | F8-06, F8-07 | DA-04 |
| R21 | Canal de download (TLS, redirect, teto) | F8-06 | DA-04, DA-13 |
| R22 | Chave privada fora do repositório | F8-04, F8-05 | DA-04 |
| R23 | Cofre sem truncar | F7-03 | DA-02 |
| R24 | Migração do env sem resíduo | F7-02, F7-05 | DA-03, DV-35 (D10) |
| R25 | Linux sem Secret Service | F7-04, F5-05 (estado no `hub doctor`) | DA-01 |
| R26 | Busca de executável sem cwd | F0-07, F1-12 | DA-29 (P1) |
| R27 | `.bat`/`.cmd` só pelo caminho explícito | F1-12 | DA-29 (P2) |
| R28 | Sem herança de handles | F0-07 | DA-29 (P4) |
| R29 | Árvore morta de verdade | F0-08 | DV-37 (D14) |
| R30 | Ambiente limpo sob AppImage | F8-03 | DA-29 (P6) |
| R31 | DLL sem diretório corrente | F1-22 | DA-29 (P7) |
| R32 | Saída de terminal saneada | F1-21, F5-07 | DV-34 (D9) |
| R33 | Aprovação mostra a ação inteira | F5-10, F6-08 | DA-29 (U3) |
| R34 | Fuzzing contínuo | F0-02 | DA-26 |
| R35 | Sanitizers e endurecimento | F0-02 | DA-26 |
| R36 | YAML com tetos | F0-10 | DA-29 (C2) |
| R37 | PCRE2 com limites | F0-10 | DA-29 (C3) |
| R38 | Autostart seguro | F5-12, F8-02 | DA-29 (G2/G3), DV-19 |
| R39 | Locais de persistência sensíveis | F1-05, F2-02 | DV-36 (D13) |
| R40 | Integridade instalada detectável | F5-05, F8-08 (F8-04 só propõe) | DA-04, DA-29 (A6) |
| R41 | `SECURITY.md` do C | F7-05, F9-07 | DA-29 (V2/A6/A1) |

---

## 4. Caminho crítico e o que dá para começar agora

**Caminho crítico até a vertical fina:** F0-01 → F0-04 → {F0-05, F0-06, F0-07, F0-09} → F0-08/F0-10 →
F1-01 → (core, store, adapters, client em paralelo) → F1-15 → F1-16 → F1-18 → F1-19 → F1-23 → F1-24.

**Estado de partida considerado (2026-09-30, segundo os commits e o `docs/19`):** F0-03 `[x]`; F0-01,
F0-02 e F0-04 parciais, com o esqueleto pronto (`008e944`); F0-13 parcial (corpus `classifier/`,
`domain/` e `mappers/` em `3fb8721`); spike F0-14 em `c8eaae0`; propostas F0-15, F2-19, F7-01 e F8-04
aprovadas (ADR 09); F4-14 em andamento. As DV/DA decididas no ADR 09 deixam de bloquear; nenhuma
decisão bloqueia mais o início de tarefa.

**Desbloqueadas agora (todas as dependências satisfeitas, tarefa ainda não começada): 8 tarefas.**

| Fase | Tarefa | Agente | Área |
|---|---|---|---|
| F0 | F0-05 — Plataforma: texto, caminhos e arquivos | c-engineer | `native/src/platform/` (fs; fragmento `fs.cmake`) |
| F0 | F0-06 — Plataforma: tempo, aleatoriedade e ambiente | c-engineer | `native/src/platform/` (tempo/aleatório/env) |
| F0 | F0-07 — Plataforma: processos | c-engineer | `native/src/platform/` (processos) |
| F0 | F0-09 — Plataforma: sockets, laço, timers, threads | c-engineer | `native/src/platform/` (rede/laço/threads) |
| F0 | F0-10 — Utilitários sem I/O (UTF-8, JSON, YAML, regex) | c-engineer | `native/src/core/` (utilitários; dona do `CMakeLists.txt` de `core/` e de `native/tests/unit/CMakeLists.txt` nesta leva) |
| F0 | F0-11 — Runner de conformidade e helper de teste | test-engineer | `native/tests/conformance/` (runner), `native/tests/integration/` (helper) |
| F0 | F0-12 — Vendorização da UI (SDL3, SDL_ttf, Clay, FreeType, HarfBuzz) | build-release-engineer | `native/third_party/` (UI) |
| F8 | F8-05 — Ferramenta de assinatura e verificação da release | build-release-engineer | `native/tools/ahsign/`, `native/src/updater/` (módulo de verificação), pipeline de release |

**Grupos que rodam em paralelo sem arquivo compartilhado:**
- **Grupo 1 (`platform/`):** F0-05, F0-06, F0-07, F0-09; cada uma é dona do seu fragmento
  (`fs.cmake`, `time.cmake`, `proc.cmake`, `net.cmake`) sobre a base comum do commit `ef81091`, sem
  arquivo compartilhado (tabela de donos, §0).
- **Grupo 2:** F0-10 (`native/src/core/`).
- **Grupo 3:** F0-11 (`native/tests/conformance/` só o runner, sem tocar nos dados da F0-13;
  `native/tests/integration/`).
- **Grupo 4:** F0-12 (`native/third_party/`, só as pastas novas de UI; a linha no
  `native/third_party/CMakeLists.txt` entra pelo coordenador).
- **Grupo 5:** F8-05 (pipeline de release e chave pública em `native/src/updater/`; nenhuma outra tarefa
  toca nisso agora).

Também seguem em andamento: o restante de F0-01, F0-02, F0-04 e F0-13, e a F4-14
(`native/tests/conformance/domain-errors/`). A F0-08 entra assim que a F0-07 fechar; a F1-01, quando
F0-06 e F0-10 fecharem.

## 5. Definição de pronto e status

### 5.1 Definição de pronto (vale para toda tarefa)

Uma tarefa só recebe `[x]` quando **todas** as linhas abaixo são verdade. Elas adaptam ao C o
critério de pronto do `CONTRIBUTING.md`:

1. **Compila do zero, sem warnings,** num checkout limpo, com MSVC, clang-cl, GCC e Clang (ADR 8.2), no
   nível de warning definido em `docs/18-padroes-c.md`.
2. **Tem teste que falha sem a mudança** (unitário, de integração ou de conformidade), cobrindo cada
   item do **Aceite**; o CTest fica verde nos quatro compiladores.
3. **Sanitizers verdes no CI:** o job clang-cl com ASan + UBSan (ADR 8.2) passa com os testes da
   tarefa.
4. **Foi exercitada fora do teste unitário**, contra o binário real com serviço isolado (regra de §0).
   Onde não foi, a tarefa recebe 🕳️, nunca `[x]`.
5. **Tem consumidor:** a função, a rota ou o comando é usado por quem a SPEC diz que usa. Sem
   consumidor ainda, a tarefa é `[~]` e a frase diz o que falta.
6. **Nenhuma pendência bloqueia o aceite:** com DV ou DA aberta no campo "Depende", a tarefa fica `[~]`
   e cita o ID.
7. **Verificação independente antes de mesclar:** `code-reviewer` (correção, segurança, desempenho) e
   `scope-guardian` (aderência a esta tarefa e às SPECs) revisam a entrega; quem implementou não se
   aprova. Nas tarefas que tocam token, cofre, gate, assinatura, atualização ou escrita em configs de
   terceiros, o `security-auditor` também revisa.
8. **Fronteiras respeitadas:** nada alterado em `packages/` (ADR 7.10); só a área da tarefa foi tocada;
   o agente não faz commit (o coordenador mescla); nenhum segredo exibido ou registrado.
9. **Evidência registrada:** comando executado e saída real citados em `docs/19-status-reescrita-c.md`.

### 5.2 Onde vive o status

O status de cada tarefa (`[x]`, `[~]`, `🕳️`, `[ ]`, com o vocabulário do `CONTRIBUTING.md`) e a
evidência ficam em **`docs/19-status-reescrita-c.md`**. Este plano não marca status e só muda quando o
escopo de uma tarefa muda, por decisão do dono. A decisão de uma pendência DV/DA também é registrada lá,
e as tarefas que ela destrava seguem as regras acima.

---

## 6. Lacunas deste plano (reportadas, não resolvidas)

- **Pasta do harness de desempenho:** resolvida pela DA-05 (ADR 09): o harness do C fica em
  `native/tests/bench/c/`, ao lado de `native/tests/bench/ts-baseline/`.
- **Módulo de configuração compartilhado:** CLI, MCP, UI e serviço leem a mesma configuração
  (SPEC-03 §1.1, §1.5). Este plano põe o parse puro em `core/` e a leitura em `platform/` (F1-07),
  seguindo a regra de camadas; se `docs/18-padroes-c.md` disser outra coisa, vale o padrão.
- **Pastas do instalador e do AppImage:** não constam da estrutura definida; F0-01 indica onde ficam.
- **Áreas sem SPEC escrita** (fonte = código TS congelado, ADR 7.10): `core/src/conversation.ts`,
  `folders.ts`, `policy-edit.ts`, `audit.ts`, `discovery.ts`, `operator-token.ts`, `hub-env.ts` e
  `adapters/src/discovery/*` (SPEC-04 "Fora deste documento"; `hub-env.ts` tem cobertura parcial em
  SPEC-03 §1.7 e §2.2, `operator-token.ts` em SPEC-01 §4); os 17 arquivos de teste do daemon sem SPEC
  dedicada (orquestração interna: gerenciador de sessões, worktree, reaper, reconcile, handoff,
  retenção; SPEC-07 §6), ligados a F1-17, F1-18, F2-11, F2-13, F2-16, F2-17 e F2-18; formato interno de `Session`, `PolicyView`, `AgentDiscovery`, `ImportResult`,
  `PlanoDeIntegracao` e `SweepResult` (SPEC-01 §10); formato de `payload_json` por tipo de evento
  (SPEC-02 §4.3). As tarefas F2-05, F2-09, F3-09 e F4-14 leem o TS diretamente.
- **Manifestos no produto:** o TS tem "manifestos embutidos" com override em `<home>/manifests/`
  (SPEC-02 §6); como o C os empacota é tratado em F8-01.
- **libcurl e fuzzing:** resolvidos no ADR 09 (DA-25: libcurl do sistema, empacotada no AppImage;
  DA-26: fuzzing adotado, com os alvos distribuídos pelas tarefas donas dos parsers, ver F0-02).
- **Motivo da DV-10 e DA-31:** resolvidos no adendo do ADR 09 (motivo corrigido; `hub mcp serve` e
  `hub daemon` executando o `agents-hubd`). A compatibilidade com os manifestos (DA-33) foi
  decidida no adendo 2.
- **`hub open` (DA-32) e `defaults.isolation` (DA-33):** decididas no adendo 2 do ADR 09.

---

## 7. Backlog pós-paridade (fora das 137 tarefas)

Trabalho decidido para **depois** da paridade (ADR 09, 9.4). Fica sem número de fase e não entra no
caminho crítico; vira tarefa quando o dono abrir a fase.

| Id | Item | Fonte | Observação |
|---|---|---|---|
| PP-01 | Renderizar markdown nas mensagens do agente, num subconjunto seguro (sem HTML, sem imagem remota, link só após confirmação) | ADR 09 (9.4; DA-08); SPEC-05 §15 (K4); SPEC-08 U3 | quais elementos e em quais tipos de evento ainda NÃO DETERMINADO |
| PP-02 | Grafo DAG com arestas desenhadas | ADR 09 (9.4; DA-09); SPEC-05 §7 | a paridade (árvore indentada) é a F6-11 |
