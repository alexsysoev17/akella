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
  const actions = recentSuccessfulActions(doc)
      .filter(
        (a, i, all) =>
          all.findIndex((other) => other.effect === a.effect) === i,
      )
      .slice(0, 5),
    selected =
      input.selectedObjectIds ??
      (input.selectedObjectId ? [input.selectedObjectId] : []);
  const ids = new Set([
    ...selected,
    ...(input.mentions ?? []).map((m) => m.sourceNodeId),
    ...actions.flatMap((a) => a.targets.slice(0, 5).map((t) => t.targetId)),
  ]);
  const roots = new Set(
    project.inspection.document.scenes.map((s) => s.figmaNodeId),
  );
  const registry = buildRegistry(
    project.inspection.document,
    project.inspection.fingerprint,
  );
  const objectIndex = registry.objects
    .filter(
      (o) =>
        objectMentionRanges(o.name, input.request).length ||
        o.sourceInstances.some((i) => ids.has(i.sourceNodeId)),
    )
    .flatMap((o) =>
      o.sourceInstances
        .filter((i) => !roots.has(i.sourceNodeId))
        .map((i) => ({
          sceneId: i.sceneId,
          sourceNodeId: i.sourceNodeId,
          logicalObjectId: o.logicalObjectId,
          name: o.name,
          aliases: objectAliases(o.name),
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
    project: { projectId: project.config.projectId, name: project.config.name },
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
    motionKnowledge: {
      expressions: expressionRegistry.map(({ id, description }) => ({
        id,
        description,
      })),
    },
    extraGuidance: config.extraGuidance,
    disclosure: {
      fullDocumentSent: false,
      profile: "selector-edit",
      objectIndex:
        "named/selected/recent candidates only; resolver queries full authoritative state",
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
