import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { LoadedProject, SceneDocument } from '../types.js';

const observationSchema = z.object({ id: z.string(), timecode: z.tuple([z.number().nonnegative(), z.number().nonnegative()]), observation: z.string(), evidencePath: z.string() });
const patternSchema = z.object({ id: z.string(), observationId: z.string(), instruction: z.string(), tags: z.array(z.string()), caution: z.string() });
const imageEvidenceSchema = z.object({ relativePath: z.string().regex(/^evidence\/[a-zA-Z0-9._/-]+$/).refine(s => !s.split('/').includes('..')), sha256: z.string().regex(/^[a-f0-9]{64}$/), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), timecode: z.tuple([z.number().nonnegative(), z.number().nonnegative()]), caption: z.string().max(800), width: z.number().positive(), height: z.number().positive() });
const recordSchema = z.object({ id: z.string(), originalSha256: z.string().regex(/^[a-f0-9]{64}$/), originalName: z.string(), durationSeconds: z.number().positive(), width: z.number().positive(), height: z.number().positive(), family: z.string(), matchTerms: z.array(z.string()), scope: z.object({ brands: z.array(z.string()) }), reviewStatus: z.enum(['overview-reviewed', 'dense-event-reviewed']), observations: z.array(observationSchema), patterns: z.array(patternSchema), imageEvidence: z.array(imageEvidenceSchema).max(8).default([]) });
const corpusSchema = z.object({ version: z.literal('approved-motion-references/1'), records: z.array(recordSchema).max(1000) });
type Reference = z.infer<typeof recordSchema>;
export interface ApprovedMotionReferenceContext {
  version: 'approved-motion-context/1';
  status: 'selected' | 'unavailable' | 'no-match';
  summary: string;
  pins: { id: string; sourceSha256: string; timecode: [number, number]; evidencePath: string; observation: string }[];
  selectionReason: string;
  diagnostics: string[];
  corpusSha256?: string;
  imageEvidence: (z.infer<typeof imageEvidenceSchema> & { referenceId: string })[];
}
export const DEFAULT_APPROVED_MOTION_CORPUS_PATH = fileURLToPath(new URL('../../../../data/motion-references/approved-work-2026-11-12/evidence-index.json', import.meta.url));
const normalize = (v: string) => v.toLocaleLowerCase().replace(/ё/g, 'е').normalize('NFKC');

/** Names and native text only: never old motion plans, project paths, or asset bytes. */
function sourceWords(document: SceneDocument): string {
  const parts: string[] = []; let visited = 0;
  const walk = (v: unknown) => {
    if (++visited > 50000 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const n of v) walk(n); return; }
    for (const [key, value] of Object.entries(v)) {
      if ((key === 'name' || key === 'characters') && typeof value === 'string') parts.push(value.slice(0, 4000));
      else if (key === 'children' || key === 'text') walk(value);
    }
  };
  walk(document.scenes);
  return normalize(parts.join(' ').slice(0, 100000));
}

/** Local curated retrieval, once per run. No embeddings/provider/media I/O is required
 * for this small corpus. Missing corpus is a diagnostic, never a generation veto. */
export async function selectApprovedMotionReferences({ project, request, corpusPath = DEFAULT_APPROVED_MOTION_CORPUS_PATH }: { project: LoadedProject; request: string; corpusPath?: string }): Promise<ApprovedMotionReferenceContext> {
  const empty = (status: ApprovedMotionReferenceContext['status'], diagnostics: string[], reason: string): ApprovedMotionReferenceContext => ({ version: 'approved-motion-context/1', status, summary: '', pins: [], imageEvidence: [], selectionReason: reason, diagnostics });
  let bytes: Buffer; let corpus: z.infer<typeof corpusSchema>;
  try {
    bytes = await readFile(corpusPath);
    if (bytes.byteLength > 4_000_000) return empty('unavailable', ['Approved motion corpus exceeds local 4MB limit.'], 'No reference context loaded.');
    corpus = corpusSchema.parse(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    return empty('unavailable', [(error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Approved motion corpus is not installed.' : 'Approved motion corpus could not be read or validated.'], 'Generation may continue with source analysis and core directing principles.');
  }
  const source = sourceWords(project.inspection.document), query = normalize(request.slice(0, 8000));
  const ratios = project.inspection.document.scenes.map(s => s.width / s.height).filter(n => Number.isFinite(n) && n > 0);
  const ranked = corpus.records.map(ref => {
    const sourceHits = ref.matchTerms.filter(t => source.includes(normalize(t)));
    const queryHits = ref.matchTerms.filter(t => query.includes(normalize(t)) && !sourceHits.includes(t));
    const format = ratios.length ? Math.max(...ratios.map(r => Math.exp(-Math.abs(Math.log(r / (ref.width / ref.height)))))) : 0;
    const score = sourceHits.length * 4 + queryHits.length * 2 + format * 2 + (ref.reviewStatus === 'dense-event-reviewed' ? .5 : 0);
    return { ref, sourceHits, queryHits, score };
  }).filter(r => r.sourceHits.length + r.queryHits.length > 0 && r.ref.patterns.length > 0).sort((a,b) => b.score - a.score || a.ref.id.localeCompare(b.ref.id));
  if (!ranked.length) return { ...empty('no-match', [], 'No scenario/content match. Aspect ratio alone never selects an unrelated brand example.'), corpusSha256: createHash('sha256').update(bytes).digest('hex') };
  // One best-format member per resize family avoids spending context on duplicates.
  const families = new Set<string>();
  const selected = ranked.filter(r => { if (families.has(r.ref.family) || r.score < ranked[0].score * .45) return false; families.add(r.ref.family); return true; }).slice(0, 3);
  const header = 'Accepted-work motion references (advisory; current brief/source artwork win). Read timestamps as examples, not mandatory duration/amplitude presets. Preserve source brand, typography and assets. Ordered frames were reviewed; original curves and real-speed playback were not verified. Never copy noted text ghosting.\n';
  let summary = header;
  const pins: ApprovedMotionReferenceContext['pins'] = [];
  const candidates: { ref: Reference; pattern: z.infer<typeof patternSchema> }[] = [];
  const facets: Record<string, RegExp> = { phone: /телефон|phone|смартфон/u, basket: /корзин|basket/u, food: /тарел|plate|еда|food|напит|кофе/u, resize: /ресайз|resize|адаптац/u };
  const patternRelevance = (pattern: z.infer<typeof patternSchema>) => pattern.tags.reduce((score, tag) => score + (facets[tag]?.test(source + ' ' + query) ? 4 : 0), 0);
  selected.forEach((r, i) => {
    // Related campaigns contribute a scenario-relevant pattern, not their first
    // (possibly unrelated) opening such as a basket when this source has a phone.
    const patterns = i === 0 ? r.ref.patterns : [...r.ref.patterns].sort((a,b) => patternRelevance(b) - patternRelevance(a));
    patterns.slice(0, i === 0 ? 3 : 1).forEach(pattern => candidates.push({ ref: r.ref, pattern }));
  });
  for (const {ref, pattern} of candidates.slice(0,5)) {
    const evidence = ref.observations.find(o => o.id === pattern.observationId);
    if (!evidence || evidence.timecode[1] < evidence.timecode[0] || evidence.timecode[1] > ref.durationSeconds + .1) continue;
    const block = `\n${ref.id}/${pattern.id} | ${ref.scope.brands.join('/')} | ${ref.width}x${ref.height}, full clip ${ref.durationSeconds}s, event ${evidence.timecode.join('–')}s, ${ref.reviewStatus}: ${pattern.instruction}\nLimit: ${pattern.caution}\n`;
    if (Buffer.byteLength(summary + block) > 4096) continue;
    summary += block;
    pins.push({ id: evidence.id, sourceSha256: ref.originalSha256, timecode: evidence.timecode, evidencePath: evidence.evidencePath, observation: evidence.observation });
  }
  if (!pins.length) return empty('no-match', ['Matching records have no usable bounded evidence patterns.'], 'Generation continues without approved-reference context.');
  // Planner may attach these once after containment and exact image-SHA checks.
  // Direct executor receives text/pins only; the selector itself reads no media.
  const imageEvidence = selected.flatMap(({ref}) => ref.imageEvidence.filter(i => i.sourceSha256 === ref.originalSha256 && i.timecode[1] >= i.timecode[0] && i.timecode[1] <= ref.durationSeconds + .1).map(i => ({...i, referenceId: ref.id}))).slice(0,2);
  return { version: 'approved-motion-context/1', status: 'selected', summary, pins, imageEvidence, corpusSha256: createHash('sha256').update(bytes).digest('hex'), selectionReason: selected.map(r => `${r.ref.id}: source=[${r.sourceHits.join(',')}], request=[${r.queryHits.join(',')}], format+review tie-break, score=${r.score.toFixed(2)}`).join('; '), diagnostics: ['Local curated observations only; original SHA values are provenance from ingestion, not a fresh original-file verification. No media or old animation plans were read by this selector.'] };
}
