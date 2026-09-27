import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HubClient } from '@agents-hub/client';
import { ensureDaemon } from './daemon-control.js';
import { flagsDoNodeParaDaemon } from './node-runtime.js';
import { bold, dim, green, red, yellow } from './render.js';

/**
 * `hub autostart enable|disable|status|run` — daemon no ar a partir do login.
 *
 * O autostart "sob demanda" (primeiro comando sobe o daemon) continua sendo o
 * padrão; isto é para quem quer o painel e o MCP server respondendo sem ter
 * rodado nenhum comando desde que ligou a máquina. DESLIGADO até alguém rodar
 * `enable` — gravar item de inicialização é mexer no sistema do usuário.
 *
 * Mecanismo no Windows: um `.vbs` na pasta Inicializar do usuário
 * (`shell:startup`). Escolhido em vez de:
 * - `schtasks /sc onlogon`: exige terminal elevado na maioria das máquinas;
 * - `.cmd` na mesma pasta: abre uma janela de console a cada login;
 * - chave `Run` do registro: invisível para quem procura "o que sobe no login"
 *   pela pasta, e mais difícil de desfazer à mão.
 * O `.vbs` roda oculto (`Run ..., 0`), aparece em Gerenciador de Tarefas >
 * Inicializar, e desligar é apagar um arquivo. Ele chama `hub autostart run`,
 * que usa o mesmo `ensureDaemon` do autostart sob demanda — daemon
 * desacoplado, log em `<home>/logs`, nada novo para aprender quando quebrar.
 * Ressalva: a Microsoft anunciou o VBScript como recurso opcional a ser
 * removido; quando isso acontecer, o `.vbs` deixa de rodar (sem efeito
 * colateral) e este mecanismo precisa trocar — `status` continua dizendo onde
 * o arquivo está.
 */

export const NOME_DO_ITEM = 'agents-hub-daemon.vbs';

/** Pasta Inicializar do usuário (`shell:startup`). `undefined` fora do Windows. */
export function pastaDeInicializacao(
  env: NodeJS.ProcessEnv = process.env,
  plataforma: NodeJS.Platform = process.platform,
): string | undefined {
  if (plataforma !== 'win32') return undefined;
  const appData = env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

/** String VBScript: aspas se escrevem dobradas. */
function vbs(texto: string): string {
  return `"${texto.replace(/"/g, '""')}"`;
}

export interface AlvoDoAutostart {
  node: string;
  entrada: string;
  nodeFlags: string[];
  /** `AGENTS_HUB_HOME`/`AGENTS_HUB_PORT` do momento do `enable`, se definidas. */
  env: Record<string, string>;
}

/**
 * Conteúdo do `.vbs`. Puro, para teste.
 *
 * As variáveis `AGENTS_HUB_HOME`/`AGENTS_HUB_PORT` vão gravadas no script:
 * quem habilitou com um home ou porta próprios espera que o daemon do login
 * use os mesmos, e o processo do login não herda o ambiente do terminal.
 */
export function scriptDeAutostart(alvo: AlvoDoAutostart): string {
  const linhaDeComando = [alvo.node, ...alvo.nodeFlags, alvo.entrada]
    .map((parte) => `"${parte}"`)
    .concat(['autostart', 'run'])
    .join(' ');
  const linhas = [
    "' Agents-Hub: sobe o daemon no login do Windows.",
    "' Criado por `hub autostart enable`. Para desligar: `hub autostart disable` (ou apague este arquivo).",
    'Set sh = CreateObject("WScript.Shell")',
    ...Object.entries(alvo.env).map(
      ([chave, valor]) => `sh.Environment("PROCESS")(${vbs(chave)}) = ${vbs(valor)}`,
    ),
    // 0 = janela oculta; False = não espera (o login não fica pendurado nisto).
    `sh.Run ${vbs(linhaDeComando)}, 0, False`,
    '',
  ];
  return linhas.join('\r\n');
}

/**
 * UTF-16LE com BOM: o Windows Script Host lê `.vbs` sem BOM como ANSI, e um
 * caminho com acento (`C:\Users\João\...`) viraria outro caminho.
 */
function codificarParaWsh(texto: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(texto, 'utf16le')]);
}

function decodificarDoWsh(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  return buf.toString('utf8');
}

export function alvoAtual(env: NodeJS.ProcessEnv = process.env): AlvoDoAutostart {
  const extras: Record<string, string> = {};
  for (const chave of ['AGENTS_HUB_HOME', 'AGENTS_HUB_PORT'] as const) {
    const valor = env[chave];
    if (valor !== undefined && valor.length > 0) extras[chave] = valor;
  }
  return {
    node: process.execPath,
    entrada: fileURLToPath(new URL('./bin.js', import.meta.url)),
    nodeFlags: flagsDoNodeParaDaemon(process.versions.node),
    env: extras,
  };
}

export type EstadoDoAutostart =
  { suportado: false } | { suportado: true; ativo: boolean; arquivo: string; conteudo?: string };

export function estadoDoAutostart(pasta: string | undefined): EstadoDoAutostart {
  if (pasta === undefined) return { suportado: false };
  const arquivo = path.join(pasta, NOME_DO_ITEM);
  if (!existsSync(arquivo)) return { suportado: true, ativo: false, arquivo };
  return { suportado: true, ativo: true, arquivo, conteudo: decodificarDoWsh(readFileSync(arquivo)) };
}

export function habilitarAutostart(pasta: string, alvo: AlvoDoAutostart): string {
  mkdirSync(pasta, { recursive: true });
  const arquivo = path.join(pasta, NOME_DO_ITEM);
  writeFileSync(arquivo, codificarParaWsh(scriptDeAutostart(alvo)));
  return arquivo;
}

export function desabilitarAutostart(pasta: string): { arquivo: string; removido: boolean } {
  const arquivo = path.join(pasta, NOME_DO_ITEM);
  if (!existsSync(arquivo)) return { arquivo, removido: false };
  rmSync(arquivo, { force: true });
  return { arquivo, removido: true };
}

const USO = 'uso: hub autostart [status|enable|disable]';

export async function autostartCommand(
  args: { positional: string[] },
  client: HubClient,
  pasta: string | undefined = pastaDeInicializacao(),
): Promise<void> {
  const sub = args.positional[0] ?? 'status';

  if (sub === 'run') {
    // Chamado pelo item de login, sem terminal: nada na tela, falha no log do
    // daemon (`ensureDaemon` já aponta o arquivo) e no código de saída.
    try {
      await ensureDaemon(client, { quiet: true });
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (sub !== 'status' && sub !== 'enable' && sub !== 'disable') {
    console.error(red(USO));
    process.exitCode = 1;
    return;
  }

  if (pasta === undefined) {
    if (sub === 'status') {
      console.log(dim('autostart no login: só implementado no Windows.'));
      return;
    }
    console.error(
      red('autostart no login: só implementado no Windows.'),
      dim(
        'em outro sistema, registre `hub autostart run` no gerenciador de sessão (systemd --user, launchd).',
      ),
    );
    process.exitCode = 1;
    return;
  }

  if (sub === 'enable') {
    const arquivo = habilitarAutostart(pasta, alvoAtual());
    console.log(`${green('✓')} o daemon vai subir no próximo login`);
    console.log(`   ${dim(arquivo)}`);
    console.log(dim('para desligar: hub autostart disable'));
    return;
  }

  if (sub === 'disable') {
    const { arquivo, removido } = desabilitarAutostart(pasta);
    console.log(
      removido
        ? `${green('✓')} autostart no login desligado`
        : dim('autostart no login já estava desligado'),
    );
    console.log(`   ${dim(arquivo)}`);
    return;
  }

  const estado = estadoDoAutostart(pasta);
  if (!estado.suportado) return;
  if (!estado.ativo) {
    console.log(`${dim('○')} autostart no login ${dim('desligado')}`);
    console.log(`   ${dim(estado.arquivo)}`);
    console.log(`\n${dim('para ligar:')} ${bold('hub autostart enable')}`);
    return;
  }
  console.log(`${green('✓')} autostart no login ${green('ligado')}`);
  console.log(`   ${dim(estado.arquivo)}`);
  const entrada = alvoAtual().entrada;
  if (estado.conteudo !== undefined && !estado.conteudo.includes(entrada)) {
    // Habilitado de outro clone/instalação: o item de login aponta para um
    // `hub` que pode nem existir mais.
    console.log(
      `   ${yellow('⚠')} ${dim('aponta para outra instalação do hub — rode `hub autostart enable` de novo para atualizar')}`,
    );
  }
}
