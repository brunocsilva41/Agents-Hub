#include "ah_json.h"

#include <locale.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ah_text.h"
#include "cJSON.h"

#if AH_JSON_MAX_DEPTH > CJSON_NESTING_LIMIT
#error "AH_JSON_MAX_DEPTH não pode passar do CJSON_NESTING_LIMIT do cJSON vendorizado"
#endif

/* ah_json é só um nome opaco para cJSON: os ponteiros apontam para itens do
 * cJSON e a struct ah_json nunca é definida. */
static cJSON *J(ah_json *v) { return (cJSON *)(void *)v; }
static const cJSON *CJ(const ah_json *v) { return (const cJSON *)(const void *)v; }
static ah_json *A(cJSON *v) { return (ah_json *)(void *)v; }
static const ah_json *CA(const cJSON *v) { return (const ah_json *)(const void *)v; }

static int item_type(const cJSON *v) { return v->type & 0xFF; }

/* ======================================================================
 * Leitura
 * ====================================================================== */

typedef struct frame {
    cJSON *node;
    bool is_object;
    size_t count; /* membros já anexados (só objeto) */
    char *key;    /* chave lida e ainda sem valor (só objeto) */
} frame;

typedef struct parser {
    const unsigned char *s;
    size_t n;
    size_t i;
    frame *stack;
    size_t depth;
    size_t stack_cap;
    cJSON *root;
    ah_text_buf scratch;
    bool saw_nul; /* achou "\u0000" em string ou chave */
} parser;

static void skip_ws(parser *p) {
    /* JSON.parse só aceita estes quatro como espaço (RFC 8259 §2). */
    while (p->i < p->n) {
        unsigned char c = p->s[p->i];
        if (c != ' ' && c != '\t' && c != '\n' && c != '\r') {
            break;
        }
        p->i++;
    }
}

static int hex_value(unsigned char c) {
    if (c >= '0' && c <= '9') {
        return c - '0';
    }
    if (c >= 'a' && c <= 'f') {
        return c - 'a' + 10;
    }
    if (c >= 'A' && c <= 'F') {
        return c - 'A' + 10;
    }
    return -1;
}

/* Lê 4 dígitos hex a partir de s[at]; -1 se não houver. */
static long read_hex4(const parser *p, size_t at) {
    long v = 0;
    size_t k;

    if (at > p->n || p->n - at < 4) {
        return -1;
    }
    for (k = 0; k < 4; k++) {
        int h = hex_value(p->s[at + k]);
        if (h < 0) {
            return -1;
        }
        v = (v << 4) | h;
    }
    return v;
}

static ah_status append_utf8(ah_text_buf *b, uint32_t cp) {
    char out[4];
    size_t n;

    if (cp < 0x80) {
        out[0] = (char)cp;
        n = 1;
    } else if (cp < 0x800) {
        out[0] = (char)(0xC0 | (cp >> 6));
        out[1] = (char)(0x80 | (cp & 0x3F));
        n = 2;
    } else if (cp < 0x10000) {
        out[0] = (char)(0xE0 | (cp >> 12));
        out[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
        out[2] = (char)(0x80 | (cp & 0x3F));
        n = 3;
    } else {
        out[0] = (char)(0xF0 | (cp >> 18));
        out[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
        out[2] = (char)(0x80 | ((cp >> 6) & 0x3F));
        out[3] = (char)(0x80 | (cp & 0x3F));
        n = 4;
    }
    return ah_text_buf_append(b, out, n);
}

/* Lê a string que começa em s[i] == '"' para p->scratch (terminada em NUL). */
static ah_status parse_string(parser *p) {
    ah_status st = AH_OK;

    p->scratch.len = 0;
    p->i++; /* aspas de abertura */
    while (st == AH_OK) {
        size_t run = p->i;
        unsigned char c;

        while (p->i < p->n && p->s[p->i] != '"' && p->s[p->i] != '\\' && p->s[p->i] >= 0x20) {
            p->i++;
        }
        if (p->i > run) {
            st = ah_text_buf_append(&p->scratch, (const char *)p->s + run, p->i - run);
            if (st != AH_OK) {
                return st;
            }
        }
        if (p->i >= p->n) {
            return AH_ERR_INVALID;
        }
        c = p->s[p->i];
        if (c == '"') {
            p->i++;
            /* Garante o NUL mesmo para string vazia. */
            return ah_text_buf_append(&p->scratch, "", 0);
        }
        if (c < 0x20) {
            return AH_ERR_INVALID; /* controle cru é proibido dentro de string */
        }
        /* c == '\\' */
        if (p->i + 1 >= p->n) {
            return AH_ERR_INVALID;
        }
        c = p->s[p->i + 1];
        p->i += 2;
        switch (c) {
        case '"': st = ah_text_buf_append_char(&p->scratch, '"'); break;
        case '\\': st = ah_text_buf_append_char(&p->scratch, '\\'); break;
        case '/': st = ah_text_buf_append_char(&p->scratch, '/'); break;
        case 'b': st = ah_text_buf_append_char(&p->scratch, '\b'); break;
        case 'f': st = ah_text_buf_append_char(&p->scratch, '\f'); break;
        case 'n': st = ah_text_buf_append_char(&p->scratch, '\n'); break;
        case 'r': st = ah_text_buf_append_char(&p->scratch, '\r'); break;
        case 't': st = ah_text_buf_append_char(&p->scratch, '\t'); break;
        case 'u': {
            long u = read_hex4(p, p->i);
            uint32_t cp;
            if (u < 0) {
                return AH_ERR_INVALID;
            }
            p->i += 4;
            cp = (uint32_t)u;
            if (cp == 0) {
                /* O cJSON guarda string terminada em NUL: U+0000 truncaria o
                 * texto em silêncio. Marca e segue validando o resto; no fim,
                 * JSON válido com NUL vira AH_ERR_LIMIT (ver o header). */
                p->saw_nul = true;
                break;
            }
            if (cp >= 0xD800 && cp <= 0xDBFF) {
                long lo = -1;
                if (p->i + 1 < p->n && p->s[p->i] == '\\' && p->s[p->i + 1] == 'u') {
                    lo = read_hex4(p, p->i + 2);
                }
                if (lo >= 0xDC00 && lo <= 0xDFFF) {
                    cp = 0x10000u + ((cp - 0xD800u) << 10) + ((uint32_t)lo - 0xDC00u);
                    p->i += 6;
                } else {
                    cp = 0xFFFDu; /* surrogate alto sem par */
                }
            } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
                cp = 0xFFFDu; /* surrogate baixo sem par */
            }
            st = append_utf8(&p->scratch, cp);
            break;
        }
        default:
            return AH_ERR_INVALID;
        }
    }
    return st;
}

/* Número na gramática do JSON.parse; o valor sai pelo strtod. */
static ah_status parse_number(parser *p, double *out) {
    size_t start = p->i;
    size_t k;
    char *end = NULL;
    const struct lconv *lc;
    char point = '.';
    ah_status st;

    if (p->i < p->n && p->s[p->i] == '-') {
        p->i++;
    }
    if (p->i >= p->n) {
        return AH_ERR_INVALID;
    }
    if (p->s[p->i] == '0') {
        p->i++;
    } else if (p->s[p->i] >= '1' && p->s[p->i] <= '9') {
        while (p->i < p->n && p->s[p->i] >= '0' && p->s[p->i] <= '9') {
            p->i++;
        }
    } else {
        return AH_ERR_INVALID;
    }
    if (p->i < p->n && p->s[p->i] == '.') {
        size_t d = ++p->i;
        while (p->i < p->n && p->s[p->i] >= '0' && p->s[p->i] <= '9') {
            p->i++;
        }
        if (p->i == d) {
            return AH_ERR_INVALID;
        }
    }
    if (p->i < p->n && (p->s[p->i] == 'e' || p->s[p->i] == 'E')) {
        size_t d;
        p->i++;
        if (p->i < p->n && (p->s[p->i] == '+' || p->s[p->i] == '-')) {
            p->i++;
        }
        d = p->i;
        while (p->i < p->n && p->s[p->i] >= '0' && p->s[p->i] <= '9') {
            p->i++;
        }
        if (p->i == d) {
            return AH_ERR_INVALID;
        }
    }

    /* strtod usa o separador decimal do locale corrente (como o cJSON faz,
     * cJSON.c parse_number): troca o '.' por ele numa cópia terminada em NUL. */
    lc = localeconv();
    if (lc != NULL && lc->decimal_point != NULL && lc->decimal_point[0] != '\0') {
        point = lc->decimal_point[0];
    }
    p->scratch.len = 0;
    st = ah_text_buf_append(&p->scratch, (const char *)p->s + start, p->i - start);
    if (st != AH_OK) {
        return st;
    }
    for (k = 0; k < p->scratch.len; k++) {
        if (p->scratch.data[k] == '.') {
            p->scratch.data[k] = point;
        }
    }
    *out = strtod(p->scratch.data, &end);
    if (end != p->scratch.data + p->scratch.len) {
        return AH_ERR_INVALID;
    }
    return AH_OK;
}

static bool match_literal(parser *p, const char *lit) {
    size_t len = strlen(lit);
    if (p->n - p->i < len || memcmp(p->s + p->i, lit, len) != 0) {
        return false;
    }
    p->i += len;
    return true;
}

typedef struct key_entry {
    cJSON *item;
    size_t index;
} key_entry;

static int compare_key_entry(const void *a, const void *b) {
    const key_entry *x = a;
    const key_entry *y = b;
    int c = strcmp(x->item->string, y->item->string);
    if (c != 0) {
        return c;
    }
    return (x->index > y->index) - (x->index < y->index);
}

/* Chave repetida como no JSON.parse: fica o último valor, na posição da
 * primeira ocorrência. O(n log n) por objeto (qsort), sem caso quadrático. */
static ah_status dedupe_object(cJSON *obj, size_t count) {
    key_entry *e;
    cJSON *it;
    size_t k = 0;
    size_t a;

    if (count < 2) {
        return AH_OK;
    }
    if (count > SIZE_MAX / sizeof *e) {
        return AH_ERR_LIMIT;
    }
    e = malloc(count * sizeof *e);
    if (e == NULL) {
        return AH_ERR_NOMEM;
    }
    for (it = obj->child; it != NULL && k < count; it = it->next, k++) {
        e[k].item = it;
        e[k].index = k;
    }
    qsort(e, k, sizeof *e, compare_key_entry);
    a = 0;
    while (a < k) {
        size_t b = a;
        while (b + 1 < k && strcmp(e[a].item->string, e[b + 1].item->string) == 0) {
            b++;
        }
        if (b > a) {
            size_t m;
            cJSON *last;
            for (m = a + 1; m < b; m++) {
                cJSON_Delete(cJSON_DetachItemViaPointer(obj, e[m].item));
            }
            last = cJSON_DetachItemViaPointer(obj, e[b].item);
            /* Troca o primeiro pelo último na mesma posição; o primeiro é
             * liberado pelo cJSON. A chave do último é o mesmo texto. */
            if (!cJSON_ReplaceItemViaPointer(obj, e[a].item, last)) {
                cJSON_Delete(last);
                free(e);
                return AH_ERR_INTERNAL;
            }
        }
        a = b + 1;
    }
    free(e);
    return AH_OK;
}

/* Anexa `node` ao contêiner do topo (ou o faz raiz). Em erro, libera `node`. */
static ah_status attach(parser *p, cJSON *node) {
    frame *top;

    if (node == NULL) {
        return AH_ERR_NOMEM;
    }
    if (p->depth == 0) {
        p->root = node;
        return AH_OK;
    }
    top = &p->stack[p->depth - 1];
    if (!top->is_object) {
        if (!cJSON_AddItemToArray(top->node, node)) {
            cJSON_Delete(node);
            return AH_ERR_NOMEM;
        }
        return AH_OK;
    }
    if (!cJSON_AddItemToObject(top->node, top->key, node)) {
        cJSON_Delete(node);
        return AH_ERR_NOMEM;
    }
    free(top->key);
    top->key = NULL;
    top->count++;
    return AH_OK;
}

static ah_status push_frame(parser *p, cJSON *node, bool is_object) {
    if (p->depth >= AH_JSON_MAX_DEPTH) {
        return AH_ERR_LIMIT;
    }
    if (p->depth == p->stack_cap) {
        size_t cap = p->stack_cap == 0 ? 16 : p->stack_cap * 2;
        frame *f;
        if (cap > AH_JSON_MAX_DEPTH) {
            cap = AH_JSON_MAX_DEPTH;
        }
        f = realloc(p->stack, cap * sizeof *f);
        if (f == NULL) {
            return AH_ERR_NOMEM;
        }
        p->stack = f;
        p->stack_cap = cap;
    }
    p->stack[p->depth].node = node;
    p->stack[p->depth].is_object = is_object;
    p->stack[p->depth].count = 0;
    p->stack[p->depth].key = NULL;
    p->depth++;
    return AH_OK;
}

static ah_status pop_frame(parser *p) {
    frame *top = &p->stack[p->depth - 1];
    ah_status st = AH_OK;

    if (top->is_object) {
        st = dedupe_object(top->node, top->count);
    }
    free(top->key);
    top->key = NULL;
    p->depth--;
    return st;
}

enum parse_state { ST_VALUE, ST_KEY, ST_AFTER };

static ah_status parse_value_tree(parser *p) {
    enum parse_state state = ST_VALUE;
    ah_status st = AH_OK;

    for (;;) {
        skip_ws(p);
        if (state == ST_VALUE) {
            unsigned char c;
            if (p->i >= p->n) {
                return AH_ERR_INVALID;
            }
            c = p->s[p->i];
            if (c == '{' || c == '[') {
                bool obj = c == '{';
                cJSON *node = obj ? cJSON_CreateObject() : cJSON_CreateArray();
                if (p->depth >= AH_JSON_MAX_DEPTH) {
                    cJSON_Delete(node);
                    return AH_ERR_LIMIT;
                }
                st = attach(p, node);
                if (st == AH_OK) {
                    st = push_frame(p, node, obj);
                }
                if (st != AH_OK) {
                    return st;
                }
                p->i++;
                skip_ws(p);
                if (p->i < p->n && p->s[p->i] == (obj ? '}' : ']')) {
                    p->i++;
                    st = pop_frame(p);
                    if (st != AH_OK) {
                        return st;
                    }
                    state = ST_AFTER;
                } else {
                    state = obj ? ST_KEY : ST_VALUE;
                }
                continue;
            }
            if (c == '"') {
                st = parse_string(p);
                if (st == AH_OK) {
                    st = attach(p, cJSON_CreateString(p->scratch.data));
                }
            } else if (c == '-' || (c >= '0' && c <= '9')) {
                double d = 0.0;
                st = parse_number(p, &d);
                if (st == AH_OK) {
                    st = attach(p, cJSON_CreateNumber(d));
                }
            } else if (match_literal(p, "true")) {
                st = attach(p, cJSON_CreateTrue());
            } else if (match_literal(p, "false")) {
                st = attach(p, cJSON_CreateFalse());
            } else if (match_literal(p, "null")) {
                st = attach(p, cJSON_CreateNull());
            } else {
                st = AH_ERR_INVALID;
            }
            if (st != AH_OK) {
                return st;
            }
            state = ST_AFTER;
        } else if (state == ST_KEY) {
            frame *top = &p->stack[p->depth - 1];
            if (p->i >= p->n || p->s[p->i] != '"') {
                return AH_ERR_INVALID;
            }
            st = parse_string(p);
            if (st != AH_OK) {
                return st;
            }
            top->key = malloc(p->scratch.len + 1);
            if (top->key == NULL) {
                return AH_ERR_NOMEM;
            }
            memcpy(top->key, p->scratch.data, p->scratch.len + 1);
            skip_ws(p);
            if (p->i >= p->n || p->s[p->i] != ':') {
                return AH_ERR_INVALID;
            }
            p->i++;
            state = ST_VALUE;
        } else { /* ST_AFTER */
            frame *top;
            if (p->depth == 0) {
                return p->i == p->n ? AH_OK : AH_ERR_INVALID;
            }
            if (p->i >= p->n) {
                return AH_ERR_INVALID;
            }
            top = &p->stack[p->depth - 1];
            if (p->s[p->i] == ',') {
                p->i++;
                state = top->is_object ? ST_KEY : ST_VALUE;
            } else if (p->s[p->i] == (top->is_object ? '}' : ']')) {
                p->i++;
                st = pop_frame(p);
                if (st != AH_OK) {
                    return st;
                }
            } else {
                return AH_ERR_INVALID;
            }
        }
    }
}

ah_status ah_json_parse(const char *text, size_t len, ah_json **out) {
    parser p;
    ah_status st;
    size_t k;

    if (out == NULL) {
        return AH_ERR_INVALID;
    }
    *out = NULL;
    if (text == NULL) {
        return AH_ERR_INVALID;
    }
    memset(&p, 0, sizeof p);
    p.s = (const unsigned char *)text;
    p.n = len;
    ah_text_buf_init(&p.scratch, 0);

    st = parse_value_tree(&p);

    for (k = 0; k < p.depth; k++) {
        free(p.stack[k].key);
    }
    free(p.stack);
    ah_text_buf_free(&p.scratch);
    if (st == AH_OK && p.saw_nul) {
        st = AH_ERR_LIMIT; /* JSON válido, mas não representável aqui */
    }
    if (st != AH_OK) {
        cJSON_Delete(p.root);
        return st;
    }
    *out = A(p.root);
    return AH_OK;
}

ah_status ah_json_parse_or(const char *text, size_t len, const ah_json *fallback,
                           ah_json **out) {
    ah_json *v = NULL;
    ah_status st = AH_ERR_INVALID;

    if (out == NULL) {
        return AH_ERR_INVALID;
    }
    *out = NULL;
    if (text != NULL && len != 0) {
        st = ah_json_parse(text, len, &v);
        if (st == AH_ERR_NOMEM || st == AH_ERR_LIMIT) {
            /* LIMIT não é "inválido": o TS leria esse texto. Quem chama decide;
             * o padrão não é aplicado em silêncio. */
            return st;
        }
        if (st == AH_OK && item_type(J(v)) == cJSON_NULL) {
            ah_json_free(v);
            v = NULL;
            st = AH_ERR_INVALID;
        }
    }
    if (st == AH_OK) {
        *out = v;
        return AH_OK;
    }
    if (fallback == NULL) {
        return AH_OK;
    }
    *out = ah_json_duplicate(fallback);
    return *out == NULL ? AH_ERR_NOMEM : AH_OK;
}

/* ======================================================================
 * Escrita
 * ====================================================================== */

/* true se m × 10^q, lido pelo strtod, volta exatamente a `x` (> 0). O texto
 * "<m>e<q>" não tem separador decimal, então não depende do locale. */
static bool round_trips(uint64_t m, long q, double x) {
    char t[48];
    int w = snprintf(t, sizeof t, "%llue%ld", (unsigned long long)m, q);
    return w > 0 && (size_t)w < sizeof t && strtod(t, NULL) == x;
}

/* Dígitos do Number::toString(10) do ECMAScript (ECMA-262): "let n, k, and s
 * be integers such that k >= 1, 10^(k-1) <= s < 10^k, s × 10^(n-k) is x, and
 * k is as small as possible"; havendo mais de um s, o mais próximo de x.
 * Para cada precisão p de 1 a 17, o candidato c é o "%.*e" de p dígitos (o
 * decimal de p dígitos mais próximo de x). Se c não faz ida e volta, o
 * vizinho c+1 ou c-1 ainda pode fazer: nas potências de 2 o intervalo que
 * arredonda para x é assimétrico (a metade de baixo tem metade do tamanho),
 * e o decimal mais próximo pode cair fora dele enquanto o vizinho cai
 * dentro (ex.: 2^-24 = 5.9604644775390625e-8 sai 5.960464477539063e-8).
 * Basta olhar ±1: o intervalo é contíguo e contém x, então se c+2 estivesse
 * dentro, c+1 também estaria. Sai em `digits` (k dígitos, sem zeros à
 * direita) e em *n_out a posição do ponto decimal (valor = 0.digits × 10^n). */
static ah_status shortest_digits(double ax, char *digits, size_t digits_size, size_t *k_out,
                                 long *n_out) {
    char tmp[64];
    int prec;

    for (prec = 1; prec <= 17; prec++) {
        uint64_t m = 0;
        long q;
        const char *e;
        size_t t;
        int w = snprintf(tmp, sizeof tmp, "%.*e", prec - 1, ax);
        if (w < 0 || (size_t)w >= sizeof tmp) {
            return AH_ERR_INTERNAL;
        }
        /* tmp = "d[<ponto do locale>ddd]e<sinal>dd": mantissa inteira m e
         * expoente q, com valor m × 10^q. */
        e = strchr(tmp, 'e');
        if (e == NULL) {
            return AH_ERR_INTERNAL;
        }
        for (t = 0; tmp + t < e; t++) {
            if (tmp[t] >= '0' && tmp[t] <= '9') {
                m = m * 10 + (uint64_t)(tmp[t] - '0'); /* até 17 dígitos: cabe */
            }
        }
        q = strtol(e + 1, NULL, 10) - (prec - 1);
        if (!round_trips(m, q, ax)) {
            if (round_trips(m + 1, q, ax)) {
                m++;
            } else if (m > 1 && round_trips(m - 1, q, ax)) {
                m--;
            } else {
                continue;
            }
        }
        while (m % 10 == 0) {
            m /= 10;
            q++;
        }
        w = snprintf(digits, digits_size, "%llu", (unsigned long long)m);
        if (w <= 0 || (size_t)w >= digits_size) {
            return AH_ERR_INTERNAL;
        }
        *k_out = (size_t)w;
        *n_out = q + (long)w;
        return AH_OK;
    }
    return AH_ERR_INTERNAL; /* 17 dígitos sempre fazem ida e volta */
}

/* Number::toString(10): escolhe a forma (inteira, decimal ou exponencial)
 * pela posição n do ponto decimal, como a especificação manda. */
static ah_status append_number(ah_text_buf *b, double x) {
    char digits[24];
    char out[64];
    size_t k = 0;
    long n = 0;
    size_t o = 0;
    ah_status st;

    if (isnan(x) || isinf(x)) {
        return ah_text_buf_append(b, "null", 4);
    }
    if (x == 0.0) {
        return ah_text_buf_append_char(b, '0'); /* inclui -0 */
    }
    st = shortest_digits(fabs(x), digits, sizeof digits, &k, &n);
    if (st != AH_OK) {
        return st;
    }

    if (x < 0) {
        out[o++] = '-';
    }
    if ((long)k <= n && n <= 21) {
        long z;
        memcpy(out + o, digits, k);
        o += k;
        for (z = 0; z < n - (long)k; z++) {
            out[o++] = '0';
        }
    } else if (0 < n && n <= 21) {
        memcpy(out + o, digits, (size_t)n);
        o += (size_t)n;
        out[o++] = '.';
        memcpy(out + o, digits + n, k - (size_t)n);
        o += k - (size_t)n;
    } else if (-6 < n && n <= 0) {
        long z;
        out[o++] = '0';
        out[o++] = '.';
        for (z = 0; z < -n; z++) {
            out[o++] = '0';
        }
        memcpy(out + o, digits, k);
        o += k;
    } else {
        int w;
        out[o++] = digits[0];
        if (k > 1) {
            out[o++] = '.';
            memcpy(out + o, digits + 1, k - 1);
            o += k - 1;
        }
        w = snprintf(out + o, sizeof out - o, "e%c%ld", n - 1 >= 0 ? '+' : '-',
                     n - 1 >= 0 ? n - 1 : -(n - 1));
        if (w < 0 || (size_t)w >= sizeof out - o) {
            return AH_ERR_INTERNAL;
        }
        o += (size_t)w;
    }
    return ah_text_buf_append(b, out, o);
}

/* Chave que é índice de array no JS ("0".."4294967294", forma canônica):
 * o JS as põe antes das demais, em ordem numérica (OrdinaryOwnPropertyKeys). */
static bool array_index_key(const char *key, uint32_t *out) {
    uint64_t v = 0;
    size_t i;

    if (key[0] == '\0' || (key[0] == '0' && key[1] != '\0')) {
        return false;
    }
    for (i = 0; key[i] != '\0'; i++) {
        if (key[i] < '0' || key[i] > '9' || i >= 10) {
            return false;
        }
        v = v * 10 + (uint64_t)(key[i] - '0');
    }
    if (v > 4294967294u) {
        return false;
    }
    *out = (uint32_t)v;
    return true;
}

typedef struct index_entry {
    uint32_t index;
    const cJSON *item;
} index_entry;

static int compare_index_entry(const void *a, const void *b) {
    const index_entry *x = a;
    const index_entry *y = b;
    return (x->index > y->index) - (x->index < y->index);
}

static ah_status write_value(ah_text_buf *b, const cJSON *v, size_t depth);

static ah_status write_member(ah_text_buf *b, const cJSON *m, bool *first, size_t depth) {
    ah_status st = AH_OK;

    if (!*first) {
        st = ah_text_buf_append_char(b, ',');
    }
    *first = false;
    if (st == AH_OK) {
        st = ah_text_append_json_string(b, m->string, strlen(m->string));
    }
    if (st == AH_OK) {
        st = ah_text_buf_append_char(b, ':');
    }
    if (st == AH_OK) {
        st = write_value(b, m, depth + 1);
    }
    return st;
}

static ah_status write_object(ah_text_buf *b, const cJSON *v, size_t depth) {
    const cJSON *m;
    size_t n_index = 0;
    bool first = true;
    ah_status st;
    uint32_t idx;

    for (m = v->child; m != NULL; m = m->next) {
        if (m->string == NULL) {
            return AH_ERR_INVALID;
        }
        if (array_index_key(m->string, &idx)) {
            n_index++;
        }
    }
    st = ah_text_buf_append_char(b, '{');
    if (st == AH_OK && n_index > 0) {
        index_entry *e;
        size_t k = 0;
        if (n_index > SIZE_MAX / sizeof *e) {
            return AH_ERR_LIMIT;
        }
        e = malloc(n_index * sizeof *e);
        if (e == NULL) {
            return AH_ERR_NOMEM;
        }
        for (m = v->child; m != NULL; m = m->next) {
            if (array_index_key(m->string, &idx)) {
                e[k].index = idx;
                e[k].item = m;
                k++;
            }
        }
        qsort(e, k, sizeof *e, compare_index_entry);
        for (size_t i = 0; st == AH_OK && i < k; i++) {
            st = write_member(b, e[i].item, &first, depth);
        }
        free(e);
    }
    for (m = v->child; st == AH_OK && m != NULL; m = m->next) {
        if (n_index == 0 || !array_index_key(m->string, &idx)) {
            st = write_member(b, m, &first, depth);
        }
    }
    if (st == AH_OK) {
        st = ah_text_buf_append_char(b, '}');
    }
    return st;
}

/* `depth` = contêineres já abertos em volta de `v` (0 na raiz). Como no
 * parser, só contêiner conta: o contêiner que levaria a mais de
 * AH_JSON_MAX_DEPTH níveis é recusado; escalar não soma nível. */
static ah_status write_value(ah_text_buf *b, const cJSON *v, size_t depth) {
    int t = item_type(v);
    if ((t == cJSON_Array || t == cJSON_Object) && depth >= AH_JSON_MAX_DEPTH) {
        return AH_ERR_LIMIT;
    }
    switch (t) {
    case cJSON_NULL:
        return ah_text_buf_append(b, "null", 4);
    case cJSON_True:
        return ah_text_buf_append(b, "true", 4);
    case cJSON_False:
        return ah_text_buf_append(b, "false", 5);
    case cJSON_Number:
        return append_number(b, v->valuedouble);
    case cJSON_String:
        if (v->valuestring == NULL) {
            return AH_ERR_INVALID;
        }
        return ah_text_append_json_string(b, v->valuestring, strlen(v->valuestring));
    case cJSON_Array: {
        const cJSON *c;
        ah_status st = ah_text_buf_append_char(b, '[');
        for (c = v->child; st == AH_OK && c != NULL; c = c->next) {
            if (c != v->child) {
                st = ah_text_buf_append_char(b, ',');
            }
            if (st == AH_OK) {
                st = write_value(b, c, depth + 1);
            }
        }
        if (st == AH_OK) {
            st = ah_text_buf_append_char(b, ']');
        }
        return st;
    }
    case cJSON_Object:
        return write_object(b, v, depth);
    default:
        return AH_ERR_INVALID; /* cJSON_Raw/Invalid: o Hub nunca cria */
    }
}

ah_status ah_json_stringify(const ah_json *value, char **out, size_t *out_len) {
    ah_text_buf b;
    ah_status st;

    if (out == NULL) {
        return AH_ERR_INVALID;
    }
    *out = NULL;
    ah_text_buf_init(&b, 0);
    if (value == NULL) {
        st = ah_text_buf_append(&b, "null", 4);
    } else {
        st = write_value(&b, CJ(value), 0);
    }
    if (st != AH_OK) {
        ah_text_buf_free(&b);
        return st;
    }
    *out = ah_text_buf_take(&b, out_len);
    return *out == NULL ? AH_ERR_NOMEM : AH_OK;
}

/* ======================================================================
 * Acesso e construção
 * ====================================================================== */

ah_json_type ah_json_type_of(const ah_json *v) {
    switch (item_type(CJ(v))) {
    case cJSON_True:
    case cJSON_False:
        return AH_JSON_BOOL;
    case cJSON_Number:
        return AH_JSON_NUMBER;
    case cJSON_String:
        return AH_JSON_STRING;
    case cJSON_Array:
        return AH_JSON_ARRAY;
    case cJSON_Object:
        return AH_JSON_OBJECT;
    default:
        return AH_JSON_NULL;
    }
}

const char *ah_json_string(const ah_json *v) {
    if (v == NULL || item_type(CJ(v)) != cJSON_String) {
        return NULL;
    }
    return CJ(v)->valuestring;
}

bool ah_json_number(const ah_json *v, double *out) {
    if (v == NULL || out == NULL || item_type(CJ(v)) != cJSON_Number) {
        return false;
    }
    *out = CJ(v)->valuedouble;
    return true;
}

bool ah_json_bool(const ah_json *v, bool *out) {
    int t;
    if (v == NULL || out == NULL) {
        return false;
    }
    t = item_type(CJ(v));
    if (t != cJSON_True && t != cJSON_False) {
        return false;
    }
    *out = t == cJSON_True;
    return true;
}

const ah_json *ah_json_get(const ah_json *obj, const char *key) {
    const cJSON *m;
    if (obj == NULL || key == NULL || item_type(CJ(obj)) != cJSON_Object) {
        return NULL;
    }
    for (m = CJ(obj)->child; m != NULL; m = m->next) {
        if (m->string != NULL && strcmp(m->string, key) == 0) {
            return CA(m);
        }
    }
    return NULL;
}

size_t ah_json_count(const ah_json *v) {
    const cJSON *c;
    size_t n = 0;
    int t;
    if (v == NULL) {
        return 0;
    }
    t = item_type(CJ(v));
    if (t != cJSON_Array && t != cJSON_Object) {
        return 0;
    }
    for (c = CJ(v)->child; c != NULL; c = c->next) {
        n++;
    }
    return n;
}

const ah_json *ah_json_first(const ah_json *v) {
    int t;
    if (v == NULL) {
        return NULL;
    }
    t = item_type(CJ(v));
    if (t != cJSON_Array && t != cJSON_Object) {
        return NULL;
    }
    return CA(CJ(v)->child);
}

const ah_json *ah_json_next(const ah_json *item) {
    return item == NULL ? NULL : CA(CJ(item)->next);
}

const char *ah_json_key(const ah_json *member) {
    return member == NULL ? NULL : CJ(member)->string;
}

ah_json *ah_json_new_null(void) { return A(cJSON_CreateNull()); }
ah_json *ah_json_new_bool(bool b) { return A(cJSON_CreateBool(b ? 1 : 0)); }
ah_json *ah_json_new_number(double n) {
    /* cJSON_CreateNumber faz (int)num para o valueint (cJSON.c:2509), o que é
     * comportamento indefinido com NaN (o UBSan acusa). Cria com 0 e grava o
     * double direto; o valueint não é usado pelo Hub. */
    cJSON *c = cJSON_CreateNumber(isnan(n) ? 0.0 : n);
    if (c != NULL) {
        c->valuedouble = n;
    }
    return A(c);
}
ah_json *ah_json_new_string(const char *s) { return s == NULL ? NULL : A(cJSON_CreateString(s)); }
ah_json *ah_json_new_array(void) { return A(cJSON_CreateArray()); }
ah_json *ah_json_new_object(void) { return A(cJSON_CreateObject()); }

/* Tira a chave de um item solto, para ah_json_key só responder em membro. */
static void clear_key(cJSON *v) {
    if (v->string != NULL && !(v->type & cJSON_StringIsConst)) {
        cJSON_free(v->string);
    }
    v->string = NULL;
    v->type &= ~cJSON_StringIsConst;
}

ah_json *ah_json_duplicate(const ah_json *v) {
    cJSON *c;
    if (v == NULL) {
        return NULL;
    }
    c = cJSON_Duplicate(CJ(v), 1);
    if (c != NULL) {
        clear_key(c);
    }
    return A(c);
}

ah_status ah_json_set(ah_json *obj, const char *key, ah_json *value) {
    cJSON *o;
    cJSON *m;
    cJSON *val;

    if (obj == NULL || key == NULL || value == NULL || obj == value ||
        item_type(J(obj)) != cJSON_Object) {
        return AH_ERR_INVALID;
    }
    o = J(obj);
    val = J(value);
    for (m = o->child; m != NULL; m = m->next) {
        if (m->string != NULL && strcmp(m->string, key) == 0) {
            break;
        }
    }
    if (m == NULL) {
        return cJSON_AddItemToObject(o, key, val) ? AH_OK : AH_ERR_NOMEM;
    }
    {
        size_t len = strlen(key);
        char *k = cJSON_malloc(len + 1);
        if (k == NULL) {
            return AH_ERR_NOMEM;
        }
        memcpy(k, key, len + 1);
        clear_key(val);
        val->string = k;
    }
    return cJSON_ReplaceItemViaPointer(o, m, val) ? AH_OK : AH_ERR_INTERNAL;
}

ah_status ah_json_push(ah_json *arr, ah_json *value) {
    if (arr == NULL || value == NULL || arr == value || item_type(J(arr)) != cJSON_Array) {
        return AH_ERR_INVALID;
    }
    clear_key(J(value));
    return cJSON_AddItemToArray(J(arr), J(value)) ? AH_OK : AH_ERR_NOMEM;
}

void ah_json_free(ah_json *v) { cJSON_Delete(J(v)); }
