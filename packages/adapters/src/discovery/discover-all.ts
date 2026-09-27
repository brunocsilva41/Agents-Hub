/**
 * Resumo rápido (sem segredos) da descoberta contra o HOME real:
 *   node packages/adapters/dist/discovery/discover-all.js [projectDir]
 */
import { DISCOVERABLE_AGENTS, discoverAgent } from './index.js';

const projectDir = process.argv[2] ?? process.cwd();
for (const id of DISCOVERABLE_AGENTS) {
  const d = await discoverAgent(id, { installed: null, projectDir });
  const present = d.files.filter((f) => f.exists).length;
  console.log(`\n== ${id}`);
  console.log(
    `  auth: ${d.auth.state}${d.auth.evidence.length ? ` (${d.auth.evidence.join('; ')})` : ''}`,
  );
  console.log(`  defaults: ${JSON.stringify(d.defaults)}`);
  console.log(`  arquivos: ${present}/${d.files.length} existem`);
  console.log(
    `  instruções: ${d.instructionFiles.map((f) => `${f.path} (${f.bytes}B)`).join(', ') || '-'}`,
  );
  console.log(`  mcp (${d.mcpServers.length}):`);
  for (const s of d.mcpServers) {
    const target = s.url ?? [s.command, ...(s.args ?? []).slice(0, 2)].join(' ');
    const env = s.env ? ` env=[${Object.keys(s.env).join(',')}]` : '';
    console.log(`    - ${s.name} [${s.transport}]${s.isHub ? ' HUB' : ''} ${target}${env}`);
  }
  for (const w of d.warnings) console.log(`  ! ${w}`);
}
