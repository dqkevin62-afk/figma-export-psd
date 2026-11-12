// Minimal ZIP writer (STORE method, no compression) so batch exports become
// ONE download instead of a blocked queue of native save dialogs.
// PSDs are already RLE-compressed internally, so deflating them again buys
// little and costs time.

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function buildZip(files: ZipEntry[]): Blob {
  const enc = new TextEncoder();
  // General purpose flag bit 11 (0x0800): filename is UTF-8. Without it,
  // Windows Explorer decodes the UTF-8 name bytes in the ANSI codepage
  // (GBK on Chinese systems) and every non-ASCII frame name turns to mojibake.
  const flags = 0x0800;
  const chunks: (Uint8Array | ArrayBuffer)[] = [];
  const central: { name: Uint8Array; crc: number; size: number; offset: number; time: number; date: number }[] = [];
  let offset = 0;
  const u16 = (v: number) => new Uint8Array([v & 255, (v >> 8) & 255]);
  const u32 = (v: number) => new Uint8Array([v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]);
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  for (const file of files) {
    const name = enc.encode(file.name);
    const data = file.data;
    const crc = crc32(data);
    const local = [u32(0x04034b50), u16(20), u16(flags), u16(0), u16(dosTime), u16(dosDate), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data];
    const localSize = 30 + name.length + data.length;
    central.push({ name, crc, size: data.length, offset, time: dosTime, date: dosDate });
    for (const part of local) chunks.push(part);
    offset += localSize;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const e of central) {
    const rec = [u32(0x02014b50), u16(20), u16(20), u16(flags), u16(0), u16(e.time), u16(e.date), u32(e.crc), u32(e.size), u32(e.size), u16(e.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(e.offset), e.name];
    for (const part of rec) chunks.push(part);
    cdSize += 46 + e.name.length;
  }
  chunks.push(u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(cdSize), u32(cdStart), u16(0));
  return new Blob(chunks as BlobPart[], { type: 'application/zip' });
}
