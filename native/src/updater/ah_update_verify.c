/* Verificação do envelope do manifesto de atualização (F8-05). Ver o header. */
#include "ah_update_verify.h"

#include <stdlib.h>
#include <string.h>

#include "monocypher-ed25519.h"

static const char k_hex[] = "0123456789abcdef";

/* Só hex minúsculo: o formato é de bytes exatos (F8-04 §1.1), e aceitar
 * maiúsculas daria dois envelopes diferentes para o mesmo cabeçalho. */
static int hex_nibble(uint8_t c) {
    if (c >= '0' && c <= '9') {
        return c - '0';
    }
    if (c >= 'a' && c <= 'f') {
        return c - 'a' + 10;
    }
    return -1;
}

static int hex_decode(const uint8_t *in, size_t out_size, uint8_t *out) {
    size_t i;
    for (i = 0; i < out_size; i++) {
        int hi = hex_nibble(in[2 * i]);
        int lo = hex_nibble(in[2 * i + 1]);
        if (hi < 0 || lo < 0) {
            return -1;
        }
        out[i] = (uint8_t)((hi << 4) | lo);
    }
    return 0;
}

static void hex_encode(const uint8_t *in, size_t in_size, uint8_t *out) {
    size_t i;
    for (i = 0; i < in_size; i++) {
        out[2 * i] = (uint8_t)k_hex[in[i] >> 4];
        out[2 * i + 1] = (uint8_t)k_hex[in[i] & 0x0f];
    }
}

/* Compara `lit` (texto ASCII de tamanho conhecido) com os bytes em p. */
static int expect(const uint8_t *p, const char *lit, size_t n) {
    return memcmp(p, lit, n) == 0 ? 0 : -1;
}

/* Coordenada y (32 bytes, little-endian, bit 255 = sinal de x zerado) dos 8
 * pontos de torção de Ed25519, em todas as codificações com y < 2^255.
 * Fonte: a lista de bloqueio de pontos de ordem pequena do libsodium
 * (src/libsodium/crypto_core/ed25519/ref10/ed25519_ref10.c, função
 * ge25519_has_small_order), que compara com o bit de sinal ignorado como
 * aqui. Cada entrada, com sinal 0 e 1, é provada no teste
 * (test_update_verify.c: decodifica e [8]A = identidade).
 *
 *   y = 0      ordem 4 (x = ±sqrt(-1))
 *   y = 1      ordem 1 (identidade)
 *   y = y8     ordem 8 (dois pontos, ±x)
 *   y = p - y8 ordem 8 (dois pontos, ±x)
 *   y = p - 1  ordem 2 (x = 0)
 *   y = p      ≡ 0, codificação não canônica do ordem 4
 *   y = p + 1  ≡ 1, codificação não canônica da identidade
 *
 * Com x = 0 (y = ±1), o bit de sinal 1 é a codificação não canônica do mesmo
 * ponto. Os demais y < 2^255 com y >= p (p + 2 .. p + 18) não são pontos da
 * curva de ordem pequena. */
static const uint8_t k_small_order_y[7][32] = {
    {0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
     0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
     0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00},
    {0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
     0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
     0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00},
    {0x26, 0xe8, 0x95, 0x8f, 0xc2, 0xb2, 0x27, 0xb0, 0x45, 0xc3, 0xf4,
     0x89, 0xf2, 0xef, 0x98, 0xf0, 0xd5, 0xdf, 0xac, 0x05, 0xd3, 0xc6,
     0x33, 0x39, 0xb1, 0x38, 0x02, 0x88, 0x6d, 0x53, 0xfc, 0x05},
    {0xc7, 0x17, 0x6a, 0x70, 0x3d, 0x4d, 0xd8, 0x4f, 0xba, 0x3c, 0x0b,
     0x76, 0x0d, 0x10, 0x67, 0x0f, 0x2a, 0x20, 0x53, 0xfa, 0x2c, 0x39,
     0xcc, 0xc6, 0x4e, 0xc7, 0xfd, 0x77, 0x92, 0xac, 0x03, 0x7a},
    {0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
     0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
     0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f},
    {0xed, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
     0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
     0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f},
    {0xee, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
     0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
     0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f},
};

int ah_update_public_key_is_small_order(const uint8_t public_key[AH_UPDATE_PUBLIC_KEY_SIZE]) {
    size_t i;
    for (i = 0; i < sizeof k_small_order_y / sizeof k_small_order_y[0]; i++) {
        /* Bytes 0..30 iguais e o byte 31 igual com o bit de sinal ignorado. */
        if (memcmp(public_key, k_small_order_y[i], 31) == 0 &&
            (public_key[31] & 0x7fu) == k_small_order_y[i][31]) {
            return 1;
        }
    }
    return 0;
}

void ah_update_key_id(const uint8_t public_key[AH_UPDATE_PUBLIC_KEY_SIZE],
                      uint8_t out[AH_UPDATE_KEY_ID_SIZE]) {
    uint8_t hash[64];
    crypto_sha512(hash, public_key, AH_UPDATE_PUBLIC_KEY_SIZE);
    memcpy(out, hash, AH_UPDATE_KEY_ID_SIZE);
}

ah_status ah_update_envelope_parse(const uint8_t *data, size_t size,
                                   ah_update_envelope *out) {
    const uint8_t *p;

    /* Tamanho primeiro: um envelope grande é recusado sem ler um byte (T4). */
    if (size > AH_UPDATE_ENVELOPE_MAX) {
        return AH_ERR_LIMIT;
    }
    if (data == NULL || out == NULL) {
        return AH_ERR_INVALID;
    }
    /* Corpo vazio também é recusado: não há manifesto sem corpo. */
    if (size <= AH_UPDATE_HEADER_SIZE) {
        return AH_ERR_INVALID;
    }

    p = data;
    if (expect(p, AH_UPDATE_MAGIC "\n", AH_UPDATE_MAGIC_SIZE + 1u) != 0) {
        return AH_ERR_INVALID;
    }
    p += AH_UPDATE_MAGIC_SIZE + 1u;

    if (expect(p, "key: ", 5u) != 0) {
        return AH_ERR_INVALID;
    }
    p += 5u;
    if (hex_decode(p, AH_UPDATE_KEY_ID_SIZE, out->key_id) != 0) {
        return AH_ERR_INVALID;
    }
    p += 2u * AH_UPDATE_KEY_ID_SIZE;
    if (*p != '\n') {
        return AH_ERR_INVALID;
    }
    p++;

    if (expect(p, "sig: ", 5u) != 0) {
        return AH_ERR_INVALID;
    }
    p += 5u;
    if (hex_decode(p, AH_UPDATE_SIGNATURE_SIZE, out->signature) != 0) {
        return AH_ERR_INVALID;
    }
    p += 2u * AH_UPDATE_SIGNATURE_SIZE;
    if (p[0] != '\n' || p[1] != '\n') {
        return AH_ERR_INVALID;
    }
    p += 2;

    out->body = p;
    out->body_size = size - AH_UPDATE_HEADER_SIZE;
    return AH_OK;
}

ah_status ah_update_verify(const uint8_t *data, size_t size,
                           const ah_update_key *keys, size_t key_count,
                           const uint8_t **body_out, size_t *body_size_out,
                           size_t *key_index_out) {
    ah_update_envelope env;
    const ah_update_key *key = NULL;
    uint8_t computed_id[AH_UPDATE_KEY_ID_SIZE];
    uint8_t *msg;
    size_t msg_size;
    size_t i;
    size_t index = 0;
    ah_status st;
    int rc;

    if (size > AH_UPDATE_ENVELOPE_MAX) {
        return AH_ERR_LIMIT;
    }
    if (body_out == NULL || body_size_out == NULL || (keys == NULL && key_count != 0)) {
        return AH_ERR_INVALID;
    }
    *body_out = NULL;
    *body_size_out = 0;

    st = ah_update_envelope_parse(data, size, &env);
    if (st != AH_OK) {
        return st;
    }

    /* O key_id só escolhe a chave; a confiança vem da verificação. */
    for (i = 0; i < key_count; i++) {
        if (memcmp(keys[i].key_id, env.key_id, AH_UPDATE_KEY_ID_SIZE) == 0) {
            key = &keys[i];
            index = i;
            break;
        }
    }
    if (key == NULL) {
        return AH_ERR_NOT_FOUND;
    }
    /* Tabela embutida inválida é defeito do build: key_id que não é o da
     * chave, ou chave de ordem pequena (aceitaria qualquer manifesto). */
    ah_update_key_id(key->public_key, computed_id);
    if (memcmp(computed_id, key->key_id, AH_UPDATE_KEY_ID_SIZE) != 0 ||
        ah_update_public_key_is_small_order(key->public_key)) {
        return AH_ERR_INTERNAL;
    }

    /* Mensagem = prefixo de domínio || corpo. Cabe em size (≤ 64 KiB): o
     * prefixo tem 21 bytes e o cabeçalho que ele substitui, 178. */
    msg_size = AH_UPDATE_MAGIC_SIZE + 1u + env.body_size;
    msg = (uint8_t *)malloc(msg_size);
    if (msg == NULL) {
        return AH_ERR_NOMEM;
    }
    memcpy(msg, AH_UPDATE_MAGIC "\n", AH_UPDATE_MAGIC_SIZE + 1u);
    memcpy(msg + AH_UPDATE_MAGIC_SIZE + 1u, env.body, env.body_size);

    rc = crypto_ed25519_check(env.signature, key->public_key, msg, msg_size);
    free(msg);
    if (rc != 0) {
        return AH_ERR_INVALID;
    }

    *body_out = env.body;
    *body_size_out = env.body_size;
    if (key_index_out != NULL) {
        *key_index_out = index;
    }
    return AH_OK;
}

ah_status ah_update_header_write(const uint8_t key_id[AH_UPDATE_KEY_ID_SIZE],
                                 const uint8_t signature[AH_UPDATE_SIGNATURE_SIZE],
                                 uint8_t *out, size_t out_cap) {
    uint8_t *p;

    if (key_id == NULL || signature == NULL || out == NULL) {
        return AH_ERR_INVALID;
    }
    if (out_cap < AH_UPDATE_HEADER_SIZE) {
        return AH_ERR_LIMIT;
    }
    p = out;
    memcpy(p, AH_UPDATE_MAGIC "\n", AH_UPDATE_MAGIC_SIZE + 1u);
    p += AH_UPDATE_MAGIC_SIZE + 1u;
    memcpy(p, "key: ", 5u);
    p += 5u;
    hex_encode(key_id, AH_UPDATE_KEY_ID_SIZE, p);
    p += 2u * AH_UPDATE_KEY_ID_SIZE;
    *p++ = '\n';
    memcpy(p, "sig: ", 5u);
    p += 5u;
    hex_encode(signature, AH_UPDATE_SIGNATURE_SIZE, p);
    p += 2u * AH_UPDATE_SIGNATURE_SIZE;
    *p++ = '\n';
    *p = '\n';
    return AH_OK;
}
