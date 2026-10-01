# 08 — Modelo de ameaças da reescrita em C

> Insumo de segurança para o plano da reescrita ([ADR 07](../decisoes/07-reescrita-nativa.md),
> [ADR 08](../decisoes/08-pilha-tecnica-c.md)). O que é fato do TS traz `arquivo:linha`
> (caminhos relativos a `packages/`) ou a seção da SPEC. O que é recomendação está marcado
> **PROPOSTA**: nada aqui está decidido. ⚠ marca afirmação sobre biblioteca de terceiros ainda
> não conferida na fonte vendorizada, ou sobre API ou comportamento do sistema operacional ainda
> não conferido na documentação oficial. Severidade: **Alta** (quebra uma garantia do SECURITY.md
> ou dá execução de código a partir de entrada não confiável), **Média** (enfraquece uma camada
> ou expõe segredo a terceiro), **Baixa** (endurecimento ou robustez).

## 0. Escopo e fronteiras

Os atores e fronteiras do SECURITY.md:26-35 continuam: página web, o agente que o Hub roda,
repositório hostil, outro usuário do SO e processo local do mesmo usuário (que **não** é
fronteira, SECURITY.md:397-432). A reescrita acrescenta quatro superfícies: atualizador próprio
(ADR 7.13, 8.13), servidor HTTP próprio (8.6), código C nos parsers (8.1) e cofre do SO (7.16).
E remove duas: painel web servido pelo daemon e cookie de operador (ADR 7.3).

## 1. O que se mantém igual no C (paridade de segurança)

Cada item é garantia do TS e vira teste de conformidade do C (ADR 7.10).

| # | Garantia | Fonte |
|---|---|---|
| M1 | Bind em `127.0.0.1:4747`; a porta é o lock de instância | SPEC-01 §1 (`daemon/src/config.ts:321-322`, `daemon/src/hub.ts:154-174`) |
| M2 | Guarda de borda, nesta ordem: Host loopback + porta; `Origin` loopback + porta efetiva, `null` recusado; `Sec-Fetch-Site` cross-site barra método que muda estado (inclusive desconhecido); corpo só `application/json` (415). Cabeçalho repetido: vale o primeiro valor | SPEC-01 §3; `daemon/src/guard.ts:50-114`, `:146-149` |
| M3 | Corpo ≤ 5.000.000 bytes recusado pelo `Content-Length` antes de ler; chunked cortado no estouro; excedente descartado até 64.000.000 bytes, depois o socket cai; JSON inválido → 400 sem ecoar o parser; `%` malformado → 400 `MALFORMED_URL`; `%2F` não cria segmento | SPEC-01 §5; `daemon/src/http-body.ts:19`, `:93-113` |
| M4 | Ids por regex (`ses_`, `apv_`, `prj_`…), codificados no caminho; schemas `.strict()` | SPEC-01 §2; SECURITY.md:47 |
| M5 | Token de operador: 32 bytes aleatórios em hex, arquivo só do usuário, criado em temporário restrito e renomeado; 13 rotas `operator: true` dão 401 antes de ler corpo ou parâmetro; comparação em tempo constante; `by` vem da credencial; o token não vai para o ambiente do agente; MCP e hook não o têm | SPEC-01 §4; SECURITY.md:248-284; `daemon/src/operator-auth.ts:157`, `:166-180` |
| M6 | `/health` sem `home`; `/discovery` com segredos mascarados | SECURITY.md:45-46 |
| M7 | Limites do MCP (`hub_agent_call`: objetivo ≤ 20.000, ≤ 50 itens, ≤ 2.000 por item, artefato relativo sem `..`) | SECURITY.md:48 |
| M8 | Saída de agente: 64 MB por sessão, página ≤ 8 MiB, linha ≤ 16 MiB com `[truncado N bytes]`; fila SSE de 700; teto de 100 conexões SSE | SECURITY.md:49; SPEC-04 B4.1; SPEC-01 §8.1; teto SSE: SPEC-01 §1 (`docs/especificacao/01-api-http.md:43`) |
| M9 | Política: interseção pai/filho, profundidade e ciclo semântico, orçamento da raiz, deny = deny em todos os modos, tabela risco × modo | SECURITY.md:50-53, :59-104; SPEC-04 A5 |
| M10 | Classificador: tokenização, vale o pior segmento, desembrulho de wrappers, o que não tokeniza vira `escalate`, HTTP ao daemon e CLI de operador são `irreversible` | SECURITY.md:54, :137-147; SPEC-04 A6 |
| M11 | Caminhos sensíveis por segmento; lista embutida não configurável; `denyFragments` só soma | SPEC-04 A7 |
| M12 | Gate: `MATCHER_DE_RISCO`; leitura comum respondida no hook com silêncio; idempotência por `sessão\|toolUseId`; relógios 55 s < 100 s < 120 s; falha fechada em sessão do Hub e aberta fora dela | SECURITY.md:125-247; SPEC-01 §9; SPEC-03 §1.5 |
| M13 | Codex `supervised` recusado sem `bypassHookTrust`; OpenCode com agentes `hub-*` | SECURITY.md:383-390; SPEC-04 B8, B10 |
| M14 | Config de repositório: só aperta; campos sensíveis só com `trust` (TOFU por hash); env por lista de permissão, sempre recusando `PATH`, `LD_PRELOAD`, `NODE_OPTIONS`… | SECURITY.md:320-349; SPEC-04 A13 |
| M15 | Importação pula (não mascara) servidor com segredo; pasta de projeto não pode ser raiz nem pasta de sistema | SECURITY.md:297-318 |
| M16 | `--write` em config alheia: merge, escrita atômica, backup `.bak-AAAAMMDD-HHMMSS` nunca sobrescrito | SECURITY.md:57; SPEC-03 §1.9 |
| M17 | Spawn sem shell; `.cmd`/`.bat` não reconhecido via `cmd.exe /d /s /c` com escape duplo; recusa de `\r\n\0` e de linha > 8.191; prompt por stdin quando o manifesto aceita; PATH × PATHEXT sem o diretório corrente | SPEC-04 B4, B5; `adapters/src/bin-resolver.ts:347-386` |
| M18 | Os "não garante" do SECURITY.md:359-497 seguem verdadeiros e precisam ser republicados para o C: prevenção só onde há gate; processo local não é fronteira; classificador não é sandbox; worktree não é sandbox; loopback não é autenticação; prompt injection; retenção sem cifra | SECURITY.md:359-497 |

**Deixam de existir no C:** traversal do painel estático (SECURITY.md:44; SPEC-01 §7), porque
não há painel web (ADR 7.3); cookie de operador (SPEC-01 §4, SECURITY.md:271-295); porta sem
token do `vite dev` (SECURITY.md:418-419).

**Mudam por decisão:** env por projeto sai do texto puro (SECURITY.md:351-355) para o cofre
(ADR 7.16); `hub update` sai de instrução manual (SPEC-03 §1.11) para atualizador automático
(ADR 7.13).

## 2. Ameaças novas ou agravadas pela reescrita

### 2a. Atualizador próprio (ADR 7.13, 7.14, 8.10, 8.11, 8.13)

**A1 — Chave privada de assinatura comprometida. Alta.** Cenário: a chave fica num secret do
GitHub Actions; um PR malicioso, uma action de terceiro comprometida ou o roubo da conta assina
um manifesto apontando para um binário hostil, e todas as instalações o aceitam na próxima
checagem. O repositório é público (ADR 07, "Em aberto"). Impacto: execução de código em toda a
base instalada. Mitigação (PROPOSTA): chave Ed25519 fora do GitHub, assinada localmente pelo
dono (de preferência token de hardware ou arquivo cifrado offline), com o CI só compilando e
publicando artefatos e hash; se assinar no CI, *environment* protegido com aprovação manual e
secret restrito ao job; o binário embute duas chaves públicas (atual + próxima) para rotação;
campo de revogação assinado pela outra chave; procedimento de rotação e resposta a incidente no
SECURITY.md do C.

**A2 — Assinatura que não amarra tudo. Alta.** Cenário: o manifesto assina só o hash, e quem
controla o canal troca nome, plataforma ou versão, ou reaproveita a assinatura de outro artefato.
Mitigação (PROPOSTA): manifesto canônico (bytes exatos assinados, nunca JSON re-serializado) com
prefixo de domínio fixo (ex.: `agents-hub-update-v1\n`), `version` semântica, `serial` inteiro
monotônico, `published_at`, `expires_at` e, por artefato, `os`, `arch`, `name`, `size` e
`sha512`. O cliente verifica a assinatura Ed25519 sobre os bytes antes de fazer o parse, só então
baixa, e confere `size` e SHA-512 (o Monocypher tem SHA-512 e não SHA-256, ADR 08). No
Monocypher 4.0.3 vendorizado (`native/third_party/monocypher/monocypher.h:1`), a família padrão
`crypto_eddsa_*` é "EdDSA with curve25519 + BLAKE2b" (`monocypher.h:218`), não Ed25519; o Ed25519
("EdDSA with curve25519 + SHA-512") é `crypto_ed25519_*`, no arquivo opcional
(`optional/monocypher-ed25519.h:114-126`). A fonte não cita o RFC 8032. Requisito (PROPOSTA): usar
só `crypto_ed25519_*` e provar a conformidade com o RFC 8032 pelos vetores no CI.

**A3 — Rollback, downgrade e congelamento. Alta.** Cenário: um proxy corporativo com
interceptação TLS (MITM legítimo para o SO, o que faz o TLS sozinho não bastar) devolve um
manifesto antigo validamente assinado, rebaixando para versão vulnerável ou congelando o cliente.
Mitigação (PROPOSTA): recusar `serial` ≤ maior já visto (gravado em arquivo do usuário), recusar
`version` menor que a instalada, recusar manifesto com `expires_at` vencido (ex.: 30 dias) e
avisar no `hub doctor` e na UI; rebaixar só por ação manual explícita.

**A4 — TOCTOU entre verificação e troca. Média.** Cenário: o binário é verificado por caminho,
fechado e depois renomeado; no intervalo outro processo troca o arquivo. Contra processo do mesmo
usuário não é fronteira (SECURITY.md:397); o defeito é verificar uma coisa e instalar outra, o que
também quebra com antivírus e sincronizadores. Mitigação (PROPOSTA): staging criado só para o
usuário (0700 ou DACL só com o SID); abrir uma vez sem compartilhamento de escrita, hashear pelo
handle e renomear pelo mesmo handle (Windows `SetFileInformationByHandle(FileRenameInfo)` ⚠; Linux
`renameat` ⚠ (renomeia por caminho, não pelo fd) na mesma pasta com o fd aberto e conferência de `fstat` dev/ino antes e depois); nunca
executar nada de `%TEMP%` compartilhado.

**A5 — Troca do `.exe` em uso. Média (disponibilidade e integridade).** Renomear o executável em
execução funciona segundo relatos, sem confirmação oficial (ADR 08), e
`MOVEFILE_DELAY_UNTIL_REBOOT` exige admin. Uma troca pela metade deixa a instalação sem `hub.exe`
válido, e o hook do gate (configurado no `settings.json` do Claude e apontando para esse binário)
passa a falhar. Impacto: o agente trata hook com falha como erro não bloqueante e roda a
ferramenta (SECURITY.md:219-222) — falha aberta indireta. Mitigação (PROPOSTA): renomear
`hub.exe` para `hub.exe.old-<versão>`, mover o novo para o lugar, subir o novo e esperar
`/health` com a versão nova, restaurar o `.old` se falhar, limpar os `.old` na subida seguinte;
o mesmo para CLI, MCP e hook se forem binários separados; teste no runner Windows com o processo
vivo durante a troca; não atualizar com aprovação de gate pendente nem com sessão viva sem
consentimento na UI.

**A6 — Diretório de instalação gravável pelo usuário. Média.** Inno por usuário com
`PrivilegesRequired=lowest` (ADR 8.12) instala no perfil (⚠ o ADR 08 confirma só
`PrivilegesRequired=lowest`; o destino padrão no perfil não foi conferido na documentação do
Inno), e a AppImage também fica em pasta do usuário. Um agente sem gate (SECURITY.md:415-417) ou
um script troca `hub.exe`, que roda em todo login (autostart) e em todo `PreToolUse` do Claude.
Impacto: persistência e desligamento silencioso do gate. Mitigação (PROPOSTA): incluir a pasta de
instalação e os locais de autostart na lista embutida `exec-config` dos caminhos sensíveis (ver
D13); `hub doctor` e a UI conferem o
SHA-512 dos binários instalados contra o manifesto assinado da versão corrente (detecta troca
acidental ou de agente, não detém atacante decidido, e o texto precisa dizer isso); declarar no
SECURITY.md do C que instalação por usuário não protege o binário de processos do usuário;
instalação por máquina fica como lacuna para o dono.

**A7 — Canal: TLS, proxy, redirect e cota. Média.** Cenário: verificação de certificado
desligada "para funcionar atrás de proxy"; redirect seguido para `http:`; download sem teto;
cota anônima de 60 req/h por IP (ADR 08) esgotada. Mitigação (PROPOSTA): TLS sempre verificado
(⚠ WinHTTP com o repositório do SO; ⚠ libcurl com CA explícito — o caminho dos certificados na
AppImage está em aberto no ADR 08), sem opção de desligar; redirect só para `https:` e hosts de
uma lista fixa (github.com e o host de objetos do GitHub, a confirmar); teto = `size` do
manifesto mais um teto absoluto; checagem no máximo a cada N horas com recuo em 403/429. A
assinatura Ed25519 é a garantia; o TLS é defesa em profundidade.

**A8 — Primeiro download sem verificação. Baixa (risco aceito pelo ADR 7.14).** Sem Authenticode,
o instalador inicial não tem verificação automática. PROPOSTA: publicar manifesto assinado e
SHA-512 em cada release e documentar a verificação manual.

### 2b. Servidor HTTP próprio sobre picohttpparser (ADR 8.6)

O TS herdava do Node o parser, a semântica de `Content-Length`/`Transfer-Encoding` e os
timeouts, que não estão definidos no código (SPEC-01:53-56, :718-719). No C isso passa a ser
código do Hub. ⚠ O picohttpparser analisa linha de pedido e cabeçalhos (e decodifica chunked à
parte); a semântica fica com o Hub — conferir na fonte vendorizada.

**H1 — Parsing e ambiguidade de corpo. Alta.** Cenário: `Content-Length` duplicado e divergente,
CL + `Transfer-Encoding`, tamanho de chunk com overflow, CL negativo ou com overflow de `size_t`.
A guarda decide "sem corpo" (`daemon/src/guard.ts:100-104` usa a presença dos cabeçalhos) e o
leitor lê um corpo, ou o contrário: escapa do 415 ou estoura buffer. Mitigação (PROPOSTA): 400
para CL repetido, não decimal ou > 2^53; 400 para TE diferente de exatamente `chunked` ou junto de
CL; 400 para `Host` repetido; parse de inteiro com checagem de overflow; um único ponto decide
"tem corpo" e a guarda e o leitor usam o mesmo resultado; manter os 413/descarte de M3.

**H2 — Limites de cabeçalho e linha. Média.** PROPOSTA: linha de pedido ≤ 8 KiB (acima → 414),
bloco de cabeçalhos ≤ 16 KiB, ≤ 64 cabeçalhos (⚠ o array do picohttpparser é fixo: estourar = 431,
nunca truncar em silêncio), só HTTP/1.0 e 1.1, método fora da tabela → 404 como hoje (SPEC-01:104).

**H3 — Timeouts, keep-alive e slowloris local. Média.** Cenário: conexões mandando um byte por vez
esgotam descritores ou workers; o hook em sessão do Hub falha fechado (seguro), mas o humano também
não consegue aprovar. Autonegação: o gate segura a resposta por até 55 s (SPEC-01 §9); com N
threads e N agentes esperando aprovação, o `POST /approvals/:id` não tem quem o atenda e tudo vira
`deny`. Mitigação (PROPOSTA): laço de eventos não bloqueante, ou espera do gate que não ocupa
worker (evento acordado pela resolução, em vez do poll de 500 ms do TS,
`daemon/src/session-manager.ts:1037-1059`); leitura de cabeçalhos ≤ 10 s, ociosidade de corpo
≤ 30 s, keep-alive ocioso ≤ 5 s; resposta do gate isenta até 60 s; SSE sem teto de resposta mas
com detecção de escrita parada; teto global de conexões (ex.: 256) mais o teto SSE, com reserva
para rotas de operador. Valores finais definidos no plano e medidos.

Lacuna de H3: o TS usa poll e não evento de propósito, porque "a resolução pode vir de qualquer
processo — a CLI, o painel, o MCP —, e todos escrevem no mesmo banco. Um emissor em memória só
enxergaria quem resolvesse dentro deste processo" (`daemon/src/session-manager.ts:1033-1035`).
Trocar o poll por evento só vale se o C responder a essa razão (por exemplo, garantindo que toda
resolução passe pelo daemon, ou mantendo um poll de reserva para escritas feitas por outro
processo no banco); isso não está decidido.

**H4 — DNS rebinding. Alta, mantida.** Manter M2 byte a byte (Host loopback e porta). PROPOSTA:
recusar `Host` com caracteres fora de `[A-Za-z0-9.:\[\]-]`; testes com `Host: evil.com`,
`127.0.0.1.evil.com`, `localhost:80` e porta errada.

**H5 — CSRF a partir do navegador sem painel. Média.** Páginas web ainda alcançam `127.0.0.1`
(SECURITY.md:30). O contrato atual aceita `Origin` da própria porta porque o painel era servido
lá (`daemon/src/guard.ts:125-138`); no C não há origem legítima de navegador. Mitigação
(PROPOSTA, D2): 403 para toda requisição com `Origin` e todo método que muda estado com
`Sec-Fetch-Site` presente e diferente de `none`. CLI, hook, MCP e UI nativa não mandam esses
cabeçalhos. Manter o 415.

**H6 — Porta tomada por outro processo. Média.** Com o daemon parado, outro programa (ou outro
usuário do SO, já que o loopback é compartilhado) escuta em 4747, e a CLI manda
`Authorization: Bearer <token>` para ele (SPEC-01:262-265). Mitigação (PROPOSTA, D5):
`SO_EXCLUSIVEADDRUSE` ⚠ no Windows; o cliente só envia o token depois de confirmar que o dono do
socket é o mesmo usuário (Windows via tabela TCP estendida, PID → SID ⚠; Linux via coluna `uid` de
`/proc/net/tcp` ⚠).

**H7 — Outro usuário do SO usando rotas abertas. Média (lacuna que já existe no TS).** Em máquina
multiusuário, o usuário B faz `POST /sessions` no daemon de A e roda um agente com as credenciais
de CLI de A no repositório de A. O SECURITY.md:33 só protege o token contra outro usuário; as rotas
abertas aceitam qualquer processo local (SECURITY.md:475-477). Mitigação (PROPOSTA, D4): a mesma
checagem de dono da conexão de H6 do lado do servidor; conexão de outro SID/uid → 403 antes da
guarda.

**H8 — Bind fora do loopback. Média.** `config.json` aceita `host` arbitrário
(`daemon/src/config.ts:213`), e a guarda de `Host` não autentica quem vem da rede. PROPOSTA (D3):
recusar a subida com `host` não loopback enquanto acesso remoto estiver em aberto (ADR 07).

### 2c. Memória em C nos parsers (ADR 8.1, 8.2, 8.7–8.9)

**C1 — Classes de bug. Alta.** Overflow de buffer e de pilha; use-after-free e double-free
(⚠ cJSON e libyaml devolvem árvores e eventos com dono a gerenciar); inteiros (somas de tamanho,
`Content-Length`, chunk, `since` até 2^53 em SPEC-01:381, contadores de 64 MB por sessão, tokens e
USD); recursão sem teto (JSON aninhado, YAML, tokenizer com aninhamento 12, classificador com
profundidade 8 — SPEC-04 A6); UTF-8/UTF-16 inválido (conversões Win32 `W`, `-EncodedCommand` em
UTF-16LE).

Entrada não confiável que chega aos parsers sem ação humana:

| Origem | Parser | Por que é hostil |
|---|---|---|
| `.agents-hub/config.yaml` do repositório | libyaml + tipagem própria | lido antes do `trust` para mostrar avisos (SECURITY.md:322-349): bug aqui = execução ao registrar ou abrir um repositório clonado |
| stdout JSONL dos 9 CLIs | cJSON + mappers + leitor de linhas | o conteúdo segue o prompt injection (SECURITY.md:483-488) |
| SSE do OpenCode | decodificador SSE cliente | idem (SPEC-04 B8) |
| comando, caminho e `toolInput` no gate | tokenizer, classificador, caminhos | o agente escolhe o texto |
| HTTP de qualquer processo local | HTTP, URL, query, JSON, schemas | M2–M4 |
| stdin do hook e do MCP | JSON, JSON-RPC | o agente controla |
| `POST /workflows/validate`, `hub_workflow_run` | YAML | até 200.000 caracteres vindos do agente via MCP (SPEC-01) |
| shim `.cmd` do npm | desembrulho do shim | arquivo do perfil, gravável (SPEC-04 B5) |
| `settings.json` (JSONC), `config.toml` | JSONC e TOML | config alheia editada por `--write` (SPEC-03 §1.9) |
| manifesto de atualização | JSON | vem da rede; antes de autenticar se a ordem for errada (A2) |

**C2 — YAML: aliases e tipagem. Média.** ⚠ A libyaml entrega eventos de alias; a expansão é do
código do Hub. PROPOSTA: teto de aliases e de nós expandidos (anti "billion laughs"), teto de
documento e de profundidade. A tipagem 1.1 (`yes`/`no`, octais) fica no Hub (ADR 08); PROPOSTA:
exigir conformidade com o corpus do TS.

**C3 — PCRE2 sobre entrada hostil. Baixa.** PROPOSTA: `match limit` e `depth limit` (⚠ nomes e
semântica a conferir na PCRE2 vendorizada) em todo contexto de casamento; sem padrão vindo do
usuário.

**C4 — Fuzzing e sanitizers (PROPOSTA).** Alvos de fuzz (⚠ libFuzzer com clang no Linux; corpus
semeado com o corpus de conformidade gerado do TS):

| Id | Alvo | Oráculo além de "não quebra" |
|---|---|---|
| FZ01 | máquina de estados da conexão HTTP (pedido + guarda + leitor de corpo, CL/chunked) | guarda e leitor concordam sobre "tem corpo"; nunca lê além do teto |
| FZ02 | cJSON + validadores `.strict()` de cada rota | mesmo veredito (aceita/422) que o corpus do TS |
| FZ03 | carregador YAML (config de repo, manifestos, workflows) | teto de aliases; tipagem igual à do TS |
| FZ04 | tokenizer de shell + classificador | diferencial contra o TS: mesmo risco e mesmo `denied`; nunca `allow` onde o TS dá `escalate` |
| FZ05 | `matchSensitivePath`, normalização de caminho, `raizProibida` | diferencial contra o TS |
| FZ06 | leitor de linhas + cada mapper | linha > 16 MiB truncada com marcador |
| FZ07 | decodificador SSE cliente (OpenCode) e parser de `Last-Event-ID` | — |
| FZ08 | `hub hook`: stdin → dialeto Claude/Codex | saída sempre JSON válido ou vazia (Codex) |
| FZ09 | enquadramento JSON-RPC do MCP (stdio) | — |
| FZ10 | decodificação `%`, query e inteiros (`since`, `limit`, `before`) | — |
| FZ11 | parser do manifesto de atualização + verificação | nenhum caminho aceita assinatura inválida |
| FZ12 | `-EncodedCommand` (base64 → UTF-16LE → UTF-8) | — |
| FZ13 | desembrulho de shim `.cmd`/`.bat` | — |
| FZ14 | leitores JSONC/TOML de `hooks install`/`mcp install` | releitura do gerado = mesmo conteúdo |
| FZ15 | `escaparArgParaCmd` (Windows) | o argv reconstruído por `CommandLineToArgvW` após o `cmd.exe` é igual ao original; nenhum metacaractere vivo |

Sanitizers e endurecimento (PROPOSTA): ASan + UBSan no job clang-cl (ADR 8.2) e no Linux (clang),
com testes unitários, de integração e de conformidade sob sanitizer; fuzz curto por PR (ex.: 60 s
por alvo) e longo noturno, achados viram regressão; release Windows com `/guard:cf`,
`/DYNAMICBASE`, `/HIGHENTROPYVA`, `/NXCOMPAT`, `/CETCOMPAT`, `/sdl`; release Linux com PIE,
`-fstack-protector-strong`, `_FORTIFY_SOURCE=2`, RELRO completo + `-z now`, `-z noexecstack`;
proibidos no produto `system()`, `popen()`, `strcpy`/`sprintf` sem tamanho, checados por grep no CI.

### 2d. Cofre do SO (ADR 7.16; ADR 08)

**V1 — Limite do Credential Manager. Média.** `ProjectContextSchema` aceita valor de env até 2000
caracteres (SPEC-01:457), contados em unidades UTF-16 (`.length` do zod,
`node_modules/zod/v3/types.js:510`, zod 3.25.76); o blob do Credential Manager tem teto de 2560
bytes (`CRED_MAX_CREDENTIAL_BLOB_SIZE (5*512)`, `wincred.h:455` do Windows SDK 10.0.26100.0), e
2000 unidades dão até 4000 bytes em UTF-16 ou até 6000 em UTF-8. Mitigação (PROPOSTA), uma de duas: (a) guardar no Credential Manager só valores ≤ 2560
bytes em UTF-8 e recusar acima disso com erro claro, nunca truncar; ou (b) cifrar com DPAPI de
usuário e guardar o blob em arquivo do usuário fora do banco. Guardar o blob no próprio banco
contradiz o ADR 7.16 ("o banco guarda só a referência") e só cabe se o dono revisar essa decisão.
Em ambas, entropia adicional ligada ao id do projeto e ao nome da variável.

**V2 — DPAPI/Credential Manager não isolam do próprio usuário. Baixa (premissa).** Qualquer
processo do usuário decifra. O ganho real é contra outro usuário e contra disco ou backup copiados
para outra máquina. PROPOSTA: o SECURITY.md do C diz isso.

**V3 — Linux sem Secret Service. Média (decisão em aberto no ADR 08).** Cenário: servidor sem
sessão gráfica ou WM mínimo sem keyring; cair para texto puro em silêncio repete o TS sem avisar.
Opções para o dono (PROPOSTA): (1) arquivo 0600 em pasta 0700 (`<home>/secrets/`) com aviso
permanente na UI, no `hub doctor` e no `hub project env`; (2) recusar guardar e pedir o env de
fora (variável do ambiente do daemon); (3) arquivo cifrado com senha (quebra o autostart). Nunca
escolher em silêncio.

**V4 — Migração do texto puro e resíduos. Alta.** Fatos: o env vive em
`projects.hub_context → $.env` em texto puro (SPEC-02 §5); com `auto_vacuum = incremental` e
páginas livres, a retenção roda `PRAGMA incremental_vacuum(128)` em lotes e, no fim,
`PRAGMA wal_checkpoint(TRUNCATE)` (SPEC-02 §7, `docs/especificacao/02-banco-e-dados.md:554-556`;
`daemon/src/event-retention.ts:171-184`); o SECURITY.md:496 ainda diz "sem `VACUUM`" e diverge do
código; nenhum código em `packages/` liga `secure_delete` (grep sem ocorrência); o banco usa WAL
(SPEC-02); existem `backups/*.db` e `hub.db.pre-restore-*` (SPEC-02), e `hub backup` copia tudo
(SECURITY.md:497). Risco: o `incremental_vacuum` só devolve páginas inteiramente livres
(`store/src/repositories.ts:753`); o `UPDATE` que troca o env deixa os bytes antigos no espaço
livre de páginas ainda em uso e em páginas livres ainda não devolvidas, além do `-wal` antes do
checkpoint e dos backups, e sem `secure_delete` nada os sobrescreve (⚠ comportamento do SQLite a
conferir na fonte vendorizada).
Mitigação (PROPOSTA): migração idempotente por projeto e variável — gravar no cofre e reler para
conferir; na mesma transação trocar o valor pela referência; depois de tudo migrado,
`PRAGMA secure_delete=ON`, `wal_checkpoint(TRUNCATE)` e `VACUUM` (⚠ efeito combinado sobre os
resíduos a conferir no SQLite vendorizado); falha no cofre mantém o texto e avisa, nunca perde o
segredo; avisar que backups antigos contêm o texto e oferecer expurgo explícito. Eventos
(`payload_json`) podem conter segredo impresso pelo agente (SPEC-02); isso não é migrável e precisa
ser dito.

**V5 — Banco e pasta legíveis por outros usuários no Linux. Média (TS).** `mkdirSync` sem `mode`
(`daemon/src/config.ts:352-355`): com `umask 022`, `~/.agents-hub` fica 0755 e o banco nasce com a
permissão padrão. Mitigação (PROPOSTA, D7): pasta 0700, arquivos 0600, `umask(077)` no início do
daemon, SQLite com permissão padrão 0600 (⚠ como o SQLite define o modo dos arquivos que cria,
inclusive `-wal` e `-shm`, a conferir na fonte vendorizada).

### 2e. Bandeja, janela nativa e identidade na auditoria (ADR 7.3, 7.5; SPEC-05 §16)

**U1 — Identidade da UI. Baixa.** O painel se identificava pelo cookie (`by: web`,
`daemon/src/operator-auth.ts:178`); por cabeçalho, `X-Hub-Client: web` só vale depois do token
(`:172-175`); a SPEC-05 deixa a UI nativa não determinada. Mitigação (PROPOSTA): a UI usa o mesmo
cliente HTTP da CLI, lê o token do arquivo e manda Bearer + `X-Hub-Client: ui`, que vira
`ui:<usuário>`; registros antigos `web` continuam válidos na leitura. A etiqueta é autodeclarada
por quem tem o token: identifica a interface, não autentica uma pessoa.

**U2 — Remoção do cookie e do painel estático. Média (positivo).** Sem `GET /` com `Set-Cookie`,
some o caminho "curl forja `Sec-Fetch-*` e recebe o token" (SECURITY.md:286-292). PROPOSTA (D1): o
C não implementa cookie nem arquivos estáticos; `GET` sem rota → 404 JSON.

**U3 — Texto do agente na UI, nas notificações e no terminal. Média.** Sob injeção, o agente
imprime sequências ANSI/OSC; no terminal isso pode mudar o título, criar link enganoso, escrever na
área de transferência (conforme o terminal) ou falsificar uma linha "aprovado". O TS imprime o
texto cru (`cli/src/render.ts:41`, `:53`, `:213-215`); só o título do alerta é filtrado
(`cli/src/approval-alert.ts:23-25`). Na UI e nas notificações do SO, o texto do agente pode imitar
mensagens do Hub. Mitigação (PROPOSTA, D9): CLI troca C0/C1 (menos `\n` e `\t`) e ESC por marcador
visível; UI renderiza o markdown pendente (SPEC-05 K4) sem HTML, sem imagem remota e com link só
após confirmação mostrando a URL; notificação marca o texto do agente como tal; aprovação mostra o
comando inteiro (rolável), nunca só o começo.

**U4 — Instância e mensagens entre janela e bandeja. Baixa (PROPOSTA).** Se a UI usar canal
próprio (pipe ou socket) para trazer a janela para frente, ele precisa ser restrito ao usuário
(pipe com DACL do SID, socket abstrato ou em `$XDG_RUNTIME_DIR` 0700) e não pode executar comandos.

### 2f. Spawn de agentes

**P1 — Busca de executável pelo SO. Alta.** Se o C chamar `CreateProcessW` sem
`lpApplicationName` absoluto, ou usar `SearchPathW`, o Windows procura no diretório corrente ⚠, e o
`cwd` é o worktree de um repositório hostil que traz `git.exe` ou `claude.exe` na raiz. O resolvedor
do TS não inclui o diretório corrente (SPEC-04 B5). Mitigação (PROPOSTA): resolver por PATH ×
PATHEXT como no TS e passar sempre o caminho absoluto em `lpApplicationName`, também para `git`,
`cmd.exe` (via `%ComSpec%` validado como absoluto) e qualquer utilitário; teste com `git.exe` falso
no worktree.

**P2 — `.bat`/`.cmd` passados direto ao `CreateProcessW`. Alta.** O Windows executa `.bat`/`.cmd`
via `cmd.exe` mesmo sem shell pedido ⚠, e os argumentos passam pelo parser do `cmd` sem o escape
duplo do TS: injeção de comando a partir do prompt (classe "BatBadBut"). Mitigação (PROPOSTA): o
spawn em C recusa entregar `.bat`/`.cmd` ao `CreateProcessW` por qualquer caminho que não seja o
explícito `cmd.exe /d /s /c "<linha>"` com `escaparArgParaCmd` (SPEC-04 B5;
`adapters/src/bin-resolver.ts:347-386`), com paridade de bytes por conformidade e FZ15.

**P3 — Montagem da linha de comando no Windows. Média.** No Node, `shell:false` montava a linha
com aspas do `CommandLineToArgvW`; no C isso é código do Hub. PROPOSTA: função única com testes de
ida e volta contra `CommandLineToArgvW`; recusar NUL; teto de 32.767 caracteres ⚠ no
`CreateProcessW` e de 8.191 no ramo `cmd` (SPEC-04 B5).

**P4 — Herança de handles e descritores. Alta.** `bInheritHandles=TRUE` (necessário para os pipes)
faz o agente herdar todo handle herdável: socket de escuta, arquivo do banco, arquivo do token. No
POSIX, descritor sem `O_CLOEXEC` vaza pelo `exec`. Mitigação (PROPOSTA): Windows com
`STARTUPINFOEX` e `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` ⚠ contendo só os três pipes, e todo handle do
daemon criado não herdável; POSIX com `O_CLOEXEC`/`SOCK_CLOEXEC` em tudo e `posix_spawn` com ações
de arquivo, ou fechamento explícito acima de 2 no filho; teste em que o filho enumera os próprios
handles/fds e só encontra stdio.

**P5 — Árvore de processos. Média.** O TS usa `taskkill /pid <pid> /T /F` no Windows (PPID, sujeito
a corrida e reciclagem de PID) e grupo + `SIGKILL` no POSIX (SPEC-04 B6). Mitigação (PROPOSTA,
D14): Job Object por sessão com `KILL_ON_JOB_CLOSE` ⚠ e `TerminateJobObject` no cancelamento; no
Linux, grupo como no TS mais `PR_SET_PDEATHSIG` ⚠ no filho direto; conferir que o Claude e o Codex
funcionam dentro de job (jobs aninhados).

**P6 — Ambiente herdado. Média.** O agente recebe o ambiente do daemon mais `ctx.env` e
`AGENTS_HUB_*` (SPEC-04 B9). Agravante: sob AppImage, o `AppRun` pode alterar
`LD_LIBRARY_PATH`, `PATH` e afins (⚠ conferir o `AppRun` gerado), e agentes e `git` herdariam
bibliotecas do pacote. Mitigação (PROPOSTA): o daemon guarda o ambiente original e restaura ou
remove o que o empacotamento injeta antes de qualquer spawn; teste com `env` do filho sob AppImage
igual ao do login mais `AGENTS_HUB_*`; o token continua fora do ambiente (M5).

**P7 — Carregamento de DLL a partir do diretório corrente. Média.** `hub.exe hook` roda com `cwd`
no worktree, porque o Claude o chama de lá; uma DLL plantada pelo repositório e carregada por busca
padrão executa código no processo do gate. Mitigação (PROPOSTA):
`SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32 | LOAD_LIBRARY_SEARCH_APPLICATION_DIR)` ⚠
e `SetDllDirectoryW(L"")` no início, `/DEPENDENTLOADFLAG` ⚠ restrito no link, nenhum `LoadLibrary` com
nome relativo; no Linux, nenhum RPATH relativo ao diretório corrente.

**P8 — Linha do hook gravada em config alheia. Baixa.** O TS grava `"<node>" "<bin.js>" hook` e
reconhece "é nosso" por regex `main.js"`/`bin.js"` (SPEC-03). O caminho do perfil pode ter espaço.
No Codex o TS evita aspas de propósito: com espaço, usa o nome 8.3 e só põe aspas se ainda houver
espaço (`daemon/src/codex-gate.ts:120-153`; SPEC-04 B10), porque "Aspas sobrando é que quebra o
`%*` do `codex.cmd`" (`daemon/src/codex-gate.ts:144-148`); com o 8.3 desligado no volume, o
caminho fica com aspas e o risco continua (`:135-137`). PROPOSTA: aspas sempre no comando do hook
do Claude; no TOML do Codex, aspas só quando o segmento ainda tiver espaço, como o TS, nunca
"sempre"; caminho com espaço e sem 8.3 testado contra o `codex.cmd` real, e, se quebrar, o hook é
dado como não garantido (sem fingir proteção); nova regra de reconhecimento que só remove entradas
do Hub, com teste de não remoção de hooks de terceiros.

### 2g. AppImage e autostart (ADR 7.12, 8.12, 8.14; SPEC-03 §1.10)

**G1 — Integridade da AppImage. Média.** O AppImageUpdate não é usado (ADR 8.13). PROPOSTA: a
troca segue A4/A5; o destino vem de `$APPIMAGE` (variável de ambiente), validado como arquivo
regular do usuário (⚠ semântica de `$APPIMAGE` a conferir no runtime AppImage), com nome
esperado e SHA-512 igual ao da versão instalada antes de sobrescrever;
o novo arquivo nasce 0700 no staging e é promovido a 0755 depois de verificado.

**G2 — Autostart no Windows (Inno, HKCU `Run`). Média.** Valor do `Run` sem aspas num caminho com
espaço faz o Windows tentar prefixos do caminho como executáveis. PROPOSTA: valor sempre entre
aspas e com caminho absoluto; `hub autostart status` acusa entrada sem aspas ou apontando para
outra instalação (paridade com o aviso do TS, SPEC-03); desinstalar remove a entrada; o `.vbs`
antigo (SPEC-03) é detectado e removido na migração, para não haver autostart duplo apontando para
o Node.

**G3 — Autostart no Linux (XDG). Média.** Não existe no TS (SPEC-03). PROPOSTA:
`~/.config/autostart/agents-hub.desktop` com `Exec=` escapado pela especificação Desktop Entry
(aspas, `%` dobrado ⚠ a conferir na especificação), arquivo 0644 do usuário; `status` acusa
AppImage movida ou ausente.

**G4 — Locais de autostart como alvo de persistência. Média.** `core/src/sensitive-paths.ts` não
lista a pasta Inicializar, `~/.config/autostart` nem a pasta de instalação; a deny list tem
`reg delete`, não `reg add` (SECURITY.md:85-87). Mitigação (PROPOSTA, D13): acrescentar à lista
embutida `exec-config` a pasta Inicializar do usuário, `~/.config/autostart`, a pasta de instalação
do Hub e o `.desktop`; classificar `reg add` em `…\CurrentVersion\Run` como `irreversible`.

## 3. Requisitos de segurança verificáveis (para o plano)

| Id | Requisito | Critério de aceite testável |
|---|---|---|
| SEC-R01 | Paridade das garantias M1–M18 | A suíte de conformidade roda os casos de segurança do TS (guarda, 401 antes do corpo, 413, `MALFORMED_URL`, ids, classificador, caminhos sensíveis, gate, modo de falha) contra o C, 100% verde |
| SEC-R02 | As 13 rotas de operador exigem token | Teste percorre a tabela de rotas do C: sem token → 401 em todas, antes de ler o corpo (corpo inválido também dá 401) |
| SEC-R03 | Sem cookie e sem painel estático (PROPOSTA D1) | `GET /` com `Sec-Fetch-*` de navegação → 404 JSON sem `Set-Cookie`; grep sem `Set-Cookie` |
| SEC-R04 | CSRF sem origem legítima (PROPOSTA D2) | Qualquer `Origin` → 403; POST com `Sec-Fetch-Site` ≠ `none` → 403; CLI, hook, MCP e UI passam |
| SEC-R05 | DNS rebinding | `Host` não loopback, com porta errada ou com sufixo → 403 (paridade M2, `daemon/src/guard.ts:54-59`); repetido → 400 (PROPOSTA H1) e com caractere inválido → recusado (PROPOSTA H4) |
| SEC-R06 | Ambiguidade de corpo (PROPOSTA H1) | CL repetido divergente, CL+TE, TE ≠ `chunked`, CL não decimal ou com overflow, chunk com overflow → 400 e conexão fechada; em teste de integração e em FZ01 |
| SEC-R07 | Limites de cabeçalho (PROPOSTA H2) | Linha > 8 KiB → 414; cabeçalhos > 16 KiB ou > 64 → 431; nada truncado em silêncio |
| SEC-R08 | Timeouts definidos (PROPOSTA H3) | Cliente que manda 1 byte/s tem a conexão fechada no teto; keep-alive ocioso fechado no teto; valores no plano |
| SEC-R09 | Gate não esgota o servidor (PROPOSTA H3, inclusive os números "64 gates" e "< 1 s") | Com 64 gates esperando aprovação, `POST /approvals/:id` responde em < 1 s e libera o gate correspondente |
| SEC-R10 | Teto global de conexões (PROPOSTA H3) | Acima do teto, conexão nova recusada; rotas de operador atendidas pela reserva |
| SEC-R11 | Só loopback (PROPOSTA D3) | `host: "0.0.0.0"` → o daemon não sobe, com `HUB_CONFIG_INVALID` |
| SEC-R12 | Dono da conexão (PROPOSTA D4) | Em máquina com dois usuários (CI Linux com `useradd`), conexão do segundo usuário → 403 |
| SEC-R13 | Cliente não entrega token a impostor (PROPOSTA D5) | Servidor falso de outro usuário na porta → a CLI recusa sem mandar `Authorization` |
| SEC-R14 | `SO_EXCLUSIVEADDRUSE` no Windows (PROPOSTA D5) | Segundo `bind` na mesma porta com `SO_REUSEADDR` falha com o daemon no ar |
| SEC-R15 | Token restrito por SID (PROPOSTA D6) | Windows: DACL do arquivo = só o SID do usuário, sem herança, aplicada na criação e reconferida a cada subida; POSIX 0600 |
| SEC-R16 | Pasta e arquivos privados (PROPOSTA D7) | Linux com `umask 022`: home 0700; `hub.db*`, token, segredos e logs 0600 |
| SEC-R17 | Manifesto de atualização assinado (PROPOSTA A2) | Assinatura inválida, byte alterado, chave desconhecida, `os/arch` trocados, `size`/SHA-512 divergentes → recusa sem gravar fora do staging; vetores RFC 8032 passam |
| SEC-R18 | Anti-rollback e expiração (PROPOSTA A3) | `serial` ≤ visto, `version` menor que a instalada ou `expires_at` vencido → recusa e aviso no `hub doctor` |
| SEC-R19 | Verificar e instalar os mesmos bytes (PROPOSTA A4) | Alterar o staging entre download e troca → o instalado tem o SHA-512 do manifesto ou a atualização aborta |
| SEC-R20 | Troca do binário com rollback (PROPOSTA A5) | Runner Windows: troca com o processo vivo; novo binário sem `/health` → restaura o anterior; hook responde durante e depois |
| SEC-R21 | Canal de download (PROPOSTA A7) | TLS inválido → falha (sem opção de desligar); redirect para `http:` ou host fora da lista → falha; download > `size` → abortado |
| SEC-R22 | Chave privada fora do repositório (PROPOSTA A1) | Documento de release descreve onde a chave fica e a rotação; grep no repositório e nos workflows sem material de chave privada; duas chaves públicas embutidas |
| SEC-R23 | Cofre sem truncar (PROPOSTA V1) | Valor de 2000 caracteres multibyte: gravado e relido igual, ou recusado com erro explícito; nunca truncado |
| SEC-R24 | Migração do env (PROPOSTA V4) | Banco v10 com env em texto → depois da migração, o valor não aparece em `hub.db`, `-wal` nem páginas livres (leitura bruta); falha simulada do cofre mantém o texto e avisa |
| SEC-R25 | Linux sem Secret Service (PROPOSTA V3) | Com D-Bus sem Secret Service, segue a política do dono e `hub doctor` mostra o estado; nenhum caminho grava segredo em texto sem aviso |
| SEC-R26 | Busca de executável sem cwd (PROPOSTA P1) | `git.exe`/`claude.exe` falsos na raiz do worktree nunca são executados (integração Windows) |
| SEC-R27 | `.bat`/`.cmd` só pelo caminho explícito (PROPOSTA P2) | Shim `.cmd` não reconhecido com prompt contendo `& \| > % " ^` e aspas desbalanceadas → argv recebido idêntico; nenhum comando extra |
| SEC-R28 | Sem herança de handles (PROPOSTA P4) | O filho enumera handles/fds: só stdin, stdout e stderr |
| SEC-R29 | Árvore morta de verdade (PROPOSTA P5/D14) | Agente falso com netos: cancelar mata todos (Windows via Job, Linux via grupo); daemon morto à força → filhos mortos ou recolhidos na subida |
| SEC-R30 | Ambiente limpo sob AppImage (PROPOSTA P6) | `env` do agente sob AppImage = ambiente de login + `AGENTS_HUB_*`; nenhuma variável do token |
| SEC-R31 | DLL sem diretório corrente (PROPOSTA P7) | `hub.exe hook` com DLL plantada no cwd não a carrega (DLL que grava marcador) |
| SEC-R32 | Saída de terminal saneada (PROPOSTA D9) | Evento com ESC/OSC/C1 → `hub watch` imprime marcador visível, nenhum ESC vindo do payload |
| SEC-R33 | Aprovação mostra a ação inteira (PROPOSTA U3) | Comando de 10.000 caracteres com a parte perigosa no fim: UI e CLI exibem o fim |
| SEC-R34 | Fuzzing contínuo (PROPOSTA C4) | FZ01–FZ15 rodam no CI (curto por PR, longo noturno); quebra em sanitizer falha o job; FZ04/FZ05 sem divergência contra o corpus do TS |
| SEC-R35 | Sanitizers e endurecimento (PROPOSTA C4) | Testes sob ASan+UBSan (clang-cl e clang Linux) verdes; conferência automática das flags no binário de release; grep sem `system(`/`popen(`/`strcpy(`/`sprintf(` |
| SEC-R36 | YAML com tetos (PROPOSTA C2, inclusive os números "< 100 ms e < 10 MB") | Documento com alias exponencial → erro em < 100 ms e < 10 MB; `config.yaml` hostil não derruba o daemon |
| SEC-R37 | PCRE2 com limites (PROPOSTA C3) | Entrada patológica contra cada regex embutida termina com erro de limite, sem travar a thread |
| SEC-R38 | Autostart seguro (PROPOSTA G2/G3) | Entrada `Run` entre aspas e absoluta; `.desktop` escapado; `hub autostart status` acusa entrada sem aspas, obsoleta ou duplicada (`.vbs` do TS) |
| SEC-R39 | Locais de persistência sensíveis (PROPOSTA D13) | Escrita na pasta de instalação, Inicializar, `~/.config/autostart` e `reg add …\Run` → `irreversible` |
| SEC-R40 | Integridade instalada detectável (PROPOSTA A6) | `hub doctor` acusa binário com SHA-512 diferente do manifesto da versão |
| SEC-R41 | SECURITY.md do C (M18: paridade; novas premissas: PROPOSTA V2/A6/A1) | Republicado com M18, as novas premissas (cofre não isola do próprio usuário, instalação por usuário, atualizador) e cada garantia citando o arquivo C |

## 4. Divergências de segurança do TS que se recomenda corrigir no C

Todas são recomendação; a decisão é do dono. Onde o contrato HTTP muda, o ADR 7.6/7.10 pede
decisão explícita. Isso vale para D1, D2 e D16–D18 e para toda resposta nova proposta na
seção 2b (H1–H8).

| Id | Comportamento do TS | Fonte | Recomendação | Justificativa |
|---|---|---|---|---|
| D1 | Cookie `hub_operator` entregue a quem manda `Sec-Fetch-*` de navegação, forjável por `curl` | SPEC-01 §4; SECURITY.md:286-292; `daemon/src/operator-auth.ts:210-225` | Não implementar cookie nem painel estático | Não há painel (ADR 7.3); tira um caminho sem token e a superfície de traversal |
| D2 | `Origin` da própria porta é aceito | `daemon/src/guard.ts:66-73`, `:125-138` | Recusar todo `Origin` e todo `Sec-Fetch-Site` ≠ `none` em método que muda estado | Sem origem web legítima, qualquer `Origin` é página ou forja |
| D3 | `host` arbitrário no `config.json` | `daemon/src/config.ts:213`; SECURITY.md:473-481 | Recusar host não loopback | A guarda de `Host` não autentica clientes da rede; acesso remoto está em aberto |
| D4 | Rotas abertas aceitam qualquer processo local, inclusive de outro usuário do SO | SECURITY.md:33, :475-477 | Checar se o dono da conexão é o mesmo usuário | Fecha execução de agente como outro usuário sem mudar a premissa do mesmo usuário |
| D5 | O cliente manda o token para o que estiver na porta | SPEC-01:262-265; a porta é o lock (SPEC-01) | Conferir o dono do socket antes de mandar o token; `SO_EXCLUSIVEADDRUSE` | Impede que um impostor na porta colha o token |
| D6 | ACL por `icacls` chamado por nome, principal de `USERDOMAIN`; token existente dado como restrito sem conferir; falha só gera aviso | `daemon/src/operator-auth.ts:75`, `:85-90`, `:122-136` | DACL por SID na criação (API Win32), conferida a cada subida; na falha, não habilitar rotas de operador ou não subir (dono decide) | Variável de ambiente não é identidade; token com permissão herdada passa despercebido |
| D7 | Pasta e banco criados sem modo explícito | `daemon/src/config.ts:352-355` | 0700/0600 e `umask(077)` | Outro usuário do SO lê eventos e prompts no Linux |
| D8 | Timeouts e limites de cabeçalho não definidos (padrões do Node) | SPEC-01:53-56, :718-719 | Valores explícitos (H2/H3) no plano | No C não há padrão herdado |
| D9 | Texto do agente impresso cru no terminal | `cli/src/render.ts:41`, `:53`, `:213-215` | Sanear C0/C1/ESC | Injeção de sequências de terminal via prompt injection |
| D10 | Env em texto puro no banco; nenhum `secure_delete`; a retenção devolve só páginas inteiramente livres (`incremental_vacuum(128)` + `wal_checkpoint(TRUNCATE)`), e o SECURITY.md:496 ainda diz "sem `VACUUM`", divergindo do código; env em texto vai para os backups | `daemon/src/event-retention.ts:171-184`; SPEC-02 §7 (`docs/especificacao/02-banco-e-dados.md:554-556`), §8; SECURITY.md:490-497 | Na migração para o cofre, `secure_delete` + checkpoint + `VACUUM` e aviso sobre backups (V4) | O `UPDATE` deixa os bytes antigos em páginas em uso e livres; sem isso, o segredo fica recuperável |
| D11 | Filtros `sessionId`/`rootId` sem validação de formato | SPEC-01:720-724 | Validar formato e tratar inválido como inexistente | Menos entrada livre chegando ao banco |
| D12 | `POST /sessions/:id/cancel` engole erro de corpo, inclusive 413 | SPEC-01:728-730 | Manter a resposta (paridade), mas com o leitor aplicando teto e descarte | Evita que "engolir" vire "ler sem limite" |
| D13 | Caminhos sensíveis sem pasta de instalação nem autostart; `reg add` em `Run` não é `irreversible` | `core/src/sensitive-paths.ts`; SECURITY.md:85-87 | Acrescentar à lista embutida (G4) | Instalação por usuário + hook global tornam esses locais o meio mais simples de persistir |
| D14 | Árvore de processos por `taskkill /T` (PPID) | SPEC-04 B6 | Job Object por sessão | Sem corrida de reciclagem de PID |
| D15 | Identidade `web` só pelo cookie | `daemon/src/operator-auth.ts:172-178`; SPEC-05 | `X-Hub-Client: ui` → `ui:<usuário>` | Auditoria distingue UI de CLI sem cookie |
| D16 | Na guarda, cabeçalho repetido vale pelo primeiro valor (inclusive `Host` e `Content-Length`) e "tem corpo" é decidido pela presença de `Transfer-Encoding`/`Content-Length`; o parsing CL/TE em si fica com o Node, sem regra no código do Hub (⚠ o que o Node já recusa não foi conferido) | `daemon/src/guard.ts:54`, `:99-102`, `:146-149` | 400 para CL repetido, não decimal ou > 2^53, TE ≠ `chunked` ou junto de CL, `Host` repetido; um só ponto decide "tem corpo" (H1) | Muda resposta do contrato HTTP (ADR 7.6); sem isso, guarda e leitor podem discordar sobre o corpo |
| D17 | Limites de linha de pedido e de cabeçalhos não definidos (padrões do Node), sem 414/431 próprios | SPEC-01:53-56 | Linha > 8 KiB → 414; cabeçalhos > 16 KiB ou > 64 → 431 (H2) | Muda resposta do contrato HTTP (ADR 7.6); no C não há padrão herdado e truncar em silêncio esconde cabeçalho |
| D18 | `Host` aceito se, sem a porta e sem colchetes, for `127.0.0.1`, `localhost` ou `::1`; `Host` ausente passa | `daemon/src/guard.ts:54-55`, `:116-122` | Recusar `Host` com caractere fora de `[A-Za-z0-9.:\[\]-]`, além de M2 (H4) | Muda resposta do contrato HTTP (ADR 7.6); fecha variações de `Host` que um parser próprio em C pode tratar diferente do Node |

## 5. Lacunas (não decididas)

- **L1:** o ADR 08 não traz biblioteca TOML nem leitor JSONC; o TS relê o TOML gerado antes de
  gravar e aceita JSONC em `settings.json` (SPEC-03).
- **L2:** política do cofre no Linux sem Secret Service (ADR 08).
- **L3:** onde fica a chave privada e quem assina (A1).
- **L4:** instalação por máquina (admin) para quem quer o binário fora do alcance do usuário (A6).
- **L5:** valores finais de timeouts e tetos de conexão (H3), a medir.
- **L6:** formato da referência ao segredo no banco e nome das entradas no cofre (SPEC-02).
- **L7:** os IDs SEC-R precisam ser ligados às tarefas do plano (`docs/17`).
