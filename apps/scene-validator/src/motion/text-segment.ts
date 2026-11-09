import type {Expression} from '../motion-library/expressions/registry.js';
import type { Animation } from './schema.js';

/** The native compositor transforms cached shaped units; it does not re-layout text. */
export const segmentedTextCapabilities = {
    renderer: 'native-skia',
    segmentation: ['paragraph', 'line', 'word', 'character'],
    properties: ['x', 'y', 'opacity', 'scale', 'scaleX', 'scaleY', 'rotation'],
    timing: ['simultaneous', 'staggered', 'sequential'],
    transforms: 'Translation in text-local coordinates; rotation/scale around each shaped unit centre',
    expressions: 'All expression evaluators can bind a segmented text track using textBinding.animationId and phase=withTrack|afterTrack. Existing inertia/loop binding remains compatible.',
    unsupported: ['trimPath', 'maskReveal per unit'],
    shapingLimitation: 'Word/grapheme picture slicing preserves the original shaped paragraph but can split ligatures or connected script; native warnings remain visible',
} as const;

export function supportsSegmentedTextAnimation(a: Animation) {
    if (a.effect === 'trimPath' || a.effect === 'maskReveal') return false;
    if (a.effect === 'property' || a.effect === 'keyframes')
        return (segmentedTextCapabilities.properties as readonly string[]).includes(a.parameters.property);
    return true;
}

export function segmentSchedule(total: number, count: number, settings: NonNullable<Animation['text']>) {
    if (!Number.isFinite(total) || total <= 0 || !Number.isInteger(count) || count < 1)
        throw Error('INVALID_TEXT_SEGMENT_SCHEDULE');
    const step = settings.timing === 'simultaneous' ? 0
        : settings.timing === 'sequential' ? total / count : settings.staggerFrames;
    const duration = total - step * (count - 1);
    if (duration < 1) throw Error('TEXT_STAGGER_EXCEEDS_DURATION');
    return { step, duration };
}

/** Copies are evaluation-only: stored IDs, keys and typography remain untouched.
 * Keyframe abscissae must be scaled with duration, otherwise compressed/staggered
 * tracks never reach their actual terminal keys at their scheduled endpoint. */
export function segmentAnimation(a: Animation, count: number, index: number): Animation {
    if (!a.text || !Number.isInteger(index) || index < 0 || index >= count)
        throw Error('INVALID_TEXT_SEGMENT_INDEX');
    const schedule = segmentSchedule(a.durationFrames, count, a.text);
    const order = a.text.reverse ? count - 1 - index : index;
    return {
        ...a,
        startFrame: a.startFrame + order * schedule.step,
        durationFrames: schedule.duration,
        text: undefined,
        ...(a.effect === 'keyframes' ? { parameters: {
            ...a.parameters,
            points: a.parameters.points.map(point => ({
                ...point, frame: point.frame * schedule.duration / a.durationFrames,
            })),
        } } : {}),
    } as Animation;
}

export function segmentExpressionSource(e:Expression){return e.textBinding?.animationId??('sourceAnimationId'in e?e.sourceAnimationId:undefined);}
export function segmentExpression(e:Expression,source:Animation,original:Animation):Expression {
 const ratio=source.durationFrames/original.durationFrames;
 return {...e,textBinding:undefined,startFrame:e.textBinding?.phase==='withTrack'?source.startFrame+(e.startFrame-original.startFrame)*ratio:source.startFrame+source.durationFrames+e.startFrame-original.startFrame-original.durationFrames,...(e.textBinding?.phase==='withTrack'?{durationFrames:e.durationFrames*ratio}:{})} as Expression;
}
