import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { nowIso, newId, HubError } from '@agents-hub/core';
import { AsyncQueue } from './async-queue.js';
import { quoteForShell, resolveBin } from './bin-resolver.js';
import { resolveMapper } from './mappers/index.js';
import { killProcessTree } from './process-tree.js';
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
  /** Caminho do `{{promptFile}}` desta run, se o manifesto usa esse modo — apagado em `settle`. */
  promptFilePath: string | null;
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
    // Espera de verdade: quem chama `cancel` no desligamento do daemon precisa
    // que a árvore esteja morta antes de o processo sair.
    await killTree(internal.child);
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

    // A política nativa do agente vem do modo da sessão: é o que impede o
    // sandbox do próprio CLI de contradizer o isolamento que o Hub já montou.
    const args = [
      ...argsTemplate,
      ...this.manifest.invoke.modeArgs[ctx.mode],
      ...this.manifest.invoke.extraArgs,
      ...(ctx.extraArgs ?? []),
    ]
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
      pid: child.pid ?? null,
      child,
      queue,
      canceled: false,
      settle: (outcome) => {
        if (settled) return;
        settled = true;
        handle.clearTimers();
        queue.close();
        this.#handles.delete(handle.id);
        // O prompt só serve enquanto o processo roda; cada spawn grava o seu
        // com timestamp próprio (nunca reaproveitado), então sem isto o
        // diretório de tmpdir cresce um arquivo por run, para sempre.
        //
        // `resolveDone` espera a tentativa de remoção terminar (mesmo que
        // falhe) em vez de disparar e esquecer: sem isso, quem aguarda
        // `handle.done` poderia seguir em frente antes de o unlink acontecer
        // de verdade — inofensivo em produção, mas torna o comportamento
        // difícil de testar e de raciocinar sobre.
        const limpeza = handle.promptFilePath
          ? unlink(handle.promptFilePath).catch(() => {
              // Já pode ter sido removido, ou o disco pode ter sumido no
              // desligamento — nenhum dos dois motivo pra derrubar a run.
            })
          : Promise.resolve();
        void limpeza.then(() => resolveDone(outcome));
      },
      clearTimers: () => {},
      touch: () => {},
      promptFilePath: wantsPromptFile ? promptFile : null,
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
      // `void` deliberado: o turno já foi liquidado acima, e quem estourou o
      // timeout não espera o kill terminar para seguir.
      void killTree(child);
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
        void killTree(child);
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
      // Sem callback aqui, uma falha na escrita (EPIPE: o CLI já saiu, ou
      // nunca chegou a consumir stdin) some silenciosamente — a run fica
      // pendurada esperando eventos que nunca vêm, até o heartbeat/timeout
      // estourar sem nenhuma pista do motivo. `send()` já trata isso; o
      // prompt inicial precisa do mesmo tratamento.
      child.stdin.write(prompt, (err) => {
        if (!err) return;
        handle.settle({
          exitCode: null,
          signal: null,
          reason: 'error',
          error: `falha ao escrever o prompt inicial em stdin: ${err.message}`,
          nativeSessionId: discoveredNativeId,
          tail: tail.join('\n'),
        });
        // O processo pode continuar vivo mesmo com a escrita tendo falhado
        // (ex.: ele destruiu só o lado de leitura do próprio stdin) — sem
        // isto, a run é dada como terminada no domínio enquanto o processo
        // real segue rodando, gastando recurso sem ninguém observando.
        void killTree(child);
      });
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

/**
 * Mata a árvore de processos do agente — e **espera** ela morrer.
 *
 * O `await` não é zelo: no Windows o kill é um processo externo (`taskkill`), e
 * quem chamava isto no desligamento do daemon seguia direto para
 * `process.exit(0)`. O `taskkill` podia nem ter sido agendado. Resultado: o
 * daemon morria, a árvore do agente sobrevivia, continuava gastando token e
 * escrevendo no worktree — e não restava nada no sistema capaz de pará-la,
 * porque o Hub não guarda PID em lugar nenhum.
 *
 * Lógica compartilhada com `killServerTree` (`opencode/adapter.ts`) mora em
 * `killProcessTree` (`./process-tree.js`).
 */
function killTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.killed || child.pid === undefined) return Promise.resolve();
  return killProcessTree(child.pid, () => child.kill('SIGKILL'));
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
