# Segurança

O Agents-Hub é um daemon local que **executa CLIs de agentes de IA com o seu
usuário, no seu repositório**. O modelo de ameaça não é o de uma biblioteca: é o
de um processo que spawna outros processos com privilégio total do dono da
máquina. Este documento diz o que ele garante, o que ele explicitamente não
garante, e como relatar uma falha.

## Como relatar

Abra um **security advisory privado** em
<https://github.com/brunocsilva41/Agents-Hub/security/advisories/new>. Não abra
issue pública para falha explorável.

Inclua: versão (`hub doctor`), sistema operacional, e o menor caminho que
reproduza. Se o relato envolver um agente específico, diga qual binário e qual
versão — metade das falhas desta categoria vem do dialeto de um CLI, não do Hub.

Este é um projeto pessoal, sem SLA de resposta. O que existe é o compromisso de
não fechar relato sem explicação.

---

## O que o Hub garante

| Vetor | Controle | Onde |
|---|---|---|
| Página web dirigindo o daemon | `Host` só loopback (anti DNS rebinding), `Origin` verificada, content-type exigido | `packages/daemon/src/guard.ts` |
| Corpo ou parâmetro malformado | Todo corpo e parâmetro de rota por schema Zod `strict` | `packages/daemon/src/http-schemas.ts` |
| Traversal na Web UI servida | Comparação por caminho relativo resolvido, não por prefixo de string | `packages/daemon/src/static.ts` |
| Escalação por delegação | Política efetiva = interseção com a do pai. Filho **nunca** supera o pai | `packages/core/src/policy.ts` |
| Delegação em loop | Profundidade máxima + ciclo semântico por `(agente, hash do objetivo)` | `packages/core/src/graph.ts` |
| Gasto descontrolado | Orçamento é da sessão-raiz, consumido pelos descendentes | `packages/core/src/budget.ts` |
| Ação irreversível | `git push`, `rm -rf`, publish, ler ou escrever segredo (`.ssh`, `.env`, chaves, credenciais de CLI) e escrever em `.git/hooks`/`.github/workflows` param a sessão e abrem aprovação; a deny list (`sudo`...) é negada sem aprovação | `packages/core/src/policy.ts` |
| Comando composto para driblar a allow list | Comando tokenizado (`&&`, `;`, `\|`, `$(...)`, crase, redirecionamento, `bash -c`, `cmd /c`, `powershell -Command`...); vale o pior segmento; o que não dá para tokenizar não é liberado | `packages/core/src/command-classifier.ts` |
| Config de projeto hostil | `<repo>/.agents-hub/config.yaml` só pode **apertar** a política global, nunca afrouxar (regra campo a campo em `mergePolicyLayer`); campos sensíveis do repo (ver abaixo) só valem com `hub project trust` (confiança no banco do Hub, padrão desligado, suspensa se o conteúdo mudar) | `packages/daemon/src/project-config.ts`, `packages/daemon/src/repo-trust.ts` |

### Vetores do repositório (`<repo>/.agents-hub/config.yaml`)

O arquivo é versionado: quem clona o repositório herda-o. Trate-o como
qualquer script do repositório — entrada **não confiável** até você revisá-lo.

| Campo do repo | O que um repo hostil faria | Sem `hub project trust` |
|---|---|---|
| `policy.validation.command` | executar um processo arbitrário (`shell: true`) | ignorado, com aviso |
| `policy.validation.review.*` | ligar/escolher o agente revisor (outro binário, outro gasto) | ignorado, com aviso |
| `env.<agente>.*_BASE_URL`, `*_API_BASE`, `*_ENDPOINT`... | desviar o canal de API do agente para um servidor do atacante — o CLI já autenticado envia código, prompt e credencial para lá | ignorado, com aviso (o aviso mostra o destino) |
| `env.<agente>.*_API_KEY`, `GOOGLE_*`... | trocar a conta/credencial usada pelo agente | ignorado, com aviso |
| `prompts.<agente>`, `memory` | injetar instruções no prompt de todo agente (prompt injection persistente) | ignorado, com aviso |
| `env` fora da lista de permissão (`NODE_OPTIONS`, `PATH`, `HTTP(S)_PROXY`, `NODE_EXTRA_CA_CERTS`, `LD_PRELOAD`, `GIT_SSH_COMMAND`...) | execução arbitrária, troca de binário, interceptação TLS | recusado **sempre**, mesmo com `trust` (`packages/core/src/agent-env.ts`) |
| resto da política (allow/deny, orçamento, timeouts, `maxDepth`, `fallback`...) | afrouxar limites | só aperta; não precisa de `trust` |

**Trust-on-first-use.** `hub project trust` grava, junto da marca, o hash do
conteúdo sensível **de agora** (e a CLI lista o que está sendo confiado). Se o
repositório mudar qualquer campo sensível depois — um `git pull` que troca a
`ANTHROPIC_BASE_URL`, um `validation.command` novo —, o hash não bate e a
confiança fica **suspensa**: os campos voltam a ser ignorados, com aviso
(`SUSPENSA`) na timeline da sessão e em `GET /projects/:id/context` (`repo`),
até você rodar `hub project trust` de novo. Confiança dada antes do hash
existir conta como suspensa.

**O que você configura pelo Hub é outra camada.** Memória, instruções e env
definidos pelo painel, por `hub project env|prompt` ou por `hub import` ficam no
banco do Hub (`~/.agents-hub`), fora do repositório, e valem sem `trust` (ainda
passando pela lista de permissão de env). Quando as duas camadas existem, a do
Hub vence variável a variável. Até esta versão o painel gravava no
`config.yaml` do repositório; o que estiver lá passa a ser tratado como
conteúdo do repositório.

**Credenciais:** o Hub não lê os arquivos de credencial dos CLIs. Cada adapter roda
com o login que o próprio CLI já tem (`~/.claude`, `~/.codex`, ...). O env que
**você** informa pelo Hub (ex.: uma `*_API_KEY` em `hub project env`) é persistido
em texto puro no banco do Hub e repassado ao agente. Não existe
cofre, e a interface `CredentialProvider` está preparada mas não implementada —
de propósito.

---

## O que o Hub NÃO garante

Esta seção importa mais que a anterior. Confundir os níveis abaixo é como se
perde a proteção de verdade.

### Prevenção só existe onde há gate pré-execução

São **três níveis com garantias diferentes**:

| Nível | Como funciona | Cobertura hoje |
|---|---|---|
| **Gate pré-execução** | O agente pergunta ao Hub *antes* de rodar a ferramenta e obedece à resposta. Prevenção real | **Claude Code** e **Codex** |
| **Portão** | Ação que passa por dentro do Hub (delegação, reserva de orçamento). Retida antes de acontecer | Todos |
| **Vigilância** | Evento do que **já aconteceu**; para a *próxima* ação | Todos |

Chamar vigilância de "aprovação prévia" seria mentira. Para os agentes sem gate,
o Hub vê o comando depois que ele rodou.

**A vigilância em si não pausa por padrão em risco `escalate`, nem para os
agentes COM gate.** `DEFAULT_POLICY.watch` (`packages/core/src/policy.ts`) só
lista `pauseOn: ['irreversible']`; `escalate` está apenas em `flagOn`, ou seja,
por padrão vira log/timeline e a ação **segue executando até o fim**, mesmo que
`policy.risk.escalate` diga `'approve'`. É decisão de produto deliberada
(reduzir ruído de pausas), não bug — mas o efeito prático precisa ser
explícito: em qualquer modo que não seja `supervised`, uma ação classificada
`escalate` (ex.: escrita fora do workdir, comando fora da allow list, domínio
de rede não liberado) não é retida por vigilância nenhuma; ela só é impedida de
verdade nos dois agentes com gate pré-execução, porque ali o Hub responde
`deny`/`approve` *antes* da ferramenta rodar. Só o modo `supervised` adiciona
`escalate` a `pauseOn` (`watchForMode`), e mesmo assim isso só produz uma pausa
real quando há gate — para os demais agentes, "pausar" quer dizer apenas que o
evento fica marcado, a ação já foi executada.

Dos 9 agentes suportados hoje, a situação é:

| Agente | Tem gate pré-execução | `escalate` pausa de verdade antes de executar? |
|---|---|---|
| Claude Code | Sim | Sim |
| Codex | Sim (exige `hub hooks install codex --write`; ver ressalva acima) | Sim, com o bypass instalado |
| opencode | Não | Não — só log/flag, ação já executou |
| openclaude | Não | Não |
| copilot | Não | Não |
| kimi | Não | Não |
| antigravity | Não | Não |
| mimo | Não | Não |
| cursor | Não | Não |

Ou seja: só **Claude Code** e **Codex** têm gate pré-execução. Os outros **7**
(`opencode`, `openclaude`, `copilot`, `kimi`, `antigravity`, `mimo`, `cursor`)
dependem inteiramente de vigilância reativa — e, por padrão, nem `escalate`
pausa a sessão neles, só fica registrado no evento.

**Para `mimo` e `cursor`, essa vigilância reativa nem chega a existir.** A
tabela acima já diz "Não" para os dois, mas isso pode ser lido como "vigilância
mais fraca" — não é: é vigilância **ausente**. Os dois manifestos
(`manifests/mimo.yaml`, `manifests/cursor.yaml`) usam o mapper `generic-json`
(`packages/adapters/src/mappers/generic.ts`), que só produz eventos
`message`/`log`/`error` — nunca `command.executed` ou `file.changed`. Como a
classificação de risco (`escalate`/`irreversible`/etc.) roda sobre esses
eventos estruturados, e eles simplesmente não são emitidos para estes dois
agentes, não há nem o mínimo de "vigilância vê o que já aconteceu": não existe
um evento de comando ou de arquivo para essa vigilância avaliar. A garantia
mínima da linha "Vigilância" na tabela de três níveis acima (evento do que já
aconteceu, para a próxima ação) simplesmente não se aplica a `mimo`/`cursor` —
é vigilância inexistente disfarçada de existente, não apenas mais fraca que a
dos agentes com gate. Fechar isto de verdade exige um mapper dedicado para cada
um (item aberto no roadmap), que extraia esses eventos do formato nativo de
cada CLI.

O Codex é um caso à parte, e vale ser preciso sobre o que a cobertura acima
garante: hook não confiável é **ignorado em silêncio** pelo binário — sem
`--dangerously-bypass-hook-trust` (ligado por `hub hooks install codex --write`,
escolha explícita do usuário nesta máquina), não há prevenção nenhuma, e o Hub
recusa abrir uma sessão `--mode supervised` do Codex sem essa garantia, em vez
de fingir que ela existe.

### O classificador de comando é análise estática, não sandbox

O classificador lê o texto do comando; ele não vê o conteúdo de um script em
arquivo (`bash deploy.sh`, `node build.js`, `npm run x`), e código inline
(`node -e`, `python -c`) é avaliado por heurística (uso de API de processo,
arquivo e rede sobe o risco; menção a segredo vira `irreversible`). O que ele
garante é que composição não esconde nada: cada segmento de `a && b`, `a | b`,
`$(...)`, crase e `bash -c`/`cmd /c`/`powershell -Command` é classificado, e
entrada que não tokeniza com segurança (aspas sem fechar, crase de escape do
PowerShell) vira `escalate`, nunca `allow`.

### O worktree não é sandbox

Cada sessão roda num git worktree próprio, o que impede agentes de pisarem uns
nos outros e nas suas mudanças locais. **Não** impede um agente de escrever fora
dele — isso é classificado como `escalate` e depende da política ser aplicada,
o que nos agentes sem gate pré-execução acontece *depois* do fato. Isolamento de
verdade exige container, que está no roadmap como modo opcional e não existe.

Além disso, `node_modules`, `.venv` e `vendor` são **ligados por junction** ao
projeto principal, para o portão de validação conseguir rodar. Dois agentes
executando builds que escrevem em `node_modules/.cache` colidem de verdade.

### O daemon não tem autenticação

`127.0.0.1:4747` é protegido por ser loopback e pelas checagens de `Host` e
`Origin`. **Qualquer processo local rodando com o seu usuário pode dirigir o
Hub** — criar sessão, aprovar uma ação retida, encerrar o daemon. Não há token,
não há authz.

Isso é aceitável para um daemon local e **não é aceitável exposto na rede ou por
túnel**. Expor `AGENTS_HUB_PORT`/`host` para fora do loopback sem antes existir
authn é como se abre a máquina para a internet. A decisão de acesso remoto está
registrada como em aberto no roadmap justamente por isso.

### O agente executa código não confiável por natureza

O trabalho do Hub é rodar agentes que leem o seu repositório e executam
comandos. Um repositório hostil pode conter instruções destinadas ao agente
(prompt injection) que o Hub não filtra e não sabe detectar. Os controles do Hub
limitam o **dano** (política, orçamento, aprovação para o irreversível); eles não
impedem o agente de ser convencido a tentar.

### Retenção é permanente e local

Eventos ficam no SQLite **para sempre**, com o payload bruto do agente
preservado (ADR 06.3). Isso inclui trechos de arquivo que o agente leu. O banco
vive em `~/.agents-hub/hub.db`, sem criptografia. Não há comando de expurgo.

---

## Fora de escopo

- Falhas dos CLIs dos agentes (reporte ao projeto do agente).
- Um processo local malicioso rodando com o seu usuário — nesse ponto a máquina
  já está comprometida e o Hub não é a fronteira.
- Falta de authn no daemon loopback, que é decisão de projeto declarada acima.
  Um relato de "o daemon não pede senha" será fechado com um link para esta
  seção; um relato de "consegui chegar no daemon de outra máquina" não.
