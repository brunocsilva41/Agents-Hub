import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  newId,
  nowIso,
  type AgentDiscovery,
  type EventCost,
  type EventType,
  type Session,
} from '@agents-hub/core';
import { createHub, type Hub, type HubDeps } from '@agents-hub/daemon';
import { HubClient } from './client.js';

/**
 * Apoio dos testes dos comandos do item 5.6: daemon isolado (home
 * temporário, porta própria, sem autostart) e repositórios git temporários.
 * Não é teste por si (não termina em `.test.ts`).
 */

/**
 * `port: 0` não basta: a guarda de borda compara o `Host` da requisição com
 * `config.port`, que só é conhecido depois do `listen`. Reservamos uma porta
 * livre antes de montar o Hub (mesma técnica de `pause-cmd.test.ts`).
 */
export function portaLivre(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const endereco = srv.address();
      const porta = typeof endereco === 'object' && endereco ? endereco.port : 0;
      srv.close(() => resolve(porta));
    });
  });
}

export interface HubDeTeste {
  hub: Hub;
  raiz: string;
  url: string;
  /** Cliente COM o token de operador. */
  client: HubClient;
  fechar(): Promise<void>;
}

export function descobertaFalsa(id: string, over: Partial<AgentDiscovery> = {}): AgentDiscovery {
  return {
    agentId: id,
    installed: true,
    version: '1.0.0',
    binPath: `/bin/${id}`,
    auth: { state: 'present', evidence: [] },
    defaults: {},
    files: [],
    mcpServers: [],
    instructionFiles: [],
    warnings: [],
    ...over,
  };
}

export async function montarHub(
  prefixo: string,
  opts: { raiz?: string; porta?: number; deps?: HubDeps } = {},
): Promise<HubDeTeste> {
  const raiz = opts.raiz ?? mkdtempSync(path.join(os.tmpdir(), `hub-cli-${prefixo}-`));
  const manifestos = path.join(raiz, 'manifests');
  mkdirSync(manifestos, { recursive: true });
  const hub = createHub(
    {
      home: path.join(raiz, 'home'),
      manifestsDir: manifestos,
      webRoot: path.join(raiz, 'sem-web'),
      port: opts.porta ?? (await portaLivre()),
    },
    {
      homeDir: path.join(raiz, 'user-home'),
      discoverAgent: async (id) => descobertaFalsa(id, { installed: false }),
      ...opts.deps,
    },
  );
  // Nunca `process.exit` dentro do processo de teste: `POST /shutdown` só
  // derruba este Hub.
  hub.server.onShutdown = async () => {
    await hub.shutdown();
  };
  const { host, port } = await hub.start();
  const url = `http://${host}:${port}`;
  let fechado = false;
  return {
    hub,
    raiz,
    url,
    client: new HubClient(url, { token: hub.operatorToken }),
    async fechar() {
      if (!fechado) {
        fechado = true;
        try {
          await hub.shutdown();
        } catch {
          /* já encerrado pela rota */
        }
      }
    },
  };
}

export function limpar(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* limpeza de temp é oportunista */
  }
}

export function semearSessao(hub: Hub, projectId: string, over: Partial<Session> = {}): Session {
  const id = over.id ?? newId('ses');
  const session: Session = {
    id,
    projectId,
    agentId: 'claude',
    parentId: null,
    rootId: id,
    depth: 0,
    path: [`claude:${id}`],
    state: 'completed',
    mode: 'semi',
    isolation: 'worktree',
    workdir: path.join(os.tmpdir(), 'nao-existe', id),
    nativeSessionId: null,
    title: 'sessão de teste',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    endedAt: nowIso(),
    pid: null,
    ...over,
  };
  hub.store.sessions.create(session);
  return session;
}

let seqGlobal = 0;
export function semearEvento(
  hub: Hub,
  session: Session,
  type: EventType,
  payload: Record<string, unknown> = {},
  cost: EventCost | null = null,
): void {
  seqGlobal += 1;
  hub.store.events.append({
    id: newId('evt'),
    seq: seqGlobal,
    ts: nowIso(),
    sessionId: session.id,
    taskId: null,
    agentId: session.agentId,
    type,
    payload,
    cost,
    raw: { original: true },
  });
}

/** Registra `patch` como o diff capturado da sessão (o que `hub diff` mostra). */
export function semearDiff(hub: Hub, session: Session, patch: string): string {
  const dir = path.join(hub.config.artifactRoot, session.id);
  mkdirSync(dir, { recursive: true });
  const arquivo = path.join(dir, 'diff.patch');
  writeFileSync(arquivo, patch, 'utf8');
  hub.store.artifacts.create({
    id: newId('art'),
    sessionId: session.id,
    taskId: null,
    kind: 'diff',
    path: arquivo,
    hash: null,
    createdAt: nowIso(),
  });
  return arquivo;
}

/** Captura `console.log`/`console.error` durante `fn`. */
export async function capturar<T>(
  fn: () => Promise<T>,
): Promise<{ out: string[]; err: string[]; valor: T }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => void out.push(a.map(String).join(' '));
  console.error = (...a: unknown[]) => void err.push(a.map(String).join(' '));
  try {
    const valor = await fn();
    return { out, err, valor };
  } finally {
    console.log = log;
    console.error = error;
  }
}

/** Repositório git temporário com um commit inicial em `main`. */
export function repoGit(dir: string): (...argv: string[]) => string {
  mkdirSync(dir, { recursive: true });
  const git = (...argv: string[]): string =>
    execFileSync('git', argv, {
      cwd: dir,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'teste@example.com');
  git('config', 'user.name', 'Teste');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  return git;
}
