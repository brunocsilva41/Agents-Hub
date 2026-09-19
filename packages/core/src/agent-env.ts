/**
 * Variáveis de ambiente que um projeto pode passar ao agente.
 *
 * É o mecanismo que torna "modelo local" real: cada CLI descobre o provedor
 * pelo ambiente (`OPENAI_BASE_URL` apontando para o Ollama, por exemplo), então
 * um bloco de ambiente por agente atende todos eles sem adaptação individual.
 *
 * # Por que lista de permissão, e não de bloqueio
 *
 * `.agents-hub/config.yaml` é versionado junto do código. Quem clona um
 * repositório herda o arquivo — e é exatamente isso que o torna útil, e
 * exatamente isso que o torna perigoso.
 *
 * Um `NODE_OPTIONS=--require ./payload.js` nesse arquivo viraria execução
 * arbitrária na máquina de quem clonou, no instante em que o Hub lançasse
 * qualquer agente Node. `PATH` trocaria o binário do agente por outro.
 * `PYTHONSTARTUP`, `LD_PRELOAD`, `BROWSER`, `EDITOR` e `GIT_SSH_COMMAND` têm
 * variações do mesmo efeito.
 *
 * Uma lista de bloqueio precisaria acertar todas essas — e todas as que
 * aparecerem depois, em runtimes que ainda nem usamos. A lista de permissão
 * erra para o lado seguro: variável nova simplesmente não passa até alguém
 * decidir que deve passar.
 *
 * # `*_BASE_URL` é permitido de propósito, e isso É um vetor
 *
 * Diferente de `NODE_OPTIONS`/`PATH`/etc., que dão execução arbitrária,
 * `OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL`/`AZURE_OPENAI_BASE_URL`/etc. dão
 * **sequestro do canal de API inteiro**: um `.agents-hub/config.yaml`
 * malicioso num repositório clonado pode apontar o CLI do agente para um
 * endpoint controlado pelo atacante. Como o CLI já está autenticado
 * localmente (é assim que o Hub evita cofre de credencial — ver
 * `SECURITY.md`), o request sai com a credencial nativa do usuário embutida,
 * mas para o host errado; o atacante recebe a chave/token de sessão, e ainda
 * pode devolver saída de modelo forjada para o agente continuar operando
 * como se nada tivesse mudado. É deliberadamente permitido porque é o
 * mecanismo real de "modelo local" (apontar para Ollama/vLLM na própria
 * máquina) — a lista de permissão não filtra por *valor* de URL, só por
 * *nome* de variável, então não há como distinguir aqui um Ollama legítimo de
 * um endpoint hostil. Quem clona um repositório com `.agents-hub/config.yaml`
 * de terceiro deveria revisar esse arquivo como revisaria qualquer outro
 * script do repositório antes de rodar uma sessão do Hub nele.
 */

/**
 * Prefixos aceitos. Todos configuram provedor ou modelo, nada mais.
 *
 * `AGENTS_HUB_` fica de fora de propósito: é o namespace que o próprio Hub usa
 * para dizer ao agente em que sessão ele está, e deixar o projeto sobrescrever
 * isso permitiria a um repositório se passar por outra sessão no gate.
 */
const PREFIXOS_PERMITIDOS = [
  'OPENAI_',
  'ANTHROPIC_',
  'AZURE_OPENAI_',
  'OLLAMA_',
  'GOOGLE_',
  'GEMINI_',
  'MISTRAL_',
  'GROQ_',
  'TOGETHER_',
  'OPENROUTER_',
  'DEEPSEEK_',
  'MOONSHOT_',
  'LMSTUDIO_',
  'VLLM_',
] as const;

/** Nomes exatos permitidos que não casam com nenhum prefixo. */
const NOMES_PERMITIDOS = new Set(['MODEL', 'MODEL_BASE_URL']);

export interface EnvFiltrado {
  aceitas: Record<string, string>;
  /** Nomes recusados, para o operador saber que foram ignorados. */
  recusadas: string[];
}

/**
 * Filtra o bloco de ambiente vindo do projeto.
 *
 * Recusa é reportada, nunca silenciosa: quem escreveu `PATH` no config precisa
 * descobrir que ele não teve efeito ali, e não depois de horas achando que a
 * configuração estava valendo.
 */
export function filtrarEnvDeProjeto(bruto: Record<string, unknown>): EnvFiltrado {
  const aceitas: Record<string, string> = {};
  const recusadas: string[] = [];

  for (const [nome, valor] of Object.entries(bruto)) {
    if (typeof valor !== 'string') {
      recusadas.push(nome);
      continue;
    }

    const chave = nome.trim();
    const permitida =
      NOMES_PERMITIDOS.has(chave) ||
      PREFIXOS_PERMITIDOS.some((prefixo) => chave.startsWith(prefixo));

    if (permitida) aceitas[chave] = valor;
    else recusadas.push(chave);
  }

  return { aceitas, recusadas };
}

/** Os nomes que um projeto pode definir, para a interface explicar a regra. */
export function prefixosDeEnvPermitidos(): readonly string[] {
  return PREFIXOS_PERMITIDOS;
}
