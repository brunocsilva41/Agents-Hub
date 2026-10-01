/* Núcleo da ferramenta ahsign (F8-05): arquivo de chave privada cifrado com
 * senha (opção O2 da proposta F8-04 §4, adotada pelo ADR 09 §9.7), assinatura
 * do envelope do manifesto e exportação da chave pública como inicializador C.
 *
 * Sem I/O: tudo em memória, para ser testado sem disco nem terminal. A
 * aleatoriedade (sal, nonce, semente) vem do chamador (ah_platform_random_bytes).
 *
 * Arquivo de chave (AHSIGN_KEY_FILE_SIZE bytes, inteiros little-endian):
 *
 *   off  tam  campo
 *     0   24  cabeçalho fixo (ahsign_key_file_magic), para o grep de vazamento
 *    24    1  LF
 *    25    4  nb_blocks do Argon2id (KiB de memória)
 *    29    4  nb_passes do Argon2id
 *    33   16  sal do Argon2id
 *    49   24  nonce do XChaCha20-Poly1305 (crypto_aead_lock)
 *    73   32  chave pública Ed25519 (em claro)
 *   105   16  MAC
 *   121   32  semente Ed25519 cifrada
 *
 * Dados associados do AEAD = bytes 0..104: a senha também autentica o cabeçalho,
 * os parâmetros do Argon2 e a chave pública. */
#ifndef AHSIGN_KEY_H
#define AHSIGN_KEY_H

#include <stddef.h>
#include <stdint.h>

#include "ah_status.h"

/* O texto do cabeçalho fica só em ahsign_key.c (o teste de vazamento, T14,
 * aceita a constante literal apenas nesse arquivo). Sem terminador. */
extern const char ahsign_key_file_magic[];
#define AHSIGN_KEY_FILE_MAGIC_SIZE 24u

#define AHSIGN_SEED_SIZE 32u
#define AHSIGN_SALT_SIZE 16u
#define AHSIGN_NONCE_SIZE 24u
#define AHSIGN_SECRET_KEY_SIZE 64u /* formato do Monocypher: semente || pública */
#define AHSIGN_KEY_FILE_SIZE 153u
#define AHSIGN_KEY_FILE_PUBLIC_OFFSET 73u /* chave pública em claro */

/* Custo do Argon2id. nb_blocks em KiB; o Monocypher roda uma faixa só (lanes = 1). */
typedef struct ahsign_kdf {
    uint32_t nb_blocks;
    uint32_t nb_passes;
} ahsign_kdf;

/* Custo usado pela linha de comando ao gerar uma chave. */
extern const ahsign_kdf ahsign_kdf_default;

/* Faixa aceita ao gravar e ao ler (o teto evita que um arquivo peça memória absurda). */
#define AHSIGN_KDF_MIN_BLOCKS 8u
#define AHSIGN_KDF_MAX_BLOCKS (1024u * 1024u) /* 1 GiB */
#define AHSIGN_KDF_MIN_PASSES 1u
#define AHSIGN_KDF_MAX_PASSES 64u

/* Cifra `seed` com a senha e produz o arquivo de chave em `out`.
 * Tudo emprestado. A semente e a senha não são alteradas (o chamador as apaga).
 *   AH_ERR_INVALID senha vazia/maior que 1024 bytes ou kdf fora da faixa;
 *   AH_ERR_NOMEM   sem memória para o Argon2. */
ah_status ahsign_key_seal(const uint8_t seed[AHSIGN_SEED_SIZE], const uint8_t *password,
                          size_t password_size, ahsign_kdf kdf,
                          const uint8_t salt[AHSIGN_SALT_SIZE],
                          const uint8_t nonce[AHSIGN_NONCE_SIZE],
                          uint8_t out[AHSIGN_KEY_FILE_SIZE]);

/* Abre o arquivo de chave. Com AH_OK, secret_key (64 bytes, apagar com
 * crypto_wipe depois do uso) e public_key ficam preenchidos, e *kdf_out (se
 * não NULL) recebe o custo do Argon2 gravado no arquivo, para o chamador
 * avisar quando ele está abaixo de ahsign_kdf_default (ahsign_kdf_is_weak).
 *   AH_ERR_INVALID formato errado, senha errada ou arquivo adulterado
 *                  (indistinguíveis de propósito);
 *   AH_ERR_NOMEM   sem memória para o Argon2. */
ah_status ahsign_key_open(const uint8_t *file, size_t file_size, const uint8_t *password,
                          size_t password_size, uint8_t secret_key[AHSIGN_SECRET_KEY_SIZE],
                          uint8_t public_key[32], ahsign_kdf *kdf_out);

/* 1 se `kdf` custa menos que ahsign_kdf_default em memória ou em passadas. */
int ahsign_kdf_is_weak(ahsign_kdf kdf);

/* Assina `body` e monta o envelope (cabeçalho de ah_update_verify.h + corpo).
 * Antes de devolver, verifica o próprio envelope com ah_update_verify.
 * Posse: o chamador libera *out com free().
 *   AH_ERR_INVALID corpo vazio; AH_ERR_LIMIT corpo maior que AH_UPDATE_BODY_MAX. */
ah_status ahsign_sign_envelope(const uint8_t secret_key[AHSIGN_SECRET_KEY_SIZE],
                               const uint8_t *body, size_t body_size, uint8_t **out,
                               size_t *out_size);

/* Escreve em `out` (texto com NUL) o inicializador C de um ah_update_key para
 * a chave pública, com o key_id calculado. `name` só rotula o comentário:
 * [A-Za-z0-9_], 1 a 64 caracteres.
 *   AH_ERR_INVALID nome inválido; AH_ERR_LIMIT `out` pequeno demais. */
ah_status ahsign_format_c_key(const uint8_t public_key[32], const char *name, char *out,
                              size_t out_cap);

#endif /* AHSIGN_KEY_H */
