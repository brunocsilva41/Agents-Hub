# 18 — Padrões de código C da reescrita

Regras para todo código em `native/`. Valem para agentes e pessoas. Derivam do
[ADR 07](decisoes/07-reescrita-nativa.md), do [ADR 08](decisoes/08-pilha-tecnica-c.md), do
[CONTRIBUTING.md](../CONTRIBUTING.md) e dos agentes globais do dono
(`~/.claude/agents/c-engineer.md`, `~/.claude/agents/build-release-engineer.md`).

> **Como ler as marcas.** Uma regra sem marca vem de uma dessas fontes, e a fonte exata vem
> citada (ADR e número, `CONTRIBUTING.md:linha` ou `agente.md:linha`). O que interpreta ou
> estende o texto da fonte é marcado **PROPOSTA**: decisão nova deste documento, ainda não
> confirmada pelo dono. Uma PROPOSTA vale como padrão provisório até o plano
> ([docs/17](17-plano-reescrita-c.md), que pode ainda não existir) confirmar ou trocar. Quem
> discordar de uma PROPOSTA reporta; não troca sozinho. ⚠ = fato que o ADR 08 marca como não
> reconferido na fonte primária.

## 1. Linguagem e compiladores

O padrão é **C17** (ADR 8.1). Compiladores: MSVC no release Windows, clang-cl com ASan + UBSan
num job de CI, GCC e Clang no Linux (ADR 8.2). O código precisa compilar nos quatro.

- **Sem VLA.** ⚠ O MSVC não tem VLA em C17. Tamanho variável vai para o heap ou para buffer de
  tamanho fixo com checagem. (ADR 08, consequência proposta ⚠ — PROPOSTA até o plano.)
- **Sem `<stdatomic.h>`.** ⚠ É experimental no MSVC. Operações atômicas ficam atrás de funções
  de `native/src/platform/`. (ADR 08, consequência proposta ⚠ — PROPOSTA até o plano.)
- Extensões de compilador (`__attribute__`, `__declspec`) só atrás de macro em um header de
  `platform/`. (PROPOSTA)

## 2. Nomes

Todo símbolo público leva o prefixo do projeto e do módulo. (PROPOSTA)

| Item | Forma | Exemplo |
|---|---|---|
| Função pública | `ah_<módulo>_<ação>` | `ah_store_open` |
| Tipo público | `ah_<módulo>_<nome>` | `ah_store_db` |
| Macro e constante | `AH_<MÓDULO>_<NOME>` | `AH_HTTP_MAX_HEADER` |
| Enum (valores) | `AH_<MÓDULO>_<VALOR>` | `AH_SESSION_RUNNING` |
| Função interna ao `.c` | `static`, sem prefixo obrigatório | `parse_linha` |

- Sem sufixo `_t` em tipos novos: o POSIX reserva esse sufixo. (PROPOSTA)
- `<módulo>` é a pasta de `native/src/` (`platform`, `core`, `store`, `adapters`, `daemon`,
  `client`, `cli`, `mcp`, `ui`, `updater`) ou um submódulo dela. (PROPOSTA)
- Português nos identificadores é aceito, como no TS (`CONTRIBUTING.md:150-153`): siga o
  arquivo em que você está.

## 3. Header e fonte

Cada módulo tem um `.h` público e um ou mais `.c`. (PROPOSTA)

- O header declara só o que outro módulo usa. Todo o resto é `static` no `.c`. (PROPOSTA)
- Guarda de inclusão `#ifndef AH_<MÓDULO>_<ARQUIVO>_H`, não `#pragma once`. (PROPOSTA)
- O header compila sozinho: inclui o que usa e nada a mais. (PROPOSTA)
- Struct opaca (`typedef struct ah_x ah_x;`) quando o chamador não precisa dos campos.
  (PROPOSTA)
- **Camada não olha para cima** (`CONTRIBUTING.md:155-158`): `core` não conhece adapters nem
  HTTP; recebe portas injetadas. Uma importação que viole isso é motivo de recusa, mesmo que
  compile. Extensões para o C (PROPOSTA): `core` também não conhece o SO, e a porta injetada é
  uma struct de ponteiros de função.
- Comentário explica **por quê**, não o quê (`CONTRIBUTING.md:138-141`).

## 4. Posse de memória

Toda função pública que recebe ou devolve ponteiro documenta a posse **no header**. Fonte:
`c-engineer.md:18`, "posse de memória documentada no header". O formato do comentário é
PROPOSTA.

```c
/* Abre o banco em `caminho` (UTF-8). Posse: o chamador libera *out com ah_store_close.
 * `caminho` é emprestado: só é lido durante a chamada. */
ah_status ah_store_open(const char *caminho, ah_store_db **out);
```

- Quem aloca define quem libera; cada tipo alocado tem uma função `_free`/`_close` pareada.
  (PROPOSTA)
- Liberar `NULL` é no-op em toda função `_free`. (PROPOSTA)
- Ponteiro emprestado não é guardado além da chamada sem cópia explícita. (PROPOSTA)

## 5. Tratamento de erro

Toda chamada que pode falhar tem o resultado checado (`c-engineer.md:18`, "tratamento de erro
explícito em toda chamada que pode falhar"). Erro não é engolido: ou é tratado ali, ou é
devolvido. (PROPOSTA)

**PROPOSTA de tipo comum** (a confirmar no plano):

```c
typedef enum ah_status {
    AH_OK = 0,
    AH_ERR_NOMEM,      /* alocação falhou */
    AH_ERR_INVALID,    /* argumento ou entrada inválida */
    AH_ERR_IO,         /* falha de arquivo, socket ou processo */
    AH_ERR_NOT_FOUND,
    AH_ERR_LIMIT,      /* limite de tamanho ou de contagem excedido */
    AH_ERR_INTERNAL
} ah_status;
```

- Função que pode falhar devolve `ah_status`; o resultado sai por parâmetro `out`. (PROPOSTA)
- Detalhe legível (texto para log ou para o agente) vai num buffer fornecido pelo chamador,
  nunca em estado global. (PROPOSTA)
- `errno`/`GetLastError()` só são lidos dentro de `platform/`, que os traduz para `ah_status`.
  (PROPOSTA)
- Sem `abort()`/`assert` como tratamento de erro de entrada. `assert` só para invariante interna.
  (PROPOSTA)

## 6. Funções inseguras e limites

Funções inseguras são proibidas (`c-engineer.md:19`, "Sem funções inseguras (`strcpy`,
`sprintf`, `gets`...)"). A fonte nomeia só essas três. A lista derivada também é proibida
(PROPOSTA): `strcat`, `vsprintf`, `strtok` (estado global), `scanf("%s")`, `atoi`/`atol` (não
reportam erro; use `strtol`/`strtoll` com checagem).

- **Checagem de limites sempre** (`c-engineer.md:19`). Como fazer (PROPOSTA): todo buffer anda
  com seu tamanho (`size_t`); toda cópia e formatação recebe o tamanho do destino (`snprintf`
  com checagem do retorno).
- Multiplicação de tamanhos checa overflow antes de alocar. (PROPOSTA)
- Entrada externa (HTTP, stream do agente, YAML, JSON, banco) tem tamanho máximo definido e
  recusado com `AH_ERR_LIMIT` quando excedido. (PROPOSTA)
- Não silenciar avisos de função insegura com `_CRT_SECURE_NO_WARNINGS`. (PROPOSTA)

## 7. Sistema operacional

**Nenhuma chamada de SO fora de `native/src/platform/`** (`c-engineer.md:20`, "Nenhuma chamada
de SO fora da camada de plataforma definida pelo projeto"; a pasta é a da estrutura do
[CLAUDE.md](../CLAUDE.md)). Consequência (PROPOSTA): fora dela, não se inclui `<windows.h>`,
`<unistd.h>`, `<pthread.h>`, `<sys/*.h>` nem equivalentes.

- Bibliotecas do ADR 08 (SDL3, SQLite, cJSON...) não são "SO" e podem ser usadas pelo módulo
  dono da camada (ex.: SDL em `ui/`, SQLite em `store/`). (PROPOSTA)
- Onde ficam WinHTTP e libcurl (ADR 8.11): em aberto. PROPOSTA: atrás de uma interface em
  `platform/`, consumida por `updater/`.
- `SDL_CreateTray` só pode ser chamado na thread principal (ADR 08, fatos conferidos).

## 8. Esperar evento sem polling

Sem polling e sem `Sleep` para esperar evento (`c-engineer.md:21`). Serve à meta de CPU parado
≈ 0 do ADR 08. `usleep` e equivalentes POSIX caem na mesma regra (PROPOSTA).

- Espere com primitiva bloqueante de evento (handle, variável de condição, socket bloqueante
  ou multiplexado) exposta por `platform/`. (PROPOSTA)
- A UI redesenha só sob evento (`SDL_WaitEvent`). (ADR 08, consequência proposta ⚠ — PROPOSTA
  até o plano.)
- Temporizador é permitido quando o comportamento é de fato baseado em tempo (timeout,
  retenção, retry com espera), nunca para "ver se já chegou". (PROPOSTA)

## 9. Texto

Strings internas são **UTF-8** em `char *`. A conversão para UTF-16 (`wchar_t`) acontece só
na camada Win32 de `platform/`, na fronteira da chamada. (PROPOSTA)

- Caminhos de arquivo também são UTF-8 dentro do programa. (PROPOSTA)

## 10. Warnings e sanitizers

Compilar sem warnings (`c-engineer.md:22`). PROPOSTA de flags, a fixar pelo esqueleto F0:

| Compilador | Flags mínimas |
|---|---|
| MSVC / clang-cl | `/W4 /WX` |
| GCC / Clang | `-Wall -Wextra -Werror` |

- **Sanitizers:** job de CI com clang-cl + ASan + UBSan (ADR 8.2); sanitizers em Debug
  (`c-engineer.md:22`). O MSVC tem ASan, mas não UBSan (ADR 08). PROPOSTA: as flags do build
  Debug no Linux, `-fsanitize=address,undefined`.
- Desligar warning ou sanitizer para "passar" é proibido; exceção pontual exige comentário com
  o motivo e revisão. (PROPOSTA)
- Código de `native/third_party/` pode compilar com flags próprias; o nosso não. (PROPOSTA)

## 11. Formatação

PROPOSTA: **clang-format** com arquivo `.clang-format` em `native/`, criado pelo esqueleto F0.
Estilo (largura, chaves, indentação) a definir nesse arquivo; até lá, imite o código vizinho.
A checagem de formatação entra no portão do CI. (PROPOSTA)

## 12. Testes

O critério de pronto do CONTRIBUTING (`CONTRIBUTING.md:107-123`) vale para o C: tem teste que
falha sem a mudança, tem consumidor, foi exercido fora do teste, e a frase do plano descreve o
que existe. A linha 1 do TS (`CONTRIBUTING.md:107`, "`npm run verify` verde num checkout
limpo") não se aplica literalmente; o equivalente no C (compilar e testar do zero num checkout
limpo) é PROPOSTA, a confirmar pelo esqueleto F0.

- **Unitário por módulo** em `native/tests/unit/`. (PROPOSTA de granularidade: um arquivo de
  teste por `.c` público.)
- **Integração** em `native/tests/integration/`, sempre com serviço isolado
  (`AGENTS_HUB_HOME`, `AGENTS_HUB_PORT`, `AGENTS_HUB_NO_AUTOSTART=1`, porta livre, home
  temporário). Nunca a porta 4747 nem `~/.agents-hub` (CLAUDE.md).
- **Conformidade** em `native/tests/conformance/`. Decidido: os testes do TS definem o que o C
  precisa provar (ADR 7.10). PROPOSTA: o C é comparado a um corpus gerado a partir do TS
  congelado; o formato e o gerador do corpus ficam para o plano.
- Framework de teste: em aberto (não está no ADR 08). Não adicione um sem o plano.
- Sem chamada a modelo real em teste; use agente falso (CLAUDE.md, regra inviolável 3).
- Teste não depende de tempo real, ordem de escalonamento nem porta fixa. (PROPOSTA)
- Bench das metas do ADR 08: procedimento definido no plano (especificação 06).

## 13. Mensagens como contrato

**Texto devolvido ao agente é interface** (`CONTRIBUTING.md:143-148`). Mensagens das tools MCP,
erros HTTP e saídas da CLI lidas por agentes seguem a especificação
([01](especificacao/01-api-http.md), [03](especificacao/03-cli-e-mcp.md)) e dizem o **motivo
real**. Mudar um texto desses é mudar contrato: exige o mesmo rigor de mudar uma rota.

## 14. Dependências

Só as bibliotecas do ADR 08 (8.4 a 8.11): SDL3, SDL_ttf, Clay, SQLite 3.53, picohttpparser,
cJSON, libyaml, PCRE2, Monocypher, libcurl (Linux). WinHTTP vem do SO (ADR 8.11). Biblioteca
fora dessa lista exige decisão do dono. (PROPOSTA)

- O ADR 08 deixa em aberto o shaping de texto (HarfBuzz pelo SDL_ttf) e o emoji colorido
  (plutosvg): "confirmar no primeiro protótipo de UI" (`docs/decisoes/08-pilha-tecnica-c.md`,
  seção "Em aberto"). PROPOSTA: dependências transitivas (ex.: FreeType do SDL_ttf, a
  biblioteca TLS da libcurl) são definidas no plano, e nenhuma delas é vendorizada no produto
  antes disso.
- Vendorizadas em `native/third_party/<lib>/`, sem download durante o build
  (`build-release-engineer.md:12`, "dependências vendorizadas/pinadas, sem downloads implícitos
  no build").
- Versão e hash de cada uma registrados junto do código vendorizado. (PROPOSTA de formato: um
  arquivo por biblioteca com versão, URL de origem, SHA-256 do arquivo baixado e licença.)
- Código vendorizado não é editado; patch necessário fica em arquivo separado e registrado.
  (PROPOSTA)
- Versão exata de cada biblioteca, além do SQLite 3.53: definida no plano.

## 15. Segurança

As garantias do [SECURITY.md](../SECURITY.md) valem para o C (ADR 7.9). Em particular:

- O env por projeto e as credenciais geridas pelo Hub não vão para o banco: o env vai para o
  cofre do SO, e o banco guarda só a referência (ADR 3.1, ADR 7.16). Também não vão para log
  nem para mensagem de erro (PROPOSTA).
- Isso não cobre o que o agente imprime: o `payload_json` dos eventos guarda, para sempre,
  trechos de arquivo que o agente leu e o que ele imprimiu (`SECURITY.md:492-497`). O C mantém
  esse comportamento (ADR 7.9).
- Borda HTTP em 127.0.0.1 por padrão (o host é configurável no TS,
  `packages/daemon/src/config.ts:213`, `:321`), com o mesmo contrato e o token de operador
  (ADR 7.6).
- A atualização valida os binários com a chave própria do projeto (Ed25519; ADR 7.14 e 8.10).
  O esquema (manifesto assinado com hash SHA-512) é proposta do ADR 08, a confirmar no plano.
