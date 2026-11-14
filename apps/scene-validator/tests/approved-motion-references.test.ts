import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { LoadedProject } from '../src/types.js';
import { selectApprovedMotionReferences } from '../src/motion/approved-references.js';

const project = (copy: string, w = 1920, h = 1080) => ({ inspection: { document: { schemaVersion: '1', assets: [], scenes: [{ sceneId: 's', figmaNodeId: 's', name: 'Unrelated project name', index: 0, width: w, height: h, children: [{ name: 'Text', text: { characters: copy }, children: [] }] }] } } } as unknown as LoadedProject);
const ref = (id: string, family = id, width = 1920, height = 1080) => ({ id, originalSha256: 'a'.repeat(64), originalName: 'read-only.mp4', durationSeconds: 10, width, height, family, matchTerms: ['телефон'], scope: { brands: ['Example'] }, reviewStatus: 'dense-event-reviewed', observations: [0,1,2].map(n => ({ id: `${id}/${n}`, timecode: [n,n+1], observation: 'Observed positional continuity', evidencePath: '/nonexistent/evidence-is-a-pin-not-a-media-read.jpg' })), patterns: [0,1,2].map(n => ({ id: `p${n}`, observationId: `${id}/${n}`, instruction: 'Preserve shared pose continuity.', tags: ['phone'], caution: 'Reference only.' })) });
async function withCorpus(records: unknown[], run: (corpusPath: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'approved-motion-test-')); const file = path.join(dir, 'evidence.json');
  try { await writeFile(file, JSON.stringify({ version: 'approved-motion-references/1', records })); await run(file); } finally { await rm(dir, { recursive: true, force: true }); }
}
test('retrieves from native source text, includes provenance, does not read referenced media', async () => withCorpus([ref('phone')], async corpusPath => {
  const r = await selectApprovedMotionReferences({project:project('Возьмите телефон'), request:'Анимируй', corpusPath});
  assert.equal(r.status,'selected'); assert.equal(r.pins.length,3); assert.equal(r.pins[0].sourceSha256,'a'.repeat(64)); assert.match(r.summary,/10s/); assert.match(r.selectionReason,/source=\[телефон\]/); assert.match(r.corpusSha256!,/^[a-f0-9]{64}$/);
}));
test('selects nearest aspect within family; source content beats weaker request-only matches', async () => withCorpus([ref('portrait','phone',1080,1920),ref('landscape','phone')], async corpusPath => {
  const r = await selectApprovedMotionReferences({project:project('телефон',1080,1920), request:'', corpusPath}); assert.ok(r.pins.every(p => p.id.startsWith('portrait/')));
}));
test('unrelated content receives no example merely for matching dimensions', async () => withCorpus([ref('phone')], async corpusPath => {
  const r = await selectApprovedMotionReferences({project:project('Анонс театра'), request:'Тихо и плавно', corpusPath}); assert.equal(r.status,'no-match'); assert.equal(r.summary,''); assert.deepEqual(r.pins,[]);
}));
test('matches user-requested scenario without requiring opaque layer names to expose it', async () => withCorpus([ref('phone')], async corpusPath => {
  const r = await selectApprovedMotionReferences({project:project('Layer42'), request:'Телефон появляется', corpusPath}); assert.equal(r.status,'selected'); assert.match(r.selectionReason,/request=\[телефон\]/);
}));
test('output is bounded to three families, five patterns, and4096 summary bytes', async () => withCorpus(Array.from({length:10},(_,i)=>ref(`phone${i}`)), async corpusPath => {
  const r = await selectApprovedMotionReferences({project:project('телефон'),request:'',corpusPath}); assert.ok(r.pins.length<=5); assert.ok(new Set(r.pins.map(p=>p.id.split('/')[0])).size<=3); assert.ok(Buffer.byteLength(r.summary)<=4096);
}));
test('missing/invalid corpus is nonblocking and does not echo raw malformed content', async () => {
  const r = await selectApprovedMotionReferences({project:project('телефон'),request:'',corpusPath:'/nonexistent/no-motion-reference-corpus.json'}); assert.equal(r.status,'unavailable'); assert.equal(r.summary,'');
  await withCorpus([{ secret:'must-not-echo' }], async corpusPath => { const r=await selectApprovedMotionReferences({project:project('телефон'),request:'',corpusPath}); assert.equal(r.status,'unavailable'); assert.doesNotMatch(JSON.stringify(r),/must-not-echo/); });
});
test('invalid event interval cannot produce a reference pin', async () => {
  const record=ref('phone'); record.observations.forEach(o=>o.timecode=[11,12]); await withCorpus([record], async corpusPath=>{const r=await selectApprovedMotionReferences({project:project('телефон'),request:'',corpusPath});assert.equal(r.status,'no-match');assert.deepEqual(r.pins,[]);});
});
test('a related source contributes its phone transition rather than unrelated basket opening', async () => {
  const primary=ref('primary'); primary.matchTerms=['телефон','категори'];
  const secondary=ref('secondary'); secondary.patterns[0].tags=['basket']; secondary.patterns[1].tags=['phone','replacement'];
  await withCorpus([primary,secondary],async corpusPath=>{const r=await selectApprovedMotionReferences({project:project('телефон категории'),request:'',corpusPath});assert.ok(r.pins.some(p=>p.id==='secondary/1'));assert.ok(!r.pins.some(p=>p.id==='secondary/0'));});
});
test('pins at most two derived images with image SHA distinct from original SHA; rejects mismatched source', async () => {
  const image={relativePath:'evidence/phone/entry.jpg',sha256:'b'.repeat(64),sourceSha256:'a'.repeat(64),timecode:[0,1],caption:'Observed entry sequence',width:1200,height:600};
  await withCorpus([{...ref('phone'),imageEvidence:[image,{...image,relativePath:'evidence/phone/transition.jpg'},{...image,relativePath:'evidence/phone/extra.jpg'}]}],async corpusPath=>{const r=await selectApprovedMotionReferences({project:project('телефон'),request:'',corpusPath});assert.equal(r.imageEvidence.length,2);assert.equal(r.imageEvidence[0].sha256,'b'.repeat(64));assert.equal(r.imageEvidence[0].sourceSha256,'a'.repeat(64));});
  await withCorpus([{...ref('phone'),imageEvidence:[{...image,sourceSha256:'c'.repeat(64)}]}],async corpusPath=>{const r=await selectApprovedMotionReferences({project:project('телефон'),request:'',corpusPath});assert.equal(r.status,'selected');assert.deepEqual(r.imageEvidence,[]);});
});
test('traversing image path invalidates corpus rather than publishing an unsafe evidence locator',async()=>{
  await withCorpus([{...ref('phone'),imageEvidence:[{relativePath:'evidence/../../private.jpg',sha256:'b'.repeat(64),sourceSha256:'a'.repeat(64),timecode:[0,1],caption:'x',width:10,height:10}]}],async corpusPath=>{const r=await selectApprovedMotionReferences({project:project('телефон'),request:'',corpusPath});assert.equal(r.status,'unavailable');assert.deepEqual(r.imageEvidence,[]);});
});
