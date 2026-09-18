#!/usr/bin/env node
import { baseUrl } from './config.js';
import { createHub } from './hub.js';
import { instalarRedeDeSeguranca } from './safety-net.js';

const port = process.env['AGENTS_HUB_PORT'];
const hub = createHub(port ? { port: Number(port) } : {});

// `start()` e não `server.listen()`: a porta precisa estar ligada ANTES de a
// reconciliação tocar no banco. Ver o comentário em `hub.ts`.
const { host, port: listening } = await hub.start();

console.log(`Agents-Hub daemon no ar`);
console.log(`  painel:    ${baseUrl({ host, port: listening })}`);
console.log(`  home:      ${hub.config.home}`);
console.log(`  banco:     ${hub.config.dbFile}`);
console.log(`  manifests: ${hub.config.manifestsDir}`);
console.log(`  agentes:   ${hub.registry.ids().join(', ') || '(nenhum manifesto encontrado)'}`);

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} recebido — encerrando sessões vivas…`);
  await hub.shutdown();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

instalarRedeDeSeguranca(() => shutdown('exceção não tratada'));
