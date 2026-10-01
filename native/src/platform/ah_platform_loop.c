/* Laço de eventos, timers e despertar entre threads (F0-09).
 * Ver ah_platform_loop.h. */
#include "ah_platform_net_priv.h"

#include <limits.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

#include "ah_platform_loop.h"
#include "ah_platform_thread.h"

#ifdef _WIN32
#include <windows.h>
#else
#include <sys/socket.h>
#include <sys/types.h>
#include <time.h>
#endif

struct watch {
    ah_platform_socket *sock; /* NULL = registro removido, aguardando compactação */
    unsigned events;
    ah_platform_io_cb cb;
    void *ud;
};

struct ah_platform_timer {
    ah_platform_loop *loop;
    ah_platform_timer_cb cb;
    void *ud;
    uint64_t deadline;
    uint64_t period;
    uint64_t seq; /* desempate: mesmo prazo dispara na ordem em que foi armado */
    size_t heap_idx;
    bool active;
};

struct ah_platform_loop {
    /* Par para acordar o laço: lê-se em wake_r (no poll), escreve-se em wake_w. */
    ah_platform_net_fd wake_r;
    ah_platform_net_fd wake_w;

    /* Protegidos por mu (tocados por outras threads). */
    ah_platform_mutex *mu;
    bool stop_req;
    bool byte_pending; /* já há um byte no par: não precisa de outro */
    bool wake_cb_pending;

    ah_platform_wake_cb wake_cb;
    void *wake_ud;

    struct watch *watches;
    size_t nwatch;
    size_t capwatch;
    bool has_dead;

    /* Montados a cada volta: pfds[0] é o par de despertar; pfds[k] (k >= 1)
     * corresponde a watches[pmap[k]]. */
    ah_platform_net_pollfd *pfds;
    size_t *pmap;
    size_t cappoll;

    ah_platform_timer **heap;
    size_t nheap;
    size_t capheap;
    uint64_t next_seq;
};

/* ---------------------------------------------------------------------------
 * Relógio monotônico
 * ------------------------------------------------------------------------- */

uint64_t ah_platform_loop_now_ms(void) {
#ifdef _WIN32
    LARGE_INTEGER c, f;
    uint64_t cnt, freq;
    /* QueryPerformanceCounter/Frequency não falham do Windows XP em diante. */
    QueryPerformanceCounter(&c);
    QueryPerformanceFrequency(&f);
    cnt = (uint64_t)c.QuadPart;
    freq = (uint64_t)f.QuadPart;
    /* Separado em quociente e resto para não estourar 64 bits. */
    return (cnt / freq) * 1000u + ((cnt % freq) * 1000u) / freq;
#else
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) {
        return 0;
    }
    return (uint64_t)ts.tv_sec * 1000u + (uint64_t)ts.tv_nsec / 1000000u;
#endif
}

/* ---------------------------------------------------------------------------
 * Heap de timers (mínimo por prazo, depois por seq)
 * ------------------------------------------------------------------------- */

static bool timer_before(const ah_platform_timer *a, const ah_platform_timer *b) {
    if (a->deadline != b->deadline) {
        return a->deadline < b->deadline;
    }
    return a->seq < b->seq;
}

static void heap_set(ah_platform_loop *loop, size_t i, ah_platform_timer *t) {
    loop->heap[i] = t;
    t->heap_idx = i;
}

static void heap_up(ah_platform_loop *loop, size_t i) {
    ah_platform_timer *t = loop->heap[i];
    while (i > 0) {
        size_t parent = (i - 1) / 2;
        if (!timer_before(t, loop->heap[parent])) {
            break;
        }
        heap_set(loop, i, loop->heap[parent]);
        i = parent;
    }
    heap_set(loop, i, t);
}

static void heap_down(ah_platform_loop *loop, size_t i) {
    ah_platform_timer *t = loop->heap[i];
    for (;;) {
        size_t l = 2 * i + 1;
        size_t r = l + 1;
        size_t m = i;
        const ah_platform_timer *best = t;
        if (l < loop->nheap && timer_before(loop->heap[l], best)) {
            m = l;
            best = loop->heap[l];
        }
        if (r < loop->nheap && timer_before(loop->heap[r], best)) {
            m = r;
        }
        if (m == i) {
            break;
        }
        heap_set(loop, i, loop->heap[m]);
        i = m;
    }
    heap_set(loop, i, t);
}

static ah_status heap_push(ah_platform_loop *loop, ah_platform_timer *t) {
    if (loop->nheap == loop->capheap) {
        size_t cap = loop->capheap ? loop->capheap * 2 : 16;
        ah_platform_timer **h;
        if (cap > SIZE_MAX / sizeof *h) {
            return AH_ERR_LIMIT;
        }
        h = realloc(loop->heap, cap * sizeof *h);
        if (h == NULL) {
            return AH_ERR_NOMEM;
        }
        loop->heap = h;
        loop->capheap = cap;
    }
    heap_set(loop, loop->nheap, t);
    loop->nheap++;
    heap_up(loop, loop->nheap - 1);
    t->active = true;
    return AH_OK;
}

static void heap_remove(ah_platform_loop *loop, ah_platform_timer *t) {
    size_t i = t->heap_idx;
    loop->nheap--;
    if (i != loop->nheap) {
        /* O último item ocupa o buraco e pode precisar descer ou subir. */
        ah_platform_timer *moved = loop->heap[loop->nheap];
        heap_set(loop, i, moved);
        heap_down(loop, i);
        heap_up(loop, moved->heap_idx);
    }
    t->active = false;
}

/* ---------------------------------------------------------------------------
 * Timers
 * ------------------------------------------------------------------------- */

ah_status ah_platform_timer_create(ah_platform_loop *loop, ah_platform_timer_cb cb, void *ud,
                                   ah_platform_timer **out) {
    ah_platform_timer *t;

    if (loop == NULL || cb == NULL || out == NULL) {
        return AH_ERR_INVALID;
    }
    *out = NULL;
    t = calloc(1, sizeof *t);
    if (t == NULL) {
        return AH_ERR_NOMEM;
    }
    t->loop = loop;
    t->cb = cb;
    t->ud = ud;
    *out = t;
    return AH_OK;
}

ah_status ah_platform_timer_start(ah_platform_timer *timer, uint64_t delay_ms,
                                  uint64_t period_ms) {
    /* Teto para prazo e período: evita estouro em now + delay. */
    const uint64_t max_ms = UINT64_C(1) << 52;
    ah_platform_loop *loop;

    if (timer == NULL || timer->loop == NULL) {
        return AH_ERR_INVALID;
    }
    loop = timer->loop;
    if (timer->active) {
        heap_remove(loop, timer);
    }
    if (delay_ms > max_ms) {
        delay_ms = max_ms;
    }
    if (period_ms > max_ms) {
        period_ms = max_ms;
    }
    timer->deadline = ah_platform_loop_now_ms() + delay_ms;
    timer->period = period_ms;
    timer->seq = loop->next_seq++;
    return heap_push(loop, timer);
}

void ah_platform_timer_stop(ah_platform_timer *timer) {
    if (timer == NULL || !timer->active) {
        return;
    }
    heap_remove(timer->loop, timer);
}

void ah_platform_timer_free(ah_platform_timer *timer) {
    if (timer == NULL) {
        return;
    }
    ah_platform_timer_stop(timer);
    free(timer);
}

/* Dispara os timers vencidos. O teto `budget` (tamanho do heap na entrada)
 * impede que um timer rearmado com prazo 0 dentro da própria callback prenda
 * o laço nesta volta. */
static void run_timers(ah_platform_loop *loop) {
    uint64_t now = ah_platform_loop_now_ms();
    size_t budget = loop->nheap;

    while (budget > 0 && loop->nheap > 0 && loop->heap[0]->deadline <= now) {
        ah_platform_timer *t = loop->heap[0];
        budget--;
        heap_remove(loop, t);
        if (t->period > 0) {
            /* Sem deriva: o próximo prazo conta do prazo anterior; se o laço
             * atrasou mais de um período, não dispara em rajada. */
            t->deadline += t->period;
            if (t->deadline <= now) {
                t->deadline = now + t->period;
            }
            t->seq = loop->next_seq++;
            if (heap_push(loop, t) != AH_OK) {
                /* Sem memória para crescer o heap é impossível aqui: o heap
                 * acabou de perder este mesmo item. */
                t->active = false;
            }
        }
        t->cb(loop, t, t->ud);
    }
}

/* ---------------------------------------------------------------------------
 * Sockets registrados
 * ------------------------------------------------------------------------- */

ah_status ah_platform_loop_watch(ah_platform_loop *loop, ah_platform_socket *sock,
                                 unsigned events, ah_platform_io_cb cb, void *ud) {
    struct watch *w;

    if (loop == NULL || sock == NULL || cb == NULL ||
        (events & ~(unsigned)(AH_PLATFORM_IO_READ | AH_PLATFORM_IO_WRITE)) != 0) {
        return AH_ERR_INVALID;
    }
    if (sock->loop == loop) {
        w = &loop->watches[sock->watch_idx];
        w->events = events;
        w->cb = cb;
        w->ud = ud;
        return AH_OK;
    }
    if (sock->loop != NULL) {
        return AH_ERR_INVALID;
    }
    if (loop->nwatch == loop->capwatch) {
        size_t cap = loop->capwatch ? loop->capwatch * 2 : 16;
        struct watch *nw;
        if (cap > SIZE_MAX / sizeof *nw) {
            return AH_ERR_LIMIT;
        }
        nw = realloc(loop->watches, cap * sizeof *nw);
        if (nw == NULL) {
            return AH_ERR_NOMEM;
        }
        loop->watches = nw;
        loop->capwatch = cap;
    }
    w = &loop->watches[loop->nwatch];
    w->sock = sock;
    w->events = events;
    w->cb = cb;
    w->ud = ud;
    sock->loop = loop;
    sock->watch_idx = loop->nwatch;
    loop->nwatch++;
    return AH_OK;
}

void ah_platform_loop_forget_socket(ah_platform_loop *loop, ah_platform_socket *sock) {
    if (loop == NULL || sock == NULL || sock->loop != loop) {
        return;
    }
    /* Só marca: a callback em andamento pode estar percorrendo o vetor. A
     * compactação acontece antes da próxima espera. */
    loop->watches[sock->watch_idx].sock = NULL;
    loop->has_dead = true;
    sock->loop = NULL;
}

void ah_platform_loop_unwatch(ah_platform_loop *loop, ah_platform_socket *sock) {
    ah_platform_loop_forget_socket(loop, sock);
}

static void compact_watches(ah_platform_loop *loop) {
    size_t i, j = 0;

    if (!loop->has_dead) {
        return;
    }
    for (i = 0; i < loop->nwatch; i++) {
        if (loop->watches[i].sock == NULL) {
            continue;
        }
        if (i != j) {
            loop->watches[j] = loop->watches[i];
            loop->watches[j].sock->watch_idx = j;
        }
        j++;
    }
    loop->nwatch = j;
    loop->has_dead = false;
}

/* Monta pfds/pmap para a espera. Devolve o número de entradas em *n. */
static ah_status build_pollset(ah_platform_loop *loop, size_t *n) {
    size_t i, k = 1;

    if (loop->cappoll < loop->nwatch + 1) {
        size_t cap = loop->nwatch + 1;
        ah_platform_net_pollfd *p;
        size_t *m;
        if (cap > SIZE_MAX / sizeof *p || cap > SIZE_MAX / sizeof *m) {
            return AH_ERR_LIMIT;
        }
        p = realloc(loop->pfds, cap * sizeof *p);
        if (p == NULL) {
            return AH_ERR_NOMEM;
        }
        loop->pfds = p;
        m = realloc(loop->pmap, cap * sizeof *m);
        if (m == NULL) {
            return AH_ERR_NOMEM;
        }
        loop->pmap = m;
        loop->cappoll = cap;
    }
    memset(&loop->pfds[0], 0, sizeof loop->pfds[0]);
    loop->pfds[0].fd = loop->wake_r;
    loop->pfds[0].events = POLLIN;
    for (i = 0; i < loop->nwatch; i++) {
        const struct watch *w = &loop->watches[i];
        short ev = 0;
        if (w->events & AH_PLATFORM_IO_READ) {
            ev |= POLLIN;
        }
        if (w->events & AH_PLATFORM_IO_WRITE) {
            ev |= POLLOUT;
        }
        /* Sem eventos pedidos, fica fora da espera: o WSAPoll não aceita
         * entrada com events 0 de forma portável entre versões. */
        if (ev == 0) {
            continue;
        }
        memset(&loop->pfds[k], 0, sizeof loop->pfds[k]);
        loop->pfds[k].fd = w->sock->fd;
        loop->pfds[k].events = ev;
        loop->pmap[k] = i;
        k++;
    }
    *n = k;
    return AH_OK;
}

static void dispatch_io(ah_platform_loop *loop, size_t n) {
    size_t k;

    for (k = 1; k < n; k++) {
        short re = loop->pfds[k].revents;
        size_t i = loop->pmap[k];
        struct watch w;
        unsigned ev = 0;

        if (re == 0) {
            continue;
        }
        /* Cópia: a callback anterior pode ter realocado o vetor ou removido
         * este registro. */
        w = loop->watches[i];
        if (w.sock == NULL) {
            continue;
        }
        if (re & POLLIN) {
            ev |= AH_PLATFORM_IO_READ;
        }
        if (re & POLLOUT) {
            ev |= AH_PLATFORM_IO_WRITE;
        }
        if (re & POLLHUP) {
            /* Queda: quem lê vê o fim de fluxo; quem não lê precisa saber
             * por ERROR, senão o poll voltaria sem parar. */
            ev |= (w.events & AH_PLATFORM_IO_READ) ? AH_PLATFORM_IO_READ : AH_PLATFORM_IO_ERROR;
        }
        if (re & (POLLERR | POLLNVAL)) {
            ev |= AH_PLATFORM_IO_ERROR;
        }
        ev &= w.events | AH_PLATFORM_IO_ERROR;
        if (ev != 0) {
            w.cb(loop, w.sock, ev, w.ud);
        }
    }
}

/* ---------------------------------------------------------------------------
 * Despertar e parada entre threads
 * ------------------------------------------------------------------------- */

/* Com mu travado: garante um byte no par para tirar o laço da espera. */
static void kick_locked(ah_platform_loop *loop) {
    if (!loop->byte_pending) {
        const char b = 1;
#ifdef _WIN32
        int put = send(loop->wake_w, &b, 1, 0);
#elif defined(MSG_NOSIGNAL)
        ssize_t put = send(loop->wake_w, &b, 1, MSG_NOSIGNAL);
#else
        ssize_t put = send(loop->wake_w, &b, 1, 0);
#endif
        /* Falha por buffer cheio significa que já há bytes lá: o laço vai
         * acordar do mesmo jeito. */
        loop->byte_pending = put == 1;
    }
}

ah_status ah_platform_loop_wake(ah_platform_loop *loop) {
    if (loop == NULL) {
        return AH_ERR_INVALID;
    }
    ah_platform_mutex_lock(loop->mu);
    loop->wake_cb_pending = true;
    kick_locked(loop);
    ah_platform_mutex_unlock(loop->mu);
    return AH_OK;
}

void ah_platform_loop_stop(ah_platform_loop *loop) {
    if (loop == NULL) {
        return;
    }
    ah_platform_mutex_lock(loop->mu);
    loop->stop_req = true;
    kick_locked(loop);
    ah_platform_mutex_unlock(loop->mu);
}

void ah_platform_loop_set_wake_cb(ah_platform_loop *loop, ah_platform_wake_cb cb, void *ud) {
    if (loop == NULL) {
        return;
    }
    ah_platform_mutex_lock(loop->mu);
    loop->wake_cb = cb;
    loop->wake_ud = ud;
    ah_platform_mutex_unlock(loop->mu);
}

static void handle_wake(ah_platform_loop *loop) {
    char buf[64];
    bool call;
    ah_platform_wake_cb cb;
    void *ud;

    /* Esvazia o par ANTES de limpar byte_pending: um wake concorrente depois
     * do esvaziamento escreve um byte novo e acorda a próxima espera. */
    for (;;) {
#ifdef _WIN32
        int got = recv(loop->wake_r, buf, (int)sizeof buf, 0);
#else
        ssize_t got = recv(loop->wake_r, buf, sizeof buf, 0);
#endif
        if (got <= 0) {
            break;
        }
    }
    ah_platform_mutex_lock(loop->mu);
    loop->byte_pending = false;
    call = loop->wake_cb_pending;
    loop->wake_cb_pending = false;
    cb = loop->wake_cb;
    ud = loop->wake_ud;
    ah_platform_mutex_unlock(loop->mu);
    if (call && cb != NULL) {
        cb(loop, ud);
    }
}

static bool stop_requested(ah_platform_loop *loop) {
    bool s;
    ah_platform_mutex_lock(loop->mu);
    s = loop->stop_req;
    ah_platform_mutex_unlock(loop->mu);
    return s;
}

/* ---------------------------------------------------------------------------
 * Ciclo de vida e execução
 * ------------------------------------------------------------------------- */

ah_status ah_platform_loop_create(ah_platform_loop **out) {
    ah_platform_loop *loop;
    ah_status st;

    if (out == NULL) {
        return AH_ERR_INVALID;
    }
    *out = NULL;
    loop = calloc(1, sizeof *loop);
    if (loop == NULL) {
        return AH_ERR_NOMEM;
    }
    loop->wake_r = AH_PLATFORM_NET_BAD_FD;
    loop->wake_w = AH_PLATFORM_NET_BAD_FD;
    st = ah_platform_mutex_create(&loop->mu);
    if (st != AH_OK) {
        free(loop);
        return st;
    }
    st = ah_platform_net_socketpair_fds(&loop->wake_r, &loop->wake_w);
    if (st != AH_OK) {
        ah_platform_mutex_free(loop->mu);
        free(loop);
        return st;
    }
    *out = loop;
    return AH_OK;
}

void ah_platform_loop_free(ah_platform_loop *loop) {
    size_t i;

    if (loop == NULL) {
        return;
    }
    for (i = 0; i < loop->nwatch; i++) {
        if (loop->watches[i].sock != NULL) {
            loop->watches[i].sock->loop = NULL;
        }
    }
    /* Timers ainda armados ficam desarmados, para que um
     * ah_platform_timer_free posterior não toque no laço liberado. */
    for (i = 0; i < loop->nheap; i++) {
        loop->heap[i]->active = false;
    }
    ah_platform_net_close_fd(loop->wake_r);
    ah_platform_net_close_fd(loop->wake_w);
    ah_platform_mutex_free(loop->mu);
    free(loop->watches);
    free(loop->pfds);
    free(loop->pmap);
    free(loop->heap);
    free(loop);
}

/* Teto da espera: até o próximo timer, ou -1 (sem teto) se não há timer. */
static int next_timeout(const ah_platform_loop *loop) {
    uint64_t now, d;

    if (loop->nheap == 0) {
        return -1;
    }
    now = ah_platform_loop_now_ms();
    d = loop->heap[0]->deadline;
    if (d <= now) {
        return 0;
    }
    /* +1: o relógio do SO arredonda a espera para baixo em alguns casos, e
     * acordar 1 ms antes do prazo custaria uma volta extra sem trabalho. */
    d = d - now + 1u;
    return d > (uint64_t)INT_MAX ? INT_MAX : (int)d;
}

ah_status ah_platform_loop_run(ah_platform_loop *loop) {
    ah_status st = AH_OK;

    if (loop == NULL) {
        return AH_ERR_INVALID;
    }
    while (!stop_requested(loop)) {
        size_t n = 0;
        int rc;

        compact_watches(loop);
        st = build_pollset(loop, &n);
        if (st != AH_OK) {
            break;
        }
        rc = ah_platform_net_poll_fds(loop->pfds, n, next_timeout(loop));
        if (rc < 0) {
            st = AH_ERR_IO;
            break;
        }
        if (rc > 0) {
            dispatch_io(loop, n);
            if (loop->pfds[0].revents != 0) {
                handle_wake(loop);
            }
        }
        run_timers(loop);
    }
    /* O pedido de parada é consumido: um novo run volta a rodar. */
    ah_platform_mutex_lock(loop->mu);
    loop->stop_req = false;
    ah_platform_mutex_unlock(loop->mu);
    return st;
}
