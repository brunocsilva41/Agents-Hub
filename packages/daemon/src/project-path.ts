import { realpathSync, statSync } from 'node:fs';
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
    throw invalido(
      campo,
      bruto,
      'caminho relativo não é aceito — informe o caminho absoluto da pasta',
    );
  }

  let stat;
  try {
    stat = statSync(bruto);
  } catch {
    throw invalido(campo, bruto, `a pasta "${bruto}" não existe`);
  }
  if (!stat.isDirectory()) {
    throw invalido(campo, bruto, `"${bruto}" não é uma pasta`);
  }
  return bruto;
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
export function mesmoCaminho(a: string, b: string, plataforma: NodeJS.Platform = process.platform): boolean {
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
