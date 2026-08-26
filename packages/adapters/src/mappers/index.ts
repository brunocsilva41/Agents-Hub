import type { EventMapper } from '../types.js';
import { claudeMapper } from './claude.js';
import { codexMapper } from './codex.js';
import { genericJsonMapper, genericTextMapper } from './generic.js';

/**
 * Registro de mappers. O manifesto referencia um destes nomes; quando um agente
 * novo não tem formato conhecido, `generic-text` já entrega uma timeline
 * utilizável (mensagens + fim de turno + erros) sem escrever código.
 */
const MAPPERS: Record<string, EventMapper> = {
  claude: claudeMapper,
  codex: codexMapper,
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

export { claudeMapper, codexMapper, genericJsonMapper, genericTextMapper };
