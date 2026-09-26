import os from 'node:os';
import path from 'node:path';
import type { RiskLevel } from './policy.js';
import { matchSecretPath } from './sensitive-paths.js';
import {
  type ShellRedirect,
  type ShellSegment,
  type ShellWord,
  ShellParseError,
  SUBST_PLACEHOLDER,
  parseShell,
} from './shell-tokenizer.js';

/**
 * Classificador de risco de comando de shell (achado 1.1 da vistoria).
 *
 * Regras, em ordem de importância:
 * 1. O comando é tokenizado (`shell-tokenizer.ts`) e CADA segmento é
 *    classificado; vale o PIOR. `git status && git push` é `git push`.
 * 2. Redirecionamento de escrita é escrita no alvo (`echo x > .env` escreve
 *    em `.env`); de leitura, leitura (`< ~/.ssh/id_rsa`).
 * 3. Wrappers e interpretadores são desembrulhados e o conteúdo reclassificado
 *    (`bash -c`, `cmd /c`, `powershell -Command`, `env`, `xargs`, `npx`...).
 *    Código inline de linguagem (`node -e`, `python -c`) é `exec` no mínimo,
 *    sobe para `escalate` se usa API de processo/arquivo/rede, e para
 *    `irreversible` se menciona segredo.
 * 4. Opções globais do git (`-C`, `-c`, `--git-dir`...) são puladas antes de
 *    achar o subcomando; formas longas de flag destrutiva contam
 *    (`rm --recursive`, `git branch --delete --force`).
 * 5. Na dúvida — não tokenizável, comando dinâmico (`$CMD args`), script
 *    lido da entrada padrão — nunca `allow`: vira `escalate`.
 *
 * A allow/deny list da política casa por PALAVRA (token), não por prefixo de
 * string: `cat` não casa `catalog`, `node` não casa `nodemon`.
 */

export interface CommandVerdict {
  risk: RiskLevel;
  reason: string;
  /** Casou a deny list: a decisão é `deny`, independente de modo e de `policy.risk`. */
  denied?: boolean;
}

/** O que o classificador precisa saber da política e do contexto. */
export interface CommandPolicyView {
  workdir: string;
  allow: readonly string[];
  deny: readonly string[];
  allowDomains: readonly string[];
  /** Classifica escrita num caminho ABSOLUTO (mesma regra da ferramenta Write). */
  classifyWrite(absPath: string): CommandVerdict;
  /** Classifica leitura num caminho ABSOLUTO (segredo = irreversible). */
  classifyRead(absPath: string): CommandVerdict;
}

const RANK: Record<RiskLevel, number> = {
  read: 0,
  write: 1,
  exec: 2,
  escalate: 3,
  budget: 4,
  irreversible: 5,
};

const MAX_DEPTH = 8;

function v(risk: RiskLevel, reason: string): CommandVerdict {
  return { risk, reason };
}

/** O pior de dois vereditos. Deny list vence tudo; empate fica com o primeiro. */
export function worstVerdict(a: CommandVerdict, b: CommandVerdict): CommandVerdict {
  if (a.denied) return a;
  if (b.denied) return b;
  return RANK[b.risk] > RANK[a.risk] ? b : a;
}

/** Palavra já reduzida a uma leitura (bash OU cmd/PowerShell). */
interface Arg {
  t: string;
  quoted: boolean;
  dynamic: boolean;
}

// ---------------------------------------------------------------------------
// Tabelas
// ---------------------------------------------------------------------------

/** Comandos que só leem — quando também estão na allow list, o risco é `read`. */
const READ_ONLY = new Set([
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'echo',
  'printf', 'wc', 'which', 'where', 'tree', 'sort', 'uniq', 'cut', 'diff', 'jq', 'stat', 'file',
  'du', 'df', 'sed', 'awk', 'get-childitem', 'gci', 'get-content', 'gc', 'select-string', 'sls',
  'get-item', 'test-path', 'resolve-path', 'write-output', 'write-host', 'get-command', 'whoami',
  'date', 'basename', 'dirname', 'realpath', 'readlink', 'nl', 'tac', 'column', 'fd', 'ag',
]);

/** Builtins sem efeito colateral — risco `read` mesmo fora da allow list. */
const SAFE_BUILTINS = new Set([
  'cd', 'pwd', 'true', 'false', ':', 'test', '[', '[[', ']]', 'read', 'set', 'shift', 'local',
  'declare', 'typeset', 'unset', 'return', 'exit', 'wait', 'sleep', 'start-sleep', 'set-location',
  'sl', 'get-location', 'push-location', 'pop-location', 'pushd', 'popd', 'cls', 'clear',
  'shopt', 'setlocal', 'endlocal', 'chcp', 'title', 'rem', '@echo',
  // Cmdlets de pipeline do PowerShell que só transformam/formatam objetos.
  'format-table', 'ft', 'format-list', 'fl', 'format-wide', 'select-object', 'select',
  'where-object', 'measure-object', 'measure', 'sort-object', 'group-object', 'out-string',
  'out-null', 'out-host', 'convertto-json', 'convertfrom-json', 'get-location', 'test-path',
]);

/** Cmdlets cujo bloco é predicado/expressão, não comando. */
const PS_PREDICATE = new Set([
  'where-object', 'where', '?', 'sort-object', 'select-object', 'group-object', 'measure-object',
]);

/** Palavras de controle: removidas antes de classificar o resto do segmento. */
const CONTROL_WORDS = new Set([
  '{', '}', 'then', 'else', 'do', 'done', 'fi', 'esac', '!', 'if', 'elif', 'while', 'until',
  'time', 'coproc',
]);

/** Comandos cujos argumentos são dado, não caminho — ficam fora da varredura de segredo. */
const DATA_ONLY = new Set(['echo', 'printf', 'write-host', 'write-output', 'write-error', 'rem']);

/** Variáveis de ambiente que sequestram a execução de outro comando. */
const HIJACK_VARS =
  /^(PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_\w+|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONSTARTUP|BASH_ENV|ENV|PROMPT_COMMAND|GIT_SSH|GIT_SSH_COMMAND|GIT_EXEC_PATH|GIT_CONFIG\w*|GIT_DIR|GIT_WORK_TREE|PERL5OPT|RUBYOPT|ZDOTDIR|IFS)$/i;

/** Regras irreversíveis por palavras (subsequência entre os argumentos posicionais). */
const IRREVERSIBLE_RULES: Array<{ cmd: string; seq: string[]; label: string }> = [
  { cmd: 'npm', seq: ['publish'], label: 'publicação de pacote' },
  { cmd: 'npm', seq: ['unpublish'], label: 'remoção de pacote publicado' },
  { cmd: 'pnpm', seq: ['publish'], label: 'publicação de pacote' },
  { cmd: 'yarn', seq: ['publish'], label: 'publicação de pacote' },
  { cmd: 'bun', seq: ['publish'], label: 'publicação de pacote' },
  { cmd: 'cargo', seq: ['publish'], label: 'publicação de crate' },
  { cmd: 'twine', seq: ['upload'], label: 'publicação de pacote' },
  { cmd: 'gem', seq: ['push'], label: 'publicação de gem' },
  { cmd: 'dotnet', seq: ['nuget', 'push'], label: 'publicação de pacote' },
  { cmd: 'docker', seq: ['rm'], label: 'remoção de container' },
  { cmd: 'docker', seq: ['rmi'], label: 'remoção de imagem' },
  { cmd: 'docker', seq: ['prune'], label: 'limpeza do docker' },
  { cmd: 'docker', seq: ['volume', 'rm'], label: 'remoção de volume' },
  { cmd: 'kubectl', seq: ['delete'], label: 'remoção no cluster' },
  { cmd: 'terraform', seq: ['apply'], label: 'mudança de infraestrutura' },
  { cmd: 'terraform', seq: ['destroy'], label: 'destruição de infraestrutura' },
  { cmd: 'gh', seq: ['pr', 'merge'], label: 'merge de PR' },
  { cmd: 'gh', seq: ['release', 'create'], label: 'criação de release' },
  { cmd: 'gh', seq: ['release', 'delete'], label: 'remoção de release' },
  { cmd: 'gh', seq: ['repo', 'delete'], label: 'remoção de repositório' },
  { cmd: 'gcloud', seq: ['delete'], label: 'remoção na nuvem' },
  { cmd: 'az', seq: ['delete'], label: 'remoção na nuvem' },
  { cmd: 'shred', seq: [], label: 'destruição de arquivo' },
  { cmd: 'remove-item', seq: [], label: 'remoção (Remove-Item)' },
  { cmd: 'ri', seq: [], label: 'remoção (Remove-Item)' },
  // Qualquer chamada à AWS CLI mexe em infraestrutura real e cobrada.
  { cmd: 'aws', seq: [], label: 'AWS CLI' },
];

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'ash', 'mksh', 'busybox']);
const NETWORK = new Set([
  'curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'http', 'https', 'xh',
  'aria2c',
]);

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

export function classifyCommand(
  command: string,
  view: CommandPolicyView,
  depth = 0,
): CommandVerdict {
  if (depth > MAX_DEPTH) return v('escalate', 'comando aninhado demais para classificar');
  const text = command.trim();
  if (text.length === 0) return v('read', 'comando vazio');

  let segments: ShellSegment[];
  try {
    segments = parseShell(text);
  } catch (err) {
    const msg = err instanceof ShellParseError ? err.message : String(err);
    return v('escalate', `comando não tokenizável (${msg}) — na dúvida, não libera`);
  }
  if (segments.length === 0) return v('read', 'comando sem efeito (só comentário)');

  let pior: CommandVerdict | null = null;
  let piorSeg: ShellSegment | null = null;
  for (const seg of segments) {
    const r = classifySegment(seg, view, depth);
    const novo: CommandVerdict = pior === null ? r : worstVerdict(pior, r);
    if (novo !== pior) {
      pior = novo;
      piorSeg = seg;
    }
  }
  if (pior === null) return v('read', 'comando sem efeito');
  if (segments.length > 1 && piorSeg) {
    return { ...pior, reason: `${pior.reason} [em "${segmentText(piorSeg)}"]` };
  }
  return pior;
}

function segmentText(seg: ShellSegment): string {
  const t = seg.words.map((w) => w.posix.replaceAll(SUBST_PLACEHOLDER, '$(...)')).join(' ');
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
}

// ---------------------------------------------------------------------------
// Segmento
// ---------------------------------------------------------------------------

function classifySegment(seg: ShellSegment, view: CommandPolicyView, depth: number): CommandVerdict {
  let r: CommandVerdict = v('read', 'só redirecionamento');
  if (seg.words.length > 0) {
    // As duas leituras (bash e cmd/PowerShell): vale a pior.
    const posix = seg.words.map((w) => toArg(w, 'posix'));
    const win = seg.words.map((w) => toArg(w, 'win'));
    r = classifyArgv(posix, view, depth);
    if (win.some((a, k) => a.t !== posix[k]!.t)) r = worstVerdict(r, classifyArgv(win, view, depth));
  }
  for (const red of seg.redirects) r = worstVerdict(r, classifyRedirect(red, view));
  return r;
}

function toArg(w: ShellWord, reading: 'posix' | 'win'): Arg {
  return { t: reading === 'posix' ? w.posix : w.win, quoted: w.quoted, dynamic: w.dynamic };
}

const WRITE_OPS = new Set(['>', '>>', '>|', '&>', '&>>', '>&', '<>']);
const READ_OPS = new Set(['<', '<>', '<&']);
const NULL_DEVICES = new Set(['/dev/null', 'nul', '$null', '/dev/stderr', '/dev/stdout', '/dev/tty', 'con']);

function classifyRedirect(red: ShellRedirect, view: CommandPolicyView): CommandVerdict {
  if (!red.target) return v('read', 'redirecionamento sem arquivo');
  let r: CommandVerdict = v('read', 'redirecionamento');
  for (const t of uniq([red.target.posix, red.target.win])) {
    if (NULL_DEVICES.has(t.toLowerCase())) continue;
    if (WRITE_OPS.has(red.op)) {
      r = worstVerdict(r, writeTarget(t, red.target.dynamic, view, `redirecionamento "${red.op}"`));
    }
    if (READ_OPS.has(red.op)) r = worstVerdict(r, readTarget(t, view));
  }
  return r;
}

/** Resolve um argumento de caminho contra o workdir, expandindo o diretório do usuário. */
export function resolveArgPath(raw: string, workdir: string): { abs: string; unresolved: boolean } {
  const home = os.homedir();
  let t = raw.replaceAll(SUBST_PLACEHOLDER, '__subst__');
  t = t.replace(/^~(?=$|[\\/])/, home);
  t = t.replace(/^(\$HOME|\$\{HOME\}|\$env:USERPROFILE|\$env:HOME|%USERPROFILE%|%HOMEPATH%)(?=$|[\\/])/i, home);
  const unresolved = /\$|%\w+%|__subst__/.test(t);
  return { abs: path.resolve(workdir, t), unresolved };
}

function writeTarget(raw: string, dynamic: boolean, view: CommandPolicyView, via: string): CommandVerdict {
  const { abs, unresolved } = resolveArgPath(raw, view.workdir);
  const r = view.classifyWrite(abs);
  if ((unresolved || dynamic) && RANK[r.risk] < RANK.escalate) {
    return v('escalate', `${via}: alvo de escrita dinâmico (${raw.replaceAll(SUBST_PLACEHOLDER, '$(...)')})`);
  }
  return { ...r, reason: `${via}: ${r.reason}` };
}

function readTarget(raw: string, view: CommandPolicyView): CommandVerdict {
  const secret = matchSecretPath(raw);
  if (secret) return v('irreversible', `leitura de segredo (${secret.label})`);
  const { abs } = resolveArgPath(raw, view.workdir);
  return view.classifyRead(abs);
}

// ---------------------------------------------------------------------------
// Comando simples
// ---------------------------------------------------------------------------

/** Nome normalizado: base do caminho, minúsculo, sem `.exe/.cmd/.bat/.com`. */
export function commandName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? raw;
  let n = base.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
  if (/^python\d+(\.\d+)*$/.test(n) || n === 'py') n = 'python';
  if (/^pip\d+(\.\d+)*$/.test(n)) n = 'pip';
  return n;
}

function isFlag(a: Arg): boolean {
  return a.t.length > 1 && a.t.startsWith('-');
}

function classifyArgv(argv0: Arg[], view: CommandPolicyView, depth: number): CommandVerdict {
  let argv = argv0;

  // Atribuições iniciais `VAR=x cmd`.
  let assignRisk: CommandVerdict = v('read', 'atribuição de variável');
  while (argv.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]!.t) && !argv[0]!.quoted) {
    const name = argv[0]!.t.split('=')[0]!;
    if (HIJACK_VARS.test(name)) {
      assignRisk = v('escalate', `variável ${name} altera o que o comando executa`);
    }
    argv = argv.slice(1);
  }
  if (argv.length === 0) return assignRisk;
  return worstVerdict(classifySimple(argv, view, depth), assignRisk);
}

function classifySimple(argv: Arg[], view: CommandPolicyView, depth: number): CommandVerdict {
  const first = argv[0]!;
  const name = commandName(first.t);
  const args = argv.slice(1);

  // Atribuição do PowerShell: `$x = <expr>` ou `$env:X = ...`.
  if (/^\$[\w:]+$/.test(first.t) && args[0]?.t === '=') {
    const varName = first.t.replace(/^\$(env:)?/i, '');
    const rest = args.slice(1);
    let r: CommandVerdict = HIJACK_VARS.test(varName)
      ? v('escalate', `variável ${varName} altera o que o comando executa`)
      : v('read', 'atribuição de variável');
    // Lado direito que começa com nome de comando é chamada de comando.
    if (rest.length > 0 && !rest[0]!.quoted && /^[A-Za-z][\w.-]*$/.test(rest[0]!.t)) {
      r = worstVerdict(r, classifyArgv(rest, view, depth));
    }
    return r;
  }

  if (first.dynamic || first.t.includes(SUBST_PLACEHOLDER)) {
    return v('escalate', 'nome do comando é dinâmico — não dá para saber o que roda');
  }

  // Deny list: vale a palavra, em qualquer nível de desembrulho.
  const denied = matchList(view.deny, name, args);
  if (denied) return { risk: 'irreversible', reason: `comando na deny list (${denied})`, denied: true };

  if (CONTROL_WORDS.has(name)) {
    return args.length > 0 ? classifyArgv(args, view, depth) : v('read', 'palavra de controle');
  }
  if (name === 'for' || name === 'case' || name === 'select' || name === 'foreach') {
    return v('read', 'cabeçalho de laço');
  }

  const especifico = classifySpecific(name, argv, view, depth);
  const base = especifico ?? classifyByLists(name, argv, view);
  return worstVerdict(worstVerdict(base, secretScan(name, args)), scriptBlock(name, args, view, depth));
}

/** Allow list → exec (ou read se o comando só lê); fora dela → escalate. */
function classifyByLists(name: string, argv: Arg[], view: CommandPolicyView): CommandVerdict {
  if (SAFE_BUILTINS.has(name)) return v('read', `builtin sem efeito (${name})`);
  const args = argv.slice(1);
  const allowed = matchList(view.allow, name, args);
  if (allowed) {
    return READ_ONLY.has(name) || isReadOnlyGit(name, args)
      ? v('read', `comando só de leitura na allow list (${allowed})`)
      : v('exec', `comando na allow list (${allowed})`);
  }
  return v('escalate', `comando fora da allow list (${name})`);
}

/**
 * Casa uma entrada de lista por palavra: `git status` casa `git status -s`,
 * mas `cat` não casa `catalog`. `mkfs` casa `mkfs.ext4`.
 */
function matchList(list: readonly string[], name: string, args: Arg[]): string | null {
  for (const entry of list) {
    const toks = entry.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (toks.length === 0) continue;
    const head = commandName(toks[0]!);
    if (!(name === head || name.startsWith(`${head}.`))) continue;
    let ok = true;
    for (let k = 1; k < toks.length; k++) {
      if (args[k - 1]?.t.toLowerCase() !== toks[k]) {
        ok = false;
        break;
      }
    }
    if (ok) return entry.trim();
  }
  return null;
}

/**
 * Bloco `{ ... }` do PowerShell (`ForEach-Object { Remove-Item $_ }`) ou grupo
 * do bash: o conteúdo é comando e é classificado como tal. Expansão de chaves
 * (`src/{a,b}`) fica numa palavra só e não entra aqui.
 */
function scriptBlock(name: string, args: Arg[], view: CommandPolicyView, depth: number): CommandVerdict {
  const k = args.findIndex(
    (a) => !a.quoted && a.t.startsWith('{') && !(a.t.length > 1 && a.t.endsWith('}') && !a.t.includes(' ')),
  );
  if (k < 0) return v('read', 'sem bloco');
  const inner: Arg[] = [];
  for (const a of args.slice(k)) {
    let t = a.t;
    if (inner.length === 0 && t.startsWith('{')) t = t.slice(1);
    const fecha = t.endsWith('}');
    if (fecha) t = t.slice(0, -1);
    if (t.length > 0) inner.push({ ...a, t });
    if (fecha) break;
  }
  if (inner.length === 0) return v('read', 'bloco vazio');
  // Predicado/expressão de cmdlet de filtro (`Where-Object { $_.Length -gt 0 }`):
  // começa em variável, não em comando. Em `ForEach-Object` NÃO — lá
  // `$_.Delete()` é efeito colateral, e fica o `escalate` de comando dinâmico.
  if (PS_PREDICATE.has(name) && inner[0]!.t.startsWith('$')) return v('read', 'predicado de filtro');
  return depth + 1 > MAX_DEPTH
    ? v('escalate', 'comando aninhado demais para classificar')
    : classifyArgv(inner, view, depth + 1);
}

/** Argumento que aponta para segredo = leitura de segredo (`cat ~/.ssh/id_rsa`). */
function secretScan(name: string, args: Arg[]): CommandVerdict {
  if (DATA_ONLY.has(name)) return v('read', 'sem segredo');
  for (const a of args) {
    const m = matchSecretPath(a.t);
    if (m) return v('irreversible', `acesso a segredo (${m.label})`);
  }
  return v('read', 'sem segredo');
}

// ---------------------------------------------------------------------------
// Regras específicas por comando. `null` = sem regra: cai na allow list.
// ---------------------------------------------------------------------------

function classifySpecific(
  name: string,
  argv: Arg[],
  view: CommandPolicyView,
  depth: number,
): CommandVerdict | null {
  const args = argv.slice(1);

  const irr = IRREVERSIBLE_RULES.find((rule) => rule.cmd === name && hasSubsequence(args, rule.seq));
  if (irr) return v('irreversible', `comando com efeito irreversível (${irr.label})`);

  switch (name) {
    case 'sudo':
    case 'doas':
    case 'gsudo':
    case 'runas':
      return worstVerdict(
        v('escalate', `elevação de privilégio (${name})`),
        unwrap(skipFlags(args, new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-U'])), view, depth),
      );
    case 'env':
      return classifyEnv(args, view, depth);
    case 'command':
    case 'builtin':
    case 'exec':
    case 'nohup':
    case 'chronic':
    case 'unbuffer':
    case 'call':
      return unwrap(skipFlags(args, new Set()), view, depth);
    case 'nice':
    case 'ionice':
      return unwrap(skipFlags(args, new Set(['-n', '-c', '--adjustment'])), view, depth);
    case 'timeout': {
      const rest = skipFlags(args, new Set(['-s', '--signal', '-k', '--kill-after']));
      return unwrap(rest.slice(1), view, depth);
    }
    case 'stdbuf':
      return unwrap(skipFlags(args, new Set()), view, depth);
    case 'xargs': {
      const rest = skipFlags(
        args,
        new Set(['-n', '-I', '-i', '-P', '-d', '-L', '-E', '-s', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file']),
      );
      return rest.length === 0 ? v('read', 'xargs sem comando (echo)') : unwrap(rest, view, depth);
    }
    case 'npx':
    case 'bunx':
    case 'pnpx':
      return classifyNpx(args, view, depth);
    case 'pnpm':
    case 'yarn':
    case 'npm':
      if (args[0] && ['exec', 'dlx', 'x'].includes(args[0].t.toLowerCase())) {
        return classifyNpx(args.slice(1), view, depth);
      }
      return null;
    case 'eval':
      return worstVerdict(
        v('exec', 'eval'),
        classifyCommand(args.map((a) => a.t).join(' '), view, depth + 1),
      );
    case 'iex':
    case 'invoke-expression':
      return worstVerdict(
        v('escalate', 'Invoke-Expression executa texto como código'),
        classifyCommand(args.map((a) => a.t).join(' '), view, depth + 1),
      );
    case 'source':
    case '.':
      return v('escalate', 'executa script no shell atual');
    case 'cmd':
      return classifyCmdExe(args, view, depth);
    case 'powershell':
    case 'pwsh':
      return classifyPwsh(args, view, depth);
    case 'wsl':
      return classifyWsl(args, view, depth);
    case 'start':
    case 'start-process':
    case 'saps':
      return classifyStart(name, args, view, depth);
    case 'git':
      return classifyGit(argv, view);
    case 'rm':
      return classifyRm(args, view);
    case 'del':
    case 'erase':
      return classifyDel(args, view);
    case 'rd':
    case 'rmdir':
      return classifyRmdir(args, view);
    case 'find':
      return classifyFind(argv, view, depth);
    case 'sed':
      return classifySed(argv, view);
    case 'awk':
    case 'gawk':
    case 'mawk':
      return classifyAwk(argv, view);
    case 'sort':
      return classifyOutputFlag(argv, view, new Set(['-o', '--output']));
    case 'rg':
      if (args.some((a) => /^--pre(=|$)/.test(a.t))) {
        return v('escalate', 'rg --pre executa um comando por arquivo');
      }
      return null;
    case 'dd':
      return classifyDd(args, view);
  }

  if (SHELLS.has(name)) return classifyShell(name, args, view, depth);
  if (NETWORK.has(name)) return classifyNetwork(name, args, view);
  const code = classifyInterpreter(name, args, view, depth);
  if (code) return code;
  return classifyWriteCommand(name, args, view);
}

function hasSubsequence(args: Arg[], seq: string[]): boolean {
  let k = 0;
  for (const a of args) {
    if (k >= seq.length) break;
    if (!isFlag(a) && a.t.toLowerCase() === seq[k]) k++;
  }
  return k >= seq.length;
}

/** Pula flags (e os valores das que recebem valor) até o primeiro argumento posicional. */
function skipFlags(args: Arg[], withValue: Set<string>): Arg[] {
  let i = 0;
  while (i < args.length) {
    const t = args[i]!.t;
    if (t === '--') return args.slice(i + 1);
    if (!t.startsWith('-') || t === '-') break;
    i += withValue.has(t) ? 2 : 1;
  }
  return args.slice(i);
}

function unwrap(rest: Arg[], view: CommandPolicyView, depth: number): CommandVerdict {
  if (rest.length === 0) return v('read', 'wrapper sem comando');
  if (depth + 1 > MAX_DEPTH) return v('escalate', 'comando aninhado demais para classificar');
  return classifyArgv(rest, view, depth + 1);
}

function classifyEnv(args: Arg[], view: CommandPolicyView, depth: number): CommandVerdict {
  let i = 0;
  let r: CommandVerdict = v('read', 'env');
  while (i < args.length) {
    const t = args[i]!.t;
    if (t === '-S' || t === '--split-string') {
      const s = args[i + 1]?.t ?? '';
      return worstVerdict(r, classifyCommand(`${s} ${args.slice(i + 2).map((a) => a.t).join(' ')}`, view, depth + 1));
    }
    if (t === '-u' || t === '--unset' || t === '-C' || t === '--chdir') {
      i += 2;
      continue;
    }
    if (t.startsWith('-')) {
      i++;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      const name = t.split('=')[0]!;
      if (HIJACK_VARS.test(name)) r = v('escalate', `variável ${name} altera o que o comando executa`);
      i++;
      continue;
    }
    break;
  }
  const rest = args.slice(i);
  // `env` sozinho imprime o ambiente — onde moram chaves de API.
  if (rest.length === 0) return worstVerdict(r, v('escalate', 'env sem comando expõe variáveis de ambiente'));
  return worstVerdict(r, unwrap(rest, view, depth));
}

function classifyNpx(args: Arg[], view: CommandPolicyView, depth: number): CommandVerdict {
  const rest = skipFlags(args, new Set(['-p', '--package', '-c', '--call']));
  const call = args.findIndex((a) => a.t === '-c' || a.t === '--call');
  if (call >= 0) {
    return worstVerdict(v('exec', 'npx -c'), classifyCommand(args[call + 1]?.t ?? '', view, depth + 1));
  }
  if (rest.length === 0) return v('escalate', 'npx sem comando');
  return worstVerdict(v('exec', 'npx'), unwrap(rest, view, depth));
}

// --- interpretadores de shell ---------------------------------------------

function classifyShell(
  name: string,
  args: Arg[],
  view: CommandPolicyView,
  depth: number,
): CommandVerdict | null {
  let rest = args;
  if (name === 'busybox') {
    // `busybox sh -c ...` / `busybox rm -rf ...`
    return unwrap(args, view, depth);
  }
  let i = 0;
  let commandMode = false;
  let stdin = false;
  while (i < rest.length) {
    const t = rest[i]!.t;
    if (t === '--') {
      i++;
      break;
    }
    if (!/^[-+]/.test(t) || t.length === 1) break;
    if (t === '-o' || t === '+o' || t === '-O' || t === '+O' || t === '--rcfile' || t === '--init-file') {
      i += 2;
      continue;
    }
    if (t === '-c' || t === '--command' || (/^-[A-Za-z]+$/.test(t) && t.includes('c'))) commandMode = true;
    if (/^-[A-Za-z]*s[A-Za-z]*$/.test(t)) stdin = true;
    i++;
  }
  rest = rest.slice(i);
  if (commandMode) {
    const code = rest[0]?.t;
    if (code === undefined) return v('escalate', `${name} -c sem comando`);
    return worstVerdict(v('exec', `${name} -c`), classifyCommand(code, view, depth + 1));
  }
  if (stdin || rest.length === 0) {
    return v('escalate', `${name} executando comandos recebidos pela entrada padrão`);
  }
  // Script em arquivo: não dá para ver o conteúdo daqui — a allow list decide
  // (`bash scripts/test.sh` só passa se estiver lá; senão, escalate).
  return null;
}

function classifyCmdExe(args: Arg[], view: CommandPolicyView, depth: number): CommandVerdict {
  const idx = args.findIndex((a) => /^\/[ck]$/i.test(a.t));
  if (idx < 0) {
    // `/c` colado ao comando: `cmd /c"del x"` já vira `/cdel x` numa palavra.
    const glued = args.find((a) => /^\/[ck]./i.test(a.t));
    if (glued) {
      const inner = [glued.t.slice(2), ...args.slice(args.indexOf(glued) + 1).map((a) => a.t)].join(' ');
      return worstVerdict(v('exec', 'cmd /c'), classifyCommand(inner, view, depth + 1));
    }
    return v('escalate', 'cmd sem /c: shell interativo');
  }
  const inner = args.slice(idx + 1).map((a) => a.t).join(' ');
  if (inner.trim().length === 0) return v('escalate', 'cmd /c sem comando');
  return worstVerdict(v('exec', 'cmd /c'), classifyCommand(inner, view, depth + 1));
}

function classifyPwsh(args: Arg[], view: CommandPolicyView, depth: number): CommandVerdict {
  const withValue = ['-executionpolicy', '-ep', '-ex', '-windowstyle', '-w', '-inputformat', '-if',
    '-outputformat', '-of', '-o', '-version', '-v', '-configurationname', '-workingdirectory', '-wd',
    '-settingsfile', '-psconsolefile', '-custompipename'];
  let i = 0;
  while (i < args.length) {
    const t = args[i]!.t.toLowerCase();
    if (!t.startsWith('-') && !t.startsWith('/')) break;
    const flag = t.replace(/^\//, '-');
    if (flag === '-encodedcommand' || flag === '-enc' || flag === '-e' || flag === '-ec' || /^-en/.test(flag)) {
      const decoded = decodePwshBase64(args[i + 1]?.t ?? '');
      if (decoded === null) return v('escalate', 'powershell -EncodedCommand ilegível');
      return worstVerdict(
        v('escalate', 'powershell -EncodedCommand esconde o comando'),
        classifyCommand(decoded, view, depth + 1),
      );
    }
    if (flag === '-file' || flag === '-f') return v('escalate', 'powershell -File executa script');
    if (flag === '-command' || flag === '-c' || /^-com/.test(flag)) {
      const inner = args.slice(i + 1).map((a) => a.t).join(' ');
      if (inner.trim() === '-' || inner.trim() === '') {
        return v('escalate', 'powershell lendo comandos da entrada padrão');
      }
      return worstVerdict(v('exec', 'powershell -Command'), classifyCommand(inner, view, depth + 1));
    }
    i += withValue.includes(flag) ? 2 : 1;
  }
  const rest = args.slice(i);
  if (rest.length === 0) return v('escalate', 'powershell interativo/entrada padrão');
  if (/\.ps1$/i.test(rest[0]!.t)) return v('escalate', 'powershell executa script');
  return worstVerdict(
    v('exec', 'powershell'),
    classifyCommand(rest.map((a) => a.t).join(' '), view, depth + 1),
  );
}

function decodePwshBase64(b64: string): string | null {
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) return null;
  try {
    const txt = Buffer.from(b64, 'base64').toString('utf16le');
    return txt.length > 0 ? txt : null;
  } catch {
    return null;
  }
}

function classifyWsl(args: Arg[], view: CommandPolicyView, depth: number): CommandVerdict {
  const withValue = new Set(['-d', '--distribution', '-u', '--user', '--cd', '--shell-type']);
  let i = 0;
  while (i < args.length) {
    const t = args[i]!.t;
    if (t === '-e' || t === '--exec' || t === '--') {
      i++;
      break;
    }
    if (!t.startsWith('-')) break;
    i += withValue.has(t) ? 2 : 1;
  }
  const rest = args.slice(i);
  if (rest.length === 0) return v('escalate', 'wsl interativo');
  return worstVerdict(v('exec', 'wsl'), unwrap(rest, view, depth));
}

function classifyStart(name: string, args: Arg[], view: CommandPolicyView, depth: number): CommandVerdict {
  let r: CommandVerdict = v('exec', name);
  if (args.some((a, k) => /^-verb$/i.test(a.t) && /^runas$/i.test(args[k + 1]?.t ?? ''))) {
    r = v('escalate', 'elevação de privilégio (-Verb RunAs)');
  }
  const positional: string[] = [];
  let argList = '';
  for (let k = 0; k < args.length; k++) {
    const t = args[k]!.t;
    if (/^-(filepath|verb|workingdirectory|windowstyle|redirectstandard\w+)$/i.test(t)) {
      if (/^-filepath$/i.test(t)) positional.unshift(args[k + 1]?.t ?? '');
      k++;
      continue;
    }
    if (/^-argumentlist$/i.test(t)) {
      argList = args[k + 1]?.t ?? '';
      k++;
      continue;
    }
    if (/^[-/]/.test(t)) continue;
    positional.push(t);
  }
  const inner = [...positional, argList].filter(Boolean).join(' ').replaceAll(',', ' ');
  if (inner.trim().length === 0) return v('escalate', `${name} sem alvo`);
  return worstVerdict(r, classifyCommand(inner, view, depth + 1));
}

// --- interpretadores de linguagem -----------------------------------------

/** Uso de API que muda o mundo fora do processo: processo, arquivo, rede, eval. */
const DANGER_API =
  /child_process|\bexec(Sync|File|FileSync)?\s*\(|\bspawn(Sync)?\s*\(|\bfork\s*\(|\b(rm|rmdir|unlink|rename|writeFile|appendFile|copyFile|cp|truncate|chmod|chown|symlink|link|mkdir|mkdtemp)(Sync)?\s*\(|createWriteStream|\bfetch\s*\(|require\(\s*['"](node:)?(https?|net|dgram|tls|http2)['"]|\beval\s*\(|new\s+Function|process\.kill|\bos\.(system|remove|unlink|rmdir|removedirs|rename|renames|replace|makedirs|mkdir|chmod|chown|popen|exec\w*|spawn\w*|kill)\b|subprocess|shutil|\bPopen|open\s*\([^)]*,\s*['"][^'"]*[wax+]|urllib|requests\.|http\.client|socket|\.write_(text|bytes)\s*\(|\.unlink\s*\(|\bsystem\s*\(|`|File\.(write|delete|open)|FileUtils|IO\.popen|Deno\.(run|remove|writeTextFile|writeFile|Command)|Bun\.(spawn|write|\$)|\bimport\s*\(|__import__|importlib/;

/** Uso de API de processo: aí os literais de string provavelmente são comandos. */
const PROCESS_API =
  /child_process|\bexec(Sync|File|FileSync)?\s*\(|\bspawn(Sync)?\s*\(|\bos\.(system|popen|exec\w*|spawn\w*)|subprocess|\bPopen|\bsystem\s*\(|IO\.popen|Deno\.(run|Command)|Bun\.(spawn|\$)|`/;

interface InterpreterSpec {
  /** Flags que recebem código inline. */
  codeFlags: string[];
  /** Subcomando que recebe código (`deno eval`). */
  codeSub?: string;
}

const INTERPRETERS: Record<string, InterpreterSpec> = {
  node: { codeFlags: ['-e', '--eval', '-p', '--print', '-pe', '-ep'] },
  bun: { codeFlags: ['-e', '--eval', '-p', '--print'] },
  deno: { codeFlags: [], codeSub: 'eval' },
  python: { codeFlags: ['-c'] },
  ruby: { codeFlags: ['-e'] },
  perl: { codeFlags: ['-e', '-E'] },
  php: { codeFlags: ['-r'] },
  rscript: { codeFlags: ['-e'] },
  osascript: { codeFlags: ['-e'] },
};

function classifyInterpreter(
  name: string,
  args: Arg[],
  view: CommandPolicyView,
  depth: number,
): CommandVerdict | null {
  const spec = INTERPRETERS[name];
  if (!spec) return null;

  let code: string | null = null;
  let hasScript = false;
  for (let k = 0; k < args.length; k++) {
    const t = args[k]!.t;
    if (spec.codeSub && k === 0 && t === spec.codeSub) {
      code = args.slice(1).map((a) => a.t).join(' ');
      break;
    }
    const eq = spec.codeFlags.find((f) => f.startsWith('--') && t.startsWith(`${f}=`));
    if (eq) {
      code = t.slice(eq.length + 1);
      break;
    }
    // `python -Bc "..."`: bundle de flags curtas terminando na flag de código.
    const bundled = name === 'python' && /^-[A-Za-z]*c$/.test(t);
    if (spec.codeFlags.includes(t) || bundled) {
      code = args[k + 1]?.t ?? '';
      break;
    }
    if (name === 'python' && (t === '-m' || t === '-W' || t === '-X')) {
      hasScript = t === '-m' || hasScript;
      k++;
      continue;
    }
    if (t === '-') break;
    if (!t.startsWith('-')) {
      hasScript = true;
      break;
    }
  }

  if (code !== null) return classifyInlineCode(name, code, view, depth);
  if (args.some((a) => /^(--version|-v|-V|--help|-h)$/.test(a.t))) {
    return v('read', `${name} (versão/ajuda)`);
  }
  if (!hasScript) {
    if (name === 'osascript') return v('escalate', 'osascript');
    return v('escalate', `${name} executando código recebido pela entrada padrão`);
  }
  // Script em arquivo: allow list decide (`node script.js`).
  return null;
}

function classifyInlineCode(
  name: string,
  code: string,
  view: CommandPolicyView,
  depth: number,
): CommandVerdict {
  let r: CommandVerdict = v('exec', `código inline (${name})`);
  if (name === 'osascript') r = v('escalate', 'AppleScript inline');
  if (DANGER_API.test(code)) {
    r = worstVerdict(r, v('escalate', `código inline (${name}) usa API de processo/arquivo/rede`));
  }
  const literals = stringLiterals(code);
  for (const lit of literals) {
    const secret = matchSecretPath(lit);
    if (secret) return v('irreversible', `código inline (${name}) acessa segredo (${secret.label})`);
  }
  if (PROCESS_API.test(code)) {
    for (const lit of literals) {
      if (!/\s|^[a-z]/i.test(lit)) continue;
      r = worstVerdict(r, classifyCommand(lit, view, depth + 1));
    }
  }
  return r;
}

/** Literais de string de JS/Python/Ruby/Perl (aproximação suficiente para varredura). */
function stringLiterals(code: string): string[] {
  const out: string[] = [];
  const re = /'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\])*)`/g;
  for (const m of code.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

// --- git ------------------------------------------------------------------

const GIT_GLOBAL_WITH_VALUE = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path',
  '--list-cmds', '--attr-source',
]);

/** Remove opções globais: `git -C x -c k=v push` → `push`. */
function normalizeGit(argv: Arg[]): { sub: string; rest: Arg[]; config: boolean } {
  let i = 1;
  let config = false;
  while (i < argv.length) {
    const t = argv[i]!.t;
    if (!t.startsWith('-')) break;
    if (t === '-c' || t === '--config-env' || t.startsWith('--config-env=')) config = true;
    if (GIT_GLOBAL_WITH_VALUE.has(t)) i += 2;
    else i++;
  }
  return { sub: (argv[i]?.t ?? '').toLowerCase(), rest: argv.slice(i + 1), config };
}

function shortFlags(args: Arg[]): string {
  return args
    .filter((a) => /^-[A-Za-z]+$/.test(a.t))
    .map((a) => a.t.slice(1))
    .join('');
}

function hasLong(args: Arg[], ...names: string[]): boolean {
  return args.some((a) => names.some((n) => a.t === n || a.t.startsWith(`${n}=`)));
}

function classifyGit(argv: Arg[], view: CommandPolicyView): CommandVerdict {
  const { sub, rest, config } = normalizeGit(argv);
  const norm: Arg[] = [argv[0]!, { t: sub, quoted: false, dynamic: false }, ...rest];
  const shorts = shortFlags(rest);
  const positional = rest.filter((a) => !isFlag(a));

  let r: CommandVerdict | null = null;
  switch (sub) {
    case 'push':
      r = v('irreversible', 'git push publica no remoto');
      break;
    case 'reset':
      if (hasLong(rest, '--hard', '--merge', '--keep')) r = v('irreversible', 'git reset --hard descarta mudanças');
      break;
    case 'clean':
      if (shorts.includes('f') || hasLong(rest, '--force')) r = v('irreversible', 'git clean -f apaga arquivos não versionados');
      else r = v('write', 'git clean');
      break;
    case 'branch': {
      const del = /[dD]/.test(shorts) || hasLong(rest, '--delete');
      const force = shorts.includes('D') || shorts.includes('f') || hasLong(rest, '--force');
      if (del && force) r = v('irreversible', 'git branch -D apaga branch sem checar merge');
      else if (del || /[mMcC]/.test(shorts) || hasLong(rest, '--move', '--copy')) r = v('write', 'git branch altera branches');
      break;
    }
    case 'tag':
      if (shorts.includes('d') || hasLong(rest, '--delete')) r = v('irreversible', 'git tag -d');
      break;
    case 'stash': {
      const action = positional[0]?.t.toLowerCase();
      if (action === 'drop' || action === 'clear') r = v('irreversible', `git stash ${action} descarta trabalho guardado`);
      break;
    }
    case 'checkout':
      if (shorts.includes('f') || hasLong(rest, '--force') || rest.some((a) => a.t === '--' || a.t === '.')) {
        r = v('irreversible', 'git checkout descarta mudanças locais');
      }
      break;
    case 'restore': {
      const onlyStaged = (shorts.includes('S') || hasLong(rest, '--staged')) && !(shorts.includes('W') || hasLong(rest, '--worktree'));
      if (!onlyStaged) r = v('irreversible', 'git restore descarta mudanças locais');
      break;
    }
    case 'switch':
      if (shorts.includes('f') || hasLong(rest, '--force', '--discard-changes')) r = v('irreversible', 'git switch --discard-changes');
      break;
    case 'reflog':
      if (['expire', 'delete'].includes(positional[0]?.t.toLowerCase() ?? '')) r = v('irreversible', 'git reflog expire/delete');
      break;
    case 'update-ref':
      if (shorts.includes('d')) r = v('irreversible', 'git update-ref -d');
      break;
    case 'filter-branch':
    case 'filter-repo':
    case 'prune':
      r = v('irreversible', `git ${sub} reescreve/apaga histórico`);
      break;
    case 'gc':
      if (hasLong(rest, '--prune')) r = v('irreversible', 'git gc --prune');
      break;
    case 'config':
      if (!hasLong(rest, '--get', '--get-all', '--get-regexp', '--list', '-l') && !shorts.includes('l') && positional.length > 1) {
        r = v('escalate', 'git config altera configuração (pode apontar hooks e comandos)');
      }
      break;
    case '':
      r = v('read', 'git sem subcomando');
      break;
  }

  const base = r ?? classifyByLists('git', norm, view);
  // `-c core.fsmonitor=...`, `-c alias.x=!cmd` executam comando arbitrário.
  const cfg = config ? v('escalate', 'git -c/--config-env pode executar comando arbitrário') : v('read', '');
  return worstVerdict(base, cfg);
}

/** Subcomandos do git que só leem (quando `git <sub>` está na allow list). */
function isReadOnlyGit(name: string, args: Arg[]): boolean {
  if (name !== 'git') return false;
  const sub = args[0]?.t.toLowerCase() ?? '';
  const rest = args.slice(1);
  const positional = rest.filter((a) => !isFlag(a));
  switch (sub) {
    case 'status':
    case 'diff':
    case 'log':
    case 'show':
    case 'rev-parse':
    case 'ls-files':
    case 'blame':
    case 'grep':
    case 'describe':
    case 'shortlog':
      return true;
    case 'branch':
    case 'tag':
      return positional.length === 0;
    case 'stash':
      return ['list', 'show'].includes(positional[0]?.t.toLowerCase() ?? '');
    case 'remote':
      return positional.length === 0;
    default:
      return false;
  }
}

// --- remoção e escrita ----------------------------------------------------

function classifyRm(args: Arg[], view: CommandPolicyView): CommandVerdict {
  const flags = args.filter((a) => isFlag(a) && a.t !== '--');
  const letters = flags.filter((a) => !a.t.startsWith('--')).map((a) => a.t.slice(1)).join('');
  const recursive = /[rR]/.test(letters) || hasLong(flags, '--recursive') || flags.some((a) => /^-rec/i.test(a.t));
  const force = /f/i.test(letters) || hasLong(flags, '--force');
  if (recursive || force) {
    return v('irreversible', `remoção ${recursive ? 'recursiva' : 'forçada'} (rm ${flags.map((a) => a.t).join(' ')})`);
  }
  return writeTargets(args.filter((a) => !isFlag(a)), view, 'rm');
}

function classifyDel(args: Arg[], view: CommandPolicyView): CommandVerdict {
  if (args.some((a) => /^\/[sqf]$/i.test(a.t) || /^-(rec|force)/i.test(a.t))) {
    return v('irreversible', 'remoção recursiva/forçada (del)');
  }
  return writeTargets(args.filter((a) => !/^[-/]/.test(a.t)), view, 'del');
}

function classifyRmdir(args: Arg[], view: CommandPolicyView): CommandVerdict {
  if (args.some((a) => /^\/s$/i.test(a.t) || /^-rec/i.test(a.t) || /^-(force)/i.test(a.t))) {
    return v('irreversible', 'remoção recursiva de diretório (rd /s)');
  }
  return writeTargets(args.filter((a) => !/^[-/]/.test(a.t) || a.t.includes('/', 1)), view, 'rmdir');
}

function writeTargets(targets: Arg[], view: CommandPolicyView, via: string): CommandVerdict {
  let r: CommandVerdict = v('write', `${via}`);
  for (const a of targets) r = worstVerdict(r, writeTarget(a.t, a.dynamic, view, via));
  return r;
}

function classifyFind(argv: Arg[], view: CommandPolicyView, depth: number): CommandVerdict | null {
  const args = argv.slice(1);
  let r: CommandVerdict | null = null;
  for (let k = 0; k < args.length; k++) {
    const t = args[k]!.t;
    if (t === '-delete') return v('irreversible', 'find -delete apaga arquivos');
    if (['-exec', '-execdir', '-ok', '-okdir'].includes(t)) {
      const inner: Arg[] = [];
      k++;
      while (k < args.length && ![';', '\\;', '+'].includes(args[k]!.t)) inner.push(args[k++]!);
      const innerV = inner.length > 0 ? classifyArgv(inner, view, depth + 1) : v('escalate', 'find -exec vazio');
      r = worstVerdict(r ?? v('exec', `find ${t}`), worstVerdict(v('exec', `find ${t}`), innerV));
      continue;
    }
    if (['-fprint', '-fprint0', '-fprintf', '-fls'].includes(t)) {
      const target = args[k + 1];
      if (target) r = worstVerdict(r ?? v('write', 'find'), writeTarget(target.t, target.dynamic, view, `find ${t}`));
      k++;
    }
  }
  if (r === null) return null;
  // Mesmo com -exec, `find` precisa estar na allow list para não escalar.
  return worstVerdict(r, classifyByLists('find', argv, view));
}

function classifySed(argv: Arg[], view: CommandPolicyView): CommandVerdict | null {
  const args = argv.slice(1);
  const inPlace = args.some((a) => /^-[A-Za-z]*i/.test(a.t) || a.t.startsWith('--in-place'));
  const scripts: string[] = [];
  const files: Arg[] = [];
  let explicitScript = false;
  for (let k = 0; k < args.length; k++) {
    const t = args[k]!.t;
    if (t === '-e' || t === '--expression') {
      scripts.push(args[k + 1]?.t ?? '');
      explicitScript = true;
      k++;
      continue;
    }
    if (t === '-f' || t === '--file') return v('escalate', 'sed -f executa script de arquivo');
    if (isFlag(args[k]!)) continue;
    if (!explicitScript && scripts.length === 0) scripts.push(t);
    else files.push(args[k]!);
  }
  // `e` executa comando; `w`/`W` escreve arquivo; `r`/`R` lê arquivo.
  if (scripts.some((s) => /\/[gpiImM0-9]*[ewW]|(^|[;{}\n])\s*[0-9,$]*\s*[eEwWrR](\s|$)/.test(s))) {
    return v('escalate', 'script de sed executa comando ou escreve arquivo');
  }
  if (inPlace) return worstVerdict(v('write', 'sed -i'), writeTargets(files, view, 'sed -i'));
  return null;
}

function classifyAwk(argv: Arg[], view: CommandPolicyView): CommandVerdict | null {
  const args = argv.slice(1);
  if (args.some((a) => a.t === '-f' || a.t.startsWith('--file'))) return v('escalate', 'awk -f executa script de arquivo');
  const program = args.find((a) => !isFlag(a))?.t ?? '';
  if (/system\s*\(|\|\s*getline|\|\s*"|print[^;]*>|printf[^;]*>/.test(program)) {
    return v('escalate', 'programa awk executa comando ou escreve arquivo');
  }
  void view;
  return null;
}

function classifyOutputFlag(argv: Arg[], view: CommandPolicyView, flags: Set<string>): CommandVerdict | null {
  const args = argv.slice(1);
  let r: CommandVerdict | null = null;
  for (let k = 0; k < args.length; k++) {
    const t = args[k]!.t;
    const eq = [...flags].find((f) => t.startsWith(`${f}=`));
    const target = eq ? t.slice(eq.length + 1) : flags.has(t) ? args[k + 1]?.t : undefined;
    if (target !== undefined) {
      r = worstVerdict(r ?? v('write', 'saída em arquivo'), writeTarget(target, false, view, argv[0]!.t));
    }
  }
  return r === null ? null : worstVerdict(r, classifyByLists(commandName(argv[0]!.t), argv, view));
}

function classifyDd(args: Arg[], view: CommandPolicyView): CommandVerdict {
  let r: CommandVerdict = v('exec', 'dd');
  for (const a of args) {
    if (a.t.startsWith('of=')) r = worstVerdict(r, writeTarget(a.t.slice(3), a.dynamic, view, 'dd of='));
  }
  return worstVerdict(r, v('escalate', 'dd escreve blocos crus'));
}

/** Comandos cuja essência é criar/alterar arquivo: classificados pelo alvo, como a ferramenta Write. */
function classifyWriteCommand(name: string, args: Arg[], view: CommandPolicyView): CommandVerdict | null {
  const positional = (withValue: Set<string>): Arg[] => {
    const out: Arg[] = [];
    for (let k = 0; k < args.length; k++) {
      const a = args[k]!;
      if (a.t === '--') {
        out.push(...args.slice(k + 1));
        break;
      }
      if (isFlag(a)) {
        if (withValue.has(a.t.toLowerCase())) k++;
        continue;
      }
      out.push(a);
    }
    return out;
  };
  // Parâmetros do PowerShell que carregam o ALVO de escrita.
  const psTargets = (): Arg[] => {
    const out: Arg[] = [];
    for (let k = 0; k < args.length; k++) {
      const t = args[k]!.t.toLowerCase();
      if (/^-(path|literalpath|filepath|destination|target)$/.test(t) && args[k + 1]) {
        out.push(args[k + 1]!);
        k++;
      } else if (t.startsWith('-')) {
        if (!/^-(force|recurse|append|nonewline|passthru|whatif|confirm|noclobber)/.test(t)) k++;
      } else if (out.length === 0) {
        out.push(args[k]!);
      }
    }
    return out;
  };

  switch (name) {
    case 'mkdir':
    case 'md':
    case 'touch':
    case 'tee':
    case 'truncate':
    case 'unlink':
      return writeTargets(positional(new Set(['-m', '--mode', '-d', '-t', '-r', '-s', '--size', '--reference'])), view, name);
    case 'new-item':
    case 'ni':
    case 'set-content':
    case 'add-content':
    case 'ac':
    case 'out-file':
      return writeTargets(psTargets(), view, name);
    case 'cp':
    case 'copy':
    case 'copy-item':
    case 'cpi':
    case 'xcopy':
    case 'robocopy': {
      const pos = /-item$|^cpi$/.test(name) ? psTargets() : positional(new Set(['-t', '--target-directory', '-S', '--suffix']));
      const dest = pos.length > 1 ? pos[pos.length - 1]! : pos[0];
      let r = dest ? writeTargets([dest], view, name) : v('write', name);
      for (const src of pos.slice(0, -1)) r = worstVerdict(r, readTarget(src.t, view));
      return r;
    }
    case 'mv':
    case 'move':
    case 'move-item':
    case 'mi':
    case 'ren':
    case 'rename':
    case 'rename-item':
      return writeTargets(/-item$|^mi$/.test(name) ? psTargets() : positional(new Set(['-t', '--target-directory', '-S', '--suffix'])), view, name);
    case 'ln': {
      const pos = positional(new Set(['-t', '--target-directory', '-S', '--suffix']));
      const link = pos.length > 1 ? pos[pos.length - 1] : undefined;
      return link ? writeTargets([link], view, 'ln') : v('write', 'ln');
    }
    case 'mklink': {
      const pos = args.filter((a) => !a.t.startsWith('/'));
      return pos[0] ? writeTargets([pos[0]], view, 'mklink') : v('write', 'mklink');
    }
  }
  return null;
}

// --- rede -----------------------------------------------------------------

function classifyNetwork(name: string, args: Arg[], view: CommandPolicyView): CommandVerdict {
  const hosts: string[] = [];
  let r: CommandVerdict = v('exec', `${name}`);
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    const t = a.t;
    const lower = t.toLowerCase();
    // Saída em arquivo.
    if (['-o', '--output', '--output-document', '-outfile'].includes(lower) || (name === 'wget' && t === '-O')) {
      const target = args[k + 1];
      if (target) r = worstVerdict(r, writeTarget(target.t, target.dynamic, view, `${name} ${t}`));
      k++;
      continue;
    }
    if (lower === '-uri') {
      const h = hostOf(args[k + 1]?.t ?? '');
      if (h) hosts.push(h);
      k++;
      continue;
    }
    if (isFlag(a)) continue;
    const h = hostOf(t);
    if (h) hosts.push(h);
  }
  if (hosts.length === 0) return worstVerdict(r, v('escalate', `${name} sem destino reconhecível`));
  const blocked = hosts.find(
    (h) => !view.allowDomains.some((d) => h === d.toLowerCase() || h.endsWith(`.${d.toLowerCase()}`)),
  );
  if (blocked) return worstVerdict(r, v('escalate', `rede: domínio não liberado (${blocked})`));
  return worstVerdict(r, v('exec', `rede: domínio liberado (${hosts.join(', ')})`));
}

function hostOf(t: string): string | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(t) ? `http://${t}` : null;
  if (!withScheme) return null;
  try {
    return new URL(withScheme).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}
