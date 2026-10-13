import { identityFixture, node } from "./identity-fixture.js";
import { validateIntentPlan } from "../src/motion/intent/planner.js";
import type {
  IntentRequirement,
  IntentPlan,
} from "../src/motion/intent/schema.js";
export const compositeRequest =
  "сцена 2 начинается на 1 секунде: image 1926988171, Абонементы на любимую еду и напитки, куар появляются снизу через фейд, причём с колебаниями / инерцией, а лого появляется снизу аналогично. сцена 3 начинается на 3 секунде: лента 1 появляется через trim paths слева направо, и когда заканчивается её анимация, аналогично анимируется лента 2. Также снизу через фейд появляется с выгодой до 80% и шейп под 80%.";
export const emptyParameters: IntentRequirement["parameters"] = {
  fromSceneId:null,toSceneId:null,moveToCenter:null,x:null,y:null,scaleFrom:null,scaleTo:null,
  durationSeconds: null,
  distance: null,
  direction: null,
  amplitude: null,
  frequencyFactor:null,
  frequency: null,
  decay: null,
  easing: null,
  durationFactor: null,
  amplitudeFactor: null,
};
export const sceneTiming = (
  id: string,
  sceneId: string,
  seconds: number,
  sourceText: string,
): IntentRequirement => ({
  requirementId: id,
  kind: "sceneTiming",
  sourceText,
  sceneId,
  target: { sourceNodeId: null, logicalObjectId: null, name: null },
  techniques: [],
  parameters: { ...emptyParameters },
  timing: {
    startSeconds: seconds,
    relation: "sceneStart",
    anchorRequirementId: null,
    delaySeconds: 0,
  },
  inheritFromRequirementId: null,
  inheritanceExplanation: null,
  constraints: [],
  unresolvedReason: null,
});
export const objectRequirement = (
  id: string,
  sceneId: string,
  nodeId: string,
  name: string,
  techniques: IntentRequirement["techniques"],
  sourceText: string,
): IntentRequirement => ({
  ...sceneTiming(id, sceneId, 0, sourceText),
  kind: "objectAnimation",
  target: { sourceNodeId: nodeId, logicalObjectId: null, name },
  techniques,
  timing: {
    startSeconds: null,
    relation: "sceneStart",
    anchorRequirementId: null,
    delaySeconds: 0,
  },
});
export async function intentFixture() {
  const f = await identityFixture(3, (scenes) => {
    scenes[0].children = [node("bg", "Background")];
    scenes[1].children = [
      node("image", "image 1926988171", 100, 20),
      node("text", "Абонементы на любимую еду и напитки", 10, 10),
      node("qr", "куар", 150, 70),
      node("logo", "лого", 170, 10),
    ];
    scenes[2].children = [
      node("discount", "с выгодой до 80%", 20, 30),
      node("shape", "шейп под 80%", 60, 30),
      ...["лента 1", "лента 2"].map((name, i) => {
        const n = node("ribbon" + (i + 1), name, 10, 70 + i * 20, 150, 15);
        n.type = "VECTOR";
        n.properties = {
          ...n.properties,
          fills: [],
          strokeWeight: 2,
          strokeAlign: "CENTER",
          strokes: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }],
          vectorPaths: [
            { data: "M0 0 C50 25 100 -25 150 0", windingRule: "NONZERO" },
          ],
        };
        return n;
      }),
    ];
  });
  const reqs = [
    sceneTiming("timing2", "s1", 1, compositeRequest),
    sceneTiming("timing3", "s2", 3, compositeRequest),
    ...[
      ["image", "image 1926988171"],
      ["text", "Абонементы на любимую еду и напитки"],
      ["qr", "куар"],
      ["logo", "лого"],
    ].map(([id, name]) =>
      objectRequirement(
        id,
        "s1",
        id,
        name,
        ["slideUp", "fadeIn", "inertialOvershoot"],
        compositeRequest,
      ),
    ),
    objectRequirement(
      "ribbon1",
      "s2",
      "ribbon1",
      "лента 1",
      ["trimPath"],
      compositeRequest,
    ),
    objectRequirement(
      "ribbon2",
      "s2",
      "ribbon2",
      "лента 2",
      [],
      compositeRequest,
    ),
    objectRequirement(
      "discount",
      "s2",
      "discount",
      "с выгодой до 80%",
      ["slideUp", "fadeIn"],
      compositeRequest,
    ),
    objectRequirement(
      "shape",
      "s2",
      "shape",
      "шейп под 80%",
      ["slideUp", "fadeIn"],
      compositeRequest,
    ),
  ];
  reqs[7].inheritFromRequirementId = "ribbon1";
  reqs[7].inheritanceExplanation = "после первой аналогично";
  reqs[7].timing = {
    ...reqs[7].timing,
    relation: "afterRequirement",
    anchorRequirementId: "ribbon1",
  };
  reqs[6].parameters.direction = "leftToRight";
  reqs[3].parameters.direction = null;
  const plan = validateIntentPlan(f.project, compositeRequest, {
    schemaVersion: "1.0.0",
    requirements: reqs,
    coverage: [
      {
        sourceText: compositeRequest,
        requirementIds: reqs.map((r) => r.requirementId),
        classification: "executable",
        explanation:
          "Test contract supplied explicitly; not an LLM interpretation",
      },
    ],
    assumptions: [],
  } satisfies IntentPlan);
  return { ...f, plan };
}
