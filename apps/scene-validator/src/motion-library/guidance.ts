import { capabilityRegistry } from "./registry/capabilities.js";
/** One technical policy for semantic planning, operations repair and manual compatibility. */
export function capabilityGuidance() {
  const text = capabilityRegistry.find(
    (c) => "textContract" in c,
  )?.textContract;
  return `Capability policy: context.motionKnowledge and the output schema are authoritative. Unsupported explicit techniques must be diagnosed, never approximated by another effect. Trim Paths requires actual path reveal, never scale. Inertial overshoot uses the existing evaluator and base motion, never invented replacement keys. Preserve exact target/write scope, reference targets are read-only. Native TEXT segmentation supports block/line/word/character on ${text?.supportedEffects.join(", ") ?? "no advertised effects"}. Text constraints: ${text?.constraints.join("; ") ?? "none advertised"}. Compound text tracks share segmentation/timing. Missing fonts or unsupported source geometry must be diagnosed. Presets are suggestions, not overrides of the latest user instruction. Validate and execute through existing typed operations only.`;
}
