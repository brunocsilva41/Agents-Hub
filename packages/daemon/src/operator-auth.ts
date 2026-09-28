import { execFileSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  OPERATOR_CLIENT_HEADER,
  OPERATOR_COOKIE,
  OPERATOR_TOKEN_FILE,
  OPERATOR_TOKEN_HEADER,
  OPERATOR_TOKEN_PATTERN,
} from '@agents-hub/core';

/**
 * Token de operador (item 1.6 do GOAL; achado ALTO da vistoria 05: "qualquer
 * processo local, inclusive o agente gateado, pode aprovar as próprias
 * aprovações").
 *
 * # O que isto protege, e o que não
 *
 * - Protege contra: o agente (ou um script qualquer) que chama a API do Hub
 *   por HTTP para aprovar a própria ação, afrouxar política, marcar projeto
 *   como confiável ou derrubar o daemon; página web que tente CSRF (o cookie é
 *   `SameSite=Strict` e a guarda de borda continua exigindo a `Origin`
 *   certa); outros usuários do sistema operacional (arquivo só do usuário).
 * - O token NUNCA entra no ambiente do agente: não é variável de ambiente do
 *   daemon, então o `...process.env` do spawn não o carrega (há teste).
 * - O arquivo é "segredo" para o gate (`sensitive-paths.ts`): agente com hook
 *   que tenta LER `operator-token` cai em aprovação/negação, não passa direto.
 * - NÃO protege contra um processo do MESMO usuário decidido a ler o arquivo
 *   por fora do gate (agente sem hook, `isolation: none` e sem vigilância).
 *   Sem sandbox de sistema, nada no espaço do usuário fecha isso — ver
 *   SECURITY.md.
 */

export interface OperatorIdentity {
  /** `cli:<usuário>` ou `web` — é o que vira `by`/`actor` na auditoria. */
  by: string;
  via: 'header' | 'cookie';
}

export interface OperatorTokenFile {
  token: string;
  path: string;
  /**
   * `true` se o arquivo ficou restrito ao usuário (0600 no POSIX; ACL sem
   * herança só com o usuário no Windows), `false` se a restrição falhou (o
   * token ainda funciona, mas herda as permissões da pasta — aviso no log).
   */
  restricted: boolean;
}

export function operatorTokenPath(home: string): string {
  return path.join(home, OPERATOR_TOKEN_FILE);
}

/**
 * Garante o token em `<home>/operator-token` e o devolve.
 *
 * Reaproveita o existente se estiver bem formado — trocar a cada subida
 * deixaria a aba do painel aberta sem poder aprovar depois de um autostart.
 * Para rotacionar: apague o arquivo e reinicie o daemon.
 *
 * Criação: arquivo temporário com modo 0600, ACL restrita (Windows), e só
 * então `rename` para o nome final — o token nunca existe em disco com a
 * permissão herdada da pasta.
 */
export function ensureOperatorToken(home: string): OperatorTokenFile {
  const file = operatorTokenPath(home);
  const existente = lerTokenValido(file);
  if (existente) {
    // POSIX: barato, reafirma a permissão a cada subida. No Windows a ACL já
    // foi aplicada na criação e não muda sozinha.
    const restricted = process.platform === 'win32' ? true : tentarChmod(file);
    return { token: existente, path: file, restricted };
  }

  const token = randomBytes(32).toString('hex');
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    writeFileSync(tmp, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const restricted = process.platform === 'win32' ? restringirAclWindows(tmp) : tentarChmod(tmp);
    renameSync(tmp, file);
    if (!restricted) {
      console.warn(
        `[operator-token] não consegui restringir a permissão de ${file} ao seu usuário; ` +
          'o token funciona, mas herda as permissões da pasta.',
      );
    }
    return { token, path: file, restricted };
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function lerTokenValido(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    const t = readFileSync(file, 'utf8').trim();
    return OPERATOR_TOKEN_PATTERN.test(t) ? t : null;
  } catch {
    return null;
  }
}

function tentarChmod(file: string): boolean {
  try {
    chmodSync(file, 0o600);
    return true;
  } catch {
    return false;
  }
}

/**
 * Windows: `chmod` não mexe em ACL. `icacls /inheritance:r` corta o que vinha
 * da pasta (Usuários, Administradores herdados do perfil) e `/grant:r` deixa
 * só o usuário atual com controle total.
 */
function restringirAclWindows(file: string): boolean {
  const usuario = os.userInfo().username;
  const dominio = process.env['USERDOMAIN'];
  const principal = dominio ? `${dominio}\\${usuario}` : usuario;
  try {
    execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${principal}:F`], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

function primeiro(v: string | string[] | undefined): string | null {
  if (v === undefined) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

/** Valor de um cookie pelo nome, sem dependência. */
function lerCookie(header: string | null, nome: string): string | null {
  if (!header) return null;
  for (const parte of header.split(';')) {
    const i = parte.indexOf('=');
    if (i === -1) continue;
    if (parte.slice(0, i).trim() === nome) return parte.slice(i + 1).trim();
  }
  return null;
}

function iguais(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Autentica a requisição contra o token. `null` = sem credencial válida.
 *
 * Ordem: `Authorization: Bearer`, `X-Hub-Token`, cookie. `by` sai da ORIGEM
 * autenticada — o corpo da requisição não participa.
 */
export function authenticateOperator(req: IncomingMessage, token: string): OperatorIdentity | null {
  const auth = primeiro(req.headers.authorization);
  const bearer = auth ? (/^Bearer\s+(\S+)\s*$/i.exec(auth)?.[1] ?? null) : null;
  const header = bearer ?? primeiro(req.headers[OPERATOR_TOKEN_HEADER]);
  if (header !== null) {
    if (!iguais(header.trim(), token)) return null;
    // `X-Hub-Client: web` só é aceito de quem JÁ provou ter o token (o proxy
    // do Vite em desenvolvimento). Qualquer outro valor é CLI.
    const cliente = primeiro(req.headers[OPERATOR_CLIENT_HEADER]);
    return { by: cliente === 'web' ? 'web' : `cli:${os.userInfo().username}`, via: 'header' };
  }
  const cookie = lerCookie(primeiro(req.headers.cookie), OPERATOR_COOKIE);
  if (cookie !== null && iguais(cookie, token)) return { by: 'web', via: 'cookie' };
  return null;
}

const identidades = new WeakMap<IncomingMessage, OperatorIdentity>();

/** Registra quem autenticou esta requisição (feito pelo despacho do servidor). */
export function markOperator(req: IncomingMessage, id: OperatorIdentity): void {
  identidades.set(req, id);
}

/** Quem autenticou esta requisição; `null` em rota que não exige token. */
export function operatorOf(req: IncomingMessage): OperatorIdentity | null {
  return identidades.get(req) ?? null;
}

/**
 * A Web UI servida pelo daemon ganha o cookie quando o NAVEGADOR carrega um
 * documento (`Sec-Fetch-Dest: document`, `Sec-Fetch-Mode: navigate`, vindo
 * de digitação/favorito ou da própria origem). Um `fetch()` ou `<img>` de
 * outra página não recebe; um `curl` sem esses cabeçalhos também não. Não é
 * fronteira contra processo local (que forja cabeçalho), é só para o cookie
 * não sair em toda resposta estática — a fronteira contra processo local é o
 * arquivo só do usuário, e o gate que trata o arquivo E a requisição HTTP ao
 * daemon (`alvoDoDaemon`) como segredo (R05-03).
 *
 * Bilhete de uso único (`hub open` → `/?ticket=`) no lugar destes cabeçalhos
 * foi avaliado e REJEITADO: tiraria o painel de quem digita o endereço, e não
 * fecharia nada — o processo que conseguiria o bilhete (rodando a CLI ou um
 * script fora do olhar do classificador) lê o próprio `operator-token` do
 * mesmo jeito. Ver SECURITY.md.
 */
export function shouldIssueOperatorCookie(req: IncomingMessage): boolean {
  if (req.method !== 'GET') return false;
  const dest = primeiro(req.headers['sec-fetch-dest']);
  const mode = primeiro(req.headers['sec-fetch-mode']);
  const site = primeiro(req.headers['sec-fetch-site']);
  return dest === 'document' && mode === 'navigate' && (site === 'none' || site === 'same-origin');
}

/**
 * `HttpOnly`: script da página (ou XSS nela) não lê. `SameSite=Strict`: o
 * navegador não o manda em requisição iniciada por outro site. Sem `Secure`
 * porque o daemon é HTTP em loopback. Sem `Max-Age`: morre com o navegador.
 */
export function operatorCookieHeader(token: string): string {
  return `${OPERATOR_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}
