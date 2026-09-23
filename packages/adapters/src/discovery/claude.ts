import path from 'node:path';
import { type Ctx, isObj, setDefaults } from './util.js';

function samePath(a: string, b: string): boolean {
  const n = (s: string) => path.resolve(s).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  return n(a) === n(b);
}

/**
 * Leitor compartilhado pela família Claude Code (claude e openclaude, que é um
 * fork com a mesma estrutura). `dir` é o diretório de config (~/.claude ou
 * ~/.openclaude) e `globalJson` o arquivo de estado (~/.claude.json etc.).
 */
export function readClaudeFamily(ctx: Ctx, dir: string, globalJson: string, envKeys: string[]): void {
  const local = ctx.json(path.join(dir, 'settings.local.json'), 'settings');
  const settings = ctx.json(path.join(dir, 'settings.json'), 'settings');

  for (const s of [local, settings]) {
    if (!s) continue;
    const env = isObj(s.env) ? s.env : {};
    setDefaults(ctx, {
      model: env.ANTHROPIC_MODEL ?? s.model,
      baseUrl: env.ANTHROPIC_BASE_URL,
    });
    for (const k of envKeys) {
      if (typeof env[k] === 'string' && (env[k] as string).length > 0) {
        ctx.configCred(`${path.basename(dir)}/settings.json env.${k}`, true);
      }
    }
  }

  ctx.credFile(path.join(dir, '.credentials.json'), path.join(path.basename(dir), '.credentials.json'));
  for (const k of envKeys) ctx.envVar(k);

  const g = ctx.json(globalJson, 'settings');
  if (g) {
    ctx.addMcpMap(g.mcpServers, `${globalJson} (usuário)`);
    if (ctx.projectDir && isObj(g.projects)) {
      for (const [proj, cfg] of Object.entries(g.projects)) {
        if (samePath(proj, ctx.projectDir) && isObj(cfg) && cfg.mcpServers !== undefined) {
          ctx.addMcpMap(cfg.mcpServers, `${globalJson} (local, ${proj})`);
        }
      }
    }
    if (isObj(g.oauthAccount) && Object.keys(g.oauthAccount).length > 0) {
      ctx.evidence.push(`sessão OAuth registrada em ${path.basename(globalJson)}`);
    }
  }

  if (ctx.projectDir) {
    const mcpJson = ctx.json(path.join(ctx.projectDir, '.mcp.json'), 'mcp');
    if (mcpJson) ctx.addMcpMap(mcpJson.mcpServers, path.join(ctx.projectDir, '.mcp.json'));
  } else {
    ctx.warn('projectDir não informado: MCP de escopo de projeto (.mcp.json) não foi lido');
  }

  ctx.instruction(path.join(dir, 'CLAUDE.md'));
}

export function discoverClaude(ctx: Ctx): void {
  readClaudeFamily(ctx, ctx.p('.claude'), ctx.p('.claude.json'), [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
  ]);
  setDefaults(ctx, { provider: 'anthropic' });
}
