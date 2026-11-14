import type { SceneDocument } from '../types.js';
import { createHash } from 'node:crypto';
import { buildRegistry } from './registry.js';
import { matrix, type Matrix } from './geometry.js';

export type StoryboardRole = 'background' | 'text' | 'logo' | 'scannable' | 'legal' | 'artwork' | 'container' | 'mask';
export type StoryboardEdge = 'left' | 'right' | 'top' | 'bottom';
type Bounds = { x: number; y: number; width: number; height: number };
type Node = Record<string, unknown>;
export interface StoryboardObject {
  sourceNodeId: string;
  logicalObjectId: string;
  name: string;
  type: string;
  parentId?: string;
  role: StoryboardRole;
  roleEvidence: 'source-type' | 'name-hypothesis' | 'geometry-hypothesis' | 'unclassified';
  text?: string;
  visible: boolean;
  bounds: Bounds | null;
  corners: { x: number; y: number }[];
  croppedEdges: StoryboardEdge[];
  entranceCandidates: { from: StoryboardEdge; clearancePx: number; canvasStartOffset: { x: number; y: number } }[];
  geometryCaveats: string[];
  /** Identity and content signatures are evidence, never animation instructions. */
  contentSignature: string;
}
export interface StoryboardAnalysis {
  version: '1';
  coordinateContract: string;
  scenes: { sceneId: string; name: string; width: number; height: number; backgroundOnly: boolean; objects: StoryboardObject[] }[];
  transitions: {
    fromSceneId: string;
    toSceneId: string;
    persistent: { logicalObjectId: string; name: string; fromNodeId: string; toNodeId: string; pose: 'unchanged' | 'changed'; content: 'unchanged' | 'changed'; centerDelta: { x: number; y: number } }[];
    entering: string[];
    exiting: string[];
    textSlotCandidates: { outgoing: string; incoming: string; overlapOfSmallerBox: number; reason: 'changed-text-same-identity' | 'overlapping-text-regions' }[];
    reading: 'progressive-build-candidate' | 'state-transition-candidate' | 'independent-composition-candidate';
  }[];
  diagnostics: string[];
}

const record = (v: unknown): Node => v && typeof v === 'object' && !Array.isArray(v) ? v as Node : {};
const rounded = (v: number) => Math.round(v * 1000) / 1000;
const stable = (v: unknown): string => JSON.stringify(v, (_, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
const signature = (v: unknown) => createHash('sha256').update(stable(v)).digest('hex');
function contentSignature(n: Node, p: Node) {
  const text = record(n.text).characters;
  // The same words with changed typography are not a message replacement.
  if (typeof text === 'string') return signature({ characters: text });
  const clean = (v: unknown): unknown => Array.isArray(v) ? v.map(clean) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !['ownerNodeId', 'figmaNodeId'].includes(k)).map(([k, value]) => [k, clean(value)])) : v;
  const geometry = Array.isArray(p.fillGeometry) && p.fillGeometry.length || Array.isArray(p.vectorPaths) && p.vectorPaths.length;
  // Per-node SVG export IDs change for identical native rectangles/images. Only a
  // true vector fallback is content evidence; never infer byte equivalence from IDs.
  const usesVectorFallback = ['VECTOR', 'POLYGON', 'STAR', 'BOOLEAN_OPERATION'].includes(String(n.type)) && !geometry;
  return signature(clean({ fills: p.fills, strokes: p.strokes, effects: p.effects, geometry: p.fillGeometry ?? p.vectorPaths, svg: usesVectorFallback ? n.svgAssetId : undefined, fallback: n.fallbackAssetId }));
}
function roleOf(n: Node, p: Node, bounds: Bounds | null, width: number, height: number): Pick<StoryboardObject, 'role' | 'roleEvidence'> {
  const name = String(n.name ?? '').toLowerCase();
  if (p.isMask === true) return { role: 'mask', roleEvidence: 'source-type' };
  if (/(?:legal|лигал|дисклеймер|disclaimer|юридическ)/u.test(name)) return { role: 'legal', roleEvidence: 'name-hypothesis' };
  if (/(?:^|[\s_\-])(?:qr|куар|qr.?code)(?:$|[\s_\-])|qrкод|qr-код/u.test(name)) return { role: 'scannable', roleEvidence: 'name-hypothesis' };
  if (/(?:лого|logo|logotype|brand.?mark)/u.test(name)) return { role: 'logo', roleEvidence: 'name-hypothesis' };
  if (n.type === 'TEXT') return { role: 'text', roleEvidence: 'source-type' };
  if (/(?:^|[\s_\-])(?:текст|text|headline|заголовок|утп|usp)(?:$|[\s_\-0-9])/u.test(name)) return { role: 'text', roleEvidence: 'name-hypothesis' };
  if (/^(?:bg|background|фон|недофон)(?:$|[\s_\-0-9])/u.test(name)) return { role: 'background', roleEvidence: 'name-hypothesis' };
  const fills = Array.isArray(p.fills) ? p.fills.map(record).filter(f => f.visible !== false) : [];
  if (n.type === 'RECTANGLE' && bounds && bounds.width >= width * .98 && bounds.height >= height * .98 && Math.abs(bounds.x) < width * .02 && Math.abs(bounds.y) < height * .02 && fills.length && fills.every(f => f.type === 'SOLID' || String(f.type).startsWith('GRADIENT_')))
    return { role: 'background', roleEvidence: 'geometry-hypothesis' };
  if (Array.isArray(n.children) && n.children.length) return { role: 'container', roleEvidence: 'source-type' };
  return { role: 'artwork', roleEvidence: 'unclassified' };
}
function overlap(a: Bounds, b: Bounds) {
  const area = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return area / Math.max(1e-9, Math.min(a.width * a.height, b.width * b.height));
}
function samePose(a: StoryboardObject, b: StoryboardObject) {
  return a.corners.length === 4 && b.corners.length === 4 && a.corners.every((p, i) => Math.hypot(p.x - b.corners[i].x, p.y - b.corners[i].y) < .01);
}

/** Source-only deterministic geometry/identity evidence. No old plan or provider is read.
 * Roles, visual identity and replacement semantics still require preview inspection. */
export function analyzeStoryboard(document: SceneDocument): StoryboardAnalysis {
  const registry = buildRegistry(document);
  const identities = new Map(registry.objects.flatMap(o => o.sourceInstances.map(i => [JSON.stringify([i.sceneId, i.sourceNodeId]), o.logicalObjectId] as const)));
  const diagnostics = [...registry.diagnostics];
  const scenes = document.scenes.map(scene => {
    const objects: StoryboardObject[] = [];
    const visit = (raw: unknown, inheritedVisible = true, inheritedClip = false, parentId?: string) => {
      const n = record(raw), p = record(n.properties);
      const id = typeof n.figmaNodeId === 'string' ? n.figmaNodeId : '';
      const visible = inheritedVisible && p.visible !== false && Number(p.opacity ?? 1) > 0;
      let bounds: Bounds | null = null, corners: { x: number; y: number }[] = [];
      const caveats = ['Bounds are transformed source rectangles, not alpha/glyph coverage or occlusion.'];
      try {
        const m: Matrix = matrix(n.sceneTransform), w = Number(p.width ?? n.width), h = Number(p.height ?? n.height);
        if (![w, h].every(Number.isFinite) || w < 0 || h < 0) throw Error('invalid dimensions');
        corners = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => ({ x: m[0][0] * x + m[0][1] * y + m[0][2], y: m[1][0] * x + m[1][1] * y + m[1][2] }));
        const xs = corners.map(v => v.x), ys = corners.map(v => v.y);
        bounds = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
      } catch { diagnostics.push(`${scene.sceneId}/${id || '(missing id)'}: source bounds unavailable; inspect source/preview.`); }
      if (inheritedClip) caveats.push('Ancestor clipping can reduce the visible extent; inspect native coverage.');
      if (Array.isArray(p.effects) && p.effects.some(e => record(e).visible !== false)) caveats.push('Effects can extend outside these source geometry bounds.');
      const role = roleOf(n, p, bounds, scene.width, scene.height);
      const croppedEdges: StoryboardEdge[] = bounds ? [bounds.x < -.5 && 'left', bounds.x + bounds.width > scene.width + .5 && 'right', bounds.y < -.5 && 'top', bounds.y + bounds.height > scene.height + .5 && 'bottom'].filter(Boolean) as StoryboardEdge[] : [];
      const clearance = bounds ? { left: Math.max(0, bounds.x + bounds.width), right: Math.max(0, scene.width - bounds.x), top: Math.max(0, bounds.y + bounds.height), bottom: Math.max(0, scene.height - bounds.y) } : undefined;
      const entranceCandidates = clearance && role.role !== 'background' && role.role !== 'mask' ? (Object.keys(clearance) as StoryboardEdge[]).map(from => {
        const distance = clearance[from];
        return { from, clearancePx: rounded(distance), canvasStartOffset: { x: from === 'left' ? -distance : from === 'right' ? distance : 0, y: from === 'top' ? -distance : from === 'bottom' ? distance : 0 } };
      }).sort((a, b) => Number(croppedEdges.includes(b.from)) - Number(croppedEdges.includes(a.from)) || a.clearancePx - b.clearancePx).slice(0, 2) : [];
      const text = record(n.text).characters;
      if (id) objects.push({ sourceNodeId: id, logicalObjectId: identities.get(JSON.stringify([scene.sceneId, id])) ?? '', name: String(n.name ?? ''), type: String(n.type ?? ''), ...(parentId ? { parentId } : {}), ...role, ...(typeof text === 'string' ? { text } : {}), visible, bounds: bounds && Object.fromEntries(Object.entries(bounds).map(([k, v]) => [k, rounded(v)])) as Bounds | null, corners, croppedEdges, entranceCandidates, geometryCaveats: caveats, contentSignature: contentSignature(n, p) });
      for (const child of Array.isArray(n.children) ? n.children : []) visit(child, visible, inheritedClip || p.clipsContent === true, id || parentId);
    };
    for (const n of scene.children) visit(n, scene.opacity !== 0 && record(scene.properties).visible !== false);
    return { sceneId: scene.sceneId, name: scene.name, width: scene.width, height: scene.height, backgroundOnly: objects.some(o => o.visible && o.role === 'background') && objects.every(o => !o.visible || ['background', 'container', 'mask'].includes(o.role)), objects };
  });
  const transitions: StoryboardAnalysis['transitions'] = [];
  for (let i = 1; i < scenes.length; i++) {
    const from = scenes[i - 1], to = scenes[i];
    const unique = (objects: StoryboardObject[]) => {
      const counts = new Map<string, number>();
      for (const o of objects) counts.set(o.logicalObjectId, (counts.get(o.logicalObjectId) ?? 0) + 1);
      return new Map(objects.filter(o => o.visible && o.logicalObjectId && counts.get(o.logicalObjectId) === 1).map(o => [o.logicalObjectId, o]));
    };
    const a = unique(from.objects), b = unique(to.objects);
    const persistent = [...a].filter(([id]) => b.has(id)).map(([id, before]) => {
      const after = b.get(id)!, ac = before.bounds, bc = after.bounds;
      return { logicalObjectId: id, name: before.name, fromNodeId: before.sourceNodeId, toNodeId: after.sourceNodeId, pose: samePose(before, after) ? 'unchanged' as const : 'changed' as const, content: before.contentSignature === after.contentSignature ? 'unchanged' as const : 'changed' as const, centerDelta: { x: rounded(ac && bc ? bc.x + bc.width / 2 - ac.x - ac.width / 2 : 0), y: rounded(ac && bc ? bc.y + bc.height / 2 - ac.y - ac.height / 2 : 0) } };
    });
    const textSlotCandidates: StoryboardAnalysis['transitions'][number]['textSlotCandidates'] = [];
    const outgoingTexts = from.objects.filter(o => o.visible && o.role === 'text' && o.bounds && b.get(o.logicalObjectId)?.contentSignature !== o.contentSignature);
    const incomingTexts = to.objects.filter(o => o.visible && o.role === 'text' && o.bounds && a.get(o.logicalObjectId)?.contentSignature !== o.contentSignature);
    for (const outgoing of outgoingTexts) for (const incoming of incomingTexts) {
      if (outgoing.logicalObjectId === incoming.logicalObjectId && outgoing.contentSignature === incoming.contentSignature) continue;
      const ratio = overlap(outgoing.bounds!, incoming.bounds!);
      if (ratio >= .2) textSlotCandidates.push({ outgoing: outgoing.sourceNodeId, incoming: incoming.sourceNodeId, overlapOfSmallerBox: rounded(ratio), reason: outgoing.logicalObjectId === incoming.logicalObjectId ? 'changed-text-same-identity' : 'overlapping-text-regions' });
    }
    const entering = to.objects.filter(o => o.visible && !a.has(o.logicalObjectId)).map(o => o.sourceNodeId);
    const exiting = from.objects.filter(o => o.visible && !b.has(o.logicalObjectId)).map(o => o.sourceNodeId);
    const foreground = persistent.filter(p => !['background', 'container', 'mask'].includes(a.get(p.logicalObjectId)!.role));
    transitions.push({ fromSceneId: from.sceneId, toSceneId: to.sceneId, persistent, entering, exiting, textSlotCandidates, reading: !exiting.length && (from.backgroundOnly || foreground.length > 0 && foreground.every(p => p.pose === 'unchanged' && p.content === 'unchanged')) ? 'progressive-build-candidate' : foreground.length ? 'state-transition-candidate' : 'independent-composition-candidate' });
  }
  return { version: '1', coordinateContract: 'sceneTransform is scene-local. Bounds include rotation/reflection. Entrance offsets are CANVAS vectors before parent conversion, with no shadow/antialias margin; use canonical geometry-aware motion tools. Exact names define registry identity, not visual equivalence. Roles, cropping and text replacements require preview/coverage confirmation.', scenes, transitions, diagnostics };
}
