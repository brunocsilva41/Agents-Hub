# ah_updater: atualização automática (ADR 7.13, 8.13). Criado pela F8-05 com a
# verificação do envelope do manifesto; a F8-06 estende com o atualizador.
add_library(ah_updater STATIC ah_update_verify.c)
add_library(ah::updater ALIAS ah_updater)
target_include_directories(ah_updater PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
# ah_status.h vem do core (só cabeçalho aqui); Ed25519/SHA-512 do Monocypher (ADR 8.10).
target_link_libraries(ah_updater PUBLIC ah::core PRIVATE ah::monocypher)
ah_project_warnings(ah_updater)

# Testes T1-T4 (e casos fixados da revisão) da proposta F8-04 §8. As chaves de
# teste efêmeras usam o CSPRNG de ah::platform (F0-06).
set(_ah_updater_tests "${PROJECT_SOURCE_DIR}/tests/unit/updater")
add_executable(test_update_verify "${_ah_updater_tests}/test_update_verify.c")
target_include_directories(test_update_verify PRIVATE "${PROJECT_SOURCE_DIR}/tests/unit")
target_link_libraries(test_update_verify PRIVATE ah::updater ah::monocypher ah::platform)
ah_project_warnings(test_update_verify)
ah_add_test(unit.updater.verify test_update_verify)
