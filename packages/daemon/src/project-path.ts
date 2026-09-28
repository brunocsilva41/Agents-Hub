import { realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HubError } from '@agents-hub/core';

/**
 * Caminho de projeto/pasta vindo de fora (HTTP) antes de virar registro.
 *
 * Antes, `POST /projects {"path": "..."}` aceitava pasta que não existe,
 * arquivo comum e caminho relativo (resolvido contra o diretório em que o
 * DAEMON subiu, que quem chamou não conhece). O projeto nascia apontando
 * para lugar nenhum e só falhava muito depois, no spawn da sessão.
 *
 * Fica na borda HTTP e não em `ProjectRegistry`: o registry é usado
 * direto por testes e rotinas internas com caminhos que o próprio daemon
 * controla; quem não é confiável é o corpo da requisição.
 */
export function validarDiretorioDeProjeto(bruto: unknown, campo = 'path'): string {
  if (typeof bruto !== 'string' || bruto.trim() === '') {
    throw invalido(campo, bruto, 'caminho vazio');
  }
  if (bruto.includes('\0')) {
    throw invalido(campo, bruto, 'caminho contém caractere nulo');
  }
  if (!path.isAbsolute(bruto)) {
    throw invalido(campo, bruto, 'caminho relativo não é aceito — informe o caminho absoluto da pasta');
  }
  // ANTES do `stat`: `\\host\C$` faria o daemon esperar a rede para, no fim,
  // recusar do mesmo jeito.
  const proibida = raizProibida(bruto, SISTEMA_ATUAL);
  if (proibida) throw invalido(campo, bruto, proibida);

  let stat;
  try {
    stat = statSync(bruto);
  } catch {
    throw invalido(campo, bruto, `a pasta "${bruto}" não existe`);
  }
  if (!stat.isDirectory()) {
    throw invalido(campo, bruto, `"${bruto}" não é uma pasta`);
  }
  // De novo na grafia do disco: junction/symlink para `C:\Windows` e nome
  // curto 8.3 (`C:\PROGRA~1`) passariam pela checagem textual acima.
  const real = raizProibida(canonicalizarCaminho(bruto), SISTEMA_ATUAL);
  if (real) throw invalido(campo, bruto, real);
  return bruto;
}

/** O que `raizProibida` precisa saber da máquina — injetável para testar Windows no Linux e vice-versa. */
export interface SistemaDaMaquina {
  plataforma: NodeJS.Platform;
  home: string;
  env: Readonly<Record<string, string | undefined>>;
}

const SISTEMA_ATUAL: SistemaDaMaquina = {
  plataforma: process.platform,
  home: os.homedir(),
  env: process.env,
};

/**
 * Diretórios POSIX de sistema: recusados eles e tudo abaixo. `/usr` e `/var`
 * ficam de fora desta lista e só são recusados EXATOS (`POSIX_EXATOS`):
 * `/var/folders` é o tmpdir do macOS e `/usr/local/src`, `/var/www` guardam
 * projeto de verdade.
 */
const POSIX_ARVORES = [
  '/etc',
  '/bin',
  '/sbin',
  '/boot',
  '/proc',
  '/sys',
  '/dev',
  '/usr/bin',
  '/usr/sbin',
  '/usr/lib',
  '/lib',
  '/lib64',
];
const POSIX_EXATOS = ['/usr', '/var', '/root', '/home', '/Users', '/System', '/Library'];

/**
 * Motivo para recusar `p` como pasta de projeto, ou `null` se é aceitável
 * (R05-10).
 *
 * Projeto é onde o agente escreve (worktree criado a partir dele, ou a própria
 * pasta com `isolation: none`) e é o `workdir` contra o qual o gate decide
 * "escrita dentro do diretório da sessão". Registrar `C:\Windows`, a raiz da
 * unidade ou o home inteiro transforma o sistema (ou tudo do usuário, com
 * `.ssh` e credenciais) em "dentro do projeto". Recusados:
 * - raiz de filesystem/unidade (`/`, `C:\`) e raiz de compartilhamento UNC;
 * - o próprio home (só ele — `~/projetos/x` segue normal);
 * - Windows: `%WINDIR%`/`%SystemRoot%`, Program Files (x64 e x86) e
 *   ProgramData, com tudo abaixo;
 * - compartilhamento administrativo UNC (`\\host\C$`,`ADMIN$`, `IPC$`) — é
 *   a unidade inteira de outra máquina, por qualquer caminho;
 * - POSIX: `POSIX_ARVORES` com tudo abaixo e `POSIX_EXATOS` só na raiz.
 */
export function raizProibida(p: string, sistema: SistemaDaMaquina): string | null {
  const win = sistema.plataforma === 'win32';
  const mod = win ? path.win32 : path.posix;
  // Windows não diferencia caixa; barra final não muda a pasta.
  const norm = (x: string): string => {
    const r = mod.resolve(x);
    const sem = r.length > mod.parse(r).root.length ? r.replace(/[\\/]+$/, '') : r;
    return win ? sem.toLowerCase() : sem;
  };
  const alvo = norm(p);
  const dentro = (pai: string): boolean => {
    const base = norm(pai);
    return alvo === base || alvo.startsWith(base.endsWith(mod.sep) ? base : base + mod.sep);
  };

  if (win && /^[\\/]{2}[^\\/]+[\\/]([a-z]\$|admin\$|ipc\$)([\\/]|$)/i.test(p)) {
    return `"${p}" é um compartilhamento administrativo (a unidade inteira de outra máquina)`;
  }
  if (alvo === norm(mod.parse(alvo).root)) {
    return `"${p}" é a raiz do sistema de arquivos/unidade — escolha a pasta do repositório`;
  }
  if (alvo === norm(sistema.home)) {
    return `"${p}" é o seu home inteiro (com .ssh e credenciais) — escolha a pasta do repositório`;
  }

  const sistemaDirs = win
    ? ['WINDIR', 'SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData']
        .map((k) => sistema.env[k])
        .filter((d): d is string => typeof d === 'string' && d.length > 0 && mod.isAbsolute(d))
    : POSIX_ARVORES;
  const hit = sistemaDirs.find(dentro);
  if (hit) return `"${p}" é diretório do sistema (${hit}) — projeto não pode morar ali`;
  if (!win && POSIX_EXATOS.some((d) => alvo === norm(d))) {
    return `"${p}" é diretório do sistema — escolha a pasta do repositório`;
  }
  return null;
}

/**
 * Caminho de projeto/pasta na grafia do disco, antes de virar registro.
 *
 * No Windows o mesmo diretório tem várias grafias: nome curto 8.3
 * (`C:\PROGRA~1`), outra caixa (`c:\users\...`). Sem canonicalizar, cada grafia
 * virava um projeto novo (com worktrees/contexto próprios) ou um
 * PROJECT_FOLDER_CONFLICT dizendo que a pasta "está DENTRO" dela mesma.
 * `realpathSync.native` pede ao SO o caminho final (expande 8.3, caixa real).
 * Caminho que não existe fica só resolvido — quem valida existência é a borda
 * HTTP (`validarDiretorioDeProjeto`).
 */
export function canonicalizarCaminho(bruto: string): string {
  const absoluto = path.resolve(bruto);
  // Inexistente: canonicaliza o ancestral mais próximo que existe e reanexa o
  // resto, para continuar comparável com as pastas já registradas.
  const resto: string[] = [];
  let atual = absoluto;
  for (;;) {
    try {
      return path.join(realpathSync.native(atual), ...resto.reverse());
    } catch {
      const pai = path.dirname(atual);
      if (pai === atual) return absoluto;
      resto.push(path.basename(atual));
      atual = pai;
    }
  }
}

/** Mesma pasta? Canônica e, no Windows (FS sem caixa), sem diferenciar caixa. */
export function mesmoCaminho(
  a: string,
  b: string,
  plataforma: NodeJS.Platform = process.platform,
): boolean {
  const x = canonicalizarCaminho(a);
  const y = canonicalizarCaminho(b);
  return plataforma === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function invalido(campo: string, valor: unknown, motivo: string): HubError {
  return new HubError('INVALID_PATH', `${campo} inválido: ${motivo}`, {
    campo,
    valor: typeof valor === 'string' ? valor : String(valor),
  });
}
