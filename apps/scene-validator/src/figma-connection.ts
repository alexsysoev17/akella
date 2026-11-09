import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { codexBinary } from './harness/providers/codex.js';
import type { FigmaMcpTransport } from './figma-runner.js';
export function figmaResult(value: any): any {
    if (value?.isError)
        throw new Error(value.content?.filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n') || 'Figma MCP error');
    return value.structuredContent ?? JSON.parse(value.content.find((x: any) => x.type === 'text').text);
}
/** Own ephemeral Codex session; uses supported app-server RPC, never reads stored tokens. */
export class FigmaConnection implements FigmaMcpTransport {
    private child?: ChildProcessWithoutNullStreams;
    private seq = 0;
    private pending = new Map<number, {
        resolve: (value: any) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }>();
    private threadId = '';
    async connect(cwd: string) {
        this.child = spawn(await codexBinary(), ['app-server', '-c', 'mcp_servers={}'], { stdio: 'pipe' });
        this.child.stderr.resume();
        this.child.stdin.on('error', () => this.fail('Соединение с Codex прервано.'));
        this.child.on('error', () => this.fail('Не удалось запустить Codex.'));
        this.child.on('exit', () => this.fail('Соединение с Codex закрыто.'));
        createInterface({ input: this.child.stdout }).on('line', line => {
            let m: any;
            try {
                m = JSON.parse(line);
            }
            catch {
                return;
            }
            if (m.method && m.id !== undefined) {
                this.child?.stdin.write(JSON.stringify({ id: m.id, error: { code: -32601, message: 'Interactive requests require user action in Codex' } }) + '\n');
                return;
            }
            const p = this.pending.get(m.id);
            if (!p)
                return;
            clearTimeout(p.timer);
            this.pending.delete(m.id);
            if (m.error)
                p.reject(new Error(m.error.message || 'Codex RPC error'));
            else
                p.resolve(m.result);
        });
        await this.rpc('initialize', { clientInfo: { name: 'akella', version: '0.1.0' }, capabilities: { experimentalApi: true } });
        this.child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
        const t = await this.rpc('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true });
        this.threadId = t.thread.id;
        const status = await this.rpc('mcpServerStatus/list', { threadId: this.threadId, detail: 'toolsAndAuthOnly', serverName: 'codex_apps' });
        if (!status.data?.some((s: any) => s.tools?.['figma.use_figma']))
            throw new Error('Подключи Figma в Codex, затем повтори импорт.');
        await this.call('whoami', {});
    }
    private rpc(method: string, params: unknown): Promise<any> {
        return new Promise((resolve, reject) => { const id = ++this.seq; const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Figma не ответила вовремя. Повтори импорт.')); }, 180000); this.pending.set(id, { resolve, reject, timer }); this.child!.stdin.write(JSON.stringify({ id, method, params }) + '\n'); });
    }
    private fail(message: string) { for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(message));
    } this.pending.clear(); }
    call(name: 'create_session' | 'use_figma' | 'download_assets' | 'whoami', args: Record<string, unknown>) {
        if (!['create_session', 'use_figma', 'download_assets', 'whoami'].includes(name))
            throw new Error('Unsupported Figma operation');
        return this.rpc('mcpServer/tool/call', { threadId: this.threadId, server: 'codex_apps', tool: `figma.${name}`, arguments: args }).then(r => { if (r.isError)
            figmaResult(r); return r; });
    }
    async download(url: string): Promise<Buffer> {
        const u = new URL(url);
        if (u.protocol !== 'https:' || u.hostname !== 'www.figma.com' || !u.pathname.startsWith('/api/mcp/asset/'))
            throw new Error('Invalid Figma asset URL');
        const response = await fetch(url, { signal: AbortSignal.timeout(60000), redirect: 'error' });
        if (!response.ok)
            throw new Error(`Figma download HTTP ${response.status}`);
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of response.body as any) {
            size += chunk.length;
            if (size > 64 * 1024 * 1024)
                throw new Error('Figma asset exceeds 64 MiB');
            chunks.push(Buffer.from(chunk));
        }
        if (!size)
            throw new Error('Figma вернула пустой файл. Повтори импорт.');
        return Buffer.concat(chunks);
    }
    close() { this.fail('Соединение завершено.'); this.child?.kill(); }
}
