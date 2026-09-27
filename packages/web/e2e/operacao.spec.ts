/**
 * Teste e2e da aba Operação (item 6.12, parte A): cada seção abre, cada ação
 * mostra carregando/erro/sucesso de verdade, e em 375/768/1100/1440 px nenhum
 * controle fica coberto, cortado ou fora da tela (mesma medição do painel.spec).
 *
 * Contra o build estático e o servidor falso — sem daemon, sem agentes reais.
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

async function abrirOperacao(page: Page): Promise<void> {
  await page.goto(servidor.url);
  await expect(page.locator('.topbar')).toBeVisible();
  await expect(page.locator('.approval').first()).toBeVisible();
  await acionarNaTopbar(page, /^Operação/);
  await expect(page.locator('.ops-page')).toBeVisible();
}

async function secao(page: Page, nome: string): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Seções de operação' })
    .getByRole('button', { name: nome })
    .click();
}

async function semProblemas(page: Page): Promise<void> {
  expect(await problemasDeLayout(page, 'main.tab-view-container')).toEqual([]);
  expect(await problemasDeLayout(page, '.topbar')).toEqual([]);
}

VIEWPORTS.forEach((vp, indice) => {
  test.describe(`Operação ${vp.largura}px`, () => {
    test.use({ viewport: { width: vp.largura, height: vp.altura } });

    test('sessão: tarefas, diff, artefatos e teto do fluxo', async ({ page }) => {
      await abrirOperacao(page);
      await semProblemas(page);
      await page.locator('.ops-toolbar select').selectOption('ses_raiz1');

      // Tarefas: estado, motivo de falha da validação.
      await expect(page.getByRole('list', { name: 'Validação' })).toContainText(
        '3 testes falharam em auth.spec.ts',
      );
      await expect(page.getByText('2 tentativas')).toBeVisible();
      // Artefatos.
      await expect(page.getByText('validacao.log')).toBeVisible();

      // Diff sob pedido, separado por arquivo.
      await page.getByRole('button', { name: 'Carregar diff' }).click();
      await expect(page.locator('.ops-diff-file')).toHaveCount(2);
      await expect(page.locator('.ops-diff-file summary').first()).toContainText('+2');
      await semProblemas(page);

      // Teto: inválido é recusado no campo; válido salva e diz o novo teto.
      const usd = page.getByLabel('Teto em US$');
      await usd.fill('0.1');
      await page.getByRole('button', { name: 'Salvar teto' }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'já gastou' })).toBeVisible();
      const novo = String(3 + indice);
      await usd.fill(novo);
      await page.getByRole('button', { name: 'Salvar teto' }).click();
      await expect(
        page.getByRole('status').filter({ hasText: `Teto salvo: US$ ${novo}.00` }),
      ).toBeVisible();
      await semProblemas(page);
    });

    test('workflow: validar, executar e acompanhar', async ({ page }) => {
      await abrirOperacao(page);
      await secao(page, 'Workflow');
      await expect(page.getByLabel('YAML do workflow')).toBeVisible();
      // Execução anterior listada com o passo parado em aprovação (as dos
      // outros viewports também estão na lista: escolhe a antiga).
      await page.locator('.ops-runs select').selectOption('wfr_antiga1');
      await expect(page.getByText('esperando aprovação: executar: npm run migrate')).toBeVisible();
      await semProblemas(page);

      await page
        .getByLabel('YAML do workflow')
        .fill('name: x\nsteps:\n  - { id: b, agent: claude, objective: y, dependsOn: [inexistente] }\n');
      await page.getByRole('button', { name: 'Validar' }).click();
      await expect(page.getByRole('list', { name: 'Erros de validação' })).toContainText('inexistente');
      await expect(page.getByRole('button', { name: 'Executar' })).toBeDisabled();

      await page.getByLabel('YAML do workflow').fill('');
      await page.getByRole('button', { name: 'Usar exemplo' }).click();
      await page.getByRole('button', { name: 'Validar' }).click();
      await expect(page.getByRole('list', { name: 'Ordem de execução' })).toContainText('Lote 2');
      await page.getByLabel('Orçamento total (US$)').fill('2');
      await page.getByRole('button', { name: 'Executar' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'disparado no Hub' })).toBeVisible();
      await expect(page.locator('.ops-run')).toContainText('em andamento');
      await semProblemas(page);
    });

    test('projeto: pastas e agentes externos', async ({ page }) => {
      await abrirOperacao(page);
      await secao(page, 'Projeto');
      await expect(page.getByText('principal')).toBeVisible();
      await semProblemas(page);

      const caminho = `C:\\projetos\\nova-${vp.largura}`;
      await page.getByLabel('Caminho absoluto da pasta').fill(caminho);
      await page.getByRole('button', { name: 'Adicionar pasta' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Pasta adicionada' })).toBeVisible();
      await page.getByRole('button', { name: `Remover a pasta ${caminho}` }).click();
      await page
        .getByRole('alertdialog', { name: 'Confirmar remover pasta' })
        .getByRole('button', { name: 'Remover pasta' })
        .click();
      await expect(page.getByRole('status').filter({ hasText: 'Pasta removida' })).toBeVisible();

      // Adotada e viva: pode desanexar (com confirmação).
      const adotadas = page.getByRole('list', { name: 'Sessões adotadas' });
      await expect(adotadas).toContainText('Claude Code (externo)');
      await adotadas.getByRole('button', { name: 'Desanexar' }).click();
      await semProblemas(page);
      await page
        .getByRole('alertdialog', { name: 'Confirmar desanexar' })
        .getByRole('button', { name: 'Desanexar' })
        .click();
      await expect(page.getByRole('status').filter({ hasText: 'Sessão desanexada' })).toBeVisible();

      await page.getByRole('button', { name: 'Adotar sessão' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'registrada para' })).toBeVisible();
      await semProblemas(page);
    });

    test('saúde e manutenção: estado do daemon, re-sondar, recolher worktrees', async ({ page }) => {
      await abrirOperacao(page);
      await secao(page, 'Saúde');
      await expect(page.getByText('respondendo')).toBeVisible();
      await expect(page.locator('.ops-pill.nivel-erro')).toHaveCount(1);
      await page.getByRole('button', { name: 'Re-sondar agentes' }).click();
      await expect(
        page.getByRole('status').filter({ hasText: 'Sondagem refeita: 4 de 5' }),
      ).toBeVisible();
      await semProblemas(page);

      await secao(page, 'Manutenção');
      await page.getByRole('button', { name: 'Recolher worktrees…' }).click();
      await semProblemas(page);
      await page.getByRole('button', { name: 'Recolher agora' }).click();
      await expect(
        page.getByRole('status').filter({ hasText: '1 worktree(s) recolhido(s)' }),
      ).toBeVisible();
      await expect(page.getByRole('list', { name: 'Falhas ao recolher' })).toContainText(
        'arquivo em uso',
      );
      await semProblemas(page);
    });
  });
});
