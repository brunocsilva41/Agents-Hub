import path from 'node:path';
import { HubError, validarNovaPasta, type Project, type ProjectFolder, type UnitOfWork } from '@agents-hub/core';
import { loadProjectContext, saveProjectContext, type ProjectContext } from './project-config.js';

/**
 * CRUD de projetos e pastas — extraído de `session-manager.ts` (dívida
 * arquitetural do arquivo grande). Fica no daemon, não em `core`, porque
 * depende de `UnitOfWork`/`store` (I/O) e de `project-config.ts` (leitura de
 * arquivo) — não é lógica pura.
 *
 * `SessionManager` mantém os mesmos métodos públicos (`registerProject`,
 * `listProjects`, etc.) como delegações finas para esta classe, então a API
 * que `server.ts`/CLI/MCP já chamam não muda.
 */
export class ProjectRegistry {
  constructor(private readonly store: UnitOfWork) {}

  register(dir: string, name?: string): Project {
    // Formato primeiro, COM O CAMINHO CRU.
    //
    // `path.resolve` transforma "./algo" num absoluto contra o diretório onde o
    // DAEMON subiu — que quem chamou por HTTP não conhece e não escolheu.
    // Resolver antes de validar fazia a checagem de relativo nunca disparar, e
    // um relativo virava silenciosamente uma pasta em lugar nenhum esperado.
    //
    // Lista vazia: aqui só interessam as checagens de formato (vazio, relativo),
    // não a de sobreposição — essa vem depois, e só quando for mesmo criar.
    const formato = validarNovaPasta(dir, []);
    if (!formato.ok) {
      throw new HubError('PROJECT_FOLDER_CONFLICT', formato.motivo, { path: dir });
    }

    const absolute = path.resolve(dir);

    // Idempotência ANTES da checagem de sobreposição, e a ordem importa:
    // registrar o mesmo projeto duas vezes é uso normal (a CLI faz isso a cada
    // `hub start`), e a pasta dele conflita consigo mesma. Validar primeiro
    // fazia a segunda chamada falhar com "esta pasta já pertence ao projeto X"
    // — sendo X o próprio projeto que o chamador queria de volta.
    const existing = this.store.projects.getByPath(absolute);
    if (existing) return existing;

    const veredito = validarNovaPasta(absolute, this.store.projects.allFolders());
    if (!veredito.ok) {
      throw new HubError('PROJECT_FOLDER_CONFLICT', veredito.motivo, { path: absolute });
    }

    const project = this.store.projects.create({
      name: name ?? path.basename(absolute),
      path: absolute,
      defaultBranch: 'main',
    });

    // Todo projeto nasce com uma pasta: a dele. Sem isto, um projeto recém
    // criado não teria onde rodar sessão nenhuma.
    this.store.projects.addFolder({
      projectId: project.id,
      path: absolute,
      label: project.name,
      isPrimary: true,
    });

    return project;
  }

  list(): Project[] {
    return this.store.projects.list();
  }

  /** Projeto por id, ou erro — nunca `null` seguindo adiante em silêncio. */
  get(projectId: string): Project {
    const project = this.store.projects.get(projectId);
    if (!project) {
      throw new HubError('PROJECT_NOT_FOUND', `Projeto ${projectId} não encontrado`, {
        projectId,
      });
    }
    return project;
  }

  /** Memória e prompts do projeto, como estão no arquivo. */
  getContext(projectId: string): ProjectContext {
    return loadProjectContext(this.get(projectId).path).ctx;
  }

  /** Grava memória e prompts, preservando o bloco de política do arquivo. */
  setContext(projectId: string, ctx: ProjectContext): ProjectContext {
    const project = this.get(projectId);
    saveProjectContext(project.path, ctx);
    return loadProjectContext(project.path).ctx;
  }

  listFolders(projectId: string): ProjectFolder[] {
    // Valida a existência para não devolver lista vazia de projeto inexistente,
    // que o chamador leria como "projeto sem pastas".
    this.get(projectId);
    return this.store.projects.listFolders(projectId);
  }

  /**
   * Acrescenta uma pasta ao projeto.
   *
   * É o que torna um "projeto" capaz de cobrir frontend e backend em
   * repositórios separados sem perder a unificação de custo, política e
   * histórico — e sem unir o acesso, porque a sessão continua rodando em uma
   * pasta só.
   */
  addFolder(projectId: string, dir: string, label?: string): ProjectFolder {
    const project = this.get(projectId);

    // Mesma razão de `register`: validar o bruto, resolver depois.
    const veredito = validarNovaPasta(dir, this.store.projects.allFolders());
    if (!veredito.ok) {
      throw new HubError('PROJECT_FOLDER_CONFLICT', veredito.motivo, { path: dir });
    }
    const absolute = path.resolve(dir);

    return this.store.projects.addFolder({
      projectId: project.id,
      path: absolute,
      label: label ?? path.basename(absolute),
      isPrimary: false,
    });
  }

  /**
   * Remove uma pasta do projeto.
   *
   * A principal não sai: ela é a raiz padrão das sessões, e um projeto sem raiz
   * padrão só descobriria o problema na próxima vez que alguém tentasse abrir
   * uma sessão nele.
   */
  removeFolder(projectId: string, folderId: string): void {
    const pastas = this.listFolders(projectId);
    const alvo = pastas.find((f) => f.id === folderId);
    if (!alvo) {
      throw new HubError('FOLDER_NOT_FOUND', `pasta ${folderId} não pertence a este projeto`, {
        projectId,
        folderId,
      });
    }
    if (alvo.isPrimary) {
      throw new HubError(
        'FOLDER_IS_PRIMARY',
        'a pasta principal não pode ser removida; ela é a raiz padrão das sessões deste projeto',
        { projectId, folderId },
      );
    }
    this.store.projects.removeFolder(folderId);
  }
}
