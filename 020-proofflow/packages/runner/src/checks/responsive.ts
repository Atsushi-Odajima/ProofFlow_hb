import type { Page } from 'playwright';

export interface ResponsiveFinding { kind: 'horizontal_overflow' | 'element_offscreen' | 'cta_offscreen' | 'text_clipped' | 'fixed_header_overlap' | 'modal_overflow' | 'tiny_tap_target'; severity: 'error' | 'warning'; selector?: string; text?: string; rect?: { x: number; y: number; width: number; height: number }; detail?: string; }

/** Heuristic layout checks. Evidence-backed (screenshot taken by the caller); not an AI judgement. */
export async function responsiveCheck(page: Page): Promise<{ viewport: { width: number; height: number }; scrollWidth: number; findings: ResponsiveFinding[] }> {
  return page.evaluate(() => {
    const vw = window.innerWidth; const vh = window.innerHeight;
    const doc = document.documentElement;
    const findings: ResponsiveFinding[] = [];
    const sel = (el: Element) => { if (el.id) return `#${el.id}`; const cls = (el as HTMLElement).className && typeof (el as HTMLElement).className === 'string' ? '.' + (el as HTMLElement).className.trim().split(/\s+/).slice(0, 2).join('.') : ''; return el.tagName.toLowerCase() + cls; };
    const visible = (el: Element) => { const s = getComputedStyle(el); if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    if (doc.scrollWidth > doc.clientWidth + 1) findings.push({ kind: 'horizontal_overflow', severity: 'error', detail: `scrollWidth ${doc.scrollWidth} > clientWidth ${doc.clientWidth}` });
    const ctaRe = /sign ?up|start|get started|buy|purchase|checkout|register|申し込|購入|登録|開始|無料|trial|subscribe|contact/i;
    let count = 0;
    for (const el of Array.from(document.querySelectorAll('a,button,input[type=submit],[role=button],h1,h2,img,p,li,label'))) {
      if (count > 400) break; count++;
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      const rect = { x: Math.round(r.x + window.scrollX), y: Math.round(r.y + window.scrollY), width: Math.round(r.width), height: Math.round(r.height) };
      const isCta = /^(a|button|input)$/i.test(el.tagName) || el.getAttribute('role') === 'button';
      const text = (el.textContent ?? '').trim().slice(0, 60);
      if (r.left >= vw || r.right <= 0 || r.right > vw + 2) {
        if (isCta && ctaRe.test(text + ' ' + (el.getAttribute('aria-label') ?? ''))) findings.push({ kind: 'cta_offscreen', severity: 'error', selector: sel(el), text, rect, detail: `right=${Math.round(r.right)} viewport=${vw}` });
        else if (r.right > vw + 2) findings.push({ kind: 'element_offscreen', severity: r.width > 40 ? 'warning' : 'warning', selector: sel(el), text, rect, detail: `extends ${Math.round(r.right - vw)}px beyond viewport` });
      }
      if (isCta && (r.width < 24 || r.height < 24) && text) findings.push({ kind: 'tiny_tap_target', severity: 'warning', selector: sel(el), text, rect });
      const s = getComputedStyle(el);
      if (/^(p|li|h1|h2|label)$/i.test(el.tagName) && s.overflow === 'hidden' && (el as HTMLElement).scrollWidth > (el as HTMLElement).clientWidth + 2 && s.whiteSpace === 'nowrap' && s.textOverflow !== 'ellipsis') findings.push({ kind: 'text_clipped', severity: 'warning', selector: sel(el), text, rect });
    }
    const fixed = Array.from(document.querySelectorAll('header,nav,[role=banner]')).filter((el) => { const s = getComputedStyle(el); return (s.position === 'fixed' || s.position === 'sticky') && visible(el); });
    const h1 = document.querySelector('main h1, h1');
    if (fixed.length && h1 && visible(h1)) { const fr = fixed[0]!.getBoundingClientRect(); const hr = h1.getBoundingClientRect(); if (window.scrollY === 0 && hr.top < fr.bottom - 1 && hr.top >= fr.top) findings.push({ kind: 'fixed_header_overlap', severity: 'error', selector: sel(h1), text: (h1.textContent ?? '').trim().slice(0, 60), detail: `heading top ${Math.round(hr.top)} under header bottom ${Math.round(fr.bottom)}` }); }
    for (const d of Array.from(document.querySelectorAll('[role=dialog],dialog[open],.modal'))) { if (!visible(d)) continue; const r = d.getBoundingClientRect(); if (r.height > vh + 2 && getComputedStyle(d).overflowY !== 'auto' && getComputedStyle(d).overflowY !== 'scroll') findings.push({ kind: 'modal_overflow', severity: 'error', selector: sel(d), detail: `dialog height ${Math.round(r.height)} > viewport ${vh}` }); }
    return { viewport: { width: vw, height: vh }, scrollWidth: doc.scrollWidth, findings };
  });
}
