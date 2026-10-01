/* ah_platform_time.h no Windows: relógio, CSPRNG, ambiente e usuário. */
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include <bcrypt.h>
#include <lmcons.h>

#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ah_platform_time.h"

/* 1601-01-01 (época do FILETIME) até 1970-01-01, em unidades de 100 ns. */
#define FILETIME_UNIX_EPOCH UINT64_C(116444736000000000)

/* ---- Conversão UTF-8 <-> UTF-16 (privada) -------------------------------
 * Mínima e local a este arquivo: a conversão compartilhada da camada é da
 * F0-05 (ah_platform_fs). Unificar quando as duas tarefas forem mescladas. */

/* Converte `s` (UTF-8, terminado em 0) para UTF-16 alocado. Posse: o
 * chamador libera *out com free. UTF-8 inválido -> AH_ERR_INVALID. */
static ah_status utf8_to_wide(const char *s, wchar_t **out) {
    int n;
    wchar_t *w;

    *out = NULL;
    n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s, -1, NULL, 0);
    if (n <= 0) {
        return GetLastError() == ERROR_NO_UNICODE_TRANSLATION ? AH_ERR_INVALID : AH_ERR_IO;
    }
    w = (wchar_t *)malloc((size_t)n * sizeof *w);
    if (w == NULL) {
        return AH_ERR_NOMEM;
    }
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s, -1, w, n) != n) {
        free(w);
        return AH_ERR_IO;
    }
    *out = w;
    return AH_OK;
}

/* Converte `wlen` unidades UTF-16 de `w` (sem exigir terminador) para UTF-8
 * alocado e terminado em 0. Posse: o chamador libera *out com free. UTF-16
 * inválido (surrogate solto) -> AH_ERR_INVALID. */
static ah_status wide_to_utf8(const wchar_t *w, int wlen, char **out) {
    int n;
    char *s;

    *out = NULL;
    if (wlen == 0) {
        s = (char *)malloc(1);
        if (s == NULL) {
            return AH_ERR_NOMEM;
        }
        s[0] = '\0';
        *out = s;
        return AH_OK;
    }
    n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, w, wlen, NULL, 0, NULL, NULL);
    if (n <= 0) {
        return GetLastError() == ERROR_NO_UNICODE_TRANSLATION ? AH_ERR_INVALID : AH_ERR_IO;
    }
    if (n == INT_MAX) {
        return AH_ERR_LIMIT;
    }
    s = (char *)malloc((size_t)n + 1);
    if (s == NULL) {
        return AH_ERR_NOMEM;
    }
    if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, w, wlen, s, n, NULL, NULL) != n) {
        free(s);
        return AH_ERR_IO;
    }
    s[n] = '\0';
    *out = s;
    return AH_OK;
}

/* ---- Relógio ----------------------------------------------------------- */

ah_status ah_platform_time_now_unix_ms(int64_t *out) {
    FILETIME ft;
    uint64_t t;

    if (out == NULL) {
        return AH_ERR_INVALID;
    }
    /* "Precise" (Windows 8+): resolução sub-µs, em vez dos ~15,6 ms do
     * GetSystemTimeAsFileTime. Não falha. */
    GetSystemTimePreciseAsFileTime(&ft);
    t = ((uint64_t)ft.dwHighDateTime << 32) | ft.dwLowDateTime;
    if (t < FILETIME_UNIX_EPOCH) {
        /* Relógio antes de 1970: fora do que o Hub trata. */
        return AH_ERR_INTERNAL;
    }
    *out = (int64_t)((t - FILETIME_UNIX_EPOCH) / UINT64_C(10000));
    return AH_OK;
}

ah_status ah_platform_time_local_stamp(char *out, size_t out_size) {
    SYSTEMTIME st;
    int n;

    if (out == NULL || out_size == 0) {
        return AH_ERR_INVALID;
    }
    out[0] = '\0';
    if (out_size < AH_PLATFORM_LOCAL_STAMP_SIZE) {
        return AH_ERR_LIMIT;
    }
    GetLocalTime(&st);
    n = snprintf(out, out_size, "%04d%02d%02d-%02d%02d%02d", (int)st.wYear,
                 (int)st.wMonth, (int)st.wDay, (int)st.wHour, (int)st.wMinute,
                 (int)st.wSecond);
    if (n != AH_PLATFORM_LOCAL_STAMP_SIZE - 1) {
        out[0] = '\0';
        return AH_ERR_INTERNAL;
    }
    return AH_OK;
}

ah_status ah_platform_time_monotonic_ns(uint64_t *out) {
    LARGE_INTEGER freq, count;
    uint64_t f, c;

    if (out == NULL) {
        return AH_ERR_INVALID;
    }
    if (!QueryPerformanceFrequency(&freq) || !QueryPerformanceCounter(&count) ||
        freq.QuadPart <= 0 || count.QuadPart < 0) {
        return AH_ERR_IO;
    }
    f = (uint64_t)freq.QuadPart;
    c = (uint64_t)count.QuadPart;
    /* Parte inteira e resto separados para c * 1e9 não estourar 64 bits. */
    *out = (c / f) * UINT64_C(1000000000) + ((c % f) * UINT64_C(1000000000)) / f;
    return AH_OK;
}

/* ---- CSPRNG ------------------------------------------------------------ */

ah_status ah_platform_random_bytes(void *buf, size_t len) {
    unsigned char *p = (unsigned char *)buf;

    if (buf == NULL && len > 0) {
        return AH_ERR_INVALID;
    }
    while (len > 0) {
        ULONG chunk = len > (size_t)ULONG_MAX ? ULONG_MAX : (ULONG)len;
        NTSTATUS rc = BCryptGenRandom(NULL, p, chunk, BCRYPT_USE_SYSTEM_PREFERRED_RNG);
        if (!BCRYPT_SUCCESS(rc)) {
            return AH_ERR_IO;
        }
        p += chunk;
        len -= chunk;
    }
    return AH_OK;
}

/* ---- Ambiente ---------------------------------------------------------- */

/* Zera e libera um buffer UTF-16 de `n` unidades. Valores de ambiente podem
 * ser segredos (chaves de API do agente): a cópia temporária não fica no
 * heap. Laço volátil para o compilador não remover a limpeza antes do free. */
static void free_zeroed(wchar_t *p, DWORD n) {
    volatile wchar_t *v = p;
    DWORD i;

    if (p == NULL) {
        return;
    }
    for (i = 0; i < n; i++) {
        v[i] = 0;
    }
    free(p);
}

ah_status ah_platform_env_get(const char *name, char **out) {
    wchar_t *wname = NULL;
    wchar_t *val = NULL;
    DWORD val_cap = 0;
    DWORD cap = 256;
    ah_status st;
    int tries;

    if (out == NULL) {
        return AH_ERR_INVALID;
    }
    *out = NULL;
    if (name == NULL || name[0] == '\0' || strchr(name, '=') != NULL) {
        return AH_ERR_INVALID;
    }
    st = utf8_to_wide(name, &wname);
    if (st != AH_OK) {
        return st;
    }

    /* O valor pode crescer entre a consulta do tamanho e a leitura (outra
     * thread mexendo no ambiente): tenta de novo algumas vezes. */
    st = AH_ERR_IO;
    for (tries = 0; tries < 4; tries++) {
        DWORD r;

        /* malloc novo em vez de realloc: o realloc poderia deixar no heap uma
         * cópia do valor anterior que não teríamos como zerar. */
        free_zeroed(val, val_cap);
        val_cap = 0;
        val = (wchar_t *)malloc((size_t)cap * sizeof *val);
        if (val == NULL) {
            st = AH_ERR_NOMEM;
            break;
        }
        val_cap = cap;
        SetLastError(ERROR_SUCCESS);
        r = GetEnvironmentVariableW(wname, val, cap);
        if (r == 0) {
            DWORD err = GetLastError();
            if (err == ERROR_ENVVAR_NOT_FOUND) {
                st = AH_ERR_NOT_FOUND;
            } else if (err == ERROR_SUCCESS) {
                st = wide_to_utf8(val, 0, out); /* existe e é vazia */
            } else {
                st = AH_ERR_IO;
            }
            break;
        }
        if (r < cap) {
            /* r = unidades copiadas, sem o terminador. */
            st = wide_to_utf8(val, (int)r, out);
            break;
        }
        /* r = tamanho necessário, com o terminador. */
        cap = r;
        st = AH_ERR_IO;
    }
    free_zeroed(val, val_cap);
    free(wname);
    return st;
}

/* ---- Usuário do SO ----------------------------------------------------- */

ah_status ah_platform_user_name(char *out, size_t out_size) {
    wchar_t wbuf[UNLEN + 1];
    DWORD n = UNLEN + 1;
    char *utf8 = NULL;
    size_t len;
    ah_status st;

    if (out == NULL || out_size == 0) {
        return AH_ERR_INVALID;
    }
    out[0] = '\0';
    if (!GetUserNameW(wbuf, &n)) {
        return AH_ERR_IO;
    }
    /* n inclui o terminador. */
    if (n == 0 || n > UNLEN + 1) {
        return AH_ERR_INTERNAL;
    }
    st = wide_to_utf8(wbuf, (int)(n - 1), &utf8);
    if (st != AH_OK) {
        return st;
    }
    len = strlen(utf8);
    if (len == 0) {
        st = AH_ERR_NOT_FOUND;
    } else if (len >= out_size) {
        st = AH_ERR_LIMIT;
    } else {
        memcpy(out, utf8, len + 1);
    }
    free(utf8);
    return st;
}
