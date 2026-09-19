import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { newId, nowIso, type Approval, type Session, type Task } from '@agents-hub/core';
import { createHub, type Hub } from './hub.js';

function pidVivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function aguardarMorte(pid: number, timeoutMs = 10_000): Promise<void> {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    if (!pidVivo(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`pid ${pid} continua vivo depois de ${timeoutMs}ms`);
}

/**
 * Reconciliação de estado na subida do daemon.
 *
 * Uma run só existe dentro de um processo. Sem esta reconciliação, todo crash
 * ou reinício deixava sessões marcadas como `running` para sempre — apareciam
 * vivas no `hub status` e no painel sem nunca progredir.
 */
describe('reconciliação na subida do daemon', () => {
  let hub: Hub;
  let raiz: string;
  let projectId: string;

  before(() => {
    raiz = mkdtempSync(path.join(os.tmpdir(), 'hub-reconcile-'));
    const manifestos = path.join(raiz, 'manifests');
    mkdirSync(manifestos, { recursive: true });

    // Agente cujo binário é o próprio `node`: permite testar a checagem de
    // identidade por nome de imagem (`imagemPareceEsperada`) contra um
    // processo de verdade, sem depender de nenhum CLI de agente instalado.
    writeFileSync(
      path.join(manifestos, 'node-fake.yaml'),
      [
        'id: node-fake',
        'name: Node Fake',
        'bin: node',
        'invoke:',
        '  oneShot: ["--version"]',
      ].join('\n'),
      'utf8',
    );

    // Agente registrado, mas cujo manifesto espera um binário que nunca vai
    // bater com o `node.exe` real usado nos testes de PID reciclado.
    writeFileSync(
      path.join(manifestos, 'wrong-bin.yaml'),
      [
        'id: wrong-bin',
        'name: Wrong Bin',
        'bin: totalmente-outro-binario',
        'invoke:',
        '  oneShot: ["--version"]',
      ].join('\n'),
      'utf8',
    );

    hub = createHub({ home: raiz, manifestsDir: manifestos, webRoot: path.join(raiz, 'sem-web') });
    projectId = hub.sessions.registerProject(raiz, 'projeto-reconcile').id;
  });

  after(async () => {
    await hub.shutdown();
    try {
      rmSync(raiz, { recursive: true, force: true });
    } catch {
      /* limpeza de temp é oportunista */
    }
  });

  function semear(
    state: Session['state'],
    comAprovacaoPendente = false,
    pid: number | null = null,
    agentId = 'fantasma',
    updatedAtOverride?: string,
  ): {
    session: Session;
    task: Task;
  } {
    const sessionId = newId('ses');
    const session: Session = {
      id: sessionId,
      projectId,
      agentId,
      nativeSessionId: null,
      rootId: sessionId,
      parentId: null,
      depth: 0,
      path: [],
      state,
      mode: 'semi',
      isolation: 'none',
      workdir: raiz,
      title: `sessão em ${state}`,
      createdAt: updatedAtOverride ?? nowIso(),
      updatedAt: updatedAtOverride ?? nowIso(),
      endedAt: null,
      pid,
    };

    const task: Task = {
      id: newId('tsk'),
      sessionId,
      requesterSessionId: null,
      brief: { agent: 'fantasma', objective: 'x' } as Task['brief'],
      state: 'working',
      attempts: [],
      result: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    hub.store.sessions.create(session);
    hub.store.tasks.create(task);

    if (comAprovacaoPendente) {
      const approval: Approval = {
        id: newId('apv'),
        sessionId,
        taskId: task.id,
        risk: 'irreversible',
        action: 'algo que precisa da sua decisão',
        detail: {},
        state: 'pending',
        requestedAt: nowIso(),
        resolvedAt: null,
        resolvedBy: null,
      };
      hub.store.approvals.create(approval);
    }

    return { session, task };
  }

  test('sessão marcada como running sem processo por trás é encerrada', async () => {
    const { session, task } = semear('running');

    const resultado = await hub.sessions.reconcileOnStartup();
    assert.ok(resultado.encerradas >= 1);

    assert.equal(hub.store.sessions.get(session.id)?.state, 'killed');
    assert.equal(
      hub.store.tasks.get(task.id)?.state,
      'failed',
      'a task não pode continuar "working" sem ninguém trabalhando nela',
    );
  });

  test('sessão esperando aprovação humana SOBREVIVE ao reinício', async () => {
    const { session, task } = semear('waiting_approval', true);

    const resultado = await hub.sessions.reconcileOnStartup();
    assert.ok(resultado.revividas >= 1);

    assert.equal(
      hub.store.sessions.get(session.id)?.state,
      'waiting_approval',
      'ela não depende de processo nenhum: depende de você',
    );
    assert.equal(hub.store.tasks.get(task.id)?.state, 'working');
  });

  test('sessão em waiting_approval SEM aprovação pendente é órfã e cai', async () => {
    const { session } = semear('waiting_approval', false);

    await hub.sessions.reconcileOnStartup();

    assert.equal(
      hub.store.sessions.get(session.id)?.state,
      'killed',
      'esperar uma aprovação que não existe é esperar para sempre',
    );
  });

  test('sessão já terminada não é tocada', async () => {
    const { session } = semear('completed');
    const antes = hub.store.sessions.get(session.id);

    await hub.sessions.reconcileOnStartup();

    assert.equal(hub.store.sessions.get(session.id)?.state, 'completed');
    assert.equal(hub.store.sessions.get(session.id)?.endedAt, antes?.endedAt);
  });

  test('rodar duas vezes seguidas não muda mais nada', async () => {
    await hub.sessions.reconcileOnStartup();
    const segunda = await hub.sessions.reconcileOnStartup();
    assert.equal(segunda.encerradas, 0, 'a reconciliação precisa ser idempotente');
  });

  describe('matar órfão pelo PID (§08 3.7)', () => {
    test('sessão running com PID de processo vivo do agente esperado: mata a árvore E marca killed', async () => {
      const filho = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
        stdio: 'ignore',
      });
      assert.ok(filho.pid);
      // Só prossegue quando o SO já reconhece o processo — evita corrida com
      // `tasklist` rodando antes do PID existir de verdade.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const { session } = semear('running', false, filho.pid!, 'node-fake');

      const resultado = await hub.sessions.reconcileOnStartup();
      assert.ok(resultado.encerradas >= 1);
      assert.equal(hub.store.sessions.get(session.id)?.state, 'killed');
      assert.equal(hub.store.sessions.get(session.id)?.pid, null);

      await aguardarMorte(filho.pid!);
    });

    test('sessão running com PID que já não existe: reconciliação não lança erro', async () => {
      // Um PID improvável de estar em uso agora.
      const { session } = semear('running', false, 999_999, 'node-fake');

      await assert.doesNotReject(hub.sessions.reconcileOnStartup());
      assert.equal(hub.store.sessions.get(session.id)?.state, 'killed');
    });

    test('PID existe mas pertence a outro binário: reconciliação NÃO mata', async () => {
      // Um processo de verdade, mas registrado sob um agente cujo manifesto
      // espera um binário diferente do que está de fato rodando naquele PID.
      const filho = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
        stdio: 'ignore',
      });
      assert.ok(filho.pid);
      await new Promise((resolve) => setTimeout(resolve, 200));

      try {
        const { session } = semear('running', false, filho.pid!, 'wrong-bin');

        await hub.sessions.reconcileOnStartup();

        assert.equal(hub.store.sessions.get(session.id)?.state, 'killed');
        assert.ok(
          pidVivo(filho.pid!),
          'o processo não deveria ter sido morto: o binário esperado ("totalmente-outro-binario") não bate com o que está de fato vivo no PID ("node")',
        );
      } finally {
        filho.kill();
      }
    });

    // Mitigação de PID reciclado (segunda checagem, além do nome de imagem):
    // só faz sentido no Windows, onde `horarioDeCriacaoDoProcesso` de fato
    // consulta o SO — em POSIX ela sempre devolve `null` e a checagem vira
    // no-op (limitação já documentada e assumida).
    const testeWin32 = process.platform === 'win32' ? test : test.skip;

    testeWin32(
      'PID vivo mas processo nasceu DEPOIS do último registro da sessão: reconciliação NÃO mata (provável PID reciclado)',
      async () => {
        // Sessão gravada como se tivesse sido atualizada pela última vez há uma
        // hora — simula um daemon que crashou há tempo. Um processo real
        // spawnado agora (bem depois desse "último registro") representa o SO
        // tendo devolvido o PID órfão pra outro programa qualquer com o mesmo
        // nome de binário.
        const umaHoraAtras = new Date(Date.now() - 60 * 60 * 1000).toISOString();

        const filho = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
          stdio: 'ignore',
        });
        assert.ok(filho.pid);
        await new Promise((resolve) => setTimeout(resolve, 200));

        try {
          const { session } = semear('running', false, filho.pid!, 'node-fake', umaHoraAtras);

          await hub.sessions.reconcileOnStartup();

          assert.equal(
            hub.store.sessions.get(session.id)?.state,
            'killed',
            'o registro no banco vira killed de qualquer jeito — só o kill do processo é que é abortado',
          );
          assert.ok(
            pidVivo(filho.pid!),
            'o processo não deveria ter sido morto: ele nasceu bem depois do último registro da sessão, sinal de PID reciclado pelo SO',
          );
        } finally {
          filho.kill();
        }
      },
    );
  });
});
