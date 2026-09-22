import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { clearBinCache } from './bin-resolver.js';
import { ProcessAgentAdapter } from './process-adapter.js';
import { AsyncQueue } from './async-queue.js';
import { AgentManifestSchema } from './types.js';
import type { MappedEvent } from './types.js';

/**
 * Achado (MÉDIO) da auditoria de carga: o timeout GERAL do run
 * (`ctx.timeoutSeconds`) era armado uma única vez no spawn e nunca
 * reconsiderado — diferente do heartbeat, que já é rearmado por
 * `handle.touch()` a cada sinal de atividade (linha processada, ou o
 * `backpressureKeepAlive` batendo enquanto `child.stdout` está pausado por
 * backpressure).
 *
 * Medido de verdade contra o daemon real: um agente emitindo 50.000 linhas
 * sem delay é processado pelo consumidor síncrono (SQLite, um `write` por
 * evento) a ~41 eventos/s — bem abaixo da taxa de produção. Antes desta
 * correção, isso fazia o timeout geral disparar mesmo com o agente
 * plenamente vivo e progredindo, classificando a run como `timeout` →
 * `transient`, e a resiliência reprocessava do zero com o MESMO agente —
 * fadado a repetir o mesmo timeout em toda tentativa, porque o gargalo é a
 * taxa de escrita do daemon, não a tentativa em si.
 *
 * Estes testes rodam contra um processo `node` real (mesmo padrão de
 * `process-adapter.backpressure.test.ts`), não mocks.
 */

before(() => {
  clearBinCache();
});

after(() => {
  clearBinCache();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Escreve `n` linhas em lotes de `batch`, com um `setTimeout(delayMs)` real
 * entre lotes — produtor "vivo e devagar", mais perto de como um CLI de
 * agente real fala aos poucos.
 */
function scriptDeEscritaEmLotes(n: number, batch: number, delayMs: number): string {
  return (
    `const n=${n}, batch=${batch}, delayMs=${delayMs};` +
    'let i = 0;' +
    'function proximoLote() {' +
    '  let out = "";' +
    '  const fim = Math.min(i + batch, n);' +
    '  for (; i < fim; i++) out += "linha " + i + "\\n";' +
    '  process.stdout.write(out);' +
    '  if (i < n) setTimeout(proximoLote, delayMs);' +
    '  else process.exit(0);' +
    '}' +
    'proximoLote();'
  );
}

/** Nunca escreve nada em stdout e nunca sai — o agente "travado de verdade". */
function scriptQueTrava(): string {
  return 'setInterval(() => {}, 1000);';
}

function manifestDoAgenteFalso() {
  return AgentManifestSchema.parse({
    id: 'fake-fast-agent',
    name: 'Fake Fast Agent',
    bin: 'node',
    invoke: { oneShot: ['-e', '{{prompt}}'] },
  });
}

test(
  'agente vivo mas devagar (consumo mais lento que a produção): timeout geral não dispara enquanto há atividade sustentada',
  { timeout: 60_000 },
  async () => {
    const N = 400;
    const timeoutSeconds = 2; // teto geral propositalmente MENOR que a duração real da run
    const heartbeatSeconds = 30; // grande o bastante para não ser quem resolve o teste

    const adapter = new ProcessAgentAdapter(manifestDoAgenteFalso());

    const handle = await adapter.start(
      {
        sessionId: 'ses-overall-timeout-atividade-sustentada',
        taskId: null,
        agentId: 'fake-fast-agent',
        workdir: process.cwd(),
        mode: 'autonomous',
        env: {},
        timeoutSeconds,
        heartbeatSeconds,
      },
      // Lotes pequenos e frequentes o bastante para gerar atividade contínua
      // (cada linha chama handle.touch()) durante bem mais tempo que
      // `timeoutSeconds`.
      scriptDeEscritaEmLotes(N, 2, 30),
    );

    const queue = handle.events as AsyncQueue<MappedEvent>;

    let recebidos = 0;
    const inicio = Date.now();
    for await (const _evento of queue) {
      recebidos += 1;
    }
    const duracaoMs = Date.now() - inicio;

    const outcome = await handle.done;

    console.log(
      `[overall-timeout/atividade-sustentada] N=${N} recebidos=${recebidos} duracaoMs=${duracaoMs} ` +
        `timeoutSeconds=${timeoutSeconds} outcome=${outcome.reason} erro=${outcome.error ?? ''}`,
    );

    assert.ok(
      duracaoMs > timeoutSeconds * 1000 * 2,
      'o teste não fez sentido: a run terminou rápido demais para provar algo sobre o teto geral',
    );
    assert.equal(
      outcome.reason,
      'exit',
      `a run não podia terminar por timeout geral com atividade sustentada (motivo real: ${outcome.reason} — ${outcome.error ?? ''})`,
    );
    assert.equal(recebidos, N, 'zero perda de eventos');
  },
);

test(
  'agente travado de verdade (zero atividade): o timeout geral ainda dispara e encerra a run',
  { timeout: 30_000 },
  async () => {
    const timeoutSeconds = 2;
    const heartbeatSeconds = 30; // maior que timeoutSeconds: se o heartbeat resolvesse o teste, provaria a coisa errada

    const adapter = new ProcessAgentAdapter(manifestDoAgenteFalso());

    const handle = await adapter.start(
      {
        sessionId: 'ses-overall-timeout-travado-de-verdade',
        taskId: null,
        agentId: 'fake-fast-agent',
        workdir: process.cwd(),
        mode: 'autonomous',
        env: {},
        timeoutSeconds,
        heartbeatSeconds,
      },
      scriptQueTrava(),
    );

    const inicio = Date.now();
    const outcome = await handle.done;
    const duracaoMs = Date.now() - inicio;

    console.log(
      `[overall-timeout/travado] duracaoMs=${duracaoMs} timeoutSeconds=${timeoutSeconds} ` +
        `outcome=${outcome.reason} erro=${outcome.error ?? ''}`,
    );

    assert.equal(
      outcome.reason,
      'timeout',
      'sem NENHUMA atividade, o teto geral precisa disparar — ele não pode ter sido eliminado',
    );
    assert.ok(
      duracaoMs < heartbeatSeconds * 1000,
      'a run terminou pelo teto geral, não podia ter esperado o heartbeat (bem maior) para resolver',
    );
    assert.ok(
      duracaoMs >= timeoutSeconds * 1000 - 200,
      'o teto geral não pode disparar bem antes do tempo configurado',
    );
  },
);
