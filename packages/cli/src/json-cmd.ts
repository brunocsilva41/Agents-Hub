import type { HubClient } from './client.js';
import type { GraphSummary } from './client.js';
import { imprimirJson, required, type Args } from './cmd-util.js';
import { HOOK_TARGETS, avisoDeTimeoutDoHook, lerConfig } from './hooks-install.js';

/**
 * `--json` uniforme (item 5.6): antes só `discover`, `policy show` e `audit`
 * tinham saída máquina-legível. Estes comandos de leitura, com `--json`,
 * imprimem SÓ o JSON no stdout — sem cor, sem linha de ajuda, sem "dica".
 * (Mensagem de autostart, se houver, sai no stderr.)
 *
 * Os comandos que já tinham `--json` próprio (`discover`, `policy`, `audit`)
 * continuam no caminho deles.
 */
export const JSON_COMMANDS: ReadonlySet<string> = new Set([
  'status',
  'health',
  'sessions',
  'projects',
  'agents',
  'approvals',
  'budget',
  'graph',
  'doctor',
]);

function totalUsd(nodes: GraphSummary[]): number {
  return nodes.reduce((sum, node) => sum + node.usd + totalUsd(node.children), 0);
}

export async function jsonCommand(client: HubClient, args: Args, ctx: { home: string; url: string }): Promise<void> {
  switch (args.command) {
    case 'status': {
      const [health, { agents }, { sessions }, { approvals }] = await Promise.all([
        client.health(),
        client.agents(),
        client.sessions(),
        client.approvals(),
      ]);
      const vivas = sessions.filter((s) => s.state === 'running' || s.state === 'waiting_approval');
      return imprimirJson({
        daemon: { ok: health.ok, version: health.version, url: ctx.url, home: ctx.home },
        agents: {
          total: agents.length,
          available: agents.filter((a) => a.probe?.installed === true).map((a) => a.id),
        },
        sessions: { total: sessions.length, live: vivas },
        approvals: { pending: approvals.length, items: approvals },
      });
    }
    case 'health':
      return imprimirJson(await client.health());
    case 'sessions':
      return imprimirJson(await client.sessions());
    case 'projects':
      return imprimirJson(await client.projects());
    case 'agents':
      return imprimirJson(await client.agents());
    case 'approvals':
      return imprimirJson(await client.approvals());
    case 'budget':
      return imprimirJson(await client.budget(required(args.positional[0], 'rootId')));
    case 'graph': {
      const { graph } = await client.graph(required(args.positional[0], 'rootId'));
      return imprimirJson({ graph, totalUsd: totalUsd(graph) });
    }
    case 'doctor': {
      if (args.flags['smoke'] === true) {
        // `--smoke` gasta tokens e imprime progresso: não combina com saída pura.
        throw new Error('--smoke não aceita --json (abre sessões reais e mostra progresso); rode sem --json');
      }
      const [{ probes }, { agents }] = await Promise.all([client.probeAgents(), client.agents()]);
      const hookWarnings = HOOK_TARGETS.flatMap((alvo) => {
        const aviso = avisoDeTimeoutDoHook(lerConfig(alvo.configUsuario));
        return aviso ? [{ agentId: alvo.id, warning: aviso }] : [];
      });
      return imprimirJson({
        probes,
        installed: probes.filter((p) => p.installed).length,
        total: probes.length,
        loginHints: Object.fromEntries(agents.filter((a) => a.loginHint).map((a) => [a.id, a.loginHint])),
        hookWarnings,
      });
    }
    default:
      throw new Error(`"${args.command}" não tem saída --json`);
  }
}
