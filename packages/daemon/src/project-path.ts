import { statSync } from 'node:fs';
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

function invalido(campo: string, valor: unknown, motivo: string): HubError {
  return new HubError('INVALID_PATH', `${campo} inválido: ${motivo}`, {
    campo,
    valor: typeof valor === 'string' ? valor : String(valor),
  });
}
