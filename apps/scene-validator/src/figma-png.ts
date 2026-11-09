/** PNG pixel signature, independent of compression and metadata chunks. Figma PNGs use RGB(A)8. */
export function pngPixels(bytes: Uint8Array, inflate: (bytes: Uint8Array) => Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 33 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a)
        throw new Error('Invalid PNG');
    const width = view.getUint32(16), height = view.getUint32(20), color = bytes[25], channels = color === 6 ? 4 : color === 2 ? 3 : 0;
    if (bytes[24] !== 8 || !channels || bytes[28] !== 0 || !width || !height || width * height > 40000000)
        throw new Error('Unsupported Figma preview PNG');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (let offset = 8; offset + 12 <= bytes.length;) {
        const length = view.getUint32(offset);
        if (offset + 12 + length > bytes.length)
            throw new Error('Truncated PNG');
        if (view.getUint32(offset + 4) === 0x49444154) {
            const chunk = bytes.subarray(offset + 8, offset + 8 + length);
            chunks.push(chunk);
            size += length;
        }
        offset += 12 + length;
    }
    const compressed = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
        compressed.set(c, offset);
        offset += c.length;
    }
    const data = inflate(compressed), stride = width * channels;
    if (data.length !== (stride + 1) * height)
        throw new Error('Invalid PNG pixel size');
    let hash = 2166136261;
    const previous = new Uint8Array(stride), row = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
        const filter = data[y * (stride + 1)];
        if (filter > 4)
            throw new Error('Invalid PNG filter');
        for (let x = 0; x < stride; x++) {
            const left = x >= channels ? row[x - channels] : 0, up = previous[x], corner = x >= channels ? previous[x - channels] : 0;
            let prediction = 0;
            if (filter === 1)
                prediction = left;
            if (filter === 2)
                prediction = up;
            if (filter === 3)
                prediction = (left + up) >>> 1;
            if (filter === 4) {
                const p = left + up - corner, a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - corner);
                prediction = a <= b && a <= c ? left : b <= c ? up : corner;
            }
            row[x] = (data[y * (stride + 1) + 1 + x] + prediction) & 255;
            hash = Math.imul(hash ^ row[x], 16777619) >>> 0;
            if (channels === 3 && x % 3 === 2)
                hash = Math.imul(hash ^ 255, 16777619) >>> 0;
        }
        previous.set(row);
    }
    return { width, height, hash };
}
