# ahsign: ferramenta do dono para gerar a chave de assinatura (arquivo cifrado
# com senha, opção O2 da proposta F8-04), assinar o manifesto de atualização e
# exportar a chave pública (F8-05). Não faz parte do produto instalado.
#
# ahsign_os.c chama o SO (aleatoriedade, terminal, arquivos) fora de
# native/src/platform/: exceção TEMPORÁRIA até a F0-06 (ver ahsign_os.h).
add_library(ahsign_core STATIC ahsign_key.c ahsign_os.c)
target_include_directories(ahsign_core PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
target_link_libraries(ahsign_core PUBLIC ah::core ah::updater ah::monocypher)
if(WIN32)
  target_link_libraries(ahsign_core PRIVATE bcrypt shell32)
endif()
ah_project_warnings(ahsign_core)

add_executable(ahsign ahsign_main.c)
target_link_libraries(ahsign PRIVATE ahsign_core)
ah_project_warnings(ahsign)

set(_ahsign_tests "${PROJECT_SOURCE_DIR}/tests/unit/updater")

# Mesmo ajuste de PATH que ah_add_test faz (DLL do ASan no Windows), para os
# testes que rodam um script do CMake em vez de um executável de teste.
function(_ahsign_sanitizer_env name)
  if(AH_SANITIZE AND WIN32 AND AH_SANITIZER_RUNTIME_DIR)
    file(TO_NATIVE_PATH "${AH_SANITIZER_RUNTIME_DIR}" _dir)
    set_tests_properties(${name} PROPERTIES
      ENVIRONMENT_MODIFICATION "PATH=path_list_prepend:${_dir}")
  endif()
endfunction()

# Núcleo: arquivo de chave cifrado, assinatura e exportação.
add_executable(test_ahsign_key "${_ahsign_tests}/test_ahsign_key.c")
target_include_directories(test_ahsign_key PRIVATE "${PROJECT_SOURCE_DIR}/tests/unit")
target_link_libraries(test_ahsign_key PRIVATE ahsign_core)
ah_project_warnings(test_ahsign_key)
add_test(NAME unit.ahsign.key
  COMMAND test_ahsign_key "${CMAKE_CURRENT_BINARY_DIR}")
_ahsign_sanitizer_env(unit.ahsign.key)

# Ida e volta pela linha de comando: gerar → assinar → verificar, com chave de
# teste efêmera num diretório temporário dentro do build.
add_test(NAME unit.ahsign.roundtrip
  COMMAND "${CMAKE_COMMAND}"
    "-DAHSIGN=$<TARGET_FILE:ahsign>"
    "-DWORK_DIR=${CMAKE_CURRENT_BINARY_DIR}/test-ahsign-roundtrip"
    -P "${_ahsign_tests}/ahsign_roundtrip.cmake")
_ahsign_sanitizer_env(unit.ahsign.roundtrip)

# T14 (SEC-R22): nenhum arquivo do repositório, dos workflows nem o executável
# do produto contém o cabeçalho do arquivo de chave privada.
find_package(Git QUIET)
add_test(NAME unit.ahsign.secret_scan
  COMMAND "${CMAKE_COMMAND}"
    "-DGIT=${GIT_EXECUTABLE}"
    "-DREPO_ROOT=${PROJECT_SOURCE_DIR}/.."
    "-DWORK_DIR=${CMAKE_CURRENT_BINARY_DIR}/test-secret-scan"
    "-DEXTRA_FILES=$<TARGET_FILE:hub>"
    -P "${_ahsign_tests}/secret_scan.cmake")
