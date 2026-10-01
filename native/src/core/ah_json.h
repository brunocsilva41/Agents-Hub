/* JSON do Hub sobre a árvore do cJSON, sem I/O (plano docs/17, F0-10).
 *
 * O valor é opaco (ah_json): por baixo é um item do cJSON, mas quem consome
 * não inclui cJSON.h. Leitura e escrita de texto são próprias, não do cJSON,
 * para casar com o TS (SPEC-02 §4.1, `store/src/db.ts:100-121`):
 *
 * - ah_json_parse aceita exatamente a gramática do JSON.parse (RFC 8259:
 *   espaço só " \t\n\r", sem lixo depois do valor, número sem "+", sem "01",
 *   sem ".5"/"1."). Chave repetida segue o JS: vale o último valor, na
 *   posição da primeira ocorrência. O parser do cJSON não serve: aceita lixo
 *   no fim e números fora da gramática, e escreve um erro global sem trava
 *   (cJSON.c:1148), o que é corrida de dados com várias threads.
 * - ah_json_parse_or é o `fromJson(raw, fallback)`: texto vazio, inválido ou
 *   `null` vira o padrão.
 * - ah_json_stringify é o `JSON.stringify(value ?? null)`: sem espaços,
 *   chaves na ordem do JS (chaves que são índice de array, "0".."4294967294"
 *   na forma canônica, primeiro, em ordem numérica; as demais na ordem de
 *   inserção), números pelo Number::toString do ECMAScript (inteiros sem
 *   ".0", 1e+21, 1e-7, NaN/Infinity viram null, -0 vira 0) e escapes de
 *   ah_text_append_json_string.
 *
 * Limitações conhecidas (o cJSON guarda string terminada em NUL e o C guarda
 * UTF-8): "\u0000" dentro de string é recusado (AH_ERR_INVALID), e "\uD800"
 * sem par vira U+FFFD (o JS manteria o surrogate isolado).
 *
 * Profundidade máxima de aninhamento: AH_JSON_MAX_DEPTH (o mesmo
 * CJSON_NESTING_LIMIT do cJSON vendorizado). Acima disso: AH_ERR_LIMIT. */
#ifndef AH_CORE_JSON_H
#define AH_CORE_JSON_H

#include <stdbool.h>
#include <stddef.h>

#include "ah_status.h"

#define AH_JSON_MAX_DEPTH 1000

typedef struct ah_json ah_json;

typedef enum ah_json_type {
    AH_JSON_NULL,
    AH_JSON_BOOL,
    AH_JSON_NUMBER,
    AH_JSON_STRING,
    AH_JSON_ARRAY,
    AH_JSON_OBJECT
} ah_json_type;

/* ---- Leitura ---------------------------------------------------------- */

/* Lê `len` bytes de `text` (emprestado; não precisa terminar em NUL).
 * AH_ERR_INVALID: fora da gramática do JSON.parse (inclusive vazio).
 * AH_ERR_LIMIT: aninhamento acima de AH_JSON_MAX_DEPTH.
 * Posse: o chamador libera *out com ah_json_free. Em erro, *out = NULL. */
ah_status ah_json_parse(const char *text, size_t len, ah_json **out);

/* `fromJson` do TS: `text` NULL ou vazio, inválido (qualquer erro do
 * ah_json_parse exceto falta de memória) ou o literal `null` dão uma cópia de
 * `fallback`; senão, o valor lido. `fallback` NULL deixa *out = NULL nesses
 * casos. Devolve AH_OK ou AH_ERR_NOMEM. Posse: o chamador libera *out com
 * ah_json_free; `fallback` é emprestado. */
ah_status ah_json_parse_or(const char *text, size_t len, const ah_json *fallback,
                           ah_json **out);

/* ---- Escrita ---------------------------------------------------------- */

/* `JSON.stringify(value ?? null)`: `value` NULL vira "null". Posse: o
 * chamador libera *out com ah_text_free (ah_text.h). `out_len` pode ser
 * NULL. AH_ERR_LIMIT: árvore mais funda que AH_JSON_MAX_DEPTH. */
ah_status ah_json_stringify(const ah_json *value, char **out, size_t *out_len);

/* ---- Acesso tipado ---------------------------------------------------- */

/* Tipo do valor. `v` não pode ser NULL. */
ah_json_type ah_json_type_of(const ah_json *v);

/* Texto da string (UTF-8, terminado em NUL), ou NULL se `v` não é string.
 * Posse: pertence a `v`; vale enquanto `v` não for alterado nem liberado. */
const char *ah_json_string(const ah_json *v);

/* true e *out = valor se `v` é número; senão false e *out intacto. */
bool ah_json_number(const ah_json *v, double *out);

/* true e *out = valor se `v` é booleano; senão false e *out intacto. */
bool ah_json_bool(const ah_json *v, bool *out);

/* Membro `key` (comparação exata de bytes) de um objeto, ou NULL se `obj`
 * não é objeto ou não tem a chave. Posse: pertence a `obj`. */
const ah_json *ah_json_get(const ah_json *obj, const char *key);

/* Quantidade de itens de array/objeto; 0 para os demais tipos. */
size_t ah_json_count(const ah_json *v);

/* Iteração em ordem de inserção: primeiro filho de array/objeto (NULL se
 * vazio ou outro tipo) e o irmão seguinte (NULL no fim). Posse: do pai. */
const ah_json *ah_json_first(const ah_json *v);
const ah_json *ah_json_next(const ah_json *item);

/* Chave de um membro obtido por ah_json_first/ah_json_next sobre um objeto;
 * NULL se o item não é membro de objeto. Posse: do item. */
const char *ah_json_key(const ah_json *member);

/* ---- Construção ------------------------------------------------------- */

/* Cada função devolve um valor novo ou NULL se faltar memória. Posse: o
 * chamador libera com ah_json_free, ou passa a posse a um array/objeto. */
ah_json *ah_json_new_null(void);
ah_json *ah_json_new_bool(bool b);
ah_json *ah_json_new_number(double n);
/* Copia `s` (UTF-8 terminado em NUL, emprestado). */
ah_json *ah_json_new_string(const char *s);
ah_json *ah_json_new_array(void);
ah_json *ah_json_new_object(void);

/* Cópia profunda de `v` (emprestado). NULL se faltar memória. */
ah_json *ah_json_duplicate(const ah_json *v);

/* Põe `value` em `obj[key]` como a atribuição do JS: chave nova vai para o
 * fim; chave existente troca o valor e mantém a posição. Posse: `value`
 * passa a ser de `obj` quando devolve AH_OK; em erro continua do chamador.
 * `key` é copiada. */
ah_status ah_json_set(ah_json *obj, const char *key, ah_json *value);

/* Acrescenta `value` ao fim de `arr`. Posse como em ah_json_set. */
ah_status ah_json_push(ah_json *arr, ah_json *value);

/* Libera `v` e tudo abaixo dele. NULL é no-op. Não libere um valor que já
 * pertence a um array/objeto. */
void ah_json_free(ah_json *v);

#endif /* AH_CORE_JSON_H */
