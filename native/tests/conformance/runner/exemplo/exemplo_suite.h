/* Suite de exemplo do runner de conformidade: "o módulo" calcula o dobro de
 * `entrada` e compara com `esperado`. Existe só para provar o runner
 * (autoverificação e registro no CTest); não é corpus do TS. */
#ifndef AH_CONFORMANCE_EXEMPLO_SUITE_H
#define AH_CONFORMANCE_EXEMPLO_SUITE_H

#include "ah_conformance.h"

/* Caso: {"id", "entrada": inteiro, "esperado": inteiro, "pular"?: texto}.
 * Com `pular`, devolve SKIP com o texto como motivo. */
ah_conformance_verdict ah_conformance_exemplo_case(const cJSON *caso,
                                                   const ah_conformance_case_info *info,
                                                   char *msg, size_t msg_cap, void *ctx);

/* Suite com a tabela de esperado decidido dos arquivos verde.jsonl e misto.jsonl.
 * Posse: estática, não libera. */
const ah_conformance_suite *ah_conformance_exemplo_suite(void);

#endif /* AH_CONFORMANCE_EXEMPLO_SUITE_H */
