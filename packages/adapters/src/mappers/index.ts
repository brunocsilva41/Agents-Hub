import type { EventMapper } from '../types.js';
import { antigravityMapper } from './antigravity.js';
import { claudeMapper } from './claude.js';
import { codexMapper } from './codex.js';
import { copilotMapper } from './copilot.js';
import { kimiMapper } from './kimi.js';
import { genericJsonMapper, genericTextMapper } from './generic.js';

/**
 * Registro de mappers. O manifesto referencia um destes nomes; quando um agente
 * novo não tem formato conhecido, `generic-text` já entrega uma timeline
 * utilizável (mensagens + fim de turno + erros) sem escrever código.
 */
const MAPPERS: Record<string, EventMapper> = {
  antigravity: antigravityMapper,
  claude: claudeMapper,
  codex: codexMapper,
  copilot: copilotMapper,
  kimi: kimiMapper,
  'generic-json': genericJsonMapper,
  'generic-text': genericTextMapper,
};

export function resolveMapper(name: string): EventMapper {
  const mapper = MAPPERS[name];
  if (!mapper) {
    throw new Error(
      `Mapper "${name}" não registrado. Disponíveis: ${Object.keys(MAPPERS).join(', ')}`,
    );
  }
  return mapper;
}

export function listMappers(): string[] {
  return Object.keys(MAPPERS);
}

export {
  antigravityMapper,
  claudeMapper,
  codexMapper,
  copilotMapper,
  kimiMapper,
  genericJsonMapper,
  genericTextMapper,
};

