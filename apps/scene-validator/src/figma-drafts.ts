import { requestedFile, resolveFrames } from './figma-selection.js';
import { mkdir, readFile, readdir, writeFile, rename, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FigmaConnection, figmaResult } from './figma-connection.js';
import { exportFigmaWithMcp } from './figma-runner.js';
import { discoverProjects } from './management.js';
import { createProject } from './importer.js';
import { noSymlinkPath } from './files.js';
export type Draft = {
    projectId: string;
    name: string;
    draft: true;
    status: 'empty' | 'importing' | 'failed' | 'ready';
    updatedAt: string;
    messages: {
        role: 'user' | 'assistant';
        text: string;
        stage?: string;
    }[];
};
const normalize = (s: string) => s.toLocaleLowerCase().replace(/[«»“”"'?]/g, '').replace(/\s+/g, ' ').trim();
export function selectNamed<T extends {
    name: string;
}>(items: T[], prompt: string, label: string): T {
    const text = normalize(prompt), matches = items.filter(item => { const n = normalize(item.name); return n && new RegExp(`(^|[^\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(text); });
    if (matches.length !== 1)
        throw new Error(`Уточни ${label}: ${items.map(x => `«${x.name}»`).join(', ')}.`, {cause: matches.length > 1 ? 'ambiguous' : 'missing'});
    return matches[0];
}
export class FigmaDrafts {
    private active = new Set<string>();
    constructor(private root: string, private cwd: string) { }
    private file(id: string) { if (!/^[0-9a-f-]{36}$/.test(id))
        throw new Error('Invalid project ID'); return path.join(this.root, '.drafts', `${id}.json`); }
    async save(d: Draft) { const file = this.file(d.projectId); await mkdir(path.dirname(file), { recursive: true }); await noSymlinkPath(this.root, path.dirname(file)); d.updatedAt = new Date().toISOString(); const temp = `${file}.${randomUUID()}.tmp`; try {
        await writeFile(temp, JSON.stringify(d, null, 2), { flag: 'wx' });
        await rename(temp, file);
    }
    finally {
        await rm(temp, { force: true });
    } }
    async get(id: string): Promise<Draft | undefined> { const file = this.file(id); try {
        await noSymlinkPath(this.root, file);
        return JSON.parse(await readFile(file, 'utf8'));
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT')
            return;
        throw e;
    } }
    async list() { await mkdir(path.join(this.root, '.drafts'), { recursive: true }); await noSymlinkPath(this.root, path.join(this.root, '.drafts')); const out: Draft[] = []; for (const name of await readdir(path.join(this.root, '.drafts'))) {
        if (!name.endsWith('.json'))
            continue;
        const d = await this.get(name.slice(0, -5));
        if (d && d.status !== 'ready')
            out.push(d);
    } return out; }
    async recover() {
        const committed = (await discoverProjects(this.root)).projects;
        for (const d of await this.list()) {
            const project = committed.find(p => p.config.projectId === d.projectId);
            if (project) {
                d.status = 'ready';
                d.name = project.config.name;
                d.messages.push({ role: 'assistant', stage: 'ready', text: `Готово: ${project.inspection.document.scenes.length} сцен. Теперь опиши анимацию.` });
                await this.save(d);
            }
            else if (d.status === 'importing') {
                d.status = 'failed';
                d.messages.push({ role: 'assistant', text: 'Сервер перезапустился. Отправь запрос ещё раз, чтобы повторить импорт.' });
                await this.save(d);
            }
        }
    }
    async create() { const d: Draft = { projectId: randomUUID(), name: 'Новый проект', draft: true, status: 'empty', updatedAt: new Date().toISOString(), messages: [] }; await this.save(d); return d; }
    async start(id: string, prompt: string) {
        if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000)
            throw new Error('Напиши, какой файл, страницу и раскадровку импортировать (до 8000 символов).');
        if (this.active.size >= 2 && !this.active.has(id))
            throw new Error('Дождись завершения текущих импортов.');
        if (this.active.has(id))
            throw new Error('Импорт уже выполняется.');
        this.active.add(id);
        try {
            const d = await this.get(id);
            if (!d || d.status === 'ready')
                throw new Error('Пустой проект не найден.');
            d.status = 'importing';
            d.messages.push({ role: 'user', text: prompt });
            await this.save(d);
            void this.run(d).catch(() => { }).finally(() => this.active.delete(id));
            return d;
        }
        catch (e) {
            this.active.delete(id);
            throw e;
        }
    }
    private async run(d: Draft) {
        const client = new FigmaConnection();
        let temporary: string | undefined;
        const progress = async (stage: string, text: string) => { d.messages.push({ role: 'assistant', text, stage }); await this.save(d); };
        try {
            await progress('searching', 'Ищем файл и раскадровку в Figma…');
            await client.connect(this.cwd);
            const requests = d.messages.filter(x => x.role === 'user').map(x => x.text);
            const catalogPath = path.join(this.root, '.figma-files.json');
            let catalog: {
                fileKey: string;
                name: string;
            }[] = [];
            try {
                await noSymlinkPath(this.root, catalogPath);
                catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
            }
            catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
                    throw e;
            }
            const file=requestedFile(requests,catalog);
            const section=await resolveFrames(client,file,requests);
            if(!catalog.some(x=>x.fileKey===file.fileKey&&x.name===file.name)){
                catalog=catalog.filter(x=>x.fileKey!==file.fileKey);
                catalog.push({fileKey:file.fileKey,name:file.name});
                const tmp=catalogPath+'.'+randomUUID()+'.tmp';
                await writeFile(tmp,JSON.stringify(catalog,null,2),{flag:'wx'});
                await rename(tmp,catalogPath);
            }
            const page={id:section.pageId,name:section.pageName};
            await progress('located', `Нашли: ${file.name} → ${page.name} → ${section.name}.`);
            temporary = await mkdtemp(path.join(this.root, '.figma-import-'));
            const exported = await exportFigmaWithMcp(client, { origin: { fileKey: file.fileKey, pageId: page.id, sectionId: section.id }, frameIds:section.frameIds, outputDirectory: path.join(temporary, 'export'), cacheDirectory: path.join(this.root, '.figma-cache'), onProgress: progress });
            await progress('importing', 'Импортируем и проверяем исходники…');
            const imported = await createProject({ source: exported.zipPath, figmaSource: exported.link, name: section.name, projectsRoot: this.root, projectPath: path.join(this.root, `figma-${d.projectId}`), initialProjectId: d.projectId });
            d.name = imported.config.name;
            d.status = 'ready';
            await progress('ready', `Готово: ${imported.inspection.document.scenes.length} сцен. Теперь опиши анимацию.`);
        }
        catch (e) {
            d.status = 'failed';
            await progress('failed', e instanceof Error ? e.message : String(e));
        }
        finally {
            client.close();
            if (temporary)
                await rm(temporary, { recursive: true, force: true });
        }
    }
}
