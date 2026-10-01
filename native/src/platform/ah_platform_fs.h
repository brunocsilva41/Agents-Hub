/* Plataforma: texto, caminhos e arquivos (tarefa F0-05, plano docs/17).
 *
 * Todo caminho e todo texto que entram ou saem destas funções são UTF-8
 * (docs/18 §9). A conversão para UTF-16 acontece só aqui dentro, na fronteira
 * da chamada Win32.
 *
 * Permissões (ADR 09: DV-32 e DV-33; SPEC-08 SEC-R15 e SEC-R16):
 * - POSIX: diretórios criados com 0700, arquivos privados com 0600, e
 *   umask(077) aplicado por ah_platform_fs_init.
 * - Windows: DACL protegida (sem herança) com uma única ACE que dá controle
 *   total ao SID do usuário do processo, aplicada já na criação do objeto,
 *   pelas APIs de segurança Win32 (nada de icacls nem de principal por nome).
 *
 * Posse de memória: toda string ou buffer devolvido por parâmetro de saída é
 * alocado com malloc e passa a ser do chamador, que libera com free(). Em
 * caso de erro, *out fica NULL. Parâmetros de entrada são emprestados: só são
 * lidos durante a chamada. */
#ifndef AH_PLATFORM_FS_H
#define AH_PLATFORM_FS_H

#include <stdbool.h>
#include <stddef.h>

#include "ah_status.h"

#if defined(_WIN32)
#include <wchar.h>
#endif

/* Inicializa a camada de arquivos. Chamar uma vez, no início do processo,
 * antes de criar qualquer arquivo. POSIX: umask(077), para que tudo o que o
 * processo criar (inclusive o banco e os logs) nasça sem acesso de grupo e
 * de outros (SPEC-08 V5). Windows: nada a fazer; devolve AH_OK. */
ah_status ah_platform_fs_init(void);

#if defined(_WIN32)
/* UTF-8 -> UTF-16 (terminado em L'\0'). UTF-8 inválido -> AH_ERR_INVALID.
 * Posse: *out é do chamador (free). */
ah_status ah_platform_utf8_to_utf16(const char *utf8, wchar_t **out);

/* UTF-16 -> UTF-8 (terminado em '\0'). Surrogate isolado -> AH_ERR_INVALID.
 * Posse: *out é do chamador (free). */
ah_status ah_platform_utf16_to_utf8(const wchar_t *utf16, char **out);
#endif

/* Separador nativo de caminho: '\\' no Windows, '/' no POSIX. */
#if defined(_WIN32)
#define AH_PLATFORM_PATH_SEP '\\'
#else
#define AH_PLATFORM_PATH_SEP '/'
#endif

/* Normaliza `path` de forma puramente léxica (não consulta o disco):
 * separadores repetidos viram um só, componentes "." somem, ".." remove o
 * componente anterior (acima da raiz de um caminho absoluto é descartado; num
 * caminho relativo é mantido). O separador de saída é o nativo; no Windows,
 * '/' e '\\' são aceitos na entrada. Raízes preservadas: "/" (POSIX); "X:\",
 * "X:", "\" e "\\servidor\compartilhamento\" (Windows). Caminhos Windows com
 * prefixo "\\?\" ou "\\.\" são devolvidos sem mudança. Separador final é
 * removido, exceto na raiz. Resultado vazio vira ".".
 * Posse: *out é do chamador (free). */
ah_status ah_platform_path_normalize(const char *path, char **out);

/* Junta `a` e `b` com o separador nativo e normaliza o resultado (como
 * path.join do Node: `b` absoluto NÃO substitui `a`). Vazios são ignorados.
 * Posse: *out é do chamador (free). */
ah_status ah_platform_path_join(const char *a, const char *b, char **out);

/* Cria o diretório `path` e os pais que faltarem. Cada diretório CRIADO nasce
 * privado: 0700 no POSIX; no Windows, DACL protegida só com o SID do usuário,
 * herdável por arquivos e subpastas. Diretórios que já existem não são
 * alterados (use ah_platform_fs_restrict). Um componente que existe e não é
 * diretório -> AH_ERR_IO. */
ah_status ah_platform_fs_mkdirs(const char *path);

/* Opções de ah_platform_fs_write_atomic. */
enum {
    /* Arquivo privado: 0600 no POSIX; DACL protegida só com o SID do
     * usuário no Windows. Aplicado ao temporário NA CRIAÇÃO, antes de
     * qualquer byte ser escrito, e herdado pelo nome final no rename. Sem
     * esta opção o arquivo herda as permissões da pasta (Windows) ou
     * 0666 & ~umask (POSIX), como o gravarAtomico do TS. */
    AH_PLATFORM_FS_PRIVATE = 1u << 0
};

/* Grava `len` bytes de `data` em `path` de forma atômica (espelha o
 * gravarAtomico de packages/daemon/src/safe-write.ts): cria a pasta pai se
 * faltar (ah_platform_fs_mkdirs), escreve num temporário exclusivo no MESMO
 * diretório, `<path>.tmp-<pid>-<aleatório>`, força os dados ao disco
 * (FlushFileBuffers / fsync) e faz rename por cima de `path`. Quem lê `path`
 * vê o conteúdo antigo ou o novo inteiro, nunca um parcial. Em qualquer falha
 * o temporário é removido e `path` fica como estava. `flags` é uma
 * combinação de AH_PLATFORM_FS_*; `data` pode ser NULL se `len` == 0. */
ah_status ah_platform_fs_write_atomic(const char *path, const void *data,
                                      size_t len, unsigned flags);

/* Lê o arquivo inteiro. Mais de `max_bytes` bytes -> AH_ERR_LIMIT (nada é
 * devolvido). Arquivo inexistente -> AH_ERR_NOT_FOUND. O buffer tem um '\0'
 * extra depois dos dados (não contado em *out_len), para uso como texto.
 * Posse: *out é do chamador (free). */
ah_status ah_platform_fs_read_all(const char *path, size_t max_bytes,
                                  char **out, size_t *out_len);

/* Restringe um arquivo ou diretório existente ao usuário do processo:
 * POSIX 0600 (arquivo) ou 0700 (diretório), recusando link simbólico com
 * AH_ERR_INVALID; Windows, troca a DACL pela DACL protegida só com o SID do
 * usuário (em diretório, a ACE é herdável). */
ah_status ah_platform_fs_restrict(const char *path);

/* Confere se `path` está restrito ao usuário do processo. *restricted fica
 * true só se: POSIX, não é link simbólico, o dono é o usuário efetivo e não
 * há nenhum bit de grupo/outros; Windows, a DACL existe, é protegida (sem
 * herança), não tem ACE herdada e toda ACE é de permissão para o SID do
 * usuário (pelo menos uma). Erro de leitura -> status != AH_OK. */
ah_status ah_platform_fs_check_restricted(const char *path, bool *restricted);

/* Resolve o home do Hub (SPEC-02 §1; daemon/src/config.ts defaultHome):
 * AGENTS_HUB_HOME, se definida (devolvida como está); definida e vazia ->
 * AH_ERR_INVALID (hub-env.ts valida string não vazia); senão
 * <home do usuário>/.agents-hub, com o home do usuário vindo de USERPROFILE
 * (Windows) ou HOME (POSIX) e, na falta deles, do perfil do usuário no SO.
 * Não cria nada no disco. Posse: *out é do chamador (free). */
ah_status ah_platform_fs_resolve_home(char **out);

#endif /* AH_PLATFORM_FS_H */
