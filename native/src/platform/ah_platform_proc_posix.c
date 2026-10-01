/* Processos no POSIX (F0-07). Ver o contrato em ah_platform_proc.h.
 * NÃO VERIFICADO nesta tarefa: escrito e revisado, mas sem compilação nem
 * teste em Linux/macOS (fica para o CI linux-*).
 *
 * fork + execve (e não posix_spawn) porque o filho precisa, antes do exec,
 * de setpgid, chdir e do fechamento dos descritores acima de 2 (SPEC-08 P4),
 * e as ações equivalentes do posix_spawn (addchdir_np, addclosefrom_np) não
 * são portáveis. Entre o fork e o exec só há chamadas async-signal-safe. */
#if defined(__linux__)
#define _GNU_SOURCE /* pipe2, syscall */
#else
#define _POSIX_C_SOURCE 200809L
#if defined(__APPLE__)
#define _DARWIN_C_SOURCE
#endif
#endif

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <sys/resource.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#if defined(__linux__)
#include <sys/syscall.h>
#endif

#include "ah_platform_proc_internal.h"

extern char **environ;

struct ah_proc {
    pid_t pid;
    bool exited;
    ah_proc_exit st;
    int fd[3]; /* lado do Hub: stdin (escrita), stdout, stderr (leitura) */
    bool eof[3];
    int pidfd; /* Linux >= 5.3; -1 sem suporte */
};

/* pidfd do filho (aguardável de fim de processo, M4). -1 se o kernel ou a
 * libc não tiverem pidfd_open: aí o laço usa SIGCHLD (ver o header). O
 * pidfd já nasce com O_CLOEXEC. */
static int open_pidfd(pid_t pid) {
#if defined(__linux__) && defined(SYS_pidfd_open)
    long fd = syscall(SYS_pidfd_open, (long)pid, 0L);
    return fd < 0 ? -1 : (int)fd;
#else
    (void)pid;
    return -1;
#endif
}

static void close_fd(int *fd) {
    if (*fd >= 0) {
        close(*fd);
    }
    *fd = -1;
}

/* Pipe com O_CLOEXEC nos dois lados (o filho só recebe a sua ponta via dup2,
 * que limpa o FD_CLOEXEC da cópia). */
static int make_pipe(int fds[2]) {
#if defined(__linux__)
    return pipe2(fds, O_CLOEXEC);
#else
    if (pipe(fds) != 0) {
        return -1;
    }
    if (fcntl(fds[0], F_SETFD, FD_CLOEXEC) != 0 ||
        fcntl(fds[1], F_SETFD, FD_CLOEXEC) != 0) {
        int e = errno;
        close(fds[0]);
        close(fds[1]);
        errno = e;
        return -1;
    }
    return 0;
#endif
}

static ah_status map_errno(int e) {
    switch (e) {
    case ENOENT:
    case ENOTDIR:
        return AH_ERR_NOT_FOUND;
    case ENOMEM:
        return AH_ERR_NOMEM;
    case E2BIG:
    case ENAMETOOLONG:
        return AH_ERR_LIMIT;
    default:
        return AH_ERR_IO;
    }
}

/* Fecha [from, to] no filho: close_range (Linux >= 5.9) numa chamada (com
 * to_end, até o último descritor possível, não só até `to`); sem ele, laço
 * de close() até `to`. Ambos async-signal-safe. */
static void close_range_child(int from, int to, bool to_end) {
    if (from > to) {
        return;
    }
#if defined(__linux__) && defined(SYS_close_range)
    unsigned last = to_end ? ~0u : (unsigned)to;
    if (syscall(SYS_close_range, (unsigned)from, last, 0u) == 0) {
        return;
    }
#else
    (void)to_end;
#endif
    for (int fd = from; fd <= to; fd++) {
        close(fd);
        if (fd == INT_MAX) {
            break; /* sem overflow do contador */
        }
    }
}

/* Escreve errno no pipe de erro e sai; só chamadas async-signal-safe. */
static void child_fail(int errfd, int code) {
    ssize_t r;
    do {
        r = write(errfd, &code, sizeof code);
    } while (r < 0 && errno == EINTR);
    _exit(127);
}

void ah_proc_free(ah_proc *p) {
    if (p == NULL) {
        return;
    }
    for (int i = 0; i < 3; i++) {
        close_fd(&p->fd[i]);
    }
    close_fd(&p->pidfd);
    free(p);
}

static ah_status validate_env(const ah_proc_spawn_opts *o, char *detail,
                              size_t cap) {
    for (size_t i = 0; i < o->env_count; i++) {
        size_t nl = 0;
        if (ah_proc_i_env_split(o->env[i], &nl) != AH_OK) {
            ah_proc_i_detail(detail, cap,
                             "entrada de ambiente %zu sem NOME=valor", i);
            return AH_ERR_INVALID;
        }
        for (size_t j = 0; j < i; j++) {
            size_t ml = 0;
            if (ah_proc_i_env_split(o->env[j], &ml) == AH_OK && ml == nl &&
                memcmp(o->env[i], o->env[j], nl) == 0) {
                ah_proc_i_detail(detail, cap,
                                 "variável de ambiente repetida no bloco");
                return AH_ERR_INVALID;
            }
        }
    }
    return AH_OK;
}

ah_status ah_proc_spawn(const ah_proc_spawn_opts *o, ah_proc **out,
                        char *detail, size_t cap) {
    if (detail != NULL && cap > 0) {
        detail[0] = '\0';
    }
    if (o == NULL || out == NULL || o->path == NULL ||
        (o->arg_count > 0 && o->args == NULL) ||
        (o->env_count > 0 && o->env == NULL)) {
        ah_proc_i_detail(detail, cap, "argumentos de spawn inválidos");
        return AH_ERR_INVALID;
    }
    *out = NULL;
    if (o->path[0] != '/') {
        ah_proc_i_detail(detail, cap,
                         "caminho do executável não é absoluto: o Hub nunca "
                         "busca no diretório corrente");
        return AH_ERR_INVALID;
    }
    if (o->via_cmd || o->start_suspended) {
        ah_proc_i_detail(detail, cap,
                         "via_cmd e start_suspended só existem no Windows");
        return AH_ERR_INVALID;
    }
    if (o->arg_count > SIZE_MAX / sizeof(char *) - 2) {
        return AH_ERR_LIMIT;
    }
    ah_status st = validate_env(o, detail, cap);
    if (st != AH_OK) {
        return st;
    }

    /* argv com cópias terminadas em NUL (arg_lens pode não apontar para
     * strings terminadas). */
    char **argv = calloc(o->arg_count + 2, sizeof(char *));
    if (argv == NULL) {
        return AH_ERR_NOMEM;
    }
    argv[0] = (char *)o->path;
    for (size_t i = 0; i < o->arg_count && st == AH_OK; i++) {
        const char *s;
        size_t len;
        st = ah_proc_i_arg(o->args, o->arg_lens, i, &s, &len);
        if (st != AH_OK) {
            ah_proc_i_detail(detail, cap, "argumento %zu com NUL embutido", i);
            break;
        }
        argv[i + 1] = malloc(len + 1);
        if (argv[i + 1] == NULL) {
            st = AH_ERR_NOMEM;
            break;
        }
        memcpy(argv[i + 1], s, len);
        argv[i + 1][len] = '\0';
    }
    char **envp = environ;
    char **env_copy = NULL;
    if (st == AH_OK && o->env != NULL) {
        env_copy = calloc(o->env_count + 1, sizeof(char *));
        if (env_copy == NULL) {
            st = AH_ERR_NOMEM;
        } else {
            for (size_t i = 0; i < o->env_count; i++) {
                env_copy[i] = (char *)o->env[i];
            }
            envp = env_copy;
        }
    }

    ah_proc *p = NULL;
    int pin[2] = {-1, -1}, pout[2] = {-1, -1}, perr[2] = {-1, -1};
    int errp[2] = {-1, -1};
    if (st == AH_OK) {
        p = calloc(1, sizeof *p);
        if (p == NULL) {
            st = AH_ERR_NOMEM;
        } else {
            p->fd[0] = p->fd[1] = p->fd[2] = -1;
            p->pidfd = -1;
        }
    }
    if (st == AH_OK && (make_pipe(pin) != 0 || make_pipe(pout) != 0 ||
                        make_pipe(perr) != 0 || make_pipe(errp) != 0)) {
        st = map_errno(errno);
        ah_proc_i_detail(detail, cap, "falha ao criar os pipes");
    }
    /* Limite real para o laço alternativo ao close_range: o maior entre
     * sysconf(_SC_OPEN_MAX) e o RLIMIT_NOFILE corrente (finito). Calculado
     * antes do fork: sysconf/getrlimit não são async-signal-safe. Só se
     * nenhum dos dois for conhecido vale o teto de 1 Mi descritores. */
    long maxfd = sysconf(_SC_OPEN_MAX);
    struct rlimit rl;
    if (getrlimit(RLIMIT_NOFILE, &rl) == 0 && rl.rlim_cur != RLIM_INFINITY &&
        (maxfd < 0 || rl.rlim_cur > (rlim_t)maxfd)) {
        maxfd = rl.rlim_cur > (rlim_t)INT_MAX ? INT_MAX : (long)rl.rlim_cur;
    }
    if (maxfd < 0) {
        maxfd = 1L << 20;
    }
    if (maxfd > INT_MAX) {
        maxfd = INT_MAX;
    }

    /* B3: todos os sinais bloqueados durante o fork. Assim nenhum handler
     * do Hub roda no filho entre o fork e a restauração das disposições. */
    sigset_t all_sigs;
    sigset_t old_mask;
    bool masked = false;
    if (st == AH_OK) {
        sigfillset(&all_sigs);
        int e = pthread_sigmask(SIG_SETMASK, &all_sigs, &old_mask);
        if (e != 0) {
            st = map_errno(e);
            ah_proc_i_detail(detail, cap, "falha ao bloquear sinais");
        } else {
            masked = true;
        }
    }

    pid_t pid = -1;
    if (st == AH_OK) {
        pid = fork();
        if (pid < 0) {
            st = map_errno(errno);
            ah_proc_i_detail(detail, cap, "fork falhou");
        }
    }
    if (st == AH_OK && pid == 0) {
        /* --- filho: só async-signal-safe daqui até o exec --- */
        int errfd = errp[1];
        /* O pipe de erro sai de 0..2 primeiro; se falhar, ainda dá para
         * escrever o errno nele (o pai reconhece como falha de spawn). */
        if (errfd < 3) {
            int moved = fcntl(errfd, F_DUPFD_CLOEXEC, 3);
            if (moved < 0) {
                child_fail(errfd, errno);
            }
            errfd = moved;
        }
        setpgid(0, 0); /* grupo próprio: `detached: true` do TS (B6) */
        int src[3] = {pin[0], pout[1], perr[1]};
        for (int i = 0; i < 3; i++) {
            /* Tira a ponta do caminho de 0..2 antes dos dup2. */
            if (src[i] < 3) {
                int moved = fcntl(src[i], F_DUPFD_CLOEXEC, 3);
                if (moved < 0) {
                    child_fail(errfd, errno);
                }
                src[i] = moved;
            }
        }
        for (int i = 0; i < 3; i++) {
            if (dup2(src[i], i) < 0) {
                child_fail(errfd, errno);
            }
        }
        /* P4: nada além de 0..2 (e do pipe de erro, que é O_CLOEXEC). */
        close_range_child(3, errfd - 1, false);
        close_range_child(errfd + 1, (int)maxfd, true);
        /* B3: disposição padrão ANTES de desbloquear (ignorado sobrevive ao
         * exec; um SIGPIPE ignorado pelo Hub não pode passar ao agente). */
        struct sigaction dfl;
        memset(&dfl, 0, sizeof dfl);
        dfl.sa_handler = SIG_DFL;
        sigemptyset(&dfl.sa_mask);
        for (int sig = 1; sig < 65; sig++) {
            if (sig != SIGKILL && sig != SIGSTOP) {
                sigaction(sig, &dfl, NULL); /* EINVAL fora da faixa: ok */
            }
        }
        sigset_t none;
        sigemptyset(&none);
        sigprocmask(SIG_SETMASK, &none, NULL);
        if (o->cwd != NULL && chdir(o->cwd) != 0) {
            child_fail(errfd, errno);
        }
        execve(o->path, argv, envp);
        child_fail(errfd, errno);
    }

    /* --- Hub --- */
    if (masked) {
        pthread_sigmask(SIG_SETMASK, &old_mask, NULL);
    }
    if (st == AH_OK) {
        /* Repetido no pai para não haver corrida com um kill(-pid) logo
         * depois do spawn; EACCES (filho já executou) e ESRCH são normais. */
        setpgid(pid, pid);
    }
    close_fd(&pin[0]);
    close_fd(&pout[1]);
    close_fd(&perr[1]);
    close_fd(&errp[1]);
    if (st == AH_OK) {
        int child_errno = 0;
        ssize_t r;
        do {
            r = read(errp[0], &child_errno, sizeof child_errno);
        } while (r < 0 && errno == EINTR);
        if (r == (ssize_t)sizeof child_errno) {
            int wst;
            while (waitpid(pid, &wst, 0) < 0 && errno == EINTR) {
            }
            st = map_errno(child_errno);
            ah_proc_i_detail(detail, cap, "exec falhou (errno %d)",
                             child_errno);
        }
    }
    close_fd(&errp[0]);
    if (st == AH_OK) {
        p->pid = pid;
        p->pidfd = open_pidfd(pid);
        p->fd[0] = pin[1];
        p->fd[1] = pout[0];
        p->fd[2] = perr[0];
        pin[1] = pout[0] = perr[0] = -1;
        for (int i = 0; i < 3; i++) {
            int fl = fcntl(p->fd[i], F_GETFL);
            if (fl < 0 || fcntl(p->fd[i], F_SETFL, fl | O_NONBLOCK) < 0) {
                /* Sem O_NONBLOCK o contrato de E/S quebra: mata e falha. */
                kill(pid, SIGKILL);
                int wst;
                while (waitpid(pid, &wst, 0) < 0 && errno == EINTR) {
                }
                st = AH_ERR_IO;
                break;
            }
        }
    }
    close_fd(&pin[1]);
    close_fd(&pout[0]);
    close_fd(&perr[0]);
    for (size_t i = 1; i <= o->arg_count; i++) {
        free(argv[i]);
    }
    free(argv);
    free(env_copy);
    if (st != AH_OK) {
        ah_proc_free(p);
        return st;
    }
    *out = p;
    return AH_OK;
}

ah_status ah_proc_read(ah_proc *p, ah_proc_stream stream, void *buf,
                       size_t cap, size_t *n, ah_proc_io *state) {
    if (p == NULL || buf == NULL || cap == 0 || n == NULL || state == NULL ||
        (stream != AH_PROC_STDOUT && stream != AH_PROC_STDERR)) {
        return AH_ERR_INVALID;
    }
    *n = 0;
    int fd = p->fd[stream];
    if (fd < 0 || p->eof[stream]) {
        *state = AH_PROC_IO_EOF;
        return AH_OK;
    }
    for (;;) {
        ssize_t r = read(fd, buf, cap);
        if (r > 0) {
            *n = (size_t)r;
            *state = AH_PROC_IO_DATA;
            return AH_OK;
        }
        if (r == 0) {
            p->eof[stream] = true;
            *state = AH_PROC_IO_EOF;
            return AH_OK;
        }
        if (errno == EINTR) {
            continue;
        }
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            *state = AH_PROC_IO_AGAIN;
            return AH_OK;
        }
        return AH_ERR_IO;
    }
}

ah_status ah_proc_write(ah_proc *p, const void *buf, size_t len,
                        size_t *accepted, ah_proc_io *state) {
    if (p == NULL || accepted == NULL || state == NULL ||
        (buf == NULL && len > 0)) {
        return AH_ERR_INVALID;
    }
    *accepted = 0;
    if (p->fd[0] < 0) {
        return AH_ERR_IO;
    }
    if (len == 0) {
        *state = AH_PROC_IO_DATA;
        return AH_OK;
    }
    for (;;) {
        ssize_t r = write(p->fd[0], buf, len);
        if (r >= 0) {
            *accepted = (size_t)r;
            *state = r > 0 ? AH_PROC_IO_DATA : AH_PROC_IO_AGAIN;
            return AH_OK;
        }
        if (errno == EINTR) {
            continue;
        }
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            *state = AH_PROC_IO_AGAIN;
            return AH_OK;
        }
        return AH_ERR_IO; /* EPIPE: filho fechou o stdin */
    }
}

ah_status ah_proc_close_stdin(ah_proc *p) {
    if (p == NULL) {
        return AH_ERR_INVALID;
    }
    close_fd(&p->fd[0]);
    return AH_OK;
}

ah_status ah_proc_waitable(const ah_proc *p, ah_proc_stream stream,
                           intptr_t *out) {
    if (p == NULL || out == NULL ||
        (stream != AH_PROC_STDIN && stream != AH_PROC_STDOUT &&
         stream != AH_PROC_STDERR)) {
        return AH_ERR_INVALID;
    }
    if (p->fd[stream] < 0) {
        return AH_ERR_NOT_FOUND;
    }
    *out = (intptr_t)p->fd[stream];
    return AH_OK;
}

ah_status ah_proc_exit_waitable(const ah_proc *p, intptr_t *out) {
    if (p == NULL || out == NULL) {
        return AH_ERR_INVALID;
    }
    if (p->pidfd < 0) {
        return AH_ERR_NOT_FOUND; /* laço usa SIGCHLD (ver o header) */
    }
    *out = (intptr_t)p->pidfd;
    return AH_OK;
}

ah_status ah_proc_native_pipe(const ah_proc *p, ah_proc_stream stream,
                              intptr_t *out) {
    if (p == NULL || out == NULL ||
        (stream != AH_PROC_STDIN && stream != AH_PROC_STDOUT &&
         stream != AH_PROC_STDERR)) {
        return AH_ERR_INVALID;
    }
    if (p->fd[stream] < 0) {
        return AH_ERR_NOT_FOUND;
    }
    *out = (intptr_t)p->fd[stream];
    return AH_OK;
}

ah_status ah_proc_wait_io(ah_proc *p, unsigned mask, int32_t timeout_ms,
                          unsigned *ready) {
    if (p == NULL || ready == NULL || mask == 0 ||
        (mask & ~(AH_PROC_MASK_STDIN | AH_PROC_MASK_STDOUT |
                  AH_PROC_MASK_STDERR)) != 0) {
        return AH_ERR_INVALID;
    }
    *ready = 0;
    struct pollfd pfd[3];
    unsigned bits[3];
    nfds_t count = 0;
    for (int i = 0; i < 3; i++) {
        unsigned bit = 1u << i;
        if (!(mask & bit)) {
            continue;
        }
        if (p->fd[i] < 0 || p->eof[i]) {
            *ready |= bit;
            continue;
        }
        pfd[count].fd = p->fd[i];
        pfd[count].events = (short)(i == 0 ? POLLOUT : POLLIN);
        pfd[count].revents = 0;
        bits[count++] = bit;
    }
    if (*ready != 0 || count == 0) {
        return AH_OK;
    }
    int r;
    do {
        r = poll(pfd, count, timeout_ms < 0 ? -1 : (int)timeout_ms);
    } while (r < 0 && errno == EINTR);
    if (r < 0) {
        return AH_ERR_IO;
    }
    for (nfds_t i = 0; i < count; i++) {
        if (pfd[i].revents != 0) {
            *ready |= bits[i];
        }
    }
    return AH_OK;
}

ah_status ah_proc_wait(ah_proc *p, bool block, bool *exited,
                       ah_proc_exit *st) {
    if (p == NULL || exited == NULL || st == NULL) {
        return AH_ERR_INVALID;
    }
    if (!p->exited) {
        int wst = 0;
        pid_t r;
        do {
            r = waitpid(p->pid, &wst, block ? 0 : WNOHANG);
        } while (r < 0 && errno == EINTR);
        if (r < 0) {
            return AH_ERR_IO;
        }
        if (r == 0) {
            *exited = false;
            return AH_OK;
        }
        if (WIFEXITED(wst)) {
            p->st.code = WEXITSTATUS(wst);
            p->st.signal = 0;
        } else if (WIFSIGNALED(wst)) {
            p->st.code = 0;
            p->st.signal = WTERMSIG(wst);
        } else {
            *exited = false; /* parado/continuado: não é fim */
            return AH_OK;
        }
        p->exited = true;
    }
    *exited = true;
    *st = p->st;
    return AH_OK;
}

ah_status ah_proc_kill(ah_proc *p) {
    if (p == NULL) {
        return AH_ERR_INVALID;
    }
    if (p->exited) {
        return AH_OK; /* já colhido: o PID pode ter sido reciclado */
    }
    if (kill(p->pid, SIGKILL) != 0 && errno != ESRCH) {
        return AH_ERR_IO;
    }
    return AH_OK;
}

ah_status ah_proc_resume(ah_proc *p) {
    (void)p;
    return AH_ERR_INVALID;
}

uint32_t ah_proc_pid(const ah_proc *p) {
    return p == NULL ? 0 : (uint32_t)p->pid;
}

intptr_t ah_proc_native_process(const ah_proc *p) {
    return p == NULL ? 0 : (intptr_t)p->pid;
}
