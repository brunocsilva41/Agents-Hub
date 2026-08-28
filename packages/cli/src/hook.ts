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
 */

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
): Promise<{ saida: string; codigo: number }> {
  const toolName = entrada.tool_name;
  if (typeof toolName !== 'string' || toolName.length === 0) {
    return { saida: permitir('chamada sem nome de ferramenta'), codigo: 0 };
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

    return { saida: responder(veredito), codigo: 0 };
  } catch {
    return { saida: permitir('Agents-Hub indisponível — sem política a aplicar'), codigo: 0 };
  }
}

function responder(veredito: GateResponse): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: veredito.permission,
      permissionDecisionReason: veredito.explanation,
    },
  });
}

function permitir(motivo: string): string {
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
