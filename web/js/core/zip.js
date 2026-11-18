// Zip sin compresion (store) en el navegador, para descargar la copia local de una sesion.
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const header = (size, fill) => {
  const view = new DataView(new ArrayBuffer(size));
  fill(view);
  return view.buffer;
};

export async function zipBlob(entries) {
  const encoder = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { path, blob } of entries) {
    const name = encoder.encode(path);
    const data = new Uint8Array(await blob.arrayBuffer());
    const crc = crc32(data);
    const common = (view, at) => {
      view.setUint16(at, 20, true);
      view.setUint16(at + 2, 0x0800, true);
      view.setUint16(at + 4, 0, true);
      view.setUint16(at + 8, 33, true);
      view.setUint32(at + 10, crc, true);
      view.setUint32(at + 14, data.length, true);
      view.setUint32(at + 18, data.length, true);
      view.setUint16(at + 22, name.length, true);
    };
    parts.push(header(30, (view) => (view.setUint32(0, 0x04034b50, true), common(view, 4))), name, data);
    central.push(
      header(46, (view) => {
        view.setUint32(0, 0x02014b50, true);
        view.setUint16(4, 20, true);
        common(view, 6);
        view.setUint32(42, offset, true);
      }),
      name,
    );
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((sum, part) => sum + (part.byteLength ?? part.length), 0);
  const end = header(22, (view) => {
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(8, entries.length, true);
    view.setUint16(10, entries.length, true);
    view.setUint32(12, size, true);
    view.setUint32(16, offset, true);
  });
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
