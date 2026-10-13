import { applyFrame } from "./engine.js";
import type { MotionState } from "./schema.js";
declare global {
  interface Window {
    motionFrame: (frame: number) => unknown;
    motionUpdate: (state: MotionState) => void;
    motionReady: Promise<void>;
  }
}
let state: MotionState = JSON.parse(
  document.getElementById("motion-state")!.textContent!,
);
const presentation = JSON.parse(
  document.getElementById("object-states")?.textContent ?? "{}",
);
let frame = 0;
window.motionFrame = (value) => {
  frame = value;
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
  await document.fonts.ready;
  await Promise.all(
    [...document.querySelectorAll("svg image")].map(async (el) => {
      const image = new Image();
      image.src = el.getAttribute("href") ?? "";
      await image.decode();
    }),
  );
  window.motionFrame(0);
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
