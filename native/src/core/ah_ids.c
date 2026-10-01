#include "ah_ids.h"

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include "ah_sha256.h"
#include "ah_text.h"
#include "ah_unicode.h"

#define UUID_LEN 36
#define ID_HEX_LEN 24
#define ISO_LEN 24
#define HASH_HEX_LEN 16

static const char *const PREFIX_NAMES[AH_ID_PREFIX_COUNT] = {
    "prj", "pfd", "ses", "tsk", "evt", "apv", "art", "run", "aud",
};

static void clear_out(char *out, size_t out_size) {
    if (out != NULL && out_size > 0) {
        out[0] = '\0';
    }
}

static bool is_lower_hex(char c) {
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
}

static bool is_digit(char c) {
    return c >= '0' && c <= '9';
}

const char *ah_id_prefix_name(ah_id_prefix p) {
    if ((unsigned)p >= (unsigned)AH_ID_PREFIX_COUNT) {
        return NULL;
    }
    return PREFIX_NAMES[p];
}

/* Forma de crypto.randomUUID(): 8-4-4-4-12 hex minúsculos, versão 4 e
 * variante RFC (8, 9, a ou b). A porta é confiável, mas um defeito nela
 * viraria id fora do formato gravado no banco para sempre. */
static bool uuid_v4_shape(const char *u) {
    size_t i;

    for (i = 0; i < UUID_LEN; i++) {
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (u[i] != '-') {
                return false;
            }
        } else if (!is_lower_hex(u[i])) {
            return false;
        }
    }
    return u[UUID_LEN] == '\0' && u[14] == '4' &&
           (u[19] == '8' || u[19] == '9' || u[19] == 'a' || u[19] == 'b');
}

ah_status ah_id_new(const ah_id_uuid_port *port, ah_id_prefix prefix, char *out,
                    size_t out_size) {
    char uuid[UUID_LEN + 1];
    const char *name = ah_id_prefix_name(prefix);
    ah_status st;
    size_t i;
    size_t n;

    clear_out(out, out_size);
    if (port == NULL || port->uuid_v4 == NULL || name == NULL || out == NULL) {
        return AH_ERR_INVALID;
    }
    if (out_size < AH_ID_SIZE) {
        return AH_ERR_LIMIT;
    }
    memset(uuid, 0, sizeof uuid);
    st = port->uuid_v4(port->ctx, uuid, sizeof uuid);
    if (st != AH_OK) {
        return st;
    }
    if (!uuid_v4_shape(uuid)) {
        return AH_ERR_INTERNAL;
    }
    memcpy(out, name, 3);
    out[3] = '_';
    n = 4;
    /* replaceAll('-', '').slice(0, 24) */
    for (i = 0; i < UUID_LEN && n < 4 + ID_HEX_LEN; i++) {
        if (uuid[i] != '-') {
            out[n++] = uuid[i];
        }
    }
    out[n] = '\0';
    return AH_OK;
}

/* "AAAA-MM-DDTHH:MM:SS.mmmZ" só na forma; os valores são da porta. */
static bool iso_shape(const char *s) {
    static const char pattern[] = "dddd-dd-ddTdd:dd:dd.dddZ";
    size_t i;

    for (i = 0; i < ISO_LEN; i++) {
        if (pattern[i] == 'd' ? !is_digit(s[i]) : s[i] != pattern[i]) {
            return false;
        }
    }
    return s[ISO_LEN] == '\0';
}

ah_status ah_now_iso(const ah_clock_port *port, char *out, size_t out_size) {
    char buf[AH_ISO_TIME_SIZE];
    ah_status st;

    clear_out(out, out_size);
    if (port == NULL || port->now_iso == NULL || out == NULL) {
        return AH_ERR_INVALID;
    }
    if (out_size < AH_ISO_TIME_SIZE) {
        return AH_ERR_LIMIT;
    }
    memset(buf, 0, sizeof buf);
    st = port->now_iso(port->ctx, buf, sizeof buf);
    if (st != AH_OK) {
        return st;
    }
    if (!iso_shape(buf)) {
        return AH_ERR_INTERNAL;
    }
    memcpy(out, buf, sizeof buf);
    return AH_OK;
}

/* Conjunto da pontuação final de `[\s.!?;:,…"'`)\]]+$` (ids.ts:27). */
static bool is_trailing_strip(uint32_t cp) {
    switch (cp) {
    case '.':
    case '!':
    case '?':
    case ';':
    case ':':
    case ',':
    case 0x2026u: /* … */
    case '"':
    case '\'':
    case '`':
    case ')':
    case ']':
        return true;
    default:
        return ah_unicode_is_js_space(cp);
    }
}

/* Normaliza `objective` como ids.ts:24-27 e devolve em `norm` (UTF-8). */
static ah_status normalize(const char *s, size_t len, ah_text_buf *norm) {
    ah_text_buf low;
    size_t start = 0;
    size_t end = len;
    size_t i;
    size_t keep;
    bool pending_space = false;
    ah_status st;

    /* trim(): tira \s das pontas. */
    while (start < end) {
        size_t p = start;
        if (!ah_unicode_is_js_space(ah_unicode_next(s, len, &p))) {
            break;
        }
        start = p;
    }
    while (end > start) {
        size_t p = end - 1;
        size_t q;
        while (p > start && ((unsigned char)s[p] & 0xC0u) == 0x80u) {
            p--;
        }
        q = p;
        if (!ah_unicode_is_js_space(ah_unicode_next(s, len, &q))) {
            break;
        }
        end = p;
    }

    /* toLowerCase() sobre o texto já aparado: o contexto do Final_Sigma é o
     * texto do trim, como no TS. */
    ah_text_buf_init(&low, 0);
    st = ah_unicode_append_lower(&low, s + start, end - start);
    if (st != AH_OK) {
        ah_text_buf_free(&low);
        return st;
    }

    /* replace(/\s+/g, ' '); depois do trim não há \s nas pontas. */
    i = 0;
    while (st == AH_OK && i < low.len) {
        size_t at = i;
        uint32_t c = ah_unicode_next(low.data, low.len, &i);
        if (ah_unicode_is_js_space(c)) {
            pending_space = true;
            continue;
        }
        if (pending_space) {
            st = ah_text_buf_append_char(norm, ' ');
            pending_space = false;
        }
        if (st == AH_OK) {
            st = ah_text_buf_append(norm, low.data + at, i - at);
        }
    }
    ah_text_buf_free(&low);
    if (st != AH_OK) {
        return st;
    }

    /* replace(/[\s.!?;:,…"'`)\]]+$/u, ''): corta o sufixo máximo do conjunto. */
    keep = norm->len;
    while (keep > 0) {
        size_t p = keep - 1;
        size_t q;
        while (p > 0 && ((unsigned char)norm->data[p] & 0xC0u) == 0x80u) {
            p--;
        }
        q = p;
        if (!is_trailing_strip(ah_unicode_next(norm->data, norm->len, &q))) {
            break;
        }
        keep = p;
    }
    if (norm->data != NULL) {
        norm->len = keep;
        norm->data[keep] = '\0';
    }
    return AH_OK;
}

ah_status ah_objective_hash(const char *objective, size_t len, char *out, size_t out_size) {
    static const char hex[] = "0123456789abcdef";
    unsigned char digest[AH_SHA256_DIGEST_SIZE];
    ah_text_buf norm;
    ah_status st;
    size_t i;

    clear_out(out, out_size);
    if (out == NULL || (objective == NULL && len != 0)) {
        return AH_ERR_INVALID;
    }
    if (out_size < AH_OBJECTIVE_HASH_SIZE) {
        return AH_ERR_LIMIT;
    }
    if (objective == NULL) {
        objective = ""; /* evita aritmética sobre ponteiro nulo adiante */
    }
    if (!ah_text_utf8_valid(objective, len)) {
        return AH_ERR_INVALID;
    }
    ah_text_buf_init(&norm, 0);
    st = normalize(objective, len, &norm);
    if (st != AH_OK) {
        ah_text_buf_free(&norm);
        return st;
    }
    ah_sha256_digest(norm.data, norm.len, digest);
    ah_text_buf_free(&norm);
    /* digest('hex').slice(0, 16) */
    for (i = 0; i < HASH_HEX_LEN / 2; i++) {
        out[2 * i] = hex[digest[i] >> 4];
        out[2 * i + 1] = hex[digest[i] & 0x0Fu];
    }
    out[HASH_HEX_LEN] = '\0';
    return AH_OK;
}
