import type { StoryboardAnalysis } from './storyboard-analysis.js';

/** Small always-present directing core. Source-dependent facts belong in the analysis,
 * not in a growing catalogue of project-specific numeric presets or rejection gates. */
export const DIRECTING_PRINCIPLES = [
  { id: 'sequence-before-effects', instruction: 'Read all storyboard previews as a sequence first. Decide whether each change adds to one composition, transforms persistent objects, replaces a message, or begins a new shot. A blank/background-only reference is often a starting state, not an equal-duration slide. Give the main proposition a readable hold. When a close accepted reference is supplied, use its beat rhythm and duration as a starting point; extend holds for a clear reading or task reason, not equal scene lengths.' },
  { id: 'identity-and-pose', instruction: 'Preserve shared logical objects and stable backgrounds through reference changes; unchanged objects do not replay entrances. Transform changed reference poses with the existing object-state transition tools. Check content changes as well as bounds. Ambiguous exact names and artwork that merely look similar require inspection, never guessed identity. When shortening holds or moving a beat, retime the whole intended ensemble and attached effects together; a hero moving earlier must not leave its products/badges on a forgotten schedule.' },
  { id: 'motivated-entry', instruction: 'Choose motion from the visible composition: a bottom-cropped product normally enters from below; otherwise compare nearby edges, destination and established flow. Geometry candidates are advisory, not commands. Avoid needlessly traversing the entire frame or text region. Actual alpha/glyph extents, clips and effects can differ from source rectangles. Distances come from this object and canvas, never a reused pixel preset.' },
  { id: 'direction-and-focus', instruction: 'Create one coherent flow per beat; support established direction across shared-object transitions. Countermovement needs a visual purpose. Stage emphasis: main message/product first, supporting offer/decor in coordinated overlap, then a stable reading interval. Do not wait for every decorative tail before the next meaningful action.' },
  { id: 'continuous-arrival', instruction: 'Treat approach and settling as one whole-pose trajectory. Preserve the existing inertiaBlend/inertiaHandoff engine. For a new rest launch with requested inertia, create the movement plus inertialOvershoot then tuneInertia approach=continuous; do not stop an ease-out and invent velocity from lookback. For ongoing movement preserve actual incoming velocity instead of restarting from rest; honor explicitly fixed curves with preserve. Inspect X/Y, rotation, scale and rendered corner velocities together. Frequency, damping, approach duration, movement distance and visible peak/residual must be chosen together. Never hide an abrupt tail by clipping it at a scene boundary.' },
  { id: 'short-readable-text-handoff', instruction: 'For successive messages sharing a text region, outgoing glyphs must clear before incoming glyphs occupy it. Prefer the successor one output frame after actual clearance, without waiting for unrelated motion to settle. This is a default preference, not a global serial-animation rule. Also time each line reveal against moving foreground/KV silhouettes: already readable glyphs must not become covered while the object crosses their region. Inspect actual ink and swept silhouettes, not only old/new text boxes. Reveal an already clear first line promptly while later lines wait for their own clearance; do not postpone the whole message until every foreground movement ends. Use the existing text-handoff tools/coverage where available; box overlap only identifies candidates. Preserve source line breaks, typography and final placement. Move words/lines as semantic groups rather than random letter noise.' },
  { id: 'secondary-motion-has-a-role', instruction: 'Wiggle is optional ambient motion, not inertia. Use it subtly on appropriate decor with independent phase; keep the main reading area, logos, legal and scannable codes stable once arrived unless the brief asks otherwise. Do not let wiggle dominate the intended settling response or reset phase on scene boundaries.' },
  { id: 'validate-time-not-just-stills', instruction: 'Review the actual entire clip at intended speed and viewing scale, with dense frames around entrances, text replacements and pose joins. Compare visible travel, velocity/corner discontinuities, text collision/clearance, reading time and content persistence. A static contact sheet or a valid schema cannot establish smoothness or artistic quality. Make targeted corrections with concrete frame evidence, preserving successful beats.' },
] as const;

export const DIRECTING_SOURCES = [
  { url: 'https://developer.apple.com/videos/play/wwdc2023/10158/', use: 'Position/velocity continuity, inherited velocity, springs settling gradually. UI duration presets are not advertising defaults.' },
  { url: 'https://help.figma.com/hc/en-us/articles/41237878633111-Motion-design-fundamentals-Transformation', use: 'Motion communicates origin/destination and direction; fading can be appropriate when spatial origin is irrelevant.' },
  { url: 'https://m1.material.io/motion/choreography.html', use: 'Maintain coherent flow and hierarchy rather than moving every object independently.' },
  { url: 'https://arxiv.org/abs/2502.13372', use: 'Frame-level spatial/temporal predicates with concrete failed-frame feedback; correctness is not aesthetic certification.' },
  { url: 'https://arxiv.org/abs/2611.10592', use: 'Prompt-specific tests accept multiple valid trajectories; approved/rejected examples calibrate restrictive checks.' },
] as const;

/** Bounded provider projection; the full deterministic analysis remains an audit artifact.
 * It supplies advice only and does not add publication gates or alter engine defaults. */
export function formatDirectorContext(analysis: StoryboardAnalysis) {
  const limit = 160;
  return {
    version: '1',
    principles: DIRECTING_PRINCIPLES,
    evidenceContract: analysis.coordinateContract,
    scenes: analysis.scenes.map(s => {
      const ranked = s.objects.filter(o => o.visible && o.role !== 'mask').sort((a, b) => Number(['artwork', 'container'].includes(a.role)) - Number(['artwork', 'container'].includes(b.role)));
      return { sceneId: s.sceneId, name: s.name, canvas: [s.width, s.height], backgroundOnlyCandidate: s.backgroundOnly, totalObjects: s.objects.length, omittedObjects: Math.max(0, ranked.length - limit), objects: ranked.slice(0, limit).map(o => ({ id: o.sourceNodeId, logicalId: o.logicalObjectId, name: o.name, parentId: o.parentId, roleCandidate: o.role, roleEvidence: o.roleEvidence, ...(o.text ? { text: o.text.length <= 500 ? o.text : o.text.slice(0, 500) + '… [source text truncated; inspect object]' } : {}), bounds: o.bounds, croppedEdges: o.croppedEdges, entranceCandidates: o.entranceCandidates, ...(o.geometryCaveats.length > 1 ? { caveats: o.geometryCaveats.slice(1) } : {}) })) };
    }),
    transitions: analysis.transitions.map(t => ({ ...t, persistent: t.persistent.slice(0, limit), entering: t.entering.slice(0, limit), exiting: t.exiting.slice(0, limit), textSlotCandidates: t.textSlotCandidates.slice(0, 80), omitted: { persistent: Math.max(0, t.persistent.length - limit), entering: Math.max(0, t.entering.length - limit), exiting: Math.max(0, t.exiting.length - limit), textSlots: Math.max(0, t.textSlotCandidates.length - 80) } })),
    diagnostics: analysis.diagnostics.slice(0, 30),
    omittedDiagnostics: Math.max(0, analysis.diagnostics.length - 30),
  };
}
