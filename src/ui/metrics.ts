// Vertical font metrics used to place PSD text baselines so live text lands
// where Figma rendered it. Values come from each font's hhea table
// (ascender, descender, unitsPerEm). Fonts not listed fall back to a
// 750/250/1000 default, which is close for most Latin text faces.

import type { TextSpec, UnitValue } from '../shared/spec';

export interface FontMetrics {
  asc: number;
  desc: number;
  upm: number;
}

const METRICS: Record<string, FontMetrics> = {
  Inter: { asc: 1984, desc: 494, upm: 2048 },
  Roboto: { asc: 1900, desc: 500, upm: 2048 },
  Arial: { asc: 1854, desc: 434, upm: 2048 },
  Helvetica: { asc: 770, desc: 230, upm: 1000 },
  HelveticaNeue: { asc: 952, desc: 213, upm: 1000 },
  _default: { asc: 750, desc: 250, upm: 1000 },
};

export function metricsFor(psFont: string): FontMetrics {
  const fam = psFont.split('-')[0];
  return METRICS[fam] || METRICS['_default'];
}

export function lineHeightPx(t: Pick<TextSpec, 'lineHeight' | 'fontSize' | 'psFont'>): number {
  const lh: UnitValue = t.lineHeight || { unit: 'AUTO' };
  if (lh.unit === 'PIXELS') return lh.value as number;
  if (lh.unit === 'PERCENT') return (t.fontSize * (lh.value as number)) / 100;
  const m = metricsFor(t.psFont);
  return ((m.asc + m.desc) * t.fontSize) / m.upm;
}

export function baselineOf(t: Pick<TextSpec, 'lineHeight' | 'fontSize' | 'psFont' | 'y'>): number {
  const m = metricsFor(t.psFont);
  const a = (m.asc * t.fontSize) / m.upm;
  const d = (m.desc * t.fontSize) / m.upm;
  const lh = lineHeightPx(t);
  return t.y + (lh - (a + d)) / 2 + a;
}

export function trackingFromLS(ls: UnitValue | undefined, fontSize: number): number {
  ls = ls || { unit: 'PERCENT', value: 0 };
  if (ls.unit === 'PERCENT') return Math.round((ls.value as number) * 10);
  return Math.round(((ls.value as number) / fontSize) * 1000);
}

export function justificationOf(align: string): string {
  return align === 'CENTER' ? 'center' : align === 'RIGHT' ? 'right' : align === 'JUSTIFIED' ? 'justify-all' : 'left';
}

export function anchorX(t: Pick<TextSpec, 'align' | 'x' | 'w'>): number {
  if (t.align === 'CENTER') return t.x + t.w / 2;
  if (t.align === 'RIGHT') return t.x + t.w;
  return t.x;
}
