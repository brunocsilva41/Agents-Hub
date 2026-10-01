/* Regex do Hub sobre PCRE2 (8 bits), sem I/O (plano docs/17, F0-10).
 *
 * Usado pelos manifestos (`detect.versionRegex`, `session.nativeSessionMissing`
 * compilado com a flag `i`, SPEC-04 B2) e pelo classificador (SPEC-04 A6).
 *
 * Dialeto: o mais perto possível do RegExp do JS SEM a flag `u`, com estas
 * opções da PCRE2 10.49:
 * - PCRE2_DOLLAR_ENDONLY: `abc$` não casa "abc\n" (no JS, `$` sem `m` só
 *   casa no fim do texto);
 * - PCRE2_ALT_BSUX: `\uhhhh` e `\xhh` como no JS, `\U` é a letra U e `\u`
 *   sem 4 hex é a letra u. PCRE2_EXTRA_ALT_BSUX NÃO entra: ele lê `\u{2}`
 *   como U+0002, e no JS sem `u` isso é "u" repetido 2 vezes;
 * - PCRE2_ALLOW_EMPTY_CLASS: `[]` não casa nada e `[^]` casa qualquer
 *   caractere, inclusive quebra de linha;
 * - PCRE2_EXTRA_CASELESS_RESTRICT: com `i`, ASCII não casa com não-ASCII
 *   (`/s/i` não casa "ſ", `/k/i` não casa o sinal Kelvin), como o
 *   Canonicalize do JS sem `u`;
 * - newline ANYCRLF: `.` não casa "\n" nem "\r".
 * Diferenças que ficam: `.` casa U+2028/U+2029 (o JS não); `\s` é só ASCII
 * (o JS inclui U+00A0, U+FEFF e outros); o texto é lido como UTF-8, então
 * um caractere fora do BMP é UM caractere (no JS sem `u` são dois); e a
 * sintaxe própria da PCRE2 (`a++`, `(?>...)`, `(?i)`, `\Q...\E`, ...) compila
 * aqui e é SyntaxError no JS.
 *
 * Texto casado pode ter UTF-8 inválido (stderr de um CLI): o padrão é
 * compilado com PCRE2_MATCH_INVALID_UTF, sem comportamento indefinido; bytes
 * inválidos só não casam com nada. `\C` é proibido (quebraria o modo UTF).
 *
 * Limites de casamento (SPEC-08 C3 / SEC-R37, adotados pela DA-29 no ADR 09),
 * em TODO casamento:
 * - match limit, depth limit e heap limit da PCRE2 (pcre2_set_match_limit,
 *   pcre2_set_depth_limit, pcre2_set_heap_limit). A PCRE2 os aplica a cada
 *   posição inicial tentada (pcre2_match.c zera o contador a cada início);
 * - orçamento total da chamada (`total_limit`): o padrão é compilado com
 *   PCRE2_AUTO_CALLOUT e um callout conta cada passo, somando todas as
 *   posições iniciais. Sem ele, um padrão com retrocesso moderado por posição
 *   contra um texto longo levaria minutos sem estourar nenhum limite da PCRE2.
 * Estourar qualquer um devolve AH_ERR_LIMIT, sem travar a thread. Os valores
 * padrão são PROPOSTA desta tarefa. */
#ifndef AH_CORE_REGEX_H
#define AH_CORE_REGEX_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "ah_status.h"

/* Padrões (PROPOSTA): match limit 10x abaixo do de fábrica da PCRE2
 * (10.000.000), profundidade de retrocesso 10.000, heap de 8 MiB (em KiB, a
 * unidade da PCRE2) e 2.000.000 de passos por chamada inteira. */
#define AH_REGEX_DEFAULT_MATCH_LIMIT ((uint32_t)1000000)
#define AH_REGEX_DEFAULT_DEPTH_LIMIT ((uint32_t)10000)
#define AH_REGEX_DEFAULT_HEAP_LIMIT_KIB ((uint32_t)8192)
#define AH_REGEX_DEFAULT_TOTAL_LIMIT ((uint64_t)2000000)

/* Flag de compilação: sem diferenciar maiúsculas (a flag `i` do JS). */
#define AH_REGEX_CASELESS 0x1u

typedef struct ah_regex_limits {
    uint32_t match_limit;    /* por posição inicial (PCRE2) */
    uint32_t depth_limit;    /* por posição inicial (PCRE2) */
    uint32_t heap_limit_kib; /* por chamada (PCRE2) */
    uint64_t total_limit;    /* passos (callouts) somando a chamada inteira */
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
 * bloco de resultados e o próprio contador do orçamento). */
ah_status ah_regex_match(const ah_regex *re, const char *subject, size_t len, bool *matched,
                         ah_regex_span *groups, size_t n_groups);

#endif /* AH_CORE_REGEX_H */
