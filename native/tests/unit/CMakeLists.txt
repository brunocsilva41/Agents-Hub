add_executable(test_smoke test_smoke.c)
target_link_libraries(test_smoke PRIVATE ah::core ah::sqlite3)
ah_project_warnings(test_smoke)
ah_add_test(unit.smoke test_smoke)
