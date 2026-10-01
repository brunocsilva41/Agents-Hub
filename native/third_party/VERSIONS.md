# Bibliotecas de terceiros vendorizadas

Baixadas em 2026-09-30, só das fontes oficiais (sqlite.org e GitHub dos projetos).
Daqui foram copiados **só** os arquivos-fonte usados no build e a licença, sem
nenhuma edição. O build está em [CMakeLists.txt](CMakeLists.txt); nenhum passo
do build baixa nada.

O SHA-256 é o do arquivo baixado (zip/tar.gz), calculado com `sha256sum`.

| Lib | Versão | URL exata do arquivo baixado | SHA-256 do arquivo | Licença |
|---|---|---|---|---|
| SQLite (amalgamation) | 3.53.4 | https://sqlite.org/2026/sqlite-amalgamation-3530400.zip | `1e71ddf93849c6a6ecf58b827c0692073d2dd7ee40196158068f7b29f422e87d` | Domínio público |
| picohttpparser | 1.4 (tag `v1.4`, commit `516cdd3e00b35569dc0edc5f1b74d245cb323e57`) | https://github.com/h2o/picohttpparser/archive/refs/tags/v1.4.tar.gz | `5d4a2f11d8596843ebb485d6b66a354368aa64a0007cd817219c3f03aaf5a712` | MIT ou Perl (à escolha) |
| cJSON | 1.7.19 (tag `v1.7.19`) | https://github.com/DaveGamble/cJSON/archive/refs/tags/v1.7.19.tar.gz | `7fa616e3046edfa7a28a32d5f9eacfd23f92900fe1f8ccd988c1662f30454562` | MIT |
| libyaml | 0.2.5 | https://github.com/yaml/libyaml/releases/download/0.2.5/yaml-0.2.5.tar.gz | `c642ae9b75fee120b2d96c712538bd2cf283228d2337df2cf2988e3c02678ef4` | MIT |
| PCRE2 | 10.49 | https://github.com/PCRE2Project/pcre2/releases/download/pcre2-10.49/pcre2-10.49.tar.gz | `929f0b20e62879252a15886b06c89f1edef61a363cbd5826fb041080a5e557ae` | BSD-3-Clause com exceção PCRE2 (LICENCE.md) |
| Monocypher | 4.0.3 | https://github.com/LoupVaillant/Monocypher/releases/download/4.0.3/monocypher-4.0.3.tar.gz | `8cc9bc341a66249016db9bd70e9142d8d0aef9945973744b1ac05dbc55d8ee66` | BSD-2-Clause ou CC0-1.0 (à escolha) |

## Notas por biblioteca

### SQLite 3.53.4

- Arquivos: `sqlite/sqlite3.c`, `sqlite/sqlite3.h` (o `shell.c` e o `sqlite3ext.h` do zip não são usados).
- Conferência extra: o SHA3-256 do zip
  (`628a44cfe82c66aed1ccbbe85a562d2e33ebe64b3288981ed76285612227934e`) bate com o publicado em
  https://sqlite.org/download.html (a página publica SHA3-256, não SHA-256).
- Licença: domínio público, declarado no cabeçalho de `sqlite3.c`/`sqlite3.h` (o zip não traz arquivo de licença).
- Defines de compilação (todos documentados em https://sqlite.org/compile.html):
  - `SQLITE_THREADSAFE=1` — é o valor padrão (modo Serialized); fixado explicitamente porque o
    serviço será multithread e não deve depender de mudança de padrão.
  - Nenhum outro. O JSON embutido e as colunas geradas, exigidos pelo esquema atual (ADR 08), já
    vêm ligados por padrão nesta versão.
- Ligação no Linux: `pthread`, `dl` e `m`, conforme https://sqlite.org/howtocompile.html.

### picohttpparser 1.4

- O projeto não publica "release" no GitHub; a referência oficial é a tag `v1.4` (criada em
  2026-09-29 pela automação de release do projeto; `master` não tinha commits além dela em 2026-09-30).
  O arquivo é o tarball que o GitHub gera para a tag.
- Arquivos: `picohttpparser.c`, `picohttpparser.h`.
- Licença: o tarball não traz arquivo de licença; o texto MIT (com a opção Perl) está no cabeçalho
  de `picohttpparser.c` e no README do projeto.
- Defines: nenhum.

### cJSON 1.7.19

- O release não tem arquivo anexado; o arquivo é o tarball que o GitHub gera para a tag `v1.7.19`.
- Arquivos: `cJSON.c`, `cJSON.h`, `LICENSE` (o `cJSON_Utils` não é usado).
- Defines: nenhum.

### libyaml 0.2.5

- Arquivos: `include/yaml.h`, `src/*.c` (8 arquivos), `src/yaml_private.h`, `License`.
- O `CMakeLists.txt` da 0.2.5 referencia `cmake/config.h.in`, que **não vem no tarball de
  release**; por isso o build não usa `HAVE_CONFIG_H`. Defines:
  - `YAML_VERSION_MAJOR=0`, `YAML_VERSION_MINOR=2`, `YAML_VERSION_PATCH=5`,
    `YAML_VERSION_STRING="0.2.5"` — os mesmos valores que o `CMakeLists.txt`/`configure.ac` da
    0.2.5 definem; usados por `src/api.c` (`yaml_get_version*`).
  - `YAML_DECLARE_STATIC` (público) — lib estática; sem ele, `yaml.h` declara a API como
    `__declspec(dllimport)` no Windows (igual ao CMake upstream).
  - `_CRT_SECURE_NO_WARNINGS` (só MSVC) — igual ao CMake upstream.

### PCRE2 10.49

- Assinatura: o release publica `pcre2-10.49.tar.gz.sig`; **a assinatura GPG não foi verificada**
  (só o SHA-256 acima foi registrado).
- Build por CMake próprio mínimo, seguindo "Generic instructions for the PCRE2 C libraries" do
  `NON-AUTOTOOLS-BUILD` da 10.49: `src/config.h.generic` → `config.h`, `src/pcre2.h.generic` →
  `pcre2.h` e `src/pcre2_chartables.c.dist` → `pcre2_chartables.c`, copiados sem edição para o
  diretório de build.
- Arquivos: as 31 fontes da lista do passo (4) do `NON-AUTOTOOLS-BUILD` (30 `.c` mais o
  `pcre2_chartables.c`, gerado da cópia do `.dist`), os cabeçalhos internos que
  elas incluem (`pcre2_internal.h`, `pcre2_intmodedep.h`, `pcre2_compile.h`, `pcre2_ucp.h`,
  `pcre2_ucptables_inc.h`, `pcre2_util.h`, e `pcre2_jit_match_inc.h`/`pcre2_jit_misc_inc.h`, que
  contêm os stubs usados quando o JIT está desligado), os três `.generic`/`.dist` acima e
  `LICENCE.md`. O `deps/sljit` (JIT) não foi copiado.
- Configuração = padrões do CMake upstream da 10.49 (`PCRE2_BUILD_PCRE2_8=ON`,
  `PCRE2_SUPPORT_UNICODE=ON`, `PCRE2_SUPPORT_JIT=OFF`). Defines:
  - `HAVE_CONFIG_H` — usa o `config.h` (cópia do `.generic`) para os valores não booleanos.
  - `SUPPORT_PCRE2_8=1` — biblioteca de 8 bits (só ela).
  - `SUPPORT_UNICODE=1` — Unicode/UTF-8 (padrão upstream).
  - **Sem `SUPPORT_JIT`**: JIT desligado por ora (decisão desta tarefa; religar exige vendorizar
    `deps/sljit`).
  - `PCRE2_CODE_UNIT_WIDTH=8` (público) — exigido pelo `pcre2.h` para escolher a largura.
  - `PCRE2_STATIC` (público) — ligação estática; exigido no Windows antes de incluir `pcre2.h`.
  - `_CRT_SECURE_NO_DEPRECATE`, `_CRT_SECURE_NO_WARNINGS` (só MSVC) — iguais ao CMake upstream.

### Monocypher 4.0.3

- Arquivos: `monocypher.c`, `monocypher.h`, `optional/monocypher-ed25519.c`,
  `optional/monocypher-ed25519.h` (Ed25519 e SHA-512, ADR 8.10), `LICENCE.md`.
- Defines: nenhum.

## Como atualizar uma lib

1. Baixar o novo arquivo da mesma fonte oficial e calcular `sha256sum`.
2. Substituir só os arquivos listados acima (sem editar o conteúdo).
3. Atualizar esta tabela (versão, URL, SHA-256) e conferir se os defines ainda batem com a
   documentação da nova versão (o `NON-AUTOTOOLS-BUILD` do PCRE2 avisa que isso muda entre releases).
4. Rodar todos os presets (ver `native/README.md`).
