/* F0-12: prova mínima da pilha de UI vendorizada (ADR 8.4).
 *
 * Cria uma janela SDL3 oculta, inicializa o SDL_ttf, mede um texto e faz um
 * layout vazio no Clay. Confere também as versões compiladas (SDL 3.4.16,
 * SDL_ttf 3.2.2, FreeType 2.13.2, HarfBuzz 8.5.0): HarfBuzz 0.0.0 aqui
 * significaria SDL_ttf sem shaping.
 *
 * Sem display (CI/headless): SDL_Init(SDL_INIT_VIDEO) falha e o teste sai com
 * AH_UI_SMOKE_SKIP (77), que o CTest conta como "skipped" (SKIP_RETURN_CODE em
 * CMakeLists.txt), em vez de falhar.
 *
 * Fonte: nenhuma fonte é vendorizada (decisão de fonte ainda aberta, relatório
 * da F0-14 §10). O teste usa uma fonte do sistema, só para medir texto. */
#include <stdio.h>
#include <stdlib.h>

#include <SDL3/SDL.h>
#include <SDL3_ttf/SDL_ttf.h>

#include "ah_test.h"
#include "clay.h"

#define AH_UI_SMOKE_SKIP 77

/* Abre a primeira fonte do sistema que existir; NULL se nenhuma. */
static TTF_Font *open_system_font(float ptsize) {
#ifdef _WIN32
    static const char *const names[] = {"segoeui.ttf", "arial.ttf"};
    const char *windir = SDL_getenv("WINDIR");
    char path[512];
    size_t i;

    if (windir == NULL) {
        return NULL;
    }
    for (i = 0; i < sizeof names / sizeof names[0]; i++) {
        int n = SDL_snprintf(path, sizeof path, "%s\\Fonts\\%s", windir, names[i]);
        if (n > 0 && (size_t)n < sizeof path) {
            TTF_Font *font = TTF_OpenFont(path, ptsize);
            if (font != NULL) {
                printf("fonte: %s\n", path);
                return font;
            }
        }
    }
    return NULL;
#else
    static const char *const paths[] = {
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    };
    size_t i;

    for (i = 0; i < sizeof paths / sizeof paths[0]; i++) {
        TTF_Font *font = TTF_OpenFont(paths[i], ptsize);
        if (font != NULL) {
            printf("fonte: %s\n", paths[i]);
            return font;
        }
    }
    return NULL;
#endif
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

/* Retorna 0 se mediu, AH_UI_SMOKE_SKIP se não há fonte (só fora do Windows). */
static int test_measure_text(void) {
    /* "Agents-Hub ação" em UTF-8, com escapes para não depender do código de
     * página do compilador. */
    static const char text[] = "Agents-Hub a\xc3\xa7\xc3\xa3o";
    TTF_Font *font = open_system_font(16.0f);
    int w = 0, h = 0;

    if (font == NULL) {
#ifdef _WIN32
        fprintf(stderr, "nenhuma fonte do sistema abriu: %s\n", SDL_GetError());
        ah_test_failures++;
        return 0;
#else
        printf("SKIP: nenhuma fonte do sistema encontrada\n");
        return AH_UI_SMOKE_SKIP;
#endif
    }

    CHECK(TTF_GetStringSize(font, text, 0, &w, &h));
    printf("texto medido: %dx%d px\n", w, h);
    CHECK(w > 0);
    CHECK(h > 0);
    TTF_CloseFont(font);
    return 0;
}

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
    int rc;

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
    rc = test_measure_text();
    test_clay_empty_layout();

    TTF_Quit();
    if (window != NULL) {
        SDL_DestroyWindow(window);
    }
    SDL_Quit();

    if (rc == AH_UI_SMOKE_SKIP && ah_test_failures == 0) {
        return AH_UI_SMOKE_SKIP;
    }
    return AH_TEST_END("test_ui_smoke");
}
