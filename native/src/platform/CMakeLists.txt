# ah_platform: a ÚNICA camada que chama o SO (c-engineer.md:20; docs/18 §7).
#
# Cada área tem o seu fragmento, mantido pela tarefa dona dela (plano docs/17,
# tabela de donos do §0). O fragmento acrescenta fontes a AH_PLATFORM_SOURCES,
# bibliotecas do SO a AH_PLATFORM_LIBS e registra os próprios testes. Assim as
# tarefas F0-05/F0-06/F0-07/F0-09 trabalham em paralelo sem editar este arquivo.
#
#   fs.cmake    F0-05  texto, caminhos e arquivos
#   time.cmake  F0-06  tempo, aleatoriedade, ambiente e usuário do SO
#   proc.cmake  F0-07  processos (spawn, pipes, ambiente)
#   net.cmake   F0-09  sockets loopback, laço de eventos, timers e threads
#
# Testes de plataforma ficam em native/tests/unit/platform/ e são registrados
# pelo fragmento da área (o alvo de teste linka ah::platform e usa ah_test.h).

set(AH_PLATFORM_SOURCES ah_platform.c)
set(AH_PLATFORM_LIBS "")
set(AH_PLATFORM_TEST_DIR "${PROJECT_SOURCE_DIR}/tests/unit/platform")

include("${CMAKE_CURRENT_SOURCE_DIR}/fs.cmake" OPTIONAL)
include("${CMAKE_CURRENT_SOURCE_DIR}/time.cmake" OPTIONAL)
include("${CMAKE_CURRENT_SOURCE_DIR}/proc.cmake" OPTIONAL)
include("${CMAKE_CURRENT_SOURCE_DIR}/net.cmake" OPTIONAL)

add_library(ah_platform STATIC ${AH_PLATFORM_SOURCES})
add_library(ah::platform ALIAS ah_platform)
target_include_directories(ah_platform PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
# ah_status.h (tipo de resultado comum) vem do core, que é só cabeçalho aqui.
target_link_libraries(ah_platform PUBLIC ah::core ${AH_PLATFORM_LIBS})
ah_project_warnings(ah_platform)

# Os testes registrados pelos fragmentos só podem ser criados depois do alvo.
if(COMMAND ah_platform_register_tests)
  ah_platform_register_tests()
endif()
foreach(_ah_area fs time proc net)
  if(COMMAND ah_platform_${_ah_area}_tests)
    cmake_language(CALL ah_platform_${_ah_area}_tests)
  endif()
endforeach()
