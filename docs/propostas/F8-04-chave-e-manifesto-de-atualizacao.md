# F8-04 — Proposta: chave e manifesto de atualização (para o dono decidir DA-04)

> **Tudo aqui é PROPOSTA.** Nada está decidido. Onde há alternativas, elas aparecem como opções
> com prós e contras; a preferência do autor aparece só como "recomendação do autor". ⚠ marca
> fato de terceiro (GitHub, Windows, tokens de hardware, ferramentas) não conferido na fonte.
> Fato do repositório traz `arquivo:linha`.
>
> Fontes: plano `docs/17-plano-reescrita-c.md` (F8-04, DA-04); ADR 07 7.13/7.14; ADR 08 8.10,
> 8.11, 8.13, fatos, consequências propostas e riscos aceitos; modelo de ameaças
> (`docs/especificacao/08-modelo-de-ameacas-c.md`: A1–A8, G1, SEC-R17..R22, SEC-R40, L3);
> `CLAUDE.md` (regra de segredos). Autor: security-auditor, 2026-09-30.

## 0. Ponto de partida

| Item | Origem | Estado |
|---|---|---|
| Atualização automática a partir do GitHub Releases | ADR 7.13 | decidido |
| Sem Authenticode; a atualização valida com chave própria do projeto | ADR 7.14 | decidido |
| Monocypher (Ed25519) para a assinatura | ADR 8.10 | decidido |
| WinHTTP no Windows, libcurl no Linux | ADR 8.11 | decidido |
| Atualizador próprio | ADR 8.13 | decidido |
| Manifesto assinado com Ed25519 e hash SHA-512; fonte em `/releases/latest/download/` | ADR 08 (consequências propostas) | proposta do ADR 08, base deste documento |
| Cota anônima de 60 req/h por IP; sem documentação de que o redirect fique fora dela | ADR 08 (riscos aceitos) | risco aceito |
| Renomear o `.exe` em uso só tem relatos a favor; `MOVEFILE_DELAY_UNTIL_REBOOT` exige admin | ADR 08 (riscos aceitos) | risco aceito |
| Repositório público, download sem token | ADR 07; DA-19 | premissa |

### 0.1 Fatos do Monocypher vendorizado (conferidos em 2026-09-30)

- Versão **4.0.3** (`native/third_party/monocypher/monocypher.h:1`); a compilação inclui o
  opcional (`native/third_party/CMakeLists.txt:129-137`, alvo `ah::monocypher`).
- **Ed25519** ("EdDSA with curve25519 + SHA-512") fica no arquivo opcional (a fonte não cita o
  RFC 8032; a conformidade com o RFC fica para o teste T1): `crypto_ed25519_key_pair`,
  `crypto_ed25519_sign`, `crypto_ed25519_check` (`optional/monocypher-ed25519.h:118-126`); a
  variante pré-hash Ed25519ph é `crypto_ed25519_ph_sign`/`crypto_ed25519_ph_check` (`:129-134`).
- **`crypto_eddsa_*` não serve**: é "EdDSA with curve25519 + BLAKE2b" (`monocypher.h:218-227`).
  Uma assinatura Ed25519 verificada com `crypto_eddsa_check` falha, e vice-versa. O atualizador
  usa só `crypto_ed25519_check`.
- `crypto_ed25519_check` (`optional/monocypher-ed25519.c:475-480`) chama
  `crypto_eddsa_check_equation` (`monocypher.c:2000`) e devolve `0` para assinatura válida e `-1`
  para inválida: recusa ponto fora da curva ou `S ≥ L` (anti-maleabilidade) em `monocypher.c:2016`, e delega a
  `crypto_verify32` → `neq0` em `:2064` (`:144-161`, 0/-1 em tempo constante). Aceita codificação
  não canônica de A e R (comentário em `:2009`); não afeta o caso do Hub (quem assina é o projeto),
  mas os testes fixam o comportamento.
- SHA-512: `crypto_sha512_init/update/final` e `crypto_sha512`
  (`optional/monocypher-ed25519.h:86-91`); não há SHA-256 (ADR 08).
- Para a opção de arquivo cifrado (§4, O2): `crypto_argon2` (`monocypher.h:181`),
  `crypto_aead_lock`/`crypto_aead_unlock` (`:82-91`), `crypto_wipe` (`:77`).

## 1. Formato do manifesto

### 1.1 Envelope

Um **único arquivo**, de nome fixo e independente da versão, publicado como asset de toda release
(ex.: `agents-hub-update.manifest`, nome a decidir). O nome fixo é o que faz
`/releases/latest/download/<nome>` funcionar.

```
agents-hub-update-v1␊
key: <16 hex minúsculos>␊
sig: <128 hex minúsculos>␊
␊
<corpo JSON, bytes exatos>
```

- Linha 1: o texto exato `agents-hub-update-v1` (número mágico do formato).
- `key:` — identificador da chave que assinou: os 8 primeiros bytes de `SHA-512(chave_pública)` em
  hex. Serve só para escolher a chave; a confiança vem da verificação.
- `sig:` — assinatura Ed25519 de 64 bytes em hex (hex evita um decodificador base64, que o ADR 08
  não traz).
- LF, sem CR, sem BOM. Tamanho total ≤ **64 KiB**; acima disso o download é abortado antes de
  qualquer verificação.
- **Mensagem assinada** = `"agents-hub-update-v1\n"` ‖ bytes do corpo (do primeiro byte depois da
  linha vazia até o fim). O prefixo de domínio (A2) impede que uma assinatura da mesma chave para
  outro fim valha como manifesto.
- O cabeçalho é ASCII de tamanho fixo, lido por comparação de bytes e tamanho exato, sem parser
  genérico — a única leitura antes da verificação.

**Opção E2:** dois assets (`…manifest.json` e `…manifest.sig`). Contra: dois downloads; uma release
publicada entre eles gera par que não confere (falha segura, mas ruído e uma requisição a mais).
**Recomendação do autor:** envelope único (E1).

**Variante de algoritmo (decidir junto com §4):**
- **S1 — Ed25519 puro** sobre a mensagem inteira (`crypto_ed25519_check`): o mais simples.
- **S2 — Ed25519ph** sobre `SHA-512(mensagem)` (`crypto_ed25519_ph_check`): só se o meio de
  assinatura (token de hardware) não aceitar mensagem de tamanho arbitrário. ⚠ Suporte de tokens a
  Ed25519ph não conferido.
- O algoritmo é **fixo pela versão do formato**: não há campo `alg` negociável (evita troca de
  algoritmo). Trocar de algoritmo = `agents-hub-update-v2`.

### 1.2 Corpo JSON

```json
{
  "schema": 1,
  "product": "agents-hub",
  "channel": "stable",
  "version": "1.4.2",
  "serial": 17,
  "published_at": "2026-10-01T12:00:00Z",
  "expires_at": "2026-10-31T12:00:00Z",
  "key_id": "3f9a0c1d2e4b5a67",
  "revoked_keys": [],
  "artifacts": [
    { "os": "windows", "arch": "x86_64", "kind": "installer",
      "name": "agents-hub-1.4.2-windows-x86_64-setup.exe",
      "size": 7340032, "sha512": "<128 hex>" },
    { "os": "windows", "arch": "x86_64", "kind": "binary", "path": "hub.exe",
      "name": "hub-1.4.2-windows-x86_64.exe",
      "size": 2097152, "sha512": "<128 hex>" },
    { "os": "linux", "arch": "x86_64", "kind": "appimage",
      "name": "agents-hub-1.4.2-x86_64.AppImage",
      "size": 9437184, "sha512": "<128 hex>" }
  ]
}
```

(valores ilustrativos)

| Campo | Regra proposta | Ameaça |
|---|---|---|
| `schema` | inteiro, igual a `1` | evolução do formato |
| `product` | igual a `"agents-hub"` | reaproveitar assinatura de outro produto da mesma chave (A2) |
| `channel` | em v1 só `"stable"`; pré-release é lacuna (§9) | troca de canal |
| `version` | `MAJOR.MINOR.PATCH` decimal, sem sufixo | downgrade (A3) |
| `serial` | inteiro ≥ 1, **estritamente crescente em todo manifesto assinado**, inclusive os reassinados só para renovar `expires_at` | replay (A3) |
| `published_at`, `expires_at` | RFC 3339 em UTC com `Z`; proposta: `expires_at` = `published_at` + 30 dias (valor da A3) | congelamento (A3) |
| `key_id` | igual ao `key:` do cabeçalho e à chave que verificou | coerência |
| `revoked_keys` | lista de `key_id`; ver §2.3 | revogação (A1) |
| `artifacts[]` | `os` ∈ {`windows`,`linux`}; `arch` ∈ {`x86_64`} (outras: lacuna); `kind` ∈ {`installer`,`binary`,`appimage`}; `name` só `[A-Za-z0-9._-]`; `size` inteiro > 0; `sha512` = 128 hex minúsculos | A2: plataforma, nome e tamanho entram na assinatura |
| `path` (só `kind: binary`) | relativo à pasta de instalação, sem `..`, sem raiz, sem `:`, dentro de uma lista fixa no binário (os executáveis do layout de F8-01) | defesa em profundidade |

**Opcionais a decidir:** `min_from_version` (versão mínima da qual se pode pular direto para esta,
para migração de banco com passo intermediário; ver §5.6) e `installed[]`
(`{os, arch, path, size, sha512}` dos arquivos que o instalador grava, para o `hub doctor` conferir
integridade — SEC-R40 — também quando a atualização é pelo instalador, W1).

### 1.3 Windows: instalador ou binários

O ADR 08 não traz biblioteca de compressão (sem zip/tar): cada arquivo atualizado é um asset
próprio.

| | **W1 — baixar e rodar o instalador Inno verificado** | **W2 — trocar os binários um a um (A4/A5)** |
|---|---|---|
| Prós | Um único caminho de instalação; o Inno mantém registro de desinstalação e recursos coerentes; menos assets | O atualizador controla ordem, `/health` e rollback (SEC-R20); não executa um segundo programa |
| Contras | Executa por **caminho** um binário verificado: janela TOCTOU entre hash e `CreateProcess` (mitigação proposta: manter o handle aberto sem compartilhar escrita/exclusão até o processo iniciar; ⚠ não conferido que `CreateProcess` aceita isso). ⚠ Modo silencioso e fechamento do `hub` em uso pelo Inno não conferidos; rollback fica com o Inno ⚠; SmartScreen depende da marca de origem ⚠ | Registro de desinstalação e lista de arquivos do Inno podem divergir da versão instalada; recursos (fontes, os 9 manifestos de agentes) precisam entrar como `binary`/`path`; quantos executáveis existem depende de DA-14 |
| Depende de | F8-02 | DA-14, F8-01 |

**Recomendação do autor:** W2 para atualizar, instalador só na primeira instalação — SEC-R19/R20
(verificar e instalar os mesmos bytes, restaurar se o `/health` falhar) ficam mais fáceis sem
processo intermediário. Os dois `kind` continuam no manifesto (o `installer` serve à verificação
manual da §7).

**Linux:** um único artefato `appimage`, que substitui o arquivo de `$APPIMAGE` ⚠ seguindo G1.

### 1.4 Regras de geração (canonicalização)

A assinatura cobre os bytes exatos e o cliente **nunca reserializa** o JSON (A2). Mesmo assim o
gerador segue uma forma única, para revisão e reprodução determinísticas: UTF-8 sem BOM; LF; chaves
na ordem da tabela 1.2; indentação de 2 espaços; só inteiros (sem fração nem expoente, todos
≤ 2^53 − 1); timestamps com `Z`; hex minúsculo; sem chave duplicada; sem chave fora do esquema.

O cliente **recusa** chave duplicada, chave desconhecida, tipo errado e número não inteiro. ⚠ O
cJSON guarda números como `double` e seu comportamento com chave duplicada não foi conferido na
fonte vendorizada: a checagem de duplicatas e de inteiro exato é feita pelo código do Hub,
percorrendo os filhos do objeto.

## 2. Chaves públicas embutidas, rotação e revogação

### 2.1 O que vai no binário

Duas chaves públicas Ed25519 de 32 bytes, como arrays constantes em `native/src/updater/` (área de
F8-05), cada uma com o seu `key_id`:

- **K_atual** — assina os manifestos do dia a dia.
- **K_próxima** — guardada fria, separada da K_atual; usada só para rotacionar e revogar.

Atende ao critério "duas chaves públicas embutidas" de SEC-R22.

### 2.2 Rotação planejada

1. A versão N embute {A = atual, B = próxima}.
2. O dono gera C offline; a versão N+1, ainda assinada por A, embute {B, C}.
3. Depois de uma transição (sugestão: 2 releases ou 90 dias), os manifestos passam a ser assinados
   por B; clientes em N aceitam B porque já a têm.
4. Instalações mais de uma rotação atrás perdem a atualização automática e precisam de
   reinstalação manual (§7); o `hub doctor` avisa "manifesto assinado por chave desconhecida".

### 2.3 Revogação (com escolha para o dono)

- `revoked_keys` só vale se o manifesto foi assinado por **outra** chave embutida não revogada.
- **Política assimétrica (recomendação do autor):** só K_próxima revoga K_atual; manifesto
  assinado por K_atual que tente revogar K_próxima é recusado. Quem rouba a chave diária não trava
  a de recuperação. Com política simétrica, um atacante com A revoga B antes do dono e o cliente
  fica sem saída.
- A revogação é gravada no estado local (§5.1) e sobrevive a reinícios.
- **Ataque de serial:** quem tem A pode assinar `serial` gigante e bloquear os manifestos
  legítimos futuros. Proposta: guardar o maior `serial` **por chave**; ao revogar uma chave, o
  marcador dela é descartado, e o próximo manifesto válido só precisa superar o maior `serial` das
  chaves ainda válidas.
- Com as duas chaves embutidas revogadas, a atualização automática para (falha fechada) e o
  `hub doctor` e a UI pedem reinstalação manual.
- Limite honesto: quem tem a chave e chega ao cliente antes da revogação instala o que quiser
  **naquele cliente** (A1, Alto). A revogação limita o dano daí em diante; não o desfaz.

## 3. Onde a chave privada fica, sem nunca expô-la

Regras para qualquer opção (`CLAUDE.md`, regra de segredos; SEC-R22):

- Gerada **fora do repositório**, numa máquina do dono; nenhum agente vê o valor, e nas opções
  O1/O2 nenhum job vê o valor (na O3 o job de assinatura recebe a chave, §4).
- Fora de commit, log, artefato, cache de CI, mensagem de erro, issue e PR; documentos e scripts
  citam só o nome do arquivo ou do secret.
- O arquivo da chave privada (O2) começa com um cabeçalho fixo (ex.: `agents-hub-secret-key-v1`,
  a decidir), para que um grep no repositório, nos workflows e nos artefatos detecte vazamento
  acidental (SEC-R22); as chaves públicas têm formato próprio e não casam com o padrão.
- Em memória: buffer zerado com `crypto_wipe` logo depois de assinar.
- K_próxima num meio **diferente** do de K_atual, com backup offline próprio.
- O CI (`.github/workflows/native.yml:19-20` usa `permissions: contents: read`) continua sem acesso à
  chave nas opções O1 e O2.

## 4. Onde e como assinar (opções; sem escolha)

| | **O1 — local, pelo dono, com token de hardware** | **O2 — local, com arquivo cifrado offline** | **O3 — no CI, com *environment* protegido** |
|---|---|---|---|
| Como | O CI compila e publica os artefatos (rascunho); o dono baixa, confere os hashes, gera o corpo, assina com o token e publica o manifesto | Igual a O1, com a chave num arquivo cifrado (senha → `crypto_argon2`; chave da cifra → `crypto_aead_lock`) em mídia offline; a ferramenta usa `crypto_ed25519_sign`, a mesma biblioteca do verificador | Secret num *environment* `release` com aprovação manual do dono, restrito a tags; job só de assinatura, sem actions de terceiros (ou fixadas por SHA); a chave vai do secret para a memória, nunca para disco ou log |
| Prós | A chave não sai do token; roubo da conta GitHub ou de uma action não assina | Sem hardware; mesma biblioteca do verificador (sem divergência de formato); custo zero | Automático; a reassinatura mensal (expiração, §1.2) pode ser um workflow agendado com aprovação |
| Contras | ⚠ Suporte a Ed25519 puro sobre mensagem arbitrária varia por token e interface (OpenPGP card, PIV, PKCS#11), não conferido; pode forçar S2 ou adaptação de formato. Passo manual a cada release **e** a cada reassinatura. Perder o token sem backup força rotação | Durante a assinatura a chave fica em claro na RAM da máquina do dono: malware ali rouba chave e senha. Depende de disciplina (mídia, senha, backup) | É o cenário da A1: repositório público, conta, action ou workflow comprometidos assinam para toda a base. ⚠ Mascaramento de secrets no log não cobre valores transformados. A confiança passa a incluir a plataforma do GitHub |
| Ferramenta | ⚠ Depende do token (gpg/PKCS#11), a escolher | Pequeno programa C de assinatura, **ainda inexistente** (lacuna de F8-05) | O mesmo programa de O2, no job |

Em todas as opções a confiança no **build** continua no CI: a chave protege o canal, não o
compilador. Builds reproduzíveis estão fora do escopo (lacuna).

**Recomendação do autor:** K_atual em O1 ou O2, K_próxima sempre em O2 numa mídia separada; O3 só
se o custo da reassinatura mensal for inaceitável, e então com o prazo de expiração revisto. Com
O1/O2, a reassinatura gera novo `serial` e substitui o asset do manifesto na última release. ⚠ Isso
não é atômico no GitHub (entre apagar e subir, o asset dá 404): o cliente trata 404 como "sem
informação, tentar depois".

## 5. Fluxo do cliente, passo a passo

### 5.1 Estado local

Arquivo no home do Hub (`AGENTS_HUB_HOME`, nome a decidir), 0600 / DACL só com o SID do usuário,
gravado em temporário e renomeado. Guarda: maior `serial` por `key_id`; chaves revogadas; versão
instalada; envelope verificado da versão instalada (para SEC-R40); falhas por versão; última
checagem e recuo atual. Testes sempre com home temporário (`CLAUDE.md`).

### 5.2 Checagem (quando e quanto)

- Na subida do serviço com atraso aleatório (sugestão: 0–10 min) e depois a cada **24 h ± jitter**.
  Uma checagem = uma requisição ao manifesto (mais o redirect).
- URL: `https://github.com/<dono>/<repo>/releases/latest/download/<nome-fixo>` (proposta do
  ADR 08). ⚠ Que `latest` ignora rascunhos e pré-releases é premissa sobre o GitHub, não conferida.
- Em 403/429: recuo exponencial até 24 h. ⚠ Uso de `Retry-After` pelo GitHub não conferido.
- Cota (risco aceito): mesmo que o redirect conte na cota de 60 req/h por IP, uma checagem diária
  por máquina com jitter mantém um NAT corporativo bem abaixo do teto; artefatos só são baixados
  quando há versão nova.
- O que `hub update` faz (forçar checagem, aplicar com confirmação) fica para DV-20, sem flag
  inventada aqui.

### 5.3 Canal (A7, SEC-R21)

- TLS sempre verificado, sem opção de desligar: WinHTTP com o repositório do SO; libcurl com CA
  explícito (caminho no AppImage em aberto, DA-13).
- Redirect seguido **manualmente**: cada salto só para `https:` e para hosts de uma lista fixa
  (github.com e o host de objetos do GitHub; ⚠ nome a confirmar), no máximo 5 saltos. ⚠ Opções de
  redirect do WinHTTP e da libcurl que permitem isso não conferidas.
- Teto de bytes: 64 KiB para o manifesto; `size` exato para o artefato (um byte a mais aborta).

### 5.4 Verificação antes do parse

1. Baixar o envelope para memória (≤ 64 KiB).
2. Conferir o cabeçalho por bytes exatos (mágico, `key:` com 16 hex, `sig:` com 128 hex, linha
   vazia); qualquer desvio é recusado.
3. Escolher a chave embutida pelo `key_id`; desconhecida ou revogada → recusa.
4. `crypto_ed25519_check(sig, pk, "agents-hub-update-v1\n" ‖ corpo)` (ou `_ph_check` em S2);
   diferente de 0 → recusa; o log diz "assinatura inválida" sem despejar o conteúdo.
5. **Só agora** o corpo vai ao cJSON, com validação estrita do esquema (§1.2–1.4) e `key_id` do
   corpo igual ao do cabeçalho.

### 5.5 Política

6. `expires_at` vencido → não atualiza; `hub doctor` e UI avisam (SEC-R18). `published_at` mais de
   24 h no futuro → recusa (relógio errado: §9).
7. `serial` ≤ maior visto para chaves válidas → recusa (replay).
8. `version` menor que a instalada → recusa (rebaixar só por ação manual explícita, A3); igual →
   nada a fazer.
9. Aplicar `revoked_keys` (§2.3); gravar `serial` e revogações no estado **antes** de baixar
   qualquer coisa, para um replay posterior já encontrar o marcador.
10. Escolher exatamente um artefato com o `os`/`arch` desta instalação e o `kind` da estratégia
    (W1/W2/AppImage); nenhum ou mais de um → recusa.

### 5.6 Quando NÃO atualizar (adiar, sem falhar)

- Há aprovação de gate pendente, ou sessão viva sem consentimento na UI (A5).
- O binário em execução não está no local de instalação esperado (build de desenvolvimento, cópia
  solta). No Linux: `$APPIMAGE` ⚠ ausente, link simbólico, não é arquivo regular do usuário, nome
  inesperado ou SHA-512 diferente do da versão instalada (G1).
- Pasta de destino não gravável, ou staging fora do mesmo volume (o rename exige).
- Espaço livre menor que 2 × `size`.
- A mesma versão já falhou N vezes (sugestão: 3): para e avisa no `hub doctor`.
- Manifesto vencido, chave desconhecida ou as duas chaves revogadas.
- **Risco a decidir:** se a versão nova migrar o banco (ADR 7.15), o rollback do binário pode deixar
  o antigo diante de um esquema mais novo. Proposta: backup do banco antes da troca e migração só
  depois do `/health` da versão nova, ou `min_from_version`. É lacuna, não decisão.

### 5.7 Download e verificação por handle (A4, SEC-R19)

11. Staging só do usuário (0700 / DACL só com o SID), **no mesmo volume do destino** (proposta:
    subpasta oculta da pasta de instalação no Windows; diretório de `$APPIMAGE` no Linux). Nunca
    `%TEMP%` compartilhado.
12. Criar o arquivo com criação exclusiva (Windows `CREATE_NEW` sem compartilhar escrita nem
    exclusão; Linux `O_CREAT|O_EXCL|O_NOFOLLOW`, modo 0700) e gravar com teto em `size`.
13. Pelo **mesmo handle**: voltar ao início, calcular o SHA-512 (`crypto_sha512_*`) e comparar com o
    manifesto (`crypto_verify64`); diferença → apagar o staging sem tocar em nada fora dele
    (SEC-R17).
14. Renomear: no Windows pelo mesmo handle, com `SetFileInformationByHandle(FileRenameInfo)` ⚠; no
    Linux, `fchmod 0755` pelo fd e `renameat` na mesma pasta — que renomeia por caminho, não pelo fd
    ⚠ —, conferindo `fstat` dev/ino antes e depois (A4, G1).
    ⚠ Comportamento dessas chamadas com o binário em uso não testado (risco aceito do ADR 08).

### 5.8 Troca com rollback (A5, SEC-R20)

- **W2 (Windows):** para cada `binary`, renomear o atual para `<nome>.old-<versão>`, pôr o novo no
  lugar, subir o serviço novo e esperar `/health` com a versão do manifesto (sugestão: 15 s); se
  falhar, parar o novo, restaurar os `.old` e registrar a falha; os `.old` são limpos na subida
  seguinte. O hook do gate aponta para esse binário: entre os dois renames há uma janela sem
  executável em que o hook falha **aberto** (A5). A janela precisa ser medida no teste; a solução
  estrutural (ex.: executável de hook estável) depende de DA-14.
- **W1 (Windows):** rodar o instalador verificado (§1.3) e conferir os `installed[]` contra o
  manifesto.
- **Linux:** troca do arquivo da AppImage pelo rename do passo 14; reiniciar e conferir o
  `/health`; rollback restaura a cópia `.old`.
- **Depois:** gravar a versão instalada e o envelope verificado no estado (SEC-R40) e o evento de
  auditoria (versão, `serial`, `key_id`; nada sigiloso).

## 6. Integridade da instalação (SEC-R40)

O `hub doctor` recalcula o SHA-512 dos binários instalados e compara com o envelope **verificado**
guardado no estado (§5.1), sem rede. Detecta troca acidental ou feita por um agente; não detém um
atacante decidido do mesmo usuário (A6), e o texto do doctor precisa dizer isso.

Na primeira instalação não há envelope local. Opções: (a) o primeiro start busca o manifesto da
própria versão pela URL da tag (`/releases/download/v<versão>/<nome-fixo>`; ⚠ padrão não
conferido); (b) o doctor diz "integridade não conferida" até a primeira atualização.

## 7. Primeira instalação (A8, risco aceito pelo ADR 7.14)

Sem Authenticode, o instalador inicial não tem verificação automática. Proposta:

- Cada release publica o envelope assinado com o `sha512` do instalador e da AppImage.
- O `key_id` e a chave pública completa são publicados no README e no SECURITY.md do C (tarefa
  futura) e numa segunda via fora do GitHub, se o dono tiver uma. Comparar o hash com o manifesto do
  **mesmo** canal prova só coerência; a garantia exige verificar a assinatura com a chave pública
  obtida por outra via.
- Verificação manual documentada: hash com `sha512sum` (Linux) e `Get-FileHash -Algorithm SHA512`
  ou `certutil -hashfile <arquivo> SHA512` (Windows) — ⚠ não conferidos; assinatura com
  ⚠ `openssl pkeyutl -verify -rawin` e chave Ed25519 sobre `prefixo ‖ corpo` (OpenSSL 3, não
  conferido), ou um subcomando de verificação do próprio `hub` depois de instalado (lacuna de DV-20;
  serve para a próxima versão, não a primeira).

## 8. Testes de aceite (para F8-05..F8-08)

Todos usam um **par de chaves de teste gerado no próprio teste**, nunca a chave real, e home, porta
e `AGENTS_HUB_NO_AUTOSTART=1` isolados.

| # | Teste | Requisito |
|---|---|---|
| T1 | Vetores Ed25519 do RFC 8032 §7.1 passam em `crypto_ed25519_check` e **falham** em `crypto_eddsa_check` (trava o uso da função errada) | SEC-R17, A2 |
| T2 | Manifesto bom aceito; inverter 1 bit em cada região (mágico, `key:`, `sig:`, corpo) → recusa; chave desconhecida → recusa; `key_id` do corpo ≠ do cabeçalho → recusa | SEC-R17 |
| T3 | Assinatura feita **sem** o prefixo de domínio → recusa | A2 |
| T4 | Envelope > 64 KiB → abortado antes de verificar; envelope truncado → recusa | A7, C1 |
| T5 | Com assinatura válida: campo faltando, chave extra, chave duplicada, tipo errado, `size` com fração, `path` com `..` → recusa | §1.4 |
| T6 | `os`/`arch` trocados → nenhum artefato escolhido; `size`/SHA-512 divergentes → staging apagado, nada fora dele alterado | SEC-R17 |
| T7 | `serial` ≤ visto, `version` menor, `expires_at` vencido, `published_at` muito no futuro → recusa e aviso no `hub doctor`; mesma versão → nada a fazer | SEC-R18 |
| T8 | K_próxima revoga K_atual → K_atual recusada daí em diante, inclusive após reinício; K_atual revogando K_próxima → recusado (se assimétrica); `serial` gigante de chave revogada não bloqueia o legítimo | A1, §2.3 |
| T9 | Redirect para `http:` ou host fora da lista → falha; download além de `size` → abortado; TLS inválido → falha | SEC-R21 |
| T10 | Alterar o staging entre hash e troca (gancho de teste) → aborta, ou o instalado tem o SHA-512 do manifesto | SEC-R19, A4 |
| T11 | Runner Windows: troca com o processo vivo; binário novo sem `/health` → restaura o anterior; hook chamado em laço durante a troca, com falhas contadas e reportadas | SEC-R20, A5 |
| T12 | `$APPIMAGE` como link simbólico, de outro dono, com nome inesperado ou hash ≠ do instalado → não atualiza; arquivo final 0755 | G1 |
| T13 | Binário instalado adulterado → `hub doctor` acusa | SEC-R40 |
| T14 | Grep no repositório, nos workflows e nos artefatos sem o cabeçalho de chave privada; o binário contém duas chaves públicas | SEC-R22 |
| T15 | Relógio falso: no máximo 1 checagem por intervalo; 403/429 → recuo | A7, cota |
| T16 | Aprovação pendente ou sessão viva → atualização adiada | A5, §5.6 |
| T17 | F8-07: uma versão anterior encontra, confere e aplica uma pré-release de teste | F8-07 |

## 9. Lacunas para o dono (DA-04 e vizinhas)

1. Escolher: envelope E1/E2; algoritmo S1/S2; Windows W1/W2; assinatura O1/O2/O3; revogação
   simétrica ou assimétrica; prazo de `expires_at` (30 dias sugerido) e custo de reassinar.
2. Canal de pré-release e arquiteturas além de `x86_64`.
3. Numeração de versão do C (o `package.json:3` do TS está em `0.1.0`).
4. Ferramenta de assinatura (O2/O3): programa inexistente; onde fica no repositório.
5. Migração de banco × rollback (§5.6).
6. Executáveis e janela do hook durante a troca: dependem de DA-14.
7. O que `hub update` faz: DV-20.
8. Proxy e CA no AppImage: DA-13. Repositório público: DA-19.
9. Relógio do sistema muito adiantado (manifesto "vencido" para sempre) ou atrasado (manifesto
   vencido aceito): tolerância a decidir.
10. Opção do usuário ou empresa para desligar a atualização automática: não prevista no ADR 7.13.
11. Teste T9 de TLS inválido: precisa de servidor HTTPS local de teste, e o ADR 08 não traz
    biblioteca TLS de servidor; usar host externo seria chamada de rede (precisa de autorização).
12. Risco novo fora de A1–A8: migração de banco combinada com rollback do binário (§5.6); e um
    `serial` inflado por chave comprometida (mitigado pelo `serial` por chave, §2.3).
