# Opções de compilação do Agents-Hub nativo.
#
# - ah_project_warnings(<alvo>): warnings como erro, SÓ para código do projeto.
#   As bibliotecas de terceiros (third_party/) não chamam esta função: compilam
#   com o nível padrão do compilador e sem elevar warning a erro.
# - AH_SANITIZE (opção global): liga ASan + UBSan em TODOS os alvos (projeto e
#   terceiros), porque o ASan exige instrumentação consistente. Suportado com
#   clang-cl (Windows) e GCC/Clang (Linux). O MSVC não tem UBSan (ADR 08), por
#   isso a opção é recusada com cl.exe.

include_guard(GLOBAL)

option(AH_SANITIZE "Compila tudo com AddressSanitizer + UndefinedBehaviorSanitizer" OFF)

function(ah_project_warnings target)
  if(MSVC)
    # MSVC e clang-cl aceitam a sintaxe /W4 /WX.
    target_compile_options(${target} PRIVATE /W4 /WX)
  else()
    target_compile_options(${target} PRIVATE -Wall -Wextra -Werror)
  endif()
endfunction()

if(AH_SANITIZE)
  if(MSVC AND NOT CMAKE_C_COMPILER_ID STREQUAL "Clang")
    message(FATAL_ERROR
      "AH_SANITIZE=ON exige clang-cl (Windows) ou GCC/Clang (Linux): o MSVC não tem UBSan.")
  endif()

  # -fno-sanitize-recover=all: qualquer achado do UBSan aborta o processo, para
  # o teste falhar (o padrão do UBSan é só imprimir e seguir).
  set(_ah_san_flags -fsanitize=address,undefined -fno-sanitize-recover=all)

  if(MSVC)
    # clang-cl: o CMake chama o linker (lld-link/link) direto, não o driver, e
    # os objetos instrumentados NÃO trazem /defaultlib dos runtimes. Por isso
    # repetimos aqui o que o driver passa ao linker (conferido com
    # `clang-cl -fsanitize=address,undefined -MD t.c -###`):
    #   clang_rt.asan_dynamic-x86_64.lib
    #   -wholearchive:clang_rt.asan_dynamic_runtime_thunk-x86_64.lib
    # (o runtime do ASan já contém os handlers do UBSan; não há lib à parte).
    # O thunk "dynamic" corresponde ao CRT /MD, que fica fixado abaixo; o ASan
    # do clang-cl não suporta o CRT de debug (/MDd) nem o /RTC1 do perfil Debug.
    if(CMAKE_BUILD_TYPE STREQUAL "Debug")
      message(FATAL_ERROR
        "AH_SANITIZE com clang-cl exige CMAKE_BUILD_TYPE=RelWithDebInfo ou Release "
        "(o perfil Debug usa /MDd e /RTC1, incompatíveis com o ASan).")
    endif()
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreadedDLL")
    add_compile_options(${_ah_san_flags})

    # Caminho dos runtimes perguntado ao próprio clang-cl. O -print-runtime-dir
    # não serve: nas instalações do LLVM para Windows os clang_rt.* ficam em
    # lib/windows, fora do diretório que ele devolve.
    set(_ah_san_libs "")
    foreach(_lib clang_rt.asan_dynamic-x86_64.lib clang_rt.asan_dynamic_runtime_thunk-x86_64.lib)
      execute_process(
        COMMAND "${CMAKE_C_COMPILER}" "/clang:-print-file-name=${_lib}"
        OUTPUT_VARIABLE _path
        OUTPUT_STRIP_TRAILING_WHITESPACE
        RESULT_VARIABLE _res)
      file(TO_CMAKE_PATH "${_path}" _path)
      if(NOT _res EQUAL 0 OR NOT EXISTS "${_path}")
        message(FATAL_ERROR "não achei ${_lib} via clang-cl (resposta: '${_path}')")
      endif()
      list(APPEND _ah_san_libs "${_path}")
    endforeach()
    list(GET _ah_san_libs 0 _ah_asan_lib)
    list(GET _ah_san_libs 1 _ah_asan_thunk)
    get_filename_component(AH_SANITIZER_RUNTIME_DIR "${_ah_asan_lib}" DIRECTORY)
    set(AH_SANITIZER_RUNTIME_DIR "${AH_SANITIZER_RUNTIME_DIR}" CACHE INTERNAL "")
    add_link_options("${_ah_asan_lib}" "/WHOLEARCHIVE:${_ah_asan_thunk}")
    message(STATUS "Sanitizers: ASan+UBSan (clang-cl), runtime em ${AH_SANITIZER_RUNTIME_DIR}")
  else()
    add_compile_options(${_ah_san_flags} -fno-omit-frame-pointer)
    add_link_options(${_ah_san_flags})
    message(STATUS "Sanitizers: ASan+UBSan (${CMAKE_C_COMPILER_ID})")
  endif()
endif()

# Testes registrados com esta função recebem, no Windows com sanitizers, o
# diretório da DLL do ASan no PATH (sem isso o executável nem carrega).
function(ah_add_test name target)
  add_test(NAME ${name} COMMAND ${target})
  if(AH_SANITIZE AND WIN32 AND AH_SANITIZER_RUNTIME_DIR)
    file(TO_NATIVE_PATH "${AH_SANITIZER_RUNTIME_DIR}" _dir)
    set_tests_properties(${name} PROPERTIES
      ENVIRONMENT_MODIFICATION "PATH=path_list_prepend:${_dir}")
  endif()
endfunction()
