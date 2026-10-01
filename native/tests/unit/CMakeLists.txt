# Testes unitários. Testes de plataforma são registrados pelos fragmentos de
# native/src/platform/ (fs/time/proc/net.cmake); os demais são registrados aqui.
add_executable(test_smoke test_smoke.c)
target_link_libraries(test_smoke PRIVATE ah::core ah::sqlite3)
ah_project_warnings(test_smoke)
ah_add_test(unit.smoke test_smoke)
