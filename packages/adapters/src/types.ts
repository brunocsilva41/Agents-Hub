import { z } from 'zod';
import type { EventCost, EventEnvelope, EventType, SessionMode } from '@agents-hub/core';

/**
 * O manifesto é a peça que torna "adicionar agente" um arquivo YAML em vez de
 * um pull request. Todos os oito agentes do MVP são descritos por ele; só
 * escrevemos código quando o agente oferece algo que o genérico não cobre
 * (ex.: OpenCode via HTTP+SSE).
 */
export const AgentManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  vendor: z.string().default('desconhecido'),
  description: z.string().default(''),

  /** Executável. Resolvido no PATH; no Windows, com as extensões usuais. */
  bin: z.string().min(1),

  detect: z
    .object({
      args: z.array(z.string()).default(['--version']),
      versionRegex: z.string().default('(\\d+\\.\\d+\\.\\d+)'),
      /**
       * Generoso de propósito: no Windows, o primeiro start de um CLI
       * empacotado como .exe passa por varredura de antivírus e descompressão
       * — 20s a frio é comum. Timeout curto aqui reporta "quebrado" um agente
       * que está perfeitamente saudável.
       */
      timeoutMs: z.number().int().positive().default(45_000),
    })
    .default({}),

  invoke: z.object({
    /** Args de uma execução nova. Suporta `{{prompt}}`, `{{workdir}}`, `{{model}}`. */
    oneShot: z.array(z.string()).min(1),
    /** Args para continuar uma sessão nativa. Suporta `{{nativeSessionId}}`. */
    resume: z.array(z.string()).optional(),
    /** Manda o prompt por stdin em vez de argumento (evita limite de linha de comando). */
    stdinPrompt: z.boolean().default(false),
    /** stdin permanece aberto: permite `send()` ao vivo sem reiniciar o processo. */
    interactive: z.boolean().default(false),
    env: z.record(z.string()).default({}),
    /** Args extras que o usuário quer sempre presentes (modelo, flags de política). */
    extraArgs: z.array(z.string()).default([]),

    /**
     * Como o modo de supervisão do Hub vira a política NATIVA do agente.
     *
     * Sem isto, o Hub isola a sessão num worktree e o agente aplica por cima o
     * sandbox dele, calibrado para outro mundo. O resultado é errado nas duas
     * direções: restritivo demais (o Codex recusou escrever no próprio worktree
     * da sessão, porque o diretório não estava na lista de projetos confiáveis
     * do `~/.codex/config.toml`) ou permissivo demais, se a config global do
     * usuário for frouxa.
     *
     * Declarar aqui é o que faz `--mode supervised` significar a mesma coisa
     * para o Hub e para o agente.
     */
    modeArgs: z
      .object({
        supervised: z.array(z.string()).default([]),
        semi: z.array(z.string()).default([]),
        autonomous: z.array(z.string()).default([]),
      })
      .default({}),
  }),

  session: z
    .object({
      strategy: z.enum(['native', 'replay', 'none']).default('replay'),
      /** Caminho estilo `$.session_id` dentro do evento bruto que traz o id nativo. */
      idFrom: z.string().optional(),
    })
    .default({}),

  stream: z
    .object({
      format: z.enum(['jsonl', 'text']).default('text'),
      /** Nome do mapper registrado em `mappers/`. */
      mapper: z.string().default('generic-text'),
    })
    .default({}),

  capabilities: z.array(z.string()).default([]),

  auth: z
    .object({
      /** `inherit`: o Hub nunca toca em segredo, usa o login do próprio CLI (ADR 03.1). */
      mode: z.enum(['inherit', 'env']).default('inherit'),
      envKeys: z.array(z.string()).default([]),
      /** Dica exibida no `hub doctor` quando o agente não está autenticado. */
      loginHint: z.string().default(''),
    })
    .default({}),

  defaults: z
    .object({
      isolation: z.enum(['none', 'worktree', 'container']).default('worktree'),
      timeoutSeconds: z.number().int().positive().default(1800),
      supervision: z.enum(['supervised', 'semi', 'autonomous']).default('semi'),
    })
    .default({}),

  /** Limitações conhecidas, mostradas na UI para explicar degradações. */
  caveats: z.array(z.string()).default([]),
});

export type AgentManifest = z.infer<typeof AgentManifestSchema>;

export interface ProbeResult {
  agentId: string;
  installed: boolean;
  version: string | null;
  /** `null` quando o manifesto não sabe verificar autenticação sem gastar tokens. */
  authenticated: boolean | null;
  binPath: string | null;
  error: string | null;
  checkedAt: string;
}

export interface RunContext {
  sessionId: string;
  taskId: string | null;
  agentId: string;
  /** Diretório onde o processo roda (worktree isolado ou o repo). */
  workdir: string;
  mode: SessionMode;
  /** Env extra além do ambiente herdado. Nunca contém segredo gerado pelo Hub. */
  env: Record<string, string>;
  timeoutSeconds: number;
  /** Sem nenhum evento por este tempo, a run é considerada travada. */
  heartbeatSeconds: number;
  model?: string;
  /**
   * Argumentos extra a acrescentar na invocação, calculados por sessão — ex.:
   * a config do gate pré-execução do Codex, que depende do modo e de uma
   * escolha explícita do usuário e por isso não cabe no manifesto estático.
   */
  extraArgs?: string[];
}

/** Evento já mapeado pelo adapter, antes de ganhar `seq` e `id` no domínio. */
export interface MappedEvent {
  type: EventType;
  payload: Record<string, unknown>;
  cost?: EventCost;
  /** Quando o agente revela o id da sessão nativa, o mapper o expõe aqui. */
  nativeSessionId?: string;
  raw: unknown;
}

export type EventMapper = (line: unknown) => MappedEvent[];

export interface RunHandle {
  id: string;
  sessionId: string;
  agentId: string;
  /** Preenchido assim que o agente revela o id nativo (pode nunca ser). */
  nativeSessionId: string | null;
  startedAt: string;
  /** Resolvido quando o processo termina, com o código de saída. */
  readonly done: Promise<RunOutcome>;
  events: AsyncIterable<MappedEvent>;
  supportsLiveSend: boolean;
}

export interface RunOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  reason: 'exit' | 'timeout' | 'heartbeat' | 'canceled' | 'error';
  error: string | null;
  nativeSessionId: string | null;
  /** stdout/stderr acumulados quando o formato não é estruturado. */
  tail: string;
}

export interface AgentAdapter {
  readonly manifest: AgentManifest;
  probe(): Promise<ProbeResult>;
  start(ctx: RunContext, prompt: string): Promise<RunHandle>;
  resume(ctx: RunContext, nativeSessionId: string, prompt: string): Promise<RunHandle>;
  send(handle: RunHandle, text: string): Promise<void>;
  interrupt(handle: RunHandle): Promise<void>;
  cancel(handle: RunHandle): Promise<void>;
}

/** Usado pela camada de sessão para transformar `MappedEvent` em `EventEnvelope`. */
export type EnvelopeFactory = (mapped: MappedEvent, ctx: RunContext) => EventEnvelope;
