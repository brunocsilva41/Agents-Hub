# 05 — Vistoria: lacunas encontradas e corrigidas

Varredura sistemática atrás de erro de lógica, buraco de estado e — o que mais apareceu — **erro de comunicação**: casos em que o Hub dizia ao agente ou ao usuário algo que não era verdade.

Sete achados, todos confirmados lendo o código ou rodando contra o daemon real, não por suposição.

## 1. O agente perdia toda a memória ao receber uma mensagem

**Gravidade: alta. É a falha que mais degradava o resultado.**

Quando o agente não tem sessão nativa, cada turno é um processo novo com contexto zero. O `send()` mandava **só a mensagem nova**. O agente recebia um "o teste ainda falha" sem saber qual era a tarefa, o que já tinha feito, nem o que já tinha tentado.

O modo até se chamava `replay` — e não repetia nada.

O alcance é maior do que os manifestos sugerem. Só o `antigravity` declara `strategy: replay`, mas o caminho também dispara em **qualquer agente cujo id nativo ainda não foi capturado** — o que inclui Copilot e Kimi em *todo primeiro turno*, já que os dois só revelam o id no evento final.

**Correção:** `rebuildConversation` monta a continuação a partir do que o Hub já guarda — brief original, resumo condensado do que aconteceu (mensagens, comandos com desfecho, arquivos alterados, erros, delegações) e a mensagem nova, claramente separada.

O corte por tamanho preserva o **fim** do histórico: o começo de uma sessão é exploração, o fim é onde o trabalho está e de onde a continuação parte.

## 2. Falar com sessão já encerrada lançava um processo novo

`send()` não checava o estado. Mandar mensagem para uma sessão `killed` ou `failed` subia um agente numa sessão que ninguém mais observa — trabalho rodando num lugar morto.

**Correção:** recusa com motivo e caminho (`abra uma sessão nova ou delegue a partir de outra`). O painel agora bloqueia o campo antes, em vez de deixar o erro do servidor explicar depois que a pessoa já digitou.

## 3. A timeline mentia sobre por que a sessão parou

Toda pausa por decisão humana emitia `reason: 'orçamento esgotado'` — inclusive quando o motivo tinha sido a vigilância barrando uma ação irreversível.

**Correção:** o evento busca a aprovação pendente e reporta a ação real que está segurando a sessão, junto do `approvalId`.

## 4. O agente que delegou não sabia por que a tarefa travou

O `hub_agent_status` do MCP dizia: *"bloqueada aguardando decisão humana (normalmente orçamento esgotado)"*. Desde que o gate pré-execução e a vigilância também bloqueiam, esse "normalmente" virou chute — e o agente repassava o chute ao usuário.

**Correção:** `/tasks/:id` devolve a aprovação que está bloqueando, e o MCP informa a ação, o nível de risco e **o comando exato** para destravar (`hub approve <id>`). O resultado da validação também passou a aparecer no status.

## 5. O gate podia aplicar a política de uma sessão morta

Com `isolation: none`, várias sessões dividem o diretório do projeto. A busca por `cwd` pegava a mais recente por data de criação, **sem olhar o estado** — podia decidir por uma sessão encerrada, cujo contexto não existe mais e cuja política pode ser mais frouxa que a da sessão que está rodando.

**Correção:** sessão viva (`running` ou `waiting_approval`) tem prioridade; a mais recente só entra como último recurso.

## 6. Depois de um restart, o painel ficava cego para sessões retomadas

O vínculo sessão→raiz vive em memória no barramento de eventos. Era registrado ao criar a sessão, mas **não** ao retomá-la. Depois de reiniciar o daemon, `hub watch --root` e o painel deixavam de receber os eventos daquela sessão — sem erro nenhum, só silêncio, que é o pior tipo de falha de observabilidade.

**Correção:** o vínculo é reidratado em toda subida de run.

## 7. Fallback furava o teto de concorrência

`#assertConcurrency` só era chamado ao criar sessão. Retry e troca de agente entravam por outro caminho, então uma cadeia de fallbacks em paralelo passava do limite configurado.

**Correção:** o substituto passa pela mesma checagem; recusa vira `failed` com evento de prioridade alta em vez de estourar silenciosamente o limite.

## Padrão por trás dos achados

Cinco dos sete não são bugs de execução — o código fazia o que estava escrito. São **bugs de verdade dita**: a mensagem, o estado ou o contexto que chegava do outro lado não correspondia à realidade.

Num sistema onde agentes agem a partir do que leem, uma mensagem imprecisa não é cosmética: ela vira ação errada. O agente que recebe "bloqueado, normalmente por orçamento" vai orientar o usuário a aumentar um orçamento que não era o problema; o que recebe uma mensagem sem contexto refaz do zero o que já tinha feito.

É por isso que o texto que o Hub devolve ao agente é tratado aqui como interface, com a mesma exigência de um contrato de API.
