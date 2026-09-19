import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { clearBinCache } from './bin-resolver.js';
import {
  ProcessAgentAdapter,
  QUEUE_HARD_CAP,
  QUEUE_HIGH_WATER_MARK,
  QUEUE_LOW_WATER_MARK,
} from './process-adapter.js';
import { AsyncQueue } from './async-queue.js';
import { AgentManifestSchema } from './types.js';
import type { MappedEvent } from './types.js';

/**
 * Teste de carga da Fase 5 (AsyncQueue com watermarks): um "agente falso" que
 * imprime milhares de linhas sem nenhum atraso — o cenário exato em que a
 * fila entre `process-adapter.ts` e o `#pump` do daemon crescia sem teto
 * algum antes desta mudança, porque o consumidor faz uma escrita SQLite
 * síncrona por evento e não tem como acompanhar um produtor tão rápido.
 *
 * Roda de verdade nesta máquina Windows — não é só teste com binário falso —
 * porque `child.stdout.pause()/resume()` sobre pipes tem histórico de
 * comportamento inconsistente entre plataformas no Node.
 *
 * **Achado real rodando aqui** (documentado também no roadmap): um `write()`
 * ÚNICO e gigante do processo filho (todo o conteúdo já pronto, sem yield
 * nenhum antes de escrever) entrega ao `readline` do pai uma sequência de
 * linhas rápida demais para o `pause()` interromper a tempo — os `data`
 * chunks já estavam enfileirados no event loop antes da pausa surtir efeito.
 * Nesse caso o TETO DURO (`QUEUE_HARD_CAP`) é quem segura a fila, não o
 * `pause()`/`resume()` sozinho — exatamente por isso o plano pediu os dois
 * mecanismos, não só o `pause()`. Já um produtor que escreve em lotes menores
 * ao longo de várias voltas do event loop (mais perto de como um CLI de
 * agente real fala) é seguro pelo `pause()`/`resume()` sem nunca chegar perto
 * do teto duro — segundo teste abaixo.
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

/** Despeja `n` linhas de uma vez só, num único `write()` — o pior burst possível. */
function scriptDeDespejoUnico(n: number): string {
  return (
    `const n=${n};` +
    'let out="";' +
    'for (let i = 0; i < n; i++) { out += "linha " + i + "\\n"; }' +
    'process.stdout.write(out, () => process.exit(0));'
  );
}

/**
 * Escreve `n` linhas em lotes de `batch`, com um `setTimeout(delayMs)`
 * real entre lotes — mais perto de como um CLI de agente de verdade fala aos
 * poucos (um passo do modelo, uma chamada de ferramenta) do que um
 * `setImmediate` "yield só de nome", que na prática ainda esgota a fila numa
 * fração de segundo e nunca dá ao `pause()` uma folga de verdade.
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

function manifestDoAgenteFalso() {
  return AgentManifestSchema.parse({
    id: 'fake-fast-agent',
    name: 'Fake Fast Agent',
    bin: 'node',
    invoke: { oneShot: ['-e', '{{prompt}}'] },
  });
}

test(
  'despejo único e gigante: o teto duro protege a fila quando o pause() sozinho chega tarde',
  { timeout: 60_000 },
  async () => {
    const N = 20_000;
    const adapter = new ProcessAgentAdapter(manifestDoAgenteFalso());

    const handle = await adapter.start(
      {
        sessionId: 'ses-hardcap-burst-teste',
        taskId: null,
        agentId: 'fake-fast-agent',
        workdir: process.cwd(),
        mode: 'autonomous',
        env: {},
        timeoutSeconds: 55,
        heartbeatSeconds: 10,
      },
      scriptDeDespejoUnico(N),
    );

    const queue = handle.events as AsyncQueue<MappedEvent>;

    let maxPending = 0;
    const amostrador = setInterval(() => {
      if (queue.pending > maxPending) maxPending = queue.pending;
    }, 2);
    amostrador.unref?.();

    let recebidos = 0;
    for await (const _evento of queue) {
      recebidos += 1;
      if (recebidos % 50 === 0) await sleep(1);
    }
    clearInterval(amostrador);

    const outcome = await handle.done;

    console.log(
      `[hard-cap/burst-único] N=${N} recebidos=${recebidos} maxPending=${maxPending} ` +
        `(HIGH=${QUEUE_HIGH_WATER_MARK} LOW=${QUEUE_LOW_WATER_MARK} HARD_CAP=${QUEUE_HARD_CAP}) ` +
        `outcome=${outcome.reason} erro=${outcome.error ?? ''}`,
    );

    // Invariante que NUNCA pode falhar, venha o desfecho que vier: a fila é
    // checada a cada push individual, então não existe jeito de ultrapassar
    // o teto — o pior caso é parar exatamente nele.
    assert.ok(
      maxPending <= QUEUE_HARD_CAP,
      `pending chegou a ${maxPending}, acima do teto duro ${QUEUE_HARD_CAP}`,
    );

    if (outcome.reason === 'exit') {
      assert.equal(recebidos, N, 'se terminou por exit, zero evento pode ter se perdido');
    } else {
      // Achado real desta máquina: um despejo instantâneo e único é rápido
      // demais para o pause() reagir a tempo — o teto duro encerra a run em
      // vez de deixar a fila crescer sem limite. Perder o restante da run é
      // o preço aceito por não estourar a memória; documentado no roadmap.
      assert.equal(outcome.reason, 'error');
      assert.match(
        outcome.error ?? '',
        /satur/i,
        'quando o teto duro dispara, a mensagem precisa dizer que foi por saturação da fila',
      );
      assert.ok(recebidos <= N, 'não pode ter "recebido" mais do que o agente produziu');
    }
  },
);

test(
  'produtor que escreve em lotes (mais perto de um CLI real): backpressure sozinho basta, zero perda, nunca chega perto do teto duro',
  { timeout: 60_000 },
  async () => {
    const N = 3_000;
    const adapter = new ProcessAgentAdapter(manifestDoAgenteFalso());

    const handle = await adapter.start(
      {
        sessionId: 'ses-backpressure-lotes-teste',
        taskId: null,
        agentId: 'fake-fast-agent',
        workdir: process.cwd(),
        mode: 'autonomous',
        env: {},
        timeoutSeconds: 55,
        heartbeatSeconds: 10,
      },
      scriptDeEscritaEmLotes(N, 5, 5),
    );

    const queue = handle.events as AsyncQueue<MappedEvent>;

    let maxPending = 0;
    const amostrador = setInterval(() => {
      if (queue.pending > maxPending) maxPending = queue.pending;
    }, 2);
    amostrador.unref?.();

    let recebidos = 0;
    for await (const _evento of queue) {
      recebidos += 1;
      if (recebidos % 50 === 0) await sleep(1);
    }
    clearInterval(amostrador);

    const outcome = await handle.done;

    console.log(
      `[backpressure/lotes] N=${N} recebidos=${recebidos} maxPending=${maxPending} ` +
        `(HIGH=${QUEUE_HIGH_WATER_MARK} LOW=${QUEUE_LOW_WATER_MARK} HARD_CAP=${QUEUE_HARD_CAP}) ` +
        `outcome=${outcome.reason}`,
    );

    assert.equal(
      outcome.reason,
      'exit',
      `a run devia terminar normalmente, não por ${outcome.reason} (${outcome.error ?? ''})`,
    );
    assert.equal(recebidos, N, 'zero perda de eventos');
    assert.ok(
      maxPending < QUEUE_HARD_CAP,
      `pending chegou a ${maxPending} — o backpressure devia ter segurado bem antes do teto duro (${QUEUE_HARD_CAP})`,
    );
  },
);

test(
  'consumidor nunca lê da fila: o teto duro encerra a run com reason "error" em vez de crescer sem limite',
  { timeout: 60_000 },
  async () => {
    const N = 200_000;
    const adapter = new ProcessAgentAdapter(manifestDoAgenteFalso());

    const handle = await adapter.start(
      {
        sessionId: 'ses-hardcap-nunca-le-teste',
        taskId: null,
        agentId: 'fake-fast-agent',
        workdir: process.cwd(),
        mode: 'autonomous',
        env: {},
        timeoutSeconds: 55,
        heartbeatSeconds: 10,
      },
      scriptDeDespejoUnico(N),
    );

    const queue = handle.events as AsyncQueue<MappedEvent>;

    // De propósito: NUNCA itera `handle.events`. É o pior caso — o
    // consumidor travou de vez — que só o teto duro consegue segurar.
    const outcome = await handle.done;

    console.log(
      `[hard-cap/sem-consumidor] N=${N} pendingNoFim=${queue.pending} outcome=${outcome.reason} erro=${outcome.error ?? ''}`,
    );

    assert.ok(
      queue.pending <= QUEUE_HARD_CAP,
      `pending terminou em ${queue.pending}, acima do teto duro ${QUEUE_HARD_CAP} — a rede de segurança falhou`,
    );
    assert.equal(outcome.reason, 'error', 'sem ninguém consumindo, o teto duro tem que disparar');
    assert.match(
      outcome.error ?? '',
      /satur/i,
      'a mensagem de erro precisa dizer que foi saturação da fila de eventos',
    );
  },
);

test(
  'consumidor muito mais lento que heartbeatSeconds: a pausa por backpressure não derruba a run como falso "travada"',
  { timeout: 90_000 },
  async () => {
    const N = 2_500;
    const adapter = new ProcessAgentAdapter(manifestDoAgenteFalso());

    // heartbeatSeconds propositalmente curto: se o `touch()` só acontecesse
    // nas bordas da pausa (e não continuamente durante ela), drenar da marca
    // alta até a baixa — que com este delay por item leva vários segundos —
    // estouraria o heartbeat no meio de uma pausa saudável.
    const heartbeatSeconds = 1;

    const handle = await adapter.start(
      {
        sessionId: 'ses-heartbeat-backpressure-teste',
        taskId: null,
        agentId: 'fake-fast-agent',
        workdir: process.cwd(),
        mode: 'autonomous',
        env: {},
        timeoutSeconds: 85,
        heartbeatSeconds,
      },
      scriptDeDespejoUnico(N),
    );

    const queue = handle.events as AsyncQueue<MappedEvent>;

    let recebidos = 0;
    const inicio = Date.now();
    for await (const _evento of queue) {
      recebidos += 1;
      await sleep(3);
    }
    const duracaoMs = Date.now() - inicio;

    const outcome = await handle.done;

    console.log(
      `[heartbeat/backpressure] N=${N} recebidos=${recebidos} duracaoMs=${duracaoMs} ` +
        `heartbeatSeconds=${heartbeatSeconds} outcome=${outcome.reason}`,
    );

    assert.ok(
      duracaoMs > heartbeatSeconds * 1000 * 2,
      'o teste não fez sentido: o consumo terminou rápido demais para provar algo sobre heartbeat',
    );
    assert.equal(
      outcome.reason,
      'exit',
      `a run não podia terminar por heartbeat durante uma pausa saudável (motivo real: ${outcome.reason} — ${outcome.error ?? ''})`,
    );
    assert.equal(recebidos, N, 'zero perda também neste cenário');
  },
);
