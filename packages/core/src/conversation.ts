import { renderBriefAsPrompt, type Brief } from './brief.js';
import type { EventEnvelope } from './events.js';

/**
 * Reconstrução de contexto para agentes sem sessão nativa.
 *
 * Quando o agente não tem resume nativo — ou ainda não revelou o id da sessão,
 * o que acontece em TODO primeiro turno do Copilot e do Kimi — cada turno é um
 * processo novo, com contexto zerado. Mandar só a mensagem nova ali entrega ao
 * agente um "faça também X" sem ele saber qual era a tarefa, o que ele já
 * tentou, nem o que já deu errado.
 *
 * Este módulo transforma o histórico que o Hub já guarda numa continuação
 * legível. É a diferença entre uma conversa e uma sequência de comandos soltos.
 */

/** Eventos que contam a história; o resto é ruído de infraestrutura. */
const NARRATIVOS = new Set([
  'message',
  'command.executed',
  'file.changed',
  'error',
  'delegation.requested',
  'delegation.completed',
]);

export interface RebuildInput {
  brief: Brief;
  history: EventEnvelope[];
  message: string;
  /** Teto do trecho de histórico. O brief e a mensagem nova nunca são cortados. */
  maxHistoryChars?: number;
}

export function rebuildConversation(input: RebuildInput): string {
  const historico = condensarHistorico(input.history, input.maxHistoryChars ?? 6000);

  const partes = [renderBriefAsPrompt(input.brief)];

  if (historico.length > 0) {
    partes.push(
      [
        '## O que já aconteceu nesta sessão',
        '',
        'Você já trabalhou nesta tarefa antes. Este é o resumo do que fez:',
        '',
        ...historico,
      ].join('\n'),
    );
  }

  partes.push(
    ['## Nova mensagem', '', input.message].join('\n'),
  );

  return partes.join('\n\n');
}

/**
 * Condensa o histórico mantendo o FIM.
 *
 * O começo de uma sessão longa é exploração; o fim é onde o trabalho está e de
 * onde a continuação parte. Cortar pelo fim entregaria ao agente o contexto
 * menos útil.
 */
function condensarHistorico(eventos: EventEnvelope[], maxChars: number): string[] {
  const linhas: string[] = [];

  for (const evento of eventos) {
    if (!NARRATIVOS.has(evento.type)) continue;
    const linha = descrever(evento);
    if (linha) linhas.push(linha);
  }

  const recortadas: string[] = [];
  let total = 0;

  for (let i = linhas.length - 1; i >= 0; i -= 1) {
    const linha = linhas[i] as string;
    if (total + linha.length > maxChars) {
      recortadas.unshift(`- […] ${i + 1} passo(s) anteriores omitidos por tamanho`);
      break;
    }
    recortadas.unshift(linha);
    total += linha.length;
  }

  return recortadas;
}

function descrever(evento: EventEnvelope): string | null {
  const p = evento.payload;

  switch (evento.type) {
    case 'message': {
      const texto = comoTexto(p['text']);
      return texto ? `- você respondeu: ${truncar(texto, 500)}` : null;
    }

    case 'command.executed': {
      const comando = comoTexto(p['command']);
      if (!comando) return null;
      const codigo = p['exitCode'];
      const desfecho =
        typeof codigo === 'number' ? (codigo === 0 ? ' (ok)' : ` (falhou: ${codigo})`) : '';
      return `- você executou: \`${truncar(comando, 200)}\`${desfecho}`;
    }

    case 'file.changed': {
      const arquivos = listarArquivos(p);
      return arquivos.length > 0 ? `- você alterou: ${arquivos.join(', ')}` : null;
    }

    case 'error': {
      const mensagem = comoTexto(p['message'] ?? p['error'] ?? p['text']);
      return mensagem ? `- ERRO: ${truncar(mensagem, 300)}` : null;
    }

    case 'delegation.requested': {
      const alvo = comoTexto(p['targetAgent']);
      return alvo ? `- você delegou para ${alvo}: ${truncar(comoTexto(p['objective']) ?? '', 200)}` : null;
    }

    case 'delegation.completed': {
      const alvo = comoTexto(p['agentId']);
      return alvo ? `- a delegação para ${alvo} terminou como "${comoTexto(p['state']) ?? '?'}"` : null;
    }

    default:
      return null;
  }
}

function listarArquivos(payload: Record<string, unknown>): string[] {
  const arquivos = payload['files'];
  if (Array.isArray(arquivos)) {
    return arquivos
      .map((f) => comoTexto((f as Record<string, unknown>)?.['path']))
      .filter((p): p is string => p !== undefined)
      .slice(0, 10);
  }
  const unico = comoTexto(payload['path']);
  return unico ? [unico] : [];
}

function comoTexto(valor: unknown): string | undefined {
  return typeof valor === 'string' && valor.trim().length > 0 ? valor.trim() : undefined;
}

function truncar(texto: string, max: number): string {
  const limpo = texto.replace(/\s+/g, ' ');
  return limpo.length > max ? `${limpo.slice(0, max)}…` : limpo;
}
