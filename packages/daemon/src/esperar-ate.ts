/**
 * Espera por CONDIÇÃO para os testes do daemon — a única do pacote.
 *
 * Existe porque os testes esperavam de dois jeitos ruins: um `setTimeout` fixo
 * ("dá 300 ms e confere"), que fica vermelho num runner lento e mascara
 * regressão num rápido, e cópias locais deste mesmo laço, cada uma com seu
 * prazo e sua mensagem de erro. Aqui o teste espera o estado observável que
 * importa, com prazo generoso: só falha se a condição NUNCA vier.
 *
 * Devolve o valor que satisfez a condição, para o teste usar sem reconsultar
 * (ex.: a aprovação que apareceu). `false`, `null` e `undefined` são "ainda não".
 */
export interface OpcoesDeEspera {
  /** Teto total. Generoso de propósito: o normal é a condição chegar muito antes. */
  prazoMs?: number;
  /** Intervalo entre consultas. Curto só quando o teste precisa pegar uma janela breve. */
  intervaloMs?: number;
}

export async function esperarAte<T>(
  condicao: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  oque: string,
  opcoes: OpcoesDeEspera = {},
): Promise<T> {
  const { prazoMs = 30_000, intervaloMs = 25 } = opcoes;
  const limite = Date.now() + prazoMs;
  for (;;) {
    const valor = await condicao();
    if (valor !== false && valor !== null && valor !== undefined) return valor;
    if (Date.now() > limite) throw new Error(`tempo esgotado (${prazoMs} ms) esperando: ${oque}`);
    await new Promise((r) => setTimeout(r, intervaloMs));
  }
}
