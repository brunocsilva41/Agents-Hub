#include "exemplo_suite.h"

#include <stdio.h>

ah_conformance_verdict ah_conformance_exemplo_case(const cJSON *caso,
                                                   const ah_conformance_case_info *info,
                                                   char *msg, size_t msg_cap, void *ctx) {
    const cJSON *pular = cJSON_GetObjectItemCaseSensitive(caso, "pular");
    const cJSON *entrada = cJSON_GetObjectItemCaseSensitive(caso, "entrada");
    const cJSON *esperado = cJSON_GetObjectItemCaseSensitive(caso, "esperado");
    double obtido;

    (void)info;
    (void)ctx;
    if (cJSON_IsString(pular)) {
        (void)snprintf(msg, msg_cap, "%s", pular->valuestring);
        return AH_CONFORMANCE_SKIP;
    }
    if (!cJSON_IsNumber(entrada) || !cJSON_IsNumber(esperado)) {
        (void)snprintf(msg, msg_cap, "caso malformado: falta \"entrada\" ou \"esperado\"");
        return AH_CONFORMANCE_FAIL;
    }
    obtido = entrada->valuedouble * 2.0;
    if (obtido != esperado->valuedouble) {
        (void)snprintf(msg, msg_cap, "esperado %.17g, obtido %.17g", esperado->valuedouble,
                       obtido);
        return AH_CONFORMANCE_FAIL;
    }
    return AH_CONFORMANCE_PASS;
}

static const ah_conformance_decided k_decided[] = {
    {"ex/notas-001", "DV-45", AH_CONFORMANCE_DV_REPRODUCE, NULL},
    {"ex/corrigir-001", "DV-09", AH_CONFORMANCE_DV_CORRECT, "{\"esperado\":12}"},
    {"ex/lote-*", "DV-08", AH_CONFORMANCE_DV_CORRECT, "{\"esperado\":0}"},
};

static const ah_conformance_suite k_suite = {
    "exemplo", ah_conformance_exemplo_case, NULL, k_decided,
    sizeof k_decided / sizeof k_decided[0], 0};

const ah_conformance_suite *ah_conformance_exemplo_suite(void) {
    return &k_suite;
}
