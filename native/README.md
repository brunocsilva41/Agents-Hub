# Agents-Hub nativo (C17)

Reescrita do Agents-Hub em C ([ADR 07](../docs/decisoes/07-reescrita-nativa.md),
[ADR 08](../docs/decisoes/08-pilha-tecnica-c.md)). Por enquanto só o esqueleto de build:
a lib `ah_core` (versão), o executável placeholder `hub` e um teste de unidade.

## Estrutura

| Caminho | O que é |
|---|---|
| `CMakeLists.txt` | Projeto raiz: C17 estrito (`C_STANDARD 17`, sem extensões). |
| `CMakePresets.json` | Presets de configure/build/test (tabela abaixo). |
| `cmake/AhCompilerOptions.cmake` | Warnings como erro do projeto e a opção `AH_SANITIZE`. |
| `third_party/` | SQLite, picohttpparser, cJSON, libyaml, PCRE2, Monocypher vendorizados; versões, URLs e SHA-256 em [`third_party/VERSIONS.md`](third_party/VERSIONS.md). |
| `src/core/` | `ah_core` (lib estática). |
| `src/cli/` | `hub` (placeholder que imprime a versão). |
| `tests/unit/` | Testes de unidade, sem framework, registrados no CTest. |

Warnings: código do projeto compila com `/W4 /WX` (MSVC/clang-cl) ou `-Wall -Wextra -Werror`
(GCC/Clang). As libs de terceiros compilam com o nível padrão do compilador, sem warning como erro.

## Requisitos

- CMake ≥ 3.22 e Ninja.
- Windows: Visual Studio Build Tools com "Desenvolvimento para desktop com C++" (traz `cl`, e
  também CMake e Ninja). Para o preset ASan: LLVM (`clang-cl`) instalado.
- Linux: GCC e Clang.

## Presets

| Preset | Compilador | Tipo | Sanitizers |
|---|---|---|---|
| `windows-msvc-debug` | cl | Debug | — |
| `windows-msvc-release` | cl | Release | — |
| `windows-clangcl-asan` | clang-cl | RelWithDebInfo | ASan + UBSan |
| `linux-gcc-debug` | gcc | Debug | ASan + UBSan (PROPOSTA, docs/18 §10) |
| `linux-clang-asan` | clang | Debug | ASan + UBSan |

O build vai para `native/build/<preset>/` (ignorado pelo git). O preset clang-cl usa
RelWithDebInfo porque o ASan do clang-cl não suporta o CRT de debug nem o `/RTC1` do perfil
Debug. Os sanitizers usam `-fno-sanitize-recover=all`: qualquer achado aborta e o teste falha.

## Comandos

Windows: rode a partir de um "x64 Native Tools Command Prompt" (ou depois de
`call "<VS>\VC\Auxiliary\Build\vcvars64.bat"`), dentro de `native/`:

```bat
cmake --preset windows-msvc-debug
cmake --build --preset windows-msvc-debug
ctest --preset windows-msvc-debug
build\windows-msvc-debug\bin\hub.exe
```

Linux, dentro de `native/`:

```sh
cmake --preset linux-gcc-debug
cmake --build --preset linux-gcc-debug
ctest --preset linux-gcc-debug
./build/linux-gcc-debug/bin/hub
```

Troque o nome do preset para os demais. No CI, todos rodam em
[`.github/workflows/native.yml`](../.github/workflows/native.yml).
