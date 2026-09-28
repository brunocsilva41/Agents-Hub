import path from 'node:path';
import { TIMEOUT_DO_HOOK_SEC } from './pretool-gate.js';

/**
 * Registro do gate pré-execução na config do agente — a parte pura.
 *
 * Morava em `packages/cli/src/hooks-install.ts`; veio para o daemon porque o
 * painel também precisa saber se o hook está instalado (e com timeout antigo)
 * e oferecer a instalação com prévia (item 6.12 do GOAL). A CLI reexporta
 * daqui: uma regra só para "o que conta como o hook do Hub".
 *
 * Contrato confirmado empiricamente contra o binário do Claude Code:
 * `hooks.PreToolUse[] = { matcher: <regex>, hooks: [{ type, command, timeout }] }`.
 */

/**
 * As ferramentas que carregam risco — e as de leitura que podem ler segredo.
 *
 * `Read` e `Grep` entraram depois (decisão de 2026-09-28): sem elas, ler
 * `~/.ssh/id_rsa` pela ferramenta de leitura passava longe do gate, enquanto o
 * mesmo `cat` pelo shell parava. O custo que antes justificava deixá-las de
 * fora (um processo Node por leitura, mais a ida ao daemon) caiu para o caso
 * comum: o hook libera sozinho a leitura que não toca segredo
 * (`leituraComum` em `pretool-gate.ts`) e só consulta o daemon no resto. A
 * latência medida está em SECURITY.md, seção do gate.
 *
 * `Glob` continua de fora: ele devolve NOMES de arquivo, não conteúdo, e ler
 * qualquer arquivo que ele encontre passa por `Read` — que agora é gateado.
 * Gatear `Glob` pagaria o processo por listagem sem proteger nenhum byte de
 * segredo.
 */
export const FERRAMENTAS_DE_LEITURA_NO_GATE = ['Read', 'Grep'] as const;

export const MATCHER_DE_RISCO = [
  'Bash',
  'PowerShell',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  ...FERRAMENTAS_DE_LEITURA_NO_GATE,
].join('|');

/**
 * O comando é nosso? Instalações anteriores gravaram `main.js" hook`; as novas,
 * `bin.js" hook` (entrada leve, item 5.7). Reconhecer as duas é o que faz
 * reinstalar SUBSTITUIR a entrada antiga em vez de deixar duas (e o hook rodar
 * duas vezes).
 */
export function comandoDoHub(command: string | undefined): boolean {
  return command !== undefined && /(?:main|bin)\.js" hook\b/.test(command);
}

export interface AlvoDeHook {
  id: string;
  nome: string;
  /** Config de usuário: vale para todas as sessões daquele agente. */
  configUsuario: string;
  /** Config por projeto, quando o agente suporta. */
  configProjeto?: (projectPath: string) => string;
  nota: string;
  /**
   * Sessões SUBIDAS PELO HUB já são gateadas sem depender deste arquivo: o Hub
   * injeta o hook por sessão (`--settings`, ver `session-settings.ts` e
   * `gate.settingsArgs` no manifesto). O hook no arquivo do usuário só
   * acrescenta cobertura às sessões abertas FORA do Hub.
   */
  gateNasSessoesDoHub: boolean;
}

/** Frase única para CLI/painel: o que o hook no arquivo muda quando o Hub já injeta o gate. */
export const NOTA_GATE_POR_SESSAO =
  'sessões iniciadas pelo Hub são sempre gateadas (hook injetado por --settings a cada sessão); ' +
  'instalar o hook no arquivo só estende o gate às sessões abertas fora do Hub';

/** Tabela de alvos para um diretório home (injetável, para teste). */
export function hookTargets(home: string): AlvoDeHook[] {
  return [
    {
      id: 'claude',
      nome: 'Claude Code',
      configUsuario: path.join(home, '.claude', 'settings.json'),
      configProjeto: (p) => path.join(p, '.claude', 'settings.json'),
      nota: 'o hook é consultado antes de cada Bash/Write/Edit/Read/Grep e pode bloquear a chamada (leitura comum é liberada no próprio hook)',
      gateNasSessoesDoHub: true,
    },
    {
      id: 'openclaude',
      nome: 'OpenClaude (fork do Claude Code)',
      configUsuario: path.join(home, '.openclaude', 'settings.json'),
      configProjeto: (p) => path.join(p, '.openclaude', 'settings.json'),
      // PARCIALMENTE VERIFICADO em 2026-09-18 (verificação de MCP_TARGETS desta
      // sessão, bônus barato no mesmo caminho): `~/.openclaude/settings.json`
      // EXISTE de verdade nesta máquina e tem chave `hooks` de nível raiz com
      // `PreToolUse`/`SessionStart`, cada entrada `{ hooks: [{ type: "command",
      // command, ... }] }` — o MESMO formato do Claude Code, confirmado por
      // leitura direta do arquivo, não por suposição. O que NÃO foi verificado
      // nesta passagem: se o openclaude CONSULTA esse hook antes de cada
      // Bash/Write/Edit (comportamento em runtime), se `AGENTS_HUB_SESSION_ID`
      // chega no processo do hook, e se o dialeto de resposta é o do Claude
      // (`escalate`/`ask`) ou o oposto do Codex (`toCodexHookOutput`) — só o
      // schema estático do arquivo de config foi conferido.
      nota: 'caminho e schema (hooks.PreToolUse) confirmados no disco desta máquina; comportamento em runtime (se o binário consulta o hook e com que dialeto) ainda não foi exercido',
      // `--settings <file-or-json>` confirmado no `openclaude --help` 0.14.0.
      gateNasSessoesDoHub: true,
    },
  ];
}

/**
 * `node <caminho> hook` em vez de `hub hook`: um PATH diferente no ambiente do
 * agente faria o hook falhar em silêncio, e falha de hook é falha aberta.
 */
export function comandoDoHook(nodeBin: string, cliMain: string): string {
  return `"${nodeBin}" "${cliMain}" hook`;
}

export interface EntradaDeHook {
  matcher: string;
  hooks: Array<{ type: string; command: string; timeout?: number }>;
}

function entradasPreToolUse(config: Record<string, unknown>): EntradaDeHook[] {
  const hooks = (config['hooks'] ?? {}) as Record<string, unknown>;
  return Array.isArray(hooks['PreToolUse']) ? (hooks['PreToolUse'] as EntradaDeHook[]) : [];
}

/**
 * Funde a nossa entrada preservando o que já existe.
 *
 * Sobrescrever `hooks.PreToolUse` inteiro apagaria hooks que a pessoa
 * configurou antes — e ela só descobriria quando algo parasse de acontecer.
 */
export function mergeHooks(atual: Record<string, unknown>, comando: string): Record<string, unknown> {
  const hooks = (atual['hooks'] ?? {}) as Record<string, unknown>;
  const semONosso = entradasPreToolUse(atual).filter(
    (entrada) => !entrada.hooks?.some((h) => comandoDoHub(h.command)),
  );

  // Timeout MAIOR que a espera do daemon por aprovação humana. Era 10 s contra
  // 60 s: o Claude desistia do hook e rodava a ferramenta antes de qualquer
  // pessoa decidir. Reinstalar (`hub hooks install claude --write`) regrava a
  // entrada com o valor novo — ver os três relógios em `pretool-gate.ts`.
  const nossa: EntradaDeHook = {
    matcher: MATCHER_DE_RISCO,
    hooks: [{ type: 'command', command: comando, timeout: TIMEOUT_DO_HOOK_SEC }],
  };

  return {
    ...atual,
    hooks: { ...hooks, PreToolUse: [...semONosso, nossa] },
  };
}

export function hookInstalado(config: Record<string, unknown>): boolean {
  return entradasPreToolUse(config).some((e) => e.hooks?.some((h) => comandoDoHub(h.command)));
}

/**
 * O matcher gravado alcança a ferramenta? O Claude trata o matcher como regex
 * (ou `*`/vazio para todas); casar a string inteira evita que `ReadX` conte.
 */
function matcherCobre(matcher: string | undefined, ferramenta: string): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(ferramenta);
  } catch {
    // Matcher que nem compila não cobre nada que dê para afirmar.
    return false;
  }
}

/**
 * Hook do Hub instalado de um jeito antigo que deixa buraco no gate. Dois
 * casos, mesmo remédio (reinstalar com `hub hooks install claude --write`):
 *
 * - **timeout** menor que o atual, ou ausente. Instalações anteriores gravaram
 *   `timeout: 10`, e com isso a ação que pedia aprovação humana RODAVA depois
 *   de 10 s sem resposta.
 * - **matcher** sem `Read`/`Grep`. Instalações anteriores a 2026-09-28 só
 *   gateavam shell/escrita/rede: ler um segredo pela ferramenta de leitura
 *   passava direto.
 *
 * Devolve `null` quando está tudo certo ou quando o hook nem está instalado.
 * (O nome ficou do primeiro caso; quem chama só mostra o texto.)
 */
export function avisoDeTimeoutDoHook(config: Record<string, unknown>): string | null {
  const nossas = entradasPreToolUse(config).filter((e) =>
    (e.hooks ?? []).some((h) => comandoDoHub(h.command)),
  );
  if (nossas.length === 0) return null;
  const nossos = nossas.flatMap((e) => (e.hooks ?? []).filter((h) => comandoDoHub(h.command)));

  const avisos: string[] = [];
  const velho = nossos.find((h) => typeof h.timeout !== 'number' || h.timeout < TIMEOUT_DO_HOOK_SEC);
  if (velho) {
    avisos.push(
      `hook do gate instalado com timeout ${velho.timeout ?? 'ausente'}${typeof velho.timeout === 'number' ? ' s' : ''} ` +
        `(precisa de ${TIMEOUT_DO_HOOK_SEC} s): ação que pede aprovação roda sem ela quando o agente desiste do hook`,
    );
  }
  // Basta UMA das nossas entradas cobrir a ferramenta: é o que o agente faz.
  const faltando = FERRAMENTAS_DE_LEITURA_NO_GATE.filter(
    (f) => !nossas.some((e) => matcherCobre(e.matcher, f)),
  );
  if (faltando.length > 0) {
    avisos.push(
      `hook do gate instalado com matcher antigo, sem ${faltando.join('/')}: ` +
        'ler segredo (~/.ssh, .env, credenciais) pela ferramenta de leitura passa sem o gate',
    );
  }
  return avisos.length > 0 ? avisos.join('; ') : null;
}
