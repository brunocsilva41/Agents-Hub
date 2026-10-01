/* F0-10: regex PCRE2 com flag i e captura (SPEC-04 B2/A6) e limites de
 * casamento (SPEC-08 C3 / SEC-R37). */
#include <string.h>

#include "ah_regex.h"
#include "ah_test.h"

#define LIT(s) (s), (sizeof(s) - 1)

/* detect.versionRegex de manifests/claude.yaml depois do YAML:
 * versionRegex: "(\\d+\\.\\d+\\.\\d+)"  ->  (\d+\.\d+\.\d+) */
static const char VERSION_REGEX[] = "(\\d+\\.\\d+\\.\\d+)";

static void test_version_regex(void) {
    ah_regex *re = NULL;
    ah_regex_span g[3];
    bool m = false;
    static const char out[] = "2.1.283 (Claude Code)\n";

    CHECK(ah_regex_compile(LIT(VERSION_REGEX), AH_REGEX_CASELESS, NULL, &re, NULL, 0) == AH_OK);
    CHECK(ah_regex_group_count(re) == 1);
    CHECK(ah_regex_match(re, LIT(out), &m, g, 3) == AH_OK);
    CHECK(m);
    CHECK(g[0].matched && g[0].start == 0 && g[0].end == 7);
    CHECK(g[1].matched && g[1].start == 0 && g[1].end == 7);
    CHECK(memcmp(out + g[1].start, "2.1.283", 7) == 0);
    CHECK(!g[2].matched); /* grupo que não existe no padrão */

    CHECK(ah_regex_match(re, LIT("claude version v10.20.3-beta"), &m, g, 2) == AH_OK);
    CHECK(m && g[1].start == 16 && g[1].end == 23);

    CHECK(ah_regex_match(re, LIT("sem versao"), &m, g, 2) == AH_OK);
    CHECK(!m && !g[0].matched);

    /* UTF-8 inválido no texto (stderr de CLI) não é erro nem UB. */
    CHECK(ah_regex_match(re, LIT("\xFF\xFE 1.2.3"), &m, g, 2) == AH_OK);
    CHECK(m && g[1].start == 3 && g[1].end == 8);

    /* Só o booleano, sem grupos. */
    CHECK(ah_regex_match(re, LIT("0.0.1"), &m, NULL, 0) == AH_OK && m);
    ah_regex_free(re);
}

static void test_caseless(void) {
    ah_regex *re = NULL;
    bool m = false;
    /* session.nativeSessionMissing de manifests/claude.yaml, compilado com i. */
    CHECK(ah_regex_compile(LIT("No conversation found with session ID"), AH_REGEX_CASELESS, NULL,
                           &re, NULL, 0) == AH_OK);
    CHECK(ah_regex_match(re, LIT("Error: no CONVERSATION found with Session id abc"), &m, NULL,
                         0) == AH_OK);
    CHECK(m);
    ah_regex_free(re);

    /* Sem a flag, maiúsculas importam. */
    CHECK(ah_regex_compile(LIT("No conversation"), 0, NULL, &re, NULL, 0) == AH_OK);
    CHECK(ah_regex_match(re, LIT("no conversation"), &m, NULL, 0) == AH_OK);
    CHECK(!m);
    ah_regex_free(re);

    /* Fora do ASCII, a flag i também vale (modo UTF). */
    CHECK(ah_regex_compile(LIT("\xC3\x89RRO"), AH_REGEX_CASELESS, NULL, &re, NULL, 0) == AH_OK);
    CHECK(ah_regex_match(re, LIT("\xC3\xA9rro"), &m, NULL, 0) == AH_OK);
    CHECK(m);
    ah_regex_free(re);
}

static void test_groups(void) {
    ah_regex *re = NULL;
    ah_regex_span g[3];
    bool m = false;
    CHECK(ah_regex_compile(LIT("(a)|(b)"), 0, NULL, &re, NULL, 0) == AH_OK);
    CHECK(ah_regex_match(re, LIT("xb"), &m, g, 3) == AH_OK);
    CHECK(m && !g[1].matched && g[2].matched && g[2].start == 1 && g[2].end == 2);
    ah_regex_free(re);
}

static void test_invalid_pattern(void) {
    ah_regex *re = NULL;
    char err[200];
    CHECK(ah_regex_compile(LIT("(abc"), 0, NULL, &re, err, sizeof err) == AH_ERR_INVALID);
    CHECK(re == NULL && err[0] != '\0');
    /* \C quebraria o modo UTF: proibido. */
    CHECK(ah_regex_compile(LIT("a\\Cb"), 0, NULL, &re, err, sizeof err) == AH_ERR_INVALID);
    CHECK(ah_regex_compile(LIT("x"), 0x80u, NULL, &re, NULL, 0) == AH_ERR_INVALID);
    ah_regex_free(NULL);
}

/* Retrocesso exponencial: (a+)+$ contra "aaaa...a!" sem casamento. Com os
 * limites padrão termina com AH_ERR_LIMIT em vez de travar a thread. */
static void test_pathological_match_limit(void) {
    ah_regex *re = NULL;
    char subject[41];
    bool m = true;

    memset(subject, 'a', 39);
    subject[39] = '!';
    subject[40] = '\0';
    CHECK(ah_regex_compile(LIT("(a+)+$"), 0, NULL, &re, NULL, 0) == AH_OK);
    CHECK(ah_regex_match(re, subject, 40, &m, NULL, 0) == AH_ERR_LIMIT);
    CHECK(!m);
    ah_regex_free(re);
}

/* Limite de profundidade: cada repetição de um grupo com captura empilha um
 * quadro de retrocesso; teto 50 contra 1000 repetições estoura. O padrão não
 * tem caractere obrigatório, para a PCRE2 não recusar antes de casar. */
static void test_depth_limit(void) {
    ah_regex *re = NULL;
    ah_regex_limits lim;
    char subject[1001];
    bool m = true;

    ah_regex_limits_default(&lim);
    lim.depth_limit = 50;
    memset(subject, 'a', 1000);
    subject[1000] = '\0';
    CHECK(ah_regex_compile(LIT("(a|b)*$"), 0, &lim, &re, NULL, 0) == AH_OK);
    CHECK(ah_regex_match(re, subject, 1000, &m, NULL, 0) == AH_ERR_LIMIT);
    CHECK(!m);
    ah_regex_free(re);

    /* O mesmo padrão com os limites padrão casa normalmente. */
    CHECK(ah_regex_compile(LIT("(a|b)*$"), 0, NULL, &re, NULL, 0) == AH_OK);
    CHECK(ah_regex_match(re, subject, 1000, &m, NULL, 0) == AH_OK);
    CHECK(m);
    ah_regex_free(re);
}

/* match_limit personalizado e baixo vale: o mesmo casamento que passa com o
 * padrão estoura com 100 (prova que o valor do chamador é aplicado). */
static void test_custom_match_limit(void) {
    ah_regex *re = NULL;
    ah_regex_limits lim;
    char subject[1001];
    bool m = false;

    memset(subject, 'a', 1000);
    subject[1000] = '\0';
    ah_regex_limits_default(&lim);
    lim.match_limit = 100;
    CHECK(ah_regex_compile(LIT("(a|b)*$"), 0, &lim, &re, NULL, 0) == AH_OK);
    CHECK(ah_regex_match(re, subject, 1000, &m, NULL, 0) == AH_ERR_LIMIT);
    CHECK(!m);
    ah_regex_free(re);
}

/* Orçamento da chamada inteira (SEC-R37). Caso da revisão: retrocesso
 * moderado em CADA posição inicial, nenhum limite da PCRE2 estoura por
 * posição, e 16.000 posições levavam 244 s até AH_OK. Com o orçamento total
 * (callouts somados em todas as posições) termina com AH_ERR_LIMIT. */
static void test_total_budget(void) {
    static const char pat[] = "(?:a|aa){0,7}(?:a|aa){0,7}c|zz";
    static char subject[16001];
    ah_regex *re = NULL;
    ah_regex_limits lim;
    bool m = true;

    memset(subject, 'a', 16000);
    subject[16000] = '\0';
    CHECK(ah_regex_compile(LIT(pat), 0, NULL, &re, NULL, 0) == AH_OK);
    CHECK(ah_regex_match(re, subject, 16000, &m, NULL, 0) == AH_ERR_LIMIT);
    CHECK(!m);
    /* Texto curto: cabe no orçamento padrão e termina sem casar. */
    CHECK(ah_regex_match(re, subject, 20, &m, NULL, 0) == AH_OK);
    CHECK(!m);
    ah_regex_free(re);

    /* total_limit personalizado e baixo: o mesmo texto curto estoura. */
    ah_regex_limits_default(&lim);
    lim.total_limit = 100;
    CHECK(ah_regex_compile(LIT(pat), 0, &lim, &re, NULL, 0) == AH_OK);
    CHECK(ah_regex_match(re, subject, 20, &m, NULL, 0) == AH_ERR_LIMIT);
    ah_regex_free(re);
}

typedef struct dialect_case {
    const char *pattern;
    size_t pattern_len;
    unsigned flags;
    const char *subject;
    size_t subject_len;
    bool js; /* new RegExp(pattern, flags).test(subject) no Node v24.14.0 */
} dialect_case;

#define DC(p, f, s, r) {(p), sizeof(p) - 1, (f), (s), sizeof(s) - 1, (r)}

/* Dialeto igual ao RegExp do JS sem a flag u, nos pontos que a PCRE2 10.49
 * resolve (ver ah_regex.h). Os esperados vêm do Node (script de referência
 * citado no relatório). */
static void test_js_dialect(void) {
    static const dialect_case cases[] = {
        DC("abc$", 0, "abc\n", false),           /* PCRE2_DOLLAR_ENDONLY */
        DC("abc$", 0, "abc", true),
        DC("^\\u0041$", 0, "A", true),           /* PCRE2_ALT_BSUX */
        DC("^\\x41$", 0, "A", true),
        DC("^\\u{2}$", 0, "uu", true),           /* sem EXTRA_ALT_BSUX: u{2} */
        DC("^\\U$", 0, "U", true),
        DC("^[^]$", 0, "\n", true),              /* PCRE2_ALLOW_EMPTY_CLASS */
        DC("[]", 0, "a", false),
        DC("s", AH_REGEX_CASELESS, "\xC5\xBF", false),     /* ſ: CASELESS_RESTRICT */
        DC("k", AH_REGEX_CASELESS, "\xE2\x84\xAA", false), /* sinal Kelvin */
        DC("\xC3\xA9", AH_REGEX_CASELESS, "\xC3\x89", true),
        DC("^.$", 0, "\n", false),               /* newline ANYCRLF */
        DC("^.$", 0, "\r", false),
        DC("^.$", 0, "\v", true),
        DC("^.$", 0, "\xC2\x85", true),          /* NEL */
    };
    size_t i;

    for (i = 0; i < sizeof cases / sizeof cases[0]; i++) {
        ah_regex *re = NULL;
        bool m = !cases[i].js;
        char err[160];
        ah_status st = ah_regex_compile(cases[i].pattern, cases[i].pattern_len, cases[i].flags,
                                        NULL, &re, err, sizeof err);
        CHECK(st == AH_OK);
        if (st != AH_OK) {
            fprintf(stderr, "  caso %zu (%s): %s\n", i, cases[i].pattern, err);
            continue;
        }
        CHECK(ah_regex_match(re, cases[i].subject, cases[i].subject_len, &m, NULL, 0) == AH_OK);
        CHECK(m == cases[i].js);
        if (m != cases[i].js) {
            fprintf(stderr, "  caso %zu (%s): obtido %d, JS %d\n", i, cases[i].pattern, (int)m,
                    (int)cases[i].js);
        }
        ah_regex_free(re);
    }
}

/* Diferenças de dialeto que a PCRE2 10.49 não resolve (documentadas em
 * ah_regex.h). O teste fixa o comportamento atual para que uma mudança
 * apareça; o valor do JS está no comentário. */
static void test_js_dialect_known_gaps(void) {
    ah_regex *re = NULL;
    bool m = false;

    CHECK(ah_regex_compile(LIT("^.$"), 0, NULL, &re, NULL, 0) == AH_OK);
    CHECK(ah_regex_match(re, LIT("\xE2\x80\xA8"), &m, NULL, 0) == AH_OK && m);     /* JS: false */
    CHECK(ah_regex_match(re, LIT("\xF0\x9F\x98\x80"), &m, NULL, 0) == AH_OK && m); /* JS: false */
    ah_regex_free(re);
    CHECK(ah_regex_compile(LIT("^\\s$"), 0, NULL, &re, NULL, 0) == AH_OK);
    CHECK(ah_regex_match(re, LIT("\xC2\xA0"), &m, NULL, 0) == AH_OK && !m);        /* JS: true */
    ah_regex_free(re);
    CHECK(ah_regex_compile(LIT("a++"), 0, NULL, &re, NULL, 0) == AH_OK); /* JS: SyntaxError */
    ah_regex_free(re);
}

int main(void) {
    test_version_regex();
    test_caseless();
    test_groups();
    test_invalid_pattern();
    test_pathological_match_limit();
    test_depth_limit();
    test_custom_match_limit();
    test_total_budget();
    test_js_dialect();
    test_js_dialect_known_gaps();
    return AH_TEST_END("test_core_regex");
}
