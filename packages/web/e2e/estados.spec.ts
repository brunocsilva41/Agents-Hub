/**
 * Teste e2e dos estados honestos do painel (vistoria 2026-09-25, 03):
 * carregando / falhou / vazio em TODA aba e painel, sempre com a ação que
 * resolve ("Tentar de novo", "Nova sessão", "Ver todos"); e os achados menores
 * de interação que só dá para ver no navegador — fluxo selecionado recolhível
 * (R03-24), botão que não se mexe no hover (R03-25), atalho "/" com modal
 * aberto (R03-28), registro de projeto retomável (R03-12), filtro de projeto e
 * custo por nó no DAG, custo por agente na Telemetria (R03-27).
 *
 * O servidor falso (servidor-falso.ts) liga 500 ou listas vazias por rota via
 * `CENARIO`; nada de daemon nem agente real.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { acionarNaTopbar, problemasDeLayout, VIEWPORTS } from './medir';
import {
  CENARIO,
  PASTAS_VINCULADAS,
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

async function abrir(page: Page): Promise<void> {
  await page.goto(servidor.url);
  await expect(page.locator('.topbar')).toBeVisible();
}

/** Alerta de falha com o texto e um "tentar de novo" dentro dele. */
function alertaCom(page: Page | Locator, texto: string | RegExp): Locator {
  return page.getByRole('alert').filter({ hasText: texto });
}

async function tentarDeNovoEm(page: Page | Locator, texto: string | RegExp): Promise<void> {
  const alerta = alertaCom(page, texto).first();
  await expect(alerta).toBeVisible();
  await alerta.getByRole('button', { name: /tentar de novo/i }).click();
}

test.describe('falha 500 por tela (1440px)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('/sessions 500: lista, timeline, DAG, Telemetria e Operação dizem que FALHOU; tentar de novo recupera', async ({
    page,
  }) => {
    CENARIO.falhar = /^\/sessions$/;
    await abrir(page);
    const naLista = page
      .locator('#coluna-fluxos')
      .getByRole('alert')
      .filter({ hasText: 'Não foi possível carregar as sessões' });
    await expect(naLista).toBeVisible();
    await expect(naLista).toContainText('falha simulada');
    await expect(page.locator('#coluna-fluxos')).not.toContainText('Nenhum fluxo');
    await expect(page.locator('.col-center').getByRole('alert')).toContainText(
      'Não foi possível carregar as sessões',
    );
    // Banner global também nomeia o recurso e tem a ação.
    await expect(page.locator('.app-error-banner')).toContainText('sessões:');
    await expect(
      page.locator('.app-error-banner').getByRole('button', { name: 'Tentar de novo' }),
    ).toBeVisible();

    await acionarNaTopbar(page, /^Grafo DAG/);
    await expect(alertaCom(page, 'Não foi possível carregar as sessões')).toBeVisible();
    await expect(page.locator('main.tab-view-container')).not.toContainText('Nenhum fluxo');

    await acionarNaTopbar(page, /^Telemetria/);
    await expect(alertaCom(page, 'Não foi possível carregar as sessões')).toBeVisible();
    await expect(page.locator('.kpi-grid')).toHaveCount(0);

    await acionarNaTopbar(page, /^Operação/);
    await expect(alertaCom(page, 'Não foi possível carregar as sessões')).toBeVisible();

    CENARIO.falhar = null;
    await acionarNaTopbar(page, /^Timeline/);
    await tentarDeNovoEm(page.locator('#coluna-fluxos'), 'Não foi possível carregar as sessões');
    await expect(page.locator('.flow-head').first()).toBeVisible();
    await expect(page.locator('.app-error-banner')).toHaveCount(0);
  });

  test('/agents 500: Swarm e Configurações avisam; nada de "0 de 0 agentes"', async ({ page }) => {
    CENARIO.falhar = /^\/agents$/;
    await abrir(page);
    await expect(page.locator('.flow-head').first()).toBeVisible();
    await acionarNaTopbar(page, /^Swarm/);
    await expect(alertaCom(page, 'Não foi possível carregar os agentes')).toBeVisible();
    await expect(page.locator('main.tab-view-container')).not.toContainText('0 de 0');
    await acionarNaTopbar(page, /^Configurações/);
    await expect(alertaCom(page, 'Não foi possível carregar os projetos e agentes')).toBeVisible();
    CENARIO.falhar = null;
    await tentarDeNovoEm(page, 'Não foi possível carregar os projetos e agentes');
    await acionarNaTopbar(page, /^Swarm/);
    await expect(page.locator('.swarm-card')).toHaveCount(5);
  });

  test('/projects 500: Configurações não finge "primeiros passos"; Segurança avisa', async ({
    page,
  }) => {
    CENARIO.falhar = /^\/projects$/;
    await abrir(page);
    await acionarNaTopbar(page, /^Configurações/);
    await expect(alertaCom(page, 'Não foi possível carregar os projetos')).toBeVisible();
    await expect(page.getByText('Primeiros passos')).toHaveCount(0);
    await expect(page.locator('.onboarding')).toHaveCount(0);
    await acionarNaTopbar(page, /^Segurança/);
    await expect(alertaCom(page, 'Não foi possível carregar os projetos')).toBeVisible();
  });

  test('/approvals 500: o banner diz qual recurso falhou e tem "Tentar de novo"', async ({ page }) => {
    CENARIO.falhar = /^\/approvals$/;
    await abrir(page);
    await expect(page.locator('.app-error-banner')).toContainText('aprovações:');
    CENARIO.falhar = null;
    await page.locator('.app-error-banner').getByRole('button', { name: 'Tentar de novo' }).click();
    await expect(page.locator('.approval').first()).toBeVisible();
    await expect(page.locator('.app-error-banner')).toHaveCount(0);
  });

  test('painel da direita: orçamento e memória que falham avisam e tentam de novo', async ({ page }) => {
    CENARIO.falhar = /^\/budget\/|^\/projects\/prj_alfa\/context$/;
    await abrir(page);
    await page.locator('.flow-head', { hasText: 'Refatorar' }).first().click();
    const painel = page.locator('#coluna-painel');
    await expect(
      painel.getByRole('alert').filter({ hasText: 'Não foi possível carregar o orçamento' }),
    ).toBeVisible();
    await expect(painel.getByRole('alert').filter({ hasText: 'memória do projeto' })).toBeVisible();
    CENARIO.falhar = null;
    await painel
      .getByRole('alert')
      .filter({ hasText: 'orçamento' })
      .getByRole('button', { name: /tentar de novo/i })
      .click();
    await expect(painel.locator('.budget-pct')).toBeVisible();
    await painel
      .getByRole('alert')
      .filter({ hasText: 'memória' })
      .getByRole('button', { name: /tentar de novo/i })
      .click();
    await expect(painel).toContainText('Usar TypeScript estrito.');
  });

  test('grafo de um fluxo que falha: árvore da lista, DAG e Telemetria avisam com "tentar de novo"', async ({
    page,
  }) => {
    CENARIO.falhar = /^\/graph\//;
    await abrir(page);
    await page.locator('.flow-head', { hasText: 'Refatorar' }).first().click();
    await expect(alertaCom(page, 'Falha ao carregar o grafo deste fluxo')).toBeVisible();

    await acionarNaTopbar(page, /^Grafo DAG/);
    await expect(alertaCom(page, /O custo de \d+ fluxo\(s\) não carregou/)).toBeVisible();
    await expect(page.locator('.dag-custo-falhou').first()).toContainText('custo indisponível');

    await acionarNaTopbar(page, /^Telemetria/);
    await expect(alertaCom(page, /não carregou/)).toBeVisible();
    CENARIO.falhar = null;
    await tentarDeNovoEm(page, /não carregou/);
    await expect(alertaCom(page, /não carregou/)).toHaveCount(0);
    await expect(page.locator('.telemetry-table')).toContainText('claude');
  });

  const OPERACAO: Array<{ secao: string; rota: RegExp; texto: string }> = [
    { secao: 'Sessão', rota: /\/tasks$/, texto: 'Não foi possível carregar as tarefas' },
    { secao: 'Sessão', rota: /\/artifacts$/, texto: 'Não foi possível carregar os artefatos' },
    { secao: 'Workflow', rota: /^\/workflows\/runs$/, texto: 'Não foi possível carregar as execuções' },
    { secao: 'Projeto', rota: /\/folders$/, texto: 'Não foi possível carregar as pastas' },
    { secao: 'Saúde', rota: /^\/health$/, texto: 'Não foi possível carregar o estado do daemon' },
  ];
  for (const caso of OPERACAO) {
    test(`Operação › ${caso.secao}: ${caso.rota} 500 mostra erro com "Tentar de novo"`, async ({
      page,
    }) => {
      CENARIO.falhar = caso.rota;
      await abrir(page);
      await acionarNaTopbar(page, /^Operação/);
      await page
        .getByRole('navigation', { name: 'Seções de operação' })
        .getByRole('button', { name: caso.secao })
        .click();
      if (caso.secao === 'Sessão') await page.locator('.ops-toolbar select').selectOption('ses_raiz1');
      await expect(alertaCom(page, caso.texto)).toBeVisible();
      CENARIO.falhar = null;
      await tentarDeNovoEm(page, caso.texto);
      await expect(alertaCom(page, caso.texto)).toHaveCount(0);
    });
  }

  const SEGURANCA: Array<{ secao: string; rota: RegExp; texto: string }> = [
    { secao: 'Política', rota: /^\/policy$/, texto: 'Não foi possível ler a política' },
    {
      secao: 'Confiança do projeto',
      rota: /\/context$/,
      texto: 'Não foi possível ler o estado do repositório',
    },
    { secao: 'Gate e MCP', rota: /^\/integrations$/, texto: 'Não foi possível ler as integrações' },
    { secao: 'Aprovações', rota: /^\/audit$/, texto: 'Falha ao ler o histórico' },
    { secao: 'Auditoria', rota: /^\/audit$/, texto: 'Falha ao ler a auditoria' },
  ];
  for (const caso of SEGURANCA) {
    test(`Segurança › ${caso.secao}: 500 mostra erro com "tentar de novo"`, async ({ page }) => {
      CENARIO.falhar = caso.rota;
      await abrir(page);
      await acionarNaTopbar(page, /^Segurança/);
      await page
        .getByRole('navigation', { name: 'Seções de segurança' })
        .getByRole('button', { name: new RegExp(`^${caso.secao}`) })
        .click();
      await expect(alertaCom(page, caso.texto)).toBeVisible();
      CENARIO.falhar = null;
      await tentarDeNovoEm(page, caso.texto);
      await expect(alertaCom(page, caso.texto)).toHaveCount(0);
    });
  }

  test('Configurações › Agentes detectados: /discovery 500 mostra erro com "tentar de novo"', async ({
    page,
  }) => {
    CENARIO.falhar = /^\/discovery$/;
    await abrir(page);
    await acionarNaTopbar(page, /^Configurações/);
    await page.getByRole('button', { name: /Agentes detectados/ }).click();
    const alerta = page.locator('.settings-erro').filter({ hasText: /./ });
    await expect(alerta.first()).toBeVisible();
    CENARIO.falhar = null;
    await alerta
      .first()
      .getByRole('button', { name: /tentar de novo/i })
      .click();
    await expect(page.locator('.settings-erro')).toHaveCount(0);
  });
});

test.describe('Hub vazio (1440px)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('cada tela diz que está vazio, com a ação para começar', async ({ page }) => {
    CENARIO.vazio = true;
    await abrir(page);
    const lista = page.locator('#coluna-fluxos');
    await expect(lista).toContainText('Nenhuma sessão no Hub ainda');
    await expect(lista.getByRole('button', { name: 'Nova sessão', exact: true })).toBeVisible();
    await expect(page.locator('.col-center')).toContainText('Nenhuma sessão no Hub ainda');
    await expect(page.locator('.app-error-banner')).toHaveCount(0);

    await acionarNaTopbar(page, /^Grafo DAG/);
    await expect(page.locator('main.tab-view-container')).toContainText('Nenhum fluxo no Hub ainda');
    await expect(page.getByRole('button', { name: 'Criar Nova Sessão' })).toBeVisible();

    await acionarNaTopbar(page, /^Swarm/);
    await expect(page.locator('main.tab-view-container')).toContainText(
      'Nenhum agente registrado no Hub',
    );

    await acionarNaTopbar(page, /^Telemetria/);
    await expect(page.locator('main.tab-view-container')).toContainText('Nenhuma sessão no Hub ainda');
    await expect(page.locator('main.tab-view-container')).toContainText(
      'Nenhuma sessão começou neste período',
    );

    await acionarNaTopbar(page, /^Configurações/);
    await expect(page.getByText('Primeiros passos')).toBeVisible();
  });

  test('filtro sem resultado (Hub com fluxos): mensagem e "Ver todos"', async ({ page }) => {
    await abrir(page);
    await page.getByLabel('Filtrar fluxos ou agentes').fill('nada-casa-com-isto');
    const lista = page.locator('#coluna-fluxos');
    await expect(lista).toContainText('Nenhum fluxo com este filtro');
    await lista.getByRole('button', { name: 'Ver todos' }).click();
    await expect(page.locator('.flow-head').first()).toBeVisible();
    await expect(page.getByLabel('Filtrar fluxos ou agentes')).toHaveValue('');
  });
});

for (const vp of VIEWPORTS) {
  test.describe(`estados de erro sem controle coberto (${vp.largura}px)`, () => {
    test.use({ viewport: { width: vp.largura, height: vp.altura } });

    test('falha de /sessions e /agents: avisos e botões alcançáveis', async ({ page }) => {
      CENARIO.falhar = /^\/sessions$|^\/agents$/;
      await abrir(page);
      await expect(page.locator('.app-error-banner')).toBeVisible();
      expect(await problemasDeLayout(page)).toEqual([]);
      for (const aba of ['Grafo DAG', 'Swarm', 'Telemetria']) {
        await acionarNaTopbar(page, new RegExp(`^${aba}`));
        await expect(page.locator('main.tab-view-container').getByRole('alert')).toBeVisible();
        expect(await problemasDeLayout(page), aba).toEqual([]);
      }
    });
  });
}

test.describe('interação (1440px)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('R03-24: o fluxo selecionado pode ser recolhido e reaberto', async ({ page }) => {
    await abrir(page);
    const cabeca = page.locator('.flow-head', { hasText: 'Refatorar' }).first();
    await cabeca.click();
    await expect(cabeca).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.timeline-header .session-title')).toContainText('Refatorar');
    await cabeca.click();
    await expect(cabeca).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.flow-open')).toHaveCount(0);
    // Continua selecionado: recolher não troca a sessão.
    await expect(page.locator('.timeline-header .session-title')).toContainText('Refatorar');
    await cabeca.click();
    await expect(cabeca).toHaveAttribute('aria-expanded', 'true');
  });

  test('R03-25: botões não se mexem no hover nem têm margem global', async ({ page }) => {
    await abrir(page);
    const botoes = [
      page.locator('.flow-head').first(),
      page.locator('.topbar .btn-hero-new'),
      page.locator('.seg button').first(),
      page.locator('.approval button').first(),
    ];
    for (const b of botoes) {
      await b.hover();
      const estilo = await b.evaluate((el) => {
        const c = getComputedStyle(el);
        return { transform: c.transform, margem: c.marginLeft };
      });
      expect(estilo.transform, await b.innerText()).toBe('none');
      expect(estilo.margem, await b.innerText()).toBe('0px');
    }
  });

  test('R03-28: "/" não age com modal aberto; sem modal, foca a mensagem', async ({ page }) => {
    await abrir(page);
    await page.locator('.flow-head', { hasText: 'Refatorar' }).first().click();
    await acionarNaTopbar(page, /Nova Sessão/);
    const dialogo = page.getByRole('dialog');
    await dialogo.getByRole('button', { name: 'Cancelar' }).focus();
    const engolido = await page.evaluate(() => {
      const ev = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
      document.activeElement?.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    expect(engolido, 'o "/" não pode ser engolido com modal aberto').toBe(false);
    expect(await dialogo.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialogo).toHaveCount(0);
    await page.locator('body').click({ position: { x: 700, y: 880 } });
    await page.keyboard.press('/');
    await expect(page.locator('.composer-input')).toBeFocused();
  });

  test('R03-12: falha parcial atualiza a lista e "Concluir" só refaz o que falta', async ({ page }) => {
    CENARIO.recusarPasta = /ruim/;
    await abrir(page);
    await page.getByRole('button', { name: '+ Nova Pasta' }).click();
    const dialogo = page.getByRole('dialog');
    await dialogo.getByLabel(/Caminho da Pasta Principal/).fill('C:\\projetos\\gama');
    await dialogo.getByLabel(/Pastas Adicionais/).fill('C:\\projetos\\gama-lib\nC:\\projetos\\ruim');
    await dialogo.getByRole('button', { name: 'Criar & Vincular Projeto' }).click();
    await expect(
      dialogo.getByRole('alert').filter({ hasText: 'Projeto criado, mas 1 pasta' }),
    ).toBeVisible();
    // A lista já mostra o projeto, e ele fica selecionado no filtro.
    await expect(page.getByLabel('Filtrar por projeto')).toHaveValue('prj_novo1');
    await expect(
      page.getByLabel('Filtrar por projeto').locator('option', { hasText: 'gama' }),
    ).toHaveCount(1);
    expect(PROJETOS_CRIADOS).toHaveLength(1);

    CENARIO.recusarPasta = null;
    await dialogo.getByRole('button', { name: 'Concluir' }).click();
    await expect(dialogo).toHaveCount(0);
    expect(PROJETOS_CRIADOS, 'não recria o projeto').toHaveLength(1);
    expect(PASTAS_VINCULADAS.map((p) => p.path)).toEqual([
      'C:\\projetos\\gama-lib',
      'C:\\projetos\\ruim',
    ]);
  });

  test('DAG: filtro de projeto e custo por nó', async ({ page }) => {
    await abrir(page);
    await acionarNaTopbar(page, /^Grafo DAG/);
    const filtro = page.locator('main.tab-view-container').getByLabel('Projeto');
    await expect(page.locator('.dag-flow-cluster')).toHaveCount(4);
    await filtro.selectOption('prj_beta');
    await expect(page.locator('.dag-flow-cluster')).toHaveCount(1);
    await expect(page.locator('.dag-flow-cluster')).toContainText('copilot');
    // Mesmo filtro da lista da Timeline.
    await acionarNaTopbar(page, /^Timeline/);
    await expect(page.getByLabel('Filtrar por projeto')).toHaveValue('prj_beta');
    await acionarNaTopbar(page, /^Grafo DAG/);
    await filtro.selectOption('all');
    const no = page.locator('.dag-node-card', { hasText: 'codex' }).first();
    await expect(no.locator('.dag-node-cost')).toContainText('US$ 0.42');
    await expect(no.locator('.dag-node-cost')).toContainText('48.2k tokens');
  });

  test('Telemetria: "ao vivo" igual à pílula do topo e custo por agente do /graph', async ({ page }) => {
    await abrir(page);
    await expect(page.locator('.flow-head').first()).toBeVisible();
    const pilula = (await page.locator('.pill.status .status-text').innerText()).match(/\d+/)?.[0];
    await acionarNaTopbar(page, /^Telemetria/);
    const aoVivo = page.locator('.kpi-card', { hasText: 'Ao vivo agora' }).locator('.kpi-val');
    await expect(aoVivo).toHaveText(pilula!);
    const tabela = page.locator('.telemetry-table');
    // claude: raiz1 + ext1 (0.4231 cada); codex: filho1.
    await expect(tabela.locator('tr', { hasText: 'claude' })).toContainText('US$ 0.85');
    await expect(tabela.locator('tr', { hasText: 'codex' })).toContainText('US$ 0.42');
  });
});
