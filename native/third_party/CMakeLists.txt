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
# add_subdirectory (o option() do upstream as respeita e as copia para o
# cache). Bibliotecas compartilhadas (SDL3 e SDL3_ttf), que é o padrão dos dois
# upstreams (exceção à regra "STATIC" do topo deste arquivo; os alvos são os
# do próprio upstream, com alias ah::); FreeType e HarfBuzz entram estáticos
# dentro do SDL3_ttf (o SDL_ttf força isso). Warnings: os de cada upstream,
# sem warning como erro (SDL_WERROR e SDLTTF_WERROR ficam no padrão OFF).

# ------------------------------------------------- compilador C++ (UI)
# O SDL3 (enable_language(CXX) no Windows) e o SDL_ttf (HarfBuzz é C++)
# habilitam C++. Os presets só fixam o compilador C; sem isto o CMake escolhe
# o C++ padrão do sistema: com clang-cl ele pega clang++ (sintaxe GNU) e
# quebra, e no Linux Clang pegaria g++, misturando runtimes de ASan. Por isso
# o C++ segue o compilador C do preset, salvo se CMAKE_CXX_COMPILER ou a
# variável de ambiente CXX já o definirem.
if(NOT DEFINED CMAKE_CXX_COMPILER AND NOT DEFINED ENV{CXX})
  if(CMAKE_C_COMPILER_FRONTEND_VARIANT STREQUAL "MSVC")
    # cl.exe e clang-cl compilam C e C++ com o mesmo executável.
    set(CMAKE_CXX_COMPILER "${CMAKE_C_COMPILER}")
  else()
    if(CMAKE_C_COMPILER_ID STREQUAL "GNU")
      set(_ah_cxx_name g++)
    elseif(CMAKE_C_COMPILER_ID STREQUAL "Clang")
      set(_ah_cxx_name clang++)
    else()
      message(FATAL_ERROR "compilador C ${CMAKE_C_COMPILER_ID} sem par C++ conhecido; defina CMAKE_CXX_COMPILER")
    endif()
    get_filename_component(_ah_c_dir "${CMAKE_C_COMPILER}" DIRECTORY)
    find_program(AH_CXX_COMPILER NAMES ${_ah_cxx_name} HINTS "${_ah_c_dir}" NO_DEFAULT_PATH)
    if(NOT AH_CXX_COMPILER)
      message(FATAL_ERROR "não achei ${_ah_cxx_name} ao lado de ${CMAKE_C_COMPILER}; defina CMAKE_CXX_COMPILER")
    endif()
    set(CMAKE_CXX_COMPILER "${AH_CXX_COMPILER}")
  endif()
  message(STATUS "UI: compilador C++ = ${CMAKE_CXX_COMPILER}")
endif()

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
