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

/* Junção (e link de arquivo, se o SO deixar) DENTRO de um AGENTS_HUB_HOME
 * falso, apontando para fora: a entrada continua proibida e remove_tree recusa
 * sem apagar nada (regressão achada na revisão do 5ecb6d8). */
static void test_link_inside_forbidden_root(void) {
    char hub[1024];
    char hub_file[1200];
    char fora[1024];
    char fora_file[1200];
    char lnk[1200];
    char flnk[1200];
    char via[1300];
    int have_file_link;
    saved_env sv;

    make_sentinel(hub, sizeof hub, hub_file, sizeof hub_file, "fakehub-links");
    make_sentinel(fora, sizeof fora, fora_file, sizeof fora_file, "fora-links");
    path_join(lnk, sizeof lnk, hub, "lnk");
    CHECK(ah_itest_make_link(lnk, fora, AH_ITEST_LINK_DIR) == AH_OK);
    path_join(flnk, sizeof flnk, hub, "flnk.txt");
    have_file_link = ah_itest_make_link(flnk, fora_file, AH_ITEST_LINK_FILE) == AH_OK;
    if (!have_file_link) {
        printf("aviso: link simbólico de arquivo indisponível; só a junção testada\n");
    }

    env_save(&sv);
    CHECK(ah_itest_setenv("AGENTS_HUB_HOME", hub) == AH_OK);
    CHECK(ah_itest_path_is_forbidden(hub) == 1);
    CHECK(ah_itest_path_is_forbidden(lnk) == 1);
    CHECK(ah_itest_remove_tree(lnk) == AH_ERR_INVALID);
    path_join(via, sizeof via, lnk, "vivo.txt");
    CHECK(ah_itest_path_exists(lnk));
    CHECK(ah_itest_path_exists(via));
    if (have_file_link) {
        CHECK(ah_itest_path_is_forbidden(flnk) == 1);
        CHECK(ah_itest_remove_tree(flnk) == AH_ERR_INVALID);
        CHECK(ah_itest_path_exists(flnk));
    }
    CHECK(ah_itest_remove_tree(hub) == AH_ERR_INVALID);
    CHECK(ah_itest_path_exists(hub_file));
    env_restore(&sv);

    /* Sem o AGENTS_HUB_HOME apontando para lá, a limpeza do scratch remove só
     * os links; o alvo de fora fica. */
    CHECK(ah_itest_remove_tree(hub) == AH_OK);
    CHECK(!ah_itest_path_exists(hub));
    CHECK(ah_itest_path_exists(fora_file));
}

/* remove_tree só age dentro do diretório de teste registrado ou de um home
 * ah-itest-* da base temporária. */
static void test_remove_tree_scope(void) {
    char outside[1200];
    char inside[1200];
    char home_sub[4200];
    ah_itest_env *env = NULL;
    char err[512];
    const char *last;
    size_t lp;

    /* Irmão do diretório de teste (no build, fora do escopo registrado). */
    last = base_name(g_tmp);
    lp = (size_t)(last - g_tmp);
    CHECK(lp > 0 && lp < sizeof outside);
    if (lp == 0 || lp >= sizeof outside) {
        return;
    }
    memcpy(outside, g_tmp, lp);
    outside[lp] = '\0';
    CHECK(snprintf(outside + lp, sizeof outside - lp, "%s", "fora-do-escopo-itest") > 0);
    if (!ah_itest_path_exists(outside)) {
        CHECK(ah_itest_make_dir(outside) == AH_OK);
    }
    CHECK(ah_itest_remove_tree(outside) == AH_ERR_INVALID);
    CHECK(ah_itest_path_exists(outside)); /* nada tocado */
    /* Mesmo inexistente, fora do escopo é recusa (não "AH_OK, já não existe"). */
    path_join(inside, sizeof inside, outside, "nao-existe");
    CHECK(ah_itest_remove_tree(inside) == AH_ERR_INVALID);

    /* O próprio diretório de teste não é removível; o que está dentro, sim. */
    CHECK(ah_itest_remove_tree(g_tmp) == AH_ERR_INVALID);
    path_join(inside, sizeof inside, g_tmp, "escopo-dentro");
    CHECK(ah_itest_remove_tree(inside) == AH_OK);
    CHECK(ah_itest_make_dir(inside) == AH_OK);
    CHECK(ah_itest_remove_tree(inside) == AH_OK);
    CHECK(!ah_itest_path_exists(inside));

    /* Sem diretório registrado, o mesmo caminho dentro do build é recusado. */
    CHECK(ah_itest_make_dir(inside) == AH_OK);
    CHECK(ah_itest_set_test_dir(NULL) == AH_OK);
    CHECK(ah_itest_remove_tree(inside) == AH_ERR_INVALID);
    CHECK(ah_itest_path_exists(inside));
    CHECK(ah_itest_set_test_dir(g_tmp) == AH_OK);
    CHECK(ah_itest_remove_tree(inside) == AH_OK);

    /* Dentro de um home ah-itest-* da base temporária: permitido. */
    CHECK(ah_itest_env_create(&env, err, sizeof err) == AH_OK);
    if (env != NULL) {
        path_join(home_sub, sizeof home_sub, ah_itest_env_home(env), "sub");
        CHECK(ah_itest_make_dir(home_sub) == AH_OK);
        CHECK(ah_itest_remove_tree(home_sub) == AH_OK);
        CHECK(!ah_itest_path_exists(home_sub));
        CHECK(ah_itest_env_destroy(env) == AH_OK);
    }

    /* Registrar diretório inexistente ou proibido é recusado. */
    path_join(inside, sizeof inside, g_tmp, "nao-existe-registro");
    CHECK(ah_itest_set_test_dir(inside) == AH_ERR_INVALID);
    CHECK(ah_itest_set_test_dir(g_tmp) == AH_OK);
}

/* Caminho relativo nunca é aceito pelo remove_tree, nem com o cwd dentro do
 * diretório de teste (o CTest roda este teste com cwd = itest-tmp). Um
 * sentinela no cwd prova que nada foi apagado. */
static void test_remove_tree_relative_refused(void) {
    char sent[1024];
    char sent_file[1200];
    char drive_dot[8];
    char drive_name[64];

    make_sentinel(sent, sizeof sent, sent_file, sizeof sent_file, "sentinela-relativo");
#if defined(_WIN32)
    /* Drive relativo: "Q:." (drive provavelmente inexistente) e "<drive do
     * cwd>:." / "<drive>:nome", que o SO resolveria no cwd do drive. */
    CHECK(ah_itest_remove_tree("Q:.") == AH_ERR_INVALID);
    CHECK(ah_itest_remove_tree("Q:nome") == AH_ERR_INVALID);
    CHECK(g_tmp[0] != '\0' && g_tmp[1] == ':');
    drive_dot[0] = g_tmp[0];
    drive_dot[1] = ':';
    drive_dot[2] = '.';
    drive_dot[3] = '\0';
    CHECK(ah_itest_remove_tree(drive_dot) == AH_ERR_INVALID);
    CHECK(snprintf(drive_name, sizeof drive_name, "%c:sentinela-relativo", g_tmp[0]) > 0);
    CHECK(ah_itest_remove_tree(drive_name) == AH_ERR_INVALID);
    CHECK(ah_itest_remove_tree("\\sentinela-relativo") == AH_ERR_INVALID); /* raiz do drive atual */
#else
    (void)drive_dot;
    (void)drive_name;
#endif
    CHECK(ah_itest_remove_tree(".") == AH_ERR_INVALID);
    CHECK(ah_itest_remove_tree("sentinela-relativo") == AH_ERR_INVALID);
    CHECK(ah_itest_remove_tree("." SEP "sentinela-relativo") == AH_ERR_INVALID);
    CHECK(ah_itest_path_exists(sent_file));
    CHECK(ah_itest_remove_tree(sent) == AH_OK); /* absoluto, no escopo: aceito */
}

/* "<testdir>/x/lnk/" com barra final, lnk apontando para fora do link: só o
 * link some; o conteúdo do alvo sobrevive (POSIX: sem a normalização,
 * lstat/nftw seguiriam o link por causa da barra). */
static void test_remove_tree_trailing_separator(void) {
    char alvo[1024];
    char alvo_file[1200];
    char dir[1024];
    char dir_file[1200];
    char lnk[1200];
    char lnk_slash[1300];

    make_sentinel(alvo, sizeof alvo, alvo_file, sizeof alvo_file, "alvo-barra-final");
    make_sentinel(dir, sizeof dir, dir_file, sizeof dir_file, "dir-barra-final");
    path_join(lnk, sizeof lnk, dir, "lnk");
    CHECK(ah_itest_make_link(lnk, alvo, AH_ITEST_LINK_DIR) == AH_OK);
    CHECK(snprintf(lnk_slash, sizeof lnk_slash, "%s" SEP, lnk) > 0);

    CHECK(ah_itest_remove_tree(lnk_slash) == AH_OK);
    CHECK(!ah_itest_path_exists(lnk));
    CHECK(ah_itest_path_exists(alvo_file));
    CHECK(ah_itest_path_exists(dir_file));
#if defined(_WIN32)
    /* Barra '/' final e várias barras também. */
    CHECK(ah_itest_make_link(lnk, alvo, AH_ITEST_LINK_DIR) == AH_OK);
    CHECK(snprintf(lnk_slash, sizeof lnk_slash, "%s//", lnk) > 0);
    CHECK(ah_itest_remove_tree(lnk_slash) == AH_OK);
    CHECK(!ah_itest_path_exists(lnk));
    CHECK(ah_itest_path_exists(alvo_file));
#endif
    CHECK(ah_itest_remove_tree(dir) == AH_OK);
    CHECK(ah_itest_remove_tree(alvo) == AH_OK);
}

#if defined(_WIN32)
/* "<prefixo><D>$\resto" a partir de "D:\resto" ou "D:/resto". */
static int unc_of(char *out, size_t cap, const char *prefix, const char *drive_path) {
    int n;
    size_t i;
    if (!(drive_path[0] != '\0' && drive_path[1] == ':' &&
          (drive_path[2] == '/' || drive_path[2] == '\\'))) {
        return 0;
    }
    n = snprintf(out, cap, "%s%c$\\%s", prefix, drive_path[0], drive_path + 3);
    if (n < 0 || (size_t)n >= cap) {
        return 0;
    }
    for (i = 0; out[i] != '\0'; i++) {
        if (out[i] == '/') {
            out[i] = '\\';
        }
    }
    return 1;
}

/* TMP por UNC local (share administrativo) que leva ao AGENTS_HUB_HOME do
 * pai: recusado. UNC em geral é recusado (fail closed). */
static void test_unc_temp_refused(void) {
    static const char *const prefixes[] = {"\\\\localhost\\", "\\\\?\\UNC\\localhost\\",
                                           "\\\\127.0.0.1\\"};
    char hub[1024];
    char hub_file[1200];
    char livre[1024];
    char livre_file[1200];
    char ok_tmp[1024];
    char unc[1400];
    char unc_sub[1500];
    saved_env sv;
    ah_itest_env *env = NULL;
    char err[512];
    size_t k;

    make_sentinel(hub, sizeof hub, hub_file, sizeof hub_file, "fakehub-unc");
    make_sentinel(livre, sizeof livre, livre_file, sizeof livre_file, "tmp-unc-livre");
    CHECK(unc_of(unc, sizeof unc, prefixes[0], hub));
    if (!ah_itest_path_exists(unc)) {
        printf("aviso: share administrativo %c$ indisponível via \\\\localhost; "
               "casos UNC pulados\n",
               hub[0]);
        return;
    }

    env_save(&sv);
    CHECK(ah_itest_setenv("AGENTS_HUB_HOME", hub) == AH_OK);
    for (k = 0; k < sizeof prefixes / sizeof prefixes[0]; k++) {
        CHECK(unc_of(unc, sizeof unc, prefixes[k], hub));
        if (!ah_itest_path_exists(unc)) {
            printf("aviso: %s... não acessível; caso pulado\n", prefixes[k]);
            continue;
        }
        CHECK(ah_itest_path_is_forbidden(unc) == 1);
        CHECK(snprintf(unc_sub, sizeof unc_sub, "%s\\x", unc) > 0);
        CHECK(ah_itest_path_is_forbidden(unc_sub) == 1);
        set_temp(unc);
        env = NULL;
        err[0] = '\0';
        CHECK(ah_itest_env_create(&env, err, sizeof err) == AH_ERR_INVALID);
        if (env != NULL) {
            fprintf(stderr, "  UNC aceito como TMP: %s -> %s\n", unc, ah_itest_env_home(env));
        }
        CHECK(env == NULL);
        (void)ah_itest_env_destroy(env);
    }
    env_restore(&sv);

    /* Fail closed: UNC para um diretório sem relação com raiz alguma também é
     * recusado. */
    env_save(&sv);
    CHECK(ah_itest_setenv("AGENTS_HUB_HOME", NULL) == AH_OK);
    CHECK(unc_of(unc, sizeof unc, prefixes[0], livre));
    set_temp(unc);
    env = NULL;
    CHECK(ah_itest_env_create(&env, err, sizeof err) == AH_ERR_INVALID);
    CHECK(env == NULL);
    (void)ah_itest_env_destroy(env);
    env_restore(&sv);

    /* Controle: TMP normal (letra de drive) funciona. */
    env_save(&sv);
    scratch_dir(ok_tmp, sizeof ok_tmp, "tmp-unc-controle");
    CHECK(ah_itest_setenv("AGENTS_HUB_HOME", hub) == AH_OK);
    set_temp(ok_tmp);
    env = NULL;
    CHECK(ah_itest_env_create(&env, err, sizeof err) == AH_OK);
    if (env != NULL) {
        CHECK(run_probe(env, NULL, NULL) == 0);
        CHECK(ah_itest_env_destroy(env) == AH_OK);
    }
    env_restore(&sv);
    CHECK(ah_itest_path_exists(hub_file));
    CHECK(ah_itest_remove_tree(hub) == AH_OK);
    CHECK(ah_itest_remove_tree(livre) == AH_OK);
}

/* Roda icacls.exe (System32) pelo próprio helper; devolve o código de saída
 * ou -1 se não subiu. */
static int run_icacls(const ah_itest_env *tool, const char *target, const char *op,
                      const char *arg) {
    char sysroot[512];
    char exe[600];
    const char *args[3];
    ah_itest_spawn_opts opts;
    ah_itest_proc *proc = NULL;
    int code = -1;

    if (ah_itest_getenv("SystemRoot", sysroot, sizeof sysroot) != AH_OK ||
        snprintf(exe, sizeof exe, "%s\\System32\\icacls.exe", sysroot) <= 0) {
        return -1;
    }
    args[0] = target;
    args[1] = op;
    args[2] = arg;
    memset(&opts, 0, sizeof opts);
    opts.args = args;
    opts.nargs = 3;
    if (ah_itest_spawn(tool, exe, &opts, &proc) != AH_OK) {
        return -1;
    }
    if (ah_itest_proc_wait(proc, &code) != AH_OK) {
        code = -1;
    }
    ah_itest_proc_free(proc);
    return code;
}

/* Acesso negado não pode virar "não existe" (fail-open). Montagem do poc7 do
 * revisor: AGENTS_HUB_HOME=<root>/fakehub, junção <td>/acl-J -> fakehub,
 * deny RA no fakehub e deny RD no root. As ACLs são desfeitas sempre no fim
 * (e no começo, se uma execução anterior foi interrompida). */
static void test_access_denied_refused(void) {
    char root[1024];
    char hub[1200];
    char j[1024];
    char novo[1300];
    char user[256];
    char dom[256];
    char who[600];
    char deny_ra[700];
    char deny_rd[700];
    ah_itest_env *tool = NULL;
    ah_itest_env *env = NULL;
    char err[512];
    saved_env sv;

    if (ah_itest_getenv("USERNAME", user, sizeof user) != AH_OK) {
        printf("aviso: USERNAME indisponível; teste de ACL pulado\n");
        return;
    }
    if (ah_itest_getenv("USERDOMAIN", dom, sizeof dom) == AH_OK) {
        CHECK(snprintf(who, sizeof who, "%s\\%s", dom, user) > 0);
    } else {
        CHECK(snprintf(who, sizeof who, "%s", user) > 0);
    }
    CHECK(snprintf(deny_ra, sizeof deny_ra, "%s:(RA)", who) > 0);
    CHECK(snprintf(deny_rd, sizeof deny_rd, "%s:(RD)", who) > 0);

    CHECK(ah_itest_env_create(&tool, err, sizeof err) == AH_OK);
    if (tool == NULL) {
        return;
    }
    path_join(root, sizeof root, g_tmp, "acl-root");
    path_join(hub, sizeof hub, root, "fakehub");
    path_join(j, sizeof j, g_tmp, "acl-J");
    /* Limpeza de uma execução anterior interrompida. Ordem: primeiro o root
     * (com deny RD nele, o icacls não processa o fakehub), depois o fakehub. */
    if (ah_itest_path_exists(root)) {
        (void)run_icacls(tool, root, "/remove:d", who);
    }
    if (ah_itest_path_exists(hub)) {
        (void)run_icacls(tool, hub, "/remove:d", who);
    }
    CHECK(ah_itest_remove_tree(j) == AH_OK);
    CHECK(ah_itest_remove_tree(root) == AH_OK);
    CHECK(ah_itest_make_dir(root) == AH_OK);
    CHECK(ah_itest_make_dir(hub) == AH_OK);
    CHECK(ah_itest_make_link(j, hub, AH_ITEST_LINK_DIR) == AH_OK);
    path_join(novo, sizeof novo, j, "novo");

    env_save(&sv);
    CHECK(ah_itest_setenv("AGENTS_HUB_HOME", hub) == AH_OK);

    /* Sem deny: recusado, como antes. */
    CHECK(ah_itest_path_is_forbidden(j) == 1);
    CHECK(ah_itest_path_is_forbidden(novo) == 1);
    CHECK(ah_itest_remove_tree(novo) == AH_ERR_INVALID);
    set_temp(j);
    env = NULL;
    CHECK(ah_itest_env_create(&env, err, sizeof err) == AH_ERR_INVALID);
    CHECK(env == NULL);
    (void)ah_itest_env_destroy(env);

    /* Com deny: continua recusado (antes: forbidden 0 e home criado). */
    if (run_icacls(tool, hub, "/deny", deny_ra) == 0 &&
        run_icacls(tool, root, "/deny", deny_rd) == 0) {
        CHECK(ah_itest_path_is_forbidden(j) == 1);
        CHECK(ah_itest_path_is_forbidden(novo) == 1);
        CHECK(ah_itest_remove_tree(novo) == AH_ERR_INVALID);
        env = NULL;
        CHECK(ah_itest_env_create(&env, err, sizeof err) == AH_ERR_INVALID);
        if (env != NULL) {
            fprintf(stderr, "  acesso negado aceito: home %s\n", ah_itest_env_home(env));
        }
        CHECK(env == NULL);
        (void)ah_itest_env_destroy(env);
    } else {
        printf("aviso: icacls não aplicou o deny; parte com ACL pulada\n");
    }
    env_restore(&sv);

    /* Desfaz as ACLs SEMPRE, antes de qualquer outra coisa (root primeiro). */
    CHECK(run_icacls(tool, root, "/remove:d", who) == 0);
    CHECK(run_icacls(tool, hub, "/remove:d", who) == 0);
    CHECK(ah_itest_dir_entry_count(hub) == 0); /* nada foi criado no fakehub */
    CHECK(ah_itest_remove_tree(j) == AH_OK);
    CHECK(ah_itest_remove_tree(root) == AH_OK);
    CHECK(!ah_itest_path_exists(root));
    CHECK(ah_itest_env_destroy(tool) == AH_OK);
}

/* ':' depois da letra de drive (fluxo alternativo / $INDEX_ALLOCATION) é
 * recusado antes de chegar ao NTFS. */
static void test_alternate_stream_refused(void) {
    char p[1200];
    path_join(p, sizeof p, g_tmp, "..::$INDEX_ALLOCATION");
    CHECK(ah_itest_remove_tree(p) == AH_ERR_INVALID);
    CHECK(ah_itest_path_is_forbidden(p) == 1);
    path_join(p, sizeof p, g_tmp, "x:fluxo");
    CHECK(ah_itest_remove_tree(p) == AH_ERR_INVALID);
    CHECK(ah_itest_path_is_forbidden(p) == 1);
    path_join(p, sizeof p, g_tmp, "x::$DATA");
    CHECK(ah_itest_remove_tree(p) == AH_ERR_INVALID);
    CHECK(ah_itest_path_exists(g_tmp));
}
#endif

static void test_make_link_relative_target_refused(void) {
    char link[1200];
    path_join(link, sizeof link, g_tmp, "link-relativo");
    CHECK(ah_itest_make_link(link, "relativo", AH_ITEST_LINK_DIR) == AH_ERR_INVALID);
    CHECK(ah_itest_make_link(link, "." SEP "sub", AH_ITEST_LINK_FILE) == AH_ERR_INVALID);
    CHECK(!ah_itest_path_exists(link));
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
    /* Único lugar (além dos homes ah-itest-*) onde ah_itest_remove_tree age. */
    if (ah_itest_set_test_dir(g_tmp) != AH_OK) {
        fprintf(stderr, "não registrou o diretório de teste %s\n", g_tmp);
        return 2;
    }

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
    test_link_inside_forbidden_root();
    test_remove_tree_scope();
    test_make_link_relative_target_refused();
    test_remove_tree_relative_refused();
    test_remove_tree_trailing_separator();
#if defined(_WIN32)
    test_unc_temp_refused();
    test_alternate_stream_refused();
    test_access_denied_refused();
#endif
    CHECK(ah_itest_set_test_dir(NULL) == AH_OK);
    return AH_TEST_END("test_itest_isolation");
}
