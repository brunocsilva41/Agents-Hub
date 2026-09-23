import { existsSync, readdirSync } from 'node:fs';
import { type Ctx, hasSecretKey, isObj, setDefaults, str } from './util.js';

export function discoverKimi(ctx: Ctx): void {
  const dir = ctx.p('.kimi-code');
  const cfg = ctx.toml(`${dir}/config.toml`, 'settings');
  if (cfg) {
    const dm = str(cfg.default_model);
    const models = isObj(cfg.models) ? cfg.models : {};
    const providers = isObj(cfg.providers) ? cfg.providers : {};
    const m = dm && isObj(models[dm]) ? (models[dm] as Record<string, unknown>) : undefined;
    const pid = str(m?.provider);
    const p = pid && isObj(providers[pid]) ? (providers[pid] as Record<string, unknown>) : undefined;
    setDefaults(ctx, { model: m?.model ?? dm, provider: pid, baseUrl: p?.base_url });
    if (dm && !m) ctx.warn(`Kimi: default_model '${dm}' não tem seção [models."${dm}"]`);
    for (const [id, prov] of Object.entries(providers)) {
      if (hasSecretKey(prov)) ctx.configCred(`.kimi-code/config.toml providers.${id}`, true);
    }
  }

  // Credenciais (OAuth do Kimi) ficam num diretório; só a existência importa.
  const credDir = `${dir}/credentials`;
  if (existsSync(credDir)) {
    try {
      if (readdirSync(credDir).length > 0) ctx.credFile(credDir, '.kimi-code/credentials/');
    } catch (e) {
      ctx.warn(`Kimi: não foi possível listar credentials/: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const k of ['KIMI_API_KEY', 'MOONSHOT_API_KEY']) ctx.envVar(k);

  // MCP: esta versão do Kimi não tem mecanismo confirmado; lê mcp.json só se existir.
  const mcp = ctx.json(`${dir}/mcp.json`, 'mcp');
  if (mcp) ctx.addMcpMap(mcp.mcpServers, `${dir}/mcp.json`);
  else ctx.warn('Kimi: sem mecanismo de MCP confirmado nesta versão (nenhum mcp.json)');

  ctx.instruction(`${dir}/AGENTS.md`);
}
