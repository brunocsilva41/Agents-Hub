import { spawn, type ChildProcess } from 'node:child_process';
import { HubError, newId, nowIso } from '@agents-hub/core';
import { AsyncQueue } from '../async-queue.js';
import { resolveBin } from '../bin-resolver.js';
import type {
  AgentAdapter,
  AgentManifest,
  MappedEvent,
  ProbeResult,
  RunContext,
  RunHandle,
  RunOutcome,
} from '../types.js';
import {
  SseDecoder,
  openCodeIdleSignal,
  openCodeSessionId,
  translateOpenCodeEvent,
} from './events.js';

export interface OpenCodeAdapterOptions {
  host?: string;
  port?: number;
  /** Sobe um `opencode serve` próprio quando não houver um respondendo. */
  autoStart?: boolean;
}

/**
 * Quantas voltas de poll sem a sessão aparecer em `/api/session/active` antes
 * de declarar o turno encerrado.
 *
 * Existe uma janela (~1s medida) entre o prompt ser admitido e o loop do agente
 * começar, na qual a sessão legitimamente não aparece como ativa. Concluir na
 * primeira ausência encerraria o turno antes de ele começar.
 */
const TURN_SETTLE_POLLS = 3;
const POLL_INTERVAL_MS = 1000;

/**
 * Quanto esperar o loop do agente começar antes de desistir.
 *
 * Generoso porque o start a frio do OpenCode no Windows já foi medido em 20s, e
 * desistir cedo aqui produz exatamente o bug que este número existe para evitar:
 * uma run "concluída com sucesso" que nunca chamou o modelo.
 */
const MAX_ESPERA_INICIO_POLLS = 60;
const SERVER_BOOT_TIMEOUT_MS = 60_000;

interface RunState extends RunHandle {
  abort: AbortController;
  queue: AsyncQueue<MappedEvent>;
  settle: (outcome: RunOutcome) => void;
  canceled: boolean;
  touch: () => void;
  /** Marca que o turno saiu do papel — só depois disso ausência vira "acabou". */
  markStarted: () => void;
  /** Registra erro do agente para o desfecho da run não sair como sucesso. */
  recordError: (message: string) => void;
}

/**
 * Adapter HTTP do OpenCode.
 *
 * O OpenCode é o único agente do conjunto com servidor próprio, e usá-lo pelo
 * CLI headless jogava fora exatamente o que ele tem de melhor: id de sessão
 * durável, custo por passo e eventos estruturados. Aqui o Hub fala com
 * `opencode serve` — um servidor só, N sessões, cada uma presa ao seu worktree
 * por `location.directory`.
 *
 * O formato de fio está documentado em `docs/referencias/opencode-api.md`,
 * levantado contra o binário real.
 */
export class OpenCodeAdapter implements AgentAdapter {
  readonly manifest: AgentManifest;
  readonly #host: string;
  readonly #port: number;
  readonly #autoStart: boolean;
  readonly #runs = new Map<string, RunState>();

  /** Servidor que ESTE adapter subiu — só ele pode derrubar. */
  #ownServer: ChildProcess | null = null;
  #booting: Promise<void> | null = null;

  constructor(manifest: AgentManifest, options: OpenCodeAdapterOptions = {}) {
    this.manifest = manifest;
    this.#host = options.host ?? '127.0.0.1';
    this.#port = options.port ?? 4790;
    this.#autoStart = options.autoStart ?? true;
  }

  get baseUrl(): string {
    return `http://${this.#host}:${this.#port}`;
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

    // Servidor no ar já responde tudo que interessa, e sem pagar o start a frio
    // do .exe — que no Windows chega a 20s.
    if (await this.#healthy()) {
      return { ...base, installed: true, version: 'servidor no ar', authenticated: true };
    }

    const resolved = await resolveBin(this.manifest.bin);
    if (!resolved) {
      return { ...base, error: `binário "${this.manifest.bin}" não encontrado no PATH` };
    }
    return { ...base, installed: true, binPath: resolved.path };
  }

  async start(ctx: RunContext, prompt: string): Promise<RunHandle> {
    await this.#ensureServer();

    const created = await this.#json<{ data?: { id?: string } }>('POST', '/api/session', {
      // É assim que o worktree isolado é honrado sem um servidor por sessão.
      location: { directory: ctx.workdir },
      ...(ctx.model ? { model: { providerID: 'opencode', id: ctx.model } } : {}),
    });

    const nativeSessionId = created.data?.id;
    if (!nativeSessionId) {
      throw new HubError('ADAPTER_FAILURE', 'OpenCode não devolveu id de sessão', { created });
    }

    return this.#run(ctx, nativeSessionId, prompt);
  }

  async resume(ctx: RunContext, nativeSessionId: string, prompt: string): Promise<RunHandle> {
    await this.#ensureServer();

    // Não existe endpoint de resume: retomar é mandar outro prompt na mesma
    // sessão, e o servidor carrega o histórico. Confirmamos que a sessão
    // existe para falhar aqui, com mensagem clara, em vez de num 404 no meio.
    const exists = await this.#json<{ data?: { id?: string } }>(
      'GET',
      `/api/session/${nativeSessionId}`,
    ).catch(() => null);

    if (!exists?.data?.id) {
      throw new HubError(
        'SESSION_NOT_FOUND',
        `Sessão ${nativeSessionId} não existe mais no servidor do OpenCode`,
        { nativeSessionId },
      );
    }

    if (ctx.model) {
      await this.#json('POST', `/api/session/${nativeSessionId}/model`, {
        model: { providerID: 'opencode', id: ctx.model },
      }).catch(() => undefined);
    }

    return this.#run(ctx, nativeSessionId, prompt);
  }

  /**
   * Injeta mensagem no turno em andamento — o `send()` ao vivo de verdade.
   *
   * `delivery: steer` entrega ao loop corrente; é a capacidade que o adapter
   * de processo só tem quando o CLI aceita stdin interativo, e nenhum dos
   * outros sete aceita.
   */
  async send(handle: RunHandle, text: string): Promise<void> {
    const nativeId = handle.nativeSessionId;
    if (!nativeId) {
      throw new HubError('ADAPTER_FAILURE', 'run sem sessão nativa do OpenCode', {
        runId: handle.id,
      });
    }
    await this.#prompt(nativeId, text, 'steer');
  }

  /** Para o turno preservando a sessão — sem a degradação para kill do Windows. */
  async interrupt(handle: RunHandle): Promise<void> {
    if (!handle.nativeSessionId) return;
    await this.#request('POST', `/api/session/${handle.nativeSessionId}/interrupt`).catch(
      () => undefined,
    );
  }

  async cancel(handle: RunHandle): Promise<void> {
    const run = this.#runs.get(handle.id);
    if (run) run.canceled = true;
    await this.interrupt(handle);
    run?.abort.abort();
  }

  /** Derruba apenas o servidor que este adapter subiu (ADR: não mexer no alheio). */
  async close(): Promise<void> {
    for (const run of [...this.#runs.values()]) run.abort.abort();
    this.#runs.clear();

    const server = this.#ownServer;
    this.#ownServer = null;
    if (!server || server.killed) return;

    server.kill();
    if (process.platform === 'win32' && server.pid !== undefined) {
      spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { windowsHide: true });
    }
  }

  // ------------------------------------------------------------------- run

  #run(ctx: RunContext, nativeSessionId: string, prompt: string): RunHandle {
    const queue = new AsyncQueue<MappedEvent>();
    const abort = new AbortController();

    let settled = false;
    let resolveDone!: (outcome: RunOutcome) => void;
    const done = new Promise<RunOutcome>((resolve) => {
      resolveDone = resolve;
    });

    const run: RunState = {
      id: newId('run'),
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      nativeSessionId,
      startedAt: nowIso(),
      done,
      events: queue,
      supportsLiveSend: true,
      abort,
      queue,
      canceled: false,
      settle: (outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(overall);
        clearTimeout(heartbeat);
        if (poll) clearInterval(poll);
        abort.abort();
        queue.close();
        this.#runs.delete(run.id);
        resolveDone(outcome);
      },
      touch: () => {
        clearTimeout(heartbeat);
        heartbeat = setTimeout(onHeartbeat, ctx.heartbeatSeconds * 1000);
      },
      markStarted: () => {},
      recordError: (message) => {
        erroDoTurno = message;
      },
    };

    /**
     * Erro reportado pelo agente durante o turno.
     *
     * Sem isto, um turno que falhou no provedor (401, modelo inválido) sairia
     * daqui como `exit 0` — sucesso. O pipeline de resiliência então não veria
     * falha nenhuma, mandaria o resultado ao portão de validação e queimaria
     * tentativas culpando o motivo errado. Foi exatamente o que aconteceu no
     * primeiro teste real.
     */
    let erroDoTurno: string | null = null;

    const finish = (reason: RunOutcome['reason'], error: string | null): void => {
      const falhou = reason !== 'exit' || erroDoTurno !== null;
      run.settle({
        exitCode: reason === 'exit' ? (erroDoTurno === null ? 0 : 1) : null,
        signal: null,
        reason: run.canceled ? 'canceled' : reason,
        error: error ?? (falhou ? erroDoTurno : null),
        nativeSessionId,
        tail: '',
      });
    };

    const onHeartbeat = (): void =>
      finish('heartbeat', `sem eventos por ${ctx.heartbeatSeconds}s — run considerada travada`);

    const overall = setTimeout(
      () => finish('timeout', `run excedeu ${ctx.timeoutSeconds}s`),
      ctx.timeoutSeconds * 1000,
    );
    let heartbeat = setTimeout(onHeartbeat, ctx.heartbeatSeconds * 1000);
    let poll: NodeJS.Timeout | null = null;

    /**
     * Autoridade sobre o fim do turno: um turno que falha pode nunca emitir
     * `session.idle`, e quem esperasse só pelo evento ficaria até o timeout.
     *
     * A sutileza que custou caro: ausência da sessão em `/api/session/active`
     * só significa "acabou" DEPOIS de ela ter aparecido ativa alguma vez. Antes
     * disso a ausência é o loop ainda não ter começado — concluir ali encerra a
     * run antes de o modelo rodar, com zero token e ar de sucesso.
     */
    let turnoComecou = false;
    let ausencias = 0;
    let esperandoInicio = 0;

    run.markStarted = () => {
      turnoComecou = true;
      ausencias = 0;
    };

    const startPolling = (): void => {
      poll = setInterval(() => {
        void this.#json<{ data?: Record<string, unknown> }>('GET', '/api/session/active')
          .then((active) => {
            if (active.data?.[nativeSessionId] !== undefined) {
              run.markStarted();
              return;
            }

            if (!turnoComecou) {
              esperandoInicio += 1;
              if (esperandoInicio >= MAX_ESPERA_INICIO_POLLS) {
                finish('error', 'o turno nunca começou no OpenCode');
              }
              return;
            }

            ausencias += 1;
            if (ausencias >= TURN_SETTLE_POLLS) finish('exit', null);
          })
          .catch(() => {
            // Servidor sumiu no meio: falhar é mais honesto que esperar o timeout.
            finish('error', 'o servidor do OpenCode parou de responder');
          });
      }, POLL_INTERVAL_MS);
      poll.unref?.();
    };

    this.#runs.set(run.id, run);

    void (async () => {
      // O stream abre ANTES do prompt de propósito: a rota de replay por sessão
      // está quebrada na 1.17.15, então evento perdido é perdido para sempre.
      await this.#consume(run, nativeSessionId, finish);

      try {
        await this.#prompt(nativeSessionId, prompt, 'steer');
      } catch (err) {
        run.queue.push({
          type: 'error',
          payload: { message: `falha ao enviar o prompt: ${describe(err)}` },
          raw: null,
        });
        finish('error', describe(err));
        return;
      }

      // Só agora faz sentido perguntar se o turno acabou.
      startPolling();
    })();

    return run;
  }

  /** Assina o SSE global e filtra os eventos desta sessão. */
  async #consume(
    run: RunState,
    nativeSessionId: string,
    finish: (reason: RunOutcome['reason'], error: string | null) => void,
  ): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/event`, {
      headers: { Accept: 'text/event-stream' },
      signal: run.abort.signal,
    }).catch((err: unknown) => {
      finish('error', `não foi possível abrir o stream: ${describe(err)}`);
      return null;
    });

    if (!response?.body) {
      if (response) finish('error', `stream recusado: HTTP ${response.status}`);
      return;
    }

    void (async () => {
      const decoder = new TextDecoder();
      const sse = new SseDecoder();

      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          // Até o heartbeat do SSE conta como sinal de vida: o servidor está lá,
          // mesmo que esta sessão ainda não tenha falado.
          run.touch();

          for (const evento of sse.push(decoder.decode(chunk, { stream: true }))) {
            // O stream é global; sem este filtro uma sessão veria os eventos
            // das outras.
            if (openCodeSessionId(evento) !== nativeSessionId) continue;

            const mapeados = translateOpenCodeEvent(evento);
            // Qualquer evento desta sessão já prova que o loop rodou — não
            // precisamos esperar o poll confirmar.
            if (mapeados.length > 0) run.markStarted();

            for (const mapped of mapeados) {
              if (mapped.type === 'error') run.recordError(describeErrorPayload(mapped.payload));
              run.queue.push(mapped);
            }

            if (openCodeIdleSignal(evento)) finish('exit', null);
          }
        }
      } catch (err) {
        if (!run.abort.signal.aborted) finish('error', describe(err));
      }
    })();
  }

  // --------------------------------------------------------------- servidor

  async #ensureServer(): Promise<void> {
    if (await this.#healthy()) return;
    if (!this.#autoStart) {
      throw new HubError(
        'AGENT_NOT_INSTALLED',
        `Nenhum "opencode serve" respondendo em ${this.baseUrl} e autoStart está desligado`,
        { baseUrl: this.baseUrl },
      );
    }

    // Duas sessões começando juntas não podem subir dois servidores na mesma porta.
    this.#booting ??= this.#bootServer().finally(() => {
      this.#booting = null;
    });
    await this.#booting;
  }

  async #bootServer(): Promise<void> {
    const resolved = await resolveBin(this.manifest.bin);
    if (!resolved) {
      throw new HubError('AGENT_NOT_INSTALLED', `Binário "${this.manifest.bin}" não encontrado`, {
        bin: this.manifest.bin,
      });
    }

    // Sempre 127.0.0.1: o servidor avisa no boot que roda sem senha, e expor
    // isso na rede seria entregar execução de código a quem alcançar a porta.
    const args = ['serve', '--port', String(this.#port), '--hostname', '127.0.0.1'];
    const child = spawn(resolved.path, args, {
      shell: resolved.needsShell,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: false,
    });

    this.#ownServer = child;

    const limite = Date.now() + SERVER_BOOT_TIMEOUT_MS;
    while (Date.now() < limite) {
      if (await this.#healthy()) return;
      if (child.exitCode !== null) {
        throw new HubError(
          'ADAPTER_FAILURE',
          `"opencode serve" saiu com código ${child.exitCode} antes de responder`,
          { port: this.#port },
        );
      }
      await sleep(500);
    }

    await this.close();
    throw new HubError(
      'TIMEOUT',
      `"opencode serve" não respondeu em ${SERVER_BOOT_TIMEOUT_MS / 1000}s`,
      { baseUrl: this.baseUrl },
    );
  }

  async #healthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------ HTTP

  #prompt(nativeSessionId: string, text: string, delivery: 'steer' | 'queue'): Promise<unknown> {
    return this.#json('POST', `/api/session/${nativeSessionId}/prompt`, {
      prompt: { text },
      delivery,
    });
  }

  async #json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.#request(method, path, body);
    const raw = await response.text();
    return raw.length === 0 ? ({} as T) : (JSON.parse(raw) as T);
  }

  async #request(method: string, path: string, body?: unknown): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new HubError('ADAPTER_FAILURE', `OpenCode respondeu HTTP ${response.status} em ${path}`, {
        status: response.status,
        path,
        body: await response.text().catch(() => ''),
      });
    }
    return response;
  }
}

export function createOpenCodeAdapter(
  manifest: AgentManifest,
  options: OpenCodeAdapterOptions = {},
): OpenCodeAdapter {
  return new OpenCodeAdapter(manifest, options);
}

function describeErrorPayload(payload: Record<string, unknown>): string {
  const message = payload['message'];
  return typeof message === 'string' && message.length > 0
    ? message
    : 'o agente reportou erro sem mensagem';
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
