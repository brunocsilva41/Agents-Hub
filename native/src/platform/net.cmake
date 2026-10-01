# Fragmento F0-09: sockets loopback, laço de eventos, timers e threads.
# Incluído por native/src/platform/CMakeLists.txt (dono F0-05).

list(APPEND AH_PLATFORM_SOURCES
  ah_platform_net.c
  ah_platform_loop.c
  ah_platform_thread.c)

if(WIN32)
  # ws2_32: Winsock. iphlpapi: GetExtendedTcpTable (dono da conexão, SEC-R12/R13).
  list(APPEND AH_PLATFORM_LIBS ws2_32 iphlpapi)
else()
  find_package(Threads REQUIRED)
  list(APPEND AH_PLATFORM_LIBS Threads::Threads)
endif()

function(ah_platform_net_tests)
  foreach(_t net loop thread)
    add_executable(test_platform_${_t} "${AH_PLATFORM_TEST_DIR}/test_platform_${_t}.c")
    target_link_libraries(test_platform_${_t} PRIVATE ah::platform)
    # ah_test.h fica em tests/unit/ (o alvo de plataforma não o exporta).
    target_include_directories(test_platform_${_t} PRIVATE "${PROJECT_SOURCE_DIR}/tests/unit")
    ah_project_warnings(test_platform_${_t})
    ah_add_test(unit.platform.${_t} test_platform_${_t})
  endforeach()
endfunction()
