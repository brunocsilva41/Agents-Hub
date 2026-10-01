/* Processos: spawn sem shell, três pipes, cwd, ambiente explícito, espera e
 * kill (tarefa F0-07, plano docs/17; SPEC-04 B4 passo 4, B5 e B6
 * `opcoesDeGrupo`; SPEC-08 P1, P2, P3, P4).
 *
 * Garantias do spawn (ah_proc_spawn):
 * - Nunca usa shell nem busca de executável: `path` precisa ser ABSOLUTO
 *   (SPEC-08 P1, SEC-R26). Caminho relativo, "C:x" e "\x" são recusados com
 *   AH_ERR_INVALID; o diretório corrente nunca entra.
 * - Windows: a linha de comando é montada por UMA função (ah_proc_win_command_line)
 *   com as aspas do CommandLineToArgvW, teto de 32.767 unidades UTF-16
 *   (SPEC-08 P3). `.bat`/`.cmd` só passam pelo ramo explícito `via_cmd`
 *   (`cmd.exe /d /s /c "<linha>"` com o escape duplo de escaparArgParaCmd,
 *   SPEC-04 B5, SPEC-08 P2, SEC-R27); entregá-los por outro caminho é recusado.
 *   Janela oculta (CREATE_NO_WINDOW + SW_HIDE). O filho herda SÓ os três pipes
 *   (STARTUPINFOEX + PROC_THREAD_ATTRIBUTE_HANDLE_LIST, SPEC-08 P4, SEC-R28).
 * - POSIX: fork + execve, filho num grupo de processos próprio
 *   (setpgid(0,0), equivalente ao `detached: true` do TS), descritores acima
 *   de 2 fechados no filho antes do exec e todos os do Hub com O_CLOEXEC
 *   (SPEC-08 P4). NÃO VERIFICADO nesta tarefa (sem máquina POSIX).
 *
 * Texto: toda string é UTF-8 (docs/18 §9). No Windows a conversão para
 * UTF-16 acontece aqui dentro; UTF-8 inválido é recusado com AH_ERR_INVALID.
 * No POSIX os bytes passam como estão.
 *
 * E/S não bloqueante (contrato para o laço da F0-09):
 * - ah_proc_read / ah_proc_write nunca bloqueiam. Devolvem AH_OK e um estado:
 *   AH_PROC_IO_DATA (houve progresso), AH_PROC_IO_AGAIN (nada agora: espere o
 *   "waitable" do fluxo) ou AH_PROC_IO_EOF (só leitura: o filho fechou).
 * - ah_proc_waitable entrega o objeto nativo que fica sinalizado quando vale
 *   a pena chamar de novo: Windows, um HANDLE de evento manual (aguardável
 *   com WaitForMultipleObjects); POSIX, o descritor (poll: POLLIN/POLLOUT).
 *   O aviso pode ser espúrio: chame read/write até receber AGAIN antes de
 *   voltar a esperar (mesma regra de socket não bloqueante).
 * - Para quem não tem laço (probe, testes), ah_proc_wait_io espera os pipes
 *   do próprio processo com timeout, sem polling.
 *
 * Ponto de extensão para a F0-08 (Job Object): `start_suspended` cria o
 * processo suspenso no Windows; o chamador obtém o HANDLE com
 * ah_proc_native_process, o põe no Job e chama ah_proc_resume.
 *
 * Fios: um ah_proc não é seguro para uso simultâneo por duas threads. */
#ifndef AH_PLATFORM_PROC_H
#define AH_PLATFORM_PROC_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "ah_status.h"

/* Teto da linha de comando do CreateProcessW, em unidades UTF-16, sem o NUL
 * final (SPEC-08 P3). */
#define AH_PROC_WIN_MAX_CMDLINE 32767
/* Teto da linha do cmd.exe (CMD_MAX_LINHA, bin-resolver.ts:347). A regra do
 * TS é `linha + 16 > 8191` → recusa (SPEC-04 B5). */
#define AH_PROC_CMD_MAX_LINE 8191

typedef struct ah_proc ah_proc;

typedef enum ah_proc_stream {
    AH_PROC_STDIN = 0,
    AH_PROC_STDOUT = 1,
    AH_PROC_STDERR = 2
} ah_proc_stream;

/* Máscara para ah_proc_wait_io. */
#define AH_PROC_MASK_STDIN (1u << AH_PROC_STDIN)
#define AH_PROC_MASK_STDOUT (1u << AH_PROC_STDOUT)
#define AH_PROC_MASK_STDERR (1u << AH_PROC_STDERR)

typedef enum ah_proc_io {
    AH_PROC_IO_DATA = 0,
    AH_PROC_IO_AGAIN,
    AH_PROC_IO_EOF
} ah_proc_io;

typedef struct ah_proc_spawn_opts {
    /* Executável, UTF-8, absoluto (obrigatório). */
    const char *path;
    /* Argumentos depois do programa (o argv[0] do filho é `path`). Podem ser
     * NULL quando arg_count == 0. `arg_lens` é opcional: com ele, cada
     * argumento tem tamanho explícito e um NUL embutido é recusado
     * (AH_ERR_INVALID) em vez de truncar o argumento em silêncio
     * (SPEC-08 P3); sem ele, vale strlen. */
    const char *const *args;
    const size_t *arg_lens;
    size_t arg_count;
    /* Diretório de trabalho, UTF-8; NULL herda o do Hub. */
    const char *cwd;
    /* Ambiente explícito: `env_count` entradas "NOME=valor" em UTF-8. Com
     * env == NULL o filho herda o ambiente do Hub; com env != NULL ele recebe
     * EXATAMENTE essas entradas (env_count pode ser 0). Entrada sem '=' (ou
     * com nome vazio) e nome repetido (sem diferenciar maiúsculas no
     * Windows) são recusados com AH_ERR_INVALID. No Windows o bloco é
     * ordenado por nome sem diferenciar maiúsculas, como o SO pede. */
    const char *const *env;
    size_t env_count;
    /* Windows: entrega `path` (.cmd/.bat) pelo ramo explícito
     * `<ComSpec> /d /s /c "<linha>"` (SPEC-04 B5). ComSpec é usado só se for
     * absoluto e terminar em .exe; senão, <GetSystemDirectory>\cmd.exe.
     * `path` precisa terminar em .cmd/.bat. POSIX: recusado (AH_ERR_INVALID). */
    bool via_cmd;
    /* Windows: cria o processo suspenso (ver ah_proc_resume). POSIX:
     * recusado (AH_ERR_INVALID). */
    bool start_suspended;
} ah_proc_spawn_opts;

typedef struct ah_proc_exit {
    /* Windows: o código devolvido por GetExitCodeProcess (0..4294967295,
     * como o Node). POSIX: WEXITSTATUS quando o filho saiu normalmente. */
    int64_t code;
    /* POSIX: número do sinal que terminou o filho (0 se saiu normalmente).
     * Windows: sempre 0. */
    int signal;
} ah_proc_exit;

/* Inicia um processo conforme `opts` (emprestado: só lido durante a
 * chamada). Posse: o chamador libera *out com ah_proc_free.
 * `detail`/`detail_cap` (opcionais) recebem, em caso de erro, um motivo em
 * português, sempre terminado em NUL e truncado ao tamanho do buffer.
 * Erros: AH_ERR_INVALID (caminho relativo, .bat/.cmd fora de via_cmd, NUL
 * embutido, UTF-8 inválido, \r ou \n no ramo cmd, env malformado),
 * AH_ERR_LIMIT (linha acima de AH_PROC_WIN_MAX_CMDLINE ou do teto do cmd),
 * AH_ERR_NOT_FOUND (executável ou cwd inexistente), AH_ERR_IO, AH_ERR_NOMEM. */
ah_status ah_proc_spawn(const ah_proc_spawn_opts *opts, ah_proc **out,
                        char *detail, size_t detail_cap);

/* Lê até `cap` bytes de stdout ou stderr sem bloquear. Com AH_PROC_IO_DATA,
 * *n > 0. `stream` = AH_PROC_STDIN é AH_ERR_INVALID. */
ah_status ah_proc_read(ah_proc *p, ah_proc_stream stream, void *buf,
                       size_t cap, size_t *n, ah_proc_io *state);

/* Escreve no stdin do filho sem bloquear. Com AH_PROC_IO_DATA, *accepted
 * bytes de `buf` foram aceitos (podem ser menos que `len`; o resto é para a
 * próxima chamada). Windows: os bytes aceitos ficam numa escrita em curso
 * (o Hub guarda a cópia); `ah_proc_write(p, NULL, 0, ...)` devolve
 * AH_PROC_IO_DATA quando não há escrita em curso e AH_PROC_IO_AGAIN enquanto
 * houver. Filho que fechou o stdin → AH_ERR_IO.
 * POSIX: o processo precisa ignorar SIGPIPE (responsabilidade de quem inicia
 * o daemon); sem isso, escrever num pipe fechado mata o Hub. */
ah_status ah_proc_write(ah_proc *p, const void *buf, size_t len,
                        size_t *accepted, ah_proc_io *state);

/* Fecha o stdin do filho (EOF para ele). Windows: se houver escrita em curso,
 * espera ela terminar antes de fechar (bloqueia); para não bloquear, chame
 * antes ah_proc_write(p, NULL, 0, ...) até ele devolver AH_PROC_IO_DATA.
 * Fechar de novo é no-op. */
ah_status ah_proc_close_stdin(ah_proc *p);

/* Objeto nativo aguardável do fluxo (ver o contrato no topo). *out recebe o
 * HANDLE (Windows) ou o descritor (POSIX) convertido para intptr_t. É
 * emprestado: continua do ah_proc. Fluxo já fechado → AH_ERR_NOT_FOUND. */
ah_status ah_proc_waitable(const ah_proc *p, ah_proc_stream stream,
                           intptr_t *out);

/* Espera, por até `timeout_ms` (< 0 = sem limite; 0 = só consulta), até que
 * algum fluxo de `mask` esteja pronto para read/write. *ready recebe a
 * máscara dos prontos (0 = estourou o tempo). Fluxos já fechados contam
 * como prontos (read devolve EOF; write, AH_ERR_IO), para o chamador não
 * ficar preso. */
ah_status ah_proc_wait_io(ah_proc *p, unsigned mask, int32_t timeout_ms,
                          unsigned *ready);

/* Espera o fim do processo. block = false só consulta. *exited diz se ele
 * terminou; se sim, *st recebe o código/sinal (repetível depois do fim). */
ah_status ah_proc_wait(ah_proc *p, bool block, bool *exited,
                       ah_proc_exit *st);

/* Mata SÓ o processo (a árvore é a F0-08). Windows: TerminateProcess com
 * código 1, como o Node. POSIX: SIGKILL ao PID. Processo já terminado e
 * colhido → AH_OK sem efeito (nunca sinaliza um PID reciclado). */
ah_status ah_proc_kill(ah_proc *p);

/* Retoma um processo criado com start_suspended (Windows). Sem processo
 * suspenso → AH_ERR_INVALID. */
ah_status ah_proc_resume(ah_proc *p);

/* PID do filho. */
uint32_t ah_proc_pid(const ah_proc *p);

/* Windows: HANDLE do processo (emprestado; vale até ah_proc_free), para a
 * F0-08 associar a um Job Object. POSIX: o PID. */
intptr_t ah_proc_native_process(const ah_proc *p);

/* Fecha pipes e handles e libera `p`. Não mata nem espera o processo:
 * chame ah_proc_wait antes (no POSIX, sem isso fica um zumbi). E/S em curso
 * é cancelada. NULL é no-op. */
void ah_proc_free(ah_proc *p);

/* --- Montagem de linha (funções puras, sem SO; compilam em toda plataforma,
 * para testes e para a conformidade com o TS) --- */

/* P3: linha de comando do Windows para `program` + `args`, em UTF-8, com as
 * aspas que o CommandLineToArgvW desfaz: `program` entre aspas (não pode
 * conter '"'); cada argumento como no libuv/Node (sem aspas se não tiver
 * espaço, tab nem '"'; vazio vira ""; barras antes de '"' dobradas).
 * `arg_lens` opcional como em ah_proc_spawn_opts. Recusa NUL embutido e
 * UTF-8 inválido (AH_ERR_INVALID) e linha acima de AH_PROC_WIN_MAX_CMDLINE
 * unidades UTF-16 (AH_ERR_LIMIT). Posse: o chamador libera *out com free(). */
ah_status ah_proc_win_command_line(const char *program,
                                   const char *const *args,
                                   const size_t *arg_lens, size_t arg_count,
                                   char **out);

/* escaparArgParaCmd (bin-resolver.ts:366-386): aspas do CommandLineToArgvW
 * (sempre entre aspas) e depois `^` antes de cada metacaractere
 * ( ) [ ] % ! ^ " ` < > & | ; , espaço * ? — duas vezes. \r, \n ou NUL →
 * AH_ERR_INVALID. Posse: o chamador libera *out com free(). */
ah_status ah_proc_cmd_escape_arg(const char *arg, size_t len, char **out);

/* A `<linha>` de montarSpawn (bin-resolver.ts:420-427): `command` com um `^`
 * antes de cada metacaractere, seguido dos argumentos escapados por
 * ah_proc_cmd_escape_arg, separados por espaço. Linha (em unidades UTF-16)
 * + 16 > AH_PROC_CMD_MAX_LINE → AH_ERR_LIMIT. Posse: free(). */
ah_status ah_proc_cmd_line(const char *command, const char *const *args,
                           const size_t *arg_lens, size_t arg_count,
                           char **out);

#endif /* AH_PLATFORM_PROC_H */
