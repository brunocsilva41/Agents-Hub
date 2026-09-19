import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { HubError, newId, nowIso } from '@agents-hub/core';
import { AsyncQueue } from '../async-queue.js';
import { quoteForShell, resolveBin } from '../bin-resolver.js';
import { killProcessTree } from '../process-tree.js';
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

  /**
   * `env` com que o servidor atualmente no ar foi (ou seria) subido — só para
   * detectar e avisar quando uma sessão SEGUINTE pede um ambiente diferente.
   * Ver aviso em `#ensureServer`: o Hub NÃO resolve esse conflito, só o expõe.
   */
  #bootEnv: Record<string, string> | null = null;

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
    await this.#ensureServer(ctx);

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
    await this.#ensureServer(ctx);

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
    this.#bootEnv = null;
    if (!server || server.killed) return;

    await killServerTree(server);
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
      // Sempre null: a sessão roda num servidor HTTP compartilhado, não num
      // processo filho dedicado — ver comentário em `RunHandle.pid`.
      pid: null,
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

  async #ensureServer(ctx: RunContext): Promise<void> {
    if (await this.#healthy()) {
      this.#warnEnvMismatch(ctx.env);
      return;
    }
    if (!this.#autoStart) {
      throw new HubError(
        'AGENT_NOT_INSTALLED',
        `Nenhum "opencode serve" respondendo em ${this.baseUrl} e autoStart está desligado`,
        { baseUrl: this.baseUrl },
      );
    }

    // Duas sessões começando juntas não podem subir dois servidores na mesma porta.
    this.#booting ??= this.#bootServer(ctx.env).finally(() => {
      this.#booting = null;
    });
    await this.#booting;
  }

  /**
   * O servidor é UM SÓ, compartilhado por todas as sessões deste adapter — não
   * há um `opencode serve` por projeto. Ele só lê variáveis de ambiente (ex.:
   * `OPENAI_BASE_URL`, chaves de API) na hora do próprio `spawn`, então só a
   * PRIMEIRA sessão a subir o servidor consegue de fato influenciar o
   * provedor/modelo por ambiente — sessões seguintes de projetos com um
   * `ProjectContext.env` DIFERENTE não têm efeito nenhum sobre um servidor já
   * no ar, e não há aviso nenhum na hora sem este log.
   *
   * Isto não é resolvido aqui: resolver de verdade exigiria um servidor por
   * config (custo de boot medido em ~20s no Windows, multiplicado por projeto)
   * ou uma forma da API aceitar credencial por sessão — nenhuma das duas
   * existe hoje em `opencode serve` (ver `docs/referencias/opencode-api.md`
   * §5: nem `model`, nem qualquer coisa de ambiente, é aceito por requisição).
   * Só avisamos no log do daemon, para o operador não gastar horas achando que
   * a config por projeto está valendo.
   */
  #warnEnvMismatch(requested: Record<string, string>): void {
    if (this.#bootEnv === null) return;
    const diffKeys = Object.keys(requested).filter((k) => requested[k] !== this.#bootEnv?.[k]);
    if (diffKeys.length === 0) return;
    console.error(
      `[opencode] servidor já está no ar com outro ambiente; ${diffKeys.join(', ')} desta sessão ` +
        `NÃO terá efeito (opencode serve é um processo único e compartilhado — ver caveats de manifests/opencode.yaml)`,
    );
  }

  async #bootServer(env: Record<string, string>): Promise<void> {
    const resolved = await resolveBin(this.manifest.bin);
    if (!resolved) {
      throw new HubError('AGENT_NOT_INSTALLED', `Binário "${this.manifest.bin}" não encontrado`, {
        bin: this.manifest.bin,
      });
    }

    // Sempre 127.0.0.1: o servidor avisa no boot que roda sem senha, e expor
    // isso na rede seria entregar execução de código a quem alcançar a porta.
    const args = ['serve', '--port', String(this.#port), '--hostname', '127.0.0.1'];
    // Sem isto, `shell: true` concatena o caminho e os args SEM escapar — e
    // `resolveBin` resolve `.cmd` do npm em `%APPDATA%\npm\...`, que no
    // Windows quase sempre tem espaço (`C:\Users\Nome Sobrenome\...`). Medido
    // contra o binário real desta máquina: sem `quoteForShell`, o cmd.exe lia
    // "C:\Users\Bruno" como comando e o resto como argumento solto, e o
    // "opencode serve" nunca chegava a existir — o autostart do OpenCode
    // falhava sempre que o perfil do usuário tivesse espaço no caminho.
    // `ctx.env` (config de provedor/modelo por projeto, já filtrada por
    // `filtrarEnvDeProjeto` antes de chegar aqui) só tem efeito para QUEM sobe
    // o servidor — ver `#warnEnvMismatch` sobre o que acontece quando outra
    // sessão pede um ambiente diferente depois.
    const spawnEnv = { ...process.env, ...env };
    const child = spawn(
      resolved.needsShell ? quoteForShell(resolved.path) : resolved.path,
      resolved.needsShell ? args.map(quoteForShell) : args,
      {
        env: spawnEnv,
        shell: resolved.needsShell,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: false,
      },
    );

    this.#ownServer = child;
    this.#bootEnv = { ...env };

    // Se o spawn falhar (binário resolvido mas sem permissão de execução,
    // por exemplo), o ChildProcess emite `'error'` sem `'close'` — sem este
    // listener é exceção não tratada, e sem capturá-lo o loop abaixo só
    // descobriria o problema esperando o timeout inteiro de 60s.
    let spawnError: string | null = null;
    child.on('error', (err) => {
      spawnError = err.message;
    });

    // `pipe` sem leitor enche o buffer do SO (~64 KB) e o "opencode serve"
    // BLOQUEIA na escrita em stderr — o processo congela, e leva junto toda
    // sessão OpenCode que o Hub estiver rodando. Drenar não é conveniência de
    // diagnóstico aqui, é o que impede o travamento.
    if (child.stderr) {
      createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', (line) => {
        if (line.trim().length > 0) console.error(`[opencode serve] ${line}`);
      });
    }

    const limite = Date.now() + SERVER_BOOT_TIMEOUT_MS;
    while (Date.now() < limite) {
      if (await this.#healthy()) return;
      if (spawnError !== null) {
        throw new HubError('ADAPTER_FAILURE', `falha ao subir "opencode serve": ${spawnError}`, {
          port: this.#port,
        });
      }
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

/**
 * `server.kill()` sozinho só derruba o `cmd.exe` do shim no Windows — o
 * `node.exe` real do "opencode serve" sobrevive, reparentado, e continua
 * servindo na porta. Mesma classe de achado já corrigida em
 * `process-adapter.ts`, lógica compartilhada agora em `killProcessTree`
 * (`../process-tree.js`). Medido matando na ordem errada: `server.kill()`
 * primeiro derruba o `cmd.exe` na hora, e quando o `taskkill /T` roda em
 * seguida o pai já não existe mais para o Windows andar a árvore a partir
 * dele — o `node.exe` fica órfão e vivo. `/T /F` precisa ser o ÚNICO
 * mecanismo, com o pai ainda de pé.
 */
function killServerTree(server: ChildProcess): Promise<void> {
  if (server.pid === undefined) return Promise.resolve();
  return killProcessTree(server.pid, () => server.kill('SIGKILL'));
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
