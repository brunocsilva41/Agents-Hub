/* Verificação do envelope do manifesto de atualização (F8-05; DA-04, ADR 09 §9.7).
 *
 * Formato (proposta F8-04 §1.1, adotada pelo ADR 09):
 *
 *   agents-hub-update-v1\n
 *   key: <16 hex minúsculos>\n
 *   sig: <128 hex minúsculos>\n
 *   \n
 *   <corpo, bytes exatos>
 *
 * Mensagem assinada = "agents-hub-update-v1\n" || corpo. Ed25519 puro (S1) do
 * Monocypher: só crypto_ed25519_check, nunca crypto_eddsa_* (que é BLAKE2b).
 *
 * Este módulo cobre só o cabeçalho e a assinatura (F8-04 §5.4, passos 1 a 4).
 * O parse do corpo JSON, a revogação, o serial e a expiração ficam para a F8-06:
 * o chamador passa aqui só as chaves que ainda considera válidas.
 *
 * Sem I/O e sem estado global: pode ser usado por qualquer camada. */
#ifndef AH_UPDATER_UPDATE_VERIFY_H
#define AH_UPDATER_UPDATE_VERIFY_H

#include <stddef.h>
#include <stdint.h>

#include "ah_status.h"

/* Linha 1 do envelope e prefixo de domínio da mensagem assinada (A2). */
#define AH_UPDATE_MAGIC "agents-hub-update-v1"
#define AH_UPDATE_MAGIC_SIZE 20u

/* Teto do envelope inteiro (F8-04 §1.1): acima disso, recusa sem verificar. */
#define AH_UPDATE_ENVELOPE_MAX (64u * 1024u)

#define AH_UPDATE_KEY_ID_SIZE 8u     /* 8 primeiros bytes de SHA-512(chave pública) */
#define AH_UPDATE_PUBLIC_KEY_SIZE 32u
#define AH_UPDATE_SIGNATURE_SIZE 64u

/* Tamanho exato do cabeçalho: mágico+LF, "key: "+16 hex+LF, "sig: "+128 hex+LF, LF. */
#define AH_UPDATE_HEADER_SIZE                                                  \
    (AH_UPDATE_MAGIC_SIZE + 1u + 5u + 2u * AH_UPDATE_KEY_ID_SIZE + 1u + 5u +   \
     2u * AH_UPDATE_SIGNATURE_SIZE + 1u + 1u)

/* Maior corpo que cabe num envelope. */
#define AH_UPDATE_BODY_MAX (AH_UPDATE_ENVELOPE_MAX - AH_UPDATE_HEADER_SIZE)

/* Chave pública confiável, embutida no binário. */
typedef struct ah_update_key {
    uint8_t key_id[AH_UPDATE_KEY_ID_SIZE];
    uint8_t public_key[AH_UPDATE_PUBLIC_KEY_SIZE];
} ah_update_key;

/* Cabeçalho lido. `body` aponta para dentro do buffer do envelope (emprestado:
 * vale enquanto o buffer do chamador viver). */
typedef struct ah_update_envelope {
    uint8_t key_id[AH_UPDATE_KEY_ID_SIZE];
    uint8_t signature[AH_UPDATE_SIGNATURE_SIZE];
    const uint8_t *body;
    size_t body_size;
} ah_update_envelope;

/* key_id da chave pública: os 8 primeiros bytes de SHA-512(public_key). */
void ah_update_key_id(const uint8_t public_key[AH_UPDATE_PUBLIC_KEY_SIZE],
                      uint8_t out[AH_UPDATE_KEY_ID_SIZE]);

/* 1 se `public_key` é a codificação de um ponto de ordem pequena (ordem 1, 2,
 * 4 ou 8: os 8 pontos de torção de Ed25519), em forma canônica ou não
 * canônica (y >= p, ou bit de sinal com x = 0); 0 se não. Com uma chave
 * dessas, crypto_ed25519_check aceita R = identidade, S = 0 para qualquer
 * mensagem (a equação é conferida com cofator e A de ordem pequena não é
 * recusado). Só compara bytes; não chama crypto_eddsa_*. */
int ah_update_public_key_is_small_order(const uint8_t public_key[AH_UPDATE_PUBLIC_KEY_SIZE]);

/* Lê só o cabeçalho, por comparação de bytes exatos. Não verifica assinatura.
 * `data` é emprestado. Resultado:
 *   AH_OK          cabeçalho válido, *out preenchido;
 *   AH_ERR_LIMIT   size > AH_UPDATE_ENVELOPE_MAX (data nem é lido);
 *   AH_ERR_INVALID cabeçalho fora do formato, truncado, ou corpo vazio. */
ah_status ah_update_envelope_parse(const uint8_t *data, size_t size,
                                   ah_update_envelope *out);

/* Verifica o envelope: tamanho, cabeçalho, escolha da chave por key_id e
 * crypto_ed25519_check sobre "agents-hub-update-v1\n" || corpo.
 * `data` e `keys` são emprestados. Com AH_OK, *body_out aponta para o corpo
 * dentro de `data` e *key_index_out (se não NULL) diz qual chave verificou.
 * Resultado:
 *   AH_OK            assinatura válida;
 *   AH_ERR_LIMIT     envelope maior que AH_UPDATE_ENVELOPE_MAX (sem verificar);
 *   AH_ERR_INVALID   cabeçalho inválido ou assinatura inválida;
 *   AH_ERR_NOT_FOUND key_id não está entre `keys`;
 *   AH_ERR_INTERNAL  tabela embutida inválida: key_id que não é o da chave,
 *                    ou chave pública de ordem pequena;
 *   AH_ERR_NOMEM     sem memória para montar a mensagem assinada. */
ah_status ah_update_verify(const uint8_t *data, size_t size,
                           const ah_update_key *keys, size_t key_count,
                           const uint8_t **body_out, size_t *body_size_out,
                           size_t *key_index_out);

/* Escreve o cabeçalho do envelope (AH_UPDATE_HEADER_SIZE bytes, sem NUL) em
 * `out`, que precisa ter pelo menos esse tamanho. Usado pela ferramenta de
 * assinatura para produzir exatamente o formato que ah_update_verify aceita.
 *   AH_ERR_LIMIT se out_cap < AH_UPDATE_HEADER_SIZE. */
ah_status ah_update_header_write(const uint8_t key_id[AH_UPDATE_KEY_ID_SIZE],
                                 const uint8_t signature[AH_UPDATE_SIGNATURE_SIZE],
                                 uint8_t *out, size_t out_cap);

#endif /* AH_UPDATER_UPDATE_VERIFY_H */
