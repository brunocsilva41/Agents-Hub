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

int main(void) {
    test_version_regex();
    test_caseless();
    test_groups();
    test_invalid_pattern();
    test_pathological_match_limit();
    test_depth_limit();
    return AH_TEST_END("test_core_regex");
}
