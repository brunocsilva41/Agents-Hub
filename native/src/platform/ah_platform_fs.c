/* Parte portável da área de arquivos (F0-05): manipulação léxica de
 * caminhos e nome do temporário. Não chama o SO; as partes que chamam ficam
 * em ah_platform_fs_win.c e ah_platform_fs_posix.c. */
#include "ah_platform_fs.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ah_platform_fs_internal.h"

static int is_sep(char c) {
#if defined(_WIN32)
    return c == '/' || c == '\\';
#else
    return c == '/';
#endif
}

#if defined(_WIN32)
static int is_ascii_letter(char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}
#endif

ah_status ah_platform_fs_normalize_ex(const char *path, char **out,
                                      size_t *root_len) {
    const char sep = AH_PLATFORM_PATH_SEP;
    size_t n, i = 0, o = 0, root;
    int absolute = 0;
    char *buf;

    if (out != NULL) *out = NULL;
    if (root_len != NULL) *root_len = 0;
    if (path == NULL || out == NULL) return AH_ERR_INVALID;

    n = strlen(path);
    /* Pior caso: raiz UNC ganha um separador final (+1), "." no vazio (+1)
     * e o '\0' (+1). */
    if (n > SIZE_MAX - 4) return AH_ERR_LIMIT;
    buf = malloc(n + 4);
    if (buf == NULL) return AH_ERR_NOMEM;

#if defined(_WIN32)
    /* "\\?\" e "\\.\" desligam a interpretação do Win32: qualquer mudança
     * léxica mudaria o objeto apontado. Devolve como veio. */
    if (n >= 4 && is_sep(path[0]) && is_sep(path[1]) &&
        (path[2] == '?' || path[2] == '.') && is_sep(path[3])) {
        memcpy(buf, path, n + 1);
        *out = buf;
        if (root_len != NULL) *root_len = 4;
        return AH_OK;
    }
    if (n >= 2 && is_sep(path[0]) && is_sep(path[1])) {
        int part;
        /* UNC: \\servidor\compartilhamento\ é a raiz. */
        buf[o++] = '\\';
        buf[o++] = '\\';
        i = 2;
        while (i < n && is_sep(path[i])) i++;
        for (part = 0; part < 2; part++) {
            size_t s = i;
            while (i < n && !is_sep(path[i])) i++;
            if (i == s) break;
            memcpy(buf + o, path + s, i - s);
            o += i - s;
            buf[o++] = '\\';
            while (i < n && is_sep(path[i])) i++;
        }
        absolute = 1;
    } else if (n >= 2 && is_ascii_letter(path[0]) && path[1] == ':') {
        buf[o++] = path[0];
        buf[o++] = ':';
        i = 2;
        if (i < n && is_sep(path[i])) {
            buf[o++] = '\\';
            absolute = 1;
        }
    } else if (n >= 1 && is_sep(path[0])) {
        buf[o++] = '\\';
        absolute = 1;
    }
#else
    if (n >= 1 && path[0] == '/') {
        buf[o++] = '/';
        absolute = 1;
    }
#endif
    root = o;

    while (i < n) {
        size_t s, len;
        while (i < n && is_sep(path[i])) i++;
        s = i;
        while (i < n && !is_sep(path[i])) i++;
        len = i - s;
        if (len == 0) break;
        if (len == 1 && path[s] == '.') continue;
        if (len == 2 && path[s] == '.' && path[s + 1] == '.') {
            size_t last = o;
            while (last > root && buf[last - 1] != sep) last--;
            if (o > root && !(o - last == 2 && buf[last] == '.' &&
                              buf[last + 1] == '.')) {
                /* Remove o último componente e o separador antes dele. */
                o = last;
                if (o > root) o--;
                continue;
            }
            /* ".." acima da raiz de um absoluto não leva a lugar nenhum. */
            if (absolute) continue;
        }
        if (o > root) buf[o++] = sep;
        memcpy(buf + o, path + s, len);
        o += len;
    }
    if (o == 0) buf[o++] = '.';
    buf[o] = '\0';

    *out = buf;
    if (root_len != NULL) *root_len = root;
    return AH_OK;
}

ah_status ah_platform_path_normalize(const char *path, char **out) {
    return ah_platform_fs_normalize_ex(path, out, NULL);
}

ah_status ah_platform_path_join(const char *a, const char *b, char **out) {
    size_t la, lb, total;
    char *tmp;
    ah_status st;

    if (out != NULL) *out = NULL;
    if (a == NULL || b == NULL || out == NULL) return AH_ERR_INVALID;

    la = strlen(a);
    lb = strlen(b);
    if (la > SIZE_MAX - 2 || lb > SIZE_MAX - 2 - la) return AH_ERR_LIMIT;
    total = la + lb + 2;
    tmp = malloc(total);
    if (tmp == NULL) return AH_ERR_NOMEM;

    memcpy(tmp, a, la);
    if (la > 0 && lb > 0) {
        tmp[la] = AH_PLATFORM_PATH_SEP;
        memcpy(tmp + la + 1, b, lb);
        tmp[la + 1 + lb] = '\0';
    } else {
        memcpy(tmp + la, b, lb);
        tmp[la + lb] = '\0';
    }

    st = ah_platform_fs_normalize_ex(tmp, out, NULL);
    free(tmp);
    return st;
}

ah_status ah_platform_fs_dirname(const char *path, char **out) {
    char *norm = NULL;
    size_t root = 0, len, k;
    ah_status st;

    if (out != NULL) *out = NULL;
    if (path == NULL || out == NULL) return AH_ERR_INVALID;

    st = ah_platform_fs_normalize_ex(path, &norm, &root);
    if (st != AH_OK) return st;

    len = strlen(norm);
    k = len;
    while (k > root && norm[k - 1] != AH_PLATFORM_PATH_SEP) k--;
    if (k > root) {
        norm[k - 1] = '\0'; /* "a/b" -> "a" */
    } else if (root > 0) {
        norm[root] = '\0'; /* "/a" -> "/", "C:\a" -> "C:\" */
    } else {
        norm[0] = '.'; /* "a" -> "." (o buffer tem pelo menos 2 bytes) */
        norm[1] = '\0';
    }
    *out = norm;
    return AH_OK;
}

ah_status ah_platform_fs_tmp_name(const char *path, unsigned long pid,
                                  unsigned long long nonce, char **out) {
    /* ".tmp-" + pid (até 20 dígitos) + "-" + nonce (até 16 hex) + '\0'. */
    enum { SUFFIX_MAX = 5 + 20 + 1 + 16 + 1 };
    size_t lp;
    char *buf;
    int n;

    if (out != NULL) *out = NULL;
    if (path == NULL || out == NULL) return AH_ERR_INVALID;

    lp = strlen(path);
    if (lp > SIZE_MAX - SUFFIX_MAX) return AH_ERR_LIMIT;
    buf = malloc(lp + SUFFIX_MAX);
    if (buf == NULL) return AH_ERR_NOMEM;
    memcpy(buf, path, lp);
    n = snprintf(buf + lp, SUFFIX_MAX, ".tmp-%lu-%llx", pid, nonce);
    if (n < 0 || (size_t)n >= SUFFIX_MAX) {
        free(buf);
        return AH_ERR_INTERNAL;
    }
    *out = buf;
    return AH_OK;
}
