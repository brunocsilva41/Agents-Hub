/* Leitura de JSONL embutido (corpus de conformidade) para os testes da F1-01.
 * Só para teste: chama `fn` com cada linha não vazia já lida por
 * ah_json_parse; linha que não é JSON conta como falha do teste. */
#ifndef AH_TEST_JSONL_H
#define AH_TEST_JSONL_H

#include <stddef.h>
#include <string.h>

#include "ah_json.h"
#include "ah_test.h"

typedef void (*ah_test_jsonl_fn)(const ah_json *line, void *ctx);

/* Devolve quantas linhas foram entregues a `fn`. */
static size_t ah_test_jsonl_each(const unsigned char *data, size_t len, ah_test_jsonl_fn fn,
                                 void *ctx) {
    size_t start = 0;
    size_t lines = 0;

    while (start < len) {
        const unsigned char *nl = memchr(data + start, '\n', len - start);
        size_t end = nl != NULL ? (size_t)(nl - data) : len;
        size_t n = end - start;

        if (n > 0 && data[start + n - 1] == '\r') {
            n--;
        }
        if (n > 0) {
            ah_json *v = NULL;
            ah_status st = ah_json_parse((const char *)data + start, n, &v);
            CHECK(st == AH_OK);
            if (st == AH_OK) {
                fn(v, ctx);
                lines++;
            }
            ah_json_free(v);
        }
        start = end + 1;
    }
    return lines;
}

/* Texto de `obj[key]` se for string; senão NULL. */
static const char *ah_test_json_str(const ah_json *obj, const char *key) {
    const ah_json *v = ah_json_get(obj, key);
    return v != NULL ? ah_json_string(v) : NULL;
}

#endif /* AH_TEST_JSONL_H */
