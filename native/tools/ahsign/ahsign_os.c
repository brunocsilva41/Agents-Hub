/* Chamadas ao SO da ferramenta ahsign (F8-05) ainda sem API em platform/.
 * Ver ahsign_os.h: arquivos e argumentos migram para ah_platform_fs (F0-05);
 * o terminal sem eco é lacuna: sem área em platform/. */
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
#include <shellapi.h>
#else
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <termios.h>
#include <unistd.h>
#endif

/* Acumula um byte da linha da senha. Passado do teto, só drena até o LF. */
static void line_push(char *buf, size_t cap, size_t *n, int *too_long, char c) {
    if (*n + 1 >= cap || *n >= AHSIGN_PASSWORD_MAX) {
        *too_long = 1;
        return;
    }
    buf[(*n)++] = c;
}

/* Fecha a linha lida: tira o CR final, põe o NUL e decide o resultado. */
static ah_status line_finish(char *buf, size_t cap, size_t n, int too_long, int got_lf_or_eof,
                             size_t *len_out) {
    ah_status st = AH_OK;
    if (n > 0 && buf[n - 1] == '\r') {
        n--;
    }
    buf[n] = '\0';
    if (too_long) {
        st = AH_ERR_LIMIT;
    } else if (!got_lf_or_eof) {
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

/* ---- Senha por stdin (descritor 0, sem a CRT) ---- */

static ah_status read_password_stdin(char *buf, size_t cap, size_t *len_out) {
    HANDLE h = GetStdHandle(STD_INPUT_HANDLE);
    DWORD mode;
    DWORD got;
    size_t n = 0;
    int too_long = 0;
    int ended = 0;
    char c;

    if (h == INVALID_HANDLE_VALUE || h == NULL) {
        return AH_ERR_IO;
    }
    /* stdin é o console: a senha seria digitada com eco. */
    if (GetFileType(h) == FILE_TYPE_CHAR && GetConsoleMode(h, &mode)) {
        return AH_ERR_INVALID;
    }
    for (;;) {
        if (!ReadFile(h, &c, 1, &got, NULL)) {
            if (GetLastError() == ERROR_BROKEN_PIPE) {
                ended = 1; /* fim do pipe */
                break;
            }
            crypto_wipe(buf, cap);
            return AH_ERR_IO;
        }
        if (got == 0 || c == '\n') {
            ended = 1;
            break;
        }
        line_push(buf, cap, &n, &too_long, c);
    }
    c = 0;
    return line_finish(buf, cap, n, too_long, ended, len_out);
}

/* ---- Senha pelo console, sem eco ---- */

static HANDLE g_console_in = INVALID_HANDLE_VALUE;
static DWORD g_console_mode = 0;
static volatile LONG g_console_saved = 0;

/* Ctrl+C / Ctrl+Break / fechar a janela durante a leitura: devolve o eco ao
 * console antes do tratamento padrão (que encerra o processo). */
static BOOL WINAPI console_ctrl_handler(DWORD type) {
    (void)type;
    if (InterlockedCompareExchange(&g_console_saved, 0, 0) != 0) {
        SetConsoleMode(g_console_in, g_console_mode);
    }
    return FALSE;
}

static ah_status read_password_console(const char *prompt, char *buf, size_t cap,
                                       size_t *len_out) {
    enum { WCAP = AHSIGN_PASSWORD_MAX + 2 };
    wchar_t wbuf[WCAP];
    DWORD total = 0;
    DWORD mode = 0;
    DWORD got = 0;
    DWORD i;
    HANDLE in;
    HANDLE out;
    wchar_t *wprompt;
    int found_lf = 0;
    int too_long = 0;
    int n;
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

    g_console_in = in;
    g_console_mode = mode;
    InterlockedExchange(&g_console_saved, 1);
    if (!SetConsoleCtrlHandler(console_ctrl_handler, TRUE) ||
        !SetConsoleMode(in, (mode | ENABLE_LINE_INPUT | ENABLE_PROCESSED_INPUT) &
                                ~(DWORD)ENABLE_ECHO_INPUT)) {
        InterlockedExchange(&g_console_saved, 0);
        SetConsoleCtrlHandler(console_ctrl_handler, FALSE);
        CloseHandle(out);
        CloseHandle(in);
        return AH_ERR_IO;
    }
    while (!found_lf) {
        if (total >= WCAP) {
            /* Longa demais: descarta o que leu e continua drenando até o LF,
             * para o resto da linha não virar entrada de outro programa. */
            too_long = 1;
            crypto_wipe(wbuf, sizeof wbuf);
            total = 0;
        }
        if (!ReadConsoleW(in, wbuf + total, WCAP - total, &got, NULL) || got == 0) {
            break;
        }
        for (i = total; i < total + got; i++) {
            if (wbuf[i] == L'\n') {
                found_lf = 1;
                break;
            }
        }
        total = found_lf ? i : total + got;
    }
    SetConsoleMode(in, mode);
    InterlockedExchange(&g_console_saved, 0);
    SetConsoleCtrlHandler(console_ctrl_handler, FALSE);
    WriteConsoleW(out, L"\r\n", 2, NULL, NULL);
    CloseHandle(out);
    CloseHandle(in);

    if (too_long) {
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

/* ---- Arquivo privado (DACL só do usuário) ---- */

/* SID do usuário do processo. Posse: free(). */
static PSID current_user_sid(void) {
    HANDLE tok = NULL;
    DWORD len = 0;
    TOKEN_USER *tu;
    PSID sid = NULL;
    DWORD sid_len;

    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &tok)) {
        return NULL;
    }
    GetTokenInformation(tok, TokenUser, NULL, 0, &len);
    tu = len > 0 ? (TOKEN_USER *)malloc(len) : NULL;
    if (tu != NULL && GetTokenInformation(tok, TokenUser, tu, len, &len)) {
        sid_len = GetLengthSid(tu->User.Sid);
        sid = (PSID)malloc(sid_len);
        if (sid != NULL && !CopySid(sid_len, sid, tu->User.Sid)) {
            free(sid);
            sid = NULL;
        }
    }
    free(tu);
    CloseHandle(tok);
    return sid;
}

typedef struct private_sa {
    SECURITY_ATTRIBUTES sa;
    SECURITY_DESCRIPTOR sd;
    PACL acl;
    PSID sid;
} private_sa;

static void private_sa_free(private_sa *p) {
    free(p->acl);
    free(p->sid);
    p->acl = NULL;
    p->sid = NULL;
}

/* DACL protegida (não herda da pasta) com uma única entrada: acesso total
 * para o SID do usuário. */
static int private_sa_init(private_sa *p) {
    DWORD acl_size;

    memset(p, 0, sizeof *p);
    p->sid = current_user_sid();
    if (p->sid == NULL) {
        return -1;
    }
    acl_size = (DWORD)(sizeof(ACL) + sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) +
                       GetLengthSid(p->sid));
    p->acl = (PACL)malloc(acl_size);
    if (p->acl == NULL || !InitializeAcl(p->acl, acl_size, ACL_REVISION) ||
        !AddAccessAllowedAce(p->acl, ACL_REVISION, FILE_ALL_ACCESS, p->sid) ||
        !InitializeSecurityDescriptor(&p->sd, SECURITY_DESCRIPTOR_REVISION) ||
        !SetSecurityDescriptorDacl(&p->sd, TRUE, p->acl, FALSE) ||
        !SetSecurityDescriptorControl(&p->sd, SE_DACL_PROTECTED, SE_DACL_PROTECTED)) {
        private_sa_free(p);
        return -1;
    }
    p->sa.nLength = sizeof p->sa;
    p->sa.lpSecurityDescriptor = &p->sd;
    p->sa.bInheritHandle = FALSE;
    return 0;
}

ah_status ahsign_os_write_new_file(const char *path, const uint8_t *data, size_t size) {
    wchar_t *wpath = utf8_to_wide(path);
    private_sa psa;
    HANDLE h;
    DWORD written;
    int ok = 1;

    if (wpath == NULL) {
        return AH_ERR_INVALID;
    }
    if (private_sa_init(&psa) != 0) {
        free(wpath);
        return AH_ERR_IO;
    }
    /* CREATE_NEW: falha se já existir (nunca sobrescreve). A DACL vale desde a
     * criação: não há janela em que o arquivo exista com a herança da pasta. */
    h = CreateFileW(wpath, GENERIC_WRITE, 0, &psa.sa, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
    private_sa_free(&psa);
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

ah_status ahsign_os_file_is_private(const char *path, int *out) {
    wchar_t *wpath;
    PSECURITY_DESCRIPTOR sd = NULL;
    SECURITY_DESCRIPTOR_CONTROL ctrl = 0;
    DWORD rev = 0;
    DWORD need = 0;
    BOOL present = FALSE;
    BOOL defaulted = FALSE;
    PACL acl = NULL;
    ACL_SIZE_INFORMATION info;
    void *ace = NULL;
    PSID sid;
    ah_status st = AH_ERR_IO;

    if (path == NULL || out == NULL) {
        return AH_ERR_INVALID;
    }
    *out = 0;
    wpath = utf8_to_wide(path);
    if (wpath == NULL) {
        return AH_ERR_INVALID;
    }
    sid = current_user_sid();
    GetFileSecurityW(wpath, DACL_SECURITY_INFORMATION, NULL, 0, &need);
    if (sid != NULL && need > 0) {
        sd = (PSECURITY_DESCRIPTOR)malloc(need);
    }
    if (sd != NULL && GetFileSecurityW(wpath, DACL_SECURITY_INFORMATION, sd, need, &need) &&
        GetSecurityDescriptorControl(sd, &ctrl, &rev) &&
        GetSecurityDescriptorDacl(sd, &present, &acl, &defaulted)) {
        st = AH_OK;
        if ((ctrl & SE_DACL_PROTECTED) != 0 && present && acl != NULL &&
            GetAclInformation(acl, &info, sizeof info, AclSizeInformation) &&
            info.AceCount == 1 && GetAce(acl, 0, &ace) &&
            ((ACE_HEADER *)ace)->AceType == ACCESS_ALLOWED_ACE_TYPE &&
            EqualSid((PSID) & ((ACCESS_ALLOWED_ACE *)ace)->SidStart, sid)) {
            *out = 1;
        }
    }
    free(sd);
    free(sid);
    free(wpath);
    return st;
}

int ahsign_os_parent_writable_by_others(const char *path) {
    (void)path;
    return 0;
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

/* ---- Senha por stdin (descritor 0, sem a CRT) ---- */

static ah_status read_password_stdin(char *buf, size_t cap, size_t *len_out) {
    size_t n = 0;
    int too_long = 0;
    int ended = 0;
    char c;
    ssize_t r;

    /* stdin é terminal: a senha seria digitada com eco. */
    if (isatty(0)) {
        return AH_ERR_INVALID;
    }
    for (;;) {
        r = read(0, &c, 1);
        if (r < 0) {
            if (errno == EINTR) {
                continue;
            }
            crypto_wipe(buf, cap);
            return AH_ERR_IO;
        }
        if (r == 0 || c == '\n') {
            ended = 1;
            break;
        }
        line_push(buf, cap, &n, &too_long, c);
    }
    c = 0;
    return line_finish(buf, cap, n, too_long, ended, len_out);
}

/* ---- Senha pelo terminal, sem eco ---- */

static int g_tty_fd = -1;
static struct termios g_tty_old;
static volatile sig_atomic_t g_tty_saved = 0;

static const int k_tty_signals[] = {SIGINT, SIGTERM, SIGHUP, SIGQUIT};
#define AHSIGN_TTY_NSIG (sizeof k_tty_signals / sizeof k_tty_signals[0])
static struct sigaction g_old_actions[AHSIGN_TTY_NSIG];

/* Ctrl+C e afins durante a leitura: devolve o eco ao terminal, restaura a
 * ação anterior e repete o sinal (tcsetattr, sigaction e raise são
 * async-signal-safe). */
static void tty_signal_handler(int sig) {
    size_t i;
    if (g_tty_saved) {
        tcsetattr(g_tty_fd, TCSAFLUSH, &g_tty_old);
    }
    for (i = 0; i < AHSIGN_TTY_NSIG; i++) {
        if (k_tty_signals[i] == sig) {
            sigaction(sig, &g_old_actions[i], NULL);
        }
    }
    raise(sig);
}

static void tty_signals_install(void) {
    struct sigaction sa;
    size_t i;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = tty_signal_handler;
    sigemptyset(&sa.sa_mask);
    for (i = 0; i < AHSIGN_TTY_NSIG; i++) {
        sigaction(k_tty_signals[i], &sa, &g_old_actions[i]);
    }
}

static void tty_signals_restore(void) {
    size_t i;
    for (i = 0; i < AHSIGN_TTY_NSIG; i++) {
        sigaction(k_tty_signals[i], &g_old_actions[i], NULL);
    }
}

static ah_status read_password_console(const char *prompt, char *buf, size_t cap,
                                       size_t *len_out) {
    struct termios t;
    size_t n = 0;
    int too_long = 0;
    int got_lf = 0;
    char c;
    ssize_t r;
    int fd = open("/dev/tty", O_RDWR | O_NOCTTY | O_CLOEXEC);

    if (fd < 0) {
        return AH_ERR_IO;
    }
    if (tcgetattr(fd, &g_tty_old) != 0) {
        close(fd);
        return AH_ERR_IO;
    }
    if (write(fd, prompt, strlen(prompt)) < 0) {
        close(fd);
        return AH_ERR_IO;
    }
    g_tty_fd = fd;
    g_tty_saved = 1;
    tty_signals_install();
    t = g_tty_old;
    t.c_lflag &= ~(tcflag_t)ECHO;
    t.c_lflag |= (tcflag_t)ICANON;
    if (tcsetattr(fd, TCSAFLUSH, &t) != 0) {
        g_tty_saved = 0;
        tty_signals_restore();
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
        line_push(buf, cap, &n, &too_long, c); /* passado do teto, drena até o LF */
    }
    c = 0;
    tcsetattr(fd, TCSAFLUSH, &g_tty_old);
    g_tty_saved = 0;
    tty_signals_restore();
    if (write(fd, "\n", 1) < 0) {
        /* só cosmético */
    }
    close(fd);
    g_tty_fd = -1;
    return line_finish(buf, cap, n, too_long, got_lf, len_out);
}

/* ---- Arquivos ---- */

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

ah_status ahsign_os_file_is_private(const char *path, int *out) {
    struct stat st;
    if (path == NULL || out == NULL) {
        return AH_ERR_INVALID;
    }
    *out = 0;
    if (lstat(path, &st) != 0) {
        return AH_ERR_IO;
    }
    *out = S_ISREG(st.st_mode) && (st.st_mode & 077) == 0;
    return AH_OK;
}

int ahsign_os_parent_writable_by_others(const char *path) {
    const char *slash = strrchr(path, '/');
    struct stat st;
    char *dir;
    size_t len;
    int result = 0;

    if (slash == NULL) {
        return stat(".", &st) == 0 && (st.st_mode & (S_IWGRP | S_IWOTH)) != 0;
    }
    len = slash == path ? 1u : (size_t)(slash - path);
    dir = (char *)malloc(len + 1u);
    if (dir == NULL) {
        return 0;
    }
    memcpy(dir, path, len);
    dir[len] = '\0';
    if (stat(dir, &st) == 0 && (st.st_mode & (S_IWGRP | S_IWOTH)) != 0) {
        result = 1;
    }
    free(dir);
    return result;
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
        return read_password_stdin(buf, cap, len_out);
    }
    return read_password_console(prompt, buf, cap, len_out);
}
