import type { HubClient, IntegrationSummary } from './client.js';

/**
 * Aviso de gate pré-execução ausente no `hub start` (vistoria 14, R14-11).
 *
 * O padrão é `semi` com `exec: allow` na política, e a ÚNICA prevenção real do
 * irreversível (`git push`, `rm -rf`) é o gate pré-execução. Sem ele o Hub
 * só vê a ação depois que ela rodou (vigilância: para a sessão e pede
 * aprovação posterior).
 *
 * Nas sessões que o próprio Hub sobe, o gate já não depende de instalação
 * manual para Claude Code e OpenClaude (o daemon injeta o hook por sessão via
 * `--settings`) nem para o Codex com o bypass ligado:
 * `hook.sessoesDoHubGateadas`. Aí o `hub hooks install --write` só estende o
 * gate às sessões abertas FORA do Hub — que o `hub start` não abre —, então
 * não há o que avisar. Nos demais agentes a instalação continua manual.
 *
 * A detecção é a mesma do painel (`GET /integrations`, `daemon/integrations.ts`;
 * rótulo em `web/src/logic/security.ts` `estadoDoHook`) e inclui o aviso de
 * timeout antigo do hook.
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
  const timeoutAntigo = hook.avisoTimeout ? [`⚠ ${hook.avisoTimeout} — reinstale: ${instalar}`] : [];
  // `=== true`: daemon antigo não manda o campo, e aí vale o aviso de sempre.
  // Mesmo gateada por sessão, o timeout antigo continua valendo: o Claude
  // SOMA os hooks do settings do usuário aos do `--settings` e só deduplica
  // comando idêntico (ver `daemon/session-settings.ts`), então o hook velho
  // do arquivo também dispara na sessão do Hub.
  if (hook.sessoesDoHubGateadas === true) return timeoutAntigo;
  if (!hook.instalado) {
    return [
      `⚠ o gate pré-execução não está instalado para ${agentId}: ações de risco só serão vigiadas, ` +
        `não bloqueadas — rode ${instalar}`,
      ...(hook.erro ? [`  (a config do agente não pôde ser lida: ${hook.erro})`] : []),
    ];
  }
  return timeoutAntigo;
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
