/* Semântica Unicode do JavaScript que o domínio precisa reproduzir, sem I/O
 * (plano docs/17, F1-01).
 *
 * O `objectiveHash` (core/src/ids.ts:18-29) usa `trim()`, `\s` e
 * `toLowerCase()` do ECMAScript, e o corpus fixa o resultado em casos fora do
 * ASCII (native/tests/conformance/domain/README.md, "Dependências de
 * plataforma": NBSP, U+3000, U+2028 e BOM são espaço; `İ` vira `i` + U+0307;
 * `ß` fica; sem NFC/NFD). Aqui fica essa semântica, sobre UTF-8:
 *
 * - espaço = WhiteSpace + LineTerminator do ECMAScript (o conjunto de `\s` e
 *   do `trim()`);
 * - minúsculas = `String.prototype.toLowerCase` sem locale (Unicode Default
 *   Case Conversion: mapeamento simples, SpecialCasing incondicional e a
 *   regra condicional Final_Sigma do Σ, como o ICU do Node aplica).
 *
 * As tabelas (ah_unicode_tables.h) foram extraídas do Node 24.14.0 (o mesmo
 * da geração do corpus), Unicode 17.0; o gerador está no fim daquele arquivo.
 *
 * Entrada é UTF-8 válido (ah_text_utf8_valid); texto inválido devolve
 * AH_ERR_INVALID sem escrever nada. */
#ifndef AH_CORE_UNICODE_H
#define AH_CORE_UNICODE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "ah_status.h"
#include "ah_text.h"

/* true se `cp` casa com `\s` do ECMAScript (e, portanto, sai no `trim()`). */
bool ah_unicode_is_js_space(uint32_t cp);

/* Decodifica o code point que começa em s[*pos] e avança *pos. Exige que
 * os `len` bytes de `s` já sejam UTF-8 válido e *pos < len, numa fronteira
 * de code point (contrato do chamador; sem checagem). */
uint32_t ah_unicode_next(const char *s, size_t len, size_t *pos);

/* Acrescenta a `b` o UTF-8 de `cp` (até U+10FFFF, fora surrogates).
 * AH_ERR_INVALID para cp fora disso; demais erros vêm de ah_text_buf. */
ah_status ah_unicode_append_cp(ah_text_buf *b, uint32_t cp);

/* Acrescenta a `b` o `s.toLowerCase()` dos `len` bytes de `s` (emprestado).
 * O resultado pode ter mais bytes que a entrada (U+0130 de 2 bytes vira
 * 3 bytes). Em erro, `b` pode ter recebido uma parte do texto. */
ah_status ah_unicode_append_lower(ah_text_buf *b, const char *s, size_t len);

#endif /* AH_CORE_UNICODE_H */
