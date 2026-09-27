import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { backupDatabase, backupFileName, conferirBanco, restoreDatabase } from '@agents-hub/daemon';
import type { HubClient } from './client.js';
import { flagOn, flagString, imprimirJson, required, type Args } from './cmd-util.js';
import { bold, dim, green, yellow } from './render.js';

interface Onde {
  home: string;
  dbFile: string;
}

async function daemonNoAr(client: HubClient): Promise<boolean> {
  try {
    await client.health();
    return true;
  } catch {
    return false;
  }
}

/**
 * `hub backup [--out arquivo] [--json]` — cópia consistente do banco.
 *
 * Com o daemon no ar, pede a ele (`POST /maintenance/backup`, token de
 * operador, fica na auditoria); parado, faz aqui mesmo. Nos dois casos é
 * `VACUUM INTO`, que lê o que ainda está no WAL — copiar só o `hub.db` à mão
 * perdia os dados recentes. Não sobe o daemon só para isso.
 */
export async function backupCommand(client: HubClient, onde: Onde, args: Args): Promise<void> {
  const outFlag = flagString(args, 'out');
  const out = path.resolve(outFlag ?? path.join(onde.home, 'backups', backupFileName()));
  const viaDaemon = await daemonNoAr(client);
  const backup = viaDaemon ? (await client.backup(out)).backup : backupDatabase(onde.dbFile, out);

  if (flagOn(args, 'json')) {
    imprimirJson({ ...backup, via: viaDaemon ? 'daemon' : 'local' });
    return;
  }
  console.log(`${green('backup gravado')} ${bold(backup.path)}`);
  console.log(
    dim(
      `${(backup.bytes / 1024).toFixed(1)} KB · schema ${backup.schemaVersion} · integrity_check ok · ` +
        (viaDaemon ? 'feito pelo daemon no ar' : 'daemon parado, feito localmente'),
    ),
  );
  console.log(
    dim('restaure com:'),
    bold(`hub restore "${backup.path}" --write`),
    dim('(com o daemon parado)'),
  );
}

/**
 * `hub restore <arquivo> [--write]` — só com o daemon PARADO: trocar o banco
 * debaixo de um processo que o tem aberto (e com WAL) corromperia os dois.
 * Sem `--write`, confere o arquivo e mostra o que faria. Com `--write`, guarda
 * o banco atual em `hub.db.pre-restore-<data>` antes de trocar.
 */
export async function restoreCommand(client: HubClient, onde: Onde, args: Args): Promise<void> {
  const arquivo = path.resolve(required(args.positional[0], 'arquivo de backup'));
  if (await daemonNoAr(client)) {
    throw new Error(
      'o daemon está rodando — pare antes com `hub stop` (restaurar com o banco aberto o corromperia)',
    );
  }
  if (!existsSync(arquivo)) throw new Error(`arquivo não encontrado: ${arquivo}`);

  // Confere ANTES de qualquer mensagem de plano: backup ruim nem vira plano.
  const { schemaVersion } = conferirBanco(arquivo);
  const atualExiste = existsSync(onde.dbFile);

  if (!flagOn(args, 'write') || flagOn(args, 'dry-run')) {
    console.log(
      `${bold(arquivo)} ${dim(`(${(statSync(arquivo).size / 1024).toFixed(1)} KB, schema ${schemaVersion}, integrity_check ok)`)}`,
    );
    console.log(`substituiria ${bold(onde.dbFile)}`);
    if (atualExiste)
      console.log(dim(`o banco atual seria guardado antes em ${onde.dbFile}.pre-restore-<data>`));
    console.log(
      `\n${dim('prévia — nada foi alterado. para restaurar:')} ${bold(`hub restore "${arquivo}" --write`)}`,
    );
    return;
  }

  const r = restoreDatabase(arquivo, onde.dbFile);
  if (flagOn(args, 'json')) {
    imprimirJson(r);
    return;
  }
  console.log(`${green('banco restaurado')} ${bold(r.restored)} ${dim(`(schema ${r.schemaVersion})`)}`);
  if (r.safetyCopy) console.log(dim(`o banco anterior ficou em ${r.safetyCopy}`));
  console.log(
    yellow(
      'worktrees e artefatos em disco não fazem parte do banco: sessões restauradas podem apontar para pastas que já não existem.',
    ),
  );
}
