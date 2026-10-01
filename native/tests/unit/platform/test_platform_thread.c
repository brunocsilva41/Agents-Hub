/* Testes de ah_platform_thread (F0-09): thread, mutex e variável de condição
 * (produtor/consumidor e espera com teto). */
#include <stdbool.h>
#include <stdint.h>

#include "ah_platform_loop.h"
#include "ah_platform_thread.h"
#include "ah_test.h"

#define ITEMS 2000
#define QCAP 8

struct queue {
    ah_platform_mutex *mu;
    ah_platform_cond *not_empty;
    ah_platform_cond *not_full;
    int buf[QCAP];
    int head;
    int count;
    long long sum;
};

static void producer(void *arg) {
    struct queue *q = arg;
    int i;
    for (i = 1; i <= ITEMS; i++) {
        ah_platform_mutex_lock(q->mu);
        while (q->count == QCAP) {
            (void)ah_platform_cond_wait(q->not_full, q->mu);
        }
        q->buf[(q->head + q->count) % QCAP] = i;
        q->count++;
        ah_platform_cond_signal(q->not_empty);
        ah_platform_mutex_unlock(q->mu);
    }
}

static void consumer(void *arg) {
    struct queue *q = arg;
    int i;
    for (i = 0; i < ITEMS; i++) {
        int v;
        ah_platform_mutex_lock(q->mu);
        while (q->count == 0) {
            (void)ah_platform_cond_wait(q->not_empty, q->mu);
        }
        v = q->buf[q->head];
        q->head = (q->head + 1) % QCAP;
        q->count--;
        q->sum += v;
        ah_platform_cond_signal(q->not_full);
        ah_platform_mutex_unlock(q->mu);
    }
}

static void test_producer_consumer(void) {
    struct queue q = {0};
    ah_platform_thread *p = NULL, *c = NULL;

    CHECK(ah_platform_mutex_create(&q.mu) == AH_OK);
    CHECK(ah_platform_cond_create(&q.not_empty) == AH_OK);
    CHECK(ah_platform_cond_create(&q.not_full) == AH_OK);
    if (q.mu == NULL || q.not_empty == NULL || q.not_full == NULL) {
        return;
    }
    CHECK(ah_platform_thread_start(consumer, &q, &c) == AH_OK);
    CHECK(ah_platform_thread_start(producer, &q, &p) == AH_OK);
    CHECK(ah_platform_thread_join(p) == AH_OK);
    CHECK(ah_platform_thread_join(c) == AH_OK);
    CHECK(q.count == 0);
    CHECK(q.sum == (long long)ITEMS * (ITEMS + 1) / 2);

    ah_platform_cond_free(q.not_full);
    ah_platform_cond_free(q.not_empty);
    ah_platform_mutex_free(q.mu);
}

static void test_timedwait(void) {
    ah_platform_mutex *mu = NULL;
    ah_platform_cond *cv = NULL;
    bool timed_out = false;
    uint64_t t0, dt;

    CHECK(ah_platform_mutex_create(&mu) == AH_OK);
    CHECK(ah_platform_cond_create(&cv) == AH_OK);
    if (mu == NULL || cv == NULL) {
        return;
    }
    ah_platform_mutex_lock(mu);
    t0 = ah_platform_loop_now_ms();
    /* Ninguém sinaliza: o teto vence (despertar espúrio voltaria antes, por
     * isso o laço até o teto). */
    do {
        CHECK(ah_platform_cond_timedwait(cv, mu, 80, &timed_out) == AH_OK);
    } while (!timed_out && ah_platform_loop_now_ms() - t0 < 80);
    dt = ah_platform_loop_now_ms() - t0;
    ah_platform_mutex_unlock(mu);
    CHECK(timed_out);
    /* Folga de 20 ms para a granularidade do relógio do Windows. */
    CHECK(dt >= 60);
    CHECK(dt < 2000);

    ah_platform_cond_free(cv);
    ah_platform_mutex_free(mu);

    /* Liberar NULL é no-op. */
    ah_platform_cond_free(NULL);
    ah_platform_mutex_free(NULL);
    CHECK(ah_platform_thread_join(NULL) == AH_OK);
}

int main(void) {
    test_producer_consumer();
    test_timedwait();
    return AH_TEST_END("test_platform_thread");
}
