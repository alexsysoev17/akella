export const techniques = [
  {
    id: "maskReveal",
    name: "Раскрытие текста маской",
    implementationId: "maskReveal",
    description:
      "Explicit non-destructive text clipping reveal; never added to ordinary slide/fade",
    queries: ["mask reveal text", "текст через маску"],
    implementation:
      "Cached SVG clip wrapper sized from source bounds and loaded HTML line boxes",
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
    description: "Velocity-based additive damped sine after arrival",
    queries: [
      "инерция после движения",
      "затухающие колебания после остановки",
      "procedural overshoot",
    ],
    implementation:
      "incomingVelocity × amplitude × sin(2π frequency t) × exp(-decay t); ae mode: derivative at keyTime-frameDuration/10, exact duration cutoff; legacy mode: lookback secant and smooth settling envelope",
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
      "Needs source base track",
      "incomingImpulse is explicit additive velocity, not silently invented",
      "frame rate must resolve frequency",
    ],
    examples: ["slideUp then setExpression inertialOvershoot"],
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
      "getTotalLength + stroke-dasharray/dashoffset on centerline mask",
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
    description: "Seeded smooth noise",
    queries: ["wiggle", "случайное покачивание"],
    implementation: "seeded analytic noise",
    properties: ["x", "y", "rotation", "scaleX", "scaleY"],
    parameters: ["amplitude", "frequency", "seed"],
    limits: ["finite interval"],
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
