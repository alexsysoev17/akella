import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { reviewCodeRepair } from "../apps/scene-validator/src/harness/recovery/code-repair.ts";
import { recoveryMemory } from "../apps/scene-validator/src/harness/recovery/memory.ts";
const args = process.argv.slice(2), command = args[0], value = (flag: string) => { const i = args.indexOf(flag); if (i < 0 || !args[i + 1])
    throw Error(flag + " required"); return path.resolve(args[i + 1]); };
if (command === "memory")
    console.log(JSON.stringify(await recoveryMemory(value("--project")), null, 2));
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
    throw Error("recovery memory --project PATH | review --workspace PATH | export --workspace PATH --output PATH.patch. Production promotion is unavailable; model approval never applies source changes.");
