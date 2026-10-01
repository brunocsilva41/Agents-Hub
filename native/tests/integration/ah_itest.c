/* Helper de integração (F0-11). Contrato em ah_itest.h.
 *
 * Chamadas de SO LOCAIS a este arquivo, porque ah_platform está sendo escrita
 * em paralelo. Migram para native/src/platform/ no merge (área entre
 * parênteses, conforme native/src/platform/CMakeLists.txt):
 *   (fs)   utf8 <-> UTF-16, caminho canônico (GetFinalPathNameByHandleW /
 *          realpath, resolvendo junções e links), diretório temporário do SO,
 *          criar diretório único, remover árvore sem seguir links, existe?,
 *          criar junção/link (FSCTL_SET_REPARSE_POINT, CreateSymbolicLinkW,
 *          symlink);
 *   (time) ler/definir variável de ambiente, snapshot do ambiente, perfil do
 *          usuário do SO (GetUserProfileDirectoryW/getpwuid) — F0-06, "ambiente
 *          e usuário do SO";
 *   (proc) spawn com ambiente e cwd próprios, esperar, matar, código de saída;
 *   (net)  porta livre em 127.0.0.1 (bind na porta 0).
 * O que fica aqui depois da migração: a política de isolamento (raízes
 * proibidas, filtro de AGENTS_HUB_*, escolha de porta, as três variáveis). */
#if !defined(_WIN32)
#define _XOPEN_SOURCE 700 /* mkdtemp, realpath, nftw, setenv (POSIX.1-2008/XSI) */
#endif

#include "ah_itest.h"

#include <stdarg.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <winioctl.h>
#include <userenv.h>
#else
#include <arpa/inet.h>
#include <errno.h>
#include <ftw.h>
#include <netinet/in.h>
#include <pwd.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
extern char **environ;
#endif

#define HUB_PREFIX "AGENTS_HUB_"
#define HOME_DIR_PREFIX "ah-itest-"

struct ah_itest_env {
    char *home;
    unsigned port;
};

struct ah_itest_proc {
#if defined(_WIN32)
    HANDLE process;
#else
    pid_t pid;
#endif
    int reaped;
    int exit_code;
};

/* ================================================================ comum */

static void set_err(char *err, size_t cap, const char *fmt, ...) {
    va_list ap;
    if (err == NULL || cap == 0) {
        return;
    }
    va_start(ap, fmt);
    if (vsnprintf(err, cap, fmt, ap) < 0) {
        err[0] = '\0';
    }
    va_end(ap);
}

static char *str_dup(const char *s) {
    size_t n = strlen(s) + 1;
    char *d = malloc(n);
    if (d != NULL) {
        memcpy(d, s, n);
    }
    return d;
}

/* "a" + "b" + "c" em memória nova. */
static char *str_cat3(const char *a, const char *b, const char *c) {
    size_t la = strlen(a);
    size_t lb = strlen(b);
    size_t lc = strlen(c);
    char *d = malloc(la + lb + lc + 1);
    if (d != NULL) {
        memcpy(d, a, la);
        memcpy(d + la, b, lb);
        memcpy(d + la + lb, c, lc + 1);
    }
    return d;
}

void ah_itest_strv_free(char **v) {
    size_t i;
    if (v == NULL) {
        return;
    }
    for (i = 0; v[i] != NULL; i++) {
        free(v[i]);
    }
    free(v);
}

typedef struct strv {
    char **v;
    size_t n;
    size_t cap;
} strv;

/* Acrescenta `owned` (passa a ser da lista; liberado em caso de erro). */
static ah_status strv_push(strv *s, char *owned) {
    if (owned == NULL) {
        return AH_ERR_NOMEM;
    }
    if (s->n + 2 > s->cap) {
        size_t ncap = s->cap == 0 ? 64 : s->cap * 2;
        char **nv = realloc(s->v, ncap * sizeof *nv);
        if (nv == NULL) {
            free(owned);
            return AH_ERR_NOMEM;
        }
        s->v = nv;
        s->cap = ncap;
    }
    s->v[s->n++] = owned;
    s->v[s->n] = NULL;
    return AH_OK;
}

static void strv_dispose(strv *s) {
    size_t i;
    for (i = 0; i < s->n; i++) {
        free(s->v[i]);
    }
    free(s->v);
    s->v = NULL;
    s->n = 0;
    s->cap = 0;
}

static int chr_eq(char a, char b) {
#if defined(_WIN32)
    /* Nomes de variável no Windows não diferenciam caixa. */
    if (a >= 'a' && a <= 'z') {
        a = (char)(a - 'a' + 'A');
    }
    if (b >= 'a' && b <= 'z') {
        b = (char)(b - 'a' + 'A');
    }
#endif
    return a == b;
}

/* Tamanho do NOME em "NOME=valor". No Windows, entradas como "=C:=C:\x"
 * começam com '=' e o nome vai até o segundo '='. */
static size_t env_name_len(const char *entry) {
    const char *eq = strchr(entry[0] == '=' ? entry + 1 : entry, '=');
    return eq == NULL ? strlen(entry) : (size_t)(eq - entry);
}

static int env_same_name(const char *a, const char *b) {
    size_t la = env_name_len(a);
    size_t i;
    if (la != env_name_len(b)) {
        return 0;
    }
    for (i = 0; i < la; i++) {
        if (!chr_eq(a[i], b[i])) {
            return 0;
        }
    }
    return 1;
}

static int env_is_hub_var(const char *entry) {
    size_t lp = sizeof HUB_PREFIX - 1;
    size_t i;
    if (env_name_len(entry) < lp) {
        return 0;
    }
    for (i = 0; i < lp; i++) {
        if (!chr_eq(entry[i], HUB_PREFIX[i])) {
            return 0;
        }
    }
    return 1;
}

/* `child` é igual a `parent` ou está dentro dele (caminhos canônicos, '/'). */
static int is_under(const char *child, const char *parent) {
    size_t lp = strlen(parent);
    if (lp == 0) {
        return 0;
    }
    if (strncmp(child, parent, lp) != 0) {
        return 0;
    }
    return child[lp] == '\0' || child[lp] == '/' || parent[lp - 1] == '/';
}

/* ================================================================ SO: Windows */
#if defined(_WIN32)

static wchar_t *to_wide(const char *s) {
    int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s, -1, NULL, 0);
    wchar_t *w;
    if (n <= 0) {
        return NULL;
    }
    w = malloc((size_t)n * sizeof *w);
    if (w == NULL) {
        return NULL;
    }
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s, -1, w, n) != n) {
        free(w);
        return NULL;
    }
    return w;
}

static char *to_utf8(const wchar_t *w) {
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, NULL, 0, NULL, NULL);
    char *s;
    if (n <= 0) {
        return NULL;
    }
    s = malloc((size_t)n);
    if (s == NULL) {
        return NULL;
    }
    if (WideCharToMultiByte(CP_UTF8, 0, w, -1, s, n, NULL, NULL) != n) {
        free(s);
        return NULL;
    }
    return s;
}

/* Valor de variável de ambiente em UTF-8 (malloc) ou NULL se não existe. */
static char *env_get(const char *name) {
    wchar_t *wn = to_wide(name);
    wchar_t *wv;
    DWORD n;
    DWORD got;
    char *v;
    if (wn == NULL) {
        return NULL;
    }
    n = GetEnvironmentVariableW(wn, NULL, 0);
    if (n == 0) {
        free(wn);
        return NULL;
    }
    wv = malloc((size_t)n * sizeof *wv);
    if (wv == NULL) {
        free(wn);
        return NULL;
    }
    got = GetEnvironmentVariableW(wn, wv, n);
    free(wn);
    if (got == 0 || got >= n) {
        free(wv);
        return NULL;
    }
    v = to_utf8(wv);
    free(wv);
    return v;
}

static ah_status env_set(const char *name, const char *value) {
    wchar_t *wn = to_wide(name);
    wchar_t *wv = value != NULL ? to_wide(value) : NULL;
    BOOL ok;
    if (wn == NULL || (value != NULL && wv == NULL)) {
        free(wn);
        free(wv);
        return AH_ERR_INVALID;
    }
    ok = SetEnvironmentVariableW(wn, wv);
    free(wn);
    free(wv);
    if (!ok) {
        /* Remover o que não existe não é erro. */
        return (value == NULL && GetLastError() == ERROR_ENVVAR_NOT_FOUND) ? AH_OK : AH_ERR_IO;
    }
    return AH_OK;
}

static ah_status env_snapshot(strv *out) {
    wchar_t *block = GetEnvironmentStringsW();
    const wchar_t *p;
    ah_status st = AH_OK;
    if (block == NULL) {
        return AH_ERR_IO;
    }
    for (p = block; *p != L'\0'; p += wcslen(p) + 1) {
        st = strv_push(out, to_utf8(p));
        if (st != AH_OK) {
            break;
        }
    }
    FreeEnvironmentStringsW(block);
    return st;
}

/* Caminho final de algo que existe, seguindo junções, links simbólicos e
 * nomes 8.3 (CreateFileW com FILE_FLAG_BACKUP_SEMANTICS abre diretórios e,
 * sem FILE_FLAG_OPEN_REPARSE_POINT, segue o reparse point até o alvo).
 * Devolve sem o prefixo "\\?\" (ou "\\?\UNC\" -> "\\"); NULL se não abriu. */
static wchar_t *final_path_w(const wchar_t *full) {
    HANDLE h = CreateFileW(full, FILE_READ_ATTRIBUTES,
                           FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL,
                           OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
    DWORD n;
    DWORD got;
    wchar_t *buf;
    wchar_t *res;
    const wchar_t *src;
    int unc = 0;

    if (h == INVALID_HANDLE_VALUE) {
        return NULL;
    }
    n = GetFinalPathNameByHandleW(h, NULL, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (n == 0) {
        CloseHandle(h);
        return NULL;
    }
    buf = malloc(((size_t)n + 1) * sizeof *buf);
    if (buf == NULL) {
        CloseHandle(h);
        return NULL;
    }
    got = GetFinalPathNameByHandleW(h, buf, n + 1, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    CloseHandle(h);
    if (got == 0 || got > n) {
        free(buf);
        return NULL;
    }
    src = buf;
    if (wcsncmp(buf, L"\\\\?\\UNC\\", 8) == 0) {
        src = buf + 8;
        unc = 1;
    } else if (wcsncmp(buf, L"\\\\?\\", 4) == 0) {
        src = buf + 4;
    }
    res = malloc((wcslen(src) + 3) * sizeof *res);
    if (res != NULL) {
        size_t o = 0;
        if (unc) {
            res[o++] = L'\\';
            res[o++] = L'\\';
        }
        memcpy(res + o, src, (wcslen(src) + 1) * sizeof *res);
    }
    free(buf);
    return res;
}

/* Canoniza (absoluto, caminho final com junções e links resolvidos no maior
 * prefixo que existe, '\\' -> '/', minúsculas, sem barra final) mesmo quando
 * o caminho ainda não existe: canoniza o pai e anexa o nome. */
static wchar_t *canon_w(const wchar_t *path, int depth) {
    DWORD n;
    wchar_t *full;
    wchar_t *lng;
    wchar_t *res = NULL;

    if (depth > 64) {
        return NULL;
    }
    n = GetFullPathNameW(path, 0, NULL, NULL);
    if (n == 0) {
        return NULL;
    }
    full = malloc((size_t)n * sizeof *full);
    if (full == NULL) {
        return NULL;
    }
    if (GetFullPathNameW(path, n, full, NULL) == 0) {
        free(full);
        return NULL;
    }
    /* Existe: caminho final com junções/links/8.3 resolvidos. */
    res = final_path_w(full);
    if (res == NULL && GetFileAttributesW(full) != INVALID_FILE_ATTRIBUTES) {
        /* Existe, mas não abriu (ex.: acesso negado): ao menos o nome longo. */
        n = GetLongPathNameW(full, NULL, 0);
        if (n != 0) {
            lng = malloc((size_t)n * sizeof *lng);
            if (lng != NULL && GetLongPathNameW(full, lng, n) != 0) {
                res = lng;
            } else {
                free(lng);
            }
        }
    }
    if (res == NULL) {
        /* Não existe: pai canônico + último componente. */
        size_t len = wcslen(full);
        wchar_t *slash;
        while (len > 3 && (full[len - 1] == L'\\' || full[len - 1] == L'/')) {
            full[--len] = L'\0';
        }
        slash = wcsrchr(full, L'\\');
        if (slash != NULL && slash > full && slash[1] != L'\0' && len > 3) {
            const wchar_t *name = slash + 1;
            size_t lname = wcslen(name);
            size_t lparent = (size_t)(slash - full);
            wchar_t *ppath = malloc((lparent + 2) * sizeof *ppath);
            wchar_t *parent = NULL;
            wchar_t *cp;
            if (ppath != NULL) {
                memcpy(ppath, full, lparent * sizeof *ppath);
                ppath[lparent] = L'\0';
                if (lparent == 2 && ppath[1] == L':') {
                    /* "C:" -> "C:\" (raiz do drive, não o cwd do drive). */
                    ppath[2] = L'\\';
                    ppath[3] = L'\0';
                }
                parent = canon_w(ppath, depth + 1);
                free(ppath);
            }
            if (parent != NULL) {
                size_t lpar = wcslen(parent);
                int sep = lpar > 0 && parent[lpar - 1] != L'\\';
                cp = malloc((lpar + 1 + lname + 1) * sizeof *cp);
                if (cp != NULL) {
                    memcpy(cp, parent, lpar * sizeof *cp);
                    if (sep) {
                        cp[lpar++] = L'\\';
                    }
                    memcpy(cp + lpar, name, (lname + 1) * sizeof *cp);
                    res = cp;
                }
                free(parent);
            }
        } else {
            res = full; /* raiz */
            full = NULL;
        }
    }
    free(full);
    return res;
}

static char *canon(const char *path) {
    wchar_t *w = to_wide(path);
    wchar_t *c;
    char *u;
    size_t len;
    size_t i;
    if (w == NULL) {
        return NULL;
    }
    c = canon_w(w, 0);
    free(w);
    if (c == NULL) {
        return NULL;
    }
    len = wcslen(c);
    if (len > 0) {
        CharLowerBuffW(c, (DWORD)len);
    }
    u = to_utf8(c);
    free(c);
    if (u == NULL) {
        return NULL;
    }
    for (i = 0; u[i] != '\0'; i++) {
        if (u[i] == '\\') {
            u[i] = '/';
        }
    }
    len = strlen(u);
    while (len > 3 && u[len - 1] == '/') {
        u[--len] = '\0';
    }
    return u;
}

/* Raízes de usuário (sem o "/.agents-hub"). */
static ah_status user_homes(strv *out) {
    static const char *const vars[] = {"USERPROFILE", "HOME"};
    HANDLE token = NULL;
    size_t i;
    ah_status st;
    char *drive;
    char *hpath;

    if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
        DWORD n = 0;
        (void)GetUserProfileDirectoryW(token, NULL, &n);
        if (n > 0) {
            wchar_t *w = malloc((size_t)n * sizeof *w);
            if (w != NULL && GetUserProfileDirectoryW(token, w, &n)) {
                st = strv_push(out, to_utf8(w));
                if (st != AH_OK) {
                    free(w);
                    CloseHandle(token);
                    return st;
                }
            }
            free(w);
        }
        CloseHandle(token);
    }
    for (i = 0; i < sizeof vars / sizeof vars[0]; i++) {
        char *v = env_get(vars[i]);
        if (v != NULL && v[0] != '\0') {
            st = strv_push(out, v);
            if (st != AH_OK) {
                return st;
            }
        } else {
            free(v);
        }
    }
    drive = env_get("HOMEDRIVE");
    hpath = env_get("HOMEPATH");
    if (drive != NULL && hpath != NULL && drive[0] != '\0' && hpath[0] != '\0') {
        st = strv_push(out, str_cat3(drive, hpath, ""));
        if (st != AH_OK) {
            free(drive);
            free(hpath);
            return st;
        }
    }
    free(drive);
    free(hpath);
    return AH_OK;
}

static char *temp_base(void) {
    wchar_t buf[MAX_PATH + 2];
    DWORD n = GetTempPathW(MAX_PATH + 2, buf);
    if (n == 0 || n > MAX_PATH + 1) {
        return NULL;
    }
    while (n > 3 && buf[n - 1] == L'\\') {
        buf[--n] = L'\0';
    }
    return to_utf8(buf);
}

/* Cria base/ah-itest-<pid>-<n> novo. Devolve o caminho longo absoluto. */
static ah_status make_unique_dir(const char *base, char **out) {
    static unsigned counter = 0;
    int attempt;
    for (attempt = 0; attempt < 100; attempt++) {
        char name[96];
        char *path;
        wchar_t *w;
        BOOL ok;
        DWORD e;
        int n = snprintf(name, sizeof name, "\\" HOME_DIR_PREFIX "%lu-%u-%llu",
                         (unsigned long)GetCurrentProcessId(), counter++,
                         (unsigned long long)GetTickCount64());
        if (n < 0 || (size_t)n >= sizeof name) {
            return AH_ERR_INTERNAL;
        }
        path = str_cat3(base, name, "");
        if (path == NULL) {
            return AH_ERR_NOMEM;
        }
        w = to_wide(path);
        if (w == NULL) {
            free(path);
            return AH_ERR_INVALID;
        }
        ok = CreateDirectoryW(w, NULL);
        e = ok ? 0 : GetLastError();
        if (ok) {
            DWORD ln = GetLongPathNameW(w, NULL, 0);
            wchar_t *lw = ln != 0 ? malloc((size_t)ln * sizeof *lw) : NULL;
            free(path);
            path = NULL;
            if (lw != NULL && GetLongPathNameW(w, lw, ln) != 0) {
                path = to_utf8(lw);
            }
            free(lw);
            if (path == NULL) {
                RemoveDirectoryW(w);
                free(w);
                return AH_ERR_IO;
            }
            free(w);
            *out = path;
            return AH_OK;
        }
        free(w);
        free(path);
        if (e != ERROR_ALREADY_EXISTS) {
            return AH_ERR_IO;
        }
    }
    return AH_ERR_IO;
}

/* Remove a árvore sem seguir junções/links: um diretório com reparse point é
 * removido como entrada (RemoveDirectoryW), nunca percorrido. */
static int remove_tree_w(const wchar_t *path) {
    DWORD attr = GetFileAttributesW(path);
    int ok = 1;
    if (attr == INVALID_FILE_ATTRIBUTES) {
        DWORD e = GetLastError();
        return e == ERROR_FILE_NOT_FOUND || e == ERROR_PATH_NOT_FOUND;
    }
    if (attr & FILE_ATTRIBUTE_READONLY) {
        (void)SetFileAttributesW(path, attr & ~(DWORD)FILE_ATTRIBUTE_READONLY);
    }
    if ((attr & FILE_ATTRIBUTE_DIRECTORY) && !(attr & FILE_ATTRIBUTE_REPARSE_POINT)) {
        size_t lp = wcslen(path);
        wchar_t *pattern = malloc((lp + 3) * sizeof *pattern);
        WIN32_FIND_DATAW fd;
        HANDLE h;
        if (pattern == NULL) {
            return 0;
        }
        memcpy(pattern, path, lp * sizeof *pattern);
        memcpy(pattern + lp, L"\\*", 3 * sizeof *pattern);
        h = FindFirstFileW(pattern, &fd);
        free(pattern);
        if (h != INVALID_HANDLE_VALUE) {
            do {
                size_t ln;
                wchar_t *child;
                if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0) {
                    continue;
                }
                ln = wcslen(fd.cFileName);
                child = malloc((lp + 1 + ln + 1) * sizeof *child);
                if (child == NULL) {
                    ok = 0;
                    break;
                }
                memcpy(child, path, lp * sizeof *child);
                child[lp] = L'\\';
                memcpy(child + lp + 1, fd.cFileName, (ln + 1) * sizeof *child);
                if (!remove_tree_w(child)) {
                    ok = 0;
                }
                free(child);
            } while (FindNextFileW(h, &fd));
            FindClose(h);
        }
        return RemoveDirectoryW(path) && ok;
    }
    if (attr & FILE_ATTRIBUTE_DIRECTORY) {
        return RemoveDirectoryW(path) != 0;
    }
    return DeleteFileW(path) != 0;
}

static int remove_tree(const char *path) {
    wchar_t *w = to_wide(path);
    int ok;
    if (w == NULL) {
        return 0;
    }
    ok = remove_tree_w(w);
    free(w);
    return ok;
}

ah_status ah_itest_make_dir(const char *path) {
    wchar_t *w = to_wide(path);
    BOOL ok;
    if (w == NULL) {
        return AH_ERR_INVALID;
    }
    ok = CreateDirectoryW(w, NULL);
    free(w);
    return ok ? AH_OK : AH_ERR_IO;
}

/* Cabeçalho de reparse point de ponto de montagem (junção). A struct
 * REPARSE_DATA_BUFFER fica em ntifs.h (DDK), fora do SDK de usuário; o
 * layout abaixo é o documentado para IO_REPARSE_TAG_MOUNT_POINT. */
typedef struct mount_point_reparse {
    DWORD tag;
    WORD data_length;
    WORD reserved;
    WORD substitute_offset;
    WORD substitute_length;
    WORD print_offset;
    WORD print_length;
    WCHAR path[1];
} mount_point_reparse;

#define MOUNT_POINT_HEADER (offsetof(mount_point_reparse, path))
#define REPARSE_HEADER ((size_t)8) /* tag + data_length + reserved */
#define REPARSE_MAX ((size_t)16 * 1024)

#ifndef SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE
#define SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE 0x2
#endif

static wchar_t *full_path_w(const wchar_t *p) {
    DWORD n = GetFullPathNameW(p, 0, NULL, NULL);
    wchar_t *full;
    if (n == 0) {
        return NULL;
    }
    full = malloc((size_t)n * sizeof *full);
    if (full != NULL && GetFullPathNameW(p, n, full, NULL) == 0) {
        free(full);
        full = NULL;
    }
    return full;
}

static ah_status make_junction_w(const wchar_t *link, const wchar_t *target) {
    size_t lt = wcslen(target);
    size_t sub_chars = 4 + lt; /* "\??\" + alvo */
    size_t total = MOUNT_POINT_HEADER + (sub_chars + 1 + lt + 1) * sizeof(WCHAR);
    mount_point_reparse *rp;
    HANDLE h;
    DWORD ret = 0;
    BOOL ok;

    if (total > REPARSE_MAX) {
        return AH_ERR_LIMIT;
    }
    rp = calloc(1, total);
    if (rp == NULL) {
        return AH_ERR_NOMEM;
    }
    rp->tag = IO_REPARSE_TAG_MOUNT_POINT;
    rp->data_length = (WORD)(total - REPARSE_HEADER);
    rp->substitute_offset = 0;
    rp->substitute_length = (WORD)(sub_chars * sizeof(WCHAR));
    rp->print_offset = (WORD)((sub_chars + 1) * sizeof(WCHAR));
    rp->print_length = (WORD)(lt * sizeof(WCHAR));
    memcpy(rp->path, L"\\??\\", 4 * sizeof(WCHAR));
    memcpy(rp->path + 4, target, lt * sizeof(WCHAR));
    memcpy(rp->path + sub_chars + 1, target, lt * sizeof(WCHAR));

    if (!CreateDirectoryW(link, NULL)) {
        free(rp);
        return AH_ERR_IO;
    }
    h = CreateFileW(link, GENERIC_WRITE, 0, NULL, OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    if (h == INVALID_HANDLE_VALUE) {
        RemoveDirectoryW(link);
        free(rp);
        return AH_ERR_IO;
    }
    ok = DeviceIoControl(h, FSCTL_SET_REPARSE_POINT, rp, (DWORD)total, NULL, 0, &ret, NULL);
    CloseHandle(h);
    free(rp);
    if (!ok) {
        RemoveDirectoryW(link);
        return AH_ERR_IO;
    }
    return AH_OK;
}

ah_status ah_itest_make_link(const char *link, const char *target, ah_itest_link_kind kind) {
    wchar_t *wl;
    wchar_t *wt;
    wchar_t *full = NULL;
    ah_status st;

    if (link == NULL || target == NULL) {
        return AH_ERR_INVALID;
    }
    wl = to_wide(link);
    wt = to_wide(target);
    if (wl == NULL || wt == NULL) {
        free(wl);
        free(wt);
        return AH_ERR_INVALID;
    }
    full = full_path_w(wt);
    if (full == NULL || GetFileAttributesW(full) == INVALID_FILE_ATTRIBUTES) {
        st = AH_ERR_NOT_FOUND;
    } else if (kind == AH_ITEST_LINK_DIR) {
        st = make_junction_w(wl, full);
    } else if (kind == AH_ITEST_LINK_FILE) {
        st = CreateSymbolicLinkW(wl, full, SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE)
                 ? AH_OK
                 : AH_ERR_IO;
    } else {
        st = AH_ERR_INVALID;
    }
    free(full);
    free(wl);
    free(wt);
    return st;
}

int ah_itest_path_exists(const char *path) {
    wchar_t *w = to_wide(path);
    DWORD attr;
    if (w == NULL) {
        return 0;
    }
    attr = GetFileAttributesW(w);
    free(w);
    return attr != INVALID_FILE_ATTRIBUTES;
}

static ah_status os_free_port(void *ctx, unsigned *port) {
    static int wsa_ready = 0;
    SOCKET s;
    struct sockaddr_in addr;
    int len = (int)sizeof addr;
    ah_status st = AH_ERR_IO;
    (void)ctx;
    if (!wsa_ready) {
        WSADATA wsa;
        if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
            return AH_ERR_IO;
        }
        wsa_ready = 1; /* fica aberto até o fim do processo de teste */
    }
    s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) {
        return AH_ERR_IO;
    }
    memset(&addr, 0, sizeof addr);
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = 0;
    if (bind(s, (struct sockaddr *)&addr, (int)sizeof addr) == 0 &&
        getsockname(s, (struct sockaddr *)&addr, &len) == 0) {
        *port = ntohs(addr.sin_port);
        st = AH_OK;
    }
    closesocket(s);
    return st;
}

/* Aspas no padrão do CRT da Microsoft (CommandLineToArgvW). */
static ah_status quote_arg(strv *parts, const char *arg) {
    size_t len = strlen(arg);
    size_t i;
    size_t o = 0;
    char *q;
    if (len > 0 && strpbrk(arg, " \t\n\v\"") == NULL) {
        return strv_push(parts, str_dup(arg));
    }
    q = malloc(len * 2 + 3);
    if (q == NULL) {
        return AH_ERR_NOMEM;
    }
    q[o++] = '"';
    for (i = 0;; i++) {
        size_t bs = 0;
        while (i < len && arg[i] == '\\') {
            bs++;
            i++;
        }
        if (i == len) {
            while (bs-- > 0) {
                q[o++] = '\\';
                q[o++] = '\\';
            }
            break;
        }
        if (arg[i] == '"') {
            size_t k;
            for (k = 0; k < bs * 2 + 1; k++) {
                q[o++] = '\\';
            }
            q[o++] = '"';
        } else {
            while (bs-- > 0) {
                q[o++] = '\\';
            }
            q[o++] = arg[i];
        }
    }
    q[o++] = '"';
    q[o] = '\0';
    return strv_push(parts, q);
}

static int cmp_env_w(const void *a, const void *b) {
    const wchar_t *x = *(const wchar_t *const *)a;
    const wchar_t *y = *(const wchar_t *const *)b;
    const wchar_t *ex = wcschr(x[0] == L'=' ? x + 1 : x, L'=');
    const wchar_t *ey = wcschr(y[0] == L'=' ? y + 1 : y, L'=');
    int lx = ex != NULL ? (int)(ex - x) : (int)wcslen(x);
    int ly = ey != NULL ? (int)(ey - y) : (int)wcslen(y);
    int r = CompareStringOrdinal(x, lx, y, ly, TRUE);
    return r == 0 ? 0 : r - CSTR_EQUAL;
}

ah_status ah_itest_spawn(const ah_itest_env *env, const char *exe,
                         const ah_itest_spawn_opts *opts, ah_itest_proc **out) {
    char **vars = NULL;
    size_t nvars = 0;
    wchar_t **wvars = NULL;
    wchar_t *block = NULL;
    wchar_t *wexe = NULL;
    wchar_t *wcmd = NULL;
    wchar_t *whome = NULL;
    strv parts = {0};
    char *cmd = NULL;
    size_t total = 1;
    size_t i;
    size_t pos = 0;
    ah_status st;
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    ah_itest_proc *p;

    if (env == NULL || exe == NULL || out == NULL) {
        return AH_ERR_INVALID;
    }
    *out = NULL;
    st = ah_itest_env_child_environ(env, opts, &vars, &nvars);
    if (st != AH_OK) {
        return st;
    }
    wvars = calloc(nvars + 1, sizeof *wvars);
    if (wvars == NULL) {
        st = AH_ERR_NOMEM;
        goto done;
    }
    for (i = 0; i < nvars; i++) {
        wvars[i] = to_wide(vars[i]);
        if (wvars[i] == NULL) {
            st = AH_ERR_INVALID;
            goto done;
        }
        total += wcslen(wvars[i]) + 1;
    }
    /* O bloco de ambiente do CreateProcess deve vir ordenado por nome. */
    qsort(wvars, nvars, sizeof *wvars, cmp_env_w);
    block = malloc(total * sizeof *block);
    if (block == NULL) {
        st = AH_ERR_NOMEM;
        goto done;
    }
    for (i = 0; i < nvars; i++) {
        size_t l = wcslen(wvars[i]) + 1;
        memcpy(block + pos, wvars[i], l * sizeof *block);
        pos += l;
    }
    block[pos] = L'\0';

    st = quote_arg(&parts, exe);
    for (i = 0; st == AH_OK && opts != NULL && i < opts->nargs; i++) {
        st = opts->args[i] != NULL ? quote_arg(&parts, opts->args[i]) : AH_ERR_INVALID;
    }
    if (st != AH_OK) {
        goto done;
    }
    {
        size_t len = 1;
        for (i = 0; i < parts.n; i++) {
            len += strlen(parts.v[i]) + 1;
        }
        cmd = malloc(len);
        if (cmd == NULL) {
            st = AH_ERR_NOMEM;
            goto done;
        }
        cmd[0] = '\0';
        pos = 0;
        for (i = 0; i < parts.n; i++) {
            size_t l = strlen(parts.v[i]);
            if (i > 0) {
                cmd[pos++] = ' ';
            }
            memcpy(cmd + pos, parts.v[i], l);
            pos += l;
        }
        cmd[pos] = '\0';
    }
    wexe = to_wide(exe);
    wcmd = to_wide(cmd);
    whome = to_wide(env->home);
    if (wexe == NULL || wcmd == NULL || whome == NULL) {
        st = AH_ERR_INVALID;
        goto done;
    }
    p = calloc(1, sizeof *p);
    if (p == NULL) {
        st = AH_ERR_NOMEM;
        goto done;
    }
    memset(&si, 0, sizeof si);
    si.cb = sizeof si;
    memset(&pi, 0, sizeof pi);
    if (!CreateProcessW(wexe, wcmd, NULL, NULL, FALSE, CREATE_UNICODE_ENVIRONMENT, block,
                        whome, &si, &pi)) {
        free(p);
        st = AH_ERR_IO;
        goto done;
    }
    CloseHandle(pi.hThread);
    p->process = pi.hProcess;
    *out = p;
    st = AH_OK;

done:
    if (wvars != NULL) {
        for (i = 0; i < nvars; i++) {
            free(wvars[i]);
        }
        free(wvars);
    }
    ah_itest_strv_free(vars);
    strv_dispose(&parts);
    free(block);
    free(cmd);
    free(wexe);
    free(wcmd);
    free(whome);
    return st;
}

ah_status ah_itest_proc_wait(ah_itest_proc *proc, int *exit_code) {
    DWORD code = 0;
    if (proc == NULL || exit_code == NULL) {
        return AH_ERR_INVALID;
    }
    if (!proc->reaped) {
        if (WaitForSingleObject(proc->process, INFINITE) != WAIT_OBJECT_0 ||
            !GetExitCodeProcess(proc->process, &code)) {
            return AH_ERR_IO;
        }
        proc->reaped = 1;
        proc->exit_code = (int)code;
    }
    *exit_code = proc->exit_code;
    return AH_OK;
}

ah_status ah_itest_proc_kill(ah_itest_proc *proc) {
    if (proc == NULL) {
        return AH_ERR_INVALID;
    }
    if (proc->reaped) {
        return AH_OK;
    }
    if (!TerminateProcess(proc->process, 1)) {
        /* Já terminou sozinho: não é erro. */
        return WaitForSingleObject(proc->process, 0) == WAIT_OBJECT_0 ? AH_OK : AH_ERR_IO;
    }
    return AH_OK;
}

void ah_itest_proc_free(ah_itest_proc *proc) {
    if (proc == NULL) {
        return;
    }
    if (!proc->reaped) {
        if (WaitForSingleObject(proc->process, 0) == WAIT_TIMEOUT) {
            (void)TerminateProcess(proc->process, 1);
        }
        (void)WaitForSingleObject(proc->process, INFINITE);
    }
    CloseHandle(proc->process);
    free(proc);
}

/* ================================================================ SO: POSIX */
#else

static char *env_get(const char *name) {
    const char *v = getenv(name);
    return v != NULL ? str_dup(v) : NULL;
}

static ah_status env_set(const char *name, const char *value) {
    int rc = value != NULL ? setenv(name, value, 1) : unsetenv(name);
    return rc == 0 ? AH_OK : AH_ERR_IO;
}

static ah_status env_snapshot(strv *out) {
    char **e;
    for (e = environ; e != NULL && *e != NULL; e++) {
        ah_status st = strv_push(out, str_dup(*e));
        if (st != AH_OK) {
            return st;
        }
    }
    return AH_OK;
}

static char *canon_depth(const char *path, int depth) {
    char *r;
    char *copy;
    char *slash;
    char *parent;
    char *res;
    size_t len;

    if (depth > 64 || path[0] == '\0') {
        return NULL;
    }
    r = realpath(path, NULL);
    if (r != NULL) {
        return r;
    }
    copy = str_dup(path);
    if (copy == NULL) {
        return NULL;
    }
    len = strlen(copy);
    while (len > 1 && copy[len - 1] == '/') {
        copy[--len] = '\0';
    }
    slash = strrchr(copy, '/');
    if (slash == NULL) {
        parent = canon_depth(".", depth + 1);
        res = parent != NULL ? str_cat3(parent, "/", copy) : NULL;
    } else if (slash == copy) {
        res = str_cat3("/", slash + 1, "");
        parent = NULL;
    } else {
        const char *name = slash + 1;
        *slash = '\0';
        parent = canon_depth(copy, depth + 1);
        if (parent == NULL) {
            res = NULL;
        } else if (strcmp(name, ".") == 0) {
            res = str_dup(parent);
        } else if (strcmp(name, "..") == 0) {
            /* realpath falhou porque algo não existe: resolve ".." no texto. */
            char *last;
            res = str_dup(parent);
            last = res != NULL ? strrchr(res, '/') : NULL;
            if (last != NULL) {
                last[last == res ? 1 : 0] = '\0';
            }
        } else {
            res = str_cat3(parent, strcmp(parent, "/") == 0 ? "" : "/", name);
        }
    }
    free(parent);
    free(copy);
    return res;
}

static char *canon(const char *path) {
    char *c = canon_depth(path, 0);
    size_t len;
    if (c == NULL) {
        return NULL;
    }
    len = strlen(c);
    while (len > 1 && c[len - 1] == '/') {
        c[--len] = '\0';
    }
    return c;
}

static ah_status user_homes(strv *out) {
    struct passwd *pw = getpwuid(getuid());
    char *home = env_get("HOME");
    ah_status st;
    if (pw != NULL && pw->pw_dir != NULL && pw->pw_dir[0] != '\0') {
        st = strv_push(out, str_dup(pw->pw_dir));
        if (st != AH_OK) {
            free(home);
            return st;
        }
    }
    if (home != NULL && home[0] != '\0') {
        return strv_push(out, home);
    }
    free(home);
    return AH_OK;
}

static char *temp_base(void) {
    const char *t = getenv("TMPDIR");
    char *b = str_dup(t != NULL && t[0] != '\0' ? t : "/tmp");
    size_t len;
    if (b == NULL) {
        return NULL;
    }
    len = strlen(b);
    while (len > 1 && b[len - 1] == '/') {
        b[--len] = '\0';
    }
    return b;
}

static ah_status make_unique_dir(const char *base, char **out) {
    char *tmpl = str_cat3(base, "/" HOME_DIR_PREFIX, "XXXXXX");
    char *real;
    if (tmpl == NULL) {
        return AH_ERR_NOMEM;
    }
    if (mkdtemp(tmpl) == NULL) { /* modo 0700 */
        free(tmpl);
        return AH_ERR_IO;
    }
    real = realpath(tmpl, NULL);
    if (real == NULL) {
        rmdir(tmpl);
        free(tmpl);
        return AH_ERR_IO;
    }
    free(tmpl);
    *out = real;
    return AH_OK;
}

static int rm_entry(const char *path, const struct stat *sb, int flag, struct FTW *ftw) {
    (void)sb;
    (void)flag;
    (void)ftw;
    return remove(path); /* FTW_PHYS: um symlink é removido, nunca seguido */
}

static int remove_tree(const char *path) {
    struct stat sb;
    if (lstat(path, &sb) != 0) {
        return errno == ENOENT;
    }
    return nftw(path, rm_entry, 16, FTW_DEPTH | FTW_PHYS) == 0;
}

ah_status ah_itest_make_dir(const char *path) {
    return mkdir(path, 0700) == 0 ? AH_OK : AH_ERR_IO;
}

int ah_itest_path_exists(const char *path) {
    struct stat sb;
    return lstat(path, &sb) == 0;
}

ah_status ah_itest_make_link(const char *link, const char *target, ah_itest_link_kind kind) {
    struct stat sb;
    if (link == NULL || target == NULL ||
        (kind != AH_ITEST_LINK_DIR && kind != AH_ITEST_LINK_FILE)) {
        return AH_ERR_INVALID;
    }
    if (stat(target, &sb) != 0) {
        return AH_ERR_NOT_FOUND;
    }
    return symlink(target, link) == 0 ? AH_OK : AH_ERR_IO;
}

static ah_status os_free_port(void *ctx, unsigned *port) {
    int s;
    struct sockaddr_in addr;
    socklen_t len = sizeof addr;
    ah_status st = AH_ERR_IO;
    (void)ctx;
    s = socket(AF_INET, SOCK_STREAM, 0);
    if (s < 0) {
        return AH_ERR_IO;
    }
    memset(&addr, 0, sizeof addr);
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = 0;
    if (bind(s, (struct sockaddr *)&addr, sizeof addr) == 0 &&
        getsockname(s, (struct sockaddr *)&addr, &len) == 0) {
        *port = ntohs(addr.sin_port);
        st = AH_OK;
    }
    close(s);
    return st;
}

ah_status ah_itest_spawn(const ah_itest_env *env, const char *exe,
                         const ah_itest_spawn_opts *opts, ah_itest_proc **out) {
    char **vars = NULL;
    size_t nvars = 0;
    char **argv;
    size_t nargs = opts != NULL ? opts->nargs : 0;
    size_t i;
    ah_status st;
    ah_itest_proc *p;
    pid_t pid;

    if (env == NULL || exe == NULL || out == NULL) {
        return AH_ERR_INVALID;
    }
    *out = NULL;
    for (i = 0; i < nargs; i++) {
        if (opts->args[i] == NULL) {
            return AH_ERR_INVALID;
        }
    }
    st = ah_itest_env_child_environ(env, opts, &vars, &nvars);
    if (st != AH_OK) {
        return st;
    }
    argv = calloc(nargs + 2, sizeof *argv);
    p = calloc(1, sizeof *p);
    if (argv == NULL || p == NULL) {
        free(argv);
        free(p);
        ah_itest_strv_free(vars);
        return AH_ERR_NOMEM;
    }
    argv[0] = (char *)exe;
    for (i = 0; i < nargs; i++) {
        argv[i + 1] = (char *)opts->args[i];
    }
    pid = fork();
    if (pid == 0) {
        if (chdir(env->home) != 0) {
            _exit(127);
        }
        execve(exe, argv, vars);
        _exit(127);
    }
    free(argv);
    ah_itest_strv_free(vars);
    if (pid < 0) {
        free(p);
        return AH_ERR_IO;
    }
    p->pid = pid;
    *out = p;
    return AH_OK;
}

ah_status ah_itest_proc_wait(ah_itest_proc *proc, int *exit_code) {
    int status = 0;
    pid_t r;
    if (proc == NULL || exit_code == NULL) {
        return AH_ERR_INVALID;
    }
    if (!proc->reaped) {
        do {
            r = waitpid(proc->pid, &status, 0);
        } while (r < 0 && errno == EINTR);
        if (r != proc->pid) {
            return AH_ERR_IO;
        }
        proc->reaped = 1;
        if (WIFEXITED(status)) {
            proc->exit_code = WEXITSTATUS(status);
        } else if (WIFSIGNALED(status)) {
            proc->exit_code = 128 + WTERMSIG(status);
        } else {
            proc->exit_code = -1;
        }
    }
    *exit_code = proc->exit_code;
    return AH_OK;
}

ah_status ah_itest_proc_kill(ah_itest_proc *proc) {
    if (proc == NULL) {
        return AH_ERR_INVALID;
    }
    if (proc->reaped) {
        return AH_OK;
    }
    return kill(proc->pid, SIGKILL) == 0 || errno == ESRCH ? AH_OK : AH_ERR_IO;
}

void ah_itest_proc_free(ah_itest_proc *proc) {
    int code;
    if (proc == NULL) {
        return;
    }
    if (!proc->reaped) {
        (void)kill(proc->pid, SIGKILL);
        (void)ah_itest_proc_wait(proc, &code);
    }
    free(proc);
}

#endif /* SO */

/* ================================================================ política */

ah_status ah_itest_getenv(const char *name, char *buf, size_t cap) {
    char *v;
    size_t len;
    if (name == NULL || buf == NULL || cap == 0) {
        return AH_ERR_INVALID;
    }
    v = env_get(name);
    if (v == NULL) {
        buf[0] = '\0';
        return AH_ERR_NOT_FOUND;
    }
    len = strlen(v);
    if (len >= cap) {
        free(v);
        buf[0] = '\0';
        return AH_ERR_LIMIT;
    }
    memcpy(buf, v, len + 1);
    free(v);
    return AH_OK;
}

ah_status ah_itest_setenv(const char *name, const char *value) {
    if (name == NULL || name[0] == '\0' || strchr(name, '=') != NULL) {
        return AH_ERR_INVALID;
    }
    return env_set(name, value);
}

ah_status ah_itest_environ_snapshot(char ***out, size_t *count) {
    strv s = {0};
    ah_status st;
    if (out == NULL || count == NULL) {
        return AH_ERR_INVALID;
    }
    st = env_snapshot(&s);
    if (st == AH_OK && s.v == NULL) {
        /* Ambiente vazio: devolve lista só com o NULL final. */
        s.v = calloc(1, sizeof *s.v);
        if (s.v == NULL) {
            st = AH_ERR_NOMEM;
        }
    }
    if (st != AH_OK) {
        strv_dispose(&s);
        return st;
    }
    *out = s.v;
    *count = s.n;
    return AH_OK;
}

/* Raízes proibidas canônicas: <home>/.agents-hub de cada home do usuário e o
 * AGENTS_HUB_HOME do ambiente. Falha ao canonizar = erro (o chamador recusa). */
static ah_status forbidden_roots(strv *out) {
    strv homes = {0};
    ah_status st = user_homes(&homes);
    size_t i;
    char *hub_home;

    for (i = 0; st == AH_OK && i < homes.n; i++) {
#if defined(_WIN32)
        char *raw = str_cat3(homes.v[i], "\\", ".agents-hub");
#else
        char *raw = str_cat3(homes.v[i], "/", ".agents-hub");
#endif
        char *c = raw != NULL ? canon(raw) : NULL;
        free(raw);
        st = c != NULL ? strv_push(out, c) : AH_ERR_INTERNAL;
    }
    strv_dispose(&homes);
    if (st != AH_OK) {
        return st;
    }
    hub_home = env_get("AGENTS_HUB_HOME");
    if (hub_home != NULL && hub_home[0] != '\0') {
        char *c = canon(hub_home);
        free(hub_home);
        return c != NULL ? strv_push(out, c) : AH_ERR_INTERNAL;
    }
    free(hub_home);
    return AH_OK;
}

/* allow_ancestor = 1: `path` pode conter uma raiz (usado só para a base
 * temporária, onde o home novo nasce como subdiretório vazio). */
static int forbidden_check(const char *path, int allow_ancestor) {
    strv roots = {0};
    char *c;
    int bad = 0;
    size_t i;

    if (path == NULL || path[0] == '\0') {
        return 1;
    }
    c = canon(path);
    if (c == NULL || forbidden_roots(&roots) != AH_OK) {
        free(c);
        strv_dispose(&roots);
        return 1;
    }
    for (i = 0; i < roots.n && !bad; i++) {
        if (is_under(c, roots.v[i]) || (!allow_ancestor && is_under(roots.v[i], c))) {
            bad = 1;
        }
    }
    free(c);
    strv_dispose(&roots);
    return bad;
}

int ah_itest_path_is_forbidden(const char *path) {
    return forbidden_check(path, 0);
}

ah_status ah_itest_remove_tree(const char *path) {
    if (path == NULL || ah_itest_path_is_forbidden(path)) {
        return AH_ERR_INVALID;
    }
    return remove_tree(path) ? AH_OK : AH_ERR_IO;
}

static unsigned parent_port(void) {
    char buf[32];
    char *end = NULL;
    unsigned long v;
    if (ah_itest_getenv("AGENTS_HUB_PORT", buf, sizeof buf) != AH_OK) {
        return 0;
    }
    v = strtoul(buf, &end, 10);
    if (end == buf || *end != '\0' || v > 65535ul) {
        return 0;
    }
    return (unsigned)v;
}

ah_status ah_itest_pick_port(ah_itest_port_source source, void *ctx, unsigned *out) {
    unsigned avoid = parent_port();
    int i;
    if (out == NULL) {
        return AH_ERR_INVALID;
    }
    if (source == NULL) {
        source = os_free_port;
    }
    for (i = 0; i < AH_ITEST_PORT_ATTEMPTS; i++) {
        unsigned p = 0;
        ah_status st = source(ctx, &p);
        if (st != AH_OK) {
            return st;
        }
        if (p >= 1024u && p <= 65535u && p != AH_ITEST_FORBIDDEN_PORT && p != avoid) {
            *out = p;
            return AH_OK;
        }
    }
    return AH_ERR_LIMIT;
}

ah_status ah_itest_env_create(ah_itest_env **out, char *err, size_t err_cap) {
    ah_itest_env *env;
    char *base;
    char *home = NULL;
    unsigned port = 0;
    ah_status st;

    if (out == NULL) {
        return AH_ERR_INVALID;
    }
    *out = NULL;
    set_err(err, err_cap, "%s", "");
    base = temp_base();
    if (base == NULL) {
        set_err(err, err_cap, "diretório temporário do SO indisponível");
        return AH_ERR_IO;
    }
    /* Antes de criar qualquer coisa: a base não pode estar em uma raiz proibida. */
    if (forbidden_check(base, 1)) {
        set_err(err, err_cap,
                "diretório temporário \"%s\" está em ~/.agents-hub ou no AGENTS_HUB_HOME do "
                "ambiente: recusado",
                base);
        free(base);
        return AH_ERR_INVALID;
    }
    st = make_unique_dir(base, &home);
    if (st != AH_OK) {
        set_err(err, err_cap, "não criou o home temporário em \"%s\"", base);
        free(base);
        return st;
    }
    free(base);
    if (forbidden_check(home, 0)) {
        set_err(err, err_cap, "home temporário \"%s\" cai em caminho proibido: recusado", home);
        (void)remove_tree(home); /* acabou de ser criado vazio por nós */
        free(home);
        return AH_ERR_INVALID;
    }
    st = ah_itest_pick_port(NULL, NULL, &port);
    if (st != AH_OK) {
        set_err(err, err_cap, "sem porta livre aceitável em 127.0.0.1");
        (void)remove_tree(home);
        free(home);
        return st;
    }
    env = malloc(sizeof *env);
    if (env == NULL) {
        (void)remove_tree(home);
        free(home);
        return AH_ERR_NOMEM;
    }
    env->home = home;
    env->port = port;
    *out = env;
    return AH_OK;
}

const char *ah_itest_env_home(const ah_itest_env *env) {
    return env != NULL ? env->home : NULL;
}

unsigned ah_itest_env_port(const ah_itest_env *env) {
    return env != NULL ? env->port : 0u;
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

ah_status ah_itest_env_destroy(ah_itest_env *env) {
    ah_status st = AH_OK;
    if (env == NULL) {
        return AH_OK;
    }
    /* Defesa extra: só remove o que tem cara de home criado por nós. */
    if (strncmp(base_name(env->home), HOME_DIR_PREFIX, sizeof HOME_DIR_PREFIX - 1) != 0 ||
        ah_itest_path_is_forbidden(env->home)) {
        st = AH_ERR_INTERNAL;
    } else if (!remove_tree(env->home)) {
        st = AH_ERR_IO;
    }
    free(env->home);
    free(env);
    return st;
}

ah_status ah_itest_env_child_environ(const ah_itest_env *env,
                                     const ah_itest_spawn_opts *opts, char ***out,
                                     size_t *count) {
    strv parent = {0};
    strv child = {0};
    size_t n_extra = opts != NULL ? opts->n_extra_env : 0;
    size_t i;
    size_t j;
    char port_buf[16];
    ah_status st;
    int n;

    if (env == NULL || out == NULL || count == NULL) {
        return AH_ERR_INVALID;
    }
    *out = NULL;
    *count = 0;
    for (i = 0; i < n_extra; i++) {
        const char *e = opts->extra_env[i];
        /* Nenhuma AGENTS_HUB_* vem do chamador: só as três do helper. */
        if (e == NULL || e[0] == '=' || strchr(e, '=') == NULL || env_is_hub_var(e)) {
            return AH_ERR_INVALID;
        }
    }
    st = env_snapshot(&parent);
    for (i = 0; st == AH_OK && i < parent.n; i++) {
        int drop = env_is_hub_var(parent.v[i]);
        for (j = 0; !drop && j < n_extra; j++) {
            drop = env_same_name(parent.v[i], opts->extra_env[j]);
        }
        if (!drop) {
            st = strv_push(&child, str_dup(parent.v[i]));
        }
    }
    strv_dispose(&parent);
    for (i = 0; st == AH_OK && i < n_extra; i++) {
        st = strv_push(&child, str_dup(opts->extra_env[i]));
    }
    n = snprintf(port_buf, sizeof port_buf, "%u", env->port);
    if (st == AH_OK && (n < 0 || (size_t)n >= sizeof port_buf)) {
        st = AH_ERR_INTERNAL;
    }
    if (st == AH_OK) {
        st = strv_push(&child, str_cat3("AGENTS_HUB_HOME", "=", env->home));
    }
    if (st == AH_OK) {
        st = strv_push(&child, str_cat3("AGENTS_HUB_PORT", "=", port_buf));
    }
    if (st == AH_OK) {
        st = strv_push(&child, str_dup("AGENTS_HUB_NO_AUTOSTART=1"));
    }
    if (st != AH_OK) {
        strv_dispose(&child);
        return st;
    }
    *out = child.v;
    *count = child.n;
    return AH_OK;
}
