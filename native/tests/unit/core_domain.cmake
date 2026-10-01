# Testes da F1-01 (ids, tempo, erros e tipos de domínio). Incluído por
# native/tests/unit/CMakeLists.txt.
#
# Os casos do corpus gerado do TS (native/tests/conformance/, ADR 7.10) entram
# nos testes sem I/O, como o manifesto do teste de YAML: os bytes de cada
# arquivo viram um vetor C num cabeçalho gerado na configuração (refeita
# quando o arquivo muda). Não é o runner de conformidade (F0-11): cada teste
# lê só os `kind` da sua tarefa.
set(_ah_f101_gen "${CMAKE_CURRENT_BINARY_DIR}/generated_f101")
set(_ah_f101_corpus "${PROJECT_SOURCE_DIR}/tests/conformance")

function(ah_f101_embed header var file)
  set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${file}")
  file(READ "${file}" _hex HEX)
  string(REGEX REPLACE "(................................)" "\\1\n" _hex "${_hex}")
  string(REGEX REPLACE "([0-9a-f][0-9a-f])" "0x\\1," AH_F101_BYTES "${_hex}")
  string(TOUPPER "${var}" AH_F101_GUARD)
  set(AH_F101_VAR "${var}")
  file(RELATIVE_PATH AH_F101_SRC "${PROJECT_SOURCE_DIR}" "${file}")
  file(CONFIGURE
    OUTPUT "${_ah_f101_gen}/${header}"
    CONTENT "/* Gerado pelo CMake a partir de native/@AH_F101_SRC@. Não editar. */
#ifndef AH_TEST_@AH_F101_GUARD@_H
#define AH_TEST_@AH_F101_GUARD@_H
#include <stddef.h>
static const unsigned char @AH_F101_VAR@[] = {
@AH_F101_BYTES@
};
static const size_t @AH_F101_VAR@_len = sizeof @AH_F101_VAR@;
#endif
"
    @ONLY)
endfunction()

ah_f101_embed(corpus_objective_hash.h corpus_objective_hash
  "${_ah_f101_corpus}/domain/objective-hash.jsonl")
ah_f101_embed(corpus_ids.h corpus_ids "${_ah_f101_corpus}/domain/ids.jsonl")
ah_f101_embed(corpus_policy_intersect.h corpus_policy_intersect
  "${_ah_f101_corpus}/domain/policy-intersect.jsonl")
ah_f101_embed(corpus_route_errors.h corpus_route_errors
  "${_ah_f101_corpus}/domain-errors/route-errors.jsonl")

foreach(_ah_t sha256 unicode errors domain)
  add_executable(test_core_${_ah_t} test_core_${_ah_t}.c)
  target_link_libraries(test_core_${_ah_t} PRIVATE ah::core)
  target_include_directories(test_core_${_ah_t} PRIVATE "${_ah_f101_gen}")
  ah_project_warnings(test_core_${_ah_t})
  ah_add_test(unit.core.${_ah_t} test_core_${_ah_t})
endforeach()

# ids liga as portas de UUID e relógio às funções reais da plataforma (F0-06),
# como o programa final fará; por isso linka ah::platform.
add_executable(test_core_ids test_core_ids.c)
target_link_libraries(test_core_ids PRIVATE ah::platform ah::core)
target_include_directories(test_core_ids PRIVATE "${_ah_f101_gen}")
ah_project_warnings(test_core_ids)
ah_add_test(unit.core.ids test_core_ids)
