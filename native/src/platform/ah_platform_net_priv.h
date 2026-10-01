/* Partes internas compartilhadas entre ah_platform_net.c e ah_platform_loop.c.
 * Não é interface pública: só arquivos de native/src/platform/ incluem. */
#ifndef AH_PLATFORM_NET_PRIV_H
#define AH_PLATFORM_NET_PRIV_H

#if !defined(_WIN32) && !defined(_POSIX_C_SOURCE)
#define _POSIX_C_SOURCE 200809L
#endif

#include <stddef.h>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
typedef SOCKET ah_platform_net_fd;
typedef WSAPOLLFD ah_platform_net_pollfd;
#define AH_PLATFORM_NET_BAD_FD INVALID_SOCKET
#else
#include <poll.h>
typedef int ah_platform_net_fd;
typedef struct pollfd ah_platform_net_pollfd;
#define AH_PLATFORM_NET_BAD_FD (-1)
#endif

#include "ah_platform_net.h"

struct ah_platform_loop;

struct ah_platform_socket {
    ah_platform_net_fd fd;
    /* Laço em que o socket está registrado (NULL se nenhum) e posição do
     * registro; mantidos por ah_platform_loop.c. */
    struct ah_platform_loop *loop;
    size_t watch_idx;
};

/* Garante a inicialização do Winsock (uma vez por processo); no POSIX não
 * faz nada. */
ah_status ah_platform_net_init_os(void);

/* Envolve um descritor nativo já aberto num ah_platform_socket. Em falha,
 * fecha o descritor. */
ah_status ah_platform_net_wrap_fd(ah_platform_net_fd fd, ah_platform_socket **out);

/* Põe o descritor em modo não bloqueante. */
ah_status ah_platform_net_set_nonblocking_fd(ah_platform_net_fd fd);

/* poll() / WSAPoll() com o mesmo contrato: devolve o número de prontos, 0 no
 * teto ou -1 em erro. */
int ah_platform_net_poll_fds(ah_platform_net_pollfd *fds, size_t n, int timeout_ms);

/* Par de sockets conectados, ambos não bloqueantes e não herdáveis. Usado
 * para acordar o laço a partir de outra thread. */
ah_status ah_platform_net_socketpair_fds(ah_platform_net_fd *a, ah_platform_net_fd *b);

void ah_platform_net_close_fd(ah_platform_net_fd fd);

/* Chamado por ah_platform_socket_close para tirar o socket do laço. */
void ah_platform_loop_forget_socket(struct ah_platform_loop *loop, ah_platform_socket *sock);

#endif /* AH_PLATFORM_NET_PRIV_H */
