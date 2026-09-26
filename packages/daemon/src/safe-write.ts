import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// Subcaminho, não o índice: `config.ts` importa este arquivo, e o hook do gate
// (que lê a config a cada Bash/Edit/Write do agente) pagava ~140 ms para
// carregar registry, mappers e manifestos que não usa.
import { parseJsonTolerant } from '@agents-hub/adapters/discovery-util';

/**
 * Escrita segura em config que NÃO é nossa (settings.json do Claude,
 * config.toml do Codex, opencode.json...).
 *
 * Três garantias, todas nascidas de perda de dados real:
 * - backup versionado por horário, NUNCA sobrescrito: um `.bak` fixo era
 *   regravado a cada execução e a segunda rodada destruía o original;
 * - escrita atômica (tmp + rename): queda no meio da escrita não deixa o
 *   arquivo do usuário pela metade;
 * - leitura que recusa o que não entende em vez de tratar como `{}`.
 */

function doisDigitos(n: number): string {
  return String(n).padStart(2, '0');
}

/** `YYYYMMDD-HHMMSS` no horário local — é o que a pessoa vai procurar no disco. */
export function carimboDeBackup(agora: Date = new Date()): string {
  return (
    `${agora.getFullYear()}${doisDigitos(agora.getMonth() + 1)}${doisDigitos(agora.getDate())}-` +
    `${doisDigitos(agora.getHours())}${doisDigitos(agora.getMinutes())}${doisDigitos(agora.getSeconds())}`
  );
}

/**
 * Copia `file` para `file.bak-YYYYMMDD-HHMMSS` (com `-2`, `-3`... se colidir)
 * e devolve o caminho. `COPYFILE_EXCL` garante que um backup existente jamais
 * é sobrescrito, nem numa corrida entre duas execuções no mesmo segundo.
 */
export function backupVersionado(file: string, agora: Date = new Date()): string {
  const base = `${file}.bak-${carimboDeBackup(agora)}`;
  for (let n = 1; n < 10_000; n++) {
    const destino = n === 1 ? base : `${base}-${n}`;
    if (existsSync(destino)) continue;
    try {
      copyFileSync(file, destino, constants.COPYFILE_EXCL);
      return destino;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new Error(`não foi possível criar um backup inédito de ${file}`);
}

/** Grava via arquivo temporário no mesmo diretório + rename (atômico no mesmo volume). */
export function gravarAtomico(file: string, conteudo: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, conteudo, { encoding: 'utf8', flag: 'wx' });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Backup (se o arquivo existe) e escrita atômica. Devolve o caminho do
 * backup, ou `null` quando o arquivo não existia.
 */
export function gravarComBackup(file: string, conteudo: string, agora: Date = new Date()): string | null {
  const backup = existsSync(file) ? backupVersionado(file, agora) : null;
  gravarAtomico(file, conteudo);
  return backup;
}

/**
 * Leitura só para EXIBIR status: tolerante a JSONC e a lixo depois do objeto.
 * Nunca use o resultado disto para regravar o arquivo (use `lerJsonDeConfig`).
 */
export function lerJsonParaExibir(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const v = parseJsonTolerant(readFileSync(file, 'utf8')).value;
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export interface JsonDeConfig {
  doc: Record<string, unknown>;
  /** Avisos para mostrar à pessoa (ex.: comentários que não sobrevivem à regravação). */
  avisos: string[];
}

/**
 * Lê um JSON de config de outra ferramenta para editar e regravar.
 *
 * Aceita JSON estrito e JSONC (comentários `//`/`/* *\/` e vírgula final) —
 * formatos que as próprias ferramentas toleram. RECUSA (lança, sem escrever
 * nada) o resto: conteúdo extra depois do objeto, sintaxe quebrada, raiz que
 * não é objeto. Tratar isso como `{}` e regravar apagava a config inteira do
 * usuário, com mensagem de sucesso.
 */
export function lerJsonDeConfig(file: string): JsonDeConfig {
  if (!existsSync(file)) return { doc: {}, avisos: [] };
  const raw = readFileSync(file, 'utf8');
  if (raw.trim().length === 0) return { doc: {}, avisos: [] };

  const avisos: string[] = [];
  let valor: unknown;
  try {
    valor = JSON.parse(raw.replace(/^﻿/, ''));
  } catch (estrito) {
    const tolerante = parseJsonTolerant(raw);
    if (tolerante.error !== undefined || tolerante.note !== undefined) {
      // `note` = só deu para ler o primeiro objeto; o resto seria descartado.
      throw new Error(
        `${file} não é JSON válido (${(estrito as Error).message}). ` +
          'Nada foi gravado: corrija o arquivo (ou cole o trecho manualmente) e rode de novo.',
      );
    }
    valor = tolerante.value;
    avisos.push(
      `${file} tem comentários ou vírgulas finais (JSONC): o conteúdo é preservado, ` +
        'mas os comentários não sobrevivem à regravação — o original fica no backup',
    );
  }
  if (valor === null || typeof valor !== 'object' || Array.isArray(valor)) {
    throw new Error(`${file} não contém um objeto JSON na raiz. Nada foi gravado.`);
  }
  return { doc: valor as Record<string, unknown>, avisos };
}
