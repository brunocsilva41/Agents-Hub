#include "ah_yaml.h"

#include <locale.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "yaml.h"

struct ah_yaml_node {
    ah_yaml_kind kind;
    ah_yaml_style style;
    char *text; /* escalar: cópia terminada em NUL */
    size_t text_len;
    char *tag;
    /* Sequência: itens. Mapa: chave, valor, chave, valor... */
    const ah_yaml_node **items;
    size_t count;
    size_t cap;
    size_t weight; /* nós expandidos desta subárvore (inclui ele mesmo) */
    size_t height; /* níveis desta subárvore (escalar = 1) */
};

struct ah_yaml_doc {
    const ah_yaml_node *root;
    ah_yaml_node **all; /* todo nó alocado, para liberar uma vez só */
    size_t n_all;
    size_t cap_all;
};

typedef struct anchor_slot {
    char *name;
    const ah_yaml_node *node;
} anchor_slot;

/* Identidade de uma chave de mapa para achar repetição, como o `yaml` 2.9.1
 * do TS (compose/util-map-includes.js): duas chaves são iguais se ambas são
 * escalares (não alias) e o VALOR tipado é igual (===), no esquema core do
 * YAML 1.2 (arquivos de dist/schema/core/ do pacote). Ex.: `1` e `01` são iguais (número 1); `1` e
 * `"1"` não (número e texto); `~` e `null` são iguais. */
typedef enum key_class {
    KEY_SKIP, /* não entra na comparação: alias, tag explícita que não é !!str, .nan */
    KEY_NULL,
    KEY_BOOL,
    KEY_NUMBER,
    KEY_STRING
} key_class;

typedef struct key_id {
    key_class cls;
    bool boolean;
    double number;
    const char *text; /* KEY_STRING: texto do nó (pertence ao documento) */
    size_t len;
} key_id;

typedef struct open_frame {
    ah_yaml_node *node;
    size_t expanded_at_start;
    size_t max_child_height;
    char *anchor; /* registrada só no fim da coleção: alias para coleção aberta é recusado */
    key_id *keys; /* só mapa: identidade de cada chave, conferida no fim */
    size_t n_keys;
    size_t cap_keys;
} open_frame;

typedef struct loader {
    ah_yaml_limits lim;
    ah_yaml_doc *doc;
    open_frame *stack;
    size_t depth;
    size_t stack_cap;
    anchor_slot *anchors; /* tabela hash, endereçamento aberto */
    size_t anchor_cap;    /* potência de 2 */
    size_t anchor_used;
    size_t expanded;
    size_t aliases;
    char *err;
    size_t err_size;
} loader;

void ah_yaml_limits_default(ah_yaml_limits *lim) {
    lim->max_bytes = AH_YAML_DEFAULT_MAX_BYTES;
    lim->max_depth = AH_YAML_DEFAULT_MAX_DEPTH;
    lim->max_nodes = AH_YAML_DEFAULT_MAX_NODES;
    lim->max_aliases = AH_YAML_DEFAULT_MAX_ALIASES;
}

static ah_status fail(loader *l, ah_status st, const char *msg) {
    if (l->err != NULL && l->err_size > 0) {
        int w = snprintf(l->err, l->err_size, "%s", msg);
        if (w < 0) {
            l->err[0] = '\0';
        }
    }
    return st;
}

static char *dup_bytes(const void *src, size_t len) {
    char *p;
    if (len == SIZE_MAX) {
        return NULL;
    }
    p = malloc(len + 1);
    if (p == NULL) {
        return NULL;
    }
    if (len != 0) {
        memcpy(p, src, len);
    }
    p[len] = '\0';
    return p;
}

/* Garante capacidade para `need` elementos de `elem` bytes. Em AH_OK, *out
 * recebe o vetor (talvez realocado) e *cap a nova capacidade; em erro, o vetor
 * antigo continua válido e *out não é escrito. */
static ah_status reserve(void *arr, size_t *cap, size_t need, size_t elem, void **out) {
    size_t c;
    void *p;
    if (need <= *cap) {
        *out = arr;
        return AH_OK;
    }
    c = *cap == 0 ? 8 : *cap;
    while (c < need) {
        if (c > SIZE_MAX / 2 / elem) {
            return AH_ERR_LIMIT;
        }
        c *= 2;
    }
    p = realloc(arr, c * elem);
    if (p == NULL) {
        return AH_ERR_NOMEM;
    }
    *out = p;
    *cap = c;
    return AH_OK;
}

static ah_status new_node(loader *l, ah_yaml_kind kind, const yaml_char_t *tag, ah_yaml_node **out) {
    ah_yaml_doc *d = l->doc;
    ah_yaml_node *n = NULL;
    void *grown = NULL;
    ah_status st;

    st = reserve(d->all, &d->cap_all, d->n_all + 1, sizeof *d->all, &grown);
    if (st != AH_OK) {
        return st;
    }
    d->all = grown;
    n = calloc(1, sizeof *n);
    if (n == NULL) {
        return AH_ERR_NOMEM;
    }
    d->all[d->n_all++] = n;
    n->kind = kind;
    n->style = AH_YAML_PLAIN;
    n->weight = 1;
    n->height = 1;
    if (tag != NULL) {
        n->tag = dup_bytes(tag, strlen((const char *)tag));
        if (n->tag == NULL) {
            return AH_ERR_NOMEM;
        }
    }
    *out = n;
    return AH_OK;
}

/* ---- âncoras: hash FNV-1a, a última definição vence (YAML permite redefinir) */

static size_t hash_name(const char *s) {
    uint64_t h = 1469598103934665603ull;
    while (*s != '\0') {
        h ^= (unsigned char)*s++;
        h *= 1099511628211ull;
    }
    return (size_t)h;
}

static anchor_slot *anchor_find(loader *l, const char *name) {
    size_t i;
    if (l->anchor_cap == 0) {
        return NULL;
    }
    i = hash_name(name) & (l->anchor_cap - 1);
    while (l->anchors[i].name != NULL) {
        if (strcmp(l->anchors[i].name, name) == 0) {
            return &l->anchors[i];
        }
        i = (i + 1) & (l->anchor_cap - 1);
    }
    return NULL;
}

static ah_status anchor_put(loader *l, const char *name, const ah_yaml_node *node) {
    anchor_slot *s = anchor_find(l, name);
    size_t i;

    if (s != NULL) {
        s->node = node;
        return AH_OK;
    }
    if ((l->anchor_used + 1) * 2 > l->anchor_cap) {
        size_t cap = l->anchor_cap == 0 ? 16 : l->anchor_cap * 2;
        anchor_slot *t;
        size_t k;
        if (cap > SIZE_MAX / sizeof *t) {
            return AH_ERR_LIMIT;
        }
        t = calloc(cap, sizeof *t);
        if (t == NULL) {
            return AH_ERR_NOMEM;
        }
        for (k = 0; k < l->anchor_cap; k++) {
            if (l->anchors[k].name != NULL) {
                size_t j = hash_name(l->anchors[k].name) & (cap - 1);
                while (t[j].name != NULL) {
                    j = (j + 1) & (cap - 1);
                }
                t[j] = l->anchors[k];
            }
        }
        free(l->anchors);
        l->anchors = t;
        l->anchor_cap = cap;
    }
    i = hash_name(name) & (l->anchor_cap - 1);
    while (l->anchors[i].name != NULL) {
        i = (i + 1) & (l->anchor_cap - 1);
    }
    l->anchors[i].name = dup_bytes(name, strlen(name));
    if (l->anchors[i].name == NULL) {
        return AH_ERR_NOMEM;
    }
    l->anchors[i].node = node;
    l->anchor_used++;
    return AH_OK;
}

/* ---- montagem ---------------------------------------------------------- */

/* Soma `weight` nós expandidos e confere o teto. */
static ah_status count_nodes(loader *l, size_t weight) {
    if (weight > l->lim.max_nodes || l->expanded > l->lim.max_nodes - weight) {
        return fail(l, AH_ERR_LIMIT, "YAML excede o teto de nos expandidos");
    }
    l->expanded += weight;
    return AH_OK;
}

/* Profundidade que `height` níveis atingem a partir da posição atual. */
static ah_status check_depth(loader *l, size_t height) {
    if (height > l->lim.max_depth || l->depth > l->lim.max_depth - height) {
        return fail(l, AH_ERR_LIMIT, "YAML excede o teto de profundidade");
    }
    return AH_OK;
}

/* ---- identidade de chave (esquema core do YAML 1.2, como o yaml 2.9.1) -- */

static bool is_digit(char c) { return c >= '0' && c <= '9'; }

static bool text_is(const char *s, size_t len, const char *lit) {
    return strlen(lit) == len && memcmp(s, lit, len) == 0;
}

/* Converte com strtod trocando o '.' pelo separador do locale (como o
 * parser de JSON faz). `s` já passou pela gramática de número. */
static bool to_double(const char *s, size_t len, double *out) {
    char buf[128];
    char *end = NULL;
    const struct lconv *lc = localeconv();
    char point = (lc != NULL && lc->decimal_point != NULL && lc->decimal_point[0] != '\0')
                     ? lc->decimal_point[0]
                     : '.';
    size_t i;
    if (len >= sizeof buf) {
        return false; /* número enorme como chave: fica como texto */
    }
    for (i = 0; i < len; i++) {
        buf[i] = s[i] == '.' ? point : s[i];
    }
    buf[len] = '\0';
    *out = strtod(buf, &end);
    return end == buf + len;
}

/* Inteiro sem sinal na base `radix` (8 ou 16) depois do prefixo 0o/0x. */
static bool radix_int(const char *s, size_t len, unsigned radix, double *out) {
    double v = 0;
    size_t i;
    if (len == 0) {
        return false;
    }
    for (i = 0; i < len; i++) {
        unsigned d;
        char c = s[i];
        if (c >= '0' && c <= '9') {
            d = (unsigned)(c - '0');
        } else if (c >= 'a' && c <= 'f') {
            d = (unsigned)(c - 'a' + 10);
        } else if (c >= 'A' && c <= 'F') {
            d = (unsigned)(c - 'A' + 10);
        } else {
            return false;
        }
        if (d >= radix) {
            return false;
        }
        v = v * radix + d;
    }
    *out = v;
    return true;
}

/* Gramática dos floats do esquema core:
 *   /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/   (floatExp)
 *   /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/                         (float)
 * Inteiro sem ponto nem expoente já foi resolvido antes, como no yaml. */
static bool is_core_float(const char *s, size_t len) {
    size_t i = 0;
    size_t d;
    bool dot = false;
    bool exp = false;
    if (i < len && (s[i] == '+' || s[i] == '-')) {
        i++;
    }
    if (i < len && s[i] == '.') {
        dot = true;
        d = ++i;
        while (i < len && is_digit(s[i])) {
            i++;
        }
        if (i == d) {
            return false;
        }
    } else {
        d = i;
        while (i < len && is_digit(s[i])) {
            i++;
        }
        if (i == d) {
            return false;
        }
        if (i < len && s[i] == '.') {
            dot = true;
            i++;
            while (i < len && is_digit(s[i])) {
                i++;
            }
        }
    }
    if (i < len && (s[i] == 'e' || s[i] == 'E')) {
        exp = true;
        i++;
        if (i < len && (s[i] == '+' || s[i] == '-')) {
            i++;
        }
        d = i;
        while (i < len && is_digit(s[i])) {
            i++;
        }
        if (i == d) {
            return false;
        }
    }
    return i == len && (dot || exp);
}

static key_id classify_key(const ah_yaml_node *k, bool via_alias) {
    key_id id;
    const char *s = k->text;
    size_t len = k->text_len;
    size_t i;

    memset(&id, 0, sizeof id);
    id.cls = KEY_SKIP;
    if (via_alias) {
        return id; /* o yaml compara alias por identidade de nó: nunca repete */
    }
    if (k->tag != NULL) {
        if (strcmp(k->tag, "tag:yaml.org,2002:str") == 0) {
            id.cls = KEY_STRING;
            id.text = s;
            id.len = len;
        }
        return id;
    }
    if (k->style != AH_YAML_PLAIN) {
        id.cls = KEY_STRING;
        id.text = s;
        id.len = len;
        return id;
    }
    /* null: /^(?:~|[Nn]ull|NULL)?$/ */
    if (len == 0 || text_is(s, len, "~") || text_is(s, len, "null") ||
        text_is(s, len, "Null") || text_is(s, len, "NULL")) {
        id.cls = KEY_NULL;
        return id;
    }
    /* bool: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/ */
    if (text_is(s, len, "true") || text_is(s, len, "True") || text_is(s, len, "TRUE")) {
        id.cls = KEY_BOOL;
        id.boolean = true;
        return id;
    }
    if (text_is(s, len, "false") || text_is(s, len, "False") || text_is(s, len, "FALSE")) {
        id.cls = KEY_BOOL;
        return id;
    }
    /* int: /^0o[0-7]+$/, /^[-+]?[0-9]+$/, /^0x[0-9a-fA-F]+$/ */
    if (len > 2 && s[0] == '0' && s[1] == 'o' && radix_int(s + 2, len - 2, 8, &id.number)) {
        id.cls = KEY_NUMBER;
        return id;
    }
    i = (s[0] == '+' || s[0] == '-') ? 1 : 0;
    if (i < len) {
        size_t j = i;
        while (j < len && is_digit(s[j])) {
            j++;
        }
        if (j == len && to_double(s, len, &id.number)) {
            id.cls = KEY_NUMBER;
            return id;
        }
    }
    if (len > 2 && s[0] == '0' && s[1] == 'x' && radix_int(s + 2, len - 2, 16, &id.number)) {
        id.cls = KEY_NUMBER;
        return id;
    }
    /* floatNaN: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/ */
    if (text_is(s, len, ".nan") || text_is(s, len, ".NaN") || text_is(s, len, ".NAN")) {
        return id; /* NaN !== NaN: nunca repete */
    }
    i = (s[0] == '+' || s[0] == '-') ? 1 : 0;
    if (text_is(s + i, len - i, ".inf") || text_is(s + i, len - i, ".Inf") ||
        text_is(s + i, len - i, ".INF")) {
        id.cls = KEY_NUMBER;
        id.number = s[0] == '-' ? -HUGE_VAL : HUGE_VAL;
        return id;
    }
    if (is_core_float(s, len) && to_double(s, len, &id.number)) {
        id.cls = KEY_NUMBER;
        return id;
    }
    id.cls = KEY_STRING;
    id.text = s;
    id.len = len;
    return id;
}

static int compare_key_id(const void *pa, const void *pb) {
    const key_id *a = pa;
    const key_id *b = pb;
    int c;
    if (a->cls != b->cls) {
        return a->cls < b->cls ? -1 : 1;
    }
    switch (a->cls) {
    case KEY_BOOL:
        return (int)a->boolean - (int)b->boolean;
    case KEY_NUMBER:
        return (a->number > b->number) - (a->number < b->number); /* 0 == -0, como === */
    case KEY_STRING:
        c = memcmp(a->text, b->text, a->len < b->len ? a->len : b->len);
        if (c != 0) {
            return c;
        }
        return (a->len > b->len) - (a->len < b->len);
    default:
        return 0;
    }
}

/* Recusa chave repetida no mapa que está fechando. O(n log n). */
static ah_status check_unique_keys(loader *l, open_frame *f) {
    size_t i;
    if (f->n_keys < 2) {
        return AH_OK;
    }
    qsort(f->keys, f->n_keys, sizeof *f->keys, compare_key_id);
    for (i = 1; i < f->n_keys; i++) {
        if (f->keys[i].cls != KEY_SKIP && compare_key_id(&f->keys[i - 1], &f->keys[i]) == 0) {
            return fail(l, AH_ERR_INVALID, "chave repetida no mapa YAML");
        }
    }
    return AH_OK;
}

/* Anexa `child` (novo, ou apontado por alias quando `via_alias`) ao topo, ou
 * o faz raiz. Chave de mapa tem a identidade guardada para a checagem de
 * repetição no fim do mapa. */
static ah_status attach(loader *l, const ah_yaml_node *child, bool via_alias) {
    open_frame *top;
    ah_yaml_node *parent;
    void *grown = NULL;
    ah_status st;

    if (l->depth == 0) {
        l->doc->root = child;
        return AH_OK;
    }
    top = &l->stack[l->depth - 1];
    parent = top->node;
    if (parent->kind == AH_YAML_MAPPING && parent->count % 2 == 0) {
        if (child->kind != AH_YAML_SCALAR) {
            return fail(l, AH_ERR_INVALID, "chave de mapa YAML que nao e escalar");
        }
        st = reserve(top->keys, &top->cap_keys, top->n_keys + 1, sizeof *top->keys, &grown);
        if (st != AH_OK) {
            return st;
        }
        top->keys = grown;
        top->keys[top->n_keys++] = classify_key(child, via_alias);
    }
    st = reserve((void *)parent->items, &parent->cap, parent->count + 1, sizeof *parent->items,
                 &grown);
    if (st != AH_OK) {
        return st;
    }
    parent->items = grown;
    parent->items[parent->count++] = child;
    if (child->height > top->max_child_height) {
        top->max_child_height = child->height;
    }
    return AH_OK;
}

static ah_status on_scalar(loader *l, const yaml_event_t *ev) {
    ah_yaml_node *n = NULL;
    ah_status st;

    st = check_depth(l, 1);
    if (st == AH_OK) {
        st = count_nodes(l, 1);
    }
    if (st == AH_OK) {
        st = new_node(l, AH_YAML_SCALAR, ev->data.scalar.tag, &n);
    }
    if (st != AH_OK) {
        return st;
    }
    n->text = dup_bytes(ev->data.scalar.value, ev->data.scalar.length);
    if (n->text == NULL) {
        return AH_ERR_NOMEM;
    }
    n->text_len = ev->data.scalar.length;
    switch (ev->data.scalar.style) {
    case YAML_SINGLE_QUOTED_SCALAR_STYLE: n->style = AH_YAML_SINGLE_QUOTED; break;
    case YAML_DOUBLE_QUOTED_SCALAR_STYLE: n->style = AH_YAML_DOUBLE_QUOTED; break;
    case YAML_LITERAL_SCALAR_STYLE: n->style = AH_YAML_LITERAL; break;
    case YAML_FOLDED_SCALAR_STYLE: n->style = AH_YAML_FOLDED; break;
    default: n->style = AH_YAML_PLAIN; break;
    }
    if (ev->data.scalar.anchor != NULL) {
        st = anchor_put(l, (const char *)ev->data.scalar.anchor, n);
        if (st != AH_OK) {
            return st;
        }
    }
    return attach(l, n, false);
}

static ah_status on_alias(loader *l, const yaml_event_t *ev) {
    anchor_slot *s;
    ah_status st;

    if (l->aliases >= l->lim.max_aliases) {
        return fail(l, AH_ERR_LIMIT, "YAML excede o teto de aliases");
    }
    l->aliases++;
    s = anchor_find(l, (const char *)ev->data.alias.anchor);
    if (s == NULL) {
        return fail(l, AH_ERR_INVALID, "alias YAML para ancora inexistente ou ainda aberta");
    }
    st = check_depth(l, s->node->height);
    if (st == AH_OK) {
        st = count_nodes(l, s->node->weight);
    }
    if (st != AH_OK) {
        return st;
    }
    return attach(l, s->node, true);
}

static ah_status on_collection_start(loader *l, ah_yaml_kind kind, const yaml_char_t *anchor,
                                     const yaml_char_t *tag) {
    ah_yaml_node *n = NULL;
    open_frame *f;
    void *grown = NULL;
    size_t start = l->expanded;
    ah_status st;

    st = check_depth(l, 1);
    if (st == AH_OK) {
        st = count_nodes(l, 1);
    }
    if (st == AH_OK) {
        st = new_node(l, kind, tag, &n);
    }
    if (st == AH_OK) {
        st = attach(l, n, false);
    }
    if (st == AH_OK) {
        st = reserve(l->stack, &l->stack_cap, l->depth + 1, sizeof *l->stack, &grown);
    }
    if (st != AH_OK) {
        return st;
    }
    l->stack = grown;
    f = &l->stack[l->depth++];
    f->node = n;
    f->expanded_at_start = start;
    f->max_child_height = 0;
    f->anchor = NULL;
    f->keys = NULL;
    f->n_keys = 0;
    f->cap_keys = 0;
    if (anchor != NULL) {
        f->anchor = dup_bytes(anchor, strlen((const char *)anchor));
        if (f->anchor == NULL) {
            return AH_ERR_NOMEM;
        }
    }
    return AH_OK;
}

static ah_status on_collection_end(loader *l) {
    open_frame *f;
    ah_yaml_node *n = NULL;
    ah_status st = AH_OK;

    if (l->depth == 0) {
        return fail(l, AH_ERR_INTERNAL, "fim de colecao YAML sem inicio");
    }
    f = &l->stack[--l->depth];
    n = f->node;
    n->weight = l->expanded - f->expanded_at_start;
    n->height = 1 + f->max_child_height;
    if (n->kind == AH_YAML_MAPPING) {
        st = check_unique_keys(l, f);
    }
    free(f->keys);
    f->keys = NULL;
    if (st == AH_OK && f->anchor != NULL) {
        st = anchor_put(l, f->anchor, n);
    }
    free(f->anchor);
    f->anchor = NULL;
    if (st == AH_OK && l->depth > 0 && n->height > l->stack[l->depth - 1].max_child_height) {
        l->stack[l->depth - 1].max_child_height = n->height;
    }
    return st;
}

static ah_status parser_failure(loader *l, const yaml_parser_t *p) {
    char msg[256];
    int w;

    if (p->error == YAML_MEMORY_ERROR) {
        return fail(l, AH_ERR_NOMEM, "sem memoria ao ler YAML");
    }
    w = snprintf(msg, sizeof msg, "YAML invalido: %s (linha %lu, coluna %lu)",
                 p->problem != NULL ? p->problem : "erro do parser",
                 (unsigned long)(p->problem_mark.line + 1),
                 (unsigned long)(p->problem_mark.column + 1));
    if (w < 0) {
        msg[0] = '\0';
    }
    return fail(l, AH_ERR_INVALID, msg);
}

static void doc_free(ah_yaml_doc *doc) {
    size_t i;
    if (doc == NULL) {
        return;
    }
    for (i = 0; i < doc->n_all; i++) {
        free(doc->all[i]->text);
        free(doc->all[i]->tag);
        free((void *)doc->all[i]->items);
        free(doc->all[i]);
    }
    free(doc->all);
    free(doc);
}

ah_status ah_yaml_load(const char *text, size_t len, const ah_yaml_limits *lim,
                       ah_yaml_doc **out, char *err, size_t err_size) {
    loader l;
    yaml_parser_t parser;
    ah_status st = AH_OK;
    bool done = false;
    unsigned documents = 0;
    size_t k;

    memset(&l, 0, sizeof l);
    l.err = err;
    l.err_size = err_size;
    if (err != NULL && err_size > 0) {
        err[0] = '\0';
    }
    if (out == NULL || (text == NULL && len != 0)) {
        return fail(&l, AH_ERR_INVALID, "argumento invalido");
    }
    *out = NULL;
    if (lim != NULL) {
        l.lim = *lim;
    } else {
        ah_yaml_limits_default(&l.lim);
    }
    if (len > l.lim.max_bytes) {
        return fail(&l, AH_ERR_LIMIT, "YAML excede o teto de tamanho do documento");
    }
    l.doc = calloc(1, sizeof *l.doc);
    if (l.doc == NULL) {
        return fail(&l, AH_ERR_NOMEM, "sem memoria ao ler YAML");
    }
    if (!yaml_parser_initialize(&parser)) {
        free(l.doc);
        return fail(&l, AH_ERR_NOMEM, "sem memoria ao iniciar o parser YAML");
    }
    yaml_parser_set_input_string(&parser, (const unsigned char *)(text != NULL ? text : ""), len);
    yaml_parser_set_encoding(&parser, YAML_UTF8_ENCODING);

    while (st == AH_OK && !done) {
        yaml_event_t ev;
        if (!yaml_parser_parse(&parser, &ev)) {
            st = parser_failure(&l, &parser);
            break;
        }
        switch (ev.type) {
        case YAML_STREAM_END_EVENT:
            done = true;
            break;
        case YAML_DOCUMENT_START_EVENT:
            if (++documents > 1) {
                st = fail(&l, AH_ERR_INVALID, "YAML com mais de um documento");
            }
            break;
        case YAML_ALIAS_EVENT:
            st = on_alias(&l, &ev);
            break;
        case YAML_SCALAR_EVENT:
            st = on_scalar(&l, &ev);
            break;
        case YAML_SEQUENCE_START_EVENT:
            st = on_collection_start(&l, AH_YAML_SEQUENCE, ev.data.sequence_start.anchor,
                                     ev.data.sequence_start.tag);
            break;
        case YAML_MAPPING_START_EVENT:
            st = on_collection_start(&l, AH_YAML_MAPPING, ev.data.mapping_start.anchor,
                                     ev.data.mapping_start.tag);
            break;
        case YAML_SEQUENCE_END_EVENT:
        case YAML_MAPPING_END_EVENT:
            st = on_collection_end(&l);
            break;
        default: /* STREAM_START, DOCUMENT_END, NO_EVENT */
            break;
        }
        yaml_event_delete(&ev);
    }
    yaml_parser_delete(&parser);

    for (k = 0; k < l.depth; k++) {
        free(l.stack[k].anchor);
        free(l.stack[k].keys);
    }
    free(l.stack);
    for (k = 0; k < l.anchor_cap; k++) {
        free(l.anchors[k].name);
    }
    free(l.anchors);
    if (st != AH_OK) {
        if (st == AH_ERR_NOMEM) {
            (void)fail(&l, st, "sem memoria ao ler YAML");
        }
        doc_free(l.doc);
        return st;
    }
    *out = l.doc;
    return AH_OK;
}

void ah_yaml_free(ah_yaml_doc *doc) { doc_free(doc); }

const ah_yaml_node *ah_yaml_root(const ah_yaml_doc *doc) { return doc == NULL ? NULL : doc->root; }

ah_yaml_kind ah_yaml_node_kind(const ah_yaml_node *node) { return node->kind; }

const char *ah_yaml_scalar(const ah_yaml_node *node, size_t *len) {
    if (node == NULL || node->kind != AH_YAML_SCALAR) {
        return NULL;
    }
    if (len != NULL) {
        *len = node->text_len;
    }
    return node->text;
}

ah_yaml_style ah_yaml_scalar_style(const ah_yaml_node *node) {
    return node == NULL ? AH_YAML_PLAIN : node->style;
}

const char *ah_yaml_tag(const ah_yaml_node *node) { return node == NULL ? NULL : node->tag; }

size_t ah_yaml_count(const ah_yaml_node *node) {
    if (node == NULL || node->kind == AH_YAML_SCALAR) {
        return 0;
    }
    return node->kind == AH_YAML_MAPPING ? node->count / 2 : node->count;
}

const ah_yaml_node *ah_yaml_seq_at(const ah_yaml_node *node, size_t i) {
    if (node == NULL || node->kind != AH_YAML_SEQUENCE || i >= node->count) {
        return NULL;
    }
    return node->items[i];
}

const ah_yaml_node *ah_yaml_map_key_at(const ah_yaml_node *node, size_t i) {
    if (node == NULL || node->kind != AH_YAML_MAPPING || i >= node->count / 2) {
        return NULL;
    }
    return node->items[2 * i];
}

const ah_yaml_node *ah_yaml_map_value_at(const ah_yaml_node *node, size_t i) {
    if (node == NULL || node->kind != AH_YAML_MAPPING || i >= node->count / 2) {
        return NULL;
    }
    return node->items[2 * i + 1];
}

const ah_yaml_node *ah_yaml_map_get(const ah_yaml_node *node, const char *key) {
    size_t i;
    size_t klen;
    if (node == NULL || key == NULL || node->kind != AH_YAML_MAPPING) {
        return NULL;
    }
    klen = strlen(key);
    for (i = 0; i + 1 < node->count; i += 2) {
        const ah_yaml_node *k = node->items[i];
        if (k->text_len == klen && memcmp(k->text, key, klen) == 0) {
            return node->items[i + 1];
        }
    }
    return NULL;
}
