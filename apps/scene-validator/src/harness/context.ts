import { codeVersions } from "./versions.js";
import { createHash } from "node:crypto";
import type { LoadedProject } from "../types.js";
import type { MotionState } from "../motion/schema.js";
import { buildContext, objectsIn } from "../motion/context.js";
import { motionKnowledge } from "../motion-library/knowledge.js";
import { capabilityCatalog } from "../motion-library/registry/capabilities.js";
import { semanticInstructions } from "../motion/intent/planner.js";
import { experienceSearch } from "./experience.js";
import type { HarnessConfig } from "./config.js";
export const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const contexts = new Map<string, ReturnType<typeof buildContext>>();
export async function agentContext(
  project: LoadedProject,
  state: MotionState,
  input: {
    request: string;
    selectedObjectId?: string;
    selectedSceneId?: string;
    activeSceneId?: string;
    mentions?: { sceneId: string; sourceNodeId: string }[];
  },
  recent: unknown[],
  config: HarnessConfig,
) {
  const catalog = project.inspection.document.scenes.map((scene) => ({
    sceneId: scene.sceneId,
    index: scene.index,
    name: scene.name,
    objects: objectsIn(scene),
  }));
  const named = new Set<string>((input.mentions ?? []).map((m) => m.sceneId));
  // Lexical retrieval selects context; the LLM performs semantic interpretation.
  for (const scene of catalog) {
    if (
      new RegExp(
        `(?:сцен[аыуе]?|scene)\\s*${scene.index + 1}(?!\\d)`,
        "i",
      ).test(input.request)
    )
      named.add(scene.sceneId);
    if (
      scene.objects.some(
        (o) =>
          o.name.length >= 3 &&
          input.request.toLowerCase().includes(o.name.toLowerCase()),
      )
    )
      named.add(scene.sceneId);
  }
  if (/все.{0,12}сцен|между|all.{0,12}scene|across scenes/i.test(input.request))
    catalog.forEach((s) => named.add(s.sceneId));
  if (!named.size)
    named.add(
      input.activeSceneId ?? input.selectedSceneId ?? catalog[0].sceneId,
    );
  const selectedScenes = catalog.filter((s) => named.has(s.sceneId)),
    hints = input.request.toLowerCase();
  const objects = selectedScenes
    .flatMap((s) => s.objects)
    .filter(
      (o) =>
        o.parentId &&
        (o.targetId === input.selectedObjectId ||
          (input.mentions ?? []).some(
            (m) => m.sourceNodeId === o.targetId && m.sceneId === o.sceneId,
          ) ||
          (hints.includes(o.name.toLowerCase()) && o.name.length >= 2) ||
          (/вектор|лини[яию]/i.test(hints) && o.type === "VECTOR")),
    );
  const targetIds = new Set(objects.map((o) => o.targetId)),
    detailed = targetIds.size > 0;
  const key = digest([
    project.root,
    project.inspection.fingerprint,
    state,
    input.selectedObjectId,
    input.selectedSceneId,
    [...named],
    [...targetIds],
  ]);
  let base = contexts.get(key),
    cacheHit = !!base;
  if (!base) {
    base = buildContext(
      project,
      state,
      input.request,
      input.selectedObjectId,
      input.selectedSceneId,
      { sceneIds: named, targetIds },
    );
    if (contexts.size >= 20) contexts.delete(contexts.keys().next().value!);
    contexts.set(key, { ...base, userRequest: "" });
  }
  base = structuredClone(base);
  const scenes = selectedScenes.map((s) => ({
    ...s,
    objects: s.objects
      .filter((o) => !detailed || targetIds.has(o.targetId))
      .map((o) => ({
        ...o,
        text: o.text?.slice(0, 200),
        detail: "geometry summary; full source geometry remains in harness",
      })),
  }));
  const sceneIds = new Set(selectedScenes.map((s) => s.sceneId));
  const motion = {
    ...state,
    animations: state.animations.filter(
      (a) =>
        sceneIds.has(a.sceneId) && (!detailed || targetIds.has(a.targetId)),
    ),
    expressions: state.expressions?.filter(
      (e) =>
        sceneIds.has(e.sceneId) && (!detailed || targetIds.has(e.targetId)),
    ),
    objectTransitions: state.objectTransitions?.filter((t) => {
      const o = base!.logicalObjects.find(
        (o) => o.logicalObjectId === t.logicalObjectId,
      );
      return o?.sourceInstances.some(
        (i) =>
          sceneIds.has(i.sceneId) &&
          (!detailed || targetIds.has(i.sourceNodeId)),
      );
    }),
    visibility: state.visibility.filter((v) => sceneIds.has(v.sceneId)),
  };
  const knowledge = await motionKnowledge(
    input.request,
    objects.some((o) => o.type === "TEXT"),
  );
  const techniqueIds = new Set<string>(
    knowledge.techniques.map((t) => t.implementationId),
  );
  for (const a of motion.animations) techniqueIds.add(a.effect);
  for (const e of motion.expressions ?? []) techniqueIds.add(e.type);
  if (/между|transition/i.test(input.request))
    techniqueIds.add("objectStateTransition");
  if (/mask.?reveal|маск/i.test(input.request)) techniqueIds.add("maskReveal");
  const ids = [
    ...techniqueIds,
    ...config.retrievalBoosts,
    "slideUp",
    "fadeIn",
    "scaleIn",
    "moveTo",
    "inertialOvershoot",
    "aeEasyEase",
    "trimPath",
  ];
  knowledge.capabilities = capabilityCatalog().filter((c) =>
    ids.includes(c.id),
  );
  knowledge.expressions = knowledge.expressions.filter((e) =>
    ids.includes(e.id),
  );
  knowledge.presets = knowledge.relevantPresets.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
  }));
  const references = [
    ...(await codeVersions()),
    ...knowledge.skills.map((s) => ({
      id: "skill:" + s.id,
      version: digest(s.text),
    })),
    ...knowledge.techniques.map((t) => ({
      id: "technique:" + t.id,
      version: digest(t),
    })),
    { id: "capabilities", version: digest(capabilityCatalog()) },
    { id: "instructions", version: digest(semanticInstructions) },
    { id: "harness-config", version: digest(config) },
  ];
  const experience = await experienceSearch(
    project.root,
    input.request,
    [...techniqueIds],
    3,
  );
  const value = {
    project: base.project,
    sceneIndex: catalog.map(({ sceneId, index, name }) => ({
      sceneId,
      index,
      name,
    })),
    scenes,
    motion,
    selectedObjectId: base.selectedObjectId,
    selectedLogicalObjectId: base.selectedLogicalObjectId,
    selectedSceneId: base.selectedSceneId,
    activeSceneId: input.activeSceneId,
    mentions: input.mentions,
    userRequest: input.request,
    logicalObjects: base.logicalObjects
      .filter((o) =>
        o.sourceInstances.some(
          (i) =>
            sceneIds.has(i.sceneId) &&
            (!detailed || targetIds.has(i.sourceNodeId)),
        ),
      )
      .map((o) => ({
        ...o,
        states: o.states.map(({ appearance, ...s }) => s),
      })),
    recentConversation: recent.slice(-3),
    motionKnowledge: knowledge,
    experience,
    extraGuidance: config.extraGuidance,
    timing: base.timing,
    disclosure: {
      omittedScenes: catalog.length - scenes.length,
      objectsDetailed: detailed,
      fullDocumentSent: false,
      unresolvedReferences:
        "Do not guess targets absent from supplied context; retain unresolved requirement",
    },
  };
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > config.maxContextBytes)
    throw new Error(
      `CONTEXT_BUDGET: ${bytes} > ${config.maxContextBytes}; no requested target silently truncated`,
    );
  return { value, bytes, cacheHit, references, contextDigest: digest(value) };
}
