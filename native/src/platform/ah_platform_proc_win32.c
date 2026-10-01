/* Processos no Windows (F0-07). Ver o contrato em ah_platform_proc.h.
 *
 * Pipes: named pipes com o lado do Hub em modo OVERLAPPED (pipe anônimo não
 * aceita E/S assíncrona, e o laço da F0-09 precisa esperar por evento sem
 * polling, docs/18 §8). O lado do filho é síncrono e herdável, mas só entra
 * no filho porque está na PROC_THREAD_ATTRIBUTE_HANDLE_LIST (SPEC-08 P4).
 * Cada pipe:
 * - tem nome com 128 bits aleatórios do SO (BCryptGenRandom);
 * - tem DACL com uma única ACE, para o SID do usuário do token (sem
 *   Everyone/Anonymous, que o DACL padrão de named pipe inclui para leitura);
 * - tem uma instância só, com FILE_FLAG_FIRST_PIPE_INSTANCE e
 *   PIPE_REJECT_REMOTE_CLIENTS: se outro processo criar o nome antes ou
 *   conectar antes do Hub, a criação ou o CreateFileW falha e o spawn é
 *   abortado antes de qualquer byte ser escrito ou lido. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <bcrypt.h>

#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#include "ah_platform_proc_internal.h"

#define PIPE_BUF_BYTES 65536u

static const wchar_t NO_CWD_VAR[] = L"NoDefaultCurrentDirectoryInExePath";

typedef struct rd_state {
    HANDLE h;
    HANDLE ev;
    OVERLAPPED ov;
    char *buf;
    DWORD len;
    DWORD off;
    bool pending;
    bool eof;
} rd_state;

struct ah_proc {
    HANDLE process;
    HANDLE thread; /* só enquanto suspenso */
    DWORD pid;
    bool exited;
    ah_proc_exit st;

    HANDLE in_h;
    HANDLE in_ev;
    OVERLAPPED in_ov;
    char *wbuf;
    bool wpending;
    bool close_pending; /* close_stdin pedido com escrita em curso */

    rd_state rd[2]; /* [0] stdout, [1] stderr */
};

/* Conversão local UTF-8 → UTF-16. A F0-05 entrega a conversão comum da
 * plataforma; esta cópia privada existe para a F0-07 não depender dela e
 * deve ser unificada no merge. Posse: free(). */
static ah_status to_wide(const char *s, size_t len, wchar_t **out) {
    *out = NULL;
    if (len > (size_t)INT_MAX - 1) {
        return AH_ERR_LIMIT;
    }
    wchar_t *w = malloc((len + 1) * sizeof(wchar_t));
    if (w == NULL) {
        return AH_ERR_NOMEM;
    }
    int n = 0;
    if (len > 0) {
        n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s, (int)len, w,
                                (int)len);
        if (n <= 0) {
            free(w);
            return AH_ERR_INVALID;
        }
    }
    w[n] = L'\0';
    *out = w;
    return AH_OK;
}

/* UTF-16 → UTF-8, estrito. Posse: free(). */
static ah_status to_utf8(const wchar_t *w, char **out) {
    *out = NULL;
    int need = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, w, -1, NULL,
                                   0, NULL, NULL);
    if (need <= 0) {
        return AH_ERR_INVALID;
    }
    char *s = malloc((size_t)need);
    if (s == NULL) {
        return AH_ERR_NOMEM;
    }
    if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, w, -1, s, need,
                            NULL, NULL) != need) {
        free(s);
        return AH_ERR_INVALID;
    }
    *out = s;
    return AH_OK;
}

static ah_status map_spawn_error(DWORD e) {
    switch (e) {
    case ERROR_FILE_NOT_FOUND:
    case ERROR_PATH_NOT_FOUND:
    case ERROR_DIRECTORY:
    case ERROR_INVALID_DRIVE:
    case ERROR_BAD_NETPATH:
        return AH_ERR_NOT_FOUND;
    case ERROR_NOT_ENOUGH_MEMORY:
    case ERROR_OUTOFMEMORY:
        return AH_ERR_NOMEM;
    case ERROR_FILENAME_EXCED_RANGE:
        return AH_ERR_LIMIT;
    default:
        return AH_ERR_IO;
    }
}

/* --- ComSpec --- */

/* "X:\..." ou "X:/...": absoluto com letra de drive (nunca UNC). */
static bool drive_absolute(const char *u) {
    char c = u[0];
    bool letter = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
    return letter && u[1] == ':' && (u[2] == '\\' || u[2] == '/');
}

/* Caminho do cmd.exe: %ComSpec% se for absoluto com letra de drive, sem
 * aspas e terminar em .exe (SPEC-08 P1: "%ComSpec% validado como
 * absoluto"; UNC recusado: um cmd.exe num compartilhamento de rede não é
 * aceitável); senão o cmd.exe do diretório de sistema. Posse: free(). */
static ah_status comspec_path(char **out) {
    *out = NULL;
    wchar_t buf[MAX_PATH + 1];
    DWORD n = GetEnvironmentVariableW(L"ComSpec", buf, MAX_PATH + 1);
    if (n > 0 && n <= MAX_PATH) {
        char *u = NULL;
        if (to_utf8(buf, &u) == AH_OK) {
            size_t len = strlen(u);
            bool exe = len > 4 && _stricmp(u + len - 4, ".exe") == 0;
            if (exe && drive_absolute(u) && strchr(u, '"') == NULL &&
                !ah_proc_i_win_name_has_colon(u)) {
                *out = u;
                return AH_OK;
            }
            free(u);
        }
    }
    UINT sn = GetSystemDirectoryW(buf, MAX_PATH + 1);
    if (sn == 0 || sn > MAX_PATH - 8) {
        return AH_ERR_IO;
    }
    if (wcscat_s(buf, MAX_PATH + 1, L"\\cmd.exe") != 0) {
        return AH_ERR_LIMIT;
    }
    return to_utf8(buf, out);
}

/* --- bloco de ambiente --- */

typedef struct env_item {
    wchar_t *w;     /* "NOME=valor" */
    int name_units; /* unidades UTF-16 do nome */
} env_item;

static int env_cmp(const void *a, const void *b) {
    const env_item *x = a;
    const env_item *y = b;
    int r = CompareStringOrdinal(x->w, x->name_units, y->w, y->name_units,
                                 TRUE);
    return r - CSTR_EQUAL;
}

static bool is_no_cwd_var(const env_item *it) {
    return CompareStringOrdinal(it->w, it->name_units, NO_CWD_VAR,
                                (int)(sizeof NO_CWD_VAR / sizeof(wchar_t)) - 1,
                                TRUE) == CSTR_EQUAL;
}

static wchar_t *wdup(const wchar_t *s) {
    size_t n = wcslen(s) + 1;
    wchar_t *d = malloc(n * sizeof(wchar_t));
    if (d != NULL) {
        memcpy(d, s, n * sizeof(wchar_t));
    }
    return d;
}

/* Lista de entradas do ambiente do filho: as de `o->env` (UTF-8) ou, com
 * env == NULL, as do próprio Hub (GetEnvironmentStringsW). Reserva uma vaga
 * extra para NoDefaultCurrentDirectoryInExePath. */
static ah_status env_collect(const ah_proc_spawn_opts *o, env_item **items,
                             size_t *count, char *detail, size_t cap) {
    *items = NULL;
    *count = 0;
    wchar_t *parent = NULL;
    size_t n = 0;
    if (o->env != NULL) {
        n = o->env_count;
    } else {
        parent = GetEnvironmentStringsW();
        if (parent == NULL) {
            return AH_ERR_IO;
        }
        for (const wchar_t *q = parent; *q != L'\0'; q += wcslen(q) + 1) {
            n++;
        }
    }
    if (n > SIZE_MAX / sizeof(env_item) - 1) {
        if (parent != NULL) {
            FreeEnvironmentStringsW(parent);
        }
        return AH_ERR_LIMIT;
    }
    env_item *it = calloc(n + 1, sizeof(env_item));
    if (it == NULL) {
        if (parent != NULL) {
            FreeEnvironmentStringsW(parent);
        }
        return AH_ERR_NOMEM;
    }
    ah_status st = AH_OK;
    size_t k = 0;
    if (o->env != NULL) {
        for (size_t i = 0; i < n && st == AH_OK; i++) {
            size_t name_len = 0;
            st = ah_proc_i_env_split(o->env[i], &name_len);
            if (st != AH_OK) {
                ah_proc_i_detail(detail, cap,
                                 "entrada de ambiente %zu sem NOME=valor", i);
                break;
            }
            st = to_wide(o->env[i], strlen(o->env[i]), &it[k].w);
            if (st != AH_OK) {
                ah_proc_i_detail(detail, cap,
                                 "entrada de ambiente %zu com UTF-8 inválido",
                                 i);
                break;
            }
            k++;
        }
    } else {
        for (const wchar_t *q = parent; *q != L'\0' && st == AH_OK;
             q += wcslen(q) + 1) {
            if (wcschr(q + 1, L'=') == NULL) {
                continue; /* entrada sem '=': não há o que repassar */
            }
            it[k].w = wdup(q);
            if (it[k].w == NULL) {
                st = AH_ERR_NOMEM;
                break;
            }
            k++;
        }
        FreeEnvironmentStringsW(parent);
    }
    for (size_t i = 0; i < k; i++) {
        it[i].name_units = (int)(wcschr(it[i].w + 1, L'=') - it[i].w);
    }
    if (st != AH_OK) {
        for (size_t i = 0; i < k; i++) {
            free(it[i].w);
        }
        free(it);
        return st;
    }
    *items = it;
    *count = k;
    return AH_OK;
}

/* Bloco UTF-16 "A=1\0B=2\0\0" ordenado por nome sem diferenciar maiúsculas
 * (exigência documentada do CreateProcessW). Com env == NULL e sem via_cmd,
 * *out = NULL (o filho herda direto). Posse: free(). */
static ah_status build_env_block(const ah_proc_spawn_opts *o, wchar_t **out,
                                 char *detail, size_t cap) {
    *out = NULL;
    if (o->env == NULL && !o->via_cmd) {
        return AH_OK;
    }
    env_item *items = NULL;
    size_t count = 0;
    ah_status st = env_collect(o, &items, &count, detail, cap);
    if (st != AH_OK) {
        return st;
    }
    if (o->via_cmd) {
        /* P1 (DA-29): o cmd.exe não procura no diretório corrente quando o
         * .cmd chama outro programa pelo nome. Substitui valor anterior. */
        size_t k = 0;
        for (size_t i = 0; i < count; i++) {
            if (is_no_cwd_var(&items[i])) {
                free(items[i].w);
            } else {
                items[k++] = items[i];
            }
        }
        count = k;
        items[count].w = wdup(L"NoDefaultCurrentDirectoryInExePath=1");
        if (items[count].w == NULL) {
            st = AH_ERR_NOMEM;
        } else {
            items[count].name_units =
                (int)(sizeof NO_CWD_VAR / sizeof(wchar_t)) - 1;
            count++;
        }
    }
    size_t total = 1; /* NUL final do bloco */
    for (size_t i = 0; i < count && st == AH_OK; i++) {
        size_t wl = wcslen(items[i].w) + 1;
        if (wl > SIZE_MAX / sizeof(wchar_t) - total) {
            st = AH_ERR_LIMIT;
        }
        total += wl;
    }
    if (st == AH_OK && count > 1) {
        qsort(items, count, sizeof(env_item), env_cmp);
        for (size_t i = 1; i < count; i++) {
            if (env_cmp(&items[i - 1], &items[i]) == 0) {
                ah_proc_i_detail(detail, cap,
                                 "variável de ambiente repetida no bloco");
                st = AH_ERR_INVALID;
                break;
            }
        }
    }
    wchar_t *block = NULL;
    if (st == AH_OK) {
        if (total < 2) {
            total = 2; /* bloco vazio: dois NULs */
        }
        block = calloc(total, sizeof(wchar_t));
        if (block == NULL) {
            st = AH_ERR_NOMEM;
        }
    }
    if (st == AH_OK) {
        size_t pos = 0;
        for (size_t i = 0; i < count; i++) {
            size_t wl = wcslen(items[i].w) + 1;
            memcpy(block + pos, items[i].w, wl * sizeof(wchar_t));
            pos += wl;
        }
        *out = block;
    }
    for (size_t i = 0; i < count; i++) {
        free(items[i].w);
    }
    free(items);
    return st;
}

/* --- pipes --- */

/* SECURITY_ATTRIBUTES com DACL de uma ACE só, para o SID do usuário do
 * token. Buffers alinhados (TOKEN_USER tem ponteiro; ACL exige DWORD). */
typedef struct pipe_sec {
    SECURITY_ATTRIBUTES sa;
    SECURITY_DESCRIPTOR sd;
    union {
        TOKEN_USER tu;
        unsigned char raw[256];
    } tok;
    DWORD acl[64];
} pipe_sec;

static ah_status pipe_security(pipe_sec *ps) {
    HANDLE tok = NULL;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &tok)) {
        return AH_ERR_IO;
    }
    DWORD need = 0;
    BOOL ok = GetTokenInformation(tok, TokenUser, &ps->tok, sizeof ps->tok,
                                  &need);
    CloseHandle(tok);
    if (!ok) {
        return AH_ERR_IO;
    }
    PSID sid = ps->tok.tu.User.Sid;
    DWORD acl_size = (DWORD)(sizeof(ACL) + sizeof(ACCESS_ALLOWED_ACE) -
                             sizeof(DWORD) + GetLengthSid(sid));
    if (acl_size > sizeof ps->acl) {
        return AH_ERR_LIMIT;
    }
    PACL acl = (PACL)ps->acl;
    if (!InitializeAcl(acl, acl_size, ACL_REVISION) ||
        !AddAccessAllowedAce(acl, ACL_REVISION, FILE_ALL_ACCESS, sid) ||
        !InitializeSecurityDescriptor(&ps->sd, SECURITY_DESCRIPTOR_REVISION) ||
        !SetSecurityDescriptorDacl(&ps->sd, TRUE, acl, FALSE)) {
        return AH_ERR_IO;
    }
    ps->sa.nLength = sizeof ps->sa;
    ps->sa.lpSecurityDescriptor = &ps->sd;
    ps->sa.bInheritHandle = FALSE;
    return AH_OK;
}

/* Cria um pipe com o lado do Hub overlapped e não herdável e o lado do filho
 * síncrono e herdável. parent_reads: o Hub lê (stdout/stderr). */
static ah_status make_pipe(bool parent_reads, SECURITY_ATTRIBUTES *srv_sa,
                           HANDLE *parent, HANDLE *child) {
    *parent = INVALID_HANDLE_VALUE;
    *child = INVALID_HANDLE_VALUE;
    for (int attempt = 0; attempt < 4; attempt++) {
        unsigned char rnd[16];
        if (!BCRYPT_SUCCESS(BCryptGenRandom(NULL, rnd, sizeof rnd,
                                            BCRYPT_USE_SYSTEM_PREFERRED_RNG))) {
            return AH_ERR_IO;
        }
        wchar_t name[80] = L"\\\\.\\pipe\\agents-hub-proc-";
        size_t pos = wcslen(name);
        static const wchar_t hex[] = L"0123456789abcdef";
        for (size_t i = 0; i < sizeof rnd; i++) {
            name[pos++] = hex[rnd[i] >> 4];
            name[pos++] = hex[rnd[i] & 0xF];
        }
        name[pos] = L'\0';
        DWORD open_mode =
            (parent_reads ? PIPE_ACCESS_INBOUND : PIPE_ACCESS_OUTBOUND) |
            FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE;
        HANDLE srv = CreateNamedPipeW(
            name, open_mode,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT |
                PIPE_REJECT_REMOTE_CLIENTS,
            1, PIPE_BUF_BYTES, PIPE_BUF_BYTES, 0, srv_sa);
        if (srv == INVALID_HANDLE_VALUE) {
            DWORD e = GetLastError();
            if (e == ERROR_ACCESS_DENIED || e == ERROR_PIPE_BUSY) {
                continue; /* nome já existe: sorteia outro */
            }
            return map_spawn_error(e);
        }
        SECURITY_ATTRIBUTES sa;
        sa.nLength = sizeof sa;
        sa.lpSecurityDescriptor = NULL;
        sa.bInheritHandle = TRUE;
        DWORD access = parent_reads ? (GENERIC_WRITE | FILE_READ_ATTRIBUTES)
                                    : (GENERIC_READ | FILE_WRITE_ATTRIBUTES);
        HANDLE cli =
            CreateFileW(name, access, 0, &sa, OPEN_EXISTING, 0, NULL);
        if (cli == INVALID_HANDLE_VALUE) {
            CloseHandle(srv);
            return AH_ERR_IO;
        }
        *parent = srv;
        *child = cli;
        return AH_OK;
    }
    return AH_ERR_IO;
}

static void close_h(HANDLE *h) {
    if (*h != NULL && *h != INVALID_HANDLE_VALUE) {
        CloseHandle(*h);
    }
    *h = NULL;
}

/* Cancela a E/S em curso e espera o cancelamento: o kernel não pode
 * escrever num buffer já liberado. A espera é limitada: depois do
 * CancelIoEx a operação termina (com ERROR_OPERATION_ABORTED ou com o
 * resultado que já tinha). */
static void cancel_pending(HANDLE h, OVERLAPPED *ov, bool *pending) {
    if (*pending && h != NULL && h != INVALID_HANDLE_VALUE) {
        DWORD n = 0;
        CancelIoEx(h, ov);
        GetOverlappedResult(h, ov, &n, TRUE);
    }
    *pending = false;
}

/* Conclui um fechamento diferido do stdin se a escrita em curso acabou. */
static void finish_deferred_close(ah_proc *p) {
    if (!p->close_pending) {
        return;
    }
    DWORD put = 0;
    if (GetOverlappedResult(p->in_h, &p->in_ov, &put, FALSE) ||
        GetLastError() != ERROR_IO_INCOMPLETE) {
        p->wpending = false;
        p->close_pending = false;
        close_h(&p->in_h);
    }
}

void ah_proc_free(ah_proc *p) {
    if (p == NULL) {
        return;
    }
    if (p->thread != NULL && p->process != NULL) {
        /* Suspenso e nunca retomado: ficaria parado para sempre. */
        TerminateProcess(p->process, 1);
    }
    cancel_pending(p->in_h, &p->in_ov, &p->wpending);
    p->close_pending = false;
    close_h(&p->in_h);
    close_h(&p->in_ev);
    free(p->wbuf);
    for (int i = 0; i < 2; i++) {
        rd_state *r = &p->rd[i];
        cancel_pending(r->h, &r->ov, &r->pending);
        close_h(&r->h);
        close_h(&r->ev);
        free(r->buf);
    }
    close_h(&p->thread);
    close_h(&p->process);
    free(p);
}

/* --- spawn --- */

/* Valida o caminho e monta aplicação + linha de comando (UTF-8). */
static ah_status build_command(const ah_proc_spawn_opts *o, char **app,
                               char **cmdline, char *detail, size_t cap) {
    *app = NULL;
    *cmdline = NULL;
    if (!ah_proc_i_win_is_absolute(o->path)) {
        ah_proc_i_detail(detail, cap,
                         "caminho do executável não é absoluto: o Hub nunca "
                         "busca no diretório corrente");
        return AH_ERR_INVALID;
    }
    if (strchr(o->path, '"') != NULL ||
        ah_proc_i_win_name_has_colon(o->path)) {
        ah_proc_i_detail(detail, cap,
                         "caminho do executável com aspas ou ':' no nome");
        return AH_ERR_INVALID;
    }
    bool batch = ah_proc_i_win_is_batch(o->path);
    if (!o->via_cmd) {
        if (batch) {
            ah_proc_i_detail(detail, cap,
                             ".bat/.cmd só pelo ramo explícito do cmd.exe "
                             "(via_cmd)");
            return AH_ERR_INVALID;
        }
        ah_status st = ah_proc_win_command_line(o->path, o->args, o->arg_lens,
                                                o->arg_count, cmdline);
        if (st == AH_ERR_LIMIT) {
            ah_proc_i_detail(detail, cap,
                             "linha de comando excede o limite do Windows "
                             "(%d caracteres com o NUL)",
                             AH_PROC_WIN_MAX_CMDLINE);
        } else if (st == AH_ERR_INVALID) {
            ah_proc_i_detail(detail, cap,
                             "argumento com NUL embutido ou UTF-8 inválido");
        }
        if (st != AH_OK) {
            return st;
        }
        size_t n = strlen(o->path) + 1;
        *app = malloc(n);
        if (*app == NULL) {
            free(*cmdline);
            *cmdline = NULL;
            return AH_ERR_NOMEM;
        }
        memcpy(*app, o->path, n);
        return AH_OK;
    }

    if (!batch) {
        ah_proc_i_detail(detail, cap, "via_cmd exige um .cmd/.bat");
        return AH_ERR_INVALID;
    }
    char *linha = NULL;
    ah_status st = ah_proc_cmd_line(o->path, o->args, o->arg_lens,
                                    o->arg_count, &linha);
    if (st == AH_ERR_LIMIT) {
        ah_proc_i_detail(detail, cap,
                         "linha de comando excede o limite do cmd.exe (%d); "
                         "use stdinPrompt/{{promptFile}} no manifesto",
                         AH_PROC_CMD_MAX_LINE);
        return st;
    }
    if (st == AH_ERR_INVALID) {
        ah_proc_i_detail(detail, cap,
                         "argumento com quebra de linha ou NUL não atravessa "
                         "o cmd.exe sem ser truncado; use "
                         "stdinPrompt/{{promptFile}} no manifesto ou um "
                         "executável que não seja .cmd/.bat");
        return st;
    }
    if (st != AH_OK) {
        return st;
    }
    char *comspec = NULL;
    st = comspec_path(&comspec);
    if (st == AH_OK) {
        st = ah_proc_cmd_invocation(comspec, linha, cmdline);
    }
    free(linha);
    if (st != AH_OK) {
        free(comspec);
        return st;
    }
    *app = comspec;
    return AH_OK;
}

ah_status ah_proc_spawn(const ah_proc_spawn_opts *o, ah_proc **out,
                        char *detail, size_t cap) {
    if (detail != NULL && cap > 0) {
        detail[0] = '\0';
    }
    if (o == NULL || out == NULL || o->path == NULL ||
        (o->arg_count > 0 && o->args == NULL) ||
        (o->env_count > 0 && o->env == NULL)) {
        ah_proc_i_detail(detail, cap, "argumentos de spawn inválidos");
        return AH_ERR_INVALID;
    }
    *out = NULL;

    char *app8 = NULL;
    char *cmd8 = NULL;
    wchar_t *app = NULL;
    wchar_t *cmd = NULL;
    wchar_t *cwd = NULL;
    wchar_t *envb = NULL;
    LPPROC_THREAD_ATTRIBUTE_LIST attrs = NULL;
    bool attrs_init = false;
    HANDLE child[3] = {INVALID_HANDLE_VALUE, INVALID_HANDLE_VALUE,
                       INVALID_HANDLE_VALUE};
    pipe_sec psec;
    memset(&psec, 0, sizeof psec);
    ah_proc *p = calloc(1, sizeof *p);
    if (p == NULL) {
        return AH_ERR_NOMEM;
    }

    ah_status st = build_command(o, &app8, &cmd8, detail, cap);
    if (st == AH_OK) {
        st = to_wide(app8, strlen(app8), &app);
    }
    if (st == AH_OK) {
        st = to_wide(cmd8, strlen(cmd8), &cmd);
    }
    if (st == AH_OK && o->cwd != NULL) {
        st = to_wide(o->cwd, strlen(o->cwd), &cwd);
        if (st == AH_ERR_INVALID) {
            ah_proc_i_detail(detail, cap, "cwd com UTF-8 inválido");
        }
    }
    if (st == AH_OK) {
        st = build_env_block(o, &envb, detail, cap);
    }

    /* Recursos do Hub, todos antes do CreateProcessW: depois dele nada pode
     * falhar sem deixar um processo órfão. */
    if (st == AH_OK) {
        st = pipe_security(&psec);
    }
    if (st == AH_OK) {
        st = make_pipe(false, &psec.sa, &p->in_h, &child[0]);
    }
    for (int i = 0; i < 2 && st == AH_OK; i++) {
        st = make_pipe(true, &psec.sa, &p->rd[i].h, &child[i + 1]);
    }
    if (st == AH_OK) {
        p->in_ev = CreateEventW(NULL, TRUE, FALSE, NULL);
        p->wbuf = malloc(PIPE_BUF_BYTES);
        if (p->in_ev == NULL) {
            st = AH_ERR_IO;
        } else if (p->wbuf == NULL) {
            st = AH_ERR_NOMEM;
        }
    }
    for (int i = 0; i < 2 && st == AH_OK; i++) {
        p->rd[i].ev = CreateEventW(NULL, TRUE, FALSE, NULL);
        p->rd[i].buf = malloc(PIPE_BUF_BYTES);
        if (p->rd[i].ev == NULL) {
            st = AH_ERR_IO;
        } else if (p->rd[i].buf == NULL) {
            st = AH_ERR_NOMEM;
        }
    }
    if (st != AH_OK && detail != NULL && cap > 0 && detail[0] == '\0') {
        ah_proc_i_detail(detail, cap, "falha ao preparar o spawn");
    }

    /* P4: herança restrita aos três pipes do filho. */
    SIZE_T attr_size = 0;
    if (st == AH_OK) {
        InitializeProcThreadAttributeList(NULL, 1, 0, &attr_size);
        attrs = malloc(attr_size);
        if (attrs == NULL) {
            st = AH_ERR_NOMEM;
        } else if (!InitializeProcThreadAttributeList(attrs, 1, 0,
                                                      &attr_size)) {
            st = AH_ERR_IO;
        } else {
            attrs_init = true;
            if (!UpdateProcThreadAttribute(attrs, 0,
                                           PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                           child, sizeof child, NULL, NULL)) {
                st = AH_ERR_IO;
            }
        }
        if (st != AH_OK) {
            ah_proc_i_detail(detail, cap,
                             "falha ao restringir a herança de handles");
        }
    }

    if (st == AH_OK) {
        STARTUPINFOEXW si;
        memset(&si, 0, sizeof si);
        si.StartupInfo.cb = sizeof si;
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
        si.StartupInfo.wShowWindow = SW_HIDE;
        si.StartupInfo.hStdInput = child[0];
        si.StartupInfo.hStdOutput = child[1];
        si.StartupInfo.hStdError = child[2];
        si.lpAttributeList = attrs;
        DWORD flags = CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW |
                      EXTENDED_STARTUPINFO_PRESENT;
        if (o->start_suspended) {
            flags |= CREATE_SUSPENDED;
        }
        PROCESS_INFORMATION pi;
        memset(&pi, 0, sizeof pi);
        /* lpApplicationName absoluto: o SO não busca nada (SPEC-08 P1). */
        if (!CreateProcessW(app, cmd, NULL, NULL, TRUE, flags, envb, cwd,
                            &si.StartupInfo, &pi)) {
            DWORD e = GetLastError();
            st = map_spawn_error(e);
            ah_proc_i_detail(detail, cap,
                             "CreateProcessW falhou (erro %lu)",
                             (unsigned long)e);
        } else {
            p->process = pi.hProcess;
            p->pid = pi.dwProcessId;
            if (o->start_suspended) {
                p->thread = pi.hThread;
            } else {
                CloseHandle(pi.hThread);
            }
        }
    }

    for (int i = 0; i < 3; i++) {
        close_h(&child[i]);
    }
    if (attrs_init) {
        DeleteProcThreadAttributeList(attrs);
    }
    free(attrs);
    free(app8);
    free(cmd8);
    free(app);
    free(cmd);
    free(cwd);
    free(envb);
    if (st != AH_OK) {
        ah_proc_free(p);
        return st;
    }
    *out = p;
    return AH_OK;
}

/* --- E/S --- */

static void copy_out(rd_state *r, void *buf, size_t cap, size_t *n) {
    size_t avail = (size_t)(r->len - r->off);
    size_t k = avail < cap ? avail : cap;
    memcpy(buf, r->buf + r->off, k);
    r->off += (DWORD)k;
    *n = k;
}

static bool is_eof_error(DWORD e) {
    return e == ERROR_BROKEN_PIPE || e == ERROR_HANDLE_EOF ||
           e == ERROR_PIPE_NOT_CONNECTED;
}

/* Arma uma leitura overlapped. Mesmo concluída na hora, fica "em curso"
 * (o evento já está sinalizado) e é colhida por GetOverlappedResult. */
static ah_status rd_issue(rd_state *r, bool *eof) {
    *eof = false;
    memset(&r->ov, 0, sizeof r->ov);
    r->ov.hEvent = r->ev;
    r->len = 0;
    r->off = 0;
    if (!ReadFile(r->h, r->buf, PIPE_BUF_BYTES, NULL, &r->ov)) {
        DWORD e = GetLastError();
        if (e != ERROR_IO_PENDING) {
            if (is_eof_error(e)) {
                *eof = true;
                return AH_OK;
            }
            return AH_ERR_IO;
        }
    }
    r->pending = true;
    return AH_OK;
}

static ah_status rd_eof(rd_state *r, ah_proc_io *state) {
    r->eof = true;
    r->pending = false;
    SetEvent(r->ev); /* fluxo fechado conta como pronto */
    *state = AH_PROC_IO_EOF;
    return AH_OK;
}

ah_status ah_proc_read(ah_proc *p, ah_proc_stream stream, void *buf,
                       size_t cap, size_t *n, ah_proc_io *state) {
    if (p == NULL || buf == NULL || cap == 0 || n == NULL || state == NULL ||
        (stream != AH_PROC_STDOUT && stream != AH_PROC_STDERR)) {
        return AH_ERR_INVALID;
    }
    *n = 0;
    finish_deferred_close(p);
    rd_state *r = &p->rd[stream - 1];
    if (r->off < r->len) {
        copy_out(r, buf, cap, n);
        *state = AH_PROC_IO_DATA;
        return AH_OK;
    }
    if (r->eof || r->h == NULL) {
        *state = AH_PROC_IO_EOF;
        return AH_OK;
    }
    bool eof = false;
    if (!r->pending) {
        ah_status st = rd_issue(r, &eof);
        if (st != AH_OK) {
            return st;
        }
        if (eof) {
            return rd_eof(r, state);
        }
    }
    DWORD got = 0;
    if (!GetOverlappedResult(r->h, &r->ov, &got, FALSE)) {
        DWORD e = GetLastError();
        if (e == ERROR_IO_INCOMPLETE) {
            *state = AH_PROC_IO_AGAIN;
            return AH_OK;
        }
        r->pending = false;
        if (is_eof_error(e)) {
            return rd_eof(r, state);
        }
        return AH_ERR_IO;
    }
    r->pending = false;
    if (got > 0) {
        r->len = got;
        r->off = 0;
        copy_out(r, buf, cap, n);
        *state = AH_PROC_IO_DATA;
        return AH_OK;
    }
    /* Escrita de 0 bytes do filho: rearma UMA leitura e devolve AGAIN, sem
     * laço interno. Cada escrita vazia custa no máximo uma volta do laço do
     * chamador (que só volta se o evento sinalizar), então um filho que as
     * repete não faz o Hub girar sozinho. */
    ah_status st = rd_issue(r, &eof);
    if (st != AH_OK) {
        return st;
    }
    if (eof) {
        return rd_eof(r, state);
    }
    *state = AH_PROC_IO_AGAIN;
    return AH_OK;
}

ah_status ah_proc_write(ah_proc *p, const void *buf, size_t len,
                        size_t *accepted, ah_proc_io *state) {
    if (p == NULL || accepted == NULL || state == NULL ||
        (buf == NULL && len > 0)) {
        return AH_ERR_INVALID;
    }
    *accepted = 0;
    if (p->in_h == NULL || p->close_pending) {
        return AH_ERR_IO;
    }
    if (p->wpending) {
        DWORD put = 0;
        if (!GetOverlappedResult(p->in_h, &p->in_ov, &put, FALSE)) {
            DWORD e = GetLastError();
            if (e == ERROR_IO_INCOMPLETE) {
                *state = AH_PROC_IO_AGAIN;
                return AH_OK;
            }
            p->wpending = false;
            return AH_ERR_IO;
        }
        p->wpending = false;
    }
    if (len == 0) {
        *state = AH_PROC_IO_DATA;
        return AH_OK;
    }
    DWORD k = len < PIPE_BUF_BYTES ? (DWORD)len : PIPE_BUF_BYTES;
    memcpy(p->wbuf, buf, k);
    memset(&p->in_ov, 0, sizeof p->in_ov);
    p->in_ov.hEvent = p->in_ev;
    if (!WriteFile(p->in_h, p->wbuf, k, NULL, &p->in_ov)) {
        DWORD e = GetLastError();
        if (e != ERROR_IO_PENDING) {
            return AH_ERR_IO; /* ERROR_NO_DATA/BROKEN_PIPE: filho fechou */
        }
        p->wpending = true;
    }
    *accepted = k;
    *state = AH_PROC_IO_DATA;
    return AH_OK;
}

ah_status ah_proc_close_stdin(ah_proc *p) {
    if (p == NULL) {
        return AH_ERR_INVALID;
    }
    if (p->in_h == NULL) {
        return AH_OK;
    }
    if (p->close_pending) {
        finish_deferred_close(p);
        return AH_OK;
    }
    if (p->wpending) {
        DWORD put = 0;
        if (!GetOverlappedResult(p->in_h, &p->in_ov, &put, FALSE) &&
            GetLastError() == ERROR_IO_INCOMPLETE) {
            /* Não bloqueia: fecha quando a escrita em curso terminar. */
            p->close_pending = true;
            return AH_OK;
        }
        p->wpending = false;
    }
    close_h(&p->in_h);
    return AH_OK;
}

ah_status ah_proc_waitable(const ah_proc *p, ah_proc_stream stream,
                           intptr_t *out) {
    if (p == NULL || out == NULL) {
        return AH_ERR_INVALID;
    }
    switch (stream) {
    case AH_PROC_STDIN:
        if (p->in_h == NULL) {
            return AH_ERR_NOT_FOUND;
        }
        *out = (intptr_t)p->in_ev;
        return AH_OK;
    case AH_PROC_STDOUT:
    case AH_PROC_STDERR:
        if (p->rd[stream - 1].h == NULL) {
            return AH_ERR_NOT_FOUND;
        }
        *out = (intptr_t)p->rd[stream - 1].ev;
        return AH_OK;
    default:
        return AH_ERR_INVALID;
    }
}

ah_status ah_proc_exit_waitable(const ah_proc *p, intptr_t *out) {
    if (p == NULL || out == NULL || p->process == NULL) {
        return AH_ERR_INVALID;
    }
    *out = (intptr_t)p->process;
    return AH_OK;
}

ah_status ah_proc_native_pipe(const ah_proc *p, ah_proc_stream stream,
                              intptr_t *out) {
    if (p == NULL || out == NULL) {
        return AH_ERR_INVALID;
    }
    HANDLE h;
    switch (stream) {
    case AH_PROC_STDIN:
        h = p->in_h;
        break;
    case AH_PROC_STDOUT:
    case AH_PROC_STDERR:
        h = p->rd[stream - 1].h;
        break;
    default:
        return AH_ERR_INVALID;
    }
    if (h == NULL) {
        return AH_ERR_NOT_FOUND;
    }
    *out = (intptr_t)h;
    return AH_OK;
}

ah_status ah_proc_wait_io(ah_proc *p, unsigned mask, int32_t timeout_ms,
                          unsigned *ready) {
    if (p == NULL || ready == NULL || mask == 0 ||
        (mask & ~(AH_PROC_MASK_STDIN | AH_PROC_MASK_STDOUT |
                  AH_PROC_MASK_STDERR)) != 0) {
        return AH_ERR_INVALID;
    }
    ULONGLONG start = GetTickCount64();
    for (;;) {
        *ready = 0;
        finish_deferred_close(p);
        HANDLE hs[4];
        unsigned bits[4];
        DWORD count = 0;
        if (mask & AH_PROC_MASK_STDIN) {
            if (p->in_h == NULL || p->close_pending || !p->wpending) {
                *ready |= AH_PROC_MASK_STDIN;
            } else {
                hs[count] = p->in_ev;
                bits[count++] = AH_PROC_MASK_STDIN;
            }
        }
        for (int i = 0; i < 2; i++) {
            unsigned bit = 1u << (i + 1);
            if (!(mask & bit)) {
                continue;
            }
            rd_state *r = &p->rd[i];
            if (r->h == NULL || r->eof || r->off < r->len || !r->pending) {
                *ready |= bit;
            } else {
                hs[count] = r->ev;
                bits[count++] = bit;
            }
        }
        if (*ready != 0 || count == 0) {
            return AH_OK;
        }
        if (p->close_pending) {
            /* Interno: concluir o fechamento diferido assim que a escrita
             * terminar, mesmo que o chamador só espere stdout/stderr. */
            hs[count] = p->in_ev;
            bits[count++] = 0;
        }
        DWORD to = INFINITE;
        if (timeout_ms >= 0) {
            ULONGLONG elapsed = GetTickCount64() - start;
            to = elapsed >= (ULONGLONG)timeout_ms
                     ? 0
                     : (DWORD)((ULONGLONG)timeout_ms - elapsed);
        }
        DWORD w = WaitForMultipleObjects(count, hs, FALSE, to);
        if (w == WAIT_TIMEOUT) {
            return AH_OK;
        }
        if (w >= WAIT_OBJECT_0 + count) {
            return AH_ERR_IO;
        }
        for (DWORD i = 0; i < count; i++) {
            if (WaitForSingleObject(hs[i], 0) == WAIT_OBJECT_0) {
                *ready |= bits[i];
            }
        }
        if (*ready != 0) {
            finish_deferred_close(p);
            return AH_OK;
        }
        /* Só o evento interno sinalizou: conclui o fechamento e volta a
         * esperar pelo tempo que resta. */
    }
}

/* --- ciclo de vida --- */

ah_status ah_proc_wait(ah_proc *p, bool block, bool *exited,
                       ah_proc_exit *st) {
    if (p == NULL || exited == NULL || st == NULL) {
        return AH_ERR_INVALID;
    }
    finish_deferred_close(p);
    if (!p->exited) {
        DWORD w = WaitForSingleObject(p->process, block ? INFINITE : 0);
        if (w == WAIT_TIMEOUT) {
            *exited = false;
            return AH_OK;
        }
        if (w != WAIT_OBJECT_0) {
            return AH_ERR_IO;
        }
        DWORD code = 0;
        if (!GetExitCodeProcess(p->process, &code)) {
            return AH_ERR_IO;
        }
        p->st.code = (int64_t)code;
        p->st.signal = 0;
        p->exited = true;
    }
    *exited = true;
    *st = p->st;
    return AH_OK;
}

ah_status ah_proc_kill(ah_proc *p) {
    if (p == NULL) {
        return AH_ERR_INVALID;
    }
    if (p->exited) {
        return AH_OK;
    }
    if (TerminateProcess(p->process, 1)) {
        return AH_OK;
    }
    /* Já terminou sozinho: TerminateProcess falha com acesso negado. */
    if (WaitForSingleObject(p->process, 0) == WAIT_OBJECT_0) {
        return AH_OK;
    }
    return AH_ERR_IO;
}

ah_status ah_proc_resume(ah_proc *p) {
    if (p == NULL || p->thread == NULL) {
        return AH_ERR_INVALID;
    }
    if (ResumeThread(p->thread) == (DWORD)-1) {
        return AH_ERR_IO;
    }
    close_h(&p->thread);
    return AH_OK;
}

uint32_t ah_proc_pid(const ah_proc *p) {
    return p == NULL ? 0 : (uint32_t)p->pid;
}

intptr_t ah_proc_native_process(const ah_proc *p) {
    return p == NULL ? 0 : (intptr_t)p->process;
}
