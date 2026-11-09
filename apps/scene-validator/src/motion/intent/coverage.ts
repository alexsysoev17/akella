import {locateSource} from "./provenance.js";
import {temporalCues,hasActionSequence,type TemporalEvidence} from "./temporal-evidence.js";
import {resolveRuleTargets} from "../rules.js";
import { buildRegistry } from "../registry.js";
import type { LoadedProject } from "../../types.js";
import type {
  IntentPlan,
  IntentRequirement,
  IntentTechnique,
} from "./schema.js";
import { defaultMotion } from "../context.js";
import { objectsIn } from "../context.js";
import {
  equivalentObjectName,
  objectMentionRanges,
} from "../object-aliases.js";
export interface CoverageIssue {
  code: string;
  sourceText: string;
  requirementIds: string[];
  expected?: unknown;
  actual?: unknown;
}
export class SemanticCoverageError extends Error {
  constructor(public report: CoverageReport) {
    super("SEMANTIC_COVERAGE: " + JSON.stringify(report.issues));
  }
}
export interface CoverageReport {
  temporalRelations?:TemporalEvidence[];
  status: "PASSED" | "SUSPICIOUS";
  issues: CoverageIssue[];
  clauses: {
    start: number;
    end: number;
    sourceText: string;
    sceneId: string | null;
    requirementIds: string[];
    explicitTechniques: IntentTechnique[];
    inheritedFrom: string | null;
  }[];
}
/** Sanity-check explicit, locally bound instructions. LLM still interprets natural language. */
function explicitTechniques(text: string): IntentTechnique[] {
  const techniques: IntentTechnique[] = [];
  if (/(?:снизу|slide\s*up)/i.test(text)) techniques.push("slideUp");
  if (/(?:сверху|slide\s*down)/i.test(text)) techniques.push("slideDown");
  if (/(?:trim\s*paths?|прорисов|прорисуй|рисуется|рисуются)/i.test(text))
    techniques.push("trimPath");
  if (/fade\s*out|(?:ф[еэ]йд|\bfade\b).*(?:исчез|пропад|уход|уйд|уходит|уходят)|(?:исчез|пропад|уход|уйд|уходит|уходят).*(?:ф[еэ]йд|\bfade\b)/i.test(text))
    techniques.push("fadeOut");
  else if (/\bfade(?:\s*in)?\b|fadeIn|ф[еэ]йд/i.test(text))
    techniques.push("fadeIn");
  if (/wiggle/i.test(text)) techniques.push("wiggle");
  if (/spring|пружин/i.test(text)) techniques.push("spring");
  if (/custom\s*(?:curve|easing)|авторск.*крив/i.test(text))
    techniques.push("customCurve");
  if (
    /overshoot|инерц|затуха.*колеб|колеб.*затух|колебани|колебания|с\s+колеб|после.*останов.*покач/i.test(
      text,
    )
  )
    techniques.push("inertialOvershoot");
  return techniques;
}
const inheritance = /аналогично|так\s+же|как\s+предыдущ|как\s+перв/i;
const ordinals: Record<string, number> = {
  первой: 1,
  первую: 1,
  первом: 1,
  второй: 2,
  вторую: 2,
  третьей: 3,
  третью: 3,
  четвертой: 4,
  четвёртой: 4,
  пятой: 5,
};
export function inspectSemanticCoverage(
  project: LoadedProject,
  request: string,
  plan: IntentPlan,
  fps = defaultMotion(project).settings.fps,
): CoverageReport {
  const report: CoverageReport = { status: "PASSED", issues: [], clauses: [] };
  const scenes = project.inspection.document.scenes;
  const roots = new Set(scenes.map((s) => s.figmaNodeId));
  const registry = buildRegistry(project.inspection.document, project.inspection.fingerprint);
  const editCovers=(r:IntentRequirement,id:string)=>{if(!r.semanticEdit||r.unresolvedReason)return false;try{const edit=r.semanticEdit;const selected=edit.targets.length?resolveRuleTargets(project,edit.targets):edit.scope.logicalObjectIds;return registry.objects.some(o=>(edit.scope.selector==="project"||selected.includes(o.logicalObjectId))&&o.sourceInstances.some(i=>i.sceneId+"/"+i.sourceNodeId===id)&&(!edit.scope.sceneId||edit.scope.sceneId===id.split("/")[0]));}catch{return false;}};
  const coversTarget = (r: IntentRequirement, id: string) => editCovers(r,id)|| r.sceneId + "/" + r.target.sourceNodeId === id ||
    (r.targetScope === "logicalObject" && !r.unresolvedReason && registry.objects.some(o => o.logicalObjectId === r.target.logicalObjectId && o.sourceInstances.some(i => i.sceneId + "/" + i.sourceNodeId === id)));
  const objects = scenes
    .flatMap(objectsIn)
    .filter((o) => o.parentId && !roots.has(o.targetId));
  const sourceClauses = new Map(
    (plan.sourceClauses ?? []).map((c) => [c.clauseId, c]),
  );
  const belongs = (r: IntentRequirement, start: number, end: number) => {
    let clause: {start:number;end:number;text:string}|undefined = r.sourceClauseId
      ? sourceClauses.get(r.sourceClauseId)
      : undefined;
    if(!clause){try{clause=locateSource(request,r.sourceText.trim());}catch{/* Ambiguous legacy provenance cannot authorize a guessed span. */}}
    const ref = r.timing.reference?.sourceClauseId
      ? sourceClauses.get(r.timing.reference.sourceClauseId)
      : undefined;
    return (
      !clause ||
      (clause.start < end && clause.end > start) ||
      Boolean(ref && ref.start < end && ref.end > start)
    );
  };
  const boundaries = new Set<number>([0, request.length]);
  for (const m of request.matchAll(
    /(?:[!?;\n]+|(?<!\d)[.,]|[.,](?!\d)|(?=сцен[аыуе]?\s*\d+\s*(?:нач|на\s|start)))/gi,
  )) {
    boundaries.add(m.index!);
    if (m[0]) boundaries.add(m.index! + m[0].length);
  }
  // Use verbatim requirement spans only as candidate boundaries, never as proof of
  // coverage. This keeps postfix targets ("trim paths лента 2") with their verb.
  for (const r of plan.requirements) {
    if (r.kind === "sceneTiming" || r.sourceText.length === request.length)
      continue;
    if (
      !explicitTechniques(r.sourceText).length &&
      !inheritance.test(r.sourceText)
    )
      continue;
    let at = request.indexOf(r.sourceText);
    while (at >= 0) {
      boundaries.add(at);
      boundaries.add(at + r.sourceText.length);
      at = request.indexOf(r.sourceText, at + r.sourceText.length);
    }
  }
  // Split an unpunctuated change of object only after an actual technique phrase.
  const mentions = objects.flatMap((o) =>
    objectMentionRanges(o.name, request).map((range) => ({
      ...range,
      object: o,
    })),
  );
  const initial = [...boundaries].sort((a, b) => a - b);
  for (let i = 0; i < initial.length - 1; i++) {
    let last = initial[i],
      seenObject = false;
    for (const mention of mentions
      .filter((m) => m.start >= initial[i] && m.start < initial[i + 1])
      .sort((a, b) => a.start - b.start)) {
      if (
        seenObject &&
        !plan.requirements.some(
          (r) =>
            r.target.sourceNodeId === mention.object.targetId &&
            r.sceneId === mention.object.sceneId &&
            r.sourceText.length < request.length &&
            request.slice(initial[i], initial[i + 1]).trim() ===
              r.sourceText.trim(),
        ) &&
        explicitTechniques(request.slice(last, mention.start)).length
      ) {
        boundaries.add(mention.start);
        last = mention.start;
      }
      seenObject = true;
      last = Math.max(last, mention.end);
    }
  }
  const spans = [...boundaries].sort((a, b) => a - b);
  let sceneId: string | null = null,
    activeIds: string[] = [],
    pendingIds: string[] = [],
    previous: IntentRequirement | undefined,
    pendingAfter: string | undefined;
  let pendingCue:TemporalEvidence["sourceSpan"]|undefined;
  let activeClock:number|undefined;
  const issue = (
    code: string,
    text: string,
    rs: IntentRequirement[],
    expected?: unknown,
    actual?: unknown,
  ) =>
    report.issues.push({
      code,
      sourceText: text,
      requirementIds: rs.map((r) => r.requirementId),
      expected,
      actual,
    });
  const effective = (r: IntentRequirement): Set<IntentTechnique> => {
    const result = new Set(r.techniques);
    const seen = new Set<string>();
    let current = r;
    while (
      current.inheritFromRequirementId &&
      !seen.has(current.requirementId)
    ) {
      seen.add(current.requirementId);
      const parent = plan.requirements.find(
        (p) => p.requirementId === current.inheritFromRequirementId,
      );
      if (!parent) break;
      parent.techniques.forEach((t) => result.add(t));
      current = parent;
    }
    return result;
  };
  for (let i = 0; i < spans.length - 1; i++) {
    const start = spans[i],
      end = spans[i + 1],
      text = request.slice(start, end);
    if (!text.trim() || /^[.,!?;\s]+$/.test(text)) continue;
    const header = text.match(/(?:сцен[аыуе]?\s*(\d+)|(\d+)\s*сцен[аыуе]?)/i);
    if (header && !/(?:как|состояни|положени|state|position).*(?:сцен|scene)/iu.test(text.slice(0,header.index!+header[0].length))) {
      sceneId =
        scenes.find((s) => s.index === Number(header[1] ?? header[2]) - 1)
          ?.sceneId ?? null;
      activeIds = [];
      pendingIds = [];
      previous = undefined;
      pendingAfter = undefined;
      activeClock=undefined;
    }
    if (header && /начина|starts|\bна\s/i.test(text)) {
      const time = text.match(
        /(?:на|at)\s*(\d+(?:[.,]\d+)?|первой|первую|второй|вторую|третьей|третью|четв[её]ртой|пятой)\s*(?:сек|second|кадр|frames?)/i,
      );
      if (time && sceneId) {
        const amount =
          ordinals[time[1].toLowerCase()] ?? Number(time[1].replace(",", "."));
        const seconds = /кадр|frame/i.test(time[0]) ? amount / fps : amount;
        const rs = plan.requirements.filter(
          (r) => r.kind === "sceneTiming" && r.sceneId === sceneId,
        );
        if (!rs.some((r) => r.timing.startSeconds === seconds))
          issue("MISSING_SCENE_TIMING", text, rs, {
            sceneId,
            startSeconds: seconds,
          });
      }
    }
    const inferredScenes = new Set(
      plan.requirements
        .filter(
          (r) =>
            r.kind !== "sceneTiming" &&
            r.sceneId &&
            r.sourceText.includes(text.trim()),
        )
        .map((r) => r.sceneId!),
    );
    const here = mentions.filter(
      (m) =>
        m.start >= start &&
        m.start < end &&
        m.end <= end &&
        (sceneId
          ? m.object.sceneId === sceneId
          : !inferredScenes.size || inferredScenes.has(m.object.sceneId)),
    );
    const maximal = here.filter(
      (m) =>
        !here.some(
          (other) =>
            other.start <= m.start &&
            other.end >= m.end &&
            (other.start < m.start || other.end > m.end),
        ),
    );
    const ids = [
      ...new Set(
        maximal.map((m) => m.object.sceneId + "/" + m.object.targetId),
      ),
    ];
    const techs = explicitTechniques(text),
      inherit = inheritance.test(text);
    const staticLifetime = /статич|неподвиж|motionless|\bstatic\b|\bkeep\s+still\b/iu.test(text) &&
      /(?:весь|всё|все|цел(?:ый|ое)|whole|entire).{0,30}(?:ролик|видос|видео|video|project)|(?:throughout|на\s+вс[её]м\s+протяжении)/iu.test(text);
    const readTargets = new Set(
      plan.requirements
        .filter((r) => r.timing.reference)
        .map(
          (r) =>
            r.timing.reference!.target.sceneId +
            "/" +
            r.timing.reference!.target.sourceNodeId,
        ),
    );
    // Named temporal anchors are reads, not an instruction to animate them again.
    if(temporalCues(text).some(c=>c.relation==='afterEnd'||c.relation==='afterStart'))for(const r of plan.requirements.filter(r=>belongs(r,start,end))){const a=plan.requirements.find(a=>a.requirementId===r.timing.anchorRequirementId);if(a&&!belongs(a,start,end)&&a.target.name&&objectMentionRanges(a.target.name,text).length)readTargets.add(a.sceneId+"/"+a.target.sourceNodeId);}
    const writes = new Set(
      plan.requirements.filter(r=>belongs(r,start,end)).map((r) => r.sceneId + "/" + r.target.sourceNodeId),
    );
    const writeIds = ids.filter((id) => !readTargets.has(id) || writes.has(id));
    const targetIds = writeIds.length
      ? [...new Set([...pendingIds, ...writeIds])]
      : pendingIds.length
        ? pendingIds
        : activeIds;
    const unresolvedMention = (r: IntentRequirement, id?: string) =>
      Boolean(
        r.unresolvedReason &&
          r.target.name &&
          objects.some(
            (o) =>
              (!id || o.sceneId + "/" + o.targetId === id) &&
              equivalentObjectName(o.name, r.target.name!) &&
              objectMentionRanges(o.name, text).length,
          ),
      );
    let rs = plan.requirements.filter(
      (r) =>
        r.kind !== "sceneTiming" &&
        belongs(r, start, end) &&
        (!sceneId || !r.sceneId || r.sceneId === sceneId) &&
        (targetIds.some(id => coversTarget(r, id)) ||
          unresolvedMention(r)),
    );
    if (!targetIds.length)
      rs = plan.requirements.filter(
        (r) =>
          r.kind !== "sceneTiming" &&
          belongs(r, start, end) &&
          (!sceneId || r.sceneId === sceneId) &&
          r.sourceText.includes(text.trim()),
      );
    // A semantically bound action consumes its targets even when the conservative
    // keyword probe does not recognize its technique (e.g. lateral motion/scale).
    // Only a genuinely bare target list carries forward to the next instruction.
    if (ids.length && !rs.length && !techs.length && !inherit && !hasActionSequence(text) && !staticLifetime) {
      pendingIds = [...new Set([...pendingIds, ...ids])];
      activeIds = ids;
      continue;
    }
    if (!ids.length && !techs.length && !inherit && !hasActionSequence(text) && !staticLifetime)
      continue;
    if (staticLifetime)
      for (const id of targetIds)
        if (!rs.some(r=>coversTarget(r,id)&&r.motionAction === "freezeProject"&&!r.unresolvedReason))
          issue("MISSING_STATIC_LIFETIME_REQUIREMENT",text,rs.filter(r=>coversTarget(r,id)),{target:id,motionAction:"freezeProject"});
    if (techs.length && targetIds.length)
      for (const id of targetIds) {
        if (
          !rs.some(
            (r) =>
              coversTarget(r, id) ||
              unresolvedMention(r, id),
          ) && !plan.requirements.some(r => {
            // An inherited action can have its primary provenance on a later
            // timing clause. Accept the shared clause only with a verified
            // parent edge, explicit target and coverage link; not row text alone.
            const parent = plan.requirements.find(p => p.requirementId === r.inheritFromRequirementId);
            const clause = parent?.sourceClauseId ? sourceClauses.get(parent.sourceClauseId) : undefined;
            return coversTarget(r, id) && !r.unresolvedReason && r.sceneId === parent?.sceneId &&
              clause && clause.start < end && clause.end > start &&
              objectMentionRanges(r.target.name ?? "", text).length > 0 &&
              techs.every(t => effective(r).has(t)) &&
              plan.coverage.some(row => row.sourceText === clause.text && row.requirementIds.includes(r.requirementId));
          })
        )
          issue("MISSING_OBJECT_REQUIREMENT", text, [], {
            target: id,
            techniques: techs,
          });
      }
    const cues=temporalCues(text);
    report.temporalRelations??=[];
    for(const cue of cues.filter(c=>c.relation==='proceduralAfterMotion'))for(const r of rs.filter(r=>effective(r).has('inertialOvershoot')))
      report.temporalRelations.push({sourceSpan:{start:start+cue.start,end:start+cue.end,text:request.slice(start+cue.start,start+cue.end)},sourceRequirementId:r.requirementId,targetRequirementId:r.requirementId,relation:'proceduralAfterMotion',classification:'explicit',evidence:"The cue describes its own inertial tail, not a preceding object movement."});
    const recordEdge=(anchor:string,child:string,relation:TemporalEvidence['relation']='afterEnd')=>{const cue=cues.find(c=>c.relation===relation);const span=cue?{start:start+cue.start,end:start+cue.end,text:request.slice(start+cue.start,start+cue.end)}:pendingCue;if(span)report.temporalRelations!.push({sourceSpan:span,sourceRequirementId:anchor,targetRequirementId:child,relation,classification:'explicit',evidence:request.slice(start,end)});};
    for(const cue of cues.filter(c=>c.relation==='afterStart'))for(const r of rs){const anchor=plan.requirements.find(a=>a.requirementId===r.timing.anchorRequirementId);if(!anchor||anchor===r||!anchor.target.name||!objectMentionRanges(anchor.target.name,text.slice(cue.end)).length)continue;recordEdge(anchor.requirementId,r.requirementId,'afterStart');if(r.timing.relation!=='withRequirement'||r.timing.align==='end')issue('INCORRECT_TEMPORAL_RELATION',text,[r],{relation:'withRequirement',anchorRequirementId:anchor.requirementId,align:'start'},r.timing);}
    const clock=text.match(/(?:на|at)\s*\d+(?:[.,]\d+)?\s*(?:сек|second|кадр|frame)/iu);
    if(clock){const value=clock[0].match(/\d+(?:[.,]\d+)?/)![0];activeClock=Number(value.replace(',','.'))/(/кадр|frame/iu.test(clock[0])?fps:1);}
    if(clock)for(const r of rs.filter(r=>r.timing.startSeconds!==null))report.temporalRelations.push({sourceSpan:{start:start+clock.index!,end:start+clock.index!+clock[0].length,text:clock[0]},sourceRequirementId:null,targetRequirementId:r.requirementId,relation:'absolute',classification:'explicit',evidence:'An explicit clock does not create an after-end edge between listed objects.'});
    const delay=text.match(/(?:спустя|через|after)\s*(?:\d+|полсекунды|секунду)(?:[.,]\d+)?\s*(?:кадр[а-я]*|сек[а-я]*|frames?|seconds?)?/iu);
    if(delay)for(const r of rs.filter(r=>r.timing.delaySeconds!==0))report.temporalRelations.push({sourceSpan:{start:start+delay.index!,end:start+delay.index!+delay[0].length,text:delay[0]},sourceRequirementId:r.timing.anchorRequirementId,targetRequirementId:r.requirementId,relation:'delay',classification:'explicit',evidence:'The delay is separate from whether the anchor endpoint is start or end.'});
    if(activeClock!==undefined&&!hasActionSequence(text)&&!cues.some(c=>c.relation==='afterStart')&&!delay)for(const r of rs.filter(r=>r.kind==='objectAnimation'&&r.timing.relation==='afterRequirement'&&r.timing.anchorRequirementId!==pendingAfter&&!r.timing.reference&&(r.timing.align??'start')==='start'&&(r.timing.offsetFrames??0)===0&&r.timing.delaySeconds===0)){
      const anchor=plan.requirements.find(a=>a.requirementId===r.timing.anchorRequirementId);
      if(anchor?.timing.startSeconds===activeClock)issue('UNSUPPORTED_SEQUENTIAL_DEPENDENCY',text,[r],{startSeconds:activeClock,reason:'The explicit shared clock supplies no evidence for waiting for the preceding object.'},r.timing);
    }
    const absoluteSequence=hasActionSequence(text)&&/(?:на|at)\s*\d+(?:[.,]\d+)?\s*(?:сек|second|кадр|frame)/iu.test(text)&&rs.some(r=>r.timing.startSeconds!==null);
    if(absoluteSequence){
      const roots=rs.filter(r=>r.timing.startSeconds!==null&&!r.unresolvedReason);
      if(roots.length===1){
        const root=roots[0],children=rs.filter(r=>r!==root&&!r.unresolvedReason);
        for(const child of children){recordEdge(root.requirementId,child.requirementId);if(child.timing.relation!=="afterRequirement"||child.timing.anchorRequirementId!==root.requirementId||child.timing.align==="end")issue("MISSING_SEQUENTIAL_DEPENDENCY",text,[child],{relation:"afterRequirement",anchorRequirementId:root.requirementId,align:"start"},child.timing);}
      }
      pendingAfter=undefined;
    }
    else if (hasActionSequence(text) && previous){
      // A named anchor must match the preceding requirement; a different named
      // object is evidence against guessing that previous array item as anchor.
      const cue=cues.find(c=>c.relation==='afterEnd')!;
      const namedAnchors=plan.requirements.filter(a=>a!==previous&&!rs.some(r=>r.requirementId===a.requirementId)&&a.target.name&&objectMentionRanges(a.target.name,text.slice(cue.end)).some(m=>m.start<30));
      const declaredAnchor=rs.map(r=>plan.requirements.find(a=>a.requirementId===r.timing.anchorRequirementId)).find(a=>a?.target.name&&objectMentionRanges(a.target.name,text.slice(cue.end)).some(m=>m.start<30));
      pendingAfter=declaredAnchor?.requirementId??(!namedAnchors.length?previous.requirementId:undefined);
      pendingCue={start:start+cue.start,end:start+cue.end,text:request.slice(start+cue.start,start+cue.end)};
    }
    if (
      techs.length &&
      !targetIds.length &&
      rs.filter((r) => !r.unresolvedReason).length > 1 &&
      !(
        rs.every(
          (r) =>
            r.selectionRequirementId &&
            r.selector &&
            (r.expressionIds?.length || r.animationIds?.length),
        ) && new Set(rs.map((r) => r.selectionRequirementId)).size === 1
      )
    )
      issue(
        "AMBIGUOUS_CLAUSE_LINKAGE",
        text,
        rs,
        "precise sourceText for each target",
      );
    const linkedIds = new Set(
      plan.coverage
        .filter(
          (row) =>
            row.sourceText.includes(text.trim()) ||
            text.includes(row.sourceText.trim()),
        )
        .flatMap((row) => row.requirementIds),
    );
    for (const r of rs)
      if (!linkedIds.has(r.requirementId))
        issue(
          "UNLINKED_CLAUSE_REQUIREMENT",
          text,
          [r],
          "coverage link to this requirement",
        );
    const negated =
      /\b(?:not|without)\b|(?:не\s+(?:добав|дела|нуж|использ)|без\s+фейд|убер|удали)/i.test(
        text,
      );
    for (const r of rs) {
      if (r.kind === "unsupported" || r.unresolvedReason) continue;
      if (
        inherit &&
        previous &&
        previous.requirementId !== r.requirementId &&
        !negated &&
        !r.inheritFromRequirementId
      )
        issue("MISSING_INHERITANCE_LINK", text, [r], previous.requirementId);
      const have = effective(r);
      if (!negated)
        for (const technique of techs.filter(
          (t) =>
            !r.timing.reference ||
            r.timing.reference.effect !== t ||
            r.techniques.includes(t as (typeof r.techniques)[number]),
        ))
          if (!have.has(technique) && !rs.some(sibling => sibling !== r && !sibling.unresolvedReason && sibling.sourceClauseId === r.sourceClauseId && sibling.sourceClauseId &&
              ((r.target.logicalObjectId && sibling.target.logicalObjectId === r.target.logicalObjectId && r.targetScope === "logicalObject" && sibling.targetScope === "logicalObject") || sibling.sceneId === r.sceneId && sibling.target.sourceNodeId === r.target.sourceNodeId) && effective(sibling).has(technique)))
            issue("MISSING_EXPLICIT_TECHNIQUE", text, [r], technique, [
              ...have,
            ]);
      if (inherit && previous && !negated)
        for (const technique of effective(previous))
          if (!have.has(technique))
            issue("INCOMPLETE_INHERITANCE", text, [r], technique, [...have]);
      if(pendingAfter&&pendingAfter!==r.requirementId)recordEdge(pendingAfter,r.requirementId);
      if (
        !r.timing.reference &&
        pendingAfter &&
        pendingAfter !== r.requirementId &&
        (r.timing.relation !== "afterRequirement" ||
          r.timing.anchorRequirementId !== pendingAfter)
      )
        issue(
          "MISSING_SEQUENTIAL_DEPENDENCY",
          text,
          [r],
          { relation: "afterRequirement", anchorRequirementId: pendingAfter },
          r.timing,
        );
      if (
        inherit &&
        /быстрее|faster/i.test(text) &&
        !((r.parameters.durationFactor ?? 1) < 1) &&
        r.parameters.durationSeconds === null
      )
        issue(
          "MISSING_FASTER_MODIFIER",
          text,
          [r],
          "durationFactor < 1 or explicit duration",
        );
      if (
        /в(?:двое|\s*2\s*раза)\s*(?:слаб|меньше)/i.test(text) &&
        (r.kind !== "editAnimation" || (r.semanticEdit?.amplitudeFactor ?? r.parameters.amplitudeFactor) !== 0.5)
      )
        issue("MISSING_RELATIVE_EDIT", text, [r], {
          kind: "editAnimation",
          amplitudeFactor: 0.5,
        });
    }
    if (techs.length && !rs.length && !header)
      issue("UNBOUND_EXPLICIT_INSTRUCTION", text, [], techs);
    report.clauses.push({
      start,
      end,
      sourceText: text,
      sceneId,
      requirementIds: rs.map((r) => r.requirementId),
      explicitTechniques: techs,
      inheritedFrom: inherit ? (previous?.requirementId ?? null) : null,
    });
    if (rs.length && (techs.length || inherit)) {
      if (rs.some((r) => r.requirementId !== pendingAfter))
        pendingAfter = undefined;
      previous = rs.at(-1);
    }
    activeIds = targetIds;
    pendingIds = [];
  }
  report.status = report.issues.length ? "SUSPICIOUS" : "PASSED";
  return report;
}

/** Escalate only a provable validator write-scope contradiction, never a model assertion. */
export function assertCoverageScope(project: LoadedProject, request: string, plan: IntentPlan, report: CoverageReport) {
  const objects=project.inspection.document.scenes.flatMap(objectsIn);
  for(const issue of report.issues){
    if(issue.code!=="MISSING_OBJECT_REQUIREMENT")continue;
    const id=(issue.expected as {target?:string})?.target;
    const object=objects.find(o=>o.sceneId+"/"+o.targetId===id);
    if(!object || objectMentionRanges(object.name,issue.sourceText).length)continue;
    // Implicit/group references are not proof of a validator defect.
    if(/(?:аналогич|все|всех|одновременно|так же|\b(?:all|same|they|them)\b|(?:^|\s)(?:они|их|эти|этих|он|она)(?:\s|$))/iu.test(issue.sourceText))continue;
    if(!objects.some(o=>o!==object&&objectMentionRanges(o.name,issue.sourceText).length))continue;
    const own=plan.requirements.find(r=>r.sceneId+"/"+r.target.sourceNodeId===id && !r.unresolvedReason && r.sourceClauseId);
    const clause=plan.sourceClauses?.find(c=>c.clauseId===own?.sourceClauseId);
    if(!own||!clause||request.slice(clause.start,clause.end)!==clause.text||!objectMentionRanges(object.name,clause.text).length||clause.text.includes(issue.sourceText.trim()))continue;
    const proof={issue:issue.code,objectExplicitlyNamedInAffectedClause:false,objectHasSeparateAuthoritativeClause:true,existingTechniques:own.techniques,incorrectlyRequiredTechniques:(issue.expected as {techniques?:string[]}).techniques};
    throw Object.assign(new Error("VALIDATOR_SCOPE_CONTRADICTION: "+JSON.stringify(proof)),{code:"VALIDATOR_SCOPE_CONTRADICTION",report:{code:"VALIDATOR_SCOPE_CONTRADICTION",failure:JSON.stringify(proof)}});
  }
}
