# Fragmento de ah_platform: tempo, aleatoriedade, ambiente e usuário do SO
# (tarefa F0-06, plano docs/17). Incluído por native/src/platform/CMakeLists.txt.

list(APPEND AH_PLATFORM_SOURCES ah_platform_time.c)
if(WIN32)
  list(APPEND AH_PLATFORM_SOURCES ah_platform_time_win32.c)
  # bcrypt: BCryptGenRandom. advapi32: GetUserNameW.
  list(APPEND AH_PLATFORM_LIBS bcrypt advapi32)
else()
  list(APPEND AH_PLATFORM_SOURCES ah_platform_time_posix.c)
endif()

function(ah_platform_time_tests)
  add_executable(test_platform_time "${AH_PLATFORM_TEST_DIR}/test_platform_time.c")
  target_include_directories(test_platform_time PRIVATE "${PROJECT_SOURCE_DIR}/tests/unit")
  target_link_libraries(test_platform_time PRIVATE ah::platform)
  ah_project_warnings(test_platform_time)
  ah_add_test(unit.platform.time test_platform_time)
endfunction()
