# F0-14 — Relatório do spike de UI (SDL3 + SDL_ttf + Clay + bandeja)

Data: 2026-09-30. Protótipo descartável em `native/spikes/ui/` (build e dependências: [README.md](README.md)).
O código do spike nunca entra no produto.

## 1. Ambiente

| Item | Valor |
|---|---|
| SO | Windows 10 Pro 10.0.19045, 2 monitores 1920x1080 a 100% |
| Compilador | MSVC 14.50.35717 (VS Build Tools 18), CMake e Ninja do próprio VS |
| Versões em runtime (log do spike) | `SDL 3.4.16 \| SDL_ttf 3.2.2 \| FreeType 2.13.2 \| HarfBuzz 8.5.0` |
| Renderer do SDL | `direct3d11`, VSync ligado |
| Escala informada pelo SDL | `display_scale=1.00 pixel_density=1.00` |
| Arena do Clay (`Clay_MinMemorySize`) | 6.395.392 bytes (padrões: 8.192 elementos, 16.384 palavras no cache) |
| Teclado / IME | só pt-BR (`0416:00000416`); nenhum IME de CJK instalado |

## 2. Aceite da F0-14, item a item

| Ponto do Aceite (`docs/17-plano-reescrita-c.md`) | Resultado | Evidência |
|---|---|---|
| Shaping com HarfBuzz pelo SDL_ttf (DA-12) | **Atendido no Windows**: o SDL3_ttf.dll oficial traz HarfBuzz 8.5.0 embutido; texto pt-BR, japonês, chinês e coreano renderiza com fallback | §3, capturas `shot_1_inicial.png` |
| Emoji colorido **com plutosvg** (DA-12) | **Não coberto.** O SDL3_ttf.dll pré-compilado 3.2.2 **não** traz plutosvg (nenhum símbolo `plutosvg`/`plutovg` no DLL). O emoji colorido que aparece vem do COLR v0 do Segoe UI Emoji do Windows 10, desenhado pelo FreeType, não do plutosvg | §3 |
| Laço redesenhando só sob evento, com CPU parado medido (DA-11) | **Atendido no Windows** | §4 |
| `SDL_CreateTray` na thread principal no **Windows** | **Atendido em parte**: a bandeja é criada; fechar a janela pelo SO esconde e o processo continua; "Abrir" e "Sair" testados por `SDL_ClickTrayEntry` (mesmo callback). Clique **real** no menu da bandeja: **não verificado** | §5 |
| `SDL_CreateTray` no **Linux com e sem** `libayatana-appindicator3`/`libappindicator3` | **Não coberto.** Nada foi compilado nem executado no Linux | — |
| Entrada de texto com IME | **Não atendido.** O caminho de código existe (`SDL_StartTextInput`, `SDL_EVENT_TEXT_EDITING`, `SDL_SetTextInputArea`), mas IME real não foi testado (sem IME instalado) e há um erro conhecido de unidade no cursor da composição (§7) | §5, §7 |
| Evidência com captura e medição | capturas PNG geradas pelo próprio spike (`SPIKE_SHOT`/autoteste/F12, ignoradas no git) e medições do §4 | §3–§6 |

## 3. Texto

Fontes lidas em runtime de `%WINDIR%\Fonts` e encadeadas com `TTF_AddFallbackFont`:
`segoeui.ttf` → `msyh.ttc` → `malgun.ttf` → `seguiemj.ttf`.

Cobertura de cada fonte isolada (`TTF_FontHasGlyph`, antes de encadear):

```
glifo ç           segoeui=1 msyh=1 malgun=1 seguiemj=1
glifo 日 (CJK)    segoeui=0 msyh=1 malgun=1 seguiemj=0
glifo 한 (Hangul) segoeui=0 msyh=0 malgun=1 seguiemj=0
glifo 😀 (emoji) segoeui=0 msyh=0 malgun=0 seguiemj=1
```

| Caso | Resultado observado na captura |
|---|---|
| pt-BR (ação, coração, à, é, ü, aspas, travessão) | OK |
| Japonês e chinês (日本語のテキスト 中文文本) | OK via `msyh.ttc` |
| Coreano (한국어) | caixas vazias só com `msyh.ttc`; OK depois de acrescentar `malgun.ttf` |
| Emoji (😀 🚀 ✅ ⚠️) | colorido (COLR v0 do Win10 pelo FreeType) |
| Tom de pele (👍🏽) | OK, modificador aplicado |
| Sequência ZWJ (👨‍👩‍👧) | **não junta**: sai como 3 rostos separados |
| Quebra de linha | o Clay quebra só em espaço; texto CJK sem espaço não quebra |
| Nitidez com escala forçada 1,25 e 1,5 | texto nítido (fontes reabertas no tamanho em pixels) |

## 4. Desempenho e memória (Release `/MD`)

Medido com PowerShell `Get-Process` sobre o processo do spike (`TotalProcessorTime`,
`WorkingSet64`, `PrivateMemorySize64`). Procedimento: iniciar com `SPIKE_FRAMELOG=1` e saída
redirecionada para log, esperar 5 s, ler os contadores, esperar 60 s, ler de novo.

```powershell
$p = Start-Process -FilePath .\spike_ui.exe -RedirectStandardOutput idle.log -PassThru
Start-Sleep 5;  $p.Refresh(); $c0 = $p.TotalProcessorTime.TotalSeconds
Start-Sleep 60; $p.Refresh(); $c1 = $p.TotalProcessorTime.TotalSeconds
$c1 - $c0; $p.WorkingSet64/1MB; $p.PrivateMemorySize64/1MB
$null = $p.CloseMainWindow()   # WM_CLOSE real: deve esconder, não encerrar
```

| Medida | Valor |
|---|---|
| CPU, janela visível parada, 60,1 s | **0,016 s** (um quantum do agendador); **nenhum quadro** desenhado no período (log parou no quadro 3, em 0,379 s) |
| CPU, escondida na bandeja (após `WM_CLOSE` real), 60 s | **0,000 s**; processo vivo |
| RAM parada (visível) | WorkingSet 30,4 MB; Private 27,3 MB; pico de WorkingSet 31,3 MB |
| RAM sob carga (`SPIKE_STRESS=N`, rolando a lista) | Private 25,7 MB (0 quadros) → 42,2 MB (500) → 48,6 MB (2.000) → 49,7 MB (6.000); WorkingSet 29,3 → 31,7 MB. Estabiliza: sem sinal de vazamento sem limite |
| Custo por quadro sob carga | 2.000 quadros em 14,4 s com 9,83 s de CPU (≈ 4,9 ms de CPU/quadro); 6.000 quadros: 27,45 s de CPU (≈ 4,6 ms/quadro) |
| Quadros em regime (log de quadros) | layout ≈ 1,0 ms e render ≈ 1,2–1,5 ms com os 1.000 itens; o 1º quadro custa 23–38 ms de layout e 30–47 ms de render (cache de glifos e medidas frio) |
| Autoteste, 8 quadros (última execução) | `layout(média/máx)=5.19/34.19 ms render(média/máx)=4.68/27.91 ms`. A média de 8 quadros é dominada pelo 1º quadro |

Observação: a primeira tentativa de medir CPU visível foi descartada porque alguém usou a janela
durante a medição (o log registrou 44 cliques no botão e seleções de item). Isso serviu de prova
de que o clique real do mouse funciona, mas não vale como medida em repouso. O número acima é da
segunda execução, sem nenhum quadro desenhado.

### Observação do revisor (registrada a pedido do coordenador)

Numa execução do revisor no Release: layout média **8,28 ms** (máx. 57,62) e render média
**6,81 ms** (máx. 43,27) em 8 quadros. Causas apontadas no código do spike:
- `draw_text` cria e destrói um `TTF_Text` a cada comando de texto, em todo quadro
  (`src/spike_ui.c`, função `draw_text`). Um produto precisa de cache de `TTF_Text` por string.
- `update_hover` procura o id sob o ponteiro numa busca linear pelos 1.000 itens
  (`src/spike_ui.c`, função `update_hover`). Um produto precisa de mapa id→índice ou de
  virtualização.

## 5. Interação e bandeja

Autoteste (`SPIKE_AUTOTEST=1`, Release, última execução): 8 checagens OK, `exit=0`:

```
AUTOTEST OK  : rolagem da lista com roda          (scroll y: 0.0 -> -27369.0, conteúdo 28000)
AUTOTEST OK  : clique seleciona item visível após rolagem
AUTOTEST OK  : clique no botão
AUTOTEST OK  : foco no campo liga SDL_StartTextInput
AUTOTEST OK  : inserção UTF-8 no campo
AUTOTEST OK  : backspace remove 1 code point
AUTOTEST OK  : fechar janela esconde (processo segue)
AUTOTEST OK  : tray Abrir restaura a janela
AUTOTEST fim: 0 falha(s)
```

O autoteste usa caminhos sintéticos: chama as funções de clique, roda e inserção do próprio spike,
injeta `SDL_EVENT_WINDOW_CLOSE_REQUESTED` e usa `SDL_ClickTrayEntry`. O que foi provado com
entrada **real** do SO:
- clique real do mouse em botão e itens da lista (uso manual registrado no log, ver §4);
- `WM_CLOSE` real (`CloseMainWindow`) esconde a janela e o processo continua;
- tecla real (`WM_KEYDOWN` F12 e Enter via PostMessage) chega como `SDL_EVENT_KEY_DOWN`.

O que **não** foi possível provar com entrada real:
- **texto digitado**: `WM_CHAR` via PostMessage é descartado pelo SDL porque a janela não tem foco
  de teclado (`SDL_SendKeyboardText` exige `keyboard->focus`, e o foco vem de
  `GetForegroundWindow()`). `SendInput` foi abortado de propósito: o Windows não deixou a janela ir
  para o primeiro plano, e o script não digita em outro aplicativo;
- **roda e clique via PostMessage**: o SDL usa a posição real do cursor, não a da mensagem.

Ctrl+V, Home/End, setas e Enter no campo foram implementados, mas só Enter teve evento real.

## 6. Tamanho (MSVC Release, x64)

| Build | `spike_ui.exe` | DLLs | Total | Dependências do exe (`dumpbin /dependents`) |
|---|---|---|---|---|
| `/MD` (padrão) | 122.880 B | `SDL3.dll` 2.844.160 B + `SDL3_ttf.dll` 2.021.888 B | **4.988.928 B** | `SDL3_ttf.dll`, `SDL3.dll`, `VCRUNTIME140.dll`, `api-ms-win-crt-*`, `KERNEL32.dll` (exige o VC++ Redistributable) |
| `/MT` (`-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded`) | 256.000 B | mesmas | **5.122.048 B** | `SDL3_ttf.dll`, `SDL3.dll`, `KERNEL32.dll` |

Os DLLs oficiais do SDL não dependem do vcruntime: `SDL3_ttf.dll` importa `USP10`, `GDI32`,
`RPCRT4`, `SDL3`, `KERNEL32`, `USER32`; `SDL3.dll` importa só DLLs do sistema.

## 7. Risco do IME (erro conhecido no spike)

No SDL 3.4.16/Windows, `SDL_TextEditingEvent.start` chega em **unidades UTF-16**: o cursor vem de
`ImmGetCompositionStringW(..., GCS_CURSORPOS, ...)` e é repassado a `SDL_SendEditingText`
(`src/video/windows/SDL_windowskeyboard.c` do SDL 3.4.16, linhas 811 e 934). O spike trata esse
valor como **code points** (`utf8_cp_to_byte` no tratamento de `SDL_EVENT_TEXT_EDITING` em
`src/spike_ui.c`). Para texto no BMP (CJK comum) os dois coincidem; com caracteres fora do BMP
(emoji, CJK estendido) o cursor da composição fica na posição errada. O produto precisa converter
UTF-16→bytes, ou confirmar a unidade em cada plataforma. Não corrigido no spike: sem IME real não
dá para testar.

## 8. O que o Clay v0.14 não oferece e esforço observado

| Item | Situação no Clay | Esforço no spike |
|---|---|---|
| Renderer SDL3 | o renderer oficial (`renderers/SDL3`) usa VLA: não compila no MSVC em C17 | renderer próprio, ~65 linhas (sem cantos arredondados) |
| Campo de texto | não existe; feito como elemento `custom` | ~210 linhas (UTF-8, cursor, composição, clique para posicionar, teclas, colagem). Faltam seleção, desfazer, apagar por grafema, cursor piscando (exige timer), multilinha |
| Rolagem | área com recorte + roda (passo fixo de 10 unidades); arrasto tem inércia que exige animação | barra visual à mão (~20 linhas); arrasto da barra não feito; arrasto com inércia desligado |
| Clique, hover, foco | só ids sob o ponteiro; `Clay_Hovered()` não funciona com `.id` na mesma declaração; `Clay_ElementIdArray_Get` só existe na TU de implementação | ~50 linhas de hit-test/hover; foco por teclado (Tab) **não existe e não foi feito** |
| Tabela, árvore, modais | não existem (só elementos flutuantes como base) | não feito |
| Lista grande | refaz o layout de todos os elementos a cada quadro (~1 ms para 1.000 itens); limite padrão de 8.192 elementos | sem virtualização |
| Quebra de linha | só em espaço | CJK sem espaço não quebra |
| Avisos de compilação | `clay.h` gera ~40 avisos C4244/C4305 em `/W3` | isolado numa TU de terceiro (`src/clay_impl.c`) |
| Acessibilidade | nada (o SDL também não tem leitor de tela) | não feito |

## 9. Limitações (não verificado)

- **IME real** (composição japonesa/chinesa/coreana): não verificado; sem IME instalado.
- **Teclas mortas do ABNT2** (´ + a): não verificado.
- **Menu real da bandeja** (clique do usuário em "Abrir"/"Sair"): não verificado; só `SDL_ClickTrayEntry`.
- **Escala real de 125%/150%** e o evento `SDL_EVENT_WINDOW_DISPLAY_SCALE_CHANGED`: não verificados;
  mudar a escala do sistema é configuração global. Só a escala forçada (`SPIKE_SCALE=1.25`/`1.5`)
  foi testada: janela de 1250x850 e 1500x1020, texto nítido, autoteste com 0 falhas.
- **Emoji COLRv1 / Windows 11**: não verificado. O FreeType 2.13 não rasteriza COLRv1; no Win11 o
  emoji pode sair sem cor ou faltar.
- **Leitor de tela**: não verificado (não há suporte no SDL).
- **Linux** (build, janela, bandeja com e sem appindicator): **não coberto**.
- **plutosvg**: **não coberto** (ausente no binário oficial do SDL3_ttf).

## 10. Lacunas

- **Fontes não redistribuíveis.** Segoe UI, Microsoft YaHei, Malgun Gothic e Segoe UI Emoji são da
  Microsoft e não podem ir no instalador. O produto precisa decidir entre embutir uma fonte livre
  (ex.: família Noto, com licença registrada) e buscar fontes do sistema (inclusive fontconfig no
  Linux). Hoje nenhum plano cobre isso.
- **plutosvg e FreeType (DA-12, DA-25)**: o binário oficial traz HarfBuzz e FreeType embutidos,
  mas não plutosvg. Para emoji SVG/COLRv1 seria preciso compilar o SDL_ttf com plutosvg. Isso fica
  fora do spike e depende de decisão.
- **Runtime do C**: `/MD` exige o VC++ Redistributable; `/MT` resolve com +133 KB no exe.
- **Linux**: o ponto do Aceite sobre a bandeja com e sem appindicator continua aberto.
