/**
 * Horários na CLI (vistoria 07, R07-18).
 *
 * O daemon grava tudo em ISO UTC (`2026-09-25T04:10:03.000Z`) e a CLI
 * recortava a string (`ts.slice(11, 19)`): o relógio local marcava 01:10 e o
 * `hub approvals`/`sessions`/`watch` mostravam `04:10:03`, sem dizer que era
 * UTC. Regra agora, em todo comando: hora LOCAL deste computador. Onde a data
 * inteira aparece (listagens), o fuso vai junto (`UTC-3`); na linha de evento
 * do `watch`, que se lê ao vivo contra o relógio da parede, só `HH:MM:SS`.
 *
 * `offsetMin` segue `Date#getTimezoneOffset` (minutos A SOMAR à hora local
 * para chegar ao UTC: -03:00 é `180`). É parâmetro para o teste ser
 * determinístico em qualquer fuso; o padrão é o do instante (horário de verão
 * incluído).
 */

const dois = (n: number): string => String(n).padStart(2, '0');

function local(iso: string, offsetMin: number | undefined): { d: Date; offset: number } | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const offset = offsetMin ?? new Date(t).getTimezoneOffset();
  // Desloca e lê pelos getters UTC: independe do fuso do processo.
  return { d: new Date(t - offset * 60_000), offset };
}

/** `HH:MM:SS` na hora local. Texto que não é data volta como veio. */
export function horaLocal(iso: string, offsetMin?: number): string {
  const l = local(iso, offsetMin);
  if (!l) return iso;
  return `${dois(l.d.getUTCHours())}:${dois(l.d.getUTCMinutes())}:${dois(l.d.getUTCSeconds())}`;
}

/** `UTC-3`, `UTC+5:30`, `UTC` — o rótulo do fuso para um deslocamento. */
export function rotuloDoFuso(offsetMin: number): string {
  if (offsetMin === 0) return 'UTC';
  const leste = -offsetMin;
  const sinal = leste > 0 ? '+' : '-';
  const abs = Math.abs(leste);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sinal}${h}${m === 0 ? '' : `:${dois(m)}`}`;
}

/** `YYYY-MM-DD HH:MM:SS UTC-3` na hora local. Texto que não é data volta como veio. */
export function dataHoraLocal(iso: string, offsetMin?: number): string {
  const l = local(iso, offsetMin);
  if (!l) return iso;
  const { d } = l;
  const data = `${d.getUTCFullYear()}-${dois(d.getUTCMonth() + 1)}-${dois(d.getUTCDate())}`;
  return `${data} ${horaLocal(iso, l.offset)} ${rotuloDoFuso(l.offset)}`;
}
