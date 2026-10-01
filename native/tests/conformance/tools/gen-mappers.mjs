#!/usr/bin/env node
/**
 * CONF-02 — gerador do corpus de conformidade dos mappers de eventos e da
 * montagem de invocação dos adapters.
 *
 * Importa o código TS de `packages/adapters/src` e `packages/core/src`
 * DIRETAMENTE (os `dist/` podem estar defasados) e grava, em
 * `native/tests/conformance/mappers/`, a saída REAL das funções para cada
 * entrada. Nada de valor esperado é escrito à mão: toda saída é computada.
 *
 * Uso (da raiz do repositório):
 *   node --experimental-transform-types native/tests/conformance/tools/gen-mappers.mjs
 *   node --experimental-transform-types native/tests/conformance/tools/gen-mappers.mjs --out <dir>
 *
 * Não spawna processo, não sobe daemon, não chama agente nem modelo.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, '..', '..', '..', '..');
const ADAPTERS = path.join(RAIZ, 'packages', 'adapters', 'src');
const CORE = path.join(RAIZ, 'packages', 'core', 'src');
const MANIFESTOS = path.join(RAIZ, 'manifests');

const argOut = process.argv.indexOf('--out');
const OUT = argOut >= 0 ? path.resolve(process.argv[argOut + 1]) : path.resolve(AQUI, '..', 'mappers');

if (!process.execArgv.some((a) => a.startsWith('--experimental-transform-types'))) {
  console.error('rode com: node --experimental-transform-types ' + path.relative(process.cwd(), fileURLToPath(import.meta.url)));
  process.exit(2);
}

// --- trava 1: hash das fontes (texto normalizado para LF) ------------------
// O repositório usa core.autocrlf=true: o hash é do texto com CRLF → LF, para
// valer igual em qualquer checkout. Se uma fonte diverge do que está gravado em
// `mappers/sources.json`, o gerador PARA. Só `--aceitar-fontes` (revisão
// deliberada do corpus) aceita as fontes atuais e regrava os hashes.
const lerNormalizado = (rel) => readFileSync(path.join(RAIZ, rel), 'utf8').replace(/\r\n/g, '\n');
const sha = (texto) => createHash('sha256').update(texto).digest('hex');
const yamls = (dir) => readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort();
const FONTES = [
  ...['mappers/index.ts', 'mappers/claude.ts', 'mappers/codex.ts', 'mappers/copilot.ts', 'mappers/kimi.ts', 'mappers/antigravity.ts', 'mappers/generic.ts', 'opencode/events.ts', 'opencode/adapter.ts', 'process-adapter.ts', 'failure-reason.ts', 'types.ts', 'registry.ts', 'async-queue.ts'].map((f) => `packages/adapters/src/${f}`),
  'packages/core/src/turn-cost.ts',
  'packages/core/src/texto.ts',
  'packages/core/src/pricing.ts',
  ...yamls(MANIFESTOS).map((f) => `manifests/${f}`),
];
const fontes = Object.fromEntries(FONTES.map((f) => [f, sha(lerNormalizado(f))]));
const SOURCES_JSON = path.resolve(AQUI, '..', 'mappers', 'sources.json');
if (!process.argv.includes('--aceitar-fontes')) {
  let gravado = null;
  try {
    gravado = JSON.parse(readFileSync(SOURCES_JSON, 'utf8')).sources ?? null;
  } catch {
    gravado = null;
  }
  if (!gravado) {
    console.error(`sem ${SOURCES_JSON}: rode com --aceitar-fontes para congelar as fontes atuais`);
    process.exit(1);
  }
  const nomes = [...new Set([...Object.keys(gravado), ...Object.keys(fontes)])].sort();
  const divergentes = nomes.filter((n) => gravado[n] !== fontes[n]);
  if (divergentes.length > 0) {
    console.error('fontes divergem de mappers/sources.json (o corpus estaria desatualizado):\n  ' + divergentes.join('\n  '));
    console.error('revise o corpus e rode com --aceitar-fontes para regravar.');
    process.exit(1);
  }
}

// --- hook de resolução: `.js` relativo → `.ts`; `@agents-hub/core` → src ----
const CORE_INDEX = pathToFileURL(path.join(CORE, 'index.ts')).href;
const HOOK = `
export async function resolve(spec, ctx, next) {
  if (spec === '@agents-hub/core') return next(${JSON.stringify(CORE_INDEX)}, ctx);
  try {
    return await next(spec, ctx);
  } catch (err) {
    if (spec.endsWith('.js') && (spec.startsWith('.') || spec.startsWith('file:'))) {
      return next(spec.slice(0, -3) + '.ts', ctx);
    }
    throw err;
  }
}`;
register('data:text/javascript,' + encodeURIComponent(HOOK), import.meta.url);

const imp = (rel) => import(pathToFileURL(path.join(ADAPTERS, rel)).href);
const { resolveMapper, listMappers } = await imp('mappers/index.ts');
const { montarInvocacao } = await imp('process-adapter.ts');
const { loadManifestFile, loadManifestDir } = await imp('registry.ts');
const { AgentManifestSchema } = await imp('types.ts');
const failure = await imp('failure-reason.ts');
const oc = await imp('opencode/events.ts');
const { TurnCostTracker } = await import(CORE_INDEX);

// --- trechos REPLICADOS (privados no TS) — guardados contra drift -----------
// Cada bloco é o texto EXATO e CONTÍGUO das linhas [início..fim] do fonte
// (normalizado para LF). Qualquer mudança dentro do bloco, ou que o desloque,
// faz o gerador parar em vez de gravar um corpus desatualizado.
const BLOCOS_REPLICADOS = [
  // usesStdin: de onde vem a entrega por stdin
  ["packages/adapters/src/process-adapter.ts", 212, [
    "    const usesStdin = this.manifest.invoke.stdinPrompt;",
  ]],
  // env do processo do agente
  ["packages/adapters/src/process-adapter.ts", 249, [
    "    const env: NodeJS.ProcessEnv = {",
    "      ...process.env,",
    "      ...this.manifest.invoke.env,",
    "      ...ctx.env,",
    "      AGENTS_HUB_SESSION_ID: ctx.sessionId,",
    "      AGENTS_HUB_TASK_ID: ctx.taskId ?? '',",
    "      AGENTS_HUB_AGENT_ID: ctx.agentId,",
    "    };",
  ]],
  // stdout: id nativo (1º visto) e erros do agente (até 20)
  ["packages/adapters/src/process-adapter.ts", 486, [
    "    lerLinhas(child.stdout, (line) => {",
    "      if (saturada) return;",
    "      handle.touch();",
    "      for (const mapped of this.#mapLine(line)) {",
    "        const erro = mensagemDoEventoDeErro(mapped);",
    "        if (erro) {",
    "          errosDoAgente.push(erro);",
    "          if (errosDoAgente.length > 20) errosDoAgente.shift();",
    "        }",
    "        if (mapped.nativeSessionId && !discoveredNativeId) {",
    "          discoveredNativeId = mapped.nativeSessionId;",
    "          handle.nativeSessionId = mapped.nativeSessionId;",
    "        }",
    "        if (!pushComTeto(mapped)) break;",
    "      }",
    "    });",
  ]],
  // stdin: escreve o prompt e fecha se não for interativo
  ["packages/adapters/src/process-adapter.ts", 539, [
    "    if (usesStdin) {",
    "      // Sem callback aqui, uma falha na escrita (EPIPE: o CLI já saiu, ou",
    "      // nunca chegou a consumir stdin) some silenciosamente — a run fica",
    "      // pendurada esperando eventos que nunca vêm, até o heartbeat/timeout",
    "      // estourar sem nenhuma pista do motivo. `send()` já trata isso; o",
    "      // prompt inicial precisa do mesmo tratamento.",
    "      child.stdin.write(prompt, (err) => {",
    "        if (!err) return;",
    "        handle.settle({",
    "          exitCode: null,",
    "          signal: null,",
    "          reason: 'error',",
    "          error: `falha ao escrever o prompt inicial em stdin: ${err.message}`,",
    "          nativeSessionId: discoveredNativeId,",
    "          tail: tail.join('\\n'),",
    "        });",
    "        // O processo pode continuar vivo mesmo com a escrita tendo falhado",
    "        // (ex.: ele destruiu só o lado de leitura do próprio stdin) — sem",
    "        // isto, a run é dada como terminada no domínio enquanto o processo",
    "        // real segue rodando, gastando recurso sem ninguém observando.",
    "        void killTree(child);",
    "      });",
    "      if (!this.manifest.invoke.interactive) child.stdin.end();",
    "    } else if (!this.manifest.invoke.interactive) {",
    "      child.stdin.end();",
    "    }",
  ]],
  // #mapLine
  ["packages/adapters/src/process-adapter.ts", 570, [
    "  #mapLine(line: string): MappedEvent[] {",
    "    if (this.manifest.stream.format === 'text') {",
    "      return this.#mapper(line);",
    "    }",
    "",
    "    const trimmed = line.trim();",
    "    if (trimmed.length === 0) return [];",
    "    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {",
    "      // Linha não-JSON no meio de um stream JSONL: normalmente é banner ou",
    "      // aviso do CLI. Vira log em vez de sumir.",
    "      return [{ type: 'log', payload: { stream: 'stdout', text: line }, raw: line }];",
    "    }",
    "",
    "    try {",
    "      return this.#mapper(JSON.parse(trimmed));",
    "    } catch {",
    "      return [{ type: 'log', payload: { stream: 'stdout', text: line, unparsed: true }, raw: line }];",
    "    }",
    "  }",
  ]],
  // recordError / erroDoTurno / finish
  ["packages/adapters/src/opencode/adapter.ts", 307, [
    "      recordError: (message) => {",
    "        erroDoTurno = message;",
    "      },",
    "    };",
    "",
    "    /**",
    "     * Erro reportado pelo agente durante o turno.",
    "     *",
    "     * Sem isto, um turno que falhou no provedor (401, modelo inválido) sairia",
    "     * daqui como `exit 0` — sucesso. O pipeline de resiliência então não veria",
    "     * falha nenhuma, mandaria o resultado ao portão de validação e queimaria",
    "     * tentativas culpando o motivo errado. Foi exatamente o que aconteceu no",
    "     * primeiro teste real.",
    "     */",
    "    let erroDoTurno: string | null = null;",
    "",
    "    const finish = (reason: RunOutcome['reason'], error: string | null): void => {",
    "      const falhou = reason !== 'exit' || erroDoTurno !== null;",
    "      run.settle({",
    "        exitCode: reason === 'exit' ? (erroDoTurno === null ? 0 : 1) : null,",
    "        signal: null,",
    "        reason: run.canceled ? 'canceled' : reason,",
    "        error: error ?? (falhou ? erroDoTurno : null),",
    "        nativeSessionId,",
    "        tail: '',",
    "      });",
    "    };",
  ]],
  // laço de #consume: filtro, tradução, fila, idle
  ["packages/adapters/src/opencode/adapter.ts", 471, [
    "          for (const evento of sse.push(decoder.decode(chunk, { stream: true }))) {",
    "            // O stream é global; sem este filtro uma sessão veria os eventos",
    "            // das outras.",
    "            if (openCodeSessionId(evento) !== nativeSessionId) continue;",
    "",
    "            const pendente = openCodePendingRequest(evento);",
    "            if (pendente) void this.#recusarPendente(pendente);",
    "",
    "            const mapeados = translateOpenCodeEvent(evento);",
    "            // Qualquer evento desta sessão já prova que o loop rodou — não",
    "            // precisamos esperar o poll confirmar.",
    "            if (mapeados.length > 0) run.markStarted();",
    "",
    "            for (const mapped of mapeados) {",
    "              // Teto duro: um `chunk` sozinho pode decodificar em dezenas de",
    "              // eventos SSE de uma vez, saltando de baixo do teto de cima",
    "              // para muito acima dele antes de a checagem no topo do loop",
    "              // ter qualquer chance de agir de novo.",
    "              if (run.queue.pending >= QUEUE_HARD_CAP) {",
    "                saturada = true;",
    "                finish('error', 'fila de eventos saturada — consumidor não acompanhou o agente');",
    "                return;",
    "              }",
    "              if (mapped.type === 'error') run.recordError(describeErrorPayload(mapped.payload));",
    "              run.queue.push(mapped);",
    "            }",
    "",
    "            if (openCodeIdleSignal(evento)) finish('exit', null);",
  ]],
  // describeErrorPayload
  ["packages/adapters/src/opencode/adapter.ts", 793, [
    "function describeErrorPayload(payload: Record<string, unknown>): string {",
    "  const message = payload['message'];",
    "  return typeof message === 'string' && message.length > 0",
    "    ? message",
    "    : 'o agente reportou erro sem mensagem';",
    "}",
  ]],
  // push ignora fila fechada
  ["packages/adapters/src/async-queue.ts", 64, [
    "  push(item: T): void {",
    "    if (this.#closed) return;",
  ]],
];
function exigirBlocos() {
  const falhas = [];
  for (const [arquivoRel, inicio, esperado] of BLOCOS_REPLICADOS) {
    const linhas = lerNormalizado(arquivoRel).split('\n');
    const real = linhas.slice(inicio - 1, inicio - 1 + esperado.length);
    const fim = inicio + esperado.length - 1;
    if (real.length !== esperado.length || real.some((l, i) => l !== esperado[i])) {
      falhas.push(`${arquivoRel}:${inicio}-${fim}`);
    }
  }
  if (falhas.length > 0) {
    throw new Error('trecho replicado mudou no TS; revise o gerador:\n  ' + falhas.join('\n  '));
  }
}
exigirBlocos();

function mapLine(format, mapper, line) {
  if (format === 'text') return mapper(line);
  const trimmed = line.trim();
  if (trimmed.length === 0) return [];
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return [{ type: 'log', payload: { stream: 'stdout', text: line }, raw: line }];
  }
  try {
    return mapper(JSON.parse(trimmed));
  } catch {
    return [{ type: 'log', payload: { stream: 'stdout', text: line, unparsed: true }, raw: line }];
  }
}

function describeErrorPayload(payload) {
  const message = payload['message'];
  return typeof message === 'string' && message.length > 0 ? message : 'o agente reportou erro sem mensagem';
}

/** Seções de docs/especificacao/04-dominio-e-adapters.md que cada caso exercita. */
const SPEC = 'docs/especificacao/04-dominio-e-adapters.md';
const SPEC_MAPPER = {
  claude: `${SPEC} B7 Mappers › \`claude\``,
  codex: `${SPEC} B7 Mappers › \`codex\``,
  copilot: `${SPEC} B7 Mappers › \`copilot\``,
  kimi: `${SPEC} B7 Mappers › \`kimi\``,
  antigravity: `${SPEC} B7 Mappers › \`antigravity\``,
  'generic-json': `${SPEC} B7 Mappers › \`generic-json\``,
  'generic-text': `${SPEC} B7 Mappers › \`generic-text\``,
};
const SPEC_PIPELINE = 'B4 ProcessAgentAdapter › Linha → eventos (process-adapter.ts:570-588)';
const SPEC_TURN_COST = 'A12 Custo de turno (TurnCostTracker)';
const SPEC_SSE = `${SPEC} B8 OpenCodeAdapter › Eventos SSE → Hub; tabela run/fim do turno/desfecho`;
const SPEC_INV = `${SPEC} B2 Manifestos › Placeholders e Argv efetivo; B4 Spawn (stdin, item 10); B5 Entrega do prompt; B9 Ambiente passado ao agente (env_overlay)`;
const SPEC_INV_ERRO = `${SPEC} B4 ProcessAgentAdapter › modeloDaRun`;
const SPEC_SCHEMA = `${SPEC} B2 Manifestos › Schema (AgentManifestSchema) e Os 9 manifestos`;
const SPEC_FR = {
  motivoDaFalha: `${SPEC} B4 ProcessAgentAdapter › motivoDaFalha`,
  ultimaLinhaDeErro: `${SPEC} B4 ProcessAgentAdapter › motivoDaFalha`,
  mensagemDoEventoDeErro: `${SPEC} B4 ProcessAgentAdapter › Spawn item 7 (mensagens de eventos error) e motivoDaFalha`,
  sessaoNativaInexistente: `${SPEC} B2 Manifestos › session.strategy (nativeSessionMissing)`,
};

/** Forma canônica: o que `JSON.stringify` grava (chaves `undefined` somem). */
const canon = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const L = (o) => JSON.stringify(o);

// ============================================================================
// 1. Mappers de linha
// ============================================================================

/** Formato do stream por mapper, como nos manifestos que o usam. */
const FORMATO = {
  claude: 'jsonl',
  codex: 'jsonl',
  copilot: 'jsonl',
  kimi: 'jsonl',
  antigravity: 'jsonl',
  'generic-json': 'jsonl',
  'generic-text': 'text',
};

const T_CLAUDE = 'packages/adapters/src/mappers/claude.test.ts';
const T_COST = 'packages/adapters/src/mappers/turn-cost.test.ts';
const T_FAIL = 'packages/adapters/src/failure-reason.test.ts';
const T_AGY = 'packages/adapters/src/mappers/antigravity.test.ts';
const T_COP = 'packages/adapters/src/mappers/copilot.test.ts';
const T_KIMI = 'packages/adapters/src/mappers/kimi.test.ts';
const T_GEN = 'packages/adapters/src/mappers/generic.test.ts';
const T_DAEMON = 'packages/daemon/src/turn-cost.integration.test.ts';
const BORDA = 'borda';

const CASOS = Object.fromEntries(Object.keys(FORMATO).map((m) => [m, []]));
function caso(mapper, slug, source, notes, linhas, extra = {}) {
  CASOS[mapper].push({ slug, source, notes, linhas, ...extra });
}

const longa = (n, ch = 'a') => ch.repeat(n);
const INVALIDAS = ['null', 'undefined', '123', '"string"', '[]', '{}', 'true', ''];

// ---------------------------------------------------------------- claude ----
{
  const SID = 'cb8f904e-1abd-41d8-a15d-78075a22b01f';
  for (const subtype of ['hook_started', 'hook_response']) {
    caso('claude', `system-${subtype}-nao-define-id`, `${T_CLAUDE}:17`, 'system/hook_* com session_id NÃO define o id nativo (só o init define).', [
      L({ type: 'system', subtype, hook_name: 'SessionStart:startup', session_id: SID }),
    ]);
  }
  caso('claude', 'system-init', `${T_CLAUDE}:29`, 'init define o id nativo.', [
    L({ type: 'system', subtype: 'init', session_id: SID, tools: [], model: 'x' }),
  ]);
  caso('claude', 'result-success-com-sessao', `${T_CLAUDE}:35`, 'result carrega a sessão nativa e custo final.', [
    L({ type: 'result', subtype: 'success', session_id: SID, num_turns: 1, total_cost_usd: 0.01 }),
  ]);

  const USAGE = { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 26158, cache_creation_input_tokens: 16256 };
  const TURNO = [
    { type: 'system', subtype: 'init', session_id: 's', model: 'claude-opus-5-5', tools: [] },
    { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'thinking', thinking: 'pensando' }], usage: USAGE } },
    { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'OK' }], usage: USAGE } },
    { type: 'result', subtype: 'success', total_cost_usd: 0.1378276, usage: USAGE, session_id: 's' },
  ];
  caso('claude', 'turno-relatorio-11-parcial-vs-final', `${T_COST}:48-55`, 'Mesma message.id em 2 linhas (parciais com partId) + result final. turn_cost: parciais se substituem; o final fecha o turno.', TURNO.map(L));
  caso('claude', 'mensagens-diferentes-somam', `${T_COST}:86-90`, 'partIds diferentes somam na estimativa; o result substitui.', [
    L({ type: 'assistant', message: { id: 'a', content: [{ type: 'text', text: 'x' }], usage: USAGE } }),
    L({ type: 'assistant', message: { id: 'b', content: [{ type: 'text', text: 'y' }], usage: USAGE } }),
    L({ type: 'result', subtype: 'success', total_cost_usd: 0.05, usage: USAGE, session_id: 's' }),
  ]);
  caso('claude', 'turno-morto-antes-do-result', `${T_COST}:96`, 'Sem result: turn_cost.flush devolve a estimativa aberta.', TURNO.slice(0, 3).map(L));

  const DSID = 'c44c9fea-0000-4000-8000-000000000001';
  const DUSAGE = { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 26158, cache_creation_input_tokens: 16256 };
  caso('claude', 'stream-real-vistoria-daemon', `${T_DAEMON}:28-80`, 'Formato das saídas reais da vistoria (relatório 11), usado no teste de integração do daemon.', [
    L({ type: 'system', subtype: 'init', session_id: DSID, model: 'claude-opus-5-5', tools: [] }),
    L({ type: 'assistant', message: { id: 'msg_011CfSch8XbDVJdK2vbhMueP', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: 'O usuário quer só OK.' }], usage: DUSAGE }, session_id: DSID }),
    L({ type: 'assistant', message: { id: 'msg_011CfSch8XbDVJdK2vbhMueP', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'OK' }], usage: DUSAGE }, session_id: DSID }),
    L({ type: 'result', subtype: 'success', is_error: false, duration_ms: 11000, num_turns: 1, result: 'OK', session_id: DSID, total_cost_usd: 0.1378276, usage: DUSAGE }),
  ]);
  caso('claude', 'result-error-during-execution', `${T_FAIL}:54`, 'result de erro sem texto: evento error sem mensagem (agent_errors vazio).', [
    L({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, total_cost_usd: 0 }),
  ]);
  caso('claude', 'rate-limit-event', `${T_FAIL}:105`, 'rate_limit_event vira log técnico.', [
    L({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }),
  ]);
  caso('claude', 'thinking-vazio-some', `${T_FAIL}:108`, 'Bloco thinking vazio não gera evento.', [
    L({ type: 'assistant', message: { id: 'm', content: [{ type: 'thinking', thinking: '' }] } }),
  ]);
  // bordas
  caso('claude', 'tool-use-classificacao', BORDA, 'Bash/PowerShell→command.executed (+command); Write/Edit→file.changed (+path); NotebookEdit→file.changed sem path; outros→tool.call. usage vai SÓ no último evento da linha, com partId = message.id.', [
    L({
      type: 'assistant',
      message: {
        id: 'msg_tools',
        content: [
          { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } },
          { type: 'tool_use', id: 'tu2', name: 'PowerShell', input: { command: 'Get-ChildItem' } },
          { type: 'tool_use', id: 'tu3', name: 'Write', input: { file_path: 'src/a.ts', content: 'x' } },
          { type: 'tool_use', id: 'tu4', name: 'Edit', input: { file_path: 'src/b.ts' } },
          { type: 'tool_use', id: 'tu5', name: 'NotebookEdit', input: { notebook_path: 'n.ipynb' } },
          { type: 'tool_use', id: 'tu6', name: 'Read', input: { file_path: 'c.ts' } },
          { type: 'tool_use', id: 'tu7', name: 'Bash', input: 'não-objeto' },
        ],
        usage: { input_tokens: 10, output_tokens: 20 },
      },
    }),
  ]);
  caso('claude', 'texto-em-branco-e-unicode', BORDA, 'Texto só com espaços é descartado; CJK/emoji passam intactos.', [
    L({ type: 'assistant', message: { content: [{ type: 'text', text: '   \n\t' }, { type: 'text', text: '完成しました 😀 ação' }] } }),
  ]);
  caso('claude', 'usage-sem-message-id', BORDA, 'usage sem message.id: custo provisório sem partId.', [
    L({ type: 'assistant', message: { content: [{ type: 'text', text: 'a' }], usage: { input_tokens: 1, output_tokens: 1 } } }),
    L({ type: 'assistant', message: { content: [{ type: 'text', text: 'b' }], usage: { input_tokens: 1, output_tokens: 1 } } }),
  ]);
  caso('claude', 'usage-sem-eventos-nao-vira-custo', BORDA, 'Linha assistant só com texto vazio: nenhum evento, o usage some.', [
    L({ type: 'assistant', message: { id: 'm9', content: [{ type: 'text', text: '' }], usage: { input_tokens: 5, output_tokens: 5 } } }),
  ]);
  const T4000 = longa(4000);
  caso('claude', 'tool-result-tetos-4000', BORDA, 'tool_result string: 3999 e 4000 intactos; 4001 cortado em 4000 unidades UTF-16 + "… [4001 chars]". Conteúdo não-string passa sem corte. is_error só true quando === true.', [
    L({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: longa(3999) },
          { type: 'tool_result', tool_use_id: 'b', content: T4000 },
          { type: 'tool_result', tool_use_id: 'c', content: longa(4001), is_error: true },
          { type: 'tool_result', tool_use_id: 'd', content: [{ type: 'text', text: longa(5000) }], is_error: 'true' },
          { type: 'text', text: 'ignorado' },
        ],
      },
    }),
  ]);
  caso('claude', 'tool-result-corte-utf16-emoji', BORDA, 'DIVERGÊNCIA CONHECIDA: o corte é por unidade UTF-16 (String.length/slice). Emoji na posição 3999-4000 é partido: sobra o surrogate alto isolado, serializado como "\\ud83d". O contador "[N chars]" também conta unidades UTF-16 (emoji = 2).', [
    L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'e', content: longa(3999) + '😀' + 'fim' }] } }),
  ]);
  caso('claude', 'tool-result-cjk-acima-do-teto', BORDA, 'CJK: 4001 caracteres BMP (3 bytes UTF-8 cada) — o teto é 4000 unidades UTF-16, não bytes.', [
    L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'f', content: longa(4001, '語') }] } }),
  ]);
  caso('claude', 'result-success-com-is-error', BORDA, 'subtype success + is_error true → error.', [
    L({ type: 'result', subtype: 'success', is_error: true, result: 'falhou mesmo assim', total_cost_usd: 0.002 }),
  ]);
  caso('claude', 'result-sem-usage-nem-custo', BORDA, 'Custo final sem nenhum número: o objeto cost existe e é {} na forma serializada (todas as chaves undefined).', [
    L({ type: 'result', subtype: 'success' }),
  ]);
  caso('claude', 'numeros-extremos', BORDA, 'total_cost_usd 1e400 → Infinity no JSON.parse → descartado (numberOf exige finito). Inteiro > 2^53 perde precisão como double (9007199254740993 → 9007199254740992). -0 serializa como 0.', [
    L({ type: 'result', subtype: 'success', usage: { input_tokens: 1 } }).replace('"usage"', '"total_cost_usd":1e400,"usage"'),
    '{"type":"result","subtype":"success","total_cost_usd":-0,"usage":{"input_tokens":9007199254740993,"output_tokens":1.5e3}}',
  ]);
  caso('claude', 'system-subtipo-nao-string', BORDA, 'Subtipo objeto/ausente: texto via textoDe (JSON.stringify / "?").', [
    L({ type: 'system', subtype: { a: 1 } }),
    L({ type: 'system' }),
    L({ type: 'rate_limit_event', rate_limit_info: { status: 429 } }),
    L({ type: 'rate_limit_event' }),
  ]);
  caso('claude', 'tipo-desconhecido-e-array', BORDA, 'Tipo desconhecido → log {data}. Linha JSON array chega ao mapper como objeto (typeof [] === "object") e vira log {data: [...]}.', [
    L({ type: 'stream_event', event: { x: 1 } }),
    L({ sem: 'type' }),
    '[1,2]',
    '[]',
  ]);
  caso('claude', 'linhas-invalidas', BORDA, 'jsonl: linha vazia/espaços → nada; não começa com { ou [ → log stdout; JSON inválido/truncado → log stdout unparsed. Valores JSON escalares (null, 123, "string", true) não começam com { e viram log stdout.', [
    ...INVALIDAS,
    '   ',
    'Claude Code v2.1.283 iniciando...',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"cort',
    '{"type":"result"} lixo',
    '{type:"result"}',
  ]);
  caso('claude', 'linha-cortada-pelo-leitor', BORDA, 'Linha acima do teto de 16 MiB chega do lerLinhas cortada com " [truncado N bytes]" (line-reader.ts:17-22,58-61): deixa de ser JSON e vira log unparsed. (O corte em si é do leitor de linhas, fora deste corpus.)', [
    '{"type":"assistant","message":{"content":[{"type":"text","text":"aaaa [truncado 52428800 bytes]',
  ]);
  caso('claude', 'espaco-unicode-antes-do-json', BORDA, 'String.prototype.trim remove BOM (U+FEFF), NBSP (U+00A0) e U+2028 antes do teste de "{": a linha é parseada. O raw/payload usa o valor parseado.', [
    '\uFEFF' + L({ type: 'system', subtype: 'init', session_id: 'bom', tools: [] }),
    '\u00A0\u2028 ' + L({ type: 'rate_limit_event', rate_limit_info: { status: 'nbsp' } }) + '\u3000',
  ]);
  caso('claude', 'excecao-no-mapper-vira-unparsed', BORDA, 'DIVERGÊNCIA CONHECIDA: o try/catch do #mapLine envolve JSON.parse E o mapper. Bloco null em content faz o mapper lançar TypeError → a linha vira log stdout unparsed (mesmo sendo JSON válido).', [
    L({ type: 'assistant', message: { content: [null] } }),
    L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }, null] } }),
  ]);
  caso('claude', 'chave-duplicada', BORDA, 'JSON.parse: chave duplicada → vale a ÚLTIMA.', [
    '{"type":"result","type":"system","subtype":"init","session_id":"dup-1","session_id":"dup-2","tools":[]}',
  ]);
  caso('claude', 'surrogate-isolado', BORDA, 'Escape \\ud800 isolado é aceito pelo JSON.parse e reserializado como "\\ud800".', [
    '{"type":"assistant","message":{"content":[{"type":"text","text":"a\\ud800b"}]}}',
  ]);
  caso('claude', 'linha-grande-70k', BORDA, 'Linha de ~70 KB (acima de buffers de 64 KiB) com texto de mensagem: passa inteira (sem teto no mapper para message).', [
    L({ type: 'assistant', message: { id: 'big', content: [{ type: 'text', text: longa(70000, 'x') }] } }),
  ]);
}

// ----------------------------------------------------------------- codex ----
{
  const S = 'packages/adapters/src/mappers/codex.ts';
  caso('codex', 'turno-completo', `${S}:8-12`, 'Sem *.test.ts nem amostra real no repo: entradas montadas a partir dos tipos documentados no cabeçalho de codex.ts.', [
    L({ type: 'thread.started', thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53' }),
    L({ type: 'turn.started' }),
    L({ type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: 'ls', status: 'in_progress' } }),
    L({ type: 'item.updated', item: { id: 'item_0', type: 'command_execution' } }),
    L({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: '**Listando**' } }),
    L({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc ls', aggregated_output: 'a\nb\n', exit_code: 0, status: 'completed' } }),
    L({ type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }, { path: '', kind: 'add' }], status: 'completed' } }),
    L({ type: 'item.completed', item: { id: 'item_3', type: 'mcp_tool_call', server: 'hub', tool: 'list', status: 'completed' } }),
    L({ type: 'item.completed', item: { id: 'item_4', type: 'web_search', query: 'zod default' } }),
    L({ type: 'item.completed', item: { id: 'item_5', type: 'todo_list', items: [{ text: 'a', completed: false }] } }),
    L({ type: 'item.completed', item: { id: 'item_6', type: 'agent_message', text: 'Pronto ✅' } }),
    L({ type: 'turn.completed', usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122 } }),
  ]);
  caso('codex', 'thread-sem-id', BORDA, 'thread_id vazio: payload sem threadId e sem id nativo.', [L({ type: 'thread.started', thread_id: '' }), L({ type: 'thread.started' })]);
  caso('codex', 'turn-completed-sem-usage', BORDA, 'Custo final sem números: cost = {} serializado (tokens undefined, nunca usd).', [L({ type: 'turn.completed' }), L({ type: 'turn.completed', summary: 'ok', usage: { input_tokens: '10' } })]);
  caso('codex', 'falhas', BORDA, 'turn.failed: error string/objeto com message/objeto sem message (JSON cortado em 500 unidades)/ausente. error: message no topo, ou describeError do próprio objeto.', [
    L({ type: 'turn.failed', error: 'stream disconnected' }),
    L({ type: 'turn.failed', error: { message: "You've hit your usage limit." } }),
    L({ type: 'turn.failed', error: { code: 'x', detail: longa(600, 'd') } }),
    L({ type: 'turn.failed' }),
    L({ type: 'error', message: 'Reconnecting... 1/5' }),
    L({ type: 'error', message: '' }),
    L({ type: 'error', detalhe: longa(600, 'e') }),
  ]);
  caso('codex', 'itens-de-borda', BORDA, 'item ausente/não-objeto → nada; tipo desconhecido → log {item}; agent_message/reasoning sem texto → text "".', [
    L({ type: 'item.completed' }),
    L({ type: 'item.completed', item: 'x' }),
    L({ type: 'item.completed', item: { type: 'novo_tipo', x: 1 } }),
    L({ type: 'item.completed', item: { type: 'agent_message' } }),
    L({ type: 'item.completed', item: { type: 'reasoning', text: '' } }),
    L({ type: 'item.completed', item: { type: 'command_execution', exit_code: 1e400 } }).replace('null', '1e400'),
    L({ type: 'item.completed', item: { type: 'file_change' } }),
  ]);
  caso('codex', 'excecao-no-mapper-vira-unparsed', BORDA, 'DIVERGÊNCIA CONHECIDA: changes com null faz o mapper lançar → log stdout unparsed.', [
    L({ type: 'item.completed', item: { type: 'file_change', changes: [null] } }),
  ]);
  caso('codex', 'tipo-desconhecido-e-invalidas', BORDA, 'Tipo desconhecido → log {data}; linhas inválidas como no claude.', [L({ type: 'session.configured', model: 'gpt' }), '[{"type":"turn.started"}]', ...INVALIDAS, '{"type":"turn.started"']);
  caso('codex', 'unicode', BORDA, 'CJK/emoji em comando e saída.', [
    L({ type: 'item.completed', item: { type: 'command_execution', command: 'echo 日本語', aggregated_output: '日本語 😀\n', exit_code: 0, status: 'completed' } }),
  ]);
}

// --------------------------------------------------------------- copilot ----
{
  caso('copilot', 'auto-mode-resolved', `${T_COP}:13`, 'Modelo escolhido em modo auto.', [L({ type: 'session.auto_mode_resolved', data: { chosenModel: 'gpt-5-mini', reasoningBucket: 'low' } })]);
  caso('copilot', 'mensagem-com-output-tokens', `${T_COP}:21`, 'outputTokens (até 1.0.80) vira custo provisório; sem messageId/id não há partId.', [L({ type: 'assistant.message', data: { content: 'OK', model: 'gpt-5-mini', outputTokens: 159, toolRequests: [] } })]);
  caso('copilot', 'mensagem-1-0-88-sem-uso', `${T_COP}:36`, '1.0.88: sem outputTokens não há custo.', [
    L({ type: 'assistant.message', id: 'evt-1', timestamp: '2026-09-26T23:41:00.000Z', parentId: 'evt-0', data: { messageId: 'msg-1', originatingMessageId: 'msg-0', model: 'gpt-5-mini', content: 'OK', toolRequests: [], interactionId: 'int-1', turnId: '0', reasoningOpaque: 'cifrado', reasoningText: '', encryptedContent: 'cifrado', phase: 'final', rte: 0, apiCallId: 'api-1', serverTools: [], reasoningBlocks: [] } }),
  ]);
  caso('copilot', 'usage-checkpoint-1-0-88', `${T_COP}:64`, 'Créditos = totalNanoAiu/1e9; usd = créditos × 0,01; provisional + cumulative.', [
    L({ type: 'session.usage_checkpoint', data: { totalNanoAiu: 370_000_000, totalPremiumRequests: 0, modelCacheState: {}, promptCacheBreakState: {} } }),
  ]);
  caso('copilot', 'tool-request-shell', `${T_COP}:80`, 'Pedido bash dentro da mensagem → command.executed com command.', [L({ type: 'assistant.message', data: { content: 'rodando', toolRequests: [{ id: 't1', name: 'bash', arguments: { command: 'npm test' } }] } })]);
  caso('copilot', 'result-sessao', `${T_COP}:92`, 'result com exitCode 0 → turn.completed e id nativo.', [L({ type: 'result', sessionId: 'fea11bdf-462d-4a60-8709-fc40079aa830', exitCode: 0, usage: { premiumRequests: 0, codeChanges: { linesAdded: 0, filesModified: [] } } })]);
  caso('copilot', 'result-exit-1', `${T_COP}:103`, 'exitCode ≠ 0 → error.', [L({ type: 'result', sessionId: 's', exitCode: 1, usage: {} })]);
  caso('copilot', 'efemero-descartado', `${T_COP}:108`, 'ephemeral: true → nada.', [L({ type: 'session.mcp_servers_loaded', data: { servers: [] }, ephemeral: true })]);
  caso('copilot', 'eco-do-prompt', `${T_COP}:115`, 'user.message → nada.', [L({ type: 'user.message', data: { content: 'oi' } })]);
  caso('copilot', 'tipo-desconhecido', `${T_COP}:119`, 'Tipo desconhecido não-efêmero → log.', [L({ type: 'algo.novo', data: { x: 1 } })]);
  caso('copilot', 'turno-com-creditos', `${T_COST}:149-162`, 'Fluxo do turno: estimativa por outputTokens + acumulado de créditos; sem custo final (turn_cost.flush cobra).', [
    L({ type: 'session.auto_mode_resolved', data: { chosenModel: 'gpt-5.6-luna' } }),
    L({ type: 'assistant.message', data: { messageId: 'm1', model: 'gpt-5.6-luna', content: 'Não há uma descrição da tarefa.', toolRequests: [], outputTokens: 322 } }),
    L({ type: 'assistant.turn_end', data: { turnId: '0' } }),
    L({ type: 'session.usage_checkpoint', data: { totalNanoAiu: 529821900, totalPremiumRequests: 1 } }),
    L({ type: 'result', sessionId: 's', exitCode: 0, usage: { premiumRequests: 1 } }),
  ]);
  caso('copilot', 'sessao-retomada-base', `${T_COST}:170-174`, 'Acumulado de sessão retomada: turn_cost com base {usd: 0.005298219, credits: 0.5298219} desconta o turno anterior.', [L({ type: 'session.usage_checkpoint', data: { totalNanoAiu: 1059643800 } })], { turnCostBase: { usd: 0.005298219, credits: 0.5298219 } });
  const cop = (sessionId, nano) => [
    { type: 'session.auto_mode_resolved', data: { chosenModel: 'gpt-5.6-luna', routingMethod: 'auto_v2' }, id: 'e1', timestamp: '2026-09-25T04:05:34.945Z', parentId: null },
    { type: 'assistant.turn_start', data: { turnId: '0' }, id: 'e2', timestamp: '', parentId: 'e1' },
    { type: 'assistant.message', data: { messageId: 'b9c29dab-dd0d-4803-8f5a-78d2c5592ecc', model: 'gpt-5.6-luna', content: 'Não há uma descrição da tarefa nem arquivos no repositório para modificar.', toolRequests: [], outputTokens: 322, turnId: '0' }, id: 'e3', timestamp: '', parentId: 'e2' },
    { type: 'assistant.turn_end', data: { turnId: '0' }, id: 'e4', timestamp: '', parentId: 'e3' },
    { type: 'session.usage_checkpoint', data: { totalNanoAiu: nano, totalPremiumRequests: 1 }, id: 'e5', timestamp: '', parentId: 'e4' },
    { type: 'result', timestamp: '2026-09-25T04:06:47.006Z', sessionId, exitCode: 0, usage: { premiumRequests: 1, totalApiDurationMs: 9122, sessionDurationMs: 78000, codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] } } },
  ];
  caso('copilot', 'stream-real-sessao-3b14c0e2', `${T_DAEMON}:85-127`, 'Sessão real 3b14c0e2 (1.0.83): 529821900 nano-AIU = "AI Credits 0.53".', cop('3b14c0e2-bab4-4fc0-85e4-5367868c2838', 529821900).map(L));
  caso('copilot', 'stream-real-segundo-turno', `${T_DAEMON}:206`, 'Segundo processo da mesma sessão (acumulado 1059643800).', cop('3b14c0e2-bab4-4fc0-85e4-5367868c2838', 1059643800).map(L), { turnCostBase: { usd: 0.005298219, credits: 0.5298219 } });
  // bordas
  caso('copilot', 'tool-requests-classificacao', BORDA, 'Nome contém bash/shell/terminal → command.executed; write/edit/create → file.changed; senão tool.call. Nome por name ou tool; args por arguments ou input; path por path/file_path/filePath. Sem content, o custo (outputTokens) vai no 1º evento (a 1ª ferramenta), partId = data.messageId ?? id.', [
    L({
      type: 'assistant.message',
      id: 'evt-9',
      data: {
        toolRequests: [
          { id: 'a', name: 'run_in_terminal', arguments: { command: 'dir' } },
          { id: 'b', name: 'PowerShell', arguments: { command: 'ls' } },
          { id: 'c', tool: 'create_file', input: { filePath: 'novo.ts' } },
          { id: 'd', name: 'str_replace_editor', arguments: { file_path: 'x.ts' } },
          { id: 'e', name: 'view', arguments: { path: 'y.ts' } },
          { name: 'Edit', arguments: 'texto' },
          {},
        ],
        outputTokens: 7,
      },
    }),
  ]);
  caso('copilot', 'deltas-e-turn-start', BORDA, 'message_delta vazio → nada; turn_start com/sem model; reasoning vazio → nada.', [
    L({ type: 'assistant.message_delta', data: { deltaContent: '' } }),
    L({ type: 'assistant.message_delta', data: { deltaContent: 'Olá 😀' } }),
    L({ type: 'assistant.turn_start', data: { turnId: '1', model: 'claude-sonnet-4.6' } }),
    L({ type: 'assistant.turn_start', data: { turnId: 2, model: '' } }),
    L({ type: 'assistant.reasoning', data: { content: '' } }),
    L({ type: 'assistant.reasoning', data: { content: 'pensando' } }),
  ]);
  caso('copilot', 'checkpoint-invalido-e-zero', BORDA, 'totalNanoAiu negativo/não-numérico → nada; 0 → log com custo 0 (toFixed(2) no texto).', [
    L({ type: 'session.usage_checkpoint', data: { totalNanoAiu: -1 } }),
    L({ type: 'session.usage_checkpoint', data: { totalNanoAiu: '5' } }),
    L({ type: 'session.usage_checkpoint', data: {} }),
    L({ type: 'session.usage_checkpoint', data: { totalNanoAiu: 0 } }),
    L({ type: 'session.usage_checkpoint', data: { totalNanoAiu: 5_005_000_000 } }),
  ]);
  caso('copilot', 'checkpoint-fora-de-ordem', BORDA, 'turn_cost: acumulado só cresce — um checkpoint menor depois de um maior não desconta.', [
    L({ type: 'session.usage_checkpoint', data: { totalNanoAiu: 2_000_000_000 } }),
    L({ type: 'session.usage_checkpoint', data: { totalNanoAiu: 1_000_000_000 } }),
  ]);
  caso('copilot', 'result-sem-exitcode-e-error', BORDA, 'result sem exitCode → error "copilot saiu com código undefined"; error sem message → "erro do Copilot".', [
    L({ type: 'result', sessionId: '' }),
    L({ type: 'error', data: { message: 'Rate limited' } }),
    L({ type: 'error' }),
  ]);
  caso('copilot', 'sem-type', BORDA, 'type ausente, vazio ou não-string → nada (mesmo não-efêmero).', [L({ data: { x: 1 } }), L({ type: '' }), L({ type: 5 })]);
  caso('copilot', 'excecao-no-mapper-vira-unparsed', BORDA, 'DIVERGÊNCIA CONHECIDA: toolRequests com null faz o mapper lançar → log stdout unparsed.', [L({ type: 'assistant.message', data: { content: 'x', toolRequests: [null] } })]);
  caso('copilot', 'invalidas', BORDA, 'Linhas inválidas.', [...INVALIDAS, '{"type":"assistant.message","data":{"content":"cor']);
}

// ------------------------------------------------------------------ kimi ----
{
  caso('kimi', 'retentativa', `${T_KIMI}:67`, 'turn.step.retrying vira aviso legível (delay 606.03 ms → "1s").', [L({ role: 'meta', type: 'turn.step.retrying', failed_attempt: 1, next_attempt: 2, max_attempts: 10, delay_ms: 606.03, error_name: 'APIConnectionError', error_message: 'Connection error.' })]);
  caso('kimi', 'ultima-retentativa', `${T_KIMI}:86`, 'next_attempt >= max_attempts → " — é a última".', [L({ role: 'meta', type: 'turn.step.retrying', failed_attempt: 9, next_attempt: 10, max_attempts: 10, delay_ms: 30000, error_name: 'APIConnectionError', error_message: 'Connection error.' })]);
  caso('kimi', 'system-version', `${T_KIMI}:100`, 'system.version → "Kimi 2.0.0".', [L({ role: 'meta', type: 'system.version', version: '2.0.0' })]);
  caso('kimi', 'assistant-com-tool-calls', `${T_KIMI}:105`, 'Texto + chamadas; arguments (string JSON) decodificado.', [
    L({ role: 'assistant', content: 'vou rodar os testes', tool_calls: [{ type: 'function', id: 't1', function: { name: 'Bash', arguments: '{"command":"npm test"}' } }, { type: 'function', id: 't2', function: { name: 'Write', arguments: '{"path":"src/a.ts","content":"x"}' } }] }),
  ]);
  caso('kimi', 'assistant-so-tool-calls', `${T_KIMI}:126`, 'Sem content não perde a chamada.', [L({ role: 'assistant', tool_calls: [{ type: 'function', id: 't1', function: { name: 'Read', arguments: '{"path":"a"}' } }] })]);
  caso('kimi', 'tool-resultado-2-0-0', `${T_KIMI}:139`, 'role tool com tool_call_id → tool.result.', [L({ role: 'tool', tool_call_id: 't1', content: 'ok' })]);
  caso('kimi', 'resume-hint', `${T_KIMI}:145`, 'resume_hint revela o id nativo.', [L({ role: 'meta', type: 'session.resume_hint', session_id: 'session_abc', command: 'kimi -r session_abc', content: 'To resume this session: kimi -r session_abc' })]);
  caso('kimi', 'formato-antigo-tool', `${T_KIMI}:156`, 'Formato antigo (role tool com name/input) → chamada classificada.', [L({ role: 'tool', name: 'bash', input: { command: 'ls' } })]);
  caso('kimi', 'mensagem-ok', `${T_COP}:126`, 'assistant → message.', [L({ role: 'assistant', content: 'OK' })]);
  caso('kimi', 'resume-hint-real', `${T_COP}:132`, 'id nativo real da 2.0.0.', [L({ role: 'meta', type: 'session.resume_hint', session_id: 'session_89f4617a-cb89-44b0-a58d-2e5cfa135b3e', content: 'To resume this session: ...' })]);
  caso('kimi', 'eco-do-prompt', `${T_COP}:142`, 'role user → nada.', [L({ role: 'user', content: 'oi' })]);
  caso('kimi', 'role-desconhecido', `${T_COP}:152`, 'role desconhecido → log.', [L({ role: 'algo', content: 'x' })]);
  // bordas
  caso('kimi', 'retentativa-campos-faltando-e-arredondamento', BORDA, 'Sem campos: "tentativa ?/? falhou"; delay 400 → max(1, round(0.4)) = 1s; 1500 → 2s; 2500 → 3s (Math.round meio para cima); -1000 → 1s; só error_message.', [
    L({ role: 'meta', type: 'turn.step.retrying' }),
    L({ role: 'meta', type: 'turn.step.retrying', failed_attempt: 1, max_attempts: 3, delay_ms: 400 }),
    L({ role: 'meta', type: 'turn.step.retrying', failed_attempt: 1, max_attempts: 3, delay_ms: 1500 }),
    L({ role: 'meta', type: 'turn.step.retrying', failed_attempt: 2, next_attempt: 3, max_attempts: 3, delay_ms: 2500, error_message: 'timeout' }),
    L({ role: 'meta', type: 'turn.step.retrying', failed_attempt: 1, next_attempt: 2, max_attempts: 5, delay_ms: -1000, error_name: 'E' }),
  ]);
  caso('kimi', 'meta-com-usage-e-outros', BORDA, 'meta genérico → log {kimiType, text: content}; usage (input/prompt, output/completion) vira custo FINAL (sem provisional); system.version sem versão.', [
    L({ role: 'meta', type: 'usage.report', content: 'uso', usage: { prompt_tokens: 100, completion_tokens: 20 } }),
    L({ role: 'meta', type: 'x', usage: { input_tokens: 1, output_tokens: 2, prompt_tokens: 9 } }),
    L({ role: 'meta', type: 'system.version' }),
    L({ role: 'meta' }),
  ]);
  caso('kimi', 'tool-sem-id-nem-nome-e-teto', BORDA, 'tool sem tool_call_id e sem name → tool.result callId ausente. content > 4000 unidades UTF-16 → corte + "… [N caracteres omitidos]" (N = excedente).', [
    L({ role: 'tool', content: 'solto' }),
    L({ role: 'tool', tool_call_id: 't9', content: longa(4000) }),
    L({ role: 'tool', tool_call_id: 't9', content: longa(4001, '語') }),
    L({ role: 'tool', tool_call_id: 't9', content: longa(3999) + '😀' }),
    L({ role: 'tool', tool_call_id: 't9' }),
  ]);
  caso('kimi', 'formato-antigo-variantes', BORDA, 'Formato antigo: name ou tool; input ou arguments; content vira output; write/edit → file.changed; exec → command.executed.', [
    L({ role: 'tool', tool: 'WriteFile', arguments: { file_path: 'a.md' }, content: 'gravado' }),
    L({ role: 'tool', name: 'exec_command', input: { command: 'dir' } }),
    L({ role: 'tool', name: 'search', input: null }),
  ]);
  caso('kimi', 'tool-calls-borda', BORDA, 'arguments não-JSON fica string; arguments objeto passa; chamada null/sem function → tool.call sem tool.', [
    L({ role: 'assistant', content: '', tool_calls: [{ id: 'x', function: { name: 'Shell', arguments: '{quebrado' } }, { id: 'y', function: { name: 'edit_file', arguments: { path: 'b.ts' } } }, null, { id: 'z' }] }),
  ]);
  caso('kimi', 'raciocinio-erro-goal', BORDA, 'thinking/reasoning vazio → nada; error sem content → "erro do Kimi"; goal.summary (sem role) → log; role não-string → log {data}.', [
    L({ role: 'thinking', content: '' }),
    L({ role: 'thinking', content: 'hmm 🤔' }),
    L({ role: 'reasoning', content: 'r' }),
    L({ role: 'error', content: 'Provider error: 401' }),
    L({ role: 'error' }),
    L({ type: 'goal.summary', status: 'achieved', turnsUsed: 4 }),
    L({ type: 'goal.summary' }),
    L({ role: 7, content: 'x' }),
  ]);
  caso('kimi', 'invalidas', BORDA, 'Linhas inválidas.', [...INVALIDAS, '{"role":"assistant","content":"cor', '[{"role":"assistant","content":"em array"}]']);
}

// ----------------------------------------------------------- antigravity ----
{
  caso('antigravity', 'init', `${T_AGY}:7`, 'init extrai conversation_id e metadados.', [L({ event: 'init', conversation_id: '30077937-4cf4-44cb-a349-1f05165b5865', init: { cwd: 'C:\\Users\\workspace', tools: ['run_command', 'write_to_file'], permission_mode: 'request-review' } })]);
  caso('antigravity', 'user-input-descartado', `${T_AGY}:24`, 'Prompt ecoado em user_input → nada.', [L({ event: 'step_update', step_update: { conversation_id: 'conv-123', step_index: 0, state: 'DONE', step_type: 'user_input' } })]);
  caso('antigravity', 'agent-response-com-custo', `${T_AGY}:38`, 'Resposta → message com custo provisório partId step:1.', [L({ event: 'step_update', step_update: { conversation_id: 'conv-123', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'Olá, mundo!', duration_seconds: 1.5, usage: { input_tokens: 1200, output_tokens: 45, cache_read_tokens: 200, total_tokens: 1245 } } })]);
  caso('antigravity', 'tool-comando', `${T_AGY}:65`, 'run_command → command.executed.', [L({ event: 'step_update', step_update: { conversation_id: 'conv-123', step_type: 'tool_call', tool_call: { name: 'run_command', input: { CommandLine: 'npm test', Cwd: 'C:\\repo' } } } })]);
  caso('antigravity', 'tool-arquivo', `${T_AGY}:83`, 'write_to_file → file.changed.', [L({ event: 'step_update', step_update: { conversation_id: 'conv-123', step_type: 'tool_call', tool_call: { name: 'write_to_file', input: { TargetFile: 'C:\\repo\\file.ts' } } } })]);
  caso('antigravity', 'result-sucesso', `${T_AGY}:100`, 'result SUCCESS → turn.completed com custo final.', [L({ event: 'result', result: { conversation_id: 'conv-123', status: 'SUCCESS', response: 'Tarefa concluída com sucesso.', duration_seconds: 3.2, num_turns: 1, usage: { input_tokens: 5000, output_tokens: 200, cache_read_tokens: 1000, total_tokens: 5200 } } })]);
  caso('antigravity', 'result-erro', `${T_AGY}:125`, 'result ERROR → error; sem usage não há custo.', [L({ event: 'result', result: { conversation_id: 'conv-123', status: 'ERROR', error: 'Quota esgotada', duration_seconds: 0.5, num_turns: 1 } })]);
  caso('antigravity', 'entrada-invalida', `${T_AGY}:142`, 'Valores lixo como linhas JSONL (o undefined do teste não tem forma de linha; vira o texto "undefined").', ['null', 'undefined', '123', '"string"', '[]', '{}']);
  caso('antigravity', 'etapas-mais-result', `${T_COST}:104-125`, 'Uso por etapa (provisório) + result (final): tokens contados uma vez.', [
    L({ event: 'init', conversation_id: 'c', init: {} }),
    L({ event: 'step_update', step_update: { conversation_id: 'c', step_index: 1, step_type: 'agent_response', text_delta: 'OK', usage: { input_tokens: 15000, output_tokens: 5, cache_read_tokens: 0, total_tokens: 15005 } } }),
    L({ event: 'result', result: { conversation_id: 'c', status: 'SUCCESS', response: 'OK\n', usage: { input_tokens: 15300, output_tokens: 5, total_tokens: 15305 } } }),
  ]);
  caso('antigravity', 'result-sem-numeros-mantem-estimativa', `${T_COST}:131-141`, 'result sem input/output não vira custo: turn_cost.flush cobra a estimativa.', [
    L({ event: 'step_update', step_update: { step_index: 1, step_type: 'agent_response', text_delta: 'OK', usage: { input_tokens: 100, output_tokens: 5 } } }),
    L({ event: 'result', result: { status: 'SUCCESS', response: 'OK', usage: { total_tokens: 105 } } }),
  ]);
  // bordas
  caso('antigravity', 'agent-response-variantes', BORDA, 'Sem texto e sem usage → nada; texto só espaços + usage → nada (custo some); is_thinking/thought → reasoning; fallback text/response; usage sem step_index → sem partId; id nativo do topo quando a etapa não traz.', [
    L({ event: 'step_update', step_update: { step_type: 'agent_response' } }),
    L({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: '  ', usage: { input_tokens: 1 } } }),
    L({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'pensando', is_thinking: true, step_index: 2 } }),
    L({ event: 'step_update', step_update: { step_type: 'agent_response', text: 'via text', thought: true } }),
    L({ event: 'step_update', conversation_id: 'topo', step_update: { step_type: 'agent_response', response: '回答 😀', usage: { output_tokens: 3 } } }),
  ]);
  caso('antigravity', 'erros-de-etapa', BORDA, 'error_message ou state ERROR em qualquer tipo → error {message, stepIndex}; ordem error > message > error_message > "erro na etapa".', [
    L({ event: 'step_update', step_update: { conversation_id: 'c1', step_index: 3, step_type: 'error_message', error_message: 'falhou' } }),
    L({ event: 'step_update', step_update: { step_index: 4, step_type: 'tool_call', state: 'ERROR', message: 'tool quebrou', error: 'motivo' } }),
    L({ event: 'step_update', step_update: { step_type: 'error_message' } }),
  ]);
  caso('antigravity', 'ferramentas-variantes', BORDA, 'tool_use com campos na própria etapa; tool_call truthy sem step_type; bash/shell com command/cmd; replace_file_content/sed_file/multi_replace_file_content com AbsolutePath/path; outros → tool.call (input {} se ausente).', [
    L({ event: 'step_update', step_update: { step_type: 'tool_use', name: 'bash', input: { command: 'ls' } } }),
    L({ event: 'step_update', step_update: { tool_call: { tool: 'shell', arguments: { cmd: 'pwd' } } } }),
    L({ event: 'step_update', step_update: { step_type: 'tool_call', tool_call: { name: 'replace_file_content', input: { AbsolutePath: 'C:\\a.ts' } } } }),
    L({ event: 'step_update', step_update: { step_type: 'tool_call', tool_call: { name: 'sed_file', input: { path: 'b.ts' } } } }),
    L({ event: 'step_update', step_update: { step_type: 'tool_call', tool_call: { name: 'multi_replace_file_content', input: {} } } }),
    L({ event: 'step_update', step_update: { step_type: 'tool_call', tool_call: { name: 'view_file' } } }),
  ]);
  caso('antigravity', 'tool-result-e-outros', BORDA, 'tool_result: content > output > result; isError por is_error === true ou state ERROR (mas state ERROR cai antes no ramo de erro). step_type desconhecido → log {step}; evento desconhecido → log {data}.', [
    L({ event: 'step_update', step_update: { conversation_id: 'c2', step_type: 'tool_result', output: 'saída', is_error: true } }),
    L({ event: 'step_update', step_update: { step_type: 'tool_result', result: { ok: 1 } } }),
    L({ event: 'step_update', step_update: { step_type: 'checkpoint', step_index: 9 } }),
    L({ event: 'step_update' }),
    L({ event: 'heartbeat' }),
  ]);
  caso('antigravity', 'result-variantes', BORDA, 'Campo error com status SUCCESS → error; status ausente → "SUCCESS"/"ERROR" derivado; só output_tokens já vira custo final.', [
    L({ event: 'result', result: { status: 'SUCCESS', error: 'parcial' } }),
    L({ event: 'result', result: { response: 'ok', usage: { output_tokens: 9 } } }),
    L({ event: 'result', conversation_id: 'topo-r', result: { error: { code: 1 } } }),
    L({ event: 'result' }),
  ]);
  caso('antigravity', 'invalidas', BORDA, 'Linhas inválidas.', ['', '   ', 'agy: banner', '{"event":"init"', '{"event":"init"} x']);
}

// ---------------------------------------------------------- generic-json ----
{
  const SES = 'ses_mimo123';
  caso('generic-json', 'step-start-com-sessao', `${T_GEN}:17`, 'Qualquer linha com sessionID revela o id nativo.', [L({ type: 'step_start', timestamp: 1, sessionID: SES, part: { type: 'step-start' } })]);
  caso('generic-json', 'texto-em-part', `${T_GEN}:27`, 'part.text → message.', [L({ type: 'text', sessionID: SES, part: { type: 'text', text: 'pronto', time: { start: 1, end: 2 } } })]);
  caso('generic-json', 'step-finish-custo', `${T_GEN}:37`, 'step_finish: usd = part.cost; output = output + reasoning; cached = read + write. Sem provisional (final).', [L({ type: 'step_finish', sessionID: SES, part: { type: 'step-finish', reason: 'stop', cost: 0.0123, tokens: { input: 1200, output: 300, reasoning: 40, cache: { read: 800, write: 10 } } } })]);
  caso('generic-json', 'tool-use-shell', `${T_GEN}:52`, 'tool_use bash com command → command.executed.', [L({ type: 'tool_use', sessionID: SES, part: { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'git push' } } } })]);
  caso('generic-json', 'tool-use-escrita', `${T_GEN}:66`, 'tool_use write com filePath → file.changed.', [L({ type: 'tool_use', sessionID: SES, part: { type: 'tool', tool: 'write', state: { status: 'completed', input: { filePath: 'src/a.ts' } } } })]);
  caso('generic-json', 'error-data-message', `${T_GEN}:80`, 'error: mensagem de error.data.message.', [L({ type: 'error', sessionID: SES, error: { name: 'APIError', data: { message: 'modelo inválido' } } })]);
  caso('generic-json', 'cursor-message-content', `${T_GEN}:92`, 'Estilo Claude (Cursor): session_id e texto de message.content[].', [L({ type: 'assistant', session_id: 'c-1', message: { role: 'assistant', content: [{ type: 'text', text: 'oi' }] } })]);
  caso('generic-json', 'cursor-usage-no-topo', `${T_GEN}:103`, 'usage no topo → custo {inputTokens, outputTokens}.', [L({ type: 'result', session_id: 'c-1', usage: { input_tokens: 10, output_tokens: 5 } })]);
  // bordas
  caso('generic-json', 'envelope-opencode-variantes', BORDA, 'text/reasoning com texto vazio caem no fallback (log {data}); reasoning → reasoning; tool sem command/caminho ou nome não-shell → tool.call; patch com path → file.changed; step_finish sem reason; tipo desconhecido com part → fallback.', [
    L({ type: 'text', sessionID: SES, part: { type: 'text', text: '' } }),
    L({ type: 'reasoning', sessionID: SES, part: { text: 'analisando 🤔' } }),
    L({ type: 'tool_use', part: { tool: 'read', state: { status: 'completed', input: { command: 'cat a', path: 'a' } } } }),
    L({ type: 'tool_use', part: { tool: 'apply_patch', state: { input: { path: 'p.diff' } } } }),
    L({ type: 'tool_use', part: { tool: 'bash', state: { input: {} } } }),
    L({ type: 'tool_use', part: {} }),
    L({ type: 'step_finish', part: {} }),
    L({ type: 'novo', part: { text: 'x' }, text: 'topo' }),
  ]);
  caso('generic-json', 'error-variantes', BORDA, 'Ordem: error.data.message > error.message > error (string) > error.name > message > "erro sem mensagem".', [
    L({ type: 'error', error: { message: 'm1', name: 'N' } }),
    L({ type: 'error', error: 'texto puro' }),
    L({ type: 'error', error: { name: 'SóNome' } }),
    L({ type: 'error', message: 'no topo' }),
    L({ type: 'error' }),
  ]);
  caso('generic-json', 'texto-fallback', BORDA, 'message.content[] junta vários blocos text (sem separador); blocos não-text ignorados; text/message/content string no topo; nada → log {data}.', [
    L({ message: { content: [{ type: 'text', text: 'a' }, { type: 'image' }, null, { type: 'text', text: 'b' }] } }),
    L({ message: { content: [{ type: 'tool_use' }] }, content: 'via content' }),
    L({ message: 'via message' }),
    L({ text: '' , content: 'c' }),
    L({ x: 1 }),
  ]);
  caso('generic-json', 'custo-variantes', BORDA, 'tokens no topo com cost no topo; tokens sem números → sem custo; cache só write; usage com prompt_tokens/completion_tokens e camelCase; usage {} → cost {} (presente e vazio); sessionId camelCase.', [
    L({ type: 'step_finish', tokens: { input: 5, cache: { write: 3 } }, cost: 0.5, sessionId: 'camel' }),
    L({ type: 'step_finish', part: { tokens: {} } }),
    L({ type: 'step_finish', part: { tokens: { cache: {} }, cost: 'x' } }),
    L({ usage: { prompt_tokens: 7, completion_tokens: 8 } }),
    L({ usage: { inputTokens: 1, outputTokens: 2 } }),
    L({ usage: {} }),
  ]);
  caso('generic-json', 'string-json-nao-chega-ao-texto', BORDA, 'DIVERGÊNCIA CONHECIDA: o ramo "string → generic-text" do genericJsonMapper é inalcançável pelo pipeline jsonl: uma linha "\\"error: x\\"" não começa com { e vira log stdout antes do mapper.', ['"error: x"', 'error: banner do CLI']);
  caso('generic-json', 'stream-mimo-composto', BORDA, 'Turno do envelope `run --format json` montado com as chaves do generic.test.ts (step_start → tool_use → text → step_finish).', [
    L({ type: 'step_start', timestamp: 1, sessionID: SES, part: { type: 'step-start' } }),
    L({ type: 'tool_use', timestamp: 2, sessionID: SES, part: { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'npm test' } } } }),
    L({ type: 'text', timestamp: 3, sessionID: SES, part: { type: 'text', text: 'testes ok — 日本語' } }),
    L({ type: 'step_finish', timestamp: 4, sessionID: SES, part: { type: 'step-finish', reason: 'stop', cost: 0, tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } } }),
  ]);
  caso('generic-json', 'invalidas', BORDA, 'Linhas inválidas; array vira log {data: [...]}.', [...INVALIDAS, '[1]', '{"type":"text"']);
}

// ---------------------------------------------------------- generic-text ----
{
  const S = 'packages/adapters/src/mappers/generic.ts:11-26';
  const N = 'format text: a linha vai CRUA ao mapper (sem trim, sem JSON). Vazia/só espaços → nada; contém "error:"/"fatal:" ou começa com "error " (após toLowerCase) → error; senão message.';
  const LINHAS = [
    ['mensagem', 'olá mundo'],
    ['vazia', ''],
    ['so-espacos', '   '],
    ['so-tab', '\t'],
    ['error-dois-pontos', 'Error: falhou'],
    ['fatal-dois-pontos', 'build fatal: sem memória'],
    ['comeca-com-error-espaco', 'error ao abrir'],
    ['maiusculas', 'ERROR GRAVE'],
    ['errors-nao-casa', 'errors happen'],
    ['espaco-antes-de-error', '  error x'],
    ['error-no-meio', 'um error: no meio'],
    ['so-error-dois-pontos', 'error:'],
    ['json-vira-texto', '{"type":"text","part":{"text":"json vira texto"}}'],
    ['cjk-emoji', '日本語の出力 😀'],
    ['largura-total-nao-casa', 'ＥＲＲＯＲ: largura total não casa'],
    ['i-com-ponto', 'İERROR: dotted I'],
    ['espacos-unicode', '\u00a0\u3000'],
  ];
  for (const [slug, linha] of LINHAS) caso('generic-text', slug, S, N, [linha]);
}

// ---------------------------------------------------- execução dos casos ----
function rodarMapper(nome, c) {
  const mapper = resolveMapper(nome);
  const formato = FORMATO[nome];
  const porLinha = c.linhas.map((l) => mapLine(formato, mapper, l));
  const eventos = porLinha.flat();
  let nativo = null;
  const erros = [];
  for (const e of eventos) {
    const m = failure.mensagemDoEventoDeErro(e);
    if (m) {
      erros.push(m);
      if (erros.length > 20) erros.shift();
    }
    if (e.nativeSessionId && !nativo) nativo = e.nativeSessionId;
  }
  const out = {
    id: `${nome}/${c.slug}`,
    mapper: nome,
    format: formato,
    source: c.source,
    spec: null,
    notes: c.notes,
    input_lines: c.linhas,
    expected_events: canon(eventos),
    events_per_line: porLinha.map((p) => p.length),
    native_session_id: nativo,
    agent_errors: erros,
  };
  out.spec = [SPEC_MAPPER[nome], SPEC_PIPELINE, ...(eventos.some((e) => e.cost) ? [SPEC_TURN_COST] : [])].join('; ');
  if (eventos.some((e) => e.cost)) {
    const tracker = new TurnCostTracker(c.turnCostBase ?? {});
    const steps = [];
    eventos.forEach((e, i) => {
      if (!e.cost) return;
      const p = tracker.observe(e.cost);
      steps.push({ event_index: i, ...p });
    });
    out.turn_cost = canon({ base: c.turnCostBase ?? {}, steps, flush: tracker.flush() });
  }
  return out;
}

// ============================================================================
// 2. OpenCode SSE
// ============================================================================
const T_OC = 'packages/adapters/src/opencode/events.test.ts';
const SESSAO = 'ses_abc123';
const ev = (type, data = {}) => ({ id: 'evt_1', type, data: { sessionID: SESSAO, ...data } });
const sse = (...objs) => objs.map((o) => `data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`).join('');
const SSE_CASOS = [];
function sseCaso(slug, source, notes, chunks, extra = {}) {
  SSE_CASOS.push({ slug, source, notes, chunks, ...extra });
}
sseCaso('dois-eventos-num-bloco', `${T_OC}:12`, 'Dois eventos completos num chunk.', ['data: {"type":"a"}\n\ndata: {"type":"b"}\n\n']);
sseCaso('evento-partido', `${T_OC}:18`, 'Evento partido entre dois chunks.', ['data: {"ty', 'pe":"session.idle"}\n\n']);
sseCaso('comentario-heartbeat', `${T_OC}:27`, 'Comentário ":" ignorado.', [': heartbeat\n\n']);
sseCaso('json-invalido-nao-derruba', `${T_OC}:31`, 'JSON inválido é descartado e o decodificador segue.', ['data: {quebrado\n\n', 'data: {"type":"ok"}\n\n']);
sseCaso('session-created', `${T_OC}:39`, 'session.created → session.started com id nativo.', [sse(ev('session.created'))]);
sseCaso('text-ended', `${T_OC}:45`, 'Texto do agente → message.', [sse(ev('session.next.text.ended', { text: 'terminei' }))]);
sseCaso('step-ended-custo', `${T_OC}:51`, 'step.ended: file.changed por arquivo + log técnico com custo (reasoning soma na saída).', [sse(ev('session.next.step.ended', { finish: 'stop', cost: 0.0123, tokens: { input: 1200, output: 340, reasoning: 60, cache: { read: 800, write: 0 } }, files: ['src/a.ts'] }))]);
sseCaso('step-ended-arquivos', `${T_OC}:75`, 'Dois arquivos → dois file.changed.', [sse(ev('session.next.step.ended', { files: ['src/a.ts', 'src/b.ts'] }))]);
sseCaso('shell-started', `${T_OC}:84`, 'Shell → command.executed kind shell.', [sse(ev('session.next.shell.started', { command: 'npm test', callID: 'c1' }))]);
sseCaso('step-failed', `${T_OC}:92`, 'Passo falho → error com a mensagem; outcome no idle teria exitCode 1.', [sse(ev('session.next.step.failed', { error: { message: 'modelo não suportado' } }))]);
sseCaso('desconhecido-de-sessao', `${T_OC}:100`, 'Evento desconhecido com sessionID → log.', [sse(ev('session.next.algo.novo', { x: 1 }))]);
sseCaso('ruido-global-sem-sessao', `${T_OC}:106`, 'Sem sessionID: translate devolve [] e o filtro de sessão também descarta.', [sse({ id: 'evt', type: 'lsp.diagnostics', data: {} })]);
sseCaso('file-edited', `${T_OC}:114`, 'file.edited descartado.', [sse({ id: 'evt', type: 'file.edited', data: { file: 'a.ts' } })]);
sseCaso('prompt-ecoado', `${T_OC}:122`, 'prompt.admitted/prompted → nada.', [sse(ev('session.next.prompt.admitted', { prompt: { text: '# Tarefa ...' } }), ev('session.next.prompted', { prompt: { text: '# Tarefa ...' } }))]);
sseCaso('ruido-descartado', `${T_OC}:132`, 'Marcadores started/delta e espelho v1 → nada; status busy → nada.', [sse(...['session.next.reasoning.started', 'session.next.reasoning.delta', 'session.next.text.started', 'session.next.tool.input.delta', 'message.part.updated', 'session.updated'].map((t) => ev(t, { reasoningID: 'r1' })), ev('session.status', { status: { type: 'busy' } }))]);
sseCaso('log-texto-curto', `${T_OC}:146`, 'Log de desconhecido com texto curto.', [sse(ev('todo.updated', { todos: [] }))]);
sseCaso('permissao-v2', `${T_OC}:151`, 'permission.v2.asked → log de aviso + pending_request (recusado pelo adapter).', [sse(ev('permission.v2.asked', { id: 'per_1', action: 'bash', resources: ['git push'] }))]);
sseCaso('entrada-malformada', `${T_OC}:162`, 'Valores lixo como data: (null, 42, "texto", [], {}) → nada.', [sse('null', '42', '"texto"', '[]', '{}')]);
sseCaso('idle', `${T_OC}:170`, 'session.idle → session.ended + idle_signal; outcome exit 0.', [sse(ev('session.idle'))]);
sseCaso('status-idle', `${T_OC}:174`, 'session.status idle → session.ended + idle_signal.', [sse(ev('session.status', { status: { type: 'idle' } }))]);
sseCaso('status-retry', `${T_OC}:178`, 'status retry não encerra: log.', [sse(ev('session.status', { status: { type: 'retry', message: 'Rate limited' } }))]);
sseCaso('evento-global', `${T_OC}:188`, 'server.connected sem sessão → session_id null.', [sse({ type: 'server.connected', data: {} })]);
// bordas
sseCaso('turno-completo-e-corte-no-idle', BORDA, 'Turno inteiro; eventos DEPOIS do idle no mesmo stream não entram (a fila fecha no finish; async-queue.ts:65).', [
  sse(
    ev('session.next.agent.switched', { agent: 'hub-semi' }),
    ev('session.next.model.switched', { model: { providerID: 'opencode', modelID: 'x' } }),
    ev('session.next.step.started', { assistantMessageID: 'msg_1', agent: 'hub-semi', model: { id: 'm' } }),
    ev('session.next.text.delta', { delta: 'Olá ', textID: 't1' }),
    ev('session.next.reasoning.ended', { text: 'raciocínio' }),
    ev('session.next.tool.called', { callID: 'c1', tool: 'read', input: { path: 'a' } }),
    ev('session.next.tool.success', { callID: 'c1', content: [{ type: 'text', text: 'conteúdo' }], outputPaths: ['a'] }),
    ev('session.next.tool.failed', { callID: 'c2', error: { message: 'negado' } }),
    ev('session.next.shell.ended', { callID: 'c3', output: 'ok\n' }),
    { type: 'command.executed', data: { sessionID: SESSAO, name: 'review', arguments: 'src' } },
    ev('session.next.retried', { attempt: 2, error: { message: 'overloaded' } }),
    ev('session.next.compaction.ended'),
    ev('session.idle'),
    ev('session.next.text.ended', { text: 'depois do idle' }),
  ),
]);
sseCaso('erro-de-sessao-e-outcome', BORDA, 'session.error: message de error.data.message > error.name > padrão; outcome no idle: exitCode 1 com a última mensagem de erro.', [sse(ev('session.error', { error: { name: 'ProviderAuthError', data: { message: 'chave inválida' } } }), ev('session.error', { error: { name: 'SóNome' } }), ev('session.error'), ev('session.idle'))]);
sseCaso('erro-sem-mensagem-no-outcome', BORDA, 'step.failed sem mensagem: payload.message = "passo falhou sem mensagem" (é a que vai ao outcome).', [sse(ev('session.next.step.failed'), ev('session.idle'))]);
sseCaso('outra-sessao-filtrada', BORDA, 'Evento de outra sessão: translate gera eventos, mas passes_filter=false; não entra em expected_events.', [sse({ type: 'session.next.text.ended', data: { sessionID: 'ses_outra', text: 'não é minha' } }, ev('session.next.text.ended', { text: 'minha' }))]);
sseCaso('pedidos-pendentes', BORDA, 'permission.asked (v1, patterns), question.asked, question.v2.asked; sem id → sem pending_request mas ainda log; respostas → nada.', [
  sse(
    ev('permission.asked', { id: 'p1', permission: 'edit', patterns: ['a', 'b', 'c', 'd', 5] }),
    ev('question.asked', { id: 'q1' }),
    ev('question.v2.asked', { id: 'q2' }),
    ev('permission.v2.asked', { resources: [] }),
    ev('permission.v2.asked', { id: 'p2' }),
    ev('permission.replied', { id: 'p1' }),
    ev('question.v2.rejected', { id: 'q2' }),
  ),
]);
sseCaso('crlf-e-campos-sse', BORDA, 'CRLF normalizado; linhas event:/id:/retry: ignoradas; "data:" sem espaço; várias linhas data: juntadas com \\n (JSON multilinha).', ['event: message\r\nid: 7\r\nretry: 1000\r\ndata:{"type":"session.idle",\r\ndata: "data":{"sessionID":"ses_abc123"}}\r\n\r\n']);
sseCaso('cr-partido-entre-chunks', BORDA, 'DIVERGÊNCIA CONHECIDA: a troca \\r\\n→\\n é feita por chunk. "\\r" no fim de um chunk + "\\n\\r\\n" no seguinte: o bloco sai com "\\r" no fim da linha data (JSON.parse aceita \\r como espaço).', ['data: {"type":"session.idle","data":{"sessionID":"ses_abc123"}}\r', '\n\r\n']);
sseCaso('cr-solto-nao-separa', BORDA, 'DIVERGÊNCIA CONHECIDA (vs. especificação SSE): "\\r" sozinho não termina linha; o bloco nunca fecha e nada sai.', ['data: {"type":"session.idle"}\r\r']);
sseCaso('trimstart-agressivo', BORDA, 'DIVERGÊNCIA CONHECIDA (vs. especificação SSE, que tira só 1 espaço): trimStart remove todo espaço/tab após "data:".', ['data:\t   {"type":"session.idle","data":{"sessionID":"ses_abc123"}}\n\n']);
sseCaso('bloco-sem-data-e-sobra', BORDA, 'Bloco só com event: → nada; buffer final sem "\\n\\n" → nada.', ['event: ping\n\n', 'data: {"type":"session.idle"}\n']);
sseCaso('utf8-partido-entre-chunks', BORDA, 'Emoji (4 bytes) partido entre chunks TCP: TextDecoder em modo stream remonta. chunks_hex são os bytes crus.', null, {
  bytes: (() => {
    const b = Buffer.from(sse(ev('session.next.text.ended', { text: 'oi 😀 日本' })), 'utf8');
    const i = b.indexOf(Buffer.from('😀', 'utf8')) + 2;
    return [b.subarray(0, i), b.subarray(i)];
  })(),
});
sseCaso('texto-vazio-vs-null', BORDA, 'text() do OpenCode aceita string vazia (diferente de firstString dos mappers): text "" fica "", campo ausente fica null.', [sse(ev('session.next.text.ended', { text: '' }), ev('session.next.text.delta'))]);
sseCaso('step-ended-custo-borda', BORDA, 'Sem tokens e sem cost → sem custo; só cost; tokens {} → sem custo; cache só write; arquivos não-string filtrados.', [sse(ev('session.next.step.ended', {}), ev('session.next.step.ended', { cost: 0 }), ev('session.next.step.ended', { tokens: {} }), ev('session.next.step.ended', { tokens: { output: 1, cache: { write: 2 } }, files: ['ok.ts', 3, null] }))]);
sseCaso('sem-type', BORDA, 'type ausente/vazio → nada.', [sse({ data: { sessionID: SESSAO } }, { type: '', data: { sessionID: SESSAO } })]);

function rodarSse(c) {
  const dec = new oc.SseDecoder();
  const td = new TextDecoder();
  const chunksBytes = c.bytes ?? c.chunks.map((s) => Buffer.from(s, 'utf8'));
  const decoded = [];
  for (const b of chunksBytes) decoded.push(...dec.push(td.decode(b, { stream: true })));
  const porEvento = [];
  const filtrados = [];
  let erroDoTurno = null;
  let outcome = null;
  for (const evento of decoded) {
    const sid = oc.openCodeSessionId(evento);
    const passa = sid === SESSAO;
    const pend = oc.openCodePendingRequest(evento);
    const eventos = oc.translateOpenCodeEvent(evento);
    const idle = oc.openCodeIdleSignal(evento);
    porEvento.push({ session_id: sid, passes_filter: passa, pending_request: pend, idle_signal: idle, events: canon(eventos) });
    if (!passa || outcome) continue;
    for (const m of eventos) {
      if (m.type === 'error') erroDoTurno = describeErrorPayload(m.payload);
      filtrados.push(m);
    }
    if (idle) outcome = { exitCode: erroDoTurno === null ? 0 : 1, reason: 'exit', error: erroDoTurno };
  }
  const out = { id: `opencode-sse/${c.slug}`, source: c.source, spec: SPEC_SSE, notes: c.notes, session_filter: SESSAO };
  if (c.bytes) out.chunks_hex = c.bytes.map((b) => b.toString('hex'));
  else out.chunks = c.chunks;
  Object.assign(out, {
    expected_decoded: canon(decoded),
    expected_per_decoded: porEvento,
    expected_events: canon(filtrados),
    outcome_at_idle: outcome,
  });
  return out;
}

// ============================================================================
// 3. Invocação (montarInvocacao) dos 9 manifestos
// ============================================================================
const T_PD = 'packages/adapters/src/prompt-delivery.test.ts';
const T_GS = 'packages/adapters/src/gate-settings.test.ts';
const T_MM = 'packages/adapters/src/manifest-model.test.ts';
const MANS = loadManifestDir(MANIFESTOS);
const porId = Object.fromEntries(MANS.map((m) => [m.id, m]));
const INV = [];
const PROMPT_MARCADOR = '# Tarefa\n\nlinha 2 com "aspas" & %PATH% 日本語 😀';

function inv(manifestId, slug, source, notes, s, manifestOverride) {
  const m = manifestOverride ?? porId[manifestId];
  const template = s.template === 'resume' ? m.invoke.resume : m.invoke.oneShot;
  const nid = s.nativeSessionId ?? null;
  const ctx = { mode: s.mode, workdir: s.workdir ?? 'C:\\projeto' };
  if ('model' in s) ctx.model = s.model;
  if (s.env) ctx.env = s.env;
  if (s.extraArgs) ctx.extraArgs = s.extraArgs;
  if (s.settingsFile) ctx.settingsFile = s.settingsFile;
  const cenario = { template: s.template, prompt: s.prompt, nativeSessionId: nid, mode: s.mode, workdir: ctx.workdir, model: s.model ?? null, env: s.env ?? {}, extraArgs: s.extraArgs ?? [], settingsFile: s.settingsFile ?? null, promptFile: s.promptFile ?? '' };
  const rec = { id: `${m.id}/${slug}`, manifest: m.id, source, spec: SPEC_INV, notes, scenario: cenario };
  if (manifestOverride) rec.manifest_inline = canon(m);
  try {
    const r = montarInvocacao(m, ctx, template, s.prompt, nid, s.promptFile ?? '');
    const usaStdin = m.invoke.stdinPrompt;
    rec.expected = {
      args: r.args,
      entrega: r.entrega,
      stdin: { write: usaStdin ? s.prompt : null, close_after_write: !m.invoke.interactive },
      env_overlay: { ...m.invoke.env, ...(s.env ?? {}), AGENTS_HUB_SESSION_ID: 'ses_conf', AGENTS_HUB_TASK_ID: '', AGENTS_HUB_AGENT_ID: m.id },
    };
  } catch (err) {
    rec.spec = SPEC_INV_ERRO;
    rec.expected_error = { code: err.code ?? null, message: err.message };
  }
  INV.push(rec);
}

for (const m of MANS) {
  for (const mode of ['supervised', 'semi', 'autonomous']) {
    inv(m.id, `oneShot-${mode}`, 'docs/especificacao/04-dominio-e-adapters.md (B2, argv efetivo)', 'oneShot sem modelo nem settings.', { template: 'oneShot', prompt: 'PROMPT', mode });
    inv(m.id, `resume-${mode}-modelo-settings`, 'docs/especificacao/04-dominio-e-adapters.md (B2, argv efetivo)', 'resume com id NID, modelo MODELO e settingsFile (só entra onde há gate.settingsArgs).', { template: 'resume', prompt: 'PROMPT', mode, nativeSessionId: 'NID', model: 'MODELO', settingsFile: 'SETTINGS.json' });
  }
  for (const t of ['oneShot', 'resume']) {
    inv(m.id, `${t}-prompt-marcador`, `${T_PD}:46`, 'Contrato: o prompt chega por algum caminho; em argv aparece em exatamente 1 argumento; em stdin não vaza ao argv.', { template: t, prompt: PROMPT_MARCADOR, mode: 'supervised', nativeSessionId: 'sess-nativa-1', promptFile: 'C:\\tmp\\p.md' });
    inv(m.id, `${t}-modelo-de-teste`, `${T_MM}:27`, 'Modelo com "/" e "." logo após a flag do manifesto (cursor: ignorado).', { template: t, prompt: 'prompt', mode: 'semi', nativeSessionId: 'sess-1', model: 'modelo-de-teste/v1.2', extraArgs: [], promptFile: 'C:\\tmp\\p.md' });
    inv(m.id, `${t}-sem-modelo`, `${T_MM}:63`, 'Sem modelo nenhuma flag de modelo solta.', { template: t, prompt: 'prompt', mode: 'semi', nativeSessionId: 'sess-1', model: undefined, extraArgs: [] });
  }
  inv(m.id, 'oneShot-prompt-vazio', BORDA, 'DIVERGÊNCIA CONHECIDA: prompt "" em argv: o argumento vazio é REMOVIDO (filtro de vazios), e a flag -p fica sem valor (copilot/kimi). Em antigravity sobra "-p=".', { template: 'oneShot', prompt: '', mode: 'semi' });
  inv(m.id, 'resume-id-vazio', BORDA, 'nativeSessionId "" (não null): o argumento some e resumeModeArgs é escolhido (só null usa modeArgs).', { template: 'resume', prompt: 'p', mode: 'supervised', nativeSessionId: '' });
}
// cenários dos testes
inv('antigravity', 'oneShot-diga-oi', `${T_PD}:93`, 'argv exato.', { template: 'oneShot', prompt: 'diga oi', mode: 'supervised' });
inv('antigravity', 'resume-continue', `${T_PD}:99`, 'argv exato do resume.', { template: 'resume', prompt: 'continue', mode: 'supervised', nativeSessionId: 'conv-123' });
inv('antigravity', 'oneShot-semi-x', `${T_PD}:112`, '-p nunca solto.', { template: 'oneShot', prompt: 'x', mode: 'semi' });
inv('antigravity', 'oneShot-prompt-com-hifen', `${T_PD}:119`, 'Prompt que começa com "-" fica anexado ao -p.', { template: 'oneShot', prompt: '--help me', mode: 'supervised' });
inv('mimo', 'oneShot-stdin', `${T_PD}:125`, 'mimo: prompt por stdin.', { template: 'oneShot', prompt: PROMPT_MARCADOR, mode: 'supervised' });
for (const t of ['oneShot', 'resume']) inv('codex', `${t}-skip-git-repo-check`, `${T_PD}:135`, '--skip-git-repo-check sempre.', { template: t, prompt: 'oi', mode: 'supervised', nativeSessionId: 'thread-1' });
for (const id of ['claude', 'openclaude']) {
  inv(id, 'oneShot-settings', `${T_GS}:25`, '--settings seguido do arquivo.', { template: 'oneShot', prompt: 'prompt', mode: 'semi', workdir: 'C:\\p', settingsFile: 'C:\\hub\\run\\ses_abc-settings.json' });
  inv(id, 'resume-settings', `${T_GS}:25`, '--settings seguido do arquivo no resume.', { template: 'resume', prompt: 'prompt', mode: 'semi', workdir: 'C:\\p', nativeSessionId: 'nativo-1', settingsFile: 'C:\\hub\\run\\ses_abc-settings.json' });
  inv(id, 'oneShot-sem-settings', `${T_GS}:39`, 'Sem arquivo, sem --settings e sem placeholder vazado.', { template: 'oneShot', prompt: 'p', mode: 'semi', workdir: 'C:\\p' });
}
for (const mode of ['supervised', 'semi', 'autonomous']) {
  inv('kimi', `oneShot-${mode}-flags-proibidas`, `${T_KIMI}:24`, 'Nenhuma de -y/--yolo/--auto/--plan.', { template: 'oneShot', prompt: 'oi', mode, model: undefined, extraArgs: [] });
  inv('kimi', `resume-${mode}-flags-proibidas`, `${T_KIMI}:24`, 'Nenhuma de -y/--yolo/--auto/--plan; resume sem --agent.', { template: 'resume', prompt: 'oi', mode, nativeSessionId: 'session_1', model: undefined, extraArgs: [] });
}
inv('cursor', 'modelo-ignorado', `${T_MM}:83`, 'model.supported false: modelo ignorado.', { template: 'oneShot', prompt: 'prompt', mode: 'semi', workdir: 'C:\\p', model: 'modelo-de-teste/v1.2', extraArgs: [] });
inv('claude', 'modelo-pelo-env', `${T_MM}:101`, 'MODEL do env vale sem ctx.model.', { template: 'oneShot', prompt: 'x', mode: 'semi', workdir: 'C:\\p', env: { MODEL: 'sonnet' }, extraArgs: [] });
inv('claude', 'modelo-explicito-ganha-do-env', `${T_MM}:113`, 'ctx.model ganha de MODEL.', { template: 'oneShot', prompt: 'x', mode: 'semi', workdir: 'C:\\p', model: 'opus', env: { MODEL: 'sonnet' }, extraArgs: [] });
for (const [i, ruim] of ['--dangerously-skip-permissions', '-p', 'a\nb', 'x'.repeat(201)].entries()) {
  inv('claude', `modelo-invalido-${i + 1}`, `${T_MM}:126`, 'Modelo que parece flag, com controle ou > 200 → ADAPTER_FAILURE.', { template: 'oneShot', prompt: 'x', mode: 'semi', workdir: 'C:\\p', model: ruim, extraArgs: [] });
}
// bordas
inv('claude', 'modelo-200-chars', BORDA, 'Exatamente 200 caracteres: aceito (o teto é > 200).', { template: 'oneShot', prompt: 'x', mode: 'semi', model: 'm'.repeat(200) });
inv('claude', 'modelo-com-espacos', BORDA, 'trim antes de validar; "  sonnet  " → "sonnet". Modelo só com espaços → sem modelo.', { template: 'oneShot', prompt: 'x', mode: 'semi', model: '  sonnet  ' });
inv('claude', 'modelo-so-espacos', BORDA, 'Modelo "   " → sem modelo (nenhuma flag).', { template: 'oneShot', prompt: 'x', mode: 'semi', model: '   ' });
inv('claude', 'modelo-vazio-cai-no-env', BORDA, 'ctx.model "" é falsy: vale MODEL do env.', { template: 'oneShot', prompt: 'x', mode: 'semi', model: '', env: { MODEL: 'haiku' } });
inv('claude', 'modelo-del-0x7f', BORDA, 'DEL (U+007F) é caractere de controle → recusado.', { template: 'oneShot', prompt: 'x', mode: 'semi', model: 'a\u007fb' });
inv('claude', 'modelo-unicode', BORDA, 'Modelo com CJK/emoji (sem controle) é aceito; o teto de 200 conta unidades UTF-16.', { template: 'oneShot', prompt: 'x', mode: 'semi', model: '模型😀' });
inv('claude', 'modelo-100-emojis', BORDA, 'DIVERGÊNCIA CONHECIDA: 100 emojis = 200 unidades UTF-16 (aceito); 101 emojis = 202 (recusado), embora sejam 101 caracteres.', { template: 'oneShot', prompt: 'x', mode: 'semi', model: '😀'.repeat(100) });
inv('claude', 'modelo-101-emojis', BORDA, 'Ver modelo-100-emojis.', { template: 'oneShot', prompt: 'x', mode: 'semi', model: '😀'.repeat(101) });
inv('cursor', 'modelo-invalido-ignorado-sem-suporte', BORDA, 'Sem suporte a modelo, nem valida: "--x" não lança.', { template: 'oneShot', prompt: 'x', mode: 'semi', model: '--x' });
inv('codex', 'extra-args-do-gate', 'docs/especificacao/04-dominio-e-adapters.md (B10, codex)', 'ctx.extraArgs (hook do gate do Codex) entra depois de modeArgs e invoke.extraArgs.', { template: 'resume', prompt: 'p', mode: 'semi', nativeSessionId: 'th-1', model: 'gpt-6-sol', extraArgs: ['-c', 'hooks={PreToolUse=[{matcher="*",hooks=[{type="command",command="NODE CLI hook --dialect codex --session ses_X",timeoutSec=120}]}]}', '--dangerously-bypass-hook-trust'] });
inv('copilot', 'prompt-com-placeholder-literal', BORDA, 'Prompt contendo "{{model}}"/"{{nativeSessionId}}" não é reexpandido (substituição em passada única).', { template: 'resume', prompt: 'use {{model}} e {{nativeSessionId}}', mode: 'semi', nativeSessionId: 'N1', model: 'M1' });
inv('kimi', 'prompt-hostil-argv', `${T_PD}:263`, 'Prompt hostil vai íntegro como 1 argumento (o escape do cmd.exe é do montarSpawn, fora deste corpus).', { template: 'oneShot', prompt: 'x" & echo PWN>x & "', mode: 'semi' });
inv('opencode', 'settings-sem-gate', BORDA, 'settingsFile em manifesto sem gate.settingsArgs: nada entra.', { template: 'oneShot', prompt: 'p', mode: 'semi', settingsFile: 'S.json' });
inv('mimo', 'env-overlay', BORDA, 'env_overlay = invoke.env + ctx.env + AGENTS_HUB_* (o process.env do daemon fica por baixo, não listado).', { template: 'oneShot', prompt: 'p', mode: 'autonomous', env: { MODEL: 'mimo-v2', OUTRA: '1', AGENTS_HUB_AGENT_ID: 'tentativa-de-sobrescrever' } });
// sintéticos ({{promptFile}}, {{workdir}}, nenhuma) — nenhum manifesto real usa
const sintetico = (o) => AgentManifestSchema.parse({ id: 'sintetico', name: 'Sintético', bin: 'sintetico', ...o });
inv('sintetico', 'prompt-file', 'packages/adapters/src/process-adapter.ts:600-672', 'SINTÉTICO (nenhum manifesto real usa {{promptFile}}/{{workdir}}): entrega promptFile; {{prompt}} vira "" e some.', { template: 'oneShot', prompt: 'P', mode: 'semi', workdir: 'C:\\w', promptFile: 'C:\\tmp\\agents-hub\\prompts\\ses-1.md' }, sintetico({ invoke: { oneShot: ['--file', '{{promptFile}}', '--cwd', '{{workdir}}', '{{prompt}}', '{{desconhecido}}'] } }));
inv('sintetico', 'nenhuma', 'packages/adapters/src/process-adapter.ts:665-672', 'SINTÉTICO: sem {{prompt}}, sem stdin, sem arquivo → entrega "nenhuma".', { template: 'oneShot', prompt: 'P', mode: 'semi' }, sintetico({ invoke: { oneShot: ['run'] } }));
inv('sintetico', 'interativo', 'packages/adapters/src/process-adapter.ts:539-564', 'SINTÉTICO: interactive true com stdin → escreve o prompt e NÃO fecha o stdin.', { template: 'oneShot', prompt: 'P', mode: 'semi' }, sintetico({ invoke: { oneShot: ['run'], stdinPrompt: true, interactive: true, env: { A: 'manifesto' } } }));

// ============================================================================
// 4. Schema dos manifestos
// ============================================================================
const SCHEMA = [];
for (const f of readdirSyncSorted(MANIFESTOS)) {
  const m = loadManifestFile(path.join(MANIFESTOS, f));
  SCHEMA.push({ id: `manifest/${m.id}`, source: `manifests/${f}`, spec: SPEC_SCHEMA, notes: 'Manifesto real carregado pelo loadManifestFile (YAML → AgentManifestSchema, defaults aplicados, chaves desconhecidas removidas).', input_file: `manifests/${f}`, expected: { success: true, data: canon(m) } });
}
function schemaCaso(slug, source, notes, input) {
  const r = AgentManifestSchema.safeParse(input);
  SCHEMA.push({ id: `schema/${slug}`, source, spec: SPEC_SCHEMA, notes, input, expected: r.success ? { success: true, data: canon(r.data) } : { success: false, issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
}
const BASE = { id: 'x', name: 'X', bin: 'x', invoke: { oneShot: ['-p'] } };
schemaCaso('minimo-defaults', `${T_MM}:144`, 'Mínimo: todos os defaults.', BASE);
schemaCaso('model-supported-sem-placeholder', `${T_MM}:147`, 'supported true exige {{model}}.', { ...BASE, model: { supported: true, args: ['--model'] } });
schemaCaso('model-args-sem-suporte', `${T_MM}:151`, 'args sem supported.', { ...BASE, model: { supported: false, args: ['-m', '{{model}}'] } });
schemaCaso('native-missing-regex-invalida', `${T_FAIL}:98`, 'Regex que não compila.', { ...BASE, session: { nativeSessionMissing: ['(sem fechar'] } });
schemaCaso('gate-sem-placeholder', BORDA, 'gate.settingsArgs sem {{settingsFile}}.', { ...BASE, gate: { settingsArgs: ['--settings'] } });
schemaCaso('oneshot-vazio', BORDA, 'invoke.oneShot vazio.', { ...BASE, invoke: { oneShot: [] } });
schemaCaso('sem-id', BORDA, 'id ausente e name vazio.', { name: '', bin: 'x', invoke: { oneShot: ['a'] } });
schemaCaso('enum-invalido', BORDA, 'strategy/format/isolation fora do enum; timeoutSeconds não inteiro.', { ...BASE, session: { strategy: 'resume' }, stream: { format: 'json' }, defaults: { isolation: 'vm', timeoutSeconds: 1.5 } });
schemaCaso('auth-nao-inherit', BORDA, 'auth.mode só aceita "inherit".', { ...BASE, auth: { mode: 'token' } });
schemaCaso('chaves-desconhecidas', BORDA, 'Chaves desconhecidas são removidas (strip), em qualquer nível.', { ...BASE, extra: 1, invoke: { oneShot: ['a'], naoExiste: true }, stream: { format: 'jsonl', mapper: 'claude', x: 1 } });
schemaCaso('resume-mode-args-parcial', BORDA, 'resumeModeArgs parcial recebe defaults [] nos modos ausentes.', { ...BASE, invoke: { oneShot: ['a'], resumeModeArgs: { supervised: ['--x'] } } });
schemaCaso('env-nao-string', BORDA, 'invoke.env com valor não-string.', { ...BASE, invoke: { oneShot: ['a'], env: { A: 1 } } });

// ============================================================================
// 5. Motivo da falha
// ============================================================================
const AVISO = 'failed to load skill C:\\x\\universal-agent-guide\\SKILL.md: missing YAML frontmatter';
const CODEX_RUIDO = 'ERROR codex_core::session::session: failed to load skill C:/x/SKILL.md: missing YAML frontmatter';
const SEM_CONVERSA = 'No conversation found with session ID: cb8f904e-1abd-41d8-a15d-78075a22b01f';
const FR = [];
function fr(fn, slug, source, notes, args) {
  let expected;
  if (fn === 'motivoDaFalha') expected = failure.motivoDaFalha(...args);
  else if (fn === 'ultimaLinhaDeErro') expected = failure.ultimaLinhaDeErro(...args);
  else if (fn === 'mensagemDoEventoDeErro') expected = failure.mensagemDoEventoDeErro(...args);
  else if (fn === 'sessaoNativaInexistente') expected = failure.sessaoNativaInexistente(...args);
  FR.push({ id: `${fn}/${slug}`, fn, source, spec: SPEC_FR[fn], notes, args, expected });
}
const PADROES_CLAUDE = porId.claude.session.nativeSessionMissing;
fr('motivoDaFalha', 'evento-do-agente-vence', `${T_FAIL}:24`, 'Último erro do agente vence o stderr.', [1, ["You've hit your usage limit. Try again later."], [AVISO, 'ERROR: stream ended']]);
fr('ultimaLinhaDeErro', 'nunca-aviso', `${T_FAIL}:35`, 'Última linha de erro, pulando avisos.', [[AVISO, 'Error: 401 Unauthorized', 'WARN: something failed later']]);
fr('motivoDaFalha', 'so-aviso', `${T_FAIL}:38`, 'Só aviso → "não emitiu mensagem".', [2, [], [AVISO]]);
fr('mensagemDoEventoDeErro', 'result-de-erro-sem-texto', `${T_FAIL}:63`, 'Evento error do result sem texto → null.', [canon(resolveMapper('claude')({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, total_cost_usd: 0 })[0])]);
fr('motivoDaFalha', 'ultima-linha-util', `${T_FAIL}:64`, 'Sem cara de erro: última linha útil.', [1, [], [SEM_CONVERSA]]);
fr('motivoDaFalha', 'ruido-antes', `${T_FAIL}:70`, 'Ruído SKILL.md antes da linha útil.', [1, [], [CODEX_RUIDO, SEM_CONVERSA]]);
fr('motivoDaFalha', 'ruido-depois', `${T_FAIL}:74`, 'Ruído SKILL.md depois da linha útil.', [1, [], [SEM_CONVERSA, CODEX_RUIDO]]);
fr('motivoDaFalha', 'erro-preferido-a-util', `${T_FAIL}:76`, 'Linha com cara de erro preferida à última qualquer.', [1, [], ['Error: 401 Unauthorized', 'tentando de novo em 3s']]);
fr('sessaoNativaInexistente', 'stderr-casa', `${T_FAIL}:85`, 'Padrão do manifesto do Claude casa linha do stderr.', [PADROES_CLAUDE, ['aviso qualquer', SEM_CONVERSA].join('\n'), null]);
fr('sessaoNativaInexistente', 'motivo-casa', `${T_FAIL}:87`, 'Casa o motivo montado.', [PADROES_CLAUDE, '', `processo terminou com código 1: ${SEM_CONVERSA}`]);
fr('sessaoNativaInexistente', 'nao-casa', `${T_FAIL}:90`, 'Outro erro não casa.', [PADROES_CLAUDE, 'Error: 401 Unauthorized', 'código 1']);
fr('sessaoNativaInexistente', 'sem-padrao-nunca', `${T_FAIL}:91`, 'Sem padrões nunca casa.', [[], SEM_CONVERSA, SEM_CONVERSA]);
// bordas
fr('motivoDaFalha', 'exit-null', BORDA, 'exitCode null → "código null".', [null, [], []]);
fr('motivoDaFalha', 'corte-2000', BORDA, 'Motivo > 2000 após colapsar espaços → 1999 unidades + "…".', [1, [longa(2500, 'e')], []]);
fr('motivoDaFalha', 'exato-2000', BORDA, 'Exatamente 2000 → intacto.', [1, [longa(2000, 'e')], []]);
fr('motivoDaFalha', 'corte-utf16-emoji', BORDA, 'DIVERGÊNCIA CONHECIDA: corte por unidade UTF-16; emoji nas posições 1998-1999 é partido (sobra surrogate alto).', [1, [longa(1998, 'e') + '😀' + longa(10, 'f')], []]);
fr('motivoDaFalha', 'colapsa-espacos-unicode', BORDA, '\\s do JS inclui \\t \\n NBSP U+2028 U+3000 BOM: tudo vira 1 espaço e as pontas são aparadas.', [1, ['  linha1\n\tlinha2\u00a0\u2028\u3000\uFEFFfim  '], []]);
fr('motivoDaFalha', 'ultimo-erro-do-agente', BORDA, 'Vários erros do agente: vale o último.', [3, ['primeiro', 'segundo'], ['Error: stderr']]);
fr('motivoDaFalha', 'stderr-vazio-e-brancos', BORDA, 'Linhas vazias/brancas são puladas.', [1, [], ['', '   ', '\t']]);
fr('ultimaLinhaDeErro', 'fronteiras-de-palavra', BORDA, '\\b ASCII: "information" não é aviso (info sem fronteira); "falhação" casa falh\\w*; "v1.404.2" casa \\b[45]\\d\\d\\b; "5030" não.', [['falhação total', 'information: x', 'porta 5030', 'v1.404.2']]);
fr('ultimaLinhaDeErro', 'aviso-com-erro', BORDA, 'Linha com aviso E erro é pulada (aviso vence).', [['Error: real', 'warning: deprecated api failed']]);
fr('ultimaLinhaDeErro', 'nada', BORDA, 'Nenhuma linha com cara de erro → null.', [['tudo certo', 'pronto']]);
fr('ultimaLinhaDeErro', 'palavras-de-erro', BORDA, 'Cada palavra-chave (última que casa).', [['denied', 'refused', 'unauthorised', 'forbidden', 'quota', 'credit', 'exception', 'Falhou geral']]);
fr('mensagemDoEventoDeErro', 'ordem-dos-campos', BORDA, 'message > error > summary > text; com trim; vazio/branco pula.', [{ type: 'error', payload: { message: '  ', error: 7, summary: '  resumo  ', text: 'texto' } }]);
fr('mensagemDoEventoDeErro', 'nao-error', BORDA, 'Tipo ≠ error → null.', [{ type: 'log', payload: { message: 'x' } }]);
fr('sessaoNativaInexistente', 'case-insensitive-crlf', BORDA, 'Flag i; stderr quebrado em \\r?\\n.', [PADROES_CLAUDE, 'a\r\nno CONVERSATION found with session id: x\r\n', null]);

// ============================================================================
// Gravação
// ============================================================================
function readdirSyncSorted(dir) {
  return readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort();
}

mkdirSync(OUT, { recursive: true });
const gravados = {};
function gravar(nome, registros) {
  const texto = registros.map((r) => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(path.join(OUT, nome), texto, 'utf8');
  gravados[nome] = { cases: registros.length, sha256: createHash('sha256').update(texto).digest('hex') };
}

const nomesMappers = listMappers();
for (const nome of Object.keys(FORMATO)) {
  if (!nomesMappers.includes(nome)) throw new Error(`mapper ${nome} não registrado`);
}
for (const nome of nomesMappers) {
  if (!CASOS[nome]) throw new Error(`mapper ${nome} registrado sem casos no gerador`);
  gravar(`${nome}.jsonl`, CASOS[nome].map((c) => rodarMapper(nome, c)));
}
gravar('opencode-sse.jsonl', SSE_CASOS.map(rodarSse));
gravar('invocation.jsonl', INV);
gravar('manifest-schema.jsonl', SCHEMA);
gravar('failure-reason.jsonl', FR);

// Hashes das fontes (LF) e dos .jsonl gravados; sem versão exata do Node.
writeFileSync(path.join(OUT, 'sources.json'), JSON.stringify({ files: gravados, sources: fontes }, null, 2) + '\n', 'utf8');

for (const [nome, info] of Object.entries(gravados)) console.log(`${nome}\t${info.cases} casos\t${info.sha256}`);
