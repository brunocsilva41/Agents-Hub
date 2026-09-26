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

// ------------------------------------------------ o que cada agente LÊ de fato

/**
 * Papel de uma variável no "modelo local": para onde apontar, com que chave, e
 * qual modelo pedir.
 */
export type PapelDeVariavel = 'baseUrl' | 'apiKey' | 'model';

export interface VariavelDeAgente {
  nome: string;
  papel: PapelDeVariavel;
}

/**
 * Variáveis de ambiente que cada CLI comprovadamente lê — fonte única para a
 * importação (`daemon/absorption.ts`) e para o painel ("Modelos locais").
 *
 * A lista de permissão acima diz o que PODE passar; esta tabela diz o que TEM
 * EFEITO. A diferença importa: oferecer `OPENAI_BASE_URL` para o Claude, ou um
 * campo `MODEL` que nenhum adapter consome, é controle fantasma — o usuário
 * acha que configurou e nada muda (vistoria 2026-09-25, relatórios 03 e 10).
 * Agente fora da tabela (copilot, cursor, mimo) não lê nenhuma variável que a
 * lista de permissão aceite: o painel não oferece campo para ele.
 *
 * Só entra aqui o que tem evidência (variável documentada pelo CLI ou lida pela
 * descoberta em `adapters/src/discovery/*`). Na dúvida fica de fora: melhor não
 * oferecer o campo do que oferecer um que não faz nada.
 */
const VARIAVEIS_LIDAS_POR_AGENTE: Readonly<Record<string, readonly VariavelDeAgente[]>> = {
  claude: [
    { nome: 'ANTHROPIC_BASE_URL', papel: 'baseUrl' },
    { nome: 'ANTHROPIC_API_KEY', papel: 'apiKey' },
    { nome: 'ANTHROPIC_MODEL', papel: 'model' },
  ],
  // Fork do Claude Code: lê as mesmas. O modo OpenAI dele depende de
  // `CLAUDE_CODE_USE_OPENAI`, que a lista de permissão não deixa passar —
  // oferecer `OPENAI_*` aqui seria de novo um campo sem efeito.
  openclaude: [
    { nome: 'ANTHROPIC_BASE_URL', papel: 'baseUrl' },
    { nome: 'ANTHROPIC_API_KEY', papel: 'apiKey' },
    { nome: 'ANTHROPIC_MODEL', papel: 'model' },
  ],
  antigravity: [
    { nome: 'GOOGLE_GEMINI_BASE_URL', papel: 'baseUrl' },
    { nome: 'GEMINI_API_KEY', papel: 'apiKey' },
    { nome: 'GEMINI_MODEL', papel: 'model' },
  ],
  // Codex e OpenCode escolhem o modelo pela própria config/flag, não por
  // variável de ambiente: sem campo de modelo.
  codex: [
    { nome: 'OPENAI_BASE_URL', papel: 'baseUrl' },
    { nome: 'OPENAI_API_KEY', papel: 'apiKey' },
  ],
  opencode: [
    { nome: 'OPENAI_BASE_URL', papel: 'baseUrl' },
    { nome: 'OPENAI_API_KEY', papel: 'apiKey' },
  ],
  kimi: [{ nome: 'MOONSHOT_API_KEY', papel: 'apiKey' }],
};

/** Variáveis que o agente lê (vazia = nenhuma que o projeto possa definir). */
export function variaveisLidasPeloAgente(agentId: string): readonly VariavelDeAgente[] {
  return VARIAVEIS_LIDAS_POR_AGENTE[agentId] ?? [];
}

/** Nome da variável com esse papel para o agente, ou `null` se ele não lê nenhuma. */
export function variavelDoAgente(agentId: string, papel: PapelDeVariavel): string | null {
  return variaveisLidasPeloAgente(agentId).find((v) => v.papel === papel)?.nome ?? null;
}
