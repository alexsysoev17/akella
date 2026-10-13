import test from "node:test";
import assert from "node:assert/strict";
import {
  identity,
  inverse,
  multiply,
  relativeToScene,
} from "../src/exporter/transforms";
import { orderFrames } from "../src/exporter/ordering";
import { detectFormat } from "../src/exporter/formats";
import { safeId, serialize, toJson } from "../src/exporter/serialization";
import { AssetRegistry } from "../src/exporter/assets";
import { validateProject, ProjectZip } from "../src/ui/zip";
import type { MotionProject } from "../src/types/scene";

test("nested rotation and translation use affine matrix multiplication", () => {
  const scene: [[number, number, number], [number, number, number]] = [
    [0, -1, 100],
    [1, 0, 200],
  ];
  const group: [[number, number, number], [number, number, number]] = [
    [0, -1, 30],
    [1, 0, 40],
  ];
  const local: [[number, number, number], [number, number, number]] = [
    [1, 0, 5],
    [0, 1, 10],
  ];
  const absolute = multiply(scene, multiply(group, local));
  assert.deepEqual(relativeToScene(scene, absolute), [
    [0, -1, 20],
    [1, 0, 45],
  ]);
  assert.deepEqual(multiply(scene, inverse(scene)), identity());
});
test("inverse supports scale/shear and rejects singular matrices", () => {
  const matrix: [[number, number, number], [number, number, number]] = [
    [2, 0.5, 12],
    [1, 3, 20],
  ];
  const product = multiply(matrix, inverse(matrix));
  product
    .flat()
    .forEach((value, i) =>
      assert.ok(Math.abs(value - identity().flat()[i]) < 1e-12),
    );
  assert.throws(
    () =>
      inverse([
        [0, 0, 0],
        [0, 0, 0],
      ]),
    /Singular/,
  );
});
test("numeric prefixes sort numerically; ties stable by coordinates and ID", () => {
  const f = (id: string, name: string, x: number, y = 0) => ({
    id,
    name,
    x,
    y,
    width: 100,
    height: 100,
  });
  assert.deepEqual(
    orderFrames([
      f("a", "10_CTA", 0),
      f("b", "02_PRODUCT", 100),
      f("c", "01_INTRO", 200),
    ]).map((f) => f.id),
    ["c", "b", "a"],
  );
  assert.deepEqual(
    orderFrames([f("a", "03_X", 10), f("b", "Unnumbered", 0)]).map((f) => f.id),
    ["b", "a"],
  );
  assert.deepEqual(
    orderFrames([f("b", "X", 0), f("a", "Y", 0)]).map((f) => f.id),
    ["a", "b"],
  );
});
test("magic bytes distinguish PNG JPEG GIF WebP and unknown", () => {
  for (const [bytes, extension] of [
    [[137, 80, 78, 71, 13, 10, 26, 10], "png"],
    [[255, 216, 255, 224], "jpg"],
    [[71, 73, 70, 56, 57, 97], "gif"],
    [[71, 73, 70, 56, 55, 97], "gif"],
    [[82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80], "webp"],
  ] as const)
    assert.equal(detectFormat(new Uint8Array(bytes)).extension, extension);
  assert.throws(() => detectFormat(new Uint8Array([1, 2, 3])), /Unknown/);
});
test("JSON preserves mixed, fractional values and Unicode; omits undefined", () => {
  assert.deepEqual(
    JSON.parse(
      serialize({
        mixed: Symbol(),
        n: 0.123456789,
        text: "RED 🦈",
        absent: undefined,
      }),
    ),
    { mixed: { mixed: true }, n: 0.123456789, text: "RED 🦈" },
  );
  assert.throws(() => toJson(Infinity));
  assert.notEqual(safeId("1:2"), safeId("1_3a_2"));
  assert.equal(safeId("1:2"), safeId("1:2"));
});
test("registry deduplicates concurrent requests and registers only after file sink succeeds", async () => {
  const registry = new AssetRegistry(async () => {});
  let reads = 0;
  const create = async () => {
    reads++;
    return registry.add(
      {
        assetId: "one",
        kind: "image",
        path: "assets/images/one.png",
        mimeType: "image/png",
        byteLength: 1,
      },
      new Uint8Array([1]),
    );
  };
  const [a, b] = await Promise.all([
    registry.once("hash", create),
    registry.once("hash", create),
  ]);
  assert.equal(a, b);
  assert.equal(reads, 1);
  assert.equal(registry.assets.length, 1);
  const broken = new AssetRegistry(async () => {
    throw new Error("disk");
  });
  await assert.rejects(() =>
    broken.add(registry.assets[0], new Uint8Array([1])),
  );
  assert.equal(broken.assets.length, 0);
});
test("archive validates all references and rejects unsafe/duplicate paths", () => {
  const zip = new ProjectZip();
  assert.throws(() => zip.add("../evil", new Uint8Array()), /Unsafe/);
  zip.add("a.png", new Uint8Array());
  assert.throws(() => zip.add("a.png", new Uint8Array()), /Duplicate/);
  const project = {
    assets: [{ assetId: "one", path: "assets/images/a.png" }],
    scenes: [
      {
        preview: "previews/a.png",
        children: [{ properties: { fills: [{ assetId: "one" }] } }],
      },
    ],
  } as unknown as MotionProject;
  assert.throws(
    () => validateProject(project, new Set()),
    /Missing asset file/,
  );
  assert.throws(
    () => validateProject(project, new Set(["assets/images/a.png"])),
    /Missing preview/,
  );
  validateProject(project, new Set(["assets/images/a.png", "previews/a.png"]));
});
