import { intervalConflict } from "./intervals.js";
import { expressionLifecycles } from "../motion-library/expressions/registry.js";
import type { MotionState } from "./schema.js";
import { evaluateAnimation } from "./engine.js";
import type { MotionObject } from "./context.js";
export function validateExpressions(
  state: MotionState,
  objects: Map<string, MotionObject>,
) {
  const ids = new Set<string>();
  for (const e of state.expressions ?? []) {
    if (ids.has(e.expressionId)) throw new Error("Duplicate expressionId");
    ids.add(e.expressionId);
    const target = objects.get(`${e.sceneId}/${e.targetId}`);
    if (!target || target.mask)
      throw new Error("Expression target missing or is a mask");
    if (e.transitionId) {
      const t = state.objectTransitions?.find(t => t.transitionId === e.transitionId);
      if (!t || !["wiggle", "inertialOvershoot"].includes(e.type) || !["x", "y"].includes(e.property) || ![t.fromSceneId, t.toSceneId].includes(e.sceneId))
        throw new Error(`UNSUPPORTED_EFFECT_BINDING: ${e.expressionId} requires a current transition and additive X/Y Wiggle or inertia`);
    }
    if (e.ownership?.scope === "sceneInstance" && e.transitionId) throw new Error("EFFECT_SCOPE_MISMATCH: instance effect cannot bind a transition");
    if (e.ownership && e.ownership.scope === "transition" && !e.transitionId) throw new Error("UNSUPPORTED_EFFECT_BINDING: transition owner requires a motion transition");
    if (e.transitionId && e.ownership?.logicalObjectId !== undefined && e.ownership.logicalObjectId !== state.objectTransitions!.find(t => t.transitionId === e.transitionId)!.logicalObjectId) throw new Error("EFFECT_OWNER_MISMATCH");
    if (e.ownership?.scope === "logicalObject" && (e.type !== "wiggle" || !["x", "y"].includes(e.property) || !e.ownership.logicalObjectId)) throw new Error("UNSUPPORTED_LOGICAL_EFFECT: only additive X/Y Wiggle is supported");
    if (e.type === "inertialOvershoot" && e.transitionId) {
      const t = state.objectTransitions!.find(t => t.transitionId === e.transitionId)!;
      if (e.parameters.mode !== "ae" || e.sourceAnimationId !== t.transitionId || e.startFrame !== t.startFrame + t.durationFrames || e.parameters.incomingImpulse) throw new Error("INVALID_TRANSITION_INERTIA_ANCHOR");
    }
    const conflict = intervalConflict(e, state.settings.durationFrames, expressionLifecycles[e.type]);
    if (expressionLifecycles[e.type] === "settling" && conflict)
      throw new Error(`INVALID_LIFECYCLE_INTERVAL: ${e.expressionId} ${e.type} on ${e.sceneId}/${e.targetId} must finish before final project frame so its settled endpoint is rendered`);
    if (expressionLifecycles[e.type] === "continuous" && conflict)
      throw new Error(`INVALID_LIFECYCLE_INTERVAL: ${e.expressionId} ${e.type} exceeds project duration`);
    if (e.type === "inertialOvershoot" && e.transitionId) continue;
    if ("sourceAnimationId" in e) {
      const a = state.animations.find(
        (a) => a.animationId === e.sourceAnimationId,
      );
      if (
        !a ||
        !a.enabled ||
        a.sceneId !== e.sceneId ||
        a.targetId !== e.targetId
      )
        throw new Error(
          "Expression requires an enabled base animation of the same source object",
        );
      const values = evaluateAnimation(a, a.startFrame),
        property = e.property;
      const has =
        values[property] !== undefined ||
        (["scaleX", "scaleY"].includes(property) && values.scale !== undefined);
      if (!has)
        throw new Error("Expression property must match its source track");
      if (
        e.type === "inertialOvershoot" &&
        e.parameters.mode === "ae" &&
        e.parameters.incomingImpulse
      )
        throw new Error(
          "AE velocity mode does not accept impulse overrides; use legacy mode explicitly",
        );
      if (
        !(e.type === "inertialOvershoot" && e.parameters.mode === "ae") &&
        e.startFrame < a.startFrame + a.durationFrames
      )
        throw new Error(
          "Inertia/loop begins at or after the base track endpoint",
        );
      if (
        e.type === "inertialOvershoot" &&
        e.parameters.mode !== "ae" &&
        e.parameters.velocityLookbackFrames > a.durationFrames
      )
        throw new Error("Velocity sampling window exceeds base duration");
      if (e.type === "loop" && e.parameters.mode === "cycle") {
        const end = evaluateAnimation(a, a.startFrame + a.durationFrames);
        if (
          Math.abs(
            (values[property] ?? values.scale ?? 0) -
              (end[property] ?? end.scale ?? 0),
          ) > 1e-8
        )
          throw new Error(
            "Cycle loop needs equal endpoints for continuity; use pingPong",
          );
      }
    }
  }
}
