import { HubClient } from '@agents-hub/client';

/**
 * Ponte entre o hook `PreToolUse` do agente e a política do Hub.
 *
 * Contrato confirmado empiricamente contra o binário do Claude Code (não
 * deduzido da documentação):
 *
 *   stdin  → { session_id, cwd, tool_name, tool_input, tool_use_id, ... }
 *   stdout → { hookSpecificOutput: { hookEventName, permissionDecision,
 *              permissionDecisionReason } }
 *   saída 0 = obedece o JSON; 2 = bloqueia com o stderr como motivo.
 *
 * A sonda também confirmou que `AGENTS_HUB_SESSION_ID` — que o Hub injeta ao
 * spawnar o agente — CHEGA no processo do hook. É essa variável que correlaciona
 * a chamada com a sessão, sem depender de adivinhar por diretório.
 *
 * # Dois dialetos, e a diferença quebra o caminho feliz
 *
 * O Codex (0.149.1) tem o MESMO vocabulário de entrada — `tool_name: "Bash"`,
 * `tool_input.command`, `cwd` — mas responde a um dialeto diferente na saída,
 * medido contra o binário:
 *
 *   Claude:  permitir = { permissionDecision: "allow", ... }
 *   Codex:   permitir = NÃO ESCREVER NADA
 *
 * Devolver `allow` ao Codex faz ele registrar `hook: PreToolUse Failed`. Ou
 * seja, usar o dialeto errado não falharia no bloqueio — falharia em TODA ação
 * permitida, que é a maioria esmagadora das chamadas.
 *
 * O Codex também não tem `ask`: a decisão `approve` do Hub vira `deny` com um
 * motivo que manda o agente falar com o humano.
 *
 * O dialeto é declarado por quem chama, não farejado do payload. Para o Codex é
 * o próprio Hub que emite o comando do hook (config inline por `-c hooks={...}`),
 * então ele sabe o que está invocando; adivinhar por formato daria um erro
 * silencioso no dia em que os payloads convergirem.
 *
 * O Codex também NÃO recebe `AGENTS_HUB_SESSION_ID` — a sonda confirmou que só
 * chegam variáveis `CODEX_*`. Para ele a correlação sai do `cwd`, que no Hub é
 * o worktree da sessão.
 */

export type DialetoDeHook = 'claude' | 'codex';

export interface HookInput {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

interface GateResponse {
  permission: 'allow' | 'deny' | 'escalate';
  explanation: string;
  reason: string;
  risk: string;
  sessionId: string | null;
}

/**
 * FALHA ABERTA de propósito.
 *
 * O hook pode estar instalado globalmente e disparar em toda sessão do agente,
 * inclusive quando o Hub não está envolvido. Bloquear porque o daemon está
 * desligado transformaria o Hub numa dependência do seu editor — e a primeira
 * reação de qualquer pessoa seria desinstalar o hook, que é o pior desfecho
 * possível para um controle de segurança.
 *
 * A garantia que fica de pé é a que importa: quando o daemon RESPONDE e diz
 * "negado", a ferramenta não roda.
 */
export async function decideToolCall(
  entrada: HookInput,
  baseUrl: string,
  dialeto: DialetoDeHook = 'claude',
): Promise<{ saida: string; codigo: number }> {
  const toolName = entrada.tool_name;
  if (typeof toolName !== 'string' || toolName.length === 0) {
    return { saida: permitir('chamada sem nome de ferramenta', dialeto), codigo: 0 };
  }

  const client = new HubClient(baseUrl);
  const sessionId = process.env['AGENTS_HUB_SESSION_ID'];

  try {
    const veredito = await client.gateToolCall({
      // Só manda o id do Hub se ele tiver o formato esperado: a validação da
      // borda recusa qualquer outra coisa, e aí a chamada inteira falharia.
      ...(sessionId && /^ses_[a-z0-9]+$/i.test(sessionId) ? { sessionId } : {}),
      ...(entrada.session_id ? { nativeSessionId: entrada.session_id } : {}),
      ...(entrada.cwd ? { cwd: entrada.cwd } : {}),
      toolName,
      toolInput: entrada.tool_input ?? {},
    });

    return { saida: responder(veredito, dialeto), codigo: 0 };
  } catch {
    return {
      saida: permitir('Agents-Hub indisponível — sem política a aplicar', dialeto),
      codigo: 0,
    };
  }
}

function responder(veredito: GateResponse, dialeto: DialetoDeHook): string {
  if (dialeto === 'codex') {
    // Silêncio é o "sim" do Codex.
    if (veredito.permission === 'allow') return '';
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: veredito.explanation,
      },
    });
  }

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: veredito.permission,
      permissionDecisionReason: veredito.explanation,
    },
  });
}

function permitir(motivo: string, dialeto: DialetoDeHook): string {
  if (dialeto === 'codex') return '';
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: motivo,
    },
  });
}

/** Lê o stdin inteiro; o hook recebe um JSON só e fecha. */
export async function lerStdin(): Promise<string> {
  const partes: Buffer[] = [];
  for await (const pedaco of process.stdin) partes.push(pedaco as Buffer);
  return Buffer.concat(partes).toString('utf8');
}
