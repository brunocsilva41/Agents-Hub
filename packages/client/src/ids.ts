/**
 * Formato dos ids do Hub, validado no cliente ANTES de a requisição sair.
 *
 * O cliente monta URLs com os ids no caminho (`/sessions/:id/cancel`). Sem
 * validação, um id vindo de fora — argumento de tool MCP, argumento de CLI —
 * virava caminho: `cancel('../shutdown#')` resolvia para `POST /shutdown` e
 * derrubava o daemon, e a tool ainda respondia sucesso. Codificar o segmento
 * (`encodeURIComponent`) fecha o traversal; recusar o formato errado aqui fecha
 * a porta antes mesmo de existir requisição.
 *
 * Os ids são gerados por `newId` do core: `<prefixo>_<24 hex>`. O padrão aceita
 * alfanumérico de qualquer tamanho razoável depois do prefixo (ids de teste e
 * fixtures usam `ses_naoexiste`), mais uma exceção histórica: a migração 2 do
 * store criou as pastas principais como `pfd_` + id do projeto (`pfd_prj_...`).
 *
 * Mora aqui, e não no core, porque a Web UI empacota o cliente e o core puxa
 * `node:crypto` em runtime.
 */
export type HubIdPrefix = 'ses' | 'tsk' | 'apv' | 'prj' | 'pfd' | 'wfr';

const PADROES: Record<HubIdPrefix, RegExp> = {
  ses: /^ses_[a-z0-9]{1,60}$/i,
  tsk: /^tsk_[a-z0-9]{1,60}$/i,
  apv: /^apv_[a-z0-9]{1,60}$/i,
  prj: /^prj_[a-z0-9]{1,60}$/i,
  pfd: /^pfd_(?:prj_)?[a-z0-9]{1,56}$/i,
  /** Execução de workflow disparada pela API (registro em memória do daemon). */
  wfr: /^wfr_[a-z0-9]{1,60}$/i,
};

const NOMES: Record<HubIdPrefix, string> = {
  ses: 'sessão',
  tsk: 'task',
  apv: 'aprovação',
  prj: 'projeto',
  pfd: 'pasta',
  wfr: 'execução de workflow',
};

/** O padrão em si, para quem precisa declará-lo num schema (zod do MCP). */
export function hubIdPattern(prefixo: HubIdPrefix): RegExp {
  return PADROES[prefixo];
}

export function isHubId(valor: unknown, prefixo: HubIdPrefix): valor is string {
  return typeof valor === 'string' && PADROES[prefixo].test(valor);
}

/** Erro de id malformado — lançado sem nenhuma requisição ter saído. */
export class InvalidHubIdError extends Error {
  readonly code = 'INVALID_ID';
  readonly prefixo: HubIdPrefix;
  readonly valor: unknown;

  constructor(valor: unknown, prefixo: HubIdPrefix) {
    const mostrado = typeof valor === 'string' ? JSON.stringify(valor.slice(0, 80)) : typeof valor;
    super(
      `id de ${NOMES[prefixo]} inválido: ${mostrado} — esperado "${prefixo}_" seguido de letras e números`,
    );
    this.name = 'InvalidHubIdError';
    this.prefixo = prefixo;
    this.valor = valor;
  }
}

export function assertHubId(valor: unknown, prefixo: HubIdPrefix): string {
  if (!isHubId(valor, prefixo)) throw new InvalidHubIdError(valor, prefixo);
  return valor;
}

/**
 * Segmento de caminho pronto para a URL: valida o formato e codifica. Com o
 * formato válido a codificação não muda nada — ela está aí para que um relaxo
 * futuro do padrão não reabra o traversal.
 */
export function idSegment(valor: unknown, prefixo: HubIdPrefix): string {
  return encodeURIComponent(assertHubId(valor, prefixo));
}
