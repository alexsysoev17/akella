/** SDK readline treats U+2028/U+2029 as record separators on supported Node
 * runtimes. Escape those JSON string codepoints before SDK framing; preserve
 * the exact decoded message. Never join malformed records or repair JSON. */
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
const [binary, ...args] = process.argv.slice(2);
const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'inherit'], shell: false });
const decoder = new StringDecoder('utf8');
const encode = text => text.replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
child.stdout.on('data', chunk => { if (!process.stdout.write(encode(decoder.write(chunk)))) child.stdout.pause(); });
process.stdout.on('drain', () => child.stdout.resume());
child.stdout.on('end', () => process.stdout.write(encode(decoder.end())));
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => {});
child.on('error', error => { process.stderr.write(String(error)); process.exitCode = 1; });
let killTimer;
child.on('close', (code, signal) => { clearTimeout(killTimer); process.exitCode = code ?? (signal ? 1 : 0); });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { child.kill(signal); if(!killTimer){killTimer=setTimeout(()=>child.kill('SIGKILL'),1000);killTimer.unref();} });
