import { type Ctx, setDefaults, str } from './util.js';

export function discoverCopilot(ctx: Ctx): void {
  const dir = ctx.p('.copilot');
  // config.json é JSONC ("// ... managed automatically"); settings.json é do usuário.
  const config = ctx.json(`${dir}/config.json`, 'settings');
  const settings = ctx.json(`${dir}/settings.json`, 'settings');
  setDefaults(ctx, { model: settings?.model ?? config?.model, provider: 'github' });

  const mcp = ctx.json(`${dir}/mcp-config.json`, 'mcp');
  if (mcp) ctx.addMcpMap(mcp.mcpServers, `${dir}/mcp-config.json`);

  for (const k of ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) ctx.envVar(k);
  if (config) {
    const users = config.loggedInUsers;
    if ((Array.isArray(users) && users.length > 0) || config.lastLoggedInUser) {
      ctx.evidence.push('usuário GitHub logado registrado em .copilot/config.json');
    }
  }
  // O token pode estar no chaveiro do SO, que não inspecionamos.
  ctx.authCanBeAbsent = false;
  if (!str(settings?.model) && !str(config?.model)) {
    ctx.warn('Copilot: nenhum modelo padrão em settings.json/config.json');
  }
  ctx.instruction(`${dir}/copilot-instructions.md`);
}
