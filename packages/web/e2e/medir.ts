/**
 * Medições compartilhadas pelos testes e2e do painel (painel.spec.ts,
 * operacao.spec.ts): os viewports medidos, "nenhum controle coberto/cortado"
 * e como chegar a uma aba ou ação da topbar em qualquer largura.
 */
import type { Page } from '@playwright/test';

export const VIEWPORTS = [
  { largura: 375, altura: 812 },
  { largura: 768, altura: 1024 },
  { largura: 1100, altura: 800 },
  { largura: 1440, altura: 900 },
];

/**
 * Lista o que está errado com os controles visíveis dentro de `escopo`.
 * Vazio = nenhum controle coberto, cortado ou fora da tela.
 */
export async function problemasDeLayout(page: Page, escopo?: string): Promise<string[]> {
  return page.evaluate((seletorEscopo) => {
    const raiz = seletorEscopo ? document.querySelector(seletorEscopo) : document.body;
    if (!raiz) return [`escopo ${seletorEscopo} não encontrado`];
    const SELETOR =
      'button, a[href], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="option"], select, input, textarea';
    const descrever = (el: Element): string => {
      const texto = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      const classe = typeof el.className === 'string' ? el.className.split(' ')[0] : '';
      return `<${el.tagName.toLowerCase()}${classe ? '.' + classe : ''}> "${texto}"`;
    };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const problemas: string[] = [];
    for (const el of Array.from(raiz.querySelectorAll(SELETOR))) {
      if (el.closest('[inert]')) continue;
      if (!(el as HTMLElement).checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
      let r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // Rolagem VERTICAL legítima (listas, corpo do modal): traz o controle para
      // a área visível do contêiner antes de medir. Rolagem horizontal não é
      // tolerada — controle fora da largura é defeito.
      for (let anc = el.parentElement; anc; anc = anc.parentElement) {
        const estilo = getComputedStyle(anc);
        if (/(auto|scroll)/.test(estilo.overflowY) && anc.scrollHeight > anc.clientHeight) {
          const ar = anc.getBoundingClientRect();
          r = el.getBoundingClientRect();
          if (r.top < ar.top || r.bottom > ar.bottom) {
            anc.scrollTop += r.top - ar.top - (ar.height - r.height) / 2;
          }
        }
      }
      r = el.getBoundingClientRect();
      const nome = descrever(el);
      if (r.left < -0.5 || r.right > vw + 0.5) {
        problemas.push(`${nome}: fora do viewport horizontal (${Math.round(r.left)}..${Math.round(r.right)} de ${vw})`);
        continue;
      }
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cy < 0 || cy > vh) {
        problemas.push(`${nome}: fora do viewport vertical (${Math.round(cy)} de ${vh})`);
        continue;
      }
      const acerto = document.elementFromPoint(cx, cy);
      if (!acerto || !(acerto === el || el.contains(acerto))) {
        problemas.push(`${nome}: coberto por ${acerto ? descrever(acerto) : 'nada'}`);
      }
    }
    const sw = document.documentElement.scrollWidth;
    if (sw > vw) problemas.push(`documento rola na horizontal: scrollWidth ${sw} > ${vw}`);
    return problemas;
  }, escopo ?? null);
}

/** O controle está visível direto, ou pelo menu compacto da topbar. */
export async function acionarNaTopbar(page: Page, nome: string | RegExp): Promise<void> {
  const direto = page
    .locator('.topbar')
    .getByRole('button', { name: nome, exact: typeof nome === 'string' })
    .filter({ visible: true });
  if ((await direto.count()) > 0) {
    await direto.first().click();
    return;
  }
  await page.getByRole('button', { name: 'Mais opções' }).click();
  const item = page.getByRole('menu').getByRole('menuitemradio', { name: nome }).or(
    page.getByRole('menu').getByRole('menuitem', { name: nome }),
  );
  await item.first().click();
}

