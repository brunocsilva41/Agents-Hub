/* YAML para uma árvore própria, com tetos, sem I/O (plano docs/17, F0-10).
 *
 * Lê com a libyaml (eventos) e monta uma árvore só de leitura. Todo escalar
 * chega como TEXTO, com o estilo (plain, aspas, bloco) e a tag explícita,
 * se houver: a tipagem (`yes`/`no`, números, null) é do Hub, não daqui (fato
 * do ADR 08 sobre a libyaml; SPEC-08 C2).
 *
 * Tetos (SPEC-08 C2 / SEC-R36, adotados pela DA-29 no ADR 09). Os valores
 * padrão são PROPOSTA desta tarefa, e o chamador pode trocá-los:
 * - tamanho do documento em bytes, conferido antes de abrir o parser;
 * - profundidade de aninhamento, contando o que um alias expande;
 * - nós expandidos: cada nó conta 1 e cada alias conta o tamanho total da
 *   árvore a que aponta; é o teto anti "billion laughs";
 * - quantidade de aliases.
 * O alias NÃO copia nada: aponta para o mesmo nó (a árvore é um DAG), então a
 * memória cresce com o documento, não com a expansão; e o teto de nós
 * expandidos garante que quem percorrer a árvore visita no máximo esse total.
 *
 * Também recusados (AH_ERR_INVALID): YAML malformado, mais de um documento,
 * alias para âncora inexistente ou ainda aberta (ciclo), chave de mapa que
 * não é escalar, e chave repetida no mesmo mapa.
 *
 * Chave repetida segue o pacote `yaml` 2.9.1 do TS (opção padrão
 * uniqueKeys): duas chaves são iguais quando o valor tipado no esquema core
 * do YAML 1.2 é igual. `a` e `"a"` são iguais (texto), `1`, `01`, `+1` e
 * `1.0` são iguais (número 1), `~`, `null` e vazio são iguais; `1` e `"1"`
 * não são (número e texto). Ficam fora da comparação, como no TS: chave que
 * é alias e `.nan`; e, por simplificação daqui, chave com tag explícita
 * diferente de `!!str`. Essa tipagem serve SÓ para achar repetição; os
 * escalares continuam entregues como texto. Merge key (`<<`) é chave comum
 * (o esquema core não tem merge), então `<<` repetido também é recusado.
 *
 * UTF-8 inválido no texto é recusado (AH_ERR_INVALID, pelo leitor da
 * libyaml). O `yaml` do TS recebe texto já decodificado pelo Node, em que o
 * byte inválido vira U+FFFD; aqui não há substituição (divergência
 * registrada pelo coordenador). */
#ifndef AH_CORE_YAML_H
#define AH_CORE_YAML_H

#include <stddef.h>

#include "ah_status.h"

/* Padrões (PROPOSTA). 1 MiB cobre o maior YAML de entrada da API, o
 * `POST /workflows/validate` com até 200.000 caracteres (SPEC-01, rota 50). */
#define AH_YAML_DEFAULT_MAX_BYTES ((size_t)1024 * 1024)
#define AH_YAML_DEFAULT_MAX_DEPTH ((size_t)64)
#define AH_YAML_DEFAULT_MAX_NODES ((size_t)100000)
#define AH_YAML_DEFAULT_MAX_ALIASES ((size_t)1000)

typedef struct ah_yaml_limits {
    size_t max_bytes;   /* tamanho do texto */
    size_t max_depth;   /* raiz = 1; cada nível de coleção soma 1 */
    size_t max_nodes;   /* nós expandidos (aliases contam a árvore apontada) */
    size_t max_aliases; /* eventos de alias no documento */
} ah_yaml_limits;

typedef struct ah_yaml_doc ah_yaml_doc;
typedef struct ah_yaml_node ah_yaml_node;

typedef enum ah_yaml_kind {
    AH_YAML_SCALAR,
    AH_YAML_SEQUENCE,
    AH_YAML_MAPPING
} ah_yaml_kind;

typedef enum ah_yaml_style {
    AH_YAML_PLAIN,
    AH_YAML_SINGLE_QUOTED,
    AH_YAML_DOUBLE_QUOTED,
    AH_YAML_LITERAL,
    AH_YAML_FOLDED
} ah_yaml_style;

/* Preenche `lim` com os padrões AH_YAML_DEFAULT_*. */
void ah_yaml_limits_default(ah_yaml_limits *lim);

/* Lê o documento YAML `text` (`len` bytes, UTF-8, emprestado).
 * `lim` NULL usa os padrões. `err`/`err_size` (opcionais) recebem o motivo
 * legível, terminado em NUL, em caso de erro.
 * AH_ERR_LIMIT: algum teto excedido. AH_ERR_INVALID: ver o topo do arquivo.
 * Posse: o chamador libera *out com ah_yaml_free. Em erro, *out = NULL. */
ah_status ah_yaml_load(const char *text, size_t len, const ah_yaml_limits *lim,
                       ah_yaml_doc **out, char *err, size_t err_size);

/* Libera o documento e todos os nós. NULL é no-op. */
void ah_yaml_free(ah_yaml_doc *doc);

/* Nó raiz, ou NULL se o documento é vazio (só comentários/espaço). Todos os
 * nós pertencem a `doc` e valem até ah_yaml_free. */
const ah_yaml_node *ah_yaml_root(const ah_yaml_doc *doc);

ah_yaml_kind ah_yaml_node_kind(const ah_yaml_node *node);

/* Texto do escalar (terminado em NUL; pode conter NUL vindo de "\0", por isso
 * o tamanho sai em `len`, que pode ser NULL). NULL se não é escalar. */
const char *ah_yaml_scalar(const ah_yaml_node *node, size_t *len);

/* Estilo do escalar (AH_YAML_PLAIN para coleções). Um `key:` sem valor chega
 * como escalar plain vazio; `key: ""` como aspas duplas vazio. */
ah_yaml_style ah_yaml_scalar_style(const ah_yaml_node *node);

/* Tag explícita do nó como a libyaml a resolve (ex.: "tag:yaml.org,2002:str"
 * para `!!str`), ou NULL se o nó não tem tag. */
const char *ah_yaml_tag(const ah_yaml_node *node);

/* Itens de uma sequência ou pares de um mapa; 0 para escalar. */
size_t ah_yaml_count(const ah_yaml_node *node);

/* Item `i` da sequência; NULL se fora do intervalo ou não é sequência. */
const ah_yaml_node *ah_yaml_seq_at(const ah_yaml_node *node, size_t i);

/* Chave e valor do par `i` do mapa (ordem do documento); NULL se fora do
 * intervalo ou não é mapa. A chave é sempre escalar. */
const ah_yaml_node *ah_yaml_map_key_at(const ah_yaml_node *node, size_t i);
const ah_yaml_node *ah_yaml_map_value_at(const ah_yaml_node *node, size_t i);

/* Valor da primeira chave cujo texto é igual a `key` (bytes, terminado em
 * NUL), ou NULL. */
const ah_yaml_node *ah_yaml_map_get(const ah_yaml_node *node, const char *key);

#endif /* AH_CORE_YAML_H */
