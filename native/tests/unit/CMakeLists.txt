# Testes unitários. Testes de plataforma são registrados pelos fragmentos de
# native/src/platform/ (fs/time/proc/net.cmake); os demais são registrados aqui.
add_executable(test_smoke test_smoke.c)
target_link_libraries(test_smoke PRIVATE ah::core ah::sqlite3)
ah_project_warnings(test_smoke)
ah_add_test(unit.smoke test_smoke)

# F0-10: utilitários do core sem I/O.
#
# O teste de YAML lê o manifesto real manifests/claude.yaml sem I/O: os bytes
# do arquivo viram um vetor C num cabeçalho gerado na configuração (refeita
# quando o manifesto muda, via CMAKE_CONFIGURE_DEPENDS).
set(_ah_claude_manifest "${PROJECT_SOURCE_DIR}/../manifests/claude.yaml")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${_ah_claude_manifest}")
file(READ "${_ah_claude_manifest}" _ah_hex HEX)
string(REGEX REPLACE "(................................)" "\\1\n" _ah_hex "${_ah_hex}")
string(REGEX REPLACE "([0-9a-f][0-9a-f])" "0x\\1," AH_CLAUDE_YAML_BYTES "${_ah_hex}")
file(CONFIGURE
  OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/generated/claude_manifest.h"
  CONTENT "/* Gerado pelo CMake a partir de manifests/claude.yaml. Não editar. */
#ifndef AH_TEST_CLAUDE_MANIFEST_H
#define AH_TEST_CLAUDE_MANIFEST_H
#include <stddef.h>
static const unsigned char ah_claude_yaml[] = {
@AH_CLAUDE_YAML_BYTES@
};
static const size_t ah_claude_yaml_len = sizeof ah_claude_yaml;
#endif
"
  @ONLY)

foreach(_ah_t text json yaml regex)
  add_executable(test_core_${_ah_t} test_core_${_ah_t}.c)
  target_link_libraries(test_core_${_ah_t} PRIVATE ah::core)
  ah_project_warnings(test_core_${_ah_t})
  ah_add_test(unit.core.${_ah_t} test_core_${_ah_t})
endforeach()
target_include_directories(test_core_yaml PRIVATE "${CMAKE_CURRENT_BINARY_DIR}/generated")
