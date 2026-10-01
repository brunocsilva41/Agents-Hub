/* Regex do Hub sobre PCRE2 (8 bits), sem I/O (plano docs/17, F0-10).
 *
 * Usado pelos manifestos (`detect.versionRegex`, `session.nativeSessionMissing`
 * com flag `i`, SPEC-04 B2) e pelo classificador (SPEC-04 A6). O padrão é
 * compilado em modo UTF com PCRE2_MATCH_INVALID_UTF: o texto casado pode ter
 * UTF-8 inválido (stderr de um CLI) sem comportamento indefinido; bytes
 * inválidos só não casam com nada. `\C` é proibido (quebraria o modo UTF).
 *
 * Limites de casamento (SPEC-08 C3 / SEC-R37, adotados pela DA-29 no ADR 09)
 * vão em TODO casamento: match limit, depth limit e heap limit da PCRE2
 * vendorizada (10.49: pcre2_set_match_limit, pcre2_set_depth_limit,
 * pcre2_set_heap_limit). Estourar qualquer um devolve AH_ERR_LIMIT, sem
 * travar a thread. O match limit da PCRE2 vale por posição inicial tentada
 * (pcre2_match.c zera o contador a cada início), não pela chamada inteira.
 * Os valores padrão são PROPOSTA desta tarefa. */
#ifndef AH_CORE_REGEX_H
#define AH_CORE_REGEX_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "ah_status.h"

/* Padrões (PROPOSTA): 10x abaixo do MATCH_LIMIT de fábrica da PCRE2
 * (10.000.000), profundidade de retrocesso 10.000 e heap de 8 MiB (em KiB,
 * a unidade da PCRE2). */
#define AH_REGEX_DEFAULT_MATCH_LIMIT ((uint32_t)1000000)
#define AH_REGEX_DEFAULT_DEPTH_LIMIT ((uint32_t)10000)
#define AH_REGEX_DEFAULT_HEAP_LIMIT_KIB ((uint32_t)8192)

/* Flag de compilação: sem diferenciar maiúsculas (a flag `i` do JS). */
#define AH_REGEX_CASELESS 0x1u

typedef struct ah_regex_limits {
    uint32_t match_limit;
    uint32_t depth_limit;
    uint32_t heap_limit_kib;
} ah_regex_limits;

/* Trecho casado: [start, end) em bytes do texto. `matched` false = o grupo
 * não participou do casamento (start/end ficam 0). */
typedef struct ah_regex_span {
    size_t start;
    size_t end;
    bool matched;
} ah_regex_span;

typedef struct ah_regex ah_regex;

/* Preenche `lim` com os padrões AH_REGEX_DEFAULT_*. */
void ah_regex_limits_default(ah_regex_limits *lim);

/* Compila `pattern` (`len` bytes, UTF-8, emprestado) com `flags`
 * (AH_REGEX_CASELESS ou 0). `lim` NULL usa os padrões; os limites ficam
 * guardados no objeto e valem para todo casamento com ele.
 * AH_ERR_INVALID: padrão inválido (motivo legível em `err`, opcional).
 * Posse: o chamador libera *out com ah_regex_free. */
ah_status ah_regex_compile(const char *pattern, size_t len, unsigned flags,
                           const ah_regex_limits *lim, ah_regex **out, char *err,
                           size_t err_size);

/* Libera. NULL é no-op. */
void ah_regex_free(ah_regex *re);

/* Quantidade de grupos de captura do padrão (sem contar o grupo 0). */
size_t ah_regex_group_count(const ah_regex *re);

/* Procura a primeira ocorrência em `subject` (`len` bytes, emprestado).
 * *matched recebe se achou. Se `groups` não é NULL, recebe até `n_groups`
 * trechos: groups[0] é o casamento inteiro, groups[1..] os grupos de captura
 * (os que não existem no padrão saem com matched = false).
 * AH_ERR_LIMIT: algum limite de casamento estourou (*matched = false).
 * Seguro para várias threads com o mesmo `re` (cada chamada aloca o próprio
 * bloco de resultados). */
ah_status ah_regex_match(const ah_regex *re, const char *subject, size_t len, bool *matched,
                         ah_regex_span *groups, size_t n_groups);

#endif /* AH_CORE_REGEX_H */
