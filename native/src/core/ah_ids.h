/* Ids, carimbo de tempo e objectiveHash do domínio (plano docs/17, F1-01;
 * SPEC-04 A1 "Identificadores"; SPEC-02 §4.1; fonte core/src/ids.ts).
 *
 * O core não chama o SO (docs/18 §3 e §7): o UUID v4 e o relógio entram por
 * portas injetadas (struct de ponteiros de função). Quem monta o programa liga
 * as portas a ah_platform_uuid_v4 e ah_platform_time_now_iso (F0-06). */
#ifndef AH_CORE_IDS_H
#define AH_CORE_IDS_H

#include <stddef.h>

#include "ah_status.h"

/* Prefixos de id (core/src/ids.ts:7), na ordem do TS. */
typedef enum ah_id_prefix {
    AH_ID_PRJ, /* projeto */
    AH_ID_PFD, /* pasta de projeto */
    AH_ID_SES, /* sessão */
    AH_ID_TSK, /* task */
    AH_ID_EVT, /* evento */
    AH_ID_APV, /* aprovação */
    AH_ID_ART, /* artefato */
    AH_ID_RUN, /* run */
    AH_ID_AUD, /* registro de auditoria */
    AH_ID_PREFIX_COUNT
} ah_id_prefix;

/* "<prefixo>_" + 24 hex minúsculos: 28 caracteres + terminador. */
#define AH_ID_SIZE 29

/* "AAAA-MM-DDTHH:MM:SS.mmmZ": 24 caracteres + terminador (mesmo valor de
 * AH_PLATFORM_ISO_TIME_SIZE). */
#define AH_ISO_TIME_SIZE 25

/* 16 hex minúsculos + terminador. */
#define AH_OBJECTIVE_HASH_SIZE 17

/* Texto do prefixo ("prj", "pfd"...), ou NULL se `p` está fora do enum.
 * Posse: estático. */
const char *ah_id_prefix_name(ah_id_prefix p);

/* Porta de UUID v4: escreve em `out` (out_size >= 37) o UUID no formato de
 * crypto.randomUUID() ("xxxxxxxx-xxxx-4xxx-Yxxx-xxxxxxxxxxxx", hex
 * minúsculo). `ah_platform_uuid_v4` tem esse contrato. */
typedef struct ah_id_uuid_port {
    ah_status (*uuid_v4)(void *ctx, char *out, size_t out_size);
    void *ctx;
} ah_id_uuid_port;

/* Porta de relógio: escreve em `out` (out_size >= AH_ISO_TIME_SIZE) o agora
 * como `new Date().toISOString()`. `ah_platform_time_now_iso` tem esse
 * contrato. */
typedef struct ah_clock_port {
    ah_status (*now_iso)(void *ctx, char *out, size_t out_size);
    void *ctx;
} ah_clock_port;

/* `newId(prefix)`: "<prefixo>_" + os 24 primeiros hex do UUID v4 da porta,
 * sem hífens (core/src/ids.ts:9-11). Erros: AH_ERR_INVALID (argumento),
 * AH_ERR_LIMIT (out_size < AH_ID_SIZE), o erro da porta repassado, e
 * AH_ERR_INTERNAL se a porta devolver algo fora do formato de UUID v4.
 * Em erro, out recebe "" quando out_size > 0. `port` é emprestada. */
ah_status ah_id_new(const ah_id_uuid_port *port, ah_id_prefix prefix, char *out,
                    size_t out_size);

/* `nowIso()` (core/src/ids.ts:31-33) pela porta de relógio. Confere a forma
 * fixa "AAAA-MM-DDTHH:MM:SS.mmmZ", de que dependem as comparações de
 * retenção por string (SPEC-02 §4.1); fora dela, AH_ERR_INTERNAL. Erros e
 * saída como em ah_id_new (AH_ERR_LIMIT se out_size < AH_ISO_TIME_SIZE). */
ah_status ah_now_iso(const ah_clock_port *port, char *out, size_t out_size);

/* `objectiveHash(objective)` (core/src/ids.ts:18-29; SPEC-04 A1): `trim` →
 * minúsculas → cada sequência de `\s` vira um espaço → sai a pontuação
 * FINAL `[\s.!?;:,…"'`)\]]+$` → SHA-256 do UTF-8 → 16 primeiros hex.
 * `trim`, `\s` e minúsculas com a semântica do JavaScript (ah_unicode.h).
 * `objective` são `len` bytes UTF-8 (emprestado; pode conter NUL).
 * Erros: AH_ERR_INVALID (UTF-8 inválido ou argumento), AH_ERR_LIMIT
 * (out_size < AH_OBJECTIVE_HASH_SIZE), AH_ERR_NOMEM. Em erro, out recebe ""
 * quando out_size > 0. */
ah_status ah_objective_hash(const char *objective, size_t len, char *out, size_t out_size);

#endif /* AH_CORE_IDS_H */
