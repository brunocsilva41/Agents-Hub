import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Serve a Web UI compilada a partir do próprio daemon (ADR 05.3).
 *
 * Um processo só para subir: você roda `hub daemon` e a UI está no ar. Sem
 * isto, ver o grafo ao vivo exigiria um segundo servidor rodando em paralelo,
 * que é exatamente o tipo de cerimônia que faz ninguém abrir o painel.
 */
export function serveStatic(webRoot: string, urlPath: string, res: ServerResponse): boolean {
  if (!existsSync(webRoot)) return false;

  // `urlPath` chega ainda percent-encoded (é `URL.pathname`). Decodifica UMA
  // vez e valida o resultado: `%2e%2e` e `%5c` viram `..` e `\` e são
  // barrados abaixo como os literais.
  let decodificado: string;
  try {
    decodificado = decodeURIComponent(urlPath);
  } catch {
    res.writeHead(400).end('bad request');
    return true;
  }
  const motivo = motivoCaminhoEstaticoInvalido(decodificado);
  if (motivo !== null) {
    res.writeHead(400).end('bad request');
    return true;
  }

  const relative = decodificado === '/' ? 'index.html' : decodificado.replace(/^\/+/, '');
  const candidate = path.resolve(webRoot, relative);

  // Path traversal: `GET /../../.ssh/id_rsa` não pode escapar da pasta da UI.
  // Comparação por caminho relativo, não por prefixo de string: `startsWith`
  // deixaria passar um diretório IRMÃO cujo nome começa igual (`dist-secreto`
  // passa no prefixo de `dist`).
  if (!dentroDe(webRoot, candidate)) {
    res.writeHead(403).end('forbidden');
    return true;
  }

  const file = resolveFile(candidate, webRoot);
  if (!file) return false;

  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    // O index precisa ser sempre revalidado, senão um deploy novo da UI fica
    // invisível atrás do cache do navegador; os assets têm hash no nome.
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  createReadStream(file).pipe(res);
  return true;
}

/** Nomes de dispositivo do Windows: `CON`, `nul.txt`, `COM1.js`... abrem o dispositivo. */
const RESERVADO_WINDOWS = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * Por que um caminho estático (já decodificado) não pode ser servido, ou
 * `null` se ele é inocente.
 *
 * O NTFS aceita sintaxes que `path.resolve` não enxerga: `index.html::$DATA`
 * (stream alternativo) abria o próprio arquivo por outro nome, `a.html.` e
 * `a.html ` são o mesmo arquivo sem o ponto/espaço final, e nomes de
 * dispositivo (`CON`, `NUL`) abrem o dispositivo em qualquer pasta. A UI
 * compilada não tem nenhum desses nomes, então recusar tudo é seguro.
 */
export function motivoCaminhoEstaticoInvalido(caminho: string): string | null {
  if (caminho.includes('\u0000')) return 'caractere nulo';
  if (caminho.includes('\\')) return 'barra invertida';
  if (caminho.includes(':')) return 'dois-pontos (stream alternativo/unidade)';
  for (const segmento of caminho.split('/')) {
    if (segmento === '') continue;
    if (segmento === '.' || segmento === '..') return 'segmento relativo';
    if (/[. ]$/.test(segmento)) return 'nome terminado em ponto ou espaço';
    if (/[<>"|?*\u0000-\u001f]/.test(segmento)) return 'caractere proibido em nome de arquivo';
    if (RESERVADO_WINDOWS.test(segmento)) return 'nome reservado do Windows';
  }
  return null;
}

function dentroDe(raiz: string, alvo: string): boolean {
  const rel = path.relative(path.resolve(raiz), alvo);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveFile(candidate: string, webRoot: string): string | null {
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;

  // Rota da SPA (ex.: /session/ses_123): devolve o index e deixa o roteamento
  // acontecer no cliente.
  const index = path.join(webRoot, 'index.html');
  if (!candidate.includes('.') && existsSync(index)) return index;

  return null;
}
