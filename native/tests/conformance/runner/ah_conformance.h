/* Runner de conformidade do Agents-Hub nativo (F0-11, plano docs/17).
 *
 * Lê um arquivo JSONL do corpus de native/tests/conformance/ linha a linha,
 * entrega cada caso a uma função de teste do módulo e relata caso a caso por
 * `id`. Reconhece as marcas de divergência dos READMEs do corpus (`divergencia`,
 * `divergence` e o texto `DIVERGÊNCIA CONHECIDA`) e imprime o ID da DV. Uma
 * tabela de "esperado decidido" permite ao módulo trocar o esperado dos casos
 * de DV decidida como "corrigir" (ADR 09). A regra está no README.md desta
 * pasta.
 *
 * Sem framework externo (DA-24, ADR 9.5). Sem chamada de SO além de stdio. */
#ifndef AH_CONFORMANCE_H
#define AH_CONFORMANCE_H

#include <stddef.h>

#include "ah_status.h"
#include "cJSON.h"

/* Teto de uma linha do corpus. A maior linha atual tem ~70 KB (mappers). */
#define AH_CONFORMANCE_MAX_LINE ((size_t)16 * 1024 * 1024)

/* Teto de casos por arquivo (o maior arquivo atual tem 2784 linhas). */
#define AH_CONFORMANCE_MAX_CASES ((size_t)1000000)

typedef enum ah_conformance_verdict {
    AH_CONFORMANCE_PASS = 0,
    AH_CONFORMANCE_FAIL,
    AH_CONFORMANCE_SKIP
} ah_conformance_verdict;

/* O que o C faz com uma DV (ADR 09): reproduzir o TS ou corrigir. */
typedef enum ah_conformance_dv_policy {
    AH_CONFORMANCE_DV_REPRODUCE = 0,
    AH_CONFORMANCE_DV_CORRECT
} ah_conformance_dv_policy;

/* Entrada da tabela de esperado decidido.
 * - case_id: `id` exato do caso, ou prefixo terminado em '*' ("budget/00*").
 *   O id exato tem precedência; entre prefixos, vence o mais longo.
 * - dv_id: ID da DV no plano ("DV-09"). Obrigatório.
 * - policy: REPRODUCE só rotula o caso com a DV; CORRECT troca o esperado.
 * - expected_json: obrigatório com CORRECT e proibido com REPRODUCE. Objeto
 *   JSON cujas chaves de topo substituem (ou acrescentam) as chaves de topo do
 *   caso antes de ele chegar à função de teste. Ex.: {"risk":"escalate"}.
 * Todos os ponteiros são emprestados e precisam viver durante a execução. */
typedef struct ah_conformance_decided {
    const char *case_id;
    const char *dv_id;
    ah_conformance_dv_policy policy;
    const char *expected_json;
} ah_conformance_decided;

/* Informação do caso entregue à função de teste (emprestada, vale só durante
 * a chamada). dv_id é NULL quando o caso não tem DV identificada. */
typedef struct ah_conformance_case_info {
    const char *corpus;     /* nome do arquivo (sem diretório) */
    const char *id;         /* `id` do caso */
    size_t line;            /* linha no arquivo, a partir de 1 */
    int divergence_marked;  /* 1 se o caso tem marca de divergência no corpus */
    const char *dv_id;      /* da tabela ou do texto da marca ("DV-44") */
    int expected_overridden; /* 1 se o esperado veio da tabela (CORRECT) */
} ah_conformance_case_info;

/* Função de teste do módulo. Recebe o caso já com o esperado decidido
 * aplicado (quando houver). Escreve o motivo em msg (capacidade msg_cap,
 * sempre >= 1; o runner garante terminador). Não guarda `caso` nem `info`. */
typedef ah_conformance_verdict (*ah_conformance_case_fn)(
    const cJSON *caso, const ah_conformance_case_info *info, char *msg,
    size_t msg_cap, void *ctx);

/* Destino de cada linha do relatório (sem '\n' final). NULL em
 * ah_conformance_run_file = stdout. */
typedef void (*ah_conformance_sink_fn)(void *ctx, const char *line);

typedef struct ah_conformance_suite {
    const char *name;                     /* nome do módulo, só para o relatório */
    ah_conformance_case_fn run_case;      /* obrigatório */
    void *ctx;                            /* repassado a run_case */
    const ah_conformance_decided *decided; /* pode ser NULL se decided_count == 0 */
    size_t decided_count;
    /* 1: caso com marca de divergência sem DV identificada conta como falha. */
    int require_dv_id;
} ah_conformance_suite;

typedef struct ah_conformance_report {
    size_t cases;                 /* linhas com JSON de objeto (com ou sem id) */
    size_t passed;
    size_t failed;                /* inclui caso sem id e DV obrigatória ausente */
    size_t skipped;
    size_t divergent;             /* com marca no corpus ou entrada na tabela */
    size_t divergent_without_dv;  /* com marca e sem DV identificada */
    size_t overridden;            /* esperado trocado pela tabela (CORRECT) */
    size_t invalid_lines;         /* JSON inválido ou que não é objeto */
    size_t unused_decided;        /* entradas da tabela que não casaram caso algum */
} ah_conformance_report;

/* Executa o corpus `jsonl_path` (UTF-8; caminho emprestado) com a suite.
 * Relata cada caso e um resumo final em `sink`. Preenche *out mesmo quando
 * devolve erro de execução (contagens até o ponto da parada).
 * Erros: AH_ERR_INVALID (suite ou tabela malformada; nada é executado),
 * AH_ERR_IO (arquivo não abre ou falha de leitura), AH_ERR_LIMIT (linha acima
 * de AH_CONFORMANCE_MAX_LINE ou casos acima de AH_CONFORMANCE_MAX_CASES),
 * AH_ERR_NOMEM. Falha de caso NÃO é erro de execução: vai para *out. */
ah_status ah_conformance_run_file(const char *jsonl_path,
                                  const ah_conformance_suite *suite,
                                  ah_conformance_sink_fn sink, void *sink_ctx,
                                  ah_conformance_report *out);

/* Código de saída do teste a partir do relatório: 0 só se houve ao menos um
 * caso e nenhuma falha, linha inválida ou entrada da tabela sem uso. */
int ah_conformance_exit_code(const ah_conformance_report *report);

/* main() pronto para o executável de conformidade do módulo:
 * `<exe> <arquivo.jsonl>`. Relata em stdout; devolve o código de saída
 * (1 também para erro de uso ou de execução). */
int ah_conformance_main(int argc, char **argv, const ah_conformance_suite *suite);

#endif /* AH_CONFORMANCE_H */
