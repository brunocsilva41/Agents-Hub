import { z } from 'zod';
import { HubError } from '@agents-hub/core';

/**
 * As variáveis `AGENTS_HUB_*` que o Hub lê, num lugar só.
 *
 * Antes disto, cada entrypoint (`daemon/src/main.ts`, `cli/src/main.ts`,
 * `mcp/src/main.ts`, `cli/src/daemon-control.ts`) lia `process.env` cru, cada
 * um com sua própria conversão — ou sem nenhuma. `AGENTS_HUB_PORT=abc` virava
 * `NaN`, e `server.listen(NaN, host)` escuta numa porta aleatória do SO em vez
 * de falhar: o daemon subia, só que na porta errada, sem aviso nenhum. Validar
 * tudo de uma vez, aqui, faz o erro aparecer no lugar em que foi cometido — a
 * variável de ambiente — em vez de num sintoma três camadas depois.
 *
 * `AGENTS_HUB_AGENT_ID` e `AGENTS_HUB_TASK_ID` ficam de fora de propósito:
 * são internas, injetadas pelo Hub no processo do agente (ver
 * `packages/adapters/src/process-adapter.ts`), não algo que o usuário configura.
 */
const HubEnvSchema = z.object({
  /** Raiz do estado global do Hub. Ver `defaultHome()`. */
  AGENTS_HUB_HOME: z.string().min(1).optional(),
  /** Porta do daemon. `undefined` = usa o padrão (4747) ou o que `config.json` disser. */
  AGENTS_HUB_PORT: z.coerce
    .number({ invalid_type_error: 'precisa ser um número' })
    .int('precisa ser um inteiro')
    .min(1)
    .max(65535)
    .optional(),
  /** `'1'` impede a CLI de subir o daemon sozinha quando ele não responde. */
  AGENTS_HUB_NO_AUTOSTART: z.enum(['0', '1']).optional(),
  /** Base URL do daemon para quem fala com ele de fora (MCP server, Web UI em dev). */
  AGENTS_HUB_URL: z.string().url('precisa ser uma URL válida').optional(),
  /** Identidade do agente principal quando o MCP server roda fora do Hub. */
  AGENTS_HUB_MCP_AGENT: z.string().min(1).optional(),
  /** Carência (ms) antes do MCP server sair, depois do stdin fechar. */
  AGENTS_HUB_MCP_GRACE_MS: z.coerce
    .number({ invalid_type_error: 'precisa ser um número' })
    .int('precisa ser um inteiro')
    .min(0)
    .optional(),
});

export type HubEnv = z.infer<typeof HubEnvSchema>;

/**
 * Lê e valida as variáveis `AGENTS_HUB_*` de `process.env` (ou de um objeto
 * passado explicitamente, para teste). Falha alto com `HubError` — não devolve
 * `NaN`/`undefined` silenciosamente para quem chamou adivinhar depois.
 */
export function readHubEnv(env: NodeJS.ProcessEnv = process.env): HubEnv {
  const raw = {
    AGENTS_HUB_HOME: env['AGENTS_HUB_HOME'],
    AGENTS_HUB_PORT: env['AGENTS_HUB_PORT'],
    AGENTS_HUB_NO_AUTOSTART: env['AGENTS_HUB_NO_AUTOSTART'],
    AGENTS_HUB_URL: env['AGENTS_HUB_URL'],
    AGENTS_HUB_MCP_AGENT: env['AGENTS_HUB_MCP_AGENT'],
    AGENTS_HUB_MCP_GRACE_MS: env['AGENTS_HUB_MCP_GRACE_MS'],
  };

  const parsed = HubEnvSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`);
    throw new HubError('HUB_CONFIG_INVALID', `variável de ambiente inválida — ${issues.join('; ')}`, {
      issues,
    });
  }
  return parsed.data;
}
