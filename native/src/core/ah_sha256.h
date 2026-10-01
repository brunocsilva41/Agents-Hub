/* SHA-256 (FIPS 180-4), sem I/O (plano docs/17, F1-01).
 *
 * Existe porque o `objectiveHash` do domínio é um SHA-256
 * (core/src/ids.ts:28, `createHash('sha256')`) e nenhuma biblioteca do
 * ADR 08 traz SHA-256 (o Monocypher tem SHA-512, não SHA-256; ADR 08 §8.10).
 * Implementação direta da norma, testada com os vetores do NIST. Não é para
 * comparar segredo (não é tempo constante na comparação, que é do chamador). */
#ifndef AH_CORE_SHA256_H
#define AH_CORE_SHA256_H

#include <stddef.h>
#include <stdint.h>

#define AH_SHA256_DIGEST_SIZE 32

/* Estado de um cálculo incremental. Campos privados: use só as funções. */
typedef struct ah_sha256 {
    uint32_t h[8];
    uint64_t total_len; /* bytes já recebidos */
    unsigned char block[64];
    size_t used; /* bytes pendentes em block */
} ah_sha256;

/* Começa um cálculo novo. `ctx` não pode ser NULL. */
void ah_sha256_init(ah_sha256 *ctx);

/* Acrescenta `len` bytes de `data` (emprestado; NULL só com len 0). */
void ah_sha256_update(ah_sha256 *ctx, const void *data, size_t len);

/* Fecha o cálculo e escreve os 32 bytes do resumo em `out`. Depois disso o
 * estado só serve para um novo ah_sha256_init. */
void ah_sha256_final(ah_sha256 *ctx, unsigned char out[AH_SHA256_DIGEST_SIZE]);

/* Resumo de uma vez só dos `len` bytes de `data`. */
void ah_sha256_digest(const void *data, size_t len, unsigned char out[AH_SHA256_DIGEST_SIZE]);

#endif /* AH_CORE_SHA256_H */
