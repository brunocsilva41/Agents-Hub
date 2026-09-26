import { mergePolicyLayer, type PartialPolicyDocument, type PolicyDocument } from './policy.js';

/**
 * Apoio ao editor de política (item 1.10 do GOAL): dizer ao operador O QUE uma
 * edição muda de verdade, em vez de só gravar e torcer.
 *
 * Tudo aqui é derivado de `mergePolicyLayer` — a mesma fusão (e o mesmo clamp)
 * que o daemon usa para decidir. Uma segunda implementação das regras só para
 * "mostrar" divergiria da que "decide" no primeiro campo novo.
 */

function ehObjetoSimples(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Folhas da política como `caminho.pontuado -> JSON`. Listas são folha (a
 * ordem de `fallback` importa; a de `commands.allow` não muda decisão, mas
 * comparar como texto é conservador: no pior caso aponta uma diferença a mais).
 */
export function policyLeaves(doc: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (!ehObjetoSimples(doc)) {
    out.set(prefix, JSON.stringify(doc ?? null));
    return out;
  }
  for (const [k, v] of Object.entries(doc)) {
    const caminho = prefix ? `${prefix}.${k}` : k;
    if (ehObjetoSimples(v)) {
      for (const [ck, cv] of policyLeaves(v, caminho)) out.set(ck, cv);
    } else {
      out.set(caminho, JSON.stringify(v ?? null));
    }
  }
  return out;
}

/** Caminhos cujo valor difere entre duas políticas (ordenados). */
export function diffPolicy(a: PolicyDocument, b: PolicyDocument): string[] {
  const fa = policyLeaves(a);
  const fb = policyLeaves(b);
  const chaves = new Set([...fa.keys(), ...fb.keys()]);
  return [...chaves].filter((k) => fa.get(k) !== fb.get(k)).sort();
}

/**
 * Campos em que `after` é MAIS PERMISSIVA que `before`.
 *
 * Truque: o clamp de projeto (`clampToBase`) produz a versão de `after` que
 * nunca afrouxa `before`. Onde `after` difere dessa versão travada, ela
 * afrouxou. É o aviso "isto afrouxa a política" que a vistoria 05 pede antes
 * de gravar a camada global (que, por estar no topo, NÃO passa por clamp).
 */
export function loosenedFields(before: PolicyDocument, after: PolicyDocument): string[] {
  const travada = mergePolicyLayer(before, after, { clampToBase: true, trustExecFields: true });
  return diffPolicy(travada, after);
}

/**
 * Campos que a camada de projeto declarou e que NÃO valeram por causa do
 * clamp (a camada tentou afrouxar a global) ou da falta de confiança (campos
 * de execução). Mostrado ao salvar a camada de projeto: sem isto, o operador
 * gravaria `commands.allow: [pytest]` e acharia que liberou.
 */
export function clampedFields(
  global: PolicyDocument,
  layer: PartialPolicyDocument,
  trusted: boolean,
): string[] {
  const livre = mergePolicyLayer(global, layer);
  const travada = mergePolicyLayer(global, layer, { clampToBase: true, trustExecFields: trusted });
  return diffPolicy(livre, travada);
}
