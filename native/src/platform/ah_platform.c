/* Unidade-base de ah_platform: garante que a biblioteca tenha ao menos uma
 * fonte enquanto as áreas (fs, time, proc, net) são implementadas pelas suas
 * tarefas. Não contém lógica. */
#include "ah_platform.h"

int ah_platform_abi_version(void) {
    return 1;
}
