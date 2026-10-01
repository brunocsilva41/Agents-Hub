add_executable(hub main.c)
target_link_libraries(hub PRIVATE ah::core)
ah_project_warnings(hub)
