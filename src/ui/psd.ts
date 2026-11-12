// Turns layer specs from the sandbox into ag-psd layer objects.
// Rasters become pixel layers or Smart Objects (hi-res source embedded as a
// linked file). Text becomes live, editable PSD point text with style runs.

import type { ColorSpec, LayerSpec, TextSpec } from '../shared/spec';
import { anchorX, baselineOf, justificationOf, lineHeightPx, metricsFor, trackingFromLS } from './metrics';

export interface LinkedFile {
  id: string;
  name: string;
  data: Uint8Array;
}

function guid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function decodePng(bytes: Uint8Array): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([bytes as BlobPart], { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = reject;
    img.src = url;
  });
}

export function imgToCanvas(img: HTMLImageElement, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

export function canvasToImageData(c: HTMLCanvasElement): ImageData {
  return c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
}

function textStyleOf(fs: number, psFont: string, color: ColorSpec, tracking: number) {
  return {
    font: { name: psFont },
    fontSize: fs,
    fillColor: { r: color.r, g: color.g, b: color.b },
    autoLeading: false,
    tracking,
  };
}

export async function toPsdLayer(l: LayerSpec, scale: number, linkedFiles: LinkedFile[]): Promise<any> {
  let out: any;
  if (l.kind === 'group') {
    const children = [];
    for (const child of l.layers) children.push(await toPsdLayer(child, scale, linkedFiles));
    out = { name: l.name, opened: false, children };
  } else if (l.kind === 'raster') {
    const img = await decodePng(l.png);
    const left = Math.round(l.x * scale);
    const top = Math.round(l.y * scale);
    if (l.hiRes) {
      const preview = canvasToImageData(imgToCanvas(img, l.w * scale, l.h * scale));
      const id = guid();
      linkedFiles.push({ id, name: l.name.replace(/[^A-Za-z0-9._-]+/g, '_') + '.png', data: new Uint8Array(l.png) });
      const x0 = l.x * scale;
      const y0 = l.y * scale;
      const x1 = (l.x + l.w) * scale;
      const y1 = (l.y + l.h) * scale;
      out = {
        name: l.name, left, top, imageData: preview,
        placedLayer: {
          id, type: 'raster',
          transform: [x0, y0, x1, y0, x1, y1, x0, y1],
          width: img.naturalWidth, height: img.naturalHeight,
        },
      };
    } else {
      out = { name: l.name, left, top, imageData: canvasToImageData(imgToCanvas(img, img.naturalWidth, img.naturalHeight)) };
    }
  } else {
    // text
    const s = scale;
    const fs = l.fontSize * s;
    const scaled: TextSpec = Object.assign({}, l, { fontSize: fs, x: l.x * s, y: l.y * s, w: l.w * s });
    const baseline = baselineOf(scaled);
    const leading = lineHeightPx(scaled);
    const baseStyle: any = textStyleOf(fs, l.psFont, l.color, trackingFromLS(l.letterSpacing, fs));
    baseStyle.leading = leading;
    // Point text: the transform IS the first baseline, so position is exact
    // and the bounding box hugs the glyphs. Figma's soft wraps arrive baked in
    // as real line breaks (computed in the sandbox at the same width).
    const m = metricsFor(l.psFont);
    const ascent = (m.asc * fs) / m.upm;
    const descent = (m.desc * fs) / m.upm;
    const lines = l.chars.split(/\n/).length;
    const text: any = {
      text: l.chars.replace(/\n/g, '\r'),
      transform: [1, 0, 0, 1, anchorX(scaled), baseline],
      antiAlias: 'smooth',
      style: baseStyle,
      paragraphStyle: { justification: justificationOf(l.align), autoHyphenate: false },
    };
    if (l.runs && l.runs.length > 1) {
      text.styleRuns = l.runs.map((r) => {
        const rfs = r.fontSize * s;
        const st: any = textStyleOf(rfs, r.psFont, r.color, trackingFromLS(r.letterSpacing, rfs));
        st.leading = leading;
        if (r.sups) st.fontBaseline = 1;
        if (r.subs) st.fontBaseline = 2;
        return { length: r.length, style: st };
      });
    }
    out = {
      name: l.name,
      left: Math.round(scaled.x),
      top: Math.round(baseline - ascent),
      right: Math.round(scaled.x + scaled.w),
      bottom: Math.round(baseline + (lines - 1) * leading + descent),
      text,
    };
  }
  if (l.hidden) out.hidden = true;
  if (l.opacity != null && l.opacity < 1) out.opacity = l.opacity;
  if (l.blend && l.blend !== 'normal' && l.blend !== 'pass through') out.blendMode = l.blend;
  return out;
}
