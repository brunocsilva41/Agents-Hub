/**
 * Registro de projeto em etapas que podem ser RETOMADAS.
 *
 * O modal "Registrar Novo Projeto" faz três coisas: cria o projeto, vincula as
 * pastas extras e grava as diretrizes. Se uma pasta extra falhava, o modal
 * mostrava o erro e ficava aberto — mas o projeto JÁ existia, a lista do
 * painel não era atualizada, e "tentar de novo" chamava `addProject` outra vez
 * (projeto duplicado) e reenviava as pastas que já tinham entrado (vistoria
 * 2026-09-25, 03, MÉDIO). Aqui o progresso é lembrado entre as tentativas: a
 * segunda só faz o que falta.
 */

export interface FormularioDeProjeto {
  caminho: string;
  nome: string;
  /** Pastas extras, uma por item (já sem vazias). */
  extras: readonly string[];
  diretrizes: string;
}

export interface ProgressoDoRegistro {
  /** Projeto já criado nesta abertura do modal (não criar de novo). */
  projectId: string | null;
  /** Pastas extras já vinculadas com sucesso. */
  pastasVinculadas: readonly string[];
  /** Texto das diretrizes que já foi gravado (outro texto grava de novo). */
  diretrizesGravadas: string | null;
}

export const PROGRESSO_INICIAL: ProgressoDoRegistro = {
  projectId: null,
  pastasVinculadas: [],
  diretrizesGravadas: null,
};

export interface OperacoesDoRegistro {
  criarProjeto: (caminho: string, nome: string) => Promise<{ id: string }>;
  vincularPasta: (projectId: string, pasta: string) => Promise<unknown>;
  gravarDiretrizes: (projectId: string, texto: string) => Promise<unknown>;
}

export interface ResultadoDoRegistro {
  progresso: ProgressoDoRegistro;
  /** Pastas recusadas nesta tentativa, com o motivo. */
  recusadas: Array<{ pasta: string; motivo: string }>;
  /** Falha ao gravar as diretrizes nesta tentativa (o projeto existe). */
  erroDiretrizes: string | null;
  /** Tudo feito: o modal pode fechar. */
  completo: boolean;
}

function mensagem(err: unknown, padrao: string): string {
  return err instanceof Error && err.message ? err.message : padrao;
}

/**
 * Executa o que falta. Se CRIAR o projeto falha, a exceção sobe (nada foi
 * feito, e o erro é do caminho principal). Depois que o projeto existe, falha
 * de pasta ou de diretrizes NÃO sobe: vira resultado parcial, com o progresso
 * para a próxima tentativa.
 */
export async function registrarProjeto(
  form: FormularioDeProjeto,
  anterior: ProgressoDoRegistro,
  ops: OperacoesDoRegistro,
): Promise<ResultadoDoRegistro> {
  let projectId = anterior.projectId;
  if (projectId === null) {
    ({ id: projectId } = await ops.criarProjeto(form.caminho, form.nome));
  }

  const vinculadas = [...anterior.pastasVinculadas];
  const recusadas: ResultadoDoRegistro['recusadas'] = [];
  for (const pasta of form.extras) {
    if (vinculadas.includes(pasta)) continue;
    try {
      await ops.vincularPasta(projectId, pasta);
      vinculadas.push(pasta);
    } catch (err) {
      // Sobreposição e caminho relativo são recusas legítimas, e o daemon
      // explica o motivo. Junta para mostrar de uma vez, em vez de abortar na
      // primeira e deixar as outras sem tentativa.
      recusadas.push({ pasta, motivo: mensagem(err, 'recusada') });
    }
  }

  let diretrizesGravadas = anterior.diretrizesGravadas;
  let erroDiretrizes: string | null = null;
  const texto = form.diretrizes.trim();
  if (texto !== '' && texto !== diretrizesGravadas) {
    try {
      await ops.gravarDiretrizes(projectId, texto);
      diretrizesGravadas = texto;
    } catch (err) {
      erroDiretrizes = mensagem(err, 'falha ao gravar');
    }
  }

  return {
    progresso: { projectId, pastasVinculadas: vinculadas, diretrizesGravadas },
    recusadas,
    erroDiretrizes,
    completo: recusadas.length === 0 && erroDiretrizes === null,
  };
}

/** Texto do aviso de registro parcial (o projeto existe; falta o resto). */
export function avisoDeRegistroParcial(r: ResultadoDoRegistro): string | null {
  if (r.completo) return null;
  const partes: string[] = [];
  if (r.recusadas.length > 0) {
    partes.push(
      `${r.recusadas.length} pasta(s) não foram vinculadas: ` +
        r.recusadas.map((x) => `${x.pasta} — ${x.motivo}`).join(' | '),
    );
  }
  if (r.erroDiretrizes) partes.push(`as diretrizes não foram gravadas: ${r.erroDiretrizes}`);
  return `Projeto criado, mas ${partes.join('; ')}. Corrija e clique em "Concluir" para tentar só o que falta.`;
}
