# ah_updater: atualização automática (ADR 7.13, 8.13). Por enquanto só a
# verificação do envelope do manifesto (F8-05); o resto do atualizador é F8-06.
add_library(ah_updater STATIC ah_update_verify.c)
add_library(ah::updater ALIAS ah_updater)
target_include_directories(ah_updater PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
# ah_status.h vem do core (só cabeçalho aqui); Ed25519/SHA-512 do Monocypher (ADR 8.10).
target_link_libraries(ah_updater PUBLIC ah::core PRIVATE ah::monocypher)
ah_project_warnings(ah_updater)

# Testes T1-T4 da proposta F8-04 §8. Usa a aleatoriedade do SO de ahsign_core
# (native/tools/ahsign, alvo declarado depois; o CMake resolve na geração) só
# para criar chaves de teste efêmeras; isso migra para ah::platform com a F0-06.
set(_ah_updater_tests "${PROJECT_SOURCE_DIR}/tests/unit/updater")
add_executable(test_update_verify "${_ah_updater_tests}/test_update_verify.c")
target_include_directories(test_update_verify PRIVATE "${PROJECT_SOURCE_DIR}/tests/unit")
target_link_libraries(test_update_verify PRIVATE ah::updater ah::monocypher ahsign_core)
ah_project_warnings(test_update_verify)
ah_add_test(unit.updater.verify test_update_verify)
