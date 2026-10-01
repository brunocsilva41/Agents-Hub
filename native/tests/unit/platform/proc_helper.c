/* Executável auxiliar dos testes de processos (F0-07). Não é agente real.
 *
 * Modos (1º argumento):
 *   argv            imprime "n=<qtd>" e uma linha "a=<hex UTF-8>" por argumento
 *                   depois do modo. No Windows o argv vem de
 *                   CommandLineToArgvW(GetCommandLineW()), para a ida e volta
 *                   ser contra a regra do SO (SPEC-08 P3), não a do CRT.
 *   cat             copia stdin → stdout (binário) até EOF.
 *   env NOME...     imprime "NOME=<hex>" ou "NOME!" (ausente) para cada nome.
 *   cwd             imprime "cwd=<hex UTF-8>".
 *   exit N          sai com o código N.
 *   stderr TEXTO    escreve TEXTO no stderr.
 *   handles         enumera os próprios handles herdáveis (Windows) ou fds
 *                   abertos (POSIX) e imprime "std=<qtd de stdio achados>",
 *                   uma linha "leak=<valor>" por handle/fd que não seja stdio
 *                   e "end" (SPEC-08 P4, SEC-R28).
 *   handles-selftest   igual a `handles`, mas antes cria de propósito um
 *                   handle herdável (Windows) / fd sem CLOEXEC (POSIX): prova
 *                   que o enumerador detecta vazamento.
 * Saídas em hex evitam qualquer dependência de code page do console. */
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#include <shellapi.h>
#else
#define _POSIX_C_SOURCE 200809L
#include <fcntl.h>
#include <limits.h>
#include <unistd.h>
#endif

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void print_hex(const char *prefix, const char *s, size_t len) {
    fputs(prefix, stdout);
    for (size_t i = 0; i < len; i++) {
        printf("%02x", (unsigned)(unsigned char)s[i]);
    }
    fputc('\n', stdout);
}

#ifdef _WIN32
static char *wide_to_utf8(const wchar_t *w) {
    int need = WideCharToMultiByte(CP_UTF8, 0, w, -1, NULL, 0, NULL, NULL);
    if (need <= 0) {
        return NULL;
    }
    char *s = malloc((size_t)need);
    if (s != NULL &&
        WideCharToMultiByte(CP_UTF8, 0, w, -1, s, need, NULL, NULL) != need) {
        free(s);
        s = NULL;
    }
    return s;
}

/* Argumento i em UTF-8 a partir da linha UTF-16 (o argv do main vem na
 * code page ANSI e perderia caracteres). Posse: free(). */
static char *arg_utf8(int i) {
    int n = 0;
    wchar_t **wargv = CommandLineToArgvW(GetCommandLineW(), &n);
    char *u = NULL;
    if (wargv != NULL && i < n) {
        u = wide_to_utf8(wargv[i]);
    }
    if (wargv != NULL) {
        LocalFree(wargv);
    }
    return u;
}

static int mode_argv(void) {
    int n = 0;
    wchar_t **wargv = CommandLineToArgvW(GetCommandLineW(), &n);
    if (wargv == NULL || n < 2) {
        return 3;
    }
    printf("n=%d\n", n - 2);
    for (int i = 2; i < n; i++) {
        char *u = wide_to_utf8(wargv[i]);
        if (u == NULL) {
            return 3;
        }
        print_hex("a=", u, strlen(u));
        free(u);
    }
    LocalFree(wargv);
    return 0;
}

static int mode_env(int argc, char **argv) {
    for (int i = 2; i < argc; i++) {
        wchar_t name[256];
        if (MultiByteToWideChar(CP_UTF8, 0, argv[i], -1, name, 256) <= 0) {
            return 3;
        }
        wchar_t val[4096];
        DWORD k = GetEnvironmentVariableW(name, val, 4096);
        if (k == 0 && GetLastError() == ERROR_ENVVAR_NOT_FOUND) {
            printf("%s!\n", argv[i]);
            continue;
        }
        if (k >= 4096) {
            return 3;
        }
        char *u = wide_to_utf8(val);
        if (u == NULL) {
            return 3;
        }
        printf("%s=", argv[i]);
        print_hex("", u, strlen(u));
        free(u);
    }
    return 0;
}

static int mode_cwd(void) {
    wchar_t buf[4096];
    DWORD k = GetCurrentDirectoryW(4096, buf);
    if (k == 0 || k >= 4096) {
        return 3;
    }
    char *u = wide_to_utf8(buf);
    if (u == NULL) {
        return 3;
    }
    print_hex("cwd=", u, strlen(u));
    free(u);
    return 0;
}

static int mode_handles(int selftest) {
    if (selftest) {
        SECURITY_ATTRIBUTES sa = {sizeof sa, NULL, TRUE};
        if (CreateEventW(&sa, TRUE, FALSE, NULL) == NULL) {
            return 3;
        }
    }
    HANDLE std[3] = {GetStdHandle(STD_INPUT_HANDLE),
                     GetStdHandle(STD_OUTPUT_HANDLE),
                     GetStdHandle(STD_ERROR_HANDLE)};
    int nstd = 0;
    /* Handles do processo são múltiplos de 4; a tabela de um processo
     * pequeno não chega perto de 1 Mi. Um handle herdado mantém o flag
     * HANDLE_FLAG_INHERIT no filho, e o que o próprio processo cria por
     * padrão não é herdável. */
    for (uintptr_t v = 4; v < 0x100000; v += 4) {
        HANDLE h = (HANDLE)v;
        DWORD flags = 0;
        if (!GetHandleInformation(h, &flags) ||
            !(flags & HANDLE_FLAG_INHERIT)) {
            continue;
        }
        if (h == std[0] || h == std[1] || h == std[2]) {
            nstd++;
        } else {
            printf("leak=%llx\n", (unsigned long long)v);
        }
    }
    printf("std=%d\nend\n", nstd);
    return 0;
}
#else
static int mode_argv(int argc, char **argv) {
    printf("n=%d\n", argc - 2);
    for (int i = 2; i < argc; i++) {
        print_hex("a=", argv[i], strlen(argv[i]));
    }
    return 0;
}

static int mode_env(int argc, char **argv) {
    for (int i = 2; i < argc; i++) {
        const char *v = getenv(argv[i]);
        if (v == NULL) {
            printf("%s!\n", argv[i]);
            continue;
        }
        printf("%s=", argv[i]);
        print_hex("", v, strlen(v));
    }
    return 0;
}

static int mode_cwd(void) {
    char buf[4096];
    if (getcwd(buf, sizeof buf) == NULL) {
        return 3;
    }
    print_hex("cwd=", buf, strlen(buf));
    return 0;
}

static int mode_handles(int selftest) {
    if (selftest && dup(2) < 0) { /* dup não põe FD_CLOEXEC: vazaria */
        return 3;
    }
    long maxfd = sysconf(_SC_OPEN_MAX);
    if (maxfd < 0 || maxfd > 65536) {
        maxfd = 65536;
    }
    int nstd = 0;
    for (int fd = 0; fd < (int)maxfd; fd++) {
        if (fcntl(fd, F_GETFD) < 0) {
            continue;
        }
        if (fd <= 2) {
            nstd++;
        } else {
            printf("leak=%x\n", (unsigned)fd);
        }
    }
    printf("std=%d\nend\n", nstd);
    return 0;
}
#endif

static int mode_cat(void) {
    char buf[8192];
    size_t n;
    while ((n = fread(buf, 1, sizeof buf, stdin)) > 0) {
        if (fwrite(buf, 1, n, stdout) != n) {
            return 3;
        }
    }
    return ferror(stdin) ? 3 : 0;
}

int main(int argc, char **argv) {
    if (argc < 2) {
        return 2;
    }
#ifdef _WIN32
    /* Binário: sem tradução \n → \r\n nem de bytes do stdin. */
    if (_setmode(_fileno(stdin), _O_BINARY) < 0 ||
        _setmode(_fileno(stdout), _O_BINARY) < 0 ||
        _setmode(_fileno(stderr), _O_BINARY) < 0) {
        return 3;
    }
#endif
    const char *mode = argv[1];
    int rc;
    if (strcmp(mode, "argv") == 0) {
#ifdef _WIN32
        rc = mode_argv();
#else
        rc = mode_argv(argc, argv);
#endif
    } else if (strcmp(mode, "cat") == 0) {
        rc = mode_cat();
    } else if (strcmp(mode, "env") == 0) {
        rc = mode_env(argc, argv);
    } else if (strcmp(mode, "cwd") == 0) {
        rc = mode_cwd();
    } else if (strcmp(mode, "exit") == 0 && argc >= 3) {
        char *end = NULL;
        long v = strtol(argv[2], &end, 10);
        rc = (end != argv[2] && *end == '\0') ? (int)v : 2;
    } else if (strcmp(mode, "stderr") == 0 && argc >= 3) {
#ifdef _WIN32
        char *text = arg_utf8(2);
        rc = 3;
        if (text != NULL) {
            fputs(text, stderr);
            free(text);
            rc = 0;
        }
#else
        fputs(argv[2], stderr);
        rc = 0;
#endif
    } else if (strcmp(mode, "handles") == 0) {
        rc = mode_handles(0);
    } else if (strcmp(mode, "handles-selftest") == 0) {
        rc = mode_handles(1);
    } else {
        rc = 2;
    }
    fflush(stdout);
    fflush(stderr);
    return rc;
}
