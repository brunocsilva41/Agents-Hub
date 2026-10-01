/* Chamadas ao SO da ferramenta ahsign (F8-05). TEMPORÁRIO: ver ahsign_os.h
 * (migra para native/src/platform/, área F0-06, no merge). */
#if !defined(_WIN32)
#define _POSIX_C_SOURCE 200809L
#endif

#include "ahsign_os.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "monocypher.h"

#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <bcrypt.h>
#include <shellapi.h>
#else
#include <errno.h>
#include <fcntl.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <termios.h>
#include <unistd.h>
#endif

/* Primeira linha de stdin, sem LF nem CR final. */
static ah_status read_line_stdin(char *buf, size_t cap, size_t *len_out) {
    size_t n = 0;
    int c;
    int too_long = 0;

    while ((c = getchar()) != EOF && c != '\n') {
        if (n + 1 >= cap || n >= AHSIGN_PASSWORD_MAX) {
            too_long = 1;
            continue; /* drena a linha para não deixar resto em stdin */
        }
        buf[n++] = (char)c;
    }
    if (ferror(stdin)) {
        crypto_wipe(buf, cap);
        return AH_ERR_IO;
    }
    if (n > 0 && buf[n - 1] == '\r') {
        n--;
    }
    buf[n] = '\0';
    if (too_long) {
        crypto_wipe(buf, cap);
        return AH_ERR_LIMIT;
    }
    if (n == 0) {
        return AH_ERR_INVALID;
    }
    *len_out = n;
    return AH_OK;
}

#if defined(_WIN32)

static wchar_t *utf8_to_wide(const char *s) {
    int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s, -1, NULL, 0);
    wchar_t *w;
    if (n <= 0) {
        return NULL;
    }
    w = (wchar_t *)malloc((size_t)n * sizeof(wchar_t));
    if (w == NULL) {
        return NULL;
    }
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s, -1, w, n) != n) {
        free(w);
        return NULL;
    }
    return w;
}

static char *wide_to_utf8(const wchar_t *w) {
    int n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, w, -1, NULL, 0, NULL, NULL);
    char *s;
    if (n <= 0) {
        return NULL;
    }
    s = (char *)malloc((size_t)n);
    if (s == NULL) {
        return NULL;
    }
    if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, w, -1, s, n, NULL, NULL) != n) {
        free(s);
        return NULL;
    }
    return s;
}

ah_status ahsign_os_random(uint8_t *buf, size_t size) {
    while (size > 0) {
        ULONG chunk = size > 0x10000u ? 0x10000u : (ULONG)size;
        if (!BCRYPT_SUCCESS(BCryptGenRandom(NULL, buf, chunk, BCRYPT_USE_SYSTEM_PREFERRED_RNG))) {
            return AH_ERR_IO;
        }
        buf += chunk;
        size -= chunk;
    }
    return AH_OK;
}

static ah_status read_password_console(const char *prompt, char *buf, size_t cap,
                                       size_t *len_out) {
    wchar_t wbuf[AHSIGN_PASSWORD_MAX + 2];
    DWORD total = 0;
    DWORD mode = 0;
    DWORD got = 0;
    HANDLE in;
    HANDLE out;
    wchar_t *wprompt;
    int found_lf = 0;
    int ok = 1;
    int n;
    DWORD i;
    ah_status st = AH_OK;

    in = CreateFileW(L"CONIN$", GENERIC_READ | GENERIC_WRITE,
                     FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
    if (in == INVALID_HANDLE_VALUE) {
        return AH_ERR_IO;
    }
    if (!GetConsoleMode(in, &mode)) {
        CloseHandle(in);
        return AH_ERR_IO;
    }
    out = CreateFileW(L"CONOUT$", GENERIC_READ | GENERIC_WRITE,
                      FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
    if (out == INVALID_HANDLE_VALUE) {
        CloseHandle(in);
        return AH_ERR_IO;
    }
    wprompt = utf8_to_wide(prompt);
    if (wprompt != NULL) {
        WriteConsoleW(out, wprompt, (DWORD)wcslen(wprompt), NULL, NULL);
        free(wprompt);
    }
    if (!SetConsoleMode(in, (mode | ENABLE_LINE_INPUT | ENABLE_PROCESSED_INPUT) &
                                ~(DWORD)ENABLE_ECHO_INPUT)) {
        CloseHandle(out);
        CloseHandle(in);
        return AH_ERR_IO;
    }
    while (!found_lf) {
        if (total >= AHSIGN_PASSWORD_MAX + 2) {
            ok = 0; /* linha longa demais */
            break;
        }
        if (!ReadConsoleW(in, wbuf + total, (DWORD)(AHSIGN_PASSWORD_MAX + 2) - total, &got,
                          NULL) ||
            got == 0) {
            break;
        }
        for (i = total; i < total + got; i++) {
            if (wbuf[i] == L'\n') {
                found_lf = 1;
                total = i;
                break;
            }
        }
        if (!found_lf) {
            total += got;
        }
    }
    SetConsoleMode(in, mode);
    WriteConsoleW(out, L"\r\n", 2, NULL, NULL);
    CloseHandle(out);
    CloseHandle(in);

    if (!ok) {
        st = AH_ERR_LIMIT;
    } else if (!found_lf) {
        st = AH_ERR_IO;
    } else {
        if (total > 0 && wbuf[total - 1] == L'\r') {
            total--;
        }
        if (total == 0) {
            st = AH_ERR_INVALID;
        } else {
            n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wbuf, (int)total, buf,
                                    (int)(cap - 1), NULL, NULL);
            if (n <= 0 || (size_t)n > AHSIGN_PASSWORD_MAX) {
                st = AH_ERR_LIMIT;
            } else {
                buf[n] = '\0';
                *len_out = (size_t)n;
            }
        }
    }
    crypto_wipe(wbuf, sizeof wbuf);
    if (st != AH_OK) {
        crypto_wipe(buf, cap);
    }
    return st;
}

ah_status ahsign_os_write_new_file(const char *path, const uint8_t *data, size_t size) {
    wchar_t *wpath = utf8_to_wide(path);
    HANDLE h;
    DWORD written;
    int ok = 1;

    if (wpath == NULL) {
        return AH_ERR_INVALID;
    }
    /* CREATE_NEW: falha se já existir (nunca sobrescreve uma chave). */
    h = CreateFileW(wpath, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) {
        free(wpath);
        return AH_ERR_IO;
    }
    while (size > 0 && ok) {
        DWORD chunk = size > 0x100000u ? 0x100000u : (DWORD)size;
        if (!WriteFile(h, data, chunk, &written, NULL) || written != chunk) {
            ok = 0;
            break;
        }
        data += chunk;
        size -= chunk;
    }
    if (ok && !FlushFileBuffers(h)) {
        ok = 0;
    }
    if (!CloseHandle(h)) {
        ok = 0;
    }
    if (!ok) {
        DeleteFileW(wpath);
    }
    free(wpath);
    return ok ? AH_OK : AH_ERR_IO;
}

int ahsign_os_exists(const char *path) {
    wchar_t *wpath = utf8_to_wide(path);
    DWORD attr;
    if (wpath == NULL) {
        return 0;
    }
    attr = GetFileAttributesW(wpath);
    free(wpath);
    return attr != INVALID_FILE_ATTRIBUTES;
}

ah_status ahsign_os_read_file(const char *path, size_t max, uint8_t **out, size_t *size_out) {
    wchar_t *wpath = utf8_to_wide(path);
    HANDLE h;
    LARGE_INTEGER sz;
    uint8_t *buf;
    size_t total = 0;
    DWORD got;

    *out = NULL;
    *size_out = 0;
    if (wpath == NULL) {
        return AH_ERR_INVALID;
    }
    h = CreateFileW(wpath, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL, NULL);
    free(wpath);
    if (h == INVALID_HANDLE_VALUE) {
        return AH_ERR_IO;
    }
    if (!GetFileSizeEx(h, &sz) || sz.QuadPart < 0) {
        CloseHandle(h);
        return AH_ERR_IO;
    }
    if ((unsigned long long)sz.QuadPart > (unsigned long long)max) {
        CloseHandle(h);
        return AH_ERR_LIMIT;
    }
    buf = (uint8_t *)malloc((size_t)sz.QuadPart + 1u);
    if (buf == NULL) {
        CloseHandle(h);
        return AH_ERR_NOMEM;
    }
    /* Lê até o fim de fato (e um byte além do tamanho visto), para não aceitar
     * um arquivo que cresceu entre o GetFileSizeEx e a leitura. */
    for (;;) {
        size_t room = (size_t)sz.QuadPart + 1u - total;
        if (room == 0) {
            free(buf);
            CloseHandle(h);
            return AH_ERR_LIMIT;
        }
        if (!ReadFile(h, buf + total, room > 0x100000u ? 0x100000u : (DWORD)room, &got, NULL)) {
            free(buf);
            CloseHandle(h);
            return AH_ERR_IO;
        }
        if (got == 0) {
            break;
        }
        total += got;
    }
    CloseHandle(h);
    *out = buf;
    *size_out = total;
    return AH_OK;
}

ah_status ahsign_os_args_utf8(int argc, char **argv, int *argc_out, char ***out) {
    int wargc = 0;
    wchar_t **wargv;
    char **args;
    int i;

    (void)argc;
    (void)argv;
    *out = NULL;
    *argc_out = 0;
    wargv = CommandLineToArgvW(GetCommandLineW(), &wargc);
    if (wargv == NULL || wargc < 1) {
        if (wargv != NULL) {
            LocalFree(wargv);
        }
        return AH_ERR_IO;
    }
    args = (char **)calloc((size_t)wargc + 1u, sizeof(char *));
    if (args == NULL) {
        LocalFree(wargv);
        return AH_ERR_NOMEM;
    }
    for (i = 0; i < wargc; i++) {
        args[i] = wide_to_utf8(wargv[i]);
        if (args[i] == NULL) {
            ahsign_os_free_args(wargc, args);
            LocalFree(wargv);
            return AH_ERR_INVALID;
        }
    }
    LocalFree(wargv);
    *argc_out = wargc;
    *out = args;
    return AH_OK;
}

void ahsign_os_free_args(int argc, char **args) {
    int i;
    if (args == NULL) {
        return;
    }
    for (i = 0; i < argc; i++) {
        free(args[i]);
    }
    free((void *)args);
}

#else /* POSIX */

ah_status ahsign_os_random(uint8_t *buf, size_t size) {
    while (size > 0) {
        size_t chunk = size > 256u ? 256u : size;
        ssize_t n = getrandom(buf, chunk, 0);
        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            return AH_ERR_IO;
        }
        buf += (size_t)n;
        size -= (size_t)n;
    }
    return AH_OK;
}

static ah_status read_password_console(const char *prompt, char *buf, size_t cap,
                                       size_t *len_out) {
    struct termios old;
    struct termios t;
    size_t n = 0;
    int too_long = 0;
    int got_lf = 0;
    char c;
    ssize_t r;
    ah_status st = AH_OK;
    int fd = open("/dev/tty", O_RDWR | O_NOCTTY | O_CLOEXEC);

    if (fd < 0) {
        return AH_ERR_IO;
    }
    if (tcgetattr(fd, &old) != 0) {
        close(fd);
        return AH_ERR_IO;
    }
    if (write(fd, prompt, strlen(prompt)) < 0) {
        close(fd);
        return AH_ERR_IO;
    }
    t = old;
    t.c_lflag &= ~(tcflag_t)ECHO;
    t.c_lflag |= (tcflag_t)ICANON;
    if (tcsetattr(fd, TCSAFLUSH, &t) != 0) {
        close(fd);
        return AH_ERR_IO;
    }
    for (;;) {
        r = read(fd, &c, 1);
        if (r < 0 && errno == EINTR) {
            continue;
        }
        if (r <= 0) {
            break;
        }
        if (c == '\n') {
            got_lf = 1;
            break;
        }
        if (n + 1 >= cap || n >= AHSIGN_PASSWORD_MAX) {
            too_long = 1;
            continue;
        }
        buf[n++] = c;
    }
    c = 0;
    tcsetattr(fd, TCSAFLUSH, &old);
    if (write(fd, "\n", 1) < 0) {
        /* só cosmético */
    }
    close(fd);

    if (n > 0 && buf[n - 1] == '\r') {
        n--;
    }
    buf[n] = '\0';
    if (too_long) {
        st = AH_ERR_LIMIT;
    } else if (!got_lf) {
        st = AH_ERR_IO;
    } else if (n == 0) {
        st = AH_ERR_INVALID;
    } else {
        *len_out = n;
    }
    if (st != AH_OK) {
        crypto_wipe(buf, cap);
    }
    return st;
}

ah_status ahsign_os_write_new_file(const char *path, const uint8_t *data, size_t size) {
    int ok = 1;
    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);

    if (fd < 0) {
        return AH_ERR_IO;
    }
    while (size > 0) {
        ssize_t n = write(fd, data, size);
        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            ok = 0;
            break;
        }
        data += (size_t)n;
        size -= (size_t)n;
    }
    if (ok && fsync(fd) != 0) {
        ok = 0;
    }
    if (close(fd) != 0) {
        ok = 0;
    }
    if (!ok) {
        unlink(path);
    }
    return ok ? AH_OK : AH_ERR_IO;
}

int ahsign_os_exists(const char *path) {
    struct stat st;
    return lstat(path, &st) == 0;
}

ah_status ahsign_os_read_file(const char *path, size_t max, uint8_t **out, size_t *size_out) {
    struct stat stbuf;
    uint8_t *buf;
    size_t total = 0;
    size_t cap;
    int fd;

    *out = NULL;
    *size_out = 0;
    fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) {
        return AH_ERR_IO;
    }
    if (fstat(fd, &stbuf) != 0 || stbuf.st_size < 0) {
        close(fd);
        return AH_ERR_IO;
    }
    if ((unsigned long long)stbuf.st_size > (unsigned long long)max) {
        close(fd);
        return AH_ERR_LIMIT;
    }
    cap = (size_t)stbuf.st_size + 1u;
    buf = (uint8_t *)malloc(cap);
    if (buf == NULL) {
        close(fd);
        return AH_ERR_NOMEM;
    }
    for (;;) {
        ssize_t n;
        if (total == cap) {
            free(buf);
            close(fd);
            return AH_ERR_LIMIT;
        }
        n = read(fd, buf + total, cap - total);
        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            free(buf);
            close(fd);
            return AH_ERR_IO;
        }
        if (n == 0) {
            break;
        }
        total += (size_t)n;
    }
    close(fd);
    *out = buf;
    *size_out = total;
    return AH_OK;
}

ah_status ahsign_os_args_utf8(int argc, char **argv, int *argc_out, char ***out) {
    *argc_out = argc;
    *out = argv;
    return AH_OK;
}

void ahsign_os_free_args(int argc, char **args) {
    (void)argc;
    (void)args; /* no POSIX é o próprio argv */
}

#endif

ah_status ahsign_os_read_password(int from_stdin, const char *prompt, char *buf,
                                  size_t cap, size_t *len_out) {
    if (buf == NULL || len_out == NULL || prompt == NULL || cap < AHSIGN_PASSWORD_MAX + 1u) {
        return AH_ERR_INVALID;
    }
    *len_out = 0;
    if (from_stdin) {
        return read_line_stdin(buf, cap, len_out);
    }
    return read_password_console(prompt, buf, cap, len_out);
}
