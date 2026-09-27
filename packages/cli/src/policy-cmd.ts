import path from 'node:path';
import type { AuditEntrySummary, AuditKindSummary, AuditQuery, HubClient, PolicyDoc } from './client.js';
import { erroDeUso } from './erro-cli.js';
import { dataHoraLocal } from './hora.js';
import { projetoQueContem } from './project-resolve.js';
import { bold, cyan, dim, green, red, yellow } from './render.js';

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

type ResolveProject = (client: HubClient, flag: string | boolean | undefined) => Promise<string>;

/**
 * `hub policy` e `hub audit` (item 1.10 do GOAL).
 *
 * Em arquivo próprio (como `pause-cmd.ts`) para poder ser testado sem
 * importar `main.ts`. Escrever exige o token de operador, que o `HubClient`
 * da CLI lê de `<AGENTS_HUB_HOME>/operator-token`.
 *
 * Toda escrita é ler-modificar-gravar da CAMADA (o que o arquivo declara),
 * nunca da política efetiva: gravar a efetiva congelaria os padrões atuais no
 * arquivo do usuário e esconderia o que ele realmente mudou.
 */
export async function policyCommand(
  client: HubClient,
  args: Args,
  resolveProject: ResolveProject,
): Promise<void> {
  const [sub = 'show', ...rest] = args.positional;
  const noProjeto = args.flags['project'] !== undefined;
  const projectId = noProjeto ? await resolveProject(client, args.flags['project']) : undefined;

  switch (sub) {
    case 'show':
      return policyShow(client, projectId, args.flags['json'] === true);
    case 'set': {
      const campo = obrigatorio(rest[0], 'campo (ex.: defaultBudget.usd)');
      const valor = interpretarValor(obrigatorio(rest[1], 'valor'));
      return editar(client, projectId, (layer) => definirCaminho(layer, campo, valor));
    }
    case 'unset': {
      const campo = obrigatorio(rest[0], 'campo');
      return editar(client, projectId, (layer) => removerCaminho(layer, campo));
    }
    case 'allow':
    case 'deny': {
      const acao = obrigatorio(rest[0], 'add|rm');
      const prefixo = obrigatorio(rest.slice(1).join(' ').trim() || undefined, 'prefixo do comando');
      if (acao !== 'add' && acao !== 'rm') throw new Error(`use "add" ou "rm", não "${acao}"`);
      return editar(client, projectId, (layer, view) => {
        const lista = listaDeComandos(layer, view, sub, projectId !== undefined);
        const nova =
          acao === 'add' ? [...new Set([...lista, prefixo])] : lista.filter((item) => item !== prefixo);
        definirCaminho(layer, `commands.${sub}`, nova);
      });
    }
    case 'mode': {
      const nivel = obrigatorio(
        rest[0],
        'nível de risco (read|write|exec|escalate|irreversible|budget)',
      );
      const decisao = obrigatorio(rest[1], 'decisão (allow|approve|deny)');
      return editar(client, projectId, (layer) => definirCaminho(layer, `risk.${nivel}`, decisao));
    }
    default:
      throw new Error(`subcomando desconhecido: "${sub}". Use show, set, unset, allow, deny ou mode.`);
  }
}

async function policyShow(
  client: HubClient,
  projectId: string | undefined,
  json: boolean,
): Promise<void> {
  const { policy } = await client.policy(projectId);
  if (json) {
    console.log(JSON.stringify(policy, null, 2));
    return;
  }
  console.log(bold('Camada global'), dim(policy.global.file));
  console.log(formatarCamada(policy.global.layer));

  const p = policy.project;
  if (p) {
    console.log(
      `${NL}${bold('Camada do projeto')} ${dim(p.file)} ${p.trusted ? green('(confiável)') : dim('(não confiável)')}`,
    );
    if (p.error) console.log(red(`  ${p.error}`));
    console.log(formatarCamada(p.layer));
    if (p.clamped.length > 0) {
      console.log(yellow(`  sem efeito (tentam afrouxar a global): ${p.clamped.join(', ')}`));
    }
    if (p.ignoredExecFields.length > 0) {
      console.log(yellow(`  ignorados (projeto não confiável): ${p.ignoredExecFields.join(', ')}`));
    }
  }

  const ef = (p ?? policy.global).effective;
  console.log(`${NL}${bold('Efetiva')} ${dim(p ? '(global + projeto)' : '(padrão + global)')}`);
  const risk = (ef['risk'] ?? {}) as Record<string, string>;
  console.log(
    `  risco:      ${Object.entries(risk)
      .map(([k, v]) => `${k}=${colorirDecisao(v)}`)
      .join('  ')}`,
  );
  const cmds = (ef['commands'] ?? {}) as { allow?: string[]; deny?: string[] };
  console.log(`  allow:      ${(cmds.allow ?? []).join(', ') || dim('(vazia)')}`);
  console.log(`  deny:       ${(cmds.deny ?? []).join(', ') || dim('(vazia)')}`);
  const budget = (ef['defaultBudget'] ?? {}) as Record<string, number>;
  console.log(`  orçamento:  US$ ${budget['usd']} · ${budget['tokens']} tokens · ${budget['seconds']}s`);
  console.log(
    `  limites:    profundidade ${String(ef['maxDepth'])} · concorrência ${String(ef['maxConcurrency'])} ` +
      `(${String(ef['maxConcurrencyPerAgent'])}/agente) · task ${String(ef['taskTimeoutSeconds'])}s`,
  );
  console.log(`${NL}${dim('edite com:')} ${bold('hub policy set <campo> <valor> [--project]')}`);
}

async function editar(
  client: HubClient,
  projectId: string | undefined,
  mudar: (layer: PolicyDoc, view: Awaited<ReturnType<HubClient['policy']>>['policy']) => void,
): Promise<void> {
  const { policy } = await client.policy(projectId);
  const alvo = projectId !== undefined ? policy.project : policy.global;
  if (!alvo) throw new Error('o daemon não devolveu a camada do projeto');
  const layer = structuredClone(alvo.layer);
  mudar(layer, policy);

  if (projectId === undefined) {
    const res = await client.setGlobalPolicy(layer);
    console.log(green('✓ camada global gravada'), res.backup ? dim(`(backup: ${res.backup})`) : '');
    if (res.loosened.length > 0) {
      console.log(yellow(`⚠ isto AFROUXA a política: ${res.loosened.join(', ')}`));
    }
    return;
  }
  const res = await client.setProjectPolicy(projectId, layer);
  console.log(green('✓ camada do projeto gravada'), dim(res.project.file));
  if (res.clamped.length > 0) {
    console.log(
      yellow(`⚠ sem efeito — o projeto só aperta a política global: ${res.clamped.join(', ')}`),
    );
  }
  if (res.ignoredExecFields.length > 0) {
    console.log(yellow(`⚠ ignorados até "hub project trust": ${res.ignoredExecFields.join(', ')}`));
  }
}

/**
 * Lista de partida para `allow|deny add|rm`.
 *
 * Global: a camada SUBSTITUI a lista do padrão, então parte-se da efetiva
 * (senão `add npm test` apagaria todo o resto do padrão). Projeto: `deny`
 * soma à global (parte-se do que a camada já tem); `allow` FILTRA a global
 * (parte-se da efetiva global, senão adicionar um item restringiria a allow
 * list a ele só).
 */
function listaDeComandos(
  layer: PolicyDoc,
  view: Awaited<ReturnType<HubClient['policy']>>['policy'],
  qual: 'allow' | 'deny',
  projeto: boolean,
): string[] {
  const daCamada = ((layer['commands'] ?? {}) as Record<string, string[] | undefined>)[qual];
  if (daCamada !== undefined) return [...daCamada];
  if (projeto && qual === 'deny') return [];
  const efetiva = (view.global.effective['commands'] ?? {}) as Record<string, string[] | undefined>;
  return [...(efetiva[qual] ?? [])];
}

/** `2` -> número, `true` -> booleano, `null`, `["a"]` -> JSON; o resto é texto. */
export function interpretarValor(bruto: string): unknown {
  try {
    return JSON.parse(bruto);
  } catch {
    return bruto;
  }
}

export function definirCaminho(doc: PolicyDoc, caminho: string, valor: unknown): void {
  const partes = caminho.split('.').filter((p) => p.length > 0);
  if (partes.length === 0) throw new Error('campo vazio');
  let atual: Record<string, unknown> = doc;
  for (const parte of partes.slice(0, -1)) {
    const prox = atual[parte];
    if (prox === null || typeof prox !== 'object' || Array.isArray(prox)) atual[parte] = {};
    atual = atual[parte] as Record<string, unknown>;
  }
  atual[partes[partes.length - 1]!] = valor;
}

/** Remove o campo e os objetos pais que ficaram vazios. */
export function removerCaminho(doc: PolicyDoc, caminho: string): void {
  const partes = caminho.split('.').filter((p) => p.length > 0);
  const pilha: Array<Record<string, unknown>> = [doc];
  let atual: Record<string, unknown> = doc;
  for (const parte of partes.slice(0, -1)) {
    const prox = atual[parte];
    if (prox === null || typeof prox !== 'object' || Array.isArray(prox)) return;
    atual = prox as Record<string, unknown>;
    pilha.push(atual);
  }
  delete atual[partes[partes.length - 1]!];
  for (let i = pilha.length - 1; i > 0; i -= 1) {
    if (Object.keys(pilha[i]!).length > 0) break;
    delete pilha[i - 1]![partes[i - 1]!];
  }
}

function formatarCamada(layer: PolicyDoc): string {
  if (Object.keys(layer).length === 0) return dim('  (vazia — tudo vem do nível de baixo)');
  return JSON.stringify(layer, null, 2)
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
}

function colorirDecisao(d: string): string {
  if (d === 'allow') return green(d);
  if (d === 'deny') return red(d);
  return yellow(d);
}

// ------------------------------------------------------------------ audit

/**
 * `hub audit` — trilha de decisões do gate, aprovações e mudanças de
 * política/confiança. Só leitura; não exige token.
 */
export async function auditCommand(client: HubClient, args: Args): Promise<void> {
  const q: AuditQuery = {};
  const texto = (k: string): string | undefined =>
    typeof args.flags[k] === 'string' ? args.flags[k] : undefined;

  const sessao = texto('session') ?? args.positional[0];
  if (sessao) q.sessionId = sessao;
  const projeto = args.flags['project'];
  if (projeto !== undefined) q.projectId = await acharProjeto(client, projeto);
  const kind = texto('kind');
  if (kind) q.kind = kind as AuditKindSummary;
  const since = texto('since');
  if (since) q.since = since;
  const until = texto('until');
  if (until) q.until = until;
  const limit = texto('limit');
  if (limit) q.limit = Number(limit);

  const { entries } = await client.audit(q);
  if (args.flags['json'] === true) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  if (entries.length === 0) {
    console.log(dim('nenhum registro de auditoria com esses filtros.'));
    return;
  }
  // Mais antigo em cima: lê-se como um log.
  for (const e of [...entries].reverse()) console.log(formatarEntrada(e));
}

export function formatarEntrada(e: AuditEntrySummary): string {
  const quando = dataHoraLocal(e.ts);
  const decisao = e.decision ? colorirDecisao(e.decision) : dim('-');
  const risco = e.risk ? dim(`[${e.risk}]`) : '';
  const sessao = e.sessionId ? dim(` ${e.sessionId}`) : '';
  const motivo = e.reason ? `${NL}    ${dim(e.reason)}` : '';
  return `${dim(quando)} ${cyan(e.actor)} ${e.kind} ${decisao} ${risco} ${e.action}${sessao}${motivo}`;
}

/** Id ou caminho de projeto já registrado — auditoria não registra projeto novo. */
async function acharProjeto(client: HubClient, flag: string | boolean): Promise<string> {
  const alvo = typeof flag === 'string' ? flag : process.cwd();
  if (/^prj_/i.test(alvo)) return alvo;
  const { projects } = await client.projects();
  const caminho = path.resolve(alvo);
  // Subpasta, 8.3 e caixa diferente também acham o projeto (ver project-resolve).
  const achado = projetoQueContem(projects, caminho);
  if (!achado) throw new Error(`nenhum projeto registrado em ${caminho}`);
  return achado.id;
}

function obrigatorio(valor: string | undefined, nome: string): string {
  if (valor === undefined || valor.length === 0) {
    throw erroDeUso(`argumento obrigatório ausente: ${nome}`);
  }
  return valor;
}

const NL = String.fromCharCode(10);
