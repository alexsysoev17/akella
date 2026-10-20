/** Runtime tools delegate to the existing QA and revision-checked transaction store.
 * No tool bypasses project locking, source fingerprint, validation or Undo/Redo. */
export { motionQA as validatePreview } from "./qa/render.js";
export { changeMotion as commitChanges } from "./store.js";
