import { spawn } from 'node:child_process';
import type { ValidationOutcome, ValidationPolicy } from '@agents-hub/core';

export interface ValidationContext {
  workdir: string;
  acceptanceCriteria: string[];
}

/**
 * Portão de validação do resultado (ADR 04.3).
 *
 * O que dá para verificar de forma determinística é o comando: build, testes,
 * lint. É barato, é objetivo e pega a falha mais comum — o agente diz que
 * terminou e o projeto não compila.
 *
 * Os critérios de aceite NÃO são checados por texto aqui de propósito.
 * Comparar critério em linguagem natural com um resumo em linguagem natural
 * por heurística produz veredito que parece rigoroso e não é; quem faz isso
 * de verdade é o portão de revisão, que custa uma sessão de modelo e por isso
 * é opt-in. Os critérios seguem no brief da revisão.
 */
export async function runValidation(
  policy: ValidationPolicy,
  ctx: ValidationContext,
): Promise<ValidationOutcome | null> {
  if (!policy.command) return null;

  const check = await runCommandCheck(
    policy.command,
    ctx.workdir,
    policy.commandTimeoutSeconds * 1000,
  );

  return { passed: check.passed, checks: [check] };
}

interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

function runCommandCheck(command: string, cwd: string, timeoutMs: number): Promise<CheckResult> {
  return new Promise((resolve) => {
    // `shell: true` é necessário aqui: o comando vem da configuração do usuário
    // como uma linha só ("npm test -- --run"), não como argv separado.
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const tail: string[] = [];
    const capture = (chunk: Buffer): void => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line.trim().length === 0) continue;
        tail.push(line);
        if (tail.length > 40) tail.shift();
      }
    };

    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    const timer = setTimeout(() => {
      child.kill();
      resolve({
        name: command,
        passed: false,
        detail: `o comando de validação excedeu ${Math.round(timeoutMs / 1000)}s`,
      });
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        name: command,
        passed: false,
        detail: `não foi possível executar: ${err.message}`,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        name: command,
        passed: code === 0,
        // Só as últimas linhas: um log de teste inteiro no payload do evento
        // estoura a timeline e não ajuda a entender o que reprovou.
        detail: code === 0 ? undefined : `saiu com código ${code}: ${tail.slice(-8).join(' | ')}`,
      });
    });
  });
}
