import { existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  filtrarEnvDeProjeto,
  HubError,
  variavelDoAgente,
  type AgentDiscovery,
  type ImportKind,
  type ImportPlanItem,
  type ImportResult,
} from '@agents-hub/core';
import type { AgentRegistry, DiscoverOptions } from '@agents-hub/adapters';
import {
  addMcpServers,
  existingServerNames,
  mcpTargets,
  resolveConfigPath,
  type McpTarget,
  type PortableMcpServer,
} from './mcp-config.js';
import type { ProjectContext } from './project-config.js';

/**
 * Descoberta e absorção do ambiente que cada CLI já tem.
 *
 * Modelo de segurança (ver docs/11-descoberta-e-absorcao.md):
 *  - descobrir é só leitura, e NUNCA devolve segredo — a resposta é sanitizada
 *    aqui mesmo que o leitor de um agente falhe em mascarar;
 *  - importar é dry-run por padrão; dry-run não escreve NADA;
 *  - env do projeto só recebe o que passa na lista de permissão de
 *    `core/agent-env.ts` e não parece credencial;
 *  - env de servidor MCP só é copiado com `includeEnv: true` e valor real na
 *    origem; nenhum valor aparece em resposta ou log.
 */

export type DiscoverFn = (agentId: string, opts: DiscoverOptions) => Promise<AgentDiscovery>;

const MASK = '***';

// ------------------------------------------------------------- sanitização

/**
 * Troca credencial embutida em URL por máscara: `user:senha@` e o VALOR de
 * todo parâmetro de query/fragmento. Lista de nomes "perigosos" não basta —
 * `?sig=`, `?sas=`, `?code=`, `#access_token=` escapavam — e para exibir no
 * painel o nome do parâmetro já diz tudo que o usuário precisa.
 */
export function redactUrl(value: string): string {
  return value.replace(/\/\/[^/@\s]*@/, `//${MASK}@`).replace(/([?&#][^=&#\s]*=)[^&#\s]*/g, `$1${MASK}`);
}

/** Nome de flag/variável/cabeçalho que costuma carregar credencial. */
const NOME_SENSIVEL =
  /(key|token|secret|passw|pwd|auth|bearer|credential|cookie|session|signature|\bsig\b)/i;
/** Flags cujo valor é um cabeçalho HTTP inteiro (`mcp-remote --header`, `curl -H`). */
const FLAG_DE_CABECALHO = /^(--headers?|-H)$/i;
/** Token em texto livre: `Bearer xxx`, `Basic xxx`, chaves com prefixo conhecido. */
const TOKEN_EM_TEXTO =
  /\b(Bearer|Basic|Token)\s+\S+|\b(sk|pk|rk)-[A-Za-z0-9_-]{6,}|\b(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{6,}|\bxox[abprs]-[A-Za-z0-9-]{6,}|\bAKIA[0-9A-Z]{8,}|\bAIza[0-9A-Za-z_-]{20,}/g;

/** `Authorization: Bearer x` → `Authorization: ***`. Cabeçalho em args quase sempre é credencial. */
function redactHeaderLine(linha: string): string {
  const m = /^([^:]+):\s*(.*)$/s.exec(linha);
  return m ? `${m[1]}: ${MASK}` : MASK;
}

function redactTexto(texto: string): string {
  if (looksLikeSecret(texto)) return MASK;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(texto)) return redactUrl(texto).replace(TOKEN_EM_TEXTO, MASK);
  return texto.replace(TOKEN_EM_TEXTO, MASK);
}

/**
 * Args de servidor MCP sem segredo. Antes saíam intactos em `/discovery`:
 * `--api-key sk-...`, `--header "Authorization: Bearer ..."`, `--token=...`.
 */
export function redactArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  let proximo: 'segredo' | 'cabecalho' | null = null;
  for (const bruto of args) {
    const a = typeof bruto === 'string' ? bruto : String(bruto);
    if (proximo === 'segredo') {
      out.push(MASK);
      proximo = null;
      continue;
    }
    if (proximo === 'cabecalho') {
      out.push(redactHeaderLine(a));
      proximo = null;
      continue;
    }

    const flagIgual = /^(--?[\w.-]+)=(.*)$/s.exec(a);
    if (flagIgual) {
      const [, flag = '', valor = ''] = flagIgual;
      if (FLAG_DE_CABECALHO.test(flag)) out.push(`${flag}=${redactHeaderLine(valor)}`);
      else if (NOME_SENSIVEL.test(flag)) out.push(`${flag}=${MASK}`);
      else out.push(`${flag}=${redactTexto(valor)}`);
      continue;
    }
    if (/^--?[\w.-]+$/.test(a)) {
      if (FLAG_DE_CABECALHO.test(a)) proximo = 'cabecalho';
      else if (NOME_SENSIVEL.test(a)) proximo = 'segredo';
      out.push(a);
      continue;
    }
    const kv = /^([A-Za-z_][\w.-]*)=(.*)$/s.exec(a);
    if (kv && NOME_SENSIVEL.test(kv[1] ?? '')) {
      out.push(`${kv[1]}=${MASK}`);
      continue;
    }
    const cabecalho = /^([A-Za-z][\w-]*):\s+\S/.exec(a);
    if (cabecalho && NOME_SENSIVEL.test(cabecalho[1] ?? '')) {
      out.push(redactHeaderLine(a));
      continue;
    }
    out.push(redactTexto(a));
  }
  return out;
}

function mascararValores(obj: unknown): Record<string, string> | undefined {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  return Object.fromEntries(Object.keys(obj).map((k) => [k, MASK]));
}

/**
 * Cópia da descoberta sem segredo: env e headers com QUALQUER valor
 * mascarado, args e URLs saneados. Defesa em profundidade — vale mesmo que o
 * leitor de um agente esqueça de mascarar.
 */
export function sanitizeDiscovery(d: AgentDiscovery): AgentDiscovery {
  return {
    ...d,
    defaults: {
      ...d.defaults,
      ...(d.defaults.baseUrl !== undefined ? { baseUrl: redactUrl(d.defaults.baseUrl) } : {}),
    },
    mcpServers: d.mcpServers.map((s) => {
      // `headers` não está no contrato, mas um leitor pode repassá-lo cru
      // (`...spec`); se vier, só os NOMES saem.
      const extra = s as typeof s & { headers?: unknown };
      const headers = extra.headers !== undefined ? mascararValores(extra.headers) : undefined;
      return {
        ...s,
        ...(s.args !== undefined ? { args: redactArgs(s.args) } : {}),
        ...(s.url !== undefined ? { url: redactUrl(s.url) } : {}),
        ...(s.env !== undefined ? { env: mascararValores(s.env) ?? {} } : {}),
        ...(extra.headers !== undefined ? { headers: headers ?? {} } : {}),
      };
    }),
  };
}

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\b(?:api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*['"]?[A-Za-z0-9_\-/+=]{16,}/i,
];

/** Heurística conservadora: melhor recusar um falso positivo que gravar credencial. */
export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

function urlHasCredential(value: string): boolean {
  return (
    /\/\/[^/@\s]+@/.test(value) || /[?&](?:key|token|api_key|apikey|access_token|secret)=/i.test(value)
  );
}

// ---------------------------------------------------------------- descoberta

interface CacheEntry {
  at: number;
  value: AgentDiscovery;
}

export interface DiscoveryServiceOptions {
  ttlMs?: number;
  home?: string;
  now?: () => number;
}

/**
 * Combina o probe do registry (versão/binPath) com o leitor de descoberta, com
 * cache curto: descobrir lê vários arquivos e o painel pode consultar seguido.
 */
export class DiscoveryService {
  readonly #cache = new Map<string, CacheEntry>();
  readonly #ttl: number;
  readonly #home: string;
  readonly #now: () => number;

  constructor(
    private readonly registry: AgentRegistry,
    private readonly discover: DiscoverFn,
    options: DiscoveryServiceOptions = {},
  ) {
    this.#ttl = options.ttlMs ?? 30_000;
    this.#home = options.home ?? os.homedir();
    this.#now = options.now ?? Date.now;
  }

  /** Descoberta crua (uso interno do import). Nunca sai do processo. */
  async raw(agentId: string, refresh = false, projectDir?: string): Promise<AgentDiscovery> {
    if (!this.registry.has(agentId)) {
      throw new HubError('AGENT_NOT_FOUND', `agente "${agentId}" não existe no registry`, { agentId });
    }
    const key = `${agentId}|${projectDir ?? ''}`;
    const hit = this.#cache.get(key);
    if (!refresh && hit && this.#now() - hit.at < this.#ttl) return hit.value;

    let installed: DiscoverOptions['installed'] = null;
    try {
      const probe = await this.registry.probe(agentId, refresh);
      if (probe.installed && probe.binPath) {
        installed = { version: probe.version, binPath: probe.binPath };
      }
    } catch {
      installed = null;
    }

    let value: AgentDiscovery;
    try {
      value = await this.discover(agentId, {
        home: this.#home,
        ...(projectDir !== undefined ? { projectDir } : {}),
        installed,
      });
    } catch (err) {
      // Falha de leitura não derruba a listagem — vira aviso explícito.
      value = {
        agentId,
        installed: installed !== null,
        version: installed?.version ?? null,
        binPath: installed?.binPath ?? null,
        auth: { state: 'unknown', evidence: [] },
        defaults: {},
        files: [],
        mcpServers: [],
        instructionFiles: [],
        warnings: [`falha ao descobrir: ${(err as Error).message}`],
      };
    }
    this.#cache.set(key, { at: this.#now(), value });
    return value;
  }

  async one(agentId: string, refresh = false, projectDir?: string): Promise<AgentDiscovery> {
    return sanitizeDiscovery(await this.raw(agentId, refresh, projectDir));
  }

  async all(refresh = false): Promise<AgentDiscovery[]> {
    const ids = this.registry.ids();
    const out: AgentDiscovery[] = [];
    // Em lotes de 2: mesma razão de `probeAll` (subir vários .exe juntos no Windows).
    for (let i = 0; i < ids.length; i += 2) {
      out.push(...(await Promise.all(ids.slice(i, i + 2).map((id) => this.one(id, refresh)))));
    }
    return out;
  }
}

// -------------------------------------------------------------------- import

export interface ImportRequest {
  agentId: string;
  kinds: ImportKind[];
  dryRun: boolean;
  targetAgents?: string[];
  overwrite?: boolean;
  includeEnv?: boolean;
}

export interface ProjectAccess {
  path: string;
  getContext(): ProjectContext;
  setContext(ctx: ProjectContext): void;
}

/** Limite de instrução por agente (o mesmo de `ProjectContextSchema`). */
export const MAX_PROMPT_CHARS = 8_000;

export type McpEnvReader = (server: { name: string; source: string }) => Record<string, string>;

export interface ImportServiceOptions {
  home?: string;
  /** Lê os valores REAIS do env de um servidor na origem. Injetável para teste. */
  readMcpEnv?: McpEnvReader;
  /** Nome da variável de ambiente para model/baseUrl de cada agente (injetável para teste). */
  envVarNames?: {
    model: (agentId: string) => string | null;
    baseUrl: (agentId: string) => string | null;
  };
}

export class ImportService {
  readonly #targets: McpTarget[];
  readonly #readMcpEnv: McpEnvReader;
  readonly #envVarNames: NonNullable<ImportServiceOptions['envVarNames']>;

  constructor(
    private readonly discovery: DiscoveryService,
    options: ImportServiceOptions = {},
  ) {
    this.#targets = mcpTargets(options.home ?? os.homedir());
    this.#readMcpEnv = options.readMcpEnv ?? readMcpEnvFromSource;
    // Mesma tabela que o painel usa para decidir que campos mostrar
    // (`core/agent-env.ts`): importar e configurar à mão não podem divergir.
    this.#envVarNames = options.envVarNames ?? {
      model: (id) => variavelDoAgente(id, 'model'),
      baseUrl: (id) => variavelDoAgente(id, 'baseUrl'),
    };
  }

  async run(project: ProjectAccess, req: ImportRequest): Promise<ImportResult> {
    const kinds = [...new Set(req.kinds)];
    if (kinds.includes('mcp') && (req.targetAgents ?? []).length === 0) {
      throw new HubError(
        'INVALID_BRIEF',
        'kind "mcp" exige targetAgents (para quais agentes compartilhar as ferramentas)',
        { field: 'targetAgents' },
      );
    }

    // Descoberta fresca: o plano tem de refletir o disco de agora, não o de 30s atrás.
    const found = await this.discovery.raw(req.agentId, true, project.path);
    const items: ImportPlanItem[] = [];
    const skipped: ImportResult['skipped'] = [];

    // Contexto lido uma vez, gravado uma vez, e só se não for dry-run.
    const ctx: ProjectContext = structuredClone(project.getContext());
    let ctxChanged = false;

    if (kinds.includes('instructions')) {
      ctxChanged = this.#instructions(found, req, ctx, items, skipped) || ctxChanged;
    }
    if (kinds.includes('env')) {
      ctxChanged = this.#env(found, req, ctx, items, skipped) || ctxChanged;
    }
    if (kinds.includes('mcp')) {
      this.#mcp(found, req, project.path, items, skipped);
    }

    if (!req.dryRun && ctxChanged) {
      project.setContext(ctx);
      for (const item of items) {
        if (item.kind !== 'mcp' && item.applied === false && item.target.startsWith('project-')) {
          item.applied = true;
        }
      }
    }
    return { agentId: req.agentId, dryRun: req.dryRun, items, skipped };
  }

  #instructions(
    found: AgentDiscovery,
    req: ImportRequest,
    ctx: ProjectContext,
    items: ImportPlanItem[],
    skipped: ImportResult['skipped'],
  ): boolean {
    if (found.instructionFiles.length === 0) {
      skipped.push({ what: 'instructions', reason: 'nenhum arquivo de instrução global descoberto' });
      return false;
    }
    if (ctx.prompts?.[req.agentId] !== undefined && req.overwrite !== true) {
      skipped.push({
        what: 'instructions',
        reason: `o projeto já tem instrução para "${req.agentId}"; use overwrite: true para substituir`,
      });
      return false;
    }

    const parts: string[] = [];
    for (const file of found.instructionFiles) {
      try {
        if (!statSync(file.path).isFile()) throw new Error('não é arquivo');
        const text = readFileSync(file.path, 'utf8').trim();
        if (text.length > 0)
          parts.push(
            found.instructionFiles.length > 1 ? `# ${path.basename(file.path)}\n\n${text}` : text,
          );
      } catch {
        skipped.push({ what: `instructions:${path.basename(file.path)}`, reason: 'arquivo ilegível' });
      }
    }
    const text = parts.join('\n\n');
    if (text.length === 0) {
      skipped.push({ what: 'instructions', reason: 'arquivos de instrução vazios' });
      return false;
    }
    if (text.length > MAX_PROMPT_CHARS) {
      skipped.push({
        what: 'instructions',
        reason: `instrução com ${text.length} caracteres excede o limite de ${MAX_PROMPT_CHARS} por agente; não é truncada em silêncio`,
      });
      return false;
    }
    if (looksLikeSecret(text)) {
      skipped.push({
        what: 'instructions',
        // O destino é o contexto do projeto no BANCO do Hub (migração 6), não
        // o `.agents-hub/config.yaml` versionado — mas lá o texto fica em claro
        // e entra no prompt de toda sessão do agente, então segredo continua fora.
        reason:
          'o conteúdo parece conter credencial; a instrução iria em texto puro para o banco do Hub e para o prompt de toda sessão do agente, então não foi importada',
      });
      return false;
    }

    ctx.prompts = { ...(ctx.prompts ?? {}), [req.agentId]: text };
    items.push({
      kind: 'instructions',
      description: `${parts.length} arquivo(s) de instrução global, ${text.length} caracteres, como instrução de "${req.agentId}"`,
      target: 'project-prompt',
      applied: false,
    });
    return true;
  }

  #env(
    found: AgentDiscovery,
    req: ImportRequest,
    ctx: ProjectContext,
    items: ImportPlanItem[],
    skipped: ImportResult['skipped'],
  ): boolean {
    const candidates: Array<[string, string]> = [];
    // Sem variável que o CLI realmente leia, importar seria um controle fantasma:
    // grava algo que o agente ignora. Esses vão para `skipped`, com o motivo.
    const semVar = (what: string): void => {
      skipped.push({
        what,
        reason: `${req.agentId} não lê ${what.split(':')[1]} do ambiente; ele já usa a própria config ao ser lançado pelo Hub`,
      });
    };
    if (found.defaults.model) {
      const nome = this.#envVarNames.model(req.agentId);
      if (nome) candidates.push([nome, found.defaults.model]);
      else semVar('env:model');
    }
    if (found.defaults.baseUrl) {
      const nome = this.#envVarNames.baseUrl(req.agentId);
      if (nome) candidates.push([nome, found.defaults.baseUrl]);
      else semVar('env:baseUrl');
    }
    if (found.defaults.provider) {
      skipped.push({
        what: 'env:provider',
        reason: 'provedor não tem variável de ambiente equivalente; só model e baseUrl são importados',
      });
    }
    if (candidates.length === 0) {
      skipped.push({ what: 'env', reason: 'nenhum default (model/baseUrl) descoberto' });
      return false;
    }

    const atual = ctx.env?.[req.agentId] ?? {};
    const aceitas: Record<string, string> = {};
    for (const [nome, valor] of candidates) {
      // 1) lista de permissão — a MESMA que vale para o env de projeto (banco do Hub e config.yaml)
      const { aceitas: ok } = filtrarEnvDeProjeto({ [nome]: valor });
      if (!(nome in ok)) {
        skipped.push({
          what: `env:${nome}`,
          reason: 'fora da lista de permissão de ambiente do projeto',
        });
        continue;
      }
      // 2) nunca segredo: o destino (banco do Hub) guarda em texto puro, e o
      // valor é repassado a todo processo do agente neste projeto
      if (looksLikeSecret(valor) || urlHasCredential(valor)) {
        skipped.push({
          what: `env:${nome}`,
          reason:
            'o valor parece conter credencial; o env do projeto fica em texto puro no banco do Hub, então não foi importado',
        });
        continue;
      }
      // 3) não sobrescreve sem pedir
      if (nome in atual && req.overwrite !== true) {
        skipped.push({
          what: `env:${nome}`,
          reason: 'já definida no projeto; use overwrite: true para substituir',
        });
        continue;
      }
      aceitas[nome] = valor;
      items.push({
        kind: 'env',
        description: `${nome}=${valor} para "${req.agentId}"`,
        target: 'project-env',
        applied: false,
      });
    }
    if (Object.keys(aceitas).length === 0) return false;
    ctx.env = { ...(ctx.env ?? {}), [req.agentId]: { ...atual, ...aceitas } };
    return true;
  }

  #mcp(
    found: AgentDiscovery,
    req: ImportRequest,
    projectPath: string,
    items: ImportPlanItem[],
    skipped: ImportResult['skipped'],
  ): void {
    const origem = found.mcpServers.filter((s) => !s.isHub && s.name !== 'agents-hub');
    if (origem.length === 0) {
      skipped.push({
        what: 'mcp',
        reason: 'nenhum servidor MCP (além do próprio Hub) descoberto na origem',
      });
      return;
    }

    for (const destino of [...new Set(req.targetAgents ?? [])]) {
      if (destino === req.agentId) {
        skipped.push({ what: `mcp → ${destino}`, reason: 'destino igual à origem' });
        continue;
      }
      const target = this.#targets.find((t) => t.agentId === destino);
      if (!target) {
        skipped.push({ what: `mcp → ${destino}`, reason: 'agente sem destino MCP conhecido' });
        continue;
      }
      if (!target.verified) {
        skipped.push({
          what: `mcp → ${destino}`,
          reason:
            'caminho/formato de config MCP não confirmado para este agente; não gravamos em palpite',
        });
        continue;
      }

      const configPath = resolveConfigPath(target, projectPath);
      let presentes: Set<string>;
      try {
        presentes = existingServerNames(target, configPath);
      } catch (err) {
        skipped.push({ what: `mcp → ${destino}`, reason: (err as Error).message });
        continue;
      }

      const portaveis: PortableMcpServer[] = [];
      const envCopiado: string[] = [];
      for (const s of origem) {
        const rotulo = `mcp:${s.name} → ${destino}`;
        if (presentes.has(s.name)) {
          skipped.push({ what: rotulo, reason: 'já existe no destino; mantido como está' });
          continue;
        }
        const portavel = toPortable(s);
        if (!portavel) {
          skipped.push({
            what: rotulo,
            reason: `transporte "${s.transport}" sem comando/url utilizável`,
          });
          continue;
        }
        // R05-07: a importação lê a descoberta CRUA (precisa do comando real),
        // e `/discovery` mascarar não protegia nada aqui. Segredo em args/URL
        // PULA o servidor em vez de ir mascarado: `--api-key ***` gravado
        // seria um servidor que sobe e falha na autenticação — um arquivo
        // quebrado com cara de certo, e o destino pode ser o `.mcp.json`
        // versionado do projeto. Credencial de MCP tem caminho próprio: `env`
        // com `includeEnv`. Vale também no dry-run, para a prévia ser a verdade.
        if (temSegredoEmClaro(portavel)) {
          skipped.push({
            what: rotulo,
            reason:
              'argumento ou URL com cara de segredo (chave, token, cabeçalho de autorização) — ' +
              'não gravamos credencial em claro no arquivo de config; mova-a para uma variável ' +
              'de ambiente do servidor (env) e importe com includeEnv',
          });
          continue;
        }
        if (portavel.transport === 'sse' && target.format === 'toml-codex') {
          skipped.push({ what: rotulo, reason: 'o Codex não suporta servidores SSE' });
          continue;
        }

        const nomesEnv = Object.keys(s.env ?? {});
        if (nomesEnv.length > 0) {
          if (req.includeEnv === true) {
            const reais = this.#readMcpEnv({ name: s.name, source: s.source });
            const copia: Record<string, string> = {};
            for (const nome of nomesEnv) {
              const v = reais[nome];
              if (typeof v === 'string' && v.length > 0 && v !== MASK) copia[nome] = v;
              else
                skipped.push({
                  what: `${rotulo} env:${nome}`,
                  reason: 'valor não encontrado na origem; não copiado',
                });
            }
            if (Object.keys(copia).length > 0) {
              portavel.env = copia;
              envCopiado.push(`${s.name}(${Object.keys(copia).join(',')})`);
            }
          } else {
            skipped.push({
              what: `${rotulo} env`,
              reason: `variáveis ${nomesEnv.join(', ')} não copiadas (includeEnv não foi pedido)`,
            });
          }
        }
        portaveis.push(portavel);
      }

      if (portaveis.length === 0) continue;
      const nomes = portaveis.map((p) => p.name);
      const item: ImportPlanItem = {
        kind: 'mcp',
        description:
          `adicionar ${nomes.length} servidor(es) MCP: ${nomes.join(', ')}` +
          (envCopiado.length > 0 ? `; env copiado (só nomes): ${envCopiado.join(' ')}` : ''),
        target: configPath,
        applied: false,
      };
      if (!req.dryRun) {
        try {
          const out = addMcpServers(target, configPath, portaveis);
          item.applied = out.added.length > 0;
        } catch (err) {
          skipped.push({ what: `mcp → ${destino}`, reason: (err as Error).message });
          continue;
        }
      }
      items.push(item);
    }
  }
}

/**
 * O servidor carregaria segredo em claro para o arquivo de destino? Mesmo
 * critério que mascara `/discovery` (`redactArgs`/`redactUrl`): se sanear
 * muda alguma coisa, havia segredo ali.
 */
function temSegredoEmClaro(p: PortableMcpServer): boolean {
  const args = p.args ?? [];
  if (redactArgs(args).some((a, i) => a !== args[i])) return true;
  if (p.command !== undefined && redactTexto(p.command) !== p.command) return true;
  return p.url !== undefined && redactUrl(p.url) !== p.url;
}

function toPortable(s: AgentDiscovery['mcpServers'][number]): PortableMcpServer | null {
  if (s.transport === 'stdio') {
    return s.command
      ? { name: s.name, transport: 'stdio', command: s.command, args: s.args ?? [] }
      : null;
  }
  if (s.transport === 'http' || s.transport === 'sse') {
    return s.url ? { name: s.name, transport: s.transport, url: s.url } : null;
  }
  return null;
}

// ------------------------------------------- leitura dos valores reais de env

/**
 * Lê o env REAL de um servidor no arquivo de origem. Só roda com `includeEnv`.
 * O retorno fica em memória e vai direto para o arquivo destino: nunca é
 * logado nem devolvido pela API.
 */
export function readMcpEnvFromSource(server: { name: string; source: string }): Record<string, string> {
  try {
    if (!existsSync(server.source)) return {};
    const raw = readFileSync(server.source, 'utf8');
    return server.source.toLowerCase().endsWith('.toml')
      ? envFromToml(raw, server.name)
      : envFromJson(raw, server.name);
  } catch {
    return {};
  }
}

function stringsOnly(o: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (o !== null && typeof o === 'object') {
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
  }
  return out;
}

function envFromJson(raw: string, name: string): Record<string, string> {
  const walk = (node: unknown, depth: number): Record<string, string> | null => {
    if (node === null || typeof node !== 'object' || depth > 6) return null;
    const obj = node as Record<string, unknown>;
    for (const key of ['mcpServers', 'mcp']) {
      const bucket = obj[key];
      if (bucket !== null && typeof bucket === 'object') {
        const entry = (bucket as Record<string, unknown>)[name];
        if (entry !== null && typeof entry === 'object') {
          const e = entry as Record<string, unknown>;
          return stringsOnly(e['env'] ?? e['environment']);
        }
      }
    }
    for (const v of Object.values(obj)) {
      const r = walk(v, depth + 1);
      if (r) return r;
    }
    return null;
  };
  return walk(JSON.parse(raw) as unknown, 0) ?? {};
}

function envFromToml(raw: string, name: string): Record<string, string> {
  const out: Record<string, string> = {};
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const header = new RegExp(`^\\[mcp_servers\\.(?:"${escaped}"|${escaped})(\\.env)?\\]\\s*$`, 'gm');
  const pair = /(?:^|[\s,])(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  for (const m of raw.matchAll(header)) {
    const start = (m.index ?? 0) + m[0].length;
    const rest = raw.slice(start);
    const next = rest.search(/^\[/m);
    const block = next === -1 ? rest : rest.slice(0, next);
    if (m[1] === '.env') {
      for (const p of block.matchAll(/^\s*(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*=\s*"((?:[^"\\]|\\.)*)"/gm)) {
        out[p[1] ?? p[2] ?? ''] = JSON.parse(`"${p[3]}"`) as string;
      }
    } else {
      const inline = /^\s*env\s*=\s*\{([^}]*)\}/m.exec(block);
      if (inline?.[1] !== undefined) {
        for (const p of inline[1].matchAll(pair)) {
          out[p[1] ?? p[2] ?? ''] = JSON.parse(`"${p[3]}"`) as string;
        }
      }
    }
  }
  return out;
}
