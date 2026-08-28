import type { IncomingMessage } from 'node:http';

/**
 * Guarda de borda do daemon.
 *
 * O Hub roda agentes com TODO o privilégio do seu usuário. Um daemon HTTP em
 * localhost sem esta guarda é dirigível por qualquer página web que você
 * visitar: navegador não faz preflight de `<form enctype="text/plain">`, então
 * um site qualquer conseguiria iniciar sessões, aprovar aprovações pendentes e
 * derrubar o Hub. Foi exatamente o que um teste contra o daemon confirmou.
 *
 * Três checagens, cada uma fechando um caminho diferente:
 *
 * 1. `Host` precisa ser loopback — fecha DNS rebinding, onde um domínio
 *    controlado pelo atacante resolve para 127.0.0.1.
 * 2. `Origin`, quando presente, precisa ser a nossa — navegador não deixa
 *    página forjar esse cabeçalho, e a Web UI é servida por este mesmo daemon,
 *    então ela sempre passa.
 * 3. Corpo só é aceito como `application/json` — formulário HTML não consegue
 *    mandar esse content-type sem preflight, o que sozinho já mata o CSRF por
 *    formulário.
 *
 * Cliente fora do navegador (CLI, MCP server, curl) não manda `Origin` e passa.
 * Isso é proposital: um processo local já roda como você e não ganharia nada
 * atacando o Hub — quem precisa ser barrado é a página remota.
 */

export interface GuardVerdict {
  ok: boolean;
  status?: number;
  reason?: string;
}

const METODOS_COM_CORPO = new Set(['POST', 'PUT', 'PATCH']);

export function guardRequest(
  req: IncomingMessage,
  esperado: { host: string; port: number },
): GuardVerdict {
  const host = primeiro(req.headers.host);
  if (host !== null && !hostPermitido(host, esperado.port)) {
    return {
      ok: false,
      status: 403,
      reason: `Host "${host}" não é loopback — possível DNS rebinding`,
    };
  }

  const origin = primeiro(req.headers.origin);
  if (origin !== null && origin !== 'null' && !origemPermitida(origin, esperado.port)) {
    return {
      ok: false,
      status: 403,
      reason: `Origin "${origin}" não pertence a este daemon`,
    };
  }

  if (METODOS_COM_CORPO.has(req.method ?? '')) {
    const tipo = primeiro(req.headers['content-type']);
    const temCorpo =
      primeiro(req.headers['content-length']) !== '0' ||
      primeiro(req.headers['transfer-encoding']) !== null;

    if (temCorpo && !ehJson(tipo)) {
      return {
        ok: false,
        status: 415,
        reason: 'corpo precisa ser application/json',
      };
    }
  }

  return { ok: true };
}

/** `127.0.0.1`, `::1` e `localhost` — com ou sem a porta esperada. */
function hostPermitido(host: string, port: number): boolean {
  const semPorta = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const porta = /:(\d+)$/.exec(host)?.[1];

  if (porta !== undefined && Number(porta) !== port) return false;
  return semPorta === '127.0.0.1' || semPorta === 'localhost' || semPorta === '::1';
}

function origemPermitida(origin: string, port: number): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.port !== '' && Number(url.port) !== port) return false;
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  } catch {
    return false;
  }
}

function ehJson(contentType: string | null): boolean {
  if (contentType === null) return false;
  // `application/json; charset=utf-8` é válido; o que importa é o tipo base.
  return contentType.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

function primeiro(valor: string | string[] | undefined): string | null {
  if (valor === undefined) return null;
  return Array.isArray(valor) ? (valor[0] ?? null) : valor;
}
