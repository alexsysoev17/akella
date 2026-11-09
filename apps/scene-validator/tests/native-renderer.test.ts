import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { identityFixture, node } from "./identity-fixture.js";
import { NativeRenderer } from "../src/native/renderer.js";
import {
  renderNativeFrame,
  closeNativeRenderer,
  clearNativeCache,
  probeNativeText,
} from "../src/native/client.js";
import { renderProjectFrame, framePacket } from "../src/native/service.js";
import { PathResources } from "../src/native/paths.js";
import { skia } from "../src/native/skia.js";
import { loadProject } from "../src/project.js";
import { readMotion, changeMotion } from "../src/motion/store.js";
import { motionQA } from "../src/motion/qa/render.js";
import { exportVideo } from "../src/motion/video.js";
import {
  evaluateMotion,
  evaluateAnimation,
  velocityAtTime,
} from "../src/motion/evaluation.js";
import { nativePreviewHtml } from "../src/native/preview.js";
import { createProject } from "../src/importer.js";
import type { MotionState, Animation } from "../src/motion/schema.js";
process.env.AKELLA_RENDERER = "native";
after(() => closeNativeRenderer());
async function fixture() {
  return identityFixture(1, (scenes) => {
    const t = node("text", "Headline", 45.25, 36.75, 200, 110);
    t.type = "TEXT";
    t.properties.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
    t.text = {
      characters: "Native text\nSecond line",
      fontName: { family: "Arial", style: "Regular" },
      fontSize: 24,
      lineHeight: { unit: "PIXELS", value: 30 },
      textAlignHorizontal: "LEFT",
      textAlignVertical: "TOP",
      textAutoResize: "NONE",
    };
    scenes[0].children = [t];
    scenes[0].width = 320;
    scenes[0].height = 240;
    scenes[0].properties = {
      width: 320,
      height: 240,
      clipsContent: true,
      fills: [],
    };
  });
}
const key = JSON.stringify(["s0", "text"]);
function slide(
  segmentation: "block" | "paragraph" | "line" | "word" | "character" = "line",
): Animation {
  return {
    animationId: "slide",
    sceneId: "s0",
    targetId: "text",
    effect: "slideUp",
    startFrame: 0,
    durationFrames: 6,
    easing: "linear",
    enabled: true,
    parameters: { distance: 30, mode: "in" },
    text: {
      segmentation,
      timing: "simultaneous",
      staggerFrames: 0,
      reverse: false,
      origin: "local",
    },
  };
}
async function rgba(bytes: Uint8Array) {
  const k = await skia(),
    image = k.MakeImageFromEncoded(bytes)!;
  assert.ok(image);
  try {
    return Uint8Array.from(
      image.readPixels(0, 0, {
        width: image.width(),
        height: image.height(),
        colorType: k.ColorType.RGBA_8888,
        alphaType: k.AlphaType.Unpremul,
        colorSpace: k.ColorSpace.SRGB,
      })!,
    );
  } finally {
    image.delete();
  }
}
test("native engine boundary retains frame evaluation, easing and incoming velocity without DOM", () => {
  const a = slide("block"),
    state = {
      settings: { durationFrames: 12, fps: 12 },
      animations: [a],
      blocks: [],
      expressions: [],
    } as unknown as MotionState;
  assert.equal(evaluateAnimation(a, 0).y, 30);
  assert.equal(evaluateAnimation(a, 6).y, 0);
  assert.equal(evaluateMotion(state, 3).nodes[key].y, 15);
  assert.ok(Math.abs(velocityAtTime(a, 0.25, 12).y! + 60) < 1e-7);
});
test("Skia contour extraction is genuine curved/multiple-contour trim and preserves full closed contours", async () => {
  const k = await skia(),
    resources = new PathResources(k);
  try {
    const original = resources.get(
        "M0 0 C30 80 70 -20 100 40 M120 40 L180 40 Z",
      ),
      before = original.toSVGString(),
      m = resources.measure(original);
    assert.equal(m.contours.length, 2);
    assert.ok(m.length > 180);
    const middle = resources.trim(original, 0.25, 0.75),
      full = resources.trim(original, 0, 1);
    try {
      assert.equal(original.toSVGString(), before);
      const q = resources.measure(middle);
      assert.ok(Math.abs(q.length / m.length - 0.5) < 0.02);
      assert.ok(resources.measure(full).contours.at(-1)!.isClosed());
      assert.throws(
        () => resources.trim(original, 0.8, 0.2),
        /TRIM_INTERVAL_INVALID/,
      );
    } finally {
      middle.delete();
      full.delete();
    }
  } finally {
    resources.dispose();
  }
});
test("native text layout preserves source placement, explicit lines, font face and immutable source", async () => {
  const f = await fixture(),
    before = JSON.stringify(f.project.inspection.document);
  let renderer;
  try {
    renderer = await NativeRenderer.create(f.project);
    const result = renderer.render(f.state, 0, { transparent: true });
    assert.equal(result.renderer, "skia-cpu/1");
    assert.equal(result.text[0].lines.length, 2);
    assert.ok(result.fonts.length);
    const hit = result.hits.find((h) => h.targetId === "text")!;
    assert.equal(hit.points[0].x, 45.25);
    assert.equal(hit.points[0].y, 36.75);
    assert.equal(JSON.stringify(f.project.inspection.document), before);
    assert.ok(result.png.length > 100);
    assert.ok(result.environment.fontFilesDigest.length === 64);
  } finally {
    renderer?.dispose();
    await f.cleanup();
  }
});
test("native fractional text transport meets the unchanged 0.125px alpha-centroid tolerance", async () => {
  const f = await fixture();
  try {
    const probe = await probeNativeText(f.project, f.state, "text");
    assert.equal(probe.status, "PASSED", JSON.stringify(probe));
    assert.equal(probe.tolerance, 0.125);
    console.log(JSON.stringify({ nativeSubpixel: probe }));
  } finally {
    await f.cleanup();
  }
});
test("native paragraph/line/word/grapheme motion has stable rest and deterministic random-access frames", async () => {
  const f = await fixture();
  let r;
  try {
    r = await NativeRenderer.create(f.project);
    const before = JSON.stringify(f.project.inspection.document);
    for (const segmentation of [
      "paragraph",
      "line",
      "word",
      "character",
    ] as const) {
      const a = slide(segmentation),
        state = { ...f.state, animations: [a] };
      const first = r.render(state, 3),
        rest = r.render(state, 10);
      r.render(state, 0);
      r.render(state, 11);
      assert.deepEqual(r.render(state, 3).png, first.png);
      assert.ok(rest.text[0].units >= 2);
      assert.ok(
        rest.text[0].offsets.every(
          (v) => v.x === 0 && v.y === 0 && v.opacity === 1,
        ),
      );
      assert.equal(r.render(state, 8).stats.textLayouts, 1);
      assert.equal(JSON.stringify(f.project.inspection.document), before);
    }
  } finally {
    r?.dispose();
    await f.cleanup();
  }
});
test("native compound slide/fade/inertia and stagger use the existing local evaluator", async () => {
  const f = await fixture();
  try {
    const a = slide(),
      fade = {
        ...a,
        animationId: "fade",
        effect: "fadeIn" as const,
        parameters: { from: 0, to: 1 },
      },
      state = {
        ...f.state,
        animations: [
          {
            ...a,
            text: {
              ...a.text!,
              timing: "staggered" as const,
              staggerFrames: 1,
            },
          },
          {
            ...fade,
            text: {
              ...a.text!,
              timing: "staggered" as const,
              staggerFrames: 1,
            },
          },
        ],
        expressions: [
          {
            expressionId: "inertia",
            type: "inertialOvershoot" as const,
            property: "y" as const,
            sourceAnimationId: "slide",
            targetId: "text",
            sceneId: "s0",
            startFrame: 6,
            durationFrames: 4,
            enabled: true,
            parameters: {
              mode: "ae" as const,
              amplitude: 0.1,
              frequency: 2,
              decay: 3,
              velocityLookbackFrames: 2,
            },
          },
        ],
      };
    const result = await renderNativeFrame(f.project, state, 3);
    assert.equal(result.text[0].offsets.length, 2);
    assert.notEqual(result.text[0].offsets[0].y, result.text[0].offsets[1].y);
    assert.ok(
      result.text[0].offsets.every((v) => v.opacity > 0 && v.opacity < 1),
    );
    const rest = await renderNativeFrame(f.project, state, 11);
    assert.ok(rest.text[0].offsets.every((v) => v.y === 0));
  } finally {
    await f.cleanup();
  }
});
test("native graphics preserve nesting, alpha, masks, gradient/stroke caps and ordering", async () => {
  const f = await identityFixture(1, (ss) => {
    const a = node("a", "Red", 10, 10, 60, 60);
    a.properties.fills = [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }];
    const b = node("b", "Blue", 30, 30, 40, 40);
    b.properties.fills = [{ type: "SOLID", color: { r: 0, g: 0, b: 1 } }];
    const mask = node("mask", "Mask", 90, 10, 30, 30);
    mask.type = "ELLIPSE";
    mask.properties.isMask = true;
    mask.properties.maskType = "VECTOR";
    const masked = node("masked", "Green", 80, 0, 60, 60);
    masked.properties.fills = [{ type: "SOLID", color: { r: 0, g: 1, b: 0 } }];
    ss[0].children = [a, b, mask, masked];
    ss[0].properties.fills = [];
  });
  let r;
  try {
    r = await NativeRenderer.create(f.project);
    const pixels = await rgba(r.render(f.state, 0, { transparent: true }).png);
    const at = (x: number, y: number) => [
      ...pixels.slice((y * 200 + x) * 4, (y * 200 + x) * 4 + 4),
    ];
    assert.deepEqual(at(20, 20), [255, 0, 0, 255]);
    assert.deepEqual(at(40, 40), [0, 0, 255, 255]);
    assert.deepEqual(at(105, 25), [0, 255, 0, 255]);
    assert.equal(at(82, 2)[3], 0);
  } finally {
    r?.dispose();
    await f.cleanup();
  }
});
test("native raster assets use original bytes, crop transform and transparency", async () => {
  const f = await fixture();
  try {
    const k = await skia(),
      surface = k.MakeSurface(2, 2)!;
    surface.getCanvas().clear(k.Color4f(1, 0, 0, 0.5));
    const image = surface.makeImageSnapshot(),
      png = image.encodeToBytes()!;
    await writeFile(path.join(f.project.sourceRoot, "assets/pixel.png"), png);
    image.delete();
    surface.delete();
    const doc = JSON.parse(await readFile(f.project.scenePath, "utf8"));
    doc.assets.push({
      assetId: "pixel",
      path: "assets/pixel.png",
      kind: "image",
    });
    const n = node("image", "Image", 20, 20, 80, 80);
    n.parentId = doc.scenes[0].figmaNodeId;
    n.properties.fills = [
      {
        type: "IMAGE",
        assetId: "pixel",
        scaleMode: "CROP",
        imageTransform: [
          [1, 0, 0],
          [0, 1, 0],
        ],
      },
    ];
    doc.scenes[0].children = [n];
    await writeFile(f.project.scenePath, JSON.stringify(doc));
    const project = await loadProject(f.project.root),
      result = await renderNativeFrame(project, f.state, 0, {
        transparent: true,
      }),
      pixels = await rgba(result.png),
      offset = (50 * 320 + 50) * 4;
    assert.ok(pixels[offset] > 250);
    assert.ok(Math.abs(pixels[offset + 3] - 128) <= 1);
    assert.equal(result.stats.images, 1);
  } finally {
    await f.cleanup();
  }
});
test("native gradient trim preserves structured source geometry and source opacity", async () => {
  const f = await identityFixture(1, (ss) => {
    const line = node("line", "Curve", 10, 20, 160, 70);
    line.type = "VECTOR";
    line.properties = {
      width: 160,
      height: 70,
      fills: [],
      vectorPaths: [
        { data: "M0 40 C40 -10 80 90 160 20", windingRule: "NONZERO" },
      ],
      strokeWeight: 8,
      strokeCap: "ROUND",
      strokeJoin: "ROUND",
      strokes: [
        {
          type: "GRADIENT_LINEAR",
          gradientTransform: [
            [1, 0, 0],
            [0, 1, 0],
          ],
          gradientStops: [
            { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
            { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
          ],
        },
      ],
    };
    ss[0].children = [line];
    ss[0].properties.fills = [];
  });
  let r;
  try {
    r = await NativeRenderer.create(f.project);
    const source = JSON.stringify(f.project.inspection.document),
      state = {
        ...f.state,
        animations: [
          {
            animationId: "trim",
            targetId: "line",
            sceneId: "s0",
            startFrame: 0,
            durationFrames: 10,
            easing: "linear" as const,
            enabled: true,
            effect: "trimPath" as const,
            parameters: { from: 0, to: 1, startFrom: 0.1, startTo: 0.1 },
          },
        ],
      },
      result = r.render(state, 5);
    assert.equal(result.paths[0].start, 0.1);
    assert.equal(result.paths[0].end, 0.5);
    assert.ok(result.paths[0].length > 160);
    assert.equal(JSON.stringify(f.project.inspection.document), source);
    const reversed = r.render(
      {
        ...state,
        animations: [
          {
            ...state.animations[0],
            parameters: {
              ...state.animations[0].parameters,
              direction: "reverse" as const,
            },
          },
        ],
      },
      5,
    );
    assert.deepEqual(
      [reversed.paths[0].start, reversed.paths[0].end],
      [0.5, 0.9],
    );
    assert.notDeepEqual(result.png, reversed.png);
  } finally {
    r?.dispose();
    await f.cleanup();
  }
});
test("native cache, cancellation and cleanup do not leave obsolete frame jobs active", async () => {
  const f = await fixture();
  try {
    const a = await renderNativeFrame(f.project, f.state, 0),
      b = await renderNativeFrame(f.project, f.state, 0);
    assert.equal(b.cacheHit, true);
    assert.deepEqual(a.png, b.png);
    const c = new AbortController();
    c.abort();
    await assert.rejects(
      renderNativeFrame(f.project, f.state, 2, { signal: c.signal }),
    );
    assert.equal((await renderNativeFrame(f.project, f.state, 3)).frame, 3);
    for (let i = 0; i < 125; i++)
      await renderNativeFrame(f.project, f.state, i % 12, { encoding: "rgba" });
    const last = await renderNativeFrame(f.project, f.state, 11);
    assert.ok(last.cache.bytes <= 64 * 1024 * 1024);
    assert.ok(last.cache.entries <= 120);
    console.log(
      JSON.stringify({ nativeCache: last.cache, memory: last.memory }),
    );
    await clearNativeCache();
    assert.equal(
      (await renderNativeFrame(f.project, f.state, 0)).cacheHit,
      false,
    );
  } finally {
    await f.cleanup();
  }
});
test("native unsupported paint is explicit; it never falls through to a hidden browser", async () => {
  const f = await fixture();
  try {
    const doc = JSON.parse(await readFile(f.project.scenePath, "utf8"));
    doc.scenes[0].children[0].properties.fills = [{ type: "GRADIENT_DIAMOND" }];
    await writeFile(f.project.scenePath, JSON.stringify(doc));
    await assert.rejects(
      renderNativeFrame(await loadProject(f.project.root), f.state, 0),
      /TEXT_PAINT_UNSUPPORTED/,
    );
  } finally {
    await f.cleanup();
  }
});
test("native frames survive canonical save/reload and packet pixels are exactly export input pixels", async () => {
  const f = await fixture();
  try {
    const doc = await readMotion(f.project),
      changed = await changeMotion(f.project.root, {
        expectedRevision: doc.revision,
        request: "native test",
        operations: [{ type: "addAnimation", animation: slide("block") }],
      });
    const project = await loadProject(f.project.root),
      state = (await readMotion(project)).state;
    assert.deepEqual(state, changed.document.state);
    const frame = await renderProjectFrame(project, 3, {
        encoding: "rgba",
        revision: changed.document.revision,
      }),
      packet = framePacket(frame),
      length = packet.readUInt32BE(0),
      metadata = JSON.parse(packet.subarray(4, 4 + length).toString());
    assert.equal(metadata.renderer, "skia-cpu/1");
    const exportInput = await renderNativeFrame(project, state, 3, {
      encoding: "rgba",
    });
    assert.deepEqual(packet.subarray(4 + length), Buffer.from(exportInput.png));
    const png = await renderNativeFrame(project, state, 3);
    assert.deepEqual(await rgba(png.png), exportInput.png);
    await assert.rejects(
      renderProjectFrame(project, 1, { revision: "stale" }),
      /STALE_PROJECT_REVISION/,
    );
    const before = await readFile(project.scenePath);
    const again = await createProject({
      source: f.source,
      name: "Again",
      projectsRoot: path.join(f.root, "another"),
    });
    assert.deepEqual(
      await readFile((await loadProject(again.projectPath)).scenePath),
      before,
    );
  } finally {
    await f.cleanup();
  }
});
test("native QA checks real trim pixels and text subpixel transport without Chromium", async () => {
  const f = await fixture();
  try {
    const state = { ...f.state, animations: [slide()] },
      qa = await motionQA(
        f.project,
        state,
        "motion/qa/native-test",
        "text slide",
      );
    assert.notEqual(qa.status, "FAILED", JSON.stringify(qa));
    assert.equal(
      (qa as unknown as { renderer: string }).renderer,
      "skia-cpu/1",
    );
    assert.equal(
      qa.checks.find((c) => c.name === "TEXT_RENDERED_SUBPIXEL_TRANSPORT")
        ?.status,
      "PASSED",
    );
    assert.ok(qa.samples.length > 0);
  } finally {
    await f.cleanup();
  }
});
test("native FFmpeg export records exact RGBA input digests from the shared renderer", async () => {
  const f = await fixture();
  try {
    const doc = await readMotion(f.project);
    doc.state = f.state;
    doc.state.animations = [slide("block")];
    await writeFile(
      path.join(f.project.root, "motion/motion.json"),
      JSON.stringify(doc),
    );
    const progress: number[] = [],
      video = await exportVideo(f.project.root, (n) => progress.push(n));
    assert.equal(progress.length, 12);
    const meta = JSON.parse(
      await readFile(
        path.join(f.project.root, "renders", video.file + ".json"),
        "utf8",
      ),
    );
    assert.equal(meta.renderer, "skia-cpu/1");
    assert.equal(meta.inputEncoding, "rgba");
    for (const row of meta.frameDigests) {
      const pixels = await renderNativeFrame(f.project, doc.state, row.frame, {
        encoding: "rgba",
      });
      assert.equal(
        createHash("sha256").update(pixels.png).digest("hex"),
        row.sha256,
      );
    }
    assert.ok(
      (await readFile(path.join(f.project.root, "renders", video.file)))
        .length > 100,
    );
  } finally {
    await f.cleanup();
  }
});
test("native Preview is pixel transport only, with selection and obsolete-request cancellation", () => {
  const html = nativePreviewHtml(
    "/api/projects/test/motion",
    320,
    240,
    "revision",
  );
  assert.ok(html.includes("putImageData"));
  assert.ok(html.includes("motion-select"));
  assert.ok(html.includes("AbortController"));
  assert.ok(!html.includes("foreignObject"));
  assert.ok(!html.includes("evaluateMotion"));
  assert.ok(!html.includes("<svg"));
});

test("native mixed Cyrillic styles, wrapping and vertical alignment retain UTF-16 source ranges", async () => {
  const f = await fixture();
  let renderer;
  try {
    const source = JSON.parse(await readFile(f.project.scenePath, "utf8"));
    const text = source.scenes[0].children[0];
    text.text = {
      ...text.text,
      characters: "Привет мир и ещё слова для переноса",
      textAlignHorizontal: "CENTER",
      textAlignVertical: "BOTTOM",
      segments: [
        {
          start: 0,
          end: 6,
          fontName: { family: "Arial", style: "Bold" },
          fontSize: 24,
          fontWeight: 700,
        },
        {
          start: 6,
          end: 34,
          fontName: { family: "Arial", style: "Regular" },
          fontSize: 20,
          fontWeight: 400,
        },
      ],
    };
    await writeFile(f.project.scenePath, JSON.stringify(source));
    const project = await loadProject(f.project.root);
    renderer = await NativeRenderer.create(project);
    const a = renderer.render(f.state, 0),
      b = renderer.render(f.state, 7);
    assert.ok(a.text[0].lines.length > 1);
    assert.ok(
      a.text[0].lines.every(
        (l) =>
          l.start >= 0 &&
          l.end <= text.text.characters.length &&
          l.width <= 200.01,
      ),
    );
    assert.ok(a.text[0].lines.some((l) => l.x > 0));
    assert.deepEqual(a.text[0].lines, b.text[0].lines);
    assert.ok(a.fonts.every((f) => f.candidateFiles.length > 0));
    assert.deepEqual(a.png, b.png);
  } finally {
    renderer?.dispose();
    await f.cleanup();
  }
});

test("native nested rotated parent keeps source hierarchy and fractional child transforms", async () => {
  const f = await fixture();
  let renderer;
  try {
    const source = JSON.parse(await readFile(f.project.scenePath, "utf8")),
      scene = source.scenes[0],
      child = scene.children[0];
    const parent = node("group", "Rotated", 150, 30, 200, 110);
    parent.type = "GROUP";
    parent.sceneTransform = [
      [0, -1, 150],
      [1, 0, 30],
    ];
    child.sceneTransform = [
      [0, -1, 130.5],
      [1, 0, 40.25],
    ];
    parent.children = [child];
    parent.parentId = scene.figmaNodeId;
    child.parentId = parent.figmaNodeId;
    scene.children = [parent];
    await writeFile(f.project.scenePath, JSON.stringify(source));
    renderer = await NativeRenderer.create(await loadProject(f.project.root));
    const a = renderer.render(f.state, 0, { transparent: true }),
      hit = a.hits.find((h) => h.targetId === "text")!;
    assert.equal(hit.points[0].x, 130.5);
    assert.equal(hit.points[0].y, 40.25);
    assert.equal(hit.points[1].x, 130.5);
    assert.equal(hit.points[1].y, 240.25);
    assert.deepEqual(
      renderer.render(f.state, 0, { transparent: true }).png,
      a.png,
    );
  } finally {
    renderer?.dispose();
    await f.cleanup();
  }
});

test("native reconstruction processes every scene and reports actual SVG fallback provenance", async () => {
  const f = await identityFixture(3);
  try {
    const { reconstructNativeProject } = await import(
      "../src/native/reconstruct.js"
    );
    const output = path.join(f.root, "native-validation");
    await mkdir(path.join(output, "reconstructed"), { recursive: true });
    const result = await reconstructNativeProject(f.project, output);
    assert.equal(result.size, 3);
    for (const row of result.values()) {
      assert.equal(row.error, undefined);
      assert.ok((await readFile(path.join(output, row.png))).length > 100);
    }
    assert.deepEqual(result.get("s1")!.stats.svgFallbacks, ["qr1"]);
    assert.deepEqual(result.get("s2")!.stats.svgFallbacks, ["qr2"]);
    assert.ok(
      result.get("s1")!.stats.warnings.some((w) => w.includes("resvg")),
    );
  } finally {
    await f.cleanup();
  }
});

test("native FontWeight uses actual Skia enum faces: bold changes glyph pixels, not just metadata", async () => {
  const f = await fixture();
  const renderers: NativeRenderer[] = [];
  try {
    const masses = [];
    for (const weight of [400, 700]) {
      const project = structuredClone(f.project),
        text = project.inspection.document.scenes[0].children[0] as {text: Record<string,unknown>};
      Object.assign(text.text!, {
        fontWeight: weight,
        fontName: {
          family: "Arial",
          style: weight === 700 ? "Bold" : "Regular",
        },
      });
      const renderer = await NativeRenderer.create(project);
      renderers.push(renderer);
      const pixels = await rgba(
        renderer.render(f.state, 0, { transparent: true }).png,
      );
      let mass = 0;
      for (let i = 3; i < pixels.length; i += 4) mass += pixels[i];
      masses.push(mass);
    }
    assert.ok(
      masses[1] > masses[0] * 1.1,
      JSON.stringify({ regular: masses[0], bold: masses[1] }),
    );
  } finally {
    for (const r of renderers) r.dispose();
    await f.cleanup();
  }
});

test("native SVG asset decoding rejects external relative file references", async () => {
  const f = await identityFixture(2);
  try {
    await writeFile(
      path.join(f.project.sourceRoot, "assets/qr.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><image href="../../private.png" width="20" height="20"/></svg>',
    );
    await assert.rejects(
      NativeRenderer.create(await loadProject(f.project.root)),
      /SVG_EXTERNAL_OR_HTML_UNSUPPORTED/,
    );
  } finally {
    await f.cleanup();
  }
});

test("segmented local entrance and offscreen exit share typography while the exit moves outward and fades", async()=>{
 const f=await fixture();
 try{
  const {applyOperations}=await import('../src/motion/operations.js');
  const base={...f.state,settings:{...f.state.settings,width:320,height:240,durationFrames:48},blocks:f.state.blocks.map(b=>({...b,durationFrames:48}))};
  const entry={...slide('line'),durationFrames:12,text:{...slide('line').text!,timing:'staggered' as const,staggerFrames:3}};
  const exit={...entry,animationId:'exit',effect:'slideLeft' as const,startFrame:24,parameters:{distance:100,mode:'out' as const},text:{...entry.text!,origin:'outsideViewport' as const}};
  const fade={...entry,animationId:'fade',effect:'fadeIn' as const,parameters:{from:0,to:1}};
  const fadeOut={...exit,animationId:'fade-out',effect:'fadeOut' as const,parameters:{from:1,to:0}};
  const state=applyOperations(base,[{type:'addAnimation',animation:entry},{type:'addAnimation',animation:fade},{type:'addAnimation',animation:exit},{type:'addAnimation',animation:fadeOut}],f.project);
  const settled=await renderNativeFrame(f.project,state,12),start=await renderNativeFrame(f.project,state,24),middle=await renderNativeFrame(f.project,state,30),end=await renderNativeFrame(f.project,state,36);
  assert.deepEqual(start.png,settled.png,'exit holds the settled pose until its start');
  assert.ok(middle.text[0].offsets.every(o=>o.x<0&&o.y===0&&o.opacity>0&&o.opacity<1));
  assert.notEqual(middle.text[0].offsets[0].opacity,middle.text[0].offsets[1].opacity,"line stagger is evaluated per unit during exit");
  assert.ok(end.text[0].offsets.every(o=>o.opacity===0));
  end.text[0].lines.forEach((line,i)=>assert.ok(45.25+line.x+line.width+end.text[0].offsets[i].x<0,'each shaped line clears the left viewport edge'));
  assert.deepEqual((await renderNativeFrame(f.project,state,24)).png,start.png,'random seeking does not retain exit transforms');
  assert.throws(()=>applyOperations(state,[{type:'updateAnimation',animationId:'exit',animation:{...exit,text:{...exit.text,origin:'masked'}}}],f.project),/TEXT_SEGMENT_SETTINGS_CONFLICT/);
  assert.throws(()=>applyOperations(state,[{type:'updateAnimation',animationId:'exit',animation:{...exit,text:{...exit.text,segmentation:'word'}}}],f.project),/TEXT_SEGMENT_SETTINGS_CONFLICT/);
  const reversed=applyOperations(state,[{type:'updateAnimation',animationId:'exit',animation:{...exit,text:{...exit.text,reverse:true,staggerFrames:2}}},{type:'updateAnimation',animationId:'fade-out',animation:{...fadeOut,text:{...fadeOut.text,reverse:true,staggerFrames:2}}}],f.project);
  const reversedMiddle=await renderNativeFrame(f.project,reversed,27);
  assert.ok(reversedMiddle.text[0].offsets[0].opacity>reversedMiddle.text[0].offsets.at(-1)!.opacity,'exit may reverse line order independently from entrance');
  assert.ok((await renderNativeFrame(f.project,reversed,36)).text[0].offsets.every(o=>o.opacity===0));
  const saved=await readMotion(f.project);await changeMotion(f.project.root,{expectedRevision:saved.revision,request:'line entrance and exit',operations:[{type:'setProjectSettings',settings:state.settings},{type:'setBlocks',blocks:state.blocks},...state.animations.map(animation=>({type:'addAnimation' as const,animation}))]});
  const video=await exportVideo(f.project.root,()=>{},{renderer:'native'});assert.ok('frameDigests' in video);
  assert.equal(video.frameDigests.find(d=>d.frame===24)?.sha256,createHash('sha256').update((await renderProjectFrame(f.project,24,{encoding:'rgba'})).png).digest('hex'));
 }finally{await closeNativeRenderer();await f.cleanup();}
});
