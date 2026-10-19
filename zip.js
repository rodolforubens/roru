// Reads .zip archives in memory (for imports): the list of entries from the central directory, and
// each entry's bytes, inflated with the webview's DecompressionStream. Supports Zip64 sizes.

const u16 = (dv, at) => dv.getUint16(at, true);
const u32 = (dv, at) => dv.getUint32(at, true);
const u64 = (dv, at) => Number(dv.getBigUint64(at, true));

// `buffer`: an ArrayBuffer. Returns { entries: [{ name, size, dir }], read(entry) -> Promise<Uint8Array> }.
// Names are decoded as UTF-8 (archives from Notion use it without saying so).
export function readZip(buffer) {
  const dv = new DataView(buffer), bytes = new Uint8Array(buffer);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (u32(dv, i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('This file is not a zip archive');
  let count = u16(dv, end + 10), offset = u32(dv, end + 16);
  // Zip64: the real count and offset are in the Zip64 end record, found through its locator
  if ((count === 0xffff || offset === 0xffffffff) && end >= 20 && u32(dv, end - 20) === 0x07064b50) {
    const rec = u64(dv, end - 12);
    count = u64(dv, rec + 32);
    offset = u64(dv, rec + 48);
  }
  const names = new TextDecoder('utf-8');
  const entries = [];
  for (let p = offset, k = 0; k < count; k++) {
    if (u32(dv, p) !== 0x02014b50) throw new Error('The zip archive is damaged');
    const method = u16(dv, p + 10);
    let csize = u32(dv, p + 20), size = u32(dv, p + 24), local = u32(dv, p + 42);
    const nlen = u16(dv, p + 28), xlen = u16(dv, p + 30), clen = u16(dv, p + 32);
    const name = names.decode(bytes.subarray(p + 46, p + 46 + nlen)).replace(/\\/g, '/');
    for (let x = p + 46 + nlen; x < p + 46 + nlen + xlen;) {
      const id = u16(dv, x), len = u16(dv, x + 2);
      if (id === 1) { // Zip64 sizes, in this order, only for the fields that overflowed
        let q = x + 4;
        if (size === 0xffffffff) { size = u64(dv, q); q += 8; }
        if (csize === 0xffffffff) { csize = u64(dv, q); q += 8; }
        if (local === 0xffffffff) local = u64(dv, q);
      }
      x += 4 + len;
    }
    entries.push({ name, size, csize, method, local, dir: name.endsWith('/') });
    p += 46 + nlen + xlen + clen;
  }

  async function read(e) {
    if (u32(dv, e.local) !== 0x04034b50) throw new Error(`The zip archive is damaged (${e.name})`);
    const start = e.local + 30 + u16(dv, e.local + 26) + u16(dv, e.local + 28);
    const data = bytes.subarray(start, start + e.csize);
    if (e.method === 0) return data;
    if (e.method !== 8) throw new Error(`Unsupported compression in ${e.name}`);
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  return { entries: entries.filter(e => !e.dir), read };
}
