import { configureTextPlane } from "./text-transport.js";
import { textRenderProbe } from "./text-probe.js";
import {
  prepareTextAnimation,
  invalidateTextLayouts,
  textDiagnostics,
} from "./text-animation.js";
import { applyFrame, evaluateMotion } from "./engine.js";
import type { MotionState } from "./schema.js";
declare global {
  interface Window {
    motionFrame: (frame: number) => unknown;
    motionUpdate: (state: MotionState) => void;
    motionReady: Promise<void>;
    motionTextProbe: typeof textRenderProbe;
    motionTextDiagnostics: () => ReturnType<typeof textDiagnostics>;
  }
}
let state: MotionState = JSON.parse(
  document.getElementById("motion-state")!.textContent!,
);
const presentation = JSON.parse(
  document.getElementById("object-states")?.textContent ?? "{}",
);
window.motionTextProbe = textRenderProbe;
window.motionTextDiagnostics = () =>
  textDiagnostics(document, state, evaluateMotion);
let frame = 0,
  ready = false;
window.motionFrame = (value) => {
  frame = value;
  if (!ready) return;
  return applyFrame(document, state, frame, presentation);
};
window.motionUpdate = (value) => {
  state = value;
  window.motionFrame(frame);
};
window.addEventListener("message", (e) => {
  if (e.source !== parent || e.origin !== location.origin) return;
  if (e.data?.type === "motion-frame") window.motionFrame(e.data.frame);
  if (e.data?.type === "motion-state") window.motionUpdate(e.data.state);
});
window.motionReady = (async () => {
  const canvas = document.getElementById("canvas");
  if (canvas) canvas.style.visibility = "hidden";
  const blocks = [
    ...document.querySelectorAll<HTMLElement>("[data-motion-block]"),
  ];
  for (const block of blocks) block.style.display = "block";
  // Configure transport before measuring immutable text layout. It never owns source position.
  for (const source of document.querySelectorAll<SVGForeignObjectElement>(
    "foreignObject[data-text-source]",
  ))
    configureTextPlane(source);
  const missing: string[] = [];
  await Promise.all(
    [...document.querySelectorAll<HTMLElement>("[data-text-start]")].map(
      async (span) => {
        const style = getComputedStyle(span);
        try {
          await document.fonts.load(
            `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
            span.textContent ?? "",
          );
        } catch {
          missing.push(style.fontFamily);
        }
      },
    ),
  );
  if (missing.length)
    document.body.dataset.motionMissingFonts = JSON.stringify([
      ...new Set(missing),
    ]);
  await document.fonts.ready;
  await Promise.all(
    [...document.querySelectorAll("svg image")].map(async (el) => {
      const image = new Image();
      image.src = el.getAttribute("href") ?? "";
      await image.decode();
    }),
  );
  for (const node of document.querySelectorAll<SVGGElement>(
    "[data-motion-target]",
  ))
    prepareTextAnimation(node, state);
  ready = true;
  window.motionFrame(frame);
  if (canvas) canvas.style.visibility = "";
  if (parent !== window)
    parent.postMessage({ type: "motion-ready" }, location.origin);
})();

document.addEventListener("click", (event) => {
  const target = (event.target as Element).closest?.("[data-motion-target]");
  if (!target || parent === window) return;
  parent.postMessage(
    {
      type: "motion-select",
      targetId: target.getAttribute("data-motion-target"),
      sceneId: target.closest<HTMLElement>("[data-motion-scene]")?.dataset
        .motionScene,
    },
    location.origin,
  );
});

document.fonts.addEventListener("loadingdone", () => {
  if (ready) {
    invalidateTextLayouts(document);
    window.motionFrame(frame);
  }
});
