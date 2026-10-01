# ADR 09 — Rodada 1: divergências do TS e decisões abertas do plano (decidido em 2026-09-30)

> Registro da decisão do dono sobre as 45 divergências (DV) e 29 decisões abertas (DA) do
> [plano](../17-plano-reescrita-c.md) (§2 e §3) e sobre o achado S6 da
> [proposta F7-01](../propostas/F7-01-migracao-e-cofre.md). As recomendações, item a item e com o
> motivo, estão em [`docs/propostas/decisoes-rodada-1.md`](../propostas/decisoes-rodada-1.md),
> **na versão do commit `89ca3e0`**. O dono respondeu por tema, em entrevista.

## Decisão

O dono **aceitou todas as recomendações** do documento, nos seis temas:

| Tema | Itens | Decisão do dono |
|---|---|---|
| A — Segurança | S6, DV-28 a DV-40, DA-26, DA-29 | Corrigir todas no C |
| B — Defeitos do núcleo do TS | DV-07 a DV-13, DV-41 a DV-45 | Corrigir (DV-45: reproduzir as tolerâncias dos mappers; DV-12: manter os estados no esquema, sem gerá-los) |
| C — Contrato HTTP e CLI | DV-01 a DV-06, DV-14 a DV-27 | Conforme a tabela do Tema C |
| D — Arquitetura e interface | DA-06, DA-07, DA-08, DA-09, DA-10, DA-14, DA-15, DA-27 | Conforme a tabela do Tema D |
| E — Toolchain e detalhes técnicos | DA-11 a DA-13, DA-16, DA-17, DA-19 a DA-25, DA-28 | Conforme a tabela do Tema E |
| F — Propostas | DA-01 a DA-05 | Opções recomendadas de F7-01, F8-04 e F0-15 |

## Decisões de maior impacto

- **9.1 Processos (DA-14):** serviço separado `agents-hubd` (sobe no login, sem janela); janela e
  bandeja em `agents-hub`, cliente da mesma API HTTP (ADR 7.6); CLI `hub`, com MCP e hook como
  subcomandos. A janela fechar ou travar não encerra as sessões (ADR 7.5).
- **9.2 Segurança corrigida em vez de reproduzida (Tema A):** o C não implementa cookie nem painel
  estático; recusa requisições de navegador; confere que quem conecta é o mesmo usuário do SO;
  `GET /projects/:id/context` sem token devolve só os nomes das variáveis (S6); permissões
  0700/0600 e DACL por SID; Job Object por sessão; limites e ambiguidades HTTP com 400/414/431;
  fuzzing e flags de endurecimento no release.
- **9.3 Defeitos do TS corrigidos (Tema B):** reservas de orçamento restauradas no reinício;
  interseção pai → filho com mínimo; `-S` e `-t` de `cp`/`mv`/`ln` classificados corretamente;
  sessão concluída quando o retry não consegue vaga; cortes de texto em fronteira de code point;
  limites de orçamento saneados.
- **9.4 Markdown e grafo desenhado (DA-08, DA-09):** depois da paridade; a primeira versão da UI é
  igual ao painel atual (texto cru e árvore indentada).
- **9.5 Sem dependência nova (DA-22, DA-24):** TOML/JSONC com leitor e gravador mínimos próprios;
  testes com a macro própria do esqueleto.
- **9.6 Migração e cofre (DA-01 a DA-03):** cópia de segurança antes e migração no lugar com o TS
  parado e a porta presa, marca dentro do banco; tabela própria com nome opaco; DPAPI em arquivo no
  Windows; Linux sem keyring: arquivo 0600 com aviso permanente.
- **9.7 Atualização (DA-04):** manifesto único assinado com Ed25519; troca dos binários com
  rollback no Windows; expiração de 30 dias; revogação só pela chave de recuperação; chave diária
  local cifrada e a de recuperação em mídia separada.
- **9.8 Medição (DA-05):** procedimento da [proposta F0-15](../propostas/F0-15-procedimento-de-medicao.md).

## Continua em aberto

- **DA-18** (acesso remoto): fora do escopo.
- **DV-25** não é decisão: confirmar em F2-14 como o hook do Claude identifica a sessão.
- **DA-12** (Linux): plutosvg e tray com e sem appindicator ainda não foram testados no Linux.
- **DA-13**: proxy corporativo e certificados no AppImage, a verificar na F8.
- **Variante POSIX do corpus do classificador**: onde guardá-la não tem DA no plano (a abrir).

## Consequências

- O plano (`docs/17`) e o status (`docs/19`) passam a registrar cada DV/DA como decidida, com o
  aceite das tarefas ajustado ao que foi decidido.
- O S6 entra no plano como divergência própria.
- O `SECURITY.md` do C (F7-05, SEC-R41) descreve as garantias novas.
