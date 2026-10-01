/* Testes do núcleo da ferramenta ahsign (F8-05): arquivo de chave cifrado,
 * assinatura do envelope e exportação da chave pública. Chaves e senhas são
 * de teste, geradas aqui; nenhuma chave real.
 *
 * argv[1]: diretório de trabalho já existente (o diretório do alvo no build).
 *
 * O cabeçalho do arquivo de chave nunca aparece literal neste arquivo: vem da
 * constante ahsign_key_file_magic (o teste T14 varre o repositório por ele). */
#include <stdlib.h>
#include <string.h>

#include "ah_test.h"
#include "ah_update_verify.h"
#include "ahsign_key.h"
#include "ahsign_os.h"
#include "monocypher-ed25519.h"
#include "monocypher.h"

/* Custo baixo só para o teste ficar rápido; a CLI usa ahsign_kdf_default. */
static const ahsign_kdf k_fast = {64u, 1u};

static const char k_password[] = "senha de teste, efemera";

static int contains(const uint8_t *hay, size_t hay_size, const uint8_t *needle, size_t n) {
    size_t i;
    if (n == 0 || n > hay_size) {
        return 0;
    }
    for (i = 0; i + n <= hay_size; i++) {
        if (memcmp(hay + i, needle, n) == 0) {
            return 1;
        }
    }
    return 0;
}

typedef struct sealed {
    uint8_t seed[AHSIGN_SEED_SIZE];
    uint8_t salt[AHSIGN_SALT_SIZE];
    uint8_t nonce[AHSIGN_NONCE_SIZE];
    uint8_t file[AHSIGN_KEY_FILE_SIZE];
} sealed;

static int make_sealed(sealed *s, ahsign_kdf kdf) {
    if (ahsign_os_random(s->seed, sizeof s->seed) != AH_OK ||
        ahsign_os_random(s->salt, sizeof s->salt) != AH_OK ||
        ahsign_os_random(s->nonce, sizeof s->nonce) != AH_OK) {
        return -1;
    }
    return ahsign_key_seal(s->seed, (const uint8_t *)k_password, sizeof k_password - 1, kdf,
                           s->salt, s->nonce, s->file) == AH_OK
               ? 0
               : -1;
}

static void test_random(void) {
    uint8_t a[32];
    uint8_t b[32];
    uint8_t zero[32];
    memset(zero, 0, sizeof zero);
    CHECK(ahsign_os_random(a, sizeof a) == AH_OK);
    CHECK(ahsign_os_random(b, sizeof b) == AH_OK);
    CHECK(memcmp(a, b, sizeof a) != 0);
    CHECK(memcmp(a, zero, sizeof a) != 0);
    CHECK(ahsign_os_random(a, 0) == AH_OK);
}

static void test_seal_open_roundtrip(void) {
    sealed s;
    uint8_t seed_copy[32];
    uint8_t sk_expected[64];
    uint8_t pk_expected[32];
    uint8_t sk[64];
    uint8_t pk[32];

    CHECK(make_sealed(&s, k_fast) == 0);
    /* Chave esperada derivada da mesma semente pelo Monocypher. */
    memcpy(seed_copy, s.seed, sizeof seed_copy);
    crypto_ed25519_key_pair(sk_expected, pk_expected, seed_copy);

    /* Cabeçalho fixo no início, LF, chave pública em claro na posição documentada. */
    CHECK(memcmp(s.file, ahsign_key_file_magic, AHSIGN_KEY_FILE_MAGIC_SIZE) == 0);
    CHECK(s.file[AHSIGN_KEY_FILE_MAGIC_SIZE] == '\n');
    CHECK(memcmp(s.file + AHSIGN_KEY_FILE_PUBLIC_OFFSET, pk_expected, 32) == 0);

    CHECK(ahsign_key_open(s.file, sizeof s.file, (const uint8_t *)k_password,
                          sizeof k_password - 1, sk, pk) == AH_OK);
    CHECK(memcmp(sk, sk_expected, 64) == 0);
    CHECK(memcmp(pk, pk_expected, 32) == 0);

    /* O arquivo não traz a chave privada em claro: nem a semente (32 bytes),
     * nem a chave secreta de 64 bytes, nem metade dela, nem a senha. */
    CHECK(!contains(s.file, sizeof s.file, s.seed, 32));
    CHECK(!contains(s.file, sizeof s.file, sk_expected, 64));
    CHECK(!contains(s.file, sizeof s.file, s.seed, 16));
    CHECK(!contains(s.file, sizeof s.file, s.seed + 16, 16));
    CHECK(!contains(s.file, sizeof s.file, (const uint8_t *)k_password, sizeof k_password - 1));

    crypto_wipe(sk, sizeof sk);
    crypto_wipe(sk_expected, sizeof sk_expected);
    crypto_wipe(&s, sizeof s);
}

static void test_open_rejects(void) {
    sealed s;
    uint8_t sk[64];
    uint8_t pk[32];
    uint8_t copy[AHSIGN_KEY_FILE_SIZE];
    size_t pos;
    int accepted = 0;

    CHECK(make_sealed(&s, k_fast) == 0);

    /* Senha errada, vazia, ou nula. */
    CHECK(ahsign_key_open(s.file, sizeof s.file, (const uint8_t *)"outra senha", 11, sk, pk) ==
          AH_ERR_INVALID);
    CHECK(ahsign_key_open(s.file, sizeof s.file, (const uint8_t *)k_password, 0, sk, pk) ==
          AH_ERR_INVALID);
    CHECK(ahsign_key_open(s.file, sizeof s.file, NULL, 4, sk, pk) == AH_ERR_INVALID);

    /* Tamanho errado. */
    CHECK(ahsign_key_open(s.file, sizeof s.file - 1, (const uint8_t *)k_password,
                          sizeof k_password - 1, sk, pk) == AH_ERR_INVALID);

    /* Qualquer byte alterado (cabeçalho, custo, sal, nonce, pública, MAC, cifra): recusa.
     * Os bytes de custo trocados podem pedir mais memória; ficam limitados pela faixa. */
    for (pos = 0; pos < sizeof s.file; pos++) {
        memcpy(copy, s.file, sizeof copy);
        copy[pos] ^= 0x01;
        if (ahsign_key_open(copy, sizeof copy, (const uint8_t *)k_password,
                            sizeof k_password - 1, sk, pk) == AH_OK) {
            accepted++;
            fprintf(stderr, "byte %u alterado e aceito\n", (unsigned)pos);
        }
    }
    CHECK(accepted == 0);
    crypto_wipe(sk, sizeof sk);
    crypto_wipe(&s, sizeof s);
}

static void test_kdf_bounds(void) {
    sealed s;
    uint8_t out[AHSIGN_KEY_FILE_SIZE];
    ahsign_kdf low = {AHSIGN_KDF_MIN_BLOCKS - 1u, 1u};
    ahsign_kdf high = {AHSIGN_KDF_MAX_BLOCKS + 1u, 1u};
    ahsign_kdf nopass = {64u, 0u};
    uint8_t sk[64];
    uint8_t pk[32];

    CHECK(make_sealed(&s, k_fast) == 0);
    CHECK(ahsign_key_seal(s.seed, (const uint8_t *)"x", 1, low, s.salt, s.nonce, out) ==
          AH_ERR_INVALID);
    CHECK(ahsign_key_seal(s.seed, (const uint8_t *)"x", 1, high, s.salt, s.nonce, out) ==
          AH_ERR_INVALID);
    CHECK(ahsign_key_seal(s.seed, (const uint8_t *)"x", 1, nopass, s.salt, s.nonce, out) ==
          AH_ERR_INVALID);
    CHECK(ahsign_key_seal(s.seed, (const uint8_t *)"x", 0, k_fast, s.salt, s.nonce, out) ==
          AH_ERR_INVALID);
    CHECK(ahsign_key_seal(s.seed, (const uint8_t *)"x", 1025, k_fast, s.salt, s.nonce, out) ==
          AH_ERR_INVALID);

    /* Arquivo pedindo 4 GiB de memória: recusado sem tentar alocar. */
    memcpy(out, s.file, sizeof out);
    out[25] = 0xff;
    out[26] = 0xff;
    out[27] = 0xff;
    out[28] = 0xff;
    CHECK(ahsign_key_open(out, sizeof out, (const uint8_t *)k_password, sizeof k_password - 1,
                          sk, pk) == AH_ERR_INVALID);

    /* O custo padrão da CLI está dentro da faixa e não é o de teste. */
    CHECK(ahsign_kdf_default.nb_blocks >= 64u * 1024u);
    CHECK(ahsign_kdf_default.nb_blocks <= AHSIGN_KDF_MAX_BLOCKS);
    CHECK(ahsign_kdf_default.nb_passes >= 3u);
    crypto_wipe(&s, sizeof s);
}

static void test_sign_envelope(void) {
    sealed s;
    uint8_t sk[64];
    uint8_t pk[32];
    ah_update_key key;
    uint8_t *env = NULL;
    size_t env_size = 0;
    const uint8_t *body = NULL;
    size_t body_size = 0;
    static const char text[] = "{\"schema\": 1}\n";
    uint8_t *big;

    CHECK(make_sealed(&s, k_fast) == 0);
    CHECK(ahsign_key_open(s.file, sizeof s.file, (const uint8_t *)k_password,
                          sizeof k_password - 1, sk, pk) == AH_OK);
    memcpy(key.public_key, pk, 32);
    ah_update_key_id(pk, key.key_id);

    CHECK(ahsign_sign_envelope(sk, (const uint8_t *)text, sizeof text - 1, &env, &env_size) ==
          AH_OK);
    CHECK(env != NULL && env_size == AH_UPDATE_HEADER_SIZE + sizeof text - 1);
    if (env != NULL) {
        CHECK(ah_update_verify(env, env_size, &key, 1, &body, &body_size, NULL) == AH_OK);
        CHECK(body_size == sizeof text - 1 && memcmp(body, text, body_size) == 0);
        /* O envelope não carrega a chave privada. */
        CHECK(!contains(env, env_size, sk, 32));
        free(env);
        env = NULL;
    }

    CHECK(ahsign_sign_envelope(sk, (const uint8_t *)text, 0, &env, &env_size) == AH_ERR_INVALID);
    big = (uint8_t *)malloc(AH_UPDATE_BODY_MAX + 1u);
    CHECK(big != NULL);
    if (big != NULL) {
        memset(big, 'a', AH_UPDATE_BODY_MAX + 1u);
        CHECK(ahsign_sign_envelope(sk, big, AH_UPDATE_BODY_MAX + 1u, &env, &env_size) ==
              AH_ERR_LIMIT);
        CHECK(ahsign_sign_envelope(sk, big, AH_UPDATE_BODY_MAX, &env, &env_size) == AH_OK);
        CHECK(env_size == AH_UPDATE_ENVELOPE_MAX);
        free(env);
        free(big);
    }
    crypto_wipe(sk, sizeof sk);
    crypto_wipe(&s, sizeof s);
}

static void test_format_c_key(void) {
    uint8_t pk[32];
    uint8_t id[8];
    char out[1024];
    char expect_id[64];
    size_t i;
    int n;

    for (i = 0; i < sizeof pk; i++) {
        pk[i] = (uint8_t)(0xa0u + i);
    }
    ah_update_key_id(pk, id);
    CHECK(ahsign_format_c_key(pk, "k_atual", out, sizeof out) == AH_OK);
    n = snprintf(expect_id, sizeof expect_id, "key_id %02x%02x%02x%02x%02x%02x%02x%02x", id[0],
                 id[1], id[2], id[3], id[4], id[5], id[6], id[7]);
    CHECK(n > 0 && (size_t)n < sizeof expect_id);
    CHECK(strstr(out, expect_id) != NULL);
    CHECK(strstr(out, "/* k_atual: ") == out);
    CHECK(strstr(out, ".public_key = {\n        0xa0, 0xa1,") != NULL);
    CHECK(strstr(out, "0xbf },\n},\n") != NULL);

    CHECK(ahsign_format_c_key(pk, "a*/b", out, sizeof out) == AH_ERR_INVALID);
    CHECK(ahsign_format_c_key(pk, "", out, sizeof out) == AH_ERR_INVALID);
    CHECK(ahsign_format_c_key(pk, "k", out, 40) == AH_ERR_LIMIT);
}

static void join(char *out, size_t cap, const char *dir, const char *name) {
    int n = snprintf(out, cap, "%s/%s", dir, name);
    if (n < 0 || (size_t)n >= cap) {
        out[0] = '\0';
    }
}

/* Gravação exclusiva e leitura de volta, num diretório de trabalho do build. */
static void test_file_io(const char *dir) {
    sealed s;
    char path[1024];
    uint8_t *data = NULL;
    size_t size = 0;
    uint8_t suffix[8];
    char name[64];
    int n;

    CHECK(make_sealed(&s, k_fast) == 0);
    CHECK(ahsign_os_random(suffix, sizeof suffix) == AH_OK);
    n = snprintf(name, sizeof name, "chave-%02x%02x%02x%02x.bin", suffix[0], suffix[1],
                 suffix[2], suffix[3]);
    CHECK(n > 0 && (size_t)n < sizeof name);
    join(path, sizeof path, dir, name);
    CHECK(path[0] != '\0');

    CHECK(ahsign_os_write_new_file(path, s.file, sizeof s.file) == AH_OK);
    /* Não sobrescreve. */
    CHECK(ahsign_os_write_new_file(path, s.file, sizeof s.file) == AH_ERR_IO);
    CHECK(ahsign_os_read_file(path, AHSIGN_KEY_FILE_SIZE - 1, &data, &size) == AH_ERR_LIMIT);
    CHECK(data == NULL);
    CHECK(ahsign_os_read_file(path, AHSIGN_KEY_FILE_SIZE, &data, &size) == AH_OK);
    CHECK(size == sizeof s.file && data != NULL && memcmp(data, s.file, size) == 0);
    /* Os bytes gravados em disco não contêm a semente. */
    CHECK(data != NULL && !contains(data, size, s.seed, 32));
    free(data);
    CHECK(remove(path) == 0);
    crypto_wipe(&s, sizeof s);
}

int main(int argc, char **argv) {
    test_random();
    test_seal_open_roundtrip();
    test_open_rejects();
    test_kdf_bounds();
    test_sign_envelope();
    test_format_c_key();
    CHECK(argc >= 2);
    if (argc >= 2) {
        test_file_io(argv[1]);
    }
    return AH_TEST_END("test_ahsign_key");
}
