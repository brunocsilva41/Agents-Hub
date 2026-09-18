/**
 * Rede de segurança do processo do daemon.
 *
 * O daemon guarda N sessões vivas, cada uma com um processo de agente filho e
 * orçamento sendo consumido. Um erro solto em qualquer uma delas não pode
 * derrubar as outras — mas era exatamente o que acontecia, e por um caminho
 * concreto:
 *
 * `#pump` é disparado com `void this.#pump(...)`, sem ninguém para receber a
 * rejeição. O `for await` dentro dele está protegido por try/catch, só que o
 * `catch` **emite um evento**, e emitir escreve no SQLite. Um `catch` não pega
 * o que ele mesmo lança: chave única violada, `SQLITE_BUSY` além do
 * `busy_timeout`, disco cheio — qualquer um desses escapa do `#pump`, vira
 * `unhandledRejection` e, sem handler, mata o processo. Todas as sessões vão
 * junto, e os processos filhos ficam órfãos consumindo token.
 *
 * ## Por que não apenas ignorar
 *
 * Um handler que só registra e segue em frente esconde corrupção: depois de um
 * `uncaughtException` o processo pode estar com estado inconsistente, e
 * continuar servindo a partir dali é pior do que reiniciar. Por isso a divisão:
 *
 * - `unhandledRejection` **não derruba**. A origem quase sempre é uma promessa
 *   de uma sessão específica; o resto do daemon continua íntegro, e matar tudo
 *   por causa de uma sessão é o dano que queremos evitar.
 * - `uncaughtException` **derruba, de forma ordenada**. Aí o estado do processo
 *   é suspeito de verdade, e o desligamento gracioso é o que mata os filhos e
 *   fecha o banco. A reconciliação na próxima subida cuida do registro.
 *
 * Nos dois casos o erro é escrito em stderr — que é onde o log do daemon
 * autostartado passa a cair (ver `daemon-control.ts`). Sem isso, a única
 * evidência de uma queda seria a ausência de eventos.
 */

/** Evita que uma falha durante o próprio desligamento reentre e trave tudo. */
let derrubando = false;

export function instalarRedeDeSeguranca(desligar: () => Promise<void> | void): void {
  process.on('unhandledRejection', (motivo) => {
    console.error(
      `[agents-hub] promessa rejeitada sem tratamento — a sessão de origem pode ` +
        `ter parado, o daemon segue no ar: ${formatar(motivo)}`,
    );
  });

  process.on('uncaughtException', (erro) => {
    console.error(`[agents-hub] exceção não tratada — encerrando de forma ordenada: ${formatar(erro)}`);

    if (derrubando) {
      // Falhou durante o desligamento. Insistir no caminho gracioso arriscaria
      // ficar preso para sempre; sair aqui ao menos devolve a porta e o lock.
      process.exit(1);
    }
    derrubando = true;

    // Teto de tempo: se o desligamento gracioso travar, sair mesmo assim é
    // melhor do que um daemon meio morto segurando a porta — o próximo `hub`
    // sobe um novo e a reconciliação limpa o registro.
    const forcar = setTimeout(() => process.exit(1), 10_000);
    forcar.unref();

    void (async () => {
      try {
        await desligar();
      } catch (falha) {
        console.error(`[agents-hub] desligamento após exceção também falhou: ${formatar(falha)}`);
      } finally {
        process.exit(1);
      }
    })();
  });
}

function formatar(valor: unknown): string {
  if (valor instanceof Error) return valor.stack ?? `${valor.name}: ${valor.message}`;
  return typeof valor === 'string' ? valor : JSON.stringify(valor);
}
