# Agents-Hub

> Plano de controle onde **qualquer** agente de IA pode orquestrar e ser orquestrado.

Claude Code, Codex, OpenCode, Copilot, Kimi Code, MiMo, OpenClaude, Cursor e Antigravity — todos reduzidos ao mesmo modelo de sessão, evento, política e orçamento. Nenhum papel é fixo: "principal" é apenas quem detém a sessão-raiz, e você escolhe isso a cada sessão.

## Por que existe

Cada agente é ótimo em algo e cego para o resto. Hoje, fazer um chamar o outro significa copiar contexto na mão, perder o rastro de quem fez o quê e não ter ideia de quanto custou. O Hub resolve as quatro coisas que faltam quando agentes trabalham juntos:

| Problema | O que o Hub faz |
|---|---|
| Cada CLI fala um dialeto | Um adapter por agente normaliza tudo para um `EventEnvelope` único |
| Agentes pisam uns nos outros | Um git worktree isolado por sessão |
| Delegação vira loop caro | Profundidade máxima + detecção de ciclo semântico + orçamento herdado da raiz |
| Ninguém sabe o que aconteceu | Todo evento persistido com o payload original, grafo ao vivo e custo por nó |

## Estado atual

**Fases 1 e 2 rodando e validadas com agentes reais.** Um agente inicia sessão, produz eventos normalizados, roda isolado num worktree, respeita orçamento, passa por portão de validação — e delega para outro agente, pela CLI, pelo painel ou por MCP. Quando falha, o Hub tenta de novo e depois troca de agente.

```
cursor [running]  US$ 0.0000 · 0 tok      ← agente externo, adotado como raiz
  └ codex [completed] US$ 0.0000 · 17.2k tok
    Responda apenas com a palavra MCP_OK.
```

## Começando

Requer Node ≥ 22.5 e git. Instalação a partir do clone, como pacote global (não depende do clone depois de instalado):

```bash
npm ci && npm run build && npm run pack:dist
npm i -g ./dist-pack/agents-hub-0.1.0.tgz
```

Para desenvolver no próprio Hub, `npm link --workspace @agents-hub/cli` no lugar das duas últimas linhas (aí hooks e MCP gravados nos agentes apontam para o clone). Detalhes, autostart no login (`hub autostart enable`) e o teste de instalação: [docs/13-instalacao.md](docs/13-instalacao.md).

Pronto — `hub` está no PATH. **Não existe passo "suba o daemon"**: ele nasce sozinho quando algum comando precisa e sobrevive ao terminal que você fechar.

```bash
hub status     # agentes disponíveis, sessões vivas, o que espera sua decisão
hub doctor     # o que está instalado, com versão e caminho
```

O painel fica em **http://127.0.0.1:4747**.

Abra uma sessão — o `--agent` é obrigatório porque **você escolhe o principal a cada vez**:

```bash
hub start --agent claude --budget-usd 2 "refatore o módulo de pagamentos"
```

Faça um agente chamar outro:

```bash
hub delegate <sessionId> --agent codex --budget-usd 0.5 "escreva os testes do que foi refatorado"
```

Veja quem chamou quem e quanto custou:

```bash
hub graph <rootId>
```

Quando quiser encerrar tudo:

```bash
hub stop
```

`hub help` lista o resto.

## Testar o MVP sem gastar nada

```bash
npm run build && npm run demo
```

Sobe um daemon isolado (home temporária, porta efêmera; não toca em `~/.agents-hub` nem na porta 4747) com três agentes falsos (raiz, filho, neto) e percorre o fluxo principal só por HTTP: abre a sessão-raiz, delega raiz → filho → neto (profundidade 2), espera os estados terminais e imprime o grafo com estado e custo. Também confere que o painel (`GET /`) e `/health` respondem. Cada passo sai como `PASS`/`FAIL`, o código de saída é 0 só se tudo passou, e o daemon e o temp são removidos ao final, mesmo em falha. Custo: zero, nenhum agente real é chamado.

## Usar o que você já tem instalado

O Hub reconhece os CLIs já instalados e absorve a configuração deles, sem copiar segredo:

```bash
hub discover                                   # instalado, versão, auth, modelo padrão, MCP, instruções
hub import claude --to codex,opencode          # prévia (dry-run) de compartilhar os MCP servers
hub import claude --kinds env,mcp --to codex --write
```

Também disponível no painel, em Configurações → "Agentes detectados". Detalhes e modelo de segurança em [`docs/11-descoberta-e-absorcao.md`](docs/11-descoberta-e-absorcao.md).

## Dar aos seus agentes o poder de chamar os outros

O Hub se expõe como **MCP server** — o único protocolo que os oito CLIs já falam. Registrado uma vez, o Cursor pode chamar o Claude, que chama o Codex.

```bash
hub mcp                        # o que está registrado onde
hub mcp install codex --write  # grava, com backup e merge
```

O agente ganha 11 ferramentas: `hub_agent_call` (delega e volta na hora com um `task_id`), `hub_agent_status`, `hub_agent_wait`, `hub_agent_events`, `hub_agent_cancel`, `hub_session_send`, `hub_graph`, `hub_budget` e mais.

Funciona mesmo com o agente rodando **fora** do Hub: nesse caso o MCP server adota uma sessão-raiz na primeira chamada, para o filho ter pai de quem herdar política e raiz onde debitar orçamento. Detalhes em [docs/03-mcp-e-painel.md](docs/03-mcp-e-painel.md).

## Painel

Servido pelo próprio daemon, na mesma API que a CLI consome — nenhuma lógica mora no cliente, então os dois têm a mesma capacidade por construção.

O grafo de chamadas é a **navegação**: clicar num nó abre a timeline daquele agente. Ao lado, o consumo contra o orçamento do fluxo e os controles ao vivo — interromper turno, pausar, encerrar, delegar a partir dali, ou simplesmente falar com a sessão.

```bash
npm run web:dev   # opcional: Vite com hot reload em :4748, proxy para o daemon
```

## Arquitetura em uma tela

```
CLIENTES     CLI · Web UI  ──────── HTTP + SSE (API única) ───────┐
TRANSPORTS   MCP server · A2A server (fase 3) · REST/SSE          │
CORE         Orchestrator · SessionManager · CallGraph            │
             PolicyEngine · BudgetLedger · CapabilityRegistry     │
ADAPTERS     claude · codex · opencode · copilot · kimi · mimo    │
             openclaude · cursor · antigravity (por manifesto)     │
INFRA        SQLite · WorktreeManager · ProcessHost               ┘
```

Dependências apontam só para baixo. O `core` não conhece adapters nem HTTP — recebe portas injetadas, e por isso dá para testar orquestração, política e orçamento sem invocar nenhum agente.

Detalhes em [docs/01-arquitetura.md](docs/01-arquitetura.md).

## Adicionar um agente novo

Escrever um YAML em `manifests/` — não código:

```yaml
id: meu-agente
name: Meu Agente
bin: meu-cli
invoke:
  oneShot: ["-p"]
  stdinPrompt: true
session: { strategy: replay }
stream: { format: text, mapper: generic-text }
capabilities: [code-edit]
auth: { mode: inherit }
```

Só se escreve código quando o agente oferece algo que o genérico não cobre — como o servidor HTTP do OpenCode ou o JSONL de eventos do Codex.

## Segurança

O Hub **nunca** toca nas suas credenciais: cada adapter roda com o login que o próprio CLI já tem. O que ele controla é o resto.

- Cada sessão roda num git worktree próprio — agentes não pisam uns nos outros nem nas suas mudanças locais
- Orçamento é do fluxo inteiro, consumido pelos descendentes: o que um gasta, falta para os outros
- Política de um filho = interseção com a do pai: **delegar nunca aumenta privilégio**
- Profundidade máxima e detecção de ciclo semântico impedem que delegação vire loop caro
- `git push`, `rm -rf`, publish e segredos (ler ou escrever `.ssh`, `.env`, chaves, credenciais de CLI) param a sessão e abrem uma aprovação
- Comando composto não engana a política: `git status && git push` vale como `git push` (cada segmento é classificado, vence o pior)

Detalhes e níveis de risco em [docs/decisoes/03-seguranca-limites.md](docs/decisoes/03-seguranca-limites.md).

**Três níveis de controle, com garantias diferentes** — e é importante não confundi-los:

| Nível | Como funciona | Cobertura |
|---|---|---|
| **Gate pré-execução** | O agente pergunta ao Hub *antes* de rodar a ferramenta e obedece à resposta. Prevenção real | Claude Code, Codex |
| **Portão** | Ação que passa por dentro do Hub: delegação, reserva de orçamento. Retida antes de acontecer | Todos |
| **Vigilância** | Evento do que já aconteceu; para a *próxima* ação. Chamar isso de aprovação prévia seria mentira | Todos |

Ligue o gate pré-execução:

```bash
hub hooks install claude --write   # registra o hook na config do Claude Code
hub hooks install codex --write    # liga o bypass de confiança que o hook do Codex exige
```

Validado com o Claude Code de verdade: mandado a rodar `git push origin main`, o comando foi **barrado antes de executar** e o Hub registrou o evento de auditoria.

O Codex é um caso à parte: ele **ignora hook não confiável em silêncio** — sem
`--dangerously-bypass-hook-trust` a cada invocação, a ferramenta roda como se
não houvesse gate nenhum, e o Hub não finge o contrário. Por isso uma sessão
`--mode supervised` do Codex é **recusada ao iniciar** se o bypass não estiver
ligado nesta máquina, em vez de rodar sem a prevenção que o modo promete;
`semi`/`autonomous` rodam sem o bypass, mas com aviso explícito na timeline.
Detalhes do modelo de ameaça em [SECURITY.md](SECURITY.md).

**Tabela de risco padrão** (`--mode`; `semi` é o padrão da maioria dos agentes):

| Risco | Exemplos | supervised | semi | autonomous |
|---|---|---|---|---|
| `read` | `ls`, `cat`, `rg`, `git status/diff/log`, ler arquivo comum, plano do Claude em `~/.claude/plans` | passa | passa | passa |
| `write` | editar/criar no worktree, `mkdir`, `touch`, `cp`, `mv`, `echo x > src/a.ts`, `rm arquivo` | aprovação | passa | passa |
| `exec` | `npm test/install`, `make`, `cargo build`, `git fetch/commit`, `npx vitest`, `node script.js` | aprovação | passa | passa |
| `escalate` | comando fora da allow list, `curl` para domínio não liberado, escrita fora do worktree, `node -e` com `fs`/`child_process`, comando que não tokeniza | aprovação | aprovação no gate · alerta na vigilância | passa |
| `irreversible` | `git push`, `rm -rf`, `git reset --hard`, `git stash drop`, `find -delete`, publish, ler/escrever segredo, escrever `.git/hooks`/`.github/workflows` | aprovação | aprovação | aprovação |
| deny list | `sudo`, `shutdown`, `mkfs`, `reg delete` | negado | negado | negado |

"Aprovação" é prévia nos agentes com gate (Claude, Codex); nos demais, a vigilância pausa depois do fato só a partir de `escalate` em `supervised` e de `irreversible` nos outros modos.

Por padrão só o irreversível interrompe o trabalho comum: o que um agente roda o dia todo (`mkdir`, `make`, `cargo build`, `git fetch`, `npm install`) é `write`/`exec` e passa em `semi`. Um controle que congela a sessão a cada comando legítimo é desligado na primeira hora, e controle desligado protege zero. A exceção deliberada é `escalate` **nos agentes com gate** (Claude, Codex): lá ele pede aprovação em `semi`, porque o gate *previne* e `escalate` passou a significar só o que realmente sai do combinado (rede não liberada, escrita fora do worktree, binário desconhecido). Nos demais, que só têm vigilância, `escalate` em `semi` vira alerta na timeline — pausar depois do fato não desfaz nada.

```bash
hub approvals        # o que espera sua decisão
hub approve <id>     # libera e a sessão continua
```

## Quando um agente falha

O Hub não desiste na primeira: **retry** com backoff no mesmo agente (retomando a sessão nativa, que é mais barato), **fallback** pela cadeia `claude → codex → opencode` levando junto o histórico de falhas, e um **portão de validação** que roda o build/testes do projeto antes de aceitar o resultado — porque "terminou sem erro" e "entregou o que foi pedido" são coisas diferentes.

O substituto entra como irmão no grafo, não como filho: ele não foi chamado por quem falhou, está no lugar dele.

Configure o portão por repositório em `<repo>/.agents-hub/config.yaml`:

```yaml
policy:
  validation:
    command: npx tsc -b
```

O projeto só pode **apertar** a política global, nunca afrouxar — orçamento, timeouts, retries e concorrência só descem; allow lists só encolhem; deny lists só crescem. E os campos do arquivo que mudam o que a sua máquina **faz** — `validation.command`/revisão (viram processo), `env` (ex.: `ANTHROPIC_BASE_URL`, que decide para onde vão o código e a credencial do agente), `prompts` e `memory` (instruções ao agente) — só valem depois que **você** marcar o projeto como confiável (a marca fica no banco do Hub, fora do repo):

```bash
hub project trust [projeto]     # mostra e confia no conteúdo sensível ATUAL do config.yaml
hub project untrust [projeto]   # volta ao padrão: ignorados, com aviso na timeline
```

A confiança é *trust-on-first-use*: o Hub guarda o hash do conteúdo confiado. Se o repositório mudar esses campos depois (um `git pull` que troca a URL, por exemplo), a confiança fica **suspensa** — os campos voltam a ser ignorados, com aviso — até você rodar `hub project trust` de novo.

Sem isso, um `.agents-hub/config.yaml` num repo clonado viraria execução arbitrária ou desviaria o tráfego do agente. O que **você** configura pelo Hub (painel, `hub project env`, `hub project prompt`, `hub import`) mora no banco do Hub, fora do repositório, e vale sem `trust`. Detalhes em [docs/04-resiliencia-e-politica.md](docs/04-resiliencia-e-politica.md).

## Decisões

Cada escolha estrutural está registrada como ADR em [docs/decisoes/](docs/decisoes/), com a consequência que ela impõe. A pesquisa de mercado que embasou o desenho está em [docs/00-pesquisa-mercado.md](docs/00-pesquisa-mercado.md).

## Testes e portão de qualidade

```bash
npm run verify     # o que o CI roda: build completo + a suíte inteira
npm test           # só a suíte — 273 testes em 30 arquivos
```

`npm run verify` é o mesmo comando que o CI executa em Windows com Node 22.5 e 24. Se passa na sua máquina e falha lá, é bug do portão e tem prioridade.

A descoberta dos arquivos de teste é feita em JavaScript (`scripts/run-tests.mjs`), não por glob de shell — a forma anterior coletava 30 arquivos no PowerShell e **3** no bash, saindo verde nos dois casos. Um portão que protege menos do que diz proteger é pior que nenhum. A história está em [docs/08-endurecimento.md](docs/08-endurecimento.md).

Os testes de domínio cobrem o que não pode quebrar em silêncio: não-escalação de privilégio, herança de orçamento e detecção de ciclo no grafo de delegação.

Contra os agentes de verdade, que gastam tokens:

```bash
python scripts/mcp-smoke.py                    # MCP, só leitura, sem custo
python scripts/mcp-smoke.py --delegate codex   # delega de verdade
```

Como contribuir, e o que precisa ser verdade para um item do roadmap receber `[x]`: [CONTRIBUTING.md](CONTRIBUTING.md). Modelo de ameaça e o que o Hub explicitamente **não** garante: [SECURITY.md](SECURITY.md).

## Licença

[MIT](LICENSE).
