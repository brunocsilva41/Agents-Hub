/* Testes de ah_platform_time.h (F0-06): relógio, CSPRNG, UUID v4, ambiente e
 * usuário do SO. Os formatos são conferidos caractere a caractere (o
 * equivalente das regex dos critérios), sem biblioteca de regex. */
/* Este teste chama o SO direto só para obter referências independentes da
 * camada testada (hora local por outra via; variável vazia no ambiente). */
#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#else
#define _POSIX_C_SOURCE 200809L
#include <stdlib.h>
#include <time.h>
#endif

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "ah_platform_time.h"
#include "ah_test.h"

static int is_digit(char c) {
    return c >= '0' && c <= '9';
}

static int is_lower_hex(char c) {
    return is_digit(c) || (c >= 'a' && c <= 'f');
}

/* Confere `s` contra um molde: 'd' = dígito, 'x' = hex minúsculo, qualquer
 * outro caractere = ele mesmo. Tamanhos precisam ser iguais. */
static int matches(const char *s, const char *mold) {
    size_t i;
    if (strlen(s) != strlen(mold)) {
        return 0;
    }
    for (i = 0; mold[i] != '\0'; i++) {
        if (mold[i] == 'd') {
            if (!is_digit(s[i])) return 0;
        } else if (mold[i] == 'x') {
            if (!is_lower_hex(s[i])) return 0;
        } else if (s[i] != mold[i]) {
            return 0;
        }
    }
    return 1;
}

/* ^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$ */
#define ISO_MOLD "dddd-dd-ddTdd:dd:dd.dddZ"

static void check_iso(int64_t ms, const char *expected) {
    char buf[AH_PLATFORM_ISO_TIME_SIZE];
    CHECK(ah_platform_time_format_iso(ms, buf, sizeof buf) == AH_OK);
    CHECK(strcmp(buf, expected) == 0);
    if (strcmp(buf, expected) != 0) {
        fprintf(stderr, "  esperado %s, obtido %s\n", expected, buf);
    }
}

static void test_format_iso(void) {
    char buf[AH_PLATFORM_ISO_TIME_SIZE];
    char small[AH_PLATFORM_ISO_TIME_SIZE - 1];

    /* Valores conferidos contra new Date(ms).toISOString(). */
    check_iso(0, "1970-01-01T00:00:00.000Z");
    check_iso(INT64_C(1700000000123), "2023-11-14T22:13:20.123Z");
    check_iso(INT64_C(951782400000), "2000-02-29T00:00:00.000Z");
    check_iso(-1, "1969-12-31T23:59:59.999Z");
    check_iso(INT64_C(-62167219200000), "0000-01-01T00:00:00.000Z");
    check_iso(INT64_C(253402300799999), "9999-12-31T23:59:59.999Z");

    CHECK(ah_platform_time_format_iso(INT64_C(253402300800000), buf, sizeof buf) ==
          AH_ERR_INVALID);
    CHECK(buf[0] == '\0');
    CHECK(ah_platform_time_format_iso(INT64_C(-62167219200001), buf, sizeof buf) ==
          AH_ERR_INVALID);
    CHECK(ah_platform_time_format_iso(0, small, sizeof small) == AH_ERR_LIMIT);
    CHECK(small[0] == '\0');
    CHECK(ah_platform_time_format_iso(0, NULL, 0) == AH_ERR_INVALID);
}

static void test_now_iso(void) {
    char buf[AH_PLATFORM_ISO_TIME_SIZE];
    int64_t ms = 0;

    CHECK(ah_platform_time_now_unix_ms(&ms) == AH_OK);
    /* Depois de 2020-01-01 e antes de 9999: relógio lido de verdade. */
    CHECK(ms > INT64_C(1577836800000));
    CHECK(ms < INT64_C(253402300799999));

    CHECK(ah_platform_time_now_iso(buf, sizeof buf) == AH_OK);
    CHECK(matches(buf, ISO_MOLD));
    CHECK(strncmp(buf, "20", 2) == 0);
}

/* Hora "AAAAMMDD-HHMMSS" obtida por outra via que não a camada testada.
 * local = 1: hora local (GetLocalTime / localtime_r); 0: UTC. */
static int reference_stamp(int local, char *out, size_t out_size) {
    int n;
#if defined(_WIN32)
    SYSTEMTIME st;
    if (local) {
        GetLocalTime(&st);
    } else {
        GetSystemTime(&st);
    }
    n = snprintf(out, out_size, "%04d%02d%02d-%02d%02d%02d", (int)st.wYear,
                 (int)st.wMonth, (int)st.wDay, (int)st.wHour, (int)st.wMinute,
                 (int)st.wSecond);
#else
    time_t t = time(NULL);
    struct tm tm;
    tzset();
    if (t == (time_t)-1 ||
        (local ? localtime_r(&t, &tm) : gmtime_r(&t, &tm)) == NULL) {
        return 0;
    }
    n = snprintf(out, out_size, "%04d%02d%02d-%02d%02d%02d", tm.tm_year + 1900,
                 tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec);
#endif
    return n == AH_PLATFORM_LOCAL_STAMP_SIZE - 1;
}

/* O carimbo de backup é hora LOCAL (SPEC-02 §6): ele precisa coincidir com a
 * hora local lida antes ou depois da chamada (o par antes/depois absorve a
 * virada de segundo). Limitação: numa máquina com fuso UTC, hora local e UTC
 * são iguais e este teste não distingue uma implementação que use UTC; o
 * teste avisa no stdout quando for o caso. */
static void test_local_stamp_is_local(void) {
    char before[AH_PLATFORM_LOCAL_STAMP_SIZE];
    char stamp[AH_PLATFORM_LOCAL_STAMP_SIZE];
    char after[AH_PLATFORM_LOCAL_STAMP_SIZE];
    char utc[AH_PLATFORM_LOCAL_STAMP_SIZE];
    char local_now[AH_PLATFORM_LOCAL_STAMP_SIZE];

    CHECK(reference_stamp(1, before, sizeof before));
    CHECK(ah_platform_time_local_stamp(stamp, sizeof stamp) == AH_OK);
    CHECK(reference_stamp(1, after, sizeof after));
    CHECK(strcmp(stamp, before) == 0 || strcmp(stamp, after) == 0);
    if (strcmp(stamp, before) != 0 && strcmp(stamp, after) != 0) {
        fprintf(stderr, "  carimbo %s fora de [%s, %s] (hora local)\n", stamp,
                before, after);
    }

    if (reference_stamp(0, utc, sizeof utc) &&
        reference_stamp(1, local_now, sizeof local_now) && strcmp(utc, local_now) == 0) {
        printf("aviso: fuso UTC nesta máquina; local x UTC não é distinguível\n");
    }
}

static void test_local_stamp(void) {
    char buf[AH_PLATFORM_LOCAL_STAMP_SIZE];
    char small[AH_PLATFORM_LOCAL_STAMP_SIZE - 1];

    /* ^\d{8}-\d{6}$ */
    CHECK(ah_platform_time_local_stamp(buf, sizeof buf) == AH_OK);
    CHECK(matches(buf, "dddddddd-dddddd"));
    CHECK(ah_platform_time_local_stamp(small, sizeof small) == AH_ERR_LIMIT);
}

static void test_monotonic(void) {
    uint64_t prev_ns = 0, prev_ms = 0;
    int i;

    for (i = 0; i < 10000; i++) {
        uint64_t ns = 0, ms = 0;
        CHECK(ah_platform_time_monotonic_ns(&ns) == AH_OK);
        CHECK(ah_platform_time_monotonic_ms(&ms) == AH_OK);
        CHECK(ns >= prev_ns);
        CHECK(ms >= prev_ms);
        /* ms lido depois de ns: não pode estar atrás dele. */
        CHECK(ms >= ns / UINT64_C(1000000));
        if (ns < prev_ns || ms < prev_ms) {
            break;
        }
        prev_ns = ns;
        prev_ms = ms;
    }
    CHECK(prev_ns > 0);
    CHECK(ah_platform_time_monotonic_ns(NULL) == AH_ERR_INVALID);
}

static void test_random_bytes(void) {
    unsigned char a[32], b[32];

    memset(a, 0, sizeof a);
    memset(b, 0, sizeof b);
    CHECK(ah_platform_random_bytes(a, sizeof a) == AH_OK);
    CHECK(ah_platform_random_bytes(b, sizeof b) == AH_OK);
    /* Chance de colisão em 256 bits: desprezível. */
    CHECK(memcmp(a, b, sizeof a) != 0);
    CHECK(ah_platform_random_bytes(NULL, 0) == AH_OK);
    CHECK(ah_platform_random_bytes(NULL, 1) == AH_ERR_INVALID);
}

static void test_hex(void) {
    static const unsigned char v[] = {0x00, 0x01, 0x7f, 0x80, 0xab, 0xff};
    char out[13];
    char small[12];

    CHECK(ah_platform_hex_encode(v, sizeof v, out, sizeof out) == AH_OK);
    CHECK(strcmp(out, "00017f80abff") == 0);
    CHECK(ah_platform_hex_encode(v, sizeof v, small, sizeof small) == AH_ERR_LIMIT);
    CHECK(small[0] == '\0');
    CHECK(ah_platform_hex_encode(v, 0, out, 1) == AH_OK);
    CHECK(out[0] == '\0');
}

static void test_random_hex(void) {
    char a[65], b[65];
    char small[64];

    /* Formato do operator-token: ^[0-9a-f]{64}$ (SPEC-01 §4). */
    CHECK(ah_platform_random_hex(32, a, sizeof a) == AH_OK);
    CHECK(ah_platform_random_hex(32, b, sizeof b) == AH_OK);
    CHECK(matches(a, "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"));
    CHECK(matches(b, "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"));
    CHECK(strcmp(a, b) != 0);
    CHECK(ah_platform_random_hex(32, small, sizeof small) == AH_ERR_LIMIT);
}

/* ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ */
static int is_uuid_v4(const char *u) {
    return matches(u, "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx") && u[14] == '4' &&
           (u[19] == '8' || u[19] == '9' || u[19] == 'a' || u[19] == 'b');
}

static void test_uuid_v4(void) {
    char a[AH_PLATFORM_UUID_SIZE], b[AH_PLATFORM_UUID_SIZE];
    char small[AH_PLATFORM_UUID_SIZE - 1];
    int i;

    /* Várias rodadas: um nibble de versão/variante não forçado passaria por
     * acaso numa única amostra. */
    for (i = 0; i < 256; i++) {
        CHECK(ah_platform_uuid_v4(a, sizeof a) == AH_OK);
        CHECK(is_uuid_v4(a));
        if (!is_uuid_v4(a)) {
            fprintf(stderr, "  uuid inválido: %s\n", a);
            break;
        }
    }
    CHECK(ah_platform_uuid_v4(b, sizeof b) == AH_OK);
    CHECK(strcmp(a, b) != 0);
    CHECK(ah_platform_uuid_v4(small, sizeof small) == AH_ERR_LIMIT);
}

/* Variável que existe com valor vazio: AH_OK e "", nunca NOT_FOUND. */
static void test_env_empty(void) {
    char *v = NULL;

#if defined(_WIN32)
    CHECK(SetEnvironmentVariableW(L"AH_TEST_VAZIA", L"") != 0);
#else
    CHECK(setenv("AH_TEST_VAZIA", "", 1) == 0);
#endif
    CHECK(ah_platform_env_get("AH_TEST_VAZIA", &v) == AH_OK);
    CHECK(v != NULL && v[0] == '\0');
    ah_platform_env_free(v);
}

static void test_env(void) {
    static char sentinel;
    char *v = &sentinel;

    CHECK(ah_platform_env_get("AH_TEST_VAR_INEXISTENTE_F0_06_7F3C", &v) ==
          AH_ERR_NOT_FOUND);
    CHECK(v == NULL);

    /* PATH existe no ambiente do ctest nos dois SOs. */
    CHECK(ah_platform_env_get("PATH", &v) == AH_OK);
    CHECK(v != NULL && v[0] != '\0');
    ah_platform_env_free(v);
    ah_platform_env_free(NULL);

    v = &sentinel;
    CHECK(ah_platform_env_get("", &v) == AH_ERR_INVALID);
    CHECK(v == NULL);
    CHECK(ah_platform_env_get("A=B", &v) == AH_ERR_INVALID);
    CHECK(ah_platform_env_get(NULL, &v) == AH_ERR_INVALID);
    CHECK(ah_platform_env_get("PATH", NULL) == AH_ERR_INVALID);
}

static void test_user_name(void) {
    char name[AH_PLATFORM_USER_NAME_SIZE];
    char tiny[1];

    CHECK(ah_platform_user_name(name, sizeof name) == AH_OK);
    CHECK(name[0] != '\0');
    CHECK(ah_platform_user_name(tiny, sizeof tiny) == AH_ERR_LIMIT);
    CHECK(tiny[0] == '\0');
}

int main(void) {
    test_format_iso();
    test_now_iso();
    test_local_stamp();
    test_local_stamp_is_local();
    test_monotonic();
    test_random_bytes();
    test_hex();
    test_random_hex();
    test_uuid_v4();
    test_env();
    test_env_empty();
    test_user_name();
    return AH_TEST_END("test_platform_time");
}
