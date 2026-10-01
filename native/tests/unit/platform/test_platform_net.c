/* Testes de ah_platform_net (F0-09): escuta em 127.0.0.1 com port 0, porta
 * ocupada, bind exclusivo (SEC-R14), eco cliente<->servidor pelo laço e dono
 * da conexão (SEC-R12/R13), inclusive com OUTRO processo do mesmo usuário
 * (o próprio executável relançado com "--connect <porta>"). Nunca usa a
 * porta 4747: toda escuta é port 0.
 *
 * Inclui o cabeçalho interno da plataforma para ler opções do descritor e
 * provar cada passo do dono da conexão; também chama o SO direto para o
 * "intruso" de SEC-R14 e para criar o processo auxiliar. É teste da própria
 * camada de plataforma. */
#include "ah_platform_net_priv.h" /* primeiro: define as macros de recurso do POSIX */

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ah_platform_loop.h"
#include "ah_platform_net.h"
#include "ah_test.h"

#ifdef _WIN32
#include <windows.h>
#include <wchar.h>
#else
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

static void test_listen_port_zero(void) {
    ah_platform_socket *l = NULL;
    ah_platform_net_err err = AH_PLATFORM_NET_OTHER;
    uint16_t port = 0;

    CHECK(ah_platform_net_listen(0, &err, &l) == AH_OK);
    CHECK(err == AH_PLATFORM_NET_NONE);
    CHECK(l != NULL);
    CHECK(ah_platform_socket_local_port(l, &port) == AH_OK);
    CHECK(port > 0);
    CHECK(port != 4747);
    if (l != NULL) {
        /* SEC-R14: a opção de bind exclusivo está de fato no descritor. O
         * teste de segundo bind sozinho não prova isso: como o mesmo
         * usuário, o Windows já recusa o segundo bind em 127.0.0.1. */
#ifdef _WIN32
        BOOL excl = FALSE;
        int len = (int)sizeof excl;
        CHECK(getsockopt(l->fd, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, (char *)&excl, &len) == 0);
        CHECK(excl != FALSE);
#elif defined(SO_REUSEPORT)
        int rp = 1;
        socklen_t len = (socklen_t)sizeof rp;
        CHECK(getsockopt(l->fd, SOL_SOCKET, SO_REUSEPORT, &rp, &len) == 0);
        CHECK(rp == 0);
#endif
    }
    ah_platform_socket_close(l);
}

/* Connect a porta fechada: recusa rápida e distinta de TIMEOUT. No Windows
 * depende de SIO_TCP_INITIAL_RTO (sem ela, a recusa leva ~2 s e o teto de
 * 500 ms venceria antes). */
static void test_connect_refused(void) {
    ah_platform_socket *l = NULL, *c = NULL;
    ah_platform_net_err err = AH_PLATFORM_NET_NONE;
    uint16_t port = 0;
    uint64_t t0, dt;

    CHECK(ah_platform_net_listen(0, NULL, &l) == AH_OK);
    CHECK(ah_platform_socket_local_port(l, &port) == AH_OK);
    ah_platform_socket_close(l);
    if (port == 0) {
        return;
    }
    t0 = ah_platform_loop_now_ms();
    CHECK(ah_platform_net_connect(port, 500, &err, &c) == AH_ERR_IO);
    dt = ah_platform_loop_now_ms() - t0;
    CHECK(c == NULL);
    if (err != AH_PLATFORM_NET_REFUSED) {
        fprintf(stderr, "connect a porta fechada: %s em %llu ms\n", ah_platform_net_err_text(err),
                (unsigned long long)dt);
    }
    CHECK(err == AH_PLATFORM_NET_REFUSED);
    CHECK(dt < 500);
    ah_platform_socket_close(c);
}

static void test_port_in_use(void) {
    ah_platform_socket *l1 = NULL, *l2 = NULL;
    ah_platform_net_err err = AH_PLATFORM_NET_NONE;
    uint16_t port = 0;

    CHECK(ah_platform_net_listen(0, NULL, &l1) == AH_OK);
    CHECK(ah_platform_socket_local_port(l1, &port) == AH_OK);
    CHECK(port > 0);

    /* A porta é o lock de instância (SPEC-01 §1): a segunda escuta falha com
     * o detalhe distinto de porta ocupada. */
    CHECK(ah_platform_net_listen(port, &err, &l2) == AH_ERR_IO);
    CHECK(l2 == NULL);
    CHECK(err == AH_PLATFORM_NET_ADDR_IN_USE);
    CHECK(strcmp(ah_platform_net_err_text(err), ah_platform_net_err_text(AH_PLATFORM_NET_OTHER)) != 0);

#ifdef _WIN32
    {
        /* SEC-R14: com SO_EXCLUSIVEADDRUSE no dono, nem um bind com
         * SO_REUSEADDR consegue a porta. */
        SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        struct sockaddr_in sa;
        BOOL on = TRUE;
        CHECK(s != INVALID_SOCKET);
        if (s != INVALID_SOCKET) {
            CHECK(setsockopt(s, SOL_SOCKET, SO_REUSEADDR, (const char *)&on, sizeof on) == 0);
            memset(&sa, 0, sizeof sa);
            sa.sin_family = AF_INET;
            sa.sin_port = htons(port);
            sa.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
            CHECK(bind(s, (const struct sockaddr *)&sa, sizeof sa) != 0);
            closesocket(s);
        }
    }
#endif

    ah_platform_socket_close(l2);
    ah_platform_socket_close(l1);

    /* Depois de fechar, a porta volta a ficar livre. */
    {
        ah_platform_socket *l3 = NULL;
        CHECK(ah_platform_net_listen(port, &err, &l3) == AH_OK);
        ah_platform_socket_close(l3);
    }
}

/* ------------------------------------------------------------------------- */

#define ECHO_MSG "ping-eco-123"

struct echo_ctx {
    ah_platform_socket *listener;
    ah_platform_socket *server;
    ah_platform_socket *client;
    char got[64];
    size_t ngot;
    bool done;
    bool timed_out;
    bool server_owner_same;
    ah_status server_owner_st;
};

static void on_server_read(ah_platform_loop *loop, ah_platform_socket *s, unsigned ev,
                           void *ud) {
    struct echo_ctx *c = ud;
    char buf[64];
    size_t n = 0, w = 0;
    ah_platform_net_err err = AH_PLATFORM_NET_NONE;
    (void)loop;

    CHECK((ev & AH_PLATFORM_IO_ERROR) == 0);
    for (;;) {
        CHECK(ah_platform_socket_read(s, buf, sizeof buf, &n, &err) == AH_OK);
        if (n == 0) {
            break;
        }
        CHECK(ah_platform_socket_write(s, buf, n, &w, &err) == AH_OK);
        CHECK(w == n);
    }
    if (err == AH_PLATFORM_NET_CLOSED) {
        ah_platform_socket_close(s);
        c->server = NULL;
    }
}

static void on_accept(ah_platform_loop *loop, ah_platform_socket *l, unsigned ev, void *ud) {
    struct echo_ctx *c = ud;
    ah_platform_socket *s = NULL;
    ah_platform_net_err err = AH_PLATFORM_NET_NONE;

    CHECK(ev & AH_PLATFORM_IO_READ);
    CHECK(ah_platform_socket_accept(l, &err, &s) == AH_OK);
    if (s == NULL) {
        CHECK(err == AH_PLATFORM_NET_WOULD_BLOCK);
        return;
    }
    c->server = s;
    c->server_owner_st = ah_platform_socket_peer_is_current_user(s, &c->server_owner_same);
    CHECK(ah_platform_loop_watch(loop, s, AH_PLATFORM_IO_READ, on_server_read, c) == AH_OK);
}

static void on_client_read(ah_platform_loop *loop, ah_platform_socket *s, unsigned ev,
                           void *ud) {
    struct echo_ctx *c = ud;
    size_t n = 0;
    ah_platform_net_err err = AH_PLATFORM_NET_NONE;

    CHECK((ev & AH_PLATFORM_IO_ERROR) == 0);
    CHECK(ah_platform_socket_read(s, c->got + c->ngot, sizeof c->got - c->ngot, &n, &err) ==
          AH_OK);
    c->ngot += n;
    if (c->ngot >= strlen(ECHO_MSG) || err == AH_PLATFORM_NET_CLOSED) {
        c->done = true;
        ah_platform_loop_stop(loop);
    }
}

static void on_guard(ah_platform_loop *loop, ah_platform_timer *t, void *ud) {
    struct echo_ctx *c = ud;
    (void)t;
    c->timed_out = true;
    ah_platform_loop_stop(loop);
}

static void test_echo_via_loop(void) {
    struct echo_ctx c;
    ah_platform_loop *loop = NULL;
    ah_platform_timer *guard = NULL;
    ah_platform_net_err err = AH_PLATFORM_NET_NONE;
    uint16_t port = 0;
    size_t w = 0;

    memset(&c, 0, sizeof c);
    c.server_owner_st = AH_ERR_INTERNAL;
    CHECK(ah_platform_loop_create(&loop) == AH_OK);
    if (loop == NULL) {
        return;
    }
    CHECK(ah_platform_net_listen(0, &err, &c.listener) == AH_OK);
    CHECK(ah_platform_socket_local_port(c.listener, &port) == AH_OK);
    CHECK(ah_platform_loop_watch(loop, c.listener, AH_PLATFORM_IO_READ, on_accept, &c) == AH_OK);

    CHECK(ah_platform_net_connect(port, 2000, &err, &c.client) == AH_OK);
    CHECK(c.client != NULL);
    if (c.client != NULL) {
        CHECK(ah_platform_socket_write(c.client, ECHO_MSG, strlen(ECHO_MSG), &w, &err) == AH_OK);
        CHECK(w == strlen(ECHO_MSG));
        CHECK(ah_platform_loop_watch(loop, c.client, AH_PLATFORM_IO_READ, on_client_read, &c) ==
              AH_OK);
    }

    CHECK(ah_platform_timer_create(loop, on_guard, &c, &guard) == AH_OK);
    CHECK(ah_platform_timer_start(guard, 5000, 0) == AH_OK);
    CHECK(ah_platform_loop_run(loop) == AH_OK);

    CHECK(!c.timed_out);
    CHECK(c.done);
    CHECK(c.ngot == strlen(ECHO_MSG));
    CHECK(memcmp(c.got, ECHO_MSG, strlen(ECHO_MSG)) == 0);
    /* Dono da conexão visto do servidor: o cliente é este processo. */
    CHECK(c.server_owner_st == AH_OK);
    CHECK(c.server_owner_same);

    ah_platform_timer_free(guard);
    ah_platform_socket_close(c.client);
    ah_platform_socket_close(c.server);
    ah_platform_socket_close(c.listener);
    ah_platform_loop_free(loop);
}

/* Dono da conexão dos dois lados, sem laço: o cliente confere o dono do
 * socket servidor ANTES de mandar qualquer coisa (SEC-R13), inclusive com a
 * conexão ainda na fila do accept. */
static void test_owner_both_sides(void) {
    ah_platform_socket *l = NULL, *cli = NULL, *srv = NULL;
    ah_platform_net_err err = AH_PLATFORM_NET_NONE;
    uint16_t port = 0;
    unsigned ready = 0;
    bool same = false;

    CHECK(ah_platform_net_listen(0, &err, &l) == AH_OK);
    CHECK(ah_platform_socket_local_port(l, &port) == AH_OK);
    CHECK(ah_platform_net_connect(port, 2000, &err, &cli) == AH_OK);
    if (cli == NULL) {
        ah_platform_socket_close(l);
        return;
    }

    /* Ainda não aceita do lado do servidor. */
    same = false;
    CHECK(ah_platform_socket_peer_is_current_user(cli, &same) == AH_OK);
    CHECK(same);

    CHECK(ah_platform_socket_wait(l, AH_PLATFORM_IO_READ, 2000, &ready) == AH_OK);
    CHECK(ready & AH_PLATFORM_IO_READ);
    CHECK(ah_platform_socket_accept(l, &err, &srv) == AH_OK);
    CHECK(srv != NULL);

    same = false;
    CHECK(ah_platform_socket_peer_is_current_user(cli, &same) == AH_OK);
    CHECK(same);
    if (srv != NULL) {
        same = false;
        CHECK(ah_platform_socket_peer_is_current_user(srv, &same) == AH_OK);
        CHECK(same);
    }

    /* Socket que escuta não tem outro lado: falha e *same fica false. */
    same = true;
    CHECK(ah_platform_socket_peer_is_current_user(l, &same) != AH_OK);
    CHECK(!same);

    /* Fim de fluxo visto pelo cliente quando o servidor fecha. */
    ah_platform_socket_close(srv);
    {
        char b[8];
        size_t n = 99;
        ready = 0;
        CHECK(ah_platform_socket_wait(cli, AH_PLATFORM_IO_READ, 2000, &ready) == AH_OK);
        CHECK(ready & AH_PLATFORM_IO_READ);
        CHECK(ah_platform_socket_read(cli, b, sizeof b, &n, &err) == AH_OK);
        CHECK(n == 0);
        CHECK(err == AH_PLATFORM_NET_CLOSED);
    }
    ah_platform_socket_close(cli);
    ah_platform_socket_close(l);
}

static void test_nonblocking_accept_and_read(void) {
    ah_platform_socket *l = NULL, *cli = NULL, *srv = NULL;
    ah_platform_net_err err = AH_PLATFORM_NET_NONE;
    uint16_t port = 0;
    unsigned ready = 0;
    char b[8];
    size_t n = 99;

    CHECK(ah_platform_net_listen(0, &err, &l) == AH_OK);
    /* Sem conexão pendente: volta na hora com WOULD_BLOCK. */
    CHECK(ah_platform_socket_accept(l, &err, &srv) == AH_OK);
    CHECK(srv == NULL);
    CHECK(err == AH_PLATFORM_NET_WOULD_BLOCK);

    CHECK(ah_platform_socket_local_port(l, &port) == AH_OK);
    CHECK(ah_platform_net_connect(port, 2000, &err, &cli) == AH_OK);
    CHECK(ah_platform_socket_wait(l, AH_PLATFORM_IO_READ, 2000, &ready) == AH_OK);
    CHECK(ah_platform_socket_accept(l, &err, &srv) == AH_OK);
    CHECK(srv != NULL);
    if (srv != NULL) {
        /* Sem dados: volta na hora com WOULD_BLOCK, sem confundir com fim. */
        CHECK(ah_platform_socket_read(srv, b, sizeof b, &n, &err) == AH_OK);
        CHECK(n == 0);
        CHECK(err == AH_PLATFORM_NET_WOULD_BLOCK);
    }
    ah_platform_socket_close(srv);
    ah_platform_socket_close(cli);
    ah_platform_socket_close(l);
}

/* ------------------------------------------------------------------------- */
/* Processo auxiliar: conecta na porta e espera o servidor fechar. */

static int child_connect_main(const char *port_text) {
    ah_platform_socket *c = NULL;
    ah_platform_net_err err = AH_PLATFORM_NET_NONE;
    char *end = NULL;
    long port = strtol(port_text, &end, 10);
    int rc = 0;

    if (end == port_text || *end != '\0' || port <= 0 || port > 65535) {
        return 2;
    }
    if (ah_platform_net_connect((uint16_t)port, 5000, &err, &c) != AH_OK) {
        return 3;
    }
    for (;;) {
        unsigned ready = 0;
        char b[16];
        size_t n = 0;
        if (ah_platform_socket_wait(c, AH_PLATFORM_IO_READ, 10000, &ready) != AH_OK ||
            ready == 0) {
            rc = 4;
            break;
        }
        if (ah_platform_socket_read(c, b, sizeof b, &n, &err) != AH_OK) {
            break; /* queda também encerra o auxiliar */
        }
        if (n == 0 && err == AH_PLATFORM_NET_CLOSED) {
            break;
        }
    }
    ah_platform_socket_close(c);
    return rc;
}

/* Conexão vinda de OUTRO processo do mesmo usuário: o atalho "PID igual ao
 * meu" não se aplica, e o resultado sai da comparação de SID (Windows) ou de
 * uid (Linux). */
static void test_owner_other_process(const char *argv0) {
    ah_platform_socket *l = NULL, *srv = NULL;
    ah_platform_net_err err = AH_PLATFORM_NET_NONE;
    uint16_t port = 0;
    unsigned ready = 0;
    bool same = false;
#ifdef _WIN32
    wchar_t exe[1024];
    wchar_t cmd[1200];
    DWORD nexe;
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    DWORD code = 99;
    (void)argv0;
#else
    pid_t child;
    char port_text[16];
    int status = 0;
#endif

    CHECK(ah_platform_net_listen(0, &err, &l) == AH_OK);
    CHECK(ah_platform_socket_local_port(l, &port) == AH_OK);
    if (l == NULL || port == 0) {
        ah_platform_socket_close(l);
        return;
    }

#ifdef _WIN32
    nexe = GetModuleFileNameW(NULL, exe, (DWORD)(sizeof exe / sizeof exe[0]));
    CHECK(nexe > 0 && nexe < sizeof exe / sizeof exe[0]);
    CHECK(swprintf(cmd, sizeof cmd / sizeof cmd[0], L"\"%ls\" --connect %u", exe,
                   (unsigned)port) > 0);
    memset(&si, 0, sizeof si);
    si.cb = sizeof si;
    memset(&pi, 0, sizeof pi);
    if (!CreateProcessW(exe, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
        CHECK(!"CreateProcessW falhou");
        ah_platform_socket_close(l);
        return;
    }
#else
    CHECK(snprintf(port_text, sizeof port_text, "%u", (unsigned)port) > 0);
    child = fork();
    if (child == 0) {
        execl(argv0, argv0, "--connect", port_text, (char *)NULL);
        _exit(127);
    }
    CHECK(child > 0);
    if (child < 0) {
        ah_platform_socket_close(l);
        return;
    }
#endif

    CHECK(ah_platform_socket_wait(l, AH_PLATFORM_IO_READ, 10000, &ready) == AH_OK);
    CHECK(ready & AH_PLATFORM_IO_READ);
    CHECK(ah_platform_socket_accept(l, &err, &srv) == AH_OK);
    CHECK(srv != NULL);
    if (srv != NULL) {
#ifdef _WIN32
        uint32_t pid = 0;
        /* O PID achado na tabela TCP é o do auxiliar, não o nosso. */
        CHECK(ah_platform_net_peer_pid(srv, &pid) == AH_OK);
        CHECK(pid == pi.dwProcessId);
        CHECK(pid != GetCurrentProcessId());
        same = false;
        CHECK(ah_platform_net_pid_is_current_user(pid, &same) == AH_OK);
        CHECK(same);
#endif
        same = false;
        CHECK(ah_platform_socket_peer_is_current_user(srv, &same) == AH_OK);
        CHECK(same);
    }
#ifdef _WIN32
    /* PIDs que não são deste usuário (ocioso e System) nunca passam: nem
     * AH_OK com same=true. Reprova um atalho que aceite qualquer PID. */
    {
        uint32_t others[2] = {0, 4};
        int i;
        for (i = 0; i < 2; i++) {
            ah_status st;
            same = true;
            st = ah_platform_net_pid_is_current_user(others[i], &same);
            CHECK(!(st == AH_OK && same));
        }
    }
#endif

    ah_platform_socket_close(srv); /* o auxiliar vê o fim de fluxo e sai */
#ifdef _WIN32
    CHECK(WaitForSingleObject(pi.hProcess, 10000) == WAIT_OBJECT_0);
    CHECK(GetExitCodeProcess(pi.hProcess, &code) && code == 0);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
#else
    CHECK(waitpid(child, &status, 0) == child);
    CHECK(WIFEXITED(status) && WEXITSTATUS(status) == 0);
#endif
    ah_platform_socket_close(l);
}

int main(int argc, char **argv) {
    if (argc == 3 && strcmp(argv[1], "--connect") == 0) {
        return child_connect_main(argv[2]);
    }
    test_listen_port_zero();
    test_port_in_use();
    test_connect_refused();
    test_nonblocking_accept_and_read();
    test_echo_via_loop();
    test_owner_both_sides();
    test_owner_other_process(argc > 0 ? argv[0] : "");
    return AH_TEST_END("test_platform_net");
}
