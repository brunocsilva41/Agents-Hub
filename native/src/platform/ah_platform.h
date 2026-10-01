/* Cabeçalho comum da camada de plataforma (dono: F0-05, plano docs/17 §0).
 *
 * Cada área declara a sua API no próprio cabeçalho (ah_platform_fs.h,
 * ah_platform_time.h, ah_platform_proc.h, ah_platform_net.h). Este arquivo
 * só reúne o que é comum a todas. */
#ifndef AH_PLATFORM_H
#define AH_PLATFORM_H

#include "ah_status.h"

/* Versão da interface da camada; muda quando um contrato comum muda. */
int ah_platform_abi_version(void);

#endif /* AH_PLATFORM_H */
