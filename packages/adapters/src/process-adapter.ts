import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { nowIso, newId, HubError } from '@agents-hub/core';
import { AsyncQueue } from './async-queue.js';
import { quoteForShell, resolveBin } from './bin-resolver.js';
import { resolveMapper } from './mappers/index.js';
import type {
  AgentAdapter,
  AgentManifest,
  EventMapper,
  MappedEvent,
  ProbeResult,
  RunContext,
  RunHandle,
  RunOutcome,
} from './types.js';

interface InternalHandle extends RunHandle {
  child: ChildProcessWithoutNullStreams;
  queue: AsyncQueue<MappedEvent>;
  settle: (outcome: RunOutcome) => void;
  canceled: boolean;
  clearTimers: () => void;
  touch: () => void;
}

/**
 * Adapter genérico de CLI, dirigido pelo manifesto (ADR 01.4).
 *
 * Cobre os oito agentes do MVP porque todos convergem no mesmo padrão:
 * processo headless → linhas em stdout → término. O que varia (flags, formato,
 * como o id nativo aparece) está no YAML, não aqui.
 */
export class ProcessAgentAdapter implements AgentAdapter {
  readonly manifest: AgentManifest;
  readonly #mapper: EventMapper;
  readonly #handles = new Map<string, InternalHandle>();

  constructor(manifest: AgentManifest) {
    this.manifest = manifest;
    this.#mapper = resolveMapper(manifest.stream.mapper);
  }

  async probe(): Promise<ProbeResult> {
    const base: ProbeResult = {
      agentId: this.manifest.id,
      installed: false,
      version: null,
      authenticated: null,
      binPath: null,
      error: null,
      checkedAt: nowIso(),
    };

    const resolved = await resolveBin(this.manifest.bin);
    if (!resolved) {
      return { ...base, error: `binário "${this.manifest.bin}" não encontrado no PATH` };
    }

    try {
      const output = await runToCompletion(
        resolved,
        this.manifest.detect.args,
        this.manifest.invoke.env,
        this.manifest.detect.timeoutMs,
      );
      const match = new RegExp(this.manifest.detect.versionRegex).exec(output);
      return {
        ...base,
        installed: true,
        binPath: resolved.path,
        version: match?.[1] ?? output.trim().split(/\r?\n/)[0] ?? null,
        // Verificar login de verdade custaria uma chamada real ao provedor;
        // deixamos explicitamente indeterminado em vez de mentir.
        authenticated: null,
      };
    } catch (err) {
      return {
        ...base,
        installed: true,
        binPath: resolved.path,
        error: (err as Error).message,
      };
    }
  }

  async start(ctx: RunContext, prompt: string): Promise<RunHandle> {
    return this.#spawnRun(ctx, this.manifest.invoke.oneShot, prompt, null);
  }

  async resume(ctx: RunContext, nativeSessionId: string, prompt: string): Promise<RunHandle> {
    const template = this.manifest.invoke.resume;
    if (!template || this.manifest.session.strategy !== 'native') {
      throw new HubError(
        'ADAPTER_FAILURE',
        `O agente "${this.manifest.id}" não suporta retomada nativa de sessão`,
        { agentId: this.manifest.id, strategy: this.manifest.session.strategy },
      );
    }
    return this.#spawnRun(ctx, template, prompt, nativeSessionId);
  }

  /**
   * Injeta mensagem numa run viva. Só funciona onde o manifesto declara
   * `interactive: true`; nos modos one-shot o SessionManager degrada para
   * um novo turno via `resume`.
   */
  async send(handle: RunHandle, text: string): Promise<void> {
    const internal = this.#handles.get(handle.id);
    if (!internal || !internal.supportsLiveSend) {
      throw new HubError(
        'ADAPTER_FAILURE',
        `O agente "${this.manifest.id}" não aceita mensagem ao vivo nesta run`,
        { agentId: this.manifest.id, runId: handle.id },
      );
    }
    await new Promise<void>((resolve, reject) => {
      internal.child.stdin.write(`${text}\n`, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Para o turno atual preservando o processo, quando o agente entende SIGINT. */
  async interrupt(handle: RunHandle): Promise<void> {
    const internal = this.#handles.get(handle.id);
    if (!internal) return;
    if (process.platform === 'win32') {
      // Windows não tem SIGINT entregável a outro processo de forma confiável:
      // degradamos para cancelamento, e o manifesto avisa disso em `caveats`.
      await this.cancel(handle);
      return;
    }
    internal.child.kill('SIGINT');
  }

  async cancel(handle: RunHandle): Promise<void> {
    const internal = this.#handles.get(handle.id);
    if (!internal) return;
    internal.canceled = true;
    killTree(internal.child);
  }

  async #spawnRun(
    ctx: RunContext,
    argsTemplate: string[],
    prompt: string,
    nativeSessionId: string | null,
  ): Promise<RunHandle> {
    const resolved = await resolveBin(this.manifest.bin);
    if (!resolved) {
      throw new HubError(
        'AGENT_NOT_INSTALLED',
        `Binário "${this.manifest.bin}" do agente "${this.manifest.id}" não está no PATH`,
        { agentId: this.manifest.id, bin: this.manifest.bin },
      );
    }

    const usesStdin = this.manifest.invoke.stdinPrompt;

    // Alguns CLIs não leem prompt de stdin e exigi-lo como argumento é frágil:
    // no Windows, um prompt multilinha atravessando o cmd.exe quebra o comando.
    // `{{promptFile}}` grava o Brief em arquivo e passa só o caminho.
    const wantsPromptFile = argsTemplate.some((a) => a.includes('{{promptFile}}'));
    const promptFile = wantsPromptFile ? await writePromptFile(ctx.sessionId, prompt) : '';

    const vars: Record<string, string> = {
      prompt: usesStdin || wantsPromptFile ? '' : prompt,
      promptFile,
      nativeSessionId: nativeSessionId ?? '',
      workdir: ctx.workdir,
      model: ctx.model ?? '',
    };

    const args = [...argsTemplate, ...this.manifest.invoke.extraArgs]
      .map((arg) => applyTemplate(arg, vars))
      // Um placeholder vazio (ex.: `{{model}}` sem modelo definido) some do
      // comando em vez de virar um argumento em branco que quebra o parser.
      .filter((arg) => arg.length > 0);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.manifest.invoke.env,
      ...ctx.env,
      AGENTS_HUB_SESSION_ID: ctx.sessionId,
      AGENTS_HUB_TASK_ID: ctx.taskId ?? '',
      AGENTS_HUB_AGENT_ID: ctx.agentId,
    };

    const child = spawn(
      resolved.needsShell ? quoteForShell(resolved.path) : resolved.path,
      resolved.needsShell ? args.map(quoteForShell) : args,
      {
        cwd: ctx.workdir,
        env,
        shell: resolved.needsShell,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ) as ChildProcessWithoutNullStreams;

    const queue = new AsyncQueue<MappedEvent>();
    let settled = false;
    let resolveDone!: (outcome: RunOutcome) => void;
    const done = new Promise<RunOutcome>((resolve) => {
      resolveDone = resolve;
    });

    const tail: string[] = [];
    let discoveredNativeId: string | null = nativeSessionId;

    const handle: InternalHandle = {
      id: newId('run'),
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      nativeSessionId: nativeSessionId,
      startedAt: nowIso(),
      done,
      events: queue,
      supportsLiveSend: this.manifest.invoke.interactive,
      child,
      queue,
      canceled: false,
      settle: (outcome) => {
        if (settled) return;
        settled = true;
        handle.clearTimers();
        queue.close();
        this.#handles.delete(handle.id);
        resolveDone(outcome);
      },
      clearTimers: () => {},
      touch: () => {},
    };

    // --- Guardas de tempo (ADR 03.2) -----------------------------------------
    let heartbeat: NodeJS.Timeout | null = null;
    const overall = setTimeout(() => {
      handle.settle({
        exitCode: null,
        signal: null,
        reason: 'timeout',
        error: `run excedeu ${ctx.timeoutSeconds}s`,
        nativeSessionId: discoveredNativeId,
        tail: tail.join('\n'),
      });
      killTree(child);
    }, ctx.timeoutSeconds * 1000);

    const armHeartbeat = (): void => {
      if (heartbeat) clearTimeout(heartbeat);
      heartbeat = setTimeout(() => {
        handle.settle({
          exitCode: null,
          signal: null,
          reason: 'heartbeat',
          error: `sem eventos por ${ctx.heartbeatSeconds}s — run considerada travada`,
          nativeSessionId: discoveredNativeId,
          tail: tail.join('\n'),
        });
        killTree(child);
      }, ctx.heartbeatSeconds * 1000);
    };

    handle.clearTimers = () => {
      clearTimeout(overall);
      if (heartbeat) clearTimeout(heartbeat);
    };
    handle.touch = armHeartbeat;
    armHeartbeat();

    // --- stdout: a timeline de verdade ---------------------------------------
    const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
    stdout.on('line', (line) => {
      handle.touch();
      for (const mapped of this.#mapLine(line)) {
        if (mapped.nativeSessionId && !discoveredNativeId) {
          discoveredNativeId = mapped.nativeSessionId;
          handle.nativeSessionId = mapped.nativeSessionId;
        }
        queue.push(mapped);
      }
    });

    // --- stderr: diagnóstico, nunca descartado -------------------------------
    const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
    stderr.on('line', (line) => {
      if (line.trim().length === 0) return;
      handle.touch();
      tail.push(line);
      if (tail.length > 200) tail.shift();
      queue.push({ type: 'log', payload: { stream: 'stderr', text: line }, raw: line });
    });

    child.on('error', (err) => {
      queue.push({ type: 'error', payload: { message: err.message }, raw: null });
      handle.settle({
        exitCode: null,
        signal: null,
        reason: 'error',
        error: err.message,
        nativeSessionId: discoveredNativeId,
        tail: tail.join('\n'),
      });
    });

    child.on('close', (code, signal) => {
      handle.settle({
        exitCode: code,
        signal: signal as NodeJS.Signals | null,
        reason: handle.canceled ? 'canceled' : 'exit',
        error:
          code === 0 || handle.canceled
            ? null
            : `processo terminou com código ${code}${tail.length > 0 ? `: ${tail.slice(-5).join(' | ')}` : ''}`,
        nativeSessionId: discoveredNativeId,
        tail: tail.join('\n'),
      });
    });

    // --- prompt por stdin evita todo o inferno de escaping de linha de comando
    if (usesStdin) {
      child.stdin.write(prompt);
      if (!this.manifest.invoke.interactive) child.stdin.end();
    } else if (!this.manifest.invoke.interactive) {
      child.stdin.end();
    }

    this.#handles.set(handle.id, handle);
    return handle;
  }

  #mapLine(line: string): MappedEvent[] {
    if (this.manifest.stream.format === 'text') {
      return this.#mapper(line);
    }

    const trimmed = line.trim();
    if (trimmed.length === 0) return [];
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      // Linha não-JSON no meio de um stream JSONL: normalmente é banner ou
      // aviso do CLI. Vira log em vez de sumir.
      return [{ type: 'log', payload: { stream: 'stdout', text: line }, raw: line }];
    }

    try {
      return this.#mapper(JSON.parse(trimmed));
    } catch {
      return [{ type: 'log', payload: { stream: 'stdout', text: line, unparsed: true }, raw: line }];
    }
  }
}

async function writePromptFile(sessionId: string, prompt: string): Promise<string> {
  const dir = path.join(os.tmpdir(), 'agents-hub', 'prompts');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}-${Date.now()}.md`);
  await writeFile(file, prompt, 'utf8');
  return file;
}

function applyTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => vars[key] ?? '');
}

function killTree(child: ChildProcessWithoutNullStreams): void {
  if (child.killed || child.pid === undefined) return;
  if (process.platform === 'win32') {
    // O CLI costuma ser um shim que abre um processo filho; sem /T o agente
    // real sobrevive ao "cancelamento" e continua gastando tokens.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGKILL');
  }
}

async function runToCompletion(
  bin: { path: string; needsShell: boolean },
  args: string[],
  extraEnv: Record<string, string>,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      bin.needsShell ? quoteForShell(bin.path) : bin.path,
      bin.needsShell ? args.map(quoteForShell) : args,
      {
        env: { ...process.env, ...extraEnv },
        shell: bin.needsShell,
        windowsHide: true,
        // stdin fechado é essencial: vários CLIs de agente, ao verem um stdin
        // aberto, ficam esperando entrada em vez de imprimir a versão e sair.
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timeout ao executar ${bin.path} ${args.join(' ')}`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}
