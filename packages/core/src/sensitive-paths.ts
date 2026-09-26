/**
 * Caminhos sensíveis embutidos na política (ADR 03, achados 1.2 da vistoria).
 *
 * Dois tipos, com regras diferentes:
 * - `secret`: o CONTEÚDO é o segredo (chave SSH, `.env`, token de CLI).
 *   Ler já é o dano — vazar não se desfaz —, então vale para leitura E escrita.
 * - `exec-config`: arquivo que vira execução de código ou afrouxa controle
 *   (hooks do git, workflow de CI, settings de agente, config do próprio Hub).
 *   Ler é inofensivo; escrever é plantar código que roda depois, sem aprovação.
 *
 * O casamento é por SEGMENTO de caminho, não por substring: `.environment/` e
 * `process.env` não são `.env`. Os separadores incluem `:`, `=` e `@` para
 * pegar formas como `HEAD:.env`, `--env-file=.env` e `curl -d @.env`.
 *
 * Esta lista não é configurável de propósito: é o piso. A política do usuário
 * ACRESCENTA fragmentos (`paths.denyFragments`), nunca remove estes.
 */

import path from 'node:path';

export type SensitiveKind = 'secret' | 'exec-config';

export interface SensitiveMatch {
  kind: SensitiveKind;
  label: string;
}

/** Diretórios cujo conteúdo inteiro é segredo. */
const SECRET_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.azure']);

/** Nomes de arquivo que são segredo onde quer que estejam. */
const SECRET_BASENAMES = new Set([
  '.env',
  '.envrc',
  '.npmrc',
  '.yarnrc.yml',
  '.pypirc',
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.pgpass',
  'credentials',
  'credentials.json',
  '.credentials.json',
  // Token de operador do próprio Hub (item 1.6): quem o lê aprova as próprias ações.
  'operator-token',
]);

/** Sufixos de `.env.<x>` que são modelo, não segredo. */
const ENV_TEMPLATE_SUFFIXES = new Set(['example', 'sample', 'template', 'dist', 'defaults']);

const SECRET_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.ppk', '.jks', '.keystore'];

/** Pares diretório/arquivo (ou diretório/subdiretório) que guardam credencial de CLI. */
const SECRET_PAIRS: Array<[string, string, string]> = [
  ['.claude', '.credentials.json', 'credencial do Claude Code'],
  ['.codex', 'auth.json', 'credencial do Codex'],
  ['.docker', 'config.json', 'credencial do Docker'],
  ['.kube', 'config', 'credencial do Kubernetes'],
  ['gh', 'hosts.yml', 'token do GitHub CLI'],
  ['.config', 'gcloud', 'credencial do gcloud'],
];

/** Arquivos que viram execução ou mudam controles quando escritos. */
const EXEC_CONFIG_PAIRS: Array<[string, string, string]> = [
  ['.git', 'hooks', 'hooks do git'],
  ['.git', 'config', 'config do git'],
  ['.github', 'workflows', 'workflow de CI'],
  ['.claude', 'settings.json', 'settings do Claude Code'],
  ['.claude', 'settings.local.json', 'settings do Claude Code'],
  ['.codex', 'config.toml', 'config do Codex'],
];

const EXEC_CONFIG_DIRS = new Set(['.husky', '.agents-hub']);

const EXEC_CONFIG_BASENAMES = new Set([
  '.mcp.json',
  '.gitlab-ci.yml',
  '.pre-commit-config.yaml',
  '.gitconfig',
  '.bashrc',
  '.zshrc',
  '.profile',
  '.bash_profile',
  '.bash_login',
  'microsoft.powershell_profile.ps1',
  'profile.ps1',
]);

/** Nomes canônicos usados para testar padrões com curinga (`.env*`, `*.pem`). */
const GLOB_PROBES = [
  '.env',
  '.env.local',
  '.env.production',
  'id_rsa',
  'id_ed25519',
  'server.pem',
  'server.key',
  '.npmrc',
  '.netrc',
  '.git-credentials',
  'credentials',
  '.credentials.json',
];

export function pathSegments(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/["']/g, '')
    .split(/[\\/:=@]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '.');
}

function isSecretBasename(b: string): string | null {
  if (SECRET_BASENAMES.has(b)) return b;
  if (b.startsWith('.env.')) {
    const suffix = b.slice('.env.'.length);
    return ENV_TEMPLATE_SUFFIXES.has(suffix) ? null : '.env';
  }
  if (/^id_(rsa|dsa|ecdsa|ed25519)(_sk)?(?!.*\.pub$)/.test(b)) return 'chave privada SSH';
  const ext = SECRET_EXTENSIONS.find((e) => b.endsWith(e) && b.length > e.length);
  if (ext) return `arquivo de chave (${ext})`;
  return null;
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (const ch of glob) {
    if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function secretByGlob(b: string): string | null {
  if (!/[*?]/.test(b)) return null;
  // `*` sozinho não indica nada; precisa de parte literal (`.env*`, `*.pem`).
  if (b.replace(/[*?[\]]/g, '').length === 0) return null;
  const re = globToRegExp(b.replace(/[[\]]/g, ''));
  // Curinga no início não casa arquivo oculto no bash.
  const probe = GLOB_PROBES.find((p) => re.test(p) && !(p.startsWith('.') && /^[*?]/.test(b)));
  return probe ? `curinga que alcança ${probe}` : null;
}

function hasPair(segs: string[], pairs: Array<[string, string, string]>): string | null {
  for (let k = 0; k + 1 < segs.length; k++) {
    for (const [dir, file, label] of pairs) {
      if (segs[k] === dir && segs[k + 1] === file) return label;
    }
  }
  return null;
}

/**
 * Classifica um caminho (absoluto, relativo, com `~`, `%USERPROFILE%`,
 * `$HOME`... — só os segmentos importam). `null` = nada sensível.
 */
export function matchSensitivePath(raw: string): SensitiveMatch | null {
  const segs = pathSegments(raw);
  if (segs.length === 0) return null;
  const base = segs[segs.length - 1]!;

  const dir = segs.find((s) => SECRET_DIRS.has(s));
  if (dir) return { kind: 'secret', label: dir };
  const pair = hasPair(segs, SECRET_PAIRS);
  if (pair) return { kind: 'secret', label: pair };
  const bn = isSecretBasename(base) ?? secretByGlob(base);
  if (bn) return { kind: 'secret', label: bn };

  const cfg = hasPair(segs, EXEC_CONFIG_PAIRS);
  if (cfg) return { kind: 'exec-config', label: cfg };
  const cfgDir = segs.find((s) => EXEC_CONFIG_DIRS.has(s));
  if (cfgDir) return { kind: 'exec-config', label: cfgDir };
  if (EXEC_CONFIG_BASENAMES.has(base)) return { kind: 'exec-config', label: base };

  return null;
}

/** Só os segredos (o que importa para leitura). */
export function matchSecretPath(raw: string): SensitiveMatch | null {
  const m = matchSensitivePath(raw);
  return m?.kind === 'secret' ? m : null;
}

/**
 * Diretórios onde o PRÓPRIO agente grava artefatos de trabalho que não afetam
 * o projeto nem o sistema — hoje, o plano do modo plan do Claude Code
 * (`~/.claude/plans/*.md`, visto na vistoria 11). Escrever ali não pede
 * aprovação: antes, o supervised do Claude parava no primeiro turno de
 * qualquer pedido só porque o Claude gravou o plano dele, e aprovação inútil
 * treina o usuário a aprovar sem ler.
 *
 * Só agentes com o caminho comprovado entram. `CLAUDE_CONFIG_DIR` move a
 * pasta de config do Claude Code, então é respeitado.
 */
export function agentOwnDirs(
  agentId: string,
  homeDir: string,
  env: Readonly<Record<string, string | undefined>> = {},
): string[] {
  switch (agentId) {
    case 'claude': {
      const configDir = env['CLAUDE_CONFIG_DIR'] || path.join(homeDir, '.claude');
      return [path.join(configDir, 'plans')];
    }
    default:
      return [];
  }
}

/**
 * Casa um fragmento configurável (`paths.denyFragments`) respeitando fronteira
 * de segmento: `.env` casa `.env` e `.env.local`, mas não `.environment`.
 * `path` deve vir normalizado (minúsculo, `/`).
 */
export function fragmentMatches(normalizedPath: string, fragment: string): boolean {
  const f = fragment.trim().toLowerCase().replaceAll('\\', '/');
  if (f.length === 0) return false;
  const p = `/${normalizedPath}`;
  let idx = p.indexOf(f);
  while (idx >= 0) {
    const before = p[idx - 1];
    const after = p[idx + f.length];
    const okBefore = f.startsWith('/') || before === '/';
    const okAfter = f.endsWith('/') || after === undefined || after === '/' || after === '.';
    if (okBefore && okAfter) return true;
    idx = p.indexOf(f, idx + 1);
  }
  return false;
}
