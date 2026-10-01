/* Erros do domínio: HubErrorCode e HubError (plano docs/17, F1-01;
 * SPEC-04 A1 "Erros"; fonte core/src/errors.ts).
 *
 * O código é o contrato estável que a API HTTP, o MCP e a CLI traduzem
 * (errors.ts:1-5): o texto de cada código é exatamente o literal do TS.
 * A mensagem é de quem lança (cada tarefa fixa as suas, conforme a SPEC);
 * aqui só se carrega e serializa. Status HTTP por código é da borda HTTP
 * (`statusFor`, daemon/src/server.ts:1153-1205; F1-19), não deste módulo. */
#ifndef AH_CORE_ERRORS_H
#define AH_CORE_ERRORS_H

#include <stddef.h>

#include "ah_json.h"
#include "ah_status.h"

/* Os 32 códigos de HubErrorCode, na ordem de core/src/errors.ts:6-42. */
typedef enum ah_error_code {
    AH_ERROR_AGENT_NOT_FOUND,
    AH_ERROR_AGENT_NOT_INSTALLED,
    AH_ERROR_AGENT_NOT_AUTHENTICATED,
    AH_ERROR_SESSION_NOT_FOUND,
    AH_ERROR_TASK_NOT_FOUND,
    AH_ERROR_PROJECT_NOT_FOUND,
    AH_ERROR_PROJECT_FOLDER_CONFLICT,
    AH_ERROR_PROJECT_CONFIG_INVALID,
    AH_ERROR_HUB_CONFIG_INVALID,
    /* Config de OUTRA ferramenta que não sabemos editar sem perda. */
    AH_ERROR_AGENT_CONFIG_INVALID,
    /* O arquivo mudou entre a prévia e a confirmação: nada foi gravado. */
    AH_ERROR_CONFIG_CHANGED,
    AH_ERROR_FOLDER_NOT_FOUND,
    /* Aprovação inexistente (id bem formado que não está no banco). */
    AH_ERROR_APPROVAL_NOT_FOUND,
    AH_ERROR_FOLDER_IS_PRIMARY,
    AH_ERROR_INVALID_BRIEF,
    AH_ERROR_INVALID_QUERY,
    /* Id em parâmetro de rota fora do formato `<prefixo>_<alfanumérico>`. */
    AH_ERROR_INVALID_ID,
    AH_ERROR_INVALID_JSON,
    AH_ERROR_INVALID_PATH,
    AH_ERROR_MALFORMED_URL,
    AH_ERROR_PAYLOAD_TOO_LARGE,
    AH_ERROR_POLICY_DENIED,
    AH_ERROR_APPROVAL_REQUIRED,
    AH_ERROR_BUDGET_EXCEEDED,
    AH_ERROR_DEPTH_EXCEEDED,
    AH_ERROR_CYCLE_DETECTED,
    AH_ERROR_CONCURRENCY_EXCEEDED,
    AH_ERROR_TIMEOUT,
    AH_ERROR_ADAPTER_FAILURE,
    AH_ERROR_CAPABILITY_UNRESOLVED,
    AH_ERROR_ILLEGAL_STATE,
    AH_ERROR_CODEX_GATE_NOT_GUARANTEED,
    AH_ERROR_CODE_COUNT
} ah_error_code;

/* Literal do código ("AGENT_NOT_FOUND"...), ou NULL fora do enum.
 * Posse: estático. */
const char *ah_error_code_name(ah_error_code code);

/* Código cujo literal é exatamente os `len` bytes de `s` (sensível a
 * maiúsculas). AH_ERR_NOT_FOUND se não for um dos 32 (*out intacto);
 * AH_ERR_INVALID se `out` for NULL ou `s` NULL com len > 0. */
ah_status ah_error_code_parse(const char *s, size_t len, ah_error_code *out);

/* HubError: `code`, `message` e `details` (errors.ts:44-58). Campos de
 * leitura; a posse de `message` e `details` é do próprio erro. */
typedef struct ah_hub_error {
    ah_error_code code;
    char *message;    /* UTF-8, nunca NULL */
    ah_json *details; /* sempre objeto; `{}` quando não há detalhe */
} ah_hub_error;

/* Cria um HubError. `message` (UTF-8, terminado em NUL, nunca NULL) é
 * copiada. `details`: NULL vira `{}` (o padrão do TS); senão precisa ser
 * objeto e a posse passa ao erro quando devolve AH_OK; em erro continua do
 * chamador. Erros: AH_ERR_INVALID (código fora do enum, message NULL ou
 * details que não é objeto), AH_ERR_NOMEM. Posse: o chamador libera *out
 * com ah_hub_error_free. */
ah_status ah_hub_error_new(ah_error_code code, const char *message, ah_json *details,
                           ah_hub_error **out);

/* Libera o erro e o que ele possui. NULL é no-op. */
void ah_hub_error_free(ah_hub_error *err);

/* `toJSON()`: objeto `{code, message, details}` nessa ordem (errors.ts:55-57),
 * com cópia profunda de `details`. Posse: o chamador libera *out com
 * ah_json_free. */
ah_status ah_hub_error_to_json(const ah_hub_error *err, ah_json **out);

#endif /* AH_CORE_ERRORS_H */
