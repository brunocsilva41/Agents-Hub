# Fragmento da área de processos (F0-07): spawn sem shell, pipes, cwd,
# ambiente, espera e kill. Incluído por native/src/platform/CMakeLists.txt.
# Não precisa de biblioteca além da kernel32 (Windows) e da libc (POSIX).

list(APPEND AH_PLATFORM_SOURCES ah_platform_proc_common.c)
if(WIN32)
  list(APPEND AH_PLATFORM_SOURCES ah_platform_proc_win32.c)
else()
  list(APPEND AH_PLATFORM_SOURCES ah_platform_proc_posix.c)
endif()

function(ah_platform_proc_tests)
  # Executável auxiliar: ecoa argv/stdin/env/cwd e enumera os próprios
  # handles/fds herdáveis. Nenhum agente real (CLAUDE.md, regra 3).
  add_executable(ah_test_proc_helper "${AH_PLATFORM_TEST_DIR}/proc_helper.c")
  ah_project_warnings(ah_test_proc_helper)
  if(WIN32)
    # CommandLineToArgvW (ida e volta do argv, SPEC-08 P3).
    target_link_libraries(ah_test_proc_helper PRIVATE shell32)
  endif()

  # Diretório de trabalho dos testes; o subdiretório com nome não ASCII
  # prova a conversão UTF-8 → UTF-16 do cwd.
  set(_work "${CMAKE_CURRENT_BINARY_DIR}/proc_test_work")
  file(MAKE_DIRECTORY "${_work}" "${_work}/cwd-ção")

  add_executable(test_platform_proc "${AH_PLATFORM_TEST_DIR}/test_platform_proc.c")
  target_link_libraries(test_platform_proc PRIVATE ah::platform)
  target_include_directories(test_platform_proc PRIVATE "${PROJECT_SOURCE_DIR}/tests/unit")
  target_compile_definitions(test_platform_proc PRIVATE
    "AH_TEST_PROC_HELPER=\"$<TARGET_FILE:ah_test_proc_helper>\""
    "AH_TEST_PROC_WORK=\"${_work}\"")
  add_dependencies(test_platform_proc ah_test_proc_helper)
  ah_project_warnings(test_platform_proc)
  ah_add_test(unit.platform.proc test_platform_proc)
endfunction()
