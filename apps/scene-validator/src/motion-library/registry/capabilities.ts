import { semanticBindings } from "../techniques/registry.js";
import { z } from "zod";
import {
  animationSchema,
  textAnimationSchema,
  objectTransitionSchema,
} from "../../motion/schema.js";
import { evaluateAnimation } from "../../motion/engine.js";
import { expressionSchema, propertySchema } from "../expressions/registry.js";
import { expressionValue } from "../../motion/expressions.js";
import { easingRegistry } from "../easings/registry.js";
import { pathReveal } from "../../motion/path-reveal.js";
export const capabilityRegistry = [
  ...animationSchema.options.map((s) => ({
    id: s.shape.effect.value,
    kind: "animation",
    parameterSchema: z.toJSONSchema(s.shape.parameters),
    textContract: {
      schema: z.toJSONSchema(textAnimationSchema),
      supportedEffects: [
        "slideUp",
        "slideDown",
        "slideLeft",
        "slideRight",
        "fadeIn",
        "fadeOut",
      ],
      constraints: [
        "native TEXT only",
        "max 512 visible slices",
        "loaded fonts",
        "total duration includes stagger",
        "matching segmentation settings for compound tracks",
      ],
      implementationReference: "motion/text-animation.ts",
    },
    evaluator: evaluateAnimation,
    supportedProperties:
      s.shape.effect.value === "maskReveal"
        ? ["reveal"]
        : s.shape.effect.value === "trimPath"
          ? ["trim"]
          : ["transform", "opacity"],
    constraints:
      s.shape.effect.value === "trimPath"
        ? [
            "pathCapability.supported",
            "immutable centerline",
            "forward/reverse",
            "all paths reveal simultaneously",
          ]
        : ["validateMotion"],
    validation: ["validateMotion", "rendered frames"],
    ...(s.shape.effect.value === "trimPath" ? { renderer: pathReveal } : {}),
  })),
  ...expressionSchema.options.map((s) => ({
    id: s.shape.type.value,
    kind: "expression",
    parameterSchema: z.toJSONSchema(s.shape.parameters),
    evaluator: expressionValue,
    supportedProperties: propertySchema.options,
    constraints: [
      "finite interval",
      "base source for inertia/loop",
      "no recursive expressions",
    ],
    validation: [
      "validateExpressions",
      "sampled evaluator",
      "rendered contribution",
    ],
  })),
  ...easingRegistry.map((e) => ({
    id: e.id,
    kind: "easing",
    parameterSchema: z.toJSONSchema(e.parameterSchema),
    evaluator: e.evaluate,
    supportedProperties: ["progress"],
    constraints: ["finite 0..1 time"],
    validation: ["endpoint", "finite values"],
  })),
];
const catalog = [
  ...capabilityRegistry.map(({ evaluator, ...entry }) => {
    const { renderer, ...data } = entry as typeof entry & {
      renderer?: unknown;
    };
    return {
      ...data,
      lifecycle:
        data.kind === "animation" || data.kind === "expression"
          ? {
              storage: data.kind,
              create:
                data.kind === "animation" ? "addAnimation" : "setExpression",
              update:
                data.kind === "animation" ? "updateAnimation" : "setExpression",
              remove:
                data.kind === "animation"
                  ? "removeAnimation"
                  : "removeExpression",
              semanticSupport:
                data.kind === "animation"
                  ? "explicit effect operation; supported compiler parameters"
                  : "existing expression compiler techniques only",
            }
          : {
              storage: data.kind,
              semanticSupport:
                "not an independently removable track/expression",
            },
      semanticTechniques: Object.entries(semanticBindings)
        .filter(
          ([id, kind]) =>
            kind === data.kind &&
            (id === data.id ||
              (id === "customCurve" &&
                ["cubicBezier", "piecewise"].includes(data.id))),
        )
        .map(([id]) => id),
      description: `${data.kind}: ${data.id} executed by existing Motion Engine`,
      supportedObjectTypes:
        data.id === "maskReveal"
          ? ["TEXT"]
          : data.id === "trimPath"
            ? ["VECTOR", "LINE"]
            : [
                "FRAME",
                "GROUP",
                "TEXT",
                "RECTANGLE",
                "ELLIPSE",
                "LINE",
                "VECTOR",
                "POLYGON",
                "STAR",
                "BOOLEAN_OPERATION",
                "COMPONENT",
                "INSTANCE",
              ],
      implementationReference:
        data.kind === "expression"
          ? "motion/expressions.ts"
          : data.kind === "easing"
            ? "motion-library/easings/registry.ts"
            : data.id === "maskReveal"
              ? "motion/text-reveal.ts"
              : data.id === "trimPath"
                ? "motion/path-reveal.ts"
                : "motion/engine.ts",
      usageExamples: [
        `Typed operation ${data.kind === "expression" ? "setExpression" : "addAnimation"}; parameters must match parameterSchema`,
      ],
    };
  }),
  {
    id: "objectStateTransition",
    semanticTechniques: ["objectStateTransition"],
    kind: "transition",
    parameterSchema: z.toJSONSchema(objectTransitionSchema),
    description:
      "One logical object transitions between its immutable source states",
    supportedObjectTypes: [
      "TEXT",
      "RECTANGLE",
      "ELLIPSE",
      "VECTOR",
      "GROUP",
      "INSTANCE",
      "COMPONENT",
    ],
    supportedProperties: ["transform", "opacity"],
    constraints: [
      "same logicalObjectId",
      "unambiguous source states",
      "preserve hierarchy",
    ],
    validation: ["validateObjectTransitions", "renderedInstanceUniqueness"],
    implementationReference: "motion/transitions.ts",
    usageExamples: [
      "animateObjectStateTransition with source and target scene IDs",
    ],
  },
];
export function capabilityCatalog() {
  return structuredClone(catalog);
}
