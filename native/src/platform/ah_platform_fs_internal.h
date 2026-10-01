/* Uso interno da área de arquivos de ah_platform (F0-05): funções portáveis
 * de ah_platform_fs.c usadas pelas implementações por SO
 * (ah_platform_fs_win.c, ah_platform_fs_posix.c). Não incluir fora de
 * native/src/platform/. Posse: igual a ah_platform_fs.h (malloc/free). */
#ifndef AH_PLATFORM_FS_INTERNAL_H
#define AH_PLATFORM_FS_INTERNAL_H

#include <stddef.h>

#include "ah_status.h"

/* Normaliza `path` (mesmas regras de ah_platform_path_normalize) e devolve
 * também o tamanho da raiz no resultado ("/" = 1, "C:\" = 3, relativo = 0).
 * `root_len` pode ser NULL. */
ah_status ah_platform_fs_normalize_ex(const char *path, char **out,
                                      size_t *root_len);

/* Diretório pai de `path`, já normalizado: "a/b" -> "a"; "b" -> ".";
 * "/" -> "/"; "C:\x" -> "C:\". */
ah_status ah_platform_fs_dirname(const char *path, char **out);

/* Monta `<path>.tmp-<pid>-<nonce em hex>`, o nome do temporário da escrita
 * atômica (SPEC-02 §6: `*.tmp-<pid>-…`). */
ah_status ah_platform_fs_tmp_name(const char *path, unsigned long pid,
                                  unsigned long long nonce, char **out);

#endif /* AH_PLATFORM_FS_INTERNAL_H */
