/* F1-01: SHA-256 (base do objectiveHash). Vetores do NIST (FIPS 180-4,
 * exemplos "abc", 448 e 896 bits, um milhão de 'a') e fronteiras de bloco
 * conferidas com createHash('sha256') do Node 24.14.0. */
#include <stdlib.h>
#include <string.h>

#include "ah_sha256.h"
#include "ah_test.h"

static void to_hex(const unsigned char *d, char *out) {
    static const char hex[] = "0123456789abcdef";
    int i;

    for (i = 0; i < AH_SHA256_DIGEST_SIZE; i++) {
        out[2 * i] = hex[d[i] >> 4];
        out[2 * i + 1] = hex[d[i] & 0x0F];
    }
    out[2 * AH_SHA256_DIGEST_SIZE] = '\0';
}

static int digest_is(const void *data, size_t len, const char *expect) {
    unsigned char d[AH_SHA256_DIGEST_SIZE];
    char h[2 * AH_SHA256_DIGEST_SIZE + 1];

    ah_sha256_digest(data, len, d);
    to_hex(d, h);
    if (strcmp(h, expect) != 0) {
        fprintf(stderr, "  len %u: %s != %s\n", (unsigned)len, h, expect);
        return 0;
    }
    return 1;
}

static void test_nist(void) {
    static const char m448[] = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
    static const char m896[] = "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmn"
                               "hijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu";

    CHECK(digest_is("", 0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"));
    CHECK(digest_is(NULL, 0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"));
    CHECK(digest_is("abc", 3, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
    CHECK(digest_is(m448, sizeof m448 - 1,
                    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"));
    CHECK(digest_is(m896, sizeof m896 - 1,
                    "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1"));
}

static void test_million_a_incremental(void) {
    unsigned char chunk[1000];
    unsigned char d[AH_SHA256_DIGEST_SIZE];
    char h[2 * AH_SHA256_DIGEST_SIZE + 1];
    ah_sha256 ctx;
    int i;

    memset(chunk, 'a', sizeof chunk);
    ah_sha256_init(&ctx);
    for (i = 0; i < 1000; i++) {
        ah_sha256_update(&ctx, chunk, sizeof chunk);
    }
    ah_sha256_final(&ctx, d);
    to_hex(d, h);
    CHECK(strcmp(h, "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0") == 0);
}

/* Fronteiras do preenchimento (55/56 bytes no último bloco) e de bloco. */
static void test_block_edges(void) {
    static const struct {
        size_t n;
        const char *hex;
    } cases[] = {
        {55, "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318"},
        {56, "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a"},
        {57, "f13b2d724659eb3bf47f2dd6af1accc87b81f09f59f2b75e5c0bed6589dfe8c6"},
        {63, "7d3e74a05d7db15bce4ad9ec0658ea98e3f06eeecf16b4c6fff2da457ddc2f34"},
        {64, "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb"},
        {65, "635361c48bb9eab14198e76ea8ab7f1a41685d6ad62aa9146d301d4f17eb0ae0"},
        {119, "31eba51c313a5c08226adf18d4a359cfdfd8d2e816b13f4af952f7ea6584dcfb"},
        {120, "2f3d335432c70b580af0e8e1b3674a7c020d683aa5f73aaaedfdc55af904c21c"},
        {128, "6836cf13bac400e9105071cd6af47084dfacad4e5e302c94bfed24e013afb73e"},
    };
    unsigned char buf[128];
    size_t i;

    memset(buf, 'a', sizeof buf);
    for (i = 0; i < sizeof cases / sizeof cases[0]; i++) {
        CHECK(digest_is(buf, cases[i].n, cases[i].hex));
    }
}

/* Qualquer fatiamento da entrada dá o mesmo resumo que de uma vez. */
static void test_chunking(void) {
    unsigned char data[300];
    unsigned char one[AH_SHA256_DIGEST_SIZE];
    unsigned char inc[AH_SHA256_DIGEST_SIZE];
    size_t step;
    size_t i;

    for (i = 0; i < sizeof data; i++) {
        data[i] = (unsigned char)(i * 7u + 3u);
    }
    ah_sha256_digest(data, sizeof data, one);
    for (step = 1; step <= 130; step++) {
        ah_sha256 ctx;
        size_t off = 0;

        ah_sha256_init(&ctx);
        while (off < sizeof data) {
            size_t n = sizeof data - off < step ? sizeof data - off : step;
            ah_sha256_update(&ctx, data + off, n);
            off += n;
        }
        ah_sha256_final(&ctx, inc);
        CHECK(memcmp(one, inc, sizeof one) == 0);
    }
}

int main(void) {
    test_nist();
    test_million_a_incremental();
    test_block_edges();
    test_chunking();
    return AH_TEST_END("test_core_sha256");
}
