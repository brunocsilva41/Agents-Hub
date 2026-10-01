# CLAUDE.md — Agents-Hub

O Agents-Hub está sendo **reescrito em C** como app nativo instalável para Windows e Linux
([ADR 07](docs/decisoes/07-reescrita-nativa.md), [ADR 08](docs/decisoes/08-pilha-tecnica-c.md)).
O código TypeScript em `packages/` é **especificação congelada**: fica no repositório como
referência, e seus testes definem o que o C precisa provar. **Não altere nada em `packages/`**
(ADR 7.10). Pendências abertas do TS viram requisitos do C.

## Fontes da verdade (ordem de leitura)

Leia antes de qualquer tarefa. Se o código e um documento divergirem, reporte; não escolha
sozinho.

1. [ADR 07](docs/decisoes/07-reescrita-nativa.md) — o que foi decidido para a reescrita.
2. [ADR 08](docs/decisoes/08-pilha-tecnica-c.md) — pilha técnica, bibliotecas e metas de desempenho.
3. Especificação extraída do TS, em `docs/especificacao/`:
   - [01 — API HTTP](docs/especificacao/01-api-http.md)
   - [02 — banco e dados](docs/especificacao/02-banco-e-dados.md)
   - [03 — CLI e MCP](docs/especificacao/03-cli-e-mcp.md)
   - [04 — domínio e adapters](docs/especificacao/04-dominio-e-adapters.md)
   - [05 — inventário do painel](docs/especificacao/05-painel-inventario.md)
   - [06 — desempenho: linha de base e metas](docs/especificacao/06-desempenho-linha-de-base-e-metas.md) (orçamento de performance)
4. Plano: `docs/17-plano-reescrita-c.md` — tarefas com ID, entrega, aceite e dependências.
5. Padrões de código C: `docs/18-padroes-c.md`.
6. Status: `docs/19-status-reescrita-c.md` — o que está pronto, com evidência.
7. [SECURITY.md](SECURITY.md) — modelo de ameaça; as garantias valem também para o C.
8. [CONTRIBUTING.md](CONTRIBUTING.md) — critério de pronto e vocabulário de status (`[x]`, `[~]`, `🕳️`, `[ ]`).

> Os itens 4, 5 e 6 estão sendo escritos em 2026-09-30. Se um deles ainda não existir, diga
> isso no relatório e trabalhe só com o que a tarefa pede.

## Estrutura de pastas

| Caminho | Conteúdo |
|---|---|
| `native/CMakeLists.txt` | build raiz do C |
| `native/cmake/` | módulos e toolchains do CMake |
| `native/third_party/<lib>/` | bibliotecas vendorizadas do ADR 08 (registro de versão e hash: PROPOSTA, ver `docs/18-padroes-c.md` §14) |
| `native/src/platform/` | **única** camada que chama o SO (Win32/POSIX); fonte: `~/.claude/agents/c-engineer.md:20` |
| `native/src/core/` | domínio: política, orçamento, grafo, resiliência (`CONTRIBUTING.md:67`); não conhece adapters nem HTTP, recebe portas injetadas (`CONTRIBUTING.md:155-158`) |
| `native/src/store/` | SQLite e migrações |
| `native/src/adapters/` | os 9 agentes (ADR 7.8): spawn e mapeamento de stream |
| `native/src/daemon/` | serviço HTTP em 127.0.0.1, SSE, sessões |
| `native/src/client/` | cliente HTTP do serviço, usado por CLI, hook do gate e MCP (ADR 7.6); uso pela UI: PROPOSTA |
| `native/src/cli/` | CLI `hub` |
| `native/src/mcp/` | MCP server (16 tools) |
| `native/src/ui/` | janela nativa (SDL3 + SDL_ttf + Clay) e bandeja |
| `native/src/updater/` | atualização automática via GitHub Releases |
| `native/tests/unit/` | testes unitários por módulo |
| `native/tests/integration/` | testes com serviço isolado |
| `native/tests/conformance/` | conformidade com o TS (ADR 7.10: os testes do TS definem o que o C precisa provar); comparação contra corpus gerado do TS: PROPOSTA |
| `native/spikes/` | protótipos descartáveis; não entram no produto (PROPOSTA) |
| `packages/` | TS congelado (especificação). Só leitura |

O esqueleto da fase F0 (CMake, presets, bibliotecas em `native/third_party/` com versão e hash em
`VERSIONS.md`, CI em `.github/workflows/native.yml`) já existe; as demais pastas de `native/src/`
são criadas pelas tarefas do plano.

## Comandos

Dentro de `native/`. No Windows, depois de
`call "<VS>\VC\Auxiliary\Build\vcvars64.bat"` (CMake e Ninja vêm do VS Build Tools). Presets em
`native/CMakePresets.json`: `windows-msvc-debug`, `windows-msvc-release`, `windows-clangcl-asan`,
`linux-gcc-debug`, `linux-clang-asan`. Não invente flags, presets nem alvos.

| Ação | Comando | Estado |
|---|---|---|
| Configurar | `cmake --preset <preset>` | verificado no Windows (2026-09-30); Linux só no CI |
| Compilar | `cmake --build --preset <preset>` | verificado no Windows; Linux só no CI |
| Testar | `ctest --preset <preset>` | verificado no Windows; Linux só no CI |
| Formatar | `find src tests -name '*.c' -o -name '*.h' \| xargs clang-format --dry-run --Werror` (config em `native/.clang-format`; `third_party/` excluído) | verificado no Windows com clang-format 22.1.8 (2026-10-01); o código atual ainda tem desvios (42 de 54 arquivos), não está no CI |
| Bench de desempenho | procedimento do plano (especificação 06); harness da linha de base TS em `native/tests/bench/ts-baseline/` | a confirmar pelo plano (DA-05) |

O TS continua compilável para gerar referência (`npm ci`, `npm run verify`, ver
CONTRIBUTING.md), mas sem mudança de código.

Quem criar um comando novo (build, test, bench, package) registra aqui, já verificado.

## Regras invioláveis do projeto

1. **Daemon real do usuário é intocável.** Nunca suba, pare, reinicie nem escreva no daemon
   da porta **4747** nem em **`~/.agents-hub`**.
2. **Teste real sempre isolado, na mesma chamada de shell.** Toda invocação do `hub` (TS ou C)
   leva juntas `AGENTS_HUB_HOME=<home temporário>`, `AGENTS_HUB_PORT=<porta livre>` e
   `AGENTS_HUB_NO_AUTOSTART=1`. O estado do shell não persiste entre chamadas; sem as três, a
   chamada atinge ou sobe o daemon real.
3. **Nunca chame modelo real sem autorização explícita** do dono na tarefa. Use agentes falsos (como o `npm run demo` do TS faz).
4. **Nunca use `--write`** (`hub hooks install`, `hub mcp install`, `hub import`, `hub merge`,
   `hub restore`...) contra configs reais de CLIs ou contra o banco real.
5. **Segredos:** nunca exiba, copie, registre em log nem envie `.env`, tokens (inclusive o
   `operator-token`), chaves de assinatura ou credenciais de CLI. Cite só o nome.
6. **Sem trabalho novo em TS** (ADR 7.10).

## Fluxo de trabalho

- **Agentes especializados por área disjunta.** Cada tarefa (ID do plano) tem um dono e toca
  só os arquivos da sua área. Duas tarefas em paralelo não editam o mesmo arquivo.
- **O agente não faz commit** nem `push`. O coordenador mescla.
- **Verificação independente antes de mesclar:** `scope-guardian` (aderência ao plano) e
  `code-reviewer` (correção) revisam a entrega; quem implementou não se aprova.
- **Nada é "pronto" sem evidência:** comando executado e saída real. O status só muda com
  commit, saída de teste ou medição citada (critério de pronto do CONTRIBUTING.md).
- **Lacuna se reporta, não se implementa.** O que não está no plano nem no ADR vira pergunta.

## Commits

Imperativo, descrevendo o efeito observável (ver CONTRIBUTING.md, "Commits"). Toda mensagem
termina com:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```
