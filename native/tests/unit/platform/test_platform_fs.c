/* Testes da área de arquivos de ah_platform (F0-05).
 *
 * Tudo acontece num diretório temporário próprio do teste, removido no fim.
 * O home do Hub é testado trocando AGENTS_HUB_HOME e USERPROFILE/HOME do
 * PRÓPRIO processo para caminhos dentro desse diretório: o ~/.agents-hub real
 * nunca é lido nem escrito (CLAUDE.md, regra inviolável 1).
 *
 * As conferências de permissão são feitas também por fora da API testada
 * (DACL lida com as APIs Win32; stat no POSIX), para o teste não confiar só
 * em ah_platform_fs_check_restricted.
 *
 * Literais não ASCII vão em escapes (UTF-8 em "\x..", UTF-16 em L"\x...")
 * para não dependerem da página de código com que o compilador lê a fonte. */
#if !defined(_WIN32)
#define _XOPEN_SOURCE 700
#endif

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include <aclapi.h>
#else
#include <dirent.h>
#include <errno.h>
#include <pthread.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#endif

#include "ah_platform_fs.h"
#include "ah_test.h"

/* "ação" e "日本" em UTF-8. */
#define ACAO_U8 "a\xC3\xA7\xC3\xA3o"
#define NIHON_U8 "\xE6\x97\xA5\xE6\x9C\xAC"

static char *g_root = NULL; /* diretório temporário do teste (UTF-8) */

/* ------------------------------------------------------------------------ */
/* Utilitários do teste (chamam o SO direto, de propósito)                   */
/* ------------------------------------------------------------------------ */

static char *join(const char *a, const char *b) {
    char *out = NULL;
    if (ah_platform_path_join(a, b, &out) != AH_OK) return NULL;
    return out;
}

static bool str_eq(const char *a, const char *b) {
    return a != NULL && b != NULL && strcmp(a, b) == 0;
}

#if defined(_WIN32)

static wchar_t *wide(const char *u8) {
    wchar_t *w = NULL;
    if (ah_platform_utf8_to_utf16(u8, &w) != AH_OK) return NULL;
    return w;
}

static void remove_tree_w(const wchar_t *dir) {
    size_t n = wcslen(dir);
    wchar_t *pat = malloc((n + 3) * sizeof *pat);
    WIN32_FIND_DATAW fd;
    HANDLE h;

    if (pat == NULL) return;
    memcpy(pat, dir, n * sizeof *pat);
    pat[n] = L'\\';
    pat[n + 1] = L'*';
    pat[n + 2] = L'\0';
    h = FindFirstFileW(pat, &fd);
    if (h != INVALID_HANDLE_VALUE) {
        do {
            size_t m;
            wchar_t *child;
            if (wcscmp(fd.cFileName, L".") == 0 ||
                wcscmp(fd.cFileName, L"..") == 0) {
                continue;
            }
            m = wcslen(fd.cFileName);
            child = malloc((n + m + 2) * sizeof *child);
            if (child == NULL) continue;
            memcpy(child, dir, n * sizeof *child);
            child[n] = L'\\';
            memcpy(child + n + 1, fd.cFileName, (m + 1) * sizeof *child);
            if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
                remove_tree_w(child);
            } else {
                SetFileAttributesW(child, FILE_ATTRIBUTE_NORMAL);
                DeleteFileW(child);
            }
            free(child);
        } while (FindNextFileW(h, &fd));
        FindClose(h);
    }
    free(pat);
    RemoveDirectoryW(dir);
}

static void remove_tree(const char *dir) {
    wchar_t *w = wide(dir);
    if (w != NULL) remove_tree_w(w);
    free(w);
}

/* Quantas entradas de `dir` contêm ".tmp-" (temporários esquecidos). */
static int count_tmp_entries(const char *dir) {
    char *pat = join(dir, "*");
    wchar_t *w = pat ? wide(pat) : NULL;
    WIN32_FIND_DATAW fd;
    HANDLE h;
    int count = 0;

    free(pat);
    if (w == NULL) return -1;
    h = FindFirstFileW(w, &fd);
    free(w);
    if (h == INVALID_HANDLE_VALUE) return -1;
    do {
        if (wcsstr(fd.cFileName, L".tmp-") != NULL) count++;
    } while (FindNextFileW(h, &fd));
    FindClose(h);
    return count;
}

static char *make_temp_root(void) {
    wchar_t buf[MAX_PATH + 1];
    char *base = NULL, *root = NULL;
    char name[64];
    DWORD n = GetTempPathW(MAX_PATH + 1, buf);
    int k;

    if (n == 0 || n > MAX_PATH) return NULL;
    if (ah_platform_utf16_to_utf8(buf, &base) != AH_OK) return NULL;
    k = snprintf(name, sizeof name, "ah-test-fs-%lu-%lu",
                 (unsigned long)GetCurrentProcessId(),
                 (unsigned long)GetTickCount());
    if (k > 0 && (size_t)k < sizeof name) root = join(base, name);
    free(base);
    return root;
}

static bool exists_dir(const char *path) {
    wchar_t *w = wide(path);
    DWORD a = w ? GetFileAttributesW(w) : INVALID_FILE_ATTRIBUTES;
    free(w);
    return a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY);
}

static bool exists_any(const char *path) {
    wchar_t *w = wide(path);
    DWORD a = w ? GetFileAttributesW(w) : INVALID_FILE_ATTRIBUTES;
    free(w);
    return a != INVALID_FILE_ATTRIBUTES;
}

/* Conferência independente da DACL: protegida, sem ACE herdada, toda ACE
 * de permissão para o SID do usuário do processo, com controle total; em
 * diretório, a ACE precisa ser herdável por arquivos e pastas. */
static bool dacl_only_user(const char *path, bool is_dir) {
    wchar_t *w = wide(path);
    PACL dacl = NULL;
    PSECURITY_DESCRIPTOR sd = NULL;
    SECURITY_DESCRIPTOR_CONTROL ctrl = 0;
    DWORD rev = 0, i, size = 0;
    HANDLE token = NULL;
    TOKEN_USER *tu = NULL;
    bool ok = false;

    if (w == NULL) return false;
    if (GetNamedSecurityInfoW(w, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                              NULL, NULL, &dacl, NULL, &sd) != ERROR_SUCCESS) {
        free(w);
        return false;
    }
    free(w);
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) goto done;
    GetTokenInformation(token, TokenUser, NULL, 0, &size);
    tu = size ? malloc(size) : NULL;
    if (tu == NULL || !GetTokenInformation(token, TokenUser, tu, size, &size)) {
        goto done;
    }
    if (!GetSecurityDescriptorControl(sd, &ctrl, &rev)) goto done;
    if (dacl == NULL || !(ctrl & SE_DACL_PROTECTED) || dacl->AceCount == 0) {
        goto done;
    }
    ok = true;
    for (i = 0; i < dacl->AceCount; i++) {
        ACCESS_ALLOWED_ACE *ace = NULL;
        if (!GetAce(dacl, i, (void **)&ace) ||
            ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE ||
            (ace->Header.AceFlags & INHERITED_ACE) ||
            !EqualSid((PSID)&ace->SidStart, tu->User.Sid) ||
            (ace->Mask & FILE_ALL_ACCESS) != FILE_ALL_ACCESS) {
            ok = false;
            break;
        }
        if (is_dir && (ace->Header.AceFlags &
                       (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)) !=
                          (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)) {
            ok = false;
            break;
        }
    }
done:
    free(tu);
    if (token != NULL) CloseHandle(token);
    LocalFree(sd);
    return ok;
}

static bool private_dir_ok(const char *path) {
    return dacl_only_user(path, true);
}
static bool private_file_ok(const char *path) {
    return dacl_only_user(path, false);
}

/* Variáveis de ambiente do processo (a implementação lê com
 * GetEnvironmentVariableW). `value` NULL remove. */
static void env_set(const char *name, const char *value) {
    wchar_t *wn = wide(name);
    wchar_t *wv = value ? wide(value) : NULL;
    if (wn != NULL) SetEnvironmentVariableW(wn, wv);
    free(wn);
    free(wv);
}

static char *env_get(const char *name) {
    wchar_t *wn = wide(name);
    wchar_t buf[32768];
    char *out = NULL;
    DWORD n;
    if (wn == NULL) return NULL;
    SetLastError(ERROR_SUCCESS);
    n = GetEnvironmentVariableW(wn, buf, (DWORD)(sizeof buf / sizeof buf[0]));
    free(wn);
    if (n == 0 && GetLastError() == ERROR_ENVVAR_NOT_FOUND) return NULL;
    if (n >= sizeof buf / sizeof buf[0]) return NULL;
    if (n == 0) buf[0] = L'\0';
    if (ah_platform_utf16_to_utf8(buf, &out) != AH_OK) return NULL;
    return out;
}

#define USER_HOME_VAR "USERPROFILE"

#else /* POSIX */

static void remove_tree(const char *dir) {
    DIR *d = opendir(dir);
    struct dirent *e;
    if (d != NULL) {
        while ((e = readdir(d)) != NULL) {
            char *child;
            struct stat st;
            if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) {
                continue;
            }
            child = join(dir, e->d_name);
            if (child == NULL) continue;
            if (lstat(child, &st) == 0 && S_ISDIR(st.st_mode)) {
                remove_tree(child);
            } else {
                unlink(child);
            }
            free(child);
        }
        closedir(d);
    }
    rmdir(dir);
}

static int count_tmp_entries(const char *dir) {
    DIR *d = opendir(dir);
    struct dirent *e;
    int count = 0;
    if (d == NULL) return -1;
    while ((e = readdir(d)) != NULL) {
        if (strstr(e->d_name, ".tmp-") != NULL) count++;
    }
    closedir(d);
    return count;
}

static char *make_temp_root(void) {
    const char *base = getenv("TMPDIR");
    char *tmpl;
    if (base == NULL || base[0] == '\0') base = "/tmp";
    tmpl = join(base, "ah-test-fs-XXXXXX");
    if (tmpl == NULL) return NULL;
    if (mkdtemp(tmpl) == NULL) {
        free(tmpl);
        return NULL;
    }
    return tmpl;
}

static bool exists_dir(const char *path) {
    struct stat st;
    return stat(path, &st) == 0 && S_ISDIR(st.st_mode);
}

static bool exists_any(const char *path) {
    struct stat st;
    return lstat(path, &st) == 0;
}

static bool mode_is(const char *path, mode_t want) {
    struct stat st;
    return lstat(path, &st) == 0 && (st.st_mode & 0777) == want &&
           st.st_uid == geteuid();
}

static bool private_dir_ok(const char *path) {
    return mode_is(path, 0700);
}
static bool private_file_ok(const char *path) {
    return mode_is(path, 0600);
}

static void env_set(const char *name, const char *value) {
    if (value != NULL) {
        setenv(name, value, 1);
    } else {
        unsetenv(name);
    }
}

static char *env_get(const char *name) {
    const char *v = getenv(name);
    char *out;
    size_t n;
    if (v == NULL) return NULL;
    n = strlen(v);
    out = malloc(n + 1);
    if (out != NULL) memcpy(out, v, n + 1);
    return out;
}

#define USER_HOME_VAR "HOME"

#endif

/* Lê `path` e confere que o conteúdo é exatamente `want`. */
static bool content_is(const char *path, const char *want) {
    char *buf = NULL;
    size_t len = 0;
    bool ok;
    if (ah_platform_fs_read_all(path, 1u << 20, &buf, &len) != AH_OK) {
        return false;
    }
    ok = len == strlen(want) && memcmp(buf, want, len) == 0 && buf[len] == 0;
    free(buf);
    return ok;
}

/* ------------------------------------------------------------------------ */
/* Texto                                                                     */
/* ------------------------------------------------------------------------ */

#if defined(_WIN32)
static void test_utf8_utf16(void) {
    wchar_t *w = NULL;
    char *s = NULL;
    /* "ação 日本 😀" em UTF-8; o emoji (U+1F600) vira par substituto. */
    const char *u8 = ACAO_U8 " " NIHON_U8 " \xF0\x9F\x98\x80";
    const wchar_t expected[] = {0x61, 0xE7, 0xE3, 0x6F, 0x20, 0x65E5, 0x672C,
                                0x20, 0xD83D, 0xDE00, 0};
    const wchar_t lone[] = {0x61, 0xD800, 0x62, 0};

    CHECK(ah_platform_utf8_to_utf16(u8, &w) == AH_OK);
    CHECK(w != NULL && wcscmp(w, expected) == 0);
    CHECK(ah_platform_utf16_to_utf8(expected, &s) == AH_OK);
    CHECK(str_eq(s, u8));
    free(w);
    free(s);

    w = NULL;
    CHECK(ah_platform_utf8_to_utf16("", &w) == AH_OK);
    CHECK(w != NULL && w[0] == L'\0');
    free(w);

    /* UTF-8 inválido e surrogate isolado são recusados, sem saída. */
    w = (wchar_t *)1;
    CHECK(ah_platform_utf8_to_utf16("a\xC3(", &w) == AH_ERR_INVALID);
    CHECK(w == NULL);
    s = (char *)1;
    CHECK(ah_platform_utf16_to_utf8(lone, &s) == AH_ERR_INVALID);
    CHECK(s == NULL);
    CHECK(ah_platform_utf8_to_utf16(NULL, &w) == AH_ERR_INVALID);
}
#endif

/* ------------------------------------------------------------------------ */
/* Caminhos                                                                  */
/* ------------------------------------------------------------------------ */

static void check_norm(const char *in, const char *want) {
    char *out = NULL;
    ah_status st = ah_platform_path_normalize(in, &out);
    CHECK(st == AH_OK);
    if (!str_eq(out, want)) {
        fprintf(stderr, "  normalize(\"%s\") = \"%s\", esperado \"%s\"\n", in,
                out ? out : "(null)", want);
    }
    CHECK(str_eq(out, want));
    free(out);
}

static void check_join(const char *a, const char *b, const char *want) {
    char *out = NULL;
    CHECK(ah_platform_path_join(a, b, &out) == AH_OK);
    if (!str_eq(out, want)) {
        fprintf(stderr, "  join(\"%s\", \"%s\") = \"%s\", esperado \"%s\"\n",
                a, b, out ? out : "(null)", want);
    }
    CHECK(str_eq(out, want));
    free(out);
}

static void test_paths(void) {
    char *out = (char *)1;

    check_norm("", ".");
    check_norm(".", ".");
#if defined(_WIN32)
    check_norm("a/./b//c/", "a\\b\\c");
    check_norm("a/../..", "..");
    check_norm("../a/../../b", "..\\..\\b");
    check_norm("C:/Users//Bruno Silva/./x/..", "C:\\Users\\Bruno Silva");
    check_norm("C:\\..\\..\\x", "C:\\x");
    check_norm("C:\\", "C:\\");
    check_norm("c:x\\..\\y", "c:y");
    check_norm("\\a\\..\\b", "\\b");
    check_norm("//srv/share/a/../b", "\\\\srv\\share\\b");
    check_norm("\\\\srv\\share", "\\\\srv\\share\\");
    check_norm("\\\\?\\C:\\a\\..\\b", "\\\\?\\C:\\a\\..\\b");
    check_norm("C:\\Users\\Bruno Silva\\" ACAO_U8 "\\" NIHON_U8 "\\",
               "C:\\Users\\Bruno Silva\\" ACAO_U8 "\\" NIHON_U8);

    check_join("C:\\a", "b", "C:\\a\\b");
    check_join("C:\\a\\", "\\b/", "C:\\a\\b");
    check_join("C:\\a", "../b", "C:\\b");
    check_join("", "b", "b");
    check_join("a", "", "a");
    check_join("C:\\Users\\Bruno Silva", ".agents-hub",
               "C:\\Users\\Bruno Silva\\.agents-hub");
#else
    check_norm("a/./b//c/", "a/b/c");
    check_norm("a/../..", "..");
    check_norm("../a/../../b", "../../b");
    check_norm("/usr//lib/./x/..", "/usr/lib");
    check_norm("/../../x", "/x");
    check_norm("/", "/");
    check_norm("//a", "/a");
    check_norm("a\\b", "a\\b"); /* '\\' não é separador no POSIX */
    check_norm("/home/bruno/" ACAO_U8 "/" NIHON_U8 "/",
               "/home/bruno/" ACAO_U8 "/" NIHON_U8);

    check_join("/a", "b", "/a/b");
    check_join("/a/", "/b/", "/a/b");
    check_join("/a", "../b", "/b");
    check_join("", "b", "b");
    check_join("a", "", "a");
    check_join("/home/bruno", ".agents-hub", "/home/bruno/.agents-hub");
#endif

    CHECK(ah_platform_path_normalize(NULL, &out) == AH_ERR_INVALID);
    CHECK(out == NULL);
    CHECK(ah_platform_path_join("a", NULL, &out) == AH_ERR_INVALID);
}

/* ------------------------------------------------------------------------ */
/* Diretórios                                                                */
/* ------------------------------------------------------------------------ */

static void test_mkdirs(void) {
    char *a = join(g_root, "mk");
    char *abc = NULL, *ab = NULL, *file = NULL, *under_file = NULL;

    CHECK(a != NULL);
    if (a == NULL) return;
    ab = join(a, "b");
    abc = join(ab, "c");
    CHECK(ab != NULL && abc != NULL);
    if (ab == NULL || abc == NULL) goto out;

    CHECK(ah_platform_fs_mkdirs(abc) == AH_OK);
    CHECK(exists_dir(abc));
    /* Cada pasta criada é privada (0700 / DACL só do usuário, herdável). */
    CHECK(private_dir_ok(a));
    CHECK(private_dir_ok(ab));
    CHECK(private_dir_ok(abc));
    {
        bool r = false;
        CHECK(ah_platform_fs_check_restricted(abc, &r) == AH_OK);
        CHECK(r);
    }
    /* Repetir é idempotente. */
    CHECK(ah_platform_fs_mkdirs(abc) == AH_OK);

    /* Um componente que é arquivo impede a criação. */
    file = join(a, "arquivo");
    under_file = file ? join(file, "sub") : NULL;
    CHECK(file != NULL && under_file != NULL);
    if (file != NULL && under_file != NULL) {
        CHECK(ah_platform_fs_write_atomic(file, "x", 1, 0) == AH_OK);
        CHECK(ah_platform_fs_mkdirs(under_file) != AH_OK);
        CHECK(!exists_any(under_file));
    }
    CHECK(ah_platform_fs_mkdirs(NULL) == AH_ERR_INVALID);
    CHECK(ah_platform_fs_mkdirs("") == AH_ERR_INVALID);
out:
    free(under_file);
    free(file);
    free(abc);
    free(ab);
    free(a);
}

/* ------------------------------------------------------------------------ */
/* Escrita atômica                                                           */
/* ------------------------------------------------------------------------ */

static void test_write_atomic_basic(void) {
    char *dir = join(g_root, "atomic");
    char *file = dir ? join(dir, "config.json") : NULL;
    char *pub = dir ? join(dir, "publico.txt") : NULL;
    bool r = true;

    CHECK(file != NULL && pub != NULL);
    if (file == NULL || pub == NULL) goto out;

    /* Cria a pasta pai que falta, como o gravarAtomico do TS. */
    CHECK(!exists_any(dir));
    CHECK(ah_platform_fs_write_atomic(file, "v1", 2, AH_PLATFORM_FS_PRIVATE) ==
          AH_OK);
    CHECK(exists_dir(dir));
    CHECK(private_dir_ok(dir));
    CHECK(content_is(file, "v1"));
    CHECK(count_tmp_entries(dir) == 0);

    /* Substitui por inteiro (maior e depois menor que o anterior). */
    CHECK(ah_platform_fs_write_atomic(file, "versao-2-maior", 14,
                                      AH_PLATFORM_FS_PRIVATE) == AH_OK);
    CHECK(content_is(file, "versao-2-maior"));
    CHECK(ah_platform_fs_write_atomic(file, "v3", 2, AH_PLATFORM_FS_PRIVATE) ==
          AH_OK);
    CHECK(content_is(file, "v3"));
    CHECK(count_tmp_entries(dir) == 0);

    /* Privado: restrito ao usuário já no nome final. */
    CHECK(private_file_ok(file));
    CHECK(ah_platform_fs_check_restricted(file, &r) == AH_OK);
    CHECK(r);

    /* Vazio é válido. */
    CHECK(ah_platform_fs_write_atomic(file, NULL, 0, AH_PLATFORM_FS_PRIVATE) ==
          AH_OK);
    CHECK(content_is(file, ""));

    /* Sem a opção privada o arquivo herda da pasta (Windows: ACE herdada,
     * logo não "restrito"); no POSIX vale a umask(077) de
     * ah_platform_fs_init, então nasce 0600. */
    CHECK(ah_platform_fs_write_atomic(pub, "p", 1, 0) == AH_OK);
    CHECK(content_is(pub, "p"));
    CHECK(ah_platform_fs_check_restricted(pub, &r) == AH_OK);
#if defined(_WIN32)
    CHECK(!r);
    CHECK(!private_file_ok(pub));
#else
    CHECK(r);
    CHECK(private_file_ok(pub));
#endif

    CHECK(ah_platform_fs_write_atomic(file, NULL, 1, 0) == AH_ERR_INVALID);
    CHECK(ah_platform_fs_write_atomic(file, "x", 1, 0x80u) == AH_ERR_INVALID);
    CHECK(content_is(file, ""));
out:
    free(pub);
    free(file);
    free(dir);
}

/* Falha no rename: o destino fica intacto e o temporário é removido. */
static void test_write_atomic_failure(void) {
    char *dir = join(g_root, "falha");
    char *target = dir ? join(dir, "alvo") : NULL;
    char *inner = target ? join(target, "dentro.txt") : NULL;

    CHECK(inner != NULL);
    if (inner == NULL) goto out;

    /* O destino é um diretório não vazio: rename por cima falha. */
    CHECK(ah_platform_fs_write_atomic(inner, "intacto", 7, 0) == AH_OK);
    CHECK(ah_platform_fs_write_atomic(target, "novo", 4, 0) != AH_OK);
    CHECK(exists_dir(target));
    CHECK(content_is(inner, "intacto"));
    CHECK(count_tmp_entries(dir) == 0);

#if defined(_WIN32)
    {
        /* Destino aberto por outro handle sem FILE_SHARE_DELETE: o
         * MoveFileExW falha; o conteúdo antigo continua inteiro. */
        char *locked = join(dir, "travado.txt");
        wchar_t *wl = locked ? wide(locked) : NULL;
        HANDLE h = INVALID_HANDLE_VALUE;
        CHECK(wl != NULL);
        if (wl != NULL) {
            CHECK(ah_platform_fs_write_atomic(locked, "antigo", 6, 0) ==
                  AH_OK);
            h = CreateFileW(wl, GENERIC_READ, FILE_SHARE_READ, NULL,
                            OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
            CHECK(h != INVALID_HANDLE_VALUE);
            CHECK(ah_platform_fs_write_atomic(locked, "novo!!!", 7, 0) !=
                  AH_OK);
            if (h != INVALID_HANDLE_VALUE) CloseHandle(h);
            CHECK(content_is(locked, "antigo"));
            CHECK(count_tmp_entries(dir) == 0);
        }
        free(wl);
        free(locked);
    }
#endif
out:
    free(inner);
    free(target);
    free(dir);
}

/* Leitor concorrente: cada leitura vê o conteúdo antigo ou o novo inteiro,
 * nunca um pedaço (nem um arquivo vazio ou ausente no meio do rename). */
#define CONC_A_LEN (64 * 1024)
#define CONC_B_LEN (96 * 1024)
#define CONC_WRITES 200

typedef struct conc_state {
    const char *path;
    int reads;
    int torn;
    int errors;
#if defined(_WIN32)
    volatile LONG done;
#else
    pthread_mutex_t mu;
    int done;
#endif
} conc_state;

static bool conc_is_done(conc_state *s) {
#if defined(_WIN32)
    return InterlockedCompareExchange(&s->done, 0, 0) != 0;
#else
    int d;
    pthread_mutex_lock(&s->mu);
    d = s->done;
    pthread_mutex_unlock(&s->mu);
    return d != 0;
#endif
}

static void conc_read_once(conc_state *s) {
    char *buf = NULL;
    size_t len = 0, i;
    ah_status st = ah_platform_fs_read_all(s->path, 1u << 20, &buf, &len);
    if (st != AH_OK) {
        s->errors++;
        return;
    }
    s->reads++;
    if (len == CONC_A_LEN || len == CONC_B_LEN) {
        char c = len == CONC_A_LEN ? 'a' : 'b';
        for (i = 0; i < len; i++) {
            if (buf[i] != c) {
                s->torn++;
                break;
            }
        }
    } else {
        s->torn++;
    }
    free(buf);
}

#if defined(_WIN32)
static DWORD WINAPI conc_reader(LPVOID arg) {
#else
static void *conc_reader(void *arg) {
#endif
    conc_state *s = arg;
    while (!conc_is_done(s)) conc_read_once(s);
    conc_read_once(s);
#if defined(_WIN32)
    return 0;
#else
    return NULL;
#endif
}

static void test_write_atomic_concurrent(void) {
    char *dir = join(g_root, "concorrente");
    char *file = dir ? join(dir, "dados.bin") : NULL;
    char *a = malloc(CONC_A_LEN), *b = malloc(CONC_B_LEN);
    conc_state s;
    int i, write_failures = 0;
    bool started = false;
#if defined(_WIN32)
    HANDLE th = NULL;
#else
    pthread_t th;
#endif

    memset(&s, 0, sizeof s);
    CHECK(file != NULL && a != NULL && b != NULL);
    if (file == NULL || a == NULL || b == NULL) goto out;
    memset(a, 'a', CONC_A_LEN);
    memset(b, 'b', CONC_B_LEN);
    CHECK(ah_platform_fs_write_atomic(file, a, CONC_A_LEN, 0) == AH_OK);

    s.path = file;
#if defined(_WIN32)
    th = CreateThread(NULL, 0, conc_reader, &s, 0, NULL);
    started = th != NULL;
#else
    pthread_mutex_init(&s.mu, NULL);
    started = pthread_create(&th, NULL, conc_reader, &s) == 0;
#endif
    CHECK(started);
    for (i = 0; i < CONC_WRITES; i++) {
        const char *src = (i % 2) ? a : b;
        size_t len = (i % 2) ? CONC_A_LEN : CONC_B_LEN;
        if (ah_platform_fs_write_atomic(file, src, len, 0) != AH_OK) {
            write_failures++;
        }
    }
#if defined(_WIN32)
    InterlockedExchange(&s.done, 1);
    if (started) {
        WaitForSingleObject(th, INFINITE);
        CloseHandle(th);
    }
#else
    pthread_mutex_lock(&s.mu);
    s.done = 1;
    pthread_mutex_unlock(&s.mu);
    if (started) pthread_join(th, NULL);
    pthread_mutex_destroy(&s.mu);
#endif
    if (write_failures != 0 || s.torn != 0 || s.errors != 0) {
        fprintf(stderr,
                "  concorrente: %d escritas falharam, %d leituras, %d "
                "parciais, %d erros de leitura\n",
                write_failures, s.reads, s.torn, s.errors);
    }
    CHECK(write_failures == 0);
    CHECK(s.reads > 0);
    CHECK(s.torn == 0);
    CHECK(s.errors == 0);
    CHECK(count_tmp_entries(dir) == 0);
out:
    free(b);
    free(a);
    free(file);
    free(dir);
}

/* ------------------------------------------------------------------------ */
/* Leitura com teto                                                          */
/* ------------------------------------------------------------------------ */

static void test_read_all(void) {
    char *file = join(g_root, "ler.txt");
    char *missing = join(g_root, "nao-existe.txt");
    char *buf = (char *)1;
    size_t len = 99;

    CHECK(file != NULL && missing != NULL);
    if (file == NULL || missing == NULL) goto out;
    CHECK(ah_platform_fs_write_atomic(file, "0123456789", 10, 0) == AH_OK);

    CHECK(ah_platform_fs_read_all(file, 10, &buf, &len) == AH_OK);
    CHECK(buf != NULL && len == 10 && memcmp(buf, "0123456789", 10) == 0 &&
          buf[10] == '\0');
    free(buf);

    buf = (char *)1;
    CHECK(ah_platform_fs_read_all(file, 9, &buf, &len) == AH_ERR_LIMIT);
    CHECK(buf == NULL && len == 0);

    buf = (char *)1;
    CHECK(ah_platform_fs_read_all(missing, 10, &buf, &len) ==
          AH_ERR_NOT_FOUND);
    CHECK(buf == NULL);

    CHECK(ah_platform_fs_read_all(NULL, 10, &buf, &len) == AH_ERR_INVALID);
out:
    free(missing);
    free(file);
}

/* ------------------------------------------------------------------------ */
/* Restrição de arquivo e pasta existentes                                   */
/* ------------------------------------------------------------------------ */

static void test_restrict_existing(void) {
    char *file = join(g_root, "token-existente");
    char *dir = join(g_root, "pasta-existente");
    bool r = true;

    CHECK(file != NULL && dir != NULL);
    if (file == NULL || dir == NULL) goto out;

    /* Arquivo com permissão aberta, criado por fora da API. */
#if defined(_WIN32)
    {
        wchar_t *wd = wide(dir);
        CHECK(ah_platform_fs_write_atomic(file, "t", 1, 0) == AH_OK);
        CHECK(wd != NULL && CreateDirectoryW(wd, NULL));
        free(wd);
    }
#else
    {
        FILE *f = fopen(file, "w");
        CHECK(f != NULL);
        if (f != NULL) fclose(f);
        CHECK(chmod(file, 0644) == 0);
        CHECK(mkdir(dir, 0755) == 0);
        CHECK(chmod(dir, 0755) == 0);
    }
#endif
    CHECK(ah_platform_fs_check_restricted(file, &r) == AH_OK);
    CHECK(!r);
    CHECK(!private_file_ok(file));
    r = true;
    CHECK(ah_platform_fs_check_restricted(dir, &r) == AH_OK);
    CHECK(!r);

    CHECK(ah_platform_fs_restrict(file) == AH_OK);
    CHECK(ah_platform_fs_check_restricted(file, &r) == AH_OK);
    CHECK(r);
    CHECK(private_file_ok(file));

    CHECK(ah_platform_fs_restrict(dir) == AH_OK);
    r = false;
    CHECK(ah_platform_fs_check_restricted(dir, &r) == AH_OK);
    CHECK(r);
    CHECK(private_dir_ok(dir));

    {
        char *missing = join(g_root, "sumiu");
        CHECK(ah_platform_fs_restrict(missing) == AH_ERR_NOT_FOUND);
        CHECK(ah_platform_fs_check_restricted(missing, &r) ==
              AH_ERR_NOT_FOUND);
        CHECK(!r);
        free(missing);
    }
#if !defined(_WIN32)
    {
        /* Link simbólico: recusado pelo restrict e nunca "restrito". */
        char *link = join(g_root, "link-token");
        CHECK(link != NULL && symlink(file, link) == 0);
        CHECK(ah_platform_fs_restrict(link) == AH_ERR_INVALID);
        r = true;
        CHECK(ah_platform_fs_check_restricted(link, &r) == AH_OK);
        CHECK(!r);
        free(link);
    }
#endif
out:
    free(dir);
    free(file);
}

/* ------------------------------------------------------------------------ */
/* Home do Hub                                                               */
/* ------------------------------------------------------------------------ */

static void test_home(void) {
    char *saved_hub = env_get("AGENTS_HUB_HOME");
    char *saved_user = env_get(USER_HOME_VAR);
    char *custom = join(g_root, "hub-home");
    char *profile = join(g_root, "perfil " ACAO_U8);
    char *expected = profile ? join(profile, ".agents-hub") : NULL;
    char *got = NULL;

    CHECK(custom != NULL && profile != NULL && expected != NULL);
    if (custom == NULL || profile == NULL || expected == NULL) goto out;

    /* Com AGENTS_HUB_HOME: usada como está. */
    env_set("AGENTS_HUB_HOME", custom);
    CHECK(ah_platform_fs_resolve_home(&got) == AH_OK);
    CHECK(str_eq(got, custom));
    free(got);
    got = NULL;

    /* Definida e vazia: inválida (hub-env.ts exige string não vazia). */
    env_set("AGENTS_HUB_HOME", "");
    got = (char *)1;
    CHECK(ah_platform_fs_resolve_home(&got) == AH_ERR_INVALID);
    CHECK(got == NULL);

    /* Sem AGENTS_HUB_HOME: <home do usuário>/.agents-hub. O home do usuário
     * aponta para dentro do diretório do teste (com acento). */
    env_set("AGENTS_HUB_HOME", NULL);
    env_set(USER_HOME_VAR, profile);
    CHECK(ah_platform_fs_resolve_home(&got) == AH_OK);
    if (!str_eq(got, expected)) {
        fprintf(stderr, "  home = \"%s\", esperado \"%s\"\n",
                got ? got : "(null)", expected);
    }
    CHECK(str_eq(got, expected));
    free(got);
    got = NULL;
    /* Resolver não cria nada. */
    CHECK(!exists_any(expected));
    CHECK(!exists_any(custom));

out:
    env_set("AGENTS_HUB_HOME", saved_hub);
    env_set(USER_HOME_VAR, saved_user);
    free(expected);
    free(profile);
    free(custom);
    free(saved_user);
    free(saved_hub);
}

/* ------------------------------------------------------------------------ */
/* Caminhos não ASCII                                                        */
/* ------------------------------------------------------------------------ */

static void test_non_ascii(void) {
    char *base = join(g_root, "Bruno Silva");
    char *deep = NULL, *file = NULL;
    char *p1 = base ? join(base, ACAO_U8) : NULL;
    bool r = false;

    deep = p1 ? join(p1, NIHON_U8) : NULL;
    file = deep ? join(deep, "arquivo-" ACAO_U8 ".txt") : NULL;
    CHECK(file != NULL);
    if (file == NULL) goto out;

    CHECK(ah_platform_fs_mkdirs(deep) == AH_OK);
    CHECK(exists_dir(deep));
    CHECK(private_dir_ok(deep));
    CHECK(ah_platform_fs_write_atomic(file, NIHON_U8, 6,
                                      AH_PLATFORM_FS_PRIVATE) == AH_OK);
    CHECK(content_is(file, NIHON_U8));
    CHECK(private_file_ok(file));
    CHECK(ah_platform_fs_check_restricted(file, &r) == AH_OK);
    CHECK(r);
    CHECK(count_tmp_entries(deep) == 0);

#if defined(_WIN32)
    {
        /* Conferência por fora do conversor: o nome no disco é o UTF-16
         * certo ("ação\日本\arquivo-ação.txt"), não mojibake da página de
         * código ANSI. */
        wchar_t *wroot = wide(g_root);
        const wchar_t *tail = L"\\Bruno Silva\\a\x00E7\x00E3o\\\x65E5\x672C"
                              L"\\arquivo-a\x00E7\x00E3o.txt";
        size_t n1 = wroot ? wcslen(wroot) : 0, n2 = wcslen(tail);
        wchar_t *wfile = wroot ? malloc((n1 + n2 + 1) * sizeof *wfile) : NULL;
        CHECK(wfile != NULL);
        if (wfile != NULL) {
            memcpy(wfile, wroot, n1 * sizeof *wfile);
            memcpy(wfile + n1, tail, (n2 + 1) * sizeof *wfile);
            CHECK(GetFileAttributesW(wfile) != INVALID_FILE_ATTRIBUTES);
        }
        free(wfile);
        free(wroot);
    }
#endif
out:
    free(file);
    free(deep);
    free(p1);
    free(base);
}

int main(void) {
    CHECK(ah_platform_fs_init() == AH_OK);

    g_root = make_temp_root();
    CHECK(g_root != NULL);
    if (g_root == NULL) return AH_TEST_END("test_platform_fs");
    CHECK(ah_platform_fs_mkdirs(g_root) == AH_OK);

#if defined(_WIN32)
    test_utf8_utf16();
#endif
    test_paths();
    test_mkdirs();
    test_write_atomic_basic();
    test_write_atomic_failure();
    test_write_atomic_concurrent();
    test_read_all();
    test_restrict_existing();
    test_home();
    test_non_ascii();

    remove_tree(g_root);
    CHECK(!exists_any(g_root));
    free(g_root);
    return AH_TEST_END("test_platform_fs");
}
