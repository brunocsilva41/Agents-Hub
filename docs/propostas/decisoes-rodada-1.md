# Rodada 1 de decisões — recomendações do coordenador

> As 45 divergências (DV) e 29 decisões abertas (DA) do [plano](../17-plano-reescrita-c.md), §2 e
> §3, agrupadas por tema, com a **recomendação do coordenador** para cada uma. Nada aqui está
> decidido: o dono aceita o tema inteiro, ou abre item a item. A fonte de cada item está na tabela
> do plano. Inclui o achado S6 da proposta F7-01, que ainda não tem número de DV.

## Tema A — Segurança: corrigir no C o que a SPEC-08 recomenda

Princípio: o C é uma reescrita do zero; reproduzir uma fraqueza conhecida custa o mesmo que
corrigi-la. Todas as correções abaixo foram propostas pelo modelo de ameaças
([SPEC-08](../especificacao/08-modelo-de-ameacas-c.md)) e revisadas.

| Item | O que muda | Recomendação |
|---|---|---|
| S6 (novo) | `GET /projects/:id/context` devolve as chaves de API sem token; outro usuário do SO as lê | **Corrigir**: sem token, devolver só os nomes das variáveis; com token, os valores |
| DV-28 | Recusar todo `Origin` e `Sec-Fetch-Site` ≠ `none` em método que muda estado (não há mais painel web) | Corrigir |
| DV-29 | Recusar `host` não loopback no `config.json` | Corrigir |
| DV-30 | Conferir que quem conecta é o mesmo usuário do SO | Corrigir |
| DV-31 | Cliente confere o dono do socket antes de mandar o token; `SO_EXCLUSIVEADDRUSE` | Corrigir |
| DV-32 | Token de operador com DACL por SID, reconferida a cada subida | Corrigir |
| DV-33 | Pasta 0700, arquivos 0600, `umask(077)` | Corrigir |
| DV-34 | Sanear sequências ANSI/OSC do texto do agente no terminal | Corrigir |
| DV-35 | Limpeza do env antigo (secure_delete → VACUUM → checkpoint) na migração | Corrigir (detalhe na proposta F7-01) |
| DV-36 | Pasta de instalação e locais de autostart como caminhos sensíveis; `reg add …\Run` irreversível | Corrigir |
| DV-37 | Job Object por sessão no Windows em vez de `taskkill /T` | Corrigir |
| DV-38, DV-39, DV-40 | HTTP: 400 para cabeçalho ambíguo, 414/431 para limites, `Host` com caracteres válidos | Corrigir |
| DA-26 | Fuzzing (FZ01–FZ15) e flags de endurecimento no release | Adotar (fuzz curto no PR, longo noturno) |
| DA-29 | Endurecimentos sem D próprio (spawn, handles, ambiente, DLL, tetos de YAML/PCRE2, aprovação mostra a ação inteira, AppImage/autostart) | Adotar |

## Tema B — Defeitos do núcleo do TS: corrigir no C

| Item | Defeito | Recomendação |
|---|---|---|
| DV-07 | Reiniciar o daemon zera as reservas de orçamento das tasks em andamento | Corrigir: restaurar `reserved_json` |
| DV-08 | Pai → filho herda orçamento padrão/retries/fallback do filho sem tomar o menor (contraria "delegar nunca aumenta privilégio") | Corrigir: aplicar o mínimo |
| DV-09 | `-S` de `cp`/`mv`/`ln` nunca reconhecido; o valor vira alvo | Corrigir |
| DV-41 | `-t`/`--target-directory` descarta o alvo: `mv -t /etc a` sai `write` | Corrigir (escrita fora do worktree vira `escalate`) |
| DV-10 | `defaults.isolation` do manifesto nunca tem efeito | Remover o campo do manifesto C (só `worktree` existe após o ADR 7.17) |
| DV-11 | Timeout/heartbeat vêm da política global, não da do projeto | Corrigir: usar a política efetiva |
| DV-12 | Estados declarados e nunca gravados (`submitted`, `auth_required`, `expired`) | Manter no esquema por compatibilidade com o banco migrado; não gerar |
| DV-13 | Retry sem vaga deixa a sessão `running` sem processo | Corrigir: concluir a sessão como `failed` com `session.ended` e liberar o worktree |
| DV-42 | Cortes por unidade UTF-16 partem emoji | Corrigir: cortar em fronteira de code point UTF-8, mesmo teto |
| DV-43 | Prompt vazio em argv deixa `-p` sem valor | Corrigir: recusar prompt vazio antes do spawn |
| DV-44 | Limite NaN no orçamento nunca esgota | Corrigir: sanear como o `setLimits` |
| DV-45 | Demais comportamentos dos mappers (exceção vira `unparsed`, array como objeto…) | Reproduzir (são tolerâncias, não falhas) |

## Tema C — Contrato HTTP e CLI: inconsistências pequenas

| Item | O que é | Recomendação |
|---|---|---|
| DV-01 | Timeouts de socket não definidos no TS | Definir explicitamente (valores da SPEC-08 H3 como ponto de partida, medidos na F1) |
| DV-02 | `/events` ignora `Last-Event-ID` | Corrigir: aceitar `Last-Event-ID` além de `?since=` |
| DV-03 | `cancel` engole erro de corpo | Manter a resposta, com teto e descarte no leitor (SPEC-08 D12) |
| DV-04 | Filtros sem validação de formato | Validar; formato inválido = inexistente |
| DV-05 | Descritor declara "sem autenticação" | Corrigir o descritor (descreve só `/api/tasks/*`) |
| DV-06 | Diretório do daemon como projeto implícito | Manter (paridade de contrato) |
| DV-14, DV-15, DV-16, DV-17, DV-24, DV-26 | `--version --json`, `workflow validate` sobe o daemon, `doctor --json` impuro, `logs -n`, ajuda sem `--json` de import/restore, `help` cria pastas | Corrigir todos (a ajuda passa a dizer a verdade) |
| DV-18 | Instruções do MCP citam 8 agentes | Corrigir para 9 |
| DV-19 | Autostart só no Windows; ramo de macOS no `open` | Autostart também no Linux (XDG); remover macOS |
| DV-20 | O que `hub update` faz com atualização automática | Checar e aplicar agora, com confirmação |
| DV-21 | Formato do hook/MCP gravado nas configs dos agentes | Novo formato apontando para o executável C, com a regra "é nosso" redefinida e migração das entradas antigas |
| DV-22 | Modelo começando com `-` não validado na UI | Validar na UI |
| DV-23 | `home` no `config.json` move só parte dos arquivos | Corrigir: tudo deriva do home efetivo |
| DV-25 | Como o hook do Claude identifica a sessão | Confirmar em F2-14 (não é decisão) |
| DV-27 | MCP termina `blocked` em aprovação; CLI espera | Manter (comportamentos diferentes por design de cada superfície) |

## Tema D — Arquitetura e interface

| Item | Pergunta | Recomendação |
|---|---|---|
| DA-14 | Janela, bandeja e serviço no mesmo processo? | **Serviço separado** (`agents-hubd`), janela+bandeja como cliente (`agents-hub`), CLI `hub` com MCP e hook como subcomandos. Motivo: o serviço sobrevive a falha da UI, sobe no login sem janela, e a janela fala a mesma API (ADR 7.6, "sem lógica no cliente") |
| DA-06 | Identidade da janela na auditoria | Bearer + `X-Hub-Client: ui` → `ui:<usuário>` |
| DA-15 | `GET` sem rota | 404 JSON; sem cookie |
| DA-07 | Recursos do navegador sem equivalente | Diálogos nativos de confirmação; tema salvo no `config.json`; notificação do SO quando a janela está oculta; seletor de pasta nativo |
| DA-08 | Markdown nas mensagens do agente | Fazer depois da paridade (requisito novo, subconjunto seguro: sem HTML, sem imagem remota) |
| DA-09 | Grafo com arestas desenhadas | Fazer depois da paridade (requisito novo) |
| DA-10 | Ícone | Encomendar um ícone próprio; até lá, um provisório gerado |
| DA-27 | Adapters (F3) antes da UI (F6) | Confirmar a ordem do plano |

## Tema E — Toolchain e detalhes técnicos

| Item | Pergunta | Recomendação |
|---|---|---|
| DA-11 | Propostas técnicas do ADR 08 (C17 sem VLA/stdatomic, CMake 3.22, UI só sob evento, linuxdeploy) | Confirmar (o spike de UI comprovou o laço sob evento) |
| DA-12 | HarfBuzz/plutosvg | HarfBuzz sim (já vem no SDL_ttf); emoji colorido COLR sem plutosvg no Windows; Linux a confirmar no spike |
| DA-13 | Proxy corporativo e certificados no AppImage | Ler o proxy do sistema (WinHTTP); CA do sistema no Linux; verificar na F8 |
| DA-22 | TOML e JSONC sem biblioteca | Leitor/gravador mínimo próprio só para as chaves que o Hub edita, com teste de ida e volta (sem nova dependência) |
| DA-23 | Mensagens do zod | Reproduzir só o código e o caminho do campo; texto próprio em pt-BR |
| DA-24 | Framework de teste | Manter a macro própria do esqueleto (sem dependência) |
| DA-25 | Dependências transitivas | FreeType e HarfBuzz vendorizados com o SDL_ttf; libcurl do sistema no Linux, empacotada no AppImage |
| DA-16 | Texto de erro do SDK MCP e versão do protocolo | Texto próprio; versão do protocolo igual à negociada pelo SDK TS na data |
| DA-20 | Comportamentos ligados a Node na CLI | Remover (sem Node no produto) |
| DA-21 | `container` no Brief/API/manifesto/banco | Recusar com erro claro na entrada; ler linhas antigas como estão |
| DA-17 | O que é o "corte do TS" | Parar de distribuir o tarball e tirar o TS do CI depois da F9; o código fica no repositório |
| DA-19 | Repositório público | Manter público |
| DA-28 | Desinstalação | Não apagar `~/.agents-hub`; remover autostart; oferecer remover os hooks gravados |
| DA-18 | Acesso remoto | Fora do escopo (segue em aberto) |

## Tema F — Propostas (DA-01 a DA-05)

| Item | Proposta | Recomendação |
|---|---|---|
| DA-01 | Linux sem Secret Service ([F7-01](F7-01-migracao-e-cofre.md) §4) | Opção 1: arquivo 0600 em pasta 0700 com aviso permanente |
| DA-02 | Referência e nomes no cofre (F7-01 §3) | Tabela própria no banco (R-C) com nome opaco (N-D); Windows com DPAPI em arquivo (W-B) — sem teto de 2560 bytes |
| DA-03 | Migração (F7-01 §2) | Cópia antes e migração no lugar (M-C), com o TS parado e a porta presa; marca dentro do banco (migração 11) |
| DA-04 | Chave e manifesto ([F8-04](F8-04-chave-e-manifesto-de-atualizacao.md)) | Envelope único; Ed25519 puro; Windows trocando binários (W2); chave diária local cifrada (O2) e a de recuperação em mídia separada; revogação assimétrica; expiração de 30 dias |
| DA-05 | Medição ([F0-15](F0-15-procedimento-de-medicao.md)) | Adotar a proposta (mediana de ≥ 5, mesma máquina, harness do C em `native/tests/bench/c/`) |
