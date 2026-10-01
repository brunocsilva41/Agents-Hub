/* F1-01: semântica Unicode do JS usada pelo objectiveHash — `\s`/`trim()` e
 * `String.prototype.toLowerCase()` (com Final_Sigma). Valores esperados
 * obtidos com `s.toLowerCase()` no Node 24.14.0 (o runtime da geração do
 * corpus, native/tests/conformance/domain/README.md). */
#include <string.h>

#include "ah_test.h"
#include "ah_text.h"
#include "ah_unicode.h"

static void test_js_space(void) {
    /* /\s/u no Node 24.14.0: exatamente estes 25 code points. */
    static const unsigned spaces[] = {
        0x0009, 0x000A, 0x000B, 0x000C, 0x000D, 0x0020, 0x00A0, 0x1680, 0x2000,
        0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009,
        0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF,
    };
    unsigned cp;
    size_t i = 0;
    unsigned count = 0;

    for (cp = 0; cp <= 0x10FFFF; cp++) {
        if (ah_unicode_is_js_space(cp)) {
            count++;
            CHECK(i < sizeof spaces / sizeof spaces[0] && spaces[i] == cp);
            i++;
        }
    }
    CHECK(count == 25);
    /* U+180E deixou de ser espaço no Unicode 6.3; U+200B nunca foi \s. */
    CHECK(!ah_unicode_is_js_space(0x180E));
    CHECK(!ah_unicode_is_js_space(0x200B));
    CHECK(!ah_unicode_is_js_space(0x0085));
}

static int lower_is(const char *in, const char *expect) {
    ah_text_buf b;
    int ok;

    ah_text_buf_init(&b, 0);
    ok = ah_unicode_append_lower(&b, in, strlen(in)) == AH_OK && b.data != NULL &&
         b.len == strlen(expect) && memcmp(b.data, expect, b.len) == 0;
    if (!ok) {
        fprintf(stderr, "  toLowerCase(\"%s\") deu \"%s\"\n", in, b.data ? b.data : "(nulo)");
    }
    ah_text_buf_free(&b);
    return ok;
}

static void test_lower_vectors(void) {
    /* {entrada, s.toLowerCase()} — Node 24.14.0 (Unicode 17.0, ICU 78.2). */
    static const char *const cases[][2] = {
        {"ABC", "abc"},
        /* Final_Sigma: Σ vira ς só com letra Cased antes e nenhuma depois,
         * pulando Case_Ignorable dos dois lados (mesmo se também Cased). */
        {"\xce\xa3\xce\x91\xce\xa3", "\xcf\x83\xce\xb1\xcf\x82"},
        {"\xce\xa3", "\xcf\x83"},
        {"A\xce\xa3", "a\xcf\x82"},
        {"A\xce\xa3" "B", "a\xcf\x83" "b"},
        {"A\xce\xa3 B", "a\xcf\x82 b"},
        {"A'\xce\xa3", "a'\xcf\x82"},
        {"A\xce\xa3'", "a\xcf\x82'"},
        {"A\xce\xa3'B", "a\xcf\x83'b"},
        {"A\xcd\x85\xce\xa3", "a\xcd\x85\xcf\x82"},
        {"A\xce\xa3\xcd\x85", "a\xcf\x82\xcd\x85"},
        {"A\xce\xa3\xcd\x85" "B", "a\xcf\x83\xcd\x85" "b"},
        {"1\xce\xa3", "1\xcf\x83"},
        {"\xca\xb0\xce\xa3", "\xca\xb0\xcf\x83"}, /* ʰ é Cased e Case_Ignorable */
        {"\xce\xa3\xce\xa3", "\xcf\x83\xcf\x82"},
        {"A\xce\xa3\xce\xa3", "a\xcf\x83\xcf\x82"},
        {"A\xce\xa3.\xce\xa3", "a\xcf\x83.\xcf\x82"},
        {"\xce\x8c\xce\xa3\xce\x9f\xce\xa3", "\xcf\x8c\xcf\x83\xce\xbf\xcf\x82"},
        {"\xce\x9f\xce\x94\xce\x9f\xce\xa3", "\xce\xbf\xce\xb4\xce\xbf\xcf\x82"},
        {"\xce\x9f\xce\x94\xce\x9f\xce\xa3!", "\xce\xbf\xce\xb4\xce\xbf\xcf\x82!"},
        /* SpecialCasing incondicional: İ → i + U+0307. */
        {"\xc4\xb0", "i\xcc\x87"},
        {"I\xc4\xb0", "ii\xcc\x87"},
        /* Mapeamentos simples, inclusive fora do BMP e do Unicode 16/17. */
        {"\xe1\xba\x9e", "\xc3\x9f"},             /* ẞ → ß */
        {"\xce\xa9", "\xcf\x89"},                 /* Ω */
        {"\xe2\x84\xaa", "k"},                    /* U+212A KELVIN SIGN */
        {"\xc3\x85", "\xc3\xa5"},                 /* Å */
        {"\xc7\x85", "\xc7\x86"},                 /* ǅ (titlecase) */
        {"\xe2\x85\xab", "\xe2\x85\xbb"},         /* Ⅻ */
        {"\xe2\x92\xb6", "\xe2\x93\x90"},         /* Ⓐ */
        {"\xf0\x90\x90\x80", "\xf0\x90\x90\xa8"}, /* 𐐀 */
        {"\xf0\x9e\xa4\x80", "\xf0\x9e\xa4\xa2"}, /* 𞤀 */
        {"\xea\x9f\x8b\xea\x9f\x8c", "\xc9\xa4\xea\x9f\x8d"},
        {"\xc4\xb2\xc5\x92", "\xc4\xb3\xc5\x93"},
        /* ß e minúsculas ficam; ASCII não-letra fica. */
        {"stra\xc3\x9f" "e 123 [x]", "stra\xc3\x9f" "e 123 [x]"},
    };
    size_t i;

    for (i = 0; i < sizeof cases / sizeof cases[0]; i++) {
        CHECK(lower_is(cases[i][0], cases[i][1]));
    }
    /* Ω de 3 bytes (U+2126 OHM SIGN) vira ω de 2: o texto pode encolher. */
    CHECK(lower_is("\xe2\x84\xa6", "\xcf\x89"));
}

static void test_lower_errors(void) {
    ah_text_buf b;

    ah_text_buf_init(&b, 0);
    CHECK(ah_unicode_append_lower(&b, "\xff", 1) == AH_ERR_INVALID);
    CHECK(ah_unicode_append_lower(&b, "\xed\xa0\x80", 3) == AH_ERR_INVALID); /* surrogate */
    CHECK(ah_unicode_append_lower(NULL, "a", 1) == AH_ERR_INVALID);
    CHECK(ah_unicode_append_lower(&b, NULL, 1) == AH_ERR_INVALID);
    CHECK(b.len == 0);
    CHECK(ah_unicode_append_lower(&b, NULL, 0) == AH_OK);
    /* NUL no meio é U+0000 e passa. */
    CHECK(ah_unicode_append_lower(&b, "A\0B", 3) == AH_OK);
    CHECK(b.len == 3 && memcmp(b.data, "a\0b", 3) == 0);
    ah_text_buf_free(&b);

    /* Teto do buffer repassado. */
    ah_text_buf_init(&b, 2);
    CHECK(ah_unicode_append_lower(&b, "\xc4\xb0", 2) == AH_ERR_LIMIT);
    ah_text_buf_free(&b);
}

static void test_append_cp_and_next(void) {
    static const unsigned cps[] = {0x0, 0x7F, 0x80, 0x7FF, 0x800, 0xFFFF, 0x10000, 0x10FFFF};
    ah_text_buf b;
    size_t i;
    size_t pos = 0;

    ah_text_buf_init(&b, 0);
    for (i = 0; i < sizeof cps / sizeof cps[0]; i++) {
        CHECK(ah_unicode_append_cp(&b, cps[i]) == AH_OK);
    }
    CHECK(ah_text_utf8_valid(b.data, b.len));
    CHECK(b.len == 1 + 1 + 2 + 2 + 3 + 3 + 4 + 4);
    for (i = 0; i < sizeof cps / sizeof cps[0]; i++) {
        CHECK(ah_unicode_next(b.data, b.len, &pos) == cps[i]);
    }
    CHECK(pos == b.len);
    CHECK(ah_unicode_append_cp(&b, 0xD800) == AH_ERR_INVALID);
    CHECK(ah_unicode_append_cp(&b, 0x110000) == AH_ERR_INVALID);
    ah_text_buf_free(&b);
}

int main(void) {
    test_js_space();
    test_lower_vectors();
    test_lower_errors();
    test_append_cp_and_next();
    return AH_TEST_END("test_core_unicode");
}
