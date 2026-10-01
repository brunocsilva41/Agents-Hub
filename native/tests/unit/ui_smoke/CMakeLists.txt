# F0-12: teste mínimo da pilha de UI vendorizada (SDL3 + SDL_ttf + Clay).
#
# Sem display (CI/headless), o teste sai com 77 e o CTest o conta como
# "skipped" (SKIP_RETURN_CODE), sem falhar. Qualquer outro código != 0 é falha.
add_executable(test_ui_smoke test_ui_smoke.c)
target_include_directories(test_ui_smoke PRIVATE "${PROJECT_SOURCE_DIR}/tests/unit")
target_link_libraries(test_ui_smoke PRIVATE ah::sdl3_ttf ah::sdl3 ah::clay)
ah_project_warnings(test_ui_smoke)
ah_add_test(unit.ui_smoke test_ui_smoke)
set_tests_properties(unit.ui_smoke PROPERTIES SKIP_RETURN_CODE 77)
