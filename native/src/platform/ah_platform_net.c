/* Sockets TCP em loopback e dono da conexão (F0-09). Ver ah_platform_net.h. */
#include "ah_platform_net_priv.h"

#include <limits.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <ws2tcpip.h>
#include <iphlpapi.h>
#include <windows.h>
#else
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdio.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>
#endif

/* ---------------------------------------------------------------------------
 * Erros do SO -> detalhe
 * ------------------------------------------------------------------------- */

static int last_net_error(void) {
#ifdef _WIN32
    return WSAGetLastError();
#else
    return errno;
#endif
}

static ah_platform_net_err map_error(int e) {
#ifdef _WIN32
    switch (e) {
    case WSAEWOULDBLOCK:
    case WSAEINPROGRESS:
        return AH_PLATFORM_NET_WOULD_BLOCK;
    case WSAEADDRINUSE:
        return AH_PLATFORM_NET_ADDR_IN_USE;
    case WSAEACCES:
        return AH_PLATFORM_NET_ADDR_ACCESS;
    case WSAECONNREFUSED:
        return AH_PLATFORM_NET_REFUSED;
    case WSAETIMEDOUT:
        return AH_PLATFORM_NET_TIMEOUT;
    case WSAECONNRESET:
    case WSAECONNABORTED:
    case WSAENETRESET:
    case WSAESHUTDOWN:
        return AH_PLATFORM_NET_RESET;
    default:
        return AH_PLATFORM_NET_OTHER;
    }
#else
    if (e == EAGAIN || e == EWOULDBLOCK || e == EINPROGRESS) {
        return AH_PLATFORM_NET_WOULD_BLOCK;
    }
    switch (e) {
    case EADDRINUSE:
        return AH_PLATFORM_NET_ADDR_IN_USE;
    case EACCES:
        return AH_PLATFORM_NET_ADDR_ACCESS;
    case ECONNREFUSED:
        return AH_PLATFORM_NET_REFUSED;
    case ETIMEDOUT:
        return AH_PLATFORM_NET_TIMEOUT;
    case ECONNRESET:
    case ECONNABORTED:
    case EPIPE:
        return AH_PLATFORM_NET_RESET;
    default:
        return AH_PLATFORM_NET_OTHER;
    }
#endif
}

static void set_err(ah_platform_net_err *err, ah_platform_net_err v) {
    if (err != NULL) {
        *err = v;
    }
}

const char *ah_platform_net_err_text(ah_platform_net_err err) {
    switch (err) {
    case AH_PLATFORM_NET_NONE:
        return "ok";
    case AH_PLATFORM_NET_WOULD_BLOCK:
        return "operacao bloquearia";
    case AH_PLATFORM_NET_CLOSED:
        return "conexao encerrada pelo outro lado";
    case AH_PLATFORM_NET_ADDR_IN_USE:
        return "porta ocupada (outra instancia escutando)";
    case AH_PLATFORM_NET_ADDR_ACCESS:
        return "porta negada pelo sistema (reservada ou em uso exclusivo)";
    case AH_PLATFORM_NET_REFUSED:
        return "conexao recusada (ninguem escutando)";
    case AH_PLATFORM_NET_TIMEOUT:
        return "tempo esgotado";
    case AH_PLATFORM_NET_RESET:
        return "conexao derrubada";
    case AH_PLATFORM_NET_OTHER:
        break;
    }
    return "falha de rede";
}

/* ---------------------------------------------------------------------------
 * Primitivas internas (compartilhadas com ah_platform_loop.c)
 * ------------------------------------------------------------------------- */

#ifdef _WIN32
static INIT_ONCE g_wsa_once = INIT_ONCE_STATIC_INIT;
static int g_wsa_rc = -1;

static BOOL CALLBACK wsa_init_cb(PINIT_ONCE once, PVOID param, PVOID *ctx) {
    WSADATA data;
    (void)once;
    (void)param;
    (void)ctx;
    /* Sem WSACleanup de propósito: o Winsock vive até o fim do processo. */
    g_wsa_rc = WSAStartup(MAKEWORD(2, 2), &data);
    return TRUE;
}
#endif

ah_status ah_platform_net_init_os(void) {
#ifdef _WIN32
    if (!InitOnceExecuteOnce(&g_wsa_once, wsa_init_cb, NULL, NULL) || g_wsa_rc != 0) {
        return AH_ERR_IO;
    }
#endif
    return AH_OK;
}

void ah_platform_net_close_fd(ah_platform_net_fd fd) {
    if (fd == AH_PLATFORM_NET_BAD_FD) {
        return;
    }
#ifdef _WIN32
    closesocket(fd);
#else
    close(fd);
#endif
}

ah_status ah_platform_net_set_nonblocking_fd(ah_platform_net_fd fd) {
#ifdef _WIN32
    u_long on = 1;
    if (ioctlsocket(fd, FIONBIO, &on) != 0) {
        return AH_ERR_IO;
    }
#else
    int fl = fcntl(fd, F_GETFL, 0);
    if (fl < 0 || fcntl(fd, F_SETFL, fl | O_NONBLOCK) < 0) {
        return AH_ERR_IO;
    }
#endif
    return AH_OK;
}

/* Impede que processos filhos herdem o descritor (SEC-R28). */
static ah_status set_no_inherit(ah_platform_net_fd fd) {
#ifdef _WIN32
    if (!SetHandleInformation((HANDLE)fd, HANDLE_FLAG_INHERIT, 0)) {
        return AH_ERR_IO;
    }
#else
    int fl = fcntl(fd, F_GETFD, 0);
    if (fl < 0 || fcntl(fd, F_SETFD, fl | FD_CLOEXEC) < 0) {
        return AH_ERR_IO;
    }
#endif
    return AH_OK;
}

int ah_platform_net_poll_fds(ah_platform_net_pollfd *fds, size_t n, int timeout_ms) {
#ifdef _WIN32
    if (n > ULONG_MAX) {
        return -1;
    }
    return WSAPoll(fds, (ULONG)n, timeout_ms);
#else
    int rc;
    do {
        rc = poll(fds, (nfds_t)n, timeout_ms);
    } while (rc < 0 && errno == EINTR);
    return rc;
#endif
}

/* Socket TCP IPv4 novo, não herdável e não bloqueante. */
static ah_status new_tcp_socket(ah_platform_net_fd *out, ah_platform_net_err *err) {
    ah_platform_net_fd fd;

    *out = AH_PLATFORM_NET_BAD_FD;
    if (ah_platform_net_init_os() != AH_OK) {
        set_err(err, AH_PLATFORM_NET_OTHER);
        return AH_ERR_IO;
    }
#ifdef _WIN32
    fd = WSASocketW(AF_INET, SOCK_STREAM, IPPROTO_TCP, NULL, 0,
                    WSA_FLAG_OVERLAPPED | WSA_FLAG_NO_HANDLE_INHERIT);
#else
    fd = socket(AF_INET, SOCK_STREAM, 0);
#endif
    if (fd == AH_PLATFORM_NET_BAD_FD) {
        set_err(err, map_error(last_net_error()));
        return AH_ERR_IO;
    }
    if (set_no_inherit(fd) != AH_OK || ah_platform_net_set_nonblocking_fd(fd) != AH_OK) {
        set_err(err, map_error(last_net_error()));
        ah_platform_net_close_fd(fd);
        return AH_ERR_IO;
    }
    *out = fd;
    return AH_OK;
}

ah_status ah_platform_net_wrap_fd(ah_platform_net_fd fd, ah_platform_socket **out) {
    ah_platform_socket *s = calloc(1, sizeof *s);
    if (s == NULL) {
        ah_platform_net_close_fd(fd);
        *out = NULL;
        return AH_ERR_NOMEM;
    }
    s->fd = fd;
    s->loop = NULL;
    s->watch_idx = 0;
    *out = s;
    return AH_OK;
}

static void loopback_addr(struct sockaddr_in *sa, uint16_t port) {
    memset(sa, 0, sizeof *sa);
    sa->sin_family = AF_INET;
    sa->sin_port = htons(port);
    sa->sin_addr.s_addr = htonl(INADDR_LOOPBACK);
}

/* Escuta exclusiva em 127.0.0.1:port sobre um descritor já criado. */
static ah_status bind_listen(ah_platform_net_fd fd, uint16_t port, int backlog,
                             ah_platform_net_err *err) {
    struct sockaddr_in sa;
    int on = 1;

#ifdef _WIN32
    /* SEC-R14: sem isto, outro processo com SO_REUSEADDR poderia ligar a
     * mesma porta e receber as conexões destinadas ao daemon. */
    if (setsockopt(fd, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, (const char *)&on, sizeof on) != 0) {
        set_err(err, map_error(last_net_error()));
        return AH_ERR_IO;
    }
#else
    /* No Linux, SO_REUSEADDR só permite religar sobre conexões em TIME_WAIT
     * (reinício rápido do daemon); NÃO permite dois sockets escutando na
     * mesma porta. SO_REUSEPORT, que permitiria, nunca é usado. */
    if (setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, sizeof on) != 0) {
        set_err(err, map_error(last_net_error()));
        return AH_ERR_IO;
    }
#endif
    loopback_addr(&sa, port);
    if (bind(fd, (const struct sockaddr *)&sa, sizeof sa) != 0) {
        set_err(err, map_error(last_net_error()));
        return AH_ERR_IO;
    }
    if (listen(fd, backlog) != 0) {
        set_err(err, map_error(last_net_error()));
        return AH_ERR_IO;
    }
    return AH_OK;
}

/* ---------------------------------------------------------------------------
 * Interface pública
 * ------------------------------------------------------------------------- */

ah_status ah_platform_net_listen(uint16_t port, ah_platform_net_err *err,
                                 ah_platform_socket **out) {
    ah_platform_net_fd fd;
    ah_status st;

    set_err(err, AH_PLATFORM_NET_NONE);
    if (out == NULL) {
        return AH_ERR_INVALID;
    }
    *out = NULL;
    st = new_tcp_socket(&fd, err);
    if (st != AH_OK) {
        return st;
    }
    st = bind_listen(fd, port, SOMAXCONN, err);
    if (st != AH_OK) {
        ah_platform_net_close_fd(fd);
        return st;
    }
    return ah_platform_net_wrap_fd(fd, out);
}

ah_status ah_platform_socket_accept(ah_platform_socket *listener, ah_platform_net_err *err,
                                    ah_platform_socket **out) {
    ah_platform_net_fd fd;

    set_err(err, AH_PLATFORM_NET_NONE);
    if (listener == NULL || out == NULL) {
        return AH_ERR_INVALID;
    }
    *out = NULL;
    for (;;) {
        fd = accept(listener->fd, NULL, NULL);
        if (fd != AH_PLATFORM_NET_BAD_FD) {
            break;
        }
#ifndef _WIN32
        if (errno == EINTR) {
            continue;
        }
        /* Conexão abortada antes do accept: não há o que entregar. */
        if (errno == ECONNABORTED) {
            set_err(err, AH_PLATFORM_NET_WOULD_BLOCK);
            return AH_OK;
        }
#else
        if (WSAGetLastError() == WSAECONNRESET) {
            set_err(err, AH_PLATFORM_NET_WOULD_BLOCK);
            return AH_OK;
        }
#endif
        {
            ah_platform_net_err e = map_error(last_net_error());
            set_err(err, e);
            return e == AH_PLATFORM_NET_WOULD_BLOCK ? AH_OK : AH_ERR_IO;
        }
    }
    /* No Windows o socket aceito herda o modo do que escuta, no Linux não:
     * aplicamos os dois atributos explicitamente nos dois. */
    if (set_no_inherit(fd) != AH_OK || ah_platform_net_set_nonblocking_fd(fd) != AH_OK) {
        set_err(err, map_error(last_net_error()));
        ah_platform_net_close_fd(fd);
        return AH_ERR_IO;
    }
    return ah_platform_net_wrap_fd(fd, out);
}

/* Espera o connect não bloqueante terminar. Devolve 1 pronto, 0 teto, -1 erro. */
static int wait_connect(ah_platform_net_fd fd, uint32_t timeout_ms) {
#ifdef _WIN32
    /* select e não WSAPoll: o WSAPoll de versões antigas do Windows não
     * reporta connect recusado. */
    fd_set wr, ex;
    struct timeval tv;
    int rc;
    FD_ZERO(&wr);
    FD_ZERO(&ex);
    FD_SET(fd, &wr);
    FD_SET(fd, &ex);
    tv.tv_sec = (long)(timeout_ms / 1000u);
    tv.tv_usec = (long)(timeout_ms % 1000u) * 1000L;
    rc = select(0, NULL, &wr, &ex, &tv);
    if (rc == SOCKET_ERROR) {
        return -1;
    }
    return rc > 0 ? 1 : 0;
#else
    struct pollfd p;
    int rc;
    int t = timeout_ms > (uint32_t)INT_MAX ? INT_MAX : (int)timeout_ms;
    p.fd = fd;
    p.events = POLLOUT;
    p.revents = 0;
    rc = ah_platform_net_poll_fds(&p, 1, t);
    if (rc < 0) {
        return -1;
    }
    return rc > 0 ? 1 : 0;
#endif
}

ah_status ah_platform_net_connect(uint16_t port, uint32_t timeout_ms,
                                  ah_platform_net_err *err, ah_platform_socket **out) {
    struct sockaddr_in sa;
    ah_platform_net_fd fd;
    ah_status st;
    int rc;

    set_err(err, AH_PLATFORM_NET_NONE);
    if (out == NULL || port == 0) {
        return AH_ERR_INVALID;
    }
    *out = NULL;
    st = new_tcp_socket(&fd, err);
    if (st != AH_OK) {
        return st;
    }
    loopback_addr(&sa, port);
    rc = connect(fd, (const struct sockaddr *)&sa, sizeof sa);
    if (rc != 0) {
        ah_platform_net_err e = map_error(last_net_error());
        int so_err = 0;
        socklen_t len = (socklen_t)sizeof so_err;
        int w;

        if (e != AH_PLATFORM_NET_WOULD_BLOCK) {
            set_err(err, e);
            ah_platform_net_close_fd(fd);
            return AH_ERR_IO;
        }
        w = wait_connect(fd, timeout_ms);
        if (w <= 0) {
            set_err(err, w == 0 ? AH_PLATFORM_NET_TIMEOUT : map_error(last_net_error()));
            ah_platform_net_close_fd(fd);
            return AH_ERR_IO;
        }
        if (getsockopt(fd, SOL_SOCKET, SO_ERROR, (char *)&so_err, &len) != 0) {
            set_err(err, map_error(last_net_error()));
            ah_platform_net_close_fd(fd);
            return AH_ERR_IO;
        }
        if (so_err != 0) {
            set_err(err, map_error(so_err));
            ah_platform_net_close_fd(fd);
            return AH_ERR_IO;
        }
    }
    return ah_platform_net_wrap_fd(fd, out);
}

ah_status ah_platform_socket_read(ah_platform_socket *sock, void *buf, size_t cap,
                                  size_t *n, ah_platform_net_err *err) {
    set_err(err, AH_PLATFORM_NET_NONE);
    if (sock == NULL || n == NULL || (buf == NULL && cap > 0)) {
        return AH_ERR_INVALID;
    }
    *n = 0;
    if (cap == 0) {
        return AH_OK;
    }
    for (;;) {
#ifdef _WIN32
        int want = cap > (size_t)INT_MAX ? INT_MAX : (int)cap;
        int got = recv(sock->fd, (char *)buf, want, 0);
#else
        ssize_t got = recv(sock->fd, buf, cap, 0);
#endif
        if (got > 0) {
            *n = (size_t)got;
            return AH_OK;
        }
        if (got == 0) {
            set_err(err, AH_PLATFORM_NET_CLOSED);
            return AH_OK;
        }
#ifndef _WIN32
        if (errno == EINTR) {
            continue;
        }
#endif
        {
            ah_platform_net_err e = map_error(last_net_error());
            set_err(err, e);
            return e == AH_PLATFORM_NET_WOULD_BLOCK ? AH_OK : AH_ERR_IO;
        }
    }
}

ah_status ah_platform_socket_write(ah_platform_socket *sock, const void *buf, size_t len,
                                   size_t *n, ah_platform_net_err *err) {
    set_err(err, AH_PLATFORM_NET_NONE);
    if (sock == NULL || n == NULL || (buf == NULL && len > 0)) {
        return AH_ERR_INVALID;
    }
    *n = 0;
    if (len == 0) {
        return AH_OK;
    }
    for (;;) {
#ifdef _WIN32
        int want = len > (size_t)INT_MAX ? INT_MAX : (int)len;
        int put = send(sock->fd, (const char *)buf, want, 0);
#else
#ifdef MSG_NOSIGNAL
        ssize_t put = send(sock->fd, buf, len, MSG_NOSIGNAL);
#else
        ssize_t put = send(sock->fd, buf, len, 0);
#endif
#endif
        if (put >= 0) {
            *n = (size_t)put;
            if (put == 0) {
                set_err(err, AH_PLATFORM_NET_WOULD_BLOCK);
            }
            return AH_OK;
        }
#ifndef _WIN32
        if (errno == EINTR) {
            continue;
        }
#endif
        {
            ah_platform_net_err e = map_error(last_net_error());
            set_err(err, e);
            return e == AH_PLATFORM_NET_WOULD_BLOCK ? AH_OK : AH_ERR_IO;
        }
    }
}

ah_status ah_platform_socket_wait(ah_platform_socket *sock, unsigned events, int timeout_ms,
                                  unsigned *ready) {
    ah_platform_net_pollfd p;
    int rc;

    if (sock == NULL || ready == NULL ||
        (events & (AH_PLATFORM_IO_READ | AH_PLATFORM_IO_WRITE)) == 0) {
        return AH_ERR_INVALID;
    }
    *ready = 0;
    memset(&p, 0, sizeof p);
    p.fd = sock->fd;
    p.events = 0;
    if (events & AH_PLATFORM_IO_READ) {
        p.events |= POLLIN;
    }
    if (events & AH_PLATFORM_IO_WRITE) {
        p.events |= POLLOUT;
    }
    rc = ah_platform_net_poll_fds(&p, 1, timeout_ms < 0 ? -1 : timeout_ms);
    if (rc < 0) {
        return AH_ERR_IO;
    }
    if (rc == 0) {
        return AH_OK;
    }
    if (p.revents & (POLLIN | POLLHUP)) {
        *ready |= AH_PLATFORM_IO_READ;
    }
    if (p.revents & POLLOUT) {
        *ready |= AH_PLATFORM_IO_WRITE;
    }
    if (p.revents & (POLLERR | POLLNVAL)) {
        *ready |= AH_PLATFORM_IO_ERROR;
    }
    return AH_OK;
}

ah_status ah_platform_socket_local_port(const ah_platform_socket *sock, uint16_t *port) {
    struct sockaddr_in sa;
    socklen_t len = (socklen_t)sizeof sa;

    if (sock == NULL || port == NULL) {
        return AH_ERR_INVALID;
    }
    *port = 0;
    memset(&sa, 0, sizeof sa);
    if (getsockname(sock->fd, (struct sockaddr *)&sa, &len) != 0 || sa.sin_family != AF_INET) {
        return AH_ERR_IO;
    }
    *port = ntohs(sa.sin_port);
    return AH_OK;
}

void ah_platform_socket_close(ah_platform_socket *sock) {
    if (sock == NULL) {
        return;
    }
    if (sock->loop != NULL) {
        ah_platform_loop_forget_socket(sock->loop, sock);
    }
    ah_platform_net_close_fd(sock->fd);
    free(sock);
}

/* ---------------------------------------------------------------------------
 * Par de sockets para acordar o laço
 * ------------------------------------------------------------------------- */

ah_status ah_platform_net_socketpair_fds(ah_platform_net_fd *a, ah_platform_net_fd *b) {
    *a = AH_PLATFORM_NET_BAD_FD;
    *b = AH_PLATFORM_NET_BAD_FD;
    if (ah_platform_net_init_os() != AH_OK) {
        return AH_ERR_IO;
    }
#ifdef _WIN32
    {
        /* O Windows não tem socketpair: liga um par por loopback. Outro
         * processo pode conectar no escutador temporário antes de nós; por
         * isso só aceitamos a conexão cujo endereço de origem é o do nosso
         * próprio cliente. */
        ah_platform_net_fd lst = AH_PLATFORM_NET_BAD_FD, cli = AH_PLATFORM_NET_BAD_FD, srv = AH_PLATFORM_NET_BAD_FD;
        struct sockaddr_in la, ca, pa;
        socklen_t len;
        int tries;
        ah_status st = AH_ERR_IO;

        lst = WSASocketW(AF_INET, SOCK_STREAM, IPPROTO_TCP, NULL, 0, WSA_FLAG_NO_HANDLE_INHERIT);
        cli = WSASocketW(AF_INET, SOCK_STREAM, IPPROTO_TCP, NULL, 0, WSA_FLAG_NO_HANDLE_INHERIT);
        if (lst == AH_PLATFORM_NET_BAD_FD || cli == AH_PLATFORM_NET_BAD_FD) {
            goto pair_done;
        }
        if (bind_listen(lst, 0, 4, NULL) != AH_OK) {
            goto pair_done;
        }
        len = (socklen_t)sizeof la;
        if (getsockname(lst, (struct sockaddr *)&la, &len) != 0) {
            goto pair_done;
        }
        /* Conexão bloqueante com o próprio escutador em loopback: completa
         * no SYN/ACK local, sem esperar por terceiros. */
        if (connect(cli, (const struct sockaddr *)&la, sizeof la) != 0) {
            goto pair_done;
        }
        len = (socklen_t)sizeof ca;
        if (getsockname(cli, (struct sockaddr *)&ca, &len) != 0) {
            goto pair_done;
        }
        for (tries = 0; tries < 8; tries++) {
            /* Bloqueante: a nossa conexão já está na fila, então o accept
             * volta assim que chegar nela. */
            srv = accept(lst, NULL, NULL);
            if (srv == AH_PLATFORM_NET_BAD_FD) {
                goto pair_done;
            }
            len = (socklen_t)sizeof pa;
            if (getpeername(srv, (struct sockaddr *)&pa, &len) == 0 &&
                pa.sin_port == ca.sin_port && pa.sin_addr.s_addr == ca.sin_addr.s_addr) {
                break;
            }
            ah_platform_net_close_fd(srv);
            srv = AH_PLATFORM_NET_BAD_FD;
        }
        if (srv == AH_PLATFORM_NET_BAD_FD) {
            goto pair_done;
        }
        if (set_no_inherit(srv) != AH_OK || ah_platform_net_set_nonblocking_fd(srv) != AH_OK ||
            ah_platform_net_set_nonblocking_fd(cli) != AH_OK) {
            goto pair_done;
        }
        *a = srv;
        *b = cli;
        srv = AH_PLATFORM_NET_BAD_FD;
        cli = AH_PLATFORM_NET_BAD_FD;
        st = AH_OK;
    pair_done:
        ah_platform_net_close_fd(lst);
        ah_platform_net_close_fd(cli);
        ah_platform_net_close_fd(srv);
        return st;
    }
#else
    {
        int fds[2];
        int i;
        if (socketpair(AF_UNIX, SOCK_STREAM, 0, fds) != 0) {
            return AH_ERR_IO;
        }
        for (i = 0; i < 2; i++) {
            if (set_no_inherit(fds[i]) != AH_OK || ah_platform_net_set_nonblocking_fd(fds[i]) != AH_OK) {
                close(fds[0]);
                close(fds[1]);
                return AH_ERR_IO;
            }
        }
        *a = fds[0];
        *b = fds[1];
        return AH_OK;
    }
#endif
}

/* ---------------------------------------------------------------------------
 * Dono da conexão (SEC-R12, SEC-R13)
 * ------------------------------------------------------------------------- */

/* Endereços dos dois lados, em ordem de rede. */
static ah_status endpoints(const ah_platform_socket *sock, struct sockaddr_in *self,
                           struct sockaddr_in *peer) {
    socklen_t len = (socklen_t)sizeof *self;
    memset(self, 0, sizeof *self);
    memset(peer, 0, sizeof *peer);
    if (getsockname(sock->fd, (struct sockaddr *)self, &len) != 0 ||
        self->sin_family != AF_INET) {
        return AH_ERR_IO;
    }
    len = (socklen_t)sizeof *peer;
    if (getpeername(sock->fd, (struct sockaddr *)peer, &len) != 0 ||
        peer->sin_family != AF_INET) {
        return AH_ERR_IO;
    }
    return AH_OK;
}

#ifdef _WIN32

/* TOKEN_USER do token do processo. Posse: o chamador libera com free(). */
static ah_status process_token_user(HANDLE process, TOKEN_USER **out) {
    HANDLE tok = NULL;
    DWORD need = 0;
    TOKEN_USER *tu = NULL;
    ah_status st = AH_ERR_IO;

    *out = NULL;
    if (!OpenProcessToken(process, TOKEN_QUERY, &tok)) {
        return AH_ERR_IO;
    }
    if (!GetTokenInformation(tok, TokenUser, NULL, 0, &need) &&
        GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
        goto done;
    }
    if (need == 0) {
        goto done;
    }
    tu = malloc(need);
    if (tu == NULL) {
        st = AH_ERR_NOMEM;
        goto done;
    }
    if (!GetTokenInformation(tok, TokenUser, tu, need, &need)) {
        free(tu);
        tu = NULL;
        goto done;
    }
    *out = tu;
    st = AH_OK;
done:
    CloseHandle(tok);
    return st;
}

/* Tabela TCP IPv4 com o PID dono de cada linha. Posse: free(). */
static ah_status tcp_table(MIB_TCPTABLE_OWNER_PID **out) {
    DWORD size = 0;
    int tries;

    *out = NULL;
    /* A tabela pode crescer entre a consulta do tamanho e a cópia: algumas
     * tentativas com folga. */
    for (tries = 0; tries < 4; tries++) {
        MIB_TCPTABLE_OWNER_PID *t;
        DWORD rc = GetExtendedTcpTable(NULL, &size, FALSE, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0);
        if (rc != ERROR_INSUFFICIENT_BUFFER && rc != NO_ERROR) {
            return AH_ERR_IO;
        }
        if (size > ULONG_MAX - 4096u) {
            return AH_ERR_LIMIT;
        }
        size += 4096u;
        t = malloc(size);
        if (t == NULL) {
            return AH_ERR_NOMEM;
        }
        rc = GetExtendedTcpTable(t, &size, FALSE, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0);
        if (rc == NO_ERROR) {
            *out = t;
            return AH_OK;
        }
        free(t);
        if (rc != ERROR_INSUFFICIENT_BUFFER) {
            return AH_ERR_IO;
        }
    }
    return AH_ERR_IO;
}

/* PID do processo dono do lado `peer` da conexão self<->peer. */
static ah_status peer_pid(const struct sockaddr_in *self, const struct sockaddr_in *peer,
                          DWORD *pid) {
    MIB_TCPTABLE_OWNER_PID *t = NULL;
    ah_status st = tcp_table(&t);
    DWORD i;
    DWORD listen_pid = 0;
    int listen_hits = 0;

    *pid = 0;
    if (st != AH_OK) {
        return st;
    }
    st = AH_ERR_NOT_FOUND;
    for (i = 0; i < t->dwNumEntries; i++) {
        const MIB_TCPROW_OWNER_PID *r = &t->table[i];
        /* As portas da tabela vêm em ordem de rede nos 16 bits baixos. */
        u_short lport = (u_short)(r->dwLocalPort & 0xFFFFu);
        u_short rport = (u_short)(r->dwRemotePort & 0xFFFFu);
        if (r->dwState == MIB_TCP_STATE_LISTEN) {
            if (lport == peer->sin_port &&
                (r->dwLocalAddr == peer->sin_addr.s_addr || r->dwLocalAddr == htonl(INADDR_ANY))) {
                if (listen_hits == 0 || r->dwOwningPid != listen_pid) {
                    listen_hits++;
                }
                listen_pid = r->dwOwningPid;
            }
            continue;
        }
        if (r->dwLocalAddr == peer->sin_addr.s_addr && lport == peer->sin_port &&
            r->dwRemoteAddr == self->sin_addr.s_addr && rport == self->sin_port) {
            *pid = r->dwOwningPid;
            st = AH_OK;
            break;
        }
    }
    /* Do lado do cliente, a conexão ainda na fila do servidor pode não ter
     * linha própria: vale o dono do socket que escuta na porta, desde que
     * seja um só (dois donos possíveis = ambíguo = recusa). */
    if (st != AH_OK && listen_hits == 1) {
        *pid = listen_pid;
        st = AH_OK;
    }
    free(t);
    return st;
}

ah_status ah_platform_socket_peer_is_current_user(const ah_platform_socket *sock, bool *same) {
    struct sockaddr_in self, peer;
    TOKEN_USER *mine = NULL, *theirs = NULL;
    HANDLE proc = NULL;
    DWORD pid = 0;
    ah_status st;

    if (same == NULL) {
        return AH_ERR_INVALID;
    }
    *same = false;
    if (sock == NULL) {
        return AH_ERR_INVALID;
    }
    st = endpoints(sock, &self, &peer);
    if (st != AH_OK) {
        return st;
    }
    st = peer_pid(&self, &peer, &pid);
    if (st != AH_OK) {
        return st;
    }
    if (pid == GetCurrentProcessId()) {
        *same = true;
        return AH_OK;
    }
    /* PID 0 (ocioso) e 4 (System) não têm token consultável. */
    if (pid == 0 || pid == 4) {
        return AH_ERR_IO;
    }
    st = process_token_user(GetCurrentProcess(), &mine);
    if (st != AH_OK) {
        return st;
    }
    proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (proc == NULL) {
        /* Sem acesso ao processo: não dá para provar que é nosso. */
        free(mine);
        return AH_ERR_IO;
    }
    st = process_token_user(proc, &theirs);
    CloseHandle(proc);
    if (st == AH_OK) {
        *same = EqualSid(mine->User.Sid, theirs->User.Sid) ? true : false;
    }
    free(theirs);
    free(mine);
    return st;
}

#elif defined(__linux__)

/* uid dono do lado `peer`, lido de /proc/net/tcp. Formato de cada linha:
 * "sl local rem st tx:rx tr:when retrnsmt uid ...", endereços como
 * %08X:%04X (o endereço é o valor bruto de s_addr, a porta em ordem do
 * host). */
static ah_status peer_uid(const struct sockaddr_in *self, const struct sockaddr_in *peer,
                          uid_t *uid) {
    FILE *f;
    char line[512];
    unsigned int want_la = (unsigned int)peer->sin_addr.s_addr;
    unsigned int want_lp = ntohs(peer->sin_port);
    unsigned int want_ra = (unsigned int)self->sin_addr.s_addr;
    unsigned int want_rp = ntohs(self->sin_port);
    unsigned int listen_uid = 0;
    int listen_hits = 0;
    ah_status st = AH_ERR_NOT_FOUND;

    f = fopen("/proc/net/tcp", "r");
    if (f == NULL) {
        return AH_ERR_IO;
    }
    /* Cabeçalho. */
    if (fgets(line, sizeof line, f) == NULL) {
        fclose(f);
        return AH_ERR_IO;
    }
    while (fgets(line, sizeof line, f) != NULL) {
        unsigned int la, lp, ra, rp, state, u;
        if (sscanf(line, " %*u: %8X:%4X %8X:%4X %2X %*X:%*X %*X:%*X %*X %u", &la, &lp, &ra,
                   &rp, &state, &u) != 6) {
            continue;
        }
        if (state == 0x0Au) { /* TCP_LISTEN */
            if (lp == want_lp && (la == want_la || la == 0u)) {
                if (listen_hits == 0 || u != listen_uid) {
                    listen_hits++;
                }
                listen_uid = u;
            }
            continue;
        }
        if (la == want_la && lp == want_lp && ra == want_ra && rp == want_rp) {
            *uid = (uid_t)u;
            st = AH_OK;
            break;
        }
    }
    fclose(f);
    if (st != AH_OK && listen_hits == 1) {
        *uid = (uid_t)listen_uid;
        st = AH_OK;
    }
    return st;
}

ah_status ah_platform_socket_peer_is_current_user(const ah_platform_socket *sock, bool *same) {
    struct sockaddr_in self, peer;
    uid_t uid = 0;
    ah_status st;

    if (same == NULL) {
        return AH_ERR_INVALID;
    }
    *same = false;
    if (sock == NULL) {
        return AH_ERR_INVALID;
    }
    st = endpoints(sock, &self, &peer);
    if (st != AH_OK) {
        return st;
    }
    st = peer_uid(&self, &peer, &uid);
    if (st != AH_OK) {
        return st;
    }
    *same = uid == geteuid();
    return AH_OK;
}

#else

ah_status ah_platform_socket_peer_is_current_user(const ah_platform_socket *sock, bool *same) {
    (void)sock;
    if (same != NULL) {
        *same = false;
    }
    /* Só Windows e Linux são alvos (ADR 07); outro SO falha fechado. */
    return AH_ERR_INTERNAL;
}

#endif
