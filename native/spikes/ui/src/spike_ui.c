/* F0-14 (spike de UI) — prova da pilha de UI do ADR 08 (8.4): SDL3 + SDL_ttf + Clay + tray.
 *
 * Protótipo descartável: NÃO é código de produção e não segue a estrutura de native/src.
 * Objetivos medidos: layout Clay com lista de 1.000 itens, texto pt-BR/CJK/emoji, botão,
 * campo de texto com SDL_StartTextInput/IME, redesenho só sob evento (SDL_WaitEvent),
 * bandeja (fechar esconde; "Abrir" restaura; "Sair" encerra) e escala HiDPI.
 *
 * Unidades:
 *   L = unidade lógica do layout Clay (independe de DPI)
 *   P = pixel do render target          P = L * ui_scale
 *   W = coordenada de janela do SDL     W = P / pixel_density
 *
 * Variáveis de ambiente (só para o spike):
 *   SPIKE_SCALE=1.5      força ui_scale (testa o caminho HiDPI num monitor 100%)
 *   SPIKE_SHOT=arq.png   salva captura do primeiro quadro
 *   SPIKE_AUTOTEST=1     roteiro automático (rolagem, clique, texto, fechar/abrir/sair via tray)
 *   SPIKE_FRAMELOG=1     registra cada quadro desenhado (prova de redesenho só sob evento)
 *   SPIKE_STRESS=N       desenha N quadros rolando a lista ao iniciar (crescimento de memória)
 *   SPIKE_FOCUS=1        inicia com o campo de texto focado (teste de entrada sem mouse)
 */
#include <SDL3/SDL.h>
#include <SDL3/SDL_main.h>
#include <SDL3_ttf/SDL_ttf.h>

#include "clay.h"

#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#define ITEM_COUNT 1000
#define ITEM_LABEL_CAP 48
#define TF_CAP 512
#define PRE_CAP 128
#define STATUS_CAP 512

enum { FONT_BODY = 0, FONT_TITLE = 1, FONT_COUNT = 2 };
enum { FALLBACK_COUNT = 3 };

static const float FONT_PT[FONT_COUNT] = {15.0f, 20.0f};

typedef struct TextField {
    char buf[TF_CAP]; /* UTF-8, sempre terminado em NUL */
    size_t len;
    size_t cursor; /* índice em bytes, sempre em fronteira de code point */
    char pre[PRE_CAP]; /* composição do IME (preedit) */
    size_t pre_len;
    size_t pre_cursor; /* bytes dentro de pre */
    bool focused;
    float scroll_px;
    SDL_FRect rect_px; /* último retângulo desenhado */
} TextField;

typedef struct App {
    SDL_Window *win;
    SDL_Renderer *ren;
    TTF_TextEngine *te;
    TTF_Font *font[FONT_COUNT];
    TTF_Font *fallback[FONT_COUNT][FALLBACK_COUNT];
    SDL_Tray *tray;
    SDL_TrayEntry *e_open;
    SDL_TrayEntry *e_quit;
    SDL_Surface *icon;

    float ui_scale;
    float density;
    bool scale_forced;

    bool dirty;
    bool quit;
    bool framelog;
    bool autotest;
    int autotest_step;
    int autotest_fail;
    char shot_path[260];

    Clay_Vector2 mouse_l;
    int hover_item; /* -1 = nenhum */
    bool hover_button;
    bool hover_field;
    int selected;
    int clicks;

    TextField tf;
    char submitted[TF_CAP];

    char labels[ITEM_COUNT][ITEM_LABEL_CAP];
    uint32_t item_ids[ITEM_COUNT];
    uint32_t id_list, id_button, id_field;

    char status[STATUS_CAP];
    char info[STATUS_CAP];

    Uint64 frames;
    double layout_ms_max, render_ms_max, layout_ms_sum, render_ms_sum;
    Uint32 autotest_event;
} App;

static void app_log(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    fprintf(stdout, "[%8.3f] ", (double)SDL_GetTicks() / 1000.0);
    vfprintf(stdout, fmt, ap);
    fputc('\n', stdout);
    fflush(stdout);
    va_end(ap);
}

/* ---------- UTF-8 ---------- */

static size_t utf8_prev(const char *s, size_t i)
{
    if (i == 0) return 0;
    i--;
    while (i > 0 && ((unsigned char)s[i] & 0xC0u) == 0x80u) i--;
    return i;
}

static size_t utf8_next(const char *s, size_t len, size_t i)
{
    if (i >= len) return len;
    i++;
    while (i < len && ((unsigned char)s[i] & 0xC0u) == 0x80u) i++;
    return i;
}

/* Maior n <= max tal que s[0..n) termina em fronteira de code point. */
static size_t utf8_clip(const char *s, size_t len, size_t max)
{
    if (len <= max) return len;
    size_t n = max;
    while (n > 0 && ((unsigned char)s[n] & 0xC0u) == 0x80u) n--;
    return n;
}

/* Converte índice em code points (SDL_TextEditingEvent.start) para bytes. */
static size_t utf8_cp_to_byte(const char *s, size_t len, int cp)
{
    size_t i = 0;
    for (int k = 0; k < cp && i < len; k++) i = utf8_next(s, len, i);
    return i;
}

/* ---------- campo de texto (Clay não tem: widget próprio) ---------- */

static bool tf_insert(TextField *tf, const char *s, size_t n)
{
    size_t room = TF_CAP - 1 - tf->len;
    bool truncated = false;
    if (n > room) {
        n = utf8_clip(s, n, room);
        truncated = true;
    }
    memmove(tf->buf + tf->cursor + n, tf->buf + tf->cursor, tf->len - tf->cursor);
    memcpy(tf->buf + tf->cursor, s, n);
    tf->len += n;
    tf->cursor += n;
    tf->buf[tf->len] = '\0';
    return !truncated;
}

static void tf_erase(TextField *tf, size_t from, size_t to)
{
    if (to <= from || to > tf->len) return;
    memmove(tf->buf + from, tf->buf + to, tf->len - to);
    tf->len -= to - from;
    tf->buf[tf->len] = '\0';
    tf->cursor = from;
}

static int text_width_px(TTF_Font *f, const char *s, size_t n)
{
    if (n == 0) return 0;
    int w = 0, h = 0;
    if (!TTF_GetStringSize(f, s, n, &w, &h)) {
        app_log("TTF_GetStringSize falhou: %s", SDL_GetError());
        return 0;
    }
    return w;
}

/* ---------- fontes (lidas do sistema em runtime; nada é copiado para o repo) ---------- */

static bool font_path(char *out, size_t cap, const char *file)
{
    const char *windir = SDL_getenv("WINDIR");
    if (!windir) windir = "C:\\Windows";
    int n = snprintf(out, cap, "%s\\Fonts\\%s", windir, file);
    return n > 0 && (size_t)n < cap;
}

static TTF_Font *open_font(const char *file, float pt)
{
    char path[512];
    if (!font_path(path, sizeof path, file)) return NULL;
    TTF_Font *f = TTF_OpenFont(path, pt);
    if (!f) app_log("TTF_OpenFont(%s) falhou: %s", path, SDL_GetError());
    return f;
}

static bool fonts_open(App *a)
{
    static const char *const fallback_files[FALLBACK_COUNT] = {"msyh.ttc", "malgun.ttf", "seguiemj.ttf"};
    for (int i = 0; i < FONT_COUNT; i++) {
        float pt = FONT_PT[i] * a->ui_scale;
        a->font[i] = open_font(i == FONT_TITLE ? "segoeuib.ttf" : "segoeui.ttf", pt);
        if (!a->font[i]) return false;
        for (int k = 0; k < FALLBACK_COUNT; k++) {
            a->fallback[i][k] = open_font(fallback_files[k], pt);
            if (!a->fallback[i][k]) return false;
        }
        if (i == FONT_BODY) { /* cobertura de cada fonte isolada, antes de encadear os fallbacks */
            static const struct { Uint32 cp; const char *name; } probes[] = {
                {0x00E7, "ç"}, {0x00E3, "ã"}, {0x65E5, "日 (CJK)"}, {0xD55C, "한 (Hangul)"}, {0x1F600, "😀 (emoji)"}};
            for (size_t p = 0; p < SDL_arraysize(probes); p++) {
                app_log("glifo %-12s segoeui=%d msyh=%d malgun=%d seguiemj=%d", probes[p].name,
                        TTF_FontHasGlyph(a->font[i], probes[p].cp), TTF_FontHasGlyph(a->fallback[i][0], probes[p].cp),
                        TTF_FontHasGlyph(a->fallback[i][1], probes[p].cp),
                        TTF_FontHasGlyph(a->fallback[i][2], probes[p].cp));
            }
        }
        for (int k = 0; k < FALLBACK_COUNT; k++) {
            if (!TTF_AddFallbackFont(a->font[i], a->fallback[i][k])) {
                app_log("TTF_AddFallbackFont falhou: %s", SDL_GetError());
                return false;
            }
        }
    }
    return true;
}

static void fonts_rescale(App *a)
{
    for (int i = 0; i < FONT_COUNT; i++) {
        float pt = FONT_PT[i] * a->ui_scale;
        for (int k = 0; k < FALLBACK_COUNT; k++) {
            if (!TTF_SetFontSize(a->fallback[i][k], pt)) app_log("TTF_SetFontSize: %s", SDL_GetError());
        }
        if (!TTF_SetFontSize(a->font[i], pt)) app_log("TTF_SetFontSize: %s", SDL_GetError());
    }
    Clay_ResetMeasureTextCache();
}

static void fonts_close(App *a)
{
    for (int i = 0; i < FONT_COUNT; i++) {
        if (a->font[i]) TTF_CloseFont(a->font[i]);
        for (int k = 0; k < FALLBACK_COUNT; k++) {
            if (a->fallback[i][k]) TTF_CloseFont(a->fallback[i][k]);
        }
    }
}

static Clay_Dimensions measure_text(Clay_StringSlice text, Clay_TextElementConfig *cfg, void *ud)
{
    App *a = ud;
    TTF_Font *f = a->font[cfg->fontId < FONT_COUNT ? cfg->fontId : 0];
    int w = 0, h = 0;
    if (text.length > 0 && !TTF_GetStringSize(f, text.chars, (size_t)text.length, &w, &h)) {
        app_log("measure falhou: %s", SDL_GetError());
    }
    if (h == 0) h = TTF_GetFontHeight(f);
    return (Clay_Dimensions){(float)w / a->ui_scale, (float)h / a->ui_scale};
}

static void clay_error(Clay_ErrorData e)
{
    app_log("Clay erro %d: %.*s", (int)e.errorType, (int)e.errorText.length, e.errorText.chars);
}

/* ---------- escala ---------- */

static void update_scale(App *a)
{
    float d = SDL_GetWindowPixelDensity(a->win);
    a->density = d > 0.0f ? d : 1.0f;
    if (!a->scale_forced) {
        float s = SDL_GetWindowDisplayScale(a->win);
        a->ui_scale = s > 0.0f ? s : 1.0f;
    }
}

static void update_layout_size(App *a)
{
    int pw = 0, ph = 0;
    if (!SDL_GetWindowSizeInPixels(a->win, &pw, &ph)) app_log("SDL_GetWindowSizeInPixels: %s", SDL_GetError());
    Clay_SetLayoutDimensions((Clay_Dimensions){(float)pw / a->ui_scale, (float)ph / a->ui_scale});
}

static Clay_Vector2 window_to_layout(const App *a, float x, float y)
{
    float k = a->density / a->ui_scale;
    return (Clay_Vector2){x * k, y * k};
}

/* ---------- layout ---------- */

static const Clay_Color C_BG = {24, 26, 31, 255};
static const Clay_Color C_SIDEBAR = {32, 35, 42, 255};
static const Clay_Color C_ITEM_HOVER = {48, 53, 64, 255};
static const Clay_Color C_ITEM_SEL = {46, 92, 160, 255};
static const Clay_Color C_PANEL = {36, 39, 47, 255};
static const Clay_Color C_TEXT = {226, 230, 236, 255};
static const Clay_Color C_MUTED = {150, 158, 170, 255};
static const Clay_Color C_BTN = {52, 120, 220, 255};
static const Clay_Color C_BTN_HOVER = {80, 145, 240, 255};
static const Clay_Color C_FIELD = {20, 22, 27, 255};
static const Clay_Color C_BORDER = {70, 76, 90, 255};
static const Clay_Color C_FOCUS = {90, 160, 255, 255};
static const Clay_Color C_THUMB = {90, 98, 115, 255};

/* Literal (macro): CLAY_STRING exige literal de string. */
#define SAMPLE_TEXT                                                                            \
    "Português: ação, coração, pão, avó, você, à, é, ü — \"Não há sessões ativas.\"\n"         \
    "CJK (fallback msyh.ttc + malgun.ttf): 日本語のテキスト 中文文本 한국어\n"                              \
    "Emoji (fallback seguiemj.ttf): 😀 🚀 ✅ ⚠️ 👍🏽 👨‍👩‍👧\n"                                       \
    "Parágrafo longo para testar a quebra de linha por palavras do Clay quando a largura do " \
    "painel diminui: o orçamento de tokens do agente foi excedido e a sessão foi pausada "    \
    "automaticamente pela política de resiliência."

static Clay_String cstr(const char *s)
{
    return (Clay_String){.isStaticallyAllocated = false, .length = (int32_t)strlen(s), .chars = s};
}

static Clay_RenderCommandArray build_layout(App *a)
{
    Clay_BeginLayout();
    Clay_TextElementConfig *body = CLAY_TEXT_CONFIG({.fontId = FONT_BODY, .textColor = C_TEXT});

    CLAY({.id = CLAY_ID("Root"),
          .layout = {.sizing = {CLAY_SIZING_GROW(0), CLAY_SIZING_GROW(0)}, .layoutDirection = CLAY_LEFT_TO_RIGHT},
          .backgroundColor = C_BG})
    {
        CLAY({.id = CLAY_ID("Sidebar"),
              .layout = {.sizing = {CLAY_SIZING_FIXED(260), CLAY_SIZING_GROW(0)},
                         .layoutDirection = CLAY_TOP_TO_BOTTOM,
                         .padding = {8, 8, 8, 8},
                         .childGap = 6},
              .backgroundColor = C_SIDEBAR})
        {
            CLAY_TEXT(CLAY_STRING("Itens (1.000)"), CLAY_TEXT_CONFIG({.fontId = FONT_TITLE, .textColor = C_TEXT}));
            CLAY({.id = CLAY_ID("List"),
                  .layout = {.sizing = {CLAY_SIZING_GROW(0), CLAY_SIZING_GROW(0)}, .layoutDirection = CLAY_TOP_TO_BOTTOM},
                  .clip = {.vertical = true, .childOffset = Clay_GetScrollOffset()}})
            {
                for (int i = 0; i < ITEM_COUNT; i++) {
                    Clay_Color bg = i == a->selected ? C_ITEM_SEL : (i == a->hover_item ? C_ITEM_HOVER : C_SIDEBAR);
                    CLAY({.id = CLAY_IDI("Item", (uint32_t)i),
                          .layout = {.sizing = {CLAY_SIZING_GROW(0), CLAY_SIZING_FIXED(28)},
                                     .padding = {10, 10, 5, 0},
                                     .childAlignment = {.y = CLAY_ALIGN_Y_CENTER}},
                          .backgroundColor = bg})
                    {
                        CLAY_TEXT(cstr(a->labels[i]), body);
                    }
                }
            }
            /* Barra de rolagem: só visual, calculada a partir dos dados de scroll do Clay. */
            Clay_ScrollContainerData sd = Clay_GetScrollContainerData(Clay_GetElementId(CLAY_STRING("List")));
            if (sd.found && sd.contentDimensions.height > sd.scrollContainerDimensions.height) {
                float view = sd.scrollContainerDimensions.height;
                float content = sd.contentDimensions.height;
                float thumb = fmaxf(24.0f, view * view / content);
                float pos = (-sd.scrollPosition->y / (content - view)) * (view - thumb);
                CLAY({.id = CLAY_ID("Thumb"),
                      .layout = {.sizing = {CLAY_SIZING_FIXED(6), CLAY_SIZING_FIXED(thumb)}},
                      .backgroundColor = C_THUMB,
                      .floating = {.attachTo = CLAY_ATTACH_TO_ELEMENT_WITH_ID,
                                   .parentId = Clay_GetElementId(CLAY_STRING("List")).id,
                                   .attachPoints = {CLAY_ATTACH_POINT_RIGHT_TOP, CLAY_ATTACH_POINT_RIGHT_TOP},
                                   .offset = {-1, pos},
                                   .pointerCaptureMode = CLAY_POINTER_CAPTURE_MODE_PASSTHROUGH}})
                {
                }
            }
        }

        CLAY({.id = CLAY_ID("Main"),
              .layout = {.sizing = {CLAY_SIZING_GROW(0), CLAY_SIZING_GROW(0)},
                         .layoutDirection = CLAY_TOP_TO_BOTTOM,
                         .padding = {16, 16, 16, 16},
                         .childGap = 12}})
        {
            CLAY_TEXT(CLAY_STRING("Spike UI — SDL3 + SDL_ttf + Clay"),
                      CLAY_TEXT_CONFIG({.fontId = FONT_TITLE, .textColor = C_TEXT}));
            CLAY({.id = CLAY_ID("Panel"),
                  .layout = {.sizing = {CLAY_SIZING_GROW(0), CLAY_SIZING_FIT(0)}, .padding = {12, 12, 12, 12}},
                  .backgroundColor = C_PANEL,
                  .border = {.color = C_BORDER, .width = {1, 1, 1, 1, 0}}})
            {
                CLAY_TEXT(CLAY_STRING(SAMPLE_TEXT),
                          CLAY_TEXT_CONFIG({.fontId = FONT_BODY, .textColor = C_TEXT, .lineHeight = 22}));
            }
            CLAY({.id = CLAY_ID("Row"),
                  .layout = {.sizing = {CLAY_SIZING_GROW(0), CLAY_SIZING_FIT(0)},
                             .childGap = 12,
                             .childAlignment = {.y = CLAY_ALIGN_Y_CENTER}}})
            {
                CLAY({.id = CLAY_ID("Button"),
                      .layout = {.padding = {16, 16, 8, 8}},
                      .backgroundColor = a->hover_button ? C_BTN_HOVER : C_BTN})
                {
                    CLAY_TEXT(CLAY_STRING("Clique aqui"), body);
                }
                CLAY_TEXT(cstr(a->status), CLAY_TEXT_CONFIG({.fontId = FONT_BODY, .textColor = C_MUTED}));
            }
            CLAY({.id = CLAY_ID("Field"),
                  .layout = {.sizing = {CLAY_SIZING_GROW(0), CLAY_SIZING_FIXED(36)}},
                  .backgroundColor = C_FIELD,
                  .border = {.color = a->tf.focused ? C_FOCUS : C_BORDER, .width = {1, 1, 1, 1, 0}},
                  .custom = {.customData = &a->tf}})
            {
            }
            CLAY_TEXT(cstr(a->info), CLAY_TEXT_CONFIG({.fontId = FONT_BODY, .textColor = C_MUTED}));
        }
    }
    return Clay_EndLayout();
}

/* ---------- render ---------- */

static void set_color(SDL_Renderer *r, Clay_Color c)
{
    SDL_SetRenderDrawColor(r, (Uint8)c.r, (Uint8)c.g, (Uint8)c.b, (Uint8)c.a);
}

static void draw_text(App *a, TTF_Font *f, const char *s, size_t n, Clay_Color c, float x, float y)
{
    if (n == 0) return;
    TTF_Text *t = TTF_CreateText(a->te, f, s, n);
    if (!t) {
        app_log("TTF_CreateText: %s", SDL_GetError());
        return;
    }
    TTF_SetTextColor(t, (Uint8)c.r, (Uint8)c.g, (Uint8)c.b, (Uint8)c.a);
    if (!TTF_DrawRendererText(t, x, y)) app_log("TTF_DrawRendererText: %s", SDL_GetError());
    TTF_DestroyText(t);
}

static void draw_textfield(App *a, SDL_FRect r)
{
    TextField *tf = &a->tf;
    TTF_Font *f = a->font[FONT_BODY];
    float pad = 8.0f * a->ui_scale;
    tf->rect_px = r;

    char disp[TF_CAP + PRE_CAP];
    size_t n = 0;
    memcpy(disp, tf->buf, tf->cursor);
    n += tf->cursor;
    memcpy(disp + n, tf->pre, tf->pre_len);
    n += tf->pre_len;
    memcpy(disp + n, tf->buf + tf->cursor, tf->len - tf->cursor);
    n += tf->len - tf->cursor;

    float caret = (float)text_width_px(f, disp, tf->cursor + tf->pre_cursor);
    float inner = r.w - 2.0f * pad;
    if (caret - tf->scroll_px > inner) tf->scroll_px = caret - inner;
    if (caret - tf->scroll_px < 0.0f) tf->scroll_px = caret;

    SDL_Rect clip = {(int)r.x + 1, (int)r.y + 1, (int)r.w - 2, (int)r.h - 2};
    SDL_SetRenderClipRect(a->ren, &clip);
    float ty = r.y + (r.h - (float)TTF_GetFontHeight(f)) / 2.0f;
    float tx = r.x + pad - tf->scroll_px;
    if (n == 0 && !tf->focused) {
        static const char ph[] = "Digite aqui (acentos, IME, Ctrl+V)…";
        draw_text(a, f, ph, sizeof ph - 1, C_MUTED, r.x + pad, ty);
    } else {
        draw_text(a, f, disp, n, C_TEXT, tx, ty);
    }
    if (tf->pre_len > 0) { /* sublinhado da composição do IME */
        float x0 = (float)text_width_px(f, disp, tf->cursor);
        float x1 = (float)text_width_px(f, disp, tf->cursor + tf->pre_len);
        SDL_FRect u = {tx + x0, ty + (float)TTF_GetFontHeight(f), x1 - x0, fmaxf(1.0f, a->ui_scale)};
        set_color(a->ren, C_FOCUS);
        SDL_RenderFillRect(a->ren, &u);
    }
    if (tf->focused) { /* cursor fixo: piscar exigiria timer e redesenho 2x/s */
        SDL_FRect c = {tx + caret, ty, fmaxf(1.0f, 1.5f * a->ui_scale), (float)TTF_GetFontHeight(f)};
        set_color(a->ren, C_TEXT);
        SDL_RenderFillRect(a->ren, &c);
    }
    SDL_SetRenderClipRect(a->ren, NULL);

    if (tf->focused) { /* posiciona a janela de candidatos do IME (coordenadas de janela) */
        SDL_Rect area = {(int)(r.x / a->density), (int)(r.y / a->density), (int)(r.w / a->density),
                         (int)(r.h / a->density)};
        int cur = (int)((pad + caret - tf->scroll_px) / a->density);
        if (!SDL_SetTextInputArea(a->win, &area, cur)) app_log("SDL_SetTextInputArea: %s", SDL_GetError());
    }
}

static void render_commands(App *a, Clay_RenderCommandArray *cmds)
{
    float s = a->ui_scale;
    for (int32_t i = 0; i < cmds->length; i++) {
        Clay_RenderCommand *c = Clay_RenderCommandArray_Get(cmds, i);
        Clay_BoundingBox b = c->boundingBox;
        SDL_FRect r = {roundf(b.x * s), roundf(b.y * s), roundf(b.width * s), roundf(b.height * s)};
        switch (c->commandType) {
        case CLAY_RENDER_COMMAND_TYPE_RECTANGLE:
            set_color(a->ren, c->renderData.rectangle.backgroundColor);
            SDL_RenderFillRect(a->ren, &r);
            break;
        case CLAY_RENDER_COMMAND_TYPE_TEXT: {
            Clay_TextRenderData *t = &c->renderData.text;
            TTF_Font *f = a->font[t->fontId < FONT_COUNT ? t->fontId : 0];
            draw_text(a, f, t->stringContents.chars, (size_t)t->stringContents.length, t->textColor, r.x, r.y);
            break;
        }
        case CLAY_RENDER_COMMAND_TYPE_BORDER: {
            Clay_BorderRenderData *d = &c->renderData.border;
            set_color(a->ren, d->color);
            float l = d->width.left * s, rt = d->width.right * s, t = d->width.top * s, bt = d->width.bottom * s;
            SDL_FRect e[4] = {{r.x, r.y, r.w, t}, {r.x, r.y + r.h - bt, r.w, bt}, {r.x, r.y, l, r.h},
                              {r.x + r.w - rt, r.y, rt, r.h}};
            SDL_RenderFillRects(a->ren, e, 4);
            break;
        }
        case CLAY_RENDER_COMMAND_TYPE_SCISSOR_START: {
            SDL_Rect clip = {(int)r.x, (int)r.y, (int)r.w, (int)r.h};
            SDL_SetRenderClipRect(a->ren, &clip);
            break;
        }
        case CLAY_RENDER_COMMAND_TYPE_SCISSOR_END:
            SDL_SetRenderClipRect(a->ren, NULL);
            break;
        case CLAY_RENDER_COMMAND_TYPE_CUSTOM:
            if (c->renderData.custom.customData == &a->tf) {
                set_color(a->ren, c->renderData.custom.backgroundColor);
                SDL_RenderFillRect(a->ren, &r);
                draw_textfield(a, r);
            }
            break;
        default:
            break;
        }
    }
}

static void save_shot(App *a, const char *path)
{
    SDL_Surface *s = SDL_RenderReadPixels(a->ren, NULL);
    if (!s) {
        app_log("SDL_RenderReadPixels: %s", SDL_GetError());
        return;
    }
    if (!SDL_SavePNG(s, path)) app_log("SDL_SavePNG(%s): %s", path, SDL_GetError());
    else app_log("captura salva: %s (%dx%d)", path, s->w, s->h);
    SDL_DestroySurface(s);
}

static void update_texts(App *a)
{
    const char *sel = a->selected >= 0 ? a->labels[a->selected] : "nenhum";
    int n = snprintf(a->status, sizeof a->status, "Cliques: %d | Selecionado: %s%s%s", a->clicks, sel,
                     a->submitted[0] ? " | Enviado: " : "", a->submitted);
    if (n < 0 || (size_t)n >= sizeof a->status) a->status[sizeof a->status - 1] = '\0';
    n = snprintf(a->info, sizeof a->info, "renderer=%s  ui_scale=%.2f%s  density=%.2f  quadros=%llu",
                 SDL_GetRendererName(a->ren), (double)a->ui_scale, a->scale_forced ? " (forçado)" : "",
                 (double)a->density, (unsigned long long)a->frames + 1);
    if (n < 0 || (size_t)n >= sizeof a->info) a->info[sizeof a->info - 1] = '\0';
}

static void redraw(App *a, const char *why)
{
    Uint64 t0 = SDL_GetPerformanceCounter();
    update_texts(a);
    Clay_RenderCommandArray cmds = build_layout(a);
    Uint64 t1 = SDL_GetPerformanceCounter();
    set_color(a->ren, C_BG);
    SDL_RenderClear(a->ren);
    render_commands(a, &cmds);
    Uint64 t2 = SDL_GetPerformanceCounter();
    if (a->shot_path[0]) {
        save_shot(a, a->shot_path);
        a->shot_path[0] = '\0';
    }
    SDL_RenderPresent(a->ren);
    double f = 1000.0 / (double)SDL_GetPerformanceFrequency();
    double lm = (double)(t1 - t0) * f, rm = (double)(t2 - t1) * f;
    a->frames++;
    a->layout_ms_sum += lm;
    a->render_ms_sum += rm;
    if (lm > a->layout_ms_max) a->layout_ms_max = lm;
    if (rm > a->render_ms_max) a->render_ms_max = rm;
    if (a->framelog) app_log("quadro %llu (%s) layout=%.2fms render=%.2fms cmds=%d", (unsigned long long)a->frames,
                             why, lm, rm, (int)cmds.length);
}

/* ---------- interação ---------- */

static void set_focus(App *a, bool on)
{
    if (a->tf.focused == on) return;
    a->tf.focused = on;
    if (on) {
        if (!SDL_StartTextInput(a->win)) app_log("SDL_StartTextInput: %s", SDL_GetError());
    } else {
        if (!SDL_StopTextInput(a->win)) app_log("SDL_StopTextInput: %s", SDL_GetError());
        a->tf.pre_len = 0;
        a->tf.pre_cursor = 0;
    }
    a->dirty = true;
}

/* Recalcula hover a partir dos ids sob o ponteiro; só marca sujo se algo mudou. */
static void update_hover(App *a)
{
    Clay_ElementIdArray ids = Clay_GetPointerOverIds();
    int item = -1;
    bool btn = false, field = false;
    for (int32_t i = 0; i < ids.length; i++) {
        uint32_t id = ids.internalArray[i].id; /* Clay_ElementIdArray_Get só existe na TU de implementação */
        if (id == a->id_button) btn = true;
        else if (id == a->id_field) field = true;
        else if (item < 0) {
            for (int k = 0; k < ITEM_COUNT; k++) {
                if (a->item_ids[k] == id) {
                    item = k;
                    break;
                }
            }
        }
    }
    if (item != a->hover_item || btn != a->hover_button || field != a->hover_field) {
        a->hover_item = item;
        a->hover_button = btn;
        a->hover_field = field;
        a->dirty = true;
    }
}

static void pointer_move(App *a, Clay_Vector2 p, bool down)
{
    a->mouse_l = p;
    Clay_SetPointerState(p, down);
    update_hover(a);
}

static void tf_click(App *a, float x_l)
{
    TextField *tf = &a->tf;
    TTF_Font *f = a->font[FONT_BODY];
    float target = x_l * a->ui_scale - (tf->rect_px.x + 8.0f * a->ui_scale) + tf->scroll_px;
    size_t best = 0;
    float best_d = 1e9f;
    for (size_t i = 0;; i = utf8_next(tf->buf, tf->len, i)) {
        float d = fabsf((float)text_width_px(f, tf->buf, i) - target);
        if (d < best_d) {
            best_d = d;
            best = i;
        }
        if (i >= tf->len) break;
    }
    tf->cursor = best;
}

static void click(App *a, Clay_Vector2 p)
{
    pointer_move(a, p, true);
    if (a->hover_button) {
        a->clicks++;
        app_log("botão clicado (total=%d)", a->clicks);
        a->dirty = true;
    }
    if (a->hover_item >= 0) {
        a->selected = a->hover_item;
        app_log("item selecionado: %d", a->selected);
        a->dirty = true;
    }
    if (a->hover_field) {
        set_focus(a, true);
        tf_click(a, p.x);
        a->dirty = true;
    } else {
        set_focus(a, false);
    }
    pointer_move(a, p, false);
}

static void wheel(App *a, Clay_Vector2 p, float dy)
{
    pointer_move(a, p, false);
    Clay_UpdateScrollContainers(false, (Clay_Vector2){0, dy * 4.0f}, 0.0f);
    a->dirty = true;
}

static void key_down(App *a, const SDL_KeyboardEvent *k)
{
    if (k->key == SDLK_F12) {
        snprintf(a->shot_path, sizeof a->shot_path, "shot_f12_%llu.png", (unsigned long long)a->frames);
        a->dirty = true;
        return;
    }
    TextField *tf = &a->tf;
    if (!tf->focused || tf->pre_len > 0) return; /* durante composição, o IME consome as teclas */
    bool ctrl = (k->mod & SDL_KMOD_CTRL) != 0;
    switch (k->key) {
    case SDLK_BACKSPACE: tf_erase(tf, utf8_prev(tf->buf, tf->cursor), tf->cursor); break;
    case SDLK_DELETE: tf_erase(tf, tf->cursor, utf8_next(tf->buf, tf->len, tf->cursor)); break;
    case SDLK_LEFT: tf->cursor = utf8_prev(tf->buf, tf->cursor); break;
    case SDLK_RIGHT: tf->cursor = utf8_next(tf->buf, tf->len, tf->cursor); break;
    case SDLK_HOME: tf->cursor = 0; break;
    case SDLK_END: tf->cursor = tf->len; break;
    case SDLK_ESCAPE: set_focus(a, false); break;
    case SDLK_RETURN:
    case SDLK_KP_ENTER:
        memcpy(a->submitted, tf->buf, tf->len + 1);
        app_log("campo enviado: \"%s\" (%zu bytes)", a->submitted, tf->len);
        break;
    case SDLK_V:
        if (ctrl) {
            char *clip = SDL_GetClipboardText();
            if (clip) {
                for (char *c = clip; *c; c++) {
                    if (*c == '\n' || *c == '\r' || *c == '\t') *c = ' ';
                }
                if (!tf_insert(tf, clip, strlen(clip))) app_log("colagem truncada no limite de %d bytes", TF_CAP - 1);
                SDL_free(clip);
            }
        }
        break;
    default: return;
    }
    a->dirty = true;
}

/* ---------- tray ---------- */

static void show_window(App *a)
{
    if (!SDL_ShowWindow(a->win)) app_log("SDL_ShowWindow: %s", SDL_GetError());
    if (!SDL_RestoreWindow(a->win)) app_log("SDL_RestoreWindow: %s", SDL_GetError());
    if (!SDL_RaiseWindow(a->win)) app_log("SDL_RaiseWindow: %s", SDL_GetError());
    a->dirty = true;
}

static void SDLCALL on_tray_open(void *ud, SDL_TrayEntry *e)
{
    (void)e;
    App *a = ud;
    app_log("tray: Abrir");
    show_window(a);
}

static void SDLCALL on_tray_quit(void *ud, SDL_TrayEntry *e)
{
    (void)e;
    (void)ud;
    app_log("tray: Sair");
    SDL_Event q;
    SDL_zero(q);
    q.type = SDL_EVENT_QUIT;
    if (!SDL_PushEvent(&q)) app_log("SDL_PushEvent: %s", SDL_GetError());
}

static SDL_Surface *make_icon(void)
{
    SDL_Surface *s = SDL_CreateSurface(32, 32, SDL_PIXELFORMAT_ARGB8888);
    if (!s) return NULL;
    const SDL_PixelFormatDetails *fmt = SDL_GetPixelFormatDetails(s->format);
    SDL_Rect outer = {0, 0, 32, 32}, inner = {8, 8, 16, 16};
    SDL_FillSurfaceRect(s, &outer, SDL_MapRGBA(fmt, NULL, 52, 120, 220, 255));
    SDL_FillSurfaceRect(s, &inner, SDL_MapRGBA(fmt, NULL, 255, 255, 255, 255));
    return s;
}

static bool tray_create(App *a)
{
    a->tray = SDL_CreateTray(a->icon, "Agents Hub (spike UI)");
    if (!a->tray) {
        app_log("SDL_CreateTray: %s", SDL_GetError());
        return false;
    }
    SDL_TrayMenu *m = SDL_CreateTrayMenu(a->tray);
    if (!m) {
        app_log("SDL_CreateTrayMenu: %s", SDL_GetError());
        return false;
    }
    a->e_open = SDL_InsertTrayEntryAt(m, -1, "Abrir", SDL_TRAYENTRY_BUTTON);
    a->e_quit = SDL_InsertTrayEntryAt(m, -1, "Sair", SDL_TRAYENTRY_BUTTON);
    if (!a->e_open || !a->e_quit) {
        app_log("SDL_InsertTrayEntryAt: %s", SDL_GetError());
        return false;
    }
    SDL_SetTrayEntryCallback(a->e_open, on_tray_open, a);
    SDL_SetTrayEntryCallback(a->e_quit, on_tray_quit, a);
    return true;
}

/* ---------- roteiro automático ---------- */

static Uint32 SDLCALL autotest_timer(void *ud, SDL_TimerID id, Uint32 interval)
{
    (void)id;
    App *a = ud;
    SDL_Event e;
    SDL_zero(e);
    e.type = a->autotest_event;
    SDL_PushEvent(&e);
    return interval;
}

static Clay_Vector2 center_of(const char *id_str)
{
    Clay_ElementData d = Clay_GetElementData(Clay_GetElementId(cstr(id_str)));
    return (Clay_Vector2){d.boundingBox.x + d.boundingBox.width / 2, d.boundingBox.y + d.boundingBox.height / 2};
}

static void check(App *a, bool ok, const char *what)
{
    app_log("AUTOTEST %s: %s", ok ? "OK  " : "FALHA", what);
    if (!ok) a->autotest_fail++;
}

static void autotest_step(App *a)
{
    int s = a->autotest_step++;
    switch (s) {
    case 0: snprintf(a->shot_path, sizeof a->shot_path, "shot_1_inicial.png"); a->dirty = true; break;
    case 1: {
        Clay_ScrollContainerData sd = Clay_GetScrollContainerData(Clay_GetElementId(CLAY_STRING("List")));
        float before = sd.found ? sd.scrollPosition->y : 1.0f;
        wheel(a, center_of("List"), -1000.0f); /* 4000 L para baixo */
        redraw(a, "autotest-wheel");
        a->dirty = false;
        sd = Clay_GetScrollContainerData(Clay_GetElementId(CLAY_STRING("List")));
        check(a, sd.found && sd.scrollPosition->y < before - 3000.0f, "rolagem da lista com roda");
        app_log("scroll y: %.1f -> %.1f (conteúdo %.0f)", (double)before, sd.found ? (double)sd.scrollPosition->y : 0.0,
                sd.found ? (double)sd.contentDimensions.height : 0.0);
        break;
    }
    case 2: {
        Clay_Vector2 p = center_of("List");
        click(a, p);
        check(a, a->selected > 100, "clique seleciona item visível após rolagem");
        int before = a->clicks;
        click(a, center_of("Button"));
        check(a, a->clicks == before + 1, "clique no botão");
        click(a, center_of("Field"));
        check(a, a->tf.focused && SDL_TextInputActive(a->win), "foco no campo liga SDL_StartTextInput");
        static const char typed[] = "ação 日本語 😀";
        tf_insert(&a->tf, typed, sizeof typed - 1);
        check(a, strcmp(a->tf.buf, typed) == 0, "inserção UTF-8 no campo");
        SDL_KeyboardEvent k;
        SDL_zero(k);
        k.key = SDLK_BACKSPACE;
        key_down(a, &k); /* remove o emoji (4 bytes, 1 code point) */
        check(a, strcmp(a->tf.buf, "ação 日本語 ") == 0, "backspace remove 1 code point");
        tf_insert(&a->tf, "😀", strlen("😀"));
        snprintf(a->shot_path, sizeof a->shot_path, "shot_2_interacao.png");
        a->dirty = true;
        break;
    }
    case 3: {
        SDL_Event e;
        SDL_zero(e);
        e.type = SDL_EVENT_WINDOW_CLOSE_REQUESTED;
        e.window.windowID = SDL_GetWindowID(a->win);
        SDL_PushEvent(&e);
        break;
    }
    case 4:
        check(a, (SDL_GetWindowFlags(a->win) & SDL_WINDOW_HIDDEN) != 0, "fechar janela esconde (processo segue)");
        SDL_ClickTrayEntry(a->e_open);
        break;
    case 5:
        check(a, (SDL_GetWindowFlags(a->win) & SDL_WINDOW_HIDDEN) == 0, "tray Abrir restaura a janela");
        app_log("AUTOTEST fim: %d falha(s)", a->autotest_fail);
        SDL_ClickTrayEntry(a->e_quit);
        break;
    default: break;
    }
}

/* ---------- eventos ---------- */

static void handle_event(App *a, const SDL_Event *e)
{
    switch (e->type) {
    case SDL_EVENT_QUIT: a->quit = true; break;
    case SDL_EVENT_WINDOW_CLOSE_REQUESTED:
        /* Fechar esconde: o processo continua na bandeja. */
        set_focus(a, false);
        if (!SDL_HideWindow(a->win)) app_log("SDL_HideWindow: %s", SDL_GetError());
        app_log("janela escondida (bandeja)");
        break;
    case SDL_EVENT_WINDOW_EXPOSED: a->dirty = true; break;
    case SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED:
    case SDL_EVENT_WINDOW_RESIZED:
        update_layout_size(a);
        a->dirty = true;
        break;
    case SDL_EVENT_WINDOW_DISPLAY_SCALE_CHANGED: {
        float old = a->ui_scale;
        update_scale(a);
        app_log("escala mudou: %.2f -> %.2f (density %.2f)", (double)old, (double)a->ui_scale, (double)a->density);
        fonts_rescale(a);
        update_layout_size(a);
        a->dirty = true;
        break;
    }
    case SDL_EVENT_MOUSE_MOTION:
        pointer_move(a, window_to_layout(a, e->motion.x, e->motion.y), (e->motion.state & SDL_BUTTON_LMASK) != 0);
        break;
    case SDL_EVENT_WINDOW_MOUSE_LEAVE:
        pointer_move(a, (Clay_Vector2){-1, -1}, false);
        break;
    case SDL_EVENT_MOUSE_BUTTON_DOWN:
        if (e->button.button == SDL_BUTTON_LEFT) click(a, window_to_layout(a, e->button.x, e->button.y));
        break;
    case SDL_EVENT_MOUSE_WHEEL:
        wheel(a, window_to_layout(a, e->wheel.mouse_x, e->wheel.mouse_y), e->wheel.y);
        break;
    case SDL_EVENT_KEY_DOWN: key_down(a, &e->key); break;
    case SDL_EVENT_TEXT_INPUT:
        if (a->tf.focused) {
            if (!tf_insert(&a->tf, e->text.text, strlen(e->text.text))) app_log("texto truncado no limite");
            a->tf.pre_len = 0;
            a->tf.pre_cursor = 0;
            app_log("TEXT_INPUT: \"%s\"", e->text.text);
            a->dirty = true;
        }
        break;
    case SDL_EVENT_TEXT_EDITING:
        if (a->tf.focused) {
            size_t n = utf8_clip(e->edit.text, strlen(e->edit.text), PRE_CAP - 1);
            memcpy(a->tf.pre, e->edit.text, n);
            a->tf.pre[n] = '\0';
            a->tf.pre_len = n;
            a->tf.pre_cursor = e->edit.start < 0 ? n : utf8_cp_to_byte(a->tf.pre, n, e->edit.start);
            app_log("TEXT_EDITING: \"%s\" start=%d", a->tf.pre, (int)e->edit.start);
            a->dirty = true;
        }
        break;
    case SDL_EVENT_RENDER_TARGETS_RESET:
    case SDL_EVENT_RENDER_DEVICE_RESET: a->dirty = true; break;
    default:
        if (a->autotest && e->type == a->autotest_event) autotest_step(a);
        break;
    }
}

static bool window_visible(App *a)
{
    SDL_WindowFlags f = SDL_GetWindowFlags(a->win);
    return (f & (SDL_WINDOW_HIDDEN | SDL_WINDOW_MINIMIZED)) == 0;
}

int main(int argc, char **argv)
{
    (void)argc;
    (void)argv;
    static App app; /* ~60 KB: fora da pilha */
    App *a = &app;
    a->selected = -1;
    a->hover_item = -1;
    int rc = 1;
    void *clay_mem = NULL;

    const char *env = SDL_getenv("SPIKE_SCALE");
    if (env) {
        char *end = NULL;
        double v = SDL_strtod(env, &end);
        if (end != env && v >= 0.5 && v <= 4.0) {
            a->ui_scale = (float)v;
            a->scale_forced = true;
        }
    }
    a->framelog = SDL_getenv("SPIKE_FRAMELOG") != NULL;
    a->autotest = SDL_getenv("SPIKE_AUTOTEST") != NULL;
    env = SDL_getenv("SPIKE_SHOT");
    if (env) snprintf(a->shot_path, sizeof a->shot_path, "%s", env);

    /* A bandeja mantém o processo vivo sem janela visível. */
    SDL_SetHint(SDL_HINT_QUIT_ON_LAST_WINDOW_CLOSE, "0");
    SDL_SetHint(SDL_HINT_IME_IMPLEMENTED_UI, "composition"); /* o app desenha a composição inline */

    if (!SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS)) {
        app_log("SDL_Init: %s", SDL_GetError());
        return 1;
    }
    if (!TTF_Init()) {
        app_log("TTF_Init: %s", SDL_GetError());
        goto out_sdl;
    }
    int hb_maj = 0, hb_min = 0, hb_pat = 0, ft_maj = 0, ft_min = 0, ft_pat = 0;
    TTF_GetHarfBuzzVersion(&hb_maj, &hb_min, &hb_pat);
    TTF_GetFreeTypeVersion(&ft_maj, &ft_min, &ft_pat);
    int sv = SDL_GetVersion();
    app_log("SDL %d.%d.%d | SDL_ttf %d.%d.%d | FreeType %d.%d.%d | HarfBuzz %d.%d.%d", SDL_VERSIONNUM_MAJOR(sv),
            SDL_VERSIONNUM_MINOR(sv), SDL_VERSIONNUM_MICRO(sv), SDL_TTF_MAJOR_VERSION, SDL_TTF_MINOR_VERSION,
            SDL_TTF_MICRO_VERSION, ft_maj, ft_min, ft_pat, hb_maj, hb_min, hb_pat);

    a->win = SDL_CreateWindow("Agents Hub — spike UI", 1000, 680, SDL_WINDOW_RESIZABLE | SDL_WINDOW_HIGH_PIXEL_DENSITY);
    if (!a->win) {
        app_log("SDL_CreateWindow: %s", SDL_GetError());
        goto out_ttf;
    }
    a->ren = SDL_CreateRenderer(a->win, NULL);
    if (!a->ren) {
        app_log("SDL_CreateRenderer: %s", SDL_GetError());
        goto out_win;
    }
    if (!SDL_SetRenderVSync(a->ren, 1)) app_log("SDL_SetRenderVSync: %s", SDL_GetError());
    update_scale(a);
    if (a->ui_scale != 1.0f) {
        if (!SDL_SetWindowSize(a->win, (int)(1000 * a->ui_scale / a->density), (int)(680 * a->ui_scale / a->density))) {
            app_log("SDL_SetWindowSize: %s", SDL_GetError());
        }
    }
    app_log("renderer=%s display_scale=%.2f pixel_density=%.2f ui_scale=%.2f%s", SDL_GetRendererName(a->ren),
            (double)SDL_GetWindowDisplayScale(a->win), (double)a->density, (double)a->ui_scale,
            a->scale_forced ? " (forçado por SPIKE_SCALE)" : "");

    a->te = TTF_CreateRendererTextEngine(a->ren);
    if (!a->te) {
        app_log("TTF_CreateRendererTextEngine: %s", SDL_GetError());
        goto out_ren;
    }
    if (!fonts_open(a)) goto out_fonts;

    a->icon = make_icon();
    if (!a->icon) {
        app_log("make_icon: %s", SDL_GetError());
        goto out_fonts;
    }
    if (!SDL_SetWindowIcon(a->win, a->icon)) app_log("SDL_SetWindowIcon: %s", SDL_GetError());
    if (!tray_create(a)) goto out_tray;

    uint32_t mem_size = Clay_MinMemorySize();
    clay_mem = SDL_malloc(mem_size);
    if (!clay_mem) {
        app_log("sem memória para o Clay (%u bytes)", mem_size);
        goto out_tray;
    }
    app_log("Clay arena: %u bytes", mem_size);
    Clay_Initialize(Clay_CreateArenaWithCapacityAndMemory(mem_size, clay_mem), (Clay_Dimensions){1000, 680},
                    (Clay_ErrorHandler){.errorHandlerFunction = clay_error});
    Clay_SetMeasureTextFunction(measure_text, a);
    update_layout_size(a);

    for (int i = 0; i < ITEM_COUNT; i++) {
        snprintf(a->labels[i], ITEM_LABEL_CAP, "Sessão %04d — agente %s", i + 1,
                 (i % 3 == 0) ? "claude" : (i % 3 == 1) ? "codex" : "gemini");
        a->item_ids[i] = Clay_GetElementIdWithIndex(CLAY_STRING("Item"), (uint32_t)i).id;
    }
    a->id_list = Clay_GetElementId(CLAY_STRING("List")).id;
    a->id_button = Clay_GetElementId(CLAY_STRING("Button")).id;
    a->id_field = Clay_GetElementId(CLAY_STRING("Field")).id;

    SDL_TimerID timer = 0;
    if (a->autotest) {
        a->autotest_event = SDL_RegisterEvents(1);
        timer = SDL_AddTimer(700, autotest_timer, a);
        if (!a->autotest_event || !timer) { /* sem timer o roteiro não roda: falha explícita, não "passa" */
            app_log("autotest: falha ao registrar evento/timer: %s", SDL_GetError());
            if (timer) SDL_RemoveTimer(timer);
            rc = 3;
            goto out_tray;
        }
    }

    /* Primeiro quadro duplo: Clay calcula scroll e hit-test a partir do quadro anterior. */
    redraw(a, "inicial");
    a->dirty = true;
    if (SDL_getenv("SPIKE_FOCUS")) set_focus(a, true); /* teste de entrada via WM_CHAR sem mouse */

    env = SDL_getenv("SPIKE_STRESS"); /* N quadros rolando a lista: checa crescimento de memória */
    if (env) {
        long n = SDL_strtol(env, NULL, 10);
        Uint64 t0 = SDL_GetTicks();
        for (long i = 0; i < n && n <= 100000; i++) {
            wheel(a, (Clay_Vector2){100, 300}, (i / 50) % 2 ? 3.0f : -3.0f);
            Clay_UpdateScrollContainers(false, (Clay_Vector2){0, 0}, 0.0f);
            redraw(a, "stress");
        }
        a->dirty = false;
        app_log("stress: %ld quadros em %llu ms", n, (unsigned long long)(SDL_GetTicks() - t0));
    }

    while (!a->quit) {
        if (a->dirty && window_visible(a)) {
            Clay_UpdateScrollContainers(false, (Clay_Vector2){0, 0}, 0.0f);
            redraw(a, "evento");
            a->dirty = false;
        }
        SDL_Event e;
        if (!SDL_WaitEvent(&e)) { /* bloqueia: CPU ~0 sem eventos */
            app_log("SDL_WaitEvent: %s", SDL_GetError());
            break;
        }
        handle_event(a, &e);
        while (!a->quit && SDL_PollEvent(&e)) handle_event(a, &e); /* drena a fila antes de redesenhar */
    }

    if (timer) SDL_RemoveTimer(timer);
    app_log("saindo: quadros=%llu layout(média/máx)=%.2f/%.2f ms render(média/máx)=%.2f/%.2f ms",
            (unsigned long long)a->frames, a->frames ? a->layout_ms_sum / (double)a->frames : 0.0, a->layout_ms_max,
            a->frames ? a->render_ms_sum / (double)a->frames : 0.0, a->render_ms_max);
    rc = a->autotest_fail ? 2 : 0;

out_tray:
    if (a->tray) SDL_DestroyTray(a->tray);
    SDL_DestroySurface(a->icon);
out_fonts:
    fonts_close(a);
    TTF_DestroyRendererTextEngine(a->te);
out_ren:
    SDL_DestroyRenderer(a->ren);
out_win:
    SDL_DestroyWindow(a->win);
out_ttf:
    TTF_Quit();
out_sdl:
    SDL_Quit();
    SDL_free(clay_mem);
    return rc;
}
