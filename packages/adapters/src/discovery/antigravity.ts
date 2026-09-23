import { type Ctx, isObj, setDefaults, str } from './util.js';

export function discoverAntigravity(ctx: Ctx): void {
  const dir = ctx.p('.gemini');
  const settings = ctx.json(`${dir}/settings.json`, 'settings');
  ctx.json(`${dir}/config/config.json`, 'settings');
  const mcp = ctx.json(`${dir}/config/mcp_config.json`, 'mcp');

  if (settings) {
    const model = isObj(settings.model) ? settings.model.name : settings.model;
    setDefaults(ctx, { model });
    const auth = isObj(settings.security) && isObj(settings.security.auth) ? settings.security.auth : {};
    if (str(auth.selectedType)) ctx.evidence.push('método de login configurado em .gemini/settings.json');
    ctx.addMcpMap(settings.mcpServers, `${dir}/settings.json`);
  }
  if (mcp) ctx.addMcpMap(mcp.mcpServers, `${dir}/config/mcp_config.json`);

  setDefaults(ctx, { provider: 'google' });
  ctx.credFile(`${dir}/google_accounts.json`, '.gemini/google_accounts.json');
  ctx.credFile(`${dir}/oauth_creds.json`, '.gemini/oauth_creds.json');
  for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY']) ctx.envVar(k);
  ctx.instruction(`${dir}/GEMINI.md`);
}
