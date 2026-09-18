# Contribuindo com o Agents-Hub

Este documento existe por um motivo específico e verificável: em 2026-09-18, o
commit de topo de `main` não compilava. Treze erros de TypeScript, seis arquivos
de teste caindo na carga, e o gate pré-execução respondendo ao hook do agente
com uma Promise serializada como `{}` — ou seja, **falhando aberto** no único
caso que ele existe para pegar.

Nada disso era invisível. Bastava rodar `tsc -b` num checkout limpo. O que
faltava não era cuidado, era **portão**: nenhuma máquina, em nenhum momento,
compilava o repositório do zero antes de aceitar uma mudança.

O que segue é o portão.

---

## O ciclo

```bash
npm ci          # exatamente o que está no lockfile, nada de resolver versões
npm run verify  # build completo (pacotes + Web UI) e a suíte inteira
```

`npm run verify` é o mesmo que o CI roda. Se passa aqui e falha lá, é bug do
portão e tem prioridade sobre o que você estava fazendo.

### Comandos individuais

| Comando | O que faz |
|---|---|
| `npm run build:packages` | só `tsc -b` — o laço rápido |
| `npm run build` | pacotes + Web UI, que é o que o CI compila |
| `npm test` | a suíte inteira (30 arquivos, 273 testes) |
| `npm run clean` | apaga `dist/` e `.tsbuildinfo` |

> **Sobre `npm test`:** a descoberta dos arquivos é feita em JavaScript
> (`scripts/run-tests.mjs`), não por glob de shell. O motivo é concreto: a
> forma anterior — `node --test packages/*/dist/**/*.test.js` — dependia de
> **quem** expandia o glob. No PowerShell a string chegava intacta ao Node, que
> a expandia certo e coletava os 30 arquivos. No bash, o shell expandia
> primeiro, e `**` sem `globstar` vale por um `*` só: casava **3 arquivos**,
> saía verde, e todo o domínio (política, orçamento, grafo, resiliência) e todo
> o daemon nunca rodavam. Um CI em Linux teria rodado a versão cega.
>
> Um portão que protege menos do que diz proteger é pior do que nenhum, porque
> compra confiança sem lastro.

---

## Critério de pronto

O roadmap deste projeto já marcou como `[x]` coisas que não estavam prontas —
um "A2A server" que nenhum peer A2A conversa, um motor de workflows que validava
o DAG e o ignorava na execução, um evento de alerta de orçamento sem nenhum
emissor. A auditoria em [`docs/07-progresso-real.md`](docs/07-progresso-real.md)
conferiu item a item e reclassificou o que não se sustentava.

Para não repetir, **um item só recebe `[x]` quando as cinco linhas abaixo são
verdade**:

1. **Compila do zero.** `npm run verify` verde num checkout limpo, sem `dist/`
   nem `.tsbuildinfo`. O cache incremental do `tsc -b` foi exatamente o que
   escondeu o build quebrado na máquina de quem o escreveu.
2. **Tem teste que falha sem a mudança.** Não "tem cobertura" — tem um teste
   que prova o comportamento e que ficaria vermelho se a mudança fosse
   revertida.
3. **Tem consumidor.** Função exportada que ninguém importa, rota que ninguém
   chama, tipo de evento que ninguém emite: isso é código escrito, não recurso
   entregue. Se ainda não há consumidor, o item é `[~]` e a frase diz o que
   falta.
4. **Foi exercido fora do teste.** Contra o binário real, contra o daemon
   rodando, contra o banco. Onde não foi, o item recebe **🕳️** — *código
   escrito, nunca exercitado* — e isso é uma informação legítima, não uma
   confissão. O que não é legítimo é `[x]` sem ter rodado.
5. **A frase do plano descreve o que existe.** Se o item se chama "A2A server"
   e o que existe é REST com caminhos batizados de A2A, o nome está errado e o
   plano está mentindo. Renomear é mais barato do que descobrir depois.

### O vocabulário de status

| Marca | Significado |
|---|---|
| `[x]` | passa nas cinco linhas acima |
| `[~]` | existe e funciona, mas entrega **menos** do que a frase sugere — e a frase diz o quê |
| `🕳️` | código escrito, nunca exercitado fora do teste unitário |
| `[ ]` | não começou |

---

## Ao escrever código

**Comentário explica *por quê*, não *o quê*.** O código já diz o que faz. O que
ele não diz é qual alternativa foi descartada e por qual motivo — e é isso que
impede alguém (ou algum agente) de "simplificar" de volta para o bug. O
repositório inteiro segue essa convenção; mantenha-a.

**Mensagem devolvida ao agente é interface.** Este ponto é específico deste
projeto: agentes agem a partir do que leem. Um `hub_agent_status` que diz
"bloqueado, normalmente por orçamento" quando o motivo foi a vigilância faz o
agente orientar o usuário a aumentar um orçamento que não era o problema. Trate
esses textos com o rigor de um contrato de API — [`docs/05-vistoria.md`](docs/05-vistoria.md)
mostra cinco bugs que eram exatamente isso.

**Português nos identificadores é aceito e usado.** O código mistura inglês
(vocabulário do domínio: `Session`, `Brief`, `EventEnvelope`) e português
(mecânica interna: `#aguardarDecisao`, `resumoDaChamada`). Não uniformize; siga
o arquivo em que você está.

**Camada não olha para cima.** `core` não conhece adapters nem HTTP — recebe
portas injetadas. É o que permite testar orquestração, política e orçamento sem
invocar agente nenhum. Uma importação que viole isso é motivo para recusar a
mudança, mesmo que compile.

**Lógica que mais precisa de teste é a que menos precisa de processo rodando.**
`resilience.ts` e `workflow.ts` são puros de propósito. Quando você puder
escolher entre lógica dentro do `SessionManager` e lógica pura no `core` com
dependências injetadas, escolha a segunda.

---

## Commits

Mensagens no imperativo, descrevendo **o efeito observável**, não o arquivo
tocado. O histórico deste repositório é bom nisso e vale imitar:

```
fix(diff): o Hub creditava ao agente mudancas que ja estavam na arvore
fix: estado terminal era mutavel, e toda retomada de conversa do Codex falhava
```

Quando o commit conserta algo, o corpo diz **como aquilo passava despercebido**.
É a parte mais útil da mensagem seis meses depois.

---

## Antes de abrir PR

- [ ] `npm run verify` verde num checkout limpo
- [ ] Teste que ficaria vermelho sem a mudança
- [ ] Nenhum item de roadmap marcado `[x]` sem as cinco linhas do critério de pronto
- [ ] Se mudou comportamento documentado, o documento mudou junto

O CI roda Windows (Node 22.5 e 24) como portão. O job de Linux é
**informativo** — o Hub nunca foi executado nessa plataforma, e ele existe para
descobrir o que falta, não para bloquear. Ele deixa de ser informativo no dia em
que passar de forma consistente.
