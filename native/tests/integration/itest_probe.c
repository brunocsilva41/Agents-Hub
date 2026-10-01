/* Filho de teste do helper de integração: confere, DE DENTRO do processo
 * filho, o ambiente que o helper montou. Não grava nada em lugar nenhum.
 *
 *   itest_probe <home esperado> <porta esperada> [NOME=valor esperado]
 *   itest_probe --bloquear      (fica parado até ser morto; para o teste de kill)
 *
 * Código de saída: 0 ok; 2 uso; 10 AGENTS_HUB_HOME ausente ou diferente;
 * 11 AGENTS_HUB_PORT ausente ou diferente; 12 AGENTS_HUB_NO_AUTOSTART != "1";
 * 13 porta 4747; 14 home em caminho proibido; 15 outra variável AGENTS_HUB_*
 * presente; 16 variável extra ausente ou diferente; 17 erro interno. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ah_itest.h"

#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <unistd.h>
#endif

static int name_is_hub(const char *entry) {
    static const char prefix[] = "AGENTS_HUB_";
    size_t i;
    for (i = 0; i + 1 < sizeof prefix; i++) {
        char c = entry[i];
#if defined(_WIN32)
        if (c >= 'a' && c <= 'z') {
            c = (char)(c - 'a' + 'A');
        }
#endif
        if (c != prefix[i]) {
            return 0;
        }
    }
    return 1;
}

int main(int argc, char **argv) {
    char home[4096];
    char port[32];
    char flag[32];
    char **vars = NULL;
    size_t nvars = 0;
    size_t i;
    size_t hub_count = 0;

    if (argc == 2 && strcmp(argv[1], "--bloquear") == 0) {
        /* Espera bloqueante, sem polling: só sai quando for morto. */
#if defined(_WIN32)
        (void)WaitForSingleObject(GetCurrentProcess(), INFINITE);
#else
        for (;;) {
            (void)pause();
        }
#endif
        return 17;
    }
    if (argc != 3 && argc != 4) {
        return 2;
    }
    if (ah_itest_getenv("AGENTS_HUB_HOME", home, sizeof home) != AH_OK ||
        strcmp(home, argv[1]) != 0) {
        return 10;
    }
    if (ah_itest_getenv("AGENTS_HUB_PORT", port, sizeof port) != AH_OK ||
        strcmp(port, argv[2]) != 0) {
        return 11;
    }
    if (ah_itest_getenv("AGENTS_HUB_NO_AUTOSTART", flag, sizeof flag) != AH_OK ||
        strcmp(flag, "1") != 0) {
        return 12;
    }
    if (strtoul(port, NULL, 10) == AH_ITEST_FORBIDDEN_PORT) {
        return 13;
    }
    if (ah_itest_environ_snapshot(&vars, &nvars) != AH_OK) {
        return 17;
    }
    for (i = 0; i < nvars; i++) {
        if (name_is_hub(vars[i])) {
            hub_count++;
        }
    }
    ah_itest_strv_free(vars);
    if (hub_count != 3) {
        return 15;
    }
    if (argc == 4) {
        const char *eq = strchr(argv[3], '=');
        char name[256];
        char val[1024];
        size_t ln;
        if (eq == NULL || (ln = (size_t)(eq - argv[3])) == 0 || ln >= sizeof name) {
            return 2;
        }
        memcpy(name, argv[3], ln);
        name[ln] = '\0';
        if (ah_itest_getenv(name, val, sizeof val) != AH_OK || strcmp(val, eq + 1) != 0) {
            return 16;
        }
    }
    /* O AGENTS_HUB_HOME do filho é o próprio home temporário; sem tirá-lo, a
     * checagem abaixo o veria como "AGENTS_HUB_HOME do pai". O que importa
     * aqui é ~/.agents-hub (perfil real e HOME/USERPROFILE herdados). */
    if (ah_itest_setenv("AGENTS_HUB_HOME", NULL) != AH_OK) {
        return 17;
    }
    if (ah_itest_path_is_forbidden(home)) {
        return 14;
    }
    return 0;
}
