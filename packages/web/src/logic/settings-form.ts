import type { AgentSummary, ProjectContextDto } from '@agents-hub/client';
import {
  filtrarEnvDeProjeto,
  variaveisLidasPeloAgente,
  type PapelDeVariavel,
} from '@agents-hub/core/agent-env';

/*
 * Lógica pura da tela de Configurações — sem React, sem `window`, para ter
 * teste (`settings-form.test.ts`). O componente só despacha ações e desenha.
 */

// ------------------------------------------------ estado do formulário

/**
 * `pronto` é o ÚNICO estado em que editar e salvar fazem sentido: o `ctx` na
 * tela é, comprovadamente, o do projeto selecionado.
 */
export type StatusCarga = 'sem-projeto' | 'carregando' | 'pronto' | 'falhou';

export interface EstadoForm {
  projectId: string;
  status: StatusCarga;
  ctx: ProjectContextDto;
  sujo: boolean;
  erroCarga: string | null;
}

export type AcaoForm =
  | { tipo: 'trocar-projeto'; projectId: string }
  | { tipo: 'carregou'; projectId: string; ctx: ProjectContextDto }
  | { tipo: 'falhou'; projectId: string; erro: string }
  | { tipo: 'editar'; mudar: (ctx: ProjectContextDto) => ProjectContextDto }
  | { tipo: 'salvou'; projectId: string; ctx: ProjectContextDto };

export function estadoInicial(projectId: string): EstadoForm {
  return {
    projectId,
    status: projectId === '' ? 'sem-projeto' : 'carregando',
    ctx: {},
    sujo: false,
    erroCarga: null,
  };
}

/**
 * Transições do formulário.
 *
 * O bug que isto fecha (vistoria 2026-09-25, relatório 03, ALTO): trocar para
 * um projeto cujo contexto falha ao carregar deixava o `ctx` do projeto
 * ANTERIOR na tela, editável — e "Salvar" gravava prompts, memória e env
 * (inclusive chaves) do projeto A no `config.yaml` do projeto B. Agora:
 *
 * - trocar de projeto zera o `ctx` na hora, antes de qualquer resposta;
 * - resposta de outro projeto (chegou atrasada) é ignorada;
 * - falha de carga deixa o formulário vazio e travado (`falhou`), com o erro;
 * - editar fora de `pronto` não tem efeito.
 */
export function reduzirForm(estado: EstadoForm, acao: AcaoForm): EstadoForm {
  switch (acao.tipo) {
    case 'trocar-projeto':
      return estadoInicial(acao.projectId);
    case 'carregou':
      if (acao.projectId !== estado.projectId) return estado;
      return { ...estado, status: 'pronto', ctx: acao.ctx, sujo: false, erroCarga: null };
    case 'falhou':
      if (acao.projectId !== estado.projectId) return estado;
      return { ...estado, status: 'falhou', ctx: {}, sujo: false, erroCarga: acao.erro };
    case 'editar':
      if (estado.status !== 'pronto') return estado;
      return { ...estado, ctx: acao.mudar(estado.ctx), sujo: true };
    case 'salvou':
      if (acao.projectId !== estado.projectId || estado.status !== 'pronto') return estado;
      return { ...estado, ctx: acao.ctx, sujo: false };
  }
}

export function podeEditar(estado: EstadoForm): boolean {
  return estado.status === 'pronto';
}

export function podeSalvar(estado: EstadoForm): boolean {
  return estado.status === 'pronto' && estado.sujo;
}

// ------------------------------------------------ campos de env por agente

export interface CampoDeEnv {
  nome: string;
  papel: PapelDeVariavel;
  rotulo: string;
  /** Valor é credencial: campo mascarado, com aviso de versionamento. */
  secreto: boolean;
  /** Formato esperado (vem do manifesto, para o campo de modelo). */
  formato?: string;
  /** O valor chega ao CLI como flag (`--model x`), não como variável lida por ele. */
  viaFlag?: boolean;
}

const ROTULO: Record<PapelDeVariavel, string> = {
  baseUrl: 'Endereço da API',
  apiKey: 'Chave',
  model: 'Modelo',
};

/** O que o painel precisa saber do agente para o campo de modelo. */
export type ModeloDoAgente = Partial<Pick<AgentSummary, 'model'>>;

/**
 * Os campos fixos de "Modelos locais" para um agente: só as variáveis que ele
 * de fato lê (tabela em `core/agent-env.ts`).
 *
 * Antes a tela oferecia `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`MODEL` a TODOS os
 * agentes — inclusive ao Claude, que não lê `OPENAI_*`, e com um `MODEL` que
 * nenhum adapter consumia. Controle fantasma: o usuário configurava e nada
 * mudava (vistoria 2026-09-25, relatórios 03 e 10).
 *
 * Modelo (item 4.3): o `/agents` diz por agente se o CLI aceita modelo por
 * invocação (`model.supported`, flag conferida no `--help`). Quando aceita, o
 * campo "Modelo" grava `MODEL` no env do projeto para o agente, que o adapter
 * lê e transforma na flag do manifesto (`modeloDaRun`). Quando NÃO aceita, não
 * há campo de modelo nenhum — nem o da variável própria do CLI: o controle só
 * aparece onde o valor chega ao agente. Sem o resumo do agente (lista ainda
 * carregando), cai na tabela de variáveis, como antes.
 */
export function camposDeEnvDoAgente(agentId: string, agente?: ModeloDoAgente): CampoDeEnv[] {
  // `model` ausente = daemon anterior ao item 4.3: comportamento antigo.
  const conhece = agente?.model !== undefined;
  const doAmbiente = variaveisLidasPeloAgente(agentId)
    .filter((v) => !conhece || v.papel !== 'model')
    .map((v) => ({
      nome: v.nome,
      papel: v.papel,
      rotulo: ROTULO[v.papel],
      secreto: v.papel === 'apiKey',
    }));
  if (agente?.model?.supported !== true) return doAmbiente;
  return [
    ...doAmbiente,
    {
      nome: 'MODEL',
      papel: 'model',
      rotulo: ROTULO.model,
      secreto: false,
      viaFlag: true,
      ...(agente.model.format ? { formato: agente.model.format } : {}),
    },
  ];
}

/** Variáveis do agente que não são campos fixos — listadas à parte. */
export function extrasDoAgente(
  envDoAgente: Record<string, string>,
  agentId: string,
  agente?: ModeloDoAgente,
): Array<[string, string]> {
  const fixos = new Set(camposDeEnvDoAgente(agentId, agente).map((c) => c.nome));
  return Object.entries(envDoAgente).filter(([chave]) => !fixos.has(chave));
}

/**
 * O daemon aceitaria esta variável? Mesma função que ele usa
 * (`filtrarEnvDeProjeto`), importada pelo subcaminho `@agents-hub/core/agent-env`
 * — que não arrasta `node:*` para o bundle do navegador. Substitui a cópia da
 * lista de prefixos que existia na tela e precisava ser mantida à mão.
 */
export function chaveEhPermitida(chave: string): boolean {
  const c = chave.trim();
  if (c === '') return false;
  return filtrarEnvDeProjeto({ [c]: 'x' }).recusadas.length === 0;
}

/** `*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`: valor não aparece em claro. */
export function chaveEhSecreta(chave: string): boolean {
  return /(_KEY|_TOKEN|_SECRET|_PASSWORD)$/i.test(chave.trim());
}

export function valorParaExibir(chave: string, valor: string): string {
  if (!chaveEhSecreta(chave)) return valor;
  return valor.length <= 4 ? '••••' : `••••${valor.slice(-4)}`;
}

/**
 * A variável extra é lida pelo agente? Primeiro pela tabela; na falta dela,
 * pelo texto do manifesto (descrição e ressalvas), como antes. Só aviso — não
 * bloqueia.
 */
export function variavelConhecidaDoAgente(chave: string, agente: AgentSummary | undefined): boolean {
  if (!agente) return true;
  const c = chave.trim().toUpperCase();
  if (variaveisLidasPeloAgente(agente.id).some((v) => v.nome === c)) return true;
  const textos = [agente.description, ...agente.caveats].join(' ').toUpperCase();
  return textos.includes(c);
}

// ------------------------------------------------ primeira execução

/**
 * Mostrar as boas-vindas: o índice já carregou (sem isso, um piscar de "nenhum
 * projeto" antes da primeira resposta) e não há projeto nenhum.
 */
export function precisaDeBoasVindas(ready: boolean, totalDeProjetos: number): boolean {
  return ready && totalDeProjetos === 0;
}
