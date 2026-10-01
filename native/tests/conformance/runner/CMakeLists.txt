# Runner de conformidade (F0-11): biblioteca, função CMake de registro no CTest
# e autoverificação com o corpus de exemplo do próprio runner (exemplo/).
#
# Regra de uso e da tabela de esperado decidido: README.md desta pasta.

# Raiz do corpus: caminhos relativos de ah_add_conformance_test partem daqui.
get_filename_component(_ah_conf_root "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)
set(AH_CONFORMANCE_DIR "${_ah_conf_root}" CACHE INTERNAL
  "Raiz do corpus de conformidade (native/tests/conformance)")

add_library(ah_conformance_runner STATIC ah_conformance.c)
add_library(ah::conformance_runner ALIAS ah_conformance_runner)
target_include_directories(ah_conformance_runner PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
target_link_libraries(ah_conformance_runner PUBLIC ah::core ah::cjson)
ah_project_warnings(ah_conformance_runner)

# ah_add_conformance_test(<nome> <executável> <arquivo.jsonl>)
#
# Registra no CTest o teste `conformance.<nome>`, que roda
# `<executável> <arquivo.jsonl>`. O executável é do módulo e chama
# ah_conformance_main() (ah_conformance.h). <arquivo.jsonl> relativo parte de
# native/tests/conformance/ (ex.: classifier/classifier.jsonl); absoluto vale
# como está. O arquivo precisa existir na configuração. Como ah_add_test, põe
# a DLL do ASan no PATH no Windows com sanitizers.
#
# CMake: funções são globais, mas só existem depois que este diretório é
# processado; por isso o add_subdirectory(tests/conformance/runner) vem antes
# dos diretórios que registram testes de conformidade.
function(ah_add_conformance_test name target jsonl)
  if(ARGC GREATER 3)
    message(FATAL_ERROR "ah_add_conformance_test: argumentos demais (${ARGN})")
  endif()
  if(NOT TARGET ${target})
    message(FATAL_ERROR "ah_add_conformance_test(${name}): alvo '${target}' não existe")
  endif()
  if(IS_ABSOLUTE "${jsonl}")
    set(_file "${jsonl}")
  else()
    set(_file "${AH_CONFORMANCE_DIR}/${jsonl}")
  endif()
  if(NOT EXISTS "${_file}" OR IS_DIRECTORY "${_file}")
    message(FATAL_ERROR "ah_add_conformance_test(${name}): corpus não encontrado: ${_file}")
  endif()
  set(_test "conformance.${name}")
  add_test(NAME ${_test} COMMAND ${target} "${_file}")
  set_tests_properties(${_test} PROPERTIES LABELS conformance)
  if(AH_SANITIZE AND WIN32 AND AH_SANITIZER_RUNTIME_DIR)
    file(TO_NATIVE_PATH "${AH_SANITIZER_RUNTIME_DIR}" _dir)
    set_tests_properties(${_test} PROPERTIES
      ENVIRONMENT_MODIFICATION "PATH=path_list_prepend:${_dir}")
  endif()
endfunction()

# ---------------------------------------------------------------- exemplo
add_library(ah_conformance_exemplo STATIC exemplo/exemplo_suite.c)
target_include_directories(ah_conformance_exemplo PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/exemplo")
target_link_libraries(ah_conformance_exemplo PUBLIC ah::conformance_runner)
ah_project_warnings(ah_conformance_exemplo)

add_executable(conformance_exemplo exemplo/exemplo_main.c)
target_link_libraries(conformance_exemplo PRIVATE ah_conformance_exemplo)
ah_project_warnings(conformance_exemplo)

# Corpus de exemplo pelo caminho real de uso: verde passa; misto tem casos que
# falham, então o CTest só fica verde se o executável sair != 0 (WILL_FAIL).
ah_add_conformance_test(exemplo.verde conformance_exemplo runner/exemplo/verde.jsonl)
ah_add_conformance_test(exemplo.misto conformance_exemplo runner/exemplo/misto.jsonl)
set_tests_properties(conformance.exemplo.misto PROPERTIES WILL_FAIL TRUE)

# Autoverificação: confere contagens e o texto do relatório caso a caso.
set(_ah_conf_tmp "${CMAKE_CURRENT_BINARY_DIR}/selftest-tmp")
file(MAKE_DIRECTORY "${_ah_conf_tmp}")
add_executable(test_conformance_runner test_conformance_runner.c)
target_include_directories(test_conformance_runner PRIVATE "${PROJECT_SOURCE_DIR}/tests/unit")
target_link_libraries(test_conformance_runner PRIVATE ah_conformance_exemplo)
ah_project_warnings(test_conformance_runner)
add_test(NAME conformance.runner.selftest
  COMMAND test_conformance_runner "${CMAKE_CURRENT_SOURCE_DIR}/exemplo" "${_ah_conf_tmp}")
if(AH_SANITIZE AND WIN32 AND AH_SANITIZER_RUNTIME_DIR)
  file(TO_NATIVE_PATH "${AH_SANITIZER_RUNTIME_DIR}" _ah_conf_dir)
  set_tests_properties(conformance.runner.selftest PROPERTIES
    ENVIRONMENT_MODIFICATION "PATH=path_list_prepend:${_ah_conf_dir}")
endif()
