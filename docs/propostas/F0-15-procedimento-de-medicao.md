# F0-15 — Proposta do procedimento de medição das metas de desempenho

> **Estado: PROPOSTA para o dono decidir (DA-05).** Nada aqui está decidido. Cada escolha
> está marcada **PROPOSTA**. O resto é fato conferido nas fontes abaixo. Fatos de terceiros que
> não verifiquei em execução estão marcados com ⚠. Quando a decisão sair, ela vira o
> procedimento que o F9-01 implementa e que o F9-02, o F9-03 e o F9-04 usam.

Fontes: [ADR 08](../decisoes/08-pilha-tecnica-c.md) (tabela "Metas de desempenho" e "Em
aberto"), [SPEC-06](../especificacao/06-desempenho-linha-de-base-e-metas.md) ("Ambiente da
medição", linha de base, "Como as metas serão conferidas"), plano
`docs/17-plano-reescrita-c.md` (F0-15, F9-01 a F9-04, DA-05, DA-14, §6), e o harness da linha de
base preservado em `native/tests/bench/ts-baseline/` (`bench.mjs`, `agente.cjs`, `flood.cjs`,
`relatorio-linha-de-base.md`, `resultados/`, `README.md`; copiado pelo coordenador, pendente de
commit, caminhos pessoais redigidos).

## 1. Ponto de partida

A SPEC-06 deixou uma proposta não decidida: "o mesmo procedimento da linha de base, com mediana
de pelo menos 5 execuções na mesma máquina de referência e serviço isolado". Esta proposta
mantém esses três pontos e detalha o resto:

| Ponto | Proposta |
|---|---|
| Estatística | **Mediana** de N ≥ 5 execuções válidas. Também se registram mín., máx. e p90, como o harness já faz (`native/tests/bench/ts-baseline/bench.mjs:24`). Onde a linha de base usou N maior (hook N=15, `bench.mjs:208`; MCP N=8, `bench.mjs:257`; início com home nova N=7, `bench.mjs:127`), usa-se o mesmo N. **PROPOSTA** |
| Aquecimento | 1 execução descartada antes de cada série, como o harness já faz no hook (`bench.mjs:212`, uma execução antes do laço de `bench.mjs:213`). O valor descartado é registrado, porque o 1º spawn frio do MCP no TS levou 5.505 ms (`native/tests/bench/ts-baseline/relatorio-linha-de-base.md:36`). **PROPOSTA** |
| Máquina | A **mesma máquina de referência** da SPEC-06 (Xeon E5-2650 v4, 15,9 GiB, Windows 10 Pro 19045, SSD NVMe). Para o Linux, ver §2.2. **PROPOSTA** |
| Isolamento | Serviço isolado em toda chamada (§5). Custo zero: só agentes falsos. Nunca a porta 4747 nem `~/.agents-hub`. (Regra do `CLAUDE.md`, não é escolha.) |
| Veredito | Uma meta é cumprida quando a **mediana** fica dentro do limite. Mín. e máx. servem só para diagnóstico. **PROPOSTA** |

## 2. Ambiente de referência

### 2.1 Condições da máquina (PROPOSTA)

A linha de base saiu numa máquina compartilhada (~37% de CPU total num instante amostrado;
SPEC-06 e `relatorio-linha-de-base.md:9`). Para o veredito das metas, a proposta é:

- Fechar navegador, outros agentes e builds durante a série.
- Amostrar a CPU total da máquina antes e depois de cada série e registrar os dois valores.
  Proposta de limite: **CPU total < 10%** antes de começar. Acima disso, a série é marcada "com
  carga" e não vale para o veredito.
- Plano de energia fixo e anotado; máquina na tomada.
- Registrar, em todo resultado: data, commit, SO e build, CPU, RAM, disco, compilador e preset
  CMake (C) ou versão do Node (TS), N, e a CPU total amostrada.

### 2.2 Linux (PROPOSTA)

Não existe linha de base do TS no Linux: a SPEC-06 mediu só no Windows. O ADR 08 não diz se as
metas valem nos dois SOs. Proposta: as metas valem nos dois. A referência Linux seria o
**Ubuntu 22.04** (base do AppImage, ADR 8.14), de preferência na mesma máquina física (dual boot).
Se não houver, numa máquina fixa e anotada. Antes de medir o C, mede-se o TS nessa máquina, que
passa a ser a linha de base Linux. Ver lacuna L2.

### 2.3 Build medido (PROPOSTA)

- Windows: preset `windows-msvc-release`, que já existe em `native/CMakePresets.json`. É o
  compilador do release (ADR 8.2).
- Linux: **não há preset Release Linux**. Os presets Linux são `linux-gcc-debug` e
  `linux-clang-asan` (`native/CMakePresets.json:55-72`). Medir build Debug ou com sanitizer não
  vale. Lacuna L3.
- TS: `packages/*/dist` conferido por hash antes e depois de `npm run build`, como na linha de
  base (`relatorio-linha-de-base.md:62`, seção "Build e commit").

## 3. Definições de medida: Windows e o equivalente no Linux

O Windows segue a SPEC-06 ("Ambiente da medição") e o harness: `Get-Process` em
`bench.mjs:31-35`, descrito em `relatorio-linha-de-base.md:12`. Os campos de Linux vêm da
documentação do `proc(5)` (⚠ fato de terceiro). **Não foram executados aqui:** esta máquina não
tem Linux (o WSL só tem a distro `docker-desktop`, que não usei, e o `/proc` do Git Bash é
emulação do MSYS). O F9-01 precisa confirmá-los no runner `ubuntu-22.04` antes de medir.

| Grandeza | Windows (linha de base) | Linux (equivalente proposto) | Observação |
|---|---|---|---|
| RAM em uso | `WorkingSet64` (`Get-Process`) | `VmRSS` em `/proc/<pid>/status` | Par direto: memória residente do processo |
| RAM privada | `PrivateMemorySize64` (`Get-Process`) | **Sem equivalente exato.** Mais próximos: `RssAnon` em `/proc/<pid>/status` (anônima residente; ⚠ kernel ≥ 4.5) e `Private_Clean` + `Private_Dirty` em `/proc/<pid>/smaps_rollup` (⚠ kernel ≥ 4.14) | ⚠ No Windows esse número é memória **comprometida** privada, que pode não estar residente. No Linux os dois candidatos são residentes. Proposta: registrar os dois, sem comparar com o Windows |
| Pico de RAM | `PeakWorkingSet64` | `VmHWM` em `/proc/<pid>/status` | Só diagnóstico |
| Tempo de CPU | `TotalProcessorTime`: o contador anda em passos de 15,6 ms nesta máquina (`relatorio-linha-de-base.md:22`: 78 a 156 ms) | ⚠ `utime` + `stime`, campos 14 e 15 de `/proc/<pid>/stat`, em ticks de `sysconf(_SC_CLK_TCK)`, somando todas as threads | Precisão melhor (PROPOSTA, para o "≈ 0"): ⚠ `QueryProcessCycleTime` (Win32, em ciclos) e ⚠ a soma do 1º campo (ns) de `/proc/<pid>/task/*/schedstat` |
| Acordadas (trocas de contexto) | Não medido na linha de base (SPEC-06 "Não medido"). Candidato: ⚠ contador por thread `Context Switches/sec` do PerfProc, a confirmar no F9-01 | ⚠ Soma de `voluntary_ctxt_switches` + `nonvoluntary_ctxt_switches` em `/proc/<pid>/task/*/status`. O `status` do processo mostra só a thread principal | Métrica nova, informativa (§4.3) |
| Threads / handles | `Threads.Count`, `HandleCount` | `Threads` em `/proc/<pid>/status`; número de entradas em `/proc/<pid>/fd` | Só diagnóstico |
| Tempo | `performance.now()` no processo medidor, **do spawn até o evento medido** | Igual: é o mesmo harness em Node nos dois SOs | Ver o piso do harness em §4.4 |
| Tamanho | Soma de `Length` dos arquivos (tamanho aparente) | ⚠ `du --apparent-size -b` ou soma de `st_size` | Não usar o espaço alocado: o TS deu 18,2 MiB aparentes e 27,6 MB alocados (`relatorio-linha-de-base.md:40`) |

**Unidade (PROPOSTA).** O harness divide bytes por 1.048.576 (`bench.mjs:23`). Os "MB" de RAM
da SPEC-06 são, portanto, MiB, e o tamanho já aparece como MiB. Proposta: **todas as metas de RAM
e de tamanho em MiB (2^20 bytes)**, sempre com o valor em bytes ao lado. Lacuna L4.

## 4. Procedimento por meta (as 7 do ADR 08)

Comum a todas: serviço isolado (§5), home temporário com manifestos falsos quando a medição
precisa de agente (`bench.mjs:95-106`), e encerramento por `POST /shutdown` com o token do home
temporário (`bench.mjs:77-85`).

### 4.1 Início do serviço ≤ 150 ms

- **Evento final:** primeira resposta `200` de `GET /health`. O harness consulta a cada 5 ms
  (`bench.mjs:58-69`), então o erro vai de 0 a 5 ms, mais o tempo da requisição.
- **Casos:** home já existente (1 subida de aquecimento antes, depois N=5) e home nova (cria
  banco e token, N=7), como na linha de base (`bench.mjs:125-155`).
- **Qual caso a meta cobre (PROPOSTA):** **home existente**, o caso de todo dia. A home nova é
  registrada como informativa. Proposta alternativa para o dono: os dois.
- **Comando do C:** o equivalente de `hub daemon` (SPEC-03), a confirmar quando a CLI C existir.
  Hoje ela não existe.

### 4.2 RAM do serviço parado ≤ 15 MB

- **Leituras:** 2 s e 62 s depois do `/health`, sem sessão e sem cliente SSE
  (`bench.mjs:139-140`).
- **Contador da meta (PROPOSTA):** `WorkingSet64` no Windows e `VmRSS` no Linux. A privada é
  registrada ao lado. A SPEC-06 dá os dois números, e o ADR 08 não diz qual vale. Lacuna L5.
- **Instante (PROPOSTA):** vale a **maior** das leituras de 2 s e de 62 s. No TS a memória caía
  com o tempo (GC); no C não há GC, e a regra impede escolher o instante mais favorável.
- **Processos filhos (PROPOSTA):** mede-se só o processo do serviço e listam-se os filhos
  (`bench.mjs:139`). O `conhost.exe` da linha de base (~11 MB) ficou fora da conta
  (`relatorio-linha-de-base.md:23`). Se o serviço C criar um processo auxiliar próprio (não
  agente), a RAM dele entra na soma.
- **Dependência:** se a janela e o serviço forem o mesmo processo (DA-14, aberta), a medição é
  feita com a janela fechada e o app na bandeja (estado do ADR 7.5). Lacuna L6.

### 4.3 CPU do serviço parado ≈ 0

Definição operacional (**PROPOSTA**):

- **Janela:** de 2 s a 62 s depois do `/health`, sem sessão, sem cliente SSE e sem requisição
  (a mesma janela de `bench.mjs:139-143`). Com cliente SSE o serviço acorda por desenho: o
  heartbeat `: ping` sai a cada 20.000 ms (`docs/especificacao/01-api-http.md:525`). Essa
  variante é medida à parte, como informativa.
- **Critério de "≈ 0":** mediana do tempo de CPU na janela **≤ 15,6 ms em 60 s**, ou seja, no
  máximo um passo do contador do Windows (≤ 0,026% de um núcleo). No Linux, **≤ 1 tick** de
  `_SC_CLK_TCK` em 60 s. O TS gastou 109 ms (`relatorio-linha-de-base.md:22`).
- **Complemento informativo:** trocas de contexto na mesma janela (§3) e ciclos (⚠
  `QueryProcessCycleTime` / ⚠ `schedstat`). Proposta de alvo informativo: **≤ 1 acordada por
  segundo** somando todas as threads. Isso fecha o item "acordadas por segundo" do "Não medido"
  da SPEC-06. Não bloqueia sem decisão do dono.
- O F0-09 e o F6-01 já pedem "sem polling periódico ocioso" e "CPU parado medido". Esta definição
  serve para os dois.

### 4.4 Hook do gate ≤ 30 ms

- **Casos:** as seis séries de hook do harness, N=15 + 1 de aquecimento cada
  (`bench.mjs:222-223`, `:226-227` e `:233-234`). Elas aparecem no relatório como:
  - 4a: `Read` pelo caminho rápido com o daemon no ar, 152 ms. Na mesma linha estão as variantes
    daemon fora (177 ms) e com sessão (168 ms) (`relatorio-linha-de-base.md:28`).
  - 4b: `Bash "git status"` fora de sessão, 308 ms (`relatorio-linha-de-base.md:29`).
  - 4c: `Bash "git status"` com sessão viva do agente falso `lento`, 309 ms
    (`relatorio-linha-de-base.md:30`). A sessão é passada por `AGENTS_HUB_SESSION_ID`; o agente
    falso dorme 600 s (`bench.mjs:99`).
  - 4d: `Bash` com o daemon fora do ar, 307 ms (`relatorio-linha-de-base.md:31`).

  A meta vale para o caminho rápido e para o comando de shell (aceite do F9-03). Proposta: a meta
  cobre 4a, 4b e 4c; 4d (daemon fora) é informativo. **PROPOSTA**
- **Evento final:** saída do processo do hook. O stdin com o PreToolUse é escrito e fechado logo
  depois do spawn (`bench.mjs:115`).
- **Piso do harness (PROPOSTA):** a mesma série com um executável que só termina com código 0,
  compilado com o mesmo preset. O piso conta. Nesta máquina, `cmd /c` sozinho custou 27 ms e
  `node -e 0` custou 76 ms com `spawnSync` (`relatorio-linha-de-base.md:33`, linha 5a) e 106 ms
  com spawn assíncrono no harness (`relatorio-linha-de-base.md:19`, linha 1b). Proposta: a meta
  vale para o **tempo bruto** (o que o Claude Code sente), e o piso é registrado ao lado. Se o
  piso passar de ~15 ms na máquina de referência, o dono revê a meta. Lacuna L7.
- **Registrar também** o custo só do daemon (`POST /hooks/pretooluse` direto, N=50,
  `bench.mjs:236-241`): no TS foi 2,6 ms com sessão e 1,4 ms fora (`relatorio-linha-de-base.md:32`).

### 4.5 MCP server: início ≤ 50 ms; RAM ≤ 10 MB

- **Início:** do spawn até a resposta JSON-RPC de `initialize` no stdout, com o daemon isolado no
  ar, N=8 (`bench.mjs:253-265`). `AGENTS_HUB_MCP_GRACE_MS=0` (variável da SPEC-03), como na linha
  de base (`bench.mjs:259`).
- **RAM:** `WorkingSet64` / `VmRSS` 1 s depois de `initialize` + `notifications/initialized` +
  `tools/list` + `tools/call hub_agent_list` (`bench.mjs:266-269`). Mesma regra de contador da
  §4.2 (PROPOSTA).
- **1º spawn frio:** é o aquecimento, registrado e fora da mediana (PROPOSTA).

### 4.6 Tamanho instalado ≤ 20 MB

- **Windows (PROPOSTA):** tamanho aparente do diretório instalado pelo Inno Setup (instalação por
  usuário, ADR 8.12). Para não instalar na máquina do usuário, a medição roda num runner efêmero
  do CI, ou soma o diretório de staging que o instalador empacota, conferido uma vez contra a
  instalação real no runner. As flags de instalação silenciosa ficam para o F8-02 confirmar.
- **Linux (PROPOSTA):** tamanho do arquivo `.AppImage`, que é o que fica no disco.
- **O que entra:** tudo o que o instalador põe no disco. Bibliotecas do sistema ficam fora (por
  exemplo, a libcurl se não for vendorizada, §6 do plano e DA-13) e são listadas à parte. A linha
  de base do TS somou o `node.exe` (≈ 105 MiB no total), porque o TS precisa dele.
- Métrica determinística: não precisa de mediana. N=1 por build basta (PROPOSTA).

### 4.7 Vazão de eventos ≥ 5.000 eventos/s

- **Agente:** o mesmo da linha de base. `native/tests/bench/ts-baseline/flood.cjs` (Node puro)
  espera o stdin fechar, aguarda 500 ms (`flood.cjs:7`) e imprime `FLOOD_N` linhas
  `F|<seq>|<carimbo>|<150 x>` em blocos de ~64 KiB (`flood.cjs:12`). Manifestos com
  `format: text` e `mapper: generic-text`: `burst2k`, `burst20k` e `paced` (`bench.mjs:101-102`).
- **Medida:** cliente SSE em `GET /events` aberto antes da sessão (`bench.mjs:282-301`).
  eventos/s = recebidos / (último recebimento − primeiro recebimento) (`bench.mjs:329`). "Sem
  perda" = recebidos == `FLOOD_N` e o SSE não foi fechado pelo servidor (`bench.mjs:328`).
- **Caso da meta (PROPOSTA):** a rajada de **20.000 linhas**, com 5 repetições no mesmo daemon,
  como na linha de base (`bench.mjs:308`). Na meta, 2.000 linhas duram ~0,4 s, curto demais para
  medir bem. A de 2.000 e a de ritmo baixo (200 linhas a cada 20 ms) entram como informativas.
- **Registrar também:** latência agente → SSE (mediana, p99), `/health` durante a rajada, pico de
  RAM ao longo das 5 rajadas (no TS subiu de 88 para 145 MB e não voltou,
  `relatorio-linha-de-base.md:51`) e bytes do banco por evento.
- **Teto do harness (PROPOSTA):** antes de medir o C, prova-se que o agente e o cliente SSE em
  Node passam com folga de 5.000 eventos/s. Por exemplo: o `flood.cjs` ligado direto a um leitor
  de pipe, e o cliente SSE contra um emissor trivial. Sem isso, um resultado perto da meta pode
  medir o harness, não o serviço.
- **Pré-requisitos do C:** mapper `generic-text` (F3-05) e override de manifestos em
  `<home>/manifests/`. Ver lacuna L8.

## 5. Isolamento (o que o harness garante)

O harness da linha de base já tem estas travas, e a proposta é mantê-las no harness do C:

- `AGENTS_HUB_HOME` (temporário), `AGENTS_HUB_PORT` e `AGENTS_HUB_NO_AUTOSTART=1` em toda chamada
  (`bench.mjs:26-28`). Aborta se a porta for 4747 ou estiver indefinida (`bench.mjs:14`) e se
  `BENCH_TMP` terminar em `.agents-hub` (`bench.mjs:16`).
- Confere que a porta está livre antes de subir (`bench.mjs:56`, usado em `:59`). Confere que o
  daemon que responde é o nosso: lê o token do home temporário e exige que uma rota de operador
  não dê 401/403 (`bench.mjs:72-74`).
- Encerra por `POST /shutdown` com esse token. Só mata o processo depois de 15 s
  (`bench.mjs:82`). Em falha, encerra os daemons ainda vivos (`bench.mjs:120`, `:349`).
- Conferência no fim, como na linha de base: nada ouvindo em 4747 nem na porta do bench, nenhum
  arquivo novo em `~/.agents-hub`, nenhum processo remanescente (`relatorio-linha-de-base.md:66`,
  seção "Isolamento (conferido no fim)").

## 6. Onde o harness mora (PROPOSTA)

O harness da linha de base já está em `native/tests/bench/ts-baseline/` (copiado pelo
coordenador, pendente de commit). O `README.md` dele diz: "Este harness não foi
adaptado: está como foi usado na medição". `native/tests/bench/` existe, mas não está na estrutura
original do `CLAUDE.md` (plano §6).

| Caminho | Conteúdo | Estado |
|---|---|---|
| `native/tests/bench/ts-baseline/` | `bench.mjs`, `agente.cjs`, `flood.cjs`, `relatorio-linha-de-base.md`, `resultados/res-*.json`, `README.md` | Existe. PROPOSTA: **congelado** — é a referência da SPEC-06 e não se edita |
| `native/tests/bench/c/` | harness do C | **PROPOSTA** |
| `native/tests/bench/c/bench.mjs` | harness derivado de `ts-baseline/bench.mjs`, com o alvo parametrizado (`ts` ou `c`) | **PROPOSTA** |
| `native/tests/bench/c/agentes/` | cópia dos agentes falsos (`agente.cjs`, `flood.cjs`). Mudança só com justificativa, porque eles definem a carga | **PROPOSTA** |
| `native/tests/bench/c/README.md` | como rodar. O comando vai para o `CLAUDE.md` quando tiver sido verificado | **PROPOSTA** |

- **Separação (PROPOSTA):** o harness do C nunca altera `ts-baseline/`. Ele é uma cópia derivada
  em `c/`. Para provar que a derivação não mudou a medida, o harness novo roda contra o TS e
  reproduz a linha de base dentro da tolerância da §7, item 5 (aceite do F9-01).
- **Linguagem (PROPOSTA):** manter o harness do C em **Node**. O de base já mediu o TS, e o TS
  precisa do Node de qualquer forma. Um único harness para os dois alvos é o que torna a
  comparação justa (§7). A dependência de Node fica só no bench, não no produto.
- **Parametrização (PROPOSTA):** hoje os alvos estão fixos em `packages/*/dist`
  (`ts-baseline/bench.mjs:10-11`). No harness do C eles viram argumento (alvo e caminhos dos
  binários). As seções `panel`, `probe` e `kids` (`ts-baseline/bench.mjs:158`, `:344-346`) não
  entram, porque o painel web deixa de existir (ADR 7.3).
- **Saída:** JSON no diretório de build ou num temporário, **nunca** dentro do repositório. O CI
  exige checkout limpo depois do build e dos testes (`.github/workflows/native.yml:72-75`).
- **Fora do `ctest` padrão (PROPOSTA):** é lento (a seção de início leva ~6 min por causa das
  janelas de 60 s, `ts-baseline/bench.mjs:140`) e depende da máquina.

## 7. Comparação justa TS vs C (PROPOSTA)

1. **Mesmo harness**, mesma seção e mesmo N para os dois alvos.
2. **Mesma máquina, mesma sessão de medição**, com séries intercaladas (TS, C, TS, C) para
   diluir a deriva da máquina (térmica, carga de fundo).
3. **Mesmos agentes falsos e manifestos** (`flood.cjs`, `agente.cjs`), mesmo conteúdo de home
   (`config.json` com `retries.max = 0`, `ts-baseline/bench.mjs:103`) e mesmos corpos de hook.
4. **Carga concorrente controlada:** a série oficial roda sem carga (§2.1). Se o dono quiser
   medir sob carga, a carga é sintética e fixa (por exemplo, K núcleos ocupados por um processo
   de laço, com K anotado) e aplicada igual aos dois alvos. Nunca a carga ocasional de outros
   agentes, como na linha de base.
5. **Reprodução da linha de base (aceite do F9-01):** o TS é medido de novo com o harness do C.
   Tolerância proposta: **±20% na mediana dos tempos e ±10% na RAM**, comparando com a SPEC-06.
   Fora disso, investiga-se antes de medir o C. Como a SPEC-06 saiu sob carga, um TS mais rápido
   agora é esperado. O número novo passa a ser a base de comparação, e a diferença é registrada.
6. O C é medido no build da §2.3, nunca em Debug ou com sanitizer.

## 8. Integração ao CI (PROPOSTA)

⚠ Os runners hospedados do GitHub são VMs compartilhadas. Esse é um fato de terceiro: não medi o
ruído deles. A proposta parte da hipótese de que ele é maior que o da máquina de referência:

| Métrica | No CI | Motivo |
|---|---|---|
| Tamanho instalado | **Bloqueante** (≤ meta) | Determinística |
| Início, RAM parado, CPU parado, hook, MCP, vazão | **Informativo**: job separado, resultado em JSON como artefato, sem falhar o build | Ruído do runner (⚠ hipótese) |
| Regressão grosseira | **Bloqueante opcional**, a decidir: falha se a mediana passar de 2× a meta | Pega regressões grandes sem falso positivo de ruído |

- O padrão de job informativo já existe no repositório: `.github/workflows/ci.yml:173`
  ("cobertura (informativo)") e `.github/workflows/ci.yml:207` ("auditoria de dependências
  (informativo)").
- **Veredito oficial das metas:** sempre na máquina de referência (§2), com os números
  registrados em `docs/19-status-reescrita-c.md` (F9-02 a F9-04). O CI não dá `[x]` a meta de
  tempo nem de RAM.
- Gatilho do job informativo: `workflow_dispatch` e `push` em `main`, não em cada PR, para não
  alongar o ciclo.

## 9. Lacunas para o dono

- **L1 — resolvida, pendente de commit.** O harness da linha de base foi copiado pelo
  coordenador para `native/tests/bench/ts-baseline/` (caminhos pessoais redigidos). Falta
  o commit.
- **L2** — Não há linha de base Linux, e o ADR 08 não diz se as metas valem nos dois SOs.
- **L3** — Não há preset Release no Linux (`native/CMakePresets.json:55-72`).
- **L4** — Unidade das metas: "MB" no ADR 08 contra MiB no harness (`bench.mjs:23`) e no tamanho
  da SPEC-06.
- **L5** — Qual contador vale para as metas de RAM (em uso ou privada) e em que instante.
- **L6** — O DA-14 (janela e serviço no mesmo processo?) muda o que é "RAM e CPU do serviço
  parado".
- **L7** — Hook ≤ 30 ms: tempo bruto com spawn ou descontado o piso? O spawn de processo no
  Windows ocupa parte relevante desse limite.
- **L8** — A medição de vazão exige o `generic-text` (F3-05) e o override de manifestos. O F9-02
  depende do F4-09 e do F9-01. Não conferi se o F3-05 entra por dependência transitiva.
- **L9** — Os fatos marcados com ⚠ na §3 (campos do `/proc`, versões de kernel,
  `QueryProcessCycleTime`, contador do PerfProc, `du`) não foram executados nesta máquina. O F9-01
  os confirma no `ubuntu-22.04` e no Windows de referência.
