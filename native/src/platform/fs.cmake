# Fragmento da área de arquivos de ah_platform (F0-05: texto, caminhos e
# arquivos). Incluído por native/src/platform/CMakeLists.txt.

list(APPEND AH_PLATFORM_SOURCES ah_platform_fs.c)
if(WIN32)
  list(APPEND AH_PLATFORM_SOURCES ah_platform_fs_win.c)
  # advapi32: token, SID e DACL (OpenProcessToken, SetNamedSecurityInfoW...).
  # userenv: GetUserProfileDirectoryW (home do usuário sem USERPROFILE).
  list(APPEND AH_PLATFORM_LIBS advapi32 userenv)
else()
  list(APPEND AH_PLATFORM_SOURCES ah_platform_fs_posix.c)
endif()

function(ah_platform_fs_tests)
  add_executable(test_platform_fs "${AH_PLATFORM_TEST_DIR}/test_platform_fs.c")
  target_include_directories(test_platform_fs PRIVATE "${PROJECT_SOURCE_DIR}/tests/unit")
  target_link_libraries(test_platform_fs PRIVATE ah::platform)
  if(NOT WIN32)
    # O teste de leitura concorrente usa uma thread de leitura.
    find_package(Threads REQUIRED)
    target_link_libraries(test_platform_fs PRIVATE Threads::Threads)
  endif()
  ah_project_warnings(test_platform_fs)
  ah_add_test(unit.platform.fs test_platform_fs)
endfunction()
