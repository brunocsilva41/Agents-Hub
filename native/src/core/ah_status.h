/* Tipo de resultado comum do Agents-Hub nativo.
 *
 * Forma proposta em docs/18-padroes-c.md §5 (PROPOSTA): toda função que pode
 * falhar devolve ah_status e entrega o resultado por parâmetro de saída. O
 * detalhe legível vai num buffer do chamador, nunca em estado global.
 * errno/GetLastError() só são lidos dentro de native/src/platform/, que os
 * traduz para estes valores.
 *
 * Só cabeçalho, sem I/O: pode ser incluído por qualquer camada. */
#ifndef AH_CORE_STATUS_H
#define AH_CORE_STATUS_H

typedef enum ah_status {
    AH_OK = 0,
    AH_ERR_NOMEM,     /* alocação falhou */
    AH_ERR_INVALID,   /* argumento ou entrada inválida */
    AH_ERR_IO,        /* falha de arquivo, socket ou processo */
    AH_ERR_NOT_FOUND, /* recurso inexistente */
    AH_ERR_LIMIT,     /* limite de tamanho ou de contagem excedido */
    AH_ERR_INTERNAL   /* invariante violada (defeito do Hub) */
} ah_status;

#endif /* AH_CORE_STATUS_H */
