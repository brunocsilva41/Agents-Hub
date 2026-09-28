import path from 'node:path';
import type { Decision, GuardedAction, RiskLevel, SessionMode } from '@agents-hub/core';
// Subcaminho, não o índice do core: o hook importa este módulo a cada leitura
// do agente, e o índice arrasta o zod e a política inteira.
import { matchSecretPath } from '@agents-hub/core/sensitive-paths';

/**
 * Gate PRÉ-execução, ligado por hook do agente.
 *
 * A vigilância reativa (`session-manager.#watch`) só vê o comando depois que
 * ele rodou — ela impede a PRÓXIMA ação, não a atual. Um hook que o agente
 * consulta *antes* de executar a ferramenta é a única forma de prevenção real
 * sem sandbox de sistema operacional, e é o que fecha a lacuna que a
 * documentação vinha assumindo explicitamente.
 *
 * Este módulo é puro: recebe a chamada de ferramenta e devolve o veredito. Quem
 * fala HTTP, quem descobre a sessão e quem escreve no stdout do hook são outros.
 */

export interface ToolCall {
  /** Nome da ferramenta como o agente a chama (`Bash`, `Write`, `Edit`, ...). */
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Diretório onde o agente está rodando, quando informado. */
  cwd?: string | undefined;
}

export interface GateVerdict {
  decision: Decision;
  risk: RiskLevel;
  reason: string;
  /** Ações que a chamada representa — vazio quando não há risco a classificar. */
  actions: GuardedAction[];
}

/**
 * Traduz uma chamada de ferramenta nas ações que a política sabe classificar.
 *
 * Os nomes cobrem as três famílias que carregam risco de verdade: shell,
 * escrita em arquivo e rede. Ferramenta desconhecida NÃO vira ação — negar o
 * que não se entende transformaria cada ferramenta nova num bloqueio
 * misterioso, e o usuário desligaria o hook inteiro no primeiro dia.
 */
export function actionsOfToolCall(call: ToolCall, workdir: string): GuardedAction[] {
  const nome = call.toolName.toLowerCase();
  const input = call.toolInput;

  if (nome === 'bash' || nome === 'powershell' || nome === 'shell' || nome === 'terminal') {
    const command = texto(input['command']);
    return command ? [{ kind: 'command', command }] : [];
  }

  if (nome === 'write' || nome === 'edit' || nome === 'notebookedit' || nome === 'multiedit') {
    const alvo = texto(input['file_path']) ?? texto(input['path']) ?? texto(input['notebook_path']);
    return alvo ? [{ kind: 'file.write', path: path.resolve(workdir, alvo) }] : [];
  }

  if (nome === 'read' || nome === 'glob' || nome === 'grep') {
    const alvo = texto(input['file_path']) ?? texto(input['path']);
    const acoes: GuardedAction[] = alvo
      ? [{ kind: 'file.read', path: path.resolve(workdir, alvo) }]
      : [];
    // `Grep` com filtro de arquivo (`glob: ".env*"`) lê o CONTEÚDO do que o
    // filtro alcança, mesmo com `path` inocente: o filtro entra como o último
    // segmento do caminho, e o classificador de segredo já sabe ler curinga.
    const filtro = nome === 'grep' ? texto(input['glob']) : undefined;
    if (filtro) acoes.push({ kind: 'file.read', path: path.resolve(workdir, alvo ?? '.', filtro) });
    return acoes;
  }

  if (nome === 'webfetch' || nome === 'websearch') {
    const url = texto(input['url']);
    return url ? [{ kind: 'network', url }] : [];
  }

  return [];
}

const FERRAMENTAS_DE_LEITURA = new Set(['read', 'glob', 'grep']);

/**
 * A chamada é uma leitura COMUM — dá para responder no próprio hook, sem
 * perguntar ao daemon?
 *
 * `Read` e `Grep` entraram no matcher para que ler `~/.ssh/id_rsa` ou `.env`
 * pela ferramenta de leitura pare no gate como para em `cat` pelo shell. Mas o
 * agente lê muito mais do que escreve: se toda leitura fizesse a ida HTTP ao
 * daemon (e a busca da sessão, a política efetiva, o registro), o custo cairia
 * justamente no caminho quente. Então o hook decide sozinho o caso comum e só
 * leva ao daemon o que a política classificaria como segredo.
 *
 * A regra é a do daemon (`#classifyRead`: segredo é `irreversible`, o resto é
 * `read`), aplicada de forma CONSERVADORA — errar aqui só pode mandar ao daemon
 * uma leitura a mais, nunca liberar uma que ele pararia:
 * - o daemon casa o caminho RELATIVO ao worktree; os segmentos do relativo são
 *   um sufixo dos do absoluto, então testar o absoluto casa tudo que o
 *   relativo casaria (e mais);
 * - o texto cru da entrada também é testado, para o caso de o daemon resolver
 *   contra um diretório diferente do `cwd` que o hook recebeu.
 *
 * Limite conhecido e aceito: uma política que endureça `risk.read` para além
 * de `allow` não é vista aqui (ler a política custaria o que se quer evitar).
 * Antes desta mudança nenhuma leitura chegava ao gate; o caso comum continua
 * igual, e o segredo passa a parar.
 */
export function leituraComum(call: ToolCall, workdir: string): boolean {
  if (!FERRAMENTAS_DE_LEITURA.has(call.toolName.toLowerCase())) return false;
  const crus = ['file_path', 'path', 'glob'].map((k) => texto(call.toolInput[k]));
  if (crus.some((c) => c !== undefined && matchSecretPath(c) !== null)) return false;
  return actionsOfToolCall(call, workdir).every(
    (a) => a.kind === 'file.read' && matchSecretPath(a.path) === null,
  );
}

/**
 * Frase curta que descreve a chamada na fila de aprovações.
 *
 * Quem lê isto está decidindo se libera ou não, quase sempre de relance — na
 * CLI, numa linha só. Então o que importa é o **argumento perigoso**, não o
 * nome da ferramenta: "Bash" não diz nada, `git push origin main` decide a
 * questão sozinho. Por isso cada família devolve o campo que carrega o risco.
 *
 * Ferramenta desconhecida não vira "sem detalhe": devolve as chaves do input.
 * Saber que a chamada mexe em `file_path` e `content` é pouco, mas é mais do
 * que uma linha muda — e uma aprovação que não diz o que está aprovando é uma
 * aprovação que a pessoa dá no automático.
 *
 * O corte é por caracteres, pelo fim: comando longo tem o alvo no começo
 * (`rm -rf /caminho/...`), e é o começo que revela a intenção.
 */
export function resumoDaChamada(
  toolName: string,
  toolInput: Record<string, unknown>,
  limite = 160,
): string {
  const nome = toolName.toLowerCase();

  if (nome === 'bash' || nome === 'powershell' || nome === 'shell' || nome === 'terminal') {
    return cortar(texto(toolInput['command']) ?? '(comando vazio)', limite);
  }

  if (nome === 'write' || nome === 'edit' || nome === 'notebookedit' || nome === 'multiedit') {
    const alvo =
      texto(toolInput['file_path']) ?? texto(toolInput['path']) ?? texto(toolInput['notebook_path']);
    return cortar(alvo ?? '(caminho não informado)', limite);
  }

  if (nome === 'read' || nome === 'glob' || nome === 'grep') {
    const alvo =
      texto(toolInput['file_path']) ?? texto(toolInput['path']) ?? texto(toolInput['pattern']);
    return cortar(alvo ?? '(alvo não informado)', limite);
  }

  if (nome === 'webfetch' || nome === 'websearch') {
    return cortar(texto(toolInput['url']) ?? texto(toolInput['query']) ?? '(url não informada)', limite);
  }

  const chaves = Object.keys(toolInput);
  if (chaves.length === 0) return '(sem argumentos)';
  return cortar(`campos: ${chaves.join(', ')}`, limite);
}

function cortar(valor: string, limite: number): string {
  const limpo = valor.replace(/\s+/g, ' ').trim();
  if (limpo.length === 0) return '(vazio)';
  return limpo.length <= limite ? limpo : `${limpo.slice(0, limite - 1)}…`;
}

/**
 * Combina os vereditos das ações de uma chamada.
 *
 * A decisão mais restritiva vence: uma chamada que escreve em dois arquivos,
 * um deles fora do worktree, é tão perigosa quanto a pior das suas partes.
 */
export function combineVerdicts(
  partes: Array<{ decision: Decision; risk: RiskLevel; reason: string }>,
): { decision: Decision; risk: RiskLevel; reason: string } {
  if (partes.length === 0) {
    return { decision: 'allow', risk: 'read', reason: 'sem ação de risco a classificar' };
  }

  const ordem: Record<Decision, number> = { allow: 0, approve: 1, deny: 2 };
  return partes.reduce((pior, atual) => (ordem[atual.decision] > ordem[pior.decision] ? atual : pior));
}

/**
 * Como o veredito do Hub vira permissão do agente.
 *
 * O vocabulário do hook do Claude Code é `allow | deny | ask | defer` — medido
 * no schema embutido no binário (2.1.283). `ask` devolve a decisão a quem está
 * no teclado. A versão anterior devolvia `escalate`, que NÃO existe nesse
 * vocabulário: era um valor inválido que só não quebrava nada porque o gate
 * bloqueante nunca devolve `approve` (ele espera a decisão humana e responde
 * `allow` ou `deny`).
 *
 * `approve` do Hub vira `ask`, nunca `deny`. Transformar "precisa de
 * aprovação" em "negado" faria o agente concluir que a ação é impossível e
 * procurar outro caminho para o mesmo efeito — exatamente o comportamento que
 * um gate de segurança não pode induzir.
 */
export type HookPermission = 'allow' | 'deny' | 'ask';

export function toHookPermission(decision: Decision): HookPermission {
  switch (decision) {
    case 'allow':
      return 'allow';
    case 'approve':
      return 'ask';
    case 'deny':
      return 'deny';
  }
}

// --------------------------------------------------------------- tempos
//
// Três relógios decidem se o gate protege ou falha aberto, e a ordem entre
// eles é o contrato inteiro:
//
//   espera do daemon  <  teto HTTP do hook  <  timeout do hook no agente
//        55 s                  100 s                   120 s
//
// Medido com o `claude` real (vistoria de 2026-09-25): quando o hook estoura o
// timeout que o agente deu a ele, a ferramenta RODA. Com o hook instalado a
// 10 s e o daemon esperando 60 s, toda ação que pedia aprovação humana rodava
// sem ela depois de 10 s — o caminho mais forte do gate era o único que
// nunca protegia. Com a ordem acima, quem desiste primeiro é sempre o daemon,
// e a desistência dele é `deny`; o hook ainda tem folga para aplicar o modo
// de falha se o daemon sumir; e o agente só desistiria de um hook que já
// morreu por outro motivo.
//
// Nem o Claude Code (schema `timeout: positive()`, sem teto; padrão de 600 s)
// nem o Codex (`timeoutSec`, sem teto no binário 0.155.0) limitam o valor, então
// 120 s é escolha nossa: longo o bastante para uma pessoa ler e decidir,
// curto o bastante para um agente parado não parecer travado para sempre.

/** Quanto o daemon espera por uma decisão humana antes de NEGAR a chamada. */
export const ESPERA_DO_GATE_MS = 55_000;

/**
 * Quanto o processo do hook espera o daemon responder antes de aplicar o modo
 * de falha. Maior que a espera do daemon (a resposta normal sempre chega
 * antes) e menor que o timeout do hook (o hook ainda consegue falar).
 */
export const TETO_HTTP_DO_HOOK_MS = 100_000;

/** Timeout gravado na config do agente (`timeout` do Claude, `timeoutSec` do Codex). */
export const TIMEOUT_DO_HOOK_SEC = 120;

/**
 * Saída do hook no dialeto do **Codex**, que não é o do Claude Code.
 *
 * Descoberto sondando o binário real (0.149.1), não deduzido — e as duas
 * diferenças importam:
 *
 * 1. **Permitir é ficar calado.** Devolver `permissionDecision: "allow"` faz o
 *    Codex registrar `hook: PreToolUse Failed`; o binário traz a string
 *    "PreToolUse hook returned unsupported permissionDecision:allow". Saída
 *    vazia dá `hook: PreToolUse Completed` e a ferramenta roda. Se o Hub
 *    respondesse `allow` como responde ao Claude, **toda ação permitida
 *    quebraria** — o caminho feliz seria o único a falhar.
 *
 * 2. **Não existe `ask`.** O Claude escala para aprovação humana com
 *    `escalate`; o Codex marca `ask` como não suportado. Então a decisão
 *    `approve` do Hub vira `deny` aqui, com um motivo que manda o agente
 *    pedir ao humano em vez de tentar outro caminho. É menos elegante e mais
 *    honesto do que fingir que existe uma escalada.
 *
 * O motivo é obrigatório em `deny`: o binário reclama de
 * "permissionDecision:deny without a non-empty permissionDecisionReason".
 *
 * `null` significa "não escreva nada no stdout".
 */
export function toCodexHookOutput(
  verdict: { decision: Decision; risk: RiskLevel; reason: string },
  mode: SessionMode,
): CodexHookOutput | null {
  if (verdict.decision === 'allow') return null;

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: explainToAgent(verdict, mode),
    },
  };
}

export interface CodexHookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny';
    permissionDecisionReason: string;
  };
}

/** Frase que o agente vê quando a ação é barrada — precisa dizer o que fazer. */
export function explainToAgent(
  verdict: { decision: Decision; risk: RiskLevel; reason: string },
  mode: SessionMode,
): string {
  if (verdict.decision === 'allow') return verdict.reason;

  const base = `Agents-Hub classificou esta ação como "${verdict.risk}": ${verdict.reason}.`;

  if (verdict.decision === 'deny') {
    return `${base} A política do projeto proíbe esta ação. Não tente contornar — explique ao usuário o que você precisava fazer e por quê.`;
  }

  return (
    `${base} A sessão está em modo "${mode}", então esta ação precisa de aprovação humana. ` +
    `Se for negada, siga com o resto da tarefa em vez de tentar outro caminho para o mesmo efeito.`
  );
}

function texto(valor: unknown): string | undefined {
  return typeof valor === 'string' && valor.length > 0 ? valor : undefined;
}
