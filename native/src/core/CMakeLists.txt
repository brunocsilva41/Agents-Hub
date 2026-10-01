# ah_core: domínio do Hub (por enquanto só a versão; o resto vem nas próximas tarefas).
add_library(ah_core STATIC ah_version.c)
add_library(ah::core ALIAS ah_core)
target_include_directories(ah_core PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
target_compile_definitions(ah_core PRIVATE
  AH_CORE_VERSION_MAJOR=${PROJECT_VERSION_MAJOR}
  AH_CORE_VERSION_MINOR=${PROJECT_VERSION_MINOR}
  AH_CORE_VERSION_PATCH=${PROJECT_VERSION_PATCH}
  AH_CORE_VERSION_TEXT="${PROJECT_VERSION}")
ah_project_warnings(ah_core)
