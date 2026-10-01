/* F0-10: UTF-8 (validar, contar, cortar em fronteira de code point — DV-42) e
 * escape de string igual ao JSON.stringify. */
#include <string.h>

#include "ah_test.h"
#include "ah_text.h"

#define LIT(s) (s), (sizeof(s) - 1)

static void test_valid(void) {
    CHECK(ah_text_utf8_valid(LIT("")));
    CHECK(ah_text_utf8_valid(NULL, 0));
    CHECK(ah_text_utf8_valid(LIT("abc")));
    CHECK(ah_text_utf8_valid(LIT("\xC3\xA9")));             /* é */
    CHECK(ah_text_utf8_valid(LIT("\xF0\x9F\x98\x80")));     /* 😀 */
    CHECK(ah_text_utf8_valid(LIT("\xF4\x8F\xBF\xBF")));     /* U+10FFFF */
    CHECK(!ah_text_utf8_valid(LIT("\xC0\x80")));            /* forma longa */
    CHECK(!ah_text_utf8_valid(LIT("\xE0\x80\x80")));        /* forma longa */
    CHECK(!ah_text_utf8_valid(LIT("\xED\xA0\x80")));        /* surrogate */
    CHECK(!ah_text_utf8_valid(LIT("\xF4\x90\x80\x80")));    /* > U+10FFFF */
    CHECK(!ah_text_utf8_valid(LIT("\xF0\x9F\x98")));        /* truncado */
    CHECK(!ah_text_utf8_valid(LIT("\x80")));                /* continuação solta */
    CHECK(!ah_text_utf8_valid(LIT("\xFF")));
}

static void test_count(void) {
    size_t n = 99;
    CHECK(ah_text_utf8_count(LIT("a\xC3\xA9\xF0\x9F\x98\x80\xE2\x82\xAC"), &n) == AH_OK);
    CHECK(n == 4);
    CHECK(ah_text_utf8_count(LIT(""), &n) == AH_OK);
    CHECK(n == 0);
    n = 7;
    CHECK(ah_text_utf8_count(LIT("a\xFF"), &n) == AH_ERR_INVALID);
    CHECK(n == 7);
}

static void test_cut(void) {
    /* "abc" + 😀 (4 bytes): o teto cai em cada byte do emoji. */
    static const char s[] = "abc\xF0\x9F\x98\x80" "d";
    size_t len = sizeof s - 1; /* 8 */
    size_t m;

    CHECK(ah_text_utf8_cut(s, len, 3) == 3);
    CHECK(ah_text_utf8_cut(s, len, 4) == 3);
    CHECK(ah_text_utf8_cut(s, len, 5) == 3);
    CHECK(ah_text_utf8_cut(s, len, 6) == 3);
    CHECK(ah_text_utf8_cut(s, len, 7) == 7);
    CHECK(ah_text_utf8_cut(s, len, 8) == 8);
    CHECK(ah_text_utf8_cut(s, len, 100) == 8);
    CHECK(ah_text_utf8_cut(s, len, 0) == 0);
    /* Nenhum teto produz prefixo inválido. */
    for (m = 0; m <= len; m++) {
        size_t c = ah_text_utf8_cut(s, len, m);
        CHECK(c <= m);
        CHECK(ah_text_utf8_valid(s, c));
    }
    /* 2 e 3 bytes. */
    CHECK(ah_text_utf8_cut(LIT("x\xC3\xA9"), 2) == 1);
    CHECK(ah_text_utf8_cut(LIT("\xE2\x82\xAC\xE2\x82\xAC"), 5) == 3);
    /* Emoji exatamente no limite: corte logo depois dele. */
    CHECK(ah_text_utf8_cut(LIT("\xF0\x9F\x98\x80\xF0\x9F\x98\x80"), 4) == 4);
    /* Entrada inválida: continuações soltas não fazem o corte recuar. */
    CHECK(ah_text_utf8_cut(LIT("ab\x80\x80\x80\x80"), 4) == 4);
}

static void test_buf_limit(void) {
    ah_text_buf b;
    char *s;
    size_t n = 0;

    ah_text_buf_init(&b, 4);
    CHECK(ah_text_buf_append(&b, LIT("abc")) == AH_OK);
    CHECK(ah_text_buf_append(&b, LIT("de")) == AH_ERR_LIMIT);
    CHECK(b.len == 3 && strcmp(b.data, "abc") == 0);
    CHECK(ah_text_buf_append_char(&b, 'd') == AH_OK);
    s = ah_text_buf_take(&b, &n);
    CHECK(s != NULL && n == 4 && strcmp(s, "abcd") == 0);
    CHECK(b.data == NULL && b.len == 0);
    ah_text_free(s);

    ah_text_buf_init(&b, 0);
    s = ah_text_buf_take(&b, &n);
    CHECK(s != NULL && n == 0 && s[0] == '\0');
    ah_text_free(s);
    ah_text_buf_free(NULL);
}

static void check_json_string(const char *in, size_t len, const char *expected, size_t exp_len) {
    ah_text_buf b;
    ah_text_buf_init(&b, 0);
    CHECK(ah_text_append_json_string(&b, in, len) == AH_OK);
    CHECK(b.len == exp_len && b.data != NULL && memcmp(b.data, expected, exp_len) == 0);
    if (b.len != exp_len || b.data == NULL || memcmp(b.data, expected, exp_len) != 0) {
        fprintf(stderr, "  obtido: %s\n", b.data != NULL ? b.data : "(nulo)");
    }
    ah_text_buf_free(&b);
}

static void test_json_escape(void) {
    /* Esperados gerados com o Node (JSON.stringify), ver test_core_json.c. */
    check_json_string(LIT(""), LIT("\"\""));
    check_json_string(NULL, 0, LIT("\"\""));
    /* U+2028/U+2029 saem crus no JSON.stringify. */
    check_json_string(LIT("\xE2\x80\xA8\xE2\x80\xA9"), LIT("\"\xE2\x80\xA8\xE2\x80\xA9\""));
    /* Controles, DEL cru, aspas, barra invertida e "/" cru. */
    check_json_string(LIT("\x01\x1F\x7F\b\f\n\r\t\"\\/"),
                      LIT("\"\\u0001\\u001f\x7F\\b\\f\\n\\r\\t\\\"\\\\/\""));
    /* NUL no meio vira \u0000. */
    check_json_string("a\0b", 3, LIT("\"a\\u0000b\""));
    check_json_string(LIT("\xC3\xA9\xF0\x9F\x98\x80"), LIT("\"\xC3\xA9\xF0\x9F\x98\x80\""));
    /* Bytes inválidos viram U+FFFD como no Buffer.toString('utf8') do Node:
     * node -e "Buffer.from([0x61,0xff,0x62,0xe2,0x82,0x63,0xf0,0x9f,0x98,
     *          0xed,0xa0,0x80,0x64]).toString()" -> "a�b�c" + 4x U+FFFD + "d". */
    check_json_string(LIT("a\xFF" "b\xE2\x82" "c\xF0\x9F\x98\xED\xA0\x80" "d"),
                      LIT("\"a\xEF\xBF\xBD" "b\xEF\xBF\xBD" "c\xEF\xBF\xBD\xEF\xBF\xBD"
                          "\xEF\xBF\xBD\xEF\xBF\xBD" "d\""));
}

int main(void) {
    test_valid();
    test_count();
    test_cut();
    test_buf_limit();
    test_json_escape();
    return AH_TEST_END("test_core_text");
}
