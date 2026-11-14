import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeStoryboard } from '../src/motion/storyboard-analysis.js';
import { DIRECTING_PRINCIPLES, formatDirectorContext } from '../src/motion/directing-knowledge.js';
import type { Scene, SceneDocument } from '../src/types.js';

const node = (id: string, name: string, x: number, y: number, w = 120, h = 100, extra: Record<string, unknown> = {}) => ({ figmaNodeId: id, name, type: 'RECTANGLE', sceneTransform: [[1, 0, x], [0, 1, y]], properties: { width: w, height: h }, children: [], ...extra });
const scene = (id: string, children: unknown[]): Scene => ({ sceneId: id, figmaNodeId: id, name: id, index: 0, width: 800, height: 600, children });
const doc = (...scenes: Scene[]): SceneDocument => ({ schemaVersion: '1.0.0', assets: [], scenes });
const text = (id: string, content: string, name = id) => node(id, name, 40, 80, 400, 150, { type: 'TEXT', text: { characters: content, fontSize: 64 } });

test('bottom-clipped artwork enters from nearby cropped edge, including rotated/reflected source geometry', () => {
  const result = analyzeStoryboard(doc(scene('a', [node('plate', 'product', 280, 400, 300, 320), node('rot', 'rotated garnish', 400, 560, 100, 80, { sceneTransform: [[0, -1, 400], [-1, 0, 660]] })])));
  const [plate, rotated] = result.scenes[0].objects;
  assert.deepEqual(plate.croppedEdges, ['bottom']);
  assert.equal(plate.entranceCandidates[0].from, 'bottom');
  assert.equal(plate.entranceCandidates[0].clearancePx, 200);
  assert.deepEqual(rotated.bounds, { x: 320, y: 560, width: 80, height: 100 });
  assert.deepEqual(rotated.croppedEdges, ['bottom']);
  assert.equal(rotated.entranceCandidates[0].from, 'bottom');
});

test('progressive storyboard preserves exact-name identity and does not replay existing entrances', () => {
  const background = (id: string) => node(id, 'фон', 0, 0, 800, 600);
  const result = analyzeStoryboard(doc(scene('a', [background('a-bg')]), scene('b', [background('b-bg'), node('b-p', 'Plate', 300, 400)]), scene('c', [background('c-bg'), node('c-p', 'Plate', 300, 400), text('offer', 'Save 25%')])));
  assert.equal(result.scenes[0].backgroundOnly, true);
  assert.equal(result.transitions[0].reading, 'progressive-build-candidate');
  assert.deepEqual(result.transitions[1].entering, ['offer']);
  assert.equal(result.transitions[1].persistent.find(o => o.name === 'Plate')?.pose, 'unchanged');
  assert.equal(result.transitions[1].reading, 'progressive-build-candidate');
});

test('shared object can move and replace its visual content without resetting identity', () => {
  const result = analyzeStoryboard(doc(scene('a', [node('one', 'Phone', 240, 200, 200, 400, { fallbackAssetId: 'screen-one' })]), scene('b', [node('two', 'Phone', 500, 150, 220, 440, { fallbackAssetId: 'screen-two' })])));
  const edge = result.transitions[0];
  assert.equal(edge.reading, 'state-transition-candidate');
  assert.equal(edge.persistent[0].pose, 'changed');
  assert.equal(edge.persistent[0].content, 'changed');
  assert.deepEqual(edge.entering, []);
  assert.deepEqual(edge.persistent[0].centerDelta, { x: 270, y: -30 });
});

test('overlapping replacement text is a candidate, stable legal and unrelated text are not', () => {
  const legal = (id: string) => node(id, 'legal', 40, 550, 600, 25, { type: 'TEXT', text: { characters: 'Terms' } });
  const result = analyzeStoryboard(doc(scene('a', [text('old', 'Old offer'), legal('legal-a')]), scene('b', [text('new', 'New offer'), legal('legal-b'), node('other', 'Other message', 500, 450, 100, 50, { type: 'TEXT', text: { characters: 'App' } })])));
  assert.deepEqual(result.transitions[0].textSlotCandidates, [{ outgoing: 'old', incoming: 'new', overlapOfSmallerBox: 1, reason: 'overlapping-text-regions' }]);
  const changed = analyzeStoryboard(doc(scene('a', [text('a-text', 'Old', 'Title')]), scene('b', [text('b-text', 'New', 'Title')])));
  assert.equal(changed.transitions[0].textSlotCandidates[0].reason, 'changed-text-same-identity');
});

test('export IDs and clipping owner metadata do not turn persistent artwork into new content; typography alone is not replacement text', () => {
  const artwork = (id: string) => node(id, 'Hero', 200, 300, 200, 250, { svgAssetId: `svg_${id}`, properties: { width: 200, height: 250, fills: [{ type: 'IMAGE', imageHash: 'same-original', assetId: 'image_same', clipping: { ownerNodeId: id, geometry: 'owner-node' } }] } });
  const result = analyzeStoryboard(doc(scene('a', [artwork('a-image'), text('a-text', 'Same message', 'Title')]), scene('b', [artwork('b-image'), { ...text('b-text', 'Same message', 'Title'), text: { characters: 'Same message', fontSize: 68, fontWeight: 700 } }])));
  assert.equal(result.transitions[0].persistent.find(p => p.name === 'Hero')?.content, 'unchanged');
  assert.deepEqual(result.transitions[0].textSlotCandidates, []);
});

test('ambiguous names do not produce invented persistent correspondence and case is significant', () => {
  const result = analyzeStoryboard(doc(scene('a', [node('a1', 'Box', 0, 0), node('a2', 'Box', 200, 0), node('a3', 'TITLE', 0, 300)]), scene('b', [node('b1', 'Box', 0, 0), node('b2', 'Title', 0, 300)])));
  assert.equal(result.transitions[0].persistent.length, 0);
  assert.ok(result.diagnostics.some(d => d.includes('Box')));
});

test('hidden ancestors and source masks do not create visible actor or text replacement evidence', () => {
  const group = node('group', 'Group', 0, 0, 800, 600, { type: 'GROUP', properties: { width: 800, height: 600, visible: false }, children: [text('hidden', 'Hidden headline')] });
  const result = analyzeStoryboard(doc(scene('a', [group, node('mask', 'mask', 0, 0, 800, 600, { properties: { width: 800, height: 600, isMask: true } })])));
  assert.equal(result.scenes[0].objects.find(o => o.sourceNodeId === 'hidden')?.visible, false);
  assert.deepEqual(formatDirectorContext(result).scenes[0].objects, []);
});

test('provider projection reports omissions and keeps source uncertainty plus continuous inertia guidance', () => {
  const result = analyzeStoryboard(doc(scene('a', Array.from({ length: 180 }, (_, i) => node(String(i), `Object ${i}`, i, 300)))));
  const projected = formatDirectorContext(result);
  assert.equal(projected.scenes[0].objects.length, 160);
  assert.equal(projected.scenes[0].omittedObjects, 20);
  assert.match(projected.evidenceContract, /CANVAS/);
  assert.ok(DIRECTING_PRINCIPLES.find(p => p.id === 'continuous-arrival')?.instruction.includes('inertiaBlend'));
  assert.ok(!JSON.stringify(projected).includes('contentSignature'));
});
