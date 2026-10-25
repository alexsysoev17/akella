import {reviewForApproval,approveCodeRepair} from "../apps/scene-validator/src/harness/recovery/promotion.ts";
import {verifyOriginalRun,publishOriginalReplay} from "../apps/scene-validator/src/harness/recovery/replay.ts";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { reviewCodeRepair } from "../apps/scene-validator/src/harness/recovery/code-repair.ts";
import { recoveryMemory } from "../apps/scene-validator/src/harness/recovery/memory.ts";
const args = process.argv.slice(2), command = args[0], value = (flag: string) => { const i = args.indexOf(flag); if (i < 0 || !args[i + 1])
    throw Error(flag + " required"); return path.resolve(args[i + 1]); };
if (command === "memory")
    console.log(JSON.stringify(await recoveryMemory(value("--project")), null, 2));
else if(command === "apply") {
    const workspace=value("--workspace"), identity=args[args.indexOf("--approve-patch")+1];
    if(!args.includes("--approve-patch")||!args.includes("--run"))throw Error("Explicit --approve-patch HASH and original --run UUID required");
    const review=await reviewForApproval(process.cwd(),workspace,identity);
    const result=await approveCodeRepair(process.cwd(),workspace,identity,review.approvalToken,isolated=>verifyOriginalRun(isolated,value("--project"),args[args.indexOf("--run")+1],process.cwd(),args.includes("--allow-live-replay")));
    const resume=await publishOriginalReplay(process.cwd(),value("--project"),args[args.indexOf("--run")+1],result.replay);
    console.log(JSON.stringify({...result,resume},null,2));
}
else if (command === "review" || command === "export") {
    const root = value("--workspace"), report = await reviewCodeRepair(root);
    if (command === "export") {
        const output = value("--output");
        if (!output.endsWith(".patch"))
            throw Error("--output must end in .patch");
        await writeFile(output, await readFile(path.join(root, "proposal.patch")), { flag: "wx" });
        await writeFile(output + ".json", JSON.stringify(report, null, 2), { flag: "wx" });
    }
    console.log(JSON.stringify(report, null, 2));
}
else
    throw Error("recovery memory --project PATH | review --workspace PATH | export --workspace PATH --output PATH.patch. apply --workspace PATH --approve-patch HASH --project PATH --run UUID requires explicit human approval and successful isolated original-request replay.");
