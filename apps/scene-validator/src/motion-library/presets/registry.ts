import { z } from "zod";
import type { Easing } from "../easings/registry.js";
import type { Expression } from "../expressions/registry.js";
import type { Animation } from "../../motion/schema.js";
export const presetIds = [
  "smooth-entrance",
  "sharp-smooth",
  "smooth-overshoot",
  "elastic-entrance",
  "soft-floating",
  "subtle-wiggle",
  "dynamic-exit",
  "gentle-scale",
] as const;
export const presetIdSchema = z.enum(presetIds);
export interface Preset {
  id: (typeof presetIds)[number];
  name: string;
  description: string;
  durationSeconds: number;
  easing: Easing;
  properties: {
    property: "x" | "y" | "scaleX" | "scaleY" | "opacity" | "rotation";
    from: number;
    to: number;
  }[];
  expression?: {
    type: "wiggle" | "dampedOscillation" | "inertialOvershoot";
    amplitude: number;
    frequency: number;
    decay?: number;
    after: boolean;
    durationSeconds: number;
  };
}
export const presetRegistry: Preset[] = [
  {
    id: "smooth-entrance",
    name: "Smooth Entrance",
    description: "Soft slide and fade.",
    durationSeconds: 0.7,
    easing: "easeOutCubic",
    properties: [
      { property: "y", from: 80, to: 0 },
      { property: "opacity", from: 0, to: 1 },
    ],
  },
  {
    id: "sharp-smooth",
    name: "Sharp Smooth",
    description: "Slow edges, fast middle; editable Bezier.",
    durationSeconds: 1,
    easing: {
      type: "cubicBezier",
      parameters: { x1: 0.85, y1: 0, x2: 0.15, y2: 1 },
    },
    properties: [{ property: "y", from: 100, to: 0 }],
  },
  {
    id: "smooth-overshoot",
    name: "Smooth Overshoot",
    description: "Bezier entrance followed by velocity-driven inertia.",
    durationSeconds: 0.8,
    easing: {
      type: "cubicBezier",
      parameters: { x1: 0.7, y1: 0, x2: 0.3, y2: 0.92 },
    },
    properties: [{ property: "y", from: 100, to: 0 }],
    expression: {
      type: "inertialOvershoot",
      amplitude: 0.05,
      frequency: 3,
      decay: 4,
      after: true,
      durationSeconds: 1,
    },
  },
  {
    id: "elastic-entrance",
    name: "Elastic Entrance",
    description: "Spring scale and fade.",
    durationSeconds: 1,
    easing: {
      type: "spring",
      parameters: { stiffness: 180, damping: 14, mass: 1 },
    },
    properties: [
      { property: "scaleX", from: 0.6, to: 1 },
      { property: "scaleY", from: 0.6, to: 1 },
      { property: "opacity", from: 0, to: 1 },
    ],
  },
  {
    id: "soft-floating",
    name: "Soft Floating",
    description: "Gentle additive vertical sine.",
    durationSeconds: 3,
    easing: "linear",
    properties: [],
    expression: {
      type: "dampedOscillation",
      amplitude: 8,
      frequency: 0.5,
      decay: 0,
      after: false,
      durationSeconds: 3,
    },
  },
  {
    id: "subtle-wiggle",
    name: "Subtle Wiggle",
    description: "Seeded smooth vertical noise.",
    durationSeconds: 3,
    easing: "linear",
    properties: [],
    expression: {
      type: "wiggle",
      amplitude: 4,
      frequency: 2,
      after: false,
      durationSeconds: 3,
    },
  },
  {
    id: "dynamic-exit",
    name: "Dynamic Exit",
    description: "Accelerating slide and fade.",
    durationSeconds: 0.5,
    easing: "easeInCubic",
    properties: [
      { property: "y", from: 0, to: -100 },
      { property: "opacity", from: 1, to: 0 },
    ],
  },
  {
    id: "gentle-scale",
    name: "Gentle Scale",
    description: "Small scale change with soft edges.",
    durationSeconds: 1,
    easing: "easeInOutSine",
    properties: [
      { property: "scaleX", from: 0.95, to: 1 },
      { property: "scaleY", from: 0.95, to: 1 },
    ],
  },
];
/** Expand once into plain editable tracks, never reapply defaults while evaluating. */
export function instantiatePreset(
  id: (typeof presetIds)[number],
  instanceId: string,
  sceneId: string,
  targetId: string,
  startFrame: number,
  fps: number,
) {
  const p = presetRegistry.find((p) => p.id === id)!;
  const durationFrames = Math.max(1, Math.round(p.durationSeconds * fps));
  const animations: Animation[] = p.properties.map((property, i) => ({
    animationId: `${instanceId}:base:${i}`,
    sceneId,
    targetId,
    startFrame,
    durationFrames,
    easing: structuredClone(p.easing),
    enabled: true,
    effect: "property",
    parameters: { ...property },
  }));
  const expressions: Expression[] = [];
  if (p.expression) {
    const e = p.expression,
      common = {
        expressionId: `${instanceId}:expression`,
        sceneId,
        targetId,
        property: "y" as const,
        startFrame: startFrame + (e.after ? durationFrames : 0),
        durationFrames: Math.round(e.durationSeconds * fps),
        enabled: true,
      };
    if (e.type === "wiggle")
      expressions.push({
        ...common,
        type: e.type,
        parameters: { amplitude: e.amplitude, frequency: e.frequency, seed: 1 },
      });
    if (e.type === "dampedOscillation")
      expressions.push({
        ...common,
        type: e.type,
        parameters: {
          amplitude: e.amplitude,
          frequency: e.frequency,
          decay: e.decay!,
        },
      });
    if (e.type === "inertialOvershoot")
      expressions.push({
        ...common,
        type: e.type,
        sourceAnimationId: animations[0].animationId,
        parameters: {
          mode: "ae",
          amplitude: e.amplitude,
          frequency: e.frequency,
          decay: e.decay!,
          velocityLookbackFrames: Math.min(
            durationFrames,
            Math.max(1, fps * 0.1),
          ),
        },
      });
  }
  return { animations, expressions };
}
