/* F0-10: YAML com escalares como texto (ADR 08) e tetos (SPEC-08 C2 / SEC-R36).
 *
 * O manifesto real manifests/claude.yaml entra pelo cabeçalho gerado
 * claude_manifest.h (bytes do arquivo, gerados pelo CMake na configuração),
 * para o teste não depender de I/O. */
#include <string.h>
#include <time.h>

#include "ah_test.h"
#include "ah_yaml.h"
#include "claude_manifest.h"

#define LIT(s) (s), (sizeof(s) - 1)

static const ah_yaml_node *path2(const ah_yaml_node *root, const char *a, const char *b) {
    return ah_yaml_map_get(ah_yaml_map_get(root, a), b);
}

/* Escalar `n` com texto `text` e estilo `style`. */
static int scalar_is(const ah_yaml_node *n, const char *text, ah_yaml_style style) {
    size_t len = 0;
    const char *s = ah_yaml_scalar(n, &len);
    return s != NULL && len == strlen(text) && memcmp(s, text, len) == 0 &&
           ah_yaml_scalar_style(n) == style;
}

static void test_real_manifest(void) {
    ah_yaml_doc *doc = NULL;
    char err[256];
    const ah_yaml_node *root;
    const ah_yaml_node *caps;
    ah_status st;

    st = ah_yaml_load((const char *)ah_claude_yaml, ah_claude_yaml_len, NULL, &doc, err,
                      sizeof err);
    CHECK(st == AH_OK);
    if (st != AH_OK) {
        fprintf(stderr, "  %s\n", err);
        return;
    }
    root = ah_yaml_root(doc);
    CHECK(root != NULL && ah_yaml_node_kind(root) == AH_YAML_MAPPING);
    CHECK(scalar_is(ah_yaml_map_get(root, "id"), "claude", AH_YAML_PLAIN));
    CHECK(scalar_is(ah_yaml_map_get(root, "bin"), "claude", AH_YAML_PLAIN));
    /* versionRegex: "(\\d+\\.\\d+\\.\\d+)" entre aspas duplas -> texto com uma barra. */
    CHECK(scalar_is(path2(root, "detect", "versionRegex"), "(\\d+\\.\\d+\\.\\d+)",
                    AH_YAML_DOUBLE_QUOTED));
    /* Booleanos e números chegam como texto plain; a tipagem é do Hub. */
    CHECK(scalar_is(path2(root, "invoke", "stdinPrompt"), "true", AH_YAML_PLAIN));
    CHECK(scalar_is(path2(root, "invoke", "interactive"), "false", AH_YAML_PLAIN));
    CHECK(scalar_is(path2(root, "defaults", "timeoutSeconds"), "1800", AH_YAML_PLAIN));
    CHECK(scalar_is(path2(root, "model", "supported"), "true", AH_YAML_PLAIN));
    CHECK(scalar_is(path2(root, "verified", "version"), "2.1.283", AH_YAML_DOUBLE_QUOTED));
    /* Coleções vazias em fluxo. */
    CHECK(ah_yaml_node_kind(path2(root, "invoke", "env")) == AH_YAML_MAPPING);
    CHECK(ah_yaml_count(path2(root, "invoke", "env")) == 0);
    CHECK(ah_yaml_node_kind(path2(root, "invoke", "extraArgs")) == AH_YAML_SEQUENCE);
    /* Sequência de fluxo e de bloco. */
    CHECK(ah_yaml_count(path2(root, "invoke", "oneShot")) == 4);
    CHECK(scalar_is(ah_yaml_seq_at(path2(root, "invoke", "oneShot"), 3), "--verbose",
                    AH_YAML_DOUBLE_QUOTED));
    caps = ah_yaml_map_get(root, "capabilities");
    CHECK(ah_yaml_count(caps) == 8);
    CHECK(scalar_is(ah_yaml_seq_at(caps, 0), "code-edit", AH_YAML_PLAIN));
    CHECK(scalar_is(ah_yaml_seq_at(caps, 7), "long-context", AH_YAML_PLAIN));
    CHECK(ah_yaml_seq_at(caps, 8) == NULL);
    /* description: bloco dobrado (>). */
    CHECK(ah_yaml_scalar_style(ah_yaml_map_get(root, "description")) == AH_YAML_FOLDED);
    CHECK(scalar_is(path2(root, "session", "strategy"), "native", AH_YAML_PLAIN));
    CHECK(ah_yaml_count(path2(root, "session", "nativeSessionMissing")) == 1);
    ah_yaml_free(doc);
}

static void test_scalars_are_text(void) {
    ah_yaml_doc *doc = NULL;
    const ah_yaml_node *r;
    static const char y[] = "a: yes\n"
                            "b: no\n"
                            "c: 010\n"
                            "d: 1.5\n"
                            "e: ~\n"
                            "f:\n"
                            "g: 'yes'\n"
                            "h: !!int 7\n"
                            "i: \"\"\n"
                            "j: \"a\\0b\"\n";
    size_t len = 0;

    CHECK(ah_yaml_load(LIT(y), NULL, &doc, NULL, 0) == AH_OK);
    r = ah_yaml_root(doc);
    CHECK(scalar_is(ah_yaml_map_get(r, "a"), "yes", AH_YAML_PLAIN));
    CHECK(scalar_is(ah_yaml_map_get(r, "b"), "no", AH_YAML_PLAIN));
    CHECK(scalar_is(ah_yaml_map_get(r, "c"), "010", AH_YAML_PLAIN));
    CHECK(scalar_is(ah_yaml_map_get(r, "d"), "1.5", AH_YAML_PLAIN));
    CHECK(scalar_is(ah_yaml_map_get(r, "e"), "~", AH_YAML_PLAIN));
    CHECK(scalar_is(ah_yaml_map_get(r, "f"), "", AH_YAML_PLAIN));
    CHECK(scalar_is(ah_yaml_map_get(r, "g"), "yes", AH_YAML_SINGLE_QUOTED));
    CHECK(scalar_is(ah_yaml_map_get(r, "h"), "7", AH_YAML_PLAIN));
    CHECK(ah_yaml_tag(ah_yaml_map_get(r, "h")) != NULL &&
          strcmp(ah_yaml_tag(ah_yaml_map_get(r, "h")), "tag:yaml.org,2002:int") == 0);
    CHECK(ah_yaml_tag(ah_yaml_map_get(r, "a")) == NULL);
    CHECK(scalar_is(ah_yaml_map_get(r, "i"), "", AH_YAML_DOUBLE_QUOTED));
    /* "\0" no YAML: NUL dentro do texto, tamanho preservado. */
    CHECK(ah_yaml_scalar(ah_yaml_map_get(r, "j"), &len) != NULL && len == 3);
    CHECK(scalar_is(ah_yaml_map_key_at(r, 0), "a", AH_YAML_PLAIN));
    CHECK(ah_yaml_map_value_at(r, 10) == NULL);
    ah_yaml_free(doc);
}

static void test_alias_shares_node(void) {
    ah_yaml_doc *doc = NULL;
    const ah_yaml_node *r;
    CHECK(ah_yaml_load(LIT("x: &x {k: v}\ny: *x\nz: &s txt\nw: *s\n"), NULL, &doc, NULL, 0) ==
          AH_OK);
    r = ah_yaml_root(doc);
    CHECK(ah_yaml_map_get(r, "x") != NULL && ah_yaml_map_get(r, "x") == ah_yaml_map_get(r, "y"));
    CHECK(scalar_is(path2(r, "y", "k"), "v", AH_YAML_PLAIN));
    CHECK(scalar_is(ah_yaml_map_get(r, "w"), "txt", AH_YAML_PLAIN));
    ah_yaml_free(doc);
}

/* "Billion laughs": 9 níveis, cada um com 9 aliases do anterior; expandido
 * daria ~4,3e8 nós. Tem de ser recusado rápido (SEC-R36: < 100 ms). */
static void test_billion_laughs(void) {
    static const char y[] =
        "a: &a [\"lol\",\"lol\",\"lol\",\"lol\",\"lol\",\"lol\",\"lol\",\"lol\",\"lol\"]\n"
        "b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\n"
        "c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]\n"
        "d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]\n"
        "e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]\n"
        "f: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]\n"
        "g: &g [*f,*f,*f,*f,*f,*f,*f,*f,*f]\n"
        "h: &h [*g,*g,*g,*g,*g,*g,*g,*g,*g]\n"
        "i: &i [*h,*h,*h,*h,*h,*h,*h,*h,*h]\n";
    ah_yaml_doc *doc = NULL;
    ah_yaml_limits lim;
    char err[128];
    clock_t t0 = clock();
    clock_t t1;
    double ms;

    CHECK(ah_yaml_load(LIT(y), NULL, &doc, err, sizeof err) == AH_ERR_LIMIT && doc == NULL);
    CHECK(strstr(err, "expandidos") != NULL);
    t1 = clock();
    ms = (double)(t1 - t0) * 1000.0 / CLOCKS_PER_SEC;
    CHECK(ms < 100.0);
    if (ms >= 100.0) {
        fprintf(stderr, "  billion laughs levou %.1f ms\n", ms);
    }

    /* Teto de aliases separado do teto de nós. */
    ah_yaml_limits_default(&lim);
    lim.max_aliases = 5;
    CHECK(ah_yaml_load(LIT(y), &lim, &doc, err, sizeof err) == AH_ERR_LIMIT && doc == NULL);
    CHECK(strstr(err, "aliases") != NULL);
}

static void test_depth(void) {
    char buf[2 * 70 + 1];
    ah_yaml_doc *doc = NULL;
    ah_yaml_limits lim;
    size_t d;

    d = AH_YAML_DEFAULT_MAX_DEPTH;
    memset(buf, '[', d);
    memset(buf + d, ']', d);
    CHECK(ah_yaml_load(buf, 2 * d, NULL, &doc, NULL, 0) == AH_OK);
    ah_yaml_free(doc);
    doc = NULL;

    d = AH_YAML_DEFAULT_MAX_DEPTH + 1;
    memset(buf, '[', d);
    memset(buf + d, ']', d);
    CHECK(ah_yaml_load(buf, 2 * d, NULL, &doc, NULL, 0) == AH_ERR_LIMIT && doc == NULL);

    /* Profundidade via alias: a âncora tem 3 níveis (seq, seq, escalar) e
     * cabe no teto 4 onde foi definida; o alias dentro de b: [[...]] fica sob
     * 3 coleções abertas, e a expansão chegaria a 6 níveis. */
    ah_yaml_limits_default(&lim);
    lim.max_depth = 4;
    CHECK(ah_yaml_load(LIT("a: &a [[x]]\n"), &lim, &doc, NULL, 0) == AH_OK);
    ah_yaml_free(doc);
    CHECK(ah_yaml_load(LIT("a: &a [[x]]\nb: [[*a]]\n"), &lim, &doc, NULL, 0) == AH_ERR_LIMIT);
}

static void test_size_and_invalid(void) {
    ah_yaml_doc *doc = NULL;
    ah_yaml_limits lim;
    char err[256];

    ah_yaml_limits_default(&lim);
    lim.max_bytes = 8;
    CHECK(ah_yaml_load(LIT("chave: valor\n"), &lim, &doc, err, sizeof err) == AH_ERR_LIMIT);
    CHECK(strstr(err, "tamanho") != NULL);

    CHECK(ah_yaml_load(LIT("a: [1, 2\n"), NULL, &doc, err, sizeof err) == AH_ERR_INVALID);
    CHECK(err[0] != '\0');
    CHECK(ah_yaml_load(LIT("a: 1\n---\nb: 2\n"), NULL, &doc, NULL, 0) == AH_ERR_INVALID);
    CHECK(ah_yaml_load(LIT("a: *nada\n"), NULL, &doc, NULL, 0) == AH_ERR_INVALID);
    /* Alias para a coleção ainda aberta (ciclo). */
    CHECK(ah_yaml_load(LIT("a: &a [*a]\n"), NULL, &doc, NULL, 0) == AH_ERR_INVALID);
    CHECK(ah_yaml_load(LIT("? [k]\n: v\n"), NULL, &doc, NULL, 0) == AH_ERR_INVALID);
    CHECK(ah_yaml_load(LIT("a: \xFF\n"), NULL, &doc, NULL, 0) == AH_ERR_INVALID);
    CHECK(doc == NULL);

    /* Documento vazio: raiz NULL. */
    CHECK(ah_yaml_load(LIT("# so comentario\n"), NULL, &doc, NULL, 0) == AH_OK);
    CHECK(doc != NULL && ah_yaml_root(doc) == NULL);
    ah_yaml_free(doc);
    CHECK(ah_yaml_load(NULL, 0, NULL, &doc, NULL, 0) == AH_OK);
    ah_yaml_free(doc);
    ah_yaml_free(NULL);
}

int main(void) {
    test_real_manifest();
    test_scalars_are_text();
    test_alias_shares_node();
    test_billion_laughs();
    test_depth();
    test_size_and_invalid();
    return AH_TEST_END("test_core_yaml");
}
