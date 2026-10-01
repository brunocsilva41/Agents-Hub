/* Runner de conformidade (F0-11). Contrato em ah_conformance.h; regra da
 * tabela de esperado decidido em README.md. */
#include "ah_conformance.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* "DV-" + até 6 dígitos + terminador. */
#define DV_ID_CAP 16
#define MSG_CAP 1024
#define EXCERPT_BYTES 80

/* Marca dos mappers (README de mappers, campo `notes`), em UTF-8. */
static const char k_marker_text[] = "DIVERG\xC3\x8A" "NCIA CONHECIDA";

/* ------------------------------------------------------------- relatório */

static void sink_stdout(void *ctx, const char *line) {
    (void)ctx;
    fputs(line, stdout);
    fputc('\n', stdout);
}

/* Formata e entrega uma linha. Sem memória para a linha longa, entrega o
 * prefixo que coube: o relatório nunca some em silêncio. */
static void emit(ah_conformance_sink_fn sink, void *ctx, const char *fmt, ...) {
    char small[1024];
    va_list ap;
    va_list ap2;
    int n;

    va_start(ap, fmt);
    va_copy(ap2, ap);
    n = vsnprintf(small, sizeof small, fmt, ap);
    va_end(ap);
    if (n < 0) {
        va_end(ap2);
        sink(ctx, "ERRO: falha ao formatar linha do relatório");
        return;
    }
    if ((size_t)n < sizeof small) {
        va_end(ap2);
        sink(ctx, small);
        return;
    }
    {
        size_t need = (size_t)n + 1;
        char *big = malloc(need);
        if (big == NULL) {
            va_end(ap2);
            sink(ctx, small);
            return;
        }
        n = vsnprintf(big, need, fmt, ap2);
        va_end(ap2);
        sink(ctx, n < 0 ? small : big);
        free(big);
    }
}

/* Troca caracteres de controle por espaço: cada caso ocupa uma linha só. */
static void flatten(char *s) {
    for (; *s != '\0'; s++) {
        if ((unsigned char)*s < 0x20 || *s == 0x7F) {
            *s = ' ';
        }
    }
}

/* Copia até `max` bytes de `src` sem partir um code point UTF-8. */
static void excerpt(const char *src, char *dst, size_t dst_cap) {
    size_t len = strlen(src);
    size_t max = dst_cap - 1;
    int cut = 0;

    if (len > max) {
        len = max;
        cut = 1;
        while (len > 0 && ((unsigned char)src[len] & 0xC0) == 0x80) {
            len--;
        }
    }
    memcpy(dst, src, len);
    dst[len] = '\0';
    flatten(dst);
    if (cut && len >= 3) {
        memcpy(dst + len - 3, "...", 4);
    }
}

static const char *base_name(const char *path) {
    const char *b = path;
    const char *p;
    for (p = path; *p != '\0'; p++) {
        if (*p == '/' || *p == '\\') {
            b = p + 1;
        }
    }
    return b;
}

/* ------------------------------------------------------------- DV e marcas */

/* Procura "DV-<dígitos>" com fronteira à esquerda. Devolve 1 e copia o ID. */
static int find_dv_id(const char *text, char out[DV_ID_CAP]) {
    const char *p = text;
    while ((p = strstr(p, "DV-")) != NULL) {
        int left_ok = (p == text) ||
                      !((p[-1] >= 'A' && p[-1] <= 'Z') || (p[-1] >= 'a' && p[-1] <= 'z') ||
                        (p[-1] >= '0' && p[-1] <= '9'));
        size_t digits = 0;
        while (p[3 + digits] >= '0' && p[3 + digits] <= '9') {
            digits++;
        }
        if (left_ok && digits > 0 && digits <= 6) {
            memcpy(out, p, 3 + digits);
            out[3 + digits] = '\0';
            return 1;
        }
        p += 3;
    }
    return 0;
}

/* dv_id da tabela precisa ser exatamente "DV-<1 a 6 dígitos>". */
static int valid_dv_id(const char *s) {
    size_t i = 3;
    if (s == NULL || strncmp(s, "DV-", 3) != 0) {
        return 0;
    }
    while (s[i] >= '0' && s[i] <= '9') {
        i++;
    }
    return i > 3 && i <= 9 && s[i] == '\0';
}

/* Marca de divergência do caso. Devolve 1 se há marca; *text aponta para o
 * texto da marca (emprestado do cJSON) ou para "" se o valor não é texto. */
static int find_marker(const cJSON *caso, const char **text) {
    static const char *const keys[] = {"divergencia", "divergence"};
    const cJSON *it;
    size_t k;

    for (k = 0; k < sizeof keys / sizeof keys[0]; k++) {
        const cJSON *v = cJSON_GetObjectItemCaseSensitive(caso, keys[k]);
        if (v != NULL && !cJSON_IsNull(v)) {
            *text = cJSON_IsString(v) && v->valuestring != NULL ? v->valuestring : "";
            return 1;
        }
    }
    cJSON_ArrayForEach(it, caso) {
        if (cJSON_IsString(it) && it->valuestring != NULL &&
            strstr(it->valuestring, k_marker_text) != NULL) {
            *text = it->valuestring;
            return 1;
        }
    }
    return 0;
}

/* ------------------------------------------------------------- tabela */

typedef struct decided_state {
    const ah_conformance_suite *suite;
    cJSON **override; /* um por entrada; NULL em REPRODUCE */
    size_t *hits;     /* casos casados por entrada */
} decided_state;

static void decided_free(decided_state *st) {
    size_t i;
    if (st->override != NULL) {
        for (i = 0; i < st->suite->decided_count; i++) {
            cJSON_Delete(st->override[i]);
        }
    }
    free(st->override);
    free(st->hits);
    st->override = NULL;
    st->hits = NULL;
}

static ah_status decided_init(decided_state *st, const ah_conformance_suite *suite,
                              ah_conformance_sink_fn sink, void *sink_ctx) {
    size_t n = suite->decided_count;
    size_t i;
    size_t j;
    int bad = 0;

    st->suite = suite;
    st->override = NULL;
    st->hits = NULL;
    if (n == 0) {
        return AH_OK;
    }
    if (suite->decided == NULL) {
        emit(sink, sink_ctx, "ERRO tabela: decided == NULL com decided_count %zu", n);
        return AH_ERR_INVALID;
    }
    st->override = calloc(n, sizeof *st->override);
    st->hits = calloc(n, sizeof *st->hits);
    if (st->override == NULL || st->hits == NULL) {
        decided_free(st);
        return AH_ERR_NOMEM;
    }
    for (i = 0; i < n; i++) {
        const ah_conformance_decided *d = &suite->decided[i];
        const char *star = d->case_id != NULL ? strchr(d->case_id, '*') : NULL;

        if (d->case_id == NULL || d->case_id[0] == '\0' || d->case_id[0] == '*' ||
            (star != NULL && star[1] != '\0')) {
            emit(sink, sink_ctx,
                 "ERRO tabela[%zu]: case_id vazio ou com '*' fora do fim", i);
            bad = 1;
            continue;
        }
        if (!valid_dv_id(d->dv_id)) {
            emit(sink, sink_ctx, "ERRO tabela[%zu] (%s): dv_id precisa ser \"DV-<número>\"",
                 i, d->case_id);
            bad = 1;
        }
        for (j = 0; j < i; j++) {
            if (suite->decided[j].case_id != NULL &&
                strcmp(suite->decided[j].case_id, d->case_id) == 0) {
                emit(sink, sink_ctx, "ERRO tabela[%zu] (%s): case_id repetido", i,
                     d->case_id);
                bad = 1;
            }
        }
        if (d->policy == AH_CONFORMANCE_DV_REPRODUCE) {
            if (d->expected_json != NULL) {
                emit(sink, sink_ctx,
                     "ERRO tabela[%zu] (%s): REPRODUCE não troca o esperado (expected_json "
                     "precisa ser NULL)",
                     i, d->case_id);
                bad = 1;
            }
        } else if (d->policy == AH_CONFORMANCE_DV_CORRECT) {
            cJSON *obj = d->expected_json != NULL ? cJSON_Parse(d->expected_json) : NULL;
            if (!cJSON_IsObject(obj) || obj->child == NULL) {
                emit(sink, sink_ctx,
                     "ERRO tabela[%zu] (%s): CORRECT exige expected_json com objeto JSON "
                     "não vazio",
                     i, d->case_id);
                cJSON_Delete(obj);
                bad = 1;
            } else {
                st->override[i] = obj;
            }
        } else {
            emit(sink, sink_ctx, "ERRO tabela[%zu] (%s): policy desconhecida", i,
                 d->case_id);
            bad = 1;
        }
    }
    if (bad) {
        decided_free(st);
        return AH_ERR_INVALID;
    }
    return AH_OK;
}

/* Entrada da tabela que casa o id: exato primeiro, depois o prefixo mais longo. */
static long decided_match(const decided_state *st, const char *id) {
    const ah_conformance_suite *s = st->suite;
    long best = -1;
    size_t best_len = 0;
    size_t i;

    for (i = 0; i < s->decided_count; i++) {
        if (strcmp(s->decided[i].case_id, id) == 0) {
            return (long)i;
        }
    }
    for (i = 0; i < s->decided_count; i++) {
        const char *cid = s->decided[i].case_id;
        size_t len = strlen(cid);
        if (cid[len - 1] == '*' && strncmp(cid, id, len - 1) == 0 && len - 1 > best_len) {
            best = (long)i;
            best_len = len - 1;
        }
    }
    return best;
}

/* Cópia do caso com as chaves de topo do esperado decidido aplicadas. */
static cJSON *apply_override(const cJSON *caso, const cJSON *override) {
    cJSON *copy = cJSON_Duplicate(caso, 1);
    const cJSON *it;

    if (copy == NULL) {
        return NULL;
    }
    cJSON_ArrayForEach(it, override) {
        cJSON *val = cJSON_Duplicate(it, 1);
        cJSON_bool ok;
        if (val == NULL) {
            cJSON_Delete(copy);
            return NULL;
        }
        if (cJSON_GetObjectItemCaseSensitive(copy, it->string) != NULL) {
            ok = cJSON_ReplaceItemInObjectCaseSensitive(copy, it->string, val);
        } else {
            ok = cJSON_AddItemToObject(copy, it->string, val);
        }
        if (!ok) {
            cJSON_Delete(val);
            cJSON_Delete(copy);
            return NULL;
        }
    }
    return copy;
}

/* ------------------------------------------------------------- leitura */

/* O CRT da Microsoft marca fopen como inseguro (C4996, erro com /WX) e o
 * docs/18 §6 proíbe silenciar com _CRT_SECURE_NO_WARNINGS; fopen_s é a
 * alternativa dele. Migra para a área fs de ah_platform (README, "Limites"). */
static FILE *open_read(const char *path) {
#if defined(_MSC_VER)
    FILE *f = NULL;
    if (fopen_s(&f, path, "rb") != 0) {
        return NULL;
    }
    return f;
#else
    return fopen(path, "rb");
#endif
}

/* Lê uma linha (sem '\n' e sem '\r' final) para *buf. Devolve AH_OK com
 * *eof = 1 quando não há mais nada. */
static ah_status read_line(FILE *f, char **buf, size_t *cap, size_t *len, int *eof) {
    *len = 0;
    *eof = 0;
    for (;;) {
        size_t chunk;
        if (*cap - *len < 2) {
            size_t ncap = *cap == 0 ? 4096 : *cap * 2;
            char *nb;
            if (ncap > AH_CONFORMANCE_MAX_LINE + 2) {
                ncap = AH_CONFORMANCE_MAX_LINE + 2;
            }
            if (ncap <= *cap) {
                return AH_ERR_LIMIT;
            }
            nb = realloc(*buf, ncap);
            if (nb == NULL) {
                return AH_ERR_NOMEM;
            }
            *buf = nb;
            *cap = ncap;
        }
        chunk = *cap - *len;
        if (chunk > (size_t)0x7FFFFFFF) {
            chunk = (size_t)0x7FFFFFFF;
        }
        if (fgets(*buf + *len, (int)chunk, f) == NULL) {
            if (ferror(f)) {
                return AH_ERR_IO;
            }
            if (*len == 0) {
                *eof = 1;
            }
            break;
        }
        *len += strlen(*buf + *len);
        if (*len > 0 && (*buf)[*len - 1] == '\n') {
            (*len)--;
            break;
        }
        if (*len > AH_CONFORMANCE_MAX_LINE) {
            return AH_ERR_LIMIT;
        }
    }
    if (*len > AH_CONFORMANCE_MAX_LINE) {
        return AH_ERR_LIMIT;
    }
    if (*len > 0 && (*buf)[*len - 1] == '\r') {
        (*len)--;
    }
    if (*buf != NULL) {
        (*buf)[*len] = '\0';
    }
    return AH_OK;
}

static int blank(const char *s) {
    for (; *s != '\0'; s++) {
        if (*s != ' ' && *s != '\t') {
            return 0;
        }
    }
    return 1;
}

/* ------------------------------------------------------------- execução */

typedef struct run_state {
    const ah_conformance_suite *suite;
    decided_state decided;
    ah_conformance_sink_fn sink;
    void *sink_ctx;
    const char *corpus;
    ah_conformance_report *rep;
} run_state;

static ah_status run_case(run_state *rs, const cJSON *caso, size_t line_no) {
    const cJSON *jid = cJSON_GetObjectItemCaseSensitive(caso, "id");
    const char *marker_text = NULL;
    char dv_buf[DV_ID_CAP];
    char msg[MSG_CAP];
    char tag[DV_ID_CAP + 2 * EXCERPT_BYTES + 96];
    ah_conformance_case_info info;
    cJSON *merged = NULL;
    long entry;
    ah_conformance_verdict v;
    const char *label;

    rs->rep->cases++;
    if (!cJSON_IsString(jid) || jid->valuestring == NULL || jid->valuestring[0] == '\0') {
        rs->rep->failed++;
        emit(rs->sink, rs->sink_ctx, "FALHOU  %s linha %zu: caso sem campo \"id\" (texto)",
             rs->corpus, line_no);
        return AH_OK;
    }

    memset(&info, 0, sizeof info);
    info.corpus = rs->corpus;
    info.id = jid->valuestring;
    info.line = line_no;
    info.divergence_marked = find_marker(caso, &marker_text);

    entry = decided_match(&rs->decided, info.id);
    if (entry >= 0) {
        const ah_conformance_decided *d = &rs->suite->decided[entry];
        rs->decided.hits[entry]++;
        info.dv_id = d->dv_id;
        if (d->policy == AH_CONFORMANCE_DV_CORRECT) {
            merged = apply_override(caso, rs->decided.override[entry]);
            if (merged == NULL) {
                return AH_ERR_NOMEM;
            }
            info.expected_overridden = 1;
        }
    } else if (info.divergence_marked && find_dv_id(marker_text, dv_buf)) {
        info.dv_id = dv_buf;
    }

    tag[0] = '\0';
    if (info.divergence_marked || info.dv_id != NULL) {
        int n;
        rs->rep->divergent++;
        if (info.dv_id == NULL) {
            char ex[EXCERPT_BYTES];
            rs->rep->divergent_without_dv++;
            excerpt(marker_text, ex, sizeof ex);
            n = snprintf(tag, sizeof tag, " [divergência sem ID de DV: \"%s\"]", ex);
        } else if (info.expected_overridden) {
            rs->rep->overridden++;
            n = snprintf(tag, sizeof tag, " [divergência %s: esperado decidido (corrigir)]",
                         info.dv_id);
        } else if (entry >= 0) {
            n = snprintf(tag, sizeof tag, " [divergência %s: reproduz o TS (decidido)]",
                         info.dv_id);
        } else {
            n = snprintf(tag, sizeof tag, " [divergência %s]", info.dv_id);
        }
        if (n < 0 || (size_t)n >= sizeof tag) {
            tag[0] = '\0'; /* não acontece com os tetos acima; nunca imprime lixo */
        }
    }

    msg[0] = '\0';
    v = rs->suite->run_case(merged != NULL ? merged : caso, &info, msg, sizeof msg,
                            rs->suite->ctx);
    msg[sizeof msg - 1] = '\0';
    flatten(msg);
    cJSON_Delete(merged);

    if (v == AH_CONFORMANCE_PASS && info.divergence_marked && info.dv_id == NULL &&
        rs->suite->require_dv_id) {
        v = AH_CONFORMANCE_FAIL;
        (void)snprintf(msg, sizeof msg,
                       "divergência sem ID de DV (require_dv_id): registre o caso na tabela "
                       "do módulo");
    }

    switch (v) {
    case AH_CONFORMANCE_PASS:
        rs->rep->passed++;
        label = "PASSOU ";
        break;
    case AH_CONFORMANCE_SKIP:
        rs->rep->skipped++;
        label = "PULADO ";
        break;
    case AH_CONFORMANCE_FAIL:
        rs->rep->failed++;
        label = "FALHOU ";
        break;
    default:
        rs->rep->failed++;
        label = "FALHOU ";
        (void)snprintf(msg, sizeof msg, "função de teste devolveu veredito inválido (%d)",
                       (int)v);
        break;
    }
    emit(rs->sink, rs->sink_ctx, "%s %s %s%s%s%s", label, rs->corpus, info.id,
         msg[0] != '\0' ? ": " : "", msg, tag);
    return AH_OK;
}

ah_status ah_conformance_run_file(const char *jsonl_path,
                                  const ah_conformance_suite *suite,
                                  ah_conformance_sink_fn sink, void *sink_ctx,
                                  ah_conformance_report *out) {
    run_state rs;
    FILE *f;
    char *buf = NULL;
    size_t cap = 0;
    size_t len = 0;
    size_t line_no = 0;
    ah_status st = AH_OK;
    size_t i;

    if (out == NULL) {
        return AH_ERR_INVALID;
    }
    memset(out, 0, sizeof *out);
    if (sink == NULL) {
        sink = sink_stdout;
    }
    if (jsonl_path == NULL || suite == NULL || suite->run_case == NULL) {
        emit(sink, sink_ctx, "ERRO: caminho, suite ou run_case ausente");
        return AH_ERR_INVALID;
    }

    memset(&rs, 0, sizeof rs);
    rs.suite = suite;
    rs.sink = sink;
    rs.sink_ctx = sink_ctx;
    rs.corpus = base_name(jsonl_path);
    rs.rep = out;

    st = decided_init(&rs.decided, suite, sink, sink_ctx);
    if (st != AH_OK) {
        return st;
    }

    /* fopen recebe o caminho como bytes; no Windows, caminho fora do code
     * page ativo exige a camada de plataforma (ver README, "Limites"). */
    f = open_read(jsonl_path);
    if (f == NULL) {
        emit(sink, sink_ctx, "ERRO: não abriu o corpus \"%s\"", jsonl_path);
        decided_free(&rs.decided);
        return AH_ERR_IO;
    }

    emit(sink, sink_ctx, "CORPUS  %s (suite %s)", rs.corpus,
         suite->name != NULL ? suite->name : "?");

    for (;;) {
        int eof = 0;
        char *text;
        cJSON *caso;

        st = read_line(f, &buf, &cap, &len, &eof);
        if (st != AH_OK) {
            emit(sink, sink_ctx, "ERRO: %s na linha %zu de %s",
                 st == AH_ERR_LIMIT ? "linha acima do teto" : "falha de leitura",
                 line_no + 1, rs.corpus);
            break;
        }
        if (eof) {
            break;
        }
        line_no++;
        text = buf;
        if (line_no == 1 && len >= 3 && (unsigned char)text[0] == 0xEF &&
            (unsigned char)text[1] == 0xBB && (unsigned char)text[2] == 0xBF) {
            text += 3; /* BOM UTF-8 */
        }
        if (blank(text)) {
            continue;
        }
        if (out->cases + out->invalid_lines >= AH_CONFORMANCE_MAX_CASES) {
            emit(sink, sink_ctx, "ERRO: mais de %zu casos em %s",
                 (size_t)AH_CONFORMANCE_MAX_CASES, rs.corpus);
            st = AH_ERR_LIMIT;
            break;
        }
        caso = cJSON_ParseWithOpts(text, NULL, 1);
        if (!cJSON_IsObject(caso)) {
            out->invalid_lines++;
            emit(sink, sink_ctx, "FALHOU  %s linha %zu: %s", rs.corpus, line_no,
                 caso == NULL ? "JSON inválido" : "a linha não é um objeto JSON");
            cJSON_Delete(caso);
            continue;
        }
        st = run_case(&rs, caso, line_no);
        cJSON_Delete(caso);
        if (st != AH_OK) {
            emit(sink, sink_ctx, "ERRO: sem memória no caso da linha %zu de %s", line_no,
                 rs.corpus);
            break;
        }
    }
    free(buf);
    if (fclose(f) != 0 && st == AH_OK) {
        st = AH_ERR_IO;
    }

    if (st == AH_OK) {
        for (i = 0; i < suite->decided_count; i++) {
            if (rs.decided.hits[i] == 0) {
                out->unused_decided++;
                emit(sink, sink_ctx,
                     "FALHOU  %s tabela: entrada \"%s\" (%s) não casou caso algum", rs.corpus,
                     suite->decided[i].case_id, suite->decided[i].dv_id);
            }
        }
    }
    decided_free(&rs.decided);

    emit(sink, sink_ctx,
         "RESUMO  %s: %zu casos, %zu passaram, %zu falharam, %zu pulados; %zu com "
         "divergência (%zu com esperado decidido, %zu sem ID de DV); %zu linhas inválidas; "
         "%zu entradas da tabela sem uso%s",
         rs.corpus, out->cases, out->passed, out->failed, out->skipped, out->divergent,
         out->overridden, out->divergent_without_dv, out->invalid_lines, out->unused_decided,
         st != AH_OK ? "; EXECUÇÃO INTERROMPIDA" : "");
    return st;
}

int ah_conformance_exit_code(const ah_conformance_report *r) {
    if (r == NULL || r->cases == 0) {
        return 1;
    }
    return (r->failed == 0 && r->invalid_lines == 0 && r->unused_decided == 0) ? 0 : 1;
}

int ah_conformance_main(int argc, char **argv, const ah_conformance_suite *suite) {
    ah_conformance_report rep;
    ah_status st;
    int code;

    if (argc != 2 || argv == NULL || argv[1] == NULL) {
        fprintf(stderr, "uso: %s <arquivo.jsonl>\n",
                argc > 0 && argv != NULL && argv[0] != NULL ? argv[0] : "conformance");
        return 1;
    }
    st = ah_conformance_run_file(argv[1], suite, NULL, NULL, &rep);
    code = st == AH_OK ? ah_conformance_exit_code(&rep) : 1;
    if (st == AH_OK && rep.cases == 0) {
        fputs("ERRO: o corpus não tem nenhum caso\n", stdout);
    }
    fflush(stdout);
    return code;
}
