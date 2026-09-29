#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { HubClient } from '@agents-hub/client';
import { readHubEnv, type HubEnv } from '@agents-hub/core';
import { CallerIdentity } from './caller.js';
import { buildMcpServer } from './server.js';

/**
 * Entrada stdio do MCP server.
 *
 * REGRA DE OURO: nada pode ser escrito em stdout além do JSON-RPC. stdout é o
 * canal do protocolo — um `console.log` de diagnóstico aqui corrompe a sessão
 * MCP inteira e o agente hospedeiro desconecta sem explicar por quê.
 * Todo diagnóstico vai para stderr.
 */

// Validadas pelo mesmo esquema do daemon e da CLI. Antes eram lidas cruas:
// `AGENTS_HUB_MCP_GRACE_MS=abc` virava `NaN`, `grace > 0` dava falso e a
// carência sumia em silêncio. Valor inválido agora encerra com a mensagem —
// no stderr, que é onde o agente hospedeiro mostra o log do MCP server.
let hubEnv: HubEnv;
try {
  hubEnv = readHubEnv();
} catch (err) {
  process.stderr.write(`agents-hub mcp: ${(err as Error).message}\n`);
  process.exit(1);
}

const hubUrl = hubEnv.AGENTS_HUB_URL ?? 'http://127.0.0.1:4747';

// Injetado pelo adapter quando o agente roda DENTRO do Hub. Ausente quando o
// agente é o principal externo — nesse caso a identidade é adotada sob demanda.
const sessionId = process.env['AGENTS_HUB_SESSION_ID'];
const agentId = process.env['AGENTS_HUB_AGENT_ID'] ?? hubEnv.AGENTS_HUB_MCP_AGENT ?? 'externo';

const client = new HubClient(hubUrl);
const caller = new CallerIdentity(client, agentId, process.cwd(), sessionId);
const server = buildMcpServer(client, caller);

// Sinal de vida da raiz adotada (só faz algo depois de uma adoção). Sem ele,
// um hospedeiro que mata este processo sem fechar stdin deixava a raiz
// `running` para sempre no daemon.
// O intervalo vem validado por `readHubEnv`, como a carência: antes era
// `Number()` cru e `abc`/`0` voltavam ao padrão sem aviso.
const pararHeartbeat = caller.startHeartbeat(hubEnv.AGENTS_HUB_MCP_HEARTBEAT_MS ?? 30_000);

const transport = new StdioServerTransport();
await server.connect(transport);

process.stderr.write(
  `agents-hub mcp conectado — hub: ${hubUrl}, agente: ${agentId}, ` +
    `sessão: ${sessionId ?? '(adota ao primeiro uso)'}\n`,
);

/**
 * Carência antes de sair. Quando o hospedeiro fecha stdin, ainda pode haver
 * resposta calculada esperando para ser escrita em stdout — sair na hora a
 * descartaria, e o agente veria a tool falhar sem motivo aparente.
 *
 * Não esperamos a delegação em si: ela roda no daemon e sobrevive à nossa
 * saída, que é exatamente o ponto de a delegação ser assíncrona.
 */
const SHUTDOWN_GRACE_MS = hubEnv.AGENTS_HUB_MCP_GRACE_MS ?? 3000;

let closing = false;
const shutdown = async (grace: number): Promise<void> => {
  if (closing) return;
  closing = true;
  pararHeartbeat();
  if (grace > 0) await new Promise((resolve) => setTimeout(resolve, grace));
  await caller.release();
  await server.close().catch(() => {});
  process.exit(0);
};

// Sinal explícito: sai imediatamente, sem carência.
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

// stdin fechado é o fim de sessão normal do MCP — aqui vale a carência.
process.stdin.on('close', () => void shutdown(SHUTDOWN_GRACE_MS));
process.stdin.on('end', () => void shutdown(SHUTDOWN_GRACE_MS));
