import { type Ctx, hasSecretKey, isObj, setDefaults, str } from './util.js';

/** Config do OpenCode e forks (MiMo Code): mesma forma, diretório diferente. */
export function readOpenCodeStyle(ctx: Ctx, dir: string, baseName: string): void {
  for (const ext of ['json', 'jsonc']) {
    const file = `${dir}/${baseName}.${ext}`;
    const cfg = ctx.json(file, 'settings');
    if (!cfg) continue;
    const modelRef = str(cfg.model);
    let provider: string | undefined;
    let model = modelRef;
    let baseUrl: unknown;
    if (modelRef?.includes('/')) {
      provider = modelRef.slice(0, modelRef.indexOf('/'));
      model = modelRef;
    }
    if (isObj(cfg.provider)) {
      for (const [id, p] of Object.entries(cfg.provider)) {
        if (!isObj(p)) continue;
        const opts = isObj(p.options) ? p.options : {};
        if (id === provider) baseUrl = opts.baseURL ?? opts.baseUrl;
        if (hasSecretKey(opts)) ctx.configCred(`${baseName}.${ext} provider.${id}.options`, true);
      }
    }
    setDefaults(ctx, { model, provider, baseUrl });
    ctx.addMcpMap(cfg.mcp, file);
  }
}

export function discoverOpenCode(ctx: Ctx): void {
  const dir = ctx.p('.config', 'opencode');
  readOpenCodeStyle(ctx, dir, 'opencode');
  ctx.credFile(ctx.p('.local', 'share', 'opencode', 'auth.json'), '.local/share/opencode/auth.json');
  for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY']) {
    ctx.envVar(k);
  }
  ctx.instruction(`${dir}/AGENTS.md`);
}
