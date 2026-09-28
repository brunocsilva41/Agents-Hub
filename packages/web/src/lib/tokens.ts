/*
 * Contagem de tokens para exibição. Mora aqui (e não em `hub.ts`, que cria o
 * cliente com `window`) para ser testável em `tokens.test.ts`.
 */

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/**
 * Houve gasto e nenhum token contado? Nenhum modelo cobra por zero tokens:
 * é o agente que não informa. O Copilot >= 1.0.81 só entrega AI Credits no
 * JSONL (sem `outputTokens`), e o painel mostrava "0 tokens" ao lado do
 * custo — número falso, não ausência.
 */
export function tokensDesconhecidos(tokens: number, usd: number): boolean {
  return tokens === 0 && usd > 0;
}

/** "12.3k tokens", ou a ausência dita com todas as letras. */
export function rotuloDeTokens(tokens: number, usd: number): string {
  return tokensDesconhecidos(tokens, usd) ? 'sem contagem de tokens' : `${formatTokens(tokens)} tokens`;
}

/** Para tabela e lista densa, onde a unidade já está no cabeçalho: "—" é ausência. */
export function tokensCompactos(tokens: number, usd: number): string {
  return tokensDesconhecidos(tokens, usd) ? '—' : formatTokens(tokens);
}
