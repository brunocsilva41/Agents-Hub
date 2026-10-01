#include "ah_regex.h"

#include <stdio.h>
#include <stdlib.h>

#include "pcre2.h"

struct ah_regex {
    pcre2_code *code;
    /* Só lido durante o casamento: a PCRE2 permite compartilhar um contexto
     * de casamento entre threads enquanto ninguém o altera. */
    pcre2_match_context *mctx;
    uint32_t capture_count;
};

void ah_regex_limits_default(ah_regex_limits *lim) {
    lim->match_limit = AH_REGEX_DEFAULT_MATCH_LIMIT;
    lim->depth_limit = AH_REGEX_DEFAULT_DEPTH_LIMIT;
    lim->heap_limit_kib = AH_REGEX_DEFAULT_HEAP_LIMIT_KIB;
}

static void set_err(char *err, size_t err_size, const char *prefix, int code, size_t offset) {
    PCRE2_UCHAR msg[160];
    int w;

    if (err == NULL || err_size == 0) {
        return;
    }
    if (pcre2_get_error_message(code, msg, sizeof msg / sizeof msg[0]) < 0) {
        msg[0] = 0;
    }
    w = snprintf(err, err_size, "%s: %s (posicao %lu)", prefix, (const char *)msg,
                 (unsigned long)offset);
    if (w < 0) {
        err[0] = '\0';
    }
}

ah_status ah_regex_compile(const char *pattern, size_t len, unsigned flags,
                           const ah_regex_limits *lim, ah_regex **out, char *err,
                           size_t err_size) {
    ah_regex_limits l;
    ah_regex *re;
    uint32_t options = PCRE2_UTF | PCRE2_MATCH_INVALID_UTF | PCRE2_NEVER_BACKSLASH_C;
    int errcode = 0;
    PCRE2_SIZE erroff = 0;

    if (err != NULL && err_size > 0) {
        err[0] = '\0';
    }
    if (out == NULL || (pattern == NULL && len != 0) || (flags & ~AH_REGEX_CASELESS) != 0) {
        return AH_ERR_INVALID;
    }
    *out = NULL;
    if (lim != NULL) {
        l = *lim;
    } else {
        ah_regex_limits_default(&l);
    }
    if ((flags & AH_REGEX_CASELESS) != 0) {
        options |= PCRE2_CASELESS;
    }
    re = calloc(1, sizeof *re);
    if (re == NULL) {
        return AH_ERR_NOMEM;
    }
    re->code = pcre2_compile((PCRE2_SPTR)(pattern != NULL ? pattern : ""), len, options,
                             &errcode, &erroff, NULL);
    if (re->code == NULL) {
        free(re);
        if (errcode == PCRE2_ERROR_NOMEMORY) {
            return AH_ERR_NOMEM;
        }
        set_err(err, err_size, "regex invalida", errcode, erroff);
        return AH_ERR_INVALID;
    }
    re->mctx = pcre2_match_context_create(NULL);
    if (re->mctx == NULL) {
        ah_regex_free(re);
        return AH_ERR_NOMEM;
    }
    /* Na 10.49 os três setters devolvem sempre 0 (pcre2_context.c); confere mesmo assim. */
    if (pcre2_set_match_limit(re->mctx, l.match_limit) != 0 ||
        pcre2_set_depth_limit(re->mctx, l.depth_limit) != 0 ||
        pcre2_set_heap_limit(re->mctx, l.heap_limit_kib) != 0 ||
        pcre2_pattern_info(re->code, PCRE2_INFO_CAPTURECOUNT, &re->capture_count) != 0) {
        ah_regex_free(re);
        return AH_ERR_INTERNAL;
    }
    *out = re;
    return AH_OK;
}

void ah_regex_free(ah_regex *re) {
    if (re == NULL) {
        return;
    }
    pcre2_match_context_free(re->mctx);
    pcre2_code_free(re->code);
    free(re);
}

size_t ah_regex_group_count(const ah_regex *re) {
    return re == NULL ? 0 : (size_t)re->capture_count;
}

ah_status ah_regex_match(const ah_regex *re, const char *subject, size_t len, bool *matched,
                         ah_regex_span *groups, size_t n_groups) {
    pcre2_match_data *md;
    PCRE2_SIZE *ov;
    int rc;
    size_t i;
    ah_status st = AH_OK;

    if (matched != NULL) {
        *matched = false;
    }
    if (re == NULL || matched == NULL || (subject == NULL && len != 0) ||
        (groups == NULL && n_groups != 0)) {
        return AH_ERR_INVALID;
    }
    for (i = 0; i < n_groups; i++) {
        groups[i].start = 0;
        groups[i].end = 0;
        groups[i].matched = false;
    }
    md = pcre2_match_data_create_from_pattern(re->code, NULL);
    if (md == NULL) {
        return AH_ERR_NOMEM;
    }
    rc = pcre2_match(re->code, (PCRE2_SPTR)(subject != NULL ? subject : ""), len, 0, 0, md,
                     re->mctx);
    if (rc > 0) {
        *matched = true;
        ov = pcre2_get_ovector_pointer(md);
        for (i = 0; i < n_groups && i <= re->capture_count && i < (size_t)rc; i++) {
            if (ov[2 * i] != PCRE2_UNSET) {
                groups[i].start = ov[2 * i];
                groups[i].end = ov[2 * i + 1];
                groups[i].matched = true;
            }
        }
    } else if (rc == PCRE2_ERROR_NOMATCH) {
        st = AH_OK;
    } else if (rc == PCRE2_ERROR_MATCHLIMIT || rc == PCRE2_ERROR_DEPTHLIMIT ||
               rc == PCRE2_ERROR_HEAPLIMIT) {
        st = AH_ERR_LIMIT;
    } else if (rc == PCRE2_ERROR_NOMEMORY) {
        st = AH_ERR_NOMEM;
    } else {
        st = AH_ERR_INTERNAL; /* rc == 0 não ocorre com o bloco do próprio padrão */
    }
    pcre2_match_data_free(md);
    return st;
}
