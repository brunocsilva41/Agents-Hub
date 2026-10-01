/* F0-12: prova mínima da pilha de UI vendorizada (ADR 8.4; DA-12 e DA-25).
 *
 * 1. Janela SDL3 oculta.
 * 2. Versões compiladas: SDL 3.4.16, SDL_ttf 3.2.2, FreeType 2.13.2,
 *    HarfBuzz 8.5.0 (HarfBuzz 0.0.0 significaria SDL_ttf sem shaping).
 * 3. Medida de um texto latino e render dele pelos caminhos de blit Blended
 *    (opaco e com alpha), Shaded e LCD (sem Solid: FreeType #1261, ver
 *    test_render_paths).
 * 4. Shaping (HarfBuzz): a palavra árabe "بببب" (quatro BEH) só sai com as
 *    formas inicial/medial/final, mais estreitas, se houver shaping. Sem
 *    shaping cada letra vira o glifo isolado do cmap, e a palavra mede o
 *    mesmo que 4 BEH isolados. O teste exige a palavra < 80% disso. Também
 *    confere que TTF_SetFontDirection(RTL) é aceito (sem HarfBuzz o SDL_ttf
 *    devolve "unsupported").
 * 5. Emoji colorido (COLR do Segoe UI Emoji, sem plutosvg; só no Windows):
 *    renderiza U+1F600 numa superfície com cor de frente cinza. Se a cor do
 *    glifo for ignorada, todos os pixels saem cinza (R=G=B); o teste exige
 *    pixels coloridos.
 * 6. Layout vazio no Clay.
 *
 * Skip (código AH_UI_SMOKE_SKIP = 77, que o CTest conta como "Skipped" via
 * SKIP_RETURN_CODE em CMakeLists.txt), sempre com mensagem "SKIP: ...":
 * - Linux sem DISPLAY nem WAYLAND_DISPLAY: sai antes de tocar no SDL;
 * - SDL_Init(SDL_INIT_VIDEO) falha (sem display utilizável);
 * - uma fonte exigida não existe (nenhuma fonte é vendorizada; decisão de
 *   fonte em aberto, relatório da F0-14 §10). */
#include <stdio.h>
#include <stdlib.h>

#include <SDL3/SDL.h>
#include <SDL3_ttf/SDL_ttf.h>

#include "ah_test.h"
#include "clay.h"

#define AH_UI_SMOKE_SKIP 77
#define FONT_PT 32.0f

/* Abre uma fonte do sistema pelo nome do arquivo; NULL (com mensagem) se não
 * existir. No Windows procura em %WINDIR%\Fonts; fora dele, nos caminhos
 * completos dados. */
static TTF_Font *open_font(const char *name) {
    TTF_Font *font;
#ifdef _WIN32
    const char *windir = SDL_getenv("WINDIR");
    char path[512];
    int n;

    if (windir == NULL) {
        printf("SKIP: WINDIR não definido, sem como achar %s\n", name);
        return NULL;
    }
    n = SDL_snprintf(path, sizeof path, "%s\\Fonts\\%s", windir, name);
    if (n <= 0 || (size_t)n >= sizeof path) {
        printf("SKIP: caminho da fonte %s longo demais\n", name);
        return NULL;
    }
#else
    const char *path = name;
#endif
    font = TTF_OpenFont(path, FONT_PT);
    if (font == NULL) {
        printf("SKIP: fonte %s não abriu (%s)\n", path, SDL_GetError());
        return NULL;
    }
    printf("fonte: %s\n", path);
    return font;
}

static void clay_error(Clay_ErrorData error) {
    fprintf(stderr, "clay: erro %d\n", (int)error.errorType);
    ah_test_failures++;
}

static void test_versions(void) {
    int major = 0, minor = 0, patch = 0;

    CHECK(SDL_GetVersion() == SDL_VERSIONNUM(3, 4, 16));
    CHECK(TTF_Version() == SDL_VERSIONNUM(3, 2, 2));

    TTF_GetFreeTypeVersion(&major, &minor, &patch);
    printf("FreeType %d.%d.%d\n", major, minor, patch);
    CHECK(major == 2 && minor == 13 && patch == 2);

    TTF_GetHarfBuzzVersion(&major, &minor, &patch);
    printf("HarfBuzz %d.%d.%d\n", major, minor, patch);
    CHECK(major == 8 && minor == 5 && patch == 0);
}

static void test_measure_latin(TTF_Font *font) {
    /* "Agents-Hub ação" em UTF-8, com escapes para não depender do código de
     * página do compilador. */
    static const char text[] = "Agents-Hub a\xc3\xa7\xc3\xa3o";
    int w = 0, h = 0;

    CHECK(TTF_GetStringSize(font, text, 0, &w, &h));
    printf("texto latino: %dx%d px\n", w, h);
    CHECK(w > 0);
    CHECK(h > 0);
}

/* Conta pixels "com tinta": alpha > 0 (por_alpha) ou vermelho > 0 sobre fundo
 * preto opaco. -1 se a superfície for NULL. */
static int count_ink(SDL_Surface *surface, bool por_alpha) {
    int x, y, ink = 0;

    if (surface == NULL) {
        return -1;
    }
    for (y = 0; y < surface->h; y++) {
        for (x = 0; x < surface->w; x++) {
            Uint8 r, g, b, a;
            if (SDL_ReadSurfacePixel(surface, x, y, &r, &g, &b, &a) &&
                (por_alpha ? a > 0 : r > 0)) {
                ink++;
            }
        }
    }
    return ink;
}

/* Passa o texto pelos outros caminhos de blit do SDL_ttf (todos tocados pelo
 * patch 0001 em native/third_party/patches/sdl_ttf/): Blended opaco e com
 * alpha, Shaded e LCD. Sob ASan/UBSan, ponteiro desalinhado aborta. */
static void test_render_paths(TTF_Font *font) {
    static const char text[] = "Agents-Hub a\xc3\xa7\xc3\xa3o";
    const SDL_Color white = {255, 255, 255, 255};
    const SDL_Color white_half = {255, 255, 255, 128};
    const SDL_Color black = {0, 0, 0, 255};
    struct {
        const char *name;
        SDL_Surface *surface;
        bool por_alpha;
    } r[4];
    size_t i;

    r[0].name = "Blended";
    r[0].surface = TTF_RenderText_Blended(font, text, 0, white);
    r[0].por_alpha = true;
    r[1].name = "Blended (alpha 128)";
    r[1].surface = TTF_RenderText_Blended(font, text, 0, white_half);
    r[1].por_alpha = true;
    r[2].name = "Shaded";
    r[2].surface = TTF_RenderText_Shaded(font, text, 0, white, black);
    r[2].por_alpha = false;
    /* Sem render Solid, de propósito. O Solid usa o rasterizador mono do
     * FreeType (src/raster/ftraster.c), que no Windows 64-bit põe o TProfile
     * desalinhado: Long tem 4 bytes no Win64 e o perfil, que tem ponteiros,
     * fica alinhado só a 4 (UBSan: "ftraster.c:727:21 ... misaligned ...
     * 'TProfile'"). Defeito aberto no upstream, sem correção nem no master:
     * https://gitlab.freedesktop.org/freetype/freetype/-/work_items/1261
     * Regra: a UI não usa render Solid (TTF_Render*_Solid) enquanto a #1261
     * estiver aberta. Ver native/third_party/VERSIONS.md, "Defeitos
     * conhecidos". */
    r[3].name = "LCD";
    r[3].surface = TTF_RenderText_LCD(font, text, 0, white, black);
    r[3].por_alpha = false;

    for (i = 0; i < sizeof r / sizeof r[0]; i++) {
        int ink = count_ink(r[i].surface, r[i].por_alpha);
        if (r[i].surface == NULL) {
            fprintf(stderr, "render %s: %s\n", r[i].name, SDL_GetError());
        } else {
            printf("render %s: %dx%d, %d pixels com tinta\n", r[i].name,
                   r[i].surface->w, r[i].surface->h, ink);
        }
        CHECK(r[i].surface != NULL);
        CHECK(ink > 0);
        SDL_DestroySurface(r[i].surface);
    }
}

static void test_shaping(TTF_Font *font) {
    static const char beh[] = "\xd8\xa8";                   /* U+0628 */
    static const char word[] = "\xd8\xa8\xd8\xa8\xd8\xa8\xd8\xa8"; /* 4x U+0628 */
    int w1 = 0, w4 = 0, h = 0;
    bool rtl;

    CHECK(TTF_FontHasGlyph(font, 0x0628));
    CHECK(TTF_GetStringSize(font, beh, 0, &w1, &h));
    CHECK(TTF_GetStringSize(font, word, 0, &w4, &h));
    printf("shaping: 1 BEH isolado = %d px; palavra de 4 BEH = %d px "
           "(sem shaping seria ~%d px)\n", w1, w4, 4 * w1);
    CHECK(w1 > 0);
    /* palavra < 80% de 4 isolados, em inteiros: w4 * 10 < 4 * w1 * 8 */
    CHECK(w4 > 0 && w4 * 10 < 4 * w1 * 8);

    rtl = TTF_SetFontDirection(font, TTF_DIRECTION_RTL);
    if (!rtl) {
        fprintf(stderr, "TTF_SetFontDirection(RTL): %s\n", SDL_GetError());
    }
    CHECK(rtl);
    CHECK(TTF_SetFontDirection(font, TTF_DIRECTION_INVALID));
}

#ifdef _WIN32
static void test_color_emoji(TTF_Font *font) {
    static const char emoji[] = "\xf0\x9f\x98\x80"; /* U+1F600 */
    const SDL_Color gray = {128, 128, 128, 255};
    SDL_Surface *surface;
    int x, y, inked = 0, colored = 0;

    CHECK(TTF_FontHasGlyph(font, 0x1F600));
    surface = TTF_RenderText_Blended(font, emoji, 0, gray);
    CHECK(surface != NULL);
    if (surface == NULL) {
        fprintf(stderr, "TTF_RenderText_Blended: %s\n", SDL_GetError());
        return;
    }
    for (y = 0; y < surface->h; y++) {
        for (x = 0; x < surface->w; x++) {
            Uint8 r, g, b, a;
            if (!SDL_ReadSurfacePixel(surface, x, y, &r, &g, &b, &a)) {
                continue;
            }
            if (a == 0) {
                continue;
            }
            inked++;
            if (abs((int)r - (int)g) > 40 || abs((int)g - (int)b) > 40 ||
                abs((int)r - (int)b) > 40) {
                colored++;
            }
        }
    }
    printf("emoji: superfície %dx%d, %d pixels com tinta, %d coloridos\n",
           surface->w, surface->h, inked, colored);
    CHECK(inked > 0);
    /* Pelo menos um quarto da tinta com cor: cinza puro daria 0. */
    CHECK(colored * 4 >= inked && colored > 0);
    SDL_DestroySurface(surface);
}
#endif

static void test_clay_empty_layout(void) {
    uint32_t size = Clay_MinMemorySize();
    void *memory;
    Clay_Arena arena;
    Clay_ErrorHandler handler = {clay_error, NULL};
    Clay_Dimensions dims = {320.0f, 200.0f};
    Clay_RenderCommandArray commands;

    CHECK(size > 0);
    memory = malloc(size);
    CHECK(memory != NULL);
    if (memory == NULL) {
        return;
    }
    arena = Clay_CreateArenaWithCapacityAndMemory(size, memory);
    CHECK(Clay_Initialize(arena, dims, handler) != NULL);
    Clay_BeginLayout();
    commands = Clay_EndLayout();
    CHECK(commands.length == 0);
    free(memory);
}

int main(void) {
    SDL_Window *window;
    TTF_Font *text_font = NULL;
#ifdef _WIN32
    TTF_Font *emoji_font = NULL;
#endif
    int skip = 0;

#ifndef _WIN32
    /* Sem servidor gráfico, nem toca no SDL (evita vazamentos de libs do
     * sistema no caminho de falha e o LSan acusar o skip). */
    if (getenv("DISPLAY") == NULL && getenv("WAYLAND_DISPLAY") == NULL) {
        printf("SKIP: sem display (DISPLAY e WAYLAND_DISPLAY não definidos)\n");
        return AH_UI_SMOKE_SKIP;
    }
#endif

    if (!SDL_Init(SDL_INIT_VIDEO)) {
        printf("SKIP: sem display (SDL_Init(VIDEO): %s)\n", SDL_GetError());
        SDL_Quit();
        return AH_UI_SMOKE_SKIP;
    }
    printf("driver de video: %s\n", SDL_GetCurrentVideoDriver());

    window = SDL_CreateWindow("ah ui_smoke", 320, 200, SDL_WINDOW_HIDDEN);
    CHECK(window != NULL);
    if (window == NULL) {
        fprintf(stderr, "SDL_CreateWindow: %s\n", SDL_GetError());
    }

    CHECK(TTF_Init());
    test_versions();

#ifdef _WIN32
    text_font = open_font("segoeui.ttf");
    emoji_font = open_font("seguiemj.ttf");
    skip = (text_font == NULL || emoji_font == NULL);
#else
    text_font = open_font("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf");
    skip = (text_font == NULL);
#endif

    if (!skip) {
        test_measure_latin(text_font);
        test_render_paths(text_font);
        test_shaping(text_font);
#ifdef _WIN32
        test_color_emoji(emoji_font);
#else
        /* DA-12: emoji colorido no Linux ainda em aberto (a fonte de emoji
         * comum no Linux é CBDT/PNG, e o FreeType vendorizado é compilado sem
         * PNG). Fica explícito na saída, não passa calado. */
        printf("emoji colorido: NAO verificado fora do Windows (DA-12, Linux em aberto)\n");
#endif
    }
    test_clay_empty_layout();

    if (text_font != NULL) {
        TTF_CloseFont(text_font);
    }
#ifdef _WIN32
    if (emoji_font != NULL) {
        TTF_CloseFont(emoji_font);
    }
#endif
    TTF_Quit();
    if (window != NULL) {
        SDL_DestroyWindow(window);
    }
    SDL_Quit();

    if (skip && ah_test_failures == 0) {
        return AH_UI_SMOKE_SKIP;
    }
    return AH_TEST_END("test_ui_smoke");
}
