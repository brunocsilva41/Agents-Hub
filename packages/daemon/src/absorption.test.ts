import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

/** O único backup versionado (`<arquivo>.bak-*`) ao lado de `file`. */
function unicoBackup(file: string): string {
  const nomes = readdirSync(path.dirname(file)).filter((n) =>
    n.startsWith(`${path.basename(file)}.bak-`),
  );
  assert.equal(nomes.length, 1, `esperava 1 backup, achei ${nomes.join(', ')}`);
  return path.join(path.dirname(file), nomes[0]!);
}
import type { AgentDiscovery, ImportResult } from '@agents-hub/core';
import type { AgentRegistry } from '@agents-hub/adapters';
import {
  DiscoveryService,
  ImportService,
  looksLikeSecret,
  readMcpEnvFromSource,
  sanitizeDiscovery,
  type ProjectAccess,
} from './absorption.js';
import type { ProjectContext } from './project-config.js';

/**
 * Prova o modelo de segurança da absorção — cada teste falha se a proteção
 * correspondente sumir (dry-run que escreve, env fora da lista, segredo em
 * resposta, merge que duplica/apaga, backup ausente).
 */

const SEGREDO_ENV = 'SEGREDO-ENV-plantado-0123456789';
const SEGREDO_MODELO = 'sk-abcdefghijklmnopqrstuvwxyz012345';

function fakeRegistry(ids: string[]): AgentRegistry {
  return {
    has: (id: string) => ids.includes(id),
    ids: () => ids,
    probe: async (id: string) => ({
      agentId: id,
      installed: true,
      version: '1.2.3',
      authenticated: null,
      binPath: `/bin/${id}`,
      error: null,
      checkedAt: new Date().toISOString(),
    }),
  } as unknown as AgentRegistry;
}

function base(agentId: string, over: Partial<AgentDiscovery> = {}): AgentDiscovery {
  return {
    agentId,
    installed: true,
    version: '1.2.3',
    binPath: `/bin/${agentId}`,
    auth: { state: 'present', evidence: ['arquivo de credencial presente'] },
    defaults: {},
    files: [],
    mcpServers: [],
    instructionFiles: [],
    warnings: [],
    ...over,
  };
}

describe('sanitização e detecção de segredo', () => {
  test('sanitizeDiscovery mascara QUALQUER valor de env, mesmo que o leitor vaze', () => {
    const vazado = base('claude', {
      defaults: { baseUrl: 'https://user:senha123@host.dev/v1?api_key=abc' },
      mcpServers: [
        {
          name: 'x',
          transport: 'stdio',
          command: 'npx',
          env: { API_KEY: SEGREDO_ENV },
          source: '/f',
          isHub: false,
        },
      ],
    });
    const limpo = JSON.stringify(sanitizeDiscovery(vazado));
    assert.ok(!limpo.includes(SEGREDO_ENV));
    assert.ok(!limpo.includes('senha123'));
    assert.ok(!limpo.includes('api_key=abc'));
    assert.ok(limpo.includes('API_KEY'), 'o NOME da variável continua visível');
  });

  test('looksLikeSecret pega chaves comuns e não pega texto normal', () => {
    assert.ok(looksLikeSecret(SEGREDO_MODELO));
    assert.ok(looksLikeSecret('api_key = "abcdefghijklmnop1234"'));
    assert.ok(looksLikeSecret('-----BEGIN RSA PRIVATE KEY-----'));
    assert.ok(!looksLikeSecret('Prefira mudanças pequenas e testáveis.'));
  });
});

describe('DiscoveryService', () => {
  test('cache curto: segunda chamada não relê; refresh força releitura', async () => {
    let chamadas = 0;
    let agora = 1_000;
    const svc = new DiscoveryService(
      fakeRegistry(['claude']),
      async (id) => {
        chamadas += 1;
        return base(id);
      },
      { ttlMs: 30_000, now: () => agora },
    );
    await svc.one('claude');
    await svc.one('claude');
    assert.equal(chamadas, 1);
    await svc.one('claude', true);
    assert.equal(chamadas, 2);
    agora += 31_000; // TTL vencido
    await svc.one('claude');
    assert.equal(chamadas, 3);
  });

  test('combina probe do registry (versão/binPath) com o leitor', async () => {
    let recebido: unknown = null;
    const svc = new DiscoveryService(fakeRegistry(['claude']), async (id, opts) => {
      recebido = opts.installed;
      return base(id);
    });
    await svc.one('claude');
    assert.deepEqual(recebido, { version: '1.2.3', binPath: '/bin/claude' });
  });

  test('leitor que lança vira aviso, não derruba a listagem', async () => {
    const svc = new DiscoveryService(fakeRegistry(['a', 'b']), async (id) => {
      if (id === 'a') throw new Error('boom');
      return base(id);
    });
    const todos = await svc.all();
    assert.equal(todos.length, 2);
    assert.match(todos[0]?.warnings[0] ?? '', /boom/);
  });

  test('agente desconhecido -> AGENT_NOT_FOUND', async () => {
    const svc = new DiscoveryService(fakeRegistry(['a']), async (id) => base(id));
    await assert.rejects(() => svc.one('nao-existe'), /nao-existe/);
  });
});

describe('ImportService', () => {
  let raiz: string;
  let home: string;
  let projeto: string;

  before(() => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-abs-'));
  });
  after(() => {
    rmSync(raiz, { recursive: true, force: true });
  });

  let n = 0;
  function cenario(
    discovery: (dir: string) => AgentDiscovery,
    extra: { readMcpEnv?: () => Record<string, string> } = {},
  ) {
    n += 1;
    const dir = path.join(raiz, `c${n}`);
    home = path.join(dir, 'home');
    projeto = path.join(dir, 'projeto');
    mkdirSync(home, { recursive: true });
    mkdirSync(projeto, { recursive: true });
    const found = discovery(dir);
    const discSvc = new DiscoveryService(
      fakeRegistry([found.agentId, 'cursor', 'codex', 'claude', 'kimi']),
      async () => found,
      { home },
    );
    const svc = new ImportService(discSvc, { home, ...extra });

    let ctx: ProjectContext = {};
    const gravacoes: ProjectContext[] = [];
    const access: ProjectAccess = {
      path: projeto,
      getContext: () => ctx,
      setContext: (c) => {
        ctx = c;
        gravacoes.push(structuredClone(c));
      },
    };
    return {
      svc,
      access,
      home,
      projeto,
      dir,
      gravacoes,
      getCtx: () => ctx,
      setCtx: (c: ProjectContext) => (ctx = c),
    };
  }

  const req = (over: object = {}) => ({
    agentId: 'claude',
    kinds: ['instructions', 'env', 'mcp'] as ('instructions' | 'env' | 'mcp')[],
    dryRun: true,
    targetAgents: ['cursor', 'codex'],
    ...over,
  });

  function comServidores(dir: string): AgentDiscovery {
    const origem = path.join(dir, 'origem.json');
    writeFileSync(origem, JSON.stringify({ mcpServers: { fs: { env: { FS_TOKEN: SEGREDO_ENV } } } }));
    const instr = path.join(dir, 'CLAUDE.md');
    writeFileSync(instr, 'Sempre explique a decisão antes de aplicar.');
    return base('claude', {
      defaults: { model: 'claude-x', baseUrl: 'http://localhost:11434' },
      instructionFiles: [{ path: instr, bytes: 41 }],
      mcpServers: [
        {
          name: 'fs',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'fs-server'],
          env: { FS_TOKEN: '***' },
          source: origem,
          isHub: false,
        },
        {
          name: 'web',
          transport: 'http',
          url: 'https://mcp.exemplo.dev/mcp',
          source: origem,
          isHub: false,
        },
        {
          name: 'agents-hub',
          transport: 'stdio',
          command: 'node',
          args: ['hub.js'],
          source: origem,
          isHub: true,
        },
      ],
    });
  }

  const tudo = (r: ImportResult): string => JSON.stringify(r);

  test('dryRun não escreve NADA: nem config.yaml (setContext), nem config MCP de outro agente', async () => {
    const c = cenario(comServidores);
    const r = await c.svc.run(c.access, req());
    assert.equal(r.dryRun, true);
    assert.ok(r.items.length >= 3, 'o plano lista instruções, env e mcp');
    assert.ok(r.items.every((i) => i.applied === false));
    assert.equal(c.gravacoes.length, 0, 'setContext não pode ser chamado no dry-run');
    assert.ok(!existsSync(path.join(c.home, '.cursor')), 'nenhum diretório do cursor criado');
    assert.ok(!existsSync(path.join(c.home, '.codex')), 'nenhum diretório do codex criado');
    assert.ok(!existsSync(path.join(c.projeto, '.mcp.json')));
  });

  test('instructions: grava como instrução do agente; não sobrescreve sem overwrite', async () => {
    const c = cenario(comServidores);
    const r1 = await c.svc.run(c.access, req({ kinds: ['instructions'], dryRun: false }));
    assert.equal(r1.items[0]?.applied, true);
    assert.equal(c.getCtx().prompts?.['claude'], 'Sempre explique a decisão antes de aplicar.');

    c.setCtx({ prompts: { claude: 'MINHA instrução' } });
    const r2 = await c.svc.run(c.access, req({ kinds: ['instructions'], dryRun: false }));
    assert.equal(r2.items.length, 0);
    assert.match(r2.skipped[0]?.reason ?? '', /overwrite/);
    assert.equal(c.getCtx().prompts?.['claude'], 'MINHA instrução');

    await c.svc.run(c.access, req({ kinds: ['instructions'], dryRun: false, overwrite: true }));
    assert.equal(c.getCtx().prompts?.['claude'], 'Sempre explique a decisão antes de aplicar.');
  });

  test('instructions com credencial dentro NÃO são importadas (arquivo do projeto é versionado)', async () => {
    const c = cenario((dir) => {
      const f = path.join(dir, 'AGENTS.md');
      writeFileSync(f, `use esta chave: ${SEGREDO_MODELO}`);
      return base('claude', { instructionFiles: [{ path: f, bytes: 50 }] });
    });
    const r = await c.svc.run(c.access, req({ kinds: ['instructions'], dryRun: false }));
    assert.equal(c.gravacoes.length, 0);
    assert.match(r.skipped[0]?.reason ?? '', /credencial/);
    assert.ok(!tudo(r).includes(SEGREDO_MODELO));
  });

  test('env: model/baseUrl permitidos entram; valor jamais vira segredo', async () => {
    const c = cenario(comServidores);
    const r = await c.svc.run(c.access, req({ kinds: ['env'], dryRun: false }));
    assert.deepEqual(c.getCtx().env?.['claude'], {
      ANTHROPIC_MODEL: 'claude-x',
      ANTHROPIC_BASE_URL: 'http://localhost:11434',
    });
    assert.ok(r.items.every((i) => i.applied));
  });

  test('env: agente sem variável de ambiente real (kimi) NÃO recebe MODEL fantasma; vai em skipped', async () => {
    const c = cenario((dir) => ({ ...comServidores(dir), agentId: 'kimi' }));
    const r = await c.svc.run(c.access, req({ agentId: 'kimi', kinds: ['env'], dryRun: false }));
    assert.equal(c.getCtx().env?.['kimi'], undefined);
    assert.equal(c.gravacoes.length, 0);
    assert.ok(r.skipped.some((s) => s.what === 'env:model' && /não lê/.test(s.reason)));
    assert.ok(r.skipped.some((s) => s.what === 'env:baseUrl'));
  });

  test('env: nome fora da lista de permissão é REJEITADO e vai em skipped com motivo', async () => {
    const c = cenario(comServidores);
    // Mapeamento sabotado de propósito: se a lista de permissão sumir, NODE_OPTIONS entra.
    const svc = new ImportService(
      new DiscoveryService(fakeRegistry(['claude']), async () => comServidores(c.dir), { home: c.home }),
      { home: c.home, envVarNames: { model: () => 'NODE_OPTIONS', baseUrl: () => 'PATH' } },
    );
    const r = await svc.run(c.access, req({ kinds: ['env'], dryRun: false }));
    assert.equal(c.gravacoes.length, 0, 'nada gravado');
    assert.equal(r.items.length, 0);
    const motivos = r.skipped.filter((s) => s.what === 'env:NODE_OPTIONS' || s.what === 'env:PATH');
    assert.equal(motivos.length, 2);
    assert.ok(motivos.every((m) => /lista de permissão/.test(m.reason)));
  });

  test('env: valor com cara de segredo ou URL com credencial é rejeitado e não aparece na resposta', async () => {
    const c = cenario(() =>
      base('claude', { defaults: { model: SEGREDO_MODELO, baseUrl: 'https://u:senha-xyz@api.dev/v1' } }),
    );
    const r = await c.svc.run(c.access, req({ kinds: ['env'], dryRun: false }));
    assert.equal(c.gravacoes.length, 0);
    assert.equal(r.skipped.length, 2);
    const texto = tudo(r);
    assert.ok(!texto.includes(SEGREDO_MODELO));
    assert.ok(!texto.includes('senha-xyz'));
  });

  test('env: variável já definida no projeto não é sobrescrita sem overwrite', async () => {
    const c = cenario(comServidores);
    c.setCtx({ env: { claude: { ANTHROPIC_MODEL: 'meu-modelo' } } });
    await c.svc.run(c.access, req({ kinds: ['env'], dryRun: false }));
    assert.equal(c.getCtx().env?.['claude']?.['ANTHROPIC_MODEL'], 'meu-modelo');
    assert.equal(c.getCtx().env?.['claude']?.['ANTHROPIC_BASE_URL'], 'http://localhost:11434');
  });

  test('mcp: merge não duplica nem apaga; cria .bak; ignora o servidor do Hub', async () => {
    const c = cenario(comServidores);
    const cursorFile = path.join(c.home, '.cursor', 'mcp.json');
    mkdirSync(path.dirname(cursorFile), { recursive: true });
    const original = JSON.stringify(
      { tema: 'escuro', mcpServers: { fs: { command: 'MEU-FS' }, antigo: { command: 'x' } } },
      null,
      2,
    );
    writeFileSync(cursorFile, original);

    const r = await c.svc.run(
      c.access,
      req({ kinds: ['mcp'], targetAgents: ['cursor'], dryRun: false }),
    );
    const doc = JSON.parse(readFileSync(cursorFile, 'utf8')) as {
      tema: string;
      mcpServers: Record<string, Record<string, unknown>>;
    };

    assert.equal(doc.tema, 'escuro', 'chaves alheias preservadas');
    assert.equal(doc.mcpServers['fs']?.['command'], 'MEU-FS', 'entrada existente NÃO é sobrescrita');
    assert.ok(doc.mcpServers['antigo'], 'entrada existente NÃO é apagada');
    assert.deepEqual(doc.mcpServers['web'], { url: 'https://mcp.exemplo.dev/mcp' });
    assert.ok(!('agents-hub' in doc.mcpServers), 'o Hub não é reimportado');
    assert.equal(readFileSync(unicoBackup(cursorFile), 'utf8'), original, 'backup é o estado anterior');
    assert.ok(r.skipped.some((s) => s.what === 'mcp:fs → cursor' && /já existe/.test(s.reason)));

    // segunda execução: nada novo, nada duplicado
    const antes = readFileSync(cursorFile, 'utf8');
    const r2 = await c.svc.run(
      c.access,
      req({ kinds: ['mcp'], targetAgents: ['cursor'], dryRun: false }),
    );
    assert.equal(r2.items.length, 0);
    assert.equal(readFileSync(cursorFile, 'utf8'), antes);
  });

  test('mcp: Codex (TOML) recebe seções ao final, sem tocar no que existe, com .bak', async () => {
    const c = cenario(comServidores);
    const tomlFile = path.join(c.home, '.codex', 'config.toml');
    mkdirSync(path.dirname(tomlFile), { recursive: true });
    const original = 'model = "gpt-x"\n\n[mcp_servers.fs]\ncommand = "MEU-FS"\n';
    writeFileSync(tomlFile, original);

    await c.svc.run(c.access, req({ kinds: ['mcp'], targetAgents: ['codex'], dryRun: false }));
    const novo = readFileSync(tomlFile, 'utf8');
    assert.ok(novo.startsWith(original), 'conteúdo original intacto no início');
    assert.equal((novo.match(/\[mcp_servers\.fs\]/g) ?? []).length, 1, 'fs não duplicado');
    assert.ok(
      novo.includes('[mcp_servers.web]') && novo.includes('url = "https://mcp.exemplo.dev/mcp"'),
    );
    assert.equal(readFileSync(unicoBackup(tomlFile), 'utf8'), original);
  });

  test('mcp: sem includeEnv, NENHUM valor de env é copiado nem exposto', async () => {
    const c = cenario(comServidores, { readMcpEnv: () => ({ FS_TOKEN: SEGREDO_ENV }) });
    const r = await c.svc.run(
      c.access,
      req({ kinds: ['mcp'], targetAgents: ['cursor'], dryRun: false }),
    );
    const arquivo = readFileSync(path.join(c.home, '.cursor', 'mcp.json'), 'utf8');
    assert.ok(!arquivo.includes(SEGREDO_ENV));
    assert.ok(!arquivo.includes('FS_TOKEN'));
    assert.ok(!tudo(r).includes(SEGREDO_ENV));
    assert.ok(r.skipped.some((s) => /includeEnv/.test(s.reason)));
  });

  test('mcp: includeEnv copia só valores que existem na origem; resposta segue sem valor', async () => {
    const c = cenario(comServidores, { readMcpEnv: () => ({ FS_TOKEN: SEGREDO_ENV }) });
    const r = await c.svc.run(
      c.access,
      req({ kinds: ['mcp'], targetAgents: ['cursor'], dryRun: false, includeEnv: true }),
    );
    const doc = JSON.parse(readFileSync(path.join(c.home, '.cursor', 'mcp.json'), 'utf8')) as {
      mcpServers: { fs: { env: Record<string, string> } };
    };
    assert.equal(doc.mcpServers.fs.env['FS_TOKEN'], SEGREDO_ENV);
    assert.ok(!tudo(r).includes(SEGREDO_ENV), 'valor nunca sai na resposta');
    assert.ok(tudo(r).includes('FS_TOKEN'), 'só o nome aparece');

    // valor ausente na origem (ou a própria máscara) -> não copia
    const c2 = cenario(comServidores, { readMcpEnv: () => ({ FS_TOKEN: '***' }) });
    const r2 = await c2.svc.run(
      c2.access,
      req({ kinds: ['mcp'], targetAgents: ['cursor'], dryRun: false, includeEnv: true }),
    );
    const doc2 = JSON.parse(readFileSync(path.join(c2.home, '.cursor', 'mcp.json'), 'utf8')) as {
      mcpServers: { fs: Record<string, unknown> };
    };
    assert.equal(doc2.mcpServers.fs['env'], undefined);
    assert.ok(r2.skipped.some((s) => /não encontrado na origem/.test(s.reason)));
  });

  test('mcp: dry-run com includeEnv também não escreve nem vaza', async () => {
    const c = cenario(comServidores, { readMcpEnv: () => ({ FS_TOKEN: SEGREDO_ENV }) });
    const r = await c.svc.run(
      c.access,
      req({ kinds: ['mcp'], targetAgents: ['cursor'], includeEnv: true }),
    );
    assert.ok(!existsSync(path.join(c.home, '.cursor')));
    assert.ok(!tudo(r).includes(SEGREDO_ENV));
  });

  test('mcp: destino não confirmado (kimi) e destino = origem são pulados, sem escrever', async () => {
    const c = cenario(comServidores);
    const r = await c.svc.run(
      c.access,
      req({ kinds: ['mcp'], targetAgents: ['kimi', 'claude'], dryRun: false }),
    );
    assert.equal(r.items.length, 0);
    assert.ok(r.skipped.some((s) => s.what === 'mcp → kimi' && /não confirmado/.test(s.reason)));
    assert.ok(r.skipped.some((s) => s.what === 'mcp → claude' && /igual à origem/.test(s.reason)));
    assert.ok(!existsSync(path.join(c.home, '.kimi-code')));
  });

  test('mcp: config de destino com JSON inválido não é sobrescrito', async () => {
    const c = cenario(comServidores);
    const f = path.join(c.home, '.cursor', 'mcp.json');
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, '{ quebrado');
    const r = await c.svc.run(
      c.access,
      req({ kinds: ['mcp'], targetAgents: ['cursor'], dryRun: false }),
    );
    assert.equal(readFileSync(f, 'utf8'), '{ quebrado');
    assert.ok(r.skipped.some((s) => /JSON válido/.test(s.reason)));
  });

  test('mcp sem targetAgents é erro explícito', async () => {
    const c = cenario(comServidores);
    await assert.rejects(
      () => c.svc.run(c.access, { agentId: 'claude', kinds: ['mcp'], dryRun: true }),
      /targetAgents/,
    );
  });
});

describe('readMcpEnvFromSource', () => {
  test('lê env de JSON aninhado e de TOML (inline e subtabela)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hub-env-'));
    try {
      const j = path.join(dir, 'a.json');
      writeFileSync(
        j,
        JSON.stringify({ projects: { p: { mcpServers: { fs: { env: { K: 'v1' } } } } } }),
      );
      assert.deepEqual(readMcpEnvFromSource({ name: 'fs', source: j }), { K: 'v1' });

      const t = path.join(dir, 'c.toml');
      writeFileSync(
        t,
        '[mcp_servers.a]\ncommand = "x"\nenv = { K1 = "v1", K2 = "v2" }\n\n[mcp_servers.b]\ncommand = "y"\n\n[mcp_servers.b.env]\nK3 = "v3"\n',
      );
      assert.deepEqual(readMcpEnvFromSource({ name: 'a', source: t }), { K1: 'v1', K2: 'v2' });
      assert.deepEqual(readMcpEnvFromSource({ name: 'b', source: t }), { K3: 'v3' });
      assert.deepEqual(
        readMcpEnvFromSource({ name: 'a', source: path.join(dir, 'nao-existe.toml') }),
        {},
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
