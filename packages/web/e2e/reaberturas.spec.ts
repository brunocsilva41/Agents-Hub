/**
 * Teste e2e das reaberturas parciais da vistoria (R03-11, R03-06, R04-12,
 * R03-21): fluxos que só dá para provar no navegador — o modal de Nova Sessão
 * que sobrevive ao cadastro de uma pasta, o "ver a sessão" do banner de
 * aprovações que leva à Timeline, a confirmação do "Encerrar" e o teclado no
 * cabeçalho de memória.
 *
 * Contra o servidor falso (servidor-falso.ts): nada de daemon nem agente real.
 */
import { expect, test, type Page } from '@playwright/test';
import { acionarNaTopbar } from './medir';
import {
  ESCRITAS,
  PROJETOS_CRIADOS,
  redefinirCenario,
  subirServidorFalso,
  type ServidorFalso,
} from './servidor-falso';

let servidor: ServidorFalso;

test.beforeAll(async () => {
  servidor = await subirServidorFalso();
});

test.afterAll(async () => {
  redefinirCenario();
  await servidor?.fechar();
});

test.afterEach(() => {
  redefinirCenario();
});

test.use({ viewport: { width: 1440, height: 900 } });

async function abrir(page: Page): Promise<void> {
  await page.goto(servidor.url);
  await expect(page.locator('.topbar')).toBeVisible();
  await expect(page.locator('.approval').first()).toBeVisible();
}

test.describe('R03-11: modal Nova Sessão', () => {
  test('"+ Registrar nova pasta" no meio do modal não perde o que foi digitado', async ({ page }) => {
    await abrir(page);
    await acionarNaTopbar(page, /Nova Sessão/);
    const sessao = page.getByRole('dialog', { name: /Iniciar Nova Sessão/ });
    await sessao.getByLabel('Objetivo da Tarefa').fill('Migrar o build para o Vite 6');
    await sessao.getByLabel(/Critérios de Aceite/).fill('- build verde');
    await sessao.getByLabel(/Teto Orçamentário/).fill('7.5');
    await sessao.getByRole('button', { name: 'Codex CLI' }).click();

    await sessao.getByRole('button', { name: '+ Registrar nova pasta' }).click();
    const projeto = page.getByRole('dialog', { name: 'Registrar Novo Projeto' });
    await expect(projeto).toBeVisible();
    await projeto.getByLabel(/Caminho da Pasta Principal/).fill('C:\\projetos\\delta');
    await projeto.getByRole('button', { name: 'Criar & Vincular Projeto' }).click();
    await expect(projeto).toHaveCount(0);
    expect(PROJETOS_CRIADOS).toHaveLength(1);

    // O modal de sessão continua lá, com tudo o que foi digitado, e aponta
    // para o projeto recém-registrado.
    await expect(sessao).toBeVisible();
    await expect(sessao.getByLabel('Objetivo da Tarefa')).toHaveValue('Migrar o build para o Vite 6');
    await expect(sessao.getByLabel(/Critérios de Aceite/)).toHaveValue('- build verde');
    await expect(sessao.getByLabel(/Teto Orçamentário/)).toHaveValue('7.5');
    await expect(sessao.getByRole('button', { name: 'Codex CLI' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(sessao.getByLabel('Projeto & Pasta')).toHaveValue(PROJETOS_CRIADOS[0]!.id);
    await expect(sessao.getByRole('button', { name: 'Iniciar Sessão' })).toBeEnabled();
    // Sem fundo inerte esquecido: o modal de sessão volta a responder.
    await expect(sessao.locator('xpath=ancestor::*[@inert]')).toHaveCount(0);
  });

  test('agente não instalado vindo pré-selecionado não pode ser enviado', async ({ page }) => {
    // Máquina sem nenhum agente instalado: o modal cai no primeiro da lista,
    // que está ausente. Antes o botão ficava habilitado e a sessão falhava
    // depois, com "binário não encontrado".
    await page.route('**/agents', async (rota) => {
      const resposta = await rota.fetch();
      const corpo = (await resposta.json()) as {
        agents: Array<{ probe: { installed: boolean } | null }>;
      };
      for (const a of corpo.agents) if (a.probe) a.probe.installed = false;
      await rota.fulfill({ response: resposta, json: corpo });
    });
    await abrir(page);
    await acionarNaTopbar(page, /Nova Sessão/);
    const sessao = page.getByRole('dialog', { name: /Iniciar Nova Sessão/ });
    await sessao.getByLabel('Objetivo da Tarefa').fill('Revisar o README do projeto');
    await expect(
      sessao.getByRole('alert').filter({ hasText: /não está instalado nesta máquina/ }),
    ).toBeVisible();
    await expect(sessao.getByRole('button', { name: 'Iniciar Sessão' })).toBeDisabled();
  });

  test('teto 0, negativo ou vazio é recusado com a faixa aceita', async ({ page }) => {
    await abrir(page);
    await acionarNaTopbar(page, /Nova Sessão/);
    const sessao = page.getByRole('dialog', { name: /Iniciar Nova Sessão/ });
    await sessao.getByLabel('Objetivo da Tarefa').fill('Revisar o README do projeto');
    const teto = sessao.getByLabel(/Teto Orçamentário/);
    const iniciar = sessao.getByRole('button', { name: 'Iniciar Sessão' });
    for (const valor of ['0', '-3', '']) {
      await teto.fill(valor);
      await expect(
        sessao.getByRole('alert').filter({ hasText: /US\$ 0\.10 e US\$ 50\.00/ }),
      ).toBeVisible();
      await expect(teto).toHaveAttribute('aria-invalid', 'true');
      await expect(iniciar).toBeDisabled();
    }
    await teto.fill('3');
    await expect(iniciar).toBeEnabled();
    const antes = ESCRITAS.length;
    await iniciar.click();
    await expect.poll(() => ESCRITAS.slice(antes).find((e) => e.path === '/sessions')).toBeTruthy();
    const corpo = ESCRITAS.slice(antes).find((e) => e.path === '/sessions')?.body as {
      brief?: { budget?: { usd?: number } };
    };
    expect(corpo.brief?.budget).toEqual({ usd: 3 });
  });
});

test.describe('R03-06: banner de aprovações', () => {
  test('"ver a sessão" de outra aba leva à Timeline com a sessão parada aberta', async ({ page }) => {
    await abrir(page);
    await acionarNaTopbar(page, /^Swarm/);
    await expect(page.locator('main.tab-view-container')).toBeVisible();
    await page.locator('.approval').first().getByRole('button', { name: 'ver a sessão' }).click();
    const secoes = page.getByRole('navigation', { name: 'Seções' });
    await expect(secoes.getByRole('button', { name: 'Timeline' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.locator('.columns')).toBeVisible();
    await expect(page.locator('.timeline-header .session-title')).toContainText(
      'Rodar a suíte de migração do banco',
    );
  });
});

test.describe('R04-12: confirmação do "Encerrar"', () => {
  test('Encerrar abre a confirmação; "Manter rodando" não encerra; confirmar encerra', async ({
    page,
  }) => {
    await abrir(page);
    await page.locator('.flow-head', { hasText: 'Refatorar' }).first().click();
    const painel = page.locator('.col-right');
    const encerrar = painel.getByRole('button', { name: 'Encerrar', exact: true });
    const cancelamentos = (): number =>
      ESCRITAS.filter((e) => e.path === '/sessions/ses_raiz1/cancel').length;
    const antes = cancelamentos();

    await encerrar.click();
    const confirmacao = painel.getByRole('alertdialog', { name: 'Confirmar encerramento' });
    await expect(confirmacao).toBeVisible();
    await expect(encerrar).toHaveAttribute('aria-expanded', 'true');
    // Abrir a confirmação, por si só, não manda nada ao Hub.
    expect(cancelamentos()).toBe(antes);

    await confirmacao.getByRole('button', { name: 'Manter rodando' }).click();
    await expect(confirmacao).toHaveCount(0);
    await expect(encerrar).toBeEnabled();
    expect(cancelamentos(), '"Manter rodando" não pode encerrar').toBe(antes);

    await encerrar.click();
    await confirmacao.getByRole('button', { name: 'Encerrar sessão' }).click();
    await expect.poll(cancelamentos).toBe(antes + 1);
    await expect(confirmacao).toHaveCount(0);
  });
});
