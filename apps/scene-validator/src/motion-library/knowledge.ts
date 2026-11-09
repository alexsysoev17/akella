import {skillContracts} from "./skills/registry.js";
import { motionToolCatalog } from "../motion/tools.js";
import { capabilityCatalog } from "./registry/capabilities.js";
import { retrieveTechniques } from "./techniques/registry.js";
import { readFile } from "node:fs/promises";
import { easingCatalog } from "./easings/registry.js";
import { expressionRegistry } from "./expressions/registry.js";
import { presetRegistry } from "./presets/registry.js";
export async function motionKnowledge(request: string, textSelected: boolean) {
  const names = ["motion-timing"];
  if (textSelected || /текст|надпис|text|typograph/i.test(request))
    names.push("kinetic-typography");
  else if (/отскок|инерц|spring|bounce|колеб|wiggle|overshoot/i.test(request))
    names.push("animation-principles");
  else names.push("motion-guidelines");
  const custom = easingCatalog().filter((e) =>
    [
      "cubicBezier",
      "aeEasyEase",
      "piecewise",
      "spring",
      "back",
      "bounce",
      "elastic",
    ].includes(e.id),
  );
  return {
    version: "2.0.0",
    skillContracts:textSelected||/текст|надпис|text|заголов/iu.test(request)?skillContracts.map(({semanticInstructions,...contract})=>contract):[],
    agentTools: motionToolCatalog,
    techniques: retrieveTechniques(request),
    capabilities: capabilityCatalog().filter(
      (c) =>
        c.kind !== "easing" ||
        ["cubicBezier", "spring", "aeEasyEase"].includes(c.id),
    ),
    priority: [
      "technical correctness",
      "latest user instruction",
      "current motion parameters",
      "previous applied non-undone instructions",
      "motion skills",
      "preset suggestions",
    ],
    easingIds: easingCatalog().map((e) => e.id),
    customEasings: custom,
    expressions: expressionRegistry,
    presets: presetRegistry.map(({ id, name, description }) => ({
      id,
      name,
      description,
    })),
    relevantPresets: presetRegistry
      .filter(
        (p) =>
          request.toLowerCase().includes(p.id) ||
          request.toLowerCase().includes(p.name.toLowerCase()),
      )
      .slice(0, 2),
    skills: await Promise.all(
      names.map(async (name) => ({
        id: name,
        text: await readFile(
          new URL(`./skills/${name}.md`, import.meta.url),
          "utf8",
        ),
      })),
    ),
    composition:
      "Source base geometry + selected base property track + sum of expressions sorted by expressionId. Expressions sample only base tracks. No recursive expressions or JavaScript. Opacity clamps 0..1; scale is nonnegative; an exact zero endpoint is an invisible collapsed pose.",
    customCurvePolicy:
      "Create and edit structured cubicBezier or piecewise curves when appropriate. Presets are one-time expansion, not an ongoing constraint. Legacy easing strings remain valid.",
  };
}
