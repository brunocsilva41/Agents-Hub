import { type Ctx, isObj, setDefaults, str } from './util.js';

export function discoverCodex(ctx: Ctx): void {
  const cfg = ctx.toml(ctx.p('.codex', 'config.toml'), 'settings');
  ctx.credFile(ctx.p('.codex', 'auth.json'), '.codex/auth.json');
  ctx.envVar('OPENAI_API_KEY');

  if (cfg) {
    const providerId = str(cfg.model_provider);
    let baseUrl: unknown;
    if (providerId && isObj(cfg.model_providers) && isObj(cfg.model_providers[providerId])) {
      baseUrl = (cfg.model_providers[providerId] as Record<string, unknown>).base_url;
    }
    setDefaults(ctx, { model: cfg.model, provider: providerId ?? 'openai', baseUrl });
    if (isObj(cfg.mcp_servers)) {
      for (const [name, spec] of Object.entries(cfg.mcp_servers)) {
        if (isObj(spec)) ctx.addMcp(name, spec, ctx.p('.codex', 'config.toml'));
        else ctx.warn(`.codex/config.toml: servidor MCP '${name}' com formato inesperado — ignorado`);
      }
    } else if (cfg.mcp_servers !== undefined) {
      ctx.warn('.codex/config.toml: [mcp_servers] com formato inesperado — ignorado');
    }
  }

  ctx.instruction(ctx.p('.codex', 'AGENTS.md'));
  ctx.instruction(ctx.p('.codex', 'AGENTS.override.md'));
}
