// Baseline TIFF writer for flattened composite proofs: uncompressed, single
// strip, little-endian, with real DPI tagging so files open at the correct
// physical size in print workflows.
//
// CMYK mode uses the standard device conversion (K = 1 - max(R,G,B), then
// C/M/Y scaled by the remaining density). This is NOT an ICC-profiled
// conversion; final separations should still go through a color-managed
// tool. It exists so print vendors get a CMYK file that opens correctly.

export type TiffMode = 'rgb' | 'cmyk';

const enum T {
  BYTE = 1,
  SHORT = 3,
  LONG = 4,
  RATIONAL = 5,
}

interface Entry {
  tag: number;
  type: number;
  count: number;
  // Either an inline value or a marker resolved to an offset at layout time.
  value: number | 'bpsOffset' | 'xresOffset' | 'yresOffset';
}

export function encodeTiff(rgba: Uint8ClampedArray, width: number, height: number, dpi: number, mode: TiffMode): Uint8Array {
  const cmyk = mode === 'cmyk';
  const samples = cmyk ? 4 : 3;
  const pixelBytes = width * height * samples;

  const entries: Entry[] = [
    { tag: 256, type: T.LONG, count: 1, value: width },
    { tag: 257, type: T.LONG, count: 1, value: height },
    { tag: 258, type: T.SHORT, count: samples, value: 'bpsOffset' },
    { tag: 259, type: T.SHORT, count: 1, value: 1 }, // no compression
    { tag: 262, type: T.SHORT, count: 1, value: cmyk ? 5 : 2 }, // separated : RGB
    { tag: 273, type: T.LONG, count: 1, value: 0 }, // strip offset, patched below
    { tag: 277, type: T.SHORT, count: 1, value: samples },
    { tag: 278, type: T.LONG, count: 1, value: height },
    { tag: 279, type: T.LONG, count: 1, value: pixelBytes },
    { tag: 282, type: T.RATIONAL, count: 1, value: 'xresOffset' },
    { tag: 283, type: T.RATIONAL, count: 1, value: 'yresOffset' },
    { tag: 296, type: T.SHORT, count: 1, value: 2 }, // resolution in inches
  ];
  if (cmyk) entries.push({ tag: 332, type: T.SHORT, count: 1, value: 1 }); // CMYK ink set
  entries.sort((a, b) => a.tag - b.tag);

  const headerSize = 8;
  const ifdSize = 2 + entries.length * 12 + 4;
  const bpsSize = samples * 2;
  const bpsOffset = headerSize + ifdSize;
  const xresOffset = bpsOffset + bpsSize;
  const yresOffset = xresOffset + 8;
  const dataOffset = yresOffset + 8;

  const buf = new ArrayBuffer(dataOffset + pixelBytes);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  // Header: little-endian marker, magic 42, first IFD offset.
  view.setUint8(0, 0x49);
  view.setUint8(1, 0x49);
  view.setUint16(2, 42, true);
  view.setUint32(4, headerSize, true);

  let p = headerSize;
  view.setUint16(p, entries.length, true);
  p += 2;
  for (const e of entries) {
    view.setUint16(p, e.tag, true);
    view.setUint16(p + 2, e.type, true);
    view.setUint32(p + 4, e.count, true);
    let v: number;
    if (e.value === 'bpsOffset') v = bpsOffset;
    else if (e.value === 'xresOffset') v = xresOffset;
    else if (e.value === 'yresOffset') v = yresOffset;
    else if (e.tag === 273) v = dataOffset;
    else v = e.value;
    if (e.type === T.SHORT && e.count === 1) view.setUint16(p + 8, v, true);
    else view.setUint32(p + 8, v, true);
    p += 12;
  }
  view.setUint32(p, 0, true); // no next IFD

  for (let s = 0; s < samples; s++) view.setUint16(bpsOffset + s * 2, 8, true);
  view.setUint32(xresOffset, dpi, true);
  view.setUint32(xresOffset + 4, 1, true);
  view.setUint32(yresOffset, dpi, true);
  view.setUint32(yresOffset + 4, 1, true);

  // Pixels. Input RGBA is expected pre-composited (no meaningful alpha).
  let o = dataOffset;
  if (cmyk) {
    for (let i = 0; i < rgba.length; i += 4) {
      const r = rgba[i] / 255;
      const g = rgba[i + 1] / 255;
      const b = rgba[i + 2] / 255;
      const k = 1 - Math.max(r, g, b);
      const d = 1 - k;
      bytes[o++] = d > 0 ? Math.round(((1 - r - k) / d) * 255) : 0;
      bytes[o++] = d > 0 ? Math.round(((1 - g - k) / d) * 255) : 0;
      bytes[o++] = d > 0 ? Math.round(((1 - b - k) / d) * 255) : 0;
      bytes[o++] = Math.round(k * 255);
    }
  } else {
    for (let i = 0; i < rgba.length; i += 4) {
      bytes[o++] = rgba[i];
      bytes[o++] = rgba[i + 1];
      bytes[o++] = rgba[i + 2];
    }
  }
  return bytes;
}
