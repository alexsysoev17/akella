import { statePresentation } from "../motion/transitions.js";
import { staticObjectMembers } from "../motion/static-object.js";
import { presentedTransitions } from "../motion/transition-runtime.js";
import { failureCategory } from "../motion/qa/failure.js";
import type { LoadedProject } from "../types.js";
import type { MotionState } from "../motion/schema.js";
import type { Browser } from "playwright";
import { numericQA, type Check } from "../motion/qa/numeric.js";
import { qaAdmission } from "../motion/qa/policy.js";
import {
  renderNativeFrame,
  compareNativeFrames,
  probeNativeText,
} from "./client.js";
import { nativeDigest } from "./renderer.js";
import { safeDirectory, atomicJson } from "../files.js";
import { writeFile } from "node:fs/promises";
import path from "node:path";
/** Production QA evaluates the same native frames as Preview/export. No DOM/Chromium inspection. */
export async function nativeMotionQA(
  project: LoadedProject,
  state: MotionState,
  relativeDirectory: string,
  request: string,
  previous?: MotionState,
  targetScope?: { sceneId: string; targetId: string },
  options: {
    signal?: AbortSignal;
    beforeRender?: () => void;
    browser?: Browser;
  } = {},
) {
  const directory = await safeDirectory(project.root, relativeDirectory),
    scope = (sceneId: string, targetId: string) =>
      !targetScope ||
      (sceneId === targetScope.sceneId && targetId === targetScope.targetId);
  const numeric = numericQA(
      targetScope
        ? {
            ...state,
            animations: state.animations.filter((a) =>
              scope(a.sceneId, a.targetId),
            ),
            expressions: state.expressions?.filter((e) =>
              scope(e.sceneId, e.targetId),
            ),
            objectTransitions: state.objectTransitions?.filter(t => state.expressions?.some(e => e.transitionId === t.transitionId && scope(e.sceneId, e.targetId))),
          }
        : state,
      request,
      statePresentation(project, state),
    ),
    checks: Check[] = [...numeric.checks],
    samples: { frame: number; file: string }[] = [],
    warnings = new Set<string>(),
    before = nativeDigest(project.inspection.document),
    frames = [...new Set([...numeric.frames, ...(state.staticObjects?.some(o => scope(o.sceneId,o.targetId)) ? [0, Math.floor(state.settings.durationFrames / 2), state.settings.durationFrames - 1] : [])])]
      .slice(0, 24);
  const report = {
    scope: "native Skia objective checks; artistic quality NOT_TESTED",
    status: "PASSED",
    createdAt: new Date().toISOString(),
    stateDigest: nativeDigest(state),
    sourceFingerprint: project.inspection.fingerprint,
    request,
    checks,
    samples,
    rendererWarnings: [] as string[],
    subjectiveQuality: "NOT_TESTED",
    renderer: "skia-cpu/1",
    failureCategory: null as string | null,
    renderMetrics: { uniqueRequests: 0, reusedRequests: 0, cachePeakBytes: 0 },
    nativeMemory: undefined as
      | Awaited<ReturnType<typeof renderNativeFrame>>["nativeMemory"]
      | undefined,
  };
  const renderCache = new Map<
    string,
    Awaited<ReturnType<typeof renderNativeFrame>>
  >();
  let cacheBytes = 0;
  const stateDigests = new WeakMap<MotionState, string>();
  const render = async (s: MotionState, frame: number, fresh = false) => {
    options.signal?.throwIfAborted();
    let digest = stateDigests.get(s);
    if (!digest) {
      digest = nativeDigest(s);
      stateDigests.set(s, digest);
    }
    const key = digest + ":" + frame;
    const cached = renderCache.get(key);
    if (cached && !fresh) {
      report.renderMetrics.reusedRequests++;
      return cached;
    }
    options.beforeRender?.();
    report.renderMetrics.uniqueRequests++;
    const result = await renderNativeFrame(project, s, frame, {
      signal: options.signal,
      cache: !fresh,
    });
    result.warnings.forEach((w) => warnings.add(w));
    report.nativeMemory = result.nativeMemory;
    while (
      cacheBytes + result.png.byteLength > 16 * 1024 * 1024 &&
      renderCache.size
    ) {
      const first = renderCache.keys().next().value!;
      cacheBytes -= renderCache.get(first)!.png.byteLength;
      renderCache.delete(first);
    }
    if (!fresh && result.png.byteLength <= 16 * 1024 * 1024) {
      renderCache.set(key, result);
      cacheBytes += result.png.byteLength;
      report.renderMetrics.cachePeakBytes = Math.max(
        report.renderMetrics.cachePeakBytes,
        cacheBytes,
      );
    }
    return result;
  };
  try {
    for (const frame of frames) {
      const result = await render(state, frame),
        file = `frame-${frame}.png`;
      await writeFile(path.join(directory, file), result.png);
      samples.push({ frame, file });
    }
    checks.push({
      name: "renderedFrames",
      category: "render",
      required: true,
      status: samples.length ? "PASSED" : "FAILED",
      metrics: { renderer: "skia-cpu/1", frames: frames.length },
    });
    const sampleFrame = frames[Math.floor(frames.length / 2)] ?? 0,
      a = await render(state, sampleFrame, true),
      b = await render(state, sampleFrame, true);
    checks.push({
      name: "NATIVE_RANDOM_ACCESS_DETERMINISM",
      category: "render",
      required: true,
      status: Buffer.from(a.png).equals(Buffer.from(b.png))
        ? "PASSED"
        : "FAILED",
    });
    const text = state.animations.filter(
      (a) =>
        a.enabled &&
        a.text &&
        a.text.segmentation !== "block" &&
        scope(a.sceneId, a.targetId),
    );
    for (const track of text.filter(
      (a, i, all) =>
        all.findIndex(
          (b) => a.sceneId === b.sceneId && a.targetId === b.targetId,
        ) === i,
    )) {
      const start = track.startFrame,
        end = Math.min(
          state.settings.durationFrames - 1,
          start +
            track.durationFrames +
            Math.max(
              0,
              ...(state.expressions ?? [])
                .filter((e) => scope(e.sceneId, e.targetId))
                .map((e) => e.durationFrames),
            ),
        );
      const from = await render(state, start),
        to = await render(state, end),
        x = from.text.find(
          (t) => scope(t.sceneId, t.targetId) && t.targetId === track.targetId,
        ),
        y = to.text.find(
          (t) => scope(t.sceneId, t.targetId) && t.targetId === track.targetId,
        );
      checks.push({
        name: "TEXT_LAYOUT_AND_SEEK",
        category: "render",
        target: track.targetId,
        required: true,
        status:
          x && y && nativeDigest(x.lines) === nativeDigest(y.lines)
            ? "PASSED"
            : "FAILED",
        metrics: {
          start,
          end,
          startUnits: x,
          endUnits: y,
          layoutOwner: "immutable SkParagraph",
          transport: "native cached glyph planes",
        },
      });
      const intervalFrames = [
          ...new Set(
            Array.from({ length: 9 }, (_, i) =>
              Math.round(start + ((end - start) * i) / 8),
            ),
          ),
        ],
        temporal = [];
      for (const frame of intervalFrames) {
        const rendered = await render(state, frame);
        const detail = rendered.text.find(
          (t) => t.sceneId === track.sceneId && t.targetId === track.targetId,
        );
        if (detail) temporal.push({ frame, ...detail });
      }
      checks.push({
        name: "TEXT_SEGMENT_FRAME_CONTINUITY",
        category: "render",
        target: track.targetId,
        required: true,
        status:
          temporal.length &&
          temporal.every(
            (t) =>
              nativeDigest(t.lines) === nativeDigest(x?.lines) &&
              t.offsets.every(
                (o) =>
                  Number.isFinite(o.x) &&
                  Number.isFinite(o.y) &&
                  Number.isFinite(o.opacity) &&
                  o.opacity >= 0 &&
                  o.opacity <= 1,
              ),
          )
            ? "PASSED"
            : "FAILED",
        reason:
          "Sampled native raster frames: immutable shaped lines and finite per-unit transforms; subpixel transport is independently measured below. This is not exhaustive every-frame or artistic validation.",
        metrics: {
          frames: intervalFrames,
          sampling: "nine evenly spaced interval samples",
        },
      });
      checks.push({
        name: "TEXT_STAGGER_CONTRACT",
        category: "technical",
        target: track.targetId,
        required: true,
        status:
          (x?.units ?? 0) > 1 &&
          track.text?.timing === "staggered" &&
          track.text.staggerFrames === 0
            ? "FAILED"
            : "PASSED",
        reason:
          "Staggered multi-unit animation requires nonzero separation; simultaneous timing is explicit.",
      });
      for (let i = 0; i < 7; i++) {
        options.signal?.throwIfAborted();
        options.beforeRender?.();
      }
      const transport = await probeNativeText(
        project,
        state,
        track.targetId,
        options.signal,
      );
      checks.push({
        name: "TEXT_RENDERED_SUBPIXEL_TRANSPORT",
        category: "render",
        required: true,
        target: track.targetId,
        status: transport.status as Check["status"],
        metrics: transport,
      });
    }
    for (const track of state.animations.filter(
      (a) =>
        a.enabled && a.effect === "trimPath" && scope(a.sceneId, a.targetId),
    )) {
      const at = Math.max(0, Math.min(
          state.settings.durationFrames - 1,
          track.startFrame + Math.floor(track.durationFrames * 0.5),
        )),
        result = await render(state, at),
        full = await render(
          {
            ...state,
            animations: state.animations.map((a) =>
              a.animationId === track.animationId && a.effect === "trimPath"
                ? {
                    ...a,
                    parameters: {
                      ...a.parameters,
                      from: 1,
                      to: 1,
                      startFrom: 0,
                      startTo: 0,
                    },
                  }
                : a,
            ),
          },
          at,
        ),
        paths = result.paths.filter((p) => p.targetId === track.targetId),
        difference = await compareNativeFrames(result.png, full.png);
      checks.push({
        name: "realPathGeometry",
        category: "technical",
        target: track.targetId,
        required: true,
        status:
          paths.length && paths.every((p) => p.length > 0 && p.contours > 0)
            ? "PASSED"
            : "FAILED",
        metrics: paths,
      });
      checks.push({
        name: "TRIM_PARAMETERS",
        category: "mathematics",
        target: track.targetId,
        required: true,
        status:
          paths.length &&
          paths.every((p) => p.start >= 0 && p.end <= 1 && p.start <= p.end)
            ? "PASSED"
            : "FAILED",
      });
      const intervalVisible=track.startFrame < state.settings.durationFrames && track.startFrame+track.durationFrames > 0;
      const targetHits=result.hits.filter(h=>h.targetId===track.targetId);
      const offscreen=targetHits.length>0 && targetHits.every(h=>Math.max(...h.points.map(p=>p.x))<0 || Math.min(...h.points.map(p=>p.x))>=result.width || Math.max(...h.points.map(p=>p.y))<0 || Math.min(...h.points.map(p=>p.y))>=result.height);
      checks.push({
        name: "renderedPathReveal",
        category: "render",
        target: track.targetId,
        required: true,
        status: !intervalVisible || offscreen ? "NOT_TESTED" : difference.changedPixels > 0 ? "PASSED" : "FAILED",
        ...( !intervalVisible || offscreen ? {required:false} : {}),
        reason: !intervalVisible ? "Reveal interval lies outside exported window; parameter/geometry checks still run" : offscreen ? "Actual transformed bounds lie outside viewport; no visible reveal expected" : difference.changedPixels
          ? "Actual native geometric reveal differs from untrimmed counterfactual"
          : "No visible reveal in sampled frame: inspect scene timing, clipping, occlusion or fully offscreen geometry",
        metrics: {
          frame: at,
          ...difference,
          method:
            "native contour arc-length segments; no pixel-count monotonicity assumption",
        },
      });
    }
    for (const track of state.animations.filter(
      (a) =>
        a.enabled && a.effect === "maskReveal" && scope(a.sceneId, a.targetId),
    )) {
      const frame = Math.min(
          state.settings.durationFrames - 1,
          track.startFrame + Math.floor(track.durationFrames * 0.5),
        ),
        a = await render(state, frame),
        b = await render(
          {
            ...state,
            animations: state.animations.map((a) =>
              a.animationId === track.animationId && a.effect === "maskReveal"
                ? { ...a, parameters: { ...a.parameters, from: 1, to: 1 } }
                : a,
            ),
          },
          frame,
        ),
        difference = await compareNativeFrames(a.png, b.png);
      const targetHit = a.hits.find(
        (h) => h.sceneId === track.sceneId && h.targetId === track.targetId,
      );
      const isOffscreen = Boolean(
        targetHit?.points.length &&
          targetHit.points.every(
            (p) =>
              p.x < 0 ||
              p.x > state.settings.width ||
              p.y < 0 ||
              p.y > state.settings.height,
          ),
      );
      const passed = difference.changedPixels > 0 || isOffscreen;
      checks.push({
        name: "renderedTextReveal",
        category: "render",
        target: track.targetId,
        required: true,
        status: passed ? "PASSED" : "FAILED",
        metrics: { frame, ...difference },
      });
    }
    for (const entry of state.staticObjects ?? []) {
      if (targetScope && !scope(entry.sceneId, entry.targetId)) continue;
      if (previous?.staticObjects?.some(o => JSON.stringify(o) === JSON.stringify(entry))) continue;
      const { object } = staticObjectMembers(project, entry.logicalObjectId);
      const hidden = { ...state, staticObjects: (state.staticObjects ?? []).filter(o => o.logicalObjectId !== entry.logicalObjectId), visibility: [...state.visibility.filter(v => !object.sourceInstances.some(i => i.sceneId === v.sceneId && i.sourceNodeId === v.targetId)), ...object.sourceInstances.map(i => ({sceneId:i.sceneId,targetId:i.sourceNodeId,visible:false}))] };
      let expected: string | undefined;
      for (const frame of [...new Set([0, Math.floor(state.settings.durationFrames / 2), state.settings.durationFrames - 1])]) {
        const actual = await render(state, frame), background = await render(hidden, frame);
        const hit = actual.hits.find(h => h.sceneId === entry.sceneId && h.targetId === entry.targetId);
        const pose = JSON.stringify(hit?.points);
        expected ??= pose;
        const difference = await compareNativeFrames(actual.png, background.png);
        checks.push({name:"staticObjectPresentation",category:"render",target:entry.targetId,required:true,status:hit && pose === expected && difference.changedPixels > 0 ? "PASSED" : "FAILED",metrics:{frame,...difference},reason:"Persistent original pose and visible contribution across full project lifetime"});
      }
    }
    checks.push({
      name: "immutableGeometry",
      category: "technical",
      required: true,
      status:
        before === nativeDigest(project.inspection.document)
          ? "PASSED"
          : "FAILED",
    });
    if (warnings.size)
      checks.push({
        name: "NATIVE_RENDER_LIMITATIONS",
        category: "render",
        status: "WARNING",
        reason: [...warnings].join("; "),
      });
  } catch (e) {
    if (options.signal?.aborted) throw e;
    report.failureCategory = failureCategory(e);
    checks.push({
      name: "renderedFrames",
      category: "render",
      required: true,
      status: "FAILED",
      reason: e instanceof Error ? e.message : String(e),
    });
  }
  report.rendererWarnings = [...warnings];
  report.status = checks.some((c) => c.status === "FAILED")
    ? "FAILED"
    : checks.some((c) => c.status === "WARNING")
      ? "WARNING"
      : "PASSED";
  if (!qaAdmission(report).accepted) report.status = "FAILED";
  await atomicJson(path.join(directory, "report.json"), report);
  return report;
}
