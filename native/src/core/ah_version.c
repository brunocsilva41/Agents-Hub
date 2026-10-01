#include "ah_version.h"

#if !defined(AH_CORE_VERSION_MAJOR) || !defined(AH_CORE_VERSION_MINOR) || \
    !defined(AH_CORE_VERSION_PATCH) || !defined(AH_CORE_VERSION_TEXT)
#error "AH_CORE_VERSION_* deve vir do CMake (native/src/core/CMakeLists.txt)"
#endif

const char *ah_core_version_string(void) { return AH_CORE_VERSION_TEXT; }

int ah_core_version_major(void) { return AH_CORE_VERSION_MAJOR; }

int ah_core_version_minor(void) { return AH_CORE_VERSION_MINOR; }

int ah_core_version_patch(void) { return AH_CORE_VERSION_PATCH; }
