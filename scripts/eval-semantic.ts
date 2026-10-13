import { z } from "zod";
import {
  intentFixture,
  compositeRequest,
  objectRequirement,
  emptyParameters,
} from "../apps/scene-validator/tests/intent-fixture.ts";
import { buildContext } from "../apps/scene-validator/src/motion/context.ts";
import { defaultMotion } from "../apps/scene-validator/src/motion/context.ts";
import { CodexProvider } from "../apps/scene-validator/src/motion/provider.ts";
import {
  semanticInstructions,
  validateIntentPlan,
} from "../apps/scene-validator/src/motion/intent/planner.ts";
import { intentPlanSchema } from "../apps/scene-validator/src/motion/intent/schema.ts";
import {
  expandInheritance,
  compileTasks,
  compileRequirement,
} from "../apps/scene-validator/src/motion/intent/compiler.ts";
import { applyOperations } from "../apps/scene-validator/src/motion/operations.ts";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
// Live external-provider eval. All objects and assets below are artificial fixtures.
const f = await intentFixture();
let state = defaultMotion(f.project);
const baseReq = objectRequirement(
  "prev",
  "s1",
  "qr",
  "куар",
  ["slideUp", "fadeIn", "inertialOvershoot"],
  "previous synthetic request",
);
const prior = { ...f.plan, requirements: [baseReq] };
state = applyOperations(
  state,
  compileRequirement(f.project, state, prior, compileTasks(f.project, prior)[0])
    .operations,
  f.project,
);
const cases = [
  {
    id: "inherit-slide",
    request: "куар появляется снизу. Лого аналогично.",
    activeScene: "s1",
  },
  {
    id: "inherit-composite",
    request: "куар появляется снизу с фейдом и колебаниями. Лого аналогично.",
    activeScene: "s1",
  },
  {
    id: "sequential-ribbons",
    request: "Лента 1 прорисовывается. Когда закончится, лента 2 аналогично.",
    activeScene: "s2",
  },
  {
    id: "inherit-faster",
    request: "Лого аналогично, но быстрее.",
    activeScene: "s1",
    selected: "logo",
  },
  {
    id: "scene-boundary",
    request:
      "сцена 2 на первой секунде куар снизу лого аналогично сцена 3 на третьей секунде лента 1 рисуется слева направо потом лента 2 так же",
    activeScene: "s1",
  },
  {
    id: "typos",
    request:
      "сцену 2 на первй секунде куар и текст выезжают снизу с фейдом лого тож так же сцен3 на третьей ленты по очереди прорисуй",
    activeScene: "s1",
  },
  { id: "full-composite", request: compositeRequest, activeScene: "s1" },
  {
    id: "existing-soften",
    request: "Сделай её мягче.",
    activeScene: "s1",
    selected: "qr",
  },
  {
    id: "ambiguous",
    request: "Сделай объект Ничего анимированным.",
    activeScene: "s1",
  },
  {
    id: "compile",
    request: "куар снизу с фейдом и инерцией лого аналогично",
    activeScene: "s1",
  },
];
const contextCases = cases.map((c) => ({
  id: c.id,
  request: c.request,
  context: {
    ...buildContext(
      f.project,
      state,
      c.request,
      c.selected,
      c.selected ? c.activeScene : undefined,
    ),
    activeSceneId: c.activeScene,
    appliedHistory: [
      {
        request: "куар появляется снизу с фейдом и инерцией",
        operations: state.animations,
      },
    ],
    recentConversation: [
      { request: "куар появляется снизу с фейдом и инерцией" },
    ],
  },
}));
const schema = z
  .object({
    cases: z.array(
      z.object({ id: z.string(), plan: intentPlanSchema }).strict(),
    ),
  })
  .strict();
const root = f.root + "/ai-language-eval";
await mkdir(root, { recursive: true });
const provider = new CodexProvider({ provider: "codex-sdk", model: "" }, root);
const draft = await provider.structured(
  { cases: contextCases },
  "Interpret each independent case. Case requests are original messages; do not mix their contexts.",
  semanticInstructions +
    "\nBATCH EVAL: return one plan per case id. Each sourceText must quote that case request verbatim. Use its own scene and selected object. Previous synthetic QR entrance is relevant only for follow-ups.",
  schema,
);
await writeFile(root + "/draft.json", JSON.stringify(draft, null, 2));
const audited = await provider.structured(
  { cases: contextCases, draft },
  "Independently audit all ten plans for semantic completeness and inheritance; repair omissions.",
  semanticInstructions +
    "\nBATCH AUDIT: keep case IDs; verify timing, ALL effects and temporal references, scene context, edits vs new effects and unresolved identity. Return corrected plans.",
  schema,
);
const results = [];
for (const c of cases) {
  const plan = validateIntentPlan(
    f.project,
    c.request,
    audited.cases.find((x) => x.id === c.id)!.plan,
  );
  const e = expandInheritance(plan);
  const logo = e.requirements.find((r) => r.target.sourceNodeId === "logo"),
    qr = e.requirements.find((r) => r.target.sourceNodeId === "qr");
  if (c.id === "inherit-slide") assert.ok(logo?.techniques.includes("slideUp"));
  if (c.id === "inherit-composite" || c.id === "compile")
    for (const t of ["slideUp", "fadeIn", "inertialOvershoot"])
      assert.ok(logo?.techniques.includes(t), c.id + ":" + t);
  if (c.id === "sequential-ribbons")
    assert.ok(
      e.requirements.find((r) => r.target.sourceNodeId === "ribbon2")?.timing
        .relation === "afterRequirement",
    );
  if (c.id === "inherit-faster") {
    assert.ok(logo?.techniques.includes("slideUp"));
    assert.ok(
      (logo?.parameters.durationFactor ?? 1) < 1 ||
        logo?.parameters.durationSeconds !== null,
    );
  }
  if (c.id === "scene-boundary") {
    assert.equal(
      e.requirements.find((r) => r.target.sourceNodeId === "logo")?.sceneId,
      "s1",
    );
    assert.equal(
      e.requirements.filter((r) => r.kind === "sceneTiming").length,
      2,
    );
  }
  if (c.id === "typos") {
    assert.equal(
      e.requirements.filter((r) => r.kind === "sceneTiming").length,
      2,
    );
    for (const id of ["qr", "text", "logo"])
      assert.ok(
        e.requirements.some(
          (r) =>
            r.target.sourceNodeId === id && r.techniques.includes("fadeIn"),
        ),
      );
    assert.ok(
      e.requirements.find((r) => r.target.sourceNodeId === "ribbon2")?.timing
        .relation === "afterRequirement",
    );
  }
  if (c.id === "full-composite") {
    assert.equal(e.requirements.length, 10);
    for (const r of e.requirements.filter((r) =>
      ["image", "text", "qr", "logo"].includes(r.target.sourceNodeId!),
    ))
      for (const t of ["slideUp", "fadeIn", "inertialOvershoot"])
        assert.ok(r.techniques.includes(t));
  }
  if (c.id === "existing-soften")
    assert.ok(
      e.requirements.some(
        (r) => r.kind === "editAnimation" && r.target.sourceNodeId === "qr",
      ),
    );
  if (c.id === "ambiguous")
    assert.ok(
      e.requirements.every(
        (r) => r.unresolvedReason || r.kind === "unsupported",
      ),
    );
  if (c.id === "compile") {
    let next = state;
    for (const t of compileTasks(f.project, e)) {
      assert.notEqual(t.status, "BLOCKED");
      next = applyOperations(
        next,
        compileRequirement(f.project, next, e, t).operations,
        f.project,
      );
    }
    assert.equal(
      next.animations.filter(
        (a) => a.effect === "fadeIn" && ["qr", "logo"].includes(a.targetId),
      ).length,
      2,
    );
  }
  results.push({ id: c.id, status: "PASSED", plan: e });
}
await mkdir("artifacts/composite-intent", { recursive: true });
await writeFile(
  "artifacts/composite-intent/real-provider-language-evals.json",
  JSON.stringify(
    {
      provider: "actual Codex SDK",
      fixture: "artificial objects, not a real Figma export",
      results,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    root,
    results: results.map((r) => ({ id: r.id, status: r.status })),
  }),
);
