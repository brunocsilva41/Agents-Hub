import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_POLICY, type PolicyDocument } from '@agents-hub/core';

export interface HubConfig {
  /** Raiz do estado global do Hub. Multiprojeto vive aqui (ADR 05.2). */
  home: string;
  dbFile: string;
  worktreeRoot: string;
  logDir: string;
  manifestsDir: string;
  host: string;
  port: number;
  policy: PolicyDocument;
}

export function defaultHome(): string {
  return process.env['AGENTS_HUB_HOME'] ?? path.join(os.homedir(), '.agents-hub');
}

/** Manifestos que vêm com o repositório, quando o usuário não tem os seus. */
function bundledManifestsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/ -> packages/daemon -> packages -> raiz do repo
  return path.resolve(here, '..', '..', '..', 'manifests');
}

export function loadConfig(overrides: Partial<HubConfig> = {}): HubConfig {
  const home = overrides.home ?? defaultHome();
  const configFile = path.join(home, 'config.json');

  const onDisk = existsSync(configFile)
    ? (JSON.parse(readFileSync(configFile, 'utf8')) as Partial<HubConfig>)
    : {};

  const userManifests = path.join(home, 'manifests');
  const config: HubConfig = {
    home,
    dbFile: path.join(home, 'hub.db'),
    worktreeRoot: path.join(home, 'worktrees'),
    logDir: path.join(home, 'logs'),
    manifestsDir: existsSync(userManifests) ? userManifests : bundledManifestsDir(),
    host: '127.0.0.1',
    port: 4747,
    ...onDisk,
    ...overrides,
    // A política nunca é substituída inteira por acidente: campos ausentes no
    // arquivo do usuário caem no padrão, que é o lado seguro.
    policy: { ...DEFAULT_POLICY, ...(onDisk.policy ?? {}), ...(overrides.policy ?? {}) },
  };

  mkdirSync(config.home, { recursive: true });
  mkdirSync(config.worktreeRoot, { recursive: true });
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
