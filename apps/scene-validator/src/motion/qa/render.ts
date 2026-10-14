import { chromium, type Page, type Browser } from "playwright";
import type { LoadedProject } from "../../types.js";
import type { MotionState } from "../schema.js";
import { buildRegistry } from "../registry.js";
import { evaluateMotion } from "../engine.js";
import { motionHtml } from "../presentation.js";
import { evaluateAnimation } from "../engine.js";
import { numericQA, type Check } from "./numeric.js";
import { atomicJson, safeDirectory } from "../../files.js";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
export const stateDigest = (state: MotionState) =>
  createHash("sha256").update(JSON.stringify(state)).digest("hex");
async function pixelDifference(page: Page, a: Buffer, b: Buffer) {
  return page.evaluate(
    async ({ a, b }) => {
      const decoded: Uint8ClampedArray[] = [];
      for (const data of [a, b]) {
        const img = new Image();
        img.src = "data:image/png;base64," + data;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        decoded.push(ctx.getImageData(0, 0, c.width, c.height).data);
      }
      const [x, y] = decoded;
      let count = 0;
      for (let i = 0; i < x.length; i += 4)
        if (
          Math.max(
            Math.abs(x[i] - y[i]),
            Math.abs(x[i + 1] - y[i + 1]),
            Math.abs(x[i + 2] - y[i + 2]),
            Math.abs(x[i + 3] - y[i + 3]),
          ) > 8
        )
          count++;
      return count;
    },
    { a: a.toString("base64"), b: b.toString("base64") },
  );
}
export async function motionQA(
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
    numeric = numericQA(
      targetScope
        ? {
            ...state,
            animations: state.animations.filter(
              (a) =>
                a.sceneId === targetScope.sceneId &&
                a.targetId === targetScope.targetId,
            ),
            expressions: state.expressions?.filter(
              (e) =>
                e.sceneId === targetScope.sceneId &&
                e.targetId === targetScope.targetId,
            ),
            objectTransitions: [],
          }
        : state,
      request,
    ),
    checks: Check[] = [...numeric.checks];
  await atomicJson(
    path.join(directory, "numeric-samples.json"),
    numeric.frames.map((frame) => evaluateMotion(state, frame)),
  );
  const report = {
    scope: "objective checks only; inspect per-check NOT_TESTED coverage",
    status: "PASSED",
    createdAt: new Date().toISOString(),
    stateDigest: stateDigest(state),
    sourceFingerprint: project.inspection.fingerprint,
    request,
    checks,
    samples: [] as { frame: number; file: string }[],
    rendererWarnings: [] as string[],
    subjectiveQuality: "NOT_TESTED",
  };
  let browser: Browser | undefined;
  const pages: Page[] = [];
  const renderCheck = () => {
    options.signal?.throwIfAborted();
    options.beforeRender?.();
  };
  try {
    const built = await motionHtml(project, state);
    report.rendererWarnings = built.warnings;
    browser = options.browser ?? (await chromium.launch({ headless: true }));
    const page = await browser.newPage({
      viewport: { width: state.settings.width, height: state.settings.height },
      deviceScaleFactor: 1,
    });
    pages.push(page);
    const onAbort = () => {
      void page.close();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    page.on("close", () =>
      options.signal?.removeEventListener("abort", onAbort),
    );
    await page.route("**/*", (r) =>
      r.request().url().startsWith("data:") ? r.continue() : r.abort(),
    );
    await page.setContent(built.html);
    await page.evaluate(async () => {
      await window.motionReady;
    });
    const changed = (item: unknown, old: unknown[]) =>
      !previous || !old.some((v) => JSON.stringify(v) === JSON.stringify(item));
    const effects = [
      ...state.animations
        .filter((a) => a.enabled && changed(a, previous?.animations ?? []))
        .map((a) => ({ ...a, id: a.animationId, kind: a.effect })),
      ...(state.expressions ?? [])
        .filter((e) => e.enabled && changed(e, previous?.expressions ?? []))
        .map((e) => ({ ...e, id: e.expressionId, kind: e.type })),
    ];
    const retiredAnimations = (previous?.animations ?? []).filter(
      (a) =>
        !state.animations.some((next) => next.animationId === a.animationId) &&
        (!targetScope ||
          (a.sceneId === targetScope.sceneId &&
            a.targetId === targetScope.targetId)),
    );
    const frameSet = new Set<number>();
    for (const e of [...effects, ...retiredAnimations])
      for (const t of [-1, 0, 0.25, 0.5, 0.75, 1, 1 + 1 / e.durationFrames])
        frameSet.add(
          Math.max(
            0,
            Math.min(
              state.settings.durationFrames - 1,
              Math.round(e.startFrame + (t === -1 ? -1 : t * e.durationFrames)),
            ),
          ),
        );
    for (const t of targetScope ? [] : (state.objectTransitions ?? []))
      for (const x of [0, 0.25, 0.5, 0.75, 1])
        frameSet.add(Math.round(t.startFrame + t.durationFrames * x));
    if (!frameSet.size) frameSet.add(0);
    const frames = [...frameSet].sort((a, b) => a - b);
    if (frames.length > 100)
      throw new Error(
        "QA frame budget exceeded (100); split the requested edit",
      );
    const images: Buffer[] = [];
    for (const frame of frames) {
      await page.evaluate((f) => window.motionFrame(f), frame);
      const image = await (renderCheck(), page.screenshot({ type: "png" })),
        file = "frame-" + String(frame).padStart(6, "0") + ".png";
      await writeFile(path.join(directory, file), image);
      images.push(image);
      report.samples.push({ frame, file });
    }
    for (const a of retiredAnimations.filter((a) => a.effect === "trimPath")) {
      await page.evaluate(
        (f) => window.motionFrame(f),
        Math.min(
          state.settings.durationFrames - 1,
          a.startFrame + Math.round(a.durationFrames / 2),
        ),
      );
      const target = page
        .locator(
          `[data-motion-scene="${a.sceneId}"] [data-motion-target="${a.targetId}"]`,
        )
        .first();
      const exists = await target.count();
      const visible = exists ? await target.isVisible() : false;
      const paths = exists ? await target.locator("path").count() : 0;
      const masks = exists
        ? await target.locator("[data-motion-reveal-progress]").count()
        : 0;
      checks.push({
        name: "PATH_REVEAL_REMOVAL",
        target: a.targetId,
        status:
          !exists || masks
            ? "FAILED"
            : !visible
              ? "NOT_TESTED"
              : paths
                ? "PASSED"
                : "FAILED",
        reason: !visible
          ? "Source target is outside visible composition at sampled former interval"
          : "Original SVG geometry remains; no generated path reveal mask in rebuilt renderer",
        metrics: {
          removedAnimationId: a.animationId,
          sourcePathCount: paths,
          remainingRevealCount: masks,
        },
      });
    }
    const textTargets = [
      ...new Map(
        effects.map((e) => [JSON.stringify([e.sceneId, e.targetId]), e]),
      ).values(),
    ];
    for (const e of textTargets) {
      const frame = Math.min(
        state.settings.durationFrames - 1,
        e.startFrame + e.durationFrames,
      );
      await page.evaluate((f) => window.motionFrame(f), frame);
      const target = page
        .locator(
          `[data-motion-scene="${e.sceneId}"] [data-motion-target="${e.targetId}"]`,
        )
        .first();
      if (
        !(await target.count()) ||
        !(await target.locator("foreignObject").count())
      )
        continue;
      if (!(await target.isVisible())) {
        checks.push({
          name: "TEXT_GLYPH_INTEGRITY",
          target: e.targetId,
          status: "NOT_TESTED",
          reason: "Text is outside visible composition at sampled endpoint",
        });
        continue;
      }
      const beforeImage = await (renderCheck(), page.screenshot());
      const attributes = await target
        .locator("foreignObject")
        .evaluateAll((elements) =>
          elements.map((el) => ({
            height: el.getAttribute("height"),
            overflow: el.getAttribute("overflow"),
          })),
        );
      await target.locator("foreignObject").evaluateAll((elements) => {
        for (const el of elements) {
          const html = el.firstElementChild as HTMLElement | null;
          el.setAttribute(
            "height",
            String(
              Math.max(
                Number(el.getAttribute("height")),
                html?.scrollHeight ?? 0,
              ),
            ),
          );
          el.setAttribute("overflow", "visible");
        }
      });
      const expanded = await (renderCheck(), page.screenshot());
      await target.locator("foreignObject").evaluateAll(
        (elements, attrs) =>
          elements.forEach((el, i) => {
            for (const key of ["height", "overflow"] as const) {
              const value = attrs[i][key];
              if (value === null) el.removeAttribute(key);
              else el.setAttribute(key, value);
            }
          }),
        attributes,
      );
      const pixels = await pixelDifference(page, beforeImage, expanded);
      checks.push({
        name: "TEXT_GLYPH_INTEGRITY",
        target: e.targetId,
        status: pixels === 0 ? "PASSED" : "FAILED",
        metrics: { changedPixels: pixels },
        reason:
          "Actual text render compared against natural content height with foreignObject overflow visible; intentional ancestor clipping retained. Font fidelity is a separate limitation.",
      });
      checks.push({
        name: "UNEXPECTED_CLIPPING",
        target: e.targetId,
        status: pixels === 0 ? "PASSED" : "FAILED",
        reason:
          "Counterfactual detects foreignObject clipping; does not disable source frame clipping or masks",
      });
    }
    for (const e of effects) {
      const rows: {
        frame: number;
        contribution: number;
        effectPixels: number;
        geometry: string;
        paths: number;
        lengths: number[];
        sourceGeometryLengths: number[];
        offsets: (string | null)[];
        reveal: {
          length: number;
          offset: number;
          direction: string | null;
          progress: number;
          dash: string | null;
          forwardIsLeftToRight: boolean;
        }[];
        bounds: unknown;
        maskBoundsValid: boolean;
        gradients: string;
        sourceTransforms: string;
      }[] = [];
      const samples = (
        e.kind === "inertialOvershoot"
          ? []
          : e.kind === "trimPath"
            ? [0, 0.25, 0.5, 0.75, 1]
            : [0.5, 1]
      ).map((t) =>
        Math.min(
          state.settings.durationFrames - 1,
          Math.round(e.startFrame + t * e.durationFrames),
        ),
      );
      for (const frame of samples) {
        await page.evaluate((f) => window.motionFrame(f), frame);
        const selector =
          '[data-motion-scene="' +
          e.sceneId +
          '"] [data-motion-target="' +
          e.targetId.replaceAll('"', '\\"') +
          '"]';
        const target = page.locator(selector).first();
        if (!(await target.count())) {
          checks.push({
            name: "renderedTarget",
            status: "FAILED",
            target: e.id,
            reason: "Missing renderer target",
          });
          break;
        }
        const metrics = await target.evaluate((el) => {
          const paths = [
              ...el.querySelectorAll<SVGGeometryElement>("[data-motion-trim]"),
            ],
            r = el.getBoundingClientRect();
          return {
            sourceTransforms: [...el.querySelectorAll("[data-node-id]")]
              .map((n) => n.getAttribute("transform"))
              .join(";"),
            maskBoundsValid: paths.every((p) => {
              const parent = p.parentElement;
              if (
                parent?.getAttribute("data-motion-effect-mask") !== "pathReveal"
              )
                return false;
              const id = parent
                .getAttribute("mask")
                ?.match(/url\(#([^)]*)\)/)?.[1];
              if (!id) return true;
              const mask = document.getElementById(id);
              if (!mask) return false;
              const b = p.getBBox(),
                m = p.transform.baseVal.consolidate()?.matrix;
              const corners = [
                [b.x, b.y],
                [b.x + b.width, b.y],
                [b.x, b.y + b.height],
                [b.x + b.width, b.y + b.height],
              ].map(([x, y]) =>
                m
                  ? { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }
                  : { x, y },
              );
              const x = Number(mask.getAttribute("x")),
                y = Number(mask.getAttribute("y")),
                w = Number(mask.getAttribute("width")),
                h = Number(mask.getAttribute("height"));
              return corners.every(
                (p) =>
                  p.x >= x - 0.01 &&
                  p.x <= x + w + 0.01 &&
                  p.y >= y - 0.01 &&
                  p.y <= y + h + 0.01,
              );
            }),
            gradients: [
              ...el
                .closest("svg")!
                .querySelectorAll("linearGradient,radialGradient"),
            ]
              .map((g) => g.outerHTML)
              .join(""),
            geometry: paths
              .map((p) => p.outerHTML.replace(/ mask="[^"]*"/g, ""))
              .join(""),
            paths: paths.length,
            lengths: [
              ...el.querySelectorAll<SVGGeometryElement>(
                "[data-motion-reveal]",
              ),
            ].map((p) => p.getTotalLength()),
            sourceGeometryLengths: paths.map((p) => p.getTotalLength()),
            reveal: [
              ...el.querySelectorAll<SVGGeometryElement>(
                "[data-motion-reveal]",
              ),
            ].map((p, i) => {
              const length = p.getTotalLength(),
                start = p.getPointAtLength(0),
                end = p.getPointAtLength(length),
                ctm = paths[i]?.getScreenCTM();
              const sx = ctm ? ctm.a * start.x + ctm.c * start.y : start.x,
                ex = ctm ? ctm.a * end.x + ctm.c * end.y : end.x;
              return {
                length,
                offset: Number(p.getAttribute("stroke-dashoffset")),
                direction: p.getAttribute("data-motion-reveal-direction"),
                progress: Number(p.getAttribute("data-motion-reveal-progress")),
                dash: p.getAttribute("stroke-dasharray"),
                forwardIsLeftToRight: ex >= sx,
              };
            }),
            offsets: [...el.querySelectorAll("[data-motion-reveal]")].map((p) =>
              p.getAttribute("stroke-dashoffset"),
            ),
            bounds: { x: r.x, y: r.y, width: r.width, height: r.height },
          };
        });
        const actual = await (renderCheck(), page.screenshot());
        const original = await target.getAttribute("style");
        await target.evaluate((el) => {
          (el as HTMLElement).style.visibility = "hidden";
        });
        const hidden = await (renderCheck(), page.screenshot());
        await target.evaluate((el, style) => {
          if (style === null) el.removeAttribute("style");
          else el.setAttribute("style", style);
        }, original);
        let effectPixels = 0;
        if (e.kind === "trimPath" || e.kind === "maskReveal") {
          await page.evaluate((s) => window.motionUpdate(s), {
            ...state,
            animations: state.animations.filter((a) => a.animationId !== e.id),
          });
          const full = await (renderCheck(), page.screenshot());
          effectPixels = await pixelDifference(page, actual, full);
          await page.evaluate((s) => window.motionUpdate(s), state);
        }
        if (e.kind === "inertialOvershoot") {
          const without = {
            ...state,
            expressions: state.expressions?.filter(
              (x) => x.expressionId !== e.id,
            ),
          };
          await page.evaluate((s) => window.motionUpdate(s), without);
          const base = await (renderCheck(), page.screenshot());
          effectPixels = await pixelDifference(page, actual, base);
          await page.evaluate((s) => window.motionUpdate(s), state);
        }
        rows.push({
          frame,
          contribution: await pixelDifference(page, actual, hidden),
          effectPixels,
          ...metrics,
        });
      }
      await atomicJson(
        path.join(
          directory,
          "effect-" +
            createHash("sha256").update(e.id).digest("hex").slice(0, 16) +
            ".json",
        ),
        { id: e.id, rows },
      );
      if (e.kind === "trimPath") {
        const a = state.animations.find((a) => a.animationId === e.id)!;
        const supported =
          rows.length === 5 &&
          rows.every(
            (r) =>
              r.paths > 0 &&
              r.lengths.every((l) => Number.isFinite(l) && l > 0),
          );
        checks.push({
          name: "realPathGeometry",
          target: e.id,
          status: supported ? "PASSED" : "FAILED",
          metrics: rows,
        });
        checks.push({
          name: "immutableGeometry",
          target: e.id,
          status:
            rows.length > 0 &&
            rows.every((r) => r.geometry === rows[0].geometry)
              ? "PASSED"
              : "FAILED",
        });
        checks.push({
          name: "GEOMETRY_INTEGRITY",
          target: e.id,
          status:
            rows.length && rows.every((r) => r.geometry === rows[0].geometry)
              ? "PASSED"
              : "FAILED",
        });
        checks.push({
          name: "MASK_BOUNDS_VALIDATION",
          target: e.id,
          status:
            rows.length && rows.every((r) => r.maskBoundsValid)
              ? "PASSED"
              : "FAILED",
          reason:
            "Effect mask region contains transformed source geometry; source mask remains on the original path",
        });
        checks.push({
          name: "TRANSFORM_INTEGRITY",
          target: e.id,
          status:
            rows.length &&
            rows.every((r) => r.sourceTransforms === rows[0].sourceTransforms)
              ? "PASSED"
              : "FAILED",
          reason:
            "Source transforms are unchanged; animated transform belongs to its outer wrapper",
        });
        checks.push({
          name: "GRADIENT_PRESERVATION",
          target: e.id,
          status:
            rows.length && rows.every((r) => r.gradients === rows[0].gradients)
              ? "PASSED"
              : "FAILED",
        });
        const final = rows.at(-1),
          finalProgress = final
            ? evaluateAnimation(a, final.frame).trim
            : undefined;
        checks.push({
          name: "FINAL_STATE_MATCH",
          target: e.id,
          status:
            finalProgress === 1 && final && final.contribution > 0
              ? final.effectPixels === 0
                ? "PASSED"
                : "FAILED"
              : "NOT_TESTED",
          reason:
            "At full reveal compare actual pixels to same-frame render without Trim; offscreen/occluded/incomplete endpoints are not asserted",
        });
        if (a.effect === "trimPath") {
          const parametersValid =
            rows.length === 5 &&
            rows.every((row) => {
              const progress = evaluateAnimation(a, row.frame).trim ?? 1;
              return (
                row.reveal.length === row.paths &&
                row.reveal.every(
                  (path) =>
                    Number.isFinite(path.length) &&
                    path.length > 0 &&
                    Math.abs(path.progress - progress) < 1e-6 &&
                    Math.abs(
                      path.offset -
                        (path.direction === "reverse" ? -1 : 1) *
                          (1 - progress) *
                          path.length,
                    ) < Math.max(0.01, path.length * 1e-6) &&
                    (a.parameters.direction === "reverse"
                      ? path.direction === "reverse"
                      : a.parameters.direction === "forward" ||
                          !a.parameters.direction
                        ? path.direction === "forward"
                        : path.direction ===
                          ((a.parameters.direction === "leftToRight") ===
                          path.forwardIsLeftToRight
                            ? "forward"
                            : "reverse")),
                )
              );
            });
          checks.push({
            name: "revealParameters",
            target: e.id,
            status: parametersValid ? "PASSED" : "FAILED",
            reason:
              "Dash offset verified against evaluated progress and actual CENTERLINE mask length; frame clamping accounted for",
          });
          const visible = rows.some((r) => r.effectPixels > 0);
          checks.push({
            name: "PATH_REVEAL_INTEGRITY",
            target: e.id,
            status: !parametersValid
              ? "FAILED"
              : visible
                ? "PASSED"
                : "WARNING",
          });
          checks.push({
            name: "renderedPathReveal",
            target: e.id,
            status: !parametersValid
              ? "FAILED"
              : visible
                ? "PASSED"
                : "WARNING",
            metrics: {
              changedPixels: rows.map((r) => r.effectPixels),
              visibleContribution: rows.map((r) => r.contribution),
            },
            reason: visible
              ? "Actual render compared with fully revealed target at the SAME frame. Pixel counts across different frames are not a monotonic invariant."
              : "Renderer parameters verified, but no visible difference in sampled viewport: target may be offscreen, clipped or occluded. Visibility is not asserted.",
          });
        }
      } else if (e.kind === "maskReveal") {
        const final = rows.at(-1),
          a = state.animations.find((a) => a.animationId === e.id)!;
        checks.push({
          name: "TEXT_MASK_REVEAL",
          target: e.id,
          status: rows.some((r) => r.effectPixels > 0) ? "PASSED" : "WARNING",
          reason:
            "Actual partial render compared with same-frame text without requested Mask Reveal; no Fade substitute",
        });
        checks.push({
          name: "FINAL_STATE_MATCH",
          target: e.id,
          status:
            final &&
            final.contribution > 0 &&
            evaluateAnimation(a, final.frame).reveal === 1
              ? final.effectPixels === 0
                ? "PASSED"
                : "FAILED"
              : "NOT_TESTED",
          reason:
            "Completed text reveal must match same-frame unmasked glyph pixels",
        });
      } else if (e.kind === "inertialOvershoot") {
        // Quarter points can coincide with sine zeroes; sample the first analytical quarter-cycle too.
        const expr = state.expressions!.find((x) => x.expressionId === e.id)!;
        if (expr.type === "inertialOvershoot") {
          const probe =
            expr.startFrame +
            Math.max(
              1,
              Math.round(state.settings.fps / (4 * expr.parameters.frequency)),
            );
          await page.evaluate((f) => window.motionFrame(f), probe);
          const actual = await (renderCheck(), page.screenshot());
          await page.evaluate((s) => window.motionUpdate(s), {
            ...state,
            expressions: state.expressions?.filter(
              (x) => x.expressionId !== e.id,
            ),
          });
          const base = await (renderCheck(), page.screenshot());
          const pixels = await pixelDifference(page, actual, base);
          await page.evaluate((s) => window.motionUpdate(s), state);
          checks.push({
            name: "renderedOscillation",
            target: e.id,
            status:
              Math.max(pixels, ...rows.map((r) => r.effectPixels)) > 0
                ? "PASSED"
                : "FAILED",
            metrics: { changedPixels: pixels },
            reason:
              pixels === 0
                ? "No visible expression contribution at probe; inspect sampled rows"
                : undefined,
          });
        }
      } else
        checks.push({
          name: "renderedVisibility",
          target: e.id,
          status: rows.some((r) => r.contribution > 0) ? "PASSED" : "WARNING",
          reason: rows.every((r) => r.contribution === 0)
            ? "Target contributes no pixels: may be hidden, clipped, offscreen or occluded; artistic intent is not inferred"
            : undefined,
        });
    }
    const registry = buildRegistry(
      project.inspection.document,
      project.inspection.fingerprint,
    );
    for (const transition of targetScope
      ? []
      : (state.objectTransitions ?? [])) {
      const logical = registry.objects.find(
        (o) => o.logicalObjectId === transition.logicalObjectId,
      );
      const counts: number[] = [];
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        await page.evaluate(
          (f) => window.motionFrame(f),
          Math.round(transition.startFrame + t * transition.durationFrames),
        );
        const count = await page.evaluate(
          (refs) => {
            let count = 0;
            for (const ref of refs) {
              const nodes = [
                ...document.querySelectorAll<SVGGraphicsElement>(
                  "[data-motion-target]",
                ),
              ].filter(
                (n) =>
                  n.dataset.motionTarget === ref.sourceNodeId &&
                  n.closest<HTMLElement>("[data-motion-scene]")?.dataset
                    .motionScene === ref.sceneId,
              );
              for (const n of nodes) {
                let visible = n.getClientRects().length > 0;
                for (let p: Element | null = n; p; p = p.parentElement) {
                  const style = getComputedStyle(p);
                  if (
                    style.display === "none" ||
                    style.visibility === "hidden" ||
                    Number(style.opacity) === 0
                  )
                    visible = false;
                }
                if (visible) count++;
              }
            }
            return count;
          },
          logical?.sourceInstances.filter((i) =>
            [transition.fromSceneId, transition.toSceneId].includes(i.sceneId),
          ) ?? [],
        );
        counts.push(count);
      }
      checks.push({
        name: "singleLogicalInstance",
        target: transition.logicalObjectId,
        status: counts.every((n) => n === 1) ? "PASSED" : "FAILED",
        metrics: { counts },
      });
      checks.push({
        name: "transitionPixelIdentity",
        target: transition.logicalObjectId,
        status: "NOT_TESTED",
        reason:
          "Single visible hierarchy verified; semantic content equality is not inferred from pixels",
      });
    }
    const sheet = await browser.newPage({
      viewport: {
        width: 960,
        height: Math.max(180, Math.ceil(images.length / 4) * 170),
      },
    });
    await sheet.setContent(
      '<body style="margin:0;background:#222;color:white;font:12px sans-serif;display:grid;grid-template-columns:repeat(4,240px)">' +
        images
          .map(
            (img, i) =>
              '<div style="height:170px"><img style="width:240px;height:145px;object-fit:contain" src="data:image/png;base64,' +
              img.toString("base64") +
              '"><div>Frame ' +
              frames[i] +
              "</div></div>",
          )
          .join("") +
        "</body>",
    );
    await sheet.evaluate(async () => {
      await Promise.all([...document.images].map((i) => i.decode()));
    });
    pages.push(sheet);
    renderCheck();
    await sheet.screenshot({
      path: path.join(directory, "contact-sheet.png"),
      fullPage: true,
    });
    checks.push({
      name: "renderedFrames",
      status: "PASSED",
      metrics: { count: images.length },
    });
    checks.push({
      name: "artisticIntentAndTextClipping",
      status: "NOT_TESTED",
      reason:
        "No vision model; geometry and pixel checks do not establish subjective quality or text semantics",
    });
  } catch (error) {
    checks.push({
      name: "rendererQA",
      status: "FAILED",
      reason: String(error),
    });
  } finally {
    if (options.browser)
      await Promise.all(pages.map((p) => p.close().catch(() => {})));
    else await browser?.close();
  }
  report.status = checks.some((c) => c.status === "FAILED")
    ? "FAILED"
    : checks.some((c) => c.status === "WARNING")
      ? "WARNING"
      : "PASSED";
  await atomicJson(path.join(directory, "report.json"), report);
  return report;
}
