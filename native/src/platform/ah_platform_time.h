/* Plataforma: tempo, aleatoriedade, ambiente e usuário do SO (tarefa F0-06,
 * plano docs/17).
 *
 * Toda string de entrada e de saída é UTF-8. Nenhuma função guarda ponteiro
 * do chamador além da chamada. Funções que escrevem em buffer do chamador
 * recebem o tamanho do buffer e devolvem AH_ERR_LIMIT se ele não couber o
 * resultado mais o terminador; nesse caso o buffer recebe "" (out[0] = 0)
 * quando out_size > 0. */
#ifndef AH_PLATFORM_TIME_H
#define AH_PLATFORM_TIME_H

#include <stddef.h>
#include <stdint.h>

#include "ah_status.h"

/* ---- Relógio de parede ------------------------------------------------- */

/* "AAAA-MM-DDTHH:MM:SS.mmmZ": 24 caracteres + terminador. Mesmo formato de
 * `new Date().toISOString()` (SPEC-02 §4.1; core/src/ids.ts:31-33). */
#define AH_PLATFORM_ISO_TIME_SIZE 25

/* "AAAAMMDD-HHMMSS": 15 caracteres + terminador (SPEC-02 §6). */
#define AH_PLATFORM_LOCAL_STAMP_SIZE 16

/* Milissegundos desde 1970-01-01T00:00:00Z (equivale a Date.now()). */
ah_status ah_platform_time_now_unix_ms(int64_t *out);

/* Formata `unix_ms` como ISO 8601 UTC com milissegundos e `Z`. Aceita só
 * anos 0000..9999 (a faixa em que toISOString usa 4 dígitos); fora dela
 * devolve AH_ERR_INVALID. Função pura, sem chamada ao SO. */
ah_status ah_platform_time_format_iso(int64_t unix_ms, char *out, size_t out_size);

/* Agora, em ISO 8601 UTC (ver ah_platform_time_format_iso). */
ah_status ah_platform_time_now_iso(char *out, size_t out_size);

/* Agora, na hora LOCAL, como "AAAAMMDD-HHMMSS" — o carimbo dos nomes de
 * backup (store/src/backup.ts:36-42; daemon/src/safe-write.ts:34-39). */
ah_status ah_platform_time_local_stamp(char *out, size_t out_size);

/* ---- Relógio monotônico ------------------------------------------------ */

/* Tempo monotônico (não volta com ajuste do relógio de parede). A origem é
 * arbitrária: só a diferença entre duas leituras tem sentido. */
ah_status ah_platform_time_monotonic_ns(uint64_t *out);
ah_status ah_platform_time_monotonic_ms(uint64_t *out);

/* ---- Aleatoriedade (CSPRNG do SO) -------------------------------------- */

/* Preenche `buf` com `len` bytes do CSPRNG do SO (Windows: BCryptGenRandom
 * com BCRYPT_USE_SYSTEM_PREFERRED_RNG; Linux: getrandom, com /dev/urandom se
 * o kernel não tiver a chamada). len == 0 é AH_OK sem efeito. Falha do SO
 * devolve AH_ERR_IO e o buffer não deve ser usado. */
ah_status ah_platform_random_bytes(void *buf, size_t len);

/* Codifica `len` bytes em hex minúsculo. Exige out_size >= 2*len + 1.
 * Função pura, sem chamada ao SO. */
ah_status ah_platform_hex_encode(const void *data, size_t len, char *out,
                                 size_t out_size);

/* `nbytes` bytes aleatórios em hex minúsculo (2*nbytes caracteres). Com
 * nbytes = 32 dá o formato do operator-token, ^[0-9a-f]{64}$ (SPEC-01 §4). */
ah_status ah_platform_random_hex(size_t nbytes, char *out, size_t out_size);

/* "xxxxxxxx-xxxx-4xxx-Yxxx-xxxxxxxxxxxx": 36 caracteres + terminador. */
#define AH_PLATFORM_UUID_SIZE 37

/* UUID v4 (RFC 9562) em hex minúsculo com hífens, como crypto.randomUUID()
 * do Node, base dos ids `<prefixo>_<24 hex>` (core/src/ids.ts:9-11). */
ah_status ah_platform_uuid_v4(char *out, size_t out_size);

/* ---- Ambiente ---------------------------------------------------------- */

/* Lê a variável de ambiente `name` (UTF-8) do processo.
 * - AH_OK: *out recebe uma cópia do valor em UTF-8 (pode ser "").
 * - AH_ERR_NOT_FOUND: a variável não existe; *out = NULL.
 * - AH_ERR_INVALID: `name` NULL, vazio, com '=' ou UTF-8 inválido; no
 *   Windows, também valor que não é UTF-16 válido (surrogate solto).
 *   No POSIX o valor é devolvido como está (bytes), sem validar UTF-8.
 * - AH_ERR_NOMEM / AH_ERR_IO: falha de alocação ou do SO.
 * Posse: o chamador libera *out com ah_platform_env_free. `name` é
 * emprestado. Não é seguro chamar em paralelo com quem altera o ambiente do
 * processo (no POSIX, getenv não é reentrante frente a setenv). */
ah_status ah_platform_env_get(const char *name, char **out);

/* Libera um valor devolvido por ah_platform_env_get. NULL é no-op. */
void ah_platform_env_free(char *value);

/* ---- Usuário do SO ----------------------------------------------------- */

/* Tamanho que comporta qualquer nome de usuário do Windows (UNLEN = 256
 * unidades UTF-16, até 3 bytes UTF-8 cada) e os nomes POSIX usuais. */
#define AH_PLATFORM_USER_NAME_SIZE 800

/* Nome do usuário do SO dono do processo, em UTF-8 — o `<usuário>` de
 * `cli:<usuário>` (SPEC-01 §4; os.userInfo().username do Node).
 * Windows: GetUserNameW. POSIX: getpwuid_r(geteuid()).
 * AH_ERR_NOT_FOUND se o uid não tiver registro em passwd. */
ah_status ah_platform_user_name(char *out, size_t out_size);

#endif /* AH_PLATFORM_TIME_H */
