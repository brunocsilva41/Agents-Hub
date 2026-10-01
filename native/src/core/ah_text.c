#include "ah_text.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define REPLACEMENT_CHAR 0xFFFDu

void ah_text_buf_init(ah_text_buf *b, size_t max_len) {
    b->data = NULL;
    b->len = 0;
    b->cap = 0;
    b->max = max_len;
}

/* Garante espaço para mais `extra` bytes e o NUL final. */
static ah_status buf_reserve(ah_text_buf *b, size_t extra) {
    size_t need;
    size_t cap;
    char *p;

    if (extra > SIZE_MAX - 1 - b->len) {
        return AH_ERR_LIMIT;
    }
    if (b->max != 0 && b->len + extra > b->max) {
        return AH_ERR_LIMIT;
    }
    need = b->len + extra + 1;
    if (need <= b->cap) {
        return AH_OK;
    }
    cap = b->cap < 64 ? 64 : b->cap;
    while (cap < need) {
        if (cap > SIZE_MAX / 2) {
            cap = need;
            break;
        }
        cap *= 2;
    }
    p = realloc(b->data, cap);
    if (p == NULL) {
        return AH_ERR_NOMEM;
    }
    b->data = p;
    b->cap = cap;
    return AH_OK;
}

ah_status ah_text_buf_append(ah_text_buf *b, const char *s, size_t n) {
    ah_status st;

    if (b == NULL || (s == NULL && n != 0)) {
        return AH_ERR_INVALID;
    }
    st = buf_reserve(b, n);
    if (st != AH_OK) {
        return st;
    }
    if (n != 0) {
        memcpy(b->data + b->len, s, n);
    }
    b->len += n;
    b->data[b->len] = '\0';
    return AH_OK;
}

ah_status ah_text_buf_append_char(ah_text_buf *b, char c) {
    return ah_text_buf_append(b, &c, 1);
}

char *ah_text_buf_take(ah_text_buf *b, size_t *out_len) {
    char *s;

    if (b->data == NULL && buf_reserve(b, 0) != AH_OK) {
        ah_text_buf_free(b);
        return NULL;
    }
    if (b->data == NULL) {
        return NULL;
    }
    b->data[b->len] = '\0';
    s = b->data;
    if (out_len != NULL) {
        *out_len = b->len;
    }
    b->data = NULL;
    b->len = 0;
    b->cap = 0;
    return s;
}

void ah_text_buf_free(ah_text_buf *b) {
    if (b == NULL) {
        return;
    }
    free(b->data);
    b->data = NULL;
    b->len = 0;
    b->cap = 0;
}

void ah_text_free(char *s) { free(s); }

/* Decodifica um code point a partir de s[0] (len >= 1), pelo algoritmo do
 * WHATWG Encoding. Devolve quantos bytes consumiu (>= 1). Em erro, *cp recebe
 * U+FFFD, *ok = false, e o consumo é a subparte maximal: o byte inicial mais
 * as continuações válidas lidas antes do byte que falhou (que não é
 * consumido, e recomeça a decodificação). */
static size_t utf8_decode(const unsigned char *s, size_t len, uint32_t *cp, bool *ok) {
    unsigned char b0 = s[0];
    size_t need;
    unsigned char lower = 0x80;
    unsigned char upper = 0xBF;
    uint32_t v;
    size_t i;

    if (b0 < 0x80) {
        *cp = b0;
        *ok = true;
        return 1;
    }
    if (b0 >= 0xC2 && b0 <= 0xDF) {
        need = 1;
        v = b0 & 0x1Fu;
    } else if (b0 >= 0xE0 && b0 <= 0xEF) {
        need = 2;
        v = b0 & 0x0Fu;
        if (b0 == 0xE0) {
            lower = 0xA0;
        } else if (b0 == 0xED) {
            upper = 0x9F; /* exclui os surrogates */
        }
    } else if (b0 >= 0xF0 && b0 <= 0xF4) {
        need = 3;
        v = b0 & 0x07u;
        if (b0 == 0xF0) {
            lower = 0x90;
        } else if (b0 == 0xF4) {
            upper = 0x8F; /* teto U+10FFFF */
        }
    } else {
        *cp = REPLACEMENT_CHAR;
        *ok = false;
        return 1;
    }
    for (i = 1; i <= need; i++) {
        if (i >= len || s[i] < lower || s[i] > upper) {
            *cp = REPLACEMENT_CHAR;
            *ok = false;
            return i;
        }
        v = (v << 6) | (s[i] & 0x3Fu);
        lower = 0x80;
        upper = 0xBF;
    }
    *cp = v;
    *ok = true;
    return need + 1;
}

bool ah_text_utf8_valid(const char *s, size_t len) {
    const unsigned char *p = (const unsigned char *)s;
    size_t i = 0;

    if (s == NULL) {
        return len == 0;
    }
    while (i < len) {
        uint32_t cp;
        bool ok;
        i += utf8_decode(p + i, len - i, &cp, &ok);
        if (!ok) {
            return false;
        }
    }
    return true;
}

ah_status ah_text_utf8_count(const char *s, size_t len, size_t *out) {
    const unsigned char *p = (const unsigned char *)s;
    size_t i = 0;
    size_t n = 0;

    if ((s == NULL && len != 0) || out == NULL) {
        return AH_ERR_INVALID;
    }
    while (i < len) {
        uint32_t cp;
        bool ok;
        i += utf8_decode(p + i, len - i, &cp, &ok);
        if (!ok) {
            return AH_ERR_INVALID;
        }
        n++;
    }
    *out = n;
    return AH_OK;
}

size_t ah_text_utf8_cut(const char *s, size_t len, size_t max_bytes) {
    const unsigned char *p = (const unsigned char *)s;
    size_t cut;
    size_t back = 0;

    if (s == NULL || len <= max_bytes) {
        return s == NULL ? 0 : len;
    }
    /* p[max_bytes] existe (len > max_bytes). Se ele é continuação (10xxxxxx),
     * o corte cairia dentro de um code point: recua até o byte inicial. Um
     * code point tem no máximo 3 continuações; mais que isso é entrada
     * inválida e o corte fica onde estava. */
    cut = max_bytes;
    while (cut > 0 && back < 3 && (p[cut] & 0xC0u) == 0x80u) {
        cut--;
        back++;
    }
    if ((p[cut] & 0xC0u) == 0x80u) {
        return max_bytes; /* sem byte inicial por perto: continuações soltas */
    }
    if (cut < max_bytes) {
        /* Confere que p[cut] inicia mesmo uma sequência que chega até
         * p[max_bytes]; senão as continuações eram soltas e o corte original
         * não parte code point válido. */
        uint32_t cp;
        bool ok;
        size_t used = utf8_decode(p + cut, len - cut, &cp, &ok);
        if (!ok || cut + used <= max_bytes) {
            return max_bytes;
        }
    }
    return cut;
}

static const char HEX[] = "0123456789abcdef";

ah_status ah_text_append_json_string(ah_text_buf *b, const char *s, size_t len) {
    const unsigned char *p = (const unsigned char *)s;
    size_t i = 0;
    size_t run = 0; /* início do trecho cru pendente */
    ah_status st;

    if (b == NULL || (s == NULL && len != 0)) {
        return AH_ERR_INVALID;
    }
    st = ah_text_buf_append_char(b, '"');
    while (st == AH_OK && i < len) {
        unsigned char c = p[i];
        char esc[6];
        size_t esc_len = 0;
        size_t used = 1;
        bool bad = false;

        if (c >= 0x80) {
            uint32_t cp;
            bool ok;
            used = utf8_decode(p + i, len - i, &cp, &ok);
            bad = !ok;
        } else if (c == '"' || c == '\\') {
            esc[0] = '\\';
            esc[1] = (char)c;
            esc_len = 2;
        } else if (c < 0x20) {
            esc[0] = '\\';
            esc_len = 2;
            switch (c) {
            case '\b': esc[1] = 'b'; break;
            case '\f': esc[1] = 'f'; break;
            case '\n': esc[1] = 'n'; break;
            case '\r': esc[1] = 'r'; break;
            case '\t': esc[1] = 't'; break;
            default:
                esc[1] = 'u';
                esc[2] = '0';
                esc[3] = '0';
                esc[4] = HEX[c >> 4];
                esc[5] = HEX[c & 0x0Fu];
                esc_len = 6;
                break;
            }
        }
        if (esc_len == 0 && !bad) {
            i += used; /* cru: fica no trecho pendente */
            continue;
        }
        if (i > run) {
            st = ah_text_buf_append(b, s + run, i - run);
        }
        if (st == AH_OK) {
            st = bad ? ah_text_buf_append(b, "\xEF\xBF\xBD", 3)
                     : ah_text_buf_append(b, esc, esc_len);
        }
        i += used;
        run = i;
    }
    if (st == AH_OK && i > run) {
        st = ah_text_buf_append(b, s + run, i - run);
    }
    if (st == AH_OK) {
        st = ah_text_buf_append_char(b, '"');
    }
    return st;
}
