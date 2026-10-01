/* Laço de eventos com sockets, timers e despertar entre threads (F0-09).
 *
 * O laço DORME quando não há trabalho: espera bloqueante em poll() (POSIX) ou
 * WSAPoll() (Windows) com teto igual ao próximo timer, ou sem teto se não há
 * timer. Não há tique periódico nem espera ocupada (meta de CPU parado ≈ 0,
 * ADR 08 / SPEC-06; docs/18 §8).
 *
 * Linha de execução: todas as funções rodam na thread que chama
 * ah_platform_loop_run, EXCETO ah_platform_loop_wake e ah_platform_loop_stop,
 * que podem ser chamadas de qualquer thread. As callbacks rodam na thread do
 * laço e podem registrar, alterar ou remover sockets e timers (inclusive o
 * próprio) e fechar sockets.
 *
 * Escala: cada volta percorre os sockets registrados (O(n)); dimensionado para
 * o serviço local, com algumas centenas de conexões. */
#ifndef AH_PLATFORM_LOOP_H
#define AH_PLATFORM_LOOP_H

#include <stdint.h>

#include "ah_platform_net.h"
#include "ah_status.h"

typedef struct ah_platform_loop ah_platform_loop;
typedef struct ah_platform_timer ah_platform_timer;

/* Callback de socket pronto. `events` combina AH_PLATFORM_IO_READ, _WRITE e
 * _ERROR (ah_platform_net.h). */
typedef void (*ah_platform_io_cb)(ah_platform_loop *loop, ah_platform_socket *sock,
                                  unsigned events, void *ud);
typedef void (*ah_platform_timer_cb)(ah_platform_loop *loop, ah_platform_timer *timer,
                                     void *ud);
/* Chamada na thread do laço depois de um ou mais ah_platform_loop_wake
 * (vários despertares seguidos podem resultar numa única chamada). */
typedef void (*ah_platform_wake_cb)(ah_platform_loop *loop, void *ud);

/* Cria o laço. Posse: o chamador libera *out com ah_platform_loop_free. */
ah_status ah_platform_loop_create(ah_platform_loop **out);

/* Libera o laço. Sockets ainda registrados são só desligados dele (não são
 * fechados: continuam do chamador). Timers ainda existentes continuam do
 * chamador e precisam ser liberados ANTES, com ah_platform_timer_free. NULL é
 * no-op. Não chame de dentro de ah_platform_loop_run. */
void ah_platform_loop_free(ah_platform_loop *loop);

/* Roda até ah_platform_loop_stop. Devolve AH_OK ao parar, ou erro se a espera
 * do SO falhar. */
ah_status ah_platform_loop_run(ah_platform_loop *loop);

/* Pede que ah_platform_loop_run volte (depois da volta corrente). Pode ser
 * chamada de qualquer thread. */
void ah_platform_loop_stop(ah_platform_loop *loop);

/* Acorda o laço e agenda a callback de ah_platform_loop_set_wake_cb. Pode ser
 * chamada de qualquer thread. */
ah_status ah_platform_loop_wake(ah_platform_loop *loop);

/* Define (ou troca, ou remove com NULL) a callback de despertar. Chame antes
 * de iniciar threads que usam ah_platform_loop_wake. `ud` é emprestado. */
void ah_platform_loop_set_wake_cb(ah_platform_loop *loop, ah_platform_wake_cb cb, void *ud);

/* Registra o socket para `events` (AH_PLATFORM_IO_READ e/ou _WRITE) ou, se já
 * registrado neste laço, troca eventos, callback e ud. `events` 0 mantém o
 * registro sem pedir nada (erros ainda são entregues). O socket continua do
 * chamador; ah_platform_socket_close o tira do laço automaticamente. Um socket
 * só pode estar num laço por vez. `ud` é emprestado. */
ah_status ah_platform_loop_watch(ah_platform_loop *loop, ah_platform_socket *sock,
                                 unsigned events, ah_platform_io_cb cb, void *ud);

/* Tira o socket do laço sem fechá-lo. Socket fora do laço: no-op. */
void ah_platform_loop_unwatch(ah_platform_loop *loop, ah_platform_socket *sock);

/* Cria um timer parado ligado ao laço. Posse: o chamador libera *out com
 * ah_platform_timer_free (antes de liberar o laço). `ud` é emprestado. */
ah_status ah_platform_timer_create(ah_platform_loop *loop, ah_platform_timer_cb cb, void *ud,
                                   ah_platform_timer **out);

/* (Re)arma o timer: dispara depois de `delay_ms`; com `period_ms` > 0 repete
 * a cada `period_ms` (periódico), com 0 dispara uma vez (one-shot). Rearmar
 * um timer ativo substitui o agendamento anterior. Relógio monotônico. */
ah_status ah_platform_timer_start(ah_platform_timer *timer, uint64_t delay_ms,
                                  uint64_t period_ms);

/* Desarma o timer (sem liberar). Timer parado: no-op. */
void ah_platform_timer_stop(ah_platform_timer *timer);

/* Desarma e libera o timer. Pode ser chamada dentro da callback dele. NULL é
 * no-op. */
void ah_platform_timer_free(ah_platform_timer *timer);

/* Instante monotônico corrente do laço, em milissegundos (origem arbitrária). */
uint64_t ah_platform_loop_now_ms(void);

#endif /* AH_PLATFORM_LOOP_H */
