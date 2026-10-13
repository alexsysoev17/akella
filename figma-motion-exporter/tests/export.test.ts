import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { exportProject } from "../src/exporter/scene";
import { serialize } from "../src/exporter/serialization";
import { ProjectZip, validateProject } from "../src/ui/zip";
import type { MotionProject, Report } from "../src/types/scene";
import {
  asFrames,
  frame,
  node,
  png,
  jpeg,
  installFigma,
  imagePaint,
  type Fixture,
} from "./fixtures";
async function run(
  ...frames: Fixture[]
): Promise<{
  project: MotionProject;
  report: Report;
  files: Map<string, Uint8Array>;
}> {
  const files = new Map<string, Uint8Array>();
  const report = await exportProject(
    asFrames(...frames),
    async (path, bytes) => {
      files.set(
        path,
        typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes,
      );
    },
    () => {},
  );
  const project = JSON.parse(
    new TextDecoder().decode(files.get("scene.json")),
  ) as MotionProject;
  validateProject(project, new Set(files.keys()));
  return { project, report, files };
}
test("1: solid frame exports structured scene and full-size preview", async () => {
  installFigma();
  const { project, report, files } = await run(
    frame("1:1", [], {
      width: 1920,
      height: 1080,
      fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }],
    }),
  );
  assert.equal(report.nodes, 1);
  assert.equal(project.canvas.width, 1920);
  assert.equal(project.scenes[0].width, 1920);
  assert.deepEqual(project.scenes[0].properties.fills, [
    { type: "SOLID", color: { r: 1, g: 0, b: 0 } },
  ]);
  assert.deepEqual(files.get(project.scenes[0].preview!), png);
});
test("2: mixed text preserves segments, indices, typography and paint assets", async () => {
  installFigma({ sameHash: png });
  const text = node("TEXT", "2:1", {
    characters: "RED COLLAR",
    fontName: Symbol(),
    fontSize: 32,
    fontWeight: Symbol(),
    lineHeight: { unit: "AUTO" },
    letterSpacing: { unit: "PERCENT", value: 2 },
    textCase: "ORIGINAL",
    textDecoration: "NONE",
    textAlignHorizontal: "CENTER",
    textAlignVertical: "TOP",
    textAutoResize: "NONE",
    paragraphIndent: 0,
    paragraphSpacing: 0,
    hasMissingFont: true,
    getStyledTextSegments: (fields: string[]) => {
      assert.ok(fields.includes("fontWeight"));
      return [
        {
          start: 0,
          end: 3,
          characters: "RED",
          fontName: { family: "Inter", style: "Bold" },
          fontWeight: 700,
          fontSize: 32,
          fills: [imagePaint],
        },
        {
          start: 3,
          end: 10,
          characters: " COLLAR",
          fontName: { family: "Inter", style: "Regular" },
          fontWeight: 400,
          fontSize: 32,
          fills: [],
        },
      ];
    },
  });
  const { project } = await run(frame("2:0", [text]));
  const value = project.scenes[0].children[0].text!;
  assert.equal(value.characters, "RED COLLAR");
  assert.deepEqual(value.fontName, { mixed: true });
  const segments = value.segments as {
    start: number;
    end: number;
    fontWeight: number;
  }[];
  assert.equal(segments.length, 2);
  assert.equal(segments[0].fontWeight, 700);
  assert.equal(segments[1].start, 3);
  assert.equal(project.assets.length, 1);
});
test("3/4/7: original PNG deduplicated across three frames; crop retained", async () => {
  const mock = installFigma({ sameHash: png });
  const { project, files } = await run(
    ...[1, 2, 3].map((i) =>
      frame(`3:${i}`, [
        node("RECTANGLE", `image:${i}`, {
          fills: [imagePaint],
          width: i * 100,
        }),
      ]),
    ),
  );
  const images = project.assets.filter((a) => a.kind === "image");
  assert.equal(images.length, 1);
  assert.equal(mock.reads(), 1);
  assert.deepEqual(files.get(images[0].path), png);
  assert.equal(project.scenes.length, 3);
  const paints = project.scenes.map(
    (s) => (s.children[0].properties.fills as Record<string, unknown>[])[0],
  );
  assert.equal(new Set(paints.map((p) => p.assetId)).size, 1);
  assert.deepEqual(paints[0].imageTransform, imagePaint.imageTransform);
  assert.equal(paints[0].scaleMode, "CROP");
});
test("original JPEG extension and bytes remain JPEG", async () => {
  installFigma({ sameHash: jpeg });
  const { project, files } = await run(
    frame("jpg", [node("RECTANGLE", "jpg:1", { fills: [imagePaint] })]),
  );
  const image = project.assets.find((a) => a.kind === "image")!;
  assert.ok(image.path.endsWith(".jpg"));
  assert.deepEqual(files.get(image.path), jpeg);
});
test("5: vector geometry, gradient stroke and SVG retained", async () => {
  installFigma();
  const paths = [{ windingRule: "NONZERO", data: "M 0 0 L 100 100" }];
  const gradient = {
    type: "GRADIENT_LINEAR",
    gradientTransform: [
      [1, 0, 0],
      [0, 1, 0],
    ],
    gradientStops: [
      { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
      { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
    ],
  };
  const { project } = await run(
    frame("5:0", [
      node("VECTOR", "5:1", {
        vectorPaths: paths,
        strokes: [gradient],
        strokeWeight: 4,
        strokeCap: "ROUND",
        strokeJoin: "ROUND",
        strokeAlign: "CENTER",
      }),
    ]),
  );
  const vector = project.scenes[0].children[0];
  assert.deepEqual(vector.properties.vectorPaths, paths);
  assert.deepEqual(vector.properties.strokes, [gradient]);
  assert.equal(vector.properties.strokeWeight, 4);
  assert.ok(vector.svgAssetId);
  assert.equal(
    project.assets.find((a) => a.assetId === vector.svgAssetId)?.kind,
    "svg",
  );
});
test("6: nested rotated hierarchy retains local, scene and absolute transforms and layer order", async () => {
  installFigma();
  const rect = node("RECTANGLE", "6:2", {
    relativeTransform: [
      [1, 0, 5],
      [0, 1, 10],
    ],
    rotation: 0,
  });
  const group = node("GROUP", "6:1", {
    relativeTransform: [
      [0, -1, 30],
      [1, 0, 40],
    ],
    rotation: 90,
    children: [rect, node("ELLIPSE", "6:3")],
  });
  const { project } = await run(
    frame("6:0", [group], {
      relativeTransform: [
        [0, -1, 100],
        [1, 0, 200],
      ],
    }),
  );
  const g = project.scenes[0].children[0],
    r = g.children[0];
  assert.equal(r.parentId, "6:1");
  assert.deepEqual(r.sceneTransform, [
    [0, -1, 20],
    [1, 0, 45],
  ]);
  assert.deepEqual(r.properties.relativeTransform, [
    [1, 0, 5],
    [0, 1, 10],
  ]);
  assert.deepEqual(
    r.properties.absoluteTransform,
    JSON.parse(serialize(rect.absoluteTransform)),
  );
  assert.equal(g.children[1].layerOrder, 1);
});
test("8: repeat export has stable IDs and paths, independent of aliases", async () => {
  installFigma({ sameHash: png });
  const f = frame("8:0", [node("RECTANGLE", "8:1", { fills: [imagePaint] })]);
  const first = await run(f);
  const second = await run(f);
  assert.equal(serialize(first.project), serialize(second.project));
  f.name = "renamed";
  const renamed = await run(f);
  assert.equal(
    first.project.scenes[0].sceneId,
    renamed.project.scenes[0].sceneId,
  );
  assert.deepEqual(first.project.assets, renamed.project.assets);
});
test("9: real ZIP round-trip has valid JSON and every referenced file, Unicode preserved", async () => {
  installFigma({ sameHash: png });
  const { files } = await run(
    frame("9:0", [
      node("RECTANGLE", "9:1", { name: "Телефон 🦈", fills: [imagePaint] }),
    ]),
  );
  const zip = new ProjectZip();
  for (const [path, bytes] of files) zip.add(path, bytes);
  const blob = await zip.generate(() => {});
  const unpacked = await JSZip.loadAsync(await blob.arrayBuffer());
  const project = JSON.parse(
    await unpacked.file("motion-project/scene.json")!.async("string"),
  ) as MotionProject;
  const paths = new Set(
    Object.keys(unpacked.files).map((path) =>
      path.replace(/^motion-project\//, ""),
    ),
  );
  validateProject(project, paths);
  assert.equal(project.scenes[0].children[0].name, "Телефон 🦈");
  for (const asset of project.assets)
    assert.ok(unpacked.file("motion-project/" + asset.path));
});
test("missing original produces error and existing fallback, without dangling references", async () => {
  installFigma();
  const { project, report } = await run(
    frame("missing", [node("RECTANGLE", "missing:1", { fills: [imagePaint] })]),
  );
  assert.equal(report.errorCount, 1);
  assert.equal(project.assets.filter((a) => a.kind === "image").length, 0);
  assert.ok(project.scenes[0].children[0].fallbackAssetId);
});
test("failed SVG and preview are reported; no paths to missing files", async () => {
  installFigma();
  const vector = node("VECTOR", "fail:1", {
    exportAsync: async (settings: ExportSettings | ExportSettingsSVGString) => {
      if (settings.format === "SVG_STRING") throw new Error("SVG failure");
      return png;
    },
  });
  const { project, report } = await run(
    frame("fail", [vector], {
      exportAsync: async () => {
        throw new Error("PNG failure");
      },
    }),
  );
  assert.equal(report.errorCount, 2);
  assert.equal(project.scenes[0].preview, undefined);
  assert.ok(project.scenes[0].children[0].fallbackAssetId);
  assert.equal(project.scenes[0].children[0].svgAssetId, undefined);
});

test("transport failures abort immediately instead of building a partial archive", async () => {
  const { ExportAbortedError } = await import("../src/exporter/errors");
  installFigma({ sameHash: png });
  let attempts = 0;
  await assert.rejects(
    () =>
      exportProject(
        asFrames(
          frame("abort", [
            node("RECTANGLE", "abort:1", { fills: [imagePaint] }),
          ]),
        ),
        async () => {
          attempts++;
          throw new ExportAbortedError("UI memory limit");
        },
        () => {},
      ),
    /UI memory limit/,
  );
  assert.equal(attempts, 1);
});
