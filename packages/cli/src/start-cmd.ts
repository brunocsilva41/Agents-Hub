import type { BriefInput, HubClient } from './client.js';
import { avisoDeGateDoAgente } from './gate-aviso.js';
import { resolverProjeto } from './project-resolve.js';
import { bold, dim, green, red, yellow } from './render.js';
import { acompanhar, codigoDeSaida, relatarDesfecho, type Desfecho } from './session-follow.js';

/**
 * `hub start` — fora de `main.ts` para ser testável sem disparar `main()`.
 *
 * Validação LOCAL e em ordem de utilidade (vistoria 2026-09-25, 07 e 14):
 * `--mode bogus` e `--isolation bogus` eram aceitos em silêncio e a sessão
 * rodava com o padrão (uma flag de supervisão digitada errado não protegia);
 * com `--agent nope "teste"` o erro era sobre o objetivo curto, e só depois de
 * corrigi-lo aparecia que o agente não existia.
 */

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

type Log = (linha: string) => void;

export const MODOS = ['supervised', 'semi', 'autonomous'] as const;
/** `container` existe no tipo mas o daemon ainda recusa — melhor dizer aqui. */
export const ISOLAMENTOS = ['worktree', 'none'] as const;
/** Mesmo mínimo de `BriefSchema.objective` (core/brief.ts). */
export const OBJETIVO_MINIMO = 8;

export interface OpcoesDeStart {
  log?: Log;
  logErro?: Log;
  pollMs?: number;
}

/**
 * Valida as flags de `hub start` sem rede. Devolve o brief parcial (sem
 * projeto) ou um `Error` com a mensagem para o usuário.
 */
export function validarFlagsDeStart(args: Args): { agent: string; objective: string; brief: Omit<BriefInput, 'agent' | 'objective'> } | Error {
  const agent = args.flags['agent'];
  if (agent === true) return new Error('--agent precisa de um valor: hub start --agent claude "objetivo"');
  if (typeof agent !== 'string' || agent.trim() === '') {
    return new Error('--agent é obrigatório: você escolhe o principal a cada sessão (ADR 04.1)');
  }

  const brief: Omit<BriefInput, 'agent' | 'objective'> = {};

  const mode = args.flags['mode'];
  if (mode !== undefined) {
    if (typeof mode !== 'string' || !(MODOS as readonly string[]).includes(mode)) {
      return new Error(`--mode inválido: "${String(mode)}" (válidos: ${MODOS.join(', ')})`);
    }
    brief.supervision = mode as (typeof MODOS)[number];
  }

  const isolation = args.flags['isolation'];
  if (isolation !== undefined) {
    if (isolation === 'container') {
      return new Error('--isolation container ainda não está implementado (válidos: worktree, none)');
    }
    if (typeof isolation !== 'string' || !(ISOLAMENTOS as readonly string[]).includes(isolation)) {
      return new Error(`--isolation inválido: "${String(isolation)}" (válidos: ${ISOLAMENTOS.join(', ')})`);
    }
    brief.isolation = isolation as (typeof ISOLAMENTOS)[number];
  } else {
    brief.isolation = 'worktree';
  }

  const budget = lerBudgetUsd(args.flags['budget-usd']);
  if (budget instanceof Error) return budget;
  if (budget !== undefined) brief.budget = { usd: budget };

  if (args.flags['project'] === true) {
    return new Error('--project precisa de um valor: id (prj_...) ou caminho da pasta');
  }

  const objective = args.positional.join(' ').trim();
  return { agent: agent.trim(), objective, brief };
}

/**
 * Espelha `lerOrcamento` de `workflow-cmd.ts`: falhar localmente é imediato e
 * não depende do daemon estar de pé.
 */
export function lerBudgetUsd(flag: string | boolean | undefined): number | undefined | Error {
  if (flag === undefined) return undefined;
  if (typeof flag === 'boolean') return new Error('--budget-usd precisa de um valor em dólares');
  const n = Number(flag);
  if (!Number.isFinite(n) || n <= 0) {
    return new Error(`--budget-usd inválido: "${flag}"`);
  }
  return n;
}

/** Agente (ou `cap:x`) existe? Erro lista os ids válidos. */
async function validarAgente(client: HubClient, agent: string): Promise<Error | null> {
  if (agent.startsWith('cap:')) return null;
  const { agents } = await client.agents();
  if (agents.some((a) => a.id === agent)) return null;
  const ids = agents.map((a) => a.id).join(', ');
  return new Error(
    `agente "${agent}" não registrado. Disponíveis: ${ids || '(nenhum)'} — veja o estado de cada um com: hub doctor`,
  );
}

export async function startCommand(client: HubClient, args: Args, o: OpcoesDeStart = {}): Promise<Desfecho | null> {
  const log = o.log ?? ((l: string) => console.log(l));
  const logErro = o.logErro ?? ((l: string) => console.error(l));
  const falhar = (msg: string): null => {
    logErro(red(msg));
    process.exitCode = 1;
    return null;
  };

  const flags = validarFlagsDeStart(args);
  if (flags instanceof Error) return falhar(flags.message);

  // Agente antes do objetivo: "não existe" é o erro que muda o que você faz.
  const agenteInvalido = await validarAgente(client, flags.agent);
  if (agenteInvalido) return falhar(agenteInvalido.message);

  if (flags.objective.length === 0) {
    return falhar('faltou o objetivo: hub start --agent claude "refatore o módulo X"');
  }
  if (flags.objective.length < OBJETIVO_MINIMO) {
    return falhar(
      `objetivo curto demais ("${flags.objective}"): descreva a tarefa em pelo menos ${OBJETIVO_MINIMO} ` +
        'caracteres — o agente recebe só isto (ex.: "liste os arquivos da pasta src").',
    );
  }

  const project = await resolverProjeto(client, args.flags['project']);
  const brief: BriefInput = { agent: flags.agent, objective: flags.objective, ...flags.brief };

  const result = await client.startSession({ projectId: project.id, brief });
  const agenteReal = result.session.agentId;
  log(`${green('sessão iniciada')} ${bold(result.session.id)} ${dim(`(${agenteReal})`)}`);
  if (agenteReal !== flags.agent && !flags.agent.startsWith('cap:')) {
    // O daemon resolveu para outro agente (ex.: roteamento por fallback).
    log(yellow(`⚠ pedido "${flags.agent}", rodando em "${agenteReal}"`));
  }
  log(dim(`${brief.isolation === 'none' ? 'pasta' : 'worktree'}: ${result.session.workdir}`));
  log(dim(`modo: ${result.session.mode}`));
  // O modo nunca passa do padrão do agente: `--mode autonomous` num agente
  // `semi` roda em `semi`. Reduzir é o lado seguro, mas não em silêncio.
  if (brief.supervision !== undefined && result.session.mode !== brief.supervision) {
    log(
      yellow(
        `⚠ modo "${brief.supervision}" pedido, mas a sessão roda em "${result.session.mode}" — o padrão do agente ${agenteReal} limita o modo`,
      ),
    );
  }

  // R14-11: sem o gate pré-execução, o padrão (`semi`, `exec: allow`) só
  // vigia — dizer isso aqui, onde a pessoa está olhando, e não só no README.
  for (const linha of await avisoDeGateDoAgente(client, agenteReal)) log(yellow(linha));

  if (args.flags['detach'] === true) {
    log(dim(`acompanhe com: hub watch ${result.session.id}`));
    return null;
  }

  log('');
  const desfecho = await acompanhar(client, {
    rootId: result.session.rootId,
    taskId: result.task.id,
    log,
    pollMs: o.pollMs,
  });
  relatarDesfecho(desfecho, log, logErro);
  const codigo = codigoDeSaida(desfecho);
  if (codigo !== 0) process.exitCode = codigo;
  return desfecho;
}
