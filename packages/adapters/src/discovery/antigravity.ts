import { type Ctx, isObj, setDefaults, str } from './util.js';

/**
 * Nome de exibição que o `agy` grava em `settings.json` → id aceito por
 * `--model` (lista de `agy models`, 1.2.6): "Gemini 3.1 Pro (Low)" →
 * "gemini-3.1-pro-low". Só normaliza o padrão Gemini, que é regular; os demais
 * ("Claude Sonnet 4.6 (Thinking)" → "claude-sonnet-4-6") não seguem regra, e
 * ficam com o nome de exibição em vez de um id inventado.
 */
export function modeloDoAgy(exibicao: string): string {
  const m = /^Gemini\s+([\d.]+)\s+(Pro|Flash(?:\s+Lite)?)\s*\((High|Medium|Low)\)$/i.exec(exibicao.trim());
  if (!m) return exibicao;
  const familia = m[2]!.toLowerCase().replace(/\s+/g, '-');
  return `gemini-${m[1]}-${familia}-${m[3]!.toLowerCase()}`;
}

export function discoverAntigravity(ctx: Ctx): void {
  const dir = ctx.p('.gemini');

  // O `agy` (Antigravity CLI, 1.2.6) grava a config dele em
  // `.gemini/antigravity-cli/settings.json` (caminho embutido no binário; o
  // `settings.json` da raiz é herança do Gemini CLI e o agy não o lê). Lá
  // ficam o modelo (pelo nome de exibição) e `permissions.allow`.
  const cli = ctx.json(`${dir}/antigravity-cli/settings.json`, 'settings');
  if (cli) {
    const model = str(cli.model);
    if (model) setDefaults(ctx, { model: modeloDoAgy(model) });
    const allow = isObj(cli.permissions) && Array.isArray(cli.permissions.allow) ? cli.permissions.allow : [];
    if (allow.length > 0) {
      ctx.warn(
        `Antigravity: ${allow.length} regra(s) em permissions.allow de antigravity-cli/settings.json valem também nas sessões do Hub`,
      );
    }
    if (cli.allowNonWorkspaceAccess === true) {
      ctx.warn('Antigravity: allowNonWorkspaceAccess=true — o agy pode ler/escrever fora do worktree da sessão');
    }
  }
  // Ganchos do agy (mesmo diretório): só registramos a existência.
  ctx.read(`${dir}/antigravity-cli/hooks.json`, 'settings');

  // Herança do Gemini CLI: ainda lida como fallback de modelo e MCP.
  const settings = ctx.json(`${dir}/settings.json`, 'settings');
  ctx.json(`${dir}/config/config.json`, 'settings');
  // MCP do agy: `.gemini/config/mcp_config.json` (também embutido no binário).
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
  // O agy guarda o token no cofre do sistema (keyring), não em arquivo: não
  // achar arquivo de credencial NÃO prova que está deslogado.
  ctx.authCanBeAbsent = false;
  ctx.instruction(`${dir}/GEMINI.md`);
}
