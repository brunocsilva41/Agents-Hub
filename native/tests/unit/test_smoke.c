/* Teste mínimo do esqueleto: versão do ah_core e prova de link do SQLite.
 * Sem framework: cada falha imprime o local e o teste devolve código != 0.
 * Não usa <assert.h> de propósito, para valer também com NDEBUG (Release). */
#include <stdio.h>
#include <string.h>

#include "ah_version.h"
#include "sqlite3.h"

static int g_failures = 0;

#define CHECK(cond)                                                        \
    do {                                                                   \
        if (!(cond)) {                                                     \
            fprintf(stderr, "%s:%d: falhou: %s\n", __FILE__, __LINE__,     \
                    #cond);                                                \
            g_failures++;                                                  \
        }                                                                  \
    } while (0)

static void test_version(void) {
    const char *v = ah_core_version_string();
    char expected[32];
    int n;

    CHECK(v != NULL);
    CHECK(v != NULL && strcmp(v, "0.1.0") == 0);
    CHECK(ah_core_version_major() == 0);
    CHECK(ah_core_version_minor() == 1);
    CHECK(ah_core_version_patch() == 0);

    /* docs/18 §6: retorno do snprintf sempre checado (erro < 0, truncado >= tamanho). */
    n = snprintf(expected, sizeof expected, "%d.%d.%d", ah_core_version_major(),
                 ah_core_version_minor(), ah_core_version_patch());
    CHECK(n > 0 && (size_t)n < sizeof expected);
    if (n > 0 && (size_t)n < sizeof expected) {
        CHECK(v != NULL && strcmp(v, expected) == 0);
    }
}

static void test_sqlite_memory(void) {
    sqlite3 *db = NULL;
    sqlite3_stmt *stmt = NULL;
    int rc;

    CHECK(sqlite3_threadsafe() == 1);

    rc = sqlite3_open(":memory:", &db);
    CHECK(rc == SQLITE_OK);
    if (rc != SQLITE_OK) {
        sqlite3_close(db);
        return;
    }

    rc = sqlite3_exec(db,
                      "CREATE TABLE t(x INTEGER);"
                      "INSERT INTO t VALUES (40), (2);",
                      NULL, NULL, NULL);
    CHECK(rc == SQLITE_OK);

    rc = sqlite3_prepare_v2(db, "SELECT sum(x) FROM t;", -1, &stmt, NULL);
    CHECK(rc == SQLITE_OK);
    if (rc == SQLITE_OK) {
        CHECK(sqlite3_step(stmt) == SQLITE_ROW);
        CHECK(sqlite3_column_int(stmt, 0) == 42);
    }
    sqlite3_finalize(stmt);

    CHECK(sqlite3_close(db) == SQLITE_OK);
}

int main(void) {
    test_version();
    test_sqlite_memory();

    if (g_failures != 0) {
        fprintf(stderr, "test_smoke: %d falha(s)\n", g_failures);
        return 1;
    }
    printf("test_smoke: ok (ah %s, sqlite %s)\n", ah_core_version_string(),
           sqlite3_libversion());
    return 0;
}
