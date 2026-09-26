import { existsSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  comandoDoHook,
  gravarComBackup,
  hookTargets,
  lerJsonDeConfig,
  lerJsonParaExibir,
  type AlvoDeHook,
  type JsonDeConfig,
} from '@agents-hub/daemon';

/**
 * Registro do gate pré-execução na config do agente.
 *
 * A parte pura (alvos, merge, detecção, aviso de timeout) mora no daemon
 * (`hooks-config.ts`), porque o painel também mostra e instala o hook (item
 * 6.12 do GOAL); aqui ficam o caminho desta CLI e a gravação. Reexportado
 * para os comandos e testes que já importavam daqui.
 */
export {
  MATCHER_DE_RISCO,
  mergeHooks,
  hookInstalado,
  avisoDeTimeoutDoHook,
  comandoDoHub,
  type AlvoDeHook,
  type EntradaDeHook,
} from '@agents-hub/daemon';

export const HOOK_TARGETS: AlvoDeHook[] = hookTargets(os.homedir());

/**
 * Caminho absoluto da entrada (`bin.js`) desta CLI — não depende de `hub` estar
 * no PATH.
 *
 * Instalado pelo pacote (`npm i -g agents-hub-x.y.z.tgz`), aponta para dentro
 * da instalação global — caminho que não muda entre atualizações, e não para
 * um clone que pode ser movido ou apagado. Rodando do clone, aponta para o
 * clone (é o que existe). `bin.js` e não `main.js`: é o caminho leve do hook,
 * que não carrega o daemon nem `node:sqlite`.
 */
export function hookEntrypoint(): string {
  return fileURLToPath(new URL('./bin.js', import.meta.url));
}

export function hookCommand(): string {
  return comandoDoHook(process.execPath, hookEntrypoint());
}

/**
 * Leitura só para EXIBIR (`hub hooks`): tolerante a JSONC e a lixo no fim,
 * para mostrar o status real em vez de "não instalado" por causa de um
 * comentário. Nunca use o resultado disto para regravar o arquivo.
 */
export function lerConfig(file: string): Record<string, unknown> {
  return lerJsonParaExibir(file);
}

/**
 * Leitura para EDITAR: aceita JSON estrito e JSONC; recusa (lança, sem gravar
 * nada) arquivo que não parseia por inteiro. Antes, o erro virava `{}` e a
 * regravação apagava permissões, modelo e hooks da pessoa.
 */
export function lerConfigParaGravar(file: string): JsonDeConfig {
  return lerJsonDeConfig(file);
}

export interface GravacaoDeHook {
  acao: 'criado' | 'atualizado' | 'inalterado';
  /** Backup versionado (`settings.json.bak-YYYYMMDD-HHMMSS`) desta execução. */
  backup: string | null;
}

/**
 * Grava com backup versionado (nunca sobrescreve um backup anterior) e escrita
 * atômica. Se o conteúdo já é o desejado, não grava nem cria backup — rodar
 * duas vezes não multiplica arquivos nem apaga comentários à toa.
 */
export function gravarConfig(
  file: string,
  atual: Record<string, unknown>,
  conteudo: Record<string, unknown>,
  agora: Date = new Date(),
): GravacaoDeHook {
  const existia = existsSync(file);
  if (existia && isDeepStrictEqual(atual, conteudo)) return { acao: 'inalterado', backup: null };
  const backup = gravarComBackup(file, `${JSON.stringify(conteudo, null, 2)}\n`, agora);
  return { acao: existia ? 'atualizado' : 'criado', backup };
}
