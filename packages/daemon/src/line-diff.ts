/**
 * Diff de linhas para a PRÉVIA de escrita em config de outra ferramenta
 * (instalar hook/MCP pelo painel, item 6.12 do GOAL).
 *
 * O operador precisa ver exatamente o que muda no `settings.json` do Claude
 * ou no `config.toml` do Codex antes de confirmar — "vai registrar o hook"
 * não diz se a entrada de outra pessoa some. Só as regiões alteradas vão, com
 * um pouco de contexto; valores de chaves com cara de credencial saem
 * mascarados, porque esses arquivos costumam guardar tokens e a prévia
 * atravessa HTTP até o navegador.
 */

export interface LinhaDeDiff {
  /** `+` entra, `-` sai, ` ` contexto, `@` salto (linhas iguais omitidas). */
  tipo: '+' | '-' | ' ' | '@';
  texto: string;
}

/** Acima disto a LCS fica cara: o meio alterado vira bloco `-`/`+` inteiro. */
const TETO_DE_CELULAS = 4_000_000;

function linhas(texto: string): string[] {
  if (texto === '') return [];
  const ls = texto.replace(/\r\n/g, '\n').split('\n');
  if (ls[ls.length - 1] === '') ls.pop();
  return ls;
}

/** Sequência de operações (sem recorte de contexto) entre `a` e `b`. */
function operacoes(a: string[], b: string[]): LinhaDeDiff[] {
  let ini = 0;
  while (ini < a.length && ini < b.length && a[ini] === b[ini]) ini++;
  let fimA = a.length;
  let fimB = b.length;
  while (fimA > ini && fimB > ini && a[fimA - 1] === b[fimB - 1]) {
    fimA--;
    fimB--;
  }
  const antes = a.slice(0, ini).map((texto) => ({ tipo: ' ' as const, texto }));
  const depois = a.slice(fimA).map((texto) => ({ tipo: ' ' as const, texto }));
  const ma = a.slice(ini, fimA);
  const mb = b.slice(ini, fimB);

  let meio: LinhaDeDiff[];
  if (ma.length * mb.length > TETO_DE_CELULAS) {
    meio = [
      ...ma.map((texto) => ({ tipo: '-' as const, texto })),
      ...mb.map((texto) => ({ tipo: '+' as const, texto })),
    ];
  } else {
    // LCS clássica de baixo para cima; reconstrução em ordem.
    const n = ma.length;
    const m = mb.length;
    const t: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        t[i]![j] = ma[i] === mb[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
      }
    }
    meio = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (ma[i] === mb[j]) {
        meio.push({ tipo: ' ', texto: ma[i]! });
        i++;
        j++;
      } else if (t[i + 1]![j]! >= t[i]![j + 1]!) {
        meio.push({ tipo: '-', texto: ma[i++]! });
      } else {
        meio.push({ tipo: '+', texto: mb[j++]! });
      }
    }
    while (i < n) meio.push({ tipo: '-', texto: ma[i++]! });
    while (j < m) meio.push({ tipo: '+', texto: mb[j++]! });
  }
  return [...antes, ...meio, ...depois];
}

const CHAVE_SECRETA =
  /^(\s*"?[\w.-]*(?:key|token|secret|password|passwd|authorization|credential)[\w.-]*"?\s*[:=]\s*)(.+?)(,?\s*)$/i;

/** Esconde o valor de linhas `"ALGUMA_KEY": "..."` / `token = "..."`. */
export function mascararLinha(texto: string): string {
  const m = CHAVE_SECRETA.exec(texto);
  if (!m) return texto;
  const valor = m[2]!.trim();
  // Objeto/lista abrindo na mesma linha: o valor não está aqui.
  if (valor === '{' || valor === '[') return texto;
  return `${m[1]}"••••"${m[3]}`;
}

/**
 * Diff de `antes` para `depois`, só com as regiões alteradas e `contexto`
 * linhas em volta; trechos iguais omitidos viram uma linha `@`.
 */
export function diffDeLinhas(antes: string, depois: string, contexto = 3): LinhaDeDiff[] {
  const ops = operacoes(linhas(antes), linhas(depois));
  const mudou = ops.map((o) => o.tipo !== ' ');
  if (!mudou.includes(true)) return [];

  const manter = ops.map((_, i) => {
    for (let k = Math.max(0, i - contexto); k <= Math.min(ops.length - 1, i + contexto); k++) {
      if (mudou[k]) return true;
    }
    return false;
  });

  const out: LinhaDeDiff[] = [];
  let omitidas = 0;
  ops.forEach((op, i) => {
    if (!manter[i]) {
      omitidas++;
      return;
    }
    if (omitidas > 0) {
      out.push({ tipo: '@', texto: `… ${omitidas} linha(s) iguais` });
      omitidas = 0;
    }
    out.push({ tipo: op.tipo, texto: mascararLinha(op.texto) });
  });
  if (omitidas > 0) out.push({ tipo: '@', texto: `… ${omitidas} linha(s) iguais` });
  return out;
}
