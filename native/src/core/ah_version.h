#ifndef AH_CORE_VERSION_H
#define AH_CORE_VERSION_H

/* Versão do Agents-Hub nativo. A fonte única é `project(VERSION ...)` no
 * native/CMakeLists.txt, repassada a ah_version.c pelo CMake. */

/* Texto "MAJOR.MINOR.PATCH" (ex.: "0.1.0"). Nunca NULL. Posse: memória
 * estática da biblioteca; o chamador não libera nem modifica. */
const char *ah_core_version_string(void);

int ah_core_version_major(void);
int ah_core_version_minor(void);
int ah_core_version_patch(void);

#endif /* AH_CORE_VERSION_H */
