#include "ah_unicode.h"

#include "ah_unicode_tables.h"

#define COUNT_OF(a) (sizeof(a) / sizeof((a)[0]))

#define CAPITAL_SIGMA 0x03A3u
#define SMALL_SIGMA 0x03C3u
#define SMALL_FINAL_SIGMA 0x03C2u
#define CAPITAL_I_DOT 0x0130u
#define COMBINING_DOT_ABOVE 0x0307u

/* O único mapeamento 1 para N do toLowerCase sem locale é o U+0130, tratado
 * à parte em append_lower_cp. Se a tabela regenerada trouxer outro, este
 * código precisa mudar junto: a compilação para aqui. */
_Static_assert(AH_UNICODE_SPECIAL_LOWER_COUNT == 1, "novo mapeamento 1 para N no toLowerCase");

static bool in_ranges(const uint32_t (*r)[2], size_t n, uint32_t cp) {
    size_t lo = 0;
    size_t hi = n;

    while (lo < hi) {
        size_t mid = lo + (hi - lo) / 2;
        if (cp < r[mid][0]) {
            hi = mid;
        } else if (cp > r[mid][1]) {
            lo = mid + 1;
        } else {
            return true;
        }
    }
    return false;
}

static uint32_t simple_lower(uint32_t cp) {
    size_t lo = 0;
    size_t hi = COUNT_OF(ah_unicode_lower_map);

    while (lo < hi) {
        size_t mid = lo + (hi - lo) / 2;
        if (cp < ah_unicode_lower_map[mid][0]) {
            hi = mid;
        } else if (cp > ah_unicode_lower_map[mid][0]) {
            lo = mid + 1;
        } else {
            return ah_unicode_lower_map[mid][1];
        }
    }
    return cp;
}

static bool is_cased(uint32_t cp) {
    return in_ranges(ah_unicode_cased, COUNT_OF(ah_unicode_cased), cp);
}

static bool is_case_ignorable(uint32_t cp) {
    return in_ranges(ah_unicode_case_ignorable, COUNT_OF(ah_unicode_case_ignorable), cp);
}

bool ah_unicode_is_js_space(uint32_t cp) {
    return in_ranges(ah_unicode_js_space, COUNT_OF(ah_unicode_js_space), cp);
}

uint32_t ah_unicode_next(const char *s, size_t len, size_t *pos) {
    const unsigned char *p = (const unsigned char *)s + *pos;
    uint32_t c = p[0];

    (void)len;
    if (c < 0x80) {
        *pos += 1;
        return c;
    }
    if (c < 0xE0) {
        *pos += 2;
        return ((c & 0x1Fu) << 6) | (p[1] & 0x3Fu);
    }
    if (c < 0xF0) {
        *pos += 3;
        return ((c & 0x0Fu) << 12) | ((uint32_t)(p[1] & 0x3Fu) << 6) | (p[2] & 0x3Fu);
    }
    *pos += 4;
    return ((c & 0x07u) << 18) | ((uint32_t)(p[1] & 0x3Fu) << 12) |
           ((uint32_t)(p[2] & 0x3Fu) << 6) | (p[3] & 0x3Fu);
}

/* Code point que termina logo antes de s[pos] (pos > 0, UTF-8 válido);
 * *start recebe o início dele. */
static uint32_t prev_cp(const char *s, size_t len, size_t pos, size_t *start) {
    size_t i = pos - 1;

    while (i > 0 && ((unsigned char)s[i] & 0xC0u) == 0x80u) {
        i--;
    }
    *start = i;
    return ah_unicode_next(s, len, &i);
}

ah_status ah_unicode_append_cp(ah_text_buf *b, uint32_t cp) {
    char u[4];
    size_t n;

    if (cp > 0x10FFFFu || (cp >= 0xD800u && cp <= 0xDFFFu)) {
        return AH_ERR_INVALID;
    }
    if (cp < 0x80u) {
        u[0] = (char)cp;
        n = 1;
    } else if (cp < 0x800u) {
        u[0] = (char)(0xC0u | (cp >> 6));
        u[1] = (char)(0x80u | (cp & 0x3Fu));
        n = 2;
    } else if (cp < 0x10000u) {
        u[0] = (char)(0xE0u | (cp >> 12));
        u[1] = (char)(0x80u | ((cp >> 6) & 0x3Fu));
        u[2] = (char)(0x80u | (cp & 0x3Fu));
        n = 3;
    } else {
        u[0] = (char)(0xF0u | (cp >> 18));
        u[1] = (char)(0x80u | ((cp >> 12) & 0x3Fu));
        u[2] = (char)(0x80u | ((cp >> 6) & 0x3Fu));
        u[3] = (char)(0x80u | (cp & 0x3Fu));
        n = 4;
    }
    return ah_text_buf_append(b, u, n);
}

/* Final_Sigma (Unicode, tabela 3-17), do jeito do ICU (ucase.cpp,
 * isFollowedByCasedLetter): andando para trás e para a frente, o que é
 * Case_Ignorable é pulado, mesmo que também seja Cased; o primeiro que não é
 * decide. Σ vira ς se há letra Cased antes e não há depois. */
static bool is_final_sigma(const char *s, size_t len, size_t at, size_t after) {
    bool before = false;
    size_t i = at;

    while (i > 0) {
        size_t start;
        uint32_t c = prev_cp(s, len, i, &start);
        i = start;
        if (is_case_ignorable(c)) {
            continue;
        }
        before = is_cased(c);
        break;
    }
    if (!before) {
        return false;
    }
    i = after;
    while (i < len) {
        uint32_t c = ah_unicode_next(s, len, &i);
        if (is_case_ignorable(c)) {
            continue;
        }
        return !is_cased(c);
    }
    return true;
}

ah_status ah_unicode_append_lower(ah_text_buf *b, const char *s, size_t len) {
    size_t i = 0;

    if (b == NULL || (s == NULL && len != 0) || !ah_text_utf8_valid(s, len)) {
        return AH_ERR_INVALID;
    }
    while (i < len) {
        size_t at = i;
        uint32_t c = ah_unicode_next(s, len, &i);
        ah_status st;

        if (c == CAPITAL_I_DOT) {
            st = ah_unicode_append_cp(b, 0x0069u);
            if (st == AH_OK) {
                st = ah_unicode_append_cp(b, COMBINING_DOT_ABOVE);
            }
        } else if (c == CAPITAL_SIGMA) {
            st = ah_unicode_append_cp(b, is_final_sigma(s, len, at, i) ? SMALL_FINAL_SIGMA
                                                                       : SMALL_SIGMA);
        } else if (c < 0x80u) {
            char a = (char)(c >= 'A' && c <= 'Z' ? c + ('a' - 'A') : c);
            st = ah_text_buf_append_char(b, a);
        } else {
            st = ah_unicode_append_cp(b, simple_lower(c));
        }
        if (st != AH_OK) {
            return st;
        }
    }
    return AH_OK;
}
