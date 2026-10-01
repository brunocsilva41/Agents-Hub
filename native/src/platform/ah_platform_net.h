/* Sockets TCP em loopback (F0-09, plano docs/17).
 *
 * Só IPv4 em 127.0.0.1: o daemon escuta em loopback (SPEC-01 §1) e o cliente
 * fala com ele ali. Todo socket devolvido por este módulo está em modo NÃO
 * bloqueante e não é herdado por processos filhos (SEC-R28).
 *
 * Escuta exclusiva (SPEC-01 §1, "a porta é o lock de instância"; SEC-R14):
 * no Windows com SO_EXCLUSIVEADDRUSE (e nunca SO_REUSEADDR, que lá permite
 * roubar a porta); no POSIX com SO_REUSEADDR (só reaproveita TIME_WAIT no
 * Linux) e sem SO_REUSEPORT. Porta ocupada vira AH_ERR_IO com o detalhe
 * AH_PLATFORM_NET_ADDR_IN_USE.
 *
 * Dono da conexão (SEC-R12/R13, DV-30/DV-31): ah_platform_socket_peer_is_current_user
 * diz se o processo do outro lado da conexão roda como o mesmo usuário do SO
 * que este processo. Windows: GetExtendedTcpTable -> PID -> token -> SID.
 * Linux: coluna uid de /proc/net/tcp.
 *
 * Linha de execução: um socket é usado por uma thread por vez. */
#ifndef AH_PLATFORM_NET_H
#define AH_PLATFORM_NET_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "ah_status.h"

typedef struct ah_platform_socket ah_platform_socket;

/* Detalhe de rede, complementar ao ah_status. Toda função que recebe
 * `ah_platform_net_err *err` aceita NULL quando o detalhe não interessa. */
typedef enum ah_platform_net_err {
    AH_PLATFORM_NET_NONE = 0,
    AH_PLATFORM_NET_WOULD_BLOCK, /* operação não bloqueante sem progresso agora */
    AH_PLATFORM_NET_CLOSED,      /* fim de fluxo ordenado (o outro lado fechou) */
    AH_PLATFORM_NET_ADDR_IN_USE, /* porta ocupada: outra instância já escuta */
    AH_PLATFORM_NET_ADDR_ACCESS, /* porta negada pelo SO (reservada ou exclusiva) */
    AH_PLATFORM_NET_REFUSED,     /* ninguém escutando na porta */
    AH_PLATFORM_NET_TIMEOUT,     /* teto de espera vencido */
    AH_PLATFORM_NET_RESET,       /* conexão derrubada pelo outro lado */
    AH_PLATFORM_NET_OTHER        /* outra falha do SO */
} ah_platform_net_err;

/* Texto curto e estável do detalhe, para log e mensagens. Ponteiro estático,
 * nunca NULL. */
const char *ah_platform_net_err_text(ah_platform_net_err err);

/* Escuta em 127.0.0.1:`port`. `port` 0 deixa o SO escolher; leia a porta real
 * com ah_platform_socket_local_port. Porta ocupada: AH_ERR_IO e *err =
 * AH_PLATFORM_NET_ADDR_IN_USE. Posse: o chamador fecha *out com
 * ah_platform_socket_close. */
ah_status ah_platform_net_listen(uint16_t port, ah_platform_net_err *err,
                                 ah_platform_socket **out);

/* Aceita uma conexão pendente sem bloquear. Sem conexão pendente: AH_OK,
 * *out = NULL e *err = AH_PLATFORM_NET_WOULD_BLOCK. Posse: o chamador fecha
 * *out com ah_platform_socket_close. */
ah_status ah_platform_socket_accept(ah_platform_socket *listener, ah_platform_net_err *err,
                                    ah_platform_socket **out);

/* Conecta a 127.0.0.1:`port`, esperando no máximo `timeout_ms` pelo
 * estabelecimento (espera bloqueante por evento, sem polling). Recusa:
 * AH_ERR_IO com AH_PLATFORM_NET_REFUSED; teto vencido: AH_ERR_IO com
 * AH_PLATFORM_NET_TIMEOUT. No Windows o socket é configurado sem
 * retransmissão de SYN (SIO_TCP_INITIAL_RTO), para a recusa em loopback
 * chegar na hora e não depois de ~2 s; se o SO não aceitar a opção (a
 * chamada falhar), a recusa pode demorar e, com teto curto, sair como
 * TIMEOUT. O socket devolvido fica não bloqueante. Posse: o
 * chamador fecha *out com ah_platform_socket_close. */
ah_status ah_platform_net_connect(uint16_t port, uint32_t timeout_ms,
                                  ah_platform_net_err *err, ah_platform_socket **out);

/* Lê até `cap` bytes sem bloquear. Em AH_OK: *n > 0 com dados (*err NONE),
 * ou *n == 0 com *err WOULD_BLOCK (nada agora) ou CLOSED (fim de fluxo).
 * Falha: AH_ERR_IO com RESET ou OTHER. `buf` é emprestado. */
ah_status ah_platform_socket_read(ah_platform_socket *sock, void *buf, size_t cap,
                                  size_t *n, ah_platform_net_err *err);

/* Escreve até `len` bytes sem bloquear. Em AH_OK, *n é quanto foi aceito
 * (pode ser menor que `len`, ou 0 com *err WOULD_BLOCK). Falha: AH_ERR_IO com
 * RESET ou OTHER. No POSIX não gera SIGPIPE. `buf` é emprestado. */
ah_status ah_platform_socket_write(ah_platform_socket *sock, const void *buf, size_t len,
                                   size_t *n, ah_platform_net_err *err);

/* Eventos de prontidão, usados também pelo laço (ah_platform_loop.h). */
enum {
    AH_PLATFORM_IO_READ = 1u,  /* há dados, conexão a aceitar ou fim de fluxo */
    AH_PLATFORM_IO_WRITE = 2u, /* cabe escrita */
    AH_PLATFORM_IO_ERROR = 4u  /* erro ou queda; só sai em *ready, não se pede */
};

/* Espera bloqueante (sem polling) até o socket ficar pronto para `events`
 * (AH_PLATFORM_IO_READ/WRITE) ou vencer `timeout_ms`; -1 espera sem teto.
 * *ready recebe os eventos prontos (0 se o teto venceu). Para quem usa o
 * socket fora de um laço, como o cliente HTTP. */
ah_status ah_platform_socket_wait(ah_platform_socket *sock, unsigned events, int timeout_ms,
                                  unsigned *ready);

/* Porta local (ordem do host) do socket, ex.: a escolhida pelo SO com port 0. */
ah_status ah_platform_socket_local_port(const ah_platform_socket *sock, uint16_t *port);

/* Diz se o processo do outro lado da conexão TCP em loopback roda como o
 * mesmo usuário do SO que este processo. Serve aos dois lados: no servidor,
 * com o socket aceito (SEC-R12); no cliente, com o socket conectado, antes de
 * mandar segredo (SEC-R13). Em AH_OK, *same diz o resultado. Quando o dono
 * não pode ser determinado (conexão sumiu da tabela do SO, processo de outro
 * usuário inacessível, SO sem suporte) devolve erro e *same = false: o
 * chamador deve RECUSAR em qualquer caso que não seja AH_OK com *same true. */
ah_status ah_platform_socket_peer_is_current_user(const ah_platform_socket *sock, bool *same);

/* Fecha o socket e libera o objeto. Se estiver registrado num laço, sai dele
 * antes. NULL é no-op. */
void ah_platform_socket_close(ah_platform_socket *sock);

#endif /* AH_PLATFORM_NET_H */
