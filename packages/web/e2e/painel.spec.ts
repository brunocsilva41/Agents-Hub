/**
 * Teste e2e do painel: sobreposição, alcance, teclado, modais, gavetas e tema.
 *
 * Mede por JS, em 375/768/1100/1440 px, que todo controle visível (botão, aba,
 * link, campo) está inteiro dentro do viewport horizontal e que o ponto central
 * dele devolve o próprio controle em `elementFromPoint` — isto é, nada o cobre
 * e nenhum `overflow: hidden` o corta. Também que o documento não rola na
 * horizontal. É a verificação que a vistoria fez à mão (04-web-ao-vivo.md) e
 * que pegou a topbar estourando de 768 a ~1116 px.
 *
 * Roda contra o build estático servido por um servidor falso (servidor-falso.ts),
 * sem daemon e sem agentes reais.
 */
import { expect, test, type Page } from '@playwright/test';
import { acionarNaTopbar, problemasDeLayout, VIEWPORTS } from './medir';
import {
  CONSULTAS_DE_AUDITORIA,
  ESCRITAS,
  subirServidorFalso,
  type ServidorFalso,
} from './servidor-falso';

let servidor: ServidorFalso;

test.beforeAll(async () => {
  servidor = await subirServidorFalso();
});

test.afterAll(async () => {
  await servidor?.fechar();
});

const ABAS = ['Timeline', 'Grafo DAG', 'Swarm', 'Telemetria', 'Operação', 'Configurações', 'Segurança'];

const SECOES_SEGURANCA = ['Política', 'Confiança do projeto', 'Gate e MCP', 'Aprovações', 'Auditoria'];

async function abrirSeguranca(page: Page): Promise<void> {
  await acionarNaTopbar(page, /^Segurança/);
  await expect(page.getByRole('heading', { name: 'Segurança', exact: true })).toBeVisible();
}

async function irParaSecao(page: Page, nome: string): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Seções de segurança' })
    .getByRole('button', { name: new RegExp(`^${nome}`) })
    .click();
}

/** Última escrita (PUT/POST) que o painel mandou ao servidor falso para `caminho`. */
function ultimaEscrita(caminho: string | RegExp): { method: string; path: string; body: unknown } | undefined {
  return [...ESCRITAS].reverse().find((e) => (typeof caminho === 'string' ? e.path === caminho : caminho.test(e.path)));
}

async function abrir(page: Page): Promise<void> {
  await page.goto(servidor.url);
  await expect(page.locator('.topbar')).toBeVisible();
  // Índice carregado: a aprovação e os fluxos já estão na tela.
  await expect(page.locator('.approval').first()).toBeVisible();
}

/** Espera a gaveta terminar de deslizar (medir no meio da transição mente). */
async function esperarParada(page: Page, seletor: string): Promise<void> {
  const caixa = (): Promise<string> =>
    page.locator(seletor).evaluate((el) => JSON.stringify(el.getBoundingClientRect()));
  await expect
    .poll(async () => {
      const a = await caixa();
      await page.waitForTimeout(80);
      return a === (await caixa());
    })
    .toBe(true);
}

async function ehGaveta(page: Page, seletor: string): Promise<boolean> {
  return page.locator(seletor).evaluate((el) => getComputedStyle(el).position === 'absolute' || getComputedStyle(el).position === 'fixed');
}

async function selecionarSessao(page: Page, texto: string): Promise<void> {
  const fluxos = page.locator('.flows-toggle');
  if (await fluxos.isVisible()) await fluxos.click();
  await page.locator('.flow-head', { hasText: texto }).first().click();
  await expect(page.locator('.timeline-header .session-title')).toContainText(texto);
  // Em telas estreitas, escolher a sessão fecha a gaveta de fluxos.
}

for (const vp of VIEWPORTS) {
  test.describe(`${vp.largura}px`, () => {
    test.use({ viewport: { width: vp.largura, height: vp.altura } });

    test('nenhum controle coberto, cortado ou fora da tela', async ({ page }) => {
      await abrir(page);
      expect(await problemasDeLayout(page)).toEqual([]);
      await selecionarSessao(page, 'Refatorar');
      expect(await problemasDeLayout(page)).toEqual([]);
    });

    test('toda aba e ação da topbar é alcançável', async ({ page }) => {
      await abrir(page);
      for (const aba of ABAS) {
        await acionarNaTopbar(page, new RegExp(`^${aba}`));
        if (aba === 'Timeline') await expect(page.locator('.columns')).toBeVisible();
        else await expect(page.locator('main.tab-view-container')).toBeVisible();
        expect(await problemasDeLayout(page, '.topbar')).toEqual([]);
      }
      await acionarNaTopbar(page, /^Timeline/);
      await acionarNaTopbar(page, /Nova Sessão/);
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await acionarNaTopbar(page, /Buscar/);
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });

    test('gavetas: uma fecha a outra, fechadas ficam inertes, abertas não são cobertas', async ({ page }) => {
      await abrir(page);
      await selecionarSessao(page, 'Refatorar');
      const direitaEhGaveta = await ehGaveta(page, '.col-right');
      const esquerdaEhGaveta = await ehGaveta(page, '.col-left');
      if (esquerdaEhGaveta) {
        await expect(page.locator('.col-left')).toHaveAttribute('inert', '');
      }
      if (direitaEhGaveta) {
        await expect(page.locator('.col-right')).toHaveAttribute('inert', '');
        await acionarNaTopbar(page, /^Painel/);
        await expect(page.locator('.col-right')).not.toHaveAttribute('inert', '');
        await esperarParada(page, '.col-right');
        expect(await problemasDeLayout(page, '.col-right')).toEqual([]);
        expect(await problemasDeLayout(page, '.topbar')).toEqual([]);
        if (esquerdaEhGaveta) {
          await page.locator('.flows-toggle').click();
          await expect(page.locator('.col-left')).not.toHaveAttribute('inert', '');
          await esperarParada(page, '.col-left');
          await expect(page.locator('.col-right')).toHaveAttribute('inert', '');
          expect(await problemasDeLayout(page, '.col-left')).toEqual([]);
        }
        await page.keyboard.press('Escape');
        await expect(page.locator('.col-right')).toHaveAttribute('inert', '');
        if (esquerdaEhGaveta) await expect(page.locator('.col-left')).toHaveAttribute('inert', '');
      }
    });

    test('modal Nova Sessão: nome, foco inicial, foco preso, rodapé visível, Esc e foco de volta', async ({ page }) => {
      await abrir(page);
      await acionarNaTopbar(page, /Nova Sessão/);
      const dialogo = page.getByRole('dialog');
      await expect(dialogo).toBeVisible();
      await expect(dialogo).toHaveAttribute('aria-modal', 'true');
      await expect(dialogo).toHaveAccessibleName(/Iniciar Nova Sessão/);
      // Foco inicial dentro do diálogo.
      expect(await dialogo.evaluate((d) => d.contains(document.activeElement))).toBe(true);
      // Rodapé fixo: as ações aparecem sem rolar o formulário.
      for (const nome of ['Cancelar', 'Iniciar Sessão']) {
        const botao = dialogo.getByRole('button', { name: nome });
        const inteiro = await botao.evaluate((b) => {
          const r = b.getBoundingClientRect();
          const acerto = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return acerto === b || b.contains(acerto);
        });
        expect(inteiro, `${nome} visível sem rolar`).toBe(true);
      }
      // Tab e Shift+Tab não escapam do diálogo.
      for (let i = 0; i < 40; i += 1) {
        await page.keyboard.press(i % 7 === 6 ? 'Shift+Tab' : 'Tab');
        expect(await dialogo.evaluate((d) => d.contains(document.activeElement))).toBe(true);
      }
      expect(await problemasDeLayout(page, '[role="dialog"]')).toEqual([]);
      await page.keyboard.press('Escape');
      await expect(dialogo).toHaveCount(0);
      // O foco volta a quem abriu (o botão da topbar, ou o menu compacto).
      const focado = await page.evaluate(() => document.activeElement?.closest('.topbar') !== null);
      expect(focado).toBe(true);
    });

    test('Segurança: cada seção sem controle coberto, cortado ou fora da tela', async ({ page }) => {
      await abrir(page);
      await abrirSeguranca(page);
      for (const secao of SECOES_SEGURANCA) {
        await irParaSecao(page, secao);
        await expect(page.locator('.settings-content .card-title').first()).toBeVisible();
        // Conteúdo carregado (nada de "carregando…" medido no meio).
        await expect(page.locator('.settings-content')).not.toContainText('carregando…');
        expect(await problemasDeLayout(page), secao).toEqual([]);
      }
    });

    test('política: revisar mostra que AFROUXA antes de gravar, e gravar pede confirmação', async ({ page }) => {
      ESCRITAS.length = 0;
      await abrir(page);
      await abrirSeguranca(page);
      const editor = page.locator('#sec-camada');
      await expect(editor).toHaveValue(/maxDepth/);
      const gravar = page.getByRole('button', { name: 'Gravar…' });
      await editor.fill('{"risk": {"irreversible": "allow"}}');
      await expect(gravar).toBeDisabled();
      await page.getByRole('button', { name: 'Revisar alterações' }).click();
      await expect(page.locator('.sec-previa')).toContainText('AFROUXA');
      await expect(page.locator('.sec-previa')).toContainText('risk.irreversible');
      expect(ultimaEscrita('/policy?dryRun=1')?.body).toEqual({ policy: { risk: { irreversible: 'allow' } } });
      expect(ultimaEscrita('/policy'), 'revisar não grava').toBeUndefined();
      // Mudou o texto depois de revisar: gravar volta a exigir revisão.
      await editor.fill('{"risk": {"irreversible": "allow"}, "maxDepth": 2}');
      await expect(gravar).toBeDisabled();
      await page.getByRole('button', { name: 'Revisar alterações' }).click();
      await expect(gravar).toBeEnabled();
      await gravar.click();
      const dialogo = page.getByRole('dialog');
      await expect(dialogo).toHaveAccessibleName(/Gravar a política global/);
      await expect(dialogo.getByRole('button', { name: 'Cancelar' })).toBeFocused();
      expect(await problemasDeLayout(page, '[role="dialog"]')).toEqual([]);
      await dialogo.getByRole('button', { name: 'Afrouxar e gravar' }).click();
      await expect(dialogo).toHaveCount(0);
      expect(ultimaEscrita('/policy')?.body).toEqual({ policy: { risk: { irreversible: 'allow' }, maxDepth: 2 } });
      await expect(page.locator('.sec-previa')).toContainText('Gravado: isto AFROUXA');
    });

    test('edição não salva: trocar de aba no topo pergunta antes de descartar', async ({ page }) => {
      await abrir(page);
      await abrirSeguranca(page);
      await page.locator('#sec-camada').fill('{"maxDepth": 1}');
      page.once('dialog', (d) => void d.dismiss());
      await acionarNaTopbar(page, /^Timeline/);
      await expect(page.getByRole('heading', { name: 'Segurança', exact: true })).toBeVisible();
      await expect(page.locator('#sec-camada')).toHaveValue('{"maxDepth": 1}');
      page.once('dialog', (d) => void d.accept());
      await acionarNaTopbar(page, /^Timeline/);
      await expect(page.locator('.columns')).toBeVisible();
    });

    test('confiança: suspensa, mostra o BASE_URL do repo e confiar exige confirmação', async ({ page }) => {
      ESCRITAS.length = 0;
      await abrir(page);
      await abrirSeguranca(page);
      await irParaSecao(page, 'Confiança do projeto');
      await expect(page.locator('.sec-confianca')).toContainText('confiança suspensa');
      await expect(page.locator('.settings-content')).toContainText('servidor-de-alguem.example.com');
      await page.getByRole('button', { name: 'Confiar no conteúdo novo…' }).click();
      const dialogo = page.getByRole('dialog');
      await expect(dialogo).toContainText('ANTHROPIC_BASE_URL');
      expect(await problemasDeLayout(page, '[role="dialog"]')).toEqual([]);
      expect(ultimaEscrita(/\/trust$/), 'nada antes de confirmar').toBeUndefined();
      await dialogo.getByRole('button', { name: 'Confiar', exact: true }).click();
      await expect(dialogo).toHaveCount(0);
      expect(ultimaEscrita('/projects/prj_alfa/trust')?.body).toEqual({ trusted: true });
    });

    test('gate e MCP: timeout antigo, prévia com diff, gravar devolve o base da prévia', async ({ page }) => {
      ESCRITAS.length = 0;
      await abrir(page);
      await abrirSeguranca(page);
      await irParaSecao(page, 'Gate e MCP');
      await expect(page.locator('.settings-content')).toContainText('timeout antigo');
      await expect(page.locator('.settings-content')).toContainText('só vigilância');
      await page.getByRole('button', { name: /Atualizar gate em Claude Code/ }).click();
      const dialogo = page.getByRole('dialog');
      await expect(dialogo.locator('.sec-diff-mais')).toContainText('"timeout": 120');
      await expect(dialogo.locator('.sec-diff-menos')).toContainText('"timeout": 10');
      expect(await problemasDeLayout(page, '[role="dialog"]')).toEqual([]);
      expect(ultimaEscrita('/integrations/claude/hook')?.body).toEqual({ dryRun: true, projectId: 'prj_alfa' });
      await dialogo.getByRole('button', { name: 'Gravar no arquivo' }).click();
      await expect(dialogo).toHaveCount(0);
      expect(ultimaEscrita('/integrations/claude/hook')?.body).toEqual({
        dryRun: false,
        base: 'sha256:abc',
        projectId: 'prj_alfa',
      });
    });

    test('paleta: Ctrl+K abre e fecha, setas + Enter navegam, Esc devolve o foco', async ({ page }) => {
      await abrir(page);
      await page.locator('body').click({ position: { x: 5, y: vp.altura - 5 } });
      await page.keyboard.press('Control+k');
      const entrada = page.getByRole('dialog').getByRole('combobox');
      await expect(entrada).toBeVisible();
      await expect(entrada).toBeFocused();
      // Rótulos em português, nada de estado cru do daemon.
      const texto = await page.getByRole('dialog').innerText();
      expect(texto).not.toMatch(/WAITING_APPROVAL|RUNNING|COMPLETED|PAUSED/);
      expect(await problemasDeLayout(page, '[role="dialog"]')).toEqual([]);
      await page.keyboard.press('Control+k');
      await expect(page.getByRole('dialog')).toHaveCount(0);

      await page.keyboard.press('Control+k');
      await expect(entrada).toBeFocused();
      await entrada.fill('migra');
      const opcoes = page.getByRole('dialog').getByRole('option');
      await expect(opcoes.first()).toBeVisible();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowUp');
      const ativo = await entrada.getAttribute('aria-activedescendant');
      expect(ativo).toBeTruthy();
      await expect(page.locator(`[id="${ativo}"]`)).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator(`[id="${ativo}"]`)).toContainText('Rodar a suíte');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.locator('.timeline-header .session-title')).toContainText('Rodar a suíte');

      // Esc fecha e devolve o foco para quem abriu.
      const botaoBusca = page.locator('.topbar').getByRole('button', { name: /Buscar/ }).filter({ visible: true });
      if ((await botaoBusca.count()) > 0) {
        await botaoBusca.first().focus();
        await page.keyboard.press('Control+k');
        await expect(entrada).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(botaoBusca.first()).toBeFocused();
      }
    });
  });
}

/** Contraste WCAG entre duas cores CSS (resolvidas pelo navegador). */
async function contrastes(page: Page, pares: Array<[string, string]>): Promise<number[]> {
  return page.evaluate((lista) => {
    const sonda = document.createElement('span');
    document.body.appendChild(sonda);
    const rgb = (cor: string): number[] => {
      sonda.style.color = '';
      sonda.style.color = cor;
      const m = getComputedStyle(sonda).color.match(/[\d.]+/g) ?? [];
      return m.slice(0, 3).map(Number);
    };
    const lum = (c: number[]): number => {
      const [r, g, b] = c.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const resultado = lista.map(([a, b]) => {
      const la = lum(rgb(a));
      const lb = lum(rgb(b));
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    });
    sonda.remove();
    return resultado;
  }, pares);
}

test.describe('tema e cores', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const esquema of ['dark', 'light'] as const) {
    test(`paleta de agentes e --text-faint com contraste AA (${esquema})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: esquema });
      await abrir(page);
      const definidas = await page.evaluate(() =>
        Array.from({ length: 8 }, (_, i) =>
          getComputedStyle(document.documentElement).getPropertyValue(`--agent-${i + 1}`).trim(),
        ),
      );
      for (const v of definidas) expect(v, 'variável --agent-N definida').not.toBe('');

      const pares: Array<[string, string]> = [];
      for (let i = 1; i <= 8; i += 1) {
        pares.push([`var(--agent-${i})`, 'var(--bg-panel)']);
        pares.push([`var(--agent-${i})`, 'var(--bg)']);
        pares.push([`var(--agent-${i})`, 'var(--on-agent)']);
      }
      for (const fundo of ['var(--bg)', 'var(--bg-panel)', 'var(--bg-raised)', 'var(--bg-card)']) {
        pares.push(['var(--text-faint)', fundo]);
      }
      const valores = await contrastes(page, pares);
      valores.forEach((c, i) => {
        expect(c, `${pares[i]![0]} sobre ${pares[i]![1]}`).toBeGreaterThanOrEqual(4.5);
      });

      // O tema segue o sistema: fundo claro no claro, escuro no escuro.
      const [fundoContraBranco] = await contrastes(page, [['var(--bg)', '#ffffff']]);
      if (esquema === 'light') expect(fundoContraBranco!).toBeLessThan(1.5);
      else expect(fundoContraBranco!).toBeGreaterThan(10);
    });
  }

  test('alternância de tema persiste e vence o sistema', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await abrir(page);
    await page.getByRole('button', { name: /tema/i }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.reload();
    await expect(page.locator('.topbar')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const [c] = await contrastes(page, [['var(--bg)', '#ffffff']]);
    expect(c!).toBeLessThan(1.5);
    await page.getByRole('button', { name: /tema/i }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('nenhuma requisição a terceiros (fontes locais)', async ({ page }) => {
    const externas: string[] = [];
    page.on('request', (req) => {
      const u = new URL(req.url());
      if (u.hostname !== '127.0.0.1' && u.protocol.startsWith('http')) externas.push(req.url());
    });
    await abrir(page);
    await page.waitForTimeout(800);
    expect(externas).toEqual([]);
  });
});

test.describe('Segurança e Configurações (1100px)', () => {
  test.use({ viewport: { width: 1100, height: 800 } });

  test('aprovações mostram quem decidiu; filtros da auditoria vão na consulta', async ({ page }) => {
    await abrir(page);
    await abrirSeguranca(page);
    await irParaSecao(page, 'Aprovações');
    const item = page.locator('.sec-item').first();
    await expect(item).toContainText('negada');
    await expect(item).toContainText('decidida por web');
    await irParaSecao(page, 'Auditoria');
    await expect(page.locator('.sec-item').first()).toBeVisible();
    CONSULTAS_DE_AUDITORIA.length = 0;
    await page.getByLabel('Tipo').selectOption('policy.updated');
    await expect.poll(() => CONSULTAS_DE_AUDITORIA.at(-1) ?? '').toContain('kind=policy.updated');
    expect(CONSULTAS_DE_AUDITORIA.at(-1)).toContain('since=24h');
    await expect(page.locator('.sec-item')).toHaveCount(1);
    await expect(page.locator('.sec-item')).toContainText('cli:bruno');
  });

  test('campo de modelo só para agente com model.supported', async ({ page }) => {
    await abrir(page);
    await acionarNaTopbar(page, /^Configurações/);
    await page.getByRole('button', { name: /Modelos locais/ }).click();
    await page.getByRole('tab', { name: 'OpenCode' }).click();
    await expect(page.locator('#modelo')).toBeVisible();
    await expect(page.locator('label[for="modelo"]')).toContainText('MODEL');
    await page.getByRole('tab', { name: 'Cursor Agent' }).click();
    await expect(page.locator('#modelo')).toHaveCount(0);
  });

  test('estados de erro e vazio têm destaque (.settings-erro/.settings-vazio com CSS)', async ({ page }) => {
    await abrir(page);
    await acionarNaTopbar(page, /^Configurações/);
    await page.getByLabel('Projeto').selectOption('prj_beta');
    const erro = page.locator('.settings-erro').filter({ hasText: 'falha simulada' });
    await expect(erro).toBeVisible();
    const estiloErro = await erro.evaluate((el) => {
      const c = getComputedStyle(el);
      return { fundo: c.backgroundColor, borda: c.borderLeftWidth, display: c.display };
    });
    expect(estiloErro.fundo).not.toBe('rgba(0, 0, 0, 0)');
    expect(estiloErro.borda).toBe('4px');
    expect(estiloErro.display).toBe('flex');

    await acionarNaTopbar(page, /^Segurança/);
    await page.getByLabel('Projeto').selectOption('');
    await irParaSecao(page, 'Confiança do projeto');
    const vazio = page.locator('.settings-vazio').first();
    await expect(vazio).toBeVisible();
    expect(await vazio.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('dashed');
  });

  test('configurações: edição não salva também pergunta ao trocar de aba', async ({ page }) => {
    await abrir(page);
    await acionarNaTopbar(page, /^Configurações/);
    await page.getByRole('button', { name: /Memória do projeto/ }).click();
    await page.locator('#memoria').fill('regra nova');
    page.once('dialog', (d) => void d.dismiss());
    await acionarNaTopbar(page, /^Segurança/);
    await expect(page.locator('#memoria')).toHaveValue('regra nova');
  });
});
