# ah_core: domínio do Hub, sem I/O. Utilitários de texto, JSON, YAML e regex
# (F0-10) são camadas finas sobre cJSON, libyaml e PCRE2; as bibliotecas ficam
# PRIVATE porque os cabeçalhos do ah_core não expõem tipos delas.
add_library(ah_core STATIC
  ah_version.c
  ah_text.c
  ah_json.c
  ah_yaml.c
  ah_regex.c)
add_library(ah::core ALIAS ah_core)
target_include_directories(ah_core PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
target_compile_definitions(ah_core PRIVATE
  AH_CORE_VERSION_MAJOR=${PROJECT_VERSION_MAJOR}
  AH_CORE_VERSION_MINOR=${PROJECT_VERSION_MINOR}
  AH_CORE_VERSION_PATCH=${PROJECT_VERSION_PATCH}
  AH_CORE_VERSION_TEXT="${PROJECT_VERSION}")
target_link_libraries(ah_core PRIVATE ah::cjson ah::yaml ah::pcre2)
ah_project_warnings(ah_core)
