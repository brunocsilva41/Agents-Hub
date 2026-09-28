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
      const texto = (el.getAttribute('aria-label') || el.textContent || '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 40);
      const classe = typeof el.className === 'string' ? el.className.split(' ')[0] : '';
      return `<${el.tagName.toLowerCase()}${classe ? '.' + classe : ''}> "${texto}"`;
    };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const problemas: string[] = [];
    for (const el of Array.from(raiz.querySelectorAll(SELETOR))) {
      if (el.closest('[inert]')) continue;
      if (!(el as HTMLElement).checkVisibility({ visibilityProperty: true, opacityProperty: true }))
        continue;
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
        problemas.push(
          `${nome}: fora do viewport horizontal (${Math.round(r.left)}..${Math.round(r.right)} de ${vw})`,
        );
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

/**
 * Conteúdo que transborda de cada `seletor`: um bloco que passa da largura
 * da tela, um descendente que sai da caixa dele, ou texto maior que o próprio
 * elemento (scrollWidth > clientWidth). Pega o que `problemasDeLayout` não vê
 * — cartão cortado por `overflow: hidden`, coluna fixa que espreme o texto —
 * mesmo onde não há controle nenhum. Vazio = tudo cabe.
 */
export async function transbordos(page: Page, seletor: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const vw = window.innerWidth;
    const problemas: string[] = [];
    const nome = (el: Element): string => {
      const classe = typeof el.className === 'string' ? el.className.split(' ')[0] : '';
      const texto = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 30);
      return `<${el.tagName.toLowerCase()}${classe ? '.' + classe : ''}> "${texto}"`;
    };
    const blocos = Array.from(document.querySelectorAll(sel));
    if (blocos.length === 0) return [`nenhum ${sel} na tela`];
    for (const bloco of blocos) {
      const b = bloco.getBoundingClientRect();
      if (b.width === 0) continue;
      if (b.left < -0.5 || b.right > vw + 0.5) {
        problemas.push(
          `${nome(bloco)}: fora da tela (${Math.round(b.left)}..${Math.round(b.right)} de ${vw})`,
        );
        continue;
      }
      // Só o elemento mais externo que sai: os filhos dele sairiam junto.
      const vazados = new Set<Element>();
      for (const el of [bloco, ...Array.from(bloco.querySelectorAll('*'))]) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (el.parentElement && vazados.has(el.parentElement)) {
          vazados.add(el);
          continue;
        }
        if (el !== bloco && (r.left < b.left - 0.5 || r.right > b.right + 0.5)) {
          vazados.add(el);
          problemas.push(
            `${nome(el)}: sai de ${nome(bloco)} (${Math.round(r.right)} > ${Math.round(b.right)})`,
          );
        } else if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) {
          problemas.push(`${nome(el)}: texto maior que a caixa (${el.scrollWidth} > ${el.clientWidth})`);
        }
      }
    }
    return problemas;
  }, seletor);
}

/**
 * Selects de `escopo` cujo rótulo mais longo não cabe na caixa: um clone
 * invisível com `width: max-content` mede a largura que o select pediria para
 * mostrar a opção mais comprida inteira, com a seta e o padding do próprio
 * estilo. Maior que a caixa real = rótulo truncado para alguma escolha.
 */
export async function selectsTruncados(page: Page, escopo: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const raiz = document.querySelector(sel);
    if (!raiz) return [`escopo ${sel} não encontrado`];
    const problemas: string[] = [];
    for (const select of Array.from(raiz.querySelectorAll('select'))) {
      const real = select.getBoundingClientRect().width;
      if (real === 0) continue;
      const clone = select.cloneNode(true) as HTMLSelectElement;
      clone.removeAttribute('id');
      clone.style.cssText = 'position:absolute;visibility:hidden;width:max-content;max-width:none';
      select.parentElement?.appendChild(clone);
      const pedida = clone.getBoundingClientRect().width;
      clone.remove();
      if (pedida > real + 0.5) {
        const rotulo = select.labels?.[0]?.textContent?.trim() ?? select.id;
        problemas.push(`select "${rotulo}": pede ${Math.round(pedida)} px e tem ${Math.round(real)}`);
      }
    }
    return problemas;
  }, escopo);
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
  const item = page
    .getByRole('menu')
    .getByRole('menuitemradio', { name: nome })
    .or(page.getByRole('menu').getByRole('menuitem', { name: nome }));
  await item.first().click();
}
