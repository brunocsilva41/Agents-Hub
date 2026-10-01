# F0-14 — protótipo descartável (não entra no produto).
# Build independente: NÃO é incluído por native/CMakeLists.txt.
# Dependências pré-compiladas oficiais em _deps/ (ver README.md).
cmake_minimum_required(VERSION 3.21)
project(spike_ui LANGUAGES C)

set(CMAKE_C_STANDARD 17)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

set(SPIKE_DEPS "${CMAKE_CURRENT_SOURCE_DIR}/_deps")
set(SDL3_DIR "${SPIKE_DEPS}/SDL3-3.4.16/cmake")
set(SDL3_ttf_DIR "${SPIKE_DEPS}/SDL3_ttf-3.2.2/cmake")
find_package(SDL3 3.4 REQUIRED CONFIG COMPONENTS SDL3-shared)
find_package(SDL3_ttf 3.2 REQUIRED CONFIG)

option(SPIKE_ASAN "MSVC AddressSanitizer em Debug" ON)

# Clay (single header) compila numa TU própria, com flags de terceiro.
add_library(clay_impl STATIC src/clay_impl.c)
target_include_directories(clay_impl PUBLIC "${SPIKE_DEPS}/clay-0.14")

add_executable(spike_ui src/spike_ui.c)
target_link_libraries(spike_ui PRIVATE clay_impl SDL3_ttf::SDL3_ttf SDL3::SDL3)

if(MSVC)
  target_compile_options(clay_impl PRIVATE /W3 /utf-8)
  target_compile_options(spike_ui PRIVATE /W4 /WX /utf-8)
  if(SPIKE_ASAN)
    target_compile_options(spike_ui PRIVATE $<$<CONFIG:Debug>:/fsanitize=address>)
    target_compile_options(clay_impl PRIVATE $<$<CONFIG:Debug>:/fsanitize=address>)
  endif()
endif()

# Copia as DLLs ao lado do exe.
add_custom_command(TARGET spike_ui POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
          $<TARGET_FILE:SDL3::SDL3-shared> $<TARGET_FILE:SDL3_ttf::SDL3_ttf>
          $<TARGET_FILE_DIR:spike_ui>)
