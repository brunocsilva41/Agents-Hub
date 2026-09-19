import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  DEFAULT_POLICY,
  HubError,
  mergePolicyLayer,
  PartialPolicyDocumentSchema,
  type PolicyDocument,
} from '@agents-hub/core';
import { readHubEnv } from './env.js';

export interface HubConfig {
  /** Raiz do estado global do Hub. Multiprojeto vive aqui (ADR 05.2). */
  home: string;
  dbFile: string;
  worktreeRoot: string;
  /** Onde ficam diffs e demais saídas materiais das sessões. */
  artifactRoot: string;
  logDir: string;
  manifestsDir: string;
  host: string;
  port: number;
  /** Estáticos da Web UI. Servida pelo próprio daemon: um processo só (ADR 05.3). */
  webRoot: string;
  retention: RetentionPolicy;
  /**
   * Porta do `opencode serve`. Separada da do Hub de propósito: se o usuário já
   * tem um servidor do OpenCode no ar, o adapter reaproveita em vez de subir
   * outro — e derrubar um servidor alheio no shutdown seria invasivo.
   */
  opencodePort: number;
  policy: PolicyDocument;
  codexGate: CodexGateConfig;
  /**
   * Teto de conexões SSE simultâneas (`/events` + `/api/tasks/:id/events`).
   *
   * Sem isto, nada impede um cliente com bug (ou um scanner) de abrir
   * conexões sem limite — cada uma com seu próprio keep-alive e fila, todas
   * competindo pelo mesmo processo Node. Acima do teto, a rota responde 503
   * em vez de aceitar mais uma conexão que o daemon não tem como atender bem.
   * Generoso por padrão: uso real é CLI + Web UI + no máximo alguns peers.
   */
  maxSseConnections: number;
}

export interface CodexGateConfig {
  /**
   * Liga o gate pré-execução do Codex. Sem isto o Codex roda sem prevenção —
   * ver `packages/daemon/src/codex-gate.ts` para o porquê de não haver padrão.
   *
   * Precisa ser escolha explícita do usuário nesta máquina: por isso mora
   * SÓ na config global (`~/.agents-hub/config.json`), nunca em
   * `<repo>/.agents-hub/config.yaml` — um repositório clonado não pode ligar
   * sozinho um bypass de revisão de hook.
   */
  bypassHookTrust: boolean;
}

export const DEFAULT_CODEX_GATE: CodexGateConfig = {
  bypassHookTrust: false,
};

export const DEFAULT_MAX_SSE_CONNECTIONS = 100;

export interface RetentionPolicy {
  /**
   * Dias que o worktree de uma sessão encerrada continua no disco (ADR 06.3).
   *
   * Apagar na hora que a sessão termina — como fazíamos antes — destrói
   * justamente o que você quer olhar: o estado em que o agente deixou as
   * coisas. O branch `hub/<sessionId>` sobrevive à limpeza de qualquer forma,
   * então nada de trabalho se perde; o que expira é só o checkout.
   */
  worktreeDays: number;
  /** Intervalo entre passadas do coletor, em minutos. */
  sweepIntervalMinutes: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  worktreeDays: 7,
  sweepIntervalMinutes: 60,
};

export function defaultHome(): string {
  return readHubEnv().AGENTS_HUB_HOME ?? path.join(os.homedir(), '.agents-hub');
}

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/ -> packages/daemon -> packages -> raiz do repo
  return path.resolve(here, '..', '..', '..');
}

/** Manifestos que vêm com o repositório, quando o usuário não tem os seus. */
function bundledManifestsDir(): string {
  return path.join(repoRoot(), 'manifests');
}

function bundledWebRoot(): string {
  return path.join(repoRoot(), 'packages', 'web', 'dist');
}

/**
 * `main.js` da CLI — mesmo binário que `hub hooks install claude` já registra.
 *
 * O gate do Codex não se instala numa config de usuário (ADR: ver
 * `codex-gate.ts`); o Hub monta o comando do hook a cada invocação, e para
 * isso precisa saber onde a própria CLI mora, do mesmo jeito que já sabe onde
 * moram os manifestos e a Web UI.
 */
export function cliHookEntrypoint(): string {
  return path.join(repoRoot(), 'packages', 'cli', 'dist', 'main.js');
}

/**
 * Valida `config.json` ANTES do merge com os padrões.
 *
 * Sem `.strict()` no nível superior de propósito: um `config.json` gravado por
 * uma versão anterior do Hub pode ter chaves que esta versão não conhece mais,
 * e recusar a subida do daemon por isso quebraria o upgrade. `policy` valida
 * campo a campo via `PartialPolicyDocumentSchema` pelo mesmo motivo.
 */
const HubConfigOnDiskSchema = z
  .object({
    home: z.string().min(1).optional(),
    dbFile: z.string().min(1).optional(),
    worktreeRoot: z.string().min(1).optional(),
    artifactRoot: z.string().min(1).optional(),
    logDir: z.string().min(1).optional(),
    manifestsDir: z.string().min(1).optional(),
    host: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    webRoot: z.string().min(1).optional(),
    opencodePort: z.number().int().min(1).max(65535).optional(),
    maxSseConnections: z.number().int().min(1).max(100_000).optional(),
    policy: PartialPolicyDocumentSchema.optional(),
    retention: z
      .object({
        worktreeDays: z.number().optional(),
        sweepIntervalMinutes: z.number().optional(),
      })
      .optional(),
    codexGate: z
      .object({
        bypassHookTrust: z.boolean().optional(),
      })
      .optional(),
  })
  .passthrough();

type HubConfigOnDisk = z.infer<typeof HubConfigOnDiskSchema>;

function readOnDiskConfig(configFile: string): HubConfigOnDisk {
  if (!existsSync(configFile)) return {};

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configFile, 'utf8'));
  } catch (err) {
    throw new HubError(
      'HUB_CONFIG_INVALID',
      `${configFile} não é JSON válido: ${(err as Error).message}`,
      { path: configFile },
    );
  }

  const parsed = HubConfigOnDiskSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`);
    throw new HubError(
      'HUB_CONFIG_INVALID',
      `${configFile} é inválido — ${issues.join('; ')}`,
      { path: configFile, issues },
    );
  }
  return parsed.data;
}

export function loadConfig(overrides: Partial<HubConfig> = {}): HubConfig {
  const home = overrides.home ?? defaultHome();
  const configFile = path.join(home, 'config.json');

  const onDisk = readOnDiskConfig(configFile);

  const userManifests = path.join(home, 'manifests');
  const config: HubConfig = {
    home,
    dbFile: path.join(home, 'hub.db'),
    worktreeRoot: path.join(home, 'worktrees'),
    artifactRoot: path.join(home, 'artifacts'),
    logDir: path.join(home, 'logs'),
    manifestsDir: existsSync(userManifests) ? userManifests : bundledManifestsDir(),
    host: '127.0.0.1',
    port: 4747,
    webRoot: bundledWebRoot(),
    opencodePort: 4790,
    maxSseConnections: DEFAULT_MAX_SSE_CONNECTIONS,
    ...onDisk,
    ...overrides,
    // A política nunca é substituída inteira por acidente: campos ausentes no
    // arquivo do usuário (ou nos overrides) caem no padrão, que é o lado
    // seguro — inclusive dentro de objetos aninhados como `validation.review`.
    policy: mergePolicyLayer(
      mergePolicyLayer(DEFAULT_POLICY, onDisk.policy ?? {}),
      overrides.policy ?? {},
    ),
    retention: {
      ...DEFAULT_RETENTION,
      ...(onDisk.retention ?? {}),
      ...(overrides.retention ?? {}),
    },
    codexGate: {
      ...DEFAULT_CODEX_GATE,
      ...(onDisk.codexGate ?? {}),
      ...(overrides.codexGate ?? {}),
    },
  };

  mkdirSync(config.home, { recursive: true });
  mkdirSync(config.worktreeRoot, { recursive: true });
  mkdirSync(config.artifactRoot, { recursive: true });
  mkdirSync(config.logDir, { recursive: true });

  return config;
}

export function saveConfig(config: HubConfig): void {
  mkdirSync(config.home, { recursive: true });
  const { home: _home, ...serializable } = config;
  writeFileSync(
    path.join(config.home, 'config.json'),
    `${JSON.stringify(serializable, null, 2)}\n`,
    'utf8',
  );
}

/** Endereço base do daemon, usado por CLI, TUI e Web UI. */
export function baseUrl(config: Pick<HubConfig, 'host' | 'port'>): string {
  return `http://${config.host}:${config.port}`;
}
