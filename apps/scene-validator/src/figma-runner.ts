/** Shared export runner for the local application and developer tooling. */
import { mkdir, mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { inflateSync } from 'node:zlib';
import { pngPixels } from './figma-png.js';
import { createHash } from 'node:crypto';
import { frameExportCode, discoveryCode, previewSignatureCode } from './figma-code.js';
import { assembleFigmaExport, decodeFigmaPacket, type FigmaOrigin } from './figma-mcp.js';
export interface FigmaMcpTransport {
    call(name: 'create_session' | 'use_figma' | 'download_assets', args: Record<string, unknown>): Promise<unknown>;
    /** Authorized asset download. Implementations must fail on HTTP errors/empty files. */
    download(url: string): Promise<Buffer>;
}
function result(value: any): any {
    if (value.isError)
        throw new Error(value.content?.filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n') ?? 'Figma MCP error');
    if (value.structuredContent)
        return value.structuredContent;
    if (value.content)
        return JSON.parse(value.content.find((x: any) => x.type === 'text').text);
    return value;
}
function assetUrl(value: unknown): string {
    if (typeof value !== 'string')
        throw new Error('Missing Figma asset URL');
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.hostname !== 'www.figma.com' || !u.pathname.startsWith('/api/mcp/asset/') || u.username || u.password)
        throw new Error('Unexpected Figma asset URL');
    return value;
}
/** Checks chunk sequence and remote snapshot consistency before inflation. */
export function joinFigmaChunks(chunks: any[]): {
    encoding: string;
    data: string;
} {
    if (chunks.length === 1 && chunks[0].encoding === 'deflate-base64')
        return chunks[0];
    const first = chunks[0];
    let data = '';
    for (const part of chunks) {
        if (part.encoding !== 'deflate-base64-chunk' || part.offset !== data.length || part.total !== first.total || part.checksum !== first.checksum || typeof part.data !== 'string' || part.data.length > 42000)
            throw new Error('Invalid Figma chunk sequence');
        data += part.data;
    }
    let checksum = 2166136261;
    for (let i = 0; i < data.length; i++)
        checksum = Math.imul(checksum ^ data.charCodeAt(i), 16777619) >>> 0;
    if (data.length !== first.total || data.length > 24 * 1024 * 1024 || checksum !== first.checksum)
        throw new Error('Incomplete or changed Figma transfer');
    return { encoding: 'deflate-base64', data };
}
async function pool<T, R>(items: T[], fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const out: R[] = [];
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(2, items.length) }, async () => { while (cursor < items.length) {
        const i = cursor++;
        out[i] = await fn(items[i], i);
    } }));
    return out;
}
export async function exportFigmaWithMcp(client: FigmaMcpTransport, options: {
    origin: FigmaOrigin;
    frameIds?: string[];
    outputDirectory: string;
    cacheDirectory: string;
    onProgress?: (stage: string, message: string) => Promise<void>;
}) {
    const started = Date.now(), timings: Record<string, number> = {};
    const session = result(await client.call('create_session', { fileKey: options.origin.fileKey, description: 'Internal Motion export/refresh' }));
    const args = { fileKey: options.origin.fileKey, sessionId: session.sessionId };
    const selection = result(await client.call('use_figma', { ...args, skillNames: 'figma-use', description: 'Inspect export source', code: discoveryCode(options.origin) }));
    // On refresh pass saved frameIds; never silently change the selected storyboard.
    const frameIds = options.frameIds ?? selection.frames.map((f: any) => f.id);
    if (!frameIds.length || frameIds.some((id: string) => !selection.frames.some((f: any) => f.id === id)))
        throw new Error('Saved Figma frame selection no longer exists');
    await options.onProgress?.('found', `Найдены кадры: ${frameIds.length}`);
    await options.onProgress?.('exporting', 'Экспортируем слои и изображения…');
    timings.discoveryMs = Date.now() - started;
    const exportStart = Date.now();
    const captures = await pool<string, any>(frameIds, async (frameId) => {
        const capturedAt = new Date().toISOString();
        const code = await frameExportCode(options.origin, frameId, 0, capturedAt);
        // Metadata and preview URLs are independent, and there is no repeated probing/export loop.
        const [wire, assets] = await Promise.all([
            client.call('use_figma', { ...args, skillNames: 'figma-use', description: `Export frame ${frameId}`, code }),
            client.call('download_assets', { ...args, nodeId: frameId, defaultFormat: 'png', defaultScale: 1 }),
        ]);
        const first = result(wire), chunks = [first];
        if (first.encoding === 'deflate-base64-chunk') {
            if (!Number.isSafeInteger(first.total) || first.total < 1 || first.total > 24 * 1024 * 1024)
                throw new Error('Invalid Figma transfer size');
            for (let offset = first.data.length; offset < first.total;) {
                const part = result(await client.call('use_figma', { ...args, skillNames: 'figma-use', description: `Export frame ${frameId}, continuation`, code: await frameExportCode(options.origin, frameId, offset, capturedAt) }));
                if (part.offset !== offset || part.total !== first.total || part.checksum !== first.checksum || !part.data?.length || part.data.length > 42000)
                    throw new Error('Кадр изменился во время экспорта. Повтори импорт.');
                chunks.push(part);
                offset += part.data.length;
            }
        }
        return { packet: decodeFigmaPacket(joinFigmaChunks(chunks)), assets: result(assets) };
    });
    timings.captureMs = Date.now() - exportStart;
    await options.onProgress?.('downloading', 'Скачиваем исходные изображения…');
    const downloadStart = Date.now();
    await mkdir(options.cacheDirectory, { recursive: true });
    const known = new Set<string>();
    for (const entry of await readdir(options.cacheDirectory, { withFileTypes: true }))
        if (entry.isFile() && entry.name.startsWith('raw-')) {
            const bytes = await readFile(path.join(options.cacheDirectory, entry.name));
            known.add(createHash('sha1').update(bytes).digest('hex'));
        }
    const downloads = await mkdtemp(path.join(os.tmpdir(), 'figma-transfer-'));
    try {
        await pool(captures, async ({ packet, assets }) => {
            const bytes = await client.download(assetUrl(assets.export.url));
            if (!bytes.length || bytes.length !== assets.export.sizeBytes)
                throw new Error('Invalid preview download');
            const preview = packet.manifest.find((m: any) => m.path.startsWith('previews/'));
            if (preview && preview.bytes !== bytes.length) {
                const expected = result(await client.call('use_figma', { ...args, skillNames: 'figma-use', description: 'Verify preview pixels against canonical PNG export', code: await previewSignatureCode(options.origin.pageId, packet.frameId) }));
                const actual = pngPixels(bytes, b => inflateSync(b, { maxOutputLength: 161 * 1024 * 1024 }));
                if(actual.width!==expected.width||actual.height!==expected.height)throw new Error('Размер превью не соответствует исходному экспорту Figma.');
                if(actual.hash!==expected.hash)packet.report.warnings.push({code:'MCP_PREVIEW_RENDER_DIFFERENCE',figmaNodeId:packet.frameId,message:'Figma download_assets preview pixels differ from Plugin API exportAsync. Scene geometry and original assets are preserved; preview is a reference only.'});
                // The reference PNG comes from download_assets; its encoding is not the canonical exportAsync file.

                preview.bytes = bytes.length;
            }
            await writeFile(path.join(downloads, `preview-${packet.frameId.replace(':', '-')}.png`), bytes);
        });
        const needed = new Set<string>(captures.flatMap(({ packet }) => JSON.parse(packet.texts['scene.json']).assets.filter((a: any) => a.kind === 'image').map((a: any) => a.imageHash)));
        // Start with richest frame; endpoint may return duplicates/rendered variants, so verify SHA-1.
        const richest = [...captures].sort((a, b) => b.assets.rawImages.length - a.assets.rawImages.length);
        for (const capture of richest) {
            if ([...needed].every(h => known.has(h)))
                break;
            await pool<any, void>(capture.assets.rawImages, async (asset) => {
                const bytes = await client.download(assetUrl(asset.url));
                if (!bytes.length)
                    throw new Error('Empty original image download');
                const sha = createHash('sha1').update(bytes).digest('hex');
                if (needed.has(sha)) {
                    await writeFile(path.join(options.cacheDirectory, `raw-${sha}`), bytes);
                    known.add(sha);
                }
            });
        }
        // Capped raw-image lists are not silently accepted. Missing hashes block assembly.
        for (const h of needed) {
            const bytes = await readFile(path.join(options.cacheDirectory, `raw-${h}`));
            await writeFile(path.join(downloads, `raw-${h}`), bytes);
        }
        timings.downloadMs = Date.now() - downloadStart;
        const assembled = await assembleFigmaExport({ packets: captures.map(x => x.packet), frameIds, downloadsDirectory: downloads, outputDirectory: options.outputDirectory });
        timings.totalMs = Date.now() - started;
        await writeFile(path.join(options.outputDirectory, 'transfer-metrics.json'), JSON.stringify({ timings, frames: frameIds.length, originalImages: needed.size }, null, 2));
        return { ...assembled, timings };
    }
    finally {
        await rm(downloads, { recursive: true, force: true });
    }
}
/** Explicit pull: use stored origin and frame order, then atomically refresh the source. */
export async function refreshFigmaWithMcp(client: FigmaMcpTransport, options: {
    projectPath: string;
    outputDirectory: string;
    cacheDirectory: string;
}) {
    const { figmaRefreshSource, importFigmaExport } = await import('./figma-mcp.js');
    const link = await figmaRefreshSource(options.projectPath);
    const exported = await exportFigmaWithMcp(client, { ...options, origin: { fileKey: link.fileKey, pageId: link.pageId, sectionId: link.sectionId }, frameIds: link.frameIds });
    const imported = await importFigmaExport({ source: exported.zipPath, link: exported.link, projectPath: options.projectPath });
    return { exported, imported };
}
