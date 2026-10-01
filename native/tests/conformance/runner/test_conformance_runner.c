/* Autoverificação do runner de conformidade (F0-11).
 *
 * Usa só o corpus de exemplo do próprio runner (exemplo/verde.jsonl e
 * exemplo/misto.jsonl) e arquivos gerados no diretório de build; nunca o
 * corpus real do TS.
 *
 * Uso: test_conformance_runner <dir de exemplo/> <dir temporário do build> */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ah_conformance.h"
#include "ah_test.h"
#include "exemplo_suite.h"

static const char *g_exemplo_dir;
static const char *g_tmp_dir;

/* ---------------------------------------------------------- utilitários */

typedef struct capture {
    char *text;
    size_t len;
    size_t cap;
} capture;

static void capture_sink(void *ctx, const char *line) {
    capture *c = ctx;
    size_t n = strlen(line);
    if (c->len + n + 2 > c->cap) {
        size_t ncap = (c->cap == 0 ? 4096 : c->cap * 2) + n;
        char *nt = realloc(c->text, ncap);
        if (nt == NULL) {
            return;
        }
        c->text = nt;
        c->cap = ncap;
    }
    memcpy(c->text + c->len, line, n);
    c->len += n;
    c->text[c->len++] = '\n';
    c->text[c->len] = '\0';
}

static void capture_free(capture *c) {
    free(c->text);
    memset(c, 0, sizeof *c);
}

static int has(const capture *c, const char *needle) {
    if (c->text == NULL || strstr(c->text, needle) == NULL) {
        fprintf(stderr, "  saída não contém: %s\n", needle);
        return 0;
    }
    return 1;
}

static void join(char *out, size_t cap, const char *dir, const char *name) {
    int n = snprintf(out, cap, "%s/%s", dir, name);
    if (n < 0 || (size_t)n >= cap) {
        out[0] = '\0';
    }
}

static FILE *open_write(const char *path) {
#if defined(_MSC_VER)
    FILE *f = NULL;
    if (fopen_s(&f, path, "wb") != 0) {
        return NULL;
    }
    return f;
#else
    return fopen(path, "wb");
#endif
}

static int write_file(const char *path, const char *data, size_t len) {
    FILE *f = open_write(path);
    int ok;
    if (f == NULL) {
        return 0;
    }
    ok = fwrite(data, 1, len, f) == len;
    ok = (fclose(f) == 0) && ok;
    return ok;
}

static ah_status run(const char *path, const ah_conformance_suite *suite, capture *cap,
                     ah_conformance_report *rep) {
    return ah_conformance_run_file(path, suite, capture_sink, cap, rep);
}

/* ---------------------------------------------------------- casos */

static void test_misto(void) {
    char path[1024];
    capture cap = {0};
    ah_conformance_report rep;
    ah_status st;

    join(path, sizeof path, g_exemplo_dir, "misto.jsonl");
    st = run(path, ah_conformance_exemplo_suite(), &cap, &rep);
    CHECK(st == AH_OK);
    CHECK(rep.cases == 12);
    CHECK(rep.passed == 8);
    CHECK(rep.failed == 3);
    CHECK(rep.skipped == 1);
    CHECK(rep.divergent == 8);
    CHECK(rep.divergent_without_dv == 2);
    CHECK(rep.overridden == 4);
    CHECK(rep.invalid_lines == 2);
    CHECK(rep.unused_decided == 0);
    CHECK(ah_conformance_exit_code(&rep) == 1);

    CHECK(has(&cap, "CORPUS  misto.jsonl (suite exemplo)"));
    CHECK(has(&cap, "PASSOU  misto.jsonl ex/passa-001\n"));
    CHECK(has(&cap, "FALHOU  misto.jsonl ex/falha-001: esperado 7, obtido 6\n"));
    CHECK(has(&cap, "PULADO  misto.jsonl ex/pula-001: o módulo de exemplo não cobre este caso\n"));
    CHECK(has(&cap, "PASSOU  misto.jsonl ex/div-en-001 [divergência DV-44]\n"));
    CHECK(has(&cap,
              "PASSOU  misto.jsonl ex/notas-001 [divergência DV-45: reproduz o TS (decidido)]\n"));
    CHECK(has(&cap, "PASSOU  misto.jsonl ex/corrigir-001 [divergência DV-09: esperado decidido "
                    "(corrigir)]\n"));
    CHECK(has(&cap, "PASSOU  misto.jsonl ex/lote-001 [divergência DV-08: esperado decidido "
                    "(corrigir)]\n"));
    CHECK(has(&cap, "PASSOU  misto.jsonl ex/lote-002 [divergência DV-08: esperado decidido "
                    "(corrigir)]\n"));
    CHECK(has(&cap, "FALHOU  misto.jsonl ex/lote-003: esperado 0, obtido 2 [divergência DV-08: "
                    "esperado decidido (corrigir)]\n"));
    CHECK(has(&cap, "PASSOU  misto.jsonl ex/div-pt-001 [divergência sem ID de DV: \"SPEC-04 A6: "
                    "exemplo de marca sem ID de DV\"]\n"));
    /* Marca só no texto (mappers: `notes`), sem entrada na tabela nem DV no texto. */
    CHECK(has(&cap, "PASSOU  misto.jsonl ex/notas-sem-dv-001 [divergência sem ID de DV: "
                    "\"DIVERGÊNCIA CONHECIDA: exemplo sem entrada na tabela nem ID de DV no "
                    "texto\"]\n"));
    CHECK(has(&cap, "FALHOU  misto.jsonl linha 11: JSON inválido\n"));
    CHECK(has(&cap, "FALHOU  misto.jsonl linha 12: a linha não é um objeto JSON\n"));
    CHECK(has(&cap, "FALHOU  misto.jsonl linha 13: caso sem campo \"id\" (texto)\n"));
    CHECK(has(&cap, "RESUMO  misto.jsonl: 12 casos, 8 passaram, 3 falharam, 1 pulados; 8 com "
                    "divergência (4 com esperado decidido, 2 sem ID de DV); 2 linhas inválidas; "
                    "0 entradas da tabela sem uso\n"));
    capture_free(&cap);
}

static void test_verde(void) {
    char path[1024];
    capture cap = {0};
    ah_conformance_report rep;

    join(path, sizeof path, g_exemplo_dir, "verde.jsonl");
    CHECK(run(path, ah_conformance_exemplo_suite(), &cap, &rep) == AH_OK);
    CHECK(rep.cases == 7);
    CHECK(rep.passed == 6);
    CHECK(rep.skipped == 1);
    CHECK(rep.failed == 0);
    CHECK(rep.divergent == 5);
    CHECK(rep.overridden == 3);
    CHECK(rep.divergent_without_dv == 0);
    CHECK(rep.invalid_lines == 0);
    CHECK(rep.unused_decided == 0);
    CHECK(ah_conformance_exit_code(&rep) == 0);
    capture_free(&cap);
}

/* Grava o que a função de teste recebeu, para provar a troca do esperado. */
typedef struct seen {
    double corrigir_esperado;
    size_t corrigir_line;
    int corrigir_overridden;
    int corrigir_dv09;
    int div_en_ok;
    int passa_ok;
    int notas_sem_dv_ok;
    int calls;
} seen;

static ah_conformance_verdict recording_case(const cJSON *caso,
                                             const ah_conformance_case_info *info, char *msg,
                                             size_t msg_cap, void *ctx) {
    seen *s = ctx;
    s->calls++;
    if (strcmp(info->id, "ex/corrigir-001") == 0) {
        const cJSON *e = cJSON_GetObjectItemCaseSensitive(caso, "esperado");
        s->corrigir_esperado = cJSON_IsNumber(e) ? e->valuedouble : -1.0;
        s->corrigir_line = info->line;
        s->corrigir_overridden = info->expected_overridden;
        s->corrigir_dv09 = info->dv_id != NULL && strcmp(info->dv_id, "DV-09") == 0 &&
                           info->divergence_marked == 1;
    } else if (strcmp(info->id, "ex/div-en-001") == 0) {
        s->div_en_ok = info->dv_id != NULL && strcmp(info->dv_id, "DV-44") == 0 &&
                       info->divergence_marked == 1 && info->expected_overridden == 0;
    } else if (strcmp(info->id, "ex/notas-sem-dv-001") == 0) {
        s->notas_sem_dv_ok = info->divergence_marked == 1 && info->dv_id == NULL &&
                             info->expected_overridden == 0 && info->line == 15;
    } else if (strcmp(info->id, "ex/passa-001") == 0) {
        s->passa_ok = info->dv_id == NULL && info->divergence_marked == 0 &&
                      info->expected_overridden == 0 && info->line == 1 &&
                      strcmp(info->corpus, "verde.jsonl") == 0;
    }
    return ah_conformance_exemplo_case(caso, info, msg, msg_cap, NULL);
}

static void test_case_receives_decided_expected(void) {
    char path[1024];
    capture cap = {0};
    ah_conformance_report rep;
    ah_conformance_suite suite = *ah_conformance_exemplo_suite();
    seen s;

    memset(&s, 0, sizeof s);
    suite.run_case = recording_case;
    suite.ctx = &s;
    join(path, sizeof path, g_exemplo_dir, "verde.jsonl");
    CHECK(run(path, &suite, &cap, &rep) == AH_OK);
    CHECK(s.calls == 7);
    CHECK(s.corrigir_esperado == 12.0); /* o corpus diz 13; a tabela decide 12 */
    CHECK(s.corrigir_line == 5);
    CHECK(s.corrigir_overridden == 1);
    CHECK(s.corrigir_dv09 == 1);
    CHECK(s.div_en_ok == 1);
    CHECK(s.passa_ok == 1);
    CHECK(s.notas_sem_dv_ok == 0); /* o caso não existe em verde.jsonl */

    /* misto.jsonl: marca DIVERGÊNCIA CONHECIDA sem tabela chega marcada e sem DV. */
    memset(&s, 0, sizeof s);
    join(path, sizeof path, g_exemplo_dir, "misto.jsonl");
    CHECK(run(path, &suite, &cap, &rep) == AH_OK);
    CHECK(s.notas_sem_dv_ok == 1);
    capture_free(&cap);
}

static void test_nul_byte_rejects_line(void) {
    /* Linha 1 tem um NUL depois do JSON válido: fgets+strlen veria só o JSON
     * e o caso passaria. A linha precisa ser recusada; a linha 2 segue. */
    static const char data[] = "{\"id\":\"n/1\",\"entrada\":1,\"esperado\":2}\0lixo\n"
                               "{\"id\":\"n/2\",\"entrada\":2,\"esperado\":4}\n";
    char path[1024];
    capture cap = {0};
    ah_conformance_report rep;
    ah_conformance_suite suite = {"zero", ah_conformance_exemplo_case, NULL, NULL, 0, 0};

    /* Não "nul.jsonl": NUL é nome de dispositivo reservado no Windows. */
    join(path, sizeof path, g_tmp_dir, "byte-zero.jsonl");
    CHECK(write_file(path, data, sizeof data - 1));
    CHECK(run(path, &suite, &cap, &rep) == AH_OK);
    CHECK(rep.invalid_lines == 1);
    CHECK(rep.cases == 1);
    CHECK(rep.passed == 1);
    CHECK(ah_conformance_exit_code(&rep) == 1);
    CHECK(has(&cap, "FALHOU  byte-zero.jsonl linha 1: a linha contém byte NUL\n"));
    CHECK(has(&cap, "PASSOU  byte-zero.jsonl n/2\n"));
    capture_free(&cap);
}

static void test_require_dv_id(void) {
    char path[1024];
    capture cap = {0};
    ah_conformance_report rep;
    ah_conformance_suite suite = *ah_conformance_exemplo_suite();

    suite.require_dv_id = 1;
    join(path, sizeof path, g_exemplo_dir, "misto.jsonl");
    CHECK(run(path, &suite, &cap, &rep) == AH_OK);
    CHECK(rep.failed == 5);
    CHECK(rep.passed == 6);
    CHECK(has(&cap, "FALHOU  misto.jsonl ex/div-pt-001: divergência sem ID de DV "
                    "(require_dv_id): registre o caso na tabela do módulo [divergência sem ID"));
    CHECK(has(&cap, "FALHOU  misto.jsonl ex/notas-sem-dv-001: divergência sem ID de DV "
                    "(require_dv_id): registre o caso na tabela do módulo [divergência sem ID"));
    capture_free(&cap);
}

static void test_unused_entry_fails(void) {
    static const ah_conformance_decided table[] = {
        {"ex/notas-001", "DV-45", AH_CONFORMANCE_DV_REPRODUCE, NULL},
        {"ex/corrigir-001", "DV-09", AH_CONFORMANCE_DV_CORRECT, "{\"esperado\":12}"},
        {"ex/lote-*", "DV-08", AH_CONFORMANCE_DV_CORRECT, "{\"esperado\":0}"},
        {"ex/nao-existe", "DV-01", AH_CONFORMANCE_DV_REPRODUCE, NULL},
    };
    char path[1024];
    capture cap = {0};
    ah_conformance_report rep;
    ah_conformance_suite suite = *ah_conformance_exemplo_suite();

    suite.decided = table;
    suite.decided_count = sizeof table / sizeof table[0];
    join(path, sizeof path, g_exemplo_dir, "verde.jsonl");
    CHECK(run(path, &suite, &cap, &rep) == AH_OK);
    CHECK(rep.failed == 0);
    CHECK(rep.unused_decided == 1);
    CHECK(ah_conformance_exit_code(&rep) == 1);
    CHECK(has(&cap, "FALHOU  verde.jsonl tabela: entrada \"ex/nao-existe\" (DV-01) não casou "
                    "caso algum"));
    capture_free(&cap);
}

static int g_calls_invalid;

static ah_conformance_verdict counting_case(const cJSON *caso,
                                            const ah_conformance_case_info *info, char *msg,
                                            size_t msg_cap, void *ctx) {
    (void)caso;
    (void)info;
    (void)msg;
    (void)msg_cap;
    (void)ctx;
    g_calls_invalid++;
    return AH_CONFORMANCE_PASS;
}

static void expect_invalid_table(const ah_conformance_decided *d, size_t n, const char *what) {
    char path[1024];
    capture cap = {0};
    ah_conformance_report rep;
    ah_conformance_suite suite = {"invalida", counting_case, NULL, d, n, 0};
    ah_status st;

    g_calls_invalid = 0;
    join(path, sizeof path, g_exemplo_dir, "verde.jsonl");
    st = run(path, &suite, &cap, &rep);
    if (st != AH_ERR_INVALID || g_calls_invalid != 0) {
        fprintf(stderr, "  tabela inválida aceita: %s\n", what);
    }
    CHECK(st == AH_ERR_INVALID);
    CHECK(g_calls_invalid == 0);
    CHECK(has(&cap, "ERRO tabela"));
    capture_free(&cap);
}

static void test_invalid_tables(void) {
    static const ah_conformance_decided correct_null[] = {
        {"ex/passa-001", "DV-09", AH_CONFORMANCE_DV_CORRECT, NULL}};
    static const ah_conformance_decided correct_array[] = {
        {"ex/passa-001", "DV-09", AH_CONFORMANCE_DV_CORRECT, "[1]"}};
    static const ah_conformance_decided correct_empty[] = {
        {"ex/passa-001", "DV-09", AH_CONFORMANCE_DV_CORRECT, "{}"}};
    static const ah_conformance_decided correct_broken[] = {
        {"ex/passa-001", "DV-09", AH_CONFORMANCE_DV_CORRECT, "{\"esperado\":"}};
    static const ah_conformance_decided reproduce_json[] = {
        {"ex/passa-001", "DV-09", AH_CONFORMANCE_DV_REPRODUCE, "{\"esperado\":4}"}};
    static const ah_conformance_decided dv_no_digits[] = {
        {"ex/passa-001", "DV-", AH_CONFORMANCE_DV_REPRODUCE, NULL}};
    static const ah_conformance_decided dv_no_prefix[] = {
        {"ex/passa-001", "44", AH_CONFORMANCE_DV_REPRODUCE, NULL}};
    static const ah_conformance_decided dv_null[] = {
        {"ex/passa-001", NULL, AH_CONFORMANCE_DV_REPRODUCE, NULL}};
    static const ah_conformance_decided star_middle[] = {
        {"ex/*-001", "DV-09", AH_CONFORMANCE_DV_REPRODUCE, NULL}};
    static const ah_conformance_decided star_only[] = {
        {"*", "DV-09", AH_CONFORMANCE_DV_REPRODUCE, NULL}};
    static const ah_conformance_decided id_empty[] = {
        {"", "DV-09", AH_CONFORMANCE_DV_REPRODUCE, NULL}};
    static const ah_conformance_decided duplicated[] = {
        {"ex/passa-001", "DV-09", AH_CONFORMANCE_DV_REPRODUCE, NULL},
        {"ex/passa-001", "DV-10", AH_CONFORMANCE_DV_REPRODUCE, NULL}};
    static const ah_conformance_decided bad_policy[] = {
        {"ex/passa-001", "DV-09", (ah_conformance_dv_policy)7, NULL}};

    expect_invalid_table(correct_null, 1, "CORRECT sem expected_json");
    expect_invalid_table(correct_array, 1, "CORRECT com array");
    expect_invalid_table(correct_empty, 1, "CORRECT com objeto vazio");
    expect_invalid_table(correct_broken, 1, "CORRECT com JSON quebrado");
    expect_invalid_table(reproduce_json, 1, "REPRODUCE com expected_json");
    expect_invalid_table(dv_no_digits, 1, "dv_id sem número");
    expect_invalid_table(dv_no_prefix, 1, "dv_id sem DV-");
    expect_invalid_table(dv_null, 1, "dv_id NULL");
    expect_invalid_table(star_middle, 1, "'*' no meio");
    expect_invalid_table(star_only, 1, "só '*'");
    expect_invalid_table(id_empty, 1, "case_id vazio");
    expect_invalid_table(duplicated, 2, "case_id repetido");
    expect_invalid_table(bad_policy, 1, "policy desconhecida");
    expect_invalid_table(NULL, 1, "decided NULL com contagem 1");
}

static void test_bad_arguments(void) {
    char path[1024];
    capture cap = {0};
    ah_conformance_report rep;
    ah_conformance_suite no_fn = {"x", NULL, NULL, NULL, 0, 0};

    join(path, sizeof path, g_exemplo_dir, "verde.jsonl");
    CHECK(run(path, &no_fn, &cap, &rep) == AH_ERR_INVALID);
    CHECK(run(NULL, ah_conformance_exemplo_suite(), &cap, &rep) == AH_ERR_INVALID);
    CHECK(run(path, NULL, &cap, &rep) == AH_ERR_INVALID);
    CHECK(ah_conformance_run_file(path, ah_conformance_exemplo_suite(), capture_sink, &cap,
                                  NULL) == AH_ERR_INVALID);
    CHECK(ah_conformance_exit_code(NULL) == 1);
    capture_free(&cap);
}

static void test_missing_file(void) {
    char path[1024];
    capture cap = {0};
    ah_conformance_report rep;

    join(path, sizeof path, g_tmp_dir, "nao-existe.jsonl");
    CHECK(run(path, ah_conformance_exemplo_suite(), &cap, &rep) == AH_ERR_IO);
    CHECK(rep.cases == 0);
    CHECK(has(&cap, "ERRO: não abriu o corpus"));
    capture_free(&cap);
}

static void test_crlf_bom_no_final_newline_and_added_key(void) {
    static const ah_conformance_decided table[] = {
        {"g/sem-esperado", "DV-12", AH_CONFORMANCE_DV_CORRECT, "{\"esperado\":6}"}};
    /* BOM, CRLF, linha só com espaços e última linha sem '\n'. */
    static const char data[] = "\xEF\xBB\xBF{\"id\":\"g/crlf\",\"entrada\":1,\"esperado\":2}\r\n"
                               "  \t \r\n"
                               "{\"id\":\"g/sem-esperado\",\"entrada\":3}";
    char path[1024];
    capture cap = {0};
    ah_conformance_report rep;
    ah_conformance_suite suite = {"gerado", ah_conformance_exemplo_case, NULL, table, 1, 0};

    join(path, sizeof path, g_tmp_dir, "crlf-bom.jsonl");
    CHECK(write_file(path, data, sizeof data - 1));
    CHECK(run(path, &suite, &cap, &rep) == AH_OK);
    CHECK(rep.cases == 2);
    CHECK(rep.passed == 2);
    CHECK(rep.invalid_lines == 0);
    CHECK(rep.overridden == 1);
    CHECK(ah_conformance_exit_code(&rep) == 0);
    CHECK(has(&cap, "PASSOU  crlf-bom.jsonl g/crlf\n"));
    CHECK(has(&cap, "PASSOU  crlf-bom.jsonl g/sem-esperado [divergência DV-12: esperado "
                    "decidido (corrigir)]\n"));
    capture_free(&cap);
}

static void test_marker_variants(void) {
    static const char data[] =
        "{\"id\":\"m/1\",\"entrada\":1,\"esperado\":2,\"divergencia\":\"ver XDV-12 e DV-7\"}\n"
        "{\"id\":\"m/2\",\"entrada\":1,\"esperado\":2,\"divergence\":\"DV- sem número\"}\n"
        "{\"id\":\"m/3\",\"entrada\":1,\"esperado\":2,\"divergencia\":null}\n"
        "{\"id\":\"m/4\",\"entrada\":1,\"esperado\":2,\"divergencia\":{\"obj\":1}}\n"
        "{\"id\":\"m/5\",\"entrada\":1,\"esperado\":2,\"notes\":\"sem marca: divergência "
        "conhecida em minúsculas não conta\"}\n";
    char path[1024];
    capture cap = {0};
    ah_conformance_report rep;
    ah_conformance_suite suite = {"marcas", ah_conformance_exemplo_case, NULL, NULL, 0, 0};

    join(path, sizeof path, g_tmp_dir, "marcas.jsonl");
    CHECK(write_file(path, data, sizeof data - 1));
    CHECK(run(path, &suite, &cap, &rep) == AH_OK);
    CHECK(rep.cases == 5);
    CHECK(rep.passed == 5);
    CHECK(rep.divergent == 3);
    CHECK(rep.divergent_without_dv == 2);
    CHECK(has(&cap, "PASSOU  marcas.jsonl m/1 [divergência DV-7]\n"));
    CHECK(has(&cap, "PASSOU  marcas.jsonl m/2 [divergência sem ID de DV: \"DV- sem número\"]\n"));
    CHECK(has(&cap, "PASSOU  marcas.jsonl m/3\n"));
    CHECK(has(&cap, "PASSOU  marcas.jsonl m/4 [divergência sem ID de DV: \"\"]\n"));
    CHECK(has(&cap, "PASSOU  marcas.jsonl m/5\n"));
    capture_free(&cap);
}

static void test_empty_corpus_fails(void) {
    static const char blank_only[] = "\n   \n\r\n";
    char path[1024];
    capture cap = {0};
    ah_conformance_report rep;

    join(path, sizeof path, g_tmp_dir, "vazio.jsonl");
    CHECK(write_file(path, "", 0));
    CHECK(run(path, ah_conformance_exemplo_suite(), &cap, &rep) == AH_OK);
    CHECK(rep.cases == 0);
    CHECK(ah_conformance_exit_code(&rep) == 1);

    join(path, sizeof path, g_tmp_dir, "brancos.jsonl");
    CHECK(write_file(path, blank_only, sizeof blank_only - 1));
    CHECK(run(path, ah_conformance_exemplo_suite(), &cap, &rep) == AH_OK);
    CHECK(rep.cases == 0);
    CHECK(rep.invalid_lines == 0);
    CHECK(ah_conformance_exit_code(&rep) == 1);
    capture_free(&cap);
}

static void test_line_limit(void) {
    size_t n = AH_CONFORMANCE_MAX_LINE + 16;
    char *data = malloc(n);
    char path[1024];
    capture cap = {0};
    ah_conformance_report rep;
    ah_conformance_suite suite = {"teto", counting_case, NULL, NULL, 0, 0};

    CHECK(data != NULL);
    if (data == NULL) {
        return;
    }
    memset(data, 'a', n);
    memcpy(data, "{\"id\":\"t/1\",\"p\":\"", 17);
    memcpy(data + n - 3, "\"}\n", 3);
    join(path, sizeof path, g_tmp_dir, "teto.jsonl");
    CHECK(write_file(path, data, n));
    free(data);
    g_calls_invalid = 0;
    CHECK(run(path, &suite, &cap, &rep) == AH_ERR_LIMIT);
    CHECK(g_calls_invalid == 0);
    CHECK(has(&cap, "ERRO: linha acima do teto na linha 1 de teto.jsonl"));
    CHECK(has(&cap, "EXECUÇÃO INTERROMPIDA"));
    capture_free(&cap);
}

static ah_conformance_verdict bogus_case(const cJSON *caso, const ah_conformance_case_info *info,
                                         char *msg, size_t msg_cap, void *ctx) {
    (void)caso;
    (void)info;
    (void)msg;
    (void)msg_cap;
    (void)ctx;
    return (ah_conformance_verdict)42;
}

static void test_invalid_verdict_is_failure(void) {
    char path[1024];
    capture cap = {0};
    ah_conformance_report rep;
    ah_conformance_suite suite = {"bogus", bogus_case, NULL, NULL, 0, 0};

    join(path, sizeof path, g_exemplo_dir, "verde.jsonl");
    CHECK(run(path, &suite, &cap, &rep) == AH_OK);
    CHECK(rep.failed == 7);
    CHECK(rep.passed == 0);
    CHECK(has(&cap, "função de teste devolveu veredito inválido (42)"));
    capture_free(&cap);
}

static void test_main_exit_codes(void) {
    char verde[1024];
    char misto[1024];
    char exe[] = "conformance_exemplo";
    char *argv_verde[2];
    char *argv_misto[2];
    char *argv_none[1];

    join(verde, sizeof verde, g_exemplo_dir, "verde.jsonl");
    join(misto, sizeof misto, g_exemplo_dir, "misto.jsonl");
    argv_verde[0] = exe;
    argv_verde[1] = verde;
    argv_misto[0] = exe;
    argv_misto[1] = misto;
    argv_none[0] = exe;
    CHECK(ah_conformance_main(2, argv_verde, ah_conformance_exemplo_suite()) == 0);
    CHECK(ah_conformance_main(2, argv_misto, ah_conformance_exemplo_suite()) == 1);
    CHECK(ah_conformance_main(1, argv_none, ah_conformance_exemplo_suite()) == 1);
}

int main(int argc, char **argv) {
    if (argc != 3) {
        fprintf(stderr, "uso: %s <dir de exemplo> <dir temporário>\n", argv[0]);
        return 2;
    }
    g_exemplo_dir = argv[1];
    g_tmp_dir = argv[2];

    test_misto();
    test_verde();
    test_case_receives_decided_expected();
    test_require_dv_id();
    test_unused_entry_fails();
    test_invalid_tables();
    test_bad_arguments();
    test_missing_file();
    test_crlf_bom_no_final_newline_and_added_key();
    test_marker_variants();
    test_empty_corpus_fails();
    test_line_limit();
    test_invalid_verdict_is_failure();
    test_nul_byte_rejects_line();
    test_main_exit_codes();
    return AH_TEST_END("test_conformance_runner");
}
