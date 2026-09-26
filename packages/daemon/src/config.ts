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
import { gravarComBackup, lerJsonDeConfig } from './safe-write.js';

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
  /** Ver `GateConfig`. Opcional só para não quebrar quem monta `HubConfig` à mão. */
  gate?: GateConfig;
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

/**
 * O que o hook do gate faz quando NÃO consegue uma resposta do daemon (fora do
 * ar, erro, resposta inválida, demora além do teto).
 *
 * - `closed`: nega toda ação de risco (shell, escrita, rede); leitura passa.
 * - `open`: libera, como se não houvesse gate.
 * - ausente (padrão): `closed` quando a chamada vem de uma sessão do Hub
 *   (o hook recebeu o id da sessão — `AGENTS_HUB_SESSION_ID` no Claude,
 *   `--session` no Codex), `open` fora dela. Uma sessão do Hub prometeu
 *   passar pela política, então o silêncio do daemon não pode virar
 *   permissão; o Claude que você abre na mão não depende do Hub estar no ar.
 *
 * Mora só na config global (`~/.agents-hub/config.json`): um repositório
 * clonado não pode afrouxar o gate de quem o abre.
 */
export interface GateConfig {
  failMode?: 'open' | 'closed';
}

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
  /**
   * Dias que `events.raw_json` sobrevive depois de a sessão dona do evento
   * terminar, antes de ser compactado (`NULL`) — não deletado.
   *
   * O ADR 06.3 decidiu "eventos para sempre", e essa decisão continua valendo
   * para `payload_json`: é o que sustenta replay, timeline e auditoria.
   * `raw_json` existe só para debugar mapper errado — não é lido no dia a
   * dia — e por isso pode ser comprimido sem violar a decisão do ADR. Mesmo
   * padrão de `worktreeDays` por default: 7 dias é tempo de sobra para
   * investigar um bug de mapper antes de o bruto sumir.
   */
  rawEventDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  worktreeDays: 7,
  sweepIntervalMinutes: 60,
  rawEventDays: 7,
};

export function defaultHome(env: NodeJS.ProcessEnv = process.env): string {
  return readHubEnv(env).AGENTS_HUB_HOME ?? path.join(os.homedir(), '.agents-hub');
}

/**
 * Raiz de onde vêm os arquivos que acompanham o Hub (manifestos, painel).
 *
 * Dois layouts, e os dois precisam funcionar:
 *
 * - clone do repositório: `packages/daemon/dist` -> raiz do repo;
 * - pacote instalado (`npm i -g agents-hub-x.y.z.tgz`, ver
 *   `scripts/pack-dist.mjs`): os pacotes internos vêm embutidos em
 *   `agents-hub/node_modules/@agents-hub/<pacote>`, e a raiz é o próprio
 *   `agents-hub/` — onde o empacotador coloca `manifests/` e `web/`.
 *
 * Antes só existia o primeiro: instalado fora do clone, "três níveis acima"
 * caía em `node_modules/` e o daemon subia sem manifestos e sem painel.
 */
export function installRoot(daemonDist: string = path.dirname(fileURLToPath(import.meta.url))): string {
  const pacote = path.resolve(daemonDist, '..');
  const escopo = path.dirname(pacote);
  if (
    path.basename(escopo) === '@agents-hub' &&
    path.basename(path.dirname(escopo)) === 'node_modules'
  ) {
    return path.dirname(path.dirname(escopo));
  }
  // dist/ -> packages/daemon -> packages -> raiz do repo
  return path.resolve(pacote, '..', '..');
}

/** Manifestos que vêm com o Hub, quando o usuário não tem os seus. */
function bundledManifestsDir(): string {
  return path.join(installRoot(), 'manifests');
}

function bundledWebRoot(): string {
  const raiz = installRoot();
  // Pacote instalado: `web/`. Clone: o `dist` do workspace da Web UI.
  const empacotado = path.join(raiz, 'web');
  if (existsSync(path.join(empacotado, 'index.html'))) return empacotado;
  return path.join(raiz, 'packages', 'web', 'dist');
}

/**
 * Entrada da CLI (`bin.js`) — o mesmo arquivo que `hub hooks install claude`
 * registra e que o `hub` do PATH executa.
 *
 * O gate do Codex não se instala numa config de usuário (ADR: ver
 * `codex-gate.ts`); o Hub monta o comando do hook a cada invocação, e para
 * isso precisa saber onde a própria CLI mora. `@agents-hub/cli` é irmão deste
 * pacote nos dois layouts (`packages/cli` no clone,
 * `node_modules/@agents-hub/cli` no pacote instalado), então o caminho sai
 * relativo a este arquivo, sem depender de onde o repositório foi clonado.
 *
 * `bin.js` e não `main.js`: é o `bin.js` que passa `--experimental-sqlite`
 * quando o Node precisa (22.5–22.12) e silencia o `ExperimentalWarning`.
 */
export function cliHookEntrypoint(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'cli', 'dist', 'bin.js');
}

/** Executável do MCP server do Hub (o que `hub mcp install` registra nos CLIs). */
export function mcpServerEntrypoint(): string {
  // Relativo ao pacote do daemon, como `cliHookEntrypoint`: vale no clone
  // (packages/daemon/dist → packages/mcp/dist) e instalado pelo tarball
  // (node_modules/@agents-hub/daemon/dist → node_modules/@agents-hub/mcp/dist).
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'mcp', 'dist', 'main.js');
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
        rawEventDays: z.number().optional(),
      })
      .optional(),
    codexGate: z
      .object({
        bypassHookTrust: z.boolean().optional(),
      })
      .optional(),
    gate: z
      .object({
        failMode: z.enum(['open', 'closed']).optional(),
      })
      .optional(),
  })
  .passthrough();

type HubConfigOnDisk = z.infer<typeof HubConfigOnDiskSchema>;

/**
 * Linha e coluna (1-based) de uma posição num texto — o `JSON.parse` do V8 só
 * diz "at position 57", e ninguém conta caracteres num arquivo de config.
 */
export function linhaEColuna(texto: string, posicao: number): { linha: number; coluna: number } {
  const antes = texto.slice(0, Math.max(0, Math.min(posicao, texto.length)));
  const linhas = antes.split(/\n/);
  return { linha: linhas.length, coluna: (linhas[linhas.length - 1] ?? '').length + 1 };
}

/**
 * Mensagem de JSON inválido com caminho, linha e coluna.
 *
 * Exportada para teste. Sem posição reconhecível na mensagem do V8 (ex.:
 * arquivo vazio, "Unexpected end of JSON input"), aponta o fim do arquivo —
 * que é onde o parser desistiu.
 */
export function mensagemDeJsonInvalido(arquivo: string, texto: string, erro: Error): string {
  const posicao = /position (\d+)/.exec(erro.message);
  const onde = linhaEColuna(texto, posicao ? Number(posicao[1]) : texto.length);
  // O V8 às vezes acrescenta "(line X column Y)" por conta própria; tirar evita
  // dizer a mesma coisa duas vezes, em dois idiomas.
  const motivo = erro.message.replace(/\s*\(line \d+ column \d+\)/, '');
  return `${arquivo}:${onde.linha}:${onde.coluna}: não é JSON válido (linha ${onde.linha}, coluna ${onde.coluna}) — ${motivo}`;
}

function readOnDiskConfig(configFile: string): HubConfigOnDisk {
  if (!existsSync(configFile)) return {};

  // BOM do Bloco de Notas não é erro de quem escreveu o arquivo.
  const texto = readFileSync(configFile, 'utf8').replace(/^﻿/, '');
  let raw: unknown;
  try {
    raw = JSON.parse(texto);
  } catch (err) {
    throw new HubError(
      'HUB_CONFIG_INVALID',
      mensagemDeJsonInvalido(configFile, texto, err as Error),
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

/**
 * Config efetiva: padrões < `config.json` < variáveis de ambiente < overrides.
 *
 * `AGENTS_HUB_PORT` entra AQUI, e não só em `hub daemon`: antes, só o daemon
 * lia a variável, e todo o resto da CLI (cliente, autostart, `hub mcp`,
 * hook) falava com a porta do `config.json`/4747. Com a variável definida, o
 * autostart subia o daemon numa porta e a CLI ficava 30 s sondando a outra.
 * Variável malformada (`AGENTS_HUB_PORT=abc`) lança `HubError` — nunca `NaN`.
 */
export function loadConfig(
  overrides: Partial<HubConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): HubConfig {
  const hubEnv = readHubEnv(env);
  const home = overrides.home ?? hubEnv.AGENTS_HUB_HOME ?? path.join(os.homedir(), '.agents-hub');
  const configFile = path.join(home, 'config.json');

  const onDisk = readOnDiskConfig(configFile);
  const doAmbiente: Partial<HubConfig> =
    hubEnv.AGENTS_HUB_PORT !== undefined ? { port: hubEnv.AGENTS_HUB_PORT } : {};

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
    ...doAmbiente,
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
    gate: {
      ...(onDisk.gate ?? {}),
      ...(overrides.gate ?? {}),
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

/**
 * Liga `codexGate.bypassHookTrust` no `config.json` do home do Hub mexendo SÓ
 * nessa chave.
 *
 * `saveConfig({...config})` serializava a config EFETIVA inteira (política com
 * todos os defaults, caminhos absolutos do repo): o arquivo do usuário virava
 * um snapshot que congelava defaults futuros, e o original era sobrescrito sem
 * backup. Aqui: lê o JSON cru, recusa o que não parseia (sem gravar), backup
 * versionado e escrita atômica; já ligado -> nada é gravado.
 */
export function ligarBypassDoGateCodex(
  home: string,
  agora: Date = new Date(),
): { path: string; action: 'created' | 'merged' | 'unchanged'; backup: string | null } {
  const file = path.join(home, 'config.json');
  const existed = existsSync(file);
  const { doc } = lerJsonDeConfig(file);
  const gate = doc['codexGate'];
  if (gate !== undefined && (gate === null || typeof gate !== 'object' || Array.isArray(gate))) {
    throw new Error(`${file}: "codexGate" não é um objeto. Nada foi gravado.`);
  }
  const atual = (gate ?? {}) as Record<string, unknown>;
  if (atual['bypassHookTrust'] === true) return { path: file, action: 'unchanged', backup: null };
  doc['codexGate'] = { ...atual, bypassHookTrust: true };
  const backup = gravarComBackup(file, `${JSON.stringify(doc, null, 2)}\n`, agora);
  return { path: file, action: existed ? 'merged' : 'created', backup };
}

/** Endereço base do daemon, usado por CLI, TUI e Web UI. */
export function baseUrl(config: Pick<HubConfig, 'host' | 'port'>): string {
  return `http://${config.host}:${config.port}`;
}
