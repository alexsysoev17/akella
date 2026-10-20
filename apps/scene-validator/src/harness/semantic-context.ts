/** Shared wire projection; context admission and semantic planning use the same representation. */
export function semanticContext(context: unknown): unknown {
  if (!context || typeof context !== "object") return context;
  const c = context as Record<string, unknown>;
  if (c.contextualEditHint === true) {
    return {
      project: c.project,
      sceneIndex: c.sceneIndex,
      projectRevision: c.projectRevision,
      objectIndex: c.objectIndex,
      recentSuccessfulActions: c.recentSuccessfulActions,
      effectInventory: c.effectInventory,
      animationInventory: c.animationInventory,
      lifecycleCatalog: c.lifecycleCatalog,
      extraGuidance: c.extraGuidance,
      selectedObjectIds: c.selectedObjectIds,
      activeSceneId: c.activeSceneId,
      recentConversation: Array.isArray(c.recentConversation)
        ? c.recentConversation.slice(-2)
        : [],
      motionKnowledge: {
        expressions: (c.motionKnowledge as Record<string, unknown>)
          ?.expressions,
      },
      payloadTier: "contextual-effect-edit",
    };
  }
  const pick = (v: unknown, keys: string[]) =>
    v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).filter(([k]) => keys.includes(k)))
      : v;
  const rows = (v: unknown, keys: string[]) =>
    Array.isArray(v) ? v.map((x) => pick(x, keys)) : v;
  const knowledge = c.motionKnowledge as Record<string, unknown> | undefined;
  const capabilityTypes: Record<string, unknown> = {};
  const compactCapabilities = Array.isArray(knowledge?.capabilities)
    ? knowledge.capabilities.map((entry: Record<string, unknown>) => {
        const types = entry.supportedObjectTypes;
        let ref = Object.keys(capabilityTypes).find(
          (key) =>
            JSON.stringify(capabilityTypes[key]) === JSON.stringify(types),
        );
        if (!ref) {
          ref = "types" + Object.keys(capabilityTypes).length;
          capabilityTypes[ref] = types;
        }
        return {
          ...(pick(entry, [
            "id",
            "kind",
            "lifecycle",
            "semanticTechniques",
            "supportedProperties",
            "constraints",
          ]) as object),
          objectTypesRef: ref,
        };
      })
    : undefined;
  const rest = pick(c, [
    "project",
    "sceneIndex",
    "objectIndex",
    "motion",
    "selectedObjectId",
    "selectedObjectIds",
    "selectedSceneId",
    "activeSceneId",
    "mentions",
    "extraGuidance",
    "timing",
    "projectRevision",
    "contextualEditHint",
  ]) as Record<string, unknown>;
  return {
    ...rest,
    recentConversation: Array.isArray(c.recentConversation)
      ? c.recentConversation.slice(-2)
      : [],
    recentSuccessfulActions: Array.isArray(c.recentSuccessfulActions)
      ? c.recentSuccessfulActions.slice(0, 3)
      : [],
    logicalObjects: Array.isArray(c.logicalObjects)
      ? c.logicalObjects.map((v) => {
          const o = v as Record<string, unknown>;
          return {
            ...(pick(o, [
              "logicalObjectId",
              "name",
              "sourceInstances",
              "ambiguousScenes",
            ]) as object),
            states: rows(o.states, [
              "sceneId",
              "sourceNodeId",
              "width",
              "height",
              "opacity",
              "visible",
            ]),
          };
        })
      : c.logicalObjects,
    motionKnowledge: knowledge
      ? {
          version: knowledge.version,
          agentTools: knowledge.agentTools,
          techniques: rows(knowledge.techniques, [
            "id",
            "name",
            "description",
            "implementationId",
          ]),
          easingIds: knowledge.easingIds,
          composition: knowledge.composition,
          skills: rows(knowledge.skills, ["id"]),
          capabilityObjectTypes: capabilityTypes,
          capabilities: compactCapabilities,
          expressions: rows(knowledge.expressions, ["id", "description"]),
          customEasings: rows(knowledge.customEasings, [
            "id",
            "name",
            "description",
            "defaultParameters",
          ]),
        }
      : undefined,
  };
}
