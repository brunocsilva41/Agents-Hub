import { HELP_CICLO_DE_VIDA } from './lifecycle-help.js';
import { bold, dim } from './render.js';

/**
 * Texto do `hub help` e a ajuda por comando (`hub <cmd> --help`,
 * `hub help <cmd>`). Fora de `main.ts` para ser testável sem disparar `main()`
 * e para o erro de uso (`erro-cli.ts`) mostrar a linha de uso do comando.
 */

export const HELP = `
${bold('hub')} — plano de controle do Agents-Hub

${bold('Daemon')} ${dim('(sobe sozinho quando algum comando precisa)')}
  hub status                        agentes, sessões vivas e o que espera você
  hub daemon                        roda em primeiro plano, para ver os logs
  hub stop                          encerra o daemon e as sessões vivas
  hub health                        resposta crua da API
  hub autostart [enable|disable|status]  sobe o daemon no login do Windows (desligado por padrão)

${bold('Gate pré-execução')} ${dim('(bloqueia a ferramenta ANTES de ela rodar)')}
  hub hooks install claude --write   registra o hook PreToolUse no Claude Code
  hub hooks install codex --write    liga o bypass de confiança que o hook do Codex exige
  hub hooks                          mostra onde o gate está instalado
  hub hook [--dialect codex]         uso interno: o agente chama, não você

${bold('Agentes')}
  hub doctor                        instalado, versão, auth e quem está quebrado (sem gastar nada)
  hub doctor --smoke [--agent <id>] [--yes]
                                    sessão real em cada agente, um por vez, teto US$ 0,10 cada, num
                                    projeto descartável (GASTA TOKENS/CRÉDITOS; pede confirmação)
  hub agents                        lista agentes, capabilities e limitações
  hub discover [--agent <id>] [--json] [--refresh]
                                    o que cada CLI já tem: instalado, versão, auth, modelo padrão,
                                    servidores MCP e instruções globais (só leitura, nunca mostra segredo)
  hub import <agente> [--project <caminho>] [--kinds instructions,env,mcp] [--to ag1,ag2] [--write]
                                    traz o ambiente do agente para o projeto. SEM --write só imprime o plano.
      --kinds              padrão: instructions,env (mcp entra quando há --to)
      --to <ag1,ag2>       agentes que receberão os servidores MCP descobertos (merge + backup versionado .bak-<data>)
      --overwrite          substitui instrução/variável que o projeto já tem
      --include-env        copia o env dos servidores MCP (valores reais; padrão: só nomes, sem copiar)

${bold('Projetos')}
  hub projects                      lista projetos registrados
  hub project add [caminho]         registra um repositório (padrão: diretório atual)
  hub project env [projeto]                             lista o ambiente configurado por agente
      --agent <id>                 restringe a listagem a um agente
      ${dim('valores de chaves com cara de segredo (*KEY*, *TOKEN*, *SECRET*, Bearer...) aparecem mascarados')}
  hub project env [projeto] --agent <id> --set CHAVE=VALOR    configura uma variável (ex.: OPENAI_BASE_URL)
  hub project env [projeto] --agent <id> --unset CHAVE        remove uma variável
  hub project prompt [projeto] --agent <id>                   mostra a instrução salva para o agente
  hub project prompt [projeto] --agent <id> --set "texto"     grava a instrução
  hub project prompt [projeto] --agent <id> --clear           apaga a instrução
  hub project folders [projeto]                               lista as pastas vinculadas ao projeto
  hub project folders remove [projeto] <folderId>             desvincula uma pasta
  hub project trust [projeto]                                 confia no config.yaml do repo (validation.command, revisão, env, prompts, memory)
                                                              ${dim('se o conteúdo mudar depois, a confiança é suspensa: rode de novo')}
  hub project untrust [projeto]                               retira a confiança (padrão: não confiável)
      ${dim('[projeto] aceita id ou caminho; sem ele, usa o diretório atual (registra se preciso).')}

${bold('Sessões')}
  hub start --agent <id> "objetivo"          abre uma sessão-raiz e acompanha ao vivo
      --project <caminho>    projeto (padrão: diretório atual; subpasta de projeto usa o projeto)
      --budget-usd <n>       teto de custo do fluxo inteiro
      --mode <supervised|semi|autonomous>
      --isolation <worktree|none>
      --detach               não acompanha o stream
      --from <sessionId>     continua uma sessão terminada: resumo, contexto e branch dela
      --no-bell              sem bipe/título do terminal quando surge aprovação (vale para watch/send)
      --                     fim das flags: o resto é o objetivo, mesmo começando com "-"
      ${dim('saída: 0 concluída · 1 falhou/cancelada/erro · 2 parada esperando aprovação (vale para watch/send)')}
  hub sessions                                lista sessões
  hub watch <sessionId>                       acompanha uma sessão ao vivo
  hub watch --root <rootId>                   acompanha o fluxo inteiro, todos os agentes
  hub send <sessionId> "texto"                fala com uma sessão viva (terminada: hub start --from)
  hub interrupt <sessionId>                   para o turno atual; a sessão fica ociosa (retome com send)
  hub pause <sessionId>                       para o turno e pausa a sessão (retome com send)
  hub cancel <sessionId>                      encerra a sessão e seus filhos

${bold('Delegação e custo')}
  hub delegate <sessionId> --agent <id> "objetivo"   um agente pede a outro
  hub handoff <sessionId> --to <id>                  transfere a liderança da sessão
  hub diff <sessionId>                                o que o agente mudou no código
  hub artifacts <sessionId>                           artefatos da sessão (diff, log, report, transcript...)
  hub graph <rootId>                                  árvore de quem chamou quem
  hub budget <rootId>                                 consumo contra o orçamento

${bold('Aprovações e manutenção')}
  hub approvals                      o que está esperando sua decisão
  hub approve <id>                   libera e a sessão continua de onde parou
  hub deny <id>                      nega (gate: só aquela chamada; orçamento: encerra a sessão)
  hub prune                          recolhe worktrees de sessões já expiradas
  ${dim('approve/deny/prune/stop e as edições abaixo exigem o token de <AGENTS_HUB_HOME>/operator-token (a CLI lê sozinha)')}

${bold('Política e auditoria')}
  hub policy [show] [--project [p]] [--json]     camadas (global/projeto) e a política efetiva
  hub policy set <campo> <valor> [--project [p]] ex.: set defaultBudget.usd 2 · set maxDepth 2
  hub policy unset <campo> [--project [p]]       volta o campo ao nível de baixo
  hub policy allow|deny add|rm <prefixo> [--project [p]]
                                                 allow/deny list de comandos (projeto só aperta)
  hub policy mode <risco> <allow|approve|deny> [--project [p]]
                                                 decisão por nível: read|write|exec|escalate|irreversible|budget
  hub audit [sessionId] [--project [p]] [--kind k] [--since 2h|ISO] [--until ISO] [--limit n] [--json]
                                                 quem decidiu o quê: gate, aprovações, política, confiança

${bold('Workflows (DAG de múltiplos agentes)')}
  hub workflow validate <arquivo.yaml>       valida sintaxe, dependências e ciclos
  hub workflow run <arquivo.yaml>            executa o workflow em lotes paralelos

${bold('MCP — dar ao agente o poder de chamar os outros')}
  hub mcp                            mostra o estado do registro em cada agente
  hub mcp show <agente>              imprime o trecho de config para colar
  hub mcp install <agente> --write   grava a config (merge, backup versionado .bak-<data>)
      --project <caminho>    para agentes com config por projeto (Claude Code)

${HELP_CICLO_DE_VIDA}
${dim('Alvo do --agent aceita id (codex) ou capability (cap:test-writing).')}
${dim('Horários aparecem na hora local deste computador, com o fuso (ex.: UTC-3) nas listagens.')}
${dim('Ajuda de um comando: hub <comando> --help. Erros saem com código 1 (2 só para "parada esperando aprovação").')}
`;

/**
 * As linhas do `HELP` que documentam `comando` (a linha `hub <comando> ...` e
 * as continuações mais indentadas logo abaixo dela). Vazio quando o comando
 * não aparece no help. Sem cor: o texto é recortado depois de tirar os ANSI.
 */
export function ajudaDoComando(comando: string, help: string = HELP): string[] {
  const alvo = comando.trim().toLowerCase();
  if (alvo === '' || alvo.startsWith('-')) return [];
  const padrao = new RegExp(`^hub ${escapar(alvo)}(\\s|$)`);
  const saida: string[] = [];
  let indentDoBloco = -1;
  for (const linha of semCor(help).split(/\r?\n/)) {
    const indent = linha.length - linha.trimStart().length;
    const texto = linha.trim();
    // `hub version | hub --version`: a linha pode citar o comando depois de `|`.
    if (texto.split(' | ').some((parte) => padrao.test(parte.trim()))) {
      saida.push(linha);
      indentDoBloco = indent;
      continue;
    }
    // Continuação: mais indentada que a linha do comando e não é outro `hub ...`.
    if (indentDoBloco >= 0 && texto !== '' && indent > indentDoBloco && !texto.startsWith('hub ')) {
      saida.push(linha);
      continue;
    }
    indentDoBloco = -1;
  }
  return saida;
}

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

function semCor(texto: string): string {
  return texto.replace(ANSI, '');
}

function escapar(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
