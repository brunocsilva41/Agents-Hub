import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { comandoDoHook, mergeHooks } from './hooks-config.js';

/**
 * Settings POR SESSÃO com o hook `PreToolUse` do gate — o que o Hub passa ao
 * Claude Code (e ao OpenClaude) em `--settings <arquivo>`.
 *
 * Por que existe: no teste real de 2026-09-26, uma sessão do Claude subida
 * pelo Hub só tinha gate pré-execução se o usuário tivesse instalado o hook no
 * `~/.claude/settings.json`. Sem isso, `--mode supervised` prometia prevenção
 * e entregava só a vigilância reativa (que vê o comando depois que ele rodou).
 * O `claude` 2.1.283 aceita `--settings <file-or-json>` ("settings
 * ADICIONAIS"): o hook vale para a sessão sem tocar na config do usuário.
 *
 * O conteúdo é EXATAMENTE o que `hub hooks install claude --write` gravaria
 * (`mergeHooks` sobre um objeto vazio): mesmo comando (`bin.js` desta
 * instalação), mesmo matcher de risco, mesmo timeout (120 s). Isso importa
 * para quando o usuário TAMBÉM tem o hook instalado: o Claude soma os hooks
 * das duas fontes, mas deduplica comando idêntico; se os comandos diferirem
 * (instalação antiga, outro Node), os dois rodam — e o daemon responde a
 * mesma decisão para o mesmo `tool_use_id` sem abrir uma segunda aprovação
 * (`DecisoesDoGate`).
 *
 * Arquivo e não JSON inline no argv: o comando do hook tem caminhos com
 * espaço entre aspas, e aspas aninhadas no argv são exatamente o que o
 * `%*` de um shim `.cmd` destrói (ver `codex-gate.ts`, achado #4).
 */

/** `<home>/run/<sessionId>-settings.json`. */
export function caminhoDoSettingsDaSessao(hubHome: string, sessionId: string): string {
  return path.join(hubHome, 'run', `${sessionId}-settings.json`);
}

/** Conteúdo do arquivo: só o hook do gate, no formato de `mergeHooks`. */
export function conteudoDoSettingsDaSessao(nodeBin: string, cliMain: string): Record<string, unknown> {
  return mergeHooks({}, comandoDoHook(nodeBin, cliMain));
}

/**
 * Grava (ou regrava — cada turno chama de novo, e o conteúdo é o mesmo) o
 * arquivo de settings da sessão e devolve o caminho. Lança se não conseguir:
 * quem chama NÃO pode subir o agente sem o gate que ele prometeu.
 */
export async function gravarSettingsDaSessao(
  hubHome: string,
  sessionId: string,
  entrada: { nodeBin: string; cliMain: string },
): Promise<string> {
  const arquivo = caminhoDoSettingsDaSessao(hubHome, sessionId);
  await mkdir(path.dirname(arquivo), { recursive: true });
  const conteudo = conteudoDoSettingsDaSessao(entrada.nodeBin, entrada.cliMain);
  await writeFile(arquivo, `${JSON.stringify(conteudo, null, 2)}\n`, 'utf8');
  return arquivo;
}

/** Apaga o arquivo da sessão. Idempotente: ausente não é erro. */
export async function apagarSettingsDaSessao(hubHome: string, sessionId: string): Promise<void> {
  await rm(caminhoDoSettingsDaSessao(hubHome, sessionId), { force: true }).catch(() => undefined);
}
