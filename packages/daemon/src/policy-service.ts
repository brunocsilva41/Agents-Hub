import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseDocument, YAMLMap, type Document } from 'yaml';
import {
  clampedFields,
  DEFAULT_POLICY,
  execFieldsDeclared,
  HubError,
  loosenedFields,
  mergePolicyLayer,
  PartialPolicyDocumentSchema,
  PolicyDocumentSchema,
  type PartialPolicyDocument,
  type PolicyDocument,
  type UnitOfWork,
} from '@agents-hub/core';
import type { HubConfig } from './config.js';
import {
  clearProjectConfigCache,
  loadProjectOverrides,
  mergeProjectPolicy,
  projectConfigPath,
} from './project-config.js';
import { gravarAtomico, gravarComBackup, lerJsonDeConfig } from './safe-write.js';

/**
 * Editor de política (item 1.10 do GOAL): ler e gravar as DUAS camadas que o
 * daemon já usa — a global (`<home>/config.json`, chave `policy`) e a do
 * projeto (`<repo>/.agents-hub/config.yaml`, chave `policy`) — com a mesma
 * validação e o mesmo clamp que valem na hora de decidir.
 *
 * - Camada global: topo da hierarquia, funde livre sobre o padrão. Pode
 *   afrouxar; a resposta lista `loosened` para a tela avisar.
 * - Camada de projeto: só aperta (clamp do item 0.7, `mergeProjectPolicy`).
 *   Gravar um valor mais frouxo é aceito (o arquivo é do repositório e pode
 *   valer em outra máquina com global mais larga), mas a resposta lista em
 *   `clamped` o que NÃO vale aqui, e em `ignoredExecFields` os campos de
 *   execução ignorados por falta de confiança.
 *
 * Validação: `PartialPolicyDocumentSchema.strict()` — campo que não existe em
 * `PolicyDocument` (erro de digitação, típico de edição à mão) é recusado com
 * 422 em vez de gravado e ignorado em silêncio.
 */
const LAYER_SCHEMA = PartialPolicyDocumentSchema.strict();

export interface PolicyLayerView {
  file: string;
  layer: PartialPolicyDocument;
  effective: PolicyDocument;
}

export interface ProjectPolicyView extends PolicyLayerView {
  projectId: string;
  path: string;
  trusted: boolean;
  /** YAML quebrado/inválido: a camada não está valendo (cai na global). */
  error: string | null;
  ignoredExecFields: string[];
  clamped: string[];
}

export interface PolicyView {
  global: PolicyLayerView;
  project: ProjectPolicyView | null;
}

/** Valida uma camada vinda de fora; 422 apontando o campo. */
export function parsePolicyLayer(raw: unknown): PartialPolicyDocument {
  const parsed = LAYER_SCHEMA.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new HubError('INVALID_BRIEF', 'política inválida', {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.') || '(raiz)',
        message: i.message,
      })),
    });
  }
  return parsed.data;
}

const CHAVES_DE_POLITICA = new Set(Object.keys(PolicyDocumentSchema.shape));

export class PolicyService {
  constructor(
    private readonly config: HubConfig,
    private readonly store: Pick<UnitOfWork, 'projects'>,
  ) {}

  get globalFile(): string {
    return path.join(this.config.home, 'config.json');
  }

  /** A camada global como está no disco (sem os padrões). */
  globalLayer(): PartialPolicyDocument {
    const { doc } = lerJsonDeConfig(this.globalFile);
    const bruto = doc['policy'];
    if (bruto === undefined) return {};
    const parsed = PartialPolicyDocumentSchema.safeParse(bruto);
    return parsed.success ? parsed.data : {};
  }

  view(projectId?: string): PolicyView {
    const global: PolicyLayerView = {
      file: this.globalFile,
      layer: this.globalLayer(),
      effective: this.config.policy,
    };
    return { global, project: projectId ? this.#projectView(projectId) : null };
  }

  /**
   * Substitui a camada global inteira por `layer` (com backup versionado do
   * `config.json`) e passa a valer na hora, sem reiniciar o daemon.
   *
   * A política efetiva vira `padrão + camada`. Um override programático
   * passado a `loadConfig` (só testes usam) não sobrevive à edição.
   */
  setGlobalLayer(layer: unknown): {
    view: PolicyView;
    loosened: string[];
    backup: string | null;
  } {
    const validada = parsePolicyLayer(layer);
    const antes = this.config.policy;
    const depois = mergePolicyLayer(DEFAULT_POLICY, validada);

    const { doc } = lerJsonDeConfig(this.globalFile);
    if (Object.keys(validada).length === 0) delete doc['policy'];
    else doc['policy'] = validada;
    mkdirSync(this.config.home, { recursive: true });
    const backup = gravarComBackup(this.globalFile, `${JSON.stringify(doc, null, 2)}\n`);

    // Mesmo objeto de config que SessionManager e servidor leem a cada decisão.
    this.config.policy = depois;
    return { view: this.view(), loosened: loosenedFields(antes, depois), backup };
  }

  /**
   * Prévia de `setGlobalLayer`, sem gravar nada: valida (mesmo 422) e diz o
   * que a nova camada AFROUXARIA em relação ao que vale agora. É o que deixa o
   * painel mostrar "isto afrouxa a política" ANTES de o operador confirmar —
   * depois de gravado o aviso já chega tarde.
   */
  previewGlobalLayer(layer: unknown): { loosened: string[]; effective: PolicyDocument } {
    const validada = parsePolicyLayer(layer);
    const depois = mergePolicyLayer(DEFAULT_POLICY, validada);
    return { loosened: loosenedFields(this.config.policy, depois), effective: depois };
  }

  /**
   * Prévia de `setProjectLayer`, sem gravar: o que o clamp anularia e quais
   * campos de execução seriam ignorados por o projeto não ser confiável.
   */
  previewProjectLayer(
    projectId: string,
    layer: unknown,
  ): { clamped: string[]; ignoredExecFields: string[]; effective: PolicyDocument } {
    const validada = parsePolicyLayer(layer);
    const trusted = this.#project(projectId).trusted === true;
    return {
      clamped: clampedFields(this.config.policy, validada, trusted),
      ignoredExecFields: trusted ? [] : execFieldsDeclared(validada),
      effective: mergeProjectPolicy(this.config.policy, validada, { trusted }),
    };
  }

  /**
   * Substitui o bloco `policy` do `.agents-hub/config.yaml` do projeto,
   * preservando o resto do arquivo (memória, prompts, env e comentários).
   */
  setProjectLayer(projectId: string, layer: unknown): ProjectPolicyView {
    const validada = parsePolicyLayer(layer);
    const project = this.#project(projectId);
    const file = projectConfigPath(project.path);

    let doc: Document;
    if (existsSync(file)) {
      doc = parseDocument(readFileSync(file, 'utf8'));
      if (doc.errors.length > 0) {
        throw new HubError(
          'PROJECT_CONFIG_INVALID',
          `${file} não é YAML válido. Corrija o arquivo antes de salvar a política por aqui — ` +
            'sobrescrevê-lo apagaria o resto da configuração do projeto.',
          { path: file },
        );
      }
      const atual = doc.toJS() as unknown;
      if (atual !== null && typeof atual === 'object' && !Array.isArray(atual)) {
        const chaves = Object.keys(atual);
        // O leitor aceita a política no topo do arquivo quando não há `policy:`.
        // Gravar `policy:` ali mudaria o que vale sem ninguém pedir.
        if (!chaves.includes('policy') && chaves.some((k) => CHAVES_DE_POLITICA.has(k))) {
          throw new HubError(
            'PROJECT_CONFIG_INVALID',
            `${file} declara a política no topo do arquivo. Mova esses campos para dentro de ` +
              '"policy:" antes de editar por aqui.',
            { path: file },
          );
        }
      }
    } else {
      doc = parseDocument('');
      doc.contents = new YAMLMap(doc.schema);
    }

    if (Object.keys(validada).length === 0) doc.delete('policy');
    else doc.set('policy', validada);

    mkdirSync(path.dirname(file), { recursive: true });
    gravarAtomico(file, String(doc));
    clearProjectConfigCache();
    return this.#projectView(projectId);
  }

  #project(projectId: string) {
    const project = this.store.projects.get(projectId);
    if (!project) {
      throw new HubError('PROJECT_NOT_FOUND', `Projeto ${projectId} não encontrado`, { projectId });
    }
    return project;
  }

  #projectView(projectId: string): ProjectPolicyView {
    const project = this.#project(projectId);
    const trusted = project.trusted === true;
    // Camada CRUA (com campos de execução) para exibir/editar o que está no
    // arquivo; `ignoredExecFields` diz o que dela não vale.
    const cru = loadProjectOverrides(project.path, { trusted: true });
    const filtrado = loadProjectOverrides(project.path, { trusted });
    const layer = cru.overrides as PartialPolicyDocument;
    return {
      projectId: project.id,
      path: project.path,
      file: projectConfigPath(project.path),
      trusted,
      error: cru.error,
      ignoredExecFields: filtrado.ignoredExecFields,
      clamped: clampedFields(this.config.policy, layer, trusted),
      layer,
      effective: mergeProjectPolicy(this.config.policy, filtrado.overrides, { trusted }),
    };
  }
}
