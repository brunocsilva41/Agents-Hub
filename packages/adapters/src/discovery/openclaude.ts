import path from 'node:path';
import { readClaudeFamily } from './claude.js';
import { type Ctx, hasSecretKey, isObj, setDefaults, str } from './util.js';

export function discoverOpenClaude(ctx: Ctx): void {
  const dir = ctx.p('.openclaude');
  const globalJson = ctx.p('.openclaude.json');
  // O perfil de provedor tem precedência sobre o padrão herdado do Claude Code.
  const profile = ctx.json(path.join(dir, '.openclaude-profile.json'), 'settings');
  if (profile) {
    const env = isObj(profile.env) ? profile.env : {};
    setDefaults(ctx, {
      model: env.OPENAI_MODEL,
      baseUrl: env.OPENAI_BASE_URL,
      provider: profile.profile,
    });
    if (hasSecretKey(env)) ctx.configCred('.openclaude/.openclaude-profile.json env', true);
  }

  // Perfis de provedor guardados no estado global; o ativo define o padrão.
  const g = ctx.json(globalJson, 'settings');
  if (g && Array.isArray(g.providerProfiles)) {
    const active = str(g.activeProviderProfileId);
    const prof = g.providerProfiles.find((p) => isObj(p) && p.id === active);
    if (isObj(prof)) {
      setDefaults(ctx, { model: prof.model, baseUrl: prof.baseUrl, provider: prof.provider });
      if (hasSecretKey(prof)) ctx.configCred('.openclaude.json providerProfiles (perfil ativo)', true);
    } else if (active) {
      ctx.warn('.openclaude.json: perfil de provedor ativo não encontrado em providerProfiles');
    }
  }

  readClaudeFamily(ctx, dir, globalJson, [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENROUTER_API_KEY',
  ]);
}
