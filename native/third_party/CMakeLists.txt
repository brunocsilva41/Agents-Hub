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
