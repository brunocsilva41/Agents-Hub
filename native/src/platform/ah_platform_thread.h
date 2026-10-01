/* Threads, mutex e variável de condição (F0-09, plano docs/17).
 *
 * Windows: _beginthreadex, SRWLOCK e CONDITION_VARIABLE. POSIX: pthread.
 * Sem <stdatomic.h> (DA-11): estado compartilhado entre threads é protegido
 * por ah_platform_mutex.
 *
 * Todos os objetos são opacos e alocados no heap: o chamador não depende do
 * tamanho das primitivas do SO. Cada _create tem o _free pareado; liberar NULL
 * é no-op (docs/18 §4). As funções sem retorno de status (lock, unlock,
 * signal, broadcast) exigem ponteiro válido, não NULL. */
#ifndef AH_PLATFORM_THREAD_H
#define AH_PLATFORM_THREAD_H

#include <stdbool.h>
#include <stdint.h>

#include "ah_status.h"

typedef struct ah_platform_thread ah_platform_thread;
typedef struct ah_platform_mutex ah_platform_mutex;
typedef struct ah_platform_cond ah_platform_cond;

/* Função executada pela thread. `arg` é o ponteiro passado a
 * ah_platform_thread_start, sem cópia. */
typedef void (*ah_platform_thread_fn)(void *arg);

/* Inicia uma thread que executa fn(arg). Posse: o chamador é dono de *out e
 * precisa chamar ah_platform_thread_join exatamente uma vez (o join libera).
 * `arg` é emprestado à thread: precisa viver até ela terminar. */
ah_status ah_platform_thread_start(ah_platform_thread_fn fn, void *arg,
                                   ah_platform_thread **out);

/* Espera a thread terminar (bloqueante, sem polling) e libera o objeto.
 * NULL é no-op. Não chame a partir da própria thread. */
ah_status ah_platform_thread_join(ah_platform_thread *thread);

/* Mutex não recursivo. Posse: o chamador libera *out com
 * ah_platform_mutex_free. */
ah_status ah_platform_mutex_create(ah_platform_mutex **out);
/* Libera o mutex. Precisa estar destravado e sem esperas. NULL é no-op. */
void ah_platform_mutex_free(ah_platform_mutex *mutex);
void ah_platform_mutex_lock(ah_platform_mutex *mutex);
void ah_platform_mutex_unlock(ah_platform_mutex *mutex);

/* Variável de condição. Posse: o chamador libera *out com
 * ah_platform_cond_free. */
ah_status ah_platform_cond_create(ah_platform_cond **out);
/* Libera a condição. Não pode haver thread esperando nela. NULL é no-op. */
void ah_platform_cond_free(ah_platform_cond *cond);

/* Espera um sinal. `mutex` precisa estar travado pela thread chamadora; é
 * destravado durante a espera e travado de novo no retorno. Como em toda
 * variável de condição, pode haver despertar espúrio: o chamador confere o
 * predicado num laço. */
ah_status ah_platform_cond_wait(ah_platform_cond *cond, ah_platform_mutex *mutex);

/* Como ah_platform_cond_wait, com teto de `timeout_ms` (relógio monotônico).
 * *timed_out vira true se o teto venceu sem sinal. */
ah_status ah_platform_cond_timedwait(ah_platform_cond *cond, ah_platform_mutex *mutex,
                                     uint32_t timeout_ms, bool *timed_out);

void ah_platform_cond_signal(ah_platform_cond *cond);
void ah_platform_cond_broadcast(ah_platform_cond *cond);

#endif /* AH_PLATFORM_THREAD_H */
