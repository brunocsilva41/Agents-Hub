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

  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
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
