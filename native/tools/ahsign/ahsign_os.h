/* Chamadas ao SO da ferramenta ahsign (F8-05) que ainda não têm API em
 * native/src/platform/ (docs/18 §7).
 *
 * - Aleatoriedade: NÃO fica aqui; vem de ah_platform_random_bytes (F0-06).
 * - Arquivos, caminhos UTF-8 ↔ UTF-16 e argumentos: TEMPORÁRIO, migram para a
 *   API ah_platform_fs da F0-05 (escrita com AH_PLATFORM_FS_PRIVATE) quando
 *   ela estiver na main.
 * - Terminal sem eco: lacuna: sem área em platform/ no plano; fica aqui até
 *   o plano dar um dono.
 *
 * Caminhos e texto são UTF-8; a conversão para UTF-16 acontece só aqui. */
#ifndef AHSIGN_OS_H
#define AHSIGN_OS_H

#include <stddef.h>
#include <stdint.h>

#include "ah_status.h"

/* Maior senha aceita, em bytes UTF-8 (sem o terminador). */
#define AHSIGN_PASSWORD_MAX 1024u

/* Lê uma senha. `buf` (do chamador, cap ≥ AHSIGN_PASSWORD_MAX + 1) recebe a
 * senha com NUL; o chamador a apaga com crypto_wipe. Nunca de argv nem de
 * variável de ambiente.
 *   from_stdin != 0: primeira linha do descritor 0, lida byte a byte sem o
 *     buffer da CRT (nada além do LF fica em memória); stdin que é terminal
 *     é recusado com AH_ERR_INVALID (lá a senha apareceria com eco).
 *   from_stdin == 0: do terminal, sem eco, depois de mostrar `prompt`; sem
 *     terminal → AH_ERR_IO. Ctrl+C durante a leitura restaura o modo do
 *     terminal antes de o processo terminar. Linha longa é drenada até o LF.
 * Senha vazia → AH_ERR_INVALID; maior que AHSIGN_PASSWORD_MAX → AH_ERR_LIMIT. */
ah_status ahsign_os_read_password(int from_stdin, const char *prompt, char *buf,
                                  size_t cap, size_t *len_out);

/* Cria `path` (não pode existir) e grava `data`. O arquivo nasce privado:
 * Windows, DACL protegida (sem herança) com uma única entrada, acesso total
 * para o SID do usuário do processo; POSIX, modo 0600 e sem seguir link
 * simbólico. Em mídia sem ACL (FAT/exFAT) o Windows ignora a DACL. Se a
 * gravação falhar no meio, apaga o arquivo. */
ah_status ahsign_os_write_new_file(const char *path, const uint8_t *data, size_t size);

/* *out = 1 se o arquivo é privado no sentido de ahsign_os_write_new_file
 * (Windows: DACL protegida com uma só entrada de acesso, para o SID do
 * usuário; POSIX: sem nenhum bit de grupo/outros), 0 se não. */
ah_status ahsign_os_file_is_private(const char *path, int *out);

/* POSIX: 1 se a pasta que contém `path` aceita escrita de grupo ou outros
 * (quem escreve ali pode trocar o arquivo da chave). Windows: sempre 0 (a
 * conferência equivalente por DACL fica para a API da F0-05). Erro → 0. */
int ahsign_os_parent_writable_by_others(const char *path);

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
