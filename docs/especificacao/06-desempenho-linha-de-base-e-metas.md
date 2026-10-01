# 06 — Desempenho: linha de base do TS e metas do C

> A linha de base foi medida em 2026-09-30 sobre o código TS no commit `ac59745` (idêntico
> a `ecbb72f` em `packages/`), com `dist/` conferido por hash antes e depois de
> `npm run build`, daemon isolado e custo zero (só agentes falsos). As metas foram escolhidas
> pelo dono do projeto em 2026-09-30 e estão registradas no
> [ADR 08](../decisoes/08-pilha-tecnica-c.md) (a decisão de derivá-las da medição é o
> [ADR 07](../decisoes/07-reescrita-nativa.md), 7.19).

## Ambiente da medição

- Intel Xeon E5-2650 v4 (12 núcleos, 24 lógicos), 15,9 GiB de RAM, Windows 10 Pro 19045, SSD
  NVMe, Node v24.14.0.
- Máquina compartilhada durante parte das medições (outros agentes e navegador, ~37% de CPU
  total num instante amostrado). Os números são medianas; os máximos têm ruído. A RAM com o
  painel aberto no navegador, a 2ª série do MCP server e o tamanho da instalação foram medidos
  durante essa carga.
- RAM: `WorkingSet64` (memória em uso) e `PrivateMemorySize64` (privada) do `Get-Process`.
  Tempo: do spawn até o evento medido.

## Linha de base (TS/Node) e metas (C)

| Métrica | TS medido (mediana) | Meta do C |
|---|---|---|
| Início do serviço até `/health` responder | 818 ms (home existente, N=5); 881 ms (home nova, N=7) | ≤ 150 ms |
| RAM do serviço parado | 60,9 MB em uso / 38,0 MB privada (62 s depois de subir, N=5); 78,3 / 55,3 MB aos 2 s | ≤ 15 MB |
| CPU do serviço parado | 109 ms de CPU em 60 s, ~0,18% de um núcleo (N=5) | ≈ 0 |
| Hook do gate, leitura (caminho rápido) | 152 ms (N=15) | ≤ 30 ms |
| Hook do gate, comando de shell | 308 ms fora de sessão (daemon responde em 1,4 ms); 309 ms com sessão (daemon 2,6 ms) (N=15) — o resto é o processo do hook | ≤ 30 ms |
| MCP server: início até responder `initialize` | 663 ms (N=8) | ≤ 50 ms |
| RAM do MCP server | 79,5 MB em uso / 74,2 MB privada (N=8) | ≤ 10 MB |
| Tamanho instalado | 18,2 MiB do pacote + 87,1 MiB do `node.exe` ≈ 105 MiB | ≤ 20 MB |
| Vazão de eventos em rajada (agente → SSE) | 929 eventos/s (2.000 linhas); 862 eventos/s (20.000 linhas); nenhum perdido | ≥ 5.000 eventos/s |
| Latência por evento em ritmo baixo | 1,3 ms (p99 31,6 ms) | sem meta definida |
| `hub --version` a frio | 136 ms (N=15) | sem meta definida |
| `hub help` a frio | 597 ms (N=15) | sem meta definida |

## Observações da medição (hipóteses, sem profiler)

- O tempo de arranque do TS é dominado pelo carregamento de módulos: `node -e 0` custa
  106 ms no mesmo harness, e o daemon chega a ~820 ms.
- `EventRepository.append` (`packages/store/src/repositories.ts:413`) chama `prepare()` a
  cada evento e grava fora de transação, numa tabela com vários índices e um gatilho.
- A memória em uso do daemon subiu de 88 MB para 145 MB ao longo de 5 rajadas de 20.000
  eventos e não voltou durante a medição. Causa não investigada.
- `GET /agents` leva 578 ms porque roda `--version` de cada agente instalado.
- O banco ficou com ~855 bytes por evento (94,9 MB depois de 111.000 eventos).

## Não medido

- RAM do navegador que exibe o painel (só a do daemon foi medida).
- Acordadas por segundo do serviço parado (só o tempo de CPU).
- Custo extra do shell que o Claude Code usa para chamar o hook.

## Como as metas serão conferidas

O procedimento de medição e o benchmark entram no plano da reescrita. Proposta (não
decidida): o mesmo procedimento da linha de base, com mediana de pelo menos 5 execuções na
mesma máquina de referência e serviço isolado.
