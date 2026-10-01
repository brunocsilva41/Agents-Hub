# F0-14 — spike da pilha de UI do ADR 08 (SDL3 + SDL_ttf + Clay + bandeja)

Protótipo **descartável** (tarefa F0-14 de `docs/17-plano-reescrita-c.md`; relatório em [RELATORIO.md](RELATORIO.md)) para reduzir o risco do item 8.4 do
[ADR 08](../../../docs/decisoes/08-pilha-tecnica-c.md). Não é código de produção, não segue a
estrutura de `native/src/` e **não** é incluído por `native/CMakeLists.txt`.

## Dependências (baixadas para `_deps/`, fora do git)

| Item | Versão | URL oficial | SHA-256 do arquivo baixado | Conferência |
|---|---|---|---|---|
| SDL3 (devel, MSVC) | 3.4.16 | https://github.com/libsdl-org/SDL/releases/download/release-3.4.16/SDL3-devel-3.4.16-VC.zip | `1a784cb2a5c64d56fe7a62090fe9d242d9865f235e4ea9678f1a6ba4e693e7de` | igual ao `digest` do asset na API do GitHub |
| SDL3 (fonte, só para leitura) | 3.4.16 | https://github.com/libsdl-org/SDL/releases/download/release-3.4.16/SDL3-3.4.16.tar.gz | `7322236cd12090c3eb40b9728be4d49c76f66ad17d04369584d4ecad5cf77c68` | igual ao `digest` do asset na API do GitHub |
| SDL3_ttf (devel, MSVC) | 3.2.2 | https://github.com/libsdl-org/SDL_ttf/releases/download/release-3.2.2/SDL3_ttf-devel-3.2.2-VC.zip | `67805c5babfc49ca0c56882dc9b8cabbcdd1e6f9edde10ddac91ddb38f3afb8c` | o release (03/2025) não publica `digest`; `.sig` não conferida |
| Clay `clay.h` | v0.14 | https://github.com/nicbarker/clay/releases/download/v0.14/clay.h | `c97241cc423af3fa11267978adce9cbb46274a2ad0709a5d4b2b1092dc27599d` | igual ao `digest` do asset na API do GitHub |
| Clay (fonte do tag, renderers e exemplos) | v0.14 | https://github.com/nicbarker/clay/archive/refs/tags/v0.14.zip | `e8f7eb9202561527cd8bd4d5e9f110f937c11b1f9de3dc91dd1e3ee7e31e5d15` | arquivo de tag (sem digest); `clay-0.14/clay.h` é idêntico ao asset (`cmp`) |

Licenças: SDL3, SDL_ttf e Clay são Zlib. O SDL3_ttf.dll pré-compilado traz FreeType 2.13.2 e
HarfBuzz 8.5.0 embutidos (relatado em runtime por `TTF_GetFreeTypeVersion`/`TTF_GetHarfBuzzVersion`);
**não** traz plutosvg (nenhum símbolo `plutosvg`/`plutovg` no DLL).

Layout esperado depois de extrair os zips em `_deps/`:
`_deps/SDL3-3.4.16/`, `_deps/SDL3_ttf-3.2.2/`, `_deps/clay-0.14/`.

## Fontes

Nenhuma fonte é copiada para o repositório. O spike lê em runtime, de `%WINDIR%\Fonts`, fontes
do Windows (licença proprietária da Microsoft, **não redistribuíveis**):
`segoeui.ttf`/`segoeuib.ttf` (principal), `msyh.ttc` (CJK chinês/japonês), `malgun.ttf`
(Hangul) e `seguiemj.ttf` (emoji colorido), encadeadas com `TTF_AddFallbackFont`.

## Build (MSVC 14.50, CMake e Ninja do VS Build Tools 18)

```bat
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
cd native\spikes\ui
cmake -S . -B build\Release -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build\Release
rem Debug com ASan do MSVC; para rodar, clang_rt.asan_dynamic-x86_64.dll precisa estar no PATH
rem (VC\Tools\MSVC\14.50.35717\bin\Hostx64\x64)
cmake -S . -B build\Debug -G Ninja -DCMAKE_BUILD_TYPE=Debug
cmake --build build\Debug
rem CRT estático (sem VCRUNTIME140.dll)
cmake -S . -B build\ReleaseMT -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded
cmake --build build\ReleaseMT
```

`src/spike_ui.c` compila com `/W4 /WX /utf-8 -std:c17`. `clay.h` compila numa TU própria
(`src/clay_impl.c`) com `/W3`, porque gera ~40 avisos C4244/C4305 (conversões int/float).

## Execução

`build\Release\spike_ui.exe`. Variáveis de ambiente do spike:

| Variável | Efeito |
|---|---|
| `SPIKE_AUTOTEST=1` | roteiro automático: rolagem, clique em item/botão, foco e texto no campo, fechar (esconde), `SDL_ClickTrayEntry` em "Abrir" e "Sair"; código de saída 0 = sem falhas |
| `SPIKE_FRAMELOG=1` | registra cada quadro desenhado (prova de redesenho só sob evento) |
| `SPIKE_SCALE=1.25` | força a escala da UI (caminho HiDPI num monitor a 100%) |
| `SPIKE_SHOT=a.png` | salva a captura do primeiro quadro; F12 salva `shot_f12_N.png` |
| `SPIKE_STRESS=N` | desenha N quadros rolando a lista (crescimento de memória) |
| `SPIKE_FOCUS=1` | inicia com o campo de texto focado |

Resultados, medições, limitações e aceite item a item: [RELATORIO.md](RELATORIO.md).
