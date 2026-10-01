/* Interno da área de processos (F0-07): compartilhado entre
 * ah_platform_proc_common.c e as implementações por SO. Não é API pública. */
#ifndef AH_PLATFORM_PROC_INTERNAL_H
#define AH_PLATFORM_PROC_INTERNAL_H

#include <stdbool.h>
#include <stddef.h>

#include "ah_platform_proc.h"

/* Valida UTF-8 estrito (sem overlong, sem surrogates, até U+10FFFF) e conta
 * as unidades UTF-16 equivalentes. UTF-8 inválido → AH_ERR_INVALID. */
ah_status ah_proc_i_utf16_units(const char *s, size_t len, size_t *units);

/* Caminho absoluto na regra do Windows: "X:\" ou "X:/", ou dois separadores
 * no início (UNC, \\?\, \\.\). "C:x" e "\x" dependem do diretório/drive
 * corrente e NÃO são absolutos (SPEC-08 P1). */
bool ah_proc_i_win_is_absolute(const char *path);

/* Último componente do caminho termina em .bat/.cmd (sem diferenciar
 * maiúsculas), depois de remover '.' e ' ' finais, que o Win32 descarta. */
bool ah_proc_i_win_is_batch(const char *path);

/* Último componente contém ':' (fluxo alternativo NTFS, "x.cmd::$DATA"). */
bool ah_proc_i_win_name_has_colon(const char *path);

/* Tamanho do argumento i (arg_lens opcional) e checagem de NUL embutido. */
ah_status ah_proc_i_arg(const char *const *args, const size_t *arg_lens,
                        size_t i, const char **s, size_t *len);

/* Escreve o motivo em `detail` (se houver), sempre terminado em NUL. */
void ah_proc_i_detail(char *detail, size_t cap, const char *fmt, ...);

/* Posição do '=' que separa nome e valor numa entrada "NOME=valor". No
 * Windows existem nomes que começam com '=' ("=C:=C:\x"), por isso a busca
 * começa no 2º byte. Sem '=' válido → AH_ERR_INVALID. */
ah_status ah_proc_i_env_split(const char *entry, size_t *name_len);

#ifdef _WIN32
/* B7: lock da janela em que existem handles herdáveis do Hub (entre marcar
 * as pontas do filho herdáveis e fechá-las depois do CreateProcessW).
 * Qualquer código de native/src/platform/ que venha a chamar CreateProcessW
 * com bInheritHandles=TRUE fora de ah_proc_spawn precisa segurar este lock
 * (o caminho preferido é usar ah_proc_spawn). */
void ah_proc_i_spawn_lock(void);
void ah_proc_i_spawn_unlock(void);
#endif

#endif /* AH_PLATFORM_PROC_INTERNAL_H */
