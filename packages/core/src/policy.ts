import path from 'node:path';
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
  fallback: {},
};

/** Comandos cujo efeito não dá para desfazer — sempre passam por aprovação. */
const IRREVERSIBLE_PATTERNS: RegExp[] = [
  /^git\s+push\b/,
  /^git\s+reset\s+--hard\b/,
  /^git\s+clean\s+-[a-z]*f/,
  /^git\s+branch\s+-D\b/,
  /^git\s+tag\s+-d\b/,
  /^rm\s+-[a-z]*r[a-z]*f?\b/,
  /^rm\s+-[a-z]*f/,
  /^npm\s+publish\b/,
  /^pnpm\s+publish\b/,
  /^yarn\s+publish\b/,
  /^docker\s+(rm|rmi|system\s+prune)\b/,
  /^kubectl\s+delete\b/,
  /^terraform\s+(apply|destroy)\b/,
  /^gh\s+(pr\s+merge|release\s+create|repo\s+delete)\b/,
  /^aws\s+/,
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
        const fragment = this.policy.paths.denyFragments.find((f) =>
          target.replaceAll('\\', '/').includes(f),
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
