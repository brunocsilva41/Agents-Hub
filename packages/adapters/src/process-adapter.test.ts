import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { clearBinCache } from './bin-resolver.js';
import { ProcessAgentAdapter } from './process-adapter.js';
import { AgentManifestSchema } from './types.js';

/**
 * `{{promptFile}}` grava o Brief em `os.tmpdir()/agents-hub/prompts/` porque
 * alguns CLIs não leem prompt de stdin e um prompt multilinha como argumento
 * de linha de comando quebra no Windows. Antes desta correção o arquivo nunca
 * era apagado — cada spawn (timestamp único, nunca reaproveitado) deixava um
 * arquivo pra sempre em disco. Este teste prova que o arquivo é removido
 * assim que a run termina, sem esperar nenhum coletor periódico.
 */

const PROMPT_DIR = path.join(os.tmpdir(), 'agents-hub', 'prompts');

function manifestComPromptFile() {
  return AgentManifestSchema.parse({
    id: 'fake-promptfile',
    name: 'Fake PromptFile Agent',
    bin: 'node', // resolvível no PATH do próprio runner de teste
    invoke: {
      // Ignora o conteúdo do arquivo de propósito: o teste cobre o CICLO DE
      // VIDA do arquivo, não o parsing do CLI real.
      oneShot: ['-e', 'process.exit(0)', '{{promptFile}}'],
    },
  });
}

before(() => {
  clearBinCache();
});

after(() => {
  clearBinCache();
});

test('o arquivo de {{promptFile}} some depois que a run termina', async () => {
  const adapter = new ProcessAgentAdapter(manifestComPromptFile());

  const handle = await adapter.start(
    {
      sessionId: 'ses-promptfile-teste',
      taskId: null,
      agentId: 'fake-promptfile',
      workdir: process.cwd(),
      mode: 'autonomous',
      env: {},
      timeoutSeconds: 30,
      heartbeatSeconds: 30,
    },
    'prompt de teste — nada de especial aqui',
  );

  // Enquanto a run está viva, o arquivo tem que existir — é o que o CLI real
  // leria por trás do `{{promptFile}}`.
  const antesDoFim = existsSync(PROMPT_DIR)
    ? readdirSync(PROMPT_DIR).filter((f) => f.startsWith('ses-promptfile-teste-'))
    : [];
  assert.equal(antesDoFim.length, 1, 'o prompt precisa existir enquanto o processo roda');

  await handle.done;

  const depoisDoFim = existsSync(PROMPT_DIR)
    ? readdirSync(PROMPT_DIR).filter((f) => f.startsWith('ses-promptfile-teste-'))
    : [];
  assert.equal(
    depoisDoFim.length,
    0,
    'o prompt não pode sobreviver ao fim da run — sem isto, tmpdir cresce um arquivo por spawn, para sempre',
  );
});
