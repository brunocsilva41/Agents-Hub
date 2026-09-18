/**
 * Erros do domínio. Todos carregam um `code` estável — a API HTTP, o MCP server
 * e a CLI traduzem o mesmo código, então a mensagem que você vê é a mesma
 * independente da superfície por onde entrou.
 */
export type HubErrorCode =
  | 'AGENT_NOT_FOUND'
  | 'AGENT_NOT_INSTALLED'
  | 'AGENT_NOT_AUTHENTICATED'
  | 'SESSION_NOT_FOUND'
  | 'TASK_NOT_FOUND'
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_FOLDER_CONFLICT'
  | 'PROJECT_CONFIG_INVALID'
  | 'HUB_CONFIG_INVALID'
  | 'FOLDER_NOT_FOUND'
  | 'FOLDER_IS_PRIMARY'
  | 'INVALID_BRIEF'
  | 'POLICY_DENIED'
  | 'APPROVAL_REQUIRED'
  | 'BUDGET_EXCEEDED'
  | 'DEPTH_EXCEEDED'
  | 'CYCLE_DETECTED'
  | 'CONCURRENCY_EXCEEDED'
  | 'TIMEOUT'
  | 'ADAPTER_FAILURE'
  | 'CAPABILITY_UNRESOLVED'
  | 'ILLEGAL_STATE'
  | 'CODEX_GATE_NOT_GUARANTEED';

export class HubError extends Error {
  readonly code: HubErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: HubErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'HubError';
    this.code = code;
    this.details = details;
  }

  toJSON(): { code: HubErrorCode; message: string; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function isHubError(err: unknown): err is HubError {
  return err instanceof HubError;
}
