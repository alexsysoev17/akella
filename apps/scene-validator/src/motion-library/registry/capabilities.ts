import { z } from "zod";
import {
  animationSchema,
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
