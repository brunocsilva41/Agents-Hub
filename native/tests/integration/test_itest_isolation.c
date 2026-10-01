/* Prova do helper de integração (F0-11): ele NUNCA aponta para a porta 4747
 * nem para ~/.agents-hub, inclusive com o ambiente pai hostil
 * (AGENTS_HUB_HOME de outro lugar, AGENTS_HUB_PORT=4747, AGENTS_HUB_URL...).
 *
 * Nada aqui escreve fora do diretório temporário do build (argv[2]) e dos
 * homes temporários do próprio helper. Os "perfis" usados para provar a
 * recusa são falsos, dentro do diretório do build; o ~/.agents-hub real só é
 * usado como texto de caminho, nunca criado, aberto ou listado.
 *
 * Uso: test_itest_isolation <caminho do itest_probe> <dir temporário do build> */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ah_itest.h"
#include "ah_test.h"

#if defined(_WIN32)
#define SEP "\\"
#else
#define SEP "/"
#endif

static const char *g_probe;
static const char *g_tmp;

/* Variáveis do pai que os testes mexem; restauradas ao fim de cada teste. */
static const char *const k_saved_names[] = {
    "AGENTS_HUB_HOME", "AGENTS_HUB_PORT", "AGENTS_HUB_NO_AUTOSTART", "AGENTS_HUB_URL",
    "AGENTS_HUB_SESSION_ID", "AH_ITEST_MARCA", "USERPROFILE", "HOME", "TMP", "TEMP", "TMPDIR"};
#define N_SAVED (sizeof k_saved_names / sizeof k_saved_names[0])

typedef struct saved_env {
    char *value[N_SAVED];
} saved_env;

static char *dup_env(const char *name) {
    char buf[4096];
    char *d;
    size_t n;
    if (ah_itest_getenv(name, buf, sizeof buf) != AH_OK) {
        return NULL;
    }
    n = strlen(buf) + 1;
    d = malloc(n);
    if (d != NULL) {
        memcpy(d, buf, n);
    }
    return d;
}

static void env_save(saved_env *s) {
    size_t i;
    for (i = 0; i < N_SAVED; i++) {
        s->value[i] = dup_env(k_saved_names[i]);
    }
}

static void env_restore(saved_env *s) {
    size_t i;
    for (i = 0; i < N_SAVED; i++) {
        CHECK(ah_itest_setenv(k_saved_names[i], s->value[i]) == AH_OK);
        free(s->value[i]);
        s->value[i] = NULL;
    }
}

static void path_join(char *out, size_t cap, const char *a, const char *b) {
    int n = snprintf(out, cap, "%s" SEP "%s", a, b);
    if (n < 0 || (size_t)n >= cap) {
        out[0] = '\0';
    }
}

/* Cria (se faltar) um diretório de trabalho do teste dentro do build. */
static void scratch_dir(char *out, size_t cap, const char *name) {
    path_join(out, cap, g_tmp, name);
    if (!ah_itest_path_exists(out)) {
        CHECK(ah_itest_make_dir(out) == AH_OK);
    }
}

static int starts_with(const char *s, const char *prefix) {
    return strncmp(s, prefix, strlen(prefix)) == 0;
}

static const char *base_name(const char *path) {
    const char *b = path;
    const char *p;
    for (p = path; *p != '\0'; p++) {
        if (*p == '/' || *p == '\\') {
            b = p + 1;
        }
    }
    return b;
}

/* ------------------------------------------------------------ porta */

typedef struct seq_source {
    const unsigned *ports;
    size_t n;
    size_t next;
} seq_source;

static ah_status seq_port(void *ctx, unsigned *port) {
    seq_source *s = ctx;
    *port = s->ports[s->next < s->n ? s->next : s->n - 1];
    s->next++;
    return AH_OK;
}

static void test_pick_port_rejects_4747(void) {
    static const unsigned seq1[] = {4747, 4747, 0, 80, 1023, 65536, 51234};
    static const unsigned always_4747[] = {4747};
    seq_source s1 = {seq1, sizeof seq1 / sizeof seq1[0], 0};
    seq_source s2 = {always_4747, 1, 0};
    unsigned port = 0;
    saved_env sv;
    int i;

    env_save(&sv);
    CHECK(ah_itest_setenv("AGENTS_HUB_PORT", NULL) == AH_OK);

    CHECK(ah_itest_pick_port(seq_port, &s1, &port) == AH_OK);
    CHECK(port == 51234);
    CHECK(s1.next == 7);

    port = 0;
    CHECK(ah_itest_pick_port(seq_port, &s2, &port) == AH_ERR_LIMIT);
    CHECK(port == 0);
    CHECK(s2.next == AH_ITEST_PORT_ATTEMPTS);

    /* A fonte real (SO) nunca devolve 4747 pelo helper. */
    for (i = 0; i < 200; i++) {
        port = 0;
        CHECK(ah_itest_pick_port(NULL, NULL, &port) == AH_OK);
        CHECK(port != AH_ITEST_FORBIDDEN_PORT);
        CHECK(port >= 1024 && port <= 65535);
    }
    CHECK(ah_itest_pick_port(NULL, NULL, NULL) == AH_ERR_INVALID);
    env_restore(&sv);
}

static void test_pick_port_avoids_parent_port(void) {
    static const unsigned seq[] = {51234, 51235};
    seq_source s = {seq, 2, 0};
    unsigned port = 0;
    saved_env sv;

    env_save(&sv);
    CHECK(ah_itest_setenv("AGENTS_HUB_PORT", "51234") == AH_OK);
    CHECK(ah_itest_pick_port(seq_port, &s, &port) == AH_OK);
    CHECK(port == 51235);
    env_restore(&sv);
}

/* ------------------------------------------------------------ caminhos */

static void test_forbidden_paths(void) {
    char fake[1024];
    char p[1200];
    char real_home[4096];
    saved_env sv;

    env_save(&sv);
    /* Guarda o home real ANTES de falsificar o ambiente. */
#if defined(_WIN32)
    CHECK(ah_itest_getenv("USERPROFILE", real_home, sizeof real_home) == AH_OK);
#else
    CHECK(ah_itest_getenv("HOME", real_home, sizeof real_home) == AH_OK);
#endif

    scratch_dir(fake, sizeof fake, "perfil-falso");
    CHECK(ah_itest_setenv("USERPROFILE", fake) == AH_OK);
    CHECK(ah_itest_setenv("HOME", fake) == AH_OK);
    CHECK(ah_itest_setenv("AGENTS_HUB_HOME", NULL) == AH_OK);

    path_join(p, sizeof p, fake, ".agents-hub");
    CHECK(ah_itest_path_is_forbidden(p) == 1);
    path_join(p, sizeof p, fake, ".agents-hub" SEP "x" SEP "y");
    CHECK(ah_itest_path_is_forbidden(p) == 1);
    CHECK(ah_itest_path_is_forbidden(fake) == 1); /* contém ~/.agents-hub */
    path_join(p, sizeof p, fake, ".agents-hub-outro");
    CHECK(ah_itest_path_is_forbidden(p) == 0); /* prefixo de texto não é contenção */
    path_join(p, sizeof p, fake, "AppData");
    CHECK(ah_itest_path_is_forbidden(p) == 0);
    path_join(p, sizeof p, fake, ".agents-hub" SEP ".." SEP "fora");
    CHECK(ah_itest_path_is_forbidden(p) == 0); /* ".." é resolvido */
    path_join(p, sizeof p, fake, "x" SEP ".." SEP ".agents-hub");
    CHECK(ah_itest_path_is_forbidden(p) == 1);
#if defined(_WIN32)
    {
        /* Windows: caixa e separador não importam. */
        char upper[1200];
        size_t i;
        path_join(upper, sizeof upper, fake, ".AGENTS-HUB");
        for (i = 0; upper[i] != '\0'; i++) {
            if (upper[i] >= 'a' && upper[i] <= 'z') {
                upper[i] = (char)(upper[i] - 'a' + 'A');
            } else if (upper[i] == '\\') {
                upper[i] = '/';
            }
        }
        CHECK(ah_itest_path_is_forbidden(upper) == 1);
    }
#endif
    CHECK(ah_itest_path_is_forbidden("") == 1);
    CHECK(ah_itest_path_is_forbidden(NULL) == 1);

    /* O ~/.agents-hub REAL continua proibido mesmo com HOME/USERPROFILE
     * falsificados (perfil lido do SO: GetUserProfileDirectoryW/getpwuid). */
    path_join(p, sizeof p, real_home, ".agents-hub");
    CHECK(ah_itest_path_is_forbidden(p) == 1);
    path_join(p, sizeof p, real_home, ".agents-hub" SEP "agents-hub.db");
    CHECK(ah_itest_path_is_forbidden(p) == 1);

    /* AGENTS_HUB_HOME do pai também é proibido (pode ser o home do daemon real). */
    path_join(p, sizeof p, g_tmp, "home-do-pai");
    CHECK(ah_itest_setenv("AGENTS_HUB_HOME", p) == AH_OK);
    CHECK(ah_itest_path_is_forbidden(p) == 1);
    {
        char inside[1300];
        path_join(inside, sizeof inside, p, "sub");
        CHECK(ah_itest_path_is_forbidden(inside) == 1);
    }
    env_restore(&sv);
}

/* ------------------------------------------------------------ ambiente */

static void check_child_environ(const ah_itest_env *env, const char *expected_extra) {
    char **vars = NULL;
    size_t n = 0;
    size_t i;
    size_t hub = 0;
    int home_ok = 0;
    int port_ok = 0;
    int auto_ok = 0;
    int marca_ok = 0;
    int extra_ok = expected_extra == NULL;
    char want_home[4200];
    char want_port[64];
    ah_itest_spawn_opts opts = {NULL, 0, NULL, 0};
    const char *extra[1];

    CHECK(snprintf(want_home, sizeof want_home, "AGENTS_HUB_HOME=%s", ah_itest_env_home(env)) >
          0);
    CHECK(snprintf(want_port, sizeof want_port, "AGENTS_HUB_PORT=%u", ah_itest_env_port(env)) >
          0);
    if (expected_extra != NULL) {
        extra[0] = expected_extra;
        opts.extra_env = extra;
        opts.n_extra_env = 1;
    }
    CHECK(ah_itest_env_child_environ(env, &opts, &vars, &n) == AH_OK);
    for (i = 0; vars != NULL && i < n; i++) {
        if (starts_with(vars[i], "AGENTS_HUB_") || starts_with(vars[i], "agents_hub_")) {
            hub++;
        }
        home_ok += strcmp(vars[i], want_home) == 0;
        port_ok += strcmp(vars[i], want_port) == 0;
        auto_ok += strcmp(vars[i], "AGENTS_HUB_NO_AUTOSTART=1") == 0;
        marca_ok += strcmp(vars[i], "AH_ITEST_MARCA=herdada") == 0;
        if (expected_extra != NULL) {
            extra_ok += strcmp(vars[i], expected_extra) == 0;
        }
        CHECK(strcmp(vars[i], "AGENTS_HUB_PORT=4747") != 0);
        CHECK(!starts_with(vars[i], "AGENTS_HUB_URL="));
        CHECK(!starts_with(vars[i], "AGENTS_HUB_SESSION_ID="));
    }
    CHECK(vars != NULL && vars[n] == NULL);
    CHECK(hub == 3);
    CHECK(home_ok == 1);
    CHECK(port_ok == 1);
    CHECK(auto_ok == 1);
    CHECK(marca_ok == 1); /* o resto do ambiente é herdado */
    CHECK(extra_ok == 1); /* sem extra: começa em 1; com extra: exatamente uma vez */
    ah_itest_strv_free(vars);
}

static int run_probe(const ah_itest_env *env, const char *extra_env, const char *extra_arg) {
    char port[32];
    const char *args[3];
    const char *extra[1];
    ah_itest_spawn_opts opts;
    ah_itest_proc *proc = NULL;
    int code = -1;

    CHECK(snprintf(port, sizeof port, "%u", ah_itest_env_port(env)) > 0);
    args[0] = ah_itest_env_home(env);
    args[1] = port;
    args[2] = extra_arg;
    memset(&opts, 0, sizeof opts);
    opts.args = args;
    opts.nargs = extra_arg != NULL ? 3 : 2;
    if (extra_env != NULL) {
        extra[0] = extra_env;
        opts.extra_env = extra;
        opts.n_extra_env = 1;
    }
    CHECK(ah_itest_spawn(env, g_probe, &opts, &proc) == AH_OK);
    if (proc != NULL) {
        CHECK(ah_itest_proc_wait(proc, &code) == AH_OK);
        ah_itest_proc_free(proc);
    }
    return code;
}

static void test_env_basic_and_cleanup(void) {
    ah_itest_env *env = NULL;
    char err[512];
    char home_copy[4096];
    char sub[4200];
    char file[4300];
    FILE *f = NULL;

    CHECK(ah_itest_env_create(&env, err, sizeof err) == AH_OK);
    if (env == NULL) {
        fprintf(stderr, "  env_create: %s\n", err);
        return;
    }
    CHECK(ah_itest_env_port(env) != AH_ITEST_FORBIDDEN_PORT);
    CHECK(ah_itest_env_port(env) >= 1024 && ah_itest_env_port(env) <= 65535);
    CHECK(ah_itest_path_exists(ah_itest_env_home(env)));
    CHECK(starts_with(base_name(ah_itest_env_home(env)), "ah-itest-"));
    CHECK(ah_itest_path_is_forbidden(ah_itest_env_home(env)) == 0);
    CHECK(snprintf(home_copy, sizeof home_copy, "%s", ah_itest_env_home(env)) > 0);

    /* Conteúdo aninhado (como um serviço deixaria) some no destroy. */
    path_join(sub, sizeof sub, home_copy, "logs");
    CHECK(ah_itest_make_dir(sub) == AH_OK);
    path_join(file, sizeof file, sub, "hub.log");
#if defined(_MSC_VER)
    CHECK(fopen_s(&f, file, "wb") == 0);
#else
    f = fopen(file, "wb");
#endif
    CHECK(f != NULL);
    if (f != NULL) {
        CHECK(fputs("x\n", f) >= 0);
        CHECK(fclose(f) == 0);
    }
    CHECK(ah_itest_path_exists(file));

    CHECK(run_probe(env, NULL, NULL) == 0);

    CHECK(ah_itest_env_destroy(env) == AH_OK);
    CHECK(!ah_itest_path_exists(file));
    CHECK(!ah_itest_path_exists(home_copy));
    CHECK(ah_itest_env_destroy(NULL) == AH_OK);
    CHECK(ah_itest_env_home(NULL) == NULL);
}

static void test_hostile_parent_env(void) {
    char pai[1024];
    /* ASCII de propósito: no Windows o argv do main() vem na code page ANSI,
     * não em UTF-8 (a conversão é da camada de plataforma). Aspas, espaço e
     * barras invertidas (inclusive no fim) exercitam as regras de aspas. */
    char extra_arg[] = "AH_ITEST_EXTRA=valor com espaco, \"aspas\" e \\\"barra\\ no fim\\";
    saved_env sv;
    int i;

    env_save(&sv);
    scratch_dir(pai, sizeof pai, "home-do-pai-hostil");
    CHECK(ah_itest_setenv("AGENTS_HUB_HOME", pai) == AH_OK);
    CHECK(ah_itest_setenv("AGENTS_HUB_PORT", "4747") == AH_OK);
    CHECK(ah_itest_setenv("AGENTS_HUB_NO_AUTOSTART", "0") == AH_OK);
    CHECK(ah_itest_setenv("AGENTS_HUB_URL", "http://127.0.0.1:4747") == AH_OK);
    CHECK(ah_itest_setenv("AGENTS_HUB_SESSION_ID", "ses_real") == AH_OK);
    CHECK(ah_itest_setenv("AH_ITEST_MARCA", "herdada") == AH_OK);

    for (i = 0; i < 20; i++) {
        ah_itest_env *env = NULL;
        char err[512];
        CHECK(ah_itest_env_create(&env, err, sizeof err) == AH_OK);
        if (env == NULL) {
            fprintf(stderr, "  env_create: %s\n", err);
            break;
        }
        CHECK(ah_itest_env_port(env) != AH_ITEST_FORBIDDEN_PORT);
        CHECK(strcmp(ah_itest_env_home(env), pai) != 0);
        CHECK(!starts_with(ah_itest_env_home(env), pai));
        CHECK(ah_itest_path_is_forbidden(ah_itest_env_home(env)) == 0);
        check_child_environ(env, NULL);
        if (i == 0) {
            /* Dentro do filho: as três variáveis certas e nenhuma outra AGENTS_HUB_*. */
            CHECK(run_probe(env, NULL, NULL) == 0);
            check_child_environ(env, extra_arg);
            CHECK(run_probe(env, extra_arg, extra_arg) == 0);
            /* Controle negativo: o probe acusa variável extra errada. */
            CHECK(run_probe(env, NULL, extra_arg) == 16);
        }
        CHECK(ah_itest_env_destroy(env) == AH_OK);
    }
    env_restore(&sv);
}

static void test_extra_env_cannot_break_isolation(void) {
    static const char *const bad[] = {
        "AGENTS_HUB_HOME=/tmp/x", "AGENTS_HUB_PORT=4747", "AGENTS_HUB_NO_AUTOSTART=0",
        "AGENTS_HUB_URL=http://127.0.0.1:4747", "AGENTS_HUB_SESSION_ID=ses_real",
        "AGENTS_HUB_=x",
#if defined(_WIN32)
        "agents_hub_port=4747", "Agents_Hub_Home=C:\\x", "agents_hub_url=http://127.0.0.1:4747",
#endif
        "SEM_IGUAL", "=C:=C:\\"};
    ah_itest_env *env = NULL;
    char err[512];
    size_t i;

    CHECK(ah_itest_env_create(&env, err, sizeof err) == AH_OK);
    if (env == NULL) {
        return;
    }
    for (i = 0; i < sizeof bad / sizeof bad[0]; i++) {
        const char *extra[1];
        ah_itest_spawn_opts opts;
        char **vars = NULL;
        size_t n = 0;
        ah_itest_proc *proc = NULL;
        extra[0] = bad[i];
        memset(&opts, 0, sizeof opts);
        opts.extra_env = extra;
        opts.n_extra_env = 1;
        CHECK(ah_itest_env_child_environ(env, &opts, &vars, &n) == AH_ERR_INVALID);
        CHECK(vars == NULL);
        CHECK(ah_itest_spawn(env, g_probe, &opts, &proc) == AH_ERR_INVALID);
        CHECK(proc == NULL);
        ah_itest_strv_free(vars);
        /* Se o helper (com defeito) aceitar, não deixa filho vivo prendendo o home. */
        ah_itest_proc_free(proc);
    }
    CHECK(ah_itest_env_destroy(env) == AH_OK);
}

/* Diretório temporário do SO apontado para dentro de ~/.agents-hub (perfil
 * falso) ou do AGENTS_HUB_HOME do pai: o helper recusa ANTES de criar algo. */
static void set_temp(const char *dir) {
#if defined(_WIN32)
    CHECK(ah_itest_setenv("TMP", dir) == AH_OK);
    CHECK(ah_itest_setenv("TEMP", dir) == AH_OK);
#else
    CHECK(ah_itest_setenv("TMPDIR", dir) == AH_OK);
#endif
}

static void test_refuses_temp_in_forbidden_root(void) {
    char fake[1024];
    char agents[1200];
    char tmp_in[1300];
    char pai[1024];
    char ok_tmp[1024];
    char hub_real[1200];
    saved_env sv;
    ah_itest_env *env = NULL;
    char err[512];

    env_save(&sv);
    CHECK(ah_itest_setenv("AGENTS_HUB_HOME", NULL) == AH_OK);

    /* 1) TEMP em <perfil falso>/.agents-hub/tmp (que nem existe). */
    scratch_dir(fake, sizeof fake, "perfil-falso-2");
    CHECK(ah_itest_setenv("USERPROFILE", fake) == AH_OK);
    CHECK(ah_itest_setenv("HOME", fake) == AH_OK);
    path_join(agents, sizeof agents, fake, ".agents-hub");
    path_join(tmp_in, sizeof tmp_in, agents, "tmp");
    set_temp(tmp_in);
    err[0] = '\0';
    CHECK(ah_itest_env_create(&env, err, sizeof err) == AH_ERR_INVALID);
    CHECK(env == NULL);
    (void)ah_itest_env_destroy(env); /* no-op se recusou; limpa se o helper falhou */
    CHECK(strstr(err, "recusado") != NULL);
    CHECK(!ah_itest_path_exists(agents)); /* nada foi criado */
    env_restore(&sv);

    /* 2) TEMP dentro do AGENTS_HUB_HOME do pai. */
    env_save(&sv);
    scratch_dir(pai, sizeof pai, "hub-do-pai-3");
    CHECK(ah_itest_setenv("AGENTS_HUB_HOME", pai) == AH_OK);
    path_join(tmp_in, sizeof tmp_in, pai, "tmp");
    set_temp(tmp_in);
    env = NULL;
    CHECK(ah_itest_env_create(&env, err, sizeof err) == AH_ERR_INVALID);
    CHECK(env == NULL);
    (void)ah_itest_env_destroy(env); /* no-op se recusou; limpa se o helper falhou */
    CHECK(!ah_itest_path_exists(tmp_in));
    env_restore(&sv);

    /* 3) Controle positivo: AGENTS_HUB_HOME do pai em OUTRO lugar, dentro da
     *    base temporária. O helper funciona e não toca o home do pai. */
    env_save(&sv);
    scratch_dir(ok_tmp, sizeof ok_tmp, "tmp-ok");
    path_join(hub_real, sizeof hub_real, ok_tmp, "hub-real-do-pai");
    CHECK(ah_itest_setenv("AGENTS_HUB_HOME", hub_real) == AH_OK);
    set_temp(ok_tmp);
    env = NULL;
    CHECK(ah_itest_env_create(&env, err, sizeof err) == AH_OK);
    if (env != NULL) {
        CHECK(starts_with(base_name(ah_itest_env_home(env)), "ah-itest-"));
        CHECK(strstr(ah_itest_env_home(env), "tmp-ok") != NULL);
        CHECK(strstr(ah_itest_env_home(env), "hub-real-do-pai") == NULL);
        CHECK(run_probe(env, NULL, NULL) == 0);
        CHECK(ah_itest_env_destroy(env) == AH_OK);
    }
    CHECK(!ah_itest_path_exists(hub_real));
    env_restore(&sv);
}

/* ------------------------------------------------------------ links */

/* Diretório-sentinela do build com um arquivo; recriado a cada execução. */
static void make_sentinel(char *dir, size_t cap, char *file, size_t fcap, const char *name) {
    FILE *f = NULL;
    path_join(dir, cap, g_tmp, name);
    CHECK(ah_itest_remove_tree(dir) == AH_OK);
    CHECK(ah_itest_make_dir(dir) == AH_OK);
    path_join(file, fcap, dir, "vivo.txt");
#if defined(_MSC_VER)
    CHECK(fopen_s(&f, file, "wb") == 0);
#else
    f = fopen(file, "wb");
#endif
    CHECK(f != NULL);
    if (f != NULL) {
        CHECK(fputs("sentinela\n", f) >= 0);
        CHECK(fclose(f) == 0);
    }
}

/* Junção (Windows) / symlink (POSIX) e link de arquivo DENTRO do home,
 * apontando para um sentinela fora dele: o destroy remove os links e deixa o
 * sentinela intacto. */
static void test_destroy_does_not_follow_links(void) {
    char sent[1024];
    char sent_file[1200];
    char home[4096];
    char link[4200];
    char sub[4200];
    char link2[4300];
    char via[4400];
    char flink[4200];
    ah_itest_env *env = NULL;
    char err[512];
    ah_status fst;

    make_sentinel(sent, sizeof sent, sent_file, sizeof sent_file, "sentinela");
    CHECK(ah_itest_env_create(&env, err, sizeof err) == AH_OK);
    if (env == NULL) {
        return;
    }
    CHECK(snprintf(home, sizeof home, "%s", ah_itest_env_home(env)) > 0);

    path_join(link, sizeof link, home, "juncao");
    CHECK(ah_itest_make_link(link, sent, AH_ITEST_LINK_DIR) == AH_OK);
    path_join(via, sizeof via, link, "vivo.txt");
    CHECK(ah_itest_path_exists(via)); /* o link funciona: enxerga o sentinela */

    path_join(sub, sizeof sub, home, "sub");
    CHECK(ah_itest_make_dir(sub) == AH_OK);
    path_join(link2, sizeof link2, sub, "juncao-funda");
    CHECK(ah_itest_make_link(link2, sent, AH_ITEST_LINK_DIR) == AH_OK);

    path_join(flink, sizeof flink, home, "arquivo-link.txt");
    fst = ah_itest_make_link(flink, sent_file, AH_ITEST_LINK_FILE);
    if (fst != AH_OK) {
        /* Windows sem modo desenvolvedor/privilégio: o SO recusa o symlink. */
        printf("aviso: link simbólico de arquivo indisponível neste ambiente; "
               "parte do teste pulada (junções testadas)\n");
    } else {
        CHECK(ah_itest_path_exists(flink));
    }

    CHECK(ah_itest_env_destroy(env) == AH_OK);
    CHECK(!ah_itest_path_exists(home));
    CHECK(ah_itest_path_exists(sent));
    CHECK(ah_itest_path_exists(sent_file)); /* o alvo dos links sobreviveu */
}

/* TMP aponta para uma junção (Windows) / symlink (POSIX) cujo alvo é o
 * AGENTS_HUB_HOME do pai: o helper resolve o link e recusa. */
static void test_temp_link_into_parent_home(void) {
    char pai[1024];
    char pai_file[1200];
    char juncao[1024];
    char outro[1024];
    char outro_file[1200];
    saved_env sv;
    ah_itest_env *env = NULL;
    char err[512];

    make_sentinel(pai, sizeof pai, pai_file, sizeof pai_file, "hub-do-pai-via-juncao");
    path_join(juncao, sizeof juncao, g_tmp, "tmp-juncao-para-o-pai");
    CHECK(ah_itest_remove_tree(juncao) == AH_OK); /* remove só o link antigo */
    CHECK(ah_itest_make_link(juncao, pai, AH_ITEST_LINK_DIR) == AH_OK);

    /* 1) AGENTS_HUB_HOME = alvo real; TMP = junção para ele: recusa. */
    env_save(&sv);
    CHECK(ah_itest_setenv("AGENTS_HUB_HOME", pai) == AH_OK);
    set_temp(juncao);
    err[0] = '\0';
    CHECK(ah_itest_env_create(&env, err, sizeof err) == AH_ERR_INVALID);
    CHECK(env == NULL);
    (void)ah_itest_env_destroy(env); /* no-op se recusou; limpa se o helper falhou */
    CHECK(strstr(err, "recusado") != NULL);
    env_restore(&sv);

    /* 2) AGENTS_HUB_HOME = a junção; TMP = o alvo real: recusa (raiz resolvida). */
    env_save(&sv);
    CHECK(ah_itest_setenv("AGENTS_HUB_HOME", juncao) == AH_OK);
    set_temp(pai);
    env = NULL;
    CHECK(ah_itest_env_create(&env, err, sizeof err) == AH_ERR_INVALID);
    CHECK(env == NULL);
    (void)ah_itest_env_destroy(env); /* no-op se recusou; limpa se o helper falhou */
    env_restore(&sv);

    /* 3) Controle positivo: mesma junção como TMP, AGENTS_HUB_HOME em outro lugar. */
    env_save(&sv);
    make_sentinel(outro, sizeof outro, outro_file, sizeof outro_file, "hub-do-pai-outro");
    CHECK(ah_itest_setenv("AGENTS_HUB_HOME", outro) == AH_OK);
    set_temp(juncao);
    env = NULL;
    CHECK(ah_itest_env_create(&env, err, sizeof err) == AH_OK);
    if (env != NULL) {
        CHECK(run_probe(env, NULL, NULL) == 0);
        CHECK(ah_itest_env_destroy(env) == AH_OK);
    }
    env_restore(&sv);

    CHECK(ah_itest_remove_tree(juncao) == AH_OK);
    CHECK(!ah_itest_path_exists(juncao));
    CHECK(ah_itest_path_exists(pai_file)); /* remover a junção não tocou o alvo */
}

/* ------------------------------------------------------------ processos */

static void test_kill_and_free(void) {
    ah_itest_env *env = NULL;
    char err[512];
    const char *args[1] = {"--bloquear"};
    ah_itest_spawn_opts opts = {args, 1, NULL, 0};
    ah_itest_proc *proc = NULL;
    int code = 0;
    char home_copy[4096];

    CHECK(ah_itest_env_create(&env, err, sizeof err) == AH_OK);
    if (env == NULL) {
        return;
    }
    CHECK(snprintf(home_copy, sizeof home_copy, "%s", ah_itest_env_home(env)) > 0);

    CHECK(ah_itest_spawn(env, g_probe, &opts, &proc) == AH_OK);
    if (proc != NULL) {
        CHECK(ah_itest_proc_kill(proc) == AH_OK);
        CHECK(ah_itest_proc_wait(proc, &code) == AH_OK);
        CHECK(code != 0);
        CHECK(ah_itest_proc_kill(proc) == AH_OK); /* já morto: sem erro */
        ah_itest_proc_free(proc);
    }

    /* proc_free num filho vivo encerra e espera (não trava). */
    proc = NULL;
    CHECK(ah_itest_spawn(env, g_probe, &opts, &proc) == AH_OK);
    ah_itest_proc_free(proc);
    ah_itest_proc_free(NULL);

    /* Executável inexistente: erro no spawn (Windows) ou saída 127 (POSIX). */
    {
        char missing[4200];
        path_join(missing, sizeof missing, home_copy, "nao-existe.exe");
        proc = NULL;
        if (ah_itest_spawn(env, missing, NULL, &proc) == AH_OK) {
            CHECK(proc != NULL);
            if (proc != NULL) {
                CHECK(ah_itest_proc_wait(proc, &code) == AH_OK);
                CHECK(code == 127);
                ah_itest_proc_free(proc);
            }
        } else {
            CHECK(proc == NULL);
        }
    }

    /* Com o filho morto, o home (que era o cwd dele) é removido. */
    CHECK(ah_itest_env_destroy(env) == AH_OK);
    CHECK(!ah_itest_path_exists(home_copy));
}

int main(int argc, char **argv) {
    if (argc != 3) {
        fprintf(stderr, "uso: %s <itest_probe> <dir temporário>\n", argv[0]);
        return 2;
    }
    g_probe = argv[1];
    g_tmp = argv[2];

    test_pick_port_rejects_4747();
    test_pick_port_avoids_parent_port();
    test_forbidden_paths();
    test_env_basic_and_cleanup();
    test_hostile_parent_env();
    test_extra_env_cannot_break_isolation();
    test_refuses_temp_in_forbidden_root();
    test_kill_and_free();
    test_destroy_does_not_follow_links();
    test_temp_link_into_parent_home();
    return AH_TEST_END("test_itest_isolation");
}
