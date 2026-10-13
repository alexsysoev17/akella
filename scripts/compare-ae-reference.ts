import { compareReference } from "../apps/scene-validator/tests/ae-reference.js";
import { mkdir, writeFile } from "node:fs/promises";
await mkdir("artifacts/ae-parity", { recursive: true });
const result = compareReference();
await writeFile(
  "artifacts/ae-parity/reference-comparison.json",
  JSON.stringify(
    {
      schemaVersion: "1.0.0",
      source:
        "User-supplied After Effects measured frame values; AE application was not executed here",
      ...result,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify(
    {
      formulaMaxError: result.formulaMaxError,
      computedVelocity: result.computedVelocity,
      endToEndMaxError: result.endToEndMaxError,
      endToEndTolerancePassed: result.endToEndTolerancePassed,
    },
    null,
    2,
  ),
);

if (process.argv.includes("--strict") && !result.endToEndTolerancePassed)
  process.exitCode = 1;
