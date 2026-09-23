import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type {
  AgentDiscovery,
  DiscoveredConfigFile,
  DiscoveredMcpServer,
} from '@agents-hub/core';
import { parseToml } from './toml.js';

export type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Remove comentários // e /* *\/ e vírgulas finais, respeitando strings. */
function stripJsonc(text: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += c;
  }
  // vírgulas finais antes de } ou ]
  let res = '';
  inStr = false;
  for (let i = 0; i < out.length; i++) {
    const c = out[i]!;
    if (inStr) {
      res += c;
      if (c === '\\') res += out[++i] ?? '';
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      res += c;
    } else if (c === ',' && /^\s*[}\]]/.test(out.slice(i + 1, i + 200))) {
      // descarta
    } else res += c;
  }
  return res;
}

/** Fatia o primeiro valor JSON (objeto) balanceado — para arquivos com lixo depois. */
function firstBalanced(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

export interface JsonParse {
  value?: unknown;
  /** Nota quando só foi possível ler parcialmente. */
  note?: string;
  error?: string;
}

export function parseJsonTolerant(raw: string): JsonParse {
  const text = raw.replace(/^﻿/, '');
  try {
    return { value: JSON.parse(text) };
  } catch {
    /* tenta variantes */
  }
  const cleaned = stripJsonc(text);
  try {
    return { value: JSON.parse(cleaned) };
  } catch (e) {
    const head = firstBalanced(cleaned);
    if (head) {
      try {
        return {
          value: JSON.parse(head),
          note: 'conteúdo extra após o primeiro objeto JSON foi ignorado',
        };
      } catch {
        /* cai no erro */
      }
    }
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Saneamento: nada que possa ser segredo sai daqui.
// ---------------------------------------------------------------------------

const SECRET_NAME = /(key|token|secret|passw|auth|bearer|credential|cookie|apikey)/i;
const SECRET_LITERAL =
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{6,}|\b(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{6,}|\bxox[abprs]-[A-Za-z0-9-]{6,}|\bAKIA[0-9A-Z]{8,}|\bBearer\s+\S+|\bBasic\s+[A-Za-z0-9+/=]{6,}/g;

export function maskEnv(env: unknown): Record<string, string> | undefined {
  if (!isObj(env)) return undefined;
  const names = Object.keys(env);
  if (names.length === 0) return undefined;
  return Object.fromEntries(names.map((k) => [k, '***']));
}

/** URL sem userinfo e sem valores de query (podem carregar chave). */
export function safeUrl(u: string): string {
  let out = u.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1');
  const q = out.indexOf('?');
  if (q >= 0) out = `${out.slice(0, q)}?***`;
  const h = out.indexOf('#');
  if (h >= 0) out = out.slice(0, h);
  return out.replace(SECRET_LITERAL, '***');
}

export function safeArgs(args: unknown[]): string[] {
  const out: string[] = [];
  let maskNext = false;
  for (const a of args) {
    let s = typeof a === 'string' ? a : String(a);
    if (maskNext) {
      out.push('***');
      maskNext = false;
      continue;
    }
    const flag = /^(--?[\w.-]+)=(.*)$/s.exec(s);
    const kv = /^([A-Za-z_][\w.-]*)=(.*)$/s.exec(s);
    if (flag && SECRET_NAME.test(flag[1]!)) s = `${flag[1]}=***`;
    else if (kv && SECRET_NAME.test(kv[1]!)) s = `${kv[1]}=***`;
    else if (/^--?[\w.-]+$/.test(s) && SECRET_NAME.test(s)) maskNext = true;
    else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = safeUrl(s);
    out.push(s.replace(SECRET_LITERAL, '***'));
  }
  return out;
}

export function isHubServer(name: string, command?: string, args?: string[], url?: string): boolean {
  const hay = [name, command ?? '', ...(args ?? []), url ?? ''].join(' ').toLowerCase();
  return /agents[-_ ]?hub/.test(hay) || /\bhub[\s"']+mcp\b/.test(hay);
}

// ---------------------------------------------------------------------------
// Contexto de coleta
// ---------------------------------------------------------------------------

export interface DiscoveryEnv {
  [name: string]: string | undefined;
}

export class Ctx {
  readonly files: DiscoveredConfigFile[] = [];
  readonly mcpServers: DiscoveredMcpServer[] = [];
  readonly instructionFiles: { path: string; bytes: number }[] = [];
  readonly warnings: string[] = [];
  readonly evidence: string[] = [];
  defaults: AgentDiscovery['defaults'] = {};
  /** Se algum arquivo de auth foi procurado e nada achado → 'absent'; senão 'unknown'. */
  authCanBeAbsent = true;

  constructor(
    readonly home: string,
    readonly projectDir: string | undefined,
    readonly env: DiscoveryEnv,
  ) {}

  p(...segs: string[]): string {
    return path.join(this.home, ...segs);
  }

  warn(msg: string): void {
    if (!this.warnings.includes(msg)) this.warnings.push(msg);
  }

  private track(raw: string, role: DiscoveredConfigFile['role']): boolean {
    const p = path.normalize(raw);
    const exists = existsSync(p);
    if (!this.files.some((f) => f.path === p)) this.files.push({ path: p, exists, role });
    return exists;
  }

  read(raw: string, role: DiscoveredConfigFile['role']): string | undefined {
    const p = path.normalize(raw);
    if (!this.track(p, role)) return undefined;
    try {
      if (!statSync(p).isFile()) return undefined;
      return readFileSync(p, 'utf8');
    } catch (e) {
      this.warn(`não foi possível ler ${p}: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  }

  json(p: string, role: DiscoveredConfigFile['role']): Obj | undefined {
    const raw = this.read(p, role);
    if (raw === undefined) return undefined;
    const r = parseJsonTolerant(raw);
    if (r.error !== undefined) {
      this.warn(`${p}: JSON malformado (${r.error.slice(0, 120)}) — ignorado`);
      return undefined;
    }
    if (r.note) this.warn(`${p}: ${r.note}`);
    if (!isObj(r.value)) {
      this.warn(`${p}: esperado um objeto JSON na raiz — ignorado`);
      return undefined;
    }
    return r.value;
  }

  toml(p: string, role: DiscoveredConfigFile['role']): Obj | undefined {
    const raw = this.read(p, role);
    if (raw === undefined) return undefined;
    try {
      return parseToml(raw);
    } catch (e) {
      this.warn(`${p}: ${e instanceof Error ? e.message : String(e)} — ignorado`);
      return undefined;
    }
  }

  /** Só existência (credenciais): nunca lê o conteúdo. */
  credFile(p: string, label: string): boolean {
    const ok = this.track(p, 'auth');
    if (ok) this.evidence.push(`arquivo de credencial presente: ${label}`);
    return ok;
  }

  envVar(name: string): boolean {
    const v = this.env[name];
    const ok = typeof v === 'string' && v.length > 0;
    if (ok) this.evidence.push(`variável de ambiente ${name} definida`);
    return ok;
  }

  /** Nome de campo de credencial encontrado numa config (só o nome, nunca o valor). */
  configCred(where: string, present: boolean): void {
    if (present) this.evidence.push(`campo de credencial presente em ${where}`);
  }

  instruction(raw: string): void {
    const p = path.normalize(raw);
    if (!this.track(p, 'instructions')) return;
    try {
      const st = statSync(p);
      if (st.isFile()) this.instructionFiles.push({ path: p, bytes: st.size });
    } catch (e) {
      this.warn(`não foi possível medir ${p}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Normaliza um mapa {nome: spec} de servidores MCP (formatos Claude/Cursor/Gemini/OpenCode). */
  addMcpMap(map: unknown, source: string): void {
    if (map === undefined) return;
    if (!isObj(map)) {
      this.warn(`${source}: seção de MCP com formato inesperado — ignorada`);
      return;
    }
    for (const [name, spec] of Object.entries(map)) {
      if (!isObj(spec)) {
        this.warn(`${source}: servidor MCP '${name}' com formato inesperado — ignorado`);
        continue;
      }
      this.addMcp(name, spec, source);
    }
  }

  addMcp(name: string, spec: Obj, source: string): void {
    let command: string | undefined;
    let args: string[] | undefined;
    if (Array.isArray(spec.command)) {
      const [c, ...rest] = spec.command;
      command = typeof c === 'string' ? c : undefined;
      args = safeArgs(rest);
    } else {
      command = str(spec.command);
      if (Array.isArray(spec.args)) args = safeArgs(spec.args);
    }
    const rawUrl = str(spec.url) ?? str(spec.httpUrl) ?? str(spec.serverUrl);
    const url = rawUrl ? safeUrl(rawUrl) : undefined;
    const type = typeof spec.type === 'string' ? spec.type.toLowerCase() : undefined;
    let transport: DiscoveredMcpServer['transport'] = 'unknown';
    if (type === 'stdio' || type === 'local') transport = 'stdio';
    else if (type === 'sse') transport = 'sse';
    else if (type === 'http' || type === 'streamable-http' || type === 'streamable_http' || type === 'remote')
      transport = 'http';
    else if (command) transport = 'stdio';
    else if (url) transport = /\/sse\/?$/.test(url) ? 'sse' : 'http';
    const env = maskEnv(spec.env) ?? maskEnv(spec.environment);
    const server: DiscoveredMcpServer = {
      name,
      transport,
      source,
      isHub: isHubServer(name, command, args, url),
    };
    if (command !== undefined) server.command = command;
    if (args !== undefined && args.length > 0) server.args = args;
    if (url !== undefined) server.url = url;
    if (env !== undefined) server.env = env;
    this.mcpServers.push(server);
  }

  build(agentId: string, installed: { version: string | null; binPath: string } | null): AgentDiscovery {
    let state: AgentDiscovery['auth']['state'] = 'unknown';
    if (this.evidence.length > 0) state = 'present';
    else if (this.authCanBeAbsent) state = 'absent';
    return {
      agentId,
      installed: installed !== null,
      version: installed?.version ?? null,
      binPath: installed?.binPath ?? null,
      auth: {
        state,
        evidence:
          state === 'absent'
            ? ['nenhum arquivo de credencial nem variável de ambiente conhecida encontrados']
            : [...this.evidence],
      },
      defaults: this.defaults,
      files: this.files,
      mcpServers: this.mcpServers,
      instructionFiles: this.instructionFiles,
      warnings: this.warnings,
    };
  }
}

/** Copia só campos string não vazios e seguros para `defaults`. */
export function setDefaults(ctx: Ctx, d: { model?: unknown; provider?: unknown; baseUrl?: unknown }): void {
  const m = str(d.model);
  const p = str(d.provider);
  const b = str(d.baseUrl);
  if (m && ctx.defaults.model === undefined) ctx.defaults.model = m;
  if (p && ctx.defaults.provider === undefined) ctx.defaults.provider = p;
  if (b && ctx.defaults.baseUrl === undefined) ctx.defaults.baseUrl = safeUrl(b);
}

export function hasSecretKey(o: unknown): boolean {
  if (!isObj(o)) return false;
  return Object.entries(o).some(([k, v]) => SECRET_NAME.test(k) && typeof v === 'string' && v.length > 0);
}
