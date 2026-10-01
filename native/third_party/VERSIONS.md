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
| SDL3 | 3.4.16 (`REVISION.txt`: `release-3.4.16-0-gfa2c02bb6`) | https://github.com/libsdl-org/SDL/releases/download/release-3.4.16/SDL3-3.4.16.tar.gz | `7322236cd12090c3eb40b9728be4d49c76f66ad17d04369584d4ecad5cf77c68` | Zlib |
| SDL_ttf | 3.2.2 (`REVISION.txt`: `release-3.2.2-0-ga1ce367`) | https://github.com/libsdl-org/SDL_ttf/releases/download/release-3.2.2/SDL3_ttf-3.2.2.tar.gz | `63547d58d0185c833213885b635a2c0548201cc8f301e6587c0be1a67e1e045d` | Zlib |
| FreeType (fork `libsdl-org/freetype`, submódulo do SDL_ttf 3.2.2) | 2.13.2 (commit `9973564cfa63763a3e4ac67c09147899539b1e07`) | https://github.com/libsdl-org/freetype/archive/9973564cfa63763a3e4ac67c09147899539b1e07.tar.gz | `026a05a49d114a1235d2926f4c03a9330e4b1a6efe7c217ec9607904c32907d4` | FreeType License (FTL), escolhida; a outra opção é GPLv2 |
| HarfBuzz (fork `libsdl-org/harfbuzz`, submódulo do SDL_ttf 3.2.2) | 8.5.0 (commit `564bf9818a18709776856533829c0c04950773d6`) | https://github.com/libsdl-org/harfbuzz/archive/564bf9818a18709776856533829c0c04950773d6.tar.gz | `a448dd6c22d8e1e1cf39438c662251c1f97f810b8780eed4a6d6ada948c99ddc` | "Old MIT" (`COPYING`); `src/ms-use/` MIT (Microsoft) |
| Clay (`clay.h`) | v0.14 | https://github.com/nicbarker/clay/releases/download/v0.14/clay.h | `c97241cc423af3fa11267978adce9cbb46274a2ad0709a5d4b2b1092dc27599d` | Zlib |
| Clay (`LICENSE.md`, `README.md`) | v0.14 | https://github.com/nicbarker/clay/archive/refs/tags/v0.14.zip | `e8f7eb9202561527cd8bd4d5e9f110f937c11b1f9de3dc91dd1e3ee7e31e5d15` | Zlib |

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

### UI: SDL3 3.4.16, SDL_ttf 3.2.2, FreeType 2.13.2, HarfBuzz 8.5.0, Clay v0.14 (F0-12)

Pilha do ADR 8.4; FreeType e HarfBuzz vendorizados com o SDL_ttf (DA-25, ADR 09) e HarfBuzz
ligado, sem plutosvg (DA-12, ADR 09). Baixados em 2026-09-30.

**Conferência dos arquivos.** O SHA-256 do `SDL3-3.4.16.tar.gz` e do `clay.h` é igual ao
`digest` do asset na API do GitHub (`/repos/<dono>/<repo>/releases/tags/<tag>`). O release
do SDL_ttf 3.2.2 não publica `digest` (campo `null`), e a assinatura `.sig` não foi conferida.
FreeType e HarfBuzz não têm release próprio no fork: o arquivo é o tarball que o GitHub gera
para o commit; a referência forte é o hash do commit (o GitHub não garante bytes estáveis
para tarballs gerados).

**De onde vêm FreeType e HarfBuzz.** O tarball de release do SDL_ttf não traz `external/`. O
`.gitmodules` da tag `release-3.2.2` aponta para os forks `libsdl-org/freetype` (branch
`VER-2-13-2-SDL`) e `libsdl-org/harfbuzz` (branch `8.5.0-SDL`); os commits acima são os que a
árvore da tag fixa (API `contents/external/<lib>?ref=release-3.2.2`, campo `sha` do
submódulo). plutosvg e plutovg, também submódulos, **não** foram baixados.

**Onde estão.** `sdl3/`, `clay/` e `sdl_ttf/`, com FreeType em `sdl_ttf/external/freetype/` e
HarfBuzz em `sdl_ttf/external/harfbuzz/`. Não ficam em `third_party/freetype/` e
`third_party/harfbuzz/` porque o modo vendorizado do SDL_ttf 3.2.2 faz
`add_subdirectory(external/freetype)` e `add_subdirectory(external/harfbuzz)` relativos à
própria pasta, sem opção para mudar o caminho; outro lugar exigiria editar o CMake do SDL_ttf.

**O que foi copiado (sem edição, com uma exceção registrada em "Patches aplicados", abaixo; o
resto do arquivo baixado ficou de fora).**

| Lib | Copiado | Fora (motivo) | Tamanho no repositório |
|---|---|---|---|
| SDL3 | `CMakeLists.txt`, `cmake/`, `include/`, `src/`, `wayland-protocols/` (usado pelo CMake no Linux), `LICENSE.txt`, `README.md`, `CREDITS.md`, `REVISION.txt` (sem ele o CMake chama `git describe`) | `test/`, `examples/` (`SDL_TESTS`/`SDL_EXAMPLES` desligados), `docs/`, `build-scripts/` (só para man pages na instalação), `VisualC*/`, `Xcode/`, `android-project/`, `Android.mk`, `INSTALL.md`, `WhatsNew.txt` | 33 MB (o tarball extraído tem 53 MB) |
| SDL_ttf | `CMakeLists.txt`, `cmake/`, `include/`, `src/`, `LICENSE.txt`, `README.md`, `REVISION.txt` | `examples/`, `docs/`, `build-scripts/`, `VisualC/`, `Xcode/` (15 MB), `mingw/`, `Android.mk`, `external/download.sh` e `Get-GitModules.ps1` (scripts de download) | 0,8 MB sem `external/` |
| FreeType | `CMakeLists.txt`, `builds/` (o CMake usa `builds/cmake`, `builds/unix`, `builds/windows`...), `include/`, `src/`, `LICENSE.TXT`, `README`, `docs/FTL.TXT`, `docs/GPLv2.TXT` | resto de `docs/`, `devel/`, `objs/`, `tests/`, `subprojects/`, arquivos de make/meson/autotools | 9,8 MB (13 MB extraído) |
| HarfBuzz | `CMakeLists.txt`, `src/`, `util/Makefile.sources` e `configure.ac` (lidos por `file(READ)` no CMake), `replace-enum-strings.cmake`, `COPYING`, `README.md` | `test/` (90 MB), `perf/`, `docs/`, resto de `util/`, `config*.h` (não usados pelo CMake), meson/autotools | 6,4 MB (100 MB extraído) |
| Clay | `clay.h` (asset do release), `LICENSE.md` e `README.md` (do zip da tag; o `clay.h` do zip é idêntico ao asset, conferido com `cmp`) | `renderers/` (o renderer SDL3 oficial usa VLA e não compila no MSVC em C17, relatório da F0-14 §8), `examples/`, `bindings/`, `tests/`, `cmake/` | 0,4 MB |

Oito arquivos do SDL3 casam com regras de ignore (`src/hidapi/dist/hidapi.podspec`, pela regra
`dist/` do `.gitignore` da raiz, e sete `src/render/gpu/shaders/*.hlsl`, pelo `.gitignore` do
próprio SDL nessa pasta). Foram adicionados com `git add -f` para a cópia ficar igual ao tarball.

**Build** (em [CMakeLists.txt](CMakeLists.txt), seção "UI"). SDL3 e SDL_ttf usam o CMake do
upstream via `add_subdirectory(... EXCLUDE_FROM_ALL)`, como indicam SDL `docs/README-cmake.md`
("Using a vendored SDL") e SDL_ttf `docs/INTRO-cmake.md`. Nenhum dos CMakeLists (SDL3,
SDL_ttf, FreeType, HarfBuzz) usa `FetchContent`, `ExternalProject` ou `file(DOWNLOAD)`. Opções
(definidas como variáveis normais antes de cada `add_subdirectory`; com a CMP0077 em NEW, o
`option()` do upstream respeita a variável normal e **não** grava no cache; só as que são
`cmake_dependent_option`, como `SDL_SHARED`, `SDL_STATIC` e o `BUILD_SHARED_LIBS` do SDL_ttf,
gravam o valor no cache):

- SDL3: `SDL_SHARED=ON`, `SDL_STATIC=OFF` (padrão upstream: só a biblioteca compartilhada),
  `SDL_TEST_LIBRARY=OFF`, `SDL_TESTS=OFF`, `SDL_EXAMPLES=OFF`, `SDL_INSTALL=OFF`. Subsistemas no
  padrão upstream (nenhum desligado).
- SDL_ttf: `SDLTTF_VENDORED=ON` (compila `external/freetype` e `external/harfbuzz`; o padrão
  fora do MSVC é OFF, que procuraria as libs do sistema), `SDLTTF_HARFBUZZ=ON`,
  `SDLTTF_PLUTOSVG=OFF`, `SDLTTF_SAMPLES=OFF`, `SDLTTF_INSTALL=OFF`, `BUILD_SHARED_LIBS=ON`
  (SDL3_ttf compartilhado, padrão upstream). O SDL_ttf compila FreeType e HarfBuzz estáticos
  dentro do SDL3_ttf e força, no FreeType, `FT_DISABLE_ZLIB/BZIP2/PNG/BROTLI=ON` e
  `FT_REQUIRE_HARFBUZZ=ON`: nenhuma outra dependência transitiva entra.
  O SDL_ttf grava `BUILD_SHARED_LIBS=ON` no cache (é um `cmake_dependent_option`); logo depois
  do `add_subdirectory(sdl_ttf)` o `CMakeLists.txt` faz `unset(BUILD_SHARED_LIBS)` e
  `unset(BUILD_SHARED_LIBS CACHE)`, para `src/` e `tests/` não herdarem bibliotecas
  compartilhadas por padrão.
- Compilador C++: o SDL3 (no Windows) e o HarfBuzz habilitam C++. Cada preset de
  `native/CMakePresets.json` fixa `CMAKE_CXX_COMPILER` par do compilador C (`cl`, `clang-cl`,
  `g++`, `clang++`). Sem isso o preset clang-cl pegava `clang++` com flags do MSVC e o configure
  falhava, e o Linux Clang pegaria `g++`, misturando runtimes de ASan.
- Clay: a implementação (`#define CLAY_IMPLEMENTATION` + `#include "clay.h"`) vai numa TU gerada
  em `build/.../third_party/clay/clay_impl.c` (`file(CONFIGURE)`), alvo `ah_clay` com alias
  `ah::clay`. O `clay.h` fica sem edição.
- Alvos para o projeto: `ah::sdl3` (alias de `SDL3-shared`), `ah::sdl3_ttf` (alias de
  `SDL3_ttf-shared`), `ah::clay`.
- Warnings: os do próprio upstream, sem warning como erro (`SDL_WERROR` e `SDLTTF_WERROR` no
  padrão OFF). Com `AH_SANITIZE`, SDL3, SDL_ttf, FreeType e HarfBuzz também são instrumentados.

**Licenças e distribuição com o Hub (MIT).**

- SDL3, SDL_ttf e Clay: Zlib. Permite uso comercial e redistribuição binária; o crédito na
  documentação é "apreciado, não exigido".
- FreeType: escolhemos a **FTL** (a GPLv2 obrigaria o Hub a ser GPL). A FTL é do estilo BSD com
  cláusula de crédito: quem distribui um programa que usa FreeType **deve citar na documentação
  que usa código do FreeType** (`docs/FTL.TXT`, "credits"; texto sugerido: "Portions of this
  software are copyright © 2023 The FreeType Project (www.freetype.org). All rights reserved.",
  com o ano da versão usada). É compatível com distribuir o Hub sob MIT, desde que esse crédito
  vá na documentação/tela "sobre" e o `FTL.TXT` acompanhe a distribuição de fonte.
- HarfBuzz: "Old MIT" (o aviso de copyright e os dois parágrafos de `COPYING` devem aparecer em
  todas as cópias); `src/ms-use/` é MIT (Microsoft), mesma exigência de aviso. Compatível com
  MIT.
- Código de terceiros dentro do SDL3 com licença própria, por exemplo `src/hidapi/` (HIDAPI,
  escolha entre GPLv3, BSD ou licença original; para o Hub, BSD ou original) e
  `src/video/yuv2rgb/` (BSD-3). O inventário completo dos avisos de terceiros que vão no
  instalador **não** foi feito aqui (fica para o empacotamento).

**Tamanho dos binários** (2026-09-30, Windows x64, build limpo com os presets):

| Preset | `SDL3.dll` | `SDL3_ttf.dll` | `test_ui_smoke.exe` |
|---|---|---|---|
| `windows-msvc-release` | 2.713.088 B | 1.590.784 B | 92.672 B |
| `windows-msvc-debug` | 6.840.832 B | 5.404.160 B | 331.264 B |
| `windows-clangcl-asan` | 13.063.168 B | 7.800.320 B | 359.936 B |

No Release, `SDL3.dll` importa só DLLs do Windows e o CRT (`VCRUNTIME140.dll`,
`api-ms-win-crt-*`); `SDL3_ttf.dll` importa `SDL3.dll`, `GDI32`, `USP10`, `RPCRT4`, `KERNEL32`,
`USER32` e o CRT, incluindo `VCRUNTIME140_1.dll` (C++ do HarfBuzz). Nenhum símbolo plutosvg
(`dumpbin /dependents` e `/exports`). Os binários oficiais pré-compilados usados no spike da
F0-14 não dependiam do VC++ Redistributable; estes dependem (CRT `/MD`, padrão do projeto).

**Teste:** `native/tests/unit/ui_smoke/` (CTest `unit.ui_smoke`): janela SDL3 oculta; versões
compiladas (SDL 3.4.16, SDL_ttf 3.2.2, FreeType 2.13.2, HarfBuzz 8.5.0); medida de texto
latino; render do texto pelos caminhos de blit Blended (opaco e com alpha), Shaded e LCD, com
tinta na superfície (sem `Solid`: ver "Defeitos conhecidos"); **shaping** (a palavra árabe de quatro BEH tem de medir menos de 80% de quatro BEH
isolados, o que só acontece com as formas contextuais do HarfBuzz, e `TTF_SetFontDirection(RTL)`
tem de ser aceito); **emoji COLR** (só no Windows: U+1F600 do `seguiemj.ttf` renderizado numa
superfície com cor de frente cinza tem de ter pixels coloridos, não R=G=B); layout vazio no
Clay. Fontes do sistema: `segoeui.ttf` e `seguiemj.ttf` no Windows, DejaVu Sans no Linux
(nenhuma fonte é vendorizada); fonte exigida ausente é **falha**, em qualquer SO. Skip (sai com 77
e o CTest marca "Skipped", `SKIP_RETURN_CODE 77`, sempre com mensagem `SKIP: ...`) só por falta
de display e só fora do Windows: sem `DISPLAY` nem `WAYLAND_DISPLAY` (sai antes de tocar no
SDL) ou `SDL_Init(SDL_INIT_VIDEO)` falhando; no Windows, `SDL_Init` falhar é falha. No Linux o
emoji colorido não é testado (DA-12 em aberto; a saída diz isso). No CI Linux o teste roda sob
`xvfb-run -a -s "-screen 0 1280x1024x24"`.

## Patches aplicados

Código vendorizado não é editado (`docs/18-padroes-c.md` §14), salvo os patches abaixo. Os
patches já estão no fonte versionado (o build não aplica nada); os `.patch` em `patches/<lib>/`
são o registro e a prova, aplicados em ordem numérica. A conferência de integridade (`cmp` de
cada arquivo contra o download oficial) tem exatamente as diferenças desta tabela (hoje, um
único arquivo: `sdl_ttf/src/SDL_ttf.c`).

| Lib | Arquivo | Patch | Commits upstream | Motivo | SHA-256 do arquivo depois do patch |
|---|---|---|---|---|---|
| SDL_ttf 3.2.2 | `sdl_ttf/src/SDL_ttf.c` (funções de blit de glifo e `Render_Line_##NAME`) | [`patches/sdl_ttf/0001-blit-ponteiros-alinhados.patch`](patches/sdl_ttf/0001-blit-ponteiros-alinhados.patch) | [`6ea7d33927211629bf8326b7cc6caad34f3d4122`](https://github.com/libsdl-org/SDL_ttf/commit/6ea7d33927211629bf8326b7cc6caad34f3d4122) e [`a9a4fea81b41f3ceefcfacd5b32fa3e838a554c0`](https://github.com/libsdl-org/SDL_ttf/commit/a9a4fea81b41f3ceefcfacd5b32fa3e838a554c0) **inteiros** (todos os hunks; o segundo corrige o `dst +=` que o primeiro introduziu em `BG_Blended_Color`) | UB de alinhamento: as funções de blit do 3.2.2 criam e leem ponteiros `Uint32`/`Uint64` desalinhados sobre os buffers de glifo. Achada pelo UBSan (preset `windows-clangcl-asan`) no teste de emoji colorido do `unit.ui_smoke` (`SDL_ttf.c:467:13: runtime error: load of misaligned address`); as demais funções de blit (LCD, 32/64 bits, SSE, 8 bits) têm o mesmo padrão | `4dba9c5de63ee61faf4e6fb9bcc61fb38f6c42e66746b2d1c480e28382ced14e` (intermediário; o do tarball é `25a42804b18809e5c4b2eb8ed787701551d0c680aff774b7d8c54486c0d42d38`) |
| SDL_ttf 3.2.2 | `sdl_ttf/src/SDL_ttf.c` (`Render_Line_##NAME`) | [`patches/sdl_ttf/0002-render-line-buffer-nulo.patch`](patches/sdl_ttf/0002-render-line-buffer-nulo.patch) | [`7930c0282bbec7be92195218b3a1e9e58537e6f9`](https://github.com/libsdl-org/SDL_ttf/commit/7930c0282bbec7be92195218b3a1e9e58537e6f9) inteiro ("Fixed bug #537"; o pai dele é exatamente o `SDL_ttf.c` do 3.2.2) | UB: `image->buffer += alignment` com `buffer` NULL (glifo sem bitmap, ex.: espaço). Achada pelo UBSan (preset `windows-clangcl-asan`) no `unit.ui_smoke` estendido (render Shaded/LCD/Blended): `SDL_ttf.c:1318:1: runtime error: applying non-zero offset 15 to null pointer` | `afd59291c3ab9f3d381c385b92ad58370fc8118c031e622cf6c2d009805e91b3` (**final**, o do arquivo versionado) |

- Os dois commits aplicaram sobre o 3.2.2 com `git apply`, todos os hunks limpos e sem fuzz; só
  o hunk 20 do 6ea7d33 (`Render_Line_##NAME`) entra com deslocamento de -5 linhas (commits
  intermediários mudaram linhas acima dele). Nenhuma adaptação manual. O `.patch` é o diff
  combinado tarball → fonte corrigido; a linha `index` dele aponta para o blob do tarball
  (`be517a18…`) e para o blob do arquivo corrigido (`2d6e03b6…`).
- O 6ea7d33 inclui o helper `_mm_loadu_si128_unaligned` com
  `__attribute__((no_sanitize("alignment")))`, sob `HAVE_SSE2_INTRINSICS` (`__SSE2__`): é escolha
  do upstream (desliga o sanitizer de alinhamento só nessa carga SIMD) e só compila em
  GCC/Clang/clang-cl; o `cl` não define `__SSE2__` e não passa por ele.
- O 0002 aplica depois do 0001 com `git apply`: hunk único, limpo, sem fuzz, deslocamento de +17
  linhas. É o diff do estado depois do 0001 para o estado final (`index` `2d6e03b6…` →
  `008d4762…`). Cadeia conferida: tarball (`be517a18…`) + 0001 + 0002, aplicados a partir dos
  `.patch` do repositório, reproduz exatamente o blob versionado (`008d4762…`).
- Prova, a partir da raiz do repositório (o 0002 primeiro, porque é o último aplicado):
  `git apply --check -R native/third_party/patches/sdl_ttf/0002-render-line-buffer-nulo.patch`
  tem de passar; para conferir o 0001, revertendo o 0002 numa cópia de trabalho, o
  `git apply --check -R` do 0001 também passa.
- **Regra de remoção:** quando sair um release do SDL_ttf com as correções (em 2026-10-01 o
  último release era o 3.2.2, de 2025-03-31), atualizar para ele, apagar os `.patch` e estas
  linhas, e voltar a conferência de integridade a zero diferenças.

## Defeitos conhecidos (sem patch)

| Lib | Defeito | Efeito | Regra enquanto estiver aberto |
|---|---|---|---|
| FreeType 2.13.2 (`sdl_ttf/external/freetype/`) | [Issue #1261, "Windows pointer alignment"](https://gitlab.freedesktop.org/freetype/freetype/-/work_items/1261), aberta desde 2023-10-15. O rasterizador mono (`src/raster/ftraster.c`) põe cada `TProfile` logo depois de `height` elementos `Long`; no Windows 64-bit `Long` tem 4 bytes e o `TProfile` (com ponteiros) fica alinhado só a 4. Sem correção no upstream: nem na 2.13.3 nem no `master` (conferido em 2026-10-01; `New_Profile` ainda faz `ras.cProfile = (PProfile)ras.top`) | UB de alinhamento no render mono no Windows 64-bit. O UBSan (preset `windows-clangcl-asan`) aborta em `ftraster.c:727:21: member access within misaligned address ... 'TProfile'` ao renderizar com `TTF_RenderText_Solid` | **A UI não usa render `Solid` (`TTF_Render*_Solid`) enquanto a #1261 estiver aberta.** O `unit.ui_smoke` não testa o `Solid` por isso (comentário em `test_render_paths`). Não há patch local nem sanitizer desligado. Remover este registro (e voltar o `Solid` ao teste) quando o upstream corrigir e o FreeType vendorizado for atualizado |

## Como atualizar uma lib

1. Baixar o novo arquivo da mesma fonte oficial e calcular `sha256sum`.
2. Substituir só os arquivos listados acima (sem editar o conteúdo). Se a lib tem patch em
   "Patches aplicados", conferir se a versão nova já traz a correção (então remover o patch) ou
   reaplicá-lo.
3. Atualizar esta tabela (versão, URL, SHA-256) e conferir se os defines ainda batem com a
   documentação da nova versão (o `NON-AUTOTOOLS-BUILD` do PCRE2 avisa que isso muda entre releases).
4. Rodar todos os presets (ver `native/README.md`).
