import { type Ctx, setDefaults } from './util.js';

export function discoverCursor(ctx: Ctx): void {
  const dir = ctx.p('.cursor');
  const mcp = ctx.json(`${dir}/mcp.json`, 'mcp');
  if (mcp) ctx.addMcpMap(mcp.mcpServers, `${dir}/mcp.json`);
  const cli = ctx.json(`${dir}/cli-config.json`, 'settings');
  if (cli) setDefaults(ctx, { model: typeof cli.model === 'object' && cli.model ? (cli.model as Record<string, unknown>).modelId : cli.model });
  ctx.envVar('CURSOR_API_KEY');
  // O login do Cursor vive no armazenamento do app, que não inspecionamos.
  ctx.authCanBeAbsent = false;
  ctx.warn('Cursor: login e regras globais ficam no armazenamento do app, não em arquivos legíveis; auth só via CURSOR_API_KEY');
}
