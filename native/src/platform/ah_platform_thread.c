/* Threads, mutex e condição (F0-09). Ver ah_platform_thread.h. */
#if !defined(_WIN32) && !defined(_POSIX_C_SOURCE)
#define _POSIX_C_SOURCE 200809L
#endif

#include "ah_platform_thread.h"

#include <stdlib.h>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <process.h>
#else
#include <errno.h>
#include <pthread.h>
#include <time.h>
#endif

struct ah_platform_thread {
    ah_platform_thread_fn fn;
    void *arg;
#ifdef _WIN32
    HANDLE handle;
#else
    pthread_t handle;
#endif
};

struct ah_platform_mutex {
#ifdef _WIN32
    SRWLOCK lock;
#else
    pthread_mutex_t lock;
#endif
};

struct ah_platform_cond {
#ifdef _WIN32
    CONDITION_VARIABLE cv;
#else
    pthread_cond_t cv;
#endif
};

#ifdef _WIN32
static unsigned __stdcall thread_entry(void *p) {
    ah_platform_thread *t = p;
    t->fn(t->arg);
    return 0;
}
#else
static void *thread_entry(void *p) {
    ah_platform_thread *t = p;
    t->fn(t->arg);
    return NULL;
}
#endif

ah_status ah_platform_thread_start(ah_platform_thread_fn fn, void *arg,
                                   ah_platform_thread **out) {
    ah_platform_thread *t;

    if (fn == NULL || out == NULL) {
        return AH_ERR_INVALID;
    }
    *out = NULL;
    t = calloc(1, sizeof *t);
    if (t == NULL) {
        return AH_ERR_NOMEM;
    }
    t->fn = fn;
    t->arg = arg;
#ifdef _WIN32
    {
        /* _beginthreadex (e não CreateThread) para o CRT preparar o estado
         * por thread que ele mesmo usa. */
        uintptr_t h = _beginthreadex(NULL, 0, thread_entry, t, 0, NULL);
        if (h == 0) {
            free(t);
            return AH_ERR_IO;
        }
        t->handle = (HANDLE)h;
    }
#else
    if (pthread_create(&t->handle, NULL, thread_entry, t) != 0) {
        free(t);
        return AH_ERR_IO;
    }
#endif
    *out = t;
    return AH_OK;
}

ah_status ah_platform_thread_join(ah_platform_thread *thread) {
    ah_status st = AH_OK;

    if (thread == NULL) {
        return AH_OK;
    }
#ifdef _WIN32
    if (WaitForSingleObject(thread->handle, INFINITE) != WAIT_OBJECT_0) {
        st = AH_ERR_IO;
    }
    CloseHandle(thread->handle);
#else
    if (pthread_join(thread->handle, NULL) != 0) {
        st = AH_ERR_IO;
    }
#endif
    free(thread);
    return st;
}

ah_status ah_platform_mutex_create(ah_platform_mutex **out) {
    ah_platform_mutex *m;

    if (out == NULL) {
        return AH_ERR_INVALID;
    }
    *out = NULL;
    m = calloc(1, sizeof *m);
    if (m == NULL) {
        return AH_ERR_NOMEM;
    }
#ifdef _WIN32
    InitializeSRWLock(&m->lock);
#else
    if (pthread_mutex_init(&m->lock, NULL) != 0) {
        free(m);
        return AH_ERR_IO;
    }
#endif
    *out = m;
    return AH_OK;
}

void ah_platform_mutex_free(ah_platform_mutex *mutex) {
    if (mutex == NULL) {
        return;
    }
#ifndef _WIN32
    pthread_mutex_destroy(&mutex->lock);
#endif
    free(mutex);
}

void ah_platform_mutex_lock(ah_platform_mutex *mutex) {
#ifdef _WIN32
    AcquireSRWLockExclusive(&mutex->lock);
#else
    /* Com mutex válido e não recursivo travado uma vez por thread, o
     * pthread_mutex_lock padrão não falha; não há erro a propagar. */
    (void)pthread_mutex_lock(&mutex->lock);
#endif
}

void ah_platform_mutex_unlock(ah_platform_mutex *mutex) {
#ifdef _WIN32
    ReleaseSRWLockExclusive(&mutex->lock);
#else
    (void)pthread_mutex_unlock(&mutex->lock);
#endif
}

ah_status ah_platform_cond_create(ah_platform_cond **out) {
    ah_platform_cond *c;

    if (out == NULL) {
        return AH_ERR_INVALID;
    }
    *out = NULL;
    c = calloc(1, sizeof *c);
    if (c == NULL) {
        return AH_ERR_NOMEM;
    }
#ifdef _WIN32
    InitializeConditionVariable(&c->cv);
#else
    {
        /* Relógio monotônico no timedwait: ajuste do relógio de parede não
         * encurta nem estica a espera. */
        pthread_condattr_t attr;
        if (pthread_condattr_init(&attr) != 0) {
            free(c);
            return AH_ERR_IO;
        }
        if (pthread_condattr_setclock(&attr, CLOCK_MONOTONIC) != 0 ||
            pthread_cond_init(&c->cv, &attr) != 0) {
            pthread_condattr_destroy(&attr);
            free(c);
            return AH_ERR_IO;
        }
        pthread_condattr_destroy(&attr);
    }
#endif
    *out = c;
    return AH_OK;
}

void ah_platform_cond_free(ah_platform_cond *cond) {
    if (cond == NULL) {
        return;
    }
#ifndef _WIN32
    pthread_cond_destroy(&cond->cv);
#endif
    free(cond);
}

ah_status ah_platform_cond_wait(ah_platform_cond *cond, ah_platform_mutex *mutex) {
    if (cond == NULL || mutex == NULL) {
        return AH_ERR_INVALID;
    }
#ifdef _WIN32
    if (!SleepConditionVariableSRW(&cond->cv, &mutex->lock, INFINITE, 0)) {
        return AH_ERR_IO;
    }
#else
    if (pthread_cond_wait(&cond->cv, &mutex->lock) != 0) {
        return AH_ERR_IO;
    }
#endif
    return AH_OK;
}

ah_status ah_platform_cond_timedwait(ah_platform_cond *cond, ah_platform_mutex *mutex,
                                     uint32_t timeout_ms, bool *timed_out) {
    if (cond == NULL || mutex == NULL || timed_out == NULL) {
        return AH_ERR_INVALID;
    }
    *timed_out = false;
#ifdef _WIN32
    /* INFINITE é 0xFFFFFFFF: limita para não virar espera sem fim. */
    if (timeout_ms == INFINITE) {
        timeout_ms = INFINITE - 1;
    }
    if (!SleepConditionVariableSRW(&cond->cv, &mutex->lock, timeout_ms, 0)) {
        if (GetLastError() == ERROR_TIMEOUT) {
            *timed_out = true;
            return AH_OK;
        }
        return AH_ERR_IO;
    }
#else
    {
        struct timespec ts;
        int rc;
        if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) {
            return AH_ERR_IO;
        }
        ts.tv_sec += (time_t)(timeout_ms / 1000u);
        ts.tv_nsec += (long)(timeout_ms % 1000u) * 1000000L;
        if (ts.tv_nsec >= 1000000000L) {
            ts.tv_sec += 1;
            ts.tv_nsec -= 1000000000L;
        }
        rc = pthread_cond_timedwait(&cond->cv, &mutex->lock, &ts);
        if (rc == ETIMEDOUT) {
            *timed_out = true;
            return AH_OK;
        }
        if (rc != 0) {
            return AH_ERR_IO;
        }
    }
#endif
    return AH_OK;
}

void ah_platform_cond_signal(ah_platform_cond *cond) {
#ifdef _WIN32
    WakeConditionVariable(&cond->cv);
#else
    (void)pthread_cond_signal(&cond->cv);
#endif
}

void ah_platform_cond_broadcast(ah_platform_cond *cond) {
#ifdef _WIN32
    WakeAllConditionVariable(&cond->cv);
#else
    (void)pthread_cond_broadcast(&cond->cv);
#endif
}
