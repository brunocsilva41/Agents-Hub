import path from 'node:path';
import {
  HubError,
  validarNovaPasta,
  type Project,
  type ProjectFolder,
  type UnitOfWork,
} from '@agents-hub/core';
import { canonicalizarCaminho, mesmoCaminho } from './project-path.js';
import { loadProjectContext, projectConfigPath, type ProjectContext } from './project-config.js';
import {
  evaluateRepoTrust,
  repoSensitiveContent,
  repoTrustWarning,
  sanitizeHubContext,
  type RepoTrustState,
} from './repo-trust.js';

/** Como está o `.agents-hub/config.yaml` do repositório, para o painel/CLI. */
export interface RepoConfigStatus {
  path: string;
  trust: RepoTrustState;
  /** Campos sensíveis declarados no repositório (ver `RepoTrust.sensitiveFields`). */
  sensitiveFields: string[];
  /** Aviso quando campos do repositório estão sendo ignorados; `null` se nada. */
  warning: string | null;
  /** O contexto declarado no repositório — para revisar ANTES de confiar. */
  context: ProjectContext;
}

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

    // Grafia do disco (8.3 expandido, caixa real): o mesmo diretório escrito
    // de outro jeito não pode virar outro projeto — ver `canonicalizarCaminho`.
    const absolute = canonicalizarCaminho(dir);

    // Idempotência ANTES da checagem de sobreposição, e a ordem importa:
    // registrar o mesmo projeto duas vezes é uso normal (a CLI faz isso a cada
    // `hub start`), e a pasta dele conflita consigo mesma. Validar primeiro
    // fazia a segunda chamada falhar com "esta pasta já pertence ao projeto X"
    // — sendo X o próprio projeto que o chamador queria de volta.
    // Registros antigos podem ter outra grafia (gravados antes da
    // canonicalização): comparar também pela chave, não só pela string exata.
    const existing =
      this.store.projects.getByPath(absolute) ??
      this.store.projects.list().find((p) => mesmoCaminho(p.path, absolute));
    if (existing) return existing;

    const veredito = validarNovaPasta(absolute, this.#pastasCanonicas());
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

  /** Pastas registradas na grafia do disco — registros antigos podem estar em 8.3. */
  #pastasCanonicas(): ProjectFolder[] {
    return this.store.projects.allFolders().map((f) => ({ ...f, path: canonicalizarCaminho(f.path) }));
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

  /**
   * Marca (ou desmarca) o projeto como confiável NESTA máquina.
   *
   * É o único caminho para os campos sensíveis do `.agents-hub/config.yaml`
   * do repositório passarem a valer — `validation.command`/revisão (viram
   * processo), `env` (destino de rede e credenciais), `prompts` e `memory`
   * (instruções ao agente; ver `repo-trust.ts`). O arquivo é versionado — sem confiança explícita,
   * clonar um repo malicioso bastaria para executar código. A marca mora no
   * banco do Hub, fora do repo, então o repositório não consegue se
   * autodeclarar confiável.
   */
  setTrusted(projectId: string, trusted: boolean): Project {
    const project = this.get(projectId);
    // Trust-on-first-use: confia-se no conteúdo sensível DE AGORA (hash). Se o
    // repo mudar `env`/`prompts`/`memory`/`validation.command` depois, a
    // confiança fica suspensa até este comando rodar de novo (`repo-trust.ts`).
    const hash = trusted ? repoSensitiveContent(project.path).contentHash : null;
    const atualizado = this.store.projects.setTrusted(projectId, trusted, hash);
    if (!atualizado) {
      throw new HubError('PROJECT_NOT_FOUND', `Projeto ${projectId} não encontrado`, {
        projectId,
      });
    }
    return atualizado;
  }

  /**
   * Memória, instruções e env que o USUÁRIO configurou pelo Hub (painel,
   * `hub project env|prompt`, `hub import`).
   *
   * Só a camada do Hub — nunca o que veio do repositório. Devolver o efetivo
   * faria o painel/CLI (que leem, editam e gravam de volta o objeto inteiro)
   * "lavar" um `ANTHROPIC_BASE_URL` do repo não confiável para a camada
   * confiável na primeira gravação. O do repositório sai em `repoStatus`.
   */
  getContext(projectId: string): ProjectContext {
    this.get(projectId);
    return this.store.projects.getHubContext(projectId);
  }

  /**
   * Grava o contexto do usuário no banco do Hub — fora do repositório (item
   * 1.9 do GOAL). Antes ia para `<repo>/.agents-hub/config.yaml`, onde ficava
   * indistinguível do que um repo clonado declara.
   */
  setContext(projectId: string, ctx: ProjectContext): ProjectContext {
    this.get(projectId);
    this.store.projects.setHubContext(projectId, sanitizeHubContext(ctx));
    return this.store.projects.getHubContext(projectId);
  }

  /** Estado do `config.yaml` do repositório: confiança, campos sensíveis, aviso. */
  repoStatus(projectId: string): RepoConfigStatus {
    const project = this.get(projectId);
    const trust = evaluateRepoTrust(project);
    return {
      path: projectConfigPath(project.path),
      trust: trust.state,
      sensitiveFields: trust.sensitiveFields,
      warning: repoTrustWarning(project.path, trust),
      context: loadProjectContext(project.path).ctx,
    };
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

    // Mesma razão de `register`: validar o formato do bruto, resolver depois.
    const formato = validarNovaPasta(dir, []);
    if (!formato.ok) {
      throw new HubError('PROJECT_FOLDER_CONFLICT', formato.motivo, { path: dir });
    }
    const absolute = canonicalizarCaminho(dir);
    const veredito = validarNovaPasta(absolute, this.#pastasCanonicas());
    if (!veredito.ok) {
      throw new HubError('PROJECT_FOLDER_CONFLICT', veredito.motivo, { path: absolute });
    }

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
