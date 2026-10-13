import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import {
  buildSceneSvg,
  reconstructProject,
  inverse,
  multiply,
  sceneFileId,
  type Matrix,
} from "../src/renderer.js";
import type { Asset, LoadedProject, Scene } from "../src/types.js";
import { reportHtml } from "../src/viewer.js";
import { serveReport } from "../src/server.js";
const identity: Matrix = [
  [1, 0, 0],
  [0, 1, 0],
];
const solid = (r: number, g: number, b: number) => ({
  type: "SOLID",
  color: { r, g, b },
});
function node(
  id: string,
  type = "RECTANGLE",
  properties: Record<string, unknown> = {},
  transform: Matrix = identity,
  children: unknown[] = [],
) {
  return {
    figmaNodeId: id,
    type,
    sceneTransform: transform,
    properties: {
      width: 10,
      height: 10,
      opacity: 1,
      visible: true,
      fills: [solid(0, 0, 1)],
      ...properties,
    },
    children,
  };
}
function scene(children: unknown[] = []): Scene {
  return {
    ...node(
      "root",
      "FRAME",
      { width: 32, height: 24, fills: [solid(1, 0, 0)], clipsContent: true },
      identity,
      children,
    ),
    sceneId: "scene:test",
    name: "Test",
    index: 0,
    width: 32,
    height: 24,
    preview: "previews/reference.png",
  };
}

test("renderer uses geometry, scene matrices, fills and hierarchy, not preview pixels", async () => {
  let reads = 0;
  const s = scene([
    node("child", "RECTANGLE", { width: 8, height: 5 }, [
      [1, 0, 4],
      [0, 1, 8],
    ]),
  ]);
  const result = await buildSceneSvg(s, [], async () => {
    reads++;
    throw new Error("Unexpected image read");
  });
  assert.equal(reads, 0);
  assert.ok(result.svg.includes("matrix(1 0 0 1 4 8)"));
  assert.ok(result.svg.includes("rgb(255,0,0)"));
  assert.ok(result.svg.includes("rgb(0,0,255)"));
  assert.ok(!result.svg.includes("previews/"));
  assert.equal(result.stats.structuredNodes, 2);
});
test("nested rotated transforms are recovered from scene matrices, not additive coordinates", async () => {
  const parent: Matrix = [
      [0, -1, 10],
      [1, 0, 12],
    ],
    local: Matrix = [
      [1, 0, 3],
      [0, 1, 4],
    ];
  const child = node("child", "RECTANGLE", {}, multiply(parent, local));
  const group = node("group", "GROUP", { fills: [] }, parent, [child]);
  const result = await buildSceneSvg(
    scene([group]),
    [],
    async () => new Uint8Array(),
  );
  assert.ok(result.svg.includes("matrix(1 0 0 1 3 4)"));
  assert.deepEqual(multiply(inverse(parent), multiply(parent, local)), local);
});
test("linear gradient uses inverse normalized Figma transform", async () => {
  const s = scene();
  s.properties = {
    width: 32,
    height: 24,
    fills: [
      {
        type: "GRADIENT_LINEAR",
        gradientTransform: identity,
        gradientStops: [
          { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
          { position: 1, color: { r: 0, g: 1, b: 0, a: 1 } },
        ],
      },
    ],
  };
  const { svg } = await buildSceneSvg(s, [], async () => new Uint8Array());
  assert.ok(svg.includes("linearGradient"));
  assert.ok(svg.includes('gradientTransform="matrix(32 0 0 24 0 0)"'));
});
test("image paints honor visibility, assetId and geometry clipping", async () => {
  const s = scene([
    node("image", "RECTANGLE", {
      fills: [
        { type: "IMAGE", assetId: "hidden", visible: false },
        { type: "IMAGE", assetId: "visible", scaleMode: "FILL" },
      ],
    }),
  ]);
  const reads: string[] = [];
  const assets: Asset[] = [
    { assetId: "visible", path: "assets/visible.png" },
    { assetId: "hidden", path: "assets/hidden.png" },
  ];
  const result = await buildSceneSvg(s, assets, async (a) => {
    reads.push(a.assetId);
    return new Uint8Array([1]);
  });
  assert.deepEqual(reads, ["visible"]);
  assert.ok(result.svg.includes('preserveAspectRatio="xMidYMid slice"'));
  assert.ok(result.svg.includes("image-clip-"));
});
test("sibling mask is reconstructed from ellipse geometry and excluded from visible paint", async () => {
  const mask = node("mask", "ELLIPSE", {
    isMask: true,
    maskType: "ALPHA",
    fills: [solid(0, 1, 0)],
  });
  const { svg, stats } = await buildSceneSvg(
    scene([mask, node("content")]),
    [],
    async () => new Uint8Array(),
  );
  assert.ok(svg.includes("<mask"));
  assert.ok(svg.includes("<ellipse"));
  assert.ok(svg.includes('mask="url(#mask-'));
  assert.ok(!svg.includes('data-node-id="mask"'));
  assert.equal(stats.rasterFallbacks.length, 0);
});
test("mixed vector paints use declared SVG asset, with explicit fallback provenance", async () => {
  const vector = {
    ...node("vector", "VECTOR", { fills: { mixed: true } }),
    svgAssetId: "svg",
  };
  const { stats } = await buildSceneSvg(
    scene([vector]),
    [{ assetId: "svg", path: "assets/v.svg", kind: "svg" }],
    async () => new TextEncoder().encode("<svg/>"),
  );
  assert.deepEqual(stats.svgFallbacks, ["vector"]);
  assert.ok(stats.warnings.some((w) => w.includes("Mixed vector")));
});
test("preview path cannot be substituted as a registered image asset", async () => {
  await assert.rejects(
    () =>
      buildSceneSvg(
        scene([
          node("bad", "RECTANGLE", {
            fills: [{ type: "IMAGE", assetId: "bad", scaleMode: "FILL" }],
          }),
        ]),
        [{ assetId: "bad", path: "previews/reference.png" }],
        async () => new Uint8Array(),
      ),
    /Previews cannot be renderer inputs/,
  );
});
test("text remains text; mixed segments and typography are preserved without raster asset reads", async () => {
  const text = {
    ...node("text", "TEXT"),
    text: {
      characters: "RED COLLAR",
      segments: [
        {
          start: 0,
          end: 3,
          fontName: { family: "Arial", style: "Bold" },
          fontWeight: 700,
          fontSize: 16,
          fills: [solid(1, 1, 1)],
        },
        {
          start: 3,
          end: 10,
          fontName: { family: "Arial", style: "Regular" },
          fontWeight: 400,
          fontSize: 16,
          fills: [solid(1, 1, 1)],
        },
      ],
    },
  };
  const { svg, stats } = await buildSceneSvg(scene([text]), [], async () => {
    throw new Error("Text cannot require bitmap");
  });
  assert.ok(svg.includes("foreignObject"));
  assert.ok(svg.includes("RED"));
  assert.ok(svg.includes(" COLLAR"));
  assert.ok(svg.includes("font-weight:700"));
  assert.ok(svg.includes("font-weight:400"));
  assert.equal(stats.fonts.length, 2);
});

test("actual PNG pixels come from geometry; changing preview has no effect, changing scene does", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reconstruction-test-"));
  await mkdir(path.join(root, "source", "previews"), { recursive: true });
  const output = path.join(root, "validation");
  await mkdir(path.join(output, "reconstructed"), { recursive: true });
  try {
    const s = scene([
      node("blue", "RECTANGLE", { width: 8, height: 5 }, [
        [1, 0, 4],
        [0, 1, 8],
      ]),
    ]);
    await writeFile(
      path.join(root, "source", "previews", "reference.png"),
      "THIS IS NOT EVEN A PNG",
    );
    const project = {
      root,
      scenePath: path.join(root, "source", "scene.json"),
      inspection: { document: { assets: [], scenes: [s] } },
    } as unknown as LoadedProject;
    await reconstructProject(project, output);
    const png = await readFile(
      path.join(output, "reconstructed", sceneFileId(s.sceneId) + ".png"),
    );
    await writeFile(
      path.join(root, "source", "previews", "reference.png"),
      "ANOTHER INVALID PREVIEW",
    );
    await reconstructProject(project, output);
    assert.deepEqual(
      await readFile(
        path.join(output, "reconstructed", sceneFileId(s.sceneId) + ".png"),
      ),
      png,
    );
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const pixels = await page.evaluate(
        async (data) => {
          const image = new Image();
          image.src = data;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext("2d")!;
          context.drawImage(image, 0, 0);
          return {
            width: image.width,
            height: image.height,
            background: Array.from(context.getImageData(1, 1, 1, 1).data),
            child: Array.from(context.getImageData(5, 9, 1, 1).data),
          };
        },
        "data:image/png;base64," + png.toString("base64"),
      );
      assert.deepEqual(pixels, {
        width: 32,
        height: 24,
        background: [255, 0, 0, 255],
        child: [0, 0, 255, 255],
      });
    } finally {
      await browser.close();
    }
    const p = s.properties as Record<string, unknown>;
    p.fills = [solid(0, 1, 0)];
    await reconstructProject(project, output);
    assert.ok(
      !(
        await readFile(
          path.join(output, "reconstructed", sceneFileId(s.sceneId) + ".png"),
        )
      ).equals(png),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("web viewer loads real reconstructed PNG and switches between restoration and reference", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "viewer-test-"));
  const validation = path.join(root, "validation");
  await mkdir(path.join(validation, "reconstructed"), { recursive: true });
  await mkdir(path.join(validation, "references"));
  const filename = sceneFileId("scene");
  const tiny = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
    "base64",
  );
  await writeFile(
    path.join(validation, "reconstructed", filename + ".png"),
    tiny,
  );
  await writeFile(path.join(validation, "references", filename + ".png"), tiny);
  const report = {
    schemaVersion: "1.0.0",
    mode: "reconstruction",
    visualComparison: "not-performed",
    projectName: "Viewer",
    projectId: "id",
    runId: "run",
    validatedAt: "date",
    status: "passed",
    reconstruction: "completed",
    sceneCount: 1,
    assetCount: 0,
    nodeCount: 1,
    scenes: [
      {
        sceneId: "scene",
        name: "Scene",
        width: 1,
        height: 1,
        status: "structurally-valid",
        reconstructed: `reconstructed/${filename}.png`,
        reference: `references/${filename}.png`,
      },
    ],
    errors: [],
    warnings: [],
  } as Parameters<typeof reportHtml>[0];
  await writeFile(path.join(validation, "report.html"), reportHtml(report));
  const server = await serveReport(root, 0);
  const browser = await chromium.launch({ headless: true });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}`);
    assert.equal(
      await page
        .locator(".restored")
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
      1,
    );
    await page.getByRole("button", { name: "Наложение 50%" }).click();
    assert.equal(
      await page.locator(".stage").getAttribute("data-view"),
      "overlay",
    );
    await page
      .getByRole("button", { name: "Эталон Figma", exact: true })
      .click();
    assert.equal(
      await page.locator(".stage").getAttribute("data-view"),
      "original",
    );
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("polygon without source paths uses SVG fallback instead of silently drawing a rectangle", async () => {
  const polygon = { ...node("polygon", "POLYGON"), svgAssetId: "polygon-svg" };
  const { stats, svg } = await buildSceneSvg(
    scene([polygon]),
    [{ assetId: "polygon-svg", path: "assets/polygon.svg" }],
    async () =>
      new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L10 0L5 10Z"/></svg>',
      ),
  );
  assert.deepEqual(stats.svgFallbacks, ["polygon"]);
  assert.ok(svg.includes("data:image/svg+xml"));
  assert.ok(
    stats.warnings.some((w) => w.includes("Path geometry unavailable")),
  );
});

test('a failed scene does not suppress other reconstructions or publish a partial PNG', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'renderer-partial-'));
  try {
    const output=path.join(root,'validation');await mkdir(path.join(output,'reconstructed'),{recursive:true});
    const bad={...scene(),sceneId:'bad',sceneTransform:null};const good={...scene(),sceneId:'good'};
    const project={scenePath:path.join(root,'source/scene.json'),inspection:{document:{assets:[],scenes:[bad,good]}}} as unknown as LoadedProject;
    const results=await reconstructProject(project,output);
    assert.ok(results.get('bad')?.error);assert.equal(results.get('bad')?.png,'');assert.ok(results.get('good')?.png);
    assert.ok((await readFile(path.join(output,results.get('good')!.png))).length>0);
    await assert.rejects(readFile(path.join(output,'reconstructed',sceneFileId('bad')+'.png')));
  } finally {await rm(root,{recursive:true,force:true});}
});
