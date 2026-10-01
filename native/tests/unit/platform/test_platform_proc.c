/* Testes da área de processos (F0-07, plano docs/17; SPEC-04 B4/B5;
 * SPEC-08 P1-P4, SEC-R26, SEC-R27, SEC-R28). Usa só o executável auxiliar
 * proc_helper (nenhum agente real).
 *
 * As poucas chamadas de SO deste arquivo (criar um handle herdável de
 * propósito, ler variável de ambiente, criar o .cmd de teste) existem só
 * para montar o cenário; o que se testa passa todo por ah_platform_proc.h. */
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#else
#define _POSIX_C_SOURCE 200809L
#include <fcntl.h>
#include <unistd.h>
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ah_platform_proc.h"
#include "ah_test.h"

#define HELPER AH_TEST_PROC_HELPER
#define WORK AH_TEST_PROC_WORK
#define IO_TIMEOUT_MS 20000

/* --- utilitários de cenário --- */

typedef struct run_result {
    char *out;
    size_t out_len;
    char *err;
    size_t err_len;
    ah_proc_exit st;
} run_result;

static void run_free(run_result *r) {
    free(r->out);
    free(r->err);
    memset(r, 0, sizeof *r);
}

static int append(char **buf, size_t *len, const char *data, size_t n) {
    char *nb = realloc(*buf, *len + n + 1);
    if (nb == NULL) {
        return -1;
    }
    memcpy(nb + *len, data, n);
    *len += n;
    nb[*len] = '\0';
    *buf = nb;
    return 0;
}

/* Lê o que houver de um fluxo até AGAIN/EOF. Devolve -1 em erro. */
static int drain(ah_proc *p, ah_proc_stream s, char **buf, size_t *len,
                 int *eof) {
    char tmp[4096];
    for (;;) {
        size_t n = 0;
        ah_proc_io io;
        if (ah_proc_read(p, s, tmp, sizeof tmp, &n, &io) != AH_OK) {
            return -1;
        }
        if (io == AH_PROC_IO_EOF) {
            *eof = 1;
            return 0;
        }
        if (io == AH_PROC_IO_AGAIN) {
            return 0;
        }
        if (append(buf, len, tmp, n) != 0) {
            return -1;
        }
    }
}

/* Voltas do laço de run() na última execução (mede giro em falso). */
static unsigned long g_run_iterations = 0;

/* Roda até o fim: escreve `in` no stdin (e fecha), coleta stdout/stderr
 * pelo contrato não bloqueante e espera o código de saída. */
static ah_status run(const ah_proc_spawn_opts *o, const char *in,
                     size_t in_len, run_result *r) {
    g_run_iterations = 0;
    memset(r, 0, sizeof *r);
    char detail[256];
    ah_proc *p = NULL;
    ah_status st = ah_proc_spawn(o, &p, detail, sizeof detail);
    if (st != AH_OK) {
        fprintf(stderr, "spawn falhou (%d): %s\n", (int)st, detail);
        return st;
    }
    size_t sent = 0;
    int stdin_open = 1;
    int out_eof = 0;
    int err_eof = 0;
    if (append(&r->out, &r->out_len, "", 0) != 0 ||
        append(&r->err, &r->err_len, "", 0) != 0) {
        st = AH_ERR_NOMEM;
    }
    while (st == AH_OK && (stdin_open || !out_eof || !err_eof)) {
        g_run_iterations++;
        unsigned mask = 0;
        if (stdin_open) {
            size_t acc = 0;
            ah_proc_io io;
            const char *rest = in != NULL ? in + sent : NULL;
            st = ah_proc_write(p, rest, in_len - sent, &acc, &io);
            if (st != AH_OK) {
                break;
            }
            sent += acc;
            if (sent == in_len && io == AH_PROC_IO_DATA) {
                /* tudo aceito: fecha quando não houver escrita em curso */
                st = ah_proc_write(p, NULL, 0, &acc, &io);
                if (st == AH_OK && io == AH_PROC_IO_DATA) {
                    st = ah_proc_close_stdin(p);
                    stdin_open = 0;
                }
            }
            if (stdin_open) {
                mask |= AH_PROC_MASK_STDIN;
            }
        }
        if (st != AH_OK) {
            break;
        }
        if (drain(p, AH_PROC_STDOUT, &r->out, &r->out_len, &out_eof) != 0 ||
            drain(p, AH_PROC_STDERR, &r->err, &r->err_len, &err_eof) != 0) {
            st = AH_ERR_IO;
            break;
        }
        if (!out_eof) {
            mask |= AH_PROC_MASK_STDOUT;
        }
        if (!err_eof) {
            mask |= AH_PROC_MASK_STDERR;
        }
        if (mask == 0) {
            break;
        }
        unsigned ready = 0;
        st = ah_proc_wait_io(p, mask, IO_TIMEOUT_MS, &ready);
        if (st == AH_OK && ready == 0) {
            fprintf(stderr, "timeout esperando E/S do helper\n");
            st = AH_ERR_IO;
        }
    }
    if (st != AH_OK) {
        ah_proc_kill(p);
    }
    bool exited = false;
    ah_status ws = ah_proc_wait(p, true, &exited, &r->st);
    if (st == AH_OK && (ws != AH_OK || !exited)) {
        st = AH_ERR_IO;
    }
    ah_proc_free(p);
    return st;
}

static void opts_init(ah_proc_spawn_opts *o, const char *const *args,
                      size_t n) {
    memset(o, 0, sizeof *o);
    o->path = HELPER;
    o->args = args;
    o->arg_count = n;
}

static int hexval(char c) {
    if (c >= '0' && c <= '9') {
        return c - '0';
    }
    if (c >= 'a' && c <= 'f') {
        return c - 'a' + 10;
    }
    return -1;
}

/* Decodifica `hex` (até o fim da linha) em `dst` (com NUL). */
static int unhex(const char *hex, char *dst, size_t cap, size_t *len) {
    size_t n = 0;
    while (hex[0] != '\0' && hex[0] != '\n' && hex[0] != '\r') {
        int hi = hexval(hex[0]);
        int lo = hexval(hex[1]);
        if (hi < 0 || lo < 0 || n + 1 >= cap) {
            return -1;
        }
        dst[n++] = (char)(hi * 16 + lo);
        hex += 2;
    }
    dst[n] = '\0';
    *len = n;
    return 0;
}

/* Confere a saída do modo `argv` contra `expected`. */
static int argv_matches(const char *out, const char *const *expected,
                        size_t n) {
    char line[65536];
    size_t len;
    const char *q = strstr(out, "n=");
    if (q == NULL || strtol(q + 2, NULL, 10) != (long)n) {
        fprintf(stderr, "contagem de argv diferente; saída: %s\n", out);
        return 0;
    }
    for (size_t i = 0; i < n; i++) {
        q = strstr(q, "\na=");
        if (q == NULL || unhex(q + 3, line, sizeof line, &len) != 0) {
            return 0;
        }
        if (len != strlen(expected[i]) || memcmp(line, expected[i], len) != 0) {
            fprintf(stderr, "argv[%zu] diferente: recebido [%s] esperado [%s]\n",
                    i, line, expected[i]);
            return 0;
        }
        q += 3;
    }
    return 1;
}

static int file_exists(const char *path) {
    FILE *f = NULL;
#ifdef _WIN32
    if (fopen_s(&f, path, "rb") != 0) {
        f = NULL;
    }
#else
    f = fopen(path, "rb");
#endif
    if (f == NULL) {
        return 0;
    }
    fclose(f);
    return 1;
}

static int write_file(const char *path, const char *text) {
    FILE *f = NULL;
#ifdef _WIN32
    if (fopen_s(&f, path, "wb") != 0) {
        f = NULL;
    }
#else
    f = fopen(path, "wb");
#endif
    if (f == NULL) {
        return -1;
    }
    size_t n = strlen(text);
    int ok = fwrite(text, 1, n, f) == n;
    return (fclose(f) == 0 && ok) ? 0 : -1;
}

/* Variável de ambiente do processo de teste, em UTF-8 (NULL se ausente). */
static int test_getenv(const char *name, char *buf, size_t cap) {
#ifdef _WIN32
    wchar_t wname[128];
    wchar_t wval[32768];
    if (MultiByteToWideChar(CP_UTF8, 0, name, -1, wname, 128) <= 0) {
        return 0;
    }
    DWORD k = GetEnvironmentVariableW(wname, wval, 32768);
    if (k == 0 || k >= 32768) {
        return 0;
    }
    return WideCharToMultiByte(CP_UTF8, 0, wval, -1, buf, (int)cap, NULL,
                               NULL) > 0;
#else
    const char *v = getenv(name);
    if (v == NULL || strlen(v) + 1 > cap) {
        return 0;
    }
    memcpy(buf, v, strlen(v) + 1);
    return 1;
#endif
}

/* Caminho no formato nativo (barras invertidas no Windows). */
static void native_path(char *s) {
#ifdef _WIN32
    for (; *s != '\0'; s++) {
        if (*s == '/') {
            *s = '\\';
        }
    }
#else
    (void)s;
#endif
}

/* --- testes puros de montagem de linha --- */

static void check_cmdline(const char *arg, const char *expected_arg) {
    const char *args[1] = {arg};
    char *out = NULL;
    CHECK(ah_proc_win_command_line("C:\\p.exe", args, NULL, 1, &out) ==
          AH_OK);
    char expected[512];
    snprintf(expected, sizeof expected, "\"C:\\p.exe\" %s", expected_arg);
    CHECK(out != NULL && strcmp(out, expected) == 0);
    free(out);
}

static void test_command_line_vectors(void) {
    /* Casos de packages/adapters/src/bin-resolver.test.ts (quoteForShell),
     * que é a mesma regra do libuv. */
    check_cmdline("C:\\bin\\codex.exe", "C:\\bin\\codex.exe");
    check_cmdline("C:\\Program Files\\nodejs\\node.exe",
                  "\"C:\\Program Files\\nodejs\\node.exe\"");
    check_cmdline("diz \"oi\"", "\"diz \\\"oi\\\"\"");
    check_cmdline("a\\\"b", "\"a\\\\\\\"b\"");
    check_cmdline("C:\\a dir\\", "\"C:\\a dir\\\\\"");
    check_cmdline("", "\"\"");

    /* NUL embutido é recusado (P3), não truncado. */
    const char nul_arg[] = {'a', '\0', 'b'};
    const char *args[1] = {nul_arg};
    size_t lens[1] = {3};
    char *out = NULL;
    CHECK(ah_proc_win_command_line("C:\\p.exe", args, lens, 1, &out) ==
          AH_ERR_INVALID);
    CHECK(out == NULL);

    /* UTF-8 inválido recusado. */
    const char *bad[1] = {"\xc3\x28"};
    CHECK(ah_proc_win_command_line("C:\\p.exe", bad, NULL, 1, &out) ==
          AH_ERR_INVALID);

    /* Teto de 32.767 unidades UTF-16. */
    size_t big = AH_PROC_WIN_MAX_CMDLINE;
    char *huge = malloc(big + 1);
    CHECK(huge != NULL);
    if (huge != NULL) {
        memset(huge, 'a', big);
        huge[big] = '\0';
        const char *h[1] = {huge};
        CHECK(ah_proc_win_command_line("C:\\p.exe", h, NULL, 1, &out) ==
              AH_ERR_LIMIT);
        /* B1: o teto de 32.767 conta o NUL. "C:\p.exe" entre aspas (10) +
         * espaço (1) + arg: com 32.756 'a' a linha tem 32.767 unidades e
         * NÃO cabe; com 32.755 tem 32.766 e cabe. */
        huge[big - 11] = '\0';
        CHECK(ah_proc_win_command_line("C:\\p.exe", h, NULL, 1, &out) ==
              AH_ERR_LIMIT);
        CHECK(out == NULL);
        huge[big - 12] = '\0';
        CHECK(ah_proc_win_command_line("C:\\p.exe", h, NULL, 1, &out) ==
              AH_OK);
        CHECK(out != NULL && strlen(out) == AH_PROC_WIN_MAX_CMDLINE - 1);
        free(out);
        out = NULL;
        free(huge);
    }
    /* Programa com aspas é recusado. */
    CHECK(ah_proc_win_command_line("C:\\a\"b.exe", NULL, NULL, 0, &out) ==
          AH_ERR_INVALID);
}

static void test_cmd_escape_vectors(void) {
    char *out = NULL;
    /* escaparArgParaCmd('a & b'): aspas, depois ^ duas vezes. */
    CHECK(ah_proc_cmd_escape_arg("a & b", 5, &out) == AH_OK);
    CHECK(out != NULL && strcmp(out, "^^^\"a^^^ ^^^&^^^ b^^^\"") == 0);
    free(out);
    CHECK(ah_proc_cmd_escape_arg("x\\\"%", 4, &out) == AH_OK);
    /* x\"% → aspas: "x\\\"%" ; `"` com ^ duas vezes; `%` sem ^, trocado
     * por %%cd:~,% (A2, divergência deliberada do TS). */
    CHECK(out != NULL &&
          strcmp(out, "^^^\"x\\\\\\^^^\"%%cd:~,%^^^\"") == 0);
    free(out);
    out = NULL;
    CHECK(ah_proc_cmd_escape_arg("a\rb", 3, &out) == AH_ERR_INVALID);
    CHECK(ah_proc_cmd_escape_arg("a\nb", 3, &out) == AH_ERR_INVALID);
    CHECK(ah_proc_cmd_escape_arg("a\0b", 3, &out) == AH_ERR_INVALID);
    CHECK(out == NULL);

    /* Comando com um ^ por metacaractere (montarSpawn). */
    const char *args[1] = {"-p"};
    CHECK(ah_proc_cmd_line("C:\\a b\\x.cmd", args, NULL, 1, &out) == AH_OK);
    CHECK(out != NULL && strcmp(out, "C:\\a^ b\\x.cmd ^^^\"-p^^^\"") == 0);
    free(out);
    out = NULL;

    /* linha + 16 > 8191 → recusa (prompt-delivery.test.ts: 9000 'a'). */
    char *big = malloc(9001);
    CHECK(big != NULL);
    if (big != NULL) {
        memset(big, 'a', 9000);
        big[9000] = '\0';
        const char *b[1] = {big};
        CHECK(ah_proc_cmd_line("C:\\x.cmd", b, NULL, 1, &out) ==
              AH_ERR_LIMIT);
        CHECK(out == NULL);
        free(big);
    }
}

/* --- testes com processo --- */

static void test_relative_path_rejected(void) {
    /* SEC-R26 / SPEC-08 P1: nunca resolve relativo ao diretório corrente. */
    const char *paths[] = {"ah_test_proc_helper.exe", "proc_helper",
                           "./proc_helper", "../x", "bin/x",
#ifdef _WIN32
                           "C:x.exe", "\\x.exe", ".\\x.exe", "/x.exe",
#endif
                           ""};
    for (size_t i = 0; i < sizeof paths / sizeof paths[0]; i++) {
        ah_proc_spawn_opts o;
        opts_init(&o, NULL, 0);
        o.path = paths[i];
        ah_proc *p = (ah_proc *)&o; /* sentinela: precisa virar NULL */
        char detail[256];
        CHECK(ah_proc_spawn(&o, &p, detail, sizeof detail) == AH_ERR_INVALID);
        CHECK(p == NULL);
        CHECK(strstr(detail, "absoluto") != NULL);
    }
}

static void test_missing_executable(void) {
    ah_proc_spawn_opts o;
    opts_init(&o, NULL, 0);
#ifdef _WIN32
    o.path = WORK "/nao-existe.exe";
#else
    o.path = WORK "/nao-existe";
#endif
    ah_proc *p = NULL;
    CHECK(ah_proc_spawn(&o, &p, NULL, 0) == AH_ERR_NOT_FOUND);
    CHECK(p == NULL);
}

static void test_argv_roundtrip(void) {
    /* P3: ida e volta contra CommandLineToArgvW (o helper reparsa a própria
     * linha com ele no Windows). */
    const char *args[] = {
        "argv",
        "simples",
        "com espa\xc3\xa7o",
        "aspas \"internas\"",
        "\"",
        "\"\"",
        "a\"b c\"d",
        "barra\\",
        "barra\\\\",
        "barras\\\\\"aspas",
        "\\\\servidor\\share\\",
        "C:\\Program Files\\x\\",
        "",
        "tab\tdentro",
        "unicode \xc3\xa7\xc3\xa3o \xe6\x97\xa5\xe6\x9c\xac\xe8\xaa\x9e \xf0\x9f\x98\x80",
        "%PATH% & | > < ^ ! ( ) ;",
        "-p",
    };
    size_t n = sizeof args / sizeof args[0];
    ah_proc_spawn_opts o;
    opts_init(&o, args, n);
    run_result r;
    CHECK(run(&o, NULL, 0, &r) == AH_OK);
    CHECK(r.st.code == 0 && r.st.signal == 0);
    CHECK(r.out != NULL && argv_matches(r.out, args + 1, n - 1));
    run_free(&r);

    /* NUL embutido em arg_lens: recusado antes de criar processo. */
    const char nul_arg[] = {'x', '\0', 'y'};
    const char *a2[2] = {"argv", nul_arg};
    size_t lens[2] = {4, 3};
    opts_init(&o, a2, 2);
    o.arg_lens = lens;
    ah_proc *p = NULL;
    CHECK(ah_proc_spawn(&o, &p, NULL, 0) == AH_ERR_INVALID);
    CHECK(p == NULL);
}

static void test_stdin_to_stdout(void) {
    /* 1 MiB com todos os bytes (inclusive NUL, \r, \n): passa pelos buffers
     * dos pipes várias vezes e exige leitura e escrita intercaladas. */
    size_t len = 1u << 20;
    char *data = malloc(len);
    CHECK(data != NULL);
    if (data == NULL) {
        return;
    }
    for (size_t i = 0; i < len; i++) {
        data[i] = (char)((i * 7u + (i >> 9)) & 0xFFu);
    }
    const char *args[] = {"cat"};
    ah_proc_spawn_opts o;
    opts_init(&o, args, 1);
    run_result r;
    CHECK(run(&o, data, len, &r) == AH_OK);
    CHECK(r.out_len == len);
    CHECK(r.out != NULL && r.out_len == len && memcmp(r.out, data, len) == 0);
    CHECK(r.err_len == 0);
    CHECK(r.st.code == 0);
    run_free(&r);
    free(data);
}

static void test_exit_code_and_stderr(void) {
    const char *a42[] = {"exit", "42"};
    ah_proc_spawn_opts o;
    opts_init(&o, a42, 2);
    run_result r;
    CHECK(run(&o, NULL, 0, &r) == AH_OK);
    CHECK(r.st.code == 42 && r.st.signal == 0);
    run_free(&r);

    const char *a0[] = {"exit", "0"};
    opts_init(&o, a0, 2);
    CHECK(run(&o, NULL, 0, &r) == AH_OK);
    CHECK(r.st.code == 0);
    run_free(&r);

    const char *aerr[] = {"stderr", "falha: \xc3\xa7\xc3\xa3o"};
    opts_init(&o, aerr, 2);
    CHECK(run(&o, NULL, 0, &r) == AH_OK);
    CHECK(r.err != NULL && strcmp(r.err, "falha: \xc3\xa7\xc3\xa3o") == 0);
    CHECK(r.out_len == 0);
    run_free(&r);
}

/* Valor de NOME na saída do modo env: 1 achado, 0 ausente, -1 erro. */
static int env_value(const char *out, const char *name, char *val,
                     size_t cap) {
    char key[160];
    snprintf(key, sizeof key, "%s=", name);
    const char *q = out;
    size_t klen = strlen(key);
    while (q != NULL && *q != '\0') {
        if (strncmp(q, key, klen) == 0) {
            size_t len;
            return unhex(q + klen, val, cap, &len) == 0 ? 1 : -1;
        }
        q = strchr(q, '\n');
        if (q != NULL) {
            q++;
        }
    }
    return 0;
}

static void test_env(void) {
#ifdef _WIN32
    const char *parent_only = "OS"; /* sempre definido no Windows */
#else
    const char *parent_only = "HOME";
#endif
    char parent_val[4096];
    CHECK(test_getenv(parent_only, parent_val, sizeof parent_val));

    /* Ambiente explícito: o filho vê exatamente o bloco. PATH (e SystemRoot
     * no Windows) vão junto porque o loader precisa deles (a DLL do ASan
     * está no PATH do ctest). */
    static char path_entry[33000];
    static char sysroot_entry[1024];
    char tmp[32768];
    const char *env[5];
    size_t ne = 0;
    env[ne++] = "AH_TESTE_UM=valor com espa\xc3\xa7o = e igual";
    env[ne++] = "AH_TESTE_DOIS=\xc3\xa7\xc3\xa3o \xe6\x97\xa5\xe6\x9c\xac "
                "\xf0\x9f\x98\x80";
    if (test_getenv("PATH", tmp, sizeof tmp)) {
        snprintf(path_entry, sizeof path_entry, "PATH=%s", tmp);
        env[ne++] = path_entry;
    }
#ifdef _WIN32
    if (test_getenv("SystemRoot", tmp, sizeof tmp)) {
        snprintf(sysroot_entry, sizeof sysroot_entry, "SystemRoot=%s", tmp);
        env[ne++] = sysroot_entry;
    }
#else
    (void)sysroot_entry;
#endif
    const char *args[] = {"env", "AH_TESTE_UM", "AH_TESTE_DOIS", parent_only};
    ah_proc_spawn_opts o;
    opts_init(&o, args, 4);
    o.env = env;
    o.env_count = ne;
    run_result r;
    char val[4096];
    CHECK(run(&o, NULL, 0, &r) == AH_OK);
    CHECK(r.out != NULL);
    if (r.out != NULL) {
        CHECK(env_value(r.out, "AH_TESTE_UM", val, sizeof val) == 1 &&
              strcmp(val, "valor com espa\xc3\xa7o = e igual") == 0);
        CHECK(env_value(r.out, "AH_TESTE_DOIS", val, sizeof val) == 1 &&
              strcmp(val, "\xc3\xa7\xc3\xa3o \xe6\x97\xa5\xe6\x9c\xac "
                          "\xf0\x9f\x98\x80") == 0);
        char absent[160];
        snprintf(absent, sizeof absent, "%s!\n", parent_only);
        CHECK(strstr(r.out, absent) != NULL); /* não herdou */
    }
    run_free(&r);

    /* env == NULL: herda o ambiente do Hub. */
    const char *a2[] = {"env", parent_only};
    opts_init(&o, a2, 2);
    CHECK(run(&o, NULL, 0, &r) == AH_OK);
    CHECK(r.out != NULL &&
          env_value(r.out, parent_only, val, sizeof val) == 1 &&
          strcmp(val, parent_val) == 0);
    run_free(&r);

    /* Bloco malformado é recusado. */
    ah_proc *p = NULL;
    const char *dup_env[2] = {"AH_X=1", "AH_X=2"};
    opts_init(&o, a2, 2);
    o.env = dup_env;
    o.env_count = 2;
    CHECK(ah_proc_spawn(&o, &p, NULL, 0) == AH_ERR_INVALID);
#ifdef _WIN32
    const char *dup_ci[2] = {"AH_Y=1", "ah_y=2"};
    o.env = dup_ci;
    CHECK(ah_proc_spawn(&o, &p, NULL, 0) == AH_ERR_INVALID);
#endif
    const char *no_eq[1] = {"SEM_IGUAL"};
    o.env = no_eq;
    o.env_count = 1;
    CHECK(ah_proc_spawn(&o, &p, NULL, 0) == AH_ERR_INVALID);
    CHECK(p == NULL);
}

static void test_cwd(void) {
    char dir[1024];
    snprintf(dir, sizeof dir, "%s/cwd-\xc3\xa7\xc3\xa3o", WORK);
    native_path(dir);
    const char *args[] = {"cwd"};
    ah_proc_spawn_opts o;
    opts_init(&o, args, 1);
    o.cwd = dir;
    run_result r;
    char got[2048];
    size_t len = 0;
    CHECK(run(&o, NULL, 0, &r) == AH_OK);
    const char *q = r.out != NULL ? strstr(r.out, "cwd=") : NULL;
    CHECK(q != NULL && unhex(q + 4, got, sizeof got, &len) == 0);
    if (q != NULL) {
        CHECK(strcmp(got, dir) == 0);
        if (strcmp(got, dir) != 0) {
            fprintf(stderr, "cwd recebido [%s] esperado [%s]\n", got, dir);
        }
    }
    run_free(&r);

    /* cwd inexistente → NOT_FOUND. */
    opts_init(&o, args, 1);
    o.cwd = WORK "/nao-existe-dir";
    ah_proc *p = NULL;
    CHECK(ah_proc_spawn(&o, &p, NULL, 0) == AH_ERR_NOT_FOUND);
    CHECK(p == NULL);
}

static void test_only_stdio_inherited(void) {
    /* SEC-R28 / SPEC-08 P4: o Hub tem um handle/fd herdável aberto de
     * propósito; o filho não pode recebê-lo. */
#ifdef _WIN32
    SECURITY_ATTRIBUTES sa = {sizeof sa, NULL, TRUE};
    HANDLE bait = CreateEventW(&sa, TRUE, FALSE, NULL);
    CHECK(bait != NULL);
#else
    int bait = dup(2); /* sem FD_CLOEXEC */
    CHECK(bait >= 0);
#endif
    const char *args[] = {"handles"};
    ah_proc_spawn_opts o;
    opts_init(&o, args, 1);
    run_result r;
    CHECK(run(&o, NULL, 0, &r) == AH_OK);
    CHECK(r.out != NULL && strstr(r.out, "end\n") != NULL);
    CHECK(r.out != NULL && strstr(r.out, "leak=") == NULL);
    CHECK(r.out != NULL && strstr(r.out, "std=") != NULL &&
          strtol(strstr(r.out, "std=") + 4, NULL, 10) >= 3);
    printf("handles do filho: %s", r.out != NULL ? r.out : "(nada)\n");
    run_free(&r);

    /* Controle: o enumerador do helper acusa um handle herdável. */
    const char *args2[] = {"handles-selftest"};
    opts_init(&o, args2, 1);
    CHECK(run(&o, NULL, 0, &r) == AH_OK);
    CHECK(r.out != NULL && strstr(r.out, "leak=") != NULL);
    run_free(&r);
#ifdef _WIN32
    CloseHandle(bait);
#else
    close(bait);
#endif
}

static void test_kill(void) {
    const char *args[] = {"cat"}; /* bloqueia lendo stdin, que fica aberto */
    ah_proc_spawn_opts o;
    opts_init(&o, args, 1);
    ah_proc *p = NULL;
    CHECK(ah_proc_spawn(&o, &p, NULL, 0) == AH_OK);
    if (p == NULL) {
        return;
    }
    CHECK(ah_proc_pid(p) != 0);
    bool exited = true;
    ah_proc_exit st;
    CHECK(ah_proc_wait(p, false, &exited, &st) == AH_OK && !exited);
    CHECK(ah_proc_kill(p) == AH_OK);
    CHECK(ah_proc_wait(p, true, &exited, &st) == AH_OK && exited);
#ifdef _WIN32
    CHECK(st.code == 1 && st.signal == 0);
#else
    CHECK(st.signal == 9);
#endif
    CHECK(ah_proc_kill(p) == AH_OK); /* já colhido: no-op */
    ah_proc_free(p);
}

#ifdef _WIN32
static void test_batch_only_via_cmd(void) {
    /* SPEC-08 P2: .bat/.cmd nunca chegam ao CreateProcessW fora do ramo
     * explícito, nem com truques de nome que o Win32 normaliza. */
    char shim[1024];
    snprintf(shim, sizeof shim, "%s/shim.cmd", WORK);
    native_path(shim);
    const char *bad[] = {"shim.cmd", "shim.CMD", "shim.bat", "shim.cmd.",
                         "shim.cmd  ", "shim.cmd. .", "shim.cmd::$DATA",
                         "shim.exe:x"};
    for (size_t i = 0; i < sizeof bad / sizeof bad[0]; i++) {
        char path[1024];
        snprintf(path, sizeof path, "%s\\%s", WORK, bad[i]);
        native_path(path);
        ah_proc_spawn_opts o;
        opts_init(&o, NULL, 0);
        o.path = path;
        ah_proc *p = NULL;
        CHECK(ah_proc_spawn(&o, &p, NULL, 0) == AH_ERR_INVALID);
        CHECK(p == NULL);
    }
    /* via_cmd só aceita .cmd/.bat. */
    ah_proc_spawn_opts o;
    opts_init(&o, NULL, 0);
    o.via_cmd = true;
    ah_proc *p = NULL;
    CHECK(ah_proc_spawn(&o, &p, NULL, 0) == AH_ERR_INVALID);
    CHECK(p == NULL);
}

static void test_cmd_hostile_roundtrip(void) {
    /* SEC-R27: .cmd que repassa %* (o reparse da injeção "BatBadBut"); os
     * prompts são os HOSTIS_LINHA_UNICA de prompt-delivery.test.ts mais
     * aspas desbalanceadas. */
    char helper[1024];
    snprintf(helper, sizeof helper, "%s", HELPER);
    native_path(helper);
    char shim[1024];
    snprintf(shim, sizeof shim, "%s/shim.cmd", WORK);
    native_path(shim);
    char content[2048];
    snprintf(content, sizeof content, "@echo off\r\n\"%s\" argv %%*\r\n",
             helper);
    CHECK(write_file(shim, content) == 0);
    char marker[1024];
    snprintf(marker, sizeof marker, "%s/x", WORK);
    native_path(marker);
    remove(marker);

    const char *hostile[] = {
        "& echo PWN>x",
        "a&echo>x",
        "x\" & echo PWN>x & \"",
        "diz \"oi\" com \\\"barra\\\" \\",
        "valor %PATH% e %USERNAME% fim",
        "atraso !x! e !PATH!",
        "circunflexo ^ ^^ ^& | < > ( ) ; , ` *?",
        "ol\xc3\xa1 \xc3\xa7\xc3\xa3o \xe6\x97\xa5\xe6\x9c\xac\xe8\xaa\x9e \xf0\x9f\x98\x80",
        "\"",
        "abre \" e nunca fecha & echo PWN>x",
        "\"\"\" | echo PWN>x",
        "fecha\" sem abrir > x",
        "%%",
        "",
    };
    for (size_t i = 0; i < sizeof hostile / sizeof hostile[0]; i++) {
        const char *args[2] = {"-p", hostile[i]};
        ah_proc_spawn_opts o;
        memset(&o, 0, sizeof o);
        o.path = shim;
        o.args = args;
        o.arg_count = 2;
        o.via_cmd = true;
        o.cwd = WORK;
        run_result r;
        CHECK(run(&o, NULL, 0, &r) == AH_OK);
        CHECK(r.st.code == 0);
        int ok = r.out != NULL && argv_matches(r.out, args, 2);
        CHECK(ok);
        if (!ok) {
            fprintf(stderr, "prompt %zu falhou; stderr: %s\n", i,
                    r.err != NULL ? r.err : "");
        }
        CHECK(!file_exists(marker)); /* nenhum comando extra rodou */
        run_free(&r);
    }

    /* Multilinha e longo demais: recusados, não truncados. */
    const char *multi[] = {"linha1\nlinha2 & echo PWN>x\nlinha3",
                           "crlf1\r\ncrlf2"};
    for (size_t i = 0; i < 2; i++) {
        const char *args[2] = {"-p", multi[i]};
        ah_proc_spawn_opts o;
        memset(&o, 0, sizeof o);
        o.path = shim;
        o.args = args;
        o.arg_count = 2;
        o.via_cmd = true;
        ah_proc *p = NULL;
        char detail[512];
        CHECK(ah_proc_spawn(&o, &p, detail, sizeof detail) ==
              AH_ERR_INVALID);
        CHECK(p == NULL && strstr(detail, "quebra de linha") != NULL);
    }
    char *big = malloc(10300);
    CHECK(big != NULL);
    if (big != NULL) {
        for (size_t k = 0; k < 10240; k++) {
            big[k] = (char)('0' + k % 10);
        }
        snprintf(big + 10240, 60, " & echo PWN>x");
        const char *args[2] = {"-p", big};
        ah_proc_spawn_opts o;
        memset(&o, 0, sizeof o);
        o.path = shim;
        o.args = args;
        o.arg_count = 2;
        o.via_cmd = true;
        ah_proc *p = NULL;
        char detail[512];
        CHECK(ah_proc_spawn(&o, &p, detail, sizeof detail) == AH_ERR_LIMIT);
        CHECK(p == NULL && strstr(detail, "excede o limite") != NULL);
        free(big);
    }
    CHECK(!file_exists(marker));
}

static void test_cmd_percent_neutralized(void) {
    /* A2 (SEC-R27): o `%` não expande no ramo via_cmd, nem na forma de
     * substituição (`%NOME:a=b%`, `%NOME:*x=y%`, `%NOME:~0,3%`), que o `^`
     * não protegia. Só variáveis fictícias criadas aqui (e a dinâmica
     * CMDCMDLINE do próprio cmd). Valores com & | < > e marcadores: se
     * algum valor fosse expandido, o "segundo comando" criaria o arquivo. */
    CHECK(SetEnvironmentVariableW(L"AH_F007_VAR", L"abcxyz"));
    CHECK(SetEnvironmentVariableW(L"AH_F007_PERIGO",
                                  L"x&echo PWN>pwn-a2.txt&y"));
    CHECK(SetEnvironmentVariableW(L"AH_F007_PIPE",
                                  L"p|echo PWN>pwn-a2b.txt|more<nul>nul"));
    char shim[1024];
    snprintf(shim, sizeof shim, "%s/shim.cmd", WORK); /* repassa %* */
    native_path(shim);
    const char *markers[] = {"pwn-a2.txt", "pwn-a2b.txt", "pwn-a2c.txt"};
    char mpath[3][1024];
    for (int i = 0; i < 3; i++) {
        snprintf(mpath[i], sizeof mpath[i], "%s/%s", WORK, markers[i]);
        native_path(mpath[i]);
        remove(mpath[i]);
    }
    const char *args[] = {
        "-p",
        "%AH_F007_VAR%",
        "%AH_F007_VAR:a=b%",
        "%AH_F007_VAR:*x=y%",
        "%AH_F007_VAR:~0,3%",
        "%CMDCMDLINE:a=b%",
        "%%",
        "fim%",
        "%",
        "100%",
        "%~1",
        "%1",
        "%cd:~,%",
        "a%AH_F007_VAR%b%AH_F007_VAR%c",
        "%AH_F007_PERIGO%",
        "%AH_F007_PERIGO:x=z%",
        "%AH_F007_PERIGO:*&=%",
        "%AH_F007_PIPE%",
        "%AH_F007_PIPE:p=q%",
        "%AH_F007_VAR% & echo PWN>pwn-a2c.txt",
        "\"%AH_F007_PERIGO%\"",
    };
    size_t n = sizeof args / sizeof args[0];
    ah_proc_spawn_opts o;
    memset(&o, 0, sizeof o);
    o.path = shim;
    o.args = args;
    o.arg_count = n;
    o.via_cmd = true;
    o.cwd = WORK;
    run_result r;
    CHECK(run(&o, NULL, 0, &r) == AH_OK);
    CHECK(r.st.code == 0);
    int ok = r.out != NULL && argv_matches(r.out, args, n);
    CHECK(ok);
    if (!ok) {
        fprintf(stderr, "A2: stdout [%s] stderr [%s]\n",
                r.out != NULL ? r.out : "", r.err != NULL ? r.err : "");
    }
    for (int i = 0; i < 3; i++) {
        CHECK(!file_exists(mpath[i])); /* segundo comando não rodou */
    }
    printf("A2: %zu argumentos com %% chegaram idênticos: %s\n", n - 1,
           ok ? "sim" : "NÃO");
    run_free(&r);
    SetEnvironmentVariableW(L"AH_F007_VAR", NULL);
    SetEnvironmentVariableW(L"AH_F007_PERIGO", NULL);
    SetEnvironmentVariableW(L"AH_F007_PIPE", NULL);
}

static void test_start_suspended(void) {
    /* Ponto de extensão da F0-08: suspenso até ah_proc_resume. */
    const char *args[] = {"exit", "7"};
    ah_proc_spawn_opts o;
    opts_init(&o, args, 2);
    o.start_suspended = true;
    ah_proc *p = NULL;
    CHECK(ah_proc_spawn(&o, &p, NULL, 0) == AH_OK);
    if (p == NULL) {
        return;
    }
    CHECK(ah_proc_native_process(p) != 0);
    bool exited = true;
    ah_proc_exit st;
    CHECK(ah_proc_wait(p, false, &exited, &st) == AH_OK && !exited);
    CHECK(ah_proc_resume(p) == AH_OK);
    CHECK(ah_proc_resume(p) == AH_ERR_INVALID);
    CHECK(ah_proc_wait(p, true, &exited, &st) == AH_OK && exited);
    CHECK(st.code == 7);
    ah_proc_free(p);
}

/* cmd.exe do sistema, em UTF-8 (para os testes que o chamam direto). */
static int system_cmd(char *buf, size_t cap) {
    wchar_t w[MAX_PATH + 16];
    UINT n = GetSystemDirectoryW(w, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) {
        return 0;
    }
    if (wcscat_s(w, MAX_PATH + 16, L"\\cmd.exe") != 0) {
        return 0;
    }
    return WideCharToMultiByte(CP_UTF8, 0, w, -1, buf, (int)cap, NULL, NULL) >
           0;
}

static void test_cmd_last_v_flag_wins(void) {
    /* A1: com dois /v, o último vence. Controle: /v:on sozinho expande
     * !OS!; /v:on seguido de /v:off não expande. É a mesma regra que faz o
     * nosso /v:off vencer DelayedExpansion=1 do registro (que este teste
     * não altera: o registro do usuário não é tocado). */
    char cmd[MAX_PATH * 3];
    CHECK(system_cmd(cmd, sizeof cmd));
    const char *on[] = {"/d", "/v:on", "/c", "echo !OS!"};
    ah_proc_spawn_opts o;
    memset(&o, 0, sizeof o);
    o.path = cmd;
    o.args = on;
    o.arg_count = 4;
    run_result r;
    CHECK(run(&o, NULL, 0, &r) == AH_OK);
    CHECK(r.out != NULL && strstr(r.out, "Windows_NT") != NULL);
    run_free(&r);

    const char *on_off[] = {"/d", "/v:on", "/v:off", "/c", "echo !OS!"};
    o.args = on_off;
    o.arg_count = 5;
    CHECK(run(&o, NULL, 0, &r) == AH_OK);
    CHECK(r.out != NULL && strstr(r.out, "!OS!") != NULL &&
          strstr(r.out, "Windows_NT") == NULL);
    run_free(&r);
}

static void test_pipe_dacl_and_name(void) {
    /* M1: DACL com uma ACE só, do SID do usuário do token; nada de
     * Everyone/Anonymous; nome com 32 dígitos hex (128 bits). */
    union {
        TOKEN_USER tu;
        unsigned char raw[256];
    } tok;
    HANDLE th = NULL;
    DWORD need = 0;
    CHECK(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &th));
    CHECK(GetTokenInformation(th, TokenUser, &tok, sizeof tok, &need));
    CloseHandle(th);
    union {
        SID sid;
        unsigned char raw[SECURITY_MAX_SID_SIZE];
    } everyone, anonymous;
    DWORD sz = sizeof everyone;
    CHECK(CreateWellKnownSid(WinWorldSid, NULL, &everyone, &sz));
    sz = sizeof anonymous;
    CHECK(CreateWellKnownSid(WinAnonymousSid, NULL, &anonymous, &sz));

    const char *args[] = {"hang"};
    ah_proc_spawn_opts o;
    opts_init(&o, args, 1);
    ah_proc *p = NULL;
    CHECK(ah_proc_spawn(&o, &p, NULL, 0) == AH_OK);
    if (p == NULL) {
        return;
    }
    for (int s = 0; s < 3; s++) {
        intptr_t hv = 0;
        CHECK(ah_proc_native_pipe(p, (ah_proc_stream)s, &hv) == AH_OK);
        PACL dacl = NULL;
        PSECURITY_DESCRIPTOR sd = NULL;
        DWORD e = GetSecurityInfo((HANDLE)hv, SE_KERNEL_OBJECT,
                                  DACL_SECURITY_INFORMATION, NULL, NULL,
                                  &dacl, NULL, &sd);
        CHECK(e == ERROR_SUCCESS && dacl != NULL);
        if (e != ERROR_SUCCESS) {
            fprintf(stderr, "GetSecurityInfo falhou: %lu\n", (unsigned long)e);
        }
        if (e == ERROR_SUCCESS && dacl != NULL) {
            ACL_SIZE_INFORMATION si;
            CHECK(GetAclInformation(dacl, &si, sizeof si, AclSizeInformation));
            CHECK(si.AceCount == 1);
            for (DWORD i = 0; i < si.AceCount; i++) {
                void *ace = NULL;
                CHECK(GetAce(dacl, i, &ace));
                ACE_HEADER *hd = ace;
                CHECK(hd != NULL && hd->AceType == ACCESS_ALLOWED_ACE_TYPE);
                if (hd != NULL && hd->AceType == ACCESS_ALLOWED_ACE_TYPE) {
                    PSID sid = &((ACCESS_ALLOWED_ACE *)ace)->SidStart;
                    CHECK(EqualSid(sid, tok.tu.User.Sid));
                    CHECK(!EqualSid(sid, &everyone));
                    CHECK(!EqualSid(sid, &anonymous));
                }
            }
            printf("pipe %d: DACL com %lu ACE (SID do usuário)\n", s,
                   (unsigned long)si.AceCount);
        }
        LocalFree(sd);

        union {
            FILE_NAME_INFO fi;
            unsigned char raw[1024];
        } nb;
        CHECK(GetFileInformationByHandleEx((HANDLE)hv, FileNameInfo, &nb,
                                           sizeof nb));
        static const wchar_t prefix[] = L"\\agents-hub-proc-";
        size_t plen = sizeof prefix / sizeof(wchar_t) - 1;
        size_t nlen = nb.fi.FileNameLength / sizeof(wchar_t);
        CHECK(nlen == plen + 32);
        CHECK(nlen >= plen &&
              wcsncmp(nb.fi.FileName, prefix, plen) == 0);
        int hex_ok = nlen == plen + 32;
        for (size_t i = plen; i < nlen && hex_ok; i++) {
            wchar_t c = nb.fi.FileName[i];
            hex_ok = (c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f');
        }
        CHECK(hex_ok);
    }
    CHECK(ah_proc_kill(p) == AH_OK);
    bool exited = false;
    ah_proc_exit st;
    CHECK(ah_proc_wait(p, true, &exited, &st) == AH_OK && exited);
    ah_proc_free(p);
}

static void test_cmd_no_cwd_exe_search(void) {
    /* M3: um .cmd que chama "ahisca" pelo nome, com ahisca.exe (cópia do
     * helper) no cwd e fora do PATH, não executa a isca. */
    char shim[1024];
    snprintf(shim, sizeof shim, "%s/shim-isca.cmd", WORK);
    native_path(shim);
    CHECK(write_file(shim, "@echo off\r\nahisca argv marcador\r\n") == 0);
    char isca_dir[1024];
    snprintf(isca_dir, sizeof isca_dir, "%s/isca", WORK);
    native_path(isca_dir);
    char isca_exe[1024];
    snprintf(isca_exe, sizeof isca_exe, "%s\\ahisca.exe", isca_dir);
    CHECK(file_exists(isca_exe));

    /* O ambiente de quem roda o teste pode já trazer a variável (a sessão
     * do agente de código traz); sem tirá-la do processo de teste o
     * controle abaixo não provaria nada. Restaurada no fim. */
    wchar_t saved[64];
    DWORD saved_n = GetEnvironmentVariableW(L"NoDefaultCurrentDirectoryInExePath",
                                            saved, 64);
    CHECK(SetEnvironmentVariableW(L"NoDefaultCurrentDirectoryInExePath", NULL) ||
          saved_n == 0);

    /* Controle: cmd.exe chamado direto (sem o ramo via_cmd) executa a isca
     * do diretório corrente; é o risco que o M3 fecha. */
    char cmd[MAX_PATH * 3];
    CHECK(system_cmd(cmd, sizeof cmd));
    const char *ctl[] = {"/d", "/c", "ahisca argv marcador"};
    ah_proc_spawn_opts o;
    memset(&o, 0, sizeof o);
    o.path = cmd;
    o.args = ctl;
    o.arg_count = 3;
    o.cwd = isca_dir;
    run_result r;
    CHECK(run(&o, NULL, 0, &r) == AH_OK);
    CHECK(r.out != NULL && strstr(r.out, "n=1") != NULL);
    printf("controle (cmd direto) com isca no cwd: código %lld, stdout [%s], "
           "stderr [%s]\n",
           (long long)r.st.code, r.out != NULL ? r.out : "",
           r.err != NULL ? r.err : "");
    run_free(&r);

    /* Ramo via_cmd, ambiente herdado: a isca não roda. */
    memset(&o, 0, sizeof o);
    o.path = shim;
    o.via_cmd = true;
    o.cwd = isca_dir;
    CHECK(run(&o, NULL, 0, &r) == AH_OK);
    CHECK(r.out != NULL && strstr(r.out, "n=") == NULL);
    CHECK(r.st.code != 0);
    printf("via_cmd com isca no cwd: código %lld, stdout [%s], stderr [%s]\n",
           (long long)r.st.code, r.out != NULL ? r.out : "",
           r.err != NULL ? r.err : "");
    run_free(&r);

    /* B5: ambiente explícito SEM a variável: só o Hub a acrescenta. (Um
     * valor "=0" não serviria de teste: o cmd só olha se a variável
     * existe, qualquer que seja o valor.) */
    static char path_entry[33000];
    static char sysroot_entry[1024];
    char tmp[32768];
    const char *env[2];
    size_t ne = 0;
    if (test_getenv("PATH", tmp, sizeof tmp)) {
        snprintf(path_entry, sizeof path_entry, "PATH=%s", tmp);
        env[ne++] = path_entry;
    }
    if (test_getenv("SystemRoot", tmp, sizeof tmp)) {
        snprintf(sysroot_entry, sizeof sysroot_entry, "SystemRoot=%s", tmp);
        env[ne++] = sysroot_entry;
    }
    o.env = env;
    o.env_count = ne;
    CHECK(run(&o, NULL, 0, &r) == AH_OK);
    CHECK(r.out != NULL && strstr(r.out, "n=") == NULL);
    CHECK(r.st.code != 0);
    run_free(&r);

    if (saved_n > 0 && saved_n < 64) {
        SetEnvironmentVariableW(L"NoDefaultCurrentDirectoryInExePath", saved);
    }
}

static void test_free_suspended_terminates(void) {
    /* B4: ah_proc_free de um processo suspenso nunca retomado o termina. */
    const char *args[] = {"exit", "7"};
    ah_proc_spawn_opts o;
    opts_init(&o, args, 2);
    o.start_suspended = true;
    ah_proc *p = NULL;
    CHECK(ah_proc_spawn(&o, &p, NULL, 0) == AH_OK);
    if (p == NULL) {
        return;
    }
    HANDLE h = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                           FALSE, (DWORD)ah_proc_pid(p));
    CHECK(h != NULL);
    ah_proc_free(p);
    if (h != NULL) {
        CHECK(WaitForSingleObject(h, 10000) == WAIT_OBJECT_0);
        DWORD code = 0;
        CHECK(GetExitCodeProcess(h, &code) && code == 1); /* não o 7 */
        CloseHandle(h);
    }
}

static void test_comspec_unc_ignored(void) {
    /* B4: ComSpec UNC é recusado; o ramo cai no cmd.exe do sistema (se o
     * UNC fosse aceito, o spawn falharia: o servidor não existe). */
    wchar_t old[MAX_PATH + 1];
    DWORD n = GetEnvironmentVariableW(L"ComSpec", old, MAX_PATH + 1);
    CHECK(SetEnvironmentVariableW(
        L"ComSpec", L"\\\\nao-existe.invalid\\share\\cmd.exe"));
    char shim[1024];
    snprintf(shim, sizeof shim, "%s/shim.cmd", WORK);
    native_path(shim);
    const char *args[2] = {"-p", "ok"};
    ah_proc_spawn_opts o;
    memset(&o, 0, sizeof o);
    o.path = shim;
    o.args = args;
    o.arg_count = 2;
    o.via_cmd = true;
    run_result r;
    CHECK(run(&o, NULL, 0, &r) == AH_OK);
    CHECK(r.out != NULL && argv_matches(r.out, args, 2));
    run_free(&r);
    SetEnvironmentVariableW(L"ComSpec",
                            (n > 0 && n <= MAX_PATH) ? old : NULL);
}
#else
static void test_posix_only_options(void) {
    const char *args[] = {"exit", "0"};
    ah_proc_spawn_opts o;
    opts_init(&o, args, 2);
    o.via_cmd = true;
    ah_proc *p = NULL;
    CHECK(ah_proc_spawn(&o, &p, NULL, 0) == AH_ERR_INVALID);
    opts_init(&o, args, 2);
    o.start_suspended = true;
    CHECK(ah_proc_spawn(&o, &p, NULL, 0) == AH_ERR_INVALID);
    CHECK(p == NULL);
}
#endif

static void test_cmd_invocation_vector(void) {
    /* A1: /v:off presente e ANTES do /c; A2: /e:on também antes do /c;
     * bytes da <linha> intocados. */
    char *out = NULL;
    const char *linha = "C:\\x.cmd ^^^\"a^^^\"";
    CHECK(ah_proc_cmd_invocation("C:\\Windows\\System32\\cmd.exe", linha,
                                 &out) == AH_OK);
    CHECK(out != NULL &&
          strcmp(out, "\"C:\\Windows\\System32\\cmd.exe\" /d /s /e:on /v:off "
                      "/c \"C:\\x.cmd ^^^\"a^^^\"\"") == 0);
    if (out != NULL) {
        const char *v = strstr(out, " /v:off ");
        const char *e = strstr(out, " /e:on ");
        const char *c = strstr(out, " /c ");
        CHECK(v != NULL && e != NULL && c != NULL && v < c && e < c);
    }
    free(out);
    out = NULL;
    CHECK(ah_proc_cmd_invocation("C:\\a\"b.exe", linha, &out) ==
          AH_ERR_INVALID);
    CHECK(out == NULL);
}

/* Escreve no stdin até a escrita ficar em curso (AGAIN). Guarda a cópia do
 * que foi aceito. Devolve 1 se chegou a AGAIN. */
static int fill_stdin(ah_proc *p, char **copy, size_t *copy_len) {
    static char chunk[65536];
    for (size_t i = 0; i < sizeof chunk; i++) {
        chunk[i] = (char)('a' + i % 23);
    }
    for (int round = 0; round < 256; round++) {
        size_t acc = 0;
        ah_proc_io io;
        if (ah_proc_write(p, chunk, sizeof chunk, &acc, &io) != AH_OK) {
            return 0;
        }
        if (acc > 0 && append(copy, copy_len, chunk, acc) != 0) {
            return 0;
        }
        if (io == AH_PROC_IO_AGAIN) {
            return 1;
        }
    }
    return 0;
}

static void test_close_stdin_never_blocks(void) {
    /* M2: filho que nunca lê; escrita > 64 KiB em curso; close_stdin volta
     * na hora (se bloqueasse, o TIMEOUT do ctest derrubaria o teste). */
    const char *args[] = {"hang"};
    ah_proc_spawn_opts o;
    opts_init(&o, args, 1);
    ah_proc *p = NULL;
    CHECK(ah_proc_spawn(&o, &p, NULL, 0) == AH_OK);
    if (p == NULL) {
        return;
    }
    char *copy = NULL;
    size_t copy_len = 0;
    CHECK(fill_stdin(p, &copy, &copy_len));
    CHECK(copy_len >= 65536);
    printf("stdin aceito antes do AGAIN (filho não lê): %zu bytes\n",
           copy_len);
    CHECK(ah_proc_close_stdin(p) == AH_OK);
    size_t acc = 0;
    ah_proc_io io;
    CHECK(ah_proc_write(p, "x", 1, &acc, &io) == AH_ERR_IO);
    CHECK(ah_proc_close_stdin(p) == AH_OK);
    unsigned ready = 0;
    CHECK(ah_proc_wait_io(p, AH_PROC_MASK_STDOUT, 50, &ready) == AH_OK);
    CHECK(ah_proc_kill(p) == AH_OK);
    bool exited = false;
    ah_proc_exit st;
    CHECK(ah_proc_wait(p, true, &exited, &st) == AH_OK && exited);
    ah_proc_free(p); /* cancela a escrita em curso */
    free(copy);
}

static void test_close_stdin_deferred_delivers(void) {
    /* M2: com o fechamento diferido, os bytes já aceitos chegam e o filho
     * recebe EOF quando a escrita em curso termina, mesmo que o chamador
     * só espere stdout/stderr. */
    const char *args[] = {"cat"};
    ah_proc_spawn_opts o;
    opts_init(&o, args, 1);
    ah_proc *p = NULL;
    CHECK(ah_proc_spawn(&o, &p, NULL, 0) == AH_OK);
    if (p == NULL) {
        return;
    }
    char *copy = NULL;
    size_t copy_len = 0;
    CHECK(fill_stdin(p, &copy, &copy_len));
    CHECK(ah_proc_close_stdin(p) == AH_OK);
    char *out = NULL;
    size_t out_len = 0;
    char *err = NULL;
    size_t err_len = 0;
    int out_eof = 0;
    int err_eof = 0;
    int ok = 1;
    while (ok && (!out_eof || !err_eof)) {
        if (drain(p, AH_PROC_STDOUT, &out, &out_len, &out_eof) != 0 ||
            drain(p, AH_PROC_STDERR, &err, &err_len, &err_eof) != 0) {
            ok = 0;
            break;
        }
        unsigned mask = (out_eof ? 0u : AH_PROC_MASK_STDOUT) |
                        (err_eof ? 0u : AH_PROC_MASK_STDERR);
        if (mask == 0) {
            break;
        }
        unsigned ready = 0;
        if (ah_proc_wait_io(p, mask, IO_TIMEOUT_MS, &ready) != AH_OK ||
            ready == 0) {
            ok = 0;
        }
    }
    CHECK(ok);
    CHECK(out_len == copy_len);
    CHECK(out != NULL && copy != NULL && out_len == copy_len &&
          memcmp(out, copy, copy_len) == 0);
    if (!ok) {
        ah_proc_kill(p);
    }
    bool exited = false;
    ah_proc_exit st;
    CHECK(ah_proc_wait(p, true, &exited, &st) == AH_OK && exited);
    CHECK(ok == 0 || st.code == 0);
    ah_proc_free(p);
    free(copy);
    free(out);
    free(err);
}

static void test_zero_byte_writes(void) {
    /* B4: escritas de 0 bytes repetidas do filho não fazem o laço girar em
     * falso (no máximo uma volta por escrita).
     * B6: este teste NÃO passa pelo ramo "leitura concluída com 0 bytes" de
     * ah_proc_read, e não há como fazê-lo passar: nos nossos pipes (modo
     * byte), WriteFile de 0 bytes não conclui a leitura pendente do outro
     * lado. Conferido em 2026-10-01: com as escritas espaçadas por Sleep(1)
     * (leitura do Hub já pendente) e o ramo trocado por "devolve erro", o
     * teste passou com 4 voltas do laço para 200 escritas, ou seja, nenhuma
     * escrita vazia acordou o leitor. O ramo fica como defesa (pipe que um
     * dia seja de mensagem, ou comportamento do NPFS que mude). */
    const char *args[] = {"zerowrites", "2000"};
    ah_proc_spawn_opts o;
    opts_init(&o, args, 2);
    run_result r;
    CHECK(run(&o, NULL, 0, &r) == AH_OK);
    CHECK(r.out != NULL && strcmp(r.out, "fim") == 0);
    CHECK(r.st.code == 0);
    CHECK(g_run_iterations <= 2 * 2000 + 50);
    printf("2000 escritas de 0 bytes: %lu voltas do laço\n",
           g_run_iterations);
    run_free(&r);
}

static void test_exit_waitable(void) {
    /* M4: aguardável de fim de processo (Windows: HANDLE do processo;
     * Linux: pidfd; sem suporte: AH_ERR_NOT_FOUND documentado). */
    const char *args[] = {"exit", "3"};
    ah_proc_spawn_opts o;
    opts_init(&o, args, 2);
    ah_proc *p = NULL;
    CHECK(ah_proc_spawn(&o, &p, NULL, 0) == AH_OK);
    if (p == NULL) {
        return;
    }
    intptr_t w = 0;
    ah_status s = ah_proc_exit_waitable(p, &w);
#ifdef _WIN32
    CHECK(s == AH_OK && w != 0);
    if (s == AH_OK) {
        CHECK(WaitForSingleObject((HANDLE)w, 20000) == WAIT_OBJECT_0);
    }
#else
    CHECK(s == AH_OK || s == AH_ERR_NOT_FOUND);
#endif
    bool exited = false;
    ah_proc_exit st;
    CHECK(ah_proc_wait(p, true, &exited, &st) == AH_OK && exited);
    CHECK(st.code == 3);
    ah_proc_free(p);
}

int main(void) {
    test_cmd_invocation_vector();
    test_close_stdin_never_blocks();
    test_close_stdin_deferred_delivers();
    test_zero_byte_writes();
    test_exit_waitable();
    test_command_line_vectors();
    test_cmd_escape_vectors();
    test_relative_path_rejected();
    test_missing_executable();
    test_argv_roundtrip();
    test_stdin_to_stdout();
    test_exit_code_and_stderr();
    test_env();
    test_cwd();
    test_only_stdio_inherited();
    test_kill();
#ifdef _WIN32
    test_batch_only_via_cmd();
    test_cmd_hostile_roundtrip();
    test_start_suspended();
    test_cmd_last_v_flag_wins();
    test_pipe_dacl_and_name();
    test_cmd_no_cwd_exe_search();
    test_free_suspended_terminates();
    test_comspec_unc_ignored();
    test_cmd_percent_neutralized();
#else
    test_posix_only_options();
#endif
    return AH_TEST_END("test_platform_proc");
}
