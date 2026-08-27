#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { HubClient } from '@agents-hub/client';
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

const hubUrl = process.env['AGENTS_HUB_URL'] ?? 'http://127.0.0.1:4747';

// Injetado pelo adapter quando o agente roda DENTRO do Hub. Ausente quando o
// agente é o principal externo — nesse caso a identidade é adotada sob demanda.
const sessionId = process.env['AGENTS_HUB_SESSION_ID'];
const agentId = process.env['AGENTS_HUB_AGENT_ID'] ?? process.env['AGENTS_HUB_MCP_AGENT'] ?? 'externo';

const client = new HubClient(hubUrl);
const caller = new CallerIdentity(client, agentId, process.cwd(), sessionId);
const server = buildMcpServer(client, caller);

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
const SHUTDOWN_GRACE_MS = Number(process.env['AGENTS_HUB_MCP_GRACE_MS'] ?? 3000);

let closing = false;
const shutdown = async (grace: number): Promise<void> => {
  if (closing) return;
  closing = true;
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
