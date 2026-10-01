/* Processos (F0-07): partes sem SO — montagem da linha de comando do
 * Windows (SPEC-08 P3), escape do cmd.exe (SPEC-04 B5, paridade com
 * escaparArgParaCmd/montarSpawn de packages/adapters/src/bin-resolver.ts) e
 * validações de caminho. Compila em toda plataforma. */
#include "ah_platform_proc_internal.h"

#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* --- buffer crescente --- */

typedef struct sbuf {
    char *p;
    size_t len;
    size_t cap;
    bool nomem;
} sbuf;

static void sb_reserve(sbuf *b, size_t extra) {
    if (b->nomem) {
        return;
    }
    if (extra > SIZE_MAX - b->len - 1) {
        b->nomem = true;
        return;
    }
    size_t need = b->len + extra + 1;
    if (need <= b->cap) {
        return;
    }
    size_t cap = b->cap ? b->cap : 64;
    while (cap < need) {
        if (cap > SIZE_MAX / 2) {
            cap = need;
            break;
        }
        cap *= 2;
    }
    char *np = realloc(b->p, cap);
    if (np == NULL) {
        b->nomem = true;
        return;
    }
    b->p = np;
    b->cap = cap;
}

static void sb_putc(sbuf *b, char c) {
    sb_reserve(b, 1);
    if (b->nomem) {
        return;
    }
    b->p[b->len++] = c;
    b->p[b->len] = '\0';
}

static void sb_put(sbuf *b, const char *s, size_t n) {
    sb_reserve(b, n);
    if (b->nomem) {
        return;
    }
    if (n > 0) {
        memcpy(b->p + b->len, s, n);
    }
    b->len += n;
    b->p[b->len] = '\0';
}

static void sb_repeat(sbuf *b, char c, size_t n) {
    for (size_t i = 0; i < n && !b->nomem; i++) {
        sb_putc(b, c);
    }
}

/* Entrega o texto ao chamador ou libera em caso de falta de memória. */
static ah_status sb_finish(sbuf *b, char **out) {
    if (b->nomem) {
        free(b->p);
        return AH_ERR_NOMEM;
    }
    if (b->p == NULL) {
        b->p = malloc(1);
        if (b->p == NULL) {
            return AH_ERR_NOMEM;
        }
        b->p[0] = '\0';
    }
    *out = b->p;
    return AH_OK;
}

/* --- utilitários internos compartilhados --- */

ah_status ah_proc_i_utf16_units(const char *s, size_t len, size_t *units) {
    const unsigned char *u = (const unsigned char *)s;
    size_t i = 0;
    size_t n = 0;
    while (i < len) {
        unsigned c = u[i];
        if (c < 0x80) {
            i++;
            n++;
            continue;
        }
        size_t extra;
        uint32_t cp;
        uint32_t min;
        if (c >= 0xC2 && c <= 0xDF) {
            extra = 1;
            cp = c & 0x1Fu;
            min = 0x80;
        } else if (c >= 0xE0 && c <= 0xEF) {
            extra = 2;
            cp = c & 0x0Fu;
            min = 0x800;
        } else if (c >= 0xF0 && c <= 0xF4) {
            extra = 3;
            cp = c & 0x07u;
            min = 0x10000;
        } else {
            return AH_ERR_INVALID;
        }
        if (len - i <= extra) {
            return AH_ERR_INVALID;
        }
        for (size_t k = 1; k <= extra; k++) {
            unsigned cc = u[i + k];
            if ((cc & 0xC0u) != 0x80u) {
                return AH_ERR_INVALID;
            }
            cp = (cp << 6) | (cc & 0x3Fu);
        }
        if (cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) {
            return AH_ERR_INVALID;
        }
        n += cp >= 0x10000 ? 2 : 1;
        i += extra + 1;
    }
    *units = n;
    return AH_OK;
}

static bool is_sep(char c) {
    return c == '\\' || c == '/';
}

bool ah_proc_i_win_is_absolute(const char *path) {
    if (path == NULL) {
        return false;
    }
    char c = path[0];
    bool letter = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
    if (letter && path[1] == ':' && is_sep(path[2])) {
        return true;
    }
    return is_sep(path[0]) && is_sep(path[1]);
}

static const char *last_component(const char *path) {
    const char *base = path;
    for (const char *q = path; *q != '\0'; q++) {
        if (is_sep(*q)) {
            base = q + 1;
        }
    }
    return base;
}

bool ah_proc_i_win_name_has_colon(const char *path) {
    return strchr(last_component(path), ':') != NULL;
}

static char lower_ascii(char c) {
    return (c >= 'A' && c <= 'Z') ? (char)(c - 'A' + 'a') : c;
}

bool ah_proc_i_win_is_batch(const char *path) {
    const char *base = last_component(path);
    size_t n = strlen(base);
    while (n > 0 && (base[n - 1] == '.' || base[n - 1] == ' ')) {
        n--;
    }
    if (n < 4 || base[n - 4] != '.') {
        return false;
    }
    char e[3] = {lower_ascii(base[n - 3]), lower_ascii(base[n - 2]),
                 lower_ascii(base[n - 1])};
    return (e[0] == 'b' && e[1] == 'a' && e[2] == 't') ||
           (e[0] == 'c' && e[1] == 'm' && e[2] == 'd');
}

ah_status ah_proc_i_arg(const char *const *args, const size_t *arg_lens,
                        size_t i, const char **s, size_t *len) {
    if (args == NULL || args[i] == NULL) {
        return AH_ERR_INVALID;
    }
    *s = args[i];
    if (arg_lens == NULL) {
        *len = strlen(args[i]);
        return AH_OK;
    }
    *len = arg_lens[i];
    if (memchr(args[i], '\0', arg_lens[i]) != NULL) {
        return AH_ERR_INVALID;
    }
    return AH_OK;
}

void ah_proc_i_detail(char *detail, size_t cap, const char *fmt, ...) {
    if (detail == NULL || cap == 0) {
        return;
    }
    va_list ap;
    va_start(ap, fmt);
    int r = vsnprintf(detail, cap, fmt, ap);
    va_end(ap);
    if (r < 0) {
        detail[0] = '\0';
    }
    detail[cap - 1] = '\0';
}

ah_status ah_proc_i_env_split(const char *entry, size_t *name_len) {
    if (entry == NULL || entry[0] == '\0') {
        return AH_ERR_INVALID;
    }
    const char *eq = strchr(entry + 1, '=');
    if (eq == NULL) {
        return AH_ERR_INVALID;
    }
    *name_len = (size_t)(eq - entry);
    return AH_OK;
}

/* --- P3: linha de comando do Windows --- */

/* Aspas da regra do CommandLineToArgvW, como quote_cmd_arg do libuv (o que
 * o Node usa com shell:false): só cita quando precisa; dentro das aspas, as
 * barras que antecedem '"' (ou o fim) são dobradas e o '"' vira \". */
static void quote_win_arg(sbuf *b, const char *s, size_t len) {
    if (len == 0) {
        sb_put(b, "\"\"", 2);
        return;
    }
    bool needs = false;
    for (size_t i = 0; i < len; i++) {
        if (s[i] == ' ' || s[i] == '\t' || s[i] == '"') {
            needs = true;
            break;
        }
    }
    if (!needs) {
        sb_put(b, s, len);
        return;
    }
    sb_putc(b, '"');
    size_t slashes = 0;
    for (size_t i = 0; i < len; i++) {
        char c = s[i];
        if (c == '\\') {
            slashes++;
            continue;
        }
        if (c == '"') {
            sb_repeat(b, '\\', slashes * 2 + 1);
        } else {
            sb_repeat(b, '\\', slashes);
        }
        sb_putc(b, c);
        slashes = 0;
    }
    sb_repeat(b, '\\', slashes * 2);
    sb_putc(b, '"');
}

ah_status ah_proc_win_command_line(const char *program,
                                   const char *const *args,
                                   const size_t *arg_lens, size_t arg_count,
                                   char **out) {
    if (program == NULL || out == NULL || strchr(program, '"') != NULL) {
        return AH_ERR_INVALID;
    }
    size_t units = 0;
    ah_status st = ah_proc_i_utf16_units(program, strlen(program), &units);
    if (st != AH_OK) {
        return st;
    }
    sbuf b = {0};
    /* argv[0]: o CommandLineToArgvW não trata barras no programa, só aspas;
     * como caminho não tem '"', aspas simples em volta bastam. */
    sb_putc(&b, '"');
    sb_put(&b, program, strlen(program));
    sb_putc(&b, '"');
    for (size_t i = 0; i < arg_count; i++) {
        const char *s;
        size_t len;
        st = ah_proc_i_arg(args, arg_lens, i, &s, &len);
        if (st == AH_OK) {
            st = ah_proc_i_utf16_units(s, len, &units);
        }
        if (st != AH_OK) {
            free(b.p);
            return st;
        }
        sb_putc(&b, ' ');
        quote_win_arg(&b, s, len);
    }
    st = sb_finish(&b, out);
    if (st != AH_OK) {
        return st;
    }
    st = ah_proc_i_utf16_units(*out, b.len, &units);
    if (st == AH_OK && units > AH_PROC_WIN_MAX_CMDLINE) {
        st = AH_ERR_LIMIT;
    }
    if (st != AH_OK) {
        free(*out);
        *out = NULL;
    }
    return st;
}

/* --- P2: escape do cmd.exe (SPEC-04 B5) --- */

/* META_CMD de bin-resolver.ts:347: ( ) ] [ % ! ^ " ` < > & | ; , espaço * ? */
static bool is_cmd_meta(char c) {
    return strchr("()][%!^\"`<>&|;, *?", c) != NULL && c != '\0';
}

static ah_status caret_escape(const char *s, size_t len, char **out) {
    sbuf b = {0};
    for (size_t i = 0; i < len; i++) {
        if (is_cmd_meta(s[i])) {
            sb_putc(&b, '^');
        }
        sb_putc(&b, s[i]);
    }
    return sb_finish(&b, out);
}

ah_status ah_proc_cmd_escape_arg(const char *arg, size_t len, char **out) {
    if (arg == NULL || out == NULL) {
        return AH_ERR_INVALID;
    }
    for (size_t i = 0; i < len; i++) {
        if (arg[i] == '\r' || arg[i] == '\n' || arg[i] == '\0') {
            return AH_ERR_INVALID;
        }
    }
    /* 1) sempre entre aspas, com a regra do CommandLineToArgvW. */
    sbuf q = {0};
    sb_putc(&q, '"');
    size_t slashes = 0;
    for (size_t i = 0; i < len; i++) {
        char c = arg[i];
        if (c == '\\') {
            slashes++;
            continue;
        }
        if (c == '"') {
            sb_repeat(&q, '\\', slashes * 2 + 1);
        } else {
            sb_repeat(&q, '\\', slashes);
        }
        sb_putc(&q, c);
        slashes = 0;
    }
    sb_repeat(&q, '\\', slashes * 2);
    sb_putc(&q, '"');
    char *quoted = NULL;
    ah_status st = sb_finish(&q, &quoted);
    if (st != AH_OK) {
        return st;
    }
    /* 2) `^` antes de cada metacaractere, duas vezes: a 1ª camada é
     * consumida pelo `cmd /c`, a 2ª pelo reparse do `%*` no .bat. */
    char *once = NULL;
    st = caret_escape(quoted, strlen(quoted), &once);
    free(quoted);
    if (st != AH_OK) {
        return st;
    }
    st = caret_escape(once, strlen(once), out);
    free(once);
    return st;
}

ah_status ah_proc_cmd_line(const char *command, const char *const *args,
                           const size_t *arg_lens, size_t arg_count,
                           char **out) {
    if (command == NULL || out == NULL) {
        return AH_ERR_INVALID;
    }
    char *cmd = NULL;
    ah_status st = caret_escape(command, strlen(command), &cmd);
    if (st != AH_OK) {
        return st;
    }
    sbuf b = {0};
    sb_put(&b, cmd, strlen(cmd));
    free(cmd);
    for (size_t i = 0; i < arg_count; i++) {
        const char *s;
        size_t len;
        char *esc = NULL;
        st = ah_proc_i_arg(args, arg_lens, i, &s, &len);
        if (st == AH_OK) {
            st = ah_proc_cmd_escape_arg(s, len, &esc);
        }
        if (st != AH_OK) {
            free(b.p);
            return st;
        }
        sb_putc(&b, ' ');
        sb_put(&b, esc, strlen(esc));
        free(esc);
    }
    st = sb_finish(&b, out);
    if (st != AH_OK) {
        return st;
    }
    size_t units = 0;
    st = ah_proc_i_utf16_units(*out, b.len, &units);
    if (st == AH_OK && units + 16 > AH_PROC_CMD_MAX_LINE) {
        st = AH_ERR_LIMIT;
    }
    if (st != AH_OK) {
        free(*out);
        *out = NULL;
    }
    return st;
}
