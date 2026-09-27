import type { HubClient } from './client.js';
import type { Args } from './cmd-util.js';
import { erroDeUso } from './erro-cli.js';
import { resolveProjectId } from './project-resolve.js';
import { bold, dim, green, yellow } from './render.js';

/**
 * `hub project env` — lista, define ou remove variáveis de ambiente por agente.
 * Fora de `main.ts` para ser testável contra um daemon de teste.
 *
 * Vistoria 07:
 * - R07-22: a listagem e o eco do `--set` imprimiam `OPENAI_API_KEY=abc` em
 *   claro no terminal (e em qualquer log que capture a saída). Valores de
 *   chaves com cara de segredo, ou valores que por si parecem credencial
 *   (`Bearer ...`, `sk-...`), saem mascarados.
 * - R07-11: `--set` sem valor listava em vez de reclamar, `--unset` de chave
 *   inexistente dizia "removido", e `--agent naoexiste` gravava no arquivo.
 */

type Log = (linha: string) => void;

export interface OpcoesDeProjectEnv {
  log?: Log;
  logErro?: Log;
}

/** Nome que sugere segredo (avisar antes de gravar e mascarar ao mostrar). */
export function pareceSegredo(chave: string): boolean {
  return /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i.test(chave);
}

/** Valor que parece credencial mesmo sob um nome inocente. */
function valorPareceCredencial(valor: string): boolean {
  const v = valor.trim();
  return (
    /^(Bearer|Basic|Token)\s+\S/i.test(v) ||
    /^(sk|pk|rk)-[A-Za-z0-9_-]{8,}/.test(v) ||
    /^(ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abpr])[-_][A-Za-z0-9_-]{8,}/.test(v) ||
    /^AKIA[0-9A-Z]{12,}$/.test(v)
  );
}

export const MASCARA = '****';

/** O que mostrar no terminal para `chave=valor`. Vazio continua vazio. */
export function valorParaMostrar(chave: string, valor: string): string {
  if (valor === '') return valor;
  return pareceSegredo(chave) || valorPareceCredencial(valor) ? MASCARA : valor;
}

const AVISO_ARQUIVO_VERSIONADO =
  'o valor fica em texto puro no banco do Hub (~/.agents-hub), fora do repositório. ' +
  'Para servidor local (Ollama, LM Studio) um valor qualquer costuma bastar; para chave ' +
  'de verdade, prefira o login nativo do CLI do agente.';

function flagDeValor(args: Args, nome: string, exemplo: string): string | undefined {
  const v = args.flags[nome];
  if (v === undefined) return undefined;
  if (v === true || v === false || (typeof v === 'string' && v.trim() === '')) {
    throw erroDeUso(`--${nome} precisa de um valor: ${exemplo}`);
  }
  return v;
}

export async function projectEnvCommand(
  client: HubClient,
  args: Args,
  projectRef: string | undefined,
  o: OpcoesDeProjectEnv = {},
): Promise<void> {
  const log = o.log ?? ((l: string) => console.log(l));
  const logErro = o.logErro ?? ((l: string) => console.error(l));

  // Flags validadas ANTES de qualquer rede: erro de digitação não registra
  // projeto nem consulta o daemon.
  const agentId = flagDeValor(args, 'agent', 'hub project env --agent claude');
  const setFlag = flagDeValor(args, 'set', '--set CHAVE=VALOR');
  const unsetFlag = flagDeValor(args, 'unset', '--unset CHAVE');
  if (setFlag !== undefined && setFlag.indexOf('=') <= 0) {
    throw erroDeUso(`formato esperado: --set CHAVE=VALOR (recebido: "${setFlag.split('=')[0]}")`);
  }
  if ((setFlag !== undefined || unsetFlag !== undefined) && agentId === undefined) {
    throw erroDeUso('--agent é obrigatório para configurar (ex.: --agent claude --set MODEL=...)');
  }

  if (agentId !== undefined) {
    const { agents } = await client.agents();
    if (!agents.some((a) => a.id === agentId)) {
      throw erroDeUso(
        `agente "${agentId}" não registrado. Disponíveis: ${agents.map((a) => a.id).join(', ') || '(nenhum)'}`,
      );
    }
  }

  const projectId = await resolveProjectId(client, projectRef);
  const { context, repo } = await client.projectContext(projectId);

  if (setFlag === undefined && unsetFlag === undefined) {
    // O do repositório só vale com confiança — o aviso diz o que está ignorado.
    if (repo?.warning) logErro(yellow(`aviso: ${repo.warning}`));
    const env = context.env ?? {};
    const agentIds = agentId !== undefined ? [agentId] : Object.keys(env);
    if (agentIds.length === 0) {
      log(dim('nenhuma variável de ambiente configurada neste projeto.'));
      return;
    }
    let mascarou = false;
    for (const id of agentIds) {
      log(bold(id));
      const entries = Object.entries(env[id] ?? {});
      if (entries.length === 0) log(`  ${dim('(nenhuma)')}`);
      for (const [chave, valor] of entries) {
        const mostrado = valorParaMostrar(chave, valor);
        if (mostrado !== valor) mascarou = true;
        log(`  ${chave}=${mostrado}`);
      }
    }
    if (mascarou) log(dim(`valores com cara de segredo aparecem como ${MASCARA}.`));
    return;
  }

  const agente = agentId as string;
  const envAtual: Record<string, Record<string, string>> = { ...(context.env ?? {}) };
  const doAgente: Record<string, string> = { ...(envAtual[agente] ?? {}) };

  if (unsetFlag !== undefined && !(unsetFlag in doAgente)) {
    const existentes = Object.keys(doAgente);
    throw erroDeUso(
      `"${unsetFlag}" não está configurada para ${agente} — nada removido` +
        (existentes.length > 0 ? ` (configuradas: ${existentes.join(', ')})` : ' (nenhuma configurada)'),
    );
  }

  let chave: string | undefined;
  if (setFlag !== undefined) {
    const posIgual = setFlag.indexOf('=');
    chave = setFlag.slice(0, posIgual).trim();
    doAgente[chave] = setFlag.slice(posIgual + 1);
    if (pareceSegredo(chave)) logErro(yellow(`aviso: ${AVISO_ARQUIVO_VERSIONADO}`));
  }
  if (unsetFlag !== undefined) delete doAgente[unsetFlag];

  envAtual[agente] = doAgente;
  const { context: salvo } = await client.saveProjectContext(projectId, { ...context, env: envAtual });

  const ficou = salvo.env?.[agente] ?? {};
  if (chave !== undefined) {
    if (chave in ficou) {
      log(`${green('gravado')} ${bold(agente)} ${chave}=${valorParaMostrar(chave, ficou[chave] ?? '')}`);
    } else {
      // O daemon recusou — nome fora da lista de permissão. Silêncio aqui
      // seria a mesma fachada que este trabalho existe para acabar.
      throw new Error(`"${chave}" foi recusada pelo daemon (fora da lista de permissão de ambiente).`);
    }
  }
  if (unsetFlag !== undefined) log(`${green('removido')} ${bold(agente)} ${unsetFlag}`);
}
