/** Explicit opt-in live Level2 qualification. Copies source only, injects a
 * synthetic schema defect, and never modifies/promotes production code. */
import {mkdtemp,mkdir,copyFile,readFile,writeFile,symlink} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {proposeCodeRepair} from "../apps/scene-validator/src/harness/recovery/code-service.ts";
import {recoveryFailure} from "../apps/scene-validator/src/harness/recovery/failure.ts";
import {recoveryPolicySchema} from "../apps/scene-validator/src/harness/recovery/config.ts";
if(!process.argv.includes("--live")) throw new Error("Explicit --live required; one code-provider call, synthetic source defect only");
const exec=promisify(execFile),repository=process.cwd(),root=await mkdtemp(path.join(os.tmpdir(),"akella-code-qualification-"));
const tracked=(await exec("git",["ls-files","-z"],{cwd:repository})).stdout.split("\0");
const added=(await exec("git",["ls-files","--others","--exclude-standard","-z"],{cwd:repository})).stdout.split("\0");
for(const rel of new Set([...tracked,...added])){
 if(!/^(?:apps\/scene-validator\/(?:src|tests)\/.*\.(?:ts|js|mjs|json|html|css)|scripts\/.*\.(?:ts|mjs)|package(?:-lock)?\.json|tsconfig(?:\.[a-z]+)?\.json)$/.test(rel))continue;
 const dest=path.join(root,rel);await mkdir(path.dirname(dest),{recursive:true});await copyFile(path.join(repository,rel),dest);
}
const source=path.join(root,"apps/scene-validator/src/harness/providers/schema.ts");
const content=await readFile(source,"utf8"),marker='if (s?.type === "object" && !s.anyOf && !s.oneOf) return { schema, wrapped: false };';
if(content.split(marker).length!==2)throw new Error("Synthetic defect marker changed; qualification must be reviewed");
await writeFile(source,content.replace(marker,'if (s?.type !== "object") return { schema, wrapped: false };'));
await writeFile(path.join(root,".gitignore"),"node_modules\ndata/\n");
await exec("git",["init","-q","-b","codex/controlled-schema-defect"],{cwd:root});
await exec("git",["add","--all"],{cwd:root});
await exec("git",["-c","user.name=AKELLA Qualification","-c","user.email=qualification@localhost","commit","-qm","Synthetic schema defect; source-only isolated fixture"],{cwd:root});
await symlink(path.join(repository,"node_modules"),path.join(root,"node_modules"));
const failure=recoveryFailure(new Error("PROVIDER_SCHEMA_INVALID: root schema is not an object after objectEnvelope for a discriminated union"),"provider-schema","synthetic");
const policy=recoveryPolicySchema.parse({codeRepair:{enabled:true,model:"gpt-6-sol",maxDurationMs:120000}});
const start=performance.now();
const result=await proposeCodeRepair(root,failure,policy,{provider:"codex-sdk",model:"gpt-6-sol"});
await writeFile(path.join(root,"qualification-result.json"),JSON.stringify(result,null,2));
console.log(JSON.stringify({fixture:root,liveCodeProvider:true,totalMs:performance.now()-start,...result},null,2));
if(result.status!=="AWAITING_APPROVAL")process.exitCode=1;
