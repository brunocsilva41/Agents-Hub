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
import { subirServidorFalso, type ServidorFalso } from './servidor-falso';

let servidor: ServidorFalso;

test.beforeAll(async () => {
  servidor = await subirServidorFalso();
});

test.afterAll(async () => {
  await servidor?.fechar();
});

const ABAS = ['Timeline', 'Grafo DAG', 'Swarm', 'Telemetria', 'Operação', 'Configurações'];

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
