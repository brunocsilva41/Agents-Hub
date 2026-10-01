/* ah_platform_time.h no POSIX (Linux): relógio, CSPRNG, ambiente e usuário.
 * C17 estrito (CMAKE_C_EXTENSIONS OFF) esconde clock_gettime, localtime_r,
 * getpwuid_r e O_CLOEXEC; a macro abaixo os expõe (POSIX.1-2008). */
#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <pwd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#if defined(__linux__)
#include <sys/random.h>
#endif

#include "ah_platform_time.h"

/* ---- Relógio ----------------------------------------------------------- */

ah_status ah_platform_time_now_unix_ms(int64_t *out) {
    struct timespec ts;

    if (out == NULL) {
        return AH_ERR_INVALID;
    }
    if (clock_gettime(CLOCK_REALTIME, &ts) != 0) {
        return AH_ERR_IO;
    }
    *out = (int64_t)ts.tv_sec * 1000 + (int64_t)(ts.tv_nsec / 1000000);
    return AH_OK;
}

ah_status ah_platform_time_local_stamp(char *out, size_t out_size) {
    time_t now;
    struct tm tm;
    int n;

    if (out == NULL || out_size == 0) {
        return AH_ERR_INVALID;
    }
    out[0] = '\0';
    if (out_size < AH_PLATFORM_LOCAL_STAMP_SIZE) {
        return AH_ERR_LIMIT;
    }
    now = time(NULL);
    if (now == (time_t)-1) {
        return AH_ERR_IO;
    }
    /* localtime_r não chama tzset() implicitamente em todas as libc. */
    tzset();
    if (localtime_r(&now, &tm) == NULL) {
        return AH_ERR_IO;
    }
    n = snprintf(out, out_size, "%04d%02d%02d-%02d%02d%02d", tm.tm_year + 1900,
                 tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec);
    if (n != AH_PLATFORM_LOCAL_STAMP_SIZE - 1) {
        out[0] = '\0';
        return AH_ERR_INTERNAL;
    }
    return AH_OK;
}

ah_status ah_platform_time_monotonic_ns(uint64_t *out) {
    struct timespec ts;

    if (out == NULL) {
        return AH_ERR_INVALID;
    }
    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0 || ts.tv_sec < 0) {
        return AH_ERR_IO;
    }
    *out = (uint64_t)ts.tv_sec * UINT64_C(1000000000) + (uint64_t)ts.tv_nsec;
    return AH_OK;
}

/* ---- CSPRNG ------------------------------------------------------------ */

static ah_status read_urandom(unsigned char *p, size_t len) {
    int fd;

    do {
        fd = open("/dev/urandom", O_RDONLY | O_CLOEXEC);
    } while (fd < 0 && errno == EINTR);
    if (fd < 0) {
        return AH_ERR_IO;
    }
    while (len > 0) {
        ssize_t r = read(fd, p, len);
        if (r < 0) {
            if (errno == EINTR) {
                continue;
            }
            close(fd);
            return AH_ERR_IO;
        }
        if (r == 0) {
            close(fd);
            return AH_ERR_IO;
        }
        p += (size_t)r;
        len -= (size_t)r;
    }
    if (close(fd) != 0) {
        return AH_ERR_IO;
    }
    return AH_OK;
}

ah_status ah_platform_random_bytes(void *buf, size_t len) {
    unsigned char *p = (unsigned char *)buf;

    if (buf == NULL && len > 0) {
        return AH_ERR_INVALID;
    }
#if defined(__linux__)
    while (len > 0) {
        /* getrandom devolve no máximo 33554431 bytes por chamada; pedidos de
         * até 256 bytes nunca saem parciais, os maiores podem. */
        ssize_t r = getrandom(p, len, 0);
        if (r < 0) {
            if (errno == EINTR) {
                continue;
            }
            if (errno == ENOSYS) {
                /* Kernel < 3.17: sem a chamada de sistema. */
                return read_urandom(p, len);
            }
            return AH_ERR_IO;
        }
        p += (size_t)r;
        len -= (size_t)r;
    }
    return AH_OK;
#else
    return read_urandom(p, len);
#endif
}

/* ---- Ambiente ---------------------------------------------------------- */

ah_status ah_platform_env_get(const char *name, char **out) {
    const char *v;
    size_t len;
    char *copy;

    if (out == NULL) {
        return AH_ERR_INVALID;
    }
    *out = NULL;
    if (name == NULL || name[0] == '\0' || strchr(name, '=') != NULL) {
        return AH_ERR_INVALID;
    }
    v = getenv(name);
    if (v == NULL) {
        return AH_ERR_NOT_FOUND;
    }
    /* Cópia imediata: o ponteiro do getenv pode ser invalidado por setenv. */
    len = strlen(v);
    copy = (char *)malloc(len + 1);
    if (copy == NULL) {
        return AH_ERR_NOMEM;
    }
    memcpy(copy, v, len + 1);
    *out = copy;
    return AH_OK;
}

/* ---- Usuário do SO ----------------------------------------------------- */

ah_status ah_platform_user_name(char *out, size_t out_size) {
    struct passwd pw;
    struct passwd *res = NULL;
    long hint;
    size_t cap;
    char *buf = NULL;
    ah_status st;
    int rc;

    if (out == NULL || out_size == 0) {
        return AH_ERR_INVALID;
    }
    out[0] = '\0';

    hint = sysconf(_SC_GETPW_R_SIZE_MAX);
    cap = hint > 0 ? (size_t)hint : 1024;
    for (;;) {
        char *grown = (char *)realloc(buf, cap);
        if (grown == NULL) {
            free(buf);
            return AH_ERR_NOMEM;
        }
        buf = grown;
        rc = getpwuid_r(geteuid(), &pw, buf, cap, &res);
        if (rc == EINTR) {
            continue;
        }
        if (rc != ERANGE) {
            break;
        }
        /* Teto de 1 MiB: uma entrada de passwd maior que isso é anomalia. */
        if (cap >= (size_t)1 << 20) {
            free(buf);
            return AH_ERR_LIMIT;
        }
        cap *= 2;
    }

    if (rc != 0) {
        st = AH_ERR_IO;
    } else if (res == NULL || res->pw_name == NULL || res->pw_name[0] == '\0') {
        st = AH_ERR_NOT_FOUND;
    } else {
        size_t len = strlen(res->pw_name);
        if (len >= out_size) {
            st = AH_ERR_LIMIT;
        } else {
            memcpy(out, res->pw_name, len + 1);
            st = AH_OK;
        }
    }
    free(buf);
    return st;
}
