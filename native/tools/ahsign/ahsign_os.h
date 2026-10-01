/* Chamadas ao SO da ferramenta ahsign (F8-05).
 *
 * TEMPORÁRIO: docs/18 §7 manda toda chamada de SO para native/src/platform/.
 * A aleatoriedade e o usuário/terminal são da área F0-06 (ah_platform_time),
 * ainda inexistente; no merge, ahsign_os_random e a leitura de senha migram
 * para lá e este arquivo encolhe para o que sobrar (ou some).
 *
 * Caminhos e texto são UTF-8; a conversão para UTF-16 acontece só aqui. */
#ifndef AHSIGN_OS_H
#define AHSIGN_OS_H

#include <stddef.h>
#include <stdint.h>

#include "ah_status.h"

/* Maior senha aceita, em bytes UTF-8 (sem o terminador). */
#define AHSIGN_PASSWORD_MAX 1024u

/* Enche buf com `size` bytes do gerador criptográfico do SO
 * (BCryptGenRandom no Windows, getrandom no Linux). */
ah_status ahsign_os_random(uint8_t *buf, size_t size);

/* Lê uma senha. from_stdin != 0: a primeira linha de stdin (sem o LF/CRLF).
 * Senão: do terminal, sem eco, depois de mostrar `prompt` no terminal; sem
 * terminal → AH_ERR_IO. Nunca de argv nem de variável de ambiente.
 * `buf` (do chamador, cap ≥ AHSIGN_PASSWORD_MAX + 1) recebe a senha com NUL;
 * o chamador a apaga com crypto_wipe. Senha vazia → AH_ERR_INVALID; maior que
 * AHSIGN_PASSWORD_MAX → AH_ERR_LIMIT. */
ah_status ahsign_os_read_password(int from_stdin, const char *prompt, char *buf,
                                  size_t cap, size_t *len_out);

/* Cria `path` (não pode existir) e grava `data`. No POSIX, modo 0600 e sem
 * seguir link simbólico. Se a gravação falhar no meio, apaga o arquivo. */
ah_status ahsign_os_write_new_file(const char *path, const uint8_t *data, size_t size);

/* 1 se `path` existe (arquivo, diretório ou link), 0 se não. Só para avisar
 * cedo, antes de pedir a senha; a garantia contra sobrescrever é a criação
 * exclusiva de ahsign_os_write_new_file. */
int ahsign_os_exists(const char *path);

/* Lê o arquivo inteiro para memória. Posse: o chamador libera *out com free().
 * Maior que `max` bytes → AH_ERR_LIMIT. */
ah_status ahsign_os_read_file(const char *path, size_t max, uint8_t **out,
                              size_t *size_out);

/* Argumentos da linha de comando em UTF-8. No Windows relê a linha de comando
 * em UTF-16 (o argv do main vem na página de código ANSI); no POSIX devolve o
 * próprio argv. Posse: libere com ahsign_os_free_args(*argc_out, *out). */
ah_status ahsign_os_args_utf8(int argc, char **argv, int *argc_out, char ***out);
void ahsign_os_free_args(int argc, char **args);

#endif /* AHSIGN_OS_H */
