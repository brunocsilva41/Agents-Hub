import type {
  AuditEntrySummary,
  AuditKindSummary,
  AuditQuery,
  HookStatusSummary,
  McpStatusSummary,
  RepoConfigStatusDto,
} from '@agents-hub/client';

/*
 * Lógica pura da área "Segurança" do painel (item 6.12 do GOAL, parte B):
 * editor de política, trilha de auditoria, histórico de aprovações, confiança
 * do projeto e integrações (hook/MCP). Sem React, sem `window` — testada em
 * `security.test.ts`. Os componentes só despacham e desenham.
 */

// ------------------------------------------------ editor de política

export type AnaliseDaCamada =
  { ok: true; camada: Record<string, unknown> } | { ok: false; erro: string };

/**
 * O texto do editor vira camada? Só a forma é conferida aqui (JSON, objeto na
 * raiz). O SCHEMA é do daemon: a prévia (`?dryRun=1`) valida com o mesmo Zod
 * que decide e aponta o campo — uma cópia das regras no navegador
 * divergiria no primeiro campo novo.
 */
export function analisarCamada(texto: string): AnaliseDaCamada {
  const limpo = texto.trim();
  if (limpo === '') return { ok: true, camada: {} };
  let valor: unknown;
  try {
    valor = JSON.parse(limpo);
  } catch (err) {
    return { ok: false, erro: `JSON inválido: ${(err as Error).message}` };
  }
  if (valor === null || typeof valor !== 'object' || Array.isArray(valor)) {
    return { ok: false, erro: 'a camada precisa ser um objeto JSON ({ ... }) na raiz' };
  }
  return { ok: true, camada: valor as Record<string, unknown> };
}

export function textoDaCamada(camada: Record<string, unknown>): string {
  return Object.keys(camada).length === 0 ? '{}' : JSON.stringify(camada, null, 2);
}

/** Resultado da prévia (ou da gravação) de uma camada, pronto para exibir. */
export interface AvisosDePolitica {
  /** Camada global mais permissiva que a atual — aviso VERMELHO. */
  afrouxa: string[];
  /** Camada de projeto que tenta afrouxar a global: gravada, mas sem efeito aqui. */
  semEfeito: string[];
  /** Campos que executam processo, ignorados por o projeto não ser confiável. */
  execIgnorados: string[];
}

export function avisosDePolitica(r: {
  loosened?: string[];
  clamped?: string[];
  ignoredExecFields?: string[];
}): AvisosDePolitica {
  const execIgnorados = [...(r.ignoredExecFields ?? [])];
  return {
    afrouxa: [...(r.loosened ?? [])],
    // Campo de execução ignorado também aparece no `clamped` (o merge travado
    // difere do livre): listar nos dois lugares seria o mesmo aviso duas vezes.
    semEfeito: (r.clamped ?? []).filter((c) => !execIgnorados.includes(c)),
    execIgnorados,
  };
}

export function temAvisos(a: AvisosDePolitica): boolean {
  return a.afrouxa.length + a.semEfeito.length + a.execIgnorados.length > 0;
}

// ------------------------------------------------ trilha de auditoria

export const TIPOS_DE_AUDITORIA: ReadonlyArray<{ id: AuditKindSummary; rotulo: string }> = [
  { id: 'gate.decision', rotulo: 'decisão do gate' },
  { id: 'approval.requested', rotulo: 'aprovação pedida' },
  { id: 'approval.resolved', rotulo: 'aprovação resolvida' },
  { id: 'policy.updated', rotulo: 'política alterada' },
  { id: 'project.trust', rotulo: 'confiança do projeto' },
  { id: 'project.context', rotulo: 'contexto do projeto' },
  { id: 'project.import', rotulo: 'importação' },
  { id: 'project.folders', rotulo: 'pastas do projeto' },
  { id: 'integration.install', rotulo: 'hook/MCP instalado' },
  { id: 'maintenance.sweep', rotulo: 'limpeza' },
  { id: 'daemon.shutdown', rotulo: 'daemon encerrado' },
];

export function rotuloDoTipo(kind: string): string {
  return TIPOS_DE_AUDITORIA.find((t) => t.id === kind)?.rotulo ?? kind;
}

/** Janelas de tempo no formato relativo que o daemon aceita (`since=24h`). */
export const PERIODOS: ReadonlyArray<{ id: string; rotulo: string }> = [
  { id: '1h', rotulo: 'última hora' },
  { id: '24h', rotulo: 'últimas 24 h' },
  { id: '7d', rotulo: 'últimos 7 dias' },
  { id: '30d', rotulo: 'últimos 30 dias' },
  { id: '', rotulo: 'todo o período' },
];

export interface FiltrosDeAuditoria {
  sessionId: string;
  projectId: string;
  kind: string;
  periodo: string;
  limite: number;
}

export const FILTROS_PADRAO: FiltrosDeAuditoria = {
  sessionId: '',
  projectId: '',
  kind: '',
  periodo: '24h',
  limite: 200,
};

/**
 * Filtros da tela -> consulta do cliente. Campo vazio não vai (o daemon
 * trataria `sessionId=` como id inválido). Sessão digitada à mão só vai se
 * tiver a forma de id — o cliente recusaria de qualquer jeito, e a tela avisa.
 */
export function consultaDeAuditoria(f: FiltrosDeAuditoria): AuditQuery {
  const q: AuditQuery = { limit: f.limite };
  const sessao = f.sessionId.trim();
  if (sessao !== '') q.sessionId = sessao;
  if (f.projectId !== '') q.projectId = f.projectId;
  if (f.kind !== '') q.kind = f.kind as AuditKindSummary;
  if (f.periodo !== '') q.since = f.periodo;
  return q;
}

export function sessaoDoFiltroValida(sessionId: string): boolean {
  const s = sessionId.trim();
  return s === '' || /^ses_[a-z0-9]{1,60}$/i.test(s);
}

/** Tom visual de uma decisão: o que liberou em verde, o que negou em vermelho. */
export function tomDaDecisao(decision: string | null): 'ok' | 'nega' | 'pede' | 'neutro' {
  if (decision === null) return 'neutro';
  if (['allow', 'approved', 'trusted', 'written', 'updated'].includes(decision)) return 'ok';
  if (['deny', 'denied', 'expired', 'untrusted'].includes(decision)) return 'nega';
  if (['approve', 'ask', 'loosened'].includes(decision)) return 'pede';
  return 'neutro';
}

// ------------------------------------------------ histórico de aprovações

export interface ItemDoHistorico {
  approvalId: string;
  sessionId: string | null;
  action: string;
  risk: string | null;
  pedidoEm: string | null;
  /** Quem pediu: `gate` (pré-execução) ou `policy` (vigilância/delegação). */
  pedidoPor: string | null;
  resolvidoEm: string | null;
  decisao: string | null;
  /** `web`, `cli:<usuário>`, `tempo esgotado`... — vem da origem autenticada. */
  por: string | null;
}

/**
 * Junta pedido e resolução de cada aprovação (duas linhas na auditoria) numa
 * linha só, mais recente primeiro. Pendentes (sem resolução) aparecem também:
 * "pedido há 3 min, ninguém respondeu" é parte da história.
 */
export function historicoDeAprovacoes(entradas: readonly AuditEntrySummary[]): ItemDoHistorico[] {
  const porId = new Map<string, ItemDoHistorico>();
  for (const e of entradas) {
    if (e.kind !== 'approval.requested' && e.kind !== 'approval.resolved') continue;
    if (!e.approvalId) continue;
    const item =
      porId.get(e.approvalId) ??
      ({
        approvalId: e.approvalId,
        sessionId: e.sessionId,
        action: e.action,
        risk: null,
        pedidoEm: null,
        pedidoPor: null,
        resolvidoEm: null,
        decisao: null,
        por: null,
      } satisfies ItemDoHistorico);
    if (e.kind === 'approval.requested') {
      item.pedidoEm = e.ts;
      item.pedidoPor = e.actor;
      item.risk = e.risk;
      item.action = e.action;
    } else {
      item.resolvidoEm = e.ts;
      item.decisao = e.decision;
      item.por = e.actor;
    }
    item.sessionId = item.sessionId ?? e.sessionId;
    porId.set(e.approvalId, item);
  }
  const quando = (i: ItemDoHistorico): string => i.resolvidoEm ?? i.pedidoEm ?? '';
  return [...porId.values()].sort((a, b) => quando(b).localeCompare(quando(a)));
}

export const DECISAO_LABEL: Record<string, string> = {
  approved: 'aprovada',
  denied: 'negada',
  expired: 'expirada',
};

// ------------------------------------------------ confiança do projeto

export interface ResumoDaConfianca {
  estado: RepoConfigStatusDto['trust'];
  rotulo: string;
  tom: 'ok' | 'alerta' | 'neutro';
  explicacao: string;
  /** O que o repositório quer mudar, agrupado. */
  execucao: string[];
  rede: string[];
  ambiente: string[];
  instrucoes: string[];
  /** Nada sensível declarado: confiar não muda nada. */
  vazio: boolean;
}

/**
 * Classifica os campos sensíveis que o daemon listou (`sensitiveFields`, já
 * legíveis: `validation.command = npm test`, `env.claude.ANTHROPIC_BASE_URL =
 * http://...`) no que eles fazem: rodam processo, mudam para onde vai a
 * credencial, mudam o ambiente do agente ou mudam o que se diz a ele.
 */
export function resumoDaConfianca(repo: RepoConfigStatusDto): ResumoDaConfianca {
  const execucao: string[] = [];
  const rede: string[] = [];
  const ambiente: string[] = [];
  const instrucoes: string[] = [];
  for (const campo of repo.sensitiveFields) {
    if (campo.startsWith('validation.')) execucao.push(campo);
    else if (campo.startsWith('env.')) {
      const nome = campo.split(' = ')[0]!;
      if (/URL|BASE|ENDPOINT|HOST/i.test(nome) && !/KEY|TOKEN|SECRET/i.test(nome)) rede.push(campo);
      else ambiente.push(campo);
    } else instrucoes.push(campo);
  }
  const vazio = repo.sensitiveFields.length === 0;
  const base = { execucao, rede, ambiente, instrucoes, vazio, estado: repo.trust };
  if (repo.trust === 'trusted') {
    return {
      ...base,
      rotulo: 'confiável',
      tom: 'ok',
      explicacao:
        'O conteúdo sensível do config.yaml do repositório é o mesmo que você confiou e está valendo.',
    };
  }
  if (repo.trust === 'suspended') {
    return {
      ...base,
      rotulo: 'confiança suspensa',
      tom: 'alerta',
      explicacao:
        'O config.yaml MUDOU depois que você confiou. Os campos abaixo estão IGNORADOS até você revisar e confiar de novo.',
    };
  }
  return {
    ...base,
    rotulo: 'não confiável',
    tom: vazio ? 'neutro' : 'alerta',
    explicacao: vazio
      ? 'O repositório não declara nada sensível: não há o que confiar.'
      : 'Os campos abaixo, vindos do repositório, estão IGNORADOS. Confie só se você revisou o arquivo.',
  };
}

// ------------------------------------------------ integrações (hook/MCP)

export interface RotuloDeEstado {
  texto: string;
  tom: 'ok' | 'alerta' | 'neutro' | 'erro';
}

export function estadoDoHook(h: HookStatusSummary): RotuloDeEstado {
  if (h.erro) return { texto: 'config ilegível', tom: 'erro' };
  if (h.modo === 'nenhum') return { texto: 'só vigilância', tom: 'neutro' };
  // Sem o hook no arquivo, as sessões do HUB continuam gateadas (hook por
  // sessão via --settings); só as abertas fora do Hub ficam sem.
  if (!h.instalado && h.sessoesDoHubGateadas === true) {
    return { texto: 'gate ativo nas sessões do Hub', tom: 'ok' };
  }
  if (!h.instalado) return { texto: 'gate desligado', tom: 'alerta' };
  if (h.avisoTimeout) return { texto: 'timeout antigo', tom: 'alerta' };
  return { texto: 'gate ativo', tom: 'ok' };
}

export function estadoDoMcp(m: McpStatusSummary): RotuloDeEstado {
  if (m.erro) return { texto: 'config ilegível', tom: 'erro' };
  if (m.precisaDeProjeto) return { texto: 'escolha o projeto', tom: 'neutro' };
  if (!m.registrado) return { texto: 'não registrado', tom: 'neutro' };
  if (!m.atualizado) return { texto: 'desatualizado', tom: 'alerta' };
  return { texto: 'registrado', tom: 'ok' };
}

// ------------------------------------------------ edição não salva

/**
 * Há edição não salva em alguma área? `App` guarda um sinal por área
 * (Configurações, editor de política) e pergunta antes de trocar de aba —
 * trocar desmonta a área e a edição se perdia sem aviso (vistoria 03).
 */
export function haEdicaoNaoSalva(sujos: Readonly<Record<string, boolean>>): boolean {
  return Object.values(sujos).some(Boolean);
}

/** Pode sair da aba atual para `destino`? Pergunta só se há o que perder. */
export function podeTrocarDeAba(
  atual: string,
  destino: string,
  sujos: Readonly<Record<string, boolean>>,
  confirmar: () => boolean,
): boolean {
  if (atual === destino) return true;
  if (!haEdicaoNaoSalva(sujos)) return true;
  return confirmar();
}

// ------------------------------------------------ projeto corrente

/**
 * Projeto que a aba Segurança mostra para o filtro de projeto do painel (o
 * mesmo da Timeline, do DAG e da Telemetria; `'all'` = todos). Antes a aba
 * escolhia `projects[0]` por conta própria e ignorava o filtro: quem filtrava
 * o projeto B e abria Segurança editava a política do projeto A. Filtro em
 * "todos" (ou num projeto que sumiu) cai no primeiro projeto, como antes; sem
 * projeto carregado, só a camada global — e a aba segue quando a lista chega.
 */
export function projetoDaSeguranca(filtro: string, projetos: ReadonlyArray<{ id: string }>): string {
  if (filtro !== 'all' && projetos.some((p) => p.id === filtro)) return filtro;
  return projetos[0]?.id ?? '';
}

/**
 * A aba segue o projeto corrente (`alvo`)? Com edição não salva na política,
 * trocar de projeto descartaria o texto: pergunta antes, como a troca de aba
 * (`podeTrocarDeAba`), e "não" mantém o projeto da edição.
 */
export function seguirProjetoCorrente(o: {
  atual: string;
  alvo: string;
  sujo: boolean;
  confirmar: () => boolean;
}): string {
  if (o.alvo === o.atual) return o.atual;
  if (o.sujo && !o.confirmar()) return o.atual;
  return o.alvo;
}
