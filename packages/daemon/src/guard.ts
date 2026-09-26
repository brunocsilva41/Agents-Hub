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
 * Checagens, cada uma fechando um caminho diferente:
 *
 * 1. `Host` precisa ser loopback — fecha DNS rebinding, onde um domínio
 *    controlado pelo atacante resolve para 127.0.0.1.
 * 2. `Origin`, quando presente, precisa ser a nossa (host loopback E a nossa
 *    porta, explícita ou implícita) — navegador não deixa página forjar esse
 *    cabeçalho, e a Web UI é servida por este mesmo daemon, então ela sempre
 *    passa. `Origin: null` é RECUSADO: é o que sai de iframe `sandbox`,
 *    `data:` e `file:`, justamente de onde um atacante dispara `fetch`.
 * 3. Sem `Origin`, `Sec-Fetch-Site` de outro site barra método que muda
 *    estado — independente de haver corpo.
 * 4. Corpo só é aceito como `application/json` — formulário HTML não consegue
 *    mandar esse content-type sem preflight, o que sozinho já mata o CSRF por
 *    formulário.
 *
 * Cliente fora do navegador (CLI, MCP server, curl) não manda `Origin` nem
 * `Sec-Fetch-Site` e passa. Isso é proposital: um processo local já roda como
 * você e não ganharia nada atacando o Hub — quem precisa ser barrado é a página
 * remota.
 */

export interface GuardVerdict {
  ok: boolean;
  status?: number;
  reason?: string;
}

const METODOS_COM_CORPO = new Set(['POST', 'PUT', 'PATCH']);
const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Tudo que não é leitura muda estado — inclusive método desconhecido. */
function mudaEstado(method: string | undefined): boolean {
  return !METODOS_SEGUROS.has((method ?? '').toUpperCase());
}

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

  // `Origin: null` NÃO é "sem origem". Antes ele passava, e um POST com
  // `Content-Length: 0` (que também dispensava o content-type) derrubava o
  // daemon via `/shutdown` ou cancelava sessões a partir de qualquer página.
  const origin = primeiro(req.headers.origin);
  if (origin !== null && (origin === 'null' || !origemPermitida(origin, esperado.port))) {
    return {
      ok: false,
      status: 403,
      reason: `Origin "${origin}" não pertence a este daemon`,
    };
  }

  // Sem `Origin`, o navegador ainda denuncia a requisição entre sites pelo
  // `Sec-Fetch-Site` (cabeçalho proibido: página não consegue forjar). Vale
  // para todo método que muda estado, com ou sem corpo.
  if (mudaEstado(req.method)) {
    const site = primeiro(req.headers['sec-fetch-site']);
    if (site !== null && site !== 'same-origin' && site !== 'none') {
      return {
        ok: false,
        status: 403,
        reason: `requisição de outro site (Sec-Fetch-Site: ${site}) não pode mudar estado`,
      };
    }
  }

  if (METODOS_COM_CORPO.has(req.method ?? '')) {
    const tipo = primeiro(req.headers['content-type']);
    // HTTP/1.1: requisição sem Content-Length e sem Transfer-Encoding NÃO tem
    // corpo (o parser do Node lê zero bytes). Antes a ausência de
    // Content-Length contava como "tem corpo" e `curl -X POST .../shutdown`
    // levava 415 (R02-12). Sem risco de CSRF novo: navegador manda
    // Content-Length (ou chunked) sempre que há corpo, e Origin /
    // Sec-Fetch-Site acima continuam valendo para POST sem corpo. Sem
    // tamanho mas COM Content-Type declarado conta como corpo: quem declara
    // `text/plain`/formulário está dizendo o que manda, e isso segue 415.
    const tamanho = primeiro(req.headers['content-length']);
    const temCorpo =
      primeiro(req.headers['transfer-encoding']) !== null ||
      (tamanho !== null ? tamanho !== '0' : tipo !== null);

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
    // Porta implícita é a porta PADRÃO do esquema (80/443), não "qualquer
    // uma": `Origin: http://localhost` é outro servidor local na porta 80, e
    // tratá-lo como mesma origem entregava o Hub a um XSS nele.
    const efetiva = url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    if (efetiva !== port) return false;
    return (
      url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
    );
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
