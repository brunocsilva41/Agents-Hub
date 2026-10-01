#include "ah_sha256.h"

#include <string.h>

/* Constantes K da FIPS 180-4 §4.2.2. */
static const uint32_t K[64] = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u, 0x923f82a4u,
    0xab1c5ed5u, 0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu,
    0x9bdc06a7u, 0xc19bf174u, 0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu,
    0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau, 0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u,
    0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u, 0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu,
    0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u, 0xa2bfe8a1u, 0xa81a664bu,
    0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u, 0x19a4c116u,
    0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
    0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u, 0x90befffau, 0xa4506cebu, 0xbef9a3f7u,
    0xc67178f2u};

static uint32_t rotr(uint32_t x, unsigned n) {
    return (x >> n) | (x << (32u - n));
}

static void compress(uint32_t h[8], const unsigned char block[64]) {
    uint32_t w[64];
    uint32_t a, b, c, d, e, f, g, hh;
    unsigned i;

    for (i = 0; i < 16; i++) {
        w[i] = ((uint32_t)block[4 * i] << 24) | ((uint32_t)block[4 * i + 1] << 16) |
               ((uint32_t)block[4 * i + 2] << 8) | (uint32_t)block[4 * i + 3];
    }
    for (i = 16; i < 64; i++) {
        uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
        uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    a = h[0];
    b = h[1];
    c = h[2];
    d = h[3];
    e = h[4];
    f = h[5];
    g = h[6];
    hh = h[7];
    for (i = 0; i < 64; i++) {
        uint32_t S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        uint32_t ch = (e & f) ^ (~e & g);
        uint32_t t1 = hh + S1 + ch + K[i] + w[i];
        uint32_t S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
        uint32_t t2 = S0 + maj;
        hh = g;
        g = f;
        f = e;
        e = d + t1;
        d = c;
        c = b;
        b = a;
        a = t1 + t2;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
}

void ah_sha256_init(ah_sha256 *ctx) {
    /* Valores iniciais da FIPS 180-4 §5.3.3. */
    ctx->h[0] = 0x6a09e667u;
    ctx->h[1] = 0xbb67ae85u;
    ctx->h[2] = 0x3c6ef372u;
    ctx->h[3] = 0xa54ff53au;
    ctx->h[4] = 0x510e527fu;
    ctx->h[5] = 0x9b05688cu;
    ctx->h[6] = 0x1f83d9abu;
    ctx->h[7] = 0x5be0cd19u;
    ctx->total_len = 0;
    ctx->used = 0;
}

void ah_sha256_update(ah_sha256 *ctx, const void *data, size_t len) {
    const unsigned char *p = data;

    if (len == 0) {
        return;
    }
    ctx->total_len += (uint64_t)len;
    if (ctx->used != 0) {
        size_t take = 64 - ctx->used;
        if (take > len) {
            take = len;
        }
        memcpy(ctx->block + ctx->used, p, take);
        ctx->used += take;
        p += take;
        len -= take;
        if (ctx->used < 64) {
            return;
        }
        compress(ctx->h, ctx->block);
        ctx->used = 0;
    }
    while (len >= 64) {
        compress(ctx->h, p);
        p += 64;
        len -= 64;
    }
    if (len != 0) {
        memcpy(ctx->block, p, len);
        ctx->used = len;
    }
}

void ah_sha256_final(ah_sha256 *ctx, unsigned char out[AH_SHA256_DIGEST_SIZE]) {
    uint64_t bits = ctx->total_len * 8u;
    unsigned i;

    /* Preenchimento da FIPS 180-4 §5.1.1: 0x80, zeros, comprimento em bits
     * (64 bits big-endian) no fim do último bloco. */
    ctx->block[ctx->used++] = 0x80;
    if (ctx->used > 56) {
        memset(ctx->block + ctx->used, 0, 64 - ctx->used);
        compress(ctx->h, ctx->block);
        ctx->used = 0;
    }
    memset(ctx->block + ctx->used, 0, 56 - ctx->used);
    for (i = 0; i < 8; i++) {
        ctx->block[56 + i] = (unsigned char)(bits >> (56 - 8 * i));
    }
    compress(ctx->h, ctx->block);
    for (i = 0; i < 8; i++) {
        out[4 * i] = (unsigned char)(ctx->h[i] >> 24);
        out[4 * i + 1] = (unsigned char)(ctx->h[i] >> 16);
        out[4 * i + 2] = (unsigned char)(ctx->h[i] >> 8);
        out[4 * i + 3] = (unsigned char)ctx->h[i];
    }
    ctx->used = 0;
}

void ah_sha256_digest(const void *data, size_t len, unsigned char out[AH_SHA256_DIGEST_SIZE]) {
    ah_sha256 ctx;

    ah_sha256_init(&ctx);
    ah_sha256_update(&ctx, data, len);
    ah_sha256_final(&ctx, out);
}
