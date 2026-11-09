import { open, stat } from "node:fs/promises";
/** OpenType name-table metadata only. No glyph loading, font substitution or metric guesses. */
export async function fontFamilyNames(file: string) {
  const handle = await open(file, "r"),
    size = (await stat(file)).size,
    names = new Set<string>();
  async function bytes(offset: number, length: number) {
    if (
      offset < 0 ||
      length < 0 ||
      offset + length > size ||
      length > 1024 * 1024
    )
      throw new Error("Invalid OpenType table bounds");
    const data = Buffer.alloc(length);
    const read = await handle.read(data, 0, length, offset);
    if (read.bytesRead !== length) throw new Error("Truncated font table");
    return data;
  }
  try {
    const head = await bytes(0, 12);
    let faces = [0];
    if (head.toString("ascii", 0, 4) === "ttcf") {
      const count = head.readUInt32BE(8);
      if (count > 256) throw new Error("Too many font collection faces");
      const offsets = await bytes(12, count * 4);
      faces = Array.from({ length: count }, (_, i) =>
        offsets.readUInt32BE(i * 4),
      );
    }
    for (const offset of faces) {
      const h = await bytes(offset, 12),
        count = h.readUInt16BE(4);
      if (count > 4096) continue;
      const tables = await bytes(offset + 12, count * 16);
      for (let i = 0; i < count; i++) {
        const at = i * 16;
        if (tables.toString("ascii", at, at + 4) !== "name") continue;
        const start = tables.readUInt32BE(at + 8),
          length = tables.readUInt32BE(at + 12);
        if (length > 1024 * 1024) continue;
        const table = await bytes(start, length);
        if (table.length < 6) continue;
        const records = table.readUInt16BE(2),
          strings = table.readUInt16BE(4);
        for (let j = 0; j < records; j++) {
          const r = 6 + j * 12;
          if (r + 12 > table.length) break;
          const platform = table.readUInt16BE(r),
            id = table.readUInt16BE(r + 6),
            length = table.readUInt16BE(r + 8),
            offset = strings + table.readUInt16BE(r + 10);
          if (![1, 16].includes(id) || offset + length > table.length) continue;
          let name = "";
          if (platform === 0 || platform === 3)
            name = new TextDecoder("utf-16be").decode(
              table.subarray(offset, offset + length),
            );
          else if (platform === 1)
            name = new TextDecoder("macintosh").decode(
              table.subarray(offset, offset + length),
            );
          name = name.replace(/\0/g, "").trim();
          if (name) names.add(name);
        }
      }
    }
    return [...names];
  } finally {
    await handle.close();
  }
}
