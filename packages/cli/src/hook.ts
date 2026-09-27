import { HubClient } from '@agents-hub/client';
// Subcaminho, não o índice do daemon: o hook roda a cada Bash/Edit/Write do
// agente, e o índice arrasta store/`node:sqlite`, adapters e o servidor HTTP.
import { actionsOfToolCall, TETO_HTTP_DO_HOOK_MS } from '@agents-hub/daemon/pretool-gate';

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
 * chegam variáveis `CODEX_*`. Por isso o Hub põe o id no próprio comando do
 * hook (`--session ses_...`), que ele monta a cada invocação.
 */

export type DialetoDeHook = 'claude' | 'codex';

export interface HookInput {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** Id da chamada no agente: o daemon reconhece a mesma chamada vinda de dois hooks. */
  tool_use_id?: string;
}

interface GateResponse {
  permission: 'allow' | 'deny' | 'ask' | 'escalate';
  explanation: string;
  reason: string;
  risk: string;
  sessionId: string | null;
}

/**
 * O que fazer quando o daemon NÃO responde (fora do ar, erro, resposta
 * inválida, demora além do teto). Ver `GateConfig` no daemon.
 */
export type ModoDeFalha = 'open' | 'closed';

export interface OpcoesDoHook {
  /**
   * Id da sessão do Hub, quando o hook sabe qual é: `AGENTS_HUB_SESSION_ID`
   * no Claude, `--session` no Codex. É o que prova que a chamada vem de uma
   * sessão do Hub.
   */
  sessionId?: string | undefined;
  /** `gate.failMode` da config global; ausente = padrão por contexto. */
  failMode?: ModoDeFalha | undefined;
  /** Quanto esperar o daemon. Padrão: `TETO_HTTP_DO_HOOK_MS`. */
  tetoMs?: number | undefined;
}

/**
 * Modo de falha efetivo.
 *
 * Padrão: FECHADO para sessão do Hub, ABERTO fora dela.
 *
 * O hook pode estar instalado globalmente e disparar em toda sessão do agente,
 * inclusive quando o Hub não está envolvido. Bloquear ali porque o daemon está
 * desligado transformaria o Hub numa dependência do seu editor — e a primeira
 * reação de qualquer pessoa seria desinstalar o hook, o pior desfecho possível
 * para um controle de segurança.
 *
 * Numa sessão que o Hub spawnou, o raciocínio inverte: a sessão prometeu
 * passar pela política (o modo `supervised` existe por isso), o daemon é quem
 * a está rodando, e o silêncio dele — caiu, travou, respondeu lixo — não pode
 * virar permissão para `git push --force`. Antes, qualquer exceção virava
 * `allow`, inclusive um 400 por entrada malformada.
 */
export function modoDeFalhaEfetivo(
  configurado: ModoDeFalha | undefined,
  sessaoDoHub: boolean,
): ModoDeFalha {
  return configurado ?? (sessaoDoHub ? 'closed' : 'open');
}

/**
 * A chamada tem risco a barrar quando o gate falha fechado?
 *
 * Mesmo critério do daemon (`actionsOfToolCall`): shell, escrita e rede têm;
 * leitura e ferramenta desconhecida não. Negar leitura no modo fechado só
 * cegaria o agente sem proteger nada.
 */
export function chamadaDeRisco(toolName: string, toolInput: unknown, cwd?: string): boolean {
  // Entrada que não é objeto é anômala (o agente sempre manda objeto): sem
  // como classificar, o lado seguro é tratá-la como risco.
  if (typeof toolInput !== 'object' || toolInput === null || Array.isArray(toolInput)) return true;
  const acoes = actionsOfToolCall(
    { toolName, toolInput: toolInput as Record<string, unknown>, cwd },
    cwd ?? process.cwd(),
  );
  return acoes.some((a) => a.kind !== 'file.read');
}

const ID_DE_SESSAO = /^ses_[a-z0-9]+$/i;

export async function decideToolCall(
  entrada: HookInput,
  baseUrl: string,
  dialeto: DialetoDeHook = 'claude',
  opcoes: OpcoesDoHook = {},
): Promise<{ saida: string; codigo: number }> {
  const toolName = entrada.tool_name;
  if (typeof toolName !== 'string' || toolName.length === 0) {
    return { saida: permitir('chamada sem nome de ferramenta', dialeto), codigo: 0 };
  }

  // Só conta como sessão do Hub se o id tiver o formato esperado: a validação
  // da borda recusa qualquer outra coisa, e aí a chamada inteira falharia.
  const sessionId =
    opcoes.sessionId && ID_DE_SESSAO.test(opcoes.sessionId) ? opcoes.sessionId : undefined;
  // Vai como veio: um `tool_input` torto é recusado pela borda do daemon, e
  // essa recusa cai no modo de falha — não vira `{}` "sem ação de risco".
  const toolInput = entrada.tool_input ?? {};

  const client = new HubClient(baseUrl);
  const teto = opcoes.tetoMs ?? TETO_HTTP_DO_HOOK_MS;
  let timer: NodeJS.Timeout | undefined;

  try {
    // Teto próprio: o daemon responde em até `ESPERA_DO_GATE_MS`; se passar
    // muito disso, algo travou, e o hook precisa decidir ANTES de o agente
    // desistir dele — desistência do agente é ferramenta rodando.
    const estouro = new Promise<never>((_, rejeitar) => {
      timer = setTimeout(() => rejeitar(new Error('daemon não respondeu a tempo')), teto);
    });
    const veredito = await Promise.race([
      client.gateToolCall({
        ...(sessionId ? { sessionId } : {}),
        ...(entrada.session_id ? { nativeSessionId: entrada.session_id } : {}),
        ...(entrada.cwd ? { cwd: entrada.cwd } : {}),
        ...(typeof entrada.tool_use_id === 'string' &&
        entrada.tool_use_id.length > 0 &&
        entrada.tool_use_id.length <= 200
          ? { toolUseId: entrada.tool_use_id }
          : {}),
        toolName,
        toolInput,
      }),
      estouro,
    ]);

    return { saida: responder(veredito, dialeto), codigo: 0 };
  } catch (err) {
    const modo = modoDeFalhaEfetivo(opcoes.failMode, sessionId !== undefined);
    if (modo === 'closed' && chamadaDeRisco(toolName, toolInput, entrada.cwd)) {
      return {
        saida: negar(
          `Agents-Hub não deu um veredito (${(err as Error).message}) e o gate desta sessão falha ` +
            'FECHADO: ações de shell, escrita e rede ficam negadas até o daemon voltar. ' +
            'Não tente contornar — diga ao usuário que o Agents-Hub está indisponível ' +
            '(`hub daemon` para subir de novo).',
          dialeto,
        ),
        codigo: 0,
      };
    }
    return {
      saida: permitir('Agents-Hub indisponível — sem política a aplicar', dialeto),
      codigo: 0,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function responder(veredito: GateResponse, dialeto: DialetoDeHook): string {
  if (dialeto === 'codex') {
    // Silêncio é o "sim" do Codex.
    if (veredito.permission === 'allow') return '';
    return negar(veredito.explanation, dialeto);
  }

  // `escalate` é o nome antigo de `ask` (daemon de versão anterior): o
  // Claude Code não conhece `escalate`, então traduzimos em vez de repassar.
  const decisao = veredito.permission === 'escalate' ? 'ask' : veredito.permission;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decisao,
      permissionDecisionReason: veredito.explanation,
    },
  });
}

function negar(motivo: string, _dialeto: DialetoDeHook): string {
  // Mesmo formato nos dois dialetos: o Codex exige motivo não vazio no `deny`.
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: motivo,
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
