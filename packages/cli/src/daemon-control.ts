import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HubClient } from '@agents-hub/client';
import { loadConfig } from '@agents-hub/daemon';

/**
 * Onde o daemon autostartado escreve.
 *
 * Mesma pasta que a config do daemon já declara (`~/.agents-hub/logs`) — o
 * ponto é não inventar um segundo lugar para procurar quando algo quebra.
 */
function daemonLogDir(): string {
  return loadConfig().logDir;
}

/**
 * Sobe o daemon sozinho quando ele não está no ar.
 *
 * Sem isto, todo comando exige que você tenha deixado um terminal aberto com
 * `hub daemon` — e esquecer disso era o erro mais frequente de quem usa o Hub.
 * O daemon é detalhe de implementação do Hub, não uma cerimônia que o usuário
 * precisa executar.
 *
 * O processo sobe DESACOPLADO: sobrevive ao término do comando que o iniciou,
 * que é o que permite a sessão continuar viva depois que você fecha o terminal.
 */
export async function ensureDaemon(
  client: HubClient,
  options: { quiet?: boolean; timeoutMs?: number } = {},
): Promise<'ja-estava' | 'iniciado'> {
  if (await responde(client)) return 'ja-estava';

  if (process.env['AGENTS_HUB_NO_AUTOSTART'] === '1') {
    throw new Error(
      'daemon não está rodando e AGENTS_HUB_NO_AUTOSTART=1 impede subir sozinho. Rode: hub daemon',
    );
  }

  if (options.quiet !== true) {
    process.stderr.write('subindo o daemon…\n');
  }

  // `main.js` é este mesmo executável: reusar o próprio caminho evita depender
  // de instalação global ou de o `hub` estar no PATH.
  const entrada = fileURLToPath(new URL('./main.js', import.meta.url));

  // A saída do daemon vai para arquivo, não para o vazio.
  //
  // Com `stdio: 'ignore'` — que é como isto nasceu — o daemon autostartado era
  // completamente cego: nenhum `console.error`, nenhuma exceção, nenhuma falha
  // de migração deixava rastro em lugar nenhum. E este É o caminho normal de
  // uso, já que o daemon nasce sozinho. Quando algo dava errado, a única coisa
  // que sobrava era "o daemon não respondeu a tempo", sem nenhuma pista do
  // porquê. A pasta `~/.agents-hub/logs` já existia e era criada vazia desde
  // sempre; agora ela tem conteúdo.
  //
  // Append, num arquivo por dia: o daemon é reiniciado com frequência (o
  // autostart o ressuscita), e truncar a cada subida apagaria justamente o
  // registro da queda anterior — que é o que se quer ler.
  const logDir = daemonLogDir();
  mkdirSync(logDir, { recursive: true });
  const arquivoDeLog = path.join(logDir, `daemon-${new Date().toISOString().slice(0, 10)}.log`);
  const log = openSync(arquivoDeLog, 'a');

  const filho = spawn(process.execPath, [entrada, 'daemon'], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  filho.unref();

  // O descritor foi duplicado para o filho no spawn; manter aberto aqui
  // seguraria o arquivo pelo tempo de vida do comando da CLI sem necessidade.
  closeSync(log);

  // Se o próprio spawn falhar (execPath inválido, permissão), o ChildProcess
  // emite `'error'` — sem listener, isso é exceção não tratada na CLI.
  filho.on('error', (err) => {
    process.stderr.write(`não foi possível subir o daemon: ${err.message}\n`);
  });

  const limite = Date.now() + (options.timeoutMs ?? 30_000);
  while (Date.now() < limite) {
    if (await responde(client)) return 'iniciado';
    await sleep(300);
  }

  throw new Error(
    `o daemon não respondeu a tempo. O que ele escreveu está em ${arquivoDeLog} — ` +
      'ou rode `hub daemon` num terminal para ver ao vivo.',
  );
}

async function responde(client: HubClient): Promise<boolean> {
  try {
    await client.health();
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
