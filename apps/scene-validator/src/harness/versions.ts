import { readFile } from "node:fs/promises";
import { digest } from "./context.js";
const components = [
  "motion/engine",
  "motion/sampling",
  "motion/expressions",
  "motion-library/expressions/functions",
  "motion-library/expressions/registry",
  "motion-library/easings/registry",
  "motion-library/easings/cubic-bezier",
  "motion/path-reveal",
  "motion/text-reveal",
  "motion/text-layout",
  "motion/text-animation",
  "renderer",
  "motion/presentation",
  "motion/qa/geometry",
  "motion/operations",
  "motion/transitions",
  "motion/qa/numeric",
  "motion/qa/render",
  "motion/intent/compiler",
  "motion/intent/coverage",
  "motion/object-aliases",
  "motion/object-resolution",
  "motion/base-motion",
  "motion/contextual-resolution",
  "motion-library/techniques/registry",
  "motion/intent/planner",
  "motion/intent/schema",
  "motion/intent/selector-schema",
  "motion-library/registry/capabilities",
  "motion/intent/graph",
  "motion/intent/references",
  "motion/intent/provenance",
  "motion/intent/entrance",
  "motion/intent/repair",
  "harness/evals",
  "harness/video-eval",
  "motion/provider",
  "motion/provider-settings",
  "provider-contract",
  "harness/providers/types",
  "motion/intent/execution",
  "motion-library/registry/path-capability",
  "harness/context",
  "harness/selector-context",
  "harness/runtime",
  "harness/qa",
  "harness/config",
];
export async function codeVersions() {
  return await Promise.all(
    components.map(async (id) => {
      let content: string;
      try {
        content = await readFile(
          new URL("../" + id + ".ts", import.meta.url),
          "utf8",
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        content = await readFile(
          new URL("../" + id + ".js", import.meta.url),
          "utf8",
        );
      }
      return { id: "code:" + id, version: digest(content) };
    }),
  );
}
