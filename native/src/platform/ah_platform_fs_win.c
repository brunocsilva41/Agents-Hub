/* Área de arquivos de ah_platform, implementação Win32 (F0-05).
 *
 * Todo caminho UTF-8 vira UTF-16 aqui e as APIs "W" são as únicas usadas, para
 * que caminhos não ASCII (acentos, CJK) funcionem independentemente da página
 * de código do sistema. */
#if !defined(_WIN32)
#error "ah_platform_fs_win.c é só para Windows"
#endif

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include <aclapi.h>
#include <userenv.h>

#include <limits.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "ah_platform_fs.h"
#include "ah_platform_fs_internal.h"

/* Tentativas de nome de temporário antes de desistir (colisão com
 * CREATE_NEW só acontece se outro processo escolher o mesmo nonce). */
#define TMP_NAME_ATTEMPTS 64

static ah_status status_from_win32(DWORD err) {
    switch (err) {
    case ERROR_FILE_NOT_FOUND:
    case ERROR_PATH_NOT_FOUND:
    case ERROR_INVALID_DRIVE:
    case ERROR_BAD_NETPATH:
    case ERROR_BAD_NET_NAME:
        return AH_ERR_NOT_FOUND;
    case ERROR_NOT_ENOUGH_MEMORY:
    case ERROR_OUTOFMEMORY:
        return AH_ERR_NOMEM;
    case ERROR_INVALID_NAME:
    case ERROR_INVALID_PARAMETER:
        return AH_ERR_INVALID;
    case ERROR_FILENAME_EXCED_RANGE:
        return AH_ERR_LIMIT;
    default:
        return AH_ERR_IO;
    }
}

ah_status ah_platform_fs_init(void) {
    return AH_OK;
}

ah_status ah_platform_utf8_to_utf16(const char *utf8, wchar_t **out) {
    size_t len;
    int n, m;
    wchar_t *w;

    if (out != NULL) *out = NULL;
    if (utf8 == NULL || out == NULL) return AH_ERR_INVALID;

    len = strlen(utf8);
    if (len > (size_t)INT_MAX - 1) return AH_ERR_LIMIT;
    if (len == 0) {
        w = malloc(sizeof *w);
        if (w == NULL) return AH_ERR_NOMEM;
        w[0] = L'\0';
        *out = w;
        return AH_OK;
    }
    n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8, (int)len,
                            NULL, 0);
    if (n <= 0) {
        return GetLastError() == ERROR_NO_UNICODE_TRANSLATION
                   ? AH_ERR_INVALID
                   : status_from_win32(GetLastError());
    }
    if ((size_t)n > (SIZE_MAX / sizeof *w) - 1) return AH_ERR_LIMIT;
    w = malloc(((size_t)n + 1) * sizeof *w);
    if (w == NULL) return AH_ERR_NOMEM;
    m = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8, (int)len, w,
                            n);
    if (m != n) {
        free(w);
        return AH_ERR_INVALID;
    }
    w[n] = L'\0';
    *out = w;
    return AH_OK;
}

ah_status ah_platform_utf16_to_utf8(const wchar_t *utf16, char **out) {
    size_t len;
    int n, m;
    char *s;

    if (out != NULL) *out = NULL;
    if (utf16 == NULL || out == NULL) return AH_ERR_INVALID;

    len = wcslen(utf16);
    if (len > (size_t)INT_MAX - 1) return AH_ERR_LIMIT;
    if (len == 0) {
        s = malloc(1);
        if (s == NULL) return AH_ERR_NOMEM;
        s[0] = '\0';
        *out = s;
        return AH_OK;
    }
    n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, utf16, (int)len,
                            NULL, 0, NULL, NULL);
    if (n <= 0) {
        return GetLastError() == ERROR_NO_UNICODE_TRANSLATION
                   ? AH_ERR_INVALID
                   : status_from_win32(GetLastError());
    }
    if ((size_t)n > SIZE_MAX - 1) return AH_ERR_LIMIT;
    s = malloc((size_t)n + 1);
    if (s == NULL) return AH_ERR_NOMEM;
    m = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, utf16, (int)len, s,
                            n, NULL, NULL);
    if (m != n) {
        free(s);
        return AH_ERR_INVALID;
    }
    s[n] = '\0';
    *out = s;
    return AH_OK;
}

/* ------------------------------------------------------------------------ */
/* Segurança: DACL só com o SID do usuário do processo                       */
/* ------------------------------------------------------------------------ */

/* TOKEN_USER do processo; o SID é (*out)->User.Sid. Posse: free(). */
static ah_status current_user(TOKEN_USER **out) {
    HANDLE token = NULL;
    DWORD size = 0;
    TOKEN_USER *tu;
    ah_status st = AH_OK;

    *out = NULL;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
        return status_from_win32(GetLastError());
    }
    if (!GetTokenInformation(token, TokenUser, NULL, 0, &size) &&
        GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
        st = status_from_win32(GetLastError());
        CloseHandle(token);
        return st;
    }
    tu = malloc(size);
    if (tu == NULL) {
        CloseHandle(token);
        return AH_ERR_NOMEM;
    }
    if (!GetTokenInformation(token, TokenUser, tu, size, &size)) {
        st = status_from_win32(GetLastError());
        free(tu);
        CloseHandle(token);
        return st;
    }
    CloseHandle(token);
    *out = tu;
    return AH_OK;
}

/* Descritor privado: DACL protegida (não herda nada da pasta) com uma única
 * ACE de controle total para o SID do usuário. Em diretório, a ACE é
 * herdável por arquivos e subpastas, para o que nascer dentro também ficar
 * restrito. Equivale a `icacls /inheritance:r /grant:r <usuário>:F` da
 * SPEC-01 §4, mas por SID (DV-32): sem resolver nome, sem USERDOMAIN. */
typedef struct private_sd {
    TOKEN_USER *user;
    ACL *acl;
    SECURITY_DESCRIPTOR sd;
} private_sd;

static void private_sd_free(private_sd *p) {
    free(p->acl);
    free(p->user);
    p->acl = NULL;
    p->user = NULL;
}

static ah_status private_sd_init(private_sd *p, int is_dir) {
    DWORD sid_len, acl_len;
    ah_status st;

    memset(p, 0, sizeof *p);
    st = current_user(&p->user);
    if (st != AH_OK) return st;

    sid_len = GetLengthSid(p->user->User.Sid);
    acl_len = (DWORD)(sizeof(ACL) + sizeof(ACCESS_ALLOWED_ACE) -
                      sizeof(DWORD) + sid_len);
    acl_len = (acl_len + (DWORD)(sizeof(DWORD) - 1)) &
              ~(DWORD)(sizeof(DWORD) - 1);
    p->acl = malloc(acl_len);
    if (p->acl == NULL) {
        private_sd_free(p);
        return AH_ERR_NOMEM;
    }
    if (!InitializeAcl(p->acl, acl_len, ACL_REVISION) ||
        !AddAccessAllowedAceEx(
            p->acl, ACL_REVISION,
            is_dir ? (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) : 0,
            FILE_ALL_ACCESS, p->user->User.Sid) ||
        !InitializeSecurityDescriptor(&p->sd, SECURITY_DESCRIPTOR_REVISION) ||
        !SetSecurityDescriptorDacl(&p->sd, TRUE, p->acl, FALSE) ||
        /* Dono explícito = o usuário: num processo elevado o dono padrão
         * seria o grupo Administradores, e o dono sempre pode reescrever a
         * DACL. O próprio SID do usuário sempre pode ser dono. */
        !SetSecurityDescriptorOwner(&p->sd, p->user->User.Sid, FALSE) ||
        !SetSecurityDescriptorControl(&p->sd, SE_DACL_PROTECTED,
                                      SE_DACL_PROTECTED)) {
        st = status_from_win32(GetLastError());
        private_sd_free(p);
        return st == AH_OK ? AH_ERR_INTERNAL : st;
    }
    return AH_OK;
}

/* ------------------------------------------------------------------------ */
/* Diretórios                                                                */
/* ------------------------------------------------------------------------ */

ah_status ah_platform_fs_mkdirs(const char *path) {
    char *norm = NULL;
    wchar_t *w = NULL;
    size_t root = 0, len, k;
    private_sd psd;
    SECURITY_ATTRIBUTES sa;
    ah_status st;

    if (path == NULL || path[0] == '\0') return AH_ERR_INVALID;

    st = ah_platform_fs_normalize_ex(path, &norm, &root);
    if (st != AH_OK) return st;
    st = ah_platform_utf8_to_utf16(norm, &w);
    if (st == AH_OK && root > 0) {
        /* A raiz (que não é criada) medida em unidades UTF-16: um nome UNC
         * não ASCII tem tamanho diferente nas duas codificações. */
        wchar_t *wroot = NULL;
        char saved = norm[root];
        norm[root] = '\0';
        st = ah_platform_utf8_to_utf16(norm, &wroot);
        norm[root] = saved;
        if (st == AH_OK) {
            root = wcslen(wroot);
            free(wroot);
        }
    }
    free(norm);
    if (st != AH_OK) {
        free(w);
        return st;
    }
    len = wcslen(w);
    if (root == 4 && len >= 4 && (w[2] == L'?' || w[2] == L'.')) {
        /* "\\?\C:\...": o volume logo depois do prefixo também é raiz. */
        while (root < len && w[root] != L'\\') root++;
        if (root < len) root++;
    }

    st = private_sd_init(&psd, 1);
    if (st != AH_OK) {
        free(w);
        return st;
    }
    sa.nLength = sizeof sa;
    sa.lpSecurityDescriptor = &psd.sd;
    sa.bInheritHandle = FALSE;

    for (k = root; k <= len; k++) {
        DWORD attrs;
        wchar_t saved;
        if (k < len && w[k] != L'\\') continue;
        if (k == root) continue;
        saved = w[k];
        w[k] = L'\0';
        attrs = GetFileAttributesW(w);
        if (attrs == INVALID_FILE_ATTRIBUTES) {
            if (!CreateDirectoryW(w, &sa)) {
                DWORD err = GetLastError();
                /* Corrida: outro processo criou entre o teste e a criação. */
                attrs = GetFileAttributesW(w);
                if (err != ERROR_ALREADY_EXISTS ||
                    attrs == INVALID_FILE_ATTRIBUTES ||
                    !(attrs & FILE_ATTRIBUTE_DIRECTORY)) {
                    st = err == ERROR_ALREADY_EXISTS ? AH_ERR_IO
                                                     : status_from_win32(err);
                    w[k] = saved;
                    break;
                }
            }
        } else if (!(attrs & FILE_ATTRIBUTE_DIRECTORY)) {
            st = AH_ERR_IO;
            w[k] = saved;
            break;
        }
        w[k] = saved;
    }

    private_sd_free(&psd);
    free(w);
    return st;
}

/* ------------------------------------------------------------------------ */
/* Escrita atômica                                                           */
/* ------------------------------------------------------------------------ */

static unsigned long long tmp_nonce(unsigned attempt) {
    static volatile LONG counter = 0;
    LARGE_INTEGER qpc;
    unsigned long long v;

    QueryPerformanceCounter(&qpc);
    v = (unsigned long long)qpc.QuadPart;
    v ^= (unsigned long long)(ULONG)InterlockedIncrement(&counter) << 40;
    v ^= (unsigned long long)GetCurrentThreadId() << 20;
    v ^= (unsigned long long)attempt * 0x9E3779B97F4A7C15ull;
    return v & 0xFFFFFFFFFFFFull; /* 12 dígitos hex */
}

static ah_status write_all(HANDLE h, const unsigned char *p, size_t len) {
    while (len > 0) {
        DWORD chunk = len > 0x40000000u ? 0x40000000u : (DWORD)len;
        DWORD done = 0;
        if (!WriteFile(h, p, chunk, &done, NULL)) {
            return status_from_win32(GetLastError());
        }
        if (done == 0) return AH_ERR_IO;
        p += done;
        len -= done;
    }
    return AH_OK;
}

/* Renomeia o arquivo aberto em `h` para `dest`, substituindo o destino com
 * semântica POSIX (FILE_RENAME_FLAG_POSIX_SEMANTICS, Windows 10 1709+): o
 * rename vale mesmo com o destino aberto por um leitor (que o tenha aberto
 * com FILE_SHARE_DELETE, como ah_platform_fs_read_all e o libuv do Node
 * fazem); o MoveFileExW falharia com acesso negado nesse caso. Se o volume ou
 * o SO não suportam, devolve AH_OK com *renamed = 0, e o chamador usa o
 * MoveFileExW depois de fechar o handle. */
static ah_status rename_by_handle(HANDLE h, const wchar_t *dest,
                                  int *renamed) {
    *renamed = 0;
#if defined(FILE_RENAME_FLAG_POSIX_SEMANTICS)
    {
        size_t n = wcslen(dest), bytes;
        FILE_RENAME_INFO *ri;
        BOOL ok;
        DWORD err;

        if (n > (MAXDWORD / sizeof(WCHAR)) - 1) return AH_ERR_LIMIT;
        bytes = offsetof(FILE_RENAME_INFO, FileName) + (n + 1) * sizeof(WCHAR);
        if (bytes < sizeof *ri) bytes = sizeof *ri;
        ri = calloc(1, bytes);
        if (ri == NULL) return AH_ERR_NOMEM;
        ri->Flags =
            FILE_RENAME_FLAG_REPLACE_IF_EXISTS | FILE_RENAME_FLAG_POSIX_SEMANTICS;
        ri->RootDirectory = NULL;
        ri->FileNameLength = (DWORD)(n * sizeof(WCHAR));
        memcpy(ri->FileName, dest, (n + 1) * sizeof(WCHAR));
        ok = SetFileInformationByHandle(h, FileRenameInfoEx, ri, (DWORD)bytes);
        err = ok ? ERROR_SUCCESS : GetLastError();
        free(ri);
        if (ok) {
            *renamed = 1;
            return AH_OK;
        }
        /* Sem suporte (SO antigo, FAT, alguns compartilhamentos): cai no
         * MoveFileExW. Qualquer outro erro é real. */
        if (err != ERROR_INVALID_PARAMETER && err != ERROR_NOT_SUPPORTED &&
            err != ERROR_INVALID_FUNCTION) {
            return status_from_win32(err);
        }
    }
#else
    (void)h;
    (void)dest;
#endif
    return AH_OK;
}

ah_status ah_platform_fs_write_atomic(const char *path, const void *data,
                                      size_t len, unsigned flags) {
    char *norm = NULL, *dir = NULL, *tmp = NULL;
    wchar_t *wpath = NULL, *wtmp = NULL;
    HANDLE h = INVALID_HANDLE_VALUE;
    private_sd psd;
    SECURITY_ATTRIBUTES sa;
    int have_sd = 0;
    unsigned attempt;
    ah_status st;

    if (path == NULL || path[0] == '\0' || (data == NULL && len > 0) ||
        (flags & ~(unsigned)AH_PLATFORM_FS_PRIVATE) != 0) {
        return AH_ERR_INVALID;
    }

    /* Tudo (pasta pai, temporário e destino) sai do MESMO caminho
     * normalizado: "x/../y/f" cria y e grava y/f, sem depender de x. */
    st = ah_platform_path_normalize(path, &norm);
    if (st != AH_OK) return st;
    st = ah_platform_fs_dirname(norm, &dir);
    if (st == AH_OK) st = ah_platform_fs_mkdirs(dir);
    free(dir);
    if (st == AH_OK) st = ah_platform_utf8_to_utf16(norm, &wpath);
    if (st != AH_OK) {
        free(norm);
        return st;
    }

    if (flags & AH_PLATFORM_FS_PRIVATE) {
        st = private_sd_init(&psd, 0);
        if (st != AH_OK) {
            free(wpath);
            free(norm);
            return st;
        }
        have_sd = 1;
        sa.nLength = sizeof sa;
        sa.lpSecurityDescriptor = &psd.sd;
        sa.bInheritHandle = FALSE;
    }

    for (attempt = 0; attempt < TMP_NAME_ATTEMPTS; attempt++) {
        st = ah_platform_fs_tmp_name(norm, (unsigned long)GetCurrentProcessId(),
                                     tmp_nonce(attempt), &tmp);
        if (st != AH_OK) break;
        st = ah_platform_utf8_to_utf16(tmp, &wtmp);
        free(tmp);
        tmp = NULL;
        if (st != AH_OK) break;
        /* CREATE_NEW = flag `wx` do TS: nunca reaproveita um arquivo que já
         * existe (nem um temporário plantado por outro). */
        /* DELETE: necessário para renomear pelo próprio handle.
         * FILE_SHARE_READ: entre o rename e o CloseHandle o arquivo já tem o
         * nome final, completo e no disco; um leitor que o abra nesse
         * intervalo não pode levar violação de compartilhamento. */
        h = CreateFileW(wtmp, GENERIC_WRITE | DELETE, FILE_SHARE_READ,
                        have_sd ? &sa : NULL, CREATE_NEW,
                        FILE_ATTRIBUTE_NORMAL, NULL);
        if (h != INVALID_HANDLE_VALUE) break;
        if (GetLastError() != ERROR_FILE_EXISTS &&
            GetLastError() != ERROR_ALREADY_EXISTS) {
            st = status_from_win32(GetLastError());
            break;
        }
        free(wtmp);
        wtmp = NULL;
        st = AH_ERR_IO;
    }
    free(norm);
    if (h == INVALID_HANDLE_VALUE) {
        free(wtmp);
        free(wpath);
        if (have_sd) private_sd_free(&psd);
        return st == AH_OK ? AH_ERR_IO : st;
    }

    st = write_all(h, data, len);
    if (st == AH_OK && !FlushFileBuffers(h)) {
        st = status_from_win32(GetLastError());
    }
    if (st == AH_OK) {
        int renamed = 0;
        st = rename_by_handle(h, wpath, &renamed);
        if (!CloseHandle(h) && st == AH_OK && !renamed) {
            st = status_from_win32(GetLastError());
        }
        if (st == AH_OK && !renamed &&
            !MoveFileExW(wtmp, wpath,
                         MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
            st = status_from_win32(GetLastError());
        }
    } else {
        CloseHandle(h);
    }
    if (st != AH_OK) {
        DeleteFileW(wtmp); /* melhor esforço: o erro original é o que vale */
    }

    free(wtmp);
    free(wpath);
    if (have_sd) private_sd_free(&psd);
    return st;
}

/* ------------------------------------------------------------------------ */
/* Leitura                                                                   */
/* ------------------------------------------------------------------------ */

ah_status ah_platform_fs_read_all(const char *path, size_t max_bytes,
                                  char **out, size_t *out_len) {
    wchar_t *w = NULL;
    HANDLE h;
    LARGE_INTEGER size;
    char *buf = NULL;
    size_t cap, used = 0;
    ah_status st = AH_OK;

    if (out != NULL) *out = NULL;
    if (out_len != NULL) *out_len = 0;
    if (path == NULL || out == NULL || out_len == NULL) return AH_ERR_INVALID;
    if (max_bytes > SIZE_MAX - 2) return AH_ERR_INVALID;

    st = ah_platform_utf8_to_utf16(path, &w);
    if (st != AH_OK) return st;
    /* FILE_SHARE_DELETE: a leitura não pode impedir o rename da escrita
     * atômica de outro processo. */
    h = CreateFileW(w, GENERIC_READ,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    free(w);
    if (h == INVALID_HANDLE_VALUE) return status_from_win32(GetLastError());
    /* Só arquivo em disco: pipe nomeado ou dispositivo podem bloquear a
     * leitura e não têm tamanho confiável. */
    if (GetFileType(h) != FILE_TYPE_DISK) {
        CloseHandle(h);
        return AH_ERR_INVALID;
    }

    if (!GetFileSizeEx(h, &size) || size.QuadPart < 0) {
        st = status_from_win32(GetLastError());
        CloseHandle(h);
        return st == AH_OK ? AH_ERR_IO : st;
    }
    if ((unsigned long long)size.QuadPart > (unsigned long long)max_bytes) {
        CloseHandle(h);
        return AH_ERR_LIMIT;
    }
    /* O tamanho é só a dica inicial: o arquivo pode crescer durante a
     * leitura, e o teto vale para o que de fato foi lido. */
    cap = (size_t)size.QuadPart + 1;
    buf = malloc(cap + 1);
    if (buf == NULL) {
        CloseHandle(h);
        return AH_ERR_NOMEM;
    }
    for (;;) {
        DWORD want, got = 0;
        if (used == cap) {
            size_t ncap;
            char *nb;
            if (cap > max_bytes) {
                st = AH_ERR_LIMIT;
                break;
            }
            ncap = cap > max_bytes + 1 - cap ? max_bytes + 1 : cap * 2;
            nb = realloc(buf, ncap + 1);
            if (nb == NULL) {
                st = AH_ERR_NOMEM;
                break;
            }
            buf = nb;
            cap = ncap;
        }
        want = cap - used > 0x40000000u ? 0x40000000u : (DWORD)(cap - used);
        if (!ReadFile(h, buf + used, want, &got, NULL)) {
            st = status_from_win32(GetLastError());
            break;
        }
        if (got == 0) break;
        used += got;
        if (used > max_bytes) {
            st = AH_ERR_LIMIT;
            break;
        }
    }
    CloseHandle(h);
    if (st != AH_OK) {
        free(buf);
        return st;
    }
    buf[used] = '\0';
    *out = buf;
    *out_len = used;
    return AH_OK;
}

/* ------------------------------------------------------------------------ */
/* Restrição                                                                 */
/* ------------------------------------------------------------------------ */

/* Abre `w` sem seguir link simbólico nem junction (FILE_FLAG_OPEN_REPARSE_POINT;
 * BACKUP_SEMANTICS para aceitar diretório) e devolve os atributos do objeto
 * aberto. Trabalhar pelo handle evita trocar o caminho entre a checagem e o
 * uso. */
static ah_status open_no_follow(const wchar_t *w, DWORD access, HANDLE *out,
                                DWORD *attrs) {
    BY_HANDLE_FILE_INFORMATION info;
    HANDLE h;
    ah_status st;

    *out = INVALID_HANDLE_VALUE;
    h = CreateFileW(w, access | FILE_READ_ATTRIBUTES,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    NULL, OPEN_EXISTING,
                    FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
                    NULL);
    if (h == INVALID_HANDLE_VALUE) return status_from_win32(GetLastError());
    if (!GetFileInformationByHandle(h, &info)) {
        st = status_from_win32(GetLastError());
        CloseHandle(h);
        return st == AH_OK ? AH_ERR_IO : st;
    }
    *attrs = info.dwFileAttributes;
    *out = h;
    return AH_OK;
}

ah_status ah_platform_fs_restrict(const char *path) {
    wchar_t *w = NULL;
    HANDLE h = INVALID_HANDLE_VALUE, ho;
    PSID owner = NULL;
    PSECURITY_DESCRIPTOR owner_sd = NULL;
    DWORD attrs = 0, err;
    bool owner_ok;
    private_sd psd;
    ah_status st;

    if (path == NULL || path[0] == '\0') return AH_ERR_INVALID;
    st = ah_platform_utf8_to_utf16(path, &w);
    if (st != AH_OK) return st;
    /* Sem WRITE_OWNER aqui: o dono tem READ_CONTROL e WRITE_DAC implícitos,
     * mas não WRITE_OWNER. Pedir WRITE_OWNER logo de cara faria restrict
     * falhar num arquivo do próprio usuário cuja DACL não lhe dá controle
     * total. READ_CONTROL: o SetSecurityInfo lê o descritor atual para
     * recalcular a herança. */
    st = open_no_follow(w, READ_CONTROL | WRITE_DAC, &h, &attrs);
    free(w);
    if (st != AH_OK) return st;

    /* Link simbólico ou junction: recusado, como o O_NOFOLLOW do POSIX.
     * Restringir o link não protege o alvo, e seguir o link restringiria
     * um objeto que o chamador não nomeou. */
    if (attrs & FILE_ATTRIBUTE_REPARSE_POINT) {
        CloseHandle(h);
        return AH_ERR_INVALID;
    }
    st = private_sd_init(&psd, (attrs & FILE_ATTRIBUTE_DIRECTORY) != 0);
    if (st != AH_OK) {
        CloseHandle(h);
        return st;
    }
    err = GetSecurityInfo(h, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION,
                          &owner, NULL, NULL, NULL, &owner_sd);
    if (err != ERROR_SUCCESS) {
        private_sd_free(&psd);
        CloseHandle(h);
        return status_from_win32(err);
    }
    owner_ok = owner != NULL && EqualSid(owner, psd.user->User.Sid);
    LocalFree(owner_sd);

    /* Primeiro a DACL (só o usuário, com controle total)... */
    err = SetSecurityInfo(h, SE_FILE_OBJECT,
                          DACL_SECURITY_INFORMATION |
                              PROTECTED_DACL_SECURITY_INFORMATION,
                          NULL, NULL, psd.acl, NULL);
    if (err == ERROR_SUCCESS && !owner_ok) {
        /* ...depois o dono, só se ainda não for o usuário. Agora a DACL dá
         * WRITE_OWNER ao usuário. ReOpenFile reabre o MESMO objeto (sem
         * passar pelo nome de novo, logo sem corrida com troca de link). */
        ho = ReOpenFile(h, WRITE_OWNER,
                        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                        FILE_FLAG_OPEN_REPARSE_POINT |
                            FILE_FLAG_BACKUP_SEMANTICS);
        if (ho == INVALID_HANDLE_VALUE) {
            err = GetLastError();
        } else {
            err = SetSecurityInfo(ho, SE_FILE_OBJECT,
                                  OWNER_SECURITY_INFORMATION,
                                  psd.user->User.Sid, NULL, NULL, NULL);
            CloseHandle(ho);
        }
    }
    private_sd_free(&psd);
    CloseHandle(h);
    return err == ERROR_SUCCESS ? AH_OK : status_from_win32(err);
}

ah_status ah_platform_fs_check_restricted(const char *path, bool *restricted) {
    wchar_t *w = NULL;
    HANDLE h = INVALID_HANDLE_VALUE;
    PSID owner = NULL;
    PACL dacl = NULL;
    PSECURITY_DESCRIPTOR sd = NULL;
    SECURITY_DESCRIPTOR_CONTROL ctrl = 0;
    DWORD rev = 0, err, i, attrs = 0;
    BYTE need_flags;
    TOKEN_USER *user = NULL;
    bool ok;
    ah_status st;

    if (restricted != NULL) *restricted = false;
    if (path == NULL || path[0] == '\0' || restricted == NULL) {
        return AH_ERR_INVALID;
    }
    st = ah_platform_utf8_to_utf16(path, &w);
    if (st != AH_OK) return st;
    st = open_no_follow(w, READ_CONTROL, &h, &attrs);
    free(w);
    if (st != AH_OK) return st;
    if (attrs & FILE_ATTRIBUTE_REPARSE_POINT) {
        /* Link/junction nunca conta como restrito (POSIX: S_ISLNK). */
        CloseHandle(h);
        return AH_OK;
    }
    err = GetSecurityInfo(h, SE_FILE_OBJECT,
                          OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                          &owner, NULL, &dacl, NULL, &sd);
    CloseHandle(h);
    if (err != ERROR_SUCCESS) return status_from_win32(err);

    st = current_user(&user);
    if (st != AH_OK) {
        LocalFree(sd);
        return st;
    }
    if (!GetSecurityDescriptorControl(sd, &ctrl, &rev)) {
        st = status_from_win32(GetLastError());
        free(user);
        LocalFree(sd);
        return st == AH_OK ? AH_ERR_IO : st;
    }

    /* Em diretório, a ACE precisa ser herdável por arquivos e subpastas:
     * sem isso, o que nascer dentro herda a DACL do resto do caminho. */
    need_flags = (attrs & FILE_ATTRIBUTE_DIRECTORY)
                     ? (BYTE)(OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)
                     : (BYTE)0;

    /* Dono = usuário (equivale ao st_uid == geteuid() do POSIX): o dono
     * pode reescrever a DACL a qualquer momento. DACL nula = acesso total
     * para todos; protegida = não herda da pasta. */
    ok = owner != NULL && EqualSid(owner, user->User.Sid) && dacl != NULL &&
         (ctrl & SE_DACL_PROTECTED) != 0 && dacl->AceCount > 0;
    for (i = 0; ok && i < dacl->AceCount; i++) {
        void *ace = NULL;
        const ACE_HEADER *hdr;
        if (!GetAce(dacl, i, &ace)) {
            ok = false;
            break;
        }
        hdr = (const ACE_HEADER *)ace;
        if (hdr->AceType != ACCESS_ALLOWED_ACE_TYPE ||
            (hdr->AceFlags & INHERITED_ACE) != 0 ||
            (hdr->AceFlags & need_flags) != need_flags) {
            ok = false;
            break;
        }
        if (!EqualSid((PSID)&((ACCESS_ALLOWED_ACE *)ace)->SidStart,
                      user->User.Sid)) {
            ok = false;
        }
    }

    free(user);
    LocalFree(sd);
    *restricted = ok;
    return AH_OK;
}

/* ------------------------------------------------------------------------ */
/* Home                                                                      */
/* ------------------------------------------------------------------------ */

/* Valor UTF-8 da variável `name`. AH_ERR_NOT_FOUND se não definida; valor
 * vazio devolve "" (o chamador decide). Posse: *out é do chamador (free). */
static ah_status get_env_utf8(const wchar_t *name, char **out) {
    DWORD n, m;
    wchar_t *buf;
    ah_status st;

    *out = NULL;
    SetLastError(ERROR_SUCCESS);
    n = GetEnvironmentVariableW(name, NULL, 0);
    if (n == 0) {
        DWORD err = GetLastError();
        if (err == ERROR_ENVVAR_NOT_FOUND) return AH_ERR_NOT_FOUND;
        if (err != ERROR_SUCCESS) return status_from_win32(err);
        n = 1; /* definida e vazia */
    }
    buf = malloc((size_t)n * sizeof *buf);
    if (buf == NULL) return AH_ERR_NOMEM;
    SetLastError(ERROR_SUCCESS);
    m = GetEnvironmentVariableW(name, buf, n);
    if (m == 0) {
        DWORD err = GetLastError();
        if (err == ERROR_ENVVAR_NOT_FOUND) {
            free(buf);
            return AH_ERR_NOT_FOUND;
        }
        if (err != ERROR_SUCCESS) {
            free(buf);
            return status_from_win32(err);
        }
        buf[0] = L'\0';
    } else if (m >= n) {
        /* Mudou entre as duas chamadas. */
        free(buf);
        return AH_ERR_IO;
    }
    st = ah_platform_utf16_to_utf8(buf, out);
    free(buf);
    return st;
}

/* Pasta de perfil do usuário pelo SO (fallback de USERPROFILE, como o
 * os.homedir do Node faz). Posse: free(). */
static ah_status profile_dir(char **out) {
    HANDLE token = NULL;
    DWORD n = 0;
    wchar_t *buf;
    ah_status st;

    *out = NULL;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
        return status_from_win32(GetLastError());
    }
    if (GetUserProfileDirectoryW(token, NULL, &n) ||
        GetLastError() != ERROR_INSUFFICIENT_BUFFER || n == 0) {
        st = status_from_win32(GetLastError());
        CloseHandle(token);
        return st == AH_OK ? AH_ERR_NOT_FOUND : st;
    }
    buf = malloc((size_t)n * sizeof *buf);
    if (buf == NULL) {
        CloseHandle(token);
        return AH_ERR_NOMEM;
    }
    if (!GetUserProfileDirectoryW(token, buf, &n)) {
        st = status_from_win32(GetLastError());
        free(buf);
        CloseHandle(token);
        return st;
    }
    CloseHandle(token);
    st = ah_platform_utf16_to_utf8(buf, out);
    free(buf);
    return st;
}

ah_status ah_platform_fs_resolve_home(char **out) {
    char *v = NULL;
    ah_status st;

    if (out == NULL) return AH_ERR_INVALID;
    *out = NULL;

    st = get_env_utf8(L"AGENTS_HUB_HOME", &v);
    if (st == AH_OK) {
        if (v[0] == '\0') {
            free(v);
            return AH_ERR_INVALID;
        }
        *out = v;
        return AH_OK;
    }
    if (st != AH_ERR_NOT_FOUND) return st;

    st = get_env_utf8(L"USERPROFILE", &v);
    if (st == AH_OK && v[0] == '\0') {
        free(v);
        v = NULL;
        st = AH_ERR_NOT_FOUND;
    }
    if (st == AH_ERR_NOT_FOUND) st = profile_dir(&v);
    if (st != AH_OK) return st;

    st = ah_platform_path_join(v, ".agents-hub", out);
    free(v);
    return st;
}
