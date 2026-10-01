# Linha de base de desempenho: Agents-Hub TypeScript/Node (antes da reescrita em C)

Data: 2026-09-30, 20:25 a 20:56 (-03:00). Código medido: commit ac59745 = ecbb72f em packages/ (ver seção Build e commit). dist atualizado: confirmado por hash antes e depois de npm run build.
Sem orçamento definido: aqui só há medições.

## Ambiente
- Máquina: Intel Xeon E5-2650 v4 a 2,20 GHz (12 núcleos, 24 lógicos), 15,9 GiB de RAM, Windows 10 Pro 10.0.19045, disco do sistema NVMe "NE-512" (SSD). O temp/scratchpad fica em C:.
- Node v24.14.0 (C:\Program Files\nodejs\node.exe). Em Node 24 não há reexecução com --experimental-sqlite.
- Máquina COMPARTILHADA durante a medição: navegador, outros agentes (Hydra, OpenCode, claude) e um processo que gravou docs/especificacao/ no repo às 20:42-20:46 (não fui eu). CPU total em ~37% num instante amostrado. Por isso os números saem como mediana; os máximos têm ruído.
- Isolamento: toda chamada levou AGENTS_HUB_HOME=(scratchpad)\tmp-bench\..., AGENTS_HUB_PORT=48731, AGENTS_HUB_NO_AUTOSTART=1 (e AGENTS_HUB_URL=http://127.0.0.1:48731). Cada daemon foi validado pelo token da home temporária antes do uso e encerrado com POST /shutdown + token.
- Harness: scratchpad/bench.mjs (seções startup, panel, hookcli, mcp, flood), agentes falsos agente.cjs / flood.cjs (Node puro, nenhum modelo chamado). Resultados brutos: scratchpad/res-*.json.
- RAM/CPU: PowerShell Get-Process -Id PID (WorkingSet64, PrivateMemorySize64, PeakWorkingSet64, TotalProcessorTime). Tempos: performance.now() no processo medidor, de spawn até o evento medido.

## Tabela

| # | MÉTRICA | MEDIDO (mediana de N) | comando / procedimento | observações |
|---|---|---|---|---|
| 1a | Início do daemon até /health 200, home nova (cria banco e token) | **881 ms** (N=7; 845-1096) | node packages/cli/dist/bin.js daemon; GET /health a cada 5 ms | manifestos embutidos (9) |
| 1b | Início do daemon até /health 200, home já existente | **818 ms** (N=5; 807-851) | igual, mesma home reaproveitada | piso do runtime (node -e 0) = 106 ms no mesmo harness |
| 2a | RAM ociosa 2 s depois de subir | **WS 78,3 MB / privados 55,3 MB** (N=5) | Get-Process | home nova: WS 78,7 / priv 55,5 (N=7) |
| 2b | RAM ociosa ~62 s depois de subir | **WS 60,9 MB / privados 38,0 MB** (N=5) | idem, 60 s parado | cai sozinha (GC/trim) |
| 2c | CPU ocioso | **109 ms de CPU em 60 s (~0,18% de 1 núcleo)** (N=5; 78-156) | delta de TotalProcessorTime | granularidade do contador no Windows é 15,6 ms. 12 threads, 258 handles |
| 2d | Processo auxiliar | conhost.exe, WS ~11 MB | Win32_Process por ParentProcessId | host de console do Windows, não conta nos números acima |
| 2e | Encerramento (POST /shutdown até exit) | 141 ms (N=5) | | |
| 3a | RAM com painel via HTTP (GET /, JS, CSS, /health, /agents, /projects, /sessions, /approvals, /workflows/runs + 80 GETs quentes) | **WS 74,0 / privados 87,1 MB** (N=5); base antes: WS 71,1 / priv 54,2 | HTTP sem keep-alive | home com 5 manifestos falsos. Sem SSE nesta fase |
| 3b | RAM com painel aberto num navegador real (Edge headless, 3 s depois do load, SSE aberto) | **WS 61,8 / privados 70,3 MB** (N=5); depois de reload: 61,8 / 70,5; pico de WS 78,1 | Playwright chromium.launch com channel msedge | load do painel: 124 ms (N=5; 1º 579 ms) |
| 3c | Latência das APIs do painel | GET / 9,5 ms frio; /health, /sessions, /projects, /approvals ~1,5-2,3 ms frio e **~1,0 ms quente**; **GET /agents 578 ms** | | /agents roda --version de cada agente (probeAll) |
| 4a | hub hook Read (caminho rápido), daemon no ar | **152 ms** (N=15) | stdin = PreToolUse Read de arquivo dentro do cwd | stdout vazio (sem opinião). Daemon fora: 177 ms. Com sessão: 168 ms |
| 4b | hub hook Bash "git status", fora de sessão | **308 ms** (N=15) | stdin = PreToolUse Bash | allow "fora de uma sessão do Hub" |
| 4c | hub hook Bash "git status", sessão viva do Hub (política aplicada) | **309 ms** (N=15; 297-463) | AGENTS_HUB_SESSION_ID de sessão do agente falso "lento" | allow "comando só de leitura na allow list" |
| 4d | hub hook Bash, daemon fora do ar | 307 ms (N=15) | | allow "Agents-Hub indisponível" |
| 4e | Custo só do daemon no gate | **2,6 ms** com sessão / 1,4 ms fora (N=50) | POST /hooks/pretooluse direto | ~99% do tempo do hook é o processo Node do hook |
| 5a | hub --version a frio | **136 ms** (N=15) | node bin.js --version (spawn async) | instalado: node bin/hub.js 99,5 ms e shim hub.cmd 145 ms (spawnSync, N=11; piso node -e 0 = 76 ms nesse harness, cmd /c = 27 ms) |
| 5b | hub help a frio | **597 ms** (N=15) | node bin.js help | instalado: 633 ms direto / 659 ms pelo hub.cmd |
| 5c | hub status (cliente contra daemon) | 733 ms (N=15) | | extra |
| 6a | MCP server: spawn até resposta ao initialize | **663 ms** (N=8; 643-689) | node packages/mcp/dist/main.js, JSON-RPC por linha no stdin | 1ª série: mediana 664 ms, mas o 1º spawn frio levou 5505 ms |
| 6b | MCP: tools/list / hub_agent_list | 9,6 ms / 68 ms (1ª chamada 659 ms) | | 16 tools |
| 6c | RAM do MCP server depois de initialize + tools/list + 1 call | **WS 79,5 / privados 74,2 MB** (N=8) | Get-Process 1 s depois | saída depois de fechar o stdin: 28 ms (GRACE_MS=0) |
| 7a | Tarball | **3.998.901 bytes (3,81 MiB)**, 3830 arquivos | npm run pack:dist -- --out (scratchpad)/pack | pack levou 55 s |
| 7b | Instalado (npm i -g --prefix TMP) | **19.048.298 bytes (18,2 MiB) de tamanho aparente**; 27,6 MB alocados em disco; 3842 arquivos | du --apparent-size; soma de Length no PowerShell | install levou 53 s. Maiores: SDK MCP 4,27 MiB; zod 3,43; web 2,24 (1,75 disso é o .js.map); @agents-hub/* 1,42; hono 1,23; ajv 0,99; yaml 0,66 |
| 7c | Runtime necessário | **node.exe 91.380.224 bytes (87,1 MiB)** | ls | total do runtime + instalação ~105 MiB |
| 8a | Evento a evento, ritmo baixo (200 linhas, 1 a cada 20 ms nominais) | latência agente -> SSE **1,3 ms** mediana; p99 31,6 ms; máx. 58 ms (medianas de N=5) | agente falso generic-text; SSE /events global; carimbo de tempo na linha | ritmo efetivo 32 ev/s (timer de 15,6 ms do Windows). /health mediana 1,9 ms, máx. 44 ms |
| 8b | Rajada de 2.000 linhas (~170 B) | **929 ev/s** ponta a ponta; latência mediana 1053 ms, p99 1960 ms | idem | 2000/2000 recebidos, SSE sem queda. /health durante: mediana 3,7 ms, máx. 55 ms |
| 8c | Rajada de 20.000 linhas | **862 ev/s**; latência mediana 1679 ms, p99 2373 ms; tarefa 23,9 s | idem | 20000/20000 recebidos. /health: mediana 11,3 ms, máx. 59 ms (uma execução com 922 ms). Pico de WS 144,5 MB |
| 8d | Banco depois de 111.000 eventos | hub.db 94,9 MB (~855 B/evento) | statSync | |

## Leitura dos números (hipóteses com evidência; nada foi perfilado)
- **Carga de módulos domina o tempo a frio.** O daemon leva ~0,82 s até o /health contra um piso de 0,1 s do node -e 0. hub help, que só carrega main.js (e com ele o índice do daemon: store/node:sqlite, adapters, servidor), já custa ~0,6 s. Evidência: packages/cli/src/bin.ts faz await import('./main.js') para todo comando que não é hook nem --version.
- **Hook:** Bash ~308 ms = ~106 ms de processo Node + ~200 ms de módulos (config com zod, cliente HTTP, pretool-gate) + ~2,6 ms de daemon. O caminho rápido de Read (~150 ms) pula a config/zod (comentário em packages/cli/src/hook-run.ts). A doc cita ~250 ms e ~125 ms. Aqui deu 308 e 152-177 ms, com o spawn do harness incluído.
- **Vazão de eventos ~0,9 k ev/s**, mesmo com a latência de 1-2 s sob rajada vindo de fila. Evidência de código (não perfilado): EventRepository.append em packages/store/src/repositories.ts:413 chama db.prepare() a cada evento e grava em autocommit. A tabela events tem ~9 índices e um trigger (packages/store/src/migrations.ts).
- **RAM depois das rajadas:** o WS do daemon subiu de 88 para 145 MB ao longo das 5 rajadas de 20k no mesmo processo e não voltou durante a medição. Não investiguei se é heap do V8, cache do SQLite ou retenção.

## O que não foi medido ou tem ressalva
- Chromium do Playwright: PLAYWRIGHT_BROWSERS_PATH aponta para E:\ms-playwright, que não tem o build 1243 exigido pelo playwright 1.63. Não instalei nada. Usei o Edge do sistema (channel msedge). A RAM do navegador em si não foi medida, só a do daemon.
- "Tempo até o log de pronto" foi descartado: o marcador do harness ("daemon no ar") não bate com o que hub daemon imprime ("daemon ouvindo em ...").
- Wakeups/s do daemon ocioso: não medidos, só tempo de CPU.
- Hook medido por spawn direto do Node. O Claude Code chama o hook pelo shell dele, e esse overhead extra não está incluído.
- A latência de SSE compara relógios de parede de dois processos na mesma máquina (performance.timeOrigin + now()), com precisão de ~1 ms.
- pack:dist foi rodado com --out para o scratchpad, para não gravar dist-pack/ no repo. O npm i -g --prefix pode ter usado o cache do npm do usuário.
- As medições de 3 (painel com navegador), 6 (2ª série) e 7 coincidiram com a atividade concorrente citada acima.

## Build e commit (resposta ao aviso do coordenador)
- Medições feitas com HEAD = ac59745. Durante a sessão entraram c1c591d, 82f40cc e ecbb72f (20:31-20:54), só com docs e .claude/agents. `git diff --stat ac59745 ecbb72f -- packages scripts manifests package.json package-lock.json` saiu vazio, então o código medido é o mesmo de ecbb72f.
- O mtime de alguns src/*.ts é mais novo que dist/index.js, mas isso engana: o tsc não regrava saída que não mudou. Conferência objetiva: sha1 de todos os 353 packages/*/dist/**/*.{js,html,css} antes do build, `npm run build` às 20:55:44-20:56:01, sha1 depois: **idênticos** (diff vazio). O dist usado nas medições estava atualizado; nada foi refeito.

## Isolamento (conferido no fim)
- netstat: nada ouvindo em 127.0.0.1:4747 nem em 48731 (o daemon real já não estava no ar no início).
- find ~/.agents-hub -newermt "2026-09-30 20:25": nenhum arquivo. A listagem de ~/.agents-hub é igual à de antes, exceto o mtime do diretório pai (~).
- Nenhum node.exe remanescente com tmp-bench/scratchpad na linha de comando.
