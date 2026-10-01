/* Área de arquivos de ah_platform, implementação POSIX (F0-05).
 *
 * POSIX.1-2008 + XSI (_XOPEN_SOURCE 700): O_CLOEXEC, O_NOFOLLOW, O_DIRECTORY,
 * fsync, getpwuid_r e clock_gettime. Com CMAKE_C_EXTENSIONS OFF (-std=c17) a
 * glibc só declara essas funções com a macro definida antes dos includes. */
#if defined(_WIN32)
#error "ah_platform_fs_posix.c não é para Windows"
#endif

#define _XOPEN_SOURCE 700

#include <errno.h>
#include <fcntl.h>
#include <pwd.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#include "ah_platform_fs.h"
#include "ah_platform_fs_internal.h"

#define TMP_NAME_ATTEMPTS 64

static ah_status status_from_errno(int err) {
    switch (err) {
    case ENOENT:
    case ENOTDIR:
        return AH_ERR_NOT_FOUND;
    case ENOMEM:
        return AH_ERR_NOMEM;
    case EINVAL:
        return AH_ERR_INVALID;
    case ENAMETOOLONG:
        return AH_ERR_LIMIT;
    default:
        return AH_ERR_IO;
    }
}

ah_status ah_platform_fs_init(void) {
    /* DV-33 / SPEC-08 V5: nada do Hub nasce legível por grupo ou outros. */
    (void)umask(077);
    return AH_OK;
}

/* ------------------------------------------------------------------------ */
/* Diretórios                                                                */
/* ------------------------------------------------------------------------ */

static ah_status mkdir_one(const char *p) {
    struct stat stbuf;

    if (mkdir(p, 0700) == 0) return AH_OK;
    if (errno != EEXIST) return status_from_errno(errno);
    /* Já existe (ou outro processo criou agora): tem de ser diretório. */
    if (stat(p, &stbuf) != 0) return status_from_errno(errno);
    return S_ISDIR(stbuf.st_mode) ? AH_OK : AH_ERR_IO;
}

ah_status ah_platform_fs_mkdirs(const char *path) {
    char *norm = NULL;
    size_t root = 0, len, k;
    ah_status st = AH_OK;

    if (path == NULL || path[0] == '\0') return AH_ERR_INVALID;
    st = ah_platform_fs_normalize_ex(path, &norm, &root);
    if (st != AH_OK) return st;

    len = strlen(norm);
    for (k = root; k <= len && st == AH_OK; k++) {
        char saved;
        if (k < len && norm[k] != '/') continue;
        if (k == root) continue;
        saved = norm[k];
        norm[k] = '\0';
        st = mkdir_one(norm);
        norm[k] = saved;
    }
    free(norm);
    return st;
}

/* ------------------------------------------------------------------------ */
/* Escrita atômica                                                           */
/* ------------------------------------------------------------------------ */

static unsigned long long tmp_nonce(unsigned attempt, const void *salt) {
    struct timespec ts;
    unsigned long long v = 0;

    if (clock_gettime(CLOCK_REALTIME, &ts) == 0) {
        v = (unsigned long long)ts.tv_sec * 1000000000ull +
            (unsigned long long)ts.tv_nsec;
    }
    /* O endereço de uma variável de pilha diferencia threads; a colisão
     * restante é resolvida pela criação exclusiva (O_EXCL) com nova
     * tentativa. */
    v ^= (unsigned long long)(uintptr_t)salt << 16;
    v ^= (unsigned long long)attempt * 0x9E3779B97F4A7C15ull;
    return v & 0xFFFFFFFFFFFFull; /* 12 dígitos hex */
}

static ah_status write_all(int fd, const unsigned char *p, size_t len) {
    while (len > 0) {
        size_t chunk = len > 0x40000000u ? 0x40000000u : len;
        ssize_t n = write(fd, p, chunk);
        if (n < 0) {
            if (errno == EINTR) continue;
            return status_from_errno(errno);
        }
        if (n == 0) return AH_ERR_IO;
        p += (size_t)n;
        len -= (size_t)n;
    }
    return AH_OK;
}

/* fsync da pasta, para o rename sobreviver a queda de energia. Melhor
 * esforço: o rename já aconteceu, e devolver erro aqui faria o chamador
 * achar que o conteúdo antigo continua lá. */
static void sync_dir(const char *dir) {
    int fd = open(dir, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (fd < 0) return;
    (void)fsync(fd);
    (void)close(fd);
}

ah_status ah_platform_fs_write_atomic(const char *path, const void *data,
                                      size_t len, unsigned flags) {
    char *norm = NULL, *dir = NULL, *tmp = NULL;
    int fd = -1;
    int is_private;
    unsigned attempt;
    ah_status st = AH_OK;

    if (path == NULL || path[0] == '\0' || (data == NULL && len > 0) ||
        (flags & ~(unsigned)AH_PLATFORM_FS_PRIVATE) != 0) {
        return AH_ERR_INVALID;
    }
    is_private = (flags & AH_PLATFORM_FS_PRIVATE) != 0;

    /* Tudo (pasta pai, temporário e destino) sai do MESMO caminho
     * normalizado: "x/../y/f" cria y e grava y/f, sem depender de x. */
    st = ah_platform_path_normalize(path, &norm);
    if (st != AH_OK) return st;
    st = ah_platform_fs_dirname(norm, &dir);
    if (st == AH_OK) st = ah_platform_fs_mkdirs(dir);
    if (st != AH_OK) {
        free(dir);
        free(norm);
        return st;
    }

    for (attempt = 0; attempt < TMP_NAME_ATTEMPTS; attempt++) {
        st = ah_platform_fs_tmp_name(norm, (unsigned long)getpid(),
                                     tmp_nonce(attempt, &fd), &tmp);
        if (st != AH_OK) break;
        /* O_EXCL = flag `wx` do TS; O_NOFOLLOW recusa um link plantado no
         * nome do temporário. Privado nasce 0600 (não depende da umask). */
        fd = open(tmp, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
                  is_private ? 0600 : 0666);
        if (fd >= 0) break;
        if (errno != EEXIST) {
            st = status_from_errno(errno);
            free(tmp);
            tmp = NULL;
            break;
        }
        free(tmp);
        tmp = NULL;
        st = AH_ERR_IO;
    }
    if (fd < 0) {
        free(dir);
        free(norm);
        return st == AH_OK ? AH_ERR_IO : st;
    }

    if (is_private && fchmod(fd, 0600) != 0) st = status_from_errno(errno);
    if (st == AH_OK) st = write_all(fd, data, len);
    if (st == AH_OK && fsync(fd) != 0) st = status_from_errno(errno);
    if (close(fd) != 0 && st == AH_OK) st = status_from_errno(errno);
    if (st == AH_OK && rename(tmp, norm) != 0) st = status_from_errno(errno);
    if (st != AH_OK) {
        (void)unlink(tmp); /* melhor esforço: o erro original é o que vale */
    } else {
        sync_dir(dir);
    }

    free(tmp);
    free(dir);
    free(norm);
    return st;
}

/* ------------------------------------------------------------------------ */
/* Leitura                                                                   */
/* ------------------------------------------------------------------------ */

ah_status ah_platform_fs_read_all(const char *path, size_t max_bytes,
                                  char **out, size_t *out_len) {
    struct stat stbuf;
    char *buf = NULL;
    size_t cap, used = 0;
    int fd;
    ah_status st = AH_OK;

    if (out != NULL) *out = NULL;
    if (out_len != NULL) *out_len = 0;
    if (path == NULL || out == NULL || out_len == NULL) return AH_ERR_INVALID;
    if (max_bytes > SIZE_MAX - 2) return AH_ERR_INVALID;

    /* O_NONBLOCK: abrir um FIFO para leitura bloquearia até aparecer um
     * escritor. Em arquivo regular a flag não muda nada. */
    do {
        fd = open(path, O_RDONLY | O_CLOEXEC | O_NONBLOCK);
    } while (fd < 0 && errno == EINTR);
    if (fd < 0) return status_from_errno(errno);

    if (fstat(fd, &stbuf) != 0) {
        st = status_from_errno(errno);
        (void)close(fd);
        return st;
    }
    /* Só arquivo regular: diretório, FIFO, socket e dispositivo não têm
     * "conteúdo inteiro" com teto confiável. */
    if (!S_ISREG(stbuf.st_mode)) {
        (void)close(fd);
        return AH_ERR_INVALID;
    }
    if (stbuf.st_size < 0 ||
        (unsigned long long)stbuf.st_size > (unsigned long long)max_bytes) {
        (void)close(fd);
        return AH_ERR_LIMIT;
    }
    /* O tamanho é só a dica inicial: o arquivo pode crescer durante a
     * leitura (ou ser especial, com st_size 0), e o teto vale para o que de
     * fato foi lido. */
    cap = (size_t)stbuf.st_size + 1;
    buf = malloc(cap + 1);
    if (buf == NULL) {
        (void)close(fd);
        return AH_ERR_NOMEM;
    }
    for (;;) {
        ssize_t n;
        size_t want;
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
        want = cap - used > 0x40000000u ? 0x40000000u : cap - used;
        n = read(fd, buf + used, want);
        if (n < 0) {
            if (errno == EINTR) continue;
            st = status_from_errno(errno);
            break;
        }
        if (n == 0) break;
        used += (size_t)n;
        if (used > max_bytes) {
            st = AH_ERR_LIMIT;
            break;
        }
    }
    (void)close(fd);
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

ah_status ah_platform_fs_restrict(const char *path) {
    struct stat stbuf;
    int fd;
    ah_status st = AH_OK;

    if (path == NULL || path[0] == '\0') return AH_ERR_INVALID;
    /* O_NOFOLLOW + fchmod: o modo vai para o objeto aberto, sem janela para
     * trocar o caminho por um link entre a checagem e o chmod. */
    /* O_NONBLOCK: um FIFO no caminho não pode travar o open. */
    do {
        fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
    } while (fd < 0 && errno == EINTR);
    if (fd < 0) {
        return errno == ELOOP ? AH_ERR_INVALID : status_from_errno(errno);
    }
    if (fstat(fd, &stbuf) != 0) {
        st = status_from_errno(errno);
    } else if (!S_ISREG(stbuf.st_mode) && !S_ISDIR(stbuf.st_mode)) {
        st = AH_ERR_INVALID;
    } else if (fchmod(fd, S_ISDIR(stbuf.st_mode) ? 0700 : 0600) != 0) {
        st = status_from_errno(errno);
    }
    (void)close(fd);
    return st;
}

ah_status ah_platform_fs_check_restricted(const char *path, bool *restricted) {
    struct stat stbuf;

    if (restricted != NULL) *restricted = false;
    if (path == NULL || path[0] == '\0' || restricted == NULL) {
        return AH_ERR_INVALID;
    }
    if (lstat(path, &stbuf) != 0) return status_from_errno(errno);
    *restricted = (S_ISREG(stbuf.st_mode) || S_ISDIR(stbuf.st_mode)) &&
                  stbuf.st_uid == geteuid() && (stbuf.st_mode & 077) == 0;
    return AH_OK;
}

/* ------------------------------------------------------------------------ */
/* Home                                                                      */
/* ------------------------------------------------------------------------ */

static ah_status dup_str(const char *s, char **out) {
    size_t n = strlen(s);
    char *copy = malloc(n + 1);
    if (copy == NULL) return AH_ERR_NOMEM;
    memcpy(copy, s, n + 1);
    *out = copy;
    return AH_OK;
}

/* Diretório home pelo banco de usuários (fallback de HOME, como o
 * os.homedir do Node). Posse: free(). */
static ah_status passwd_home(char **out) {
    struct passwd pw, *res = NULL;
    long hint = sysconf(_SC_GETPW_R_SIZE_MAX);
    size_t size = hint > 0 ? (size_t)hint : 4096;
    char *buf = NULL;
    int rc = 0;

    *out = NULL;
    for (;;) {
        buf = malloc(size);
        if (buf == NULL) return AH_ERR_NOMEM;
        rc = getpwuid_r(geteuid(), &pw, buf, size, &res);
        if (rc != ERANGE) break;
        free(buf);
        if (size > (size_t)1 << 20) return AH_ERR_LIMIT;
        size *= 2;
    }
    if (rc != 0 || res == NULL || pw.pw_dir == NULL || pw.pw_dir[0] == '\0') {
        free(buf);
        return rc != 0 ? status_from_errno(rc) : AH_ERR_NOT_FOUND;
    }
    {
        ah_status st = dup_str(pw.pw_dir, out);
        free(buf);
        return st;
    }
}

ah_status ah_platform_fs_resolve_home(char **out) {
    const char *v;
    char *home = NULL;
    ah_status st;

    if (out == NULL) return AH_ERR_INVALID;
    *out = NULL;

    v = getenv("AGENTS_HUB_HOME");
    if (v != NULL) {
        if (v[0] == '\0') return AH_ERR_INVALID;
        return dup_str(v, out);
    }

    v = getenv("HOME");
    if (v != NULL && v[0] != '\0') {
        st = dup_str(v, &home);
    } else {
        st = passwd_home(&home);
    }
    if (st != AH_OK) return st;

    st = ah_platform_path_join(home, ".agents-hub", out);
    free(home);
    return st;
}
