/**
 * Tokenizador de linha de comando para o classificador de risco.
 *
 * Não é um interpretador de shell — é o mínimo necessário para NÃO ser
 * enganado por composição. Antes dele, a política casava o comando por prefixo
 * de string, e `git status && git push` passava como "git status". Aqui o
 * comando vira uma lista plana de segmentos (um por comando simples), cada um
 * com suas palavras e redirecionamentos. O conteúdo de `$(...)`, crases,
 * `<(...)`/`>(...)` e de grupos `( ... )` também vira segmento, então o
 * classificador enxerga o que roda "escondido" dentro de outro comando.
 *
 * Dialetos: bash/sh é a referência de estrutura (aspas, escapes, operadores).
 * Como os agentes também rodam cmd e PowerShell no Windows, cada palavra sai
 * com DUAS leituras de texto:
 * - `posix`: como o bash leria (`\x` vira `x` fora de aspas simples);
 * - `win`: como cmd/PowerShell leriam (barra invertida é literal — é separador
 *   de caminho —, e `^` fora de aspas é o escape do cmd).
 * O classificador avalia as duas e fica com a PIOR. Ambiguidade de dialeto
 * nunca pode virar brecha: `type C:\Users\x\.ssh\id_rsa` precisa ser visto
 * como leitura de `.ssh` mesmo que o bash fosse ler outra coisa.
 *
 * Tudo que não dá para tokenizar com segurança (aspas sem fechar, `$(` sem
 * `)`, crase sem par, aninhamento excessivo) lança `ShellParseError` — e quem
 * chama trata isso como "na dúvida, não libera".
 */

export interface ShellWord {
  /** Leitura bash. */
  posix: string;
  /** Leitura cmd/PowerShell. */
  win: string;
  /** Houve expansão (`$VAR`, `$(...)`, crase) — o valor real só existe em tempo de execução. */
  dynamic: boolean;
  /** Alguma parte veio entre aspas. */
  quoted: boolean;
}

export interface ShellRedirect {
  /** Operador: `>`, `>>`, `>|`, `&>`, `&>>`, `<`, `<>`, `<<`, `<<<`, `>&`, `<&`. */
  op: string;
  /** Descritor explícito (`2` em `2>`), quando houver. */
  fd: string | null;
  /** Arquivo alvo. `null` quando não há arquivo (heredoc, here-string, `2>&1`). */
  target: ShellWord | null;
}

export interface ShellSegment {
  words: ShellWord[];
  redirects: ShellRedirect[];
}

export class ShellParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShellParseError';
  }
}

/** Marcador que substitui, no texto da palavra, o resultado de uma substituição de comando. */
export const SUBST_PLACEHOLDER = '\u0000subst\u0000';

const MAX_DEPTH = 12;

interface PendingHeredoc {
  delim: string;
  expand: boolean;
}

interface WordBuilder {
  posix: string;
  win: string;
  dynamic: boolean;
  quoted: boolean;
}

/**
 * Quebra `src` em segmentos. Lança `ShellParseError` quando a entrada não é
 * tokenizável com segurança.
 */
export function parseShell(src: string): ShellSegment[] {
  const parser = new Parser(src, 0, []);
  parser.parseList(null);
  return parser.segments;
}

class Parser {
  i = 0;
  cur: ShellSegment = { words: [], redirects: [] };
  word: WordBuilder | null = null;
  pending: PendingHeredoc[] = [];

  constructor(
    private readonly s: string,
    private readonly depth: number,
    /** Lista compartilhada entre parsers aninhados — o resultado é plano. */
    readonly segments: ShellSegment[],
  ) {
    if (depth > MAX_DEPTH) throw new ShellParseError('aninhamento excessivo de subcomandos');
  }

  /** Lê comandos até `closer` (consumindo-o) ou até o fim da entrada. */
  parseList(closer: ')' | null): void {
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i]!;
      const next = s[this.i + 1];

      if (c === ' ' || c === '\t' || c === '\r') {
        this.flushWord();
        this.i++;
        continue;
      }
      if (c === '\\' && (next === '\n' || (next === '\r' && s[this.i + 2] === '\n'))) {
        // Continuação de linha.
        this.i += next === '\n' ? 2 : 3;
        continue;
      }
      if (c === '\n') {
        this.flushWord();
        this.endSegment();
        this.i++;
        this.readHeredocBodies();
        continue;
      }
      if (c === '#' && this.word === null) {
        while (this.i < s.length && s[this.i] !== '\n') this.i++;
        continue;
      }
      if (c === ')') {
        if (closer !== ')') throw new ShellParseError('")" sem "(" correspondente');
        this.flushWord();
        this.endSegment();
        this.i++;
        return;
      }
      if (c === '(') {
        // Grupo/subshell: o conteúdo vira segmentos próprios.
        this.flushWord();
        this.endSegment();
        this.i++;
        this.nested();
        continue;
      }
      if ((c === '<' || c === '>') && next === '(') {
        // Substituição de processo `<(cmd)` / `>(cmd)`.
        this.i += 2;
        this.nested();
        this.appendDynamic(SUBST_PLACEHOLDER);
        continue;
      }
      if (c === '&' && next === '>') {
        this.flushWord();
        this.readRedirect(null);
        continue;
      }
      if (c === ';' || c === '&' || c === '|') {
        this.flushWord();
        this.endSegment();
        // Consome o operador inteiro (`&&`, `||`, `|&`, `;;`, `;&`).
        this.i++;
        const n = s[this.i];
        if (n === c || (c === '|' && n === '&') || (c === ';' && n === '&')) this.i++;
        continue;
      }
      if (c === '<' || c === '>') {
        // `2>` / `*>` (PowerShell): o dígito colado é o descritor, não palavra.
        let fd: string | null = null;
        if (this.word && !this.word.quoted && !this.word.dynamic && /^(\d+|\*)$/.test(this.word.posix)) {
          fd = this.word.posix;
          this.word = null;
        } else {
          this.flushWord();
        }
        this.readRedirect(fd);
        continue;
      }

      this.readWordPart();
    }

    if (closer !== null) throw new ShellParseError(`"${closer}" não encontrado`);
    this.flushWord();
    this.endSegment();
    // Heredoc sem terminador até o fim: o bash aceita (com aviso); aqui também.
    this.pending = [];
  }

  /** Parse aninhado no mesmo texto, preservando a palavra/segmento em andamento. */
  private nested(): void {
    const sub = new Parser(this.s, this.depth + 1, this.segments);
    sub.i = this.i;
    sub.parseList(')');
    this.i = sub.i;
  }

  /** Parse de um texto independente (conteúdo de crase, corpo de heredoc...). */
  private parseText(text: string, mode: 'list' | 'dquote'): void {
    const sub = new Parser(text, this.depth + 1, this.segments);
    if (mode === 'list') {
      sub.parseList(null);
    } else {
      // Só interessam as substituições; o texto em si é dado.
      sub.word = { posix: '', win: '', dynamic: false, quoted: true };
      sub.readDquoteBody(null);
    }
  }

  private ensureWord(): WordBuilder {
    if (!this.word) this.word = { posix: '', win: '', dynamic: false, quoted: false };
    return this.word;
  }

  private append(posix: string, win: string = posix): void {
    const w = this.ensureWord();
    w.posix += posix;
    w.win += win;
  }

  private appendDynamic(text: string): void {
    this.append(text);
    this.word!.dynamic = true;
  }

  private flushWord(): void {
    if (this.word) {
      this.cur.words.push({ ...this.word });
      this.word = null;
    }
  }

  private endSegment(): void {
    if (this.cur.words.length > 0 || this.cur.redirects.length > 0) {
      this.segments.push(this.cur);
    }
    this.cur = { words: [], redirects: [] };
  }

  /** Lê um pedaço de palavra a partir de `this.i` (um caractere, aspas, expansão...). */
  private readWordPart(): void {
    const s = this.s;
    const c = s[this.i]!;
    const next = s[this.i + 1];

    if (c === "'") {
      const end = s.indexOf("'", this.i + 1);
      if (end < 0) throw new ShellParseError('aspas simples sem fechamento');
      const lit = s.slice(this.i + 1, end);
      this.append(lit);
      this.word!.quoted = true;
      this.i = end + 1;
      return;
    }
    if (c === '"') {
      this.ensureWord().quoted = true;
      this.i++;
      this.readDquoteBody('"');
      return;
    }
    if (c === '$') {
      this.readDollar(false);
      return;
    }
    if (c === '`') {
      this.readBacktick();
      return;
    }
    if (c === '\\') {
      if (next === undefined) {
        this.append('\\');
        this.i++;
        return;
      }
      // bash: escapa o próximo; cmd/PowerShell: barra é literal.
      this.append(next, `\\${next}`);
      this.i += 2;
      return;
    }
    if (c === '^' && next !== undefined) {
      // Escape do cmd. No bash `^` é literal.
      this.append(`^${next}`, next);
      this.i += 2;
      return;
    }
    this.append(c);
    this.i++;
  }

  /**
   * Corpo de aspas duplas (ou de heredoc expansível, com `end === null`).
   * Chamado com `this.i` logo após a aspa de abertura.
   */
  readDquoteBody(end: '"' | null): void {
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i]!;
      const next = s[this.i + 1];
      if (end !== null && c === end) {
        this.i++;
        return;
      }
      if (c === '\\' && next !== undefined) {
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          this.append(next, next === '"' ? '"' : `\\${next}`);
          this.i += 2;
          continue;
        }
        if (next === '\n') {
          this.i += 2;
          continue;
        }
        this.append('\\');
        this.i++;
        continue;
      }
      if (c === '$') {
        this.readDollar(true);
        continue;
      }
      if (c === '`') {
        this.readBacktick();
        continue;
      }
      this.append(c);
      this.i++;
    }
    if (end !== null) throw new ShellParseError('aspas duplas sem fechamento');
  }

  /** `$...` — variável, `$(...)`, `$((...))`, `${...}`, `$'...'`. */
  private readDollar(inDquote: boolean): void {
    const s = this.s;
    const next = s[this.i + 1];

    if (next === '(' && s[this.i + 2] === '(') {
      // Aritmética: não executa comando, mas pode conter `$(...)`.
      const close = findArithmeticEnd(s, this.i + 3);
      if (close < 0) throw new ShellParseError('"$((" sem "))"');
      const inner = s.slice(this.i + 3, close);
      if (inner.includes('$(') || inner.includes('`')) this.parseText(inner, 'dquote');
      this.appendDynamic('$((...))');
      this.i = close + 2;
      return;
    }
    if (next === '(') {
      this.i += 2;
      this.nested();
      this.appendDynamic(SUBST_PLACEHOLDER);
      return;
    }
    if (next === '{') {
      const close = findBraceEnd(s, this.i + 2);
      if (close < 0) throw new ShellParseError('"${" sem "}"');
      const inner = s.slice(this.i + 2, close);
      // `${X:-$(cmd)}` roda `cmd`.
      if (inner.includes('$(') || inner.includes('`')) this.parseText(inner, 'dquote');
      this.appendDynamic(`\${${inner}}`);
      this.i = close + 1;
      return;
    }
    if (!inDquote && next === "'") {
      // ANSI-C: `$'...'` com escapes de barra invertida.
      let j = this.i + 2;
      let lit = '';
      while (j < s.length && s[j] !== "'") {
        if (s[j] === '\\' && j + 1 < s.length) {
          lit += s[j + 1];
          j += 2;
          continue;
        }
        lit += s[j];
        j++;
      }
      if (j >= s.length) throw new ShellParseError("$'...' sem fechamento");
      this.append(lit);
      this.word!.quoted = true;
      this.i = j + 1;
      return;
    }
    if (!inDquote && next === '"') {
      this.ensureWord().quoted = true;
      this.i += 2;
      this.readDquoteBody('"');
      return;
    }
    // `$nome`, `$env:NOME` (PowerShell), `$1`, `$@`, `$?`...
    const m = /^\$(env:[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(s.slice(this.i));
    if (m) {
      this.appendDynamic(m[0]);
      this.i += m[0].length;
      return;
    }
    this.append('$');
    this.i++;
  }

  private readBacktick(): void {
    const s = this.s;
    let j = this.i + 1;
    let inner = '';
    while (j < s.length && s[j] !== '`') {
      if (s[j] === '\\' && j + 1 < s.length) {
        const n = s[j + 1]!;
        inner += n === '`' || n === '\\' || n === '$' ? n : `\\${n}`;
        j += 2;
        continue;
      }
      inner += s[j];
      j++;
    }
    if (j >= s.length) throw new ShellParseError('crase sem fechamento');
    this.parseText(inner, 'list');
    this.appendDynamic(SUBST_PLACEHOLDER);
    this.i = j + 1;
  }

  /** Lê operador de redirecionamento e seu alvo. */
  private readRedirect(fd: string | null): void {
    const s = this.s;
    const ops = ['&>>', '&>', '<<<', '<<-', '<<', '<>', '<&', '<', '>>', '>|', '>&', '>'];
    const op = ops.find((o) => s.startsWith(o, this.i));
    if (!op) throw new ShellParseError('redirecionamento inválido');
    this.i += op.length;
    while (this.i < s.length && (s[this.i] === ' ' || s[this.i] === '\t')) this.i++;

    const target = this.readSingleWord();
    if (!target) throw new ShellParseError(`redirecionamento "${op}" sem alvo`);

    if (op === '<<' || op === '<<-') {
      this.pending.push({ delim: target.posix, expand: !target.quoted });
      this.cur.redirects.push({ op, fd, target: null });
      return;
    }
    if (op === '<<<') {
      this.cur.redirects.push({ op, fd, target: null });
      return;
    }
    if ((op === '>&' || op === '<&') && /^(\d+|-)$/.test(target.posix)) {
      // Duplicação de descritor (`2>&1`): não é arquivo.
      this.cur.redirects.push({ op, fd, target: null });
      return;
    }
    this.cur.redirects.push({ op, fd, target });
  }

  /** Lê uma palavra isolada (alvo de redirecionamento). */
  private readSingleWord(): ShellWord | null {
    const saved = this.word;
    this.word = null;
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i]!;
      if (' \t\r\n;&|()<>'.includes(c)) break;
      this.readWordPart();
    }
    const w = this.word as WordBuilder | null;
    this.word = saved;
    return w ? { ...w } : null;
  }

  /** Após uma quebra de linha: consome os corpos de heredoc pendentes. */
  private readHeredocBodies(): void {
    const s = this.s;
    for (const h of this.pending) {
      let body = '';
      let found = false;
      while (this.i < s.length) {
        let eol = s.indexOf('\n', this.i);
        if (eol < 0) eol = s.length;
        const line = s.slice(this.i, eol);
        this.i = Math.min(eol + 1, s.length);
        if (line.replace(/\r$/, '').trim() === h.delim) {
          found = true;
          break;
        }
        body += `${line}\n`;
      }
      // Heredoc sem aspas no delimitador expande `$(...)` e crases.
      if (h.expand && (body.includes('$(') || body.includes('`'))) this.parseText(body, 'dquote');
      if (!found) break;
    }
    this.pending = [];
  }
}

function findArithmeticEnd(s: string, from: number): number {
  let depth = 0;
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) return s[j + 1] === ')' ? j : -1;
      depth--;
    }
  }
  return -1;
}

function findBraceEnd(s: string, from: number): number {
  let depth = 0;
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '{') depth++;
    else if (c === '}') {
      if (depth === 0) return j;
      depth--;
    }
  }
  return -1;
}
