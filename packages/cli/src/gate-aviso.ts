import type { HubClient, IntegrationSummary } from './client.js';

/**
 * Aviso de gate pré-execução ausente no `hub start` (vistoria 14, R14-11).
 *
 * O padrão é `semi` com `exec: allow` na política, e a ÚNICA prevenção real do
 * irreversível (`git push`, `rm -rf`) é o gate pré-execução — que exige
 * `hub hooks install <agente> --write` manual. Sem ele o Hub só vê a ação
 * depois que ela rodou (vigilância: para a sessão e pede aprovação
 * posterior). Isso estava escrito só na seção Segurança do README; nada na
 * saída do `hub start` dizia. Agora diz, em toda sessão até o gate existir.
 *
 * A detecção é a mesma do painel (`GET /integrations`, `daemon/integrations.ts`:
 * hook do Hub na config do agente, ou o bypass do Codex ligado no daemon) e
 * inclui o aviso de timeout antigo do hook.
 */
export function avisoDeGate(agentId: string, integracao: IntegrationSummary | undefined): string[] {
  const hook = integracao?.hook;
  if (!hook || hook.modo === 'nenhum') {
    return [
      `⚠ ${agentId} não tem gate pré-execução: o Hub só vigia depois que a ferramenta roda (vigilância ` +
        'reativa) — ações de risco não são bloqueadas antes, só param a sessão depois de executadas.',
    ];
  }
  const instalar = hook.comando ?? `hub hooks install ${agentId} --write`;
  if (!hook.instalado) {
    return [
      `⚠ o gate pré-execução não está instalado para ${agentId}: ações de risco só serão vigiadas, ` +
        `não bloqueadas — rode ${instalar}`,
      ...(hook.erro ? [`  (a config do agente não pôde ser lida: ${hook.erro})`] : []),
    ];
  }
  if (hook.avisoTimeout) return [`⚠ ${hook.avisoTimeout} — reinstale: ${instalar}`];
  return [];
}

/**
 * Consulta o daemon e devolve as linhas de aviso para `agentId`. Nunca lança:
 * o aviso é ajuda, e um daemon antigo sem a rota não pode derrubar o `start`.
 */
export async function avisoDeGateDoAgente(client: HubClient, agentId: string): Promise<string[]> {
  try {
    const { integrations } = await client.integrations();
    return avisoDeGate(
      agentId,
      integrations.find((i) => i.agentId === agentId),
    );
  } catch {
    return [];
  }
}
