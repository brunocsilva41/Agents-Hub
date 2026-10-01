# F7-01 — Proposta de desenho: migração do banco e cofre do SO

> Proposta para o dono decidir **DA-01**, **DA-02** e **DA-03** (`docs/17-plano-reescrita-c.md`,
> seção de decisões abertas). **Nada aqui está decidido.** Cada alternativa é uma **opção**, com prós
> e contras. A única preferência expressa está na seção 7, marcada como **recomendação do autor**, e
> não vale como decisão. Fatos trazem fonte: seção de SPEC, `arquivo:linha` (caminhos relativos a
> `packages/`, salvo indicação) ou cabeçalho de biblioteca vendorizada em `native/third_party/`.
> ⚠ marca afirmação não conferida na fonte. Nomes de arquivo, chave ou entrada escritos aqui como
> exemplo são **ilustrativos**: não existem no código nem no plano.
> Escrita em 2026-09-30. Revisão final do security-auditor: aprovado com ressalvas (R1, aplicada
> nesta versão, junto com as 13 correções da primeira revisão). A seção 8 lista o que a revisão confere.

## 0. O que cada decisão cobre

| Decisão | Pergunta | Bloqueia | Fonte |
|---|---|---|---|
| DA-01 | O que o C faz no Linux quando não há Secret Service | início de F7-04 | ADR 08 "Em aberto"; modelo de ameaças V3, L2 |
| DA-02 | Formato da referência no banco, nome das entradas no cofre, destino de `memory`/`prompts` | início de F7-03, F7-04; F7-05 | SPEC-02 §5; ADR 7.16; modelo de ameaças L6 |
| DA-03 | Desenho da migração na primeira execução: em lugar ou cópia, migração 11, fatos de SPEC-02 §10 | início de F7-02 | ADR 7.15; SPEC-02 §10 |

A limpeza de resíduos (modelo de ameaças V4, D10) aparece na seção 5. Ela depende das três decisões.

## 1. Fatos de partida

### 1.1 O banco de origem (SPEC-02 §10)

| # | Fato | Fonte |
|---|---|---|
| F1 | `migrations.version` vai de 1 a 10. O TS recusa banco com versão maior que a que conhece (`HUB_CONFIG_INVALID`) e migra em ordem o banco com versão menor. | SPEC-02 §1.2, §10; `store/src/db.ts:63-75` |
| F2 | `events.cost_tokens` e `events.cost_usd` são colunas geradas `VIRTUAL`. Não há dado a copiar, mas `idx_events_custo_soma` usa a definição. | SPEC-02 §2.1, §10; `store/src/migrations.ts:255-269` |
| F3 | `events.task_id` não tem FK. Pode haver linhas órfãs anteriores à v10. O gatilho `trg_events_task_existe` vale só para `INSERT` novo. | SPEC-02 §2.1, §10; `store/src/migrations.ts:302-312` |
| F4 | `project_folders.id` pode ter o formato `pfd_prj_…` (backfill da v2). `FolderIdSchema` aceita os dois formatos: `^pfd_(?:prj_)?[a-z0-9]+$`, sem diferenciar maiúsculas. | SPEC-02 §2.1, §10; SPEC-01:157; `daemon/src/http-schemas.ts:33` |
| F5 | `TEXT PRIMARY KEY` aceita NULL no SQLite. O TS sempre grava id. | SPEC-02 §3, §10 |
| F6 | O banco pode estar com `auto_vacuum = none`: anterior ao R09-07 e com mais de 64 MiB de dado vivo, ou quando a conversão na subida falhou. A conversão é um `VACUUM` completo que custou ≈26 ms por MB de dado vivo. | SPEC-02 §7, §10; `daemon/src/event-retention.ts:24-33`; `daemon/src/hub.ts:195-197` |
| F7 | `sessions.workdir` e `artifacts.path` guardam caminhos **absolutos**. Se o C mudar o home ou o layout, eles apontam para o lugar antigo. | SPEC-02 §6.4, §10 |
| F8 | `projects.hub_context → $.env` é o **único** segredo do usuário no banco. | SPEC-02 §5, §10 |

### 1.2 O segredo e quem o usa

| # | Fato | Fonte |
|---|---|---|
| S1 | `hub_context` é JSON `{"memory"?, "prompts"?: {agentId: texto}, "env"?: {agentId: {VAR: valor}}}`, em texto puro. | SPEC-02 §5; `core/src/domain.ts:108-114` |
| S2 | Limites de entrada: `memory` ≤ 20.000; prompt ≤ 8.000; id de agente ≤ 64; nome da variável ≤ 128; valor ≤ 2.000 (unidades UTF-16, P2). O id de agente usado como chave de `prompts` e `env` não tem restrição de caracteres, ao contrário de `AgentIdParamSchema` (`^[a-z0-9][a-z0-9_-]*$`). | SPEC-01:455-457; `daemon/src/http-schemas.ts:64-76`, `:69`, `:74`, `:201-205` |
| S3 | A sanitização filtra o **nome** da variável por lista de permissão (14 prefixos e 2 nomes exatos). Ela não cifra o valor e não restringe os caracteres depois do prefixo. | SPEC-02 §5; `core/src/agent-env.ts:52-104`; `daemon/src/repo-trust.ts:171-192` |
| S4 | A gravação substitui o `hub_context` inteiro (`UPDATE projects SET hub_context = ?`). | `store/src/repositories.ts:129-131`; `daemon/src/project-registry.ts:163-167` |
| S5 | `hub_context` ilegível vira `{}` sem derrubar o daemon. O texto ilegível continua na coluna. | SPEC-02 §5; `store/src/repositories.ts:115-127` |
| S6 | `GET /projects/:id/context` **não** exige token de operador e devolve o contexto do Hub inteiro, com os valores de env. A CLI mascara na exibição. | SPEC-01 linha 17 da tabela de rotas; `daemon/src/server.ts:597-603`; `daemon/src/project-registry.ts:153-156`; SPEC-03 (`hub project env`) |
| S7 | `PUT /projects/:id/context` exige token; a auditoria registra só as chaves (`detail.envAgents`). | SPEC-01 linha 18; `daemon/src/server.ts:606-624` |
| S8 | O env do repositório (`.agents-hub/config.yaml`) é outra camada, fora do banco. Quando as duas existem, a do Hub vence variável a variável. | SECURITY.md:345-349 |
| S9 | `events.payload_json` e `raw_json` podem conter segredo que o agente leu ou imprimiu. Isso não é migrável para o cofre. | SPEC-02 §5; modelo de ameaças V4 |

### 1.3 Onde o texto puro sobrevive

| # | Fato | Fonte |
|---|---|---|
| R1 | O banco usa WAL (`hub.db-wal`, `hub.db-shm`). | SPEC-02 §1.1 |
| R2 | Existem cópias inteiras do banco: `backups/hub-AAAAMMDD-HHMMSS.db` e `hub.db.pre-restore-AAAAMMDD-HHMMSS[-N]` (com `-wal`/`-shm` crus quando o `VACUUM INTO` falha). | SPEC-02 §6, §8.3 |
| R3 | Nenhum código em `packages/` liga `secure_delete`. | `grep secure_delete packages/` → 0 ocorrências (conferido nesta proposta) |
| R4 | O SQLite vendorizado é o 3.53.4, compilado só com `SQLITE_THREADSAFE=1`, logo sem `SQLITE_SECURE_DELETE`. | `native/third_party/sqlite/sqlite3.h:149`; `native/third_party/VERSIONS.md:28-32` |
| R5 | No SQLite vendorizado, `secure_delete` zera o conteúdo **no momento em que ele é apagado**: `ON` zera dentro da página e grava de volta as folhas da freelist; `FAST` zera dentro da página, mas não grava as folhas da freelist. Conteúdo apagado antes de ligar o pragma não é zerado depois. | `native/third_party/sqlite/sqlite3.c:76388-76404`, `:75218-75221` |
| R6 | `incremental_vacuum` só devolve páginas inteiramente livres. | `store/src/repositories.ts:753` |
| R7 | `hub backup` copia o banco inteiro. | SECURITY.md:497 |

### 1.4 Plataforma

| # | Fato | Fonte |
|---|---|---|
| P1 | Credential Manager: blob de no máximo `5*512` = 2560 bytes; nome do alvo genérico até 32.767 caracteres; nome de usuário até 513. | Windows SDK 10.0.26100.0, `um/wincred.h:257`, `:254`, `:455` (conferido nesta máquina) |
| P2 | O teto de 2.000 do valor conta unidades UTF-16 (`.length` do JavaScript, no zod 3.25.76). No limite, o valor dá até 4.000 bytes em UTF-16 e até 6.000 em UTF-8 (3 bytes por unidade no BMP; fora do BMP, 4 bytes por 2 unidades). Os dois passam de 2560. O modelo de ameaças V1 diz 8.000 em UTF-8 (ver §9). | `daemon/src/http-schemas.ts:74`; `node_modules/zod/v3/types.js:510`; `node_modules/zod/package.json:3`; S2 |
| P3 | Persistência do Credential Manager: `CRED_PERSIST_SESSION`, `LOCAL_MACHINE`, `ENTERPRISE`. ⚠ Efeito de cada um em perfil móvel: não conferido. | `um/wincred.h:460-463` |
| P4 | DPAPI: `CryptProtectData` tem a flag `CRYPTPROTECT_LOCAL_MACHINE`, que deixa qualquer usuário da máquina decifrar. | `um/dpapi.h:138-140`, `:184` |
| P5 | DPAPI e Credential Manager não isolam do próprio usuário: qualquer processo dele decifra. O ganho é contra outro usuário e contra disco ou backup levados para outra máquina. | Modelo de ameaças V2; SECURITY.md:397-404 |
| P6 | O Monocypher vendorizado (4.0.3) tem AEAD (`crypto_aead_lock`) e Argon2 (`crypto_argon2`). | `native/third_party/monocypher/monocypher.h:82`, `:181`; `VERSIONS.md:17` |
| P7 | O ADR 08 não traz biblioteca para falar com o Secret Service (libsecret, D-Bus). | `docs/decisoes/08-pilha-tecnica-c.md:10-27` (tabela de decisões); grep por `libsecret`/`D-Bus` em `docs/` sem resultado de decisão |

### 1.5 Convivência com o TS instalado

| # | Fato | Fonte |
|---|---|---|
| C1 | O plano resolve o home do C como o do TS: `AGENTS_HUB_HOME` ou `~/.agents-hub`. | F0-05 em `docs/17-plano-reescrita-c.md:133-142`; SPEC-02 §1 |
| C2 | O store do C deve abrir um banco v10 gerado pelo TS e migrar banco v<10. | F1-08 em `docs/17-plano-reescrita-c.md:351-360` |
| C3 | A porta é o lock de instância. O TS usa 4747, ou `AGENTS_HUB_PORT`, ou `port` do `config.json`. | Modelo de ameaças M1; SPEC-02 §6.1 |
| C4 | O restore do TS recusa rodar se `/health` responder. | SPEC-02 §8.3; `cli/src/backup-cmd.ts:62-66` |
| C5 | O TS sobe no login do Windows por um `.vbs` na pasta Inicializar (`hub autostart`). | ADR 07 "Contexto"; SPEC-03 §1.10 |
| C6 | `config.json` pode apontar `dbFile` para fora do home. | SPEC-02 §6.1 |
| C7 | `conferirBanco` aceita banco de versão menor; ele é migrado na próxima abertura. Restaurar um backup antigo traz de volta o que havia nele. | SPEC-02 §8.2 |

## 2. DA-03 — migração do banco

### 2.1 Onde a migração escreve

**Opção M-A — em lugar.** O C abre `<home>/hub.db` (ou o `dbFile` do `config.json`) e altera o
próprio arquivo.
- Prós: um banco só; mesmo home do TS (C1) e mesmo esquema (C2), então os caminhos absolutos
  continuam válidos (F7); sem duplicar espaço em disco.
- Contras: falha no meio exige transação e idempotência; não há volta ao TS sem uma cópia anterior
  (2.5).

**Opção M-B — cópia para banco novo.** O C copia para outro arquivo (nome ilustrativo:
`<home>/hub-c.db`) e passa a usar só a cópia. O `hub.db` do TS fica intocado.
- Prós: volta ao TS imediata, sem restore; falha na cópia não toca na origem.
- Contras: o `hub.db` antigo **continua com o env em texto puro** (F8), contra o objetivo do ADR 7.16,
  até alguém apagá-lo; dois bancos divergem se o usuário alternar entre TS e C; se a cópia for feita
  por `INSERT … SELECT` num esquema novo, o gatilho de F3 recusa as linhas órfãs e as colunas
  geradas (F2) precisam ser recriadas com a mesma definição; `VACUUM INTO` (como o backup de
  SPEC-02 §8.1) evita os dois problemas, mas copia também o texto puro.

**Opção M-C — em lugar, com cópia de segurança antes.** Como M-A, mas antes guarda o banco com
`VACUUM INTO`, no padrão do `hub.db.pre-restore-*` (SPEC-02 §8.3). Nome ilustrativo:
`hub.db.pre-c-AAAAMMDD-HHMMSS`.
- Prós: falha ou arrependimento têm volta pelo restore; reusa um padrão que o TS já tem.
- Contras: a cópia contém o env em texto puro (R2). Ela vira mais um resíduo para a seção 5. Por
  isso precisa nascer restrita (0600 no POSIX, DACL só do SID do usuário no Windows: modelo de
  ameaças D7, SEC-R16, SEC-R15) e **sem** o fallback do restore do TS, que copia `.db`, `-wal` e
  `-shm` crus quando o `VACUUM INTO` falha (SPEC-02 §8.3): se o `VACUUM INTO` falhar, a migração
  para.

### 2.2 Migração 11

**Opção V-A — o C registra uma migração 11 em `migrations`.**
- Prós: o banco passa a dizer que foi migrado pelo C; o TS recusa abrir (F1), o que impede um TS
  antigo de rodar sobre um banco cujas referências ele não entende (ver 3.1, R-A); permite DDL nova
  (tabela de referências, opção R-C).
- Contras: volta ao TS só por restore de uma cópia anterior (M-C) ou por uma rotina de reversão que
  o plano não prevê; o C passa a ter uma migração que o TS não tem, e o F1-08 hoje fala em
  "migrações 1 a 10".

**Opção V-B — sem migração 11.** O esquema fica na v10; a mudança fica dentro do JSON de
`hub_context`.
- Prós: TS e C abrem o mesmo arquivo; não há DDL nova.
- Contras: nada no banco impede o TS de abri-lo depois; o efeito disso depende do formato da
  referência (3.1); a marca de "já migrado" precisa morar em outro lugar.

### 2.3 Quando migrar e como garantir o TS parado

**Opção Q-A — na subida do serviço C, com a porta presa e sem servir.** O serviço faz `bind`/`listen`
na porta antes de migrar (o lock de instância, C3) e só começa a atender depois de terminar.
- Prós: nenhuma sessão nem cliente vê o banco pela metade; outro serviço não sobe no meio; acontece
  sem ação do usuário.
- Contras: atrasa a subida (o `VACUUM` custa ≈26 ms/MB, F6); se o cofre pedir interação (Linux,
  keyring travado ⚠), a subida fica presa, então a chamada ao cofre precisa de timeout, com o texto
  mantido e aviso.

**Opção Q-B — no instalador (Inno Setup, Windows) ou na primeira abertura da janela.**
- Prós: o usuário vê o progresso e o resultado.
- Contras: o AppImage não tem instalador (ADR 7.12); quem usa só a CLI ou o autostart não passa pela
  janela; duplica o código em dois pontos de entrada.

**Opção Q-C — por comando explícito.** É requisito **novo**: o plano e a SPEC-03 não têm esse
comando.
- Prós: o usuário escolhe a hora e pode fazer backup antes.
- Contras: até lá o C roda sobre o env em texto; contradiz "na primeira execução" do ADR 7.15.

Para garantir que o TS está parado, as opções combináveis são:
- **T-1:** chamar `/health` na porta efetiva (variável, `config.json`, 4747) e recusar se responder,
  como o restore do TS (C4). Não cobre um TS na mesma pasta com outra porta.
- **T-2:** contar com o lock da porta (C3): se o serviço C conseguiu a porta, nenhum outro serviço a
  tem. Não cobre TS em outra porta com o mesmo home.
- **T-3:** tratar o autostart do TS (C5): detectar o `.vbs` e avisar ou remover. Remover é ação sobre
  arquivo fora do home (pasta Inicializar) e pede decisão explícita.

### 2.4 Gatilho: uma vez ou a cada abertura

**Opção G-A — uma vez**, com marca de concluído.
- Prós: custo zero nas subidas seguintes.
- Contras: depende de onde mora a marca. **Marca dentro do banco** (migração 11, V-A): um backup v10
  restaurado (C7) volta sem a marca, e a migração roda de novo; não há risco por esse caminho.
  **Marca fora do banco** (arquivo no home, config): o banco restaurado traz o env em texto de volta
  e a marca diz "migrado", então nada roda.

**Opção G-B — idempotente, a cada abertura.** O C procura valor em texto em `$.env` e migra o que
achar.
- Prós: cobre restore de backup antigo e falha parcial anterior.
- Contras: custo de ler `projects` a cada subida (tabela pequena; ⚠ não medido); precisa distinguir
  valor em texto de referência sem ambiguidade (3.1); só detecta texto **vivo** em `$.env`. O
  resíduo deixado por um `VACUUM` ou checkpoint que falhou (seção 5) não aparece nessa busca. Para
  cobri-lo, G-B precisa de uma marca persistente de "limpeza pendente", gravada antes da primeira
  troca e removida só depois de um `wal_checkpoint(TRUNCATE)` completo (5.1).

### 2.5 Rollback

**Opção B-A — cópia de segurança antes (M-C) e restore.**
- Prós: volta completa ao estado anterior.
- Contras: a cópia guarda o texto puro; enquanto existir, o objetivo do ADR 7.16 não está cumprido
  no disco.

**Opção B-B — reversão pelo cofre.** O C lê o cofre e regrava o env em texto no banco.
- Prós: não precisa manter cópia com texto puro.
- Contras: rotina nova, fora do plano; reescreve segredo em texto de propósito.

**Opção B-C — sem volta, com migração que nunca perde dado.** O cofre não participa da transação do
SQLite. Por isso a ordem, por variável, é:
1. grava no cofre: com N-A/N-B/N-C, sob nome determinístico (3.2); com N-D, sob o id já gravado na
   tabela de R-C numa transação anterior (sem trocar ainda o valor);
2. relê a entrada e compara os bytes com o valor do banco;
3. `BEGIN IMMEDIATE`;
4. confere que o valor no banco não mudou desde o passo 1;
5. troca só essa variável (`json_set`/`json_remove` sobre `hub_context`, ou linha em R-C);
6. `COMMIT`.

Falha no cofre mantém o texto e avisa (modelo de ameaças V4). Queda entre passos deixa o texto no
banco e uma entrada no cofre; a próxima execução regrava a entrada (mesmo nome; com N-D, reaproveita o id gravado) e segue.
- Prós: nenhuma cópia extra com texto; falha durante a migração não perde segredo.
- Contras: voltar ao TS deixa o env vazio ou com referências (depende de 3.1 e 2.2); **perder o cofre
  depois** (entrada apagada, perfil recriado, outra máquina) perde o segredo. `hub doctor` e o spawn
  do agente precisam acusar referência sem entrada.

### 2.6 Cada fato de SPEC-02 §10

| Fato | Opções |
|---|---|
| F1 versão 1–10 | (a) migrar v<10 até v10 pelo executor de F1-08 e só então tratar o env; (b) recusar v<10 e pedir que o TS abra antes. Versão > 10 (ou > 11 com V-A): recusar, como o TS. |
| F2 colunas geradas | Em lugar (M-A/M-C): nada a fazer. Cópia (M-B) por `INSERT`: recriar a definição idêntica antes de `idx_events_custo_soma`. Teste: comparar `PRAGMA table_xinfo` com o do TS. |
| F3 órfãos de `events.task_id` | (a) manter, como o TS (o gatilho só barra `INSERT` novo); (b) manter e contar no relatório da migração; (c) apagar ou anular `task_id`, o que muda dado e não tem paralelo no TS. Cópia por `INSERT` com o gatilho ativo falha nessas linhas. |
| F4 `pfd_prj_…` | (a) manter: `FolderIdSchema` já aceita; (b) renomear para `pfd_<24 hex>`, o que muda id visível pela API sem ganho funcional conhecido. |
| F5 PK NULL | (a) aceitar e não tocar; (b) contar linhas com id NULL e relatar; (c) recusar a migração se houver. |
| F6 `auto_vacuum = none` | (a) converter sempre, aproveitando o `VACUUM` da limpeza (seção 5), com custo ≈26 ms/MB; (b) manter a regra do TS (converte só até 64 MiB); (c) converter só por comando. ⚠ Espaço livre exigido pelo `VACUUM` não conferido. |
| F7 caminhos absolutos | Com o home igual (C1): (a) não tocar. Se o C mudar home ou layout: (b) reescrever por prefixo; (c) não reescrever e marcar como antigo. |
| F8 `$.env` | Seções 3, 4 e 5. Também: `hub_context` ilegível (S5) pode conter segredo. (a) deixar como está e avisar; (b) recusar a migração do projeto; (c) mover o texto bruto para o cofre como uma entrada única. |

## 3. DA-02 — referência, entradas no cofre e `memory`/`prompts`

### 3.1 Formato da referência no banco

**Opção R-A — referência no lugar de cada valor em `$.env`.** Exemplo ilustrativo:
`{"env":{"claude":{"ANTHROPIC_API_KEY":"<marcador><id da entrada>"}}}`.
- Prós: sem DDL; o formato do JSON não muda; granularidade por variável.
- Contras: um TS que abrir o banco (possível com V-B) repassa a **referência como valor** ao
  agente; um valor real que comece com o marcador fica ambíguo; `GET /projects/:id/context` (S6)
  devolveria a referência se o C não resolver antes. O `PUT /projects/:id/context` precisa
  **recusar** valor que comece com o marcador: senão quem tem o token grava uma referência à entrada
  de outro projeto ou de outro home, e o C a resolve e injeta no agente.

**Opção R-B — `$.env` sai do JSON; fica só a lista de nomes.** Exemplo ilustrativo:
`{"envNames":{"claude":["ANTHROPIC_API_KEY"]}}`. A entrada no cofre se acha pelo nome (3.2).
- Prós: sem DDL; um TS que abrir o banco vê env vazio, sem injetar texto estranho; não há marcador
  ambíguo.
- Contras: com volta ao TS, o env some sem aviso, e qualquer gravação do contexto pelo TS descarta
  `envNames` (a sanitização monta um objeto novo só com `memory`, `prompts` e `env`,
  `daemon/src/repo-trust.ts:171-192`), deixando entradas órfãs no cofre; o JSON interno deixa de bater com
  `ProjectContextSchema`, que é `.strict()` (`daemon/src/http-schemas.ts:64-76`), então a resposta
  da API precisa ser montada à parte.

**Opção R-C — tabela nova de referências** (pede V-A). Colunas ilustrativas: projeto, agente, nome,
id da entrada, data.
- Prós: consulta simples para `hub doctor`, expurgo e conferência pós-migração; o JSON fica só com
  `memory`/`prompts`; o TS não abre o banco (V-A), então não há injeção.
- Contras: DDL e migração 11 obrigatórias; mais um lugar para manter coerente com o cofre.

### 3.2 Granularidade e nome das entradas

**Opção N-A — uma entrada por variável.** Nome ilustrativo:
`agents-hub/<projectId>/<agentId>/<VAR>`.
- Prós: cada valor tem no máximo 2.000 unidades UTF-16 (S2, P2); apagar uma variável apaga uma
  entrada; o nome cabe no limite do alvo genérico (64 + 128 + prefixo, bem abaixo de 32.767, P1).
- Contras: muitas entradas; nem o id de agente das chaves (S2) nem o nome da variável depois do
  prefixo (S3) têm restrição de caracteres, então o nome precisa de escape ou codificação injetiva;
  ⚠ não conferido se o `TargetName` do Credential Manager diferencia maiúsculas (dois nomes que só
  diferem na caixa poderiam colidir); renomear o projeto não muda o id, mas mudar a variável exige
  apagar e criar.

**Opção N-D — nome opaco.** Cada entrada recebe um id aleatório (do CSPRNG do SO), guardado na
tabela de R-C junto com projeto, agente e variável.
- Prós: o nome não carrega dado do usuário; sem escape nem colisão por caixa; renomear variável é
  só atualizar a linha.
- Contras: exige R-C (e V-A); sem a tabela, as entradas viram órfãs impossíveis de atribuir; o nome
  deixa de ser determinístico, então B-C precisa gravar o id no banco **antes** de gravar no cofre
  (senão uma queda entre os passos cria entrada que ninguém acha).

**Opção N-B — uma entrada por projeto e agente, com JSON das variáveis.**
- Prós: menos entradas; uma leitura por spawn de agente.
- Contras: o JSON passa de 2560 bytes com poucas variáveis grandes (P1), o que força DPAPI (3.3) no
  Windows; gravar uma variável regrava todas.

**Opção N-C — uma entrada por projeto.**
- Prós: o mínimo de entradas.
- Contras: o mesmo problema de tamanho de N-B, maior.

Comum a todas: a entrada precisa ser ligada ao **home**, senão dois homes (por exemplo, o de teste
com `AGENTS_HUB_HOME` e o real) disputam o mesmo nome. Opções:
- (a) incluir no nome um identificador derivado do caminho canônico do home;
- (b) incluir um id aleatório gerado e guardado no banco. Sozinho, ele é perigoso: o id viaja com
  o banco, então um teste que copie o banco real para um home temporário passa a mexer nas
  entradas **reais** (inclusive apagá-las no fim);
- (c) combinar (b) com o caminho canônico do home gravado junto, e recusar usar o cofre se o
  caminho atual não bater com o gravado.

⚠ Nenhuma delas está no plano.

### 3.3 Windows: Credential Manager ou DPAPI

**Opção W-A — Credential Manager, recusando acima de 2560 bytes.** Valor gravado em UTF-8; acima
do teto, erro claro, nunca truncar (SEC-R23).
- Prós: as entradas aparecem no Gerenciador de Credenciais do Windows; nada cifrado pelo Hub.
- Contras: recusa valor válido para a API (até 2.000 unidades UTF-16 multibyte, P2); a API do Hub
  passa a ter um limite menor que o de SPEC-01, o que é mudança de contrato (ADR 7.6). Valor **já
  gravado pelo TS** acima do teto não migra, e precisa de regra própria: W-D, ou manter em texto
  com aviso permanente (UI, `hub doctor`, `hub project env`). ⚠ Não conferido: se o `TargetName`
  diferencia maiúsculas (3.2) e se `CRED_PERSIST_ENTERPRISE` (P3) replica a entrada em perfil
  móvel; a escolha do modo de persistência faz parte da decisão.

**Opção W-B — DPAPI de usuário, blob em arquivo fora do banco.** Exemplo ilustrativo:
`<home>/secrets/<id>.bin`, com entropia adicional ligada ao id do projeto e ao nome da variável
(modelo de ameaças V1).
- Prós: sem teto prático de tamanho; mesma forma de guardar para N-A, N-B e N-C.
- Contras: o arquivo precisa da mesma ACL do `operator-token` (SPEC-02 §6.2); copiar o home para
  outra máquina leva o arquivo, mas ele não decifra lá (é o ganho de P5, e também perda de dado em
  migração de máquina); `CRYPTPROTECT_LOCAL_MACHINE` (P4) não pode ser usado.
- Requisitos da opção: a ACL é aplicada na criação (`SECURITY_ATTRIBUTES`), não depois;
  `CRYPTPROTECT_UI_FORBIDDEN` (`dpapi.h:135`); `szDataDescr` nulo (`dpapi.h:186`, `:199`); a
  entropia não é segredo, só amarra o blob a home, projeto, agente e variável.

**Opção W-C — DPAPI com o blob no banco.**
- Prós: um arquivo só; backup do banco leva o blob.
- Contras: **contradiz o ADR 7.16** ("o banco guarda só a referência"); só cabe se o dono revisar
  essa decisão (modelo de ameaças V1).

**Opção W-D — Credential Manager até 2560 bytes, DPAPI acima.**
- Prós: nenhuma recusa; o caso comum (chave de API ASCII) fica no Credential Manager.
- Contras: dois caminhos de código e de teste; o usuário não sabe onde cada valor está.

### 3.4 Destino de `memory` e `prompts`

Não são segredo (SPEC-02 §5; DA-02).

**Opção P-A — ficam em `hub_context`, como hoje.**
- Prós: sem mudança de esquema nem de tamanho (`memory` até 20.000 caracteres não cabe no
  Credential Manager, P1).
- Contras: nenhum conhecido além de manter o JSON misto (com R-A).

**Opção P-B — vão para o cofre junto com o env.**
- Prós: o banco fica sem texto do usuário em `projects`.
- Contras: estoura o teto do Credential Manager; não é exigido pelo ADR 7.16; `payload_json` já
  guarda os prompts enviados aos agentes (S9), então o ganho é pequeno ⚠ (não conferido evento a
  evento).

**Opção P-C — colunas próprias em `projects`** (pede V-A).
- Prós: tira o JSON misto.
- Contras: DDL sem ganho de segurança.

## 4. DA-01 — Linux sem Secret Service

Cenário: servidor sem sessão gráfica ou gerenciador de janelas sem keyring. Cair para texto puro em
silêncio repete o TS (modelo de ameaças V3). As três opções vêm do modelo de ameaças V3; nenhuma
pode ser escolhida em silêncio (SEC-R25).

**Opção 1 — arquivo 0600 em pasta 0700** (`<home>/secrets/`), com aviso permanente na UI, no
`hub doctor` e no `hub project env`.
- Prós: funciona em servidor e com autostart; protege de outro usuário do SO (com V5/D7 aplicados).
- Contras: é texto puro no disco, só com permissão; backup do home leva o segredo; o ganho sobre o
  TS é tirar o valor do banco e dos backups do banco. O arquivo precisa nascer já com 0600, com
  `O_EXCL` e `O_NOFOLLOW` (sem seguir link plantado), e o C precisa conferir que a pasta pertence ao
  usuário antes de gravar.

**Opção 2 — recusar guardar e pedir o env de fora** (variável no ambiente do daemon).
- Prós: o Hub nunca grava o segredo; coerente com o ADR 3.1 original ("o Hub nunca persiste
  segredo", ADR 07 "O que isto substitui").
- Contras: o env por projeto perde a função nessas máquinas; o usuário precisa configurar o ambiente
  do serviço (systemd, `.desktop`), fora do Hub; o segredo só muda de lugar, para a unit ou o
  `.desktop`, e passa a ser herdado por **todo** agente que o serviço lança, não só pelo do projeto;
  a migração de um banco TS nessas máquinas não tem para onde levar o valor (fica em texto e avisa,
  ou exige ação).

**Opção 3 — arquivo cifrado com senha.** Com o Monocypher vendorizado: Argon2 para derivar a chave e
AEAD para cifrar (P6).
- Prós: protege disco e backup copiados **enquanto o arquivo está fechado**. Depois do desbloqueio,
  o mesmo usuário lê os valores pelo serviço (S6) ou pela memória do processo.
- Contras: **quebra o autostart** (alguém precisa digitar a senha a cada subida); a senha vira um
  segundo segredo para o Hub pedir sem janela (CLI, serviço), e nunca pode chegar por argv nem por
  variável de ambiente; esquecer a senha perde o env; exige CSPRNG do SO para sal e nonce (o ADR 08
  não traz; o plano tem CSPRNG na F0-06, ver §9).
- Parâmetros a fixar, se escolhida: `CRYPTO_ARGON2_ID` (`monocypher.h:156`); sal de 16 bytes (o
  tamanho que o cabeçalho recomenda, `monocypher.h:169`); nonce de 24 bytes (`monocypher.h:85`) novo
  a cada gravação; dado associado com versão do formato, parâmetros do KDF e id do
  home. ⚠ Custos de memória e iterações conforme a RFC 9106, não conferidos.

Pontos comuns às três:
- **Detecção.** O C precisa distinguir "sem D-Bus", "D-Bus sem Secret Service" e "Secret Service
  travado". ⚠ O comportamento de cada estado (por exemplo, pedido de desbloqueio) não foi conferido.
- **Biblioteca.** O ADR 08 não traz biblioteca para o Secret Service (P7). Carregar uma por `dlopen`
  no AppImage repete o risco aceito para o tray (ADR 08 "Riscos aceitos"). Fica como lacuna (seção 9).

## 5. Limpeza de resíduos

Fatos: R1–R7. Trocar o valor por referência com `UPDATE` deixa os bytes antigos no espaço livre de
páginas em uso, em páginas da freelist, no `-wal` antes do checkpoint e nas cópias do banco
(modelo de ameaças V4).

### 5.1 No banco em uso

**Opção L-A — `secure_delete = ON`, trocas, `VACUUM`, checkpoint.** Ordem:
1. `PRAGMA secure_delete = ON` (não `FAST`) antes do primeiro `UPDATE`;
2. as trocas e o `COMMIT` de cada uma (2.5, B-C);
3. `VACUUM`, depois de **todas** as trocas;
4. por fim, `PRAGMA wal_checkpoint(TRUNCATE)`, conferindo `busy = 0` no resultado e o `-wal` com
   0 bytes, sem outra conexão aberta.
- Prós: pelo código, quem reescreve o arquivo principal é o checkpoint **posterior** ao `VACUUM`: ele
  copia as páginas do WAL para o banco e trunca o arquivo ao tamanho novo
  (`native/third_party/sqlite/sqlite3.c:69845-69852`); com `TRUNCATE`, o `-wal` fica com 0 bytes
  (`sqlite3.c:10420-10423`, `:10438-10439`). O `secure_delete` cobre a janela entre o `COMMIT` e o
  `VACUUM`. Resolve F6 junto.
- Contras: mais I/O; o `VACUUM` custa ≈26 ms/MB (F6) e exige espaço livre ⚠. O `secure_delete`
  sozinho não basta: o `rebuildPage` não zera a lacuna entre os ponteiros de célula e o novo início
  do conteúdo (`sqlite3.c:80869-80931`), e páginas que já estavam livres antes de ligar o pragma não
  são zeradas (R5). Com `FAST`, as folhas da freelist não são regravadas (`sqlite3.c:80159-80161`);
  por isso `ON`. Prova por leitura bruta (SEC-R24).

**Opção L-B — só `VACUUM` e `wal_checkpoint(TRUNCATE)`, sem `secure_delete`.**
- Prós: menos passos.
- Contras: pelo código, `VACUUM` + checkpoint `TRUNCATE` completo eliminam o resíduo do arquivo
  (mesmas linhas de L-A), mas nada cobre a janela antes do `VACUUM`; se ele falhar ou não rodar, o
  valor antigo fica. Prova por leitura bruta (SEC-R24).

Em L-A e L-B:
- O `VACUUM` monta a base nova anexando uma base temporária (`ATTACH '' AS vacuum_…`,
  `sqlite3.c:161681-161684`). Com o padrão de compilação `SQLITE_TEMP_STORE = 1`
  (`sqlite3.c:15745`) e o pragma `temp_store` no padrão, essa base vai para **arquivo no diretório
  temporário** do SO, com o conteúdo vivo do banco ⚠ (destino e apagamento do arquivo a conferir
  por teste).
- Truncar ou apagar não sobrescreve os blocos no disco ⚠ (SSD, snapshots, sistema de arquivos com
  diário).

**Opção L-C — `secure_delete` ligado sempre, não só na migração.**
- Prós: também zera o que a retenção apaga (`raw_json`, SPEC-02 §7).
- Contras: custo de I/O permanente ⚠ não medido contra as metas do ADR 08; vai além do ADR 7.16.

**Opção L-D — não limpar e avisar.**
- Prós: migração rápida.
- Contras: o segredo continua recuperável no disco; contraria SEC-R24.

### 5.2 Cópias antigas do banco

`backups/*.db`, `hub.db.pre-restore-*` e a cópia de M-C (se houver) contêm o texto (R2). Backups
pedidos ao serviço podem estar em **qualquer caminho absoluto** (`out`); o caminho fica em
`detail.path` do registro `maintenance.backup` da auditoria (`daemon/src/maintenance-routes.ts:57-68`).
⚠ Não conferido se o backup local da CLI, com o serviço parado, deixa algum registro do caminho.

- **Opção K-A — avisar** no fim da migração, com a lista dos arquivos.
- **Opção K-B — avisar e oferecer expurgo explícito** (o usuário confirma arquivo a arquivo ou em
  bloco).
- **Opção K-C — apagar automaticamente.** Destrutivo: o backup é do usuário; perder o único backup
  bom é pior que o resíduo.
- Em todas: apagar arquivo não garante que os bytes sumam do disco (SSD, sistema de arquivos com
  diário) ⚠; isso precisa estar no SECURITY.md do C.

### 5.3 O que não sai

O segredo que o agente leu ou imprimiu fica em `payload_json` para sempre (S9; SECURITY.md:490-497).
Nenhuma opção acima trata isso. O SECURITY.md do C precisa dizer.

## 6. Dependências entre as opções

| Se o dono escolher | Então |
|---|---|
| R-C (tabela) ou P-C | V-A (migração 11) é obrigatória |
| N-D (nome opaco) | R-C é obrigatória, logo V-A também |
| V-B e R-A | um TS que abrir o banco repassa referências como valor ao agente |
| V-A | volta ao TS só por B-A (cópia) ou B-B (reversão) |
| M-B | o `hub.db` do TS segue com texto puro; a seção 5 precisa cobrir também esse arquivo |
| M-C ou B-A | a cópia com texto puro entra em 5.2 |
| G-A com marca fora do banco | restore de backup antigo (C7) reintroduz texto puro sem nova migração |
| G-A com marca dentro do banco (V-A) | restore de backup v10 volta sem a marca e a migração roda de novo |
| G-B | precisa da marca de "limpeza pendente" para cobrir resíduo de limpeza que falhou |
| N-B ou N-C no Windows | W-A recusa com mais frequência; W-B ou W-D ficam mais prováveis |
| W-C | exige rever o ADR 7.16 |
| Opção 2 (DA-01) | a migração no Linux sem keyring precisa de uma regra própria (manter texto e avisar, ou parar) |

## 7. Recomendação do autor

> Esta seção é opinião de quem escreveu a proposta. **Não é decisão** e não substitui a escolha do
> dono. Ela existe só para dar um ponto de partida.

- **DA-03:** M-C + V-A + Q-A + T-1 e T-2 + G-B + B-C, com a cópia de M-C apagada só por K-B. A
  migração 11 fecha o caminho de o TS ler referências; G-B cobre restore de backup antigo; B-C
  garante que falha no cofre não perde segredo. F1–F7 conforme a opção (a) de cada linha de 2.6,
  com contagem de órfãos e de PK NULL no relatório.
- **DA-02:** R-C + N-A + W-A + P-A. Uma entrada por variável mantém cada valor pequeno; a tabela dá
  ao `hub doctor` e ao expurgo uma fonte consultável. W-A pede ao dono aceitar um teto menor que o da
  SPEC-01 para valores multibyte; se isso não for aceitável, W-D.
- **DA-01:** Opção 2 por padrão; Opção 1 só quando o usuário ligar explicitamente, com o aviso
  permanente do modelo de ameaças V3.
- **Resíduos:** L-A + K-B.

## 8. O que a revisão do security-auditor deve conferir

1. Que cada fato das seções 1.1–1.5 bate com a fonte citada, em especial S6 (`GET` sem token
   devolve valores) e R5 (semântica de `secure_delete` no SQLite 3.53.4 vendorizado).
2. Que nenhuma opção grava segredo em texto sem aviso (SEC-R25) nem trunca valor (SEC-R23).
3. Para cada combinação de L-A/L-B e M-A/M-C: se o valor antigo some de `hub.db`, `-wal` e páginas
   livres numa leitura bruta (SEC-R24), e quais itens ⚠ da seção 5 dependem de teste.
4. Que B-C de fato nunca perde segredo: gravar no cofre → reler e comparar → `BEGIN IMMEDIATE` →
   conferir valor inalterado → trocar só a variável → `COMMIT`; comportamento com queda entre passos
   e com duas subidas seguidas (G-B).
5. O risco de R-A com V-B (TS injetando referência como valor) e se alguma outra combinação tem
   efeito parecido.
6. Se o nome das entradas (3.2) separa homes diferentes, inclusive o home de teste com
   `AGENTS_HUB_HOME`, e se o escape do nome da variável (S3) é injetivo.
7. W-B: ACL do arquivo de blob igual à do `operator-token` (SEC-R15), entropia adicional, ausência de
   `CRYPTPROTECT_LOCAL_MACHINE`.
8. Opção 3 de DA-01: parâmetros de Argon2 e uso do AEAD do Monocypher (nonce, chave) antes de virar
   requisito.
9. Se as premissas V2 (cofre não isola do próprio usuário) e 5.3 (`payload_json`) estão listadas para
   o SECURITY.md do C (SEC-R41).
10. Se S6 (contexto com valores em rota sem token) deve virar divergência de segurança própria,
    porque o cofre não muda o que a API entrega.

## 9. Divergências e lacunas encontradas

- **SECURITY.md:354-355 diz** que "a interface `CredentialProvider` está preparada mas não
  implementada". Não há `CredentialProvider` em `packages/` (Grep, 0 ocorrências), e o ADR 03
  registra o mesmo: "`CredentialProvider` não existe no código" (`docs/decisoes/03-seguranca-limites.md:36`).
  Não corrigido aqui (fora do escopo).
- **Modelo de ameaças V1 diz "até 8000 em UTF-8"** para um valor de 2000. O teto conta unidades
  UTF-16 (P2), então o máximo é 6.000 bytes em UTF-8. A conclusão de V1 (passa de 2560) não muda.
- **Rota `GET /projects/:id/context` sem token devolve o env** (S6; `daemon/src/server.ts:597-603`).
  Severidade sugerida pela revisão: Média, Alta em máquina multiusuário. A revisão recomenda que vire divergência
  própria, ligada a H7, D4 e SEC-R12 do modelo de ameaças: outro usuário do SO que alcança as rotas
  abertas lê o env. Com o cofre, o C ainda precisa decidir se a rota lê o cofre a cada chamada e
  continua devolvendo valores (paridade, ADR 7.6) ou não. Nenhuma DA cobre isso hoje.
- **CSPRNG do SO** não está no ADR 08. O plano já o prevê na F0-06 (`docs/17-plano-reescrita-c.md:144-150`),
  então a lacuna é só do ADR. N-D, (b)/(c) de 3.2 e a Opção 3 de DA-01 dependem dele.
- **SEC-R41 não lista** os resíduos em cópias antigas (5.2), o segredo em `payload_json` (5.3), o
  texto com permissão da Opção 1 de DA-01, nem S6, entre o que o SECURITY.md do C precisa dizer.
- **Biblioteca do Secret Service** não está no ADR 08 (P7). F7-04 precisa dela.
- **Identificador do home no nome das entradas** (3.2) não está no plano.
- **Comando de migração ou expurgo** (Q-C, K-B) seria requisito novo; não existe na SPEC-03.
- **Migração 11** (V-A) muda o texto do aceite de F1-08 ("migrações 1 a 10"), se escolhida.
