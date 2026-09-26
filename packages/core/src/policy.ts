import path from 'node:path';
import { z } from 'zod';
import type { BudgetLimits } from './budget.js';
import { type SessionMode, MODE_RANK, narrowestMode } from './domain.js';

/**
 * Níveis de risco (ADR 02.4). Toda ação de agente é classificada em um deles
 * ANTES de executar, e a política diz o que fazer com aquele nível.
 */
export type RiskLevel = 'read' | 'write' | 'exec' | 'escalate' | 'irreversible' | 'budget';

export const RISK_RANK: Record<RiskLevel, number> = {
  read: 0,
  write: 1,
  exec: 2,
  escalate: 3,
  budget: 4,
  irreversible: 5,
};

export type Decision = 'allow' | 'approve' | 'deny';

const DECISION_RANK: Record<Decision, number> = { allow: 0, approve: 1, deny: 2 };

/** A decisão mais restritiva entre duas — base da regra de não-escalação. */
export function narrowestDecision(a: Decision, b: Decision): Decision {
  return DECISION_RANK[a] >= DECISION_RANK[b] ? a : b;
}

export interface PolicyDocument {
  /** Profundidade máxima do grafo de delegação. Raiz = 0. */
  maxDepth: number;
  maxConcurrency: number;
  maxConcurrencyPerAgent: number;
  taskTimeoutSeconds: number;
  sessionTimeoutSeconds: number;
  /** Sem evento algum por este tempo, a run é considerada travada e morta. */
  heartbeatTimeoutSeconds: number;
  defaultBudget: BudgetLimits;
  risk: Record<RiskLevel, Decision>;
  commands: {
    /** Prefixos permitidos, ex.: "npm test", "git status". */
    allow: string[];
    /** Prefixos sempre negados, mesmo em modo autônomo. */
    deny: string[];
  };
  paths: {
    allowWriteOutsideWorkdir: boolean;
    /** Fragmentos de caminho sempre bloqueados para escrita. */
    denyFragments: string[];
  };
  network: {
    /** Domínios permitidos. Vazio = nega tudo que não for explicitamente liberado. */
    allowDomains: string[];
  };
  retries: {
    max: number;
    backoffMs: number;
  };
  /** Cadeia de fallback por capability, ex.: `{"code-edit": ["claude","codex"]}`. */
  fallback: Record<string, string[]>;
  watch: WatchPolicy;
  validation: ValidationPolicy;
}

/**
 * Portão de validação do resultado (ADR 04.3).
 *
 * "O agente terminou sem erro" e "o agente entregou o que foi pedido" são
 * coisas diferentes, e só a segunda importa. O portão existe para pegar
 * resultado ruim, não só execução quebrada.
 */
export interface ValidationPolicy {
  /**
   * Comando rodado no worktree da sessão quando ela termina bem.
   * Saída diferente de zero reprova e aciona a cadeia de resiliência.
   * `null` desliga — é o padrão, porque não dá para adivinhar o comando de
   * teste de um projeto qualquer.
   */
  command: string | null;
  commandTimeoutSeconds: number;
  /**
   * Revisão por um segundo agente. Desligada por padrão: custa uma sessão
   * inteira de modelo por task, o que só compensa em trabalho de alto valor.
   */
  review: {
    enabled: boolean;
    /** `null` usa o primeiro agente disponível da capability `code-review`. */
    agent: string | null;
  };
}

/**
 * Vigilância reativa sobre o que o agente JÁ fez.
 *
 * O Hub roda os agentes como processos opacos: ele não intercepta a syscall,
 * vê o evento depois que o comando executou. Chamar isso de "aprovação prévia"
 * seria mentira — é vigilância, e o que ela pode fazer é impedir a PRÓXIMA
 * ação, parando a sessão.
 *
 * Por isso o padrão pausa apenas no irreversível: um agente executa dezenas de
 * comandos legítimos que não estão em allow list nenhuma, e pausar em todos
 * transformaria o Hub em algo que ninguém usa. O resto vira evento visível na
 * timeline, sem interromper o trabalho.
 */
export interface WatchPolicy {
  /** Níveis que param a sessão e abrem uma aprovação pendente. */
  pauseOn: RiskLevel[];
  /** Níveis que só viram evento de alerta na timeline. */
  flagOn: RiskLevel[];
}

/**
 * Espelha `PolicyDocument` para validar o que vem de disco (config global e
 * config de projeto). Sem isto, um `config.json` com `port` como string ou um
 * `validation` mal formado só se manifestava como `NaN`/`undefined` silencioso
 * bem depois, longe de onde o arquivo foi lido.
 */
const RiskLevelSchema = z.enum(['read', 'write', 'exec', 'escalate', 'irreversible', 'budget']);
const DecisionSchema = z.enum(['allow', 'approve', 'deny']);

const BudgetLimitsSchema = z.object({
  usd: z.number(),
  tokens: z.number(),
  seconds: z.number(),
});

const ValidationPolicySchema = z.object({
  command: z.string().nullable(),
  commandTimeoutSeconds: z.number(),
  review: z.object({
    enabled: z.boolean(),
    agent: z.string().nullable(),
  }),
});

const WatchPolicySchema = z.object({
  pauseOn: z.array(RiskLevelSchema),
  flagOn: z.array(RiskLevelSchema),
});

export const PolicyDocumentSchema = z.object({
  maxDepth: z.number(),
  maxConcurrency: z.number(),
  maxConcurrencyPerAgent: z.number(),
  taskTimeoutSeconds: z.number(),
  sessionTimeoutSeconds: z.number(),
  heartbeatTimeoutSeconds: z.number(),
  defaultBudget: BudgetLimitsSchema,
  risk: z.record(RiskLevelSchema, DecisionSchema),
  commands: z.object({
    allow: z.array(z.string()),
    deny: z.array(z.string()),
  }),
  paths: z.object({
    allowWriteOutsideWorkdir: z.boolean(),
    denyFragments: z.array(z.string()),
  }),
  network: z.object({
    allowDomains: z.array(z.string()),
  }),
  retries: z.object({
    max: z.number(),
    backoffMs: z.number(),
  }),
  fallback: z.record(z.string(), z.array(z.string())),
  watch: WatchPolicySchema,
  validation: ValidationPolicySchema,
});

/**
 * Versão parcial, campo a campo (inclusive nos objetos aninhados), para
 * validar overrides — o que vem de `config.json`/`config.yaml` nunca precisa
 * declarar a política inteira.
 */
export const PartialPolicyDocumentSchema = PolicyDocumentSchema.deepPartial();

export type PartialPolicyDocument = z.infer<typeof PartialPolicyDocumentSchema>;

/**
 * Campos da política que, vindos de uma camada, viram PROCESSO na máquina de
 * quem roda o Hub — não são limite, são instrução de execução.
 *
 * - `validation.command`: rodado com `shell: true` no worktree ao fim de cada
 *   task, fora do gate de comandos (é o próprio Hub quem executa, não o
 *   agente). Vindo de um `.agents-hub/config.yaml` versionado, clonar um
 *   repositório malicioso bastaria para executar código arbitrário.
 * - `validation.review.enabled` / `validation.review.agent`: ligam e escolhem
 *   uma sessão inteira de agente (processo de CLI de modelo, com custo) por
 *   task.
 *
 * Sob `clampToBase` estes campos da camada são IGNORADOS, a menos que o
 * chamador declare `trustExecFields` — o que só acontece quando o usuário
 * marcou o projeto como confiável fora do repositório (registro do projeto no
 * banco do Hub). Ver `mergeProjectPolicy` no daemon.
 */
export const EXEC_POLICY_FIELDS = [
  'validation.command',
  'validation.review.enabled',
  'validation.review.agent',
] as const;

export type ExecPolicyField = (typeof EXEC_POLICY_FIELDS)[number];

/** Quais campos de execução esta camada declara (para avisar quando forem ignorados). */
export function execFieldsDeclared(layer: PartialPolicyDocument): ExecPolicyField[] {
  const declarados: ExecPolicyField[] = [];
  if (layer.validation?.command !== undefined) declarados.push('validation.command');
  if (layer.validation?.review?.enabled !== undefined) declarados.push('validation.review.enabled');
  if (layer.validation?.review?.agent !== undefined) declarados.push('validation.review.agent');
  return declarados;
}

/** Remove da camada os campos de execução — o que sobra é só limite. */
export function withoutExecFields(layer: PartialPolicyDocument): PartialPolicyDocument {
  if (layer.validation === undefined) return layer;
  const { command: _command, review, ...restoValidation } = layer.validation;
  const validation: NonNullable<PartialPolicyDocument['validation']> = { ...restoValidation };
  if (review !== undefined) {
    const { enabled: _enabled, agent: _agent, ...restoReview } = review;
    if (Object.keys(restoReview).length > 0) validation.review = restoReview;
  }
  const semValidation = { ...layer };
  delete semValidation.validation;
  return Object.keys(validation).length > 0 ? { ...semValidation, validation } : semValidation;
}

/** Teto numérico: sob clamp a camada só pode DIMINUIR. */
function menorOuBase(base: number, layer: number | undefined): number {
  return layer === undefined ? base : Math.min(base, layer);
}

/** Allow list: sob clamp só encolhe — a camada filtra, nunca acrescenta. */
function subconjunto(base: string[], layer: string[] | undefined): string[] {
  return layer === undefined ? base : layer.filter((x) => base.includes(x));
}

/** Deny list: sob clamp só cresce — a camada soma, nunca remove. */
function uniao<T>(base: T[], layer: T[] | undefined): T[] {
  return [...new Set([...base, ...(layer ?? [])])];
}

/**
 * Funde uma camada parcial de política sobre uma base, campo a campo —
 * inclusive dentro de objetos aninhados como `validation.review`.
 *
 * O bug que isto substitui: `{ ...base, ...layer }` (ou pior, só no nível de
 * `validation`) troca o objeto aninhado INTEIRO quando `layer` declara
 * qualquer campo dele. Gravar `{"validation":{"review":{"enabled":true}}}`
 * apagava `command` e `commandTimeoutSeconds` do padrão — o merge tinha que
 * descer um nível a mais do que parecia.
 *
 * `opts.clampToBase` é o comportamento de `mergeProjectPolicy`: a config de
 * projeto só pode APERTAR a política global, nunca afrouxar. Sem a opção, a
 * config global funde livre — não há "mais restritivo que o quê" no topo da
 * hierarquia.
 *
 * REGRA DE CADA CAMPO sob `clampToBase` (monotônica: o resultado nunca é mais
 * permissivo que `base`, qualquer que seja `layer`). Achado ALTO da vistoria
 * 2026-09-25: antes, orçamento, timeouts, retries e `fallback` fundiam livres,
 * e `validation.command` do repositório era aceito sempre que a global não
 * tinha um — um repo clonado conseguia AUMENTAR orçamento/timeouts/retries e
 * executar código.
 *
 * | campo                              | regra                                   |
 * |------------------------------------|-----------------------------------------|
 * | maxDepth                           | min(base, layer)                        |
 * | maxConcurrency                     | min(base, layer)                        |
 * | maxConcurrencyPerAgent             | min(base, layer)                        |
 * | taskTimeoutSeconds                 | min(base, layer)                        |
 * | sessionTimeoutSeconds              | min(base, layer)                        |
 * | heartbeatTimeoutSeconds            | min(base, layer) (morre mais cedo)      |
 * | defaultBudget.usd/tokens/seconds   | min(base, layer), cada um               |
 * | risk.<nível>                       | decisão mais restrita (narrowestDecision)|
 * | commands.allow                     | subconjunto da base (só encolhe)        |
 * | commands.deny                      | união (só cresce)                       |
 * | paths.allowWriteOutsideWorkdir     | AND lógico (só desliga)                 |
 * | paths.denyFragments                | união (só cresce)                       |
 * | network.allowDomains               | subconjunto da base (só encolhe)        |
 * | retries.max                        | min(base, layer)                        |
 * | retries.backoffMs                  | min(base, layer) — o `sleep` do backoff |
 * |                                    | não é limitado por timeout algum; um    |
 * |                                    | valor enorme congelaria a sessão, e o   |
 * |                                    | número de tentativas continua ≤ base    |
 * | fallback.<capability>              | subconjunto da cadeia da base, na ordem |
 * |                                    | da camada; capability que a base não    |
 * |                                    | tem é ignorada (não cria agente novo)   |
 * | watch.pauseOn / watch.flagOn       | união (só cresce)                       |
 * | validation.commandTimeoutSeconds   | min(base, layer)                        |
 * | validation.command                 | CAMPO DE EXECUÇÃO: ignorado; com        |
 * |                                    | `trustExecFields`, string da camada     |
 * |                                    | substitui a base (null não desliga a    |
 * |                                    | validação que a base já exige)          |
 * | validation.review.enabled          | CAMPO DE EXECUÇÃO: ignorado; com        |
 * |                                    | `trustExecFields`, base OR camada       |
 * |                                    | (projeto não desliga revisão global)    |
 * | validation.review.agent            | CAMPO DE EXECUÇÃO: ignorado; com        |
 * |                                    | `trustExecFields`, camada ?? base       |
 *
 * Um campo novo em `PolicyDocument` TEM que ganhar linha nesta tabela e regra
 * abaixo — `...base` no retorno garante só que ele não vem da camada.
 */
export function mergePolicyLayer(
  base: PolicyDocument,
  layer: PartialPolicyDocument,
  opts: { clampToBase?: boolean; trustExecFields?: boolean } = {},
): PolicyDocument {
  const clamp = opts.clampToBase ?? false;
  if (clamp) return clampLayer(base, layer, opts.trustExecFields ?? false);

  // Sem clamp (config global sobre o padrão): a camada substitui campo a campo.
  return {
    ...base,
    maxDepth: layer.maxDepth ?? base.maxDepth,
    maxConcurrency: layer.maxConcurrency ?? base.maxConcurrency,
    maxConcurrencyPerAgent: layer.maxConcurrencyPerAgent ?? base.maxConcurrencyPerAgent,
    taskTimeoutSeconds: layer.taskTimeoutSeconds ?? base.taskTimeoutSeconds,
    sessionTimeoutSeconds: layer.sessionTimeoutSeconds ?? base.sessionTimeoutSeconds,
    heartbeatTimeoutSeconds: layer.heartbeatTimeoutSeconds ?? base.heartbeatTimeoutSeconds,
    defaultBudget: { ...base.defaultBudget, ...(layer.defaultBudget ?? {}) },
    risk: { ...base.risk, ...(layer.risk ?? {}) } as Record<RiskLevel, Decision>,
    commands: {
      allow: layer.commands?.allow ?? base.commands.allow,
      deny: layer.commands?.deny ?? base.commands.deny,
    },
    paths: {
      allowWriteOutsideWorkdir:
        layer.paths?.allowWriteOutsideWorkdir ?? base.paths.allowWriteOutsideWorkdir,
      denyFragments: layer.paths?.denyFragments ?? base.paths.denyFragments,
    },
    network: {
      allowDomains: layer.network?.allowDomains ?? base.network.allowDomains,
    },
    retries: { ...base.retries, ...(layer.retries ?? {}) },
    fallback: { ...base.fallback, ...(layer.fallback ?? {}) } as Record<string, string[]>,
    watch: {
      pauseOn: (layer.watch?.pauseOn ?? base.watch.pauseOn) as RiskLevel[],
      flagOn: (layer.watch?.flagOn ?? base.watch.flagOn) as RiskLevel[],
    },
    validation: {
      command:
        layer.validation?.command !== undefined ? layer.validation.command : base.validation.command,
      commandTimeoutSeconds:
        layer.validation?.commandTimeoutSeconds ?? base.validation.commandTimeoutSeconds,
      review: {
        enabled: layer.validation?.review?.enabled ?? base.validation.review.enabled,
        agent:
          layer.validation?.review?.agent !== undefined
            ? layer.validation.review.agent
            : base.validation.review.agent,
      },
    },
  };
}

/** O ramo `clampToBase` de `mergePolicyLayer` — ver a tabela lá. */
function clampLayer(
  base: PolicyDocument,
  layer: PartialPolicyDocument,
  trustExecFields: boolean,
): PolicyDocument {
  // `risk`: a camada NUNCA afrouxa uma decisão da base (achado CRÍTICO de
  // 2026-09-22 — antes `{ ...base.risk, ...layer.risk }` deixava o projeto
  // trocar `irreversible` de `approve` para `allow`). Mesma regra da
  // delegação pai→filho (`intersect()` mais abaixo).
  const risk = (Object.keys(base.risk) as RiskLevel[]).reduce<Record<RiskLevel, Decision>>(
    (acc, level) => {
      acc[level] = narrowestDecision(base.risk[level], layer.risk?.[level] ?? base.risk[level]);
      return acc;
    },
    {} as Record<RiskLevel, Decision>,
  );

  // `fallback`: só as capabilities que a base já tem, e só com agentes que a
  // cadeia da base já aceitava — o projeto reordena ou corta, não acrescenta.
  const fallback: Record<string, string[]> = { ...base.fallback };
  for (const [capability, cadeia] of Object.entries(layer.fallback ?? {})) {
    const daBase = base.fallback[capability];
    if (daBase === undefined || cadeia === undefined) continue;
    fallback[capability] = cadeia.filter((agente) => daBase.includes(agente));
  }

  // Campos de execução: sem confiança explícita do usuário, a camada não
  // chega neles. Com confiança, ainda não podem DESLIGAR o que a base exige.
  const v = layer.validation;
  const command =
    trustExecFields && typeof v?.command === 'string' ? v.command : base.validation.command;
  const reviewEnabled =
    base.validation.review.enabled || (trustExecFields && v?.review?.enabled === true);
  const reviewAgent =
    trustExecFields && v?.review?.agent !== undefined
      ? v.review.agent
      : base.validation.review.agent;

  return {
    ...base,
    maxDepth: menorOuBase(base.maxDepth, layer.maxDepth),
    maxConcurrency: menorOuBase(base.maxConcurrency, layer.maxConcurrency),
    maxConcurrencyPerAgent: menorOuBase(base.maxConcurrencyPerAgent, layer.maxConcurrencyPerAgent),
    taskTimeoutSeconds: menorOuBase(base.taskTimeoutSeconds, layer.taskTimeoutSeconds),
    sessionTimeoutSeconds: menorOuBase(base.sessionTimeoutSeconds, layer.sessionTimeoutSeconds),
    heartbeatTimeoutSeconds: menorOuBase(
      base.heartbeatTimeoutSeconds,
      layer.heartbeatTimeoutSeconds,
    ),
    defaultBudget: {
      usd: menorOuBase(base.defaultBudget.usd, layer.defaultBudget?.usd),
      tokens: menorOuBase(base.defaultBudget.tokens, layer.defaultBudget?.tokens),
      seconds: menorOuBase(base.defaultBudget.seconds, layer.defaultBudget?.seconds),
    },
    risk,
    commands: {
      allow: subconjunto(base.commands.allow, layer.commands?.allow),
      deny: uniao(base.commands.deny, layer.commands?.deny),
    },
    paths: {
      // AND lógico: a camada só DESLIGA, nunca liga o que a base não permitia.
      allowWriteOutsideWorkdir:
        base.paths.allowWriteOutsideWorkdir &&
        (layer.paths?.allowWriteOutsideWorkdir ?? base.paths.allowWriteOutsideWorkdir),
      denyFragments: uniao(base.paths.denyFragments, layer.paths?.denyFragments),
    },
    network: {
      allowDomains: subconjunto(base.network.allowDomains, layer.network?.allowDomains),
    },
    retries: {
      max: menorOuBase(base.retries.max, layer.retries?.max),
      backoffMs: menorOuBase(base.retries.backoffMs, layer.retries?.backoffMs),
    },
    fallback,
    watch: {
      pauseOn: uniao<RiskLevel>(base.watch.pauseOn, layer.watch?.pauseOn),
      flagOn: uniao<RiskLevel>(base.watch.flagOn, layer.watch?.flagOn),
    },
    validation: {
      command,
      commandTimeoutSeconds: menorOuBase(
        base.validation.commandTimeoutSeconds,
        v?.commandTimeoutSeconds,
      ),
      review: { enabled: reviewEnabled, agent: reviewAgent },
    },
  };
}

export const DEFAULT_POLICY: PolicyDocument = {
  maxDepth: 3,
  maxConcurrency: 4,
  maxConcurrencyPerAgent: 2,
  taskTimeoutSeconds: 1800,
  sessionTimeoutSeconds: 14400,
  heartbeatTimeoutSeconds: 300,
  defaultBudget: { usd: 5, tokens: 2_000_000, seconds: 3600 },
  risk: {
    read: 'allow',
    write: 'allow',
    exec: 'allow',
    escalate: 'approve',
    budget: 'approve',
    irreversible: 'approve',
  },
  commands: {
    allow: [
      'git status',
      'git diff',
      'git log',
      'git show',
      'git branch',
      'git add',
      'git commit',
      'git stash',
      'npm test',
      'npm run',
      'npm ci',
      'npx tsc',
      'node',
      'pnpm test',
      'pnpm run',
      'yarn test',
      'python',
      'pytest',
      'go test',
      'cargo test',
      'ls',
      'cat',
      'rg',
      'grep',
      'find',
      'echo',
    ],
    deny: ['sudo', 'shutdown', 'reboot', 'mkfs', 'diskpart', 'format ', 'reg delete'],
  },
  paths: {
    allowWriteOutsideWorkdir: false,
    denyFragments: ['.git/config', '.ssh', '.aws', '.env', 'id_rsa', 'credentials'],
  },
  network: {
    allowDomains: [],
  },
  retries: {
    max: 2,
    backoffMs: 2000,
  },
  // Cadeia curta de propósito (ADR 06.2): se claude, codex e opencode falharem
  // na mesma tarefa, o problema está no brief — insistir em mais agentes só
  // queima orçamento. Os demais continuam disponíveis por chamada explícita.
  //
  // `openclaude` foi ACRESCENTADO por dedução (é fork do Claude Code, mesmas
  // capabilities) e NUNCA foi exercitado como fallback contra o binário real
  // — entra por último em cada cadeia, depois dos agentes já comprovados, para
  // que a promoção a "cidadão pleno" não force ninguém a depender dele antes
  // da hora.
  fallback: {
    'code-edit': ['claude', 'codex', 'opencode', 'openclaude'],
    refactor: ['claude', 'codex', 'opencode', 'openclaude'],
    'test-writing': ['claude', 'codex', 'opencode', 'openclaude'],
    'code-review': ['claude', 'codex', 'openclaude'],
    debug: ['claude', 'codex', 'openclaude'],
    planning: ['claude', 'codex'],
    shell: ['codex', 'opencode', 'openclaude'],
  },
  watch: {
    pauseOn: ['irreversible'],
    flagOn: ['escalate'],
  },
  validation: {
    command: null,
    commandTimeoutSeconds: 600,
    review: { enabled: false, agent: null },
  },
};

/** Em modo supervisionado, sair da allow list também para a sessão. */
export function watchForMode(watch: WatchPolicy, mode: SessionMode): WatchPolicy {
  if (mode !== 'supervised') return watch;
  return {
    pauseOn: [...new Set<RiskLevel>([...watch.pauseOn, 'escalate'])],
    flagOn: watch.flagOn,
  };
}

/**
 * Comandos cujo efeito não dá para desfazer — sempre passam por aprovação.
 *
 * Todos os padrões usam a flag `i` (case-insensitive): PowerShell (comum no
 * Windows) e vários shells não diferenciam maiúsculas/minúsculas em nomes de
 * comando, então `Git Push`/`NPM Publish`/etc. precisam bater igual a
 * `git push`/`npm publish`.
 */
const IRREVERSIBLE_PATTERNS: RegExp[] = [
  /^git\s+push\b/i,
  /^git\s+reset\s+--hard\b/i,
  /^git\s+clean\s+-[a-z]*f/i,
  /^git\s+branch\s+-D\b/i,
  /^git\s+tag\s+-d\b/i,
  /^rm\s+-[a-z]*r[a-z]*f?\b/i,
  /^rm\s+-[a-z]*f/i,
  /^npm\s+publish\b/i,
  /^pnpm\s+publish\b/i,
  /^yarn\s+publish\b/i,
  /^docker\s+(rm|rmi|system\s+prune)\b/i,
  /^kubectl\s+delete\b/i,
  /^terraform\s+(apply|destroy)\b/i,
  /^gh\s+(pr\s+merge|release\s+create|repo\s+delete)\b/i,
  /^aws\s+/i,
  /^Remove-Item\b/i,
];

/** Ações que o Hub intercepta e classifica antes de deixar acontecer. */
export type GuardedAction =
  | { kind: 'file.read'; path: string }
  | { kind: 'file.write'; path: string }
  | { kind: 'command'; command: string }
  | { kind: 'network'; url: string }
  | { kind: 'delegation'; agent: string }
  | { kind: 'budget.overrun'; detail: string };

export interface PolicyVerdict {
  risk: RiskLevel;
  decision: Decision;
  reason: string;
}

export interface PolicyContext {
  /** Diretório onde a sessão pode escrever livremente (worktree ou repo). */
  workdir: string;
  mode: SessionMode;
}

export class PolicyEngine {
  readonly policy: PolicyDocument;

  constructor(policy: PolicyDocument = DEFAULT_POLICY) {
    this.policy = policy;
  }

  /** Classifica a ação em um nível de risco, sem ainda decidir nada. */
  classify(action: GuardedAction, ctx: PolicyContext): { risk: RiskLevel; reason: string } {
    switch (action.kind) {
      case 'file.read':
        return { risk: 'read', reason: 'leitura de arquivo' };

      case 'file.write': {
        const target = path.resolve(action.path);
        // Comparação case-insensitive: Windows e o padrão do macOS (APFS) têm
        // sistema de arquivos insensível a maiúsculas/minúsculas, então
        // `.ENV`/`ID_RSA`/`Credentials` são o MESMO arquivo físico que
        // `.env`/`id_rsa`/`credentials` e precisam ser bloqueados igual.
        const normalizedTarget = target.replaceAll('\\', '/').toLowerCase();
        const fragment = this.policy.paths.denyFragments.find((f) =>
          normalizedTarget.includes(f.toLowerCase()),
        );
        if (fragment) {
          return { risk: 'irreversible', reason: `caminho sensível (${fragment})` };
        }
        if (!isInside(ctx.workdir, target) && !this.policy.paths.allowWriteOutsideWorkdir) {
          return { risk: 'escalate', reason: 'escrita fora do diretório da sessão' };
        }
        return { risk: 'write', reason: 'escrita dentro do diretório da sessão' };
      }

      case 'command': {
        const cmd = action.command.trim();
        const denied = this.policy.commands.deny.find((d) => cmd.startsWith(d));
        if (denied) return { risk: 'irreversible', reason: `comando na deny list (${denied})` };

        if (IRREVERSIBLE_PATTERNS.some((re) => re.test(cmd))) {
          return { risk: 'irreversible', reason: 'comando com efeito irreversível' };
        }
        const allowed = this.policy.commands.allow.find((a) => cmd.startsWith(a));
        if (allowed) return { risk: 'exec', reason: `comando na allow list (${allowed})` };

        return { risk: 'escalate', reason: 'comando fora da allow list' };
      }

      case 'network': {
        const host = safeHost(action.url);
        if (host === null) return { risk: 'escalate', reason: 'URL não reconhecida' };
        const ok = this.policy.network.allowDomains.some(
          (d) => host === d || host.endsWith(`.${d}`),
        );
        return ok
          ? { risk: 'read', reason: `domínio liberado (${host})` }
          : { risk: 'escalate', reason: `domínio não liberado (${host})` };
      }

      case 'delegation':
        return { risk: 'exec', reason: `delegação para ${action.agent}` };

      case 'budget.overrun':
        return { risk: 'budget', reason: action.detail };
    }
  }

  /**
   * Decide o que fazer. O modo de supervisão é um *overlay*: só endurece,
   * nunca afrouxa o que a política já definiu.
   */
  decide(action: GuardedAction, ctx: PolicyContext): PolicyVerdict {
    const { risk, reason } = this.classify(action, ctx);
    const base = this.policy.risk[risk];
    const byMode = decisionForMode(risk, ctx.mode);
    return { risk, decision: narrowestDecision(base, byMode), reason };
  }

  /**
   * Política efetiva de um filho = interseção com a do pai.
   * Garante literalmente que nenhum agente ganhe poder ao ser delegado.
   */
  intersect(child: PolicyDocument): PolicyEngine {
    const parent = this.policy;
    const risk = {} as Record<RiskLevel, Decision>;
    for (const level of Object.keys(parent.risk) as RiskLevel[]) {
      risk[level] = narrowestDecision(parent.risk[level], child.risk[level]);
    }
    return new PolicyEngine({
      ...child,
      maxDepth: Math.min(parent.maxDepth, child.maxDepth),
      maxConcurrency: Math.min(parent.maxConcurrency, child.maxConcurrency),
      maxConcurrencyPerAgent: Math.min(
        parent.maxConcurrencyPerAgent,
        child.maxConcurrencyPerAgent,
      ),
      taskTimeoutSeconds: Math.min(parent.taskTimeoutSeconds, child.taskTimeoutSeconds),
      sessionTimeoutSeconds: Math.min(parent.sessionTimeoutSeconds, child.sessionTimeoutSeconds),
      heartbeatTimeoutSeconds: Math.min(
        parent.heartbeatTimeoutSeconds,
        child.heartbeatTimeoutSeconds,
      ),
      risk,
      commands: {
        // O filho só pode usar comandos que o pai também permitiria.
        allow: child.commands.allow.filter((c) => parent.commands.allow.includes(c)),
        deny: [...new Set([...parent.commands.deny, ...child.commands.deny])],
      },
      paths: {
        allowWriteOutsideWorkdir:
          parent.paths.allowWriteOutsideWorkdir && child.paths.allowWriteOutsideWorkdir,
        denyFragments: [
          ...new Set([...parent.paths.denyFragments, ...child.paths.denyFragments]),
        ],
      },
      network: {
        allowDomains: child.network.allowDomains.filter((d) =>
          parent.network.allowDomains.includes(d),
        ),
      },
      watch: {
        // Vigilância é união, não interseção: o filho para em tudo que o pai
        // pararia, mais o que ele mesmo declarar.
        pauseOn: [...new Set([...parent.watch.pauseOn, ...child.watch.pauseOn])],
        flagOn: [...new Set([...parent.watch.flagOn, ...child.watch.flagOn])],
      },
      validation: {
        // O filho não pode desligar um portão que o pai exige.
        command: parent.validation.command ?? child.validation.command,
        commandTimeoutSeconds: Math.min(
          parent.validation.commandTimeoutSeconds,
          child.validation.commandTimeoutSeconds,
        ),
        review: {
          enabled: parent.validation.review.enabled || child.validation.review.enabled,
          agent: child.validation.review.agent ?? parent.validation.review.agent,
        },
      },
    });
  }
}

/** Overlay de supervisão: quanto mais supervisionado, mais cedo pede aprovação. */
function decisionForMode(risk: RiskLevel, mode: SessionMode): Decision {
  const rank = RISK_RANK[risk];
  switch (mode) {
    case 'supervised':
      // Só leitura passa direto; qualquer efeito colateral pede aprovação.
      return rank <= RISK_RANK.read ? 'allow' : 'approve';
    case 'semi':
      // Trabalho normal passa; o que sai do previsto para.
      return rank <= RISK_RANK.exec ? 'allow' : 'approve';
    case 'autonomous':
      // Só o irreversível e o estouro de orçamento param.
      return rank <= RISK_RANK.escalate ? 'allow' : 'approve';
  }
}

/** Modo efetivo de um filho: nunca mais permissivo que o do pai. */
export function inheritMode(parent: SessionMode, requested?: SessionMode): SessionMode {
  if (!requested) return parent;
  return narrowestMode(parent, requested);
}

export function isInside(parentDir: string, target: string): boolean {
  const rel = path.relative(path.resolve(parentDir), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export { MODE_RANK };
