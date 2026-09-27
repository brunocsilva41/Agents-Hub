import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { HubError } from '@agents-hub/core';
import { MIGRATIONS } from './migrations.js';

/**
 * Backup e restauração do banco do Hub (item 5.6 do GOAL; achado MÉDIO da
 * vistoria 09: "copiar só o `.db` perde dados recentes").
 *
 * O banco roda em WAL: o que foi gravado recentemente mora em `hub.db-wal` até
 * o próximo checkpoint. Copiar só o `hub.db` com o daemon no ar devolvia um
 * banco (quase) vazio — 0 de 50 projetos na reprodução da vistoria. `VACUUM
 * INTO` lê pela própria conexão SQLite, que enxerga o WAL, e escreve um
 * arquivo novo, compacto e consistente (um snapshot transacional), sem travar
 * quem está escrevendo por mais que a leitura.
 */

export interface BackupResult {
  /** Caminho absoluto do arquivo gerado. */
  path: string;
  bytes: number;
  /** Maior migração aplicada no banco copiado. */
  schemaVersion: number;
}

export interface RestoreResult {
  /** Arquivo restaurado (o banco do Hub). */
  restored: string;
  /** Cópia de segurança do banco que estava lá; `null` se não havia banco. */
  safetyCopy: string | null;
  schemaVersion: number;
}

/** `hub-AAAAMMDD-HHMMSS.db` no fuso local — o que a pessoa lê na listagem. */
export function backupFileName(agora: Date = new Date()): string {
  const d = (n: number): string => String(n).padStart(2, '0');
  return (
    `hub-${agora.getFullYear()}${d(agora.getMonth() + 1)}${d(agora.getDate())}-` +
    `${d(agora.getHours())}${d(agora.getMinutes())}${d(agora.getSeconds())}.db`
  );
}

/**
 * Copia o banco `dbFile` para `outFile` com `VACUUM INTO`.
 *
 * Abre uma conexão PRÓPRIA (não a do daemon): funciona com o daemon no ar ou
 * parado, e a leitura enxerga o que está no WAL. Não migra nem altera o
 * banco de origem. Recusa sobrescrever: backup que apaga backup não é backup.
 * Depois de gravar, confere `integrity_check` do arquivo gerado.
 */
export function backupDatabase(dbFile: string, outFile: string): BackupResult {
  if (!existsSync(dbFile)) {
    throw new HubError('INVALID_PATH', `banco do Hub não encontrado em ${dbFile}`, { dbFile });
  }
  const destino = path.resolve(outFile);
  if (existsSync(destino)) {
    throw new HubError(
      'ILLEGAL_STATE',
      `${destino} já existe — escolha outro --out (backup nunca sobrescreve)`,
      {
        out: destino,
      },
    );
  }
  mkdirSync(path.dirname(destino), { recursive: true });

  const origem = new DatabaseSync(dbFile);
  try {
    origem.exec('PRAGMA busy_timeout = 5000;');
    // O caminho vai como parâmetro, não interpolado: aspas no nome do
    // arquivo não viram SQL.
    origem.prepare('VACUUM INTO ?').run(destino);
  } catch (err) {
    rmSync(destino, { force: true });
    throw new HubError('ILLEGAL_STATE', `falha no backup: ${(err as Error).message}`, { out: destino });
  } finally {
    origem.close();
  }

  const conferido = conferirBanco(destino);
  return { path: destino, bytes: statSync(destino).size, schemaVersion: conferido.schemaVersion };
}

/**
 * Abre `file`, roda `integrity_check` e confere que é um banco do Hub que esta
 * versão sabe abrir (tabela `migrations`, nenhuma migração mais nova que o
 * código). Lança `HubError` explicando o que está errado.
 */
export function conferirBanco(file: string): { schemaVersion: number } {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file);
  } catch (err) {
    throw new HubError(
      'INVALID_PATH',
      `não consegui abrir ${file} como SQLite: ${(err as Error).message}`,
      {
        file,
      },
    );
  }
  try {
    let integridade: string;
    try {
      const linhas = db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>;
      integridade = linhas.map((l) => String(Object.values(l)[0])).join('; ');
    } catch (err) {
      throw new HubError(
        'INVALID_PATH',
        `${file} não é um banco SQLite válido: ${(err as Error).message}`,
        {
          file,
        },
      );
    }
    if (integridade !== 'ok') {
      throw new HubError('INVALID_PATH', `integrity_check de ${file} falhou: ${integridade}`, { file });
    }
    const temMigracoes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migrations'")
      .get();
    if (!temMigracoes) {
      throw new HubError(
        'INVALID_PATH',
        `${file} não parece um banco do Agents-Hub (sem tabela migrations)`,
        {
          file,
        },
      );
    }
    const row = db.prepare('SELECT MAX(version) AS v FROM migrations').get() as { v: number | null };
    const schemaVersion = Number(row.v ?? 0);
    const conhecida = Math.max(0, ...MIGRATIONS.map((m) => m.version));
    if (schemaVersion > conhecida) {
      throw new HubError(
        'HUB_CONFIG_INVALID',
        `${file} tem a migração ${schemaVersion}, mas esta versão do Hub só conhece até a ${conhecida}. ` +
          'Atualize o Hub antes de restaurar este backup.',
        { schemaVersion, conhecida },
      );
    }
    return { schemaVersion };
  } finally {
    db.close();
  }
}

/**
 * Restaura `backupFile` sobre `dbFile`. SÓ com o daemon parado — quem chama
 * garante isso (a CLI confere que o daemon não responde).
 *
 * Ordem, e a ordem é o ponto:
 * 1. confere o backup (integridade + schema) ANTES de tocar em qualquer coisa;
 * 2. guarda o banco atual em `<dbFile>.pre-restore-<carimbo>` via `VACUUM
 *    INTO` (inclui o que estiver no WAL); se o atual estiver corrompido e o
 *    VACUUM falhar, copia os arquivos crus (`.db`, `-wal`, `-shm`);
 * 3. apaga `-wal`/`-shm` do atual — um WAL velho reaplicado sobre o banco
 *    restaurado o corromperia;
 * 4. copia o backup para um temporário ao lado e renomeia por cima.
 */
export function restoreDatabase(
  backupFile: string,
  dbFile: string,
  agora: Date = new Date(),
): RestoreResult {
  const origem = path.resolve(backupFile);
  if (!existsSync(origem)) {
    throw new HubError('INVALID_PATH', `arquivo de backup não encontrado: ${origem}`, { file: origem });
  }
  const destino = path.resolve(dbFile);
  if (origem === destino) {
    throw new HubError('ILLEGAL_STATE', 'o backup é o próprio banco do Hub — nada a restaurar', {
      file: origem,
    });
  }
  const { schemaVersion } = conferirBanco(origem);

  let safetyCopy: string | null = null;
  if (existsSync(destino)) {
    const base = `${destino}.pre-restore-${backupFileName(agora).slice(4, -3)}`;
    safetyCopy = base;
    for (let n = 2; existsSync(safetyCopy) || existsSync(`${safetyCopy}-wal`); n += 1) {
      safetyCopy = `${base}-${n}`;
    }
    try {
      const atual = new DatabaseSync(destino);
      try {
        atual.prepare('VACUUM INTO ?').run(safetyCopy);
      } finally {
        atual.close();
      }
    } catch {
      // Banco atual ilegível: guarda os arquivos como estão — é o que existe.
      rmSync(safetyCopy, { force: true });
      copyFileSync(destino, safetyCopy);
      for (const sufixo of ['-wal', '-shm']) {
        if (existsSync(`${destino}${sufixo}`))
          copyFileSync(`${destino}${sufixo}`, `${safetyCopy}${sufixo}`);
      }
    }
  }

  for (const sufixo of ['-wal', '-shm']) rmSync(`${destino}${sufixo}`, { force: true });
  mkdirSync(path.dirname(destino), { recursive: true });
  const tmp = `${destino}.restore-tmp-${process.pid}`;
  copyFileSync(origem, tmp);
  renameSync(tmp, destino);

  return { restored: destino, safetyCopy, schemaVersion };
}
