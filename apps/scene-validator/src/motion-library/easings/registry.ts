import { z } from "zod";
import { standardEvaluators } from "./basic.js";
import { cubicBezier } from "./cubic-bezier.js";
import { piecewise } from "./custom.js";
import { spring, elastic, back, bounce } from "./physical.js";
const finite = (min: number, max: number) =>
  z.number().finite().min(min).max(max);
const standardSchema = z.enum(
  Object.keys(standardEvaluators) as [string, ...string[]],
);
export const bezierParameters = z
  .object({
    x1: finite(0, 1),
    y1: finite(-1000, 1000),
    x2: finite(0, 1),
    y2: finite(-1000, 1000),
  })
  .strict();
export const springParameters = z
  .object({
    stiffness: finite(0.001, 100000),
    damping: finite(0.0001, 100000),
    mass: finite(0.001, 100000),
  })
  .strict();
export const elasticParameters = z
  .object({
    amplitude: finite(0, 100000),
    frequency: finite(0.001, 10000),
    decay: finite(0, 10000),
  })
  .strict();
export const backParameters = z.object({ overshoot: finite(0, 10000) }).strict();
export const bounceParameters = z
  .object({
    restitution: finite(0, 1),
    bounceCount: z.number().int().min(1).max(100),
  })
  .strict();
export const piecewiseParameters = z
  .object({
    interpolation: z.enum(["linear", "hermite"]),
    points: z
      .array(
        z
          .object({
            t: finite(0, 1),
            value: finite(-100000, 100000),
            slope: finite(-100000, 100000).nullable().optional(),
          })
          .strict(),
      )
      .min(2)
      .max(32),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (
      p.points[0].t !== 0 ||
      p.points[0].value !== 0 ||
      p.points.at(-1)!.t !== 1 ||
      p.points.at(-1)!.value !== 1
    )
      ctx.addIssue({
        code: "custom",
        message: "Piecewise endpoints must be (0,0) and (1,1)",
      });
    for (let i = 1; i < p.points.length; i++)
      if (p.points[i].t - p.points[i - 1].t < 0.0001)
        ctx.addIssue({
          code: "custom",
          message: "Piecewise times must increase with gap >= 0.0001",
        });
  });
export const aeEaseParameters = z
  .object({
    outInfluence: finite(0.1, 100).default(33.33),
    inInfluence: finite(0.1, 100).default(33.33),
  })
  .strict();
export const easingSchema = z.union([
  z.literal("aeEasyEase"),
  z
    .object({ type: z.literal("aeEasyEase"), parameters: aeEaseParameters })
    .strict(),
  standardSchema,
  z
    .object({ type: standardSchema, parameters: z.object({}).strict() })
    .strict(),
  z
    .object({ type: z.literal("cubicBezier"), parameters: bezierParameters })
    .strict(),
  z
    .object({ type: z.literal("piecewise"), parameters: piecewiseParameters })
    .strict(),
  z
    .object({ type: z.literal("spring"), parameters: springParameters })
    .strict(),
  z
    .object({ type: z.literal("elastic"), parameters: elasticParameters })
    .strict(),
  z.object({ type: z.literal("back"), parameters: backParameters }).strict(),
  z
    .object({ type: z.literal("bounce"), parameters: bounceParameters })
    .strict(),
]);
export type Easing = z.infer<typeof easingSchema>;
interface Entry {
  id: string;
  name: string;
  description: string;
  category: string;
  parameterSchema: z.ZodType;
  defaultParameters: unknown;
  evaluate: (t: number, p: unknown) => number;
}
const entry = (
  id: string,
  description: string,
  parameterSchema: z.ZodType,
  defaultParameters: unknown,
  evaluate: Entry["evaluate"],
): Entry => ({
  id,
  name: id,
  description,
  category: id,
  parameterSchema,
  defaultParameters,
  evaluate,
});
const aeCurves = new Map<string, ReturnType<typeof cubicBezier>>();
export const easingRegistry: Entry[] = [
  entry(
    "aeEasyEase",
    "Zero endpoint speed temporal Bezier; outgoing/incoming influence in percent. Not piecewise easeInOutCubic.",
    aeEaseParameters,
    { outInfluence: 33.33, inInfluence: 33.33 },
    (t, p) => {
      const q = aeEaseParameters.parse(p),
        key = JSON.stringify(q);
      let curve = aeCurves.get(key);
      if (!curve) {
        curve = cubicBezier(
          q.outInfluence / 100,
          0,
          1 - q.inInfluence / 100,
          1,
        );
        if (aeCurves.size >= 128) aeCurves.clear();
        aeCurves.set(key, curve);
      }
      return curve(t);
    },
  ),
  ...Object.entries(standardEvaluators).map(([id, fn]) =>
    entry(
      id,
      "Standard normalized progress curve; non-monotone families allow overshoot.",
      z.object({}).strict(),
      {},
      (t) => fn(t),
    ),
  ),
  entry(
    "cubicBezier",
    "CSS-compatible X inversion. y controls may exceed 0..1.",
    bezierParameters,
    { x1: 0.85, y1: 0, x2: 0.15, y2: 1 },
    (t, p) => {
      const q = p as z.infer<typeof bezierParameters>;
      return cubicBezier(q.x1, q.y1, q.x2, q.y2)(t);
    },
  ),
  entry(
    "piecewise",
    "Linear C0 or shared-tangent Hermite C1 curve.",
    piecewiseParameters,
    {
      interpolation: "hermite",
      points: [
        { t: 0, value: 0 },
        { t: 0.3, value: 0.03 },
        { t: 0.65, value: 0.9 },
        { t: 1, value: 1 },
      ],
    },
    (t, p) => {
      const q = p as z.infer<typeof piecewiseParameters>;
      return piecewise(t, q.points, q.interpolation);
    },
  ),
  entry(
    "spring",
    "Analytic mass/spring/damper. C2 finite settling window.",
    springParameters,
    { stiffness: 180, damping: 14, mass: 1 },
    (t, p) => spring(t, p as z.infer<typeof springParameters>),
  ),
  entry(
    "elastic",
    "Oscillatory easing with finite settling.",
    elasticParameters,
    { amplitude: 0.3, frequency: 3, decay: 5 },
    (t, p) => elastic(t, p as z.infer<typeof elasticParameters>),
  ),
  entry(
    "back",
    "Adjustable overshoot.",
    backParameters,
    { overshoot: 1.70158 },
    (t, p) => back(t, (p as { overshoot: number }).overshoot),
  ),
  entry(
    "bounce",
    "Ballistic contacts with restitution and bounce count.",
    bounceParameters,
    { restitution: 0.4, bounceCount: 3 },
    (t, p) => bounce(t, p as z.infer<typeof bounceParameters>),
  ),
];
const byId = new Map(easingRegistry.map((e) => [e.id, e]));
/** Input must have crossed easingSchema at a storage/API boundary. No code evaluation. */
export function evaluateEasing(t: number, easing: Easing): number {
  if (!Number.isFinite(t)) throw new Error("Non-finite easing time");
  const id = typeof easing === "string" ? easing : easing.type,
    e = byId.get(id);
  if (!e) throw new Error(`Unknown easing: ${id}`);
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const value = e.evaluate(
    t,
    typeof easing === "string" ? {} : easing.parameters,
  );
  if (!Number.isFinite(value)) throw new Error("Non-finite easing result");
  return value;
}
export function easingCatalog() {
  return easingRegistry.map(({ evaluate, parameterSchema, ...meta }) => ({
    ...meta,
    parameterSchema: z.toJSONSchema(parameterSchema),
  }));
}
