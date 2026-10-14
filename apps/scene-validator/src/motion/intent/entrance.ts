import type { LoadedProject } from "../../types.js";
/** Resolve viewport clearance in the actual parent-space translation channel. */
export function offscreenDistance(
  project: LoadedProject,
  sceneId: string,
  targetId: string,
  effect: string,
): number {
  const scene = project.inspection.document.scenes.find(
    (s) => s.sceneId === sceneId,
  );
  if (!scene) throw new Error("UNKNOWN_SCENE");
  function find(
    value: unknown,
    id: string,
  ): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object") return;
    const n = value as Record<string, unknown>;
    if (n.figmaNodeId === id) return n;
    for (const child of Array.isArray(n.children) ? n.children : []) {
      const match = find(child, id);
      if (match) return match;
    }
  }
  const node = find(scene, targetId);
  if (!node) throw new Error("TARGET_NOT_FOUND");
  const p = node.properties as Record<string, unknown>,
    m = node.sceneTransform as number[][];
  if (!m?.[0] || !m[1]) throw new Error("SOURCE_TRANSFORM_MISSING");
  const w = Number(p.width ?? node.width),
    h = Number(p.height ?? node.height);
  if (!Number.isFinite(w) || !Number.isFinite(h))
    throw new Error("SOURCE_BOUNDS_MISSING");
  const corners = [
    [0, 0],
    [w, 0],
    [0, h],
    [w, h],
  ].map(([x, y]) => [
    m[0][0] * x + m[0][1] * y + m[0][2],
    m[1][0] * x + m[1][1] * y + m[1][2],
  ]);
  const parent =
    node.parentId && node.parentId !== scene.figmaNodeId
      ? find(scene, String(node.parentId))
      : undefined;
  const pm = parent?.sceneTransform as number[][] | undefined;
  if (
    pm &&
    (Math.abs(pm[0][1]) > 1e-8 ||
      Math.abs(pm[1][0]) > 1e-8 ||
      pm[0][0] <= 0 ||
      pm[1][1] <= 0)
  )
    throw new Error("OFFSCREEN_PARENT_TRANSFORM_UNSUPPORTED");
  const axis = effect === "slideUp" || effect === "slideDown" ? 1 : 0;
  const points = corners.map((c) => c[axis]),
    size = axis ? scene.height : scene.width;
  const positive = effect === "slideUp" || effect === "slideLeft";
  const effects = Array.isArray(p.effects) ? p.effects : [];
  const visualPadding = effects.reduce<number>((padding, raw) => {
    if (!raw || typeof raw !== "object") return padding;
    const e = raw as Record<string, unknown>;
    if (e.visible === false) return padding;
    const offset = e.offset as { x?: number; y?: number } | undefined;
    return Math.max(
      padding,
      Number(e.radius ?? 0) +
        Math.max(0, Number(e.spread ?? 0)) +
        Math.abs(Number(axis ? (offset?.y ?? 0) : (offset?.x ?? 0))),
    );
  }, 0);
  const margin = Math.max(
    2,
    Math.max(Number(p.strokeWeight ?? 0), visualPadding) *
      (Math.abs(m[axis][0]) + Math.abs(m[axis][1])),
  );
  return (
    (Math.max(0, positive ? size - Math.min(...points) : Math.max(...points)) +
      margin) /
    (pm?.[axis][axis] ?? 1)
  );
}
