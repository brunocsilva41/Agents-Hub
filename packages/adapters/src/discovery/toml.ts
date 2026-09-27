/**
 * Parser TOML mínimo (somente leitura) — o suficiente para config.toml do
 * Codex e do Kimi: tabelas, tabelas-array, chaves com pontos/aspas, strings
 * (básicas, literais, multilinha), números, booleanos, arrays e tabelas inline.
 * Datas viram string crua. Lança Error em sintaxe inválida; o chamador vira
 * isso em warning.
 *
 * Chave ou tabela declarada duas vezes (ex.: `env = {...}` inline E
 * `[mcp_servers.x.env]`) é erro, como no parser do próprio Codex — o
 * instalador de MCP reparseia a saída com isto para provar que não gerou um
 * config.toml que o Codex recusaria ao iniciar.
 */

type Table = Record<string, unknown>;

class Parser {
  private i = 0;
  /** Tabelas abertas por cabeçalho `[x]` — não podem ser abertas de novo. */
  private readonly declared = new WeakSet<object>();
  /** Tabelas inline e arrays literais: valores fechados, não se estendem. */
  private readonly frozen = new WeakSet<object>();
  constructor(private readonly s: string) {}

  parse(): Table {
    const root: Table = {};
    let current: Table = root;
    for (;;) {
      this.skipBlank();
      if (this.i >= this.s.length) return root;
      if (this.s[this.i] === '[') {
        const isArray = this.s[this.i + 1] === '[';
        this.i += isArray ? 2 : 1;
        const path = this.keyPath();
        this.skipInline();
        const close = isArray ? ']]' : ']';
        if (!this.s.startsWith(close, this.i)) this.fail(`esperado '${close}'`);
        this.i += close.length;
        this.endOfLine();
        current = this.descend(root, path, isArray);
      } else {
        const path = this.keyPath();
        this.skipInline();
        if (this.s[this.i] !== '=') this.fail("esperado '='");
        this.i++;
        this.skipInline();
        const value = this.value();
        this.endOfLine();
        let t = current;
        for (const seg of path.slice(0, -1)) t = this.child(t, seg);
        this.assign(t, path[path.length - 1]!, value);
      }
    }
  }

  private fail(msg: string): never {
    const line = this.s.slice(0, this.i).split('\n').length;
    throw new Error(`TOML inválido (linha ${line}): ${msg}`);
  }

  private assign(t: Table, key: string, value: unknown): void {
    if (Object.prototype.hasOwnProperty.call(t, key)) this.fail(`chave '${key}' definida duas vezes`);
    t[key] = value;
  }

  private child(t: Table, key: string): Table {
    const existing = t[key];
    if (existing === undefined) {
      const n: Table = {};
      t[key] = n;
      return n;
    }
    if (existing && typeof existing === 'object' && this.frozen.has(existing)) {
      this.fail(`'${key}' já foi definido como valor inline e não pode ser estendido`);
    }
    if (Array.isArray(existing)) return existing[existing.length - 1] as Table;
    if (existing && typeof existing === 'object') return existing as Table;
    this.fail(`chave '${key}' redefinida`);
  }

  private descend(root: Table, path: string[], isArray: boolean): Table {
    let t = root;
    path.forEach((seg, idx) => {
      const last = idx === path.length - 1;
      if (last && isArray) {
        const existing = t[seg];
        if (existing !== undefined && (!Array.isArray(existing) || this.frozen.has(existing))) {
          this.fail(`'${path.join('.')}' já foi definido e não é array de tabelas`);
        }
        const arr = (t[seg] ??= []) as Table[];
        const n: Table = {};
        arr.push(n);
        t = n;
      } else if (last) {
        const existing = t[seg];
        if (existing !== undefined && (Array.isArray(existing) || this.declared.has(existing as object))) {
          this.fail(`tabela [${path.join('.')}] declarada duas vezes`);
        }
        t = this.child(t, seg);
        this.declared.add(t);
      } else {
        t = this.child(t, seg);
      }
    });
    return t;
  }

  private skipInline(): void {
    while (this.s[this.i] === ' ' || this.s[this.i] === '\t') this.i++;
  }

  private skipBlank(): void {
    for (;;) {
      const c = this.s[this.i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') this.i++;
      else if (c === '#') this.skipComment();
      else return;
    }
  }

  private skipComment(): void {
    while (this.i < this.s.length && this.s[this.i] !== '\n') this.i++;
  }

  private endOfLine(): void {
    this.skipInline();
    if (this.s[this.i] === '#') this.skipComment();
    if (this.i < this.s.length && this.s[this.i] !== '\n' && this.s[this.i] !== '\r') {
      this.fail('conteúdo inesperado após o valor');
    }
  }

  private keyPath(): string[] {
    const out: string[] = [];
    for (;;) {
      this.skipInline();
      const c = this.s[this.i];
      if (c === '"') out.push(this.basicString());
      else if (c === "'") out.push(this.literalString());
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(this.s.slice(this.i, this.i + 200));
        if (!m) this.fail('chave inválida');
        out.push(m[0]);
        this.i += m[0].length;
      }
      this.skipInline();
      if (this.s[this.i] === '.') this.i++;
      else return out;
    }
  }

  private basicString(): string {
    if (this.s.startsWith('"""', this.i)) {
      this.i += 3;
      if (this.s[this.i] === '\r') this.i++;
      if (this.s[this.i] === '\n') this.i++;
      let out = '';
      while (!this.s.startsWith('"""', this.i)) {
        if (this.i >= this.s.length) this.fail('string multilinha sem fim');
        if (this.s[this.i] === '\\') out += this.escape();
        else out += this.s[this.i++];
      }
      this.i += 3;
      return out;
    }
    this.i++;
    let out = '';
    for (;;) {
      const c = this.s[this.i];
      if (c === undefined || c === '\n') this.fail('string sem fim');
      if (c === '"') {
        this.i++;
        return out;
      }
      if (c === '\\') out += this.escape();
      else {
        out += c;
        this.i++;
      }
    }
  }

  private escape(): string {
    const c = this.s[this.i + 1];
    this.i += 2;
    switch (c) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'b': return '\b';
      case 'f': return '\f';
      case '"': return '"';
      case '\\': return '\\';
      case 'u':
      case 'U': {
        const len = c === 'u' ? 4 : 8;
        const hex = this.s.slice(this.i, this.i + len);
        this.i += len;
        return String.fromCodePoint(parseInt(hex, 16) || 0xfffd);
      }
      default:
        // barra no fim de linha (continuação) ou escape desconhecido: tolerante
        if (c === '\n' || c === '\r' || c === ' ') {
          while (/\s/.test(this.s[this.i] ?? '')) this.i++;
          return '';
        }
        return c ?? '';
    }
  }

  private literalString(): string {
    if (this.s.startsWith("'''", this.i)) {
      this.i += 3;
      if (this.s[this.i] === '\r') this.i++;
      if (this.s[this.i] === '\n') this.i++;
      const end = this.s.indexOf("'''", this.i);
      if (end < 0) this.fail('string multilinha sem fim');
      const v = this.s.slice(this.i, end);
      this.i = end + 3;
      return v;
    }
    this.i++;
    const end = this.s.indexOf("'", this.i);
    const nl = this.s.indexOf('\n', this.i);
    if (end < 0 || (nl >= 0 && nl < end)) this.fail('string sem fim');
    const v = this.s.slice(this.i, end);
    this.i = end + 1;
    return v;
  }

  private value(): unknown {
    const c = this.s[this.i];
    if (c === '"') return this.basicString();
    if (c === "'") return this.literalString();
    if (c === '[') {
      this.i++;
      const arr: unknown[] = [];
      for (;;) {
        this.skipBlank();
        if (this.s[this.i] === ']') {
          this.i++;
          this.frozen.add(arr);
          return arr;
        }
        arr.push(this.value());
        this.skipBlank();
        if (this.s[this.i] === ',') this.i++;
        else if (this.s[this.i] !== ']') this.fail("esperado ',' ou ']'");
      }
    }
    if (c === '{') {
      this.i++;
      const tbl: Table = {};
      for (;;) {
        this.skipInline();
        if (this.s[this.i] === '}') {
          this.i++;
          this.frozen.add(tbl);
          return tbl;
        }
        const path = this.keyPath();
        this.skipInline();
        if (this.s[this.i] !== '=') this.fail("esperado '='");
        this.i++;
        this.skipInline();
        const v = this.value();
        let t = tbl;
        for (const seg of path.slice(0, -1)) t = this.child(t, seg);
        this.assign(t, path[path.length - 1]!, v);
        this.skipInline();
        if (this.s[this.i] === ',') this.i++;
        else if (this.s[this.i] !== '}') this.fail("esperado ',' ou '}'");
      }
    }
    const m = /^[^\s,\]}#]+/.exec(this.s.slice(this.i, this.i + 200));
    if (!m) this.fail('valor ausente');
    this.i += m[0].length;
    const raw = m[0];
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (/^[+-]?(inf|nan)$/.test(raw)) return Number(raw.replace('inf', 'Infinity'));
    if (/^[+-]?(0x[0-9a-f_]+|\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?)$/i.test(raw)) {
      return Number(raw.replace(/_/g, ''));
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw; // data/hora: mantém crua
    this.fail(`valor inválido '${raw.slice(0, 20)}'`);
  }
}

export function parseToml(text: string): Record<string, unknown> {
  return new Parser(text.replace(/^\uFEFF/, '')).parse();
}
