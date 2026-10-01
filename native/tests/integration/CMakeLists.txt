# Helper de integração (F0-11): sobe um executável isolado do Hub real
# (home temporário, porta livre != 4747, AGENTS_HUB_NO_AUTOSTART=1).
# Contrato em ah_itest.h. Os testes de integração futuros linkam ah::itest.

add_library(ah_itest STATIC ah_itest.c)
add_library(ah::itest ALIAS ah_itest)
target_include_directories(ah_itest PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
target_link_libraries(ah_itest PUBLIC ah::core)
if(WIN32)
  # Chamadas de SO locais até a migração para ah_platform (ver ah_itest.c):
  # Winsock (porta livre), userenv/advapi32 (perfil real do usuário),
  # user32 (CharLowerBuffW, na comparação de caminhos sem caixa).
  target_link_libraries(ah_itest PRIVATE ws2_32 userenv advapi32 user32)
endif()
ah_project_warnings(ah_itest)

# Filho de teste: confere o ambiente de dentro do processo; não grava nada.
add_executable(itest_probe itest_probe.c)
target_link_libraries(itest_probe PRIVATE ah::itest)
ah_project_warnings(itest_probe)

set(_ah_itest_tmp "${CMAKE_CURRENT_BINARY_DIR}/itest-tmp")
file(MAKE_DIRECTORY "${_ah_itest_tmp}")
add_executable(test_itest_isolation test_itest_isolation.c)
target_include_directories(test_itest_isolation PRIVATE "${PROJECT_SOURCE_DIR}/tests/unit")
target_link_libraries(test_itest_isolation PRIVATE ah::itest)
ah_project_warnings(test_itest_isolation)
add_test(NAME integration.itest.isolation
  COMMAND test_itest_isolation "$<TARGET_FILE:itest_probe>" "${_ah_itest_tmp}")
set_tests_properties(integration.itest.isolation PROPERTIES TIMEOUT 120 LABELS integration)
if(AH_SANITIZE AND WIN32 AND AH_SANITIZER_RUNTIME_DIR)
  file(TO_NATIVE_PATH "${AH_SANITIZER_RUNTIME_DIR}" _ah_itest_dir)
  set_tests_properties(integration.itest.isolation PROPERTIES
    ENVIRONMENT_MODIFICATION "PATH=path_list_prepend:${_ah_itest_dir}")
endif()
