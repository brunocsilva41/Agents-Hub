/* Helper de integração (F0-11, plano docs/17): sobe um executável (no futuro,
 * o serviço C) totalmente isolado do Hub real do usuário.
 *
 * Garantias (CLAUDE.md, regras 1 e 2; docs/18 §12):
 * - home temporário próprio, criado do zero no diretório temporário do SO e
 *   removido no fim; nunca ~/.agents-hub nem o AGENTS_HUB_HOME do ambiente pai
 *   (nem dentro deles, nem acima deles);
 * - porta livre escolhida pelo SO em 127.0.0.1, nunca 4747 nem o
 *   AGENTS_HUB_PORT do ambiente pai;
 * - o filho recebe AGENTS_HUB_HOME, AGENTS_HUB_PORT e AGENTS_HUB_NO_AUTOSTART=1
 *   e NÃO herda nenhuma outra variável AGENTS_HUB_* do pai (ex.: AGENTS_HUB_URL
 *   apontaria o MCP para o daemon real; AGENTS_HUB_SESSION_ID, para uma sessão
 *   real). O resto do ambiente é herdado;
 * - o diretório de trabalho do filho é o home temporário.
 *
 * Chamadas de SO locais (Win32/POSIX): a camada native/src/platform/ está
 * sendo escrita em paralelo (F0-05/F0-07/F0-09). O que migra para ah_platform
 * está listado em ah_itest.c, no topo.
 *
 * Uso em uma thread só (o helper não protege estado global do Winsock). */
#ifndef AH_ITEST_H
#define AH_ITEST_H

#include <stddef.h>

#include "ah_status.h"

/* Porta do daemon real do usuário: o helper nunca a escolhe. */
#define AH_ITEST_FORBIDDEN_PORT 4747u

/* Tentativas de achar porta aceitável antes de desistir com AH_ERR_LIMIT. */
#define AH_ITEST_PORT_ATTEMPTS 64

typedef struct ah_itest_env ah_itest_env;
typedef struct ah_itest_proc ah_itest_proc;

/* Cria o ambiente isolado: home temporário novo e porta livre.
 * Posse: o chamador libera *out com ah_itest_env_destroy.
 * Erros: AH_ERR_INVALID (o diretório temporário do SO cai em ~/.agents-hub ou
 * no AGENTS_HUB_HOME do pai: nada é criado), AH_ERR_IO, AH_ERR_LIMIT (sem
 * porta aceitável), AH_ERR_NOMEM. Detalhe legível em err (pode ser NULL). */
ah_status ah_itest_env_create(ah_itest_env **out, char *err, size_t err_cap);

/* Caminho absoluto do home temporário (UTF-8, '/' ou '\\' conforme o SO).
 * Emprestado: vale até ah_itest_env_destroy. */
const char *ah_itest_env_home(const ah_itest_env *env);

/* Porta escolhida (1024..65535, nunca AH_ITEST_FORBIDDEN_PORT). */
unsigned ah_itest_env_port(const ah_itest_env *env);

/* Remove o home temporário (recursivo, sem seguir links/junções) e libera.
 * Os processos precisam ter sido liberados antes (no Windows um processo vivo
 * prende os arquivos). Devolve AH_ERR_IO se algo não pôde ser removido (a
 * memória é liberada mesmo assim). NULL é no-op (AH_OK). */
ah_status ah_itest_env_destroy(ah_itest_env *env);

typedef struct ah_itest_spawn_opts {
    const char *const *args; /* argv[1..] do filho (UTF-8); pode ser NULL se nargs == 0 */
    size_t nargs;
    /* Variáveis extras "NOME=valor" para o filho (substituem a herdada de
     * mesmo nome). Recusadas com AH_ERR_INVALID se o NOME for AGENTS_HUB_HOME,
     * AGENTS_HUB_PORT ou AGENTS_HUB_NO_AUTOSTART (sem diferença de caixa no
     * Windows): o isolamento não se negocia. */
    const char *const *extra_env;
    size_t n_extra_env;
} ah_itest_spawn_opts;

/* Ambiente completo que o filho receberia: lista de "NOME=valor" (UTF-8)
 * terminada por NULL, em *out, com *count entradas.
 * Posse: o chamador libera com ah_itest_strv_free. `opts` pode ser NULL. */
ah_status ah_itest_env_child_environ(const ah_itest_env *env,
                                     const ah_itest_spawn_opts *opts, char ***out,
                                     size_t *count);

/* Sobe `exe` (caminho do executável, UTF-8; emprestado) com o ambiente de
 * ah_itest_env_child_environ e cwd = home temporário. stdin/stdout/stderr do
 * filho não são capturados. Posse: o chamador libera *out com
 * ah_itest_proc_free (antes de ah_itest_env_destroy). */
ah_status ah_itest_spawn(const ah_itest_env *env, const char *exe,
                         const ah_itest_spawn_opts *opts, ah_itest_proc **out);

/* Espera o filho terminar (bloqueante, sem polling) e devolve o código de
 * saída. Morte por sinal (POSIX) vira 128 + sinal. */
ah_status ah_itest_proc_wait(ah_itest_proc *proc, int *exit_code);

/* Encerra o filho à força (TerminateProcess / SIGKILL). Não espera. */
ah_status ah_itest_proc_kill(ah_itest_proc *proc);

/* Encerra o filho se ainda estiver vivo, espera e libera. NULL é no-op. */
void ah_itest_proc_free(ah_itest_proc *proc);

/* Libera uma lista de ah_itest_env_child_environ. NULL é no-op. */
void ah_itest_strv_free(char **v);

/* ---------------------------------------------------------------------
 * Partes expostas para os testes do próprio helper e para os testes de
 * integração que precisam preparar o home. */

/* 1 se `path` é igual a, está dentro de, ou contém um caminho proibido:
 * ~/.agents-hub (perfil real do SO e as variáveis HOME/USERPROFILE/
 * HOMEDRIVE+HOMEPATH) ou o AGENTS_HUB_HOME do ambiente pai. Compara caminhos
 * canônicos (no Windows: absolutos, longos, sem diferença de caixa).
 * Em dúvida (falha ao canonizar), devolve 1. */
int ah_itest_path_is_forbidden(const char *path);

/* Fonte de porta candidata. A padrão (NULL) pede ao SO uma porta livre em
 * 127.0.0.1 (bind na porta 0). */
typedef ah_status (*ah_itest_port_source)(void *ctx, unsigned *port);

/* Escolhe porta: pede candidatas a `source` até AH_ITEST_PORT_ATTEMPTS vezes e
 * aceita a primeira em 1024..65535 que não seja AH_ITEST_FORBIDDEN_PORT nem o
 * AGENTS_HUB_PORT do ambiente pai. AH_ERR_LIMIT se nenhuma servir. */
ah_status ah_itest_pick_port(ah_itest_port_source source, void *ctx, unsigned *out);

/* Lê uma variável do ambiente do processo (UTF-8). AH_ERR_NOT_FOUND se não
 * existe; AH_ERR_LIMIT se não cabe em buf. */
ah_status ah_itest_getenv(const char *name, char *buf, size_t cap);

/* Define (value != NULL) ou remove (value == NULL) uma variável do ambiente
 * DESTE processo; serve para os testes simularem o ambiente pai. */
ah_status ah_itest_setenv(const char *name, const char *value);

/* Ambiente atual deste processo como lista "NOME=valor" terminada por NULL.
 * Posse: libere com ah_itest_strv_free. */
ah_status ah_itest_environ_snapshot(char ***out, size_t *count);

/* Cria um diretório (o pai precisa existir). */
ah_status ah_itest_make_dir(const char *path);

/* 1 se o caminho existe (arquivo ou diretório). */
int ah_itest_path_exists(const char *path);

#endif /* AH_ITEST_H */
