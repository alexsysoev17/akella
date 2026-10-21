/** LEVEL 2. The model has NO process/filesystem tools. Trusted backend materializes
 * bounded file proposals only in a quarantine copy; generated tests run under OS confinement. */
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, copyFile, lstat, realpath } from "node:fs/promises";
import { z } from "zod";
import { createRequire } from "node:module";
import { noSymlinkPath, relativePath, within, atomicJson } from "../../files.js";
import { redactSecrets } from "../security.js";
import type { RecoveryFailure } from "./failure.js";
const exec = promisify(execFile);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const identityFields = { path: z.string().max(250), beforeHash: z.string().regex(/^[a-f0-9]{64}$/) };
const fileChange = z.union([
    z.object({ ...identityFields, content: z.string().max(80000) }).strict(),
    z.object({ ...identityFields, edits: z.array(z.object({ find: z.string().min(1).max(8000), replace: z.string().max(12000) }).strict()).min(1).max(20) }).strict(),
]);
export const codeProposalSchema = z.object({ rootCause: z.string().min(1).max(3000), changes: z.array(fileChange).min(1).max(6), regressionTests: z.array(z.string().max(250)).min(1).max(3), risks: z.array(z.string().max(1000)).max(10) }).strict();
export type CodeProposal = z.infer<typeof codeProposalSchema>;
const sourceAllowed = (p: string) =>
    /^apps\/scene-validator\/src\/(?:motion\/(?:intent\/(?:compiler|execution|retime|planner|schema)|provider|tools|operations|contextual-resolution|base-motion|transitions|validate-expressions|schema|constraints|intervals|effect-edit|service)|motion-library\/(?:expressions\/registry|easings\/registry|techniques\/registry)|harness\/(?:recovery\/(?:failure|memory|runtime)|providers\/(?:schema|types|codex))|native\/(?:qa|renderer)|files)\.ts$/.test(
        p,
    );
const testAllowed = (p: string) => /^apps\/scene-validator\/tests\/[a-z0-9-]+\.test\.ts$/.test(p);
export type CodeRepairWorkspace = {
    id: string;
    root: string;
    baseCommit: string;
    files: {
        path: string;
        hash: string;
        content: string;
    }[];
};
export function scopedCodeProposalSchema(workspace: CodeRepairWorkspace) {
    const regressionPath = `apps/scene-validator/tests/code-repair-${workspace.id}.test.ts`;
    const paths = z.enum([regressionPath,...workspace.files.map(f=>f.path)] as [string,...string[]]);
    return {regressionPath,schema:codeProposalSchema.extend({
        changes:z.array(z.union([fileChange.options[0].extend({path:paths}),fileChange.options[1].extend({path:paths})])).min(1).max(6),
        regressionTests:z.array(z.literal(regressionPath)).min(1).max(1),
    })};
}
/** Narrow deterministic correction of NEW-test metadata, never of assertions or
 * source edits. Existing files and source write boundaries are unchanged. */
export function normalizeCodeProposal(workspace: CodeRepairWorkspace, input: unknown) {
    const proposal = codeProposalSchema.parse(input), relocations: {from:string;to:string}[] = [];
    const changes = proposal.changes.map(change => {
        if (workspace.files.some(f => f.path === change.path) || testAllowed(change.path)) return change;
        if (!/^apps\/scene-validator\/src\/[a-zA-Z0-9/_-]+\.test\.ts$/.test(change.path) || change.beforeHash !== hash("") || !("content" in change)) throw new Error("CODE_REPAIR_WRITE_SCOPE");
        const destination = `apps/scene-validator/tests/code-repair-${workspace.id}-${relocations.length}.test.ts`;
        // TypeScript's parser is needed only for this rare quarantined repair,
        // never on an ordinary prompt/render or a correctly scoped proposal.
        const ts: typeof import("typescript") = createRequire(import.meta.url)("typescript");
        const source = ts.createSourceFile(change.path, change.content, ts.ScriptTarget.Latest, true);
        const replacements: {start:number;end:number;text:string}[] = [];
        for (const statement of source.statements) {
            if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
            const specifier = statement.moduleSpecifier.text;
            if (!specifier.startsWith(".")) continue;
            const target = path.posix.normalize(path.posix.join(path.posix.dirname(change.path), specifier));
            if (!workspace.files.some(f => f.path === target || f.path === target.replace(/\.js$/, ".ts"))) throw new Error("CODE_REPAIR_TEST_IMPORT_SCOPE");
            let replacement = path.posix.relative(path.posix.dirname(destination), target);
            if (!replacement.startsWith(".")) replacement = "./" + replacement;
            replacements.push({start:statement.moduleSpecifier.getStart(source),end:statement.moduleSpecifier.end,text:JSON.stringify(replacement)});
        }
        let content = change.content;
        for (const edit of replacements.sort((a,b)=>b.start-a.start)) content = content.slice(0,edit.start)+edit.text+content.slice(edit.end);
        relocations.push({from:change.path,to:destination});
        return {...change,path:destination,content};
    });
    const newTests = changes.filter(c => testAllowed(c.path) && c.beforeHash === hash("")).map(c => c.path);
    const regressionTests = newTests.length ? newTests : proposal.regressionTests;
    return {proposal:{...proposal,changes,regressionTests},relocations};
}
/** Only tracked source/config/test files. No user project, media, logs, secrets or Git auth. */
export async function isolateCodeRepair(
    repository: string,
    failure: RecoveryFailure,
    requestedFiles: string[],
    options: { allowDirty?: boolean } = {},
): Promise<CodeRepairWorkspace> {
    if (!failure.codeRepairEligible)
        throw new Error("CODE_REPAIR_EVIDENCE_INSUFFICIENT");
    if (!requestedFiles.length || requestedFiles.length > 5 || requestedFiles.some(p => !sourceAllowed(p)))
        throw new Error("CODE_REPAIR_SOURCE_SCOPE");
    const baseCommit = (await exec("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
    if (!options.allowDirty && (await exec("git", ["status", "--porcelain"], { cwd: repository })).stdout.trim())
        throw new Error("CODE_REPAIR_REQUIRES_CLEAN_BASELINE");
    const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "akella-code-repair-")), id = randomUUID();
    const tracked = (await exec("git", ["ls-files", "-z"], { cwd: repository, maxBuffer: 2000000 })).stdout.split("\0").filter(Boolean);
    for (const rel of tracked) {
        if (!/^(?:apps\/scene-validator\/(?:src|tests)\/|figma-motion-exporter\/src\/|scripts\/|package(?:-lock)?\.json$|tsconfig(?:\.[a-z]+)?\.json$)/.test(rel))
            continue;
        const src = within(repository, rel);
        await noSymlinkPath(repository, src);
        if (!(await lstat(src)).isFile())
            throw new Error("CODE_REPAIR_UNSAFE_SOURCE");
        const dest = within(root, rel);
        await mkdir(path.dirname(dest), { recursive: true });
        await copyFile(src, dest);
    }
    const files = await Promise.all(requestedFiles.map(async (rel) => { const content = await readFile(within(root, rel), "utf8"); if (redactSecrets(content) !== content)
        throw new Error("CODE_REPAIR_SENSITIVE_SOURCE_REQUIRES_MANUAL_REPRODUCTION"); return { path: rel, hash: hash(content), content }; }));
    if (files.reduce((n, f) => n + Buffer.byteLength(f.content), 0) > 100000)
        throw new Error("CODE_REPAIR_CONTEXT_BUDGET");
    await exec("git", ["init", "-q", "-b", "codex/repair-" + id], { cwd: root });
    await exec("git", ["add", "--all"], { cwd: root });
    await exec("git", ["-c", "user.name=AKELLA Repair", "-c", "user.email=repair@localhost", "commit", "-qm", "Isolated reviewed source baseline"], { cwd: root });
    return { id, root, baseCommit, files };
}
export async function materializeCodeProposal(workspace: CodeRepairWorkspace, input: unknown) {
    const parsed = codeProposalSchema.parse(input);
    const changes = parsed.changes.map(change => {
        if ("content" in change)
            return change;
        const old = workspace.files.find(f => f.path === change.path);
        if (!old)
            throw new Error("CODE_REPAIR_EDIT_SCOPE");
        let content = old.content;
        for (const edit of change.edits) {
            if (content.split(edit.find).length !== 2)
                throw new Error("CODE_REPAIR_EDIT_NOT_UNIQUE");
            content = content.replace(edit.find, () => edit.replace);
        }
        return { path: change.path, beforeHash: change.beforeHash, content };
    });
    const proposal = { ...parsed, changes };
    const seen = new Set<string>();
    for (const change of proposal.changes) {
        relativePath(change.path);
        if (seen.has(change.path))
            throw new Error("CODE_REPAIR_DUPLICATE_PATH");
        seen.add(change.path);
        if (!workspace.files.some(f => f.path === change.path) && !testAllowed(change.path))
            throw new Error("CODE_REPAIR_WRITE_SCOPE");
        const dest = within(workspace.root, change.path);
        let before = "";
        try {
            await noSymlinkPath(workspace.root, dest);
            before = await readFile(dest, "utf8");
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT")
                throw e;
        }
        if (before && !workspace.files.some(f => f.path === change.path))
            throw new Error("CODE_REPAIR_EXISTING_TEST_IMMUTABLE");
        if (hash(before) !== change.beforeHash)
            throw new Error("CODE_REPAIR_BASE_HASH_MISMATCH");
        await mkdir(path.dirname(dest), { recursive: true });
        await noSymlinkPath(workspace.root, path.dirname(dest));
        await writeFile(dest, change.content, { flag: before ? "w" : "wx" });
    }
    if (proposal.regressionTests.some(p => !testAllowed(p) || !seen.has(p)))
        throw new Error("CODE_REPAIR_MISSING_NEW_REGRESSION");
    const identity = hash(JSON.stringify({ baseCommit: workspace.baseCommit, changes: proposal.changes }));
    await atomicJson(path.join(workspace.root, "proposal.json"), { version: "code-repair/1", id: workspace.id, baseCommit: workspace.baseCommit, patchIdentity: identity, status: "CODE_REPAIR_PROPOSED", proposal, tests: "NOT_RUN", promotion: "DISABLED" });
    // A portable diff; it is never applied to production by the runtime.
    const patches = [];
    for (const c of proposal.changes) {
        const before = workspace.files.find(f => f.path === c.path)?.content ?? "";
        const old = path.join(workspace.root, `.before-${patches.length}`);
        await writeFile(old, before);
        try {
            const result = await exec("diff", ["-u", "--label", "a/" + c.path, "--label", "b/" + c.path, old, within(workspace.root, c.path)], { maxBuffer: 1000000 });
            patches.push(result.stdout);
        }
        catch (e) {
            const result = e as {
                code?: number;
                stdout?: string;
            };
            if (result.code !== 1)
                throw e;
            patches.push(result.stdout ?? "");
        }
    }
    const patch = patches.join("\n"), patchDigest = hash(patch);
    await writeFile(path.join(workspace.root, "proposal.patch"), patch);
    await atomicJson(path.join(workspace.root, "proposal.json"), { version: "code-repair/1", id: workspace.id, baseCommit: workspace.baseCommit, patchIdentity: identity, patchDigest, status: "CODE_REPAIR_PROPOSED", proposal, tests: "NOT_RUN", promotion: "DISABLED" });
    return { workspace, proposal, patchIdentity: identity, patchDigest };
}
/** No shell. Test filenames are validated; child inherits an OS sandbox that forbids
 * production/home reads, writes outside quarantine and ALL network. No fallback. */
export async function testCodeProposal(repository: string, repair: Awaited<ReturnType<typeof materializeCodeProposal>>, signal?: AbortSignal) {
    const { workspace, proposal } = repair;
    if (process.platform !== "darwin")
        return { status: "BLOCKED" as const, reason: "OS_SANDBOX_UNAVAILABLE", tests: [] };
    const deps = await realpath(path.join(repository, "node_modules"));
    const node = await realpath(process.execPath);
    const esbuild = await realpath(path.join(deps, `@esbuild/darwin-${process.arch}/bin/esbuild`));
    const quoted = (p: string) => JSON.stringify(p);
    const profile = `(version 1)(deny default)(allow process*)(allow sysctl-read)(allow mach-lookup)(allow file-read-metadata)(allow file-read* (literal "/") (subpath "/System") (subpath "/usr") (subpath "/dev") (subpath ${quoted(workspace.root)}) (subpath ${quoted(deps)}) (literal ${quoted(node)}))(allow file-write* (subpath ${quoted(workspace.root)}) (literal "/dev/null"))(deny process-exec)(allow process-exec (literal ${quoted(node)}) (literal ${quoted(esbuild)}))`;
    const profileFile = path.join(workspace.root, "test.sb");
    await writeFile(profileFile, profile);
    const tests: {
        name: string;
        status: string;
        output: string;
    }[] = [];
    const commands: [
        string,
        string[]
    ][] = [
        ["typecheck", [path.join(deps, "typescript/bin/tsc"), "--noEmit", "-p", "tsconfig.check.json"]],
        ...proposal.regressionTests.map(t => [t, ["--import", path.join(deps, "tsx/dist/loader.mjs"), "--test", t]] as [
            string,
            string[]
        ]),
    ];
    // TypeScript/module resolution uses a trusted read-only dependency link, not model output.
    const { symlink } = await import("node:fs/promises");
    try {
        await symlink(deps, path.join(workspace.root, "node_modules"));
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST")
            throw e;
    }
    const run = async (name: string, args: string[]) => {
        if (signal?.aborted)
            throw signal.reason;
        try {
            const result = await exec("/usr/bin/sandbox-exec", ["-f", profileFile, node, ...args], { cwd: workspace.root, env: { PATH: "/usr/bin:/bin", TMPDIR: workspace.root, HOME: workspace.root, TSX_DISABLE_CACHE: "1" }, signal, timeout: 60000, maxBuffer: 1000000 });
            return { name, status: "PASSED", output: redactSecrets(result.stdout).slice(-4000) };
        }
        catch (e) {
            const out = e as {
                stdout?: string;
                stderr?: string;
            };
            return { name, status: "FAILED", output: redactSecrets((out.stdout ?? "") + (out.stderr ?? "") + String(e)).replaceAll(repository, "<production>").slice(-4000) };
        }
    };
    // The NEW regression must fail against the original source before a candidate can await review.
    const baseline: typeof tests = [];
    try {
        for (const change of proposal.changes) {
            const old = workspace.files.find(f => f.path === change.path);
            if (old)
                await writeFile(within(workspace.root, change.path), old.content);
        }
        for (const [name, args] of commands.slice(1))
            baseline.push(await run(name, args));
    }
    finally {
        for (const change of proposal.changes)
            await writeFile(within(workspace.root, change.path), change.content);
    }
    for (const [name, args] of commands)
        tests.push(await run(name, args));
    const status = !baseline.some(t => t.status === "FAILED") ? "NO_REPRODUCED_DEFECT" : tests.every(t => t.status === "PASSED") ? "AWAITING_APPROVAL" : "TESTS_FAILED";
    const report = { version: "code-repair/1", id: workspace.id, baseCommit: workspace.baseCommit, patchIdentity: repair.patchIdentity, patchDigest: repair.patchDigest, status, rootCause: proposal.rootCause, changedFiles: proposal.changes.map(c => c.path), risks: proposal.risks, baseline, tests, promotion: "DISABLED: review/export only; no production apply endpoint" };
    await atomicJson(path.join(workspace.root, "report.json"), report);
    return report;
}
// Human review/export is deliberately the only promotion boundary in this version.
export function promoteCodeRepair(): never { throw new Error("CODE_PROMOTION_DISABLED: explicit external human review and controlled apply required; model output is not approval"); }
export async function reviewCodeRepair(root: string) {
    const manifest = path.join(root, "proposal.json"), reportFile = path.join(root, "report.json");
    await noSymlinkPath(root, manifest);
    const saved = JSON.parse(await readFile(manifest, "utf8"));
    const proposal = codeProposalSchema.parse(saved.proposal);
    const identity = hash(JSON.stringify({ baseCommit: saved.baseCommit, changes: proposal.changes }));
    if (saved.patchIdentity !== identity)
        throw new Error("CODE_REPAIR_PATCH_IDENTITY_CHANGED");
    for (const change of proposal.changes) {
        const file = within(root, change.path);
        await noSymlinkPath(root, file);
        if (hash(await readFile(file, "utf8")) !== hash("content" in change ? change.content : ""))
            throw new Error("CODE_REPAIR_WORKSPACE_CHANGED");
    }
    await noSymlinkPath(root, reportFile);
    const report = JSON.parse(await readFile(reportFile, "utf8"));
    if (saved.patchDigest !== hash(await readFile(path.join(root, "proposal.patch"), "utf8")))
        throw new Error("CODE_REPAIR_DIFF_CHANGED");
    if (report.patchIdentity !== identity)
        throw new Error("CODE_REPAIR_REPORT_IDENTITY_CHANGED");
    return { ...report, patch: path.join(root, "proposal.patch"), humanApprovalRequired: true, automaticPromotionAvailable: false };
}
