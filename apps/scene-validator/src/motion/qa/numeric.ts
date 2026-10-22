import { scopedExpressionValue } from "../transition-effects.js";
import type { StatePresentation } from "../transition-runtime.js";
import type { MotionState } from "../schema.js";
import { evaluateAnimation, evaluateMotion } from "../engine.js";

export type Status = "PASSED" | "FAILED" | "WARNING" | "NOT_TESTED";
export interface Check {
  name: string;
  category?: "technical" | "mathematics" | "render" | "visual" | "artistic";
  required?: boolean;
  status: Status;
  target?: string;
  reason?: string;
  metrics?: unknown;
}
export function numericQA(state: MotionState, request = "", presentation: StatePresentation = {}) {
  const checks: Check[] = [],
    frames = new Set<number>([0, state.settings.durationFrames - 1]);
  const add = (f: number) =>
    frames.add(
      Math.max(0, Math.min(state.settings.durationFrames - 1, Math.round(f))),
    );
  if (state.expressions?.some(e => e.enabled && e.ownership?.scope === "logicalObject")) {
    for (const b of state.blocks) for (const f of [b.startFrame - 1, b.startFrame, b.startFrame + 1, b.startFrame + b.durationFrames - 1]) add(f);
  }
  for (const e of [
    ...state.animations.filter((a) => a.enabled),
    ...(state.expressions ?? []).filter((e) => e.enabled),
    ...(state.objectTransitions ?? []),
  ]) {
    const end = e.startFrame + e.durationFrames;
    for (const f of [
      e.startFrame - 1,
      e.startFrame,
      e.startFrame + e.durationFrames * 0.25,
      e.startFrame + e.durationFrames * 0.5,
      e.startFrame + e.durationFrames * 0.75,
      end - 1,
      end,
      end + 1,
    ])
      add(f);
  }
  for (const e of state.expressions ?? []) {
    if (!e.enabled || e.type !== "wiggle") continue;
    const count = Math.min(4000, Math.max(32, Math.ceil(e.durationFrames / state.settings.fps * e.parameters.frequency * 16)));
    const values = Array.from({ length: count }, (_, i) => scopedExpressionValue(state, e, e.startFrame + e.durationFrames * (i + .5) / count, presentation));
    checks.push({ name: "wiggleBoundedDeterministic", target: e.expressionId, category: "mathematics", required: true,
      status: values.every((v, i) => Number.isFinite(v) && Math.abs(v) <= e.parameters.amplitude + 1e-8 && v === scopedExpressionValue(state, e, e.startFrame + e.durationFrames * (i + .5) / count, presentation)) ? "PASSED" : "FAILED",
      metrics: { samples: count, frequency: e.parameters.frequency, maximumOffset: Math.max(...values.map(Math.abs)), temporalMode: e.parameters.temporalMode ?? "legacyWindow" } });
    if (e.parameters.temporalMode === "continuous") checks.push({ name: "wiggleContinuousInterval", target: e.expressionId, category: "mathematics", required: true,
      status: Number.isSafeInteger(e.startFrame + e.durationFrames) ? "PASSED" : "FAILED" });
  }
  for (const e of state.expressions ?? []) {
    if (!e.enabled || e.type !== "inertialOvershoot") continue;
    const duration = e.durationFrames / state.settings.fps,
      hz = e.parameters.frequency;
    // Subframe numerical sampling prevents aliasing from hiding an invalid evaluator.
    const count = Math.min(
      20000,
      Math.max(e.durationFrames, Math.ceil(duration * hz * 24), 64),
    );
    const samples = Array.from({ length: count + 1 }, (_, i) =>
      scopedExpressionValue(state, e, e.startFrame + (e.durationFrames * i) / count, presentation),
    );
    const peaks = samples
      .slice(1, -1)
      .flatMap((v, i) =>
        Math.abs(v) > Math.abs(samples[i]) &&
        Math.abs(v) >= Math.abs(samples[i + 2])
          ? [{ time: ((i + 1) * duration) / count, value: Math.abs(v) }]
          : [],
      );
    const max = Math.max(...samples.map(Math.abs));
    const threshold = ["scaleX", "scaleY"].includes(e.property)
      ? 0.0001
      : e.property === "rotation"
        ? 0.01
        : 0.05;
    checks.push({
      name: "visibleOscillation",
      target: e.expressionId,
      status: max > threshold ? "PASSED" : "FAILED",
      reason:
        max <= threshold
          ? e.parameters.mode === "ae"
            ? "Insufficient instantaneous incoming velocity or zero amplitude; inspect base easing/distance. AE mode cannot substitute a lookback secant or impulse."
            : "Insufficient incoming velocity or zero amplitude; change lookback or explicit incomingImpulse"
          : undefined,
      metrics: { maximumOffset: max },
    });
    const periodic = hz * duration >= 1.5;
    const halfPeriods = peaks
      .slice(1)
      .map((p, i) => p.time - peaks[i].time)
      .filter((x) => x > 0);
    const measured = halfPeriods.length ? 1 / (2 * halfPeriods[0]) : null;
    checks.push({
      name: "frequency",
      target: e.expressionId,
      status: !periodic
        ? "NOT_TESTED"
        : measured && Math.abs(measured - hz) / hz < 0.15
          ? "PASSED"
          : "FAILED",
      metrics: { expectedHz: hz, measuredHz: measured },
    });
    const earlyPeaks = peaks.filter((p) => p.time < duration * 0.7);
    const decay =
      earlyPeaks.length > 1
        ? Math.log(earlyPeaks[0].value / earlyPeaks[1].value) /
          (earlyPeaks[1].time - earlyPeaks[0].time)
        : null;
    checks.push({
      name: "decay",
      target: e.expressionId,
      status:
        decay === null
          ? "NOT_TESTED"
          : Math.abs(decay - e.parameters.decay) <
              Math.max(0.2, e.parameters.decay * 0.15)
            ? "PASSED"
            : "FAILED",
      metrics: { expected: e.parameters.decay, measured: decay },
    });
    checks.push({
      name: "samplingRate",
      target: e.expressionId,
      status: state.settings.fps >= hz * 4 ? "PASSED" : "FAILED",
      reason:
        state.settings.fps < hz * 4
          ? "Frequency requires at least four output frames per cycle"
          : undefined,
    });
    const aeMode = e.parameters.mode === "ae" && e.parameters.settlingEnvelope !== "smoothTail";
    checks.push({
      name: "expressionVelocityMode",
      target: e.expressionId,
      status: "PASSED",
      reason: aeMode
        ? "AE: instantaneous derivative at keyTime-frameDuration/10, unwindowed formula"
        : e.parameters.mode === "ae" ? "Instantaneous incoming velocity with explicit finite smoothTail envelope" : "Legacy: explicit lookback secant and smooth settling window",
    });
    checks.push({
      name: "continuousEndpoints",
      target: e.expressionId,
      status:
        samples[0] === 0 &&
        samples.at(-1) === 0 &&
        Math.abs(
          scopedExpressionValue(state, e, e.startFrame + 1e-6, presentation),
        ) < Math.max(1e-3, max * 1e-3) &&
        Math.abs(
          scopedExpressionValue(state, e, e.startFrame + e.durationFrames - 1e-6, presentation),
        ) < Math.max(1e-3, max * 1e-3)
          ? "PASSED"
          : aeMode
            ? "WARNING"
            : "FAILED",
    });
    if (aeMode) {
      const residual = scopedExpressionValue(state, e, e.startFrame + e.durationFrames - 1e-6, presentation);
      checks.push({
        name: "aeDurationCutoff",
        target: e.expressionId,
        status: Math.abs(residual) > 0.05 ? "WARNING" : "PASSED",
        metrics: { residualBeforeCutoff: residual },
        reason:
          "Exact AE duration gate has no artificial settling envelope; finite cutoff may leave a residual jump",
      });
    }
    const key = JSON.stringify([e.sceneId, e.targetId]),
      end = e.startFrame + e.durationFrames;
    const actual = evaluateMotion(state, end, presentation).nodes[key] ?? {};
    const without =
      evaluateMotion(
        {
          ...state,
          expressions: state.expressions?.filter(
            (x) => x.expressionId !== e.expressionId,
          ),
        },
        end,
        presentation,
      ).nodes[key] ?? {};
    const fallback = ["scaleX", "scaleY"].includes(e.property)
      ? 1
      : e.property === "opacity"
        ? 1
        : 0;
    checks.push({
      name: "finalTarget",
      target: e.expressionId,
      status:
        Math.abs(
          (actual[e.property] ?? actual.scale ?? fallback) -
            (without[e.property] ?? without.scale ?? fallback),
        ) < 1e-8
          ? "PASSED"
          : "FAILED",
    });
    for (let i = 0; i <= Math.min(e.durationFrames, 120); i++)
      add(
        e.startFrame + (i * e.durationFrames) / Math.min(e.durationFrames, 120),
      );
  }
  const tracks = new Map<
    string,
    { animation: MotionState["animations"][number]; property: string }[]
  >();
  for (const animation of state.animations.filter((a) => a.enabled)) {
    for (const property of Object.keys(
      evaluateAnimation(animation, animation.startFrame),
    )) {
      const key = JSON.stringify([
        animation.sceneId,
        animation.targetId,
        property,
      ]);
      const items = tracks.get(key) ?? [];
      items.push({ animation, property });
      tracks.set(key, items);
    }
  }
  for (const items of tracks.values()) {
    items.sort((a, b) => a.animation.startFrame - b.animation.startFrame);
    for (let i = 1; i < items.length; i++) {
      const previous = items[i - 1].animation,
        current = items[i].animation,
        property = items[i].property as keyof ReturnType<
          typeof evaluateAnimation
        >;
      const end =
        evaluateAnimation(
          previous,
          previous.startFrame + previous.durationFrames,
        )[property] ?? 0;
      const start =
        evaluateAnimation(current, current.startFrame)[property] ?? 0;
      const discontinuity = Math.abs(start - end) > 1e-5;
      if (discontinuity)
        checks.push({
          name: "trackJunction",
          target: current.animationId,
          status: /скач|прыж|резк|дискрет|снова|jump|snap|cut/i.test(request)
            ? "WARNING"
            : "FAILED",
          reason: "Consecutive base tracks have different end/start values",
          metrics: { property, previousEnd: end, nextStart: start },
        });
    }
  }
  const sequence = [...frames].sort((a, b) => a - b);
  for (const frame of sequence) {
    const result = evaluateMotion(state, frame, presentation);
    if (
      Object.values(result.nodes).some((n) =>
        Object.values(n).some((v) => !Number.isFinite(v)),
      )
    )
      checks.push({
        name: "finiteState",
        status: "FAILED",
        metrics: { frame },
      });
  }
  checks.push({
    name: "finiteState",
    status: checks.some((c) => c.name === "finiteState") ? "FAILED" : "PASSED",
    metrics: { sampleCount: sequence.length },
  });
  return { checks, frames: sequence };
}
