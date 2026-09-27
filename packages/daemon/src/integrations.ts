import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { HubError } from '@agents-hub/core';
import {
  avisoDeTimeoutDoHook,
  comandoDoHook,
  hookInstalado,
  hookTargets,
  mergeHooks,
  NOTA_GATE_POR_SESSAO,
} from './hooks-config.js';
import { diffDeLinhas, type LinhaDeDiff } from './line-diff.js';
import {
  existingServerNames,
  mcpTargets,
  planUpsertMcpServer,
  resolveConfigPath,
  type ConfigFormat,
  type McpTarget,
  type PortableMcpServer,
} from './mcp-config.js';
import { gravarComBackup, lerJsonDeConfig, lerJsonParaExibir } from './safe-write.js';

/**
 * Estado e instalação das integrações do Hub em cada CLI — o hook do gate
 * pré-execução e o registro do MCP server — para o painel (item 6.12 do GOAL,
 * vistoria 05 "cobertura visível": por agente, gate ativo ou só vigilância, e
 * o estado REAL do `hub hooks install`).
 *
 * Mesmas regras de `hub hooks`/`hub mcp` (e as mesmas funções): merge, nunca
 * sobrescrever config alheia, backup versionado, escrita atômica. O que muda
 * é o fluxo: a prévia devolve o diff do arquivo e um `base` (hash do conteúdo
 * visto); gravar exige esse `base` de volta, então o que vai para o disco é
 * exatamente o que a pessoa aprovou — se o arquivo mudou no meio, nada é
 * gravado (`CONFIG_CHANGED`).
 */

/** Nome sob o qual o Hub se registra em cada agente (o mesmo da CLI). */
export const HUB_MCP_SERVER_NAME = 'agents-hub';

export interface IntegracoesDeps {
  /** Home do usuário (onde moram as configs dos CLIs). Injetável em teste. */
  userHome: string;
  /** Home do Hub (`config.json` com `codexGate`). */
  hubHome: string;
  hubUrl: string;
  /** `codexGate.bypassHookTrust` que o daemon está usando agora. */
  codexBypassAtivo: boolean;
  nodeBin: string;
  cliMain: string;
  mcpMain: string;
}

export type TipoDeIntegracao = 'hook' | 'mcp';

export interface EstadoDoHook {
  /** `arquivo`: hook na config do agente; `codex-inline`: montado a cada invocação. */
  modo: 'arquivo' | 'codex-inline' | 'nenhum';
  arquivo: string | null;
  instalado: boolean;
  /**
   * Sessões subidas pelo Hub são gateadas mesmo sem o hook no arquivo (o Hub
   * injeta o hook por sessão). `instalado` passa a dizer só se as sessões
   * abertas FORA do Hub também são.
   */
  sessoesDoHubGateadas: boolean;
  /** Hook do Hub com timeout antigo (ação que pede aprovação roda sem ela). */
  avisoTimeout: string | null;
  /** Config ilegível: o estado mostrado pode estar incompleto. */
  erro: string | null;
  nota: string;
  /** O mesmo pelo terminal. */
  comando: string | null;
  instalavelPeloPainel: boolean;
}

export interface EstadoDoMcp {
  arquivo: string | null;
  /** Alvo por projeto (`.mcp.json`) consultado sem projeto escolhido. */
  precisaDeProjeto: boolean;
  formato: ConfigFormat;
  verificado: boolean;
  nota: string | null;
  registrado: boolean;
  /** Registrado E igual ao que o Hub gravaria hoje (caminho/porta atuais). */
  atualizado: boolean;
  erro: string | null;
  comando: string;
}

export interface EstadoDeIntegracao {
  agentId: string;
  hook: EstadoDoHook;
  mcp: EstadoDoMcp | null;
}

export interface Entrypoints {
  cli: string;
  mcp: string;
  cliExiste: boolean;
  mcpExiste: boolean;
}

export interface PlanoDeIntegracao {
  agentId: string;
  tipo: TipoDeIntegracao;
  arquivo: string;
  acao: 'criar' | 'atualizar' | 'nada';
  diff: LinhaDeDiff[];
  avisos: string[];
  /** Hash do conteúdo atual; devolva-o para gravar. */
  base: string;
}

function hashDe(file: string): string {
  if (!existsSync(file)) return 'ausente';
  return `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
}

function servidorDoHub(deps: IntegracoesDeps, agentId: string): PortableMcpServer {
  return {
    name: HUB_MCP_SERVER_NAME,
    transport: 'stdio',
    command: deps.nodeBin,
    args: [deps.mcpMain],
    env: {
      AGENTS_HUB_URL: deps.hubUrl,
      // Diz ao Hub QUEM está chamando quando este agente for o principal externo.
      AGENTS_HUB_MCP_AGENT: agentId,
    },
  };
}

export function entrypoints(deps: IntegracoesDeps): Entrypoints {
  return {
    cli: deps.cliMain,
    mcp: deps.mcpMain,
    cliExiste: existsSync(deps.cliMain),
    mcpExiste: existsSync(deps.mcpMain),
  };
}

function estadoDoHook(deps: IntegracoesDeps, agentId: string): EstadoDoHook {
  if (agentId === 'codex') {
    return {
      modo: 'codex-inline',
      arquivo: path.join(deps.hubHome, 'config.json'),
      instalado: deps.codexBypassAtivo,
      sessoesDoHubGateadas: deps.codexBypassAtivo,
      avisoTimeout: null,
      erro: null,
      nota:
        'o Hub monta o hook a cada invocação (-c hooks=...); ligar exige o bypass de confiança de hook, ' +
        'gravado no config.json do Hub e lido na subida do daemon',
      comando: 'hub hooks install codex --write',
      instalavelPeloPainel: false,
    };
  }
  const alvo = hookTargets(deps.userHome).find((t) => t.id === agentId);
  if (!alvo) {
    return {
      modo: 'nenhum',
      arquivo: null,
      instalado: false,
      sessoesDoHubGateadas: false,
      avisoTimeout: null,
      erro: null,
      nota: 'sem gate pré-execução: o Hub só vigia os eventos depois que a ferramenta roda',
      comando: null,
      instalavelPeloPainel: false,
    };
  }
  let config: Record<string, unknown> = {};
  let erro: string | null = null;
  try {
    config = lerJsonParaExibir(alvo.configUsuario);
  } catch (err) {
    erro = (err as Error).message;
  }
  return {
    modo: 'arquivo',
    arquivo: alvo.configUsuario,
    instalado: hookInstalado(config),
    sessoesDoHubGateadas: alvo.gateNasSessoesDoHub,
    avisoTimeout: avisoDeTimeoutDoHook(config),
    erro,
    nota: alvo.gateNasSessoesDoHub ? `${NOTA_GATE_POR_SESSAO}; ${alvo.nota}` : alvo.nota,
    comando: `hub hooks install ${alvo.id} --write`,
    instalavelPeloPainel: true,
  };
}

function estadoDoMcp(
  deps: IntegracoesDeps,
  target: McpTarget,
  projectPath: string | undefined,
): EstadoDoMcp {
  const precisaDeProjeto = target.configPath === null && projectPath === undefined;
  const base = {
    formato: target.format,
    verificado: target.verified,
    nota: target.note ?? null,
    comando: `hub mcp install ${target.agentId} --write`,
  };
  if (precisaDeProjeto) {
    return {
      ...base,
      arquivo: null,
      precisaDeProjeto,
      registrado: false,
      atualizado: false,
      erro: null,
    };
  }
  const arquivo = resolveConfigPath(target, projectPath ?? '');
  try {
    const registrado = existingServerNames(target, arquivo).has(HUB_MCP_SERVER_NAME);
    const atualizado =
      registrado &&
      planUpsertMcpServer(target, arquivo, servidorDoHub(deps, target.agentId)).next === null;
    return { ...base, arquivo, precisaDeProjeto, registrado, atualizado, erro: null };
  } catch (err) {
    return {
      ...base,
      arquivo,
      precisaDeProjeto,
      registrado: false,
      atualizado: false,
      erro: (err as Error).message,
    };
  }
}

/** Estado por agente (só leitura, sem escrever nada). */
export function estadoDasIntegracoes(
  deps: IntegracoesDeps,
  agentIds: readonly string[],
  projectPath?: string,
): EstadoDeIntegracao[] {
  const targets = mcpTargets(deps.userHome);
  const ids = [...new Set([...agentIds, ...targets.map((t) => t.agentId)])];
  return ids.map((agentId) => {
    const target = targets.find((t) => t.agentId === agentId);
    return {
      agentId,
      hook: estadoDoHook(deps, agentId),
      mcp: target ? estadoDoMcp(deps, target, projectPath) : null,
    };
  });
}

interface Calculo {
  plano: PlanoDeIntegracao;
  /** Conteúdo a gravar; `null` quando nada muda. */
  conteudo: string | null;
}

function recusaDeConfig(err: unknown): HubError {
  return new HubError('AGENT_CONFIG_INVALID', (err as Error).message, {});
}

function calcular(
  deps: IntegracoesDeps,
  agentId: string,
  tipo: TipoDeIntegracao,
  projectPath: string | undefined,
): Calculo {
  const pontos = entrypoints(deps);
  if (tipo === 'hook') {
    const alvo = hookTargets(deps.userHome).find((t) => t.id === agentId);
    if (!alvo) {
      throw new HubError(
        'CAPABILITY_UNRESOLVED',
        agentId === 'codex'
          ? 'o gate do Codex não se instala em arquivo do agente — use `hub hooks install codex --write`'
          : `"${agentId}" não tem gate pré-execução instalável`,
        { agentId },
      );
    }
    if (!pontos.cliExiste) {
      throw new HubError(
        'ILLEGAL_STATE',
        `CLI do Hub não encontrada em ${pontos.cli} — rode o build`,
        {},
      );
    }
    const arquivo = alvo.configUsuario;
    let atual: Record<string, unknown>;
    let avisos: string[];
    try {
      ({ doc: atual, avisos } = lerJsonDeConfig(arquivo));
    } catch (err) {
      throw recusaDeConfig(err);
    }
    const novo = mergeHooks(atual, comandoDoHook(deps.nodeBin, deps.cliMain));
    const existe = existsSync(arquivo);
    const nada = existe && isDeepStrictEqual(atual, novo);
    const antes = existe ? readFileSync(arquivo, 'utf8') : '';
    const conteudo = nada ? null : `${JSON.stringify(novo, null, 2)}\n`;
    return {
      plano: {
        agentId,
        tipo,
        arquivo,
        acao: nada ? 'nada' : existe ? 'atualizar' : 'criar',
        diff: conteudo === null ? [] : diffDeLinhas(antes, conteudo),
        avisos,
        base: hashDe(arquivo),
      },
      conteudo,
    };
  }

  const target = mcpTargets(deps.userHome).find((t) => t.agentId === agentId);
  if (!target) {
    throw new HubError('CAPABILITY_UNRESOLVED', `"${agentId}" não tem destino de MCP conhecido`, {
      agentId,
    });
  }
  if (target.configPath === null && projectPath === undefined) {
    throw new HubError(
      'INVALID_QUERY',
      `o MCP de "${agentId}" fica no projeto (${target.projectRelativePath ?? '.mcp.json'}): escolha o projeto`,
      { agentId },
    );
  }
  if (!pontos.mcpExiste) {
    throw new HubError(
      'ILLEGAL_STATE',
      `MCP server do Hub não encontrado em ${pontos.mcp} — rode o build`,
      {},
    );
  }
  const arquivo = resolveConfigPath(target, projectPath ?? '');
  let plano;
  try {
    plano = planUpsertMcpServer(target, arquivo, servidorDoHub(deps, agentId));
  } catch (err) {
    throw recusaDeConfig(err);
  }
  const avisos = [...plano.avisos];
  if (!target.verified) {
    avisos.push('caminho/formato não confirmado para este agente — teste antes de confiar');
  }
  return {
    plano: {
      agentId,
      tipo,
      arquivo,
      acao: plano.next === null ? 'nada' : plano.existed ? 'atualizar' : 'criar',
      diff: plano.next === null ? [] : diffDeLinhas(plano.raw, plano.next),
      avisos,
      base: hashDe(arquivo),
    },
    conteudo: plano.next,
  };
}

/** Prévia: o que mudaria no arquivo, sem gravar nada. */
export function planejarIntegracao(
  deps: IntegracoesDeps,
  agentId: string,
  tipo: TipoDeIntegracao,
  projectPath?: string,
): PlanoDeIntegracao {
  return calcular(deps, agentId, tipo, projectPath).plano;
}

/**
 * Grava o que a prévia mostrou. `base` é o hash que a prévia devolveu: se o
 * arquivo mudou desde então, NADA é gravado — a pessoa aprovou outro diff.
 */
export function aplicarIntegracao(
  deps: IntegracoesDeps,
  agentId: string,
  tipo: TipoDeIntegracao,
  base: string,
  projectPath?: string,
  agora: Date = new Date(),
): { plano: PlanoDeIntegracao; backup: string | null } {
  const { plano, conteudo } = calcular(deps, agentId, tipo, projectPath);
  if (plano.base !== base) {
    throw new HubError(
      'CONFIG_CHANGED',
      `${plano.arquivo} mudou depois da prévia. Nada foi gravado — revise a prévia de novo.`,
      { arquivo: plano.arquivo },
    );
  }
  if (conteudo === null) return { plano, backup: null };
  const backup = gravarComBackup(plano.arquivo, conteudo, agora);
  return { plano, backup };
}
