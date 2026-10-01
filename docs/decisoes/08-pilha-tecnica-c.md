# ADR 08 — Pilha técnica e metas de desempenho da reescrita em C (decidido em 2026-09-30)

> Complementa o [ADR 07](07-reescrita-nativa.md) e resolve o que ele deixou em aberto sobre
> biblioteca de UI, instalador, atualização, pilha C e metas numéricas. As opções vieram de
> duas pesquisas com fonte por afirmação. As afirmações que decidem a escolha foram
> reconferidas na fonte primária: 72 checadas, 67 confirmadas, 3 incorretas sem efeito na
> escolha, 2 não confirmáveis. Versões e licenças: estado em 2026-09-30. Marca ⚠ = fato
> sustentado só pela pesquisa, não reconferido.

## Decisões do dono

| # | Camada | Escolha | Licença |
|---|---|---|---|
| 8.1 | Padrão da linguagem | **C17** | — |
| 8.2 | Compiladores | **MSVC** no release Windows; **clang-cl** num job de CI com **ASan + UBSan**; **GCC e Clang** no Linux | — |
| 8.3 | Build | **CMake + Ninja** | CMake BSD-3; Ninja Apache-2.0 |
| 8.4 | Interface | **SDL3 + SDL_ttf + Clay**, com widgets próprios | Zlib (os três) |
| 8.5 | Banco | **SQLite 3.53** | domínio público |
| 8.6 | Servidor HTTP | **Próprio**, sobre **picohttpparser** | MIT ou Perl |
| 8.7 | JSON | **cJSON** | MIT |
| 8.8 | YAML | **libyaml** | MIT |
| 8.9 | Regex | **PCRE2** | BSD-3 com exceção PCRE2 |
| 8.10 | Assinatura da atualização | **Monocypher** (Ed25519) | BSD-2 ou CC0 |
| 8.11 | Download HTTPS | **WinHTTP** no Windows; **libcurl** no Linux | do SO / ⚠ estilo MIT |
| 8.12 | Instalador Windows | **Inno Setup**, por usuário | licença própria, uso comercial permitido |
| 8.13 | Atualizador | **Próprio**, via **GitHub Releases** | — |
| 8.14 | Linux | **AppImage** compilado no **Ubuntu 22.04** | — |

### Metas de desempenho (decididas pelo dono; linha de base em [especificação 06](../especificacao/06-desempenho-linha-de-base-e-metas.md))

| Métrica | Meta |
|---|---|
| RAM do serviço parado | ≤ 15 MB |
| Início do serviço | ≤ 150 ms |
| Hook do gate | ≤ 30 ms |
| MCP server | início ≤ 50 ms; RAM ≤ 10 MB |
| Tamanho instalado | ≤ 20 MB |
| Vazão de eventos | ≥ 5.000 eventos/s |
| CPU do serviço parado | ≈ 0 |

## Fatos que motivaram as escolhas (conferidos)

- **SQLite 3.53 lê o banco atual:** colunas geradas exigem ≥ 3.31 e o JSON embutido ≥ 3.38;
  o esquema atual usa os dois (`packages/store/src/migrations.ts:255-264`).
- **HTTP:** mongoose é GPLv2 ou licença comercial: usá-lo exigiria distribuir o Hub (hoje MIT) sob
  GPLv2 ou pagar a licença comercial.
  O civetweb não tem release desde 2023 (v1.16) nem API de SSE.
- **libyaml:** segue o YAML 1.1, mas o parser aceita `%YAML 1.2` desde a 0.2.3 e entrega
  escalares sem tag como texto. A tipagem (`yes`/`no`, octais) fica no código do Hub.
- **Monocypher:** tem Ed25519 (arquivos opcionais) e SHA-512, mas não SHA-256.
- **MSVC:** tem ASan, mas não UBSan.
- **Instalador:** o Inno Setup instala sem admin com `PrivilegesRequired=lowest`. Sem assinatura
  (ADR 7.14), o MSIX só instala no Windows 11 com `-AllowUnsigned`, exige admin quando o pacote tem
  executável (o caso do Hub) e não serve para distribuição ampla. O WiX v7 exige aceitar o EULA
  da OSMF.
- **Tray:** `SDL_CreateTray` existe desde o SDL 3.2.0 e só pode ser chamado na thread principal.

## Consequências técnicas propostas (não decididas pelo dono; confirmar no plano)

- ⚠ No MSVC, C17 sem VLA e com `<stdatomic.h>` experimental. Proposta: não usar nenhum dos dois.
- ⚠ CMake com versão mínima entre 3.21 e 3.31 (os runners do GitHub trazem 4.4.3 no Windows e
  3.31.6 no Ubuntu 24.04, confirmado; Ninja 1.13.2 confirmado só no runner Windows).
- ⚠ Laço de UI que redesenha só sob evento (`SDL_WaitEvent`), para a meta de CPU parado ≈ 0.
- Manifesto de atualização assinado com Ed25519 e hash SHA-512 (o Monocypher não tem
  SHA-256). Proposta de fonte: o arquivo em `/releases/latest/download/` do GitHub.
- ⚠ AppImage montado com linuxdeploy + appimagetool.

## Riscos aceitos

- **Interface (8.4):** tabela, árvore, editor de texto, modais, foco e IME serão escritos
  pelo projeto. A acessibilidade fica fraca: o SDL não tem suporte a leitor de tela, e o
  caminho conhecido (AccessKit-C) é uma camada C sobre código Rust. O
  [inventário do painel](../especificacao/05-painel-inventario.md) dá a dimensão: 198
  controles.
- **Tray no Linux:** no SDL 3.2.0–3.4.16 o tray carrega `libayatana-appindicator3` ou
  `libappindicator3` (GTK3) por dlopen, e falha se nenhuma das duas estiver instalada. O
  `main` do SDL (3.5, ainda sem release) troca isso por StatusNotifierItem via D-Bus.
  ⚠ No GNOME, o tray só aparece com a extensão AppIndicator (o Ubuntu a traz por padrão).
- **Troca do executável em uso no Windows:** renomear o `.exe` em execução funciona segundo
  relatos de usuários, sem confirmação oficial da Microsoft. O `MOVEFILE_DELAY_UNTIL_REBOOT`
  exige admin.
- **API anônima do GitHub:** 60 requisições por hora por IP. Não há documentação oficial de
  que o redirect `/releases/latest/download` fica fora dessa cota.
- **Manutenção:** a libyaml não tem release desde 2020 (0.2.5); os commits seguem até 2026.

## Em aberto

- Cofre de segredos no Linux sem keyring (Secret Service ausente): política não decidida.
- Shaping de texto (HarfBuzz pelo SDL_ttf) e emoji colorido (plutosvg): confirmar no primeiro
  protótipo de UI.
- Proxy corporativo no WinHTTP e caminho dos certificados da libcurl dentro do AppImage: não
  verificados.
- Procedimento de medição das metas: será definido no plano da reescrita.
