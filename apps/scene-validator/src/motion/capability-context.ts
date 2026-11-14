import type {LoadedProject} from '../types.js';
import {animationSchema} from './schema.js';
import {expressionRegistry} from '../motion-library/expressions/registry.js';
import {segmentedTextCapabilities} from './text-segment.js';
import {objectsIn} from './context.js';

/** Truthful authoring capabilities, not an aesthetic whitelist. Mirrors runtime target validation. */
export function motionCapabilityContext(project?:LoadedProject){
  return {
    animations:animationSchema.options.map(s=>s.shape.effect.value),
    expressions:expressionRegistry.map(({id,description,lifecycle})=>({id,description,lifecycle})),
    maskReveal:{supportedTargetTypes:['TEXT'],directions:{forward:'bottom to top',reverse:'top to bottom',leftToRight:'left to right',rightToLeft:'right to left'},limitation:'An animated clip/reveal for arbitrary raster images/groups is not implemented. Do not promise ribbon-path image reveals using maskReveal.'},
    trimPath:{requires:'source trimSupported=true; immutable supported centerline paths; simultaneous paths; inspect trimReason when false',alternative:'Choose a different authored motion preserving the artwork; do not claim a substituted fade is a path reveal.'},
    segmentedText:segmentedTextCapabilities,
    rendering:{framesPerCall:8,geometry:'Optional logicalObjectIds focuses per-frame geometry; the raster still contains the whole composition.'},
    textContinuity:'Changed text-box bounds alone do not imply changed visible glyphs; compare rendered text and line layout before adding a state morph.',
    sourceTransitionHandoff:'A completed maskReveal(to=1) or completed neutral segmented TEXT entrance can precede a state transition. Segmented duration is TOTAL including stagger; preserve the entrance rather than replacing it with a fade to avoid an obsolete neutrality conflict.',
    ...(project?{sourceEligibility:project.inspection.document.scenes.map(scene=>{const nodes=objectsIn(scene).filter(n=>n.visible);return {sceneId:scene.sceneId,objects:nodes.slice(0,160).map(n=>({id:n.targetId,type:n.type,maskReveal:n.type==='TEXT',trimPath:n.trimSupported,...(!n.trimSupported?{trimReason:n.trimReason}:{})})),omitted:Math.max(0,nodes.length-160)};})}:{}),
  };
}
