# Runner de conformidade (F0-11)

Liga o corpus de `native/tests/conformance/` ao CTest. Cada módulo C (classificador, política,
mappers, HTTP...) escreve **uma função de teste** que recebe um caso do corpus e devolve
passou/falhou/pulado. O runner lê o JSONL, chama a função caso a caso, relata cada `id` e
identifica os casos de divergência com o ID da DV do plano (`docs/17-plano-reescrita-c.md` §2).

Sem framework externo (DA-24, ADR 09 §9.5). Os testes do próprio runner usam a macro `CHECK`
de `native/tests/unit/ah_test.h`.

## Arquivos

| Arquivo | O que é |
|---|---|
| `ah_conformance.h` / `.c` | biblioteca `ah::conformance_runner` (contrato e posse no header) |
| `CMakeLists.txt` | a biblioteca, a função `ah_add_conformance_test` e os testes do runner |
| `exemplo/` | corpus **de exemplo** do runner (não é corpus do TS) e a suite de exemplo |
| `test_conformance_runner.c` | autoverificação: contagens e texto do relatório caso a caso |

## Como um módulo usa

```c
#include "ah_conformance.h"

static ah_conformance_verdict caso(const cJSON *c, const ah_conformance_case_info *info,
                                   char *msg, size_t cap, void *ctx) {
    /* lê a entrada de `c`, chama o módulo, compara com o esperado de `c` */
}

static const ah_conformance_decided decidido[] = {
    {"divergencia-S-007", "DV-09", AH_CONFORMANCE_DV_CORRECT, "{\"risk\":\"...\",\"reason\":\"...\"}"},
};
static const ah_conformance_suite suite = {"classifier", caso, NULL, decidido, 1, 1};

int main(int argc, char **argv) { return ah_conformance_main(argc, argv, &suite); }
```

```cmake
add_executable(conf_classifier conf_classifier.c)
target_link_libraries(conf_classifier PRIVATE ah::conformance_runner ah::core)
ah_project_warnings(conf_classifier)
ah_add_conformance_test(classifier conf_classifier classifier/classifier.jsonl)
```

`ah_add_conformance_test(<nome> <executável> <arquivo.jsonl>)` registra `conformance.<nome>`
no CTest (rótulo `conformance`), rodando `<executável> <arquivo.jsonl>`. Caminho relativo parte
de `native/tests/conformance/`; o arquivo precisa existir na configuração. O diretório do runner
precisa ser processado **antes** de quem chama a função (no `native/CMakeLists.txt`, o
`add_subdirectory(tests/conformance/runner)` vem antes dos módulos). Uma suite por arquivo de
corpus (a checagem de "entrada sem uso" vale por arquivo).

## Relatório

Uma linha por caso, em stdout (o CTest mostra com `--output-on-failure` e guarda no log):

```
CORPUS  misto.jsonl (suite exemplo)
PASSOU  misto.jsonl ex/passa-001
FALHOU  misto.jsonl ex/falha-001: esperado 7, obtido 6
PULADO  misto.jsonl ex/pula-001: o módulo de exemplo não cobre este caso
PASSOU  misto.jsonl ex/div-en-001 [divergência DV-44]
PASSOU  misto.jsonl ex/notas-001 [divergência DV-45: reproduz o TS (decidido)]
PASSOU  misto.jsonl ex/corrigir-001 [divergência DV-09: esperado decidido (corrigir)]
PASSOU  misto.jsonl ex/div-pt-001 [divergência sem ID de DV: "SPEC-04 A6: exemplo de marca sem ID de DV"]
FALHOU  misto.jsonl linha 11: JSON inválido
PASSOU  misto.jsonl ex/notas-sem-dv-001 [divergência sem ID de DV: "DIVERGÊNCIA CONHECIDA: exemplo sem entrada na tabela nem ID de DV no texto"]
RESUMO  misto.jsonl: 12 casos, 8 passaram, 3 falharam, 1 pulados; 8 com divergência (4 com esperado decidido, 2 sem ID de DV); 2 linhas inválidas; 0 entradas da tabela sem uso
```

Saída do executável: `0` só se houve ao menos um caso e nenhuma falha, linha inválida ou entrada
da tabela sem uso. Corpus vazio é falha (um teste que não testa nada não pode ficar verde).
Pulado não reprova, mas aparece com o motivo em cada linha e no resumo.

Linhas em branco são ignoradas; `\r` final (checkout com `core.autocrlf`) e BOM UTF-8 na primeira
linha são aceitos. Caso sem `id` (texto) é falha. Linha com byte NUL é recusada (linha inválida),
em vez de ser cortada no NUL.

## Marcas de divergência

Um caso tem marca quando (READMEs do corpus):

| Corpus | Marca |
|---|---|
| `classifier/` | campo `divergencia` (qualquer valor não nulo) |
| `domain/` | campo `divergence` (qualquer valor não nulo) |
| `mappers/` | texto `DIVERGÊNCIA CONHECIDA` em um campo de texto de topo (hoje, `notes`) |

O ID da DV é resolvido nesta ordem:

1. entrada da tabela de esperado decidido que casa o `id` do caso;
2. `DV-<número>` no texto da marca (hoje só os casos da DV-44 em `domain/budget.jsonl` trazem);
3. nenhum: o caso aparece como `divergência sem ID de DV` e conta no resumo. Com
   `require_dv_id = 1` na suite, isso vira falha. **Os módulos reais devem ligar
   `require_dv_id`**: o aceite de F0-11 pede que todo caso com marca apareça com a DV.

Um caso sem marca no corpus, mas com entrada na tabela, também é tratado como divergência
(serve para DV que o corpus não marcou).

## Tabela de esperado decidido (regra)

O corpus guarda o comportamento **do TS**. Quando o dono decide **corrigir** uma DV
(ADR 09), o esperado do C deixa de ser o do corpus. A regra:

1. **Não se edita o corpus.** Ele é gerado do TS e continua sendo a referência do TS.
2. O módulo declara, na sua suite, uma entrada por caso (ou prefixo) afetado:
   `{case_id, dv_id, policy, expected_json}`.
   - `AH_CONFORMANCE_DV_CORRECT` (DV decidida como corrigir): `expected_json` é **obrigatório** e
     é um objeto JSON não vazio. Cada chave de topo dele **substitui** a chave de mesmo nome do
     caso (ou é acrescentada se o caso não a tiver) antes de o caso chegar à função de teste. A
     troca é rasa: para mudar um campo dentro de `expect`, repita o `expect` inteiro.
   - `AH_CONFORMANCE_DV_REPRODUCE` (DV decidida como reproduzir o TS): `expected_json` tem de ser
     `NULL`; a entrada só rotula o caso com a DV.
3. `case_id` é o `id` exato ou um prefixo terminado em `*` (`divergencia-S-*`). O exato tem
   precedência; entre prefixos, vence o mais longo. `*` só no fim; `case_id` repetido é erro.
4. `dv_id` é obrigatório e tem a forma `DV-<número>`, o ID da tabela do §2 do plano.
5. Toda entrada precisa casar **pelo menos um caso** do arquivo. Entrada sem uso é falha: um
   `id` que mudou numa regeneração do corpus não pode deixar o esperado decidido parado.
6. Tabela malformada (qualquer item acima) aborta antes de executar qualquer caso
   (`AH_ERR_INVALID`, com o motivo no relatório).
7. A função de teste recebe em `info` a DV (`dv_id`), se o caso tem marca e se o esperado foi
   trocado (`expected_overridden`); o relatório mostra `esperado decidido (corrigir)`.

O campo que é "o esperado" muda por corpus (ver o README de cada pasta): `risk`/`reason`/`denied`
em `classifier/`, `expect` em `domain/`, `expected_events`/`expected`/... em `mappers/`,
`expected_status`/`expected_code` em `domain-errors/`.

### Correspondência marca ↔ DV (para os módulos montarem as tabelas)

Fonte: coluna "Fonte" da tabela de DV do plano (§2) e o ADR 09 (Tema B: DV-07 a DV-13 e DV-41 a
DV-45 "corrigir"; DV-45 "reproduzir as tolerâncias dos mappers"). O valor esperado corrigido de
cada caso é trabalho da tarefa dona do módulo, não do runner.

| Marca no corpus | DV | Decisão (ADR 09) |
|---|---|---|
| `classifier/`: `divergencia-S-001` a `-019` (`-S` de `cp`/`mv`/`ln`) | DV-09 | corrigir |
| `classifier/`: `-t`/`--target-directory` (`escrita-144`, `-145`, `-157`, `-168`, `divergencia-S-023`, `divergencia-t-*`) | DV-41 | corrigir |
| `domain/policy-intersect.jsonl`: `divergence` (herança do filho) | DV-08 | corrigir |
| `domain/budget.jsonl`: `divergence` com "DV-44" no texto | DV-44 | corrigir |
| `mappers/`: item 1 (corte por unidade UTF-16) | DV-42 | corrigir |
| `mappers/`: item 6 (prompt vazio em argv) | DV-43 | corrigir |
| `mappers/`: itens 2–5 e 7–9 | DV-45 | reproduzir |

Os casos de contraste do classificador (`divergencia-S-020` a `-022`, `--suffix`) **não** têm o
campo `divergencia` (conferido no `classifier.jsonl`): uma entrada de prefixo
`divergencia-S-*` também os pegaria. Use entradas exatas ou confira o que o prefixo cobre.

## Limites e o que migra para `ah_platform`

- O arquivo é aberto com `fopen` (`fopen_s` no CRT da Microsoft, que marca `fopen` como inseguro
  com `/W4 /WX`; `docs/18` §6 proíbe `_CRT_SECURE_NO_WARNINGS`). No Windows, um caminho fora da
  code page ativa não abre. Migra para a leitura de arquivo da área `fs` de `ah_platform` (F0-05)
  quando ela existir.
- Linha de até 16 MiB (`AH_CONFORMANCE_MAX_LINE`) e até 1.000.000 de casos por arquivo; acima
  disso, a execução para com `AH_ERR_LIMIT` e o resumo diz `EXECUÇÃO INTERROMPIDA`.
- `id` duplicado no arquivo não é detectado (os geradores do corpus garantem unicidade).
