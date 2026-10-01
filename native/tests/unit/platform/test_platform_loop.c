/* Testes de ah_platform_loop (F0-09): timers one-shot e periódico (ordem e
 * tempo aproximado), despertar e parada a partir de outra thread, e laço
 * ocioso que dorme (CPU parado ≈ 0, SPEC-06). */
#if !defined(_WIN32) && !defined(_POSIX_C_SOURCE)
#define _POSIX_C_SOURCE 200809L
#endif

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "ah_platform_loop.h"
#include "ah_platform_net.h"
#include "ah_platform_thread.h"
#include "ah_test.h"

/* Tempo de CPU (usuário + núcleo) do processo inteiro, em ms. Medição do
 * próprio teste, não do produto: lê direto do SO. */
#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
static uint64_t process_cpu_ms(void) {
    FILETIME c, e, k, u;
    ULARGE_INTEGER kk, uu;
    if (!GetProcessTimes(GetCurrentProcess(), &c, &e, &k, &u)) {
        return UINT64_MAX;
    }
    kk.LowPart = k.dwLowDateTime;
    kk.HighPart = k.dwHighDateTime;
    uu.LowPart = u.dwLowDateTime;
    uu.HighPart = u.dwHighDateTime;
    return (kk.QuadPart + uu.QuadPart) / 10000u; /* 100 ns -> ms */
}
#else
#include <sys/resource.h>
static uint64_t process_cpu_ms(void) {
    struct rusage r;
    if (getrusage(RUSAGE_SELF, &r) != 0) {
        return UINT64_MAX;
    }
    return (uint64_t)r.ru_utime.tv_sec * 1000u + (uint64_t)r.ru_utime.tv_usec / 1000u +
           (uint64_t)r.ru_stime.tv_sec * 1000u + (uint64_t)r.ru_stime.tv_usec / 1000u;
}
#endif

/* Teto de atraso tolerado para um timer: generoso, porque o CI é lento e a
 * granularidade do relógio do Windows é ~15,6 ms. */
#define LATE_MS 500u

static void on_guard(ah_platform_loop *loop, ah_platform_timer *t, void *ud) {
    bool *fired = ud;
    (void)t;
    *fired = true;
    ah_platform_loop_stop(loop);
}

/* ------------------------------------------------------------------------- */

struct order_ctx {
    uint64_t start;
    int order[8];
    uint64_t at[8];
    int n;
    int periodic_count;
    uint64_t periodic_last;
    bool periodic_done;
};

struct shot {
    struct order_ctx *ctx;
    int id;
};

static void maybe_finish(ah_platform_loop *loop, struct order_ctx *c) {
    if (c->n == 3 && c->periodic_done) {
        ah_platform_loop_stop(loop);
    }
}

static void on_shot(ah_platform_loop *loop, ah_platform_timer *t, void *ud) {
    struct shot *s = ud;
    struct order_ctx *c = s->ctx;
    (void)t;
    if (c->n < 8) {
        c->order[c->n] = s->id;
        c->at[c->n] = ah_platform_loop_now_ms() - c->start;
        c->n++;
    }
    maybe_finish(loop, c);
}

static void on_periodic(ah_platform_loop *loop, ah_platform_timer *t, void *ud) {
    struct order_ctx *c = ud;
    c->periodic_count++;
    c->periodic_last = ah_platform_loop_now_ms() - c->start;
    if (c->periodic_count == 5) {
        /* Liberar o próprio timer dentro da callback é permitido. */
        ah_platform_timer_free(t);
        c->periodic_done = true;
        maybe_finish(loop, c);
    }
}

static void test_timers_order_and_time(void) {
    ah_platform_loop *loop = NULL;
    ah_platform_timer *t[3] = {NULL, NULL, NULL};
    ah_platform_timer *per = NULL, *guard = NULL;
    struct order_ctx c;
    struct shot shots[3];
    const uint64_t delays[3] = {90, 30, 60};
    bool guard_fired = false;
    int i;

    memset(&c, 0, sizeof c);
    CHECK(ah_platform_loop_create(&loop) == AH_OK);
    if (loop == NULL) {
        return;
    }
    c.start = ah_platform_loop_now_ms();
    for (i = 0; i < 3; i++) {
        shots[i].ctx = &c;
        shots[i].id = (int)delays[i];
        CHECK(ah_platform_timer_create(loop, on_shot, &shots[i], &t[i]) == AH_OK);
        CHECK(ah_platform_timer_start(t[i], delays[i], 0) == AH_OK);
    }
    CHECK(ah_platform_timer_create(loop, on_periodic, &c, &per) == AH_OK);
    CHECK(ah_platform_timer_start(per, 20, 20) == AH_OK);
    CHECK(ah_platform_timer_create(loop, on_guard, &guard_fired, &guard) == AH_OK);
    CHECK(ah_platform_timer_start(guard, 5000, 0) == AH_OK);

    CHECK(ah_platform_loop_run(loop) == AH_OK);

    CHECK(!guard_fired);
    CHECK(c.n == 3);
    CHECK(c.order[0] == 30);
    CHECK(c.order[1] == 60);
    CHECK(c.order[2] == 90);
    for (i = 0; i < c.n && i < 3; i++) {
        uint64_t want = (uint64_t)c.order[i];
        if (c.at[i] < want || c.at[i] > want + LATE_MS) {
            fprintf(stderr, "timer %d disparou em %llu ms\n", c.order[i],
                    (unsigned long long)c.at[i]);
        }
        CHECK(c.at[i] >= want);
        CHECK(c.at[i] <= want + LATE_MS);
    }
    /* Periódico: 5 disparos de 20 ms = pelo menos 100 ms. */
    CHECK(c.periodic_count == 5);
    CHECK(c.periodic_last >= 100);
    CHECK(c.periodic_last <= 100 + LATE_MS);

    /* One-shot não dispara de novo: um run a mais, parado pelo guarda curto,
     * não muda a contagem. */
    guard_fired = false;
    CHECK(ah_platform_timer_start(guard, 50, 0) == AH_OK);
    CHECK(ah_platform_loop_run(loop) == AH_OK);
    CHECK(guard_fired);
    CHECK(c.n == 3);
    CHECK(c.periodic_count == 5);

    /* Timer parado não dispara. */
    CHECK(ah_platform_timer_start(t[0], 10, 0) == AH_OK);
    ah_platform_timer_stop(t[0]);
    guard_fired = false;
    CHECK(ah_platform_timer_start(guard, 60, 0) == AH_OK);
    CHECK(ah_platform_loop_run(loop) == AH_OK);
    CHECK(c.n == 3);

    for (i = 0; i < 3; i++) {
        ah_platform_timer_free(t[i]);
    }
    ah_platform_timer_free(guard);
    ah_platform_loop_free(loop);
}

/* ------------------------------------------------------------------------- */

struct wake_ctx {
    ah_platform_loop *loop;
    int wakes;
};

static void on_wake(ah_platform_loop *loop, void *ud) {
    struct wake_ctx *w = ud;
    w->wakes++;
    ah_platform_loop_stop(loop);
}

static void thread_wake(void *arg) {
    struct wake_ctx *w = arg;
    CHECK(ah_platform_loop_wake(w->loop) == AH_OK);
}

static void thread_stop(void *arg) {
    struct wake_ctx *w = arg;
    ah_platform_loop_stop(w->loop);
}

static void test_wake_from_thread(void) {
    ah_platform_loop *loop = NULL;
    ah_platform_timer *guard = NULL;
    ah_platform_thread *th = NULL;
    struct wake_ctx w;
    bool guard_fired = false;
    uint64_t t0, dt;

    CHECK(ah_platform_loop_create(&loop) == AH_OK);
    if (loop == NULL) {
        return;
    }
    w.loop = loop;
    w.wakes = 0;
    ah_platform_loop_set_wake_cb(loop, on_wake, &w);
    CHECK(ah_platform_timer_create(loop, on_guard, &guard_fired, &guard) == AH_OK);
    CHECK(ah_platform_timer_start(guard, 5000, 0) == AH_OK);

    /* Sem o despertar, o laço dormiria até o guarda (5 s). */
    t0 = ah_platform_loop_now_ms();
    CHECK(ah_platform_thread_start(thread_wake, &w, &th) == AH_OK);
    CHECK(ah_platform_loop_run(loop) == AH_OK);
    dt = ah_platform_loop_now_ms() - t0;
    CHECK(ah_platform_thread_join(th) == AH_OK);
    CHECK(!guard_fired);
    CHECK(w.wakes == 1);
    CHECK(dt < 4000);

    /* Parada pedida por outra thread, sem callback de despertar. */
    ah_platform_loop_set_wake_cb(loop, NULL, NULL);
    th = NULL;
    t0 = ah_platform_loop_now_ms();
    CHECK(ah_platform_thread_start(thread_stop, &w, &th) == AH_OK);
    CHECK(ah_platform_loop_run(loop) == AH_OK);
    dt = ah_platform_loop_now_ms() - t0;
    CHECK(ah_platform_thread_join(th) == AH_OK);
    CHECK(!guard_fired);
    CHECK(w.wakes == 1);
    CHECK(dt < 4000);

    ah_platform_timer_free(guard);
    ah_platform_loop_free(loop);
}

/* ------------------------------------------------------------------------- */

static void on_never(ah_platform_loop *loop, ah_platform_socket *s, unsigned ev, void *ud) {
    bool *hit = ud;
    (void)loop;
    (void)s;
    (void)ev;
    *hit = true;
}

static void test_idle_loop_sleeps(void) {
    ah_platform_loop *loop = NULL;
    ah_platform_timer *stop_t = NULL;
    ah_platform_socket *l = NULL;
    bool fired = false, io_hit = false;
    uint64_t cpu0, cpu1, t0, wall;

    CHECK(ah_platform_loop_create(&loop) == AH_OK);
    if (loop == NULL) {
        return;
    }
    /* Um socket escutando sem clientes, como o daemon parado. */
    CHECK(ah_platform_net_listen(0, NULL, &l) == AH_OK);
    CHECK(ah_platform_loop_watch(loop, l, AH_PLATFORM_IO_READ, on_never, &io_hit) == AH_OK);
    CHECK(ah_platform_timer_create(loop, on_guard, &fired, &stop_t) == AH_OK);
    CHECK(ah_platform_timer_start(stop_t, 2000, 0) == AH_OK);

    cpu0 = process_cpu_ms();
    t0 = ah_platform_loop_now_ms();
    CHECK(ah_platform_loop_run(loop) == AH_OK);
    wall = ah_platform_loop_now_ms() - t0;
    cpu1 = process_cpu_ms();

    CHECK(fired);
    CHECK(!io_hit);
    CHECK(cpu0 != UINT64_MAX && cpu1 != UINT64_MAX);
    CHECK(wall >= 1990);
    printf("laco ocioso: %llu ms de parede, %llu ms de CPU\n", (unsigned long long)wall,
           (unsigned long long)(cpu1 - cpu0));
    /* Teto generoso: espera ocupada gastaria ~2000 ms. */
    CHECK(cpu1 - cpu0 < 50);

    ah_platform_timer_free(stop_t);
    ah_platform_socket_close(l);
    ah_platform_loop_free(loop);
}

int main(void) {
    test_timers_order_and_time();
    test_wake_from_thread();
    test_idle_loop_sleeps();
    return AH_TEST_END("test_platform_loop");
}
