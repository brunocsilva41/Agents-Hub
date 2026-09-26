/**
 * Token de operador (item 1.6 do GOAL; achado ALTO da vistoria 05).
 *
 * Antes, `POST /approvals/:id` aceitava qualquer processo local — inclusive o
 * próprio agente gateado, que podia aprovar a ação que ele mesmo pediu com um
 * `curl`. O daemon agora gera um segredo aleatório em
 * `<AGENTS_HUB_HOME>/operator-token` e exige esse segredo nas rotas que mudam
 * política ou segurança. CLI lê o arquivo; a Web UI servida pelo daemon
 * recebe o token por cookie HttpOnly; o ambiente dos agentes NUNCA o recebe.
 *
 * Só constantes aqui (sem I/O): `core` também é importado pela Web UI.
 */

/** Nome do arquivo dentro do home do Hub. */
export const OPERATOR_TOKEN_FILE = 'operator-token';

/** Cookie HttpOnly que a Web UI recebe ao carregar `/`. */
export const OPERATOR_COOKIE = 'hub_operator';

/** Header alternativo ao `Authorization: Bearer`. */
export const OPERATOR_TOKEN_HEADER = 'x-hub-token';

/**
 * Quem está falando, declarado pelo cliente que JÁ provou ter o token (ex.: o
 * proxy de desenvolvimento do Vite diz `web`). Não autentica nada sozinho.
 */
export const OPERATOR_CLIENT_HEADER = 'x-hub-client';

/** Formato do token: 32 bytes aleatórios em hexadecimal. */
export const OPERATOR_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
