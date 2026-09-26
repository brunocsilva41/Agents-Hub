import { readFileSync } from 'node:fs';
import type { HubClient } from './client.js';
import { flagOn, imprimirJson, type Args } from './cmd-util.js';
import { dim } from './render.js';

/**
 * Versão da CLI, lida do `package.json` do próprio pacote — o mesmo número
 * que um `npm pack` publicaria. Nunca lança: versão desconhecida vira texto.
 */
export function cliVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' ? pkg.version : 'desconhecida';
  } catch {
    return 'desconhecida';
  }
}

export interface VersionInfo {
  cli: string;
  node: string;
  platform: string;
  /** Versão que o daemon no ar reporta; `null` se ele não está rodando. */
  daemon: string | null;
}

/**
 * `hub --version` / `hub version`. Não sobe o daemon: perguntar a versão não
 * pode ter efeito colateral. Se houver um no ar, mostra a versão dele junto —
 * depois de atualizar o código, um daemon antigo continua rodando até
 * `hub restart`.
 */
export async function versionCommand(args: Args, client: HubClient | null): Promise<VersionInfo> {
  let daemon: string | null = null;
  if (client) {
    try {
      daemon = (await client.health()).version;
    } catch {
      daemon = null;
    }
  }
  const info: VersionInfo = {
    cli: cliVersion(),
    node: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    daemon,
  };

  if (flagOn(args, 'json')) {
    imprimirJson(info);
    return info;
  }
  console.log(`hub ${info.cli}`);
  console.log(dim(`node ${info.node} · ${info.platform}`));
  console.log(dim(daemon === null ? 'daemon: não está rodando' : `daemon: ${daemon}`));
  return info;
}
