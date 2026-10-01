/* Núcleo da ferramenta ahsign (F8-05). Ver ahsign_key.h. */
#include "ahsign_key.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ah_update_verify.h"
#include "monocypher-ed25519.h"
#include "monocypher.h"

/* Única ocorrência literal do cabeçalho no repositório fora da proposta F8-04
 * (o teste T14 falha se o texto aparecer em qualquer outro arquivo). */
const char ahsign_key_file_magic[] = "agents-hub-secret-key-v1";

/* 256 MiB e 3 passadas: custo de uma chave que fica offline e é aberta poucas
 * vezes por mês (release e reassinatura de expiração, ADR 09 §9.7). */
const ahsign_kdf ahsign_kdf_default = {256u * 1024u, 3u};

enum {
    OFF_MAGIC = 0,
    OFF_LF = 24,
    OFF_BLOCKS = 25,
    OFF_PASSES = 29,
    OFF_SALT = 33,
    OFF_NONCE = 49,
    OFF_PUBLIC = 73,
    OFF_MAC = 105,
    OFF_CIPHER = 121
};

static void put_u32le(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)(v & 0xffu);
    p[1] = (uint8_t)((v >> 8) & 0xffu);
    p[2] = (uint8_t)((v >> 16) & 0xffu);
    p[3] = (uint8_t)((v >> 24) & 0xffu);
}

static uint32_t get_u32le(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) |
           ((uint32_t)p[3] << 24);
}

static int kdf_ok(ahsign_kdf kdf) {
    return kdf.nb_blocks >= AHSIGN_KDF_MIN_BLOCKS && kdf.nb_blocks <= AHSIGN_KDF_MAX_BLOCKS &&
           kdf.nb_passes >= AHSIGN_KDF_MIN_PASSES && kdf.nb_passes <= AHSIGN_KDF_MAX_PASSES;
}

/* Senha → chave da cifra (32 bytes) com Argon2id. */
static ah_status derive_key(const uint8_t *password, size_t password_size, ahsign_kdf kdf,
                            const uint8_t salt[AHSIGN_SALT_SIZE], uint8_t key[32]) {
    crypto_argon2_config cfg;
    crypto_argon2_inputs in;
    size_t work_size;
    void *work;

    if (password == NULL || password_size == 0 || password_size > 1024u || !kdf_ok(kdf)) {
        return AH_ERR_INVALID;
    }
    work_size = (size_t)kdf.nb_blocks * 1024u; /* ≤ 1 GiB pela faixa: sem overflow */
    work = malloc(work_size);
    if (work == NULL) {
        return AH_ERR_NOMEM;
    }
    cfg.algorithm = CRYPTO_ARGON2_ID;
    cfg.nb_blocks = kdf.nb_blocks;
    cfg.nb_passes = kdf.nb_passes;
    cfg.nb_lanes = 1;
    in.pass = password;
    in.pass_size = (uint32_t)password_size;
    in.salt = salt;
    in.salt_size = AHSIGN_SALT_SIZE;
    crypto_argon2(key, 32, work, cfg, in, crypto_argon2_no_extras);
    crypto_wipe(work, work_size);
    free(work);
    return AH_OK;
}

ah_status ahsign_key_seal(const uint8_t seed[AHSIGN_SEED_SIZE], const uint8_t *password,
                          size_t password_size, ahsign_kdf kdf,
                          const uint8_t salt[AHSIGN_SALT_SIZE],
                          const uint8_t nonce[AHSIGN_NONCE_SIZE],
                          uint8_t out[AHSIGN_KEY_FILE_SIZE]) {
    uint8_t seed_copy[AHSIGN_SEED_SIZE];
    uint8_t secret_key[AHSIGN_SECRET_KEY_SIZE];
    uint8_t public_key[32];
    uint8_t key[32];
    ah_status st;

    if (seed == NULL || salt == NULL || nonce == NULL || out == NULL) {
        return AH_ERR_INVALID;
    }
    st = derive_key(password, password_size, kdf, salt, key);
    if (st != AH_OK) {
        return st;
    }
    /* crypto_ed25519_key_pair apaga a semente recebida: usa uma cópia. */
    memcpy(seed_copy, seed, sizeof seed_copy);
    crypto_ed25519_key_pair(secret_key, public_key, seed_copy);
    crypto_wipe(secret_key, sizeof secret_key);

    memcpy(out + OFF_MAGIC, ahsign_key_file_magic, AHSIGN_KEY_FILE_MAGIC_SIZE);
    out[OFF_LF] = '\n';
    put_u32le(out + OFF_BLOCKS, kdf.nb_blocks);
    put_u32le(out + OFF_PASSES, kdf.nb_passes);
    memcpy(out + OFF_SALT, salt, AHSIGN_SALT_SIZE);
    memcpy(out + OFF_NONCE, nonce, AHSIGN_NONCE_SIZE);
    memcpy(out + OFF_PUBLIC, public_key, sizeof public_key);
    crypto_aead_lock(out + OFF_CIPHER, out + OFF_MAC, key, nonce, out, OFF_MAC, seed,
                     AHSIGN_SEED_SIZE);
    crypto_wipe(key, sizeof key);
    crypto_wipe(seed_copy, sizeof seed_copy);
    return AH_OK;
}

ah_status ahsign_key_open(const uint8_t *file, size_t file_size, const uint8_t *password,
                          size_t password_size, uint8_t secret_key[AHSIGN_SECRET_KEY_SIZE],
                          uint8_t public_key[32], ahsign_kdf *kdf_out) {
    uint8_t seed[AHSIGN_SEED_SIZE];
    uint8_t key[32];
    uint8_t derived_public[32];
    ahsign_kdf kdf;
    ah_status st;
    int rc;

    if (file == NULL || secret_key == NULL || public_key == NULL ||
        file_size != AHSIGN_KEY_FILE_SIZE) {
        return AH_ERR_INVALID;
    }
    if (memcmp(file + OFF_MAGIC, ahsign_key_file_magic, AHSIGN_KEY_FILE_MAGIC_SIZE) != 0 ||
        file[OFF_LF] != '\n') {
        return AH_ERR_INVALID;
    }
    kdf.nb_blocks = get_u32le(file + OFF_BLOCKS);
    kdf.nb_passes = get_u32le(file + OFF_PASSES);
    st = derive_key(password, password_size, kdf, file + OFF_SALT, key);
    if (st != AH_OK) {
        return st;
    }
    rc = crypto_aead_unlock(seed, file + OFF_MAC, key, file + OFF_NONCE, file, OFF_MAC,
                            file + OFF_CIPHER, AHSIGN_SEED_SIZE);
    crypto_wipe(key, sizeof key);
    if (rc != 0) {
        crypto_wipe(seed, sizeof seed);
        return AH_ERR_INVALID;
    }
    crypto_ed25519_key_pair(secret_key, derived_public, seed); /* apaga `seed` */
    /* A chave pública em claro está nos dados associados, mas confere-se com a
     * derivada da semente: o arquivo só vale se as duas coincidirem. */
    if (crypto_verify32(derived_public, file + OFF_PUBLIC) != 0) {
        crypto_wipe(secret_key, AHSIGN_SECRET_KEY_SIZE);
        return AH_ERR_INVALID;
    }
    memcpy(public_key, derived_public, sizeof derived_public);
    if (kdf_out != NULL) {
        *kdf_out = kdf;
    }
    return AH_OK;
}

int ahsign_kdf_is_weak(ahsign_kdf kdf) {
    return kdf.nb_blocks < ahsign_kdf_default.nb_blocks ||
           kdf.nb_passes < ahsign_kdf_default.nb_passes;
}

ah_status ahsign_sign_envelope(const uint8_t secret_key[AHSIGN_SECRET_KEY_SIZE],
                               const uint8_t *body, size_t body_size, uint8_t **out,
                               size_t *out_size) {
    ah_update_key key;
    uint8_t signature[AH_UPDATE_SIGNATURE_SIZE];
    uint8_t *msg;
    uint8_t *env;
    size_t msg_size;
    size_t env_size;
    const uint8_t *checked_body = NULL;
    size_t checked_size = 0;
    ah_status st;

    if (secret_key == NULL || out == NULL || out_size == NULL) {
        return AH_ERR_INVALID;
    }
    *out = NULL;
    *out_size = 0;
    if (body == NULL || body_size == 0) {
        return AH_ERR_INVALID;
    }
    if (body_size > AH_UPDATE_BODY_MAX) {
        return AH_ERR_LIMIT;
    }

    /* Mensagem assinada = prefixo de domínio || corpo (F8-04 §1.1, A2). */
    msg_size = AH_UPDATE_MAGIC_SIZE + 1u + body_size;
    msg = (uint8_t *)malloc(msg_size);
    if (msg == NULL) {
        return AH_ERR_NOMEM;
    }
    memcpy(msg, AH_UPDATE_MAGIC "\n", AH_UPDATE_MAGIC_SIZE + 1u);
    memcpy(msg + AH_UPDATE_MAGIC_SIZE + 1u, body, body_size);
    crypto_ed25519_sign(signature, secret_key, msg, msg_size);
    free(msg);

    /* Formato do Monocypher: os últimos 32 bytes da chave secreta são a pública. */
    memcpy(key.public_key, secret_key + AHSIGN_SEED_SIZE, sizeof key.public_key);
    ah_update_key_id(key.public_key, key.key_id);

    env_size = AH_UPDATE_HEADER_SIZE + body_size;
    env = (uint8_t *)malloc(env_size);
    if (env == NULL) {
        return AH_ERR_NOMEM;
    }
    st = ah_update_header_write(key.key_id, signature, env, env_size);
    if (st != AH_OK) {
        free(env);
        return st;
    }
    memcpy(env + AH_UPDATE_HEADER_SIZE, body, body_size);

    /* Confere com o mesmo verificador do atualizador antes de entregar. */
    st = ah_update_verify(env, env_size, &key, 1, &checked_body, &checked_size, NULL);
    if (st != AH_OK || checked_size != body_size) {
        free(env);
        return AH_ERR_INTERNAL;
    }
    *out = env;
    *out_size = env_size;
    return AH_OK;
}

static int append(char **p, size_t *left, const char *fmt, ...) {
    va_list ap;
    int n;
    va_start(ap, fmt);
    n = vsnprintf(*p, *left, fmt, ap);
    va_end(ap);
    if (n < 0 || (size_t)n >= *left) {
        return -1;
    }
    *p += n;
    *left -= (size_t)n;
    return 0;
}

ah_status ahsign_format_c_key(const uint8_t public_key[32], const char *name, char *out,
                              size_t out_cap) {
    uint8_t key_id[AH_UPDATE_KEY_ID_SIZE];
    char *p = out;
    size_t left = out_cap;
    size_t name_len;
    size_t i;
    int err = 0;

    if (public_key == NULL || name == NULL || out == NULL || out_cap == 0) {
        return AH_ERR_INVALID;
    }
    /* A tabela embutida nunca pode receber uma chave de ordem pequena. */
    if (ah_update_public_key_is_small_order(public_key)) {
        return AH_ERR_INVALID;
    }
    name_len = strlen(name);
    if (name_len == 0 || name_len > 64) {
        return AH_ERR_INVALID;
    }
    for (i = 0; i < name_len; i++) {
        char c = name[i];
        if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
              c == '_')) {
            return AH_ERR_INVALID;
        }
    }
    ah_update_key_id(public_key, key_id);

    err |= append(&p, &left, "/* %s: key_id ", name);
    for (i = 0; i < AH_UPDATE_KEY_ID_SIZE; i++) {
        err |= append(&p, &left, "%02x", key_id[i]);
    }
    err |= append(&p, &left, " (ahsign public) */\n{\n    .key_id = {");
    for (i = 0; i < AH_UPDATE_KEY_ID_SIZE; i++) {
        err |= append(&p, &left, "%s0x%02x", i == 0 ? " " : ", ", key_id[i]);
    }
    err |= append(&p, &left, " },\n    .public_key = {");
    for (i = 0; i < 32; i++) {
        err |= append(&p, &left, "%s0x%02x", i == 0 ? "\n        " : (i % 8 == 0 ? ",\n        " : ", "),
                      public_key[i]);
    }
    err |= append(&p, &left, " },\n},\n");
    if (err != 0) {
        out[0] = '\0';
        return AH_ERR_LIMIT;
    }
    return AH_OK;
}
