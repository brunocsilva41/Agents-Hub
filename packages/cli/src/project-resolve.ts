import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { HubClient, ProjectSummary } from './client.js';

/**
 * De "id ou caminho" (ou nada = diretório atual) para o projeto registrado.
 *
 * Mora fora de `main.ts` para ser testável sem disparar `main()` no import.
 *
 * Antes, a busca era igualdade exata de string (`p.path === path.resolve(cwd)`):
 * - rodar `hub start` numa SUBPASTA do projeto (`cd src`, o caso normal) não
 *   casava e caía em `addProject(subpasta)`, que o daemon recusa com
 *   PROJECT_FOLDER_CONFLICT;
 * - no Windows, o mesmo diretório escrito com outra caixa ou pelo nome curto
 *   8.3 (`C:\PROGRA~1`) virava "outro" diretório;
 * - um id `prj_...` digitado errado virava "registre a pasta prj_..." relativa
 *   ao diretório atual.
 */

/** Caminho absoluto com a grafia do disco (nome longo, caixa real) quando existe. */
export function caminhoCanonico(bruto: string): string {
  // `.native` pede ao SO o caminho final: no Windows expande 8.3 e devolve a
  // caixa que está no disco. Sem ele, `C:\PROGRA~1` e `C:\Program Files`
  // continuam duas strings diferentes para o mesmo diretório. Se o caminho
  // não existe, canonicaliza o ancestral mais próximo que existe e reanexa o
  // resto — senão pai (canônico) e filho (cru) nunca se comparariam.
  const absoluto = path.resolve(bruto);
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

/** Chave de comparação: canônica e, no Windows (FS sem caixa), minúscula. */
export function chaveDeCaminho(bruto: string, plataforma: NodeJS.Platform = process.platform): string {
  const canonico = caminhoCanonico(bruto).replace(/[\\/]+$/, '');
  return plataforma === 'win32' ? canonico.toLowerCase() : canonico;
}

/** `filho` é `pai` ou está dentro dele (comparando pelas chaves canônicas). */
export function contemCaminho(pai: string, filho: string, plataforma: NodeJS.Platform = process.platform): boolean {
  const a = chaveDeCaminho(pai, plataforma);
  const b = chaveDeCaminho(filho, plataforma);
  if (a === b) return true;
  const sep = plataforma === 'win32' ? '\\' : path.sep;
  return b.startsWith(a.endsWith(sep) ? a : a + sep);
}

/**
 * O projeto registrado que contém `dir` — o mais específico, se houver
 * aninhamento legado (o daemon hoje recusa pastas sobrepostas).
 */
export function projetoQueContem(projects: readonly ProjectSummary[], dir: string): ProjectSummary | undefined {
  let melhor: ProjectSummary | undefined;
  for (const p of projects) {
    if (!contemCaminho(p.path, dir)) continue;
    if (melhor === undefined || chaveDeCaminho(p.path).length > chaveDeCaminho(melhor.path).length) melhor = p;
  }
  return melhor;
}

/**
 * Projeto por id, por caminho (a pasta ou qualquer subpasta de um projeto
 * registrado) ou, sem nada, pelo diretório atual. Pasta fora de qualquer
 * projeto é registrada na hora — evita o passo cerimonial de "adicione o
 * projeto antes". Id `prj_...` desconhecido é erro, nunca registro.
 */
export async function resolverProjeto(
  client: HubClient,
  flag: string | boolean | undefined,
): Promise<ProjectSummary> {
  if (flag === true) {
    throw new Error('--project precisa de um valor: id (prj_...) ou caminho da pasta');
  }
  const { projects } = await client.projects();

  if (typeof flag === 'string' && /^prj_/i.test(flag)) {
    const porId = projects.find((p) => p.id === flag);
    if (porId) return porId;
    throw new Error(`projeto "${flag}" não encontrado — veja os registrados com: hub projects`);
  }

  const alvo = caminhoCanonico(typeof flag === 'string' ? flag : process.cwd());
  const existente = projetoQueContem(projects, alvo);
  if (existente) return existente;

  const { project } = await client.addProject(alvo);
  return project;
}

export async function resolveProjectId(
  client: HubClient,
  flag: string | boolean | undefined,
): Promise<string> {
  return (await resolverProjeto(client, flag)).id;
}
