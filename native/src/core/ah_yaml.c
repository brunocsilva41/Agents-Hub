#include "ah_yaml.h"

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

typedef struct open_frame {
    ah_yaml_node *node;
    size_t expanded_at_start;
    size_t max_child_height;
    char *anchor; /* registrada só no fim da coleção: alias para coleção aberta é recusado */
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

/* Anexa `child` (novo ou apontado por alias) ao topo, ou o faz raiz. */
static ah_status attach(loader *l, const ah_yaml_node *child) {
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
    if (parent->kind == AH_YAML_MAPPING && parent->count % 2 == 0 &&
        child->kind != AH_YAML_SCALAR) {
        return fail(l, AH_ERR_INVALID, "chave de mapa YAML que nao e escalar");
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
    return attach(l, n);
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
    return attach(l, s->node);
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
        st = attach(l, n);
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
    if (f->anchor != NULL) {
        st = anchor_put(l, f->anchor, n);
        free(f->anchor);
        f->anchor = NULL;
    }
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
