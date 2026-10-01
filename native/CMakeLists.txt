# Agents-Hub nativo (reescrita em C, ADR 07/08).
#
# Versão mínima: PROPOSTA (DA-11, ainda não decidida; o ADR 08 propõe a faixa
# 3.21–3.31). 3.22 porque é a primeira versão com a propriedade de teste
# ENVIRONMENT_MODIFICATION, usada para pôr a DLL do ASan no PATH no Windows
# (cmake/AhCompilerOptions.cmake). Os presets versão 3 já existem desde a 3.21.
cmake_minimum_required(VERSION 3.22)

project(agents_hub
  VERSION 0.1.0
  DESCRIPTION "Agents-Hub nativo em C"
  LANGUAGES C)

# C17 estrito, sem extensões do compilador (ADR 8.1).
set(CMAKE_C_STANDARD 17)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

if(NOT CMAKE_CONFIGURATION_TYPES AND NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Debug CACHE STRING "Tipo de build" FORCE)
endif()

list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake")
include(AhCompilerOptions)

# Executáveis e DLLs no mesmo diretório: simplifica rodar `hub` e os testes.
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")

enable_testing()

add_subdirectory(third_party)
add_subdirectory(src/core)
add_subdirectory(src/platform)
add_subdirectory(src/cli)
add_subdirectory(src/updater)
add_subdirectory(tools/ahsign)
add_subdirectory(tests/unit)
