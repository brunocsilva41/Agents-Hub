import { textoDe } from '@agents-hub/core';
import type { MappedEvent } from '../types.js';
import { firstString, numberOf } from './generic.js';

/**
 * Mapper do Kimi Code CLI — `kimi -p "<texto>" --output-format stream-json`.
 *
 * Formato da 2.0.0 (reescrita Bun/TS), conferido no bundle do `kimi.exe`
 * (`PromptJsonWriter`, `writeExperimentalVersion`, `writeResumeHint`) e em
 * execução real contra um provedor morto (sem custo): um JSON por linha,
 * orientado a `role`.
 *
 *   {"role":"meta","type":"system.version","version":"2.0.0"}
 *   {"role":"assistant","content":"texto","tool_calls":[{"type":"function","id":"t1",
 *      "function":{"name":"Bash","arguments":"{\"command\":\"ls\"}"}}]}
 *   {"role":"tool","tool_call_id":"t1","content":"saída"}
 *   {"role":"meta","type":"turn.step.retrying","failed_attempt":1,"next_attempt":2,
 *      "max_attempts":10,"delay_ms":606,"error_name":"APIConnectionError","error_message":"Connection error."}
 *   {"role":"meta","type":"session.resume_hint","session_id":"...","command":"kimi -r ...","content":"..."}
 *   {"type":"goal.summary", ...}                      (só em `/goal`)
 *
 * O `session.resume_hint` é a única fonte do id nativo, e vem no fim — é ele
 * que autoriza `session.strategy: native` no manifesto. Uso de tokens não
 * existe no stream da 2.0.0.
 *
 * O formato antigo (Python: `role:"tool"` com `name`/`input`) continua aceito.
 */
export function kimiMapper(line: unknown): MappedEvent[] {
  if (line === null || typeof line !== 'object') return [];
  const obj = line as Record<string, unknown>;

  const role = firstString(obj['role']);
  const content = firstString(obj['content']);

  switch (role) {
    case 'assistant': {
      const out: MappedEvent[] = [];
      if (content) out.push({ type: 'message', payload: { text: content }, raw: line });
      for (const call of listaDe(obj['tool_calls'])) out.push(chamadaDeFerramenta(call, line));
      return out;
    }

    case 'user':
      // É o nosso próprio prompt ecoado de volta.
      return [];

    case 'thinking':
    case 'reasoning':
      return content ? [{ type: 'reasoning', payload: { text: content }, raw: line }] : [];

    case 'tool': {
      // 2.0.0: `tool` é o RESULTADO de uma chamada anunciada antes pelo assistant.
      const callId = firstString(obj['tool_call_id']);
      const nomeAntigo = firstString(obj['name']) ?? firstString(obj['tool']);
      if (callId !== undefined || nomeAntigo === undefined) {
        return [
          {
            type: 'tool.result',
            payload: { callId, ok: true, content: truncar(content) },
            raw: line,
          },
        ];
      }

      // Formato antigo: a linha `tool` era a própria chamada.
      const entrada = obj['input'] ?? obj['arguments'];
      return [
        {
          type: classificarFerramenta(nomeAntigo),
          payload: {
            tool: nomeAntigo,
            input: entrada,
            ...descrever(entrada),
            ...(content ? { output: content } : {}),
          },
          raw: line,
        },
      ];
    }

    case 'meta':
      return [meta(obj, content, line)];

    case 'error':
      return [{ type: 'error', payload: { message: content ?? 'erro do Kimi' }, raw: line }];

    default: {
      if (firstString(obj['type']) === 'goal.summary') {
        return [
          {
            type: 'log',
            payload: {
              kimiType: 'goal.summary',
              status: obj['status'] ?? null,
              text: `Kimi: objetivo ${textoDe(obj['status'], 'sem status')} (${textoDe(obj['turnsUsed'], '?')} turnos)`,
            },
            raw: line,
          },
        ];
      }
      // Sem `role` conhecido: preservamos como log em vez de descartar — o
      // formato já mudou uma vez (Python → Bun/TS) e pode mudar de novo.
      return [{ type: 'log', payload: { data: obj }, raw: line }];
    }
  }
}

function meta(obj: Record<string, unknown>, content: string | undefined, line: unknown): MappedEvent {
  const tipo = firstString(obj['type']);
  const sessionId = firstString(obj['session_id']);

  let event: MappedEvent;
  if (tipo === 'turn.step.retrying') {
    event = retentativa(obj, line);
  } else if (tipo === 'system.version') {
    const versao = firstString(obj['version']);
    event = {
      type: 'log',
      payload: {
        kimiType: tipo,
        version: versao ?? null,
        text: `Kimi ${versao ?? '(versão desconhecida)'}`,
      },
      raw: line,
    };
  } else {
    event = { type: 'log', payload: { kimiType: tipo, text: content }, raw: line };
  }
  if (sessionId) event.nativeSessionId = sessionId;

  const uso = obj['usage'];
  if (uso && typeof uso === 'object') {
    const u = uso as Record<string, unknown>;
    event.cost = {
      inputTokens: numberOf(u['input_tokens'] ?? u['prompt_tokens']),
      outputTokens: numberOf(u['output_tokens'] ?? u['completion_tokens']),
    };
  }
  return event;
}

/**
 * Falha de rede/provedor: o Kimi retenta sozinho até `max_attempts` com
 * backoff, e antes cada tentativa virava um `log` com `text: undefined` — o
 * motivo só existia no `raw`, e a timeline ficava minutos muda (vistoria 10).
 */
function retentativa(obj: Record<string, unknown>, line: unknown): MappedEvent {
  const falhou = numberOf(obj['failed_attempt']);
  const proxima = numberOf(obj['next_attempt']);
  const maximo = numberOf(obj['max_attempts']);
  const espera = numberOf(obj['delay_ms']);
  const erro = [firstString(obj['error_name']), firstString(obj['error_message'])]
    .filter((s): s is string => s !== undefined)
    .join(': ');
  const ultima = proxima !== undefined && maximo !== undefined && proxima >= maximo;

  return {
    type: 'log',
    payload: {
      kimiType: 'turn.step.retrying',
      level: 'warn',
      failedAttempt: falhou ?? null,
      maxAttempts: maximo ?? null,
      error: erro || null,
      text:
        `Kimi: tentativa ${falhou ?? '?'}/${maximo ?? '?'} falhou${erro ? ` (${erro})` : ''}` +
        (espera !== undefined ? `; nova tentativa em ${Math.max(1, Math.round(espera / 1000))}s` : '') +
        (ultima ? ' — é a última' : ''),
    },
    raw: line,
  };
}

function chamadaDeFerramenta(call: unknown, line: unknown): MappedEvent {
  const c = (call && typeof call === 'object' ? call : {}) as Record<string, unknown>;
  const fn = (c['function'] && typeof c['function'] === 'object' ? c['function'] : {}) as Record<
    string,
    unknown
  >;
  const nome = firstString(fn['name']);
  const brutos = fn['arguments'];
  let entrada: unknown = brutos;
  if (typeof brutos === 'string') {
    try {
      entrada = JSON.parse(brutos) as unknown;
    } catch {
      entrada = brutos;
    }
  }
  return {
    type: classificarFerramenta(nome),
    payload: { tool: nome, callId: firstString(c['id']), input: entrada, ...descrever(entrada) },
    raw: line,
  };
}

function classificarFerramenta(nome: string | undefined): MappedEvent['type'] {
  const n = (nome ?? '').toLowerCase();
  if (n.includes('bash') || n.includes('shell') || n.includes('exec')) return 'command.executed';
  if (n.includes('write') || n.includes('edit')) return 'file.changed';
  return 'tool.call';
}

function descrever(entrada: unknown): Record<string, unknown> {
  if (entrada === null || typeof entrada !== 'object') return {};
  const e = entrada as Record<string, unknown>;
  const command = firstString(e['command']);
  const path = firstString(e['path']) ?? firstString(e['file_path']);
  return { ...(command ? { command } : {}), ...(path ? { path } : {}) };
}

function listaDe(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Saída de ferramenta pode ser um arquivo inteiro; a timeline não precisa dele todo. */
function truncar(s: string | undefined): string | undefined {
  if (s === undefined || s.length <= 4000) return s;
  return `${s.slice(0, 4000)}… [${s.length - 4000} caracteres omitidos]`;
}
