import type { LoadedProject } from "../types.js";
import type { MotionDocument } from "../motion/store.js";
import type { HarnessConfig } from "./config.js";
import { buildRegistry } from "../motion/registry.js";
import {
  objectAliases,
  objectMentionRanges,
} from "../motion/object-aliases.js";
import { recentSuccessfulActions } from "../motion/contextual-resolution.js";
import { expressionRegistry } from "../motion-library/expressions/registry.js";
import { codeVersions } from "./versions.js";
import { capabilityCatalog } from "../motion-library/registry/capabilities.js";
import { digest } from "./context.js";
export async function selectorContext(
  project: LoadedProject,
  doc: MotionDocument,
  input: {
    request: string;
    selectedObjectId?: string;
    selectedObjectIds?: string[];
    activeSceneId?: string;
    mentions?: { sourceNodeId: string }[];
  },
  recent: unknown[],
  config: HarnessConfig,
) {
  const actions = recentSuccessfulActions(doc, true)
      .filter(
        (a, i, all) =>
          all.findIndex((other) => other.effect === a.effect) === i,
      )
      .slice(0, 3),
    selected =
      input.selectedObjectIds ??
      (input.selectedObjectId ? [input.selectedObjectId] : []);
  const ids = new Set([
    ...selected,
    ...(input.mentions ?? []).map((m) => m.sourceNodeId),
  ]);
  const roots = new Set(
    project.inspection.document.scenes.map((s) => s.figmaNodeId),
  );
  const registry = buildRegistry(
    project.inspection.document,
    project.inspection.fingerprint,
  );
  // Explicit object references do not need unrelated historical group members.
  if (
    !registry.objects.some(
      (o) => objectMentionRanges(o.name, input.request).length,
    )
  )
    for (const a of actions)
      for (const t of a.targets.slice(0, 5)) ids.add(t.targetId);
  const objectIndex = registry.objects.flatMap((o) =>
    o.sourceInstances
      .filter((i) => !roots.has(i.sourceNodeId))
      .map((i) => ({
        sceneId: i.sceneId,
        sourceNodeId: i.sourceNodeId,
        logicalObjectId: o.logicalObjectId,
        name: o.name,
        aliases: objectAliases(o.name),
        existingAnimations: doc.state.animations
          .filter(
            (a) => a.sceneId === i.sceneId && a.targetId === i.sourceNodeId,
          )
          .map((a) => ({
            animationId: a.animationId,
            effect: a.effect,
            enabled: a.enabled,
            startFrame: a.startFrame,
            durationFrames: a.durationFrames,
          })),
        existingExpressions: (doc.state.expressions ?? [])
          .filter(
            (e) =>
              e.enabled &&
              e.sceneId === i.sceneId &&
              e.targetId === i.sourceNodeId,
          )
          .map((e) => ({
            expressionId: e.expressionId,
            type: e.type,
            property: e.property,
          })),
      })),
  );
  const inventory = new Map<
    string,
    {
      sceneId: string;
      effect: string;
      expressionCount: number;
      targetIds: Set<string>;
    }
  >();
  for (const e of doc.state.expressions ?? []) {
    if (!e.enabled) continue;
    const key = e.sceneId + "/" + e.type;
    const v = inventory.get(key) ?? {
      sceneId: e.sceneId,
      effect: e.type,
      expressionCount: 0,
      targetIds: new Set<string>(),
    };
    v.expressionCount++;
    v.targetIds.add(e.targetId);
    inventory.set(key, v);
  }
  const value: Record<string, unknown> = {
    project: {
      projectId: project.config.projectId,
      name: project.config.name,
      fps: doc.state.settings.fps,
    },
    projectRevision: doc.revision,
    sceneIndex: project.inspection.document.scenes.map((s) => ({
      sceneId: s.sceneId,
      index: s.index,
      name: s.name,
    })),
    objectIndex,
    selectedObjectIds: selected,
    activeSceneId: input.activeSceneId,
    userRequest: input.request,
    contextualEditHint: true,
    recentSuccessfulActions: actions.map((a) => ({
      actionId: a.actionId,
      effect: a.effect,
      editCount: a.editIds.length,
      editIdSamples: a.editIds.slice(0, 3),
      expressionCount: a.expressionIds.length,
      animationCount: a.animationIds?.length ?? 0,
      targetCount: new Set(a.targets.map((t) => t.sceneId + "/" + t.targetId))
        .size,
      targetSamples: a.targets.slice(0, 5),
      targetsAreSample: a.targets.length > 5,
    })),
    effectInventory: [...inventory.values()].map(({ targetIds, ...v }) => ({
      ...v,
      targetCount: targetIds.size,
    })),
    recentConversation: recent.slice(-2).map((v) => {
      const r = v as { request?: string };
      return {
        request: r.request?.slice(0, 1500),
        requestTruncated: (r.request?.length ?? 0) > 1500,
      };
    }),
    lifecycleCatalog: capabilityCatalog()
      .filter((c) => c.kind === "animation" || c.kind === "expression")
      .map((c) => ({
        id: c.id,
        kind: c.kind,
        operations:
          "lifecycle" in c
            ? { update: c.lifecycle.update, remove: c.lifecycle.remove }
            : null,
      })),
    animationInventory: [
      ...new Set(doc.state.animations.map((a) => a.sceneId + "/" + a.effect)),
    ].map((key) => ({
      sceneId: key.split("/")[0],
      effect: key.split("/")[1],
      count: doc.state.animations.filter(
        (a) => a.sceneId + "/" + a.effect === key,
      ).length,
    })),
    motionKnowledge: {
      expressions: expressionRegistry
        .filter((e) =>
          objectIndex.some((o) =>
            o.existingExpressions.some((x) => x.type === e.id),
          ),
        )
        .map(({ id, description }) => ({
          id,
          description,
        })),
    },
    extraGuidance: config.extraGuidance,
    disclosure: {
      fullDocumentSent: false,
      profile: "selector-edit",
      objectIndex:
        "all-scene compact identities; resolver queries full authoritative state; read visibility does not authorize writes",
    },
  };
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > config.maxContextBytes)
    throw new Error(
      `CONTEXT_BUDGET: ${bytes} > ${config.maxContextBytes}; selector context not truncated`,
    );
  return {
    value,
    bytes,
    cacheHit: false,
    references: [
      ...(await codeVersions()),
      { id: "expression-knowledge", version: digest(expressionRegistry) },
    ],
    contextDigest: digest(value),
  };
}
