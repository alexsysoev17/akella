import type { IntentTechnique } from "../../motion/intent/schema.js";
export const techniques = [
  {
    id: "maskReveal",
    name: "Раскрытие текста маской",
    implementationId: "maskReveal",
    description:
      "Explicit non-destructive text clipping reveal; never added to ordinary slide/fade",
    queries: ["mask reveal text", "текст через маску"],
    implementation:
      "Native shaped-text clip coverage in Skia; explicit browser compatibility uses SVG wrappers",
    properties: ["reveal"],
    parameters: ["from", "to", "direction"],
    limits: [
      "TEXT only",
      "intentional ancestor clipping remains",
      "source fonts must be installed for Figma typography fidelity",
    ],
    examples: ["addAnimation maskReveal {from:0,to:1,direction:forward}"],
    technicalChecks: ["typed reveal channel", "source geometry unchanged"],
    visualChecks: [
      "partial reveal differs from same-frame full text",
      "full reveal restores glyph pixels",
    ],
  },

  {
    id: "inertialOvershoot",
    name: "Инерционные затухающие колебания",
    implementationId: "inertialOvershoot",
    description: "Whole-object continuous approach and velocity-driven settling; tuneInertia continuous is the approved single rest-launch authoring method. See inertia-continuity guidance.",
    queries: [
      "инерция после движения",
      "затухающие колебания после остановки",
      "procedural overshoot",
    ],
    implementation:
      "Existing damped sine evaluator. Uncoupled mode uses velocity × coefficient; coupled mode uses velocity/(2πf), with strength applied to a linked approach. tuneInertia continuous matches scalar derivatives through jerk and continues all pose channels. Stored legacy math is retained.",
    properties: ["x", "y", "scaleX", "scaleY", "rotation"],
    parameters: [
      "sourceAnimationId",
      "amplitude",
      "frequency",
      "decay",
      "velocityLookbackFrames (legacy only)",
      "internal algorithm version (new: instantaneous; stored legacy retained)",
      "incomingImpulse",
    ],
    limits: [
      "Needs a finite source track or a unique cross-scene transition; whole-pose settling includes X/Y, rotation and scale, not just X. Continuous authoring is a single rest launch, not arbitrary multi-key reconstruction",
      "incomingImpulse is explicit additive velocity, not silently invented",
      "frame rate must resolve frequency",
    ],
    examples: ["create movement + linked inertialOvershoot, then tuneInertia approach=continuous; inspect achieved peak and rendered whole pose"],
    technicalChecks: [
      "source track",
      "procedural implementation",
      "finite samples",
      "continuous endpoints",
    ],
    visualChecks: [
      "visible rendered contribution",
      "oscillation frequency",
      "decaying peaks",
      "final target",
    ],
  },
  {
    id: "trimPaths",
    name: "Прорисовка вдоль контура",
    implementationId: "trimPath",
    description: "Native path-length mask reveal preserving source paint",
    queries: ["Trim Paths", "прорисуй линию вдоль траектории", "path reveal"],
    implementation:
      "Native CanvasKit PathMeasure contour segments on immutable centerline geometry; browser compatibility uses SVG dash masks",
    properties: ["trim"],
    parameters: ["from", "to", "direction", "durationFrames", "easing"],
    limits: [
      "centered stroked VECTOR/LINE only",
      "separate paths reveal simultaneously",
      "no inferred centerline from outlined fills",
      "self-intersecting wide-stroke masks can expose nearby segments",
    ],
    examples: [
      "addAnimation effect trimPath parameters {from:0,to:1,direction:forward}",
    ],
    technicalChecks: [
      "pathCapability",
      "unchanged geometry",
      "no scale imitation",
    ],
    visualChecks: [
      "same-frame comparison against fully revealed path; screen pixel count need not be monotonic",
      "partial curve at midpoint",
      "stroke paint unchanged",
    ],
  },
  {
    id: "wiggle",
    name: "Процедурное покачивание",
    implementationId: "wiggle",
    description: "Deterministic smooth seeded additive X/Y noise. Continuous until scene end when requested; no settling endpoint. Existing expressions are parameter edits, not duplicates.",
    queries: ["wiggle", "случайное покачивание"],
    implementation: "seeded analytic noise",
    properties: ["x", "y", "rotation", "scaleX", "scaleY"],
    parameters: ["amplitude", "frequency", "seed"],
    limits: ["bounded interval; continuous effects may reach final project frame"],
    examples: ["setExpression wiggle"],
    technicalChecks: ["seed", "finite evaluation"],
    visualChecks: ["visible contribution"],
  },
  {
    id: "spring",
    name: "Пружина",
    implementationId: "spring",
    description: "Analytic damped spring",
    queries: ["пружина", "spring"],
    implementation: "analytic second order response with finite settling",
    properties: ["progress"],
    parameters: ["stiffness", "damping", "mass"],
    limits: ["normalized time"],
    examples: ["structured spring easing"],
    technicalChecks: ["finite endpoints"],
    visualChecks: ["rendered motion"],
  },
  {
    id: "customCurve",
    name: "Авторская кривая",
    implementationId: "cubicBezier",
    description: "Bezier with inverse X solver",
    queries: ["резче посередине", "custom easing"],
    implementation: "bracketed Newton/bisection",
    properties: ["progress"],
    parameters: ["x1", "y1", "x2", "y2"],
    limits: ["x coordinates 0..1"],
    examples: ["setEasing cubicBezier"],
    technicalChecks: ["finite", "endpoints"],
    visualChecks: ["sampled movement"],
  },
] as const;
export function retrieveTechniques(request: string) {
  return techniques.filter((t) =>
    t.id === "maskReveal"
      ? /mask.?reveal|маск/i.test(request)
      : t.id === "trimPaths"
        ? /trim\s*paths?|path\s*reveal|прорис|рисова.*лини/i.test(request)
        : t.id === "inertialOvershoot"
          ? /инерц|inertial|затуха.*колеб|колеб.*(затух|после)|покача.*после|после.*(движ|останов)/i.test(
              request,
            )
          : t.id === "wiggle"
            ? /wiggle|покач|случайн/i.test(request)
            : t.id === "spring"
              ? /spring|пружин/i.test(request)
              : /крив|easing|ускор|резче/i.test(request),
  );
}

/** Semantic techniques bind to engine representations, not just animation effect names. */
export const semanticBindings = {
  slideUp: "animation",
  slideDown: "animation",
  slideLeft: "animation",
  slideRight: "animation",
  fadeIn: "animation",
  fadeOut: "animation",
  trimPath: "animation",
  maskReveal: "animation",
  scaleIn: "animation",
  scaleOut: "animation",
  rotation: "animation",
  moveTo: "animation",
  inertialOvershoot: "expression",
  wiggle: "expression",
  spring: "easing",
  customCurve: "easing",
  objectStateTransition: "transition",
} as const satisfies Record<
  IntentTechnique,
  "animation" | "expression" | "easing" | "transition"
>;
export const isCustomEasing = (e: string | { type: string }) =>
  typeof e === "object" && ["cubicBezier", "piecewise"].includes(e.type);
