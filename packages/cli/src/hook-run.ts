import { decideToolCall, leituraComumDoHook, lerStdin, type HookInput } from './hook.js';

/**
 * `hub hook`: a resposta ao hook `PreToolUse` do agente.
 *
 * Mora fora de `main.ts` de propósito: `bin.ts` chama isto direto, sem
 * carregar `main.ts` — que importa o índice do daemon (store/`node:sqlite`,
 * adapters, servidor HTTP). O hook roda a cada Bash/Edit/Write do agente, e
 * esse import custava ~0,5 s por chamada e um `ExperimentalWarning` no stderr.
 * Aqui entram só a config (`@agents-hub/daemon/config`), o cliente HTTP e a
 * tradução de ferramenta em ação (`@agents-hub/daemon/pretool-gate`) — e a
 * config só depois de a leitura comum ter saído pelo caminho rápido.
 */

/** Só as flags que o hook entende; `--chave valor` e `--chave=valor`. */
export function flagsDoHook(argv: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? '';
    if (!token.startsWith('--')) continue;
    const igual = token.indexOf('=');
    if (igual > 2) {
      flags[token.slice(2, igual)] = token.slice(igual + 1);
      continue;
    }
    const proximo = argv[i + 1];
    if (proximo !== undefined && !proximo.startsWith('--')) {
      flags[token.slice(2)] = proximo;
      i += 1;
    } else {
      flags[token.slice(2)] = true;
    }
  }
  return flags;
}

/**
 * Responde ao hook do agente. Silencioso por construção: qualquer coisa fora do
 * JSON no stdout confunde quem está lendo a resposta.
 */
export async function runHook(args: { flags: Record<string, string | boolean> }): Promise<void> {
  // O dialeto é DECLARADO por quem instala o hook, nunca farejado do payload.
  // Codex e Claude mandam entrada quase idêntica e esperam saídas opostas para
  // "permitir"; adivinhar por formato daria um erro silencioso no dia em que os
  // dois payloads convergirem — e o erro cairia justamente no caminho feliz.
  const dialeto = args.flags['dialect'] === 'codex' ? 'codex' : 'claude';

  let entrada: HookInput = {};
  try {
    const bruto = await lerStdin();
    entrada = bruto.trim().length > 0 ? (JSON.parse(bruto) as HookInput) : {};
  } catch {
    // stdin ilegível não pode virar bloqueio: o agente ficaria travado.
    entrada = {};
  }

  // Leitura comum responde antes de carregar a config: o módulo dela puxa o
  // zod, e isso era a maior parte do custo do hook medido para `Read`.
  if (leituraComumDoHook(entrada)) {
    process.stdout.write('', () => process.exit(0));
    return;
  }

  const { baseUrl, loadConfig } = await import('@agents-hub/daemon/config');
  // Config ilegível não derruba o hook: cai no endereço padrão, e o modo de
  // falha (fechado numa sessão do Hub) decide se o daemon não atender.
  let url = 'http://127.0.0.1:4747';
  let failMode: 'open' | 'closed' | undefined;
  try {
    const config = loadConfig();
    url = baseUrl(config);
    failMode = config.gate?.failMode;
  } catch {
    // mantém os padrões acima
  }

  // Claude recebe o id no ambiente; Codex, no próprio comando (`--session`),
  // porque ele só repassa variáveis `CODEX_*` ao hook.
  const sessaoNoComando = args.flags['session'];
  const sessionId =
    typeof sessaoNoComando === 'string' ? sessaoNoComando : process.env['AGENTS_HUB_SESSION_ID'];

  const { saida, codigo } = await decideToolCall(entrada, url, dialeto, { sessionId, failMode });
  // Sai assim que a resposta estiver escrita: se o teto do hook estourou, o
  // `fetch` ao daemon ainda está pendurado e seguraria o processo — e o agente
  // só lê a resposta quando o hook termina.
  process.exitCode = codigo;
  process.stdout.write(saida, () => process.exit(codigo));
}
