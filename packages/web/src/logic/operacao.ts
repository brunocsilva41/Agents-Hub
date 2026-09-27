/**
 * Lógica pura da aba Operação (item 6.12): diff, orçamento editável, tarefas,
 * workflow e diagnóstico dos agentes. Sem React e sem DOM — testada em Node
 * (`operacao.test.ts`).
 */
import type {
  AgentSummary,
  BudgetSummary,
  SessionSummary,
  TaskSummary,
  WorkflowRunSummary,
} from '@agents-hub/client';

/* ------------------------------------------------------------------ diff */

export type TipoLinhaDiff = 'add' | 'del' | 'ctx' | 'hunk' | 'meta';

export interface LinhaDiff {
  tipo: TipoLinhaDiff;
  texto: string;
}

export interface ArquivoDiff {
  caminho: string;
  adicoes: number;
  remocoes: number;
  /** `true` quando o git marcou como binário: não há linhas para mostrar. */
  binario: boolean;
  linhas: LinhaDiff[];
}

/** Caminho do arquivo a partir do cabeçalho `diff --git a/x b/x`. */
function caminhoDoCabecalho(linha: string): string {
  const m = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(linha);
  return m ? (m[2] ?? m[1] ?? linha) : linha.replace(/^diff --git\s+/, '');
}

/**
 * Quebra um patch unificado (`git diff`) por arquivo, contando + e −.
 *
 * O patch inteiro numa `<pre>` só é ilegível acima de meia dúzia de arquivos,
 * e o que se quer saber primeiro é "quais arquivos, quanto mudou em cada".
 * Texto que não começa com `diff --git` (patch sem cabeçalho) vira um arquivo
 * único sem nome, em vez de sumir.
 */
export function separarDiff(texto: string): ArquivoDiff[] {
  const arquivos: ArquivoDiff[] = [];
  let atual: ArquivoDiff | null = null;
  let dentroDeHunk = false;

  const novo = (caminho: string): ArquivoDiff => {
    const a: ArquivoDiff = { caminho, adicoes: 0, remocoes: 0, binario: false, linhas: [] };
    arquivos.push(a);
    return a;
  };

  const linhas = texto.replace(/\r\n/g, '\n').split('\n');
  if (linhas.at(-1) === '') linhas.pop();

  for (const linha of linhas) {
    if (linha.startsWith('diff --git ')) {
      atual = novo(caminhoDoCabecalho(linha));
      dentroDeHunk = false;
      atual.linhas.push({ tipo: 'meta', texto: linha });
      continue;
    }
    atual ??= novo('(patch)');
    if (linha.startsWith('@@')) {
      dentroDeHunk = true;
      atual.linhas.push({ tipo: 'hunk', texto: linha });
      continue;
    }
    if (!dentroDeHunk) {
      if (/^Binary files .* differ$/.test(linha) || linha === 'GIT binary patch') atual.binario = true;
      atual.linhas.push({ tipo: 'meta', texto: linha });
      continue;
    }
    if (linha.startsWith('+')) {
      atual.adicoes += 1;
      atual.linhas.push({ tipo: 'add', texto: linha });
    } else if (linha.startsWith('-')) {
      atual.remocoes += 1;
      atual.linhas.push({ tipo: 'del', texto: linha });
    } else {
      atual.linhas.push({ tipo: linha.startsWith('\\') ? 'meta' : 'ctx', texto: linha });
    }
  }
  return arquivos;
}

/* ------------------------------------------------------------- orçamento */

export interface FormOrcamento {
  /** Texto dos campos, como digitado. Vazio = não mexer. */
  usd: string;
  tokens: string;
  /** Minutos: ninguém pensa em teto de tempo em segundos. */
  minutos: string;
}

export function formDoOrcamento(b: BudgetSummary): FormOrcamento {
  return {
    usd: String(Number(b.limits.usd.toFixed(4))),
    tokens: String(Math.round(b.limits.tokens)),
    minutos: String(Number((b.limits.seconds / 60).toFixed(2))),
  };
}

export type LeituraOrcamento =
  | { ok: true; limits: { usd?: number; tokens?: number; seconds?: number } }
  | { ok: false; erro: string };

function numero(texto: string): number | null {
  const t = texto.trim().replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : Number.NaN;
}

/**
 * Converte o formulário no corpo de `PUT /budget/:rootId`, só com o que mudou.
 *
 * Replica as recusas do daemon (positivo, inteiro onde é inteiro, não abaixo
 * do já gasto) para o erro aparecer no campo antes da ida à rede — o daemon
 * continua sendo quem decide.
 */
export function lerFormOrcamento(form: FormOrcamento, atual: BudgetSummary): LeituraOrcamento {
  const limits: { usd?: number; tokens?: number; seconds?: number } = {};
  const usd = numero(form.usd);
  const tokens = numero(form.tokens);
  const minutos = numero(form.minutos);

  if (usd !== null) {
    if (Number.isNaN(usd) || usd <= 0)
      return { ok: false, erro: 'Custo: informe um valor em dólares maior que zero.' };
    if (usd < atual.consumed.usd) {
      return {
        ok: false,
        erro: `Custo: o fluxo já gastou US$ ${atual.consumed.usd.toFixed(4)} — o teto não pode ficar abaixo disso.`,
      };
    }
    if (Math.abs(usd - atual.limits.usd) > 1e-9) limits.usd = usd;
  }
  if (tokens !== null) {
    if (Number.isNaN(tokens) || tokens <= 0 || !Number.isInteger(tokens)) {
      return { ok: false, erro: 'Tokens: informe um número inteiro maior que zero.' };
    }
    if (tokens < atual.consumed.tokens) {
      return {
        ok: false,
        erro: `Tokens: o fluxo já usou ${atual.consumed.tokens} — o teto não pode ficar abaixo disso.`,
      };
    }
    if (tokens !== Math.round(atual.limits.tokens)) limits.tokens = tokens;
  }
  if (minutos !== null) {
    if (Number.isNaN(minutos) || minutos <= 0)
      return { ok: false, erro: 'Tempo: informe minutos maiores que zero.' };
    const seconds = Math.round(minutos * 60);
    if (seconds < 1) return { ok: false, erro: 'Tempo: o mínimo é 1 segundo.' };
    if (seconds < atual.consumed.seconds) {
      return {
        ok: false,
        erro: `Tempo: o fluxo já usou ${Math.ceil(atual.consumed.seconds / 60)} min — o teto não pode ficar abaixo disso.`,
      };
    }
    if (seconds !== Math.round(atual.limits.seconds)) limits.seconds = seconds;
  }

  if (Object.keys(limits).length === 0)
    return { ok: false, erro: 'Nada mudou em relação ao teto atual.' };
  return { ok: true, limits };
}

/* ---------------------------------------------------------------- sessões */

/** Só sessão adotada e ainda viva aceita "desanexar" (o daemon recusa as demais). */
export function podeDesanexar(s: SessionSummary): boolean {
  return s.adopted === true && !['completed', 'failed', 'killed'].includes(s.state);
}

/** Orçamento é da raiz: a sessão selecionada pode ser uma sub-sessão. */
export function raizDe(s: SessionSummary): string {
  return s.rootId || s.id;
}

/* ---------------------------------------------------------------- tarefas */

export const ROTULO_TAREFA: Record<string, string> = {
  submitted: 'na fila',
  working: 'trabalhando',
  input_required: 'aguardando você',
  auth_required: 'precisa de login',
  completed: 'concluída',
  failed: 'falhou',
  canceled: 'cancelada',
  rejected: 'recusada',
};

/** Motivo de falha mais útil que a tarefa carrega, ou `null`. */
export function motivoDaTarefa(t: TaskSummary): string | null {
  const ultima = t.attempts.at(-1);
  if (ultima?.error) return ultima.error;
  const reprovada = t.result?.validation?.checks.find((c) => !c.passed);
  if (reprovada)
    return `validação reprovou: ${reprovada.name}${reprovada.detail ? ` — ${reprovada.detail}` : ''}`;
  if (t.state === 'failed' || t.state === 'rejected' || t.state === 'canceled')
    return `terminou em ${ROTULO_TAREFA[t.state] ?? t.state}`;
  return null;
}

/* --------------------------------------------------------------- workflow */

export const ROTULO_PASSO: Record<string, string> = {
  pending: 'aguardando',
  running: 'rodando',
  completed: 'concluído',
  failed: 'falhou',
  skipped: 'pulado',
  blocked: 'aguardando você',
  timeout: 'tempo esgotado',
};

export const ROTULO_EXECUCAO: Record<WorkflowRunSummary['state'], string> = {
  running: 'em andamento',
  completed: 'concluído',
  failed: 'com falhas',
  interrupted: 'interrompido',
};

/** "3/5 concluídos · 1 falhou · 1 rodando" — o resumo de uma linha da execução. */
export function resumoDaExecucao(run: WorkflowRunSummary): string {
  const conta = new Map<string, number>();
  for (const s of run.steps) conta.set(s.state, (conta.get(s.state) ?? 0) + 1);
  const partes = [`${conta.get('completed') ?? 0}/${run.steps.length} concluídos`];
  for (const estado of ['running', 'blocked', 'failed', 'skipped', 'timeout', 'pending'] as const) {
    const n = conta.get(estado);
    if (n) partes.push(`${n} ${ROTULO_PASSO[estado]}`);
  }
  return partes.join(' · ');
}

/** Execução em curso precisa de nova consulta; terminada, não. */
export function execucaoEmCurso(run: WorkflowRunSummary | null): boolean {
  return run !== null && run.state === 'running';
}

/** Orçamento opcional do workflow: vazio = sem teto global. */
export function lerOrcamentoWorkflow(
  texto: string,
): { ok: true; usd?: number } | { ok: false; erro: string } {
  const n = numero(texto);
  if (n === null) return { ok: true };
  if (Number.isNaN(n) || n <= 0)
    return {
      ok: false,
      erro: 'Orçamento do workflow: informe dólares maiores que zero, ou deixe vazio.',
    };
  return { ok: true, usd: n };
}

/* ------------------------------------------------------------ diagnóstico */

export type NivelDiagnostico = 'ok' | 'aviso' | 'erro';

export interface DiagnosticoAgente {
  nivel: NivelDiagnostico;
  /** Frase curta do estado: "instalado 1.2.3", "não encontrado"... */
  estado: string;
  /** O que mais se sabe dele, em linhas curtas. */
  notas: string[];
}

/**
 * O que o `/agents` diz de cada agente, lido para quem opera: instalado ou
 * não (e por quê), contra que versão o manifesto foi conferido, se aceita
 * escolher modelo, e como fazer login. Não inventa estado de autenticação —
 * o daemon não o mede; mostra a dica de login que o manifesto declara.
 */
export function diagnosticarAgente(a: AgentSummary): DiagnosticoAgente {
  const notas: string[] = [];
  const probe = a.probe;
  let nivel: NivelDiagnostico;
  let estado: string;

  if (!probe) {
    nivel = 'aviso';
    estado = 'ainda não sondado';
  } else if (!probe.installed) {
    nivel = 'erro';
    estado = 'não encontrado';
    if (probe.error) notas.push(probe.error);
  } else {
    nivel = 'ok';
    estado = probe.version ? `instalado ${probe.version}` : 'instalado';
    if (probe.binPath) notas.push(probe.binPath);
  }

  const v = a.verified;
  if (v) {
    if (v.status === 'verified')
      notas.push(`manifesto conferido${v.version ? ` com a versão ${v.version}` : ''}`);
    else if (v.status === 'partial')
      notas.push(`manifesto conferido em parte${v.version ? ` (${v.version})` : ''}`);
    else notas.push('manifesto não conferido contra o binário');
    if (
      nivel === 'ok' &&
      v.version &&
      probe?.version &&
      v.status !== 'unverified' &&
      !probe.version.includes(v.version) &&
      !v.version.includes(probe.version)
    ) {
      nivel = 'aviso';
      notas.push(`versão instalada (${probe.version}) difere da conferida (${v.version})`);
    }
  }

  if (a.model)
    notas.push(
      a.model.supported ? 'aceita escolher modelo por sessão' : 'não aceita escolher modelo pelo Hub',
    );
  if (a.loginHint) notas.push(`login: ${a.loginHint}`);
  return { nivel, estado, notas };
}
