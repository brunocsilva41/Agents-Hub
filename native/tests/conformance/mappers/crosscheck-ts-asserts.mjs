#!/usr/bin/env node
/**
 * CONF-02 — cruzamento do corpus com os asserts dos testes TS.
 *
 * Cada entrada reproduz, sobre o REGISTRO DO CORPUS, um assert de um
 * `*.test.ts` (arquivo:linha). Se o gerador tiver transcrito mal uma entrada,
 * ou se o corpus divergir do comportamento testado, o assert falha aqui.
 *
 * Só lê os .jsonl desta pasta; não importa TS, não spawna nada.
 *   node native/tests/conformance/mappers/crosscheck-ts-asserts.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const carregar = (f) =>
  Object.fromEntries(
    readFileSync(path.join(AQUI, f), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .map((r) => [r.id, r]),
  );
const C = {};
for (const f of ['claude', 'codex', 'copilot', 'kimi', 'antigravity', 'generic-json', 'generic-text', 'opencode-sse', 'invocation', 'manifest-schema', 'failure-reason']) {
  Object.assign(C, carregar(`${f}.jsonl`));
}
const caso = (id) => {
  const r = C[id];
  if (!r) throw new Error(`caso ausente no corpus: ${id}`);
  return r;
};
const ev = (id, i = 0) => caso(id).expected_events[i];
const args = (id) => caso(id).expected.args;
const fr = (id) => caso(id).expected;
const steps = (id) => caso(id).turn_cost.steps;
const tokens = (c) => (c?.inputTokens ?? 0) + (c?.outputTokens ?? 0);
const perto = (a, b) => Math.abs(a - b) < 1e-12;

const A = 'packages/adapters/src/';
const CHECKS = [
  // ---- mappers/claude.test.ts
  [`${A}mappers/claude.test.ts:23`, () => ['hook_started', 'hook_response'].forEach((s) => assert.equal(ev(`claude/system-${s}-nao-define-id`).type, 'log'))],
  [`${A}mappers/claude.test.ts:24`, () => ['hook_started', 'hook_response'].forEach((s) => assert.equal(ev(`claude/system-${s}-nao-define-id`).nativeSessionId, undefined))],
  [`${A}mappers/claude.test.ts:30`, () => assert.equal(ev('claude/system-init').type, 'session.started')],
  [`${A}mappers/claude.test.ts:31`, () => assert.equal(ev('claude/system-init').nativeSessionId, 'cb8f904e-1abd-41d8-a15d-78075a22b01f')],
  [`${A}mappers/claude.test.ts:42`, () => assert.equal(ev('claude/result-success-com-sessao').nativeSessionId, 'cb8f904e-1abd-41d8-a15d-78075a22b01f')],
  // ---- mappers/turn-cost.test.ts (sem precificação: o corpus guarda o custo como o mapper emite)
  [`${A}mappers/turn-cost.test.ts:61`, () => { const f = steps('claude/turno-relatorio-11-parcial-vs-final').at(-1); assert.equal(f.kind, 'final'); assert.ok(perto(f.cost.usd, 0.1378276)); }],
  [`${A}mappers/turn-cost.test.ts:62`, () => assert.equal(tokens(steps('claude/turno-relatorio-11-parcial-vs-final').at(-1).cost), 6)],
  [`${A}mappers/turn-cost.test.ts:75`, () => steps('claude/turno-morto-antes-do-result').forEach((s) => assert.equal(s.kind, 'estimate'))],
  [`${A}mappers/turn-cost.test.ts:81`, () => assert.equal(steps('claude/turno-morto-antes-do-result').length, 2)],
  [`${A}mappers/turn-cost.test.ts:82`, () => { const [a, b] = steps('claude/turno-morto-antes-do-result'); assert.deepEqual(a.total, b.total); }],
  [`${A}mappers/turn-cost.test.ts:92`, () => assert.ok(perto(steps('claude/mensagens-diferentes-somam').at(-1).cost.usd, 0.05))],
  [`${A}mappers/turn-cost.test.ts:100 (adaptado: flush não nulo com tokens)`, () => assert.ok(tokens(caso('claude/turno-morto-antes-do-result').turn_cost.flush) > 0)],
  [`${A}mappers/turn-cost.test.ts:127`, () => assert.equal(tokens(steps('antigravity/etapas-mais-result').at(-1).cost), 15305)],
  [`${A}mappers/turn-cost.test.ts:144`, () => assert.equal(tokens(caso('antigravity/result-sem-numeros-mantem-estimativa').turn_cost.flush), 105)],
  [`${A}mappers/turn-cost.test.ts:165`, () => assert.ok(perto(caso('copilot/turno-com-creditos').turn_cost.flush.usd, 0.005298219))],
  [`${A}mappers/turn-cost.test.ts:166`, () => assert.equal(tokens(caso('copilot/turno-com-creditos').turn_cost.flush), 322)],
  [`${A}mappers/turn-cost.test.ts:175`, () => assert.ok(ev('copilot/sessao-retomada-base').cost)],
  [`${A}mappers/turn-cost.test.ts:178`, () => assert.ok(perto(caso('copilot/sessao-retomada-base').turn_cost.flush.usd, 0.005298219))],
  [`${A}mappers/turn-cost.test.ts:179`, () => assert.ok(perto(caso('copilot/sessao-retomada-base').turn_cost.flush.credits, 0.5298219))],
  // ---- failure-reason.test.ts
  [`${A}failure-reason.test.ts:29`, () => assert.match(fr('motivoDaFalha/evento-do-agente-vence'), /usage limit/)],
  [`${A}failure-reason.test.ts:30`, () => assert.doesNotMatch(fr('motivoDaFalha/evento-do-agente-vence'), /SKILL/)],
  [`${A}failure-reason.test.ts:34`, () => assert.equal(fr('ultimaLinhaDeErro/nunca-aviso'), 'Error: 401 Unauthorized')],
  [`${A}failure-reason.test.ts:39`, () => assert.doesNotMatch(fr('motivoDaFalha/so-aviso'), /SKILL/)],
  [`${A}failure-reason.test.ts:40`, () => assert.match(fr('motivoDaFalha/so-aviso'), /código 2/)],
  [`${A}failure-reason.test.ts:61`, () => assert.ok(ev('claude/result-error-during-execution'))],
  [`${A}failure-reason.test.ts:63`, () => { assert.equal(fr('mensagemDoEventoDeErro/result-de-erro-sem-texto'), null); assert.deepEqual(caso('claude/result-error-during-execution').agent_errors, []); }],
  [`${A}failure-reason.test.ts:65`, () => assert.match(fr('motivoDaFalha/ultima-linha-util'), /No conversation found with session ID/)],
  [`${A}failure-reason.test.ts:66`, () => assert.doesNotMatch(fr('motivoDaFalha/ultima-linha-util'), /não emitiu/)],
  [`${A}failure-reason.test.ts:71`, () => assert.match(fr('motivoDaFalha/ruido-antes'), /No conversation found/)],
  [`${A}failure-reason.test.ts:72`, () => assert.doesNotMatch(fr('motivoDaFalha/ruido-antes'), /SKILL/)],
  [`${A}failure-reason.test.ts:74`, () => assert.match(fr('motivoDaFalha/ruido-depois'), /No conversation found/)],
  [`${A}failure-reason.test.ts:76`, () => assert.match(fr('motivoDaFalha/erro-preferido-a-util'), /401/)],
  [`${A}failure-reason.test.ts:83`, () => assert.ok(caso('manifest/claude').expected.data.session.nativeSessionMissing.length > 0)],
  [`${A}failure-reason.test.ts:85`, () => assert.equal(fr('sessaoNativaInexistente/stderr-casa'), true)],
  [`${A}failure-reason.test.ts:86`, () => assert.equal(fr('sessaoNativaInexistente/motivo-casa'), true)],
  [`${A}failure-reason.test.ts:90`, () => assert.equal(fr('sessaoNativaInexistente/nao-casa'), false)],
  [`${A}failure-reason.test.ts:91`, () => assert.equal(fr('sessaoNativaInexistente/sem-padrao-nunca'), false)],
  [`${A}failure-reason.test.ts:96`, () => assert.deepEqual(caso('schema/minimo-defaults').expected.data.session.nativeSessionMissing, [])],
  [`${A}failure-reason.test.ts:97`, () => assert.equal(caso('schema/native-missing-regex-invalida').expected.success, false)],
  [`${A}failure-reason.test.ts:106`, () => assert.equal(ev('claude/rate-limit-event').payload.kind, 'tecnico')],
  [`${A}failure-reason.test.ts:107`, () => assert.equal(typeof ev('claude/rate-limit-event').payload.text, 'string')],
  [`${A}failure-reason.test.ts:112`, () => assert.equal(caso('claude/thinking-vazio-some').expected_events.length, 0)],
  // ---- mappers/antigravity.test.ts
  [`${A}mappers/antigravity.test.ts:17`, () => assert.equal(ev('antigravity/init').type, 'session.started')],
  [`${A}mappers/antigravity.test.ts:18`, () => assert.equal(ev('antigravity/init').nativeSessionId, '30077937-4cf4-44cb-a349-1f05165b5865')],
  [`${A}mappers/antigravity.test.ts:19`, () => assert.equal(ev('antigravity/init').payload.cwd, 'C:\\Users\\workspace')],
  [`${A}mappers/antigravity.test.ts:23`, () => assert.deepEqual(caso('antigravity/user-input-descartado').expected_events, [])],
  [`${A}mappers/antigravity.test.ts:56`, () => assert.equal(ev('antigravity/agent-response-com-custo').type, 'message')],
  [`${A}mappers/antigravity.test.ts:57`, () => assert.equal(ev('antigravity/agent-response-com-custo').payload.text, 'Olá, mundo!')],
  [`${A}mappers/antigravity.test.ts:58`, () => assert.equal(ev('antigravity/agent-response-com-custo').cost.inputTokens, 1200)],
  [`${A}mappers/antigravity.test.ts:59`, () => assert.equal(ev('antigravity/agent-response-com-custo').cost.outputTokens, 45)],
  [`${A}mappers/antigravity.test.ts:60`, () => assert.equal(ev('antigravity/agent-response-com-custo').cost.cachedTokens, 200)],
  [`${A}mappers/antigravity.test.ts:61`, () => assert.equal(ev('antigravity/agent-response-com-custo').nativeSessionId, 'conv-123')],
  [`${A}mappers/antigravity.test.ts:77`, () => assert.equal(ev('antigravity/tool-comando').type, 'command.executed')],
  [`${A}mappers/antigravity.test.ts:78`, () => assert.equal(ev('antigravity/tool-comando').payload.command, 'npm test')],
  [`${A}mappers/antigravity.test.ts:79`, () => assert.equal(ev('antigravity/tool-comando').payload.cwd, 'C:\\repo')],
  [`${A}mappers/antigravity.test.ts:95`, () => assert.equal(ev('antigravity/tool-arquivo').type, 'file.changed')],
  [`${A}mappers/antigravity.test.ts:96`, () => assert.equal(ev('antigravity/tool-arquivo').payload.path, 'C:\\repo\\file.ts')],
  [`${A}mappers/antigravity.test.ts:117`, () => assert.equal(ev('antigravity/result-sucesso').type, 'turn.completed')],
  [`${A}mappers/antigravity.test.ts:118`, () => assert.equal(ev('antigravity/result-sucesso').payload.summary, 'Tarefa concluída com sucesso.')],
  [`${A}mappers/antigravity.test.ts:119`, () => assert.equal(ev('antigravity/result-sucesso').nativeSessionId, 'conv-123')],
  [`${A}mappers/antigravity.test.ts:120`, () => assert.equal(ev('antigravity/result-sucesso').cost.inputTokens, 5000)],
  [`${A}mappers/antigravity.test.ts:121`, () => assert.equal(ev('antigravity/result-sucesso').cost.outputTokens, 200)],
  [`${A}mappers/antigravity.test.ts:136`, () => assert.equal(ev('antigravity/result-erro').type, 'error')],
  [`${A}mappers/antigravity.test.ts:137`, () => assert.equal(ev('antigravity/result-erro').payload.message, 'Quota esgotada')],
  [`${A}mappers/antigravity.test.ts:138`, () => assert.equal(ev('antigravity/result-erro').nativeSessionId, 'conv-123')],
  // ---- mappers/copilot.test.ts (Copilot e Kimi)
  [`${A}mappers/copilot.test.ts:17`, () => assert.equal(ev('copilot/auto-mode-resolved').payload.model, 'gpt-5-mini')],
  [`${A}mappers/copilot.test.ts:25`, () => assert.equal(ev('copilot/mensagem-com-output-tokens').type, 'message')],
  [`${A}mappers/copilot.test.ts:26`, () => assert.equal(ev('copilot/mensagem-com-output-tokens').payload.text, 'OK')],
  [`${A}mappers/copilot.test.ts:27`, () => assert.equal(ev('copilot/mensagem-com-output-tokens').cost.outputTokens, 159)],
  [`${A}mappers/copilot.test.ts:59`, () => assert.equal(ev('copilot/mensagem-1-0-88-sem-uso').type, 'message')],
  [`${A}mappers/copilot.test.ts:60`, () => assert.equal(ev('copilot/mensagem-1-0-88-sem-uso').cost, undefined)],
  [`${A}mappers/copilot.test.ts:73`, () => assert.equal(ev('copilot/usage-checkpoint-1-0-88').cost.credits, 0.37)],
  [`${A}mappers/copilot.test.ts:74`, () => assert.equal(ev('copilot/usage-checkpoint-1-0-88').cost.cumulative, true)],
  [`${A}mappers/copilot.test.ts:75`, () => assert.equal(ev('copilot/usage-checkpoint-1-0-88').cost.inputTokens, undefined)],
  [`${A}mappers/copilot.test.ts:76`, () => assert.equal(ev('copilot/usage-checkpoint-1-0-88').cost.outputTokens, undefined)],
  [`${A}mappers/copilot.test.ts:88`, () => assert.equal(caso('copilot/tool-request-shell').expected_events.find((e) => e.type === 'command.executed').payload.command, 'npm test')],
  [`${A}mappers/copilot.test.ts:98`, () => assert.equal(ev('copilot/result-sessao').type, 'turn.completed')],
  [`${A}mappers/copilot.test.ts:99`, () => assert.equal(ev('copilot/result-sessao').nativeSessionId, 'fea11bdf-462d-4a60-8709-fc40079aa830')],
  [`${A}mappers/copilot.test.ts:104`, () => assert.equal(ev('copilot/result-exit-1').type, 'error')],
  [`${A}mappers/copilot.test.ts:108`, () => assert.deepEqual(caso('copilot/efemero-descartado').expected_events, [])],
  [`${A}mappers/copilot.test.ts:115`, () => assert.deepEqual(caso('copilot/eco-do-prompt').expected_events, [])],
  [`${A}mappers/copilot.test.ts:120`, () => assert.equal(ev('copilot/tipo-desconhecido').type, 'log')],
  [`${A}mappers/copilot.test.ts:127`, () => assert.equal(ev('kimi/mensagem-ok').type, 'message')],
  [`${A}mappers/copilot.test.ts:128`, () => assert.equal(ev('kimi/mensagem-ok').payload.text, 'OK')],
  [`${A}mappers/copilot.test.ts:138`, () => assert.equal(ev('kimi/resume-hint-real').nativeSessionId, 'session_89f4617a-cb89-44b0-a58d-2e5cfa135b3e')],
  [`${A}mappers/copilot.test.ts:142`, () => assert.deepEqual(caso('kimi/eco-do-prompt').expected_events, [])],
  [`${A}mappers/copilot.test.ts:147`, () => assert.equal(ev('kimi/formato-antigo-tool').type, 'command.executed')],
  [`${A}mappers/copilot.test.ts:148`, () => assert.equal(ev('kimi/formato-antigo-tool').payload.command, 'ls')],
  [`${A}mappers/copilot.test.ts:153`, () => assert.equal(ev('kimi/role-desconhecido').type, 'log')],
  // ---- mappers/kimi.test.ts
  [`${A}mappers/kimi.test.ts:31`, () => ['supervised', 'semi', 'autonomous'].forEach((m) => ['oneShot', 'resume'].forEach((t) => ['-y', '--yolo', '--auto', '--plan'].forEach((p) => assert.ok(!args(`kimi/${t}-${m}-flags-proibidas`).includes(p)))))],
  [`${A}mappers/kimi.test.ts:49`, () => { const a = args('kimi/oneShot-supervised-flags-proibidas'); const i = a.indexOf('--agent'); assert.ok(i >= 0 && a[i + 1] === 'plan'); }],
  [`${A}mappers/kimi.test.ts:60`, () => assert.ok(args('kimi/resume-supervised-flags-proibidas').includes('--session'))],
  [`${A}mappers/kimi.test.ts:61`, () => assert.ok(!args('kimi/resume-supervised-flags-proibidas').includes('--agent'))],
  [`${A}mappers/kimi.test.ts:77`, () => assert.equal(ev('kimi/retentativa').type, 'log')],
  [`${A}mappers/kimi.test.ts:78`, () => assert.equal(ev('kimi/retentativa').payload.level, 'warn')],
  [`${A}mappers/kimi.test.ts:79`, () => assert.equal(ev('kimi/retentativa').payload.text, 'Kimi: tentativa 1/10 falhou (APIConnectionError: Connection error.); nova tentativa em 1s')],
  [`${A}mappers/kimi.test.ts:96`, () => assert.match(String(ev('kimi/ultima-retentativa').payload.text), /é a última$/)],
  [`${A}mappers/kimi.test.ts:101`, () => assert.equal(ev('kimi/system-version').payload.text, 'Kimi 2.0.0')],
  [`${A}mappers/kimi.test.ts:117`, () => assert.deepEqual(caso('kimi/assistant-com-tool-calls').expected_events.map((e) => e.type), ['message', 'command.executed', 'file.changed'])],
  [`${A}mappers/kimi.test.ts:121`, () => assert.equal(ev('kimi/assistant-com-tool-calls', 1).payload.command, 'npm test')],
  [`${A}mappers/kimi.test.ts:122`, () => assert.equal(ev('kimi/assistant-com-tool-calls', 2).payload.path, 'src/a.ts')],
  [`${A}mappers/kimi.test.ts:132`, () => assert.deepEqual(caso('kimi/assistant-so-tool-calls').expected_events.map((e) => e.type), ['tool.call'])],
  [`${A}mappers/kimi.test.ts:140`, () => assert.equal(ev('kimi/tool-resultado-2-0-0').type, 'tool.result')],
  [`${A}mappers/kimi.test.ts:141`, () => assert.equal(ev('kimi/tool-resultado-2-0-0').payload.callId, 't1')],
  [`${A}mappers/kimi.test.ts:152`, () => assert.equal(ev('kimi/resume-hint').nativeSessionId, 'session_abc')],
  [`${A}mappers/kimi.test.ts:157`, () => assert.equal(ev('kimi/formato-antigo-tool').type, 'command.executed')],
  // ---- mappers/generic.test.ts
  [`${A}mappers/generic.test.ts:23`, () => assert.equal(ev('generic-json/step-start-com-sessao').nativeSessionId, 'ses_mimo123')],
  [`${A}mappers/generic.test.ts:32`, () => assert.equal(ev('generic-json/texto-em-part').type, 'message')],
  [`${A}mappers/generic.test.ts:33`, () => assert.equal(ev('generic-json/texto-em-part').payload.text, 'pronto')],
  [`${A}mappers/generic.test.ts:47`, () => assert.deepEqual(ev('generic-json/step-finish-custo').cost, { usd: 0.0123, inputTokens: 1200, outputTokens: 340, cachedTokens: 810 })],
  [`${A}mappers/generic.test.ts:48`, () => assert.equal(ev('generic-json/step-finish-custo').nativeSessionId, 'ses_mimo123')],
  [`${A}mappers/generic.test.ts:61`, () => assert.equal(ev('generic-json/tool-use-shell').type, 'command.executed')],
  [`${A}mappers/generic.test.ts:62`, () => assert.equal(ev('generic-json/tool-use-shell').payload.command, 'git push')],
  [`${A}mappers/generic.test.ts:75`, () => assert.equal(ev('generic-json/tool-use-escrita').type, 'file.changed')],
  [`${A}mappers/generic.test.ts:76`, () => assert.equal(ev('generic-json/tool-use-escrita').payload.path, 'src/a.ts')],
  [`${A}mappers/generic.test.ts:85`, () => assert.equal(ev('generic-json/error-data-message').type, 'error')],
  [`${A}mappers/generic.test.ts:86`, () => assert.equal(ev('generic-json/error-data-message').payload.message, 'modelo inválido')],
  [`${A}mappers/generic.test.ts:97`, () => assert.equal(ev('generic-json/cursor-message-content').type, 'message')],
  [`${A}mappers/generic.test.ts:98`, () => assert.equal(ev('generic-json/cursor-message-content').payload.text, 'oi')],
  [`${A}mappers/generic.test.ts:99`, () => assert.equal(ev('generic-json/cursor-message-content').nativeSessionId, 'c-1')],
  [`${A}mappers/generic.test.ts:108`, () => assert.deepEqual(ev('generic-json/cursor-usage-no-topo').cost, { inputTokens: 10, outputTokens: 5 })],
  // ---- opencode/events.test.ts
  [`${A}opencode/events.test.ts:15`, () => assert.equal(caso('opencode-sse/dois-eventos-num-bloco').expected_decoded.length, 2)],
  [`${A}opencode/events.test.ts:23`, () => assert.equal(caso('opencode-sse/evento-partido').expected_decoded.length, 1)],
  [`${A}opencode/events.test.ts:24`, () => assert.equal(caso('opencode-sse/evento-partido').expected_decoded[0].type, 'session.idle')],
  [`${A}opencode/events.test.ts:28`, () => assert.deepEqual(caso('opencode-sse/comentario-heartbeat').expected_decoded, [])],
  [`${A}opencode/events.test.ts:34`, () => assert.equal(caso('opencode-sse/json-invalido-nao-derruba').expected_decoded.length, 1)],
  [`${A}opencode/events.test.ts:41`, () => assert.equal(ev('opencode-sse/session-created').type, 'session.started')],
  [`${A}opencode/events.test.ts:42`, () => assert.equal(ev('opencode-sse/session-created').nativeSessionId, 'ses_abc123')],
  [`${A}opencode/events.test.ts:47`, () => assert.equal(ev('opencode-sse/text-ended').type, 'message')],
  [`${A}opencode/events.test.ts:48`, () => assert.equal(ev('opencode-sse/text-ended').payload.text, 'terminei')],
  [`${A}opencode/events.test.ts:63`, () => assert.equal(ev('opencode-sse/step-ended-custo', 1).type, 'log')],
  [`${A}opencode/events.test.ts:64`, () => assert.equal(ev('opencode-sse/step-ended-custo', 1).payload.kind, 'tecnico')],
  [`${A}opencode/events.test.ts:65`, () => assert.equal(ev('opencode-sse/step-ended-custo', 1).cost.usd, 0.0123)],
  [`${A}opencode/events.test.ts:66`, () => assert.equal(ev('opencode-sse/step-ended-custo', 1).cost.inputTokens, 1200)],
  [`${A}opencode/events.test.ts:67`, () => assert.equal(ev('opencode-sse/step-ended-custo', 1).cost.outputTokens, 400)],
  [`${A}opencode/events.test.ts:72`, () => assert.equal(ev('opencode-sse/step-ended-custo', 1).cost.cachedTokens, 800)],
  [`${A}opencode/events.test.ts:80`, () => assert.equal(caso('opencode-sse/step-ended-arquivos').expected_events.filter((e) => e.type === 'file.changed').length, 2)],
  [`${A}opencode/events.test.ts:81`, () => assert.equal(ev('opencode-sse/step-ended-arquivos').payload.path, 'src/a.ts')],
  [`${A}opencode/events.test.ts:88`, () => assert.equal(ev('opencode-sse/shell-started').type, 'command.executed')],
  [`${A}opencode/events.test.ts:89`, () => assert.equal(ev('opencode-sse/shell-started').payload.command, 'npm test')],
  [`${A}opencode/events.test.ts:96`, () => assert.equal(ev('opencode-sse/step-failed').type, 'error')],
  [`${A}opencode/events.test.ts:97`, () => assert.equal(ev('opencode-sse/step-failed').payload.message, 'modelo não suportado')],
  [`${A}opencode/events.test.ts:102`, () => assert.equal(ev('opencode-sse/desconhecido-de-sessao').type, 'log')],
  [`${A}opencode/events.test.ts:103`, () => assert.equal(ev('opencode-sse/desconhecido-de-sessao').payload.opencodeType, 'session.next.algo.novo')],
  [`${A}opencode/events.test.ts:107`, () => assert.deepEqual(caso('opencode-sse/ruido-global-sem-sessao').expected_per_decoded[0].events, [])],
  [`${A}opencode/events.test.ts:115`, () => assert.deepEqual(caso('opencode-sse/file-edited').expected_per_decoded[0].events, [])],
  [`${A}opencode/events.test.ts:124`, () => caso('opencode-sse/prompt-ecoado').expected_per_decoded.forEach((p) => assert.deepEqual(p.events, []))],
  [`${A}opencode/events.test.ts:141`, () => caso('opencode-sse/ruido-descartado').expected_per_decoded.slice(0, 6).forEach((p) => assert.deepEqual(p.events, []))],
  [`${A}opencode/events.test.ts:143`, () => assert.deepEqual(caso('opencode-sse/ruido-descartado').expected_per_decoded[6].events, [])],
  [`${A}opencode/events.test.ts:148`, () => assert.equal(ev('opencode-sse/log-texto-curto').payload.text, 'OpenCode: todo.updated')],
  [`${A}opencode/events.test.ts:155`, () => assert.deepEqual(caso('opencode-sse/permissao-v2').expected_events.map((m) => m.type), ['log'])],
  [`${A}opencode/events.test.ts:159`, () => assert.match(String(ev('opencode-sse/permissao-v2').payload.text), /bash git push — recusado pelo Hub/)],
  [`${A}opencode/events.test.ts:171`, () => assert.equal(caso('opencode-sse/idle').expected_per_decoded[0].idle_signal, true)],
  [`${A}opencode/events.test.ts:175`, () => assert.equal(caso('opencode-sse/status-idle').expected_per_decoded[0].idle_signal, true)],
  [`${A}opencode/events.test.ts:179`, () => assert.equal(caso('opencode-sse/status-retry').expected_per_decoded[0].idle_signal, false)],
  [`${A}opencode/events.test.ts:185`, () => assert.equal(caso('opencode-sse/idle').expected_per_decoded[0].session_id, 'ses_abc123')],
  [`${A}opencode/events.test.ts:189`, () => assert.equal(caso('opencode-sse/evento-global').expected_per_decoded[0].session_id, null)],
  // ---- prompt-delivery.test.ts
  [`${A}prompt-delivery.test.ts:63`, () => Object.values(C).filter((r) => r.id.endsWith('-prompt-marcador') && r.expected).forEach((r) => assert.notEqual(r.expected.entrega, 'nenhuma', r.id))],
  [`${A}prompt-delivery.test.ts:71`, () => Object.values(C).filter((r) => r.id.endsWith('-prompt-marcador') && r.expected?.entrega === 'argv').forEach((r) => assert.equal(r.expected.args.filter((a) => a.includes(r.scenario.prompt)).length, 1, r.id))],
  [`${A}prompt-delivery.test.ts:78`, () => Object.values(C).filter((r) => r.id.endsWith('-prompt-marcador') && r.expected && r.expected.entrega !== 'argv').forEach((r) => assert.ok(r.expected.args.every((a) => !a.includes(r.scenario.prompt)), r.id))],
  [`${A}prompt-delivery.test.ts:84`, () => Object.values(C).filter((r) => r.id.endsWith('/resume-prompt-marcador')).forEach((r) => assert.ok(r.expected.args.includes('sess-nativa-1'), r.id))],
  [`${A}prompt-delivery.test.ts:95`, () => assert.equal(fr('antigravity/oneShot-diga-oi').entrega, 'argv')],
  [`${A}prompt-delivery.test.ts:96`, () => assert.deepEqual(args('antigravity/oneShot-diga-oi'), ['--output-format', 'stream-json', '-p=diga oi', '--mode', 'plan'])],
  [`${A}prompt-delivery.test.ts:101`, () => assert.deepEqual(args('antigravity/resume-continue'), ['--conversation', 'conv-123', '--output-format', 'stream-json', '-p=continue', '--mode', 'plan'])],
  [`${A}prompt-delivery.test.ts:115`, () => { const a = args('antigravity/oneShot-semi-x'); assert.equal(a[a.indexOf('--output-format') + 1], 'stream-json'); }],
  [`${A}prompt-delivery.test.ts:116`, () => assert.ok(!args('antigravity/oneShot-semi-x').includes('-p'))],
  [`${A}prompt-delivery.test.ts:121`, () => assert.ok(args('antigravity/oneShot-prompt-com-hifen').includes('-p=--help me'))],
  [`${A}prompt-delivery.test.ts:128`, () => assert.equal(fr('mimo/oneShot-stdin').entrega, 'stdin')],
  [`${A}prompt-delivery.test.ts:129`, () => assert.deepEqual(args('mimo/oneShot-stdin'), ['run', '--format', 'json'])],
  [`${A}prompt-delivery.test.ts:144`, () => ['oneShot', 'resume'].forEach((t) => assert.ok(args(`codex/${t}-skip-git-repo-check`).includes('--skip-git-repo-check')))],
  // ---- gate-settings.test.ts
  [`${A}gate-settings.test.ts:34`, () => ['claude', 'openclaude'].forEach((id) => ['oneShot', 'resume'].forEach((t) => assert.notEqual(args(`${id}/${t}-settings`).indexOf('--settings'), -1)))],
  [`${A}gate-settings.test.ts:35`, () => ['claude', 'openclaude'].forEach((id) => ['oneShot', 'resume'].forEach((t) => { const a = args(`${id}/${t}-settings`); assert.equal(a[a.indexOf('--settings') + 1], 'C:\\hub\\run\\ses_abc-settings.json'); }))],
  [`${A}gate-settings.test.ts:47`, () => ['claude', 'openclaude'].forEach((id) => assert.equal(args(`${id}/oneShot-sem-settings`).includes('--settings'), false))],
  [`${A}gate-settings.test.ts:48`, () => ['claude', 'openclaude'].forEach((id) => assert.ok(args(`${id}/oneShot-sem-settings`).every((a) => !a.includes('{{'))))],
  // ---- manifest-model.test.ts
  [`${A}manifest-model.test.ts:31`, () => assert.deepEqual(Object.values(C).filter((r) => r.id.startsWith('manifest/') && r.expected.data.model.supported).map((r) => r.expected.data.id).sort(), ['antigravity', 'claude', 'codex', 'copilot', 'kimi', 'mimo', 'openclaude', 'opencode'])],
  [`${A}manifest-model.test.ts:54`, () => Object.values(C).filter((r) => /\/(oneShot|resume)-modelo-de-teste$/.test(r.id) && r.manifest !== 'cursor').forEach((r) => assert.ok(r.expected.args.indexOf('modelo-de-teste/v1.2') > 0, r.id))],
  [`${A}manifest-model.test.ts:57`, () => Object.values(C).filter((r) => /\/(oneShot|resume)-modelo-de-teste$/.test(r.id) && r.manifest !== 'cursor').forEach((r) => { const m = caso(`manifest/${r.manifest}`).expected.data.model.args; const a = r.expected.args; assert.equal(a[a.indexOf('modelo-de-teste/v1.2') - 1], m[m.indexOf('{{model}}') - 1], r.id); })],
  [`${A}manifest-model.test.ts:74`, () => Object.values(C).filter((r) => /\/(oneShot|resume)-sem-modelo$/.test(r.id)).forEach((r) => caso(`manifest/${r.manifest}`).expected.data.model.args.filter((a) => !a.includes('{{model}}')).forEach((f) => assert.ok(!r.expected.args.includes(f), r.id)))],
  [`${A}manifest-model.test.ts:94`, () => assert.ok(!args('cursor/modelo-ignorado').includes('modelo-de-teste/v1.2'))],
  [`${A}manifest-model.test.ts:108`, () => { const a = args('claude/modelo-pelo-env'); assert.deepEqual(a.slice(a.indexOf('--model'), a.indexOf('--model') + 2), ['--model', 'sonnet']); }],
  [`${A}manifest-model.test.ts:120`, () => { const a = args('claude/modelo-explicito-ganha-do-env'); assert.ok(a.includes('opus') && !a.includes('sonnet')); }],
  [`${A}manifest-model.test.ts:127`, () => [1, 2, 3, 4].forEach((i) => assert.match(caso(`claude/modelo-invalido-${i}`).expected_error.message, /Modelo inválido/))],
  [`${A}manifest-model.test.ts:144`, () => assert.equal(caso('schema/minimo-defaults').expected.data.model.supported, false)],
  [`${A}manifest-model.test.ts:145`, () => assert.equal(caso('schema/minimo-defaults').expected.data.verified.status, 'unverified')],
  [`${A}manifest-model.test.ts:146`, () => assert.equal(caso('schema/model-supported-sem-placeholder').expected.success, false)],
  [`${A}manifest-model.test.ts:150`, () => assert.equal(caso('schema/model-args-sem-suporte').expected.success, false)],
  [`${A}manifest-model.test.ts:169`, () => Object.values(C).filter((r) => r.id.startsWith('manifest/')).forEach((r) => assert.match(r.expected.data.verified.date, /^\d{4}-\d{2}-\d{2}$/))],
  [`${A}manifest-model.test.ts:171`, () => { const d = caso('manifest/cursor').expected.data.verified; assert.equal(d.status, 'unverified'); assert.equal(d.version, null); }],
  [`${A}manifest-model.test.ts:176`, () => { const esperado = { antigravity: '1.2.10', claude: '2.1.283', codex: '0.155.0', copilot: '1.0.88', kimi: '2.0.0', mimo: '0.1.14', openclaude: '0.14.0', opencode: '1.18.32' }; for (const [id, v] of Object.entries(esperado)) { const d = caso(`manifest/${id}`).expected.data.verified; assert.notEqual(d.status, 'unverified'); assert.equal(d.version, v); } }],
];

let ok = 0;
const falhas = [];
for (const [ref, fn] of CHECKS) {
  try {
    fn();
    ok += 1;
  } catch (err) {
    falhas.push(`FALHOU ${ref}: ${err.message}`);
  }
}
for (const f of falhas) console.log(f);
const arquivos = new Set(CHECKS.map(([r]) => r.split(':')[0]));
console.log(`${ok}/${CHECKS.length} asserts dos testes TS conferidos contra o corpus (${arquivos.size} arquivos de teste)`);
process.exit(falhas.length > 0 ? 1 : 0);
