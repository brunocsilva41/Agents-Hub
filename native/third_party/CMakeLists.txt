# Bibliotecas de terceiros vendorizadas (versões, URLs e SHA-256 em VERSIONS.md).
#
# Regras deste arquivo:
# - Cada lib vira um alvo STATIC com alias ah::<lib>.
# - Nenhuma chama ah_project_warnings(): compilam com o nível de warning padrão
#   do compilador e SEM warning como erro (o código não é nosso).
# - Os includes são PUBLIC SYSTEM: quem consome (com /W4 /WX ou -Werror) não
#   recebe warnings vindos dos cabeçalhos de terceiros.
# - Só entram defines previstos na documentação oficial de cada lib; o motivo
#   de cada um está ao lado e em VERSIONS.md.

# ------------------------------------------------------------------ SQLite
add_library(ah_sqlite3 STATIC sqlite/sqlite3.c)
add_library(ah::sqlite3 ALIAS ah_sqlite3)
target_include_directories(ah_sqlite3 SYSTEM PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/sqlite")
target_compile_definitions(ah_sqlite3 PRIVATE
  # Valor padrão documentado (modo Serialized); fixado explicitamente porque o
  # serviço será multithread e não pode depender de mudança de padrão.
  SQLITE_THREADSAFE=1)
if(UNIX)
  # https://sqlite.org/howtocompile.html: -lpthread (threadsafe), -ldl
  # (sqlite3_load_extension) e -lm.
  find_package(Threads REQUIRED)
  target_link_libraries(ah_sqlite3 PUBLIC Threads::Threads ${CMAKE_DL_LIBS} m)
endif()

# ---------------------------------------------------------- picohttpparser
add_library(ah_picohttpparser STATIC picohttpparser/picohttpparser.c)
add_library(ah::picohttpparser ALIAS ah_picohttpparser)
target_include_directories(ah_picohttpparser SYSTEM PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/picohttpparser")

# ------------------------------------------------------------------- cJSON
add_library(ah_cjson STATIC cjson/cJSON.c)
add_library(ah::cjson ALIAS ah_cjson)
target_include_directories(ah_cjson SYSTEM PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/cjson")

# ----------------------------------------------------------------- libyaml
# O CMakeLists.txt da 0.2.5 aponta para cmake/config.h.in, que não vem no
# tarball de release; por isso não usamos HAVE_CONFIG_H. As 4 macros de versão
# são exatamente as que o CMakeLists/configure.ac da 0.2.5 definem (api.c as
# usa em yaml_get_version*).
add_library(ah_yaml STATIC
  libyaml/src/api.c
  libyaml/src/dumper.c
  libyaml/src/emitter.c
  libyaml/src/loader.c
  libyaml/src/parser.c
  libyaml/src/reader.c
  libyaml/src/scanner.c
  libyaml/src/writer.c)
add_library(ah::yaml ALIAS ah_yaml)
target_include_directories(ah_yaml SYSTEM PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/libyaml/include")
target_compile_definitions(ah_yaml
  PRIVATE
    YAML_VERSION_MAJOR=0
    YAML_VERSION_MINOR=2
    YAML_VERSION_PATCH=5
    YAML_VERSION_STRING="0.2.5"
  PUBLIC
    # Lib estática: sem isto, yaml.h declara tudo __declspec(dllimport) no Windows.
    YAML_DECLARE_STATIC)
if(MSVC)
  target_compile_definitions(ah_yaml PRIVATE _CRT_SECURE_NO_WARNINGS) # igual ao CMake upstream
endif()
if(NOT WIN32)
  # api.c (yaml_strdup) chama strdup, que é POSIX.1-2008, não ISO C. Com
  # -std=c17 estrito (CMAKE_C_EXTENSIONS OFF) a glibc só declara strdup em
  # <string.h> sob __USE_XOPEN2K8 (ou __USE_XOPEN_EXTENDED); sem declaração o
  # retorno vira int e o ponteiro de 64 bits é truncado. Isso causou SEGV no
  # CI (PR #25, linux-clang-asan: strcmp em yaml_parser_append_tag_directive,
  # parser.c:1350, via ah_yaml_load). _POSIX_C_SOURCE=200809L liga
  # __USE_XOPEN2K8 em <features.h>.
  target_compile_definitions(ah_yaml PRIVATE _POSIX_C_SOURCE=200809L)
endif()

# ------------------------------------------------------------------- PCRE2
# Build "à mão" conforme NON-AUTOTOOLS-BUILD da 10.49: config.h.generic ->
# config.h, pcre2.h.generic -> pcre2.h e pcre2_chartables.c.dist ->
# pcre2_chartables.c, copiados sem edição para o diretório de build. Os
# booleanos vão por -D, como o próprio config.h.generic orienta.
# Configuração = padrões do CMake upstream: só 8 bits, Unicode ligado, SEM JIT
# (pcre2_jit_compile.c compila só os stubs quando SUPPORT_JIT não é definido;
# os stubs vêm de pcre2_jit_match_inc.h e pcre2_jit_misc_inc.h, por isso esses
# dois cabeçalhos estão vendorizados e o resto do JIT/sljit não).
set(_pcre2_gen "${CMAKE_CURRENT_BINARY_DIR}/pcre2")
configure_file(pcre2/src/config.h.generic "${_pcre2_gen}/config.h" COPYONLY)
configure_file(pcre2/src/pcre2.h.generic "${_pcre2_gen}/include/pcre2.h" COPYONLY)
configure_file(pcre2/src/pcre2_chartables.c.dist "${_pcre2_gen}/pcre2_chartables.c" COPYONLY)

add_library(ah_pcre2 STATIC
  pcre2/src/pcre2_auto_possess.c
  "${_pcre2_gen}/pcre2_chartables.c"
  pcre2/src/pcre2_chkdint.c
  pcre2/src/pcre2_compile.c
  pcre2/src/pcre2_compile_cgroup.c
  pcre2/src/pcre2_compile_class.c
  pcre2/src/pcre2_config.c
  pcre2/src/pcre2_context.c
  pcre2/src/pcre2_convert.c
  pcre2/src/pcre2_dfa_match.c
  pcre2/src/pcre2_error.c
  pcre2/src/pcre2_extuni.c
  pcre2/src/pcre2_find_bracket.c
  pcre2/src/pcre2_jit_compile.c
  pcre2/src/pcre2_maketables.c
  pcre2/src/pcre2_match.c
  pcre2/src/pcre2_match_data.c
  pcre2/src/pcre2_match_next.c
  pcre2/src/pcre2_newline.c
  pcre2/src/pcre2_ord2utf.c
  pcre2/src/pcre2_pattern_info.c
  pcre2/src/pcre2_script_run.c
  pcre2/src/pcre2_serialize.c
  pcre2/src/pcre2_string_utils.c
  pcre2/src/pcre2_study.c
  pcre2/src/pcre2_substitute.c
  pcre2/src/pcre2_substring.c
  pcre2/src/pcre2_tables.c
  pcre2/src/pcre2_ucd.c
  pcre2/src/pcre2_valid_utf.c
  pcre2/src/pcre2_xclass.c)
add_library(ah::pcre2 ALIAS ah_pcre2)
target_include_directories(ah_pcre2 PRIVATE "${_pcre2_gen}" "${CMAKE_CURRENT_SOURCE_DIR}/pcre2/src")
target_include_directories(ah_pcre2 SYSTEM PUBLIC "${_pcre2_gen}/include")
target_compile_definitions(ah_pcre2
  PRIVATE
    HAVE_CONFIG_H
    SUPPORT_PCRE2_8=1
    SUPPORT_UNICODE=1
  PUBLIC
    # Largura padrão para quem inclui pcre2.h (nomes pcre2_* sem sufixo _8).
    PCRE2_CODE_UNIT_WIDTH=8
    # Ligação estática: exigido no Windows antes de incluir pcre2.h.
    PCRE2_STATIC)
if(MSVC)
  target_compile_definitions(ah_pcre2 PRIVATE _CRT_SECURE_NO_DEPRECATE _CRT_SECURE_NO_WARNINGS) # igual ao CMake upstream
endif()

# -------------------------------------------------------------- Monocypher
# monocypher.c + o opcional monocypher-ed25519.c (Ed25519/SHA-512, ADR 8.10).
add_library(ah_monocypher STATIC
  monocypher/monocypher.c
  monocypher/optional/monocypher-ed25519.c)
add_library(ah::monocypher ALIAS ah_monocypher)
target_include_directories(ah_monocypher SYSTEM PUBLIC
  "${CMAKE_CURRENT_SOURCE_DIR}/monocypher"
  "${CMAKE_CURRENT_SOURCE_DIR}/monocypher/optional")

# ===================================================== UI (F0-12, ADR 8.4)
# SDL3 3.4.16 + SDL_ttf 3.2.2 (com FreeType 2.13.2 e HarfBuzz 8.5.0 dos forks
# libsdl-org, nos commits fixados pela tag release-3.2.2) + Clay v0.14.
#
# SDL3 e SDL_ttf compilam pelo CMake do próprio upstream, do jeito que a
# documentação deles indica para cópia vendorizada (SDL docs/README-cmake.md,
# "Using a vendored SDL"; SDL_ttf docs/INTRO-cmake.md): add_subdirectory com
# EXCLUDE_FROM_ALL e SDLTTF_VENDORED. Nada é baixado: o modo vendorizado do
# SDL_ttf só faz add_subdirectory(external/freetype) e (external/harfbuzz),
# relativos à pasta do SDL_ttf; por isso FreeType e HarfBuzz estão em
# sdl_ttf/external/, onde o upstream os espera (são os submódulos da tag).
# Nenhum dos quatro CMakeLists usa FetchContent/ExternalProject/file(DOWNLOAD).
#
# As opções são definidas como variáveis normais antes de cada
# add_subdirectory. Com a CMP0077 em NEW (os dois upstreams exigem CMake
# >= 3.16), option() respeita a variável normal e NÃO grava no cache; só
# cmake_dependent_option (ex.: SDL_SHARED, SDL_STATIC, BUILD_SHARED_LIBS do
# SDL_ttf) grava o valor no cache.
#
# Bibliotecas compartilhadas (SDL3 e SDL3_ttf), que é o padrão dos dois
# upstreams (exceção à regra "STATIC" do topo deste arquivo; os alvos são os
# do próprio upstream, com alias ah::); FreeType e HarfBuzz entram estáticos
# dentro do SDL3_ttf (o SDL_ttf força isso). Warnings: os de cada upstream,
# sem warning como erro (SDL_WERROR e SDLTTF_WERROR ficam no padrão OFF).
# O SDL3 (no Windows) e o HarfBuzz habilitam C++: o compilador C++ vem do
# preset (CMAKE_CXX_COMPILER em CMakePresets.json).

# ---------------------------------------------------------------- SDL3
# Opções da tabela de docs/README-cmake.md do SDL 3.4.16.
set(SDL_SHARED ON)          # SDL3.dll / libSDL3.so (padrão upstream)
set(SDL_STATIC OFF)
set(SDL_TEST_LIBRARY OFF)   # SDL3_test não é usado pelo projeto
set(SDL_TESTS OFF)
set(SDL_EXAMPLES OFF)
set(SDL_INSTALL OFF)        # instalação/pacote é da F8 (já é o padrão como subprojeto)
add_subdirectory(sdl3 EXCLUDE_FROM_ALL)
add_library(ah::sdl3 ALIAS SDL3-shared)

# ------------------------------------------------------------- SDL_ttf
# Opções do CMakeLists.txt do SDL_ttf 3.2.2.
set(BUILD_SHARED_LIBS ON)   # SDL3_ttf compartilhado (padrão upstream); ver VERSIONS.md
set(SDLTTF_VENDORED ON)     # compila external/freetype e external/harfbuzz (sem download)
set(SDLTTF_HARFBUZZ ON)     # shaping (DA-12)
set(SDLTTF_PLUTOSVG OFF)    # sem plutosvg (DA-12: emoji COLR sem plutosvg)
set(SDLTTF_SAMPLES OFF)
set(SDLTTF_INSTALL OFF)
add_subdirectory(sdl_ttf EXCLUDE_FROM_ALL)
add_library(ah::sdl3_ttf ALIAS SDL3_ttf-shared)
# O SDL_ttf grava BUILD_SHARED_LIBS=ON no cache (cmake_dependent_option).
# Apaga a variável normal e a do cache para src/ e tests/ não herdarem
# bibliotecas compartilhadas por padrão.
unset(BUILD_SHARED_LIBS)
unset(BUILD_SHARED_LIBS CACHE)

# ---------------------------------------------------------------- Clay
# Biblioteca de um cabeçalho: a implementação entra numa TU gerada no build (o
# clay.h vendorizado fica sem edição), compilada como código de terceiro.
set(_clay_impl "${CMAKE_CURRENT_BINARY_DIR}/clay/clay_impl.c")
file(CONFIGURE OUTPUT "${_clay_impl}"
  CONTENT "/* Gerado por native/third_party/CMakeLists.txt: implementação do Clay. */\n#define CLAY_IMPLEMENTATION\n#include \"clay.h\"\n"
  @ONLY)
add_library(ah_clay STATIC "${_clay_impl}")
add_library(ah::clay ALIAS ah_clay)
target_include_directories(ah_clay SYSTEM PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/clay")
