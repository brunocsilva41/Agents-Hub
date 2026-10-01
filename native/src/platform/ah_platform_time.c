/* Parte portável de ah_platform_time.h: formatação, hex, UUID v4 e o que se
 * deriva das primitivas por SO (ah_platform_time_win32.c /
 * ah_platform_time_posix.c). Sem chamada direta ao SO aqui. */
#include "ah_platform_time.h"

#include <stdio.h>
#include <stdlib.h>

/* 0000-01-01T00:00:00.000Z e 9999-12-31T23:59:59.999Z em ms Unix: a faixa em
 * que toISOString escreve o ano com 4 dígitos. */
#define ISO_MIN_MS INT64_C(-62167219200000)
#define ISO_MAX_MS INT64_C(253402300799999)
#define MS_PER_DAY INT64_C(86400000)

static void clear_out(char *out, size_t out_size) {
    if (out != NULL && out_size > 0) {
        out[0] = '\0';
    }
}

/* Dias desde 1970-01-01 -> data civil do calendário gregoriano proléptico
 * (algoritmo "civil_from_days" de Howard Hinnant). Feito à mão porque
 * gmtime_s/gmtime_r têm assinaturas diferentes por SO e esta conta é pura. */
static void civil_from_days(int64_t z, int64_t *y, unsigned *m, unsigned *d) {
    int64_t era;
    unsigned doe, yoe, doy, mp;

    z += 719468;
    era = (z >= 0 ? z : z - 146096) / 146097;
    doe = (unsigned)(z - era * 146097);
    yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    mp = (5 * doy + 2) / 153;
    *d = doy - (153 * mp + 2) / 5 + 1;
    *m = mp < 10 ? mp + 3 : mp - 9;
    *y = (int64_t)yoe + era * 400 + (*m <= 2 ? 1 : 0);
}

ah_status ah_platform_time_format_iso(int64_t unix_ms, char *out, size_t out_size) {
    int64_t days, ms_of_day, year;
    unsigned month, day, hh, mi, ss, ms;
    int n;

    if (out == NULL || out_size == 0) {
        return AH_ERR_INVALID;
    }
    out[0] = '\0';
    if (unix_ms < ISO_MIN_MS || unix_ms > ISO_MAX_MS) {
        return AH_ERR_INVALID;
    }
    if (out_size < AH_PLATFORM_ISO_TIME_SIZE) {
        return AH_ERR_LIMIT;
    }

    /* Divisão com piso: instantes antes de 1970 caem no dia anterior. */
    days = unix_ms / MS_PER_DAY;
    ms_of_day = unix_ms % MS_PER_DAY;
    if (ms_of_day < 0) {
        ms_of_day += MS_PER_DAY;
        days -= 1;
    }
    civil_from_days(days, &year, &month, &day);

    ms = (unsigned)(ms_of_day % 1000);
    ss = (unsigned)((ms_of_day / 1000) % 60);
    mi = (unsigned)((ms_of_day / 60000) % 60);
    hh = (unsigned)(ms_of_day / 3600000);

    n = snprintf(out, out_size, "%04d-%02u-%02uT%02u:%02u:%02u.%03uZ", (int)year,
                 month, day, hh, mi, ss, ms);
    if (n != AH_PLATFORM_ISO_TIME_SIZE - 1) {
        out[0] = '\0';
        return AH_ERR_INTERNAL;
    }
    return AH_OK;
}

ah_status ah_platform_time_now_iso(char *out, size_t out_size) {
    int64_t now;
    ah_status st;

    if (out == NULL || out_size == 0) {
        return AH_ERR_INVALID;
    }
    out[0] = '\0';
    st = ah_platform_time_now_unix_ms(&now);
    if (st != AH_OK) {
        return st;
    }
    return ah_platform_time_format_iso(now, out, out_size);
}

ah_status ah_platform_time_monotonic_ms(uint64_t *out) {
    uint64_t ns;
    ah_status st;

    if (out == NULL) {
        return AH_ERR_INVALID;
    }
    st = ah_platform_time_monotonic_ns(&ns);
    if (st != AH_OK) {
        return st;
    }
    *out = ns / UINT64_C(1000000);
    return AH_OK;
}

ah_status ah_platform_hex_encode(const void *data, size_t len, char *out,
                                 size_t out_size) {
    static const char digits[] = "0123456789abcdef";
    const unsigned char *p = (const unsigned char *)data;
    size_t i;

    if (out == NULL || out_size == 0 || (data == NULL && len > 0)) {
        clear_out(out, out_size);
        return AH_ERR_INVALID;
    }
    /* out_size >= 2*len + 1, escrito sem estourar size_t. */
    if (len > (out_size - 1) / 2) {
        out[0] = '\0';
        return AH_ERR_LIMIT;
    }
    for (i = 0; i < len; i++) {
        out[2 * i] = digits[p[i] >> 4];
        out[2 * i + 1] = digits[p[i] & 0x0f];
    }
    out[2 * len] = '\0';
    return AH_OK;
}

ah_status ah_platform_random_hex(size_t nbytes, char *out, size_t out_size) {
    unsigned char *buf;
    ah_status st;

    if (out == NULL || out_size == 0) {
        return AH_ERR_INVALID;
    }
    out[0] = '\0';
    if (nbytes > (out_size - 1) / 2) {
        return AH_ERR_LIMIT;
    }
    if (nbytes == 0) {
        return AH_OK;
    }
    buf = (unsigned char *)malloc(nbytes);
    if (buf == NULL) {
        return AH_ERR_NOMEM;
    }
    st = ah_platform_random_bytes(buf, nbytes);
    if (st == AH_OK) {
        st = ah_platform_hex_encode(buf, nbytes, out, out_size);
    }
    /* Os bytes podem virar segredo (operator-token): não ficam no heap. Laço
     * volátil para o compilador não remover a limpeza antes do free. */
    {
        volatile unsigned char *v = buf;
        size_t i;
        for (i = 0; i < nbytes; i++) {
            v[i] = 0;
        }
    }
    free(buf);
    if (st != AH_OK) {
        out[0] = '\0';
    }
    return st;
}

ah_status ah_platform_uuid_v4(char *out, size_t out_size) {
    unsigned char b[16];
    char hex[33];
    ah_status st;
    int n;

    if (out == NULL || out_size == 0) {
        return AH_ERR_INVALID;
    }
    out[0] = '\0';
    if (out_size < AH_PLATFORM_UUID_SIZE) {
        return AH_ERR_LIMIT;
    }
    st = ah_platform_random_bytes(b, sizeof b);
    if (st != AH_OK) {
        return st;
    }
    /* RFC 9562 §5.4: versão 4 no nibble alto do byte 6, variante 10xx no
     * byte 8. */
    b[6] = (unsigned char)((b[6] & 0x0f) | 0x40);
    b[8] = (unsigned char)((b[8] & 0x3f) | 0x80);
    st = ah_platform_hex_encode(b, sizeof b, hex, sizeof hex);
    if (st != AH_OK) {
        return AH_ERR_INTERNAL;
    }
    n = snprintf(out, out_size, "%.8s-%.4s-%.4s-%.4s-%.12s", hex, hex + 8, hex + 12,
                 hex + 16, hex + 20);
    if (n != AH_PLATFORM_UUID_SIZE - 1) {
        out[0] = '\0';
        return AH_ERR_INTERNAL;
    }
    return AH_OK;
}

void ah_platform_env_free(char *value) {
    free(value);
}
