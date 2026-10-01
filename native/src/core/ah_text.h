/* Texto UTF-8 e buffer crescente, sem I/O (plano docs/17, F0-10).
 *
 * Strings internas do Hub são UTF-8 em `char *` (docs/18 §9). Aqui ficam:
 * validação e contagem de code points, corte com teto em bytes que nunca parte
 * um code point (DV-42, decidida no ADR 09: corte em fronteira de code point
 * UTF-8, não em unidade UTF-16) e o escape de string igual ao JSON.stringify.
 *
 * A decodificação segue o decodificador UTF-8 do WHATWG Encoding (o mesmo do
 * Buffer.toString('utf8') e do TextDecoder do Node): rejeita forma longa,
 * surrogates (U+D800..U+DFFF) e valores acima de U+10FFFF, e cada "subparte
 * maximal" inválida vale um U+FFFD. */
#ifndef AH_CORE_TEXT_H
#define AH_CORE_TEXT_H

#include <stdbool.h>
#include <stddef.h>

#include "ah_status.h"

/* Buffer de bytes crescente, sempre terminado em NUL quando data != NULL.
 * Campos são só de leitura para o chamador; mude-os só por estas funções.
 * `max` é o teto de `len` (sem contar o NUL); estourar devolve AH_ERR_LIMIT
 * e deixa o conteúdo anterior intacto. */
typedef struct ah_text_buf {
    char *data;
    size_t len;
    size_t cap;
    size_t max;
} ah_text_buf;

/* Inicia vazio, sem alocar. `max_len` 0 = sem teto além da memória. */
void ah_text_buf_init(ah_text_buf *b, size_t max_len);

/* Acrescenta `n` bytes de `s` (emprestado; pode conter NUL). */
ah_status ah_text_buf_append(ah_text_buf *b, const char *s, size_t n);

/* Acrescenta um byte. */
ah_status ah_text_buf_append_char(ah_text_buf *b, char c);

/* Transfere a posse do conteúdo: devolve a string terminada em NUL (nunca
 * NULL: buffer vazio vira "" alocada) e deixa `b` vazio e reutilizável.
 * `out_len` pode ser NULL. Posse: o chamador libera o retorno com
 * ah_text_free. Devolve NULL só se faltar memória (o conteúdo é liberado). */
char *ah_text_buf_take(ah_text_buf *b, size_t *out_len);

/* Libera o conteúdo e deixa `b` vazio. `b` NULL é no-op. */
void ah_text_buf_free(ah_text_buf *b);

/* Libera texto devolvido pelas funções ah_text_* e ah_json_stringify.
 * NULL é no-op. */
void ah_text_free(char *s);

/* true se os `len` bytes de `s` são UTF-8 válido (WHATWG). `s` pode ser NULL
 * só com len 0. NUL no meio é válido (U+0000). */
bool ah_text_utf8_valid(const char *s, size_t len);

/* Conta os code points de `s`. Entrada inválida devolve AH_ERR_INVALID e não
 * escreve *out. */
ah_status ah_text_utf8_count(const char *s, size_t len, size_t *out);

/* Maior prefixo de `s` com no máximo `max_bytes` bytes que termina em
 * fronteira de code point: devolve o tamanho desse prefixo (<= len).
 * Nunca deixa um code point de 2 a 4 bytes partido no fim. Em entrada
 * inválida, um byte de continuação solto conta como fronteira própria. */
size_t ah_text_utf8_cut(const char *s, size_t len, size_t max_bytes);

/* Acrescenta a `b` a string `s` entre aspas, com os escapes do
 * JSON.stringify (ECMAScript QuoteJSONString): \" \\ \b \f \n \r \t, os
 * demais controles U+0000..U+001F como \u00xx (hex minúsculo) e todo o resto
 * cru (inclusive DEL, "/", U+2028 e U+2029). Bytes UTF-8 inválidos viram
 * U+FFFD, como o Node faria ao decodificar os mesmos bytes. */
ah_status ah_text_append_json_string(ah_text_buf *b, const char *s, size_t len);

#endif /* AH_CORE_TEXT_H */
