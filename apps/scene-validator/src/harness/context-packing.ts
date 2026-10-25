import { isDeepStrictEqual } from 'node:util';
/** Lossless JSON transport only. No target selection, numerical rounding or prompt rewriting. */
type Json = null | boolean | number | string | Json[] | {
    [key: string]: Json;
};
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v) ?? "null");
const reserved = new Set(['$s', '$columns', '$rows', '$object']);
export const contextEncodingInstructions = '\nContext encoding akella-columns/1 is lossless JSON: strings[index] is the original string for {"$s":index}; {"$columns":[keys],"$rows":[values]} represents objects made by pairing each row with those keys. {"$object":[[key,value]]} escapes a literal object. Apply recursively to data. Dictionary indices are NOT object IDs: return real canonical IDs/names. All numbers and source text remain exact.\n';
export function packContext(input: unknown) {
    const original = JSON.parse(JSON.stringify(input)) as Json;
    const counts = new Map<string, number>();
    const scan = (v: Json): void => {
        if (typeof v === 'string')
            counts.set(v, (counts.get(v) ?? 0) + 1);
        else if (v && typeof v === 'object')
            Object.values(v).forEach(scan);
    };
    scan(original);
    const strings = [...counts].filter(([s, n]) => n > 1 && (bytes(s) - 12) * n > bytes(s) + 4).map(([s]) => s);
    const references = new Map(strings.map((s, i) => [s, i]));
    const encode = (v: Json): Json => {
        if (typeof v === 'string' && references.has(v))
            return { $s: references.get(v)! };
        if (Array.isArray(v)) {
            const rows = v.map(encode);
            if (rows.length > 1 && rows.every(r => r !== null && typeof r === 'object' && !Array.isArray(r))) {
                const objects = rows as {
                    [k: string]: Json;
                }[], columns = Object.keys(objects[0]);
                if (columns.every(k => !reserved.has(k)) && objects.every(r => Object.keys(r).length === columns.length && columns.every(k => Object.hasOwn(r, k)))) {
                    const table = { $columns: columns, $rows: objects.map(r => columns.map(k => r[k])) };
                    if (bytes(table) < bytes(rows))
                        return table;
                }
            }
            return rows;
        }
        if (v && typeof v === 'object') {
            const entries = Object.entries(v).map(([k, x]) => [k, encode(x)] as [
                string,
                Json
            ]);
            if (entries.some(([k]) => reserved.has(k)))
                return { $object: entries };
            return Object.fromEntries(entries);
        }
        return v;
    };
    const data = encode(original);
    const packed = { encoding: 'akella-columns/1', strings, data };
    if (!isDeepStrictEqual(unpackContext(packed), original))
        throw Error('CONTEXT_PACKING_INVARIANT');
    const changedCategories = original && typeof original === 'object' && !Array.isArray(original) && data && typeof data === 'object' && !Array.isArray(data)
        ? Object.keys(original).filter(k => bytes(original[k]) !== bytes((data as {
            [k: string]: Json;
        })[k])) : [];
    return { value: packed, changedCategories, originalBytes: bytes(original), packedBytes: bytes(packed) };
}
/** Decoder is also the admission invariant used by tests and deterministic adapters. */
export function unpackContext(input: unknown): unknown {
    const v = input as {
        encoding?: string;
        strings?: string[];
        data?: Json;
    };
    if (v?.encoding !== 'akella-columns/1')
        return input;
    if (!Array.isArray(v.strings))
        throw Error('INVALID_CONTEXT_DICTIONARY');
    const decode = (x: Json): Json => {
        if (Array.isArray(x))
            return x.map(decode);
        if (!x || typeof x !== 'object')
            return x;
        if (Object.hasOwn(x, '$s') && Object.keys(x).length === 1) {
            const i = x.$s;
            if (typeof i !== 'number' || !Number.isSafeInteger(i) || i < 0 || i >= v.strings!.length)
                throw Error('INVALID_CONTEXT_REFERENCE');
            return v.strings![i];
        }
        if (Array.isArray(x.$object) && Object.keys(x).length === 1)
            return Object.fromEntries((x.$object as [
                string,
                Json
            ][]).map(([k, y]) => [k, decode(y)]));
        if (Array.isArray(x.$columns) && Array.isArray(x.$rows) && Object.keys(x).length === 2) {
            const keys = x.$columns as string[];
            return (x.$rows as Json[][]).map(row => { if (row.length !== keys.length)
                throw Error('INVALID_CONTEXT_ROW'); return Object.fromEntries(keys.map((k, i) => [k, decode(row[i])])); });
        }
        return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, decode(y)]));
    };
    return decode(v.data!);
}
