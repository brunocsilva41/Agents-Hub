/* Placeholder do executável `hub`: só imprime a versão, para provar que o
 * link com ah_core funciona. A CLI real (SPEC-03) vem em tarefa própria. */
#include <stdio.h>

#include "ah_version.h"

int main(void) {
    if (printf("hub %s\n", ah_core_version_string()) < 0) {
        return 1;
    }
    return 0;
}
