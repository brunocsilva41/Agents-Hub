/* ------------------------------------------------------------------------ */
/* Integrações por agente: hook do gate e MCP (item 6.12)                    */
/* ------------------------------------------------------------------------ */

export interface HookStatusSummary {
  /** `arquivo`: hook na config do agente; `codex-inline`: montado a cada invocação. */
  modo: 'arquivo' | 'codex-inline' | 'nenhum';
  arquivo: string | null;
  instalado: boolean;
  /** Hook do Hub com timeout antigo: ação que pede aprovação roda sem ela. */
  avisoTimeout: string | null;
  erro: string | null;
  nota: string;
  comando: string | null;
  instalavelPeloPainel: boolean;
}

export interface McpStatusSummary {
  arquivo: string | null;
  precisaDeProjeto: boolean;
  formato: string;
  verificado: boolean;
  nota: string | null;
  registrado: boolean;
  atualizado: boolean;
  erro: string | null;
  comando: string;
}

export interface IntegrationSummary {
  agentId: string;
  hook: HookStatusSummary;
  mcp: McpStatusSummary | null;
}

export interface IntegrationEntrypoints {
  cli: string;
  mcp: string;
  cliExiste: boolean;
  mcpExiste: boolean;
}

export interface DiffLine {
  tipo: '+' | '-' | ' ' | '@';
  texto: string;
}

export interface IntegrationPlan {
  agentId: string;
  tipo: 'hook' | 'mcp';
  arquivo: string;
  acao: 'criar' | 'atualizar' | 'nada';
  diff: DiffLine[];
  avisos: string[];
  /** Hash do arquivo visto na prévia; devolvido para gravar. */
  base: string;
}
