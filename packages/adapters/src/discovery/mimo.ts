import { readOpenCodeStyle } from './opencode.js';
import type { Ctx } from './util.js';

export function discoverMimo(ctx: Ctx): void {
  const dir = ctx.p('.config', 'mimocode');
  readOpenCodeStyle(ctx, dir, 'mimocode');
  ctx.credFile(ctx.p('.local', 'share', 'mimocode', 'auth.json'), '.local/share/mimocode/auth.json');
  for (const k of ['MIMO_API_KEY', 'XIAOMI_MIMO_API_KEY']) ctx.envVar(k);
  ctx.instruction(`${dir}/AGENTS.md`);
  // Onde a credencial do MiMo mora não foi confirmado: ausência não prova nada.
  ctx.authCanBeAbsent = false;
  ctx.warn(
    'MiMo: local da credencial não confirmado (sem evidência = desconhecido, não ausente); ' +
      'o MiMo também importa MCP de configs de outros agentes, então só os declarados em mimocode.json/jsonc são listados',
  );
}
