/* Macros de teste do Agents-Hub nativo (sem framework externo: DA-24, ADR 09).
 *
 * Uso: cada executável de teste inclui este cabeçalho, chama as funções de
 * teste a partir do main() e termina com `return AH_TEST_END("nome");`.
 * CHECK não aborta: conta a falha, imprime arquivo:linha e segue, para um
 * único run mostrar todas as falhas. Não usa <assert.h>, para valer também
 * com NDEBUG (Release). */
#ifndef AH_TEST_H
#define AH_TEST_H

#include <stdio.h>

/* Um contador por executável de teste (cada teste é um programa próprio). */
static int ah_test_failures = 0;

#define CHECK(cond)                                                        \
    do {                                                                   \
        if (!(cond)) {                                                     \
            fprintf(stderr, "%s:%d: falhou: %s\n", __FILE__, __LINE__,     \
                    #cond);                                                \
            ah_test_failures++;                                            \
        }                                                                  \
    } while (0)

/* Devolve o código de saída do teste: 0 sem falhas, 1 com falhas. */
#define AH_TEST_END(name)                                                  \
    (ah_test_failures != 0                                                 \
         ? (fprintf(stderr, "%s: %d falha(s)\n", (name), ah_test_failures), \
            1)                                                             \
         : (printf("%s: ok\n", (name)), 0))

#endif /* AH_TEST_H */
