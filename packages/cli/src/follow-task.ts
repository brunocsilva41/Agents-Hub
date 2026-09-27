import type { HubClient, TaskStatus } from './client.js';
import { bold, cyan, deveExibir, dim, formatTokens, green, red, renderEvent, yellow } from './render.js';

const NEWLINE = String.fromCharCode(10);
const TERMINAIS = new Set(['completed', 'failed', 'canceled', 'rejected']);

/** Relógio do acompanhamento — injetável só para teste. */
export interface FollowOptions {
  intervaloMs?: number;
}

/** A tarefa passou para outra sessão (fallback): siga por lá. */
interface Mudou {
  sessionId: string;
  taskId: string;
}

/**
 * Acompanha o stream e devolve o terminal quando o fluxo termina.
 *
 * "Terminou" aqui é o fim da TAREFA — não o fim do primeiro agente: num
 * fluxo com delegação, o pai fecha depois dos filhos; num fallback, a tarefa
 * muda de sessão (o substituto é uma sessão nova) e o acompanhamento vai
 * junto. Antes `hub start`/`hub watch` saíam calados na primeira falha,
 * enquanto o Hub seguia gastando com outro agente.
 */
export async function streamUntilDone(
  client: HubClient,
  filter: { sessionId?: string; rootId?: string },
  opcoes: FollowOptions & { taskId?: string } = {},
): Promise<void> {
  let atual = filter;
  let taskId = opcoes.taskId;
  let alvo = filter.sessionId ?? filter.rootId;

  for (;;) {
    const showAgent = atual.rootId !== undefined;
    let proxima: string | null = null;

    for await (const event of client.stream(atual)) {
      if (deveExibir(event)) console.log(renderEvent(event, { showAgent }));

      if (taskId === undefined && event.taskId && event.sessionId === alvo) taskId = event.taskId;
      const doAlvo = alvo === undefined || event.sessionId === alvo;
      // `fimDoProcesso`: o daemon fecha a run com log técnico quando o agente
      // já emitiu o próprio `turn.completed` (um por turno).
      const fimDeTurno =
        doAlvo &&
        (event.type === 'turn.completed' ||
          event.type === 'error' ||
          event.type === 'session.ended' ||
          (event.type === 'log' && event.payload['fimDoProcesso'] === true));
      if (!fimDeTurno || alvo === undefined) continue;

      // O turno acabar NÃO quer dizer que a tarefa acabou: ainda faltam o
      // portão de validação e, se ele reprovar, retry ou troca de agente.
      const r = await aguardarTaskTerminal(client, alvo, taskId, opcoes);
      if (r === true) return;
      if (r === false) continue;

      taskId = r.taskId;
      alvo = r.sessionId;
      // Stream de UMA sessão não vê o substituto (sessão irmã): reabre na
      // sessão nova. Stream da raiz já o vê — só troca o alvo.
      if (atual.sessionId !== undefined) {
        proxima = r.sessionId;
        break;
      }
    }

    if (proxima === null) return;
    atual = { sessionId: proxima };
  }
}

/**
 * Espera a tarefa chegar a um estado terminal, relatando o portão de
 * validação. Devolve `false` quando a tarefa voltou a rodar na MESMA sessão
 * (retry), para o chamador seguir no stream; e a sessão nova quando ela
 * passou para outro agente (fallback).
 */
export async function aguardarTaskTerminal(
  client: HubClient,
  sessionId: string,
  taskIdConhecida: string | undefined,
  opcoes: FollowOptions = {},
): Promise<boolean | Mudou> {
  const intervaloMs = opcoes.intervaloMs ?? 1000;
  const taskId = taskIdConhecida ?? (await descobrirTask(client, sessionId));
  if (taskId === undefined) return true;
  let avisou = false;

  for (let i = 0; i < 600; i += 1) {
    let status: TaskStatus;
    try {
      status = await client.task(taskId);
    } catch {
      return true;
    }
    const { task } = status;

    if (task.sessionId !== sessionId) {
      console.log(
        `${NEWLINE}${yellow('↪')} a tarefa passou para ${cyan(status.session.agentId)} ${dim(
          `(${task.sessionId})`,
        )} — acompanhando`,
      );
      return { sessionId: task.sessionId, taskId };
    }

    // Bloqueio por decisão humana NÃO é espera: ninguém vai destravar enquanto
    // o terminal está preso. Antes, a CLI ficava dez minutos calada aqui.
    if (task.state === 'input_required') {
      const pendente = status.approval ?? null;

      console.log(`${NEWLINE}${yellow('⏸ bloqueado, esperando você')}`);
      if (pendente) {
        console.log(`   ${pendente.action} ${dim(`[${pendente.risk}]`)}`);
        console.log(
          `${NEWLINE}   ${bold(`hub approve ${pendente.id}`)}   ${dim('ou')}   ${bold(`hub deny ${pendente.id}`)}`,
        );
      } else {
        console.log(dim('   nenhuma aprovação registrada — veja `hub approvals`'));
      }
      return true;
    }

    if (!TERMINAIS.has(task.state)) {
      // Rodando de novo na mesma sessão (retry): volta ao stream.
      if (status.live) return false;
      if (!avisou) {
        console.log(dim('… aguardando o portão de validação'));
        avisou = true;
      }
      await new Promise((r) => setTimeout(r, intervaloMs));
      continue;
    }

    const validacao = task.result?.validation;
    if (validacao) {
      for (const check of validacao.checks) {
        console.log(
          `${check.passed ? green('✓') : red('✗')} validação: ${check.name}${
            check.detail ? dim(` — ${check.detail}`) : ''
          }`,
        );
      }
    }

    const { budget } = status;
    console.log(
      `${NEWLINE}${dim('custo do fluxo:')} US$ ${budget.consumed.usd.toFixed(4)} · ${formatTokens(
        budget.consumed.tokens,
      )} tokens ${dim(`(${Math.round(budget.pressure * 100)}% do orçamento)`)}`,
    );
    return true;
  }

  return true;
}

/**
 * Task de uma sessão. Depois de um fallback a sessão original fica SEM task
 * (ela foi reatribuída ao substituto); a timeline dela ainda aponta qual era.
 */
async function descobrirTask(client: HubClient, sessionId: string): Promise<string | undefined> {
  const { tasks } = await client.tasks(sessionId).catch(() => ({ tasks: [] }));
  if (tasks[0]) return tasks[0].id;
  const { events } = await client
    .events(sessionId, { tail: true, limit: 200 })
    .catch(() => ({ events: [] as Array<{ taskId: string | null }> }));
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const id = events[i]!.taskId;
    if (id) return id;
  }
  return undefined;
}
