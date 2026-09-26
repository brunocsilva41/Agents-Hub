import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OPERATOR_TOKEN_FILE, OPERATOR_TOKEN_PATTERN } from '@agents-hub/core';

/**
 * Leitura do token de operador (item 1.6) — SÓ para Node (CLI, scripts).
 *
 * Subcaminho separado (`@agents-hub/client/operator-token`) porque a Web UI
 * empacota o cliente e não tem `node:fs`; no navegador o token chega por
 * cookie HttpOnly e o script da página nunca o vê.
 *
 * Não existe variável de ambiente para o token, de propósito: o daemon
 * repassa o próprio ambiente aos agentes, e um token em env acabaria no
 * processo do agente que ele existe para barrar.
 */
export function operatorTokenFile(home?: string): string {
  const raiz = home ?? process.env['AGENTS_HUB_HOME'] ?? path.join(os.homedir(), '.agents-hub');
  return path.join(raiz, OPERATOR_TOKEN_FILE);
}

/** O token, ou `null` se o daemon ainda não o criou (ou o arquivo é ilegível). */
export function readOperatorToken(home?: string): string | null {
  try {
    const t = readFileSync(operatorTokenFile(home), 'utf8').trim();
    return OPERATOR_TOKEN_PATTERN.test(t) ? t : null;
  } catch {
    return null;
  }
}
