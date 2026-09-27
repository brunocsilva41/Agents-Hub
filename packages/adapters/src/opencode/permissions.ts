import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SessionMode } from '@agents-hub/core';

/**
 * Como o modo do Hub vira permissão REAL no `opencode serve`.
 *
 * O que foi medido contra o binário (opencode 1.18.32, servidor isolado, sem
 * modelo: `POST /api/session/{id}/permission` só AVALIA a regra e devolve
 * `allow`/`deny`/`ask`, custo zero):
 *
 * - A API v2 aceita `agent` na criação da sessão (e `POST /api/session/{id}/agent`
 *   para trocar), mas NÃO aceita permissão por sessão. O `permission` do
 *   `PATCH /session/{id}` (v1) é gravado e IGNORADO pela avaliação v2.
 * - O agente padrão `build` tem `* → allow`: tudo passa. O nativo `plan` nega
 *   edição, mas deixa `bash` livre (`git push` → allow).
 * - Agente inexistente é aceito na criação e vira "nega tudo" — por isso o
 *   adapter só pede um agente que conferiu existir em `GET /api/agent`.
 * - `OPENCODE_CONFIG_CONTENT` e `OPENCODE_CONFIG` não chegam à camada v2 nesta
 *   versão; `OPENCODE_CONFIG_DIR` chega, é ADITIVO à config global do usuário
 *   (provedores, modelos e login continuam valendo) e os agentes declarados
 *   nele aparecem em `GET /api/agent` com as permissões aplicadas.
 *
 * Então: quando o Hub sobe o próprio servidor, aponta `OPENCODE_CONFIG_DIR`
 * para um diretório dele com três agentes `hub-*`, um por modo. Quando o
 * servidor já existia (subido pelo usuário), esses agentes não existem e o
 * adapter cai para os nativos `plan`/`build`, avisando na timeline que a
 * restrição é parcial.
 *
 * `ask` é evitado de propósito: o Hub ainda não tem canal para responder
 * pedido de permissão do OpenCode, e um `ask` sem resposta trava o turno até o
 * heartbeat. Onde a tabela de risco pede "aprovação", aqui vira `deny` — o
 * agente recebe a recusa e segue (ou explica por que parou).
 */

/** Nome do agente `hub-*` que materializa cada modo. */
export const OPENCODE_AGENTE_DO_MODO: Record<SessionMode, string> = {
  supervised: 'hub-supervised',
  semi: 'hub-semi',
  autonomous: 'hub-autonomous',
};

/**
 * Agente nativo usado quando o servidor não foi subido pelo Hub. `plan` nega
 * edição (medido), mas não restringe `bash` — daí o aviso na timeline.
 */
export const OPENCODE_AGENTE_NATIVO_DO_MODO: Record<SessionMode, string> = {
  supervised: 'plan',
  semi: 'build',
  autonomous: 'build',
};

type Acao = 'allow' | 'deny' | 'ask';
type Regra = Acao | Record<string, Acao>;

/**
 * Irreversível pela tabela de risco do README (aprovação em TODOS os modos).
 * `*` na frente pega o comando composto (`cd x && git push`): o avaliador do
 * OpenCode casa o texto inteiro do comando contra o padrão.
 */
const BASH_IRREVERSIVEL = [
  '*git push*',
  '*git reset --hard*',
  '*git stash drop*',
  '*git stash clear*',
  '*git clean -f*',
  '*rm -rf*',
  '*rm -fr*',
  '*rm -r -f*',
  '*Remove-Item*-Recurse*',
  '*find *-delete*',
  '*npm publish*',
  '*pnpm publish*',
  '*yarn publish*',
  '*sudo *',
  '*shutdown*',
  '*mkfs*',
  '*reg delete*',
];

/** Segredos: ler ou escrever é irreversível (vaza) — negado em todos os modos. */
const LEITURA: Record<string, Acao> = {
  '*': 'allow',
  '*.env': 'deny',
  '*.env.*': 'deny',
  '*.env.example': 'allow',
  '*/.ssh/*': 'deny',
  '*\\.ssh\\*': 'deny',
};

/** Escrita em gancho do git/CI é irreversível pela tabela; o resto do worktree passa. */
const EDICAO_SEMI: Record<string, Acao> = {
  '*': 'allow',
  '*.env': 'deny',
  '*.env.*': 'deny',
  // Absoluto (como o OpenCode avalia) e relativo, com as duas barras.
  '*/.git/hooks/*': 'deny',
  '*\\.git\\hooks\\*': 'deny',
  '.git/hooks/*': 'deny',
  '.git\\hooks\\*': 'deny',
  '*/.github/workflows/*': 'deny',
  '*\\.github\\workflows\\*': 'deny',
  '.github/workflows/*': 'deny',
  '.github\\workflows\\*': 'deny',
};

/** Comum aos três: nada que abra `ask` sem ninguém para responder. */
const BASE: Record<string, Regra> = {
  read: LEITURA,
  // Sessão headless: pergunta ao usuário trava o turno.
  question: 'deny',
  // Escrita/leitura fora do worktree é `escalate` na tabela.
  external_directory: 'deny',
  // O nativo é `ask`; sem resposta vira trava.
  doom_loop: 'deny',
};

function bashSemi(): Record<string, Acao> {
  const regras: Record<string, Acao> = { '*': 'allow' };
  for (const padrao of BASH_IRREVERSIVEL) regras[padrao] = 'deny';
  return regras;
}

/**
 * Config `opencode.json` com os agentes do Hub — pura, para teste e para gravar.
 *
 * A ORDEM das chaves importa: o OpenCode avalia "a última regra que casa
 * vence", então o curinga `*` vem primeiro e as exceções depois. Agente
 * customizado sem regra para uma ação cai em `ask` (medido) — por isso cada
 * agente abre com um `*` explícito.
 */
export function configDosAgentesDoHub(): Record<string, unknown> {
  return {
    $schema: 'https://opencode.ai/config.json',
    agent: {
      [OPENCODE_AGENTE_DO_MODO.supervised]: {
        mode: 'primary',
        description: 'Agents Hub — supervised: só leitura. Edição, shell, rede e subagentes negados.',
        permission: {
          // Nega por padrão: ferramenta desconhecida (MCP incluído) pode escrever.
          '*': 'deny',
          ...BASE,
          glob: 'allow',
          grep: 'allow',
          list: 'allow',
          lsp: 'allow',
          todoread: 'allow',
          todowrite: 'allow',
          edit: 'deny',
          bash: 'deny',
          webfetch: 'deny',
          websearch: 'deny',
          // Subagente roda com as permissões DELE (`general` é allow-all):
          // sem isto, delegar seria o atalho para escapar do supervised.
          task: 'deny',
        },
      },
      [OPENCODE_AGENTE_DO_MODO.semi]: {
        mode: 'primary',
        description: 'Agents Hub — semi: edita e roda comandos; irreversível e segredos negados.',
        permission: { '*': 'allow', ...BASE, edit: EDICAO_SEMI, bash: bashSemi(), task: 'deny' },
      },
      [OPENCODE_AGENTE_DO_MODO.autonomous]: {
        mode: 'primary',
        description: 'Agents Hub — autonomous: como semi, mas pode delegar a subagentes do OpenCode.',
        permission: { '*': 'allow', ...BASE, edit: EDICAO_SEMI, bash: bashSemi(), task: 'allow' },
      },
    },
  };
}

/**
 * Grava `opencode.json` no diretório de config do Hub e devolve o diretório,
 * pronto para `OPENCODE_CONFIG_DIR`. Só reescreve quando o conteúdo mudou.
 */
export function prepararConfigDoHub(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const arquivo = path.join(dir, 'opencode.json');
  const conteudo = `${JSON.stringify(configDosAgentesDoHub(), null, 2)}\n`;
  let atual: string | null = null;
  try {
    atual = readFileSync(arquivo, 'utf8');
  } catch {
    atual = null;
  }
  if (atual !== conteudo) writeFileSync(arquivo, conteudo, 'utf8');
  return dir;
}
