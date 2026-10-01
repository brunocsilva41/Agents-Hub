/* Testes do verificador do envelope de atualização (F8-05; proposta F8-04 §8,
 * T1 a T4). Todas as chaves são de teste: vetores públicos do RFC 8032 ou
 * pares efêmeros gerados aqui com a aleatoriedade do SO. Nenhuma chave real. */
#include <stdlib.h>
#include <string.h>

#include "ah_test.h"
#include "ah_update_verify.h"
#include "ah_platform_time.h"
#include "monocypher-ed25519.h"
#include "monocypher.h"

static int hex_to_bytes(const char *hex, uint8_t *out, size_t out_size) {
    size_t i;
    if (strlen(hex) != 2 * out_size) {
        return -1;
    }
    for (i = 0; i < out_size; i++) {
        unsigned v = 0;
        int k;
        for (k = 0; k < 2; k++) {
            char c = hex[2 * i + (size_t)k];
            v <<= 4;
            if (c >= '0' && c <= '9') {
                v |= (unsigned)(c - '0');
            } else if (c >= 'a' && c <= 'f') {
                v |= (unsigned)(c - 'a' + 10);
            } else {
                return -1;
            }
        }
        out[i] = (uint8_t)v;
    }
    return 0;
}

/* ---------------------------------------------------------------- T1 */

/* RFC 8032 §7.1 (Ed25519): TEST 1, TEST 2, TEST 3 e TEST SHA(abc). O TEST 1024
 * (mensagem de 1023 bytes) ficou de fora pelo tamanho. */
typedef struct rfc_vector {
    const char *secret;
    const char *public_key;
    const char *message; /* hex */
    const char *signature;
} rfc_vector;

static const rfc_vector k_rfc8032[] = {
    {"9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
     "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "",
     "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39"
     "701cf9b46bd25bf5f0595bbe24655141438e7a100b"},
    {"4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
     "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "72",
     "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f36"
     "13d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"},
    {"c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
     "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025", "af82",
     "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f7"
     "60984dc6594a7c15e9716ed28dc027beceea1ec40a"},
    {"833fe62409237b9d62ec77587520911e9a759cec1d19755b7da901b96dca3d42",
     "ec172b93ad5e563bf4932c70e1245034c35467ef2efd4d64ebf819683467e2bf",
     "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c"
     "23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
     "dc2a4459e7369633a52b1bf277839a00201009a3efbf3ecb69bea2186c26b58909351fc9ac90b3ecfdfbc7"
     "c66431e0303dca179c138ac17ad9bef1177331a704"},
};

static void test_t1_rfc8032(void) {
    size_t v;
    for (v = 0; v < sizeof k_rfc8032 / sizeof k_rfc8032[0]; v++) {
        const rfc_vector *t = &k_rfc8032[v];
        uint8_t seed[32];
        uint8_t sk[64];
        uint8_t pk[32];
        uint8_t pk_expected[32];
        uint8_t sig_expected[64];
        uint8_t sig[64];
        uint8_t msg[64];
        size_t msg_size = strlen(t->message) / 2;

        CHECK(msg_size <= sizeof msg);
        if (msg_size > sizeof msg) {
            continue;
        }
        CHECK(hex_to_bytes(t->secret, seed, sizeof seed) == 0);
        CHECK(hex_to_bytes(t->public_key, pk_expected, sizeof pk_expected) == 0);
        CHECK(hex_to_bytes(t->signature, sig_expected, sizeof sig_expected) == 0);
        CHECK(hex_to_bytes(t->message, msg, msg_size) == 0);

        crypto_ed25519_key_pair(sk, pk, seed);
        CHECK(memcmp(pk, pk_expected, 32) == 0);
        crypto_ed25519_sign(sig, sk, msg, msg_size);
        CHECK(memcmp(sig, sig_expected, 64) == 0);

        /* Passa em Ed25519 (SHA-512) e falha em EdDSA-BLAKE2b: trava a função errada. */
        CHECK(crypto_ed25519_check(sig_expected, pk_expected, msg, msg_size) == 0);
        CHECK(crypto_eddsa_check(sig_expected, pk_expected, msg, msg_size) != 0);

        sig_expected[0] ^= 0x01;
        CHECK(crypto_ed25519_check(sig_expected, pk_expected, msg, msg_size) != 0);
        crypto_wipe(sk, sizeof sk);
    }
}

/* ---------------------------------------------------------- utilidades */

typedef struct test_signer {
    uint8_t sk[64];
    ah_update_key key;
} test_signer;

/* Par efêmero: semente do gerador do SO, descartada no fim do teste. */
static int make_signer(test_signer *s) {
    uint8_t seed[32];
    if (ah_platform_random_bytes(seed, sizeof seed) != AH_OK) {
        return -1;
    }
    crypto_ed25519_key_pair(s->sk, s->key.public_key, seed);
    ah_update_key_id(s->key.public_key, s->key.key_id);
    return 0;
}

enum sign_mode { SIGN_WITH_PREFIX, SIGN_WITHOUT_PREFIX, SIGN_EDDSA_BLAKE2B };

/* Monta um envelope (cabeçalho + corpo). Posse: o chamador libera com free(). */
static uint8_t *make_envelope(const test_signer *s, const uint8_t *body, size_t body_size,
                              enum sign_mode mode, size_t *out_size) {
    uint8_t sig[64];
    uint8_t *msg;
    uint8_t *env;
    size_t prefix = (mode == SIGN_WITHOUT_PREFIX) ? 0 : AH_UPDATE_MAGIC_SIZE + 1u;

    msg = (uint8_t *)malloc(prefix + body_size + 1u);
    env = (uint8_t *)malloc(AH_UPDATE_HEADER_SIZE + body_size);
    if (msg == NULL || env == NULL) {
        free(msg);
        free(env);
        return NULL;
    }
    memcpy(msg, AH_UPDATE_MAGIC "\n", prefix);
    memcpy(msg + prefix, body, body_size);
    if (mode == SIGN_EDDSA_BLAKE2B) {
        uint8_t eddsa_sk[64];
        uint8_t eddsa_pk[32];
        uint8_t seed[32];
        memcpy(seed, s->sk, 32);
        crypto_eddsa_key_pair(eddsa_sk, eddsa_pk, seed);
        crypto_eddsa_sign(sig, eddsa_sk, msg, prefix + body_size);
        crypto_wipe(eddsa_sk, sizeof eddsa_sk);
    } else {
        crypto_ed25519_sign(sig, s->sk, msg, prefix + body_size);
    }
    free(msg);
    if (ah_update_header_write(s->key.key_id, sig, env, AH_UPDATE_HEADER_SIZE) != AH_OK) {
        free(env);
        return NULL;
    }
    memcpy(env + AH_UPDATE_HEADER_SIZE, body, body_size);
    *out_size = AH_UPDATE_HEADER_SIZE + body_size;
    return env;
}

static ah_status verify_with(const uint8_t *env, size_t size, const ah_update_key *keys,
                             size_t n) {
    const uint8_t *body = NULL;
    size_t body_size = 0;
    return ah_update_verify(env, size, keys, n, &body, &body_size, NULL);
}

static const char k_body[] = "{\n  \"schema\": 1,\n  \"product\": \"agents-hub\"\n}\n";

/* ---------------------------------------------------------------- T2 */

static void test_header_layout(void) {
    test_signer s;
    uint8_t *env;
    size_t size = 0;
    ah_update_envelope parsed;

    CHECK(AH_UPDATE_HEADER_SIZE == 178u);
    CHECK(make_signer(&s) == 0);
    env = make_envelope(&s, (const uint8_t *)k_body, sizeof k_body - 1, SIGN_WITH_PREFIX, &size);
    CHECK(env != NULL);
    if (env == NULL) {
        return;
    }
    /* Bytes exatos do formato da proposta F8-04 §1.1. */
    CHECK(memcmp(env, "agents-hub-update-v1\nkey: ", 26) == 0);
    CHECK(env[26 + 16] == '\n');
    CHECK(memcmp(env + 43, "sig: ", 5) == 0);
    CHECK(env[48 + 128] == '\n' && env[177] == '\n');
    CHECK(ah_update_envelope_parse(env, size, &parsed) == AH_OK);
    CHECK(memcmp(parsed.key_id, s.key.key_id, 8) == 0);
    CHECK(parsed.body == env + AH_UPDATE_HEADER_SIZE);
    CHECK(parsed.body_size == sizeof k_body - 1);
    free(env);
    crypto_wipe(&s, sizeof s);
}

static void test_t2_good_and_bitflips(void) {
    test_signer s;
    test_signer other;
    ah_update_key both[2];
    ah_update_key bad_table;
    uint8_t *env;
    size_t size = 0;
    const uint8_t *body = NULL;
    size_t body_size = 0;
    size_t index = 99;
    size_t pos;
    int bit;
    int accepted_flips = 0;

    CHECK(make_signer(&s) == 0);
    CHECK(make_signer(&other) == 0);
    env = make_envelope(&s, (const uint8_t *)k_body, sizeof k_body - 1, SIGN_WITH_PREFIX, &size);
    CHECK(env != NULL);
    if (env == NULL) {
        return;
    }

    /* Bom: aceito, corpo exato, chave certa escolhida pelo key_id. */
    both[0] = other.key;
    both[1] = s.key;
    CHECK(ah_update_verify(env, size, both, 2, &body, &body_size, &index) == AH_OK);
    CHECK(index == 1);
    CHECK(body_size == sizeof k_body - 1);
    CHECK(body != NULL && memcmp(body, k_body, body_size) == 0);

    /* Chave desconhecida: só a outra está na lista. */
    CHECK(verify_with(env, size, &other.key, 1) == AH_ERR_NOT_FOUND);
    CHECK(verify_with(env, size, NULL, 0) == AH_ERR_NOT_FOUND);

    /* Tabela com key_id que não é o da chave pública: defeito do build. */
    bad_table = other.key;
    memcpy(bad_table.key_id, s.key.key_id, 8);
    CHECK(verify_with(env, size, &bad_table, 1) == AH_ERR_INTERNAL);

    /* Cada bit de cada byte (mágico, key:, sig:, separadores e corpo): recusa. */
    for (pos = 0; pos < size; pos++) {
        for (bit = 0; bit < 8; bit++) {
            env[pos] ^= (uint8_t)(1u << bit);
            if (verify_with(env, size, &s.key, 1) == AH_OK) {
                accepted_flips++;
                fprintf(stderr, "bit invertido aceito: byte %u bit %d\n", (unsigned)pos, bit);
            }
            env[pos] ^= (uint8_t)(1u << bit);
        }
    }
    CHECK(accepted_flips == 0);
    CHECK(verify_with(env, size, &s.key, 1) == AH_OK); /* restaurado */

    /* key_id trocado por outro válido de verdade (hex certo): chave desconhecida. */
    {
        uint8_t *copy = (uint8_t *)malloc(size);
        CHECK(copy != NULL);
        if (copy != NULL) {
            static const char hexd[] = "0123456789abcdef";
            size_t i;
            memcpy(copy, env, size);
            for (i = 0; i < 8; i++) {
                copy[26 + 2 * i] = (uint8_t)hexd[other.key.key_id[i] >> 4];
                copy[26 + 2 * i + 1] = (uint8_t)hexd[other.key.key_id[i] & 0x0f];
            }
            /* A outra chave é escolhida, mas a assinatura não confere. */
            CHECK(verify_with(copy, size, both, 2) == AH_ERR_INVALID);
            free(copy);
        }
    }
    free(env);
    crypto_wipe(&s, sizeof s);
    crypto_wipe(&other, sizeof other);
}

static void test_t2_header_strict(void) {
    test_signer s;
    uint8_t *env;
    uint8_t *copy;
    size_t size = 0;
    size_t cut;
    ah_update_envelope parsed;

    CHECK(make_signer(&s) == 0);
    env = make_envelope(&s, (const uint8_t *)k_body, sizeof k_body - 1, SIGN_WITH_PREFIX, &size);
    CHECK(env != NULL);
    if (env == NULL) {
        return;
    }
    copy = (uint8_t *)malloc(size + 1);
    CHECK(copy != NULL);
    if (copy == NULL) {
        free(env);
        return;
    }

    /* Truncado em qualquer ponto do cabeçalho, ou sem corpo: recusa. */
    for (cut = 0; cut <= AH_UPDATE_HEADER_SIZE; cut++) {
        CHECK(ah_update_envelope_parse(env, cut, &parsed) == AH_ERR_INVALID);
        CHECK(verify_with(env, cut, &s.key, 1) == AH_ERR_INVALID);
    }
    /* Truncado no corpo: o cabeçalho é bom, a assinatura não. */
    CHECK(verify_with(env, size - 1, &s.key, 1) == AH_ERR_INVALID);

    /* Hex maiúsculo no key_id: mesmo valor, bytes diferentes → recusa. */
    memcpy(copy, env, size);
    {
        size_t i;
        int changed = 0;
        for (i = 26; i < 26 + 16; i++) {
            if (copy[i] >= 'a' && copy[i] <= 'f') {
                copy[i] = (uint8_t)(copy[i] - 'a' + 'A');
                changed = 1;
                break;
            }
        }
        if (changed) {
            CHECK(ah_update_envelope_parse(copy, size, &parsed) == AH_ERR_INVALID);
        }
    }
    /* CR antes do LF da primeira linha. */
    memcpy(copy, env, size);
    copy[20] = '\r';
    CHECK(ah_update_envelope_parse(copy, size, &parsed) == AH_ERR_INVALID);

    /* Byte extra no fim: faz parte do corpo, então a assinatura não confere. */
    memcpy(copy, env, size);
    copy[size] = '\n';
    CHECK(verify_with(copy, size + 1, &s.key, 1) == AH_ERR_INVALID);

    /* Argumentos nulos. */
    CHECK(ah_update_envelope_parse(NULL, size, &parsed) == AH_ERR_INVALID);
    CHECK(ah_update_envelope_parse(env, size, NULL) == AH_ERR_INVALID);
    {
        size_t bs = 0;
        CHECK(ah_update_verify(env, size, &s.key, 1, NULL, &bs, NULL) == AH_ERR_INVALID);
    }
    free(copy);
    free(env);
    crypto_wipe(&s, sizeof s);
}

/* ---------------------------------------------------------------- T3 */

static void test_t3_domain_prefix(void) {
    test_signer s;
    uint8_t *env;
    size_t size = 0;

    CHECK(make_signer(&s) == 0);

    /* Assinatura só do corpo, sem "agents-hub-update-v1\n": recusa. */
    env = make_envelope(&s, (const uint8_t *)k_body, sizeof k_body - 1, SIGN_WITHOUT_PREFIX,
                        &size);
    CHECK(env != NULL);
    if (env != NULL) {
        CHECK(verify_with(env, size, &s.key, 1) == AH_ERR_INVALID);
        free(env);
    }

    /* Assinatura EdDSA-BLAKE2b (crypto_eddsa_sign) da mensagem certa: recusa. */
    env = make_envelope(&s, (const uint8_t *)k_body, sizeof k_body - 1, SIGN_EDDSA_BLAKE2B,
                        &size);
    CHECK(env != NULL);
    if (env != NULL) {
        CHECK(verify_with(env, size, &s.key, 1) == AH_ERR_INVALID);
        free(env);
    }

    /* Controle: com o prefixo, aceita. */
    env = make_envelope(&s, (const uint8_t *)k_body, sizeof k_body - 1, SIGN_WITH_PREFIX, &size);
    CHECK(env != NULL);
    if (env != NULL) {
        CHECK(verify_with(env, size, &s.key, 1) == AH_OK);
        free(env);
    }
    crypto_wipe(&s, sizeof s);
}

/* ---------------------------------------------------------------- T4 */

static void test_t4_size_limit(void) {
    test_signer s;
    uint8_t *body;
    uint8_t *env;
    size_t size = 0;
    ah_update_envelope parsed;

    CHECK(make_signer(&s) == 0);
    body = (uint8_t *)malloc(AH_UPDATE_BODY_MAX + 1u);
    CHECK(body != NULL);
    if (body == NULL) {
        return;
    }
    memset(body, ' ', AH_UPDATE_BODY_MAX + 1u);

    /* Exatamente 64 KiB, assinado: aceito. */
    env = make_envelope(&s, body, AH_UPDATE_BODY_MAX, SIGN_WITH_PREFIX, &size);
    CHECK(env != NULL);
    if (env != NULL) {
        CHECK(size == AH_UPDATE_ENVELOPE_MAX);
        CHECK(verify_with(env, size, &s.key, 1) == AH_OK);
        free(env);
    }

    /* 64 KiB + 1 com assinatura VÁLIDA: recusado pelo tamanho, antes de verificar. */
    env = make_envelope(&s, body, AH_UPDATE_BODY_MAX + 1u, SIGN_WITH_PREFIX, &size);
    CHECK(env != NULL);
    if (env != NULL) {
        CHECK(size == AH_UPDATE_ENVELOPE_MAX + 1u);
        CHECK(verify_with(env, size, &s.key, 1) == AH_ERR_LIMIT);
        CHECK(ah_update_envelope_parse(env, size, &parsed) == AH_ERR_LIMIT);
        free(env);
    }

    /* O tamanho é olhado antes de qualquer byte: com data == NULL a resposta
     * ainda é LIMIT (não INVALID), logo nada foi lido. */
    CHECK(ah_update_envelope_parse(NULL, AH_UPDATE_ENVELOPE_MAX + 1u, &parsed) == AH_ERR_LIMIT);
    {
        const uint8_t *b = NULL;
        size_t bs = 0;
        CHECK(ah_update_verify(NULL, (size_t)-1, &s.key, 1, &b, &bs, NULL) == AH_ERR_LIMIT);
    }
    free(body);
    crypto_wipe(&s, sizeof s);
}

static void test_header_write(void) {
    uint8_t id[8] = {0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef};
    uint8_t sig[64];
    uint8_t buf[AH_UPDATE_HEADER_SIZE + 1];
    ah_update_envelope parsed;
    size_t i;

    for (i = 0; i < sizeof sig; i++) {
        sig[i] = (uint8_t)i;
    }
    CHECK(ah_update_header_write(id, sig, buf, AH_UPDATE_HEADER_SIZE - 1) == AH_ERR_LIMIT);
    CHECK(ah_update_header_write(id, sig, buf, AH_UPDATE_HEADER_SIZE) == AH_OK);
    CHECK(memcmp(buf, "agents-hub-update-v1\nkey: 0123456789abcdef\nsig: 000102", 54) == 0);
    buf[AH_UPDATE_HEADER_SIZE] = 'x'; /* corpo de 1 byte */
    CHECK(ah_update_envelope_parse(buf, sizeof buf, &parsed) == AH_OK);
    CHECK(memcmp(parsed.key_id, id, 8) == 0);
    CHECK(memcmp(parsed.signature, sig, 64) == 0);
}

static void test_key_id(void) {
    uint8_t pk[32];
    uint8_t hash[64];
    uint8_t id[8];
    CHECK(hex_to_bytes(k_rfc8032[0].public_key, pk, sizeof pk) == 0);
    crypto_sha512(hash, pk, sizeof pk);
    ah_update_key_id(pk, id);
    CHECK(memcmp(id, hash, 8) == 0);
}

/* ------------------------------------------- casos fixados (revisão B5) */

/* Cópia de `env` com `ins` (n bytes) inserido na posição `pos`. Posse: free(). */
static uint8_t *insert_bytes(const uint8_t *env, size_t size, size_t pos, const char *ins,
                             size_t n, size_t *out_size) {
    uint8_t *copy = (uint8_t *)malloc(size + n);
    if (copy == NULL) {
        return NULL;
    }
    memcpy(copy, env, pos);
    memcpy(copy + pos, ins, n);
    memcpy(copy + pos + n, env + pos, size - pos);
    *out_size = size + n;
    return copy;
}

/* Reescreve o hex da assinatura (bytes 48..175) com `sig`. */
static void put_sig_hex(uint8_t *env, const uint8_t sig[64]) {
    static const char hexd[] = "0123456789abcdef";
    size_t i;
    for (i = 0; i < 64; i++) {
        env[48 + 2 * i] = (uint8_t)hexd[sig[i] >> 4];
        env[48 + 2 * i + 1] = (uint8_t)hexd[sig[i] & 0x0f];
    }
}

/* L = 2^252 + 27742317777372353535851937790883648493, little-endian. */
static const uint8_t k_order_l[32] = {0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58,
                                      0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14,
                                      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                                      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10};

/* S + L e S = L: a mesma assinatura com S fora de [0, L) é recusada
 * (anti-maleabilidade, monocypher.c is_above_l). */
static void test_b5_s_plus_l(void) {
    test_signer s;
    ah_update_envelope parsed;
    uint8_t *env;
    uint8_t sig[64];
    uint8_t msg[sizeof k_body - 1 + AH_UPDATE_MAGIC_SIZE + 1];
    size_t size = 0;
    unsigned carry = 0;
    size_t i;

    CHECK(make_signer(&s) == 0);
    env = make_envelope(&s, (const uint8_t *)k_body, sizeof k_body - 1, SIGN_WITH_PREFIX, &size);
    CHECK(env != NULL);
    if (env == NULL) {
        return;
    }
    CHECK(ah_update_envelope_parse(env, size, &parsed) == AH_OK);
    memcpy(sig, parsed.signature, 64);
    memcpy(msg, AH_UPDATE_MAGIC "\n", AH_UPDATE_MAGIC_SIZE + 1u);
    memcpy(msg + AH_UPDATE_MAGIC_SIZE + 1u, k_body, sizeof k_body - 1);
    CHECK(crypto_ed25519_check(sig, s.key.public_key, msg, sizeof msg) == 0);

    /* S' = S + L (cabe em 32 bytes: S < L < 2^253). */
    for (i = 0; i < 32; i++) {
        unsigned v = (unsigned)sig[32 + i] + k_order_l[i] + carry;
        sig[32 + i] = (uint8_t)(v & 0xffu);
        carry = v >> 8;
    }
    CHECK(carry == 0);
    CHECK(crypto_ed25519_check(sig, s.key.public_key, msg, sizeof msg) != 0);
    put_sig_hex(env, sig);
    CHECK(verify_with(env, size, &s.key, 1) == AH_ERR_INVALID);

    /* S = L. */
    memcpy(sig + 32, k_order_l, 32);
    put_sig_hex(env, sig);
    CHECK(verify_with(env, size, &s.key, 1) == AH_ERR_INVALID);
    free(env);
    crypto_wipe(&s, sizeof s);
}

/* Cabeçalho: hex maiúsculo na sig, CRLF, BOM, NUL e `key:` repetido. */
static void test_b5_header_variants(void) {
    test_signer s;
    ah_update_envelope parsed;
    uint8_t *env;
    uint8_t *copy;
    size_t size = 0;
    size_t csize = 0;
    size_t i;
    int changed = 0;

    CHECK(make_signer(&s) == 0);
    env = make_envelope(&s, (const uint8_t *)k_body, sizeof k_body - 1, SIGN_WITH_PREFIX, &size);
    CHECK(env != NULL);
    if (env == NULL) {
        return;
    }
    CHECK(verify_with(env, size, &s.key, 1) == AH_OK);

    /* Hex maiúsculo na assinatura. */
    copy = (uint8_t *)malloc(size);
    CHECK(copy != NULL);
    if (copy != NULL) {
        memcpy(copy, env, size);
        for (i = 48; i < 176; i++) {
            if (copy[i] >= 'a' && copy[i] <= 'f') {
                copy[i] = (uint8_t)(copy[i] - 'a' + 'A');
                changed = 1;
                break;
            }
        }
        CHECK(changed); /* 128 hex aleatórios sem a-f: probabilidade desprezível */
        CHECK(ah_update_envelope_parse(copy, size, &parsed) == AH_ERR_INVALID);
        CHECK(verify_with(copy, size, &s.key, 1) == AH_ERR_INVALID);

        /* NUL no lugar de um byte do cabeçalho: no texto fixo e no hex. */
        memcpy(copy, env, size);
        copy[22] = 0;
        CHECK(ah_update_envelope_parse(copy, size, &parsed) == AH_ERR_INVALID);
        memcpy(copy, env, size);
        copy[30] = 0;
        CHECK(ah_update_envelope_parse(copy, size, &parsed) == AH_ERR_INVALID);
        memcpy(copy, env, size);
        copy[177] = 0; /* a linha vazia */
        CHECK(ah_update_envelope_parse(copy, size, &parsed) == AH_ERR_INVALID);

        /* `key:` no lugar de `sig:`. */
        memcpy(copy, env, size);
        memcpy(copy + 43, "key: ", 5);
        CHECK(ah_update_envelope_parse(copy, size, &parsed) == AH_ERR_INVALID);
        free(copy);
    }

    /* CRLF em cada fim de linha do cabeçalho (CR inserido antes do LF). */
    {
        static const size_t lf_positions[] = {20, 42, 176, 177};
        size_t k;
        for (k = 0; k < sizeof lf_positions / sizeof lf_positions[0]; k++) {
            copy = insert_bytes(env, size, lf_positions[k], "\r", 1, &csize);
            CHECK(copy != NULL);
            if (copy != NULL) {
                CHECK(verify_with(copy, csize, &s.key, 1) != AH_OK);
                free(copy);
            }
        }
    }
    /* BOM UTF-8 no início. */
    copy = insert_bytes(env, size, 0, "\xef\xbb\xbf", 3, &csize);
    CHECK(copy != NULL);
    if (copy != NULL) {
        CHECK(ah_update_envelope_parse(copy, csize, &parsed) == AH_ERR_INVALID);
        free(copy);
    }
    /* Uma linha `key:` repetida inteira antes da `sig:`. */
    {
        char line[23];
        memcpy(line, env + 21, 22); /* "key: <16 hex>\n" */
        line[22] = 0;
        copy = insert_bytes(env, size, 43, line, 22, &csize);
        CHECK(copy != NULL);
        if (copy != NULL) {
            CHECK(ah_update_envelope_parse(copy, csize, &parsed) == AH_ERR_INVALID);
            CHECK(verify_with(copy, csize, &s.key, 1) != AH_OK);
            free(copy);
        }
    }
    free(env);
    crypto_wipe(&s, sizeof s);
}

/* A e R com codificação não canônica. O Monocypher 4.0.3 ACEITA codificação
 * não canônica de A e de R (monocypher.c, comentário em
 * crypto_eddsa_check_equation) e não recusa ponto de ordem pequena. Fixa-se
 * aqui o comportamento: com A = identidade (y = 1, codificado como y = 1 ou
 * y = p + 1), a assinatura R = identidade, S = 0 vale para QUALQUER mensagem.
 * Não afeta o Hub porque A só vem da tabela embutida (as chaves do projeto),
 * nunca do envelope; quem montar essa tabela não pode pôr ali uma chave fraca. */
static void test_b5_non_canonical_points(void) {
    /* Identidade canônica: y = 1. */
    static const uint8_t ident[32] = {0x01};
    /* Identidade não canônica: y = p + 1 = 2^255 - 18. */
    static const uint8_t ident_nc[32] = {
        0xee, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f};
    static const uint8_t msg[] = "qualquer mensagem";
    uint8_t sig[64];
    ah_update_key weak;
    uint8_t *env;
    size_t size = 0;

    memset(sig, 0, sizeof sig);
    memcpy(sig, ident, 32);
    CHECK(crypto_ed25519_check(sig, ident, msg, sizeof msg - 1) == 0);
    CHECK(crypto_ed25519_check(sig, ident_nc, msg, sizeof msg - 1) == 0); /* A não canônico */
    memcpy(sig, ident_nc, 32);
    CHECK(crypto_ed25519_check(sig, ident, msg, sizeof msg - 1) == 0); /* R não canônico */
    CHECK(crypto_ed25519_check(sig, ident_nc, msg, sizeof msg - 1) == 0);

    /* Com uma chave válida de verdade, R não canônico não forja nada. */
    {
        uint8_t pk[32];
        CHECK(hex_to_bytes(k_rfc8032[0].public_key, pk, sizeof pk) == 0);
        CHECK(crypto_ed25519_check(sig, pk, msg, sizeof msg - 1) != 0);
    }

    /* O mesmo pelo verificador do Hub, se a tabela tivesse a chave fraca. */
    memcpy(weak.public_key, ident_nc, 32);
    ah_update_key_id(weak.public_key, weak.key_id);
    env = (uint8_t *)malloc(AH_UPDATE_HEADER_SIZE + sizeof k_body - 1);
    CHECK(env != NULL);
    if (env != NULL) {
        CHECK(ah_update_header_write(weak.key_id, sig, env, AH_UPDATE_HEADER_SIZE) == AH_OK);
        memcpy(env + AH_UPDATE_HEADER_SIZE, k_body, sizeof k_body - 1);
        size = AH_UPDATE_HEADER_SIZE + sizeof k_body - 1;
        CHECK(verify_with(env, size, &weak, 1) == AH_OK);
        free(env);
    }
}

int main(void) {
    test_t1_rfc8032();
    test_b5_s_plus_l();
    test_b5_header_variants();
    test_b5_non_canonical_points();
    test_header_layout();
    test_t2_good_and_bitflips();
    test_t2_header_strict();
    test_t3_domain_prefix();
    test_t4_size_limit();
    test_header_write();
    test_key_id();
    return AH_TEST_END("test_update_verify");
}
