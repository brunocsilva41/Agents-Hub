# Fragmento da área de processos (F0-07): spawn sem shell, pipes, cwd,
# ambiente, espera e kill. Incluído por native/src/platform/CMakeLists.txt.

list(APPEND AH_PLATFORM_SOURCES ah_platform_proc_common.c)
if(WIN32)
  list(APPEND AH_PLATFORM_SOURCES ah_platform_proc_win32.c)
  # advapi32: token e DACL dos pipes; bcrypt: nome aleatório dos pipes.
  list(APPEND AH_PLATFORM_LIBS advapi32 bcrypt)
else()
  list(APPEND AH_PLATFORM_SOURCES ah_platform_proc_posix.c)
  # pthread_sigmask (sinais bloqueados durante o fork).
  find_package(Threads REQUIRED)
  list(APPEND AH_PLATFORM_LIBS Threads::Threads)
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
  # prova a conversão UTF-8 → UTF-16 do cwd. `isca/` recebe uma cópia do
  # helper com outro nome: o executável-isca do teste de
  # NoDefaultCurrentDirectoryInExePath (SPEC-08 P1).
  set(_work "${CMAKE_CURRENT_BINARY_DIR}/proc_test_work")
  file(MAKE_DIRECTORY "${_work}" "${_work}/cwd-ção" "${_work}/isca")
  if(WIN32)
    add_custom_command(TARGET ah_test_proc_helper POST_BUILD
      COMMAND "${CMAKE_COMMAND}" -E copy_if_different
              "$<TARGET_FILE:ah_test_proc_helper>" "${_work}/isca/ahisca.exe"
      VERBATIM)
  endif()

  add_executable(test_platform_proc "${AH_PLATFORM_TEST_DIR}/test_platform_proc.c")
  target_link_libraries(test_platform_proc PRIVATE ah::platform)
  if(WIN32)
    # Leitura da DACL dos pipes no teste (GetSecurityInfo).
    target_link_libraries(test_platform_proc PRIVATE advapi32)
  endif()
  target_include_directories(test_platform_proc PRIVATE "${PROJECT_SOURCE_DIR}/tests/unit")
  target_compile_definitions(test_platform_proc PRIVATE
    "AH_TEST_PROC_HELPER=\"$<TARGET_FILE:ah_test_proc_helper>\""
    "AH_TEST_PROC_WORK=\"${_work}\"")
  add_dependencies(test_platform_proc ah_test_proc_helper)
  ah_project_warnings(test_platform_proc)
  ah_add_test(unit.platform.proc test_platform_proc)
  # Um close_stdin que bloqueie (M2) trava o teste: o teto o derruba.
  set_tests_properties(unit.platform.proc PROPERTIES TIMEOUT 120)
endfunction()
