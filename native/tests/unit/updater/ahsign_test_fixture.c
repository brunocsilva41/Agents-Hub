/* Auxiliar SÓ de teste (unit.ahsign.roundtrip): grava em argv[1] um arquivo
 * de chave de teste selado pelo núcleo do ahsign com custo baixo do Argon2id,
 * para o roteiro exercitar `public` e `sign` sem pagar 256 MiB por chamada.
 * A senha de teste vem da primeira linha de stdin, como na CLI. A CLI não tem
 * opção de custo: chave de verdade só sai de `ahsign generate`.
 *
 * Saída: 0 gravado; 1 falha; 2 uso. */
#include <stdio.h>

#include "ah_platform_time.h"
#include "ahsign_key.h"
#include "ahsign_os.h"
#include "monocypher.h"

int main(int argc, char **argv) {
    static const ahsign_kdf k_test_kdf = {64u, 1u};
    char pw[AHSIGN_PASSWORD_MAX + 1];
    size_t pw_len = 0;
    uint8_t seed[AHSIGN_SEED_SIZE];
    uint8_t salt[AHSIGN_SALT_SIZE];
    uint8_t nonce[AHSIGN_NONCE_SIZE];
    uint8_t file[AHSIGN_KEY_FILE_SIZE];
    ah_status st;

    if (argc != 2) {
        fputs("uso: ahsign_test_fixture <arquivo-de-saida> < senha\n", stderr);
        return 2;
    }
    st = ahsign_os_read_password(1, "", pw, sizeof pw, &pw_len);
    if (st == AH_OK) {
        st = ah_platform_random_bytes(seed, sizeof seed);
    }
    if (st == AH_OK) {
        st = ah_platform_random_bytes(salt, sizeof salt);
    }
    if (st == AH_OK) {
        st = ah_platform_random_bytes(nonce, sizeof nonce);
    }
    if (st == AH_OK) {
        st = ahsign_key_seal(seed, (const uint8_t *)pw, pw_len, k_test_kdf, salt, nonce, file);
    }
    crypto_wipe(pw, sizeof pw);
    crypto_wipe(seed, sizeof seed);
    if (st == AH_OK) {
        st = ahsign_os_write_new_file(argv[1], file, sizeof file);
    }
    if (st != AH_OK) {
        fprintf(stderr, "ahsign_test_fixture: falhou (%d)\n", (int)st);
        return 1;
    }
    return 0;
}
