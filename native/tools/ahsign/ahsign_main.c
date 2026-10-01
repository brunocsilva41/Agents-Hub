/* ahsign — chave e assinatura do manifesto de atualização (F8-05).
 *
 *   ahsign generate --out <arquivo-da-chave> [--password-stdin]
 *   ahsign public   --key <arquivo-da-chave> [--name <nome>] [--password-stdin]
 *   ahsign sign     --key <arquivo-da-chave> --body <corpo> --out <envelope> [--password-stdin]
 *   ahsign verify   --public-key <64 hex> --in <envelope>
 *
 * A senha vem do terminal, sem eco, ou da primeira linha de stdin com
 * --password-stdin. Nunca de argv nem de variável de ambiente (CLAUDE.md,
 * regra de segredos). Nada secreto é impresso: só key_id e chave pública.
 *
 * Saída: 0 sucesso; 1 falha da operação; 2 uso incorreto. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ah_update_verify.h"
#include "ahsign_key.h"
#include "ah_platform_time.h"
#include "ahsign_os.h"
#include "monocypher.h"

enum { EXIT_OPFAIL = 1, EXIT_USAGE = 2 };

typedef struct options {
    const char *out;
    const char *key;
    const char *body;
    const char *in;
    const char *name;
    const char *public_key;
    int password_stdin;
} options;

static void usage(void) {
    fputs("uso:\n"
          "  ahsign generate --out <arquivo-da-chave> [--password-stdin]\n"
          "  ahsign public   --key <arquivo-da-chave> [--name <nome>] [--password-stdin]\n"
          "  ahsign sign     --key <arquivo-da-chave> --body <corpo> --out <envelope> "
          "[--password-stdin]\n"
          "  ahsign verify   --public-key <64 hex> --in <envelope>\n"
          "A senha e lida do terminal sem eco, ou da primeira linha de stdin com "
          "--password-stdin.\n",
          stderr);
}

static const char *status_text(ah_status st) {
    switch (st) {
    case AH_OK:
        return "ok";
    case AH_ERR_NOMEM:
        return "sem memoria";
    case AH_ERR_INVALID:
        return "entrada invalida";
    case AH_ERR_IO:
        return "falha de E/S";
    case AH_ERR_NOT_FOUND:
        return "nao encontrado";
    case AH_ERR_LIMIT:
        return "limite de tamanho excedido";
    case AH_ERR_INTERNAL:
        return "erro interno";
    }
    return "erro";
}

static void print_hex(FILE *f, const uint8_t *p, size_t n) {
    size_t i;
    for (i = 0; i < n; i++) {
        fprintf(f, "%02x", p[i]);
    }
}

static int parse_hex(const char *s, uint8_t *out, size_t out_size) {
    size_t i;
    if (strlen(s) != 2 * out_size) {
        return -1;
    }
    for (i = 0; i < 2 * out_size; i++) {
        char c = s[i];
        int v;
        if (c >= '0' && c <= '9') {
            v = c - '0';
        } else if (c >= 'a' && c <= 'f') {
            v = c - 'a' + 10;
        } else {
            return -1;
        }
        if (i % 2 == 0) {
            out[i / 2] = (uint8_t)(v << 4);
        } else {
            out[i / 2] = (uint8_t)(out[i / 2] | v);
        }
    }
    return 0;
}

/* Opções conhecidas, todas com valor exceto --password-stdin. Qualquer outra
 * (inclusive uma tentativa de passar a senha por argv) é erro de uso. */
static int parse_options(int argc, char **argv, options *o) {
    int i;
    memset(o, 0, sizeof *o);
    for (i = 2; i < argc; i++) {
        const char *a = argv[i];
        const char **slot = NULL;
        if (strcmp(a, "--password-stdin") == 0) {
            o->password_stdin = 1;
            continue;
        }
        if (strcmp(a, "--out") == 0) {
            slot = &o->out;
        } else if (strcmp(a, "--key") == 0) {
            slot = &o->key;
        } else if (strcmp(a, "--body") == 0) {
            slot = &o->body;
        } else if (strcmp(a, "--in") == 0) {
            slot = &o->in;
        } else if (strcmp(a, "--name") == 0) {
            slot = &o->name;
        } else if (strcmp(a, "--public-key") == 0) {
            slot = &o->public_key;
        } else {
            fprintf(stderr, "ahsign: opcao desconhecida: %s\n", a);
            return -1;
        }
        if (i + 1 >= argc || *slot != NULL) {
            fprintf(stderr, "ahsign: %s exige um valor (uma vez)\n", a);
            return -1;
        }
        *slot = argv[++i];
    }
    return 0;
}

/* Lê a senha; com `confirm`, pede duas vezes no terminal (não com stdin). */
static ah_status get_password(const options *o, int confirm, char *pw, size_t cap,
                              size_t *len) {
    char again[AHSIGN_PASSWORD_MAX + 1];
    size_t again_len = 0;
    ah_status st;

    st = ahsign_os_read_password(o->password_stdin, "Senha da chave: ", pw, cap, len);
    if (st != AH_OK) {
        if (st == AH_ERR_IO && !o->password_stdin) {
            fputs("ahsign: sem terminal para ler a senha; use --password-stdin\n", stderr);
        } else if (st == AH_ERR_INVALID && o->password_stdin) {
            fputs("ahsign: senha nao lida: vazia, ou stdin e um terminal (sem "
                  "--password-stdin a senha e lida sem eco)\n",
                  stderr);
        } else {
            fprintf(stderr, "ahsign: senha nao lida (%s)\n", status_text(st));
        }
        return st;
    }
    if (confirm && !o->password_stdin) {
        st = ahsign_os_read_password(0, "Repita a senha: ", again, sizeof again, &again_len);
        if (st != AH_OK || again_len != *len || memcmp(again, pw, *len) != 0) {
            crypto_wipe(again, sizeof again);
            crypto_wipe(pw, cap);
            fputs("ahsign: as senhas nao conferem\n", stderr);
            return AH_ERR_INVALID;
        }
        crypto_wipe(again, sizeof again);
    }
    return AH_OK;
}

/* Lê e abre o arquivo de chave. Com sucesso, sk e pk preenchidos. */
static int open_key(const options *o, uint8_t sk[AHSIGN_SECRET_KEY_SIZE], uint8_t pk[32]) {
    char pw[AHSIGN_PASSWORD_MAX + 1];
    size_t pw_len = 0;
    uint8_t *file = NULL;
    size_t file_size = 0;
    ahsign_kdf kdf = {0, 0};
    ah_status st;

    st = ahsign_os_read_file(o->key, AHSIGN_KEY_FILE_SIZE, &file, &file_size);
    if (st != AH_OK) {
        fprintf(stderr, "ahsign: nao li o arquivo da chave (%s)\n", status_text(st));
        return EXIT_OPFAIL;
    }
    if (get_password(o, 0, pw, sizeof pw, &pw_len) != AH_OK) {
        crypto_wipe(file, file_size);
        free(file);
        return EXIT_OPFAIL;
    }
    st = ahsign_key_open(file, file_size, (const uint8_t *)pw, pw_len, sk, pk, &kdf);
    crypto_wipe(pw, sizeof pw);
    crypto_wipe(file, file_size);
    free(file);
    if (st == AH_OK && ahsign_kdf_is_weak(kdf)) {
        fprintf(stderr,
                "ahsign: aviso: custo do Argon2id do arquivo (%u KiB, %u passadas) abaixo do "
                "padrao (%u KiB, %u passadas); gere a chave de novo com ahsign generate\n",
                (unsigned)kdf.nb_blocks, (unsigned)kdf.nb_passes,
                (unsigned)ahsign_kdf_default.nb_blocks, (unsigned)ahsign_kdf_default.nb_passes);
    }
    if (st != AH_OK) {
        if (st == AH_ERR_INVALID) {
            fputs("ahsign: senha incorreta ou arquivo de chave invalido\n", stderr);
        } else {
            fprintf(stderr, "ahsign: nao abri a chave (%s)\n", status_text(st));
        }
        return EXIT_OPFAIL;
    }
    return 0;
}

static int cmd_generate(const options *o) {
    char pw[AHSIGN_PASSWORD_MAX + 1];
    size_t pw_len = 0;
    uint8_t seed[AHSIGN_SEED_SIZE];
    uint8_t salt[AHSIGN_SALT_SIZE];
    uint8_t nonce[AHSIGN_NONCE_SIZE];
    uint8_t file[AHSIGN_KEY_FILE_SIZE];
    uint8_t pk[32];
    uint8_t key_id[AH_UPDATE_KEY_ID_SIZE];
    ah_status st;

    if (o->out == NULL || o->key || o->body || o->in || o->name || o->public_key) {
        usage();
        return EXIT_USAGE;
    }
    if (ahsign_os_exists(o->out)) {
        fprintf(stderr, "ahsign: %s ja existe; nao sobrescrevo\n", o->out);
        return EXIT_OPFAIL;
    }
    if (ahsign_os_parent_writable_by_others(o->out)) {
        fprintf(stderr, "ahsign: aviso: a pasta de %s aceita escrita de grupo ou de outros "
                        "usuarios; quem escreve ali pode trocar o arquivo da chave\n",
                o->out);
    }
    if (get_password(o, 1, pw, sizeof pw, &pw_len) != AH_OK) {
        return EXIT_OPFAIL;
    }
    st = ah_platform_random_bytes(seed, sizeof seed);
    if (st == AH_OK) {
        st = ah_platform_random_bytes(salt, sizeof salt);
    }
    if (st == AH_OK) {
        st = ah_platform_random_bytes(nonce, sizeof nonce);
    }
    if (st == AH_OK) {
        st = ahsign_key_seal(seed, (const uint8_t *)pw, pw_len, ahsign_kdf_default, salt,
                             nonce, file);
    }
    crypto_wipe(pw, sizeof pw);
    crypto_wipe(seed, sizeof seed);
    if (st != AH_OK) {
        fprintf(stderr, "ahsign: nao gerei a chave (%s)\n", status_text(st));
        return EXIT_OPFAIL;
    }
    st = ahsign_os_write_new_file(o->out, file, sizeof file);
    if (st != AH_OK) {
        fprintf(stderr, "ahsign: nao gravei %s (ja existe ou sem permissao)\n", o->out);
        return EXIT_OPFAIL;
    }
    memcpy(pk, file + AHSIGN_KEY_FILE_PUBLIC_OFFSET, sizeof pk);
    ah_update_key_id(pk, key_id);
    fputs("key_id: ", stdout);
    print_hex(stdout, key_id, sizeof key_id);
    fputs("\npublic_key: ", stdout);
    print_hex(stdout, pk, sizeof pk);
    fputs("\n", stdout);
    return 0;
}

static int cmd_public(const options *o) {
    uint8_t sk[AHSIGN_SECRET_KEY_SIZE];
    uint8_t pk[32];
    char text[1024];
    ah_status st;
    int rc;

    if (o->key == NULL || o->out || o->body || o->in || o->public_key) {
        usage();
        return EXIT_USAGE;
    }
    rc = open_key(o, sk, pk);
    crypto_wipe(sk, sizeof sk); /* só a pública interessa aqui */
    if (rc != 0) {
        return rc;
    }
    if (ah_update_public_key_is_small_order(pk)) {
        fputs("ahsign: recusado: chave publica de ordem pequena\n", stderr);
        return EXIT_OPFAIL;
    }
    st = ahsign_format_c_key(pk, o->name != NULL ? o->name : "chave", text, sizeof text);
    if (st != AH_OK) {
        fprintf(stderr, "ahsign: nao formatei a chave (%s)\n", status_text(st));
        return st == AH_ERR_INVALID ? EXIT_USAGE : EXIT_OPFAIL;
    }
    fputs(text, stdout);
    return 0;
}

static int cmd_sign(const options *o) {
    uint8_t sk[AHSIGN_SECRET_KEY_SIZE];
    uint8_t pk[32];
    uint8_t *body = NULL;
    size_t body_size = 0;
    uint8_t *env = NULL;
    size_t env_size = 0;
    ah_status st;
    int rc;

    if (o->key == NULL || o->body == NULL || o->out == NULL || o->in || o->name ||
        o->public_key) {
        usage();
        return EXIT_USAGE;
    }
    if (ahsign_os_exists(o->out)) {
        fprintf(stderr, "ahsign: %s ja existe; nao sobrescrevo\n", o->out);
        return EXIT_OPFAIL;
    }
    st = ahsign_os_read_file(o->body, AH_UPDATE_BODY_MAX, &body, &body_size);
    if (st != AH_OK) {
        fprintf(stderr, "ahsign: nao li o corpo (%s)\n", status_text(st));
        return EXIT_OPFAIL;
    }
    rc = open_key(o, sk, pk);
    if (rc != 0) {
        free(body);
        return rc;
    }
    st = ahsign_sign_envelope(sk, body, body_size, &env, &env_size);
    crypto_wipe(sk, sizeof sk);
    free(body);
    if (st != AH_OK) {
        fprintf(stderr, "ahsign: nao assinei (%s)\n", status_text(st));
        return EXIT_OPFAIL;
    }
    st = ahsign_os_write_new_file(o->out, env, env_size);
    free(env);
    if (st != AH_OK) {
        fprintf(stderr, "ahsign: nao gravei %s (ja existe ou sem permissao)\n", o->out);
        return EXIT_OPFAIL;
    }
    {
        uint8_t key_id[AH_UPDATE_KEY_ID_SIZE];
        ah_update_key_id(pk, key_id);
        fputs("assinado: key_id ", stdout);
        print_hex(stdout, key_id, sizeof key_id);
        fprintf(stdout, ", envelope de %u bytes\n", (unsigned)env_size);
    }
    return 0;
}

static int cmd_verify(const options *o) {
    ah_update_key key;
    uint8_t *env = NULL;
    size_t env_size = 0;
    const uint8_t *body = NULL;
    size_t body_size = 0;
    ah_status st;

    if (o->public_key == NULL || o->in == NULL || o->key || o->body || o->out || o->name ||
        o->password_stdin) {
        usage();
        return EXIT_USAGE;
    }
    if (parse_hex(o->public_key, key.public_key, sizeof key.public_key) != 0) {
        fputs("ahsign: --public-key exige 64 hex minusculos\n", stderr);
        return EXIT_USAGE;
    }
    /* Ponto de ordem pequena aceitaria qualquer envelope (R = identidade, S = 0). */
    if (ah_update_public_key_is_small_order(key.public_key)) {
        fputs("ahsign: recusado: chave publica de ordem pequena\n", stderr);
        return EXIT_OPFAIL;
    }
    ah_update_key_id(key.public_key, key.key_id);
    st = ahsign_os_read_file(o->in, AH_UPDATE_ENVELOPE_MAX, &env, &env_size);
    if (st != AH_OK) {
        fprintf(stderr, "ahsign: nao li o envelope (%s)\n", status_text(st));
        return EXIT_OPFAIL;
    }
    st = ah_update_verify(env, env_size, &key, 1, &body, &body_size, NULL);
    free(env);
    if (st != AH_OK) {
        if (st == AH_ERR_NOT_FOUND) {
            fputs("ahsign: recusado: assinado por outra chave\n", stderr);
        } else if (st == AH_ERR_INVALID) {
            fputs("ahsign: recusado: cabecalho ou assinatura invalida\n", stderr);
        } else {
            fprintf(stderr, "ahsign: recusado (%s)\n", status_text(st));
        }
        return EXIT_OPFAIL;
    }
    fputs("ok: key_id ", stdout);
    print_hex(stdout, key.key_id, sizeof key.key_id);
    fprintf(stdout, ", corpo de %u bytes\n", (unsigned)body_size);
    return 0;
}

int main(int argc, char **argv) {
    char **args = NULL;
    int nargs = 0;
    options o;
    int rc;

    if (ahsign_os_args_utf8(argc, argv, &nargs, &args) != AH_OK) {
        fputs("ahsign: argumentos invalidos (UTF-8)\n", stderr);
        return EXIT_USAGE;
    }
    if (nargs < 2 || parse_options(nargs, args, &o) != 0) {
        usage();
        ahsign_os_free_args(nargs, args);
        return EXIT_USAGE;
    }
    if (strcmp(args[1], "generate") == 0) {
        rc = cmd_generate(&o);
    } else if (strcmp(args[1], "public") == 0) {
        rc = cmd_public(&o);
    } else if (strcmp(args[1], "sign") == 0) {
        rc = cmd_sign(&o);
    } else if (strcmp(args[1], "verify") == 0) {
        rc = cmd_verify(&o);
    } else {
        usage();
        rc = EXIT_USAGE;
    }
    ahsign_os_free_args(nargs, args);
    return rc;
}
