import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DEFAULT_POLICY,
  execFieldsDeclared,
  mergePolicyLayer,
  withoutExecFields,
  type PartialPolicyDocument,
  type PolicyDocument,
} from './policy.js';

/**
 * `mergePolicyLayer({ clampToBase: true })` — a garantia "config de projeto só
 * aperta" (achado ALTO da vistoria 2026-09-25, item 0.7 do GOAL).
 *
 * Antes desta correção, orçamento, timeouts, retries e `fallback` fundiam
 * livres mesmo sob clamp: um `.agents-hub/config.yaml` de repo clonado
 * conseguia AUMENTAR o orçamento e os tempos. E `validation.command` do repo
 * valia sempre que a global não tinha um — execução de código ao clonar.
 */

const clamp = (layer: PartialPolicyDocument, trustExecFields = false): PolicyDocument =>
  mergePolicyLayer(DEFAULT_POLICY, layer, { clampToBase: true, trustExecFields });

/** Lê um campo numérico por caminho pontuado ("defaultBudget.usd"). */
function ler(doc: unknown, caminho: string): number {
  return caminho.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], doc) as number;
}

/** Monta uma camada parcial com um único campo numérico no caminho dado. */
function camada(caminho: string, valor: number): PartialPolicyDocument {
  const partes = caminho.split('.');
  const raiz: Record<string, unknown> = {};
  let atual = raiz;
  for (const parte of partes.slice(0, -1)) {
    atual[parte] = {};
    atual = atual[parte] as Record<string, unknown>;
  }
  atual[partes[partes.length - 1]!] = valor;
  return raiz as PartialPolicyDocument;
}

/** TODO campo numérico do `PolicyDocument` — tabela da regra min(base, camada). */
const CAMPOS_NUMERICOS = [
  'maxDepth',
  'maxConcurrency',
  'maxConcurrencyPerAgent',
  'taskTimeoutSeconds',
  'sessionTimeoutSeconds',
  'heartbeatTimeoutSeconds',
  'defaultBudget.usd',
  'defaultBudget.tokens',
  'defaultBudget.seconds',
  'retries.max',
  'retries.backoffMs',
  'validation.commandTimeoutSeconds',
] as const;

describe('mergePolicyLayer com clampToBase — tabela campo a campo', () => {
  test('a tabela cobre todo campo numérico do PolicyDocument', () => {
    // Se alguém acrescentar um número em `PolicyDocument`, este teste obriga a
    // decidir a regra do clamp para ele (e a pô-lo na tabela acima).
    const numericos: string[] = [];
    const varrer = (o: Record<string, unknown>, prefixo: string): void => {
      for (const [k, v] of Object.entries(o)) {
        const caminho = prefixo ? `${prefixo}.${k}` : k;
        if (typeof v === 'number') numericos.push(caminho);
        else if (v && typeof v === 'object' && !Array.isArray(v) && k !== 'fallback' && k !== 'risk') {
          varrer(v as Record<string, unknown>, caminho);
        }
      }
    };
    varrer(DEFAULT_POLICY as unknown as Record<string, unknown>, '');
    assert.deepEqual([...numericos].sort(), [...CAMPOS_NUMERICOS].sort());
  });

  for (const campo of CAMPOS_NUMERICOS) {
    test(`${campo}: override MAIOR que a base é clampado à base`, () => {
      const base = ler(DEFAULT_POLICY, campo);
      const merged = clamp(camada(campo, base * 10 + 1));
      assert.equal(ler(merged, campo), base, `${campo} não pode subir por config de projeto`);
    });

    test(`${campo}: override MENOR que a base passa`, () => {
      const base = ler(DEFAULT_POLICY, campo);
      const menor = Math.floor(base / 2);
      const merged = clamp(camada(campo, menor));
      assert.equal(ler(merged, campo), menor);
    });
  }

  test('risk: não afrouxa, só aperta', () => {
    const merged = clamp({ risk: { irreversible: 'allow', write: 'deny' } });
    assert.equal(merged.risk.irreversible, 'approve');
    assert.equal(merged.risk.write, 'deny');
  });

  test('commands.allow só encolhe; commands.deny só cresce', () => {
    const merged = clamp({ commands: { allow: ['npm test', 'curl x | sh'], deny: ['terraform'] } });
    assert.deepEqual(merged.commands.allow, ['npm test']);
    assert.ok(merged.commands.deny.includes('terraform'));
    assert.ok(merged.commands.deny.includes('sudo'));
    // deny declarado vazio NÃO remove o que a base nega
    assert.deepEqual(clamp({ commands: { deny: [] } }).commands.deny, DEFAULT_POLICY.commands.deny);
  });

  test('paths: allowWriteOutsideWorkdir só desliga; denyFragments só cresce', () => {
    assert.equal(clamp({ paths: { allowWriteOutsideWorkdir: true } }).paths.allowWriteOutsideWorkdir, false);
    const liberada = { ...DEFAULT_POLICY, paths: { ...DEFAULT_POLICY.paths, allowWriteOutsideWorkdir: true } };
    assert.equal(
      mergePolicyLayer(liberada, { paths: { allowWriteOutsideWorkdir: false } }, { clampToBase: true })
        .paths.allowWriteOutsideWorkdir,
      false,
    );
    const merged = clamp({ paths: { denyFragments: [] } });
    assert.deepEqual(merged.paths.denyFragments, DEFAULT_POLICY.paths.denyFragments);
  });

  test('network.allowDomains só encolhe', () => {
    const base = { ...DEFAULT_POLICY, network: { allowDomains: ['npmjs.org'] } };
    const merged = mergePolicyLayer(
      base,
      { network: { allowDomains: ['npmjs.org', 'evil.example'] } },
      { clampToBase: true },
    );
    assert.deepEqual(merged.network.allowDomains, ['npmjs.org']);
    assert.deepEqual(clamp({ network: { allowDomains: ['evil.example'] } }).network.allowDomains, []);
  });

  test('watch.pauseOn/flagOn só crescem', () => {
    const merged = clamp({ watch: { pauseOn: [], flagOn: ['write'] } });
    assert.deepEqual(merged.watch.pauseOn, ['irreversible']);
    assert.deepEqual(merged.watch.flagOn, ['escalate', 'write']);
  });

  test('fallback: só agentes que a cadeia da base já aceitava; capability nova é ignorada', () => {
    const merged = clamp({
      fallback: { 'code-edit': ['codex', 'agente-malicioso'], 'nova-cap': ['agente-malicioso'] },
    });
    assert.deepEqual(merged.fallback['code-edit'], ['codex']);
    assert.equal(merged.fallback['nova-cap'], undefined);
    assert.deepEqual(merged.fallback['planning'], DEFAULT_POLICY.fallback['planning']);
  });
});

describe('campos que viram processo — só com confiança explícita', () => {
  const comExec: PartialPolicyDocument = {
    validation: { command: 'node pwn.js', review: { enabled: true, agent: 'x' } },
  };

  test('sem confiança, validation.command/review da camada são ignorados', () => {
    const merged = clamp(comExec);
    assert.equal(merged.validation.command, null);
    assert.equal(merged.validation.review.enabled, false);
    assert.equal(merged.validation.review.agent, null);
  });

  test('sem confiança, a camada também não troca o comando que a base já tem', () => {
    const base = { ...DEFAULT_POLICY, validation: { ...DEFAULT_POLICY.validation, command: 'npm test' } };
    const merged = mergePolicyLayer(base, comExec, { clampToBase: true });
    assert.equal(merged.validation.command, 'npm test');
  });

  test('com confiança, valem — mas não desligam o que a base exige', () => {
    const merged = clamp(comExec, true);
    assert.equal(merged.validation.command, 'node pwn.js');
    assert.equal(merged.validation.review.enabled, true);
    assert.equal(merged.validation.review.agent, 'x');

    const base = {
      ...DEFAULT_POLICY,
      validation: { ...DEFAULT_POLICY.validation, command: 'npm test', review: { enabled: true, agent: null } },
    };
    const desliga = mergePolicyLayer(
      base,
      { validation: { command: null, review: { enabled: false } } },
      { clampToBase: true, trustExecFields: true },
    );
    assert.equal(desliga.validation.command, 'npm test');
    assert.equal(desliga.validation.review.enabled, true);
  });

  test('sem clamp (config global), os campos fundem livres como sempre', () => {
    assert.equal(mergePolicyLayer(DEFAULT_POLICY, comExec).validation.command, 'node pwn.js');
  });

  test('execFieldsDeclared/withoutExecFields', () => {
    assert.deepEqual(execFieldsDeclared(comExec), [
      'validation.command',
      'validation.review.enabled',
      'validation.review.agent',
    ]);
    assert.deepEqual(
      withoutExecFields({ maxDepth: 1, validation: { command: 'x', commandTimeoutSeconds: 5 } }),
      { maxDepth: 1, validation: { commandTimeoutSeconds: 5 } },
    );
    assert.deepEqual(withoutExecFields({ validation: { review: { enabled: true } } }), {});
  });
});
