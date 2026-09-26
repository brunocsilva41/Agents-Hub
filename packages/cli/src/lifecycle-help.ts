import { bold, dim } from './render.js';

/**
 * Trecho do `hub help` com os comandos do item 5.6. Fica fora de `main.ts`
 * para o texto de ajuda de lá mudar numa linha só.
 */
export const HELP_CICLO_DE_VIDA = `${bold('Primeiro uso, ciclo de vida e manutenção')}
  hub init [--yes]                   onboarding: node/git, daemon, agentes (descoberta), registra o
                                     diretório atual e sugere hooks/mcp em PRÉVIA (nada gravado)
  hub open [--print]                 abre o painel no navegador padrão
  hub logs [--lines N] [--follow] [--list]
                                     log do daemon autostartado (<home>/logs)
  hub restart [--force]              encerra o daemon (token de operador) e sobe de novo
                                     ${dim('com sessão viva, recusa sem --force (reiniciar encerra as sessões)')}
  hub update [--check] [--json]      como atualizar (não há canal publicado: é git pull + build)
  hub version | hub --version [--json]
  hub backup [--out arquivo] [--json]
                                     cópia consistente do banco (VACUUM INTO — inclui o WAL)
  hub restore <arquivo> [--write]    troca o banco pelo backup; só com o daemon parado,
                                     guarda o atual em hub.db.pre-restore-<data>

${bold('Resultado e custo')}
  hub export <sessionId> [--format md|json] [--out arquivo] [--raw] [--force]
                                     timeline, custo, tarefas e diff num arquivo
  hub cost [--since 7d | --all] [--project X] [--json]
                                     custo agregado por agente, projeto, dia e fluxo
  hub merge <sessionId> [--strategy merge|cherry-pick|squash] [--write]
  hub apply <sessionId> [--write]    traz o trabalho do branch hub/<id> (+ alterações não commitadas)
                                     para o branch atual. SEM --write só mostra a prévia; exige árvore
                                     limpa; conflito é desfeito; nunca força, nunca faz push.
                                     ${dim('apply = --strategy squash (fica no índice para você commitar)')}

${bold('Saída para scripts')}
  --json em status, health, sessions, projects, agents, approvals, budget, graph, doctor,
  discover, policy show, audit, cost, update, version, backup: só JSON no stdout.
`;
