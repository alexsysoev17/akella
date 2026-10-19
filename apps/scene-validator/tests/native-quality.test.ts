import test, { after } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { identityFixture, node } from "./identity-fixture.js";
import { skia, makeSurface, nativeMemory } from "../src/native/skia.js";
import { NativeRenderer } from "../src/native/renderer.js";
import { closeNativeRenderer } from "../src/native/client.js";
import { nativePreviewHtml } from "../src/native/preview.js";
import { chromium, webkit } from "playwright";
after(() => closeNativeRenderer());
async function rasterFixture(alpha = false) {
  const k = await skia(),
    s = makeSurface(k, 256, 256),
    c = s.getCanvas(),
    brush = new k.Paint();
  c.clear(k.TRANSPARENT);
  brush.setAntiAlias(true);
  if (alpha) {
    brush.setColor(k.WHITE);
    c.drawCircle(128.3, 128.6, 105.7, brush);
  } else {
    for (let y = 0; y < 256; y++)
      for (let x = 0; x < 256; x++) {
        brush.setColor((x + y) % 2 ? k.WHITE : k.BLACK);
        c.drawRect(k.XYWHRect(x, y, 1, 1), brush);
      }
  }
  const im = s.makeImageSnapshot(),
    bytes = im.encodeToBytes()!;
  im.delete();
  brush.delete();
  s.dispose();
  const f = await identityFixture(1, (ss) => {
    ss[0].properties.fills = [];
    const n = node("photo", "PNG", 40.25, 30.75, 27, 27);
    if (alpha)
      n.sceneTransform = [
        [0.866, -0.5, 85.25],
        [0.5, 0.866, 30.75],
      ];
    ss[0].children = [n];
  });
  const target = f.project.inspection.document.scenes[0].children[0] as unknown as ReturnType<typeof node>;
  target.properties.fills = [
    { type: "IMAGE", assetId: "photo", scaleMode: "FIT" },
  ];
  const file = path.join(
    path.dirname(f.project.scenePath),
    "assets/quality.png",
  );
  await writeFile(file, bytes);
  f.project.inspection.document.assets.push({
    ...f.project.inspection.document.assets[0],
    assetId: "photo",
    path: "assets/quality.png",
    kind: "image",
  });
  return f;
}
test("native minification averages fine detail instead of aliasing; PNG alpha stays premultiplied and surfaces are released", async () => {
  for (const alpha of [false, true]) {
    const f = await rasterFixture(alpha);
    const r = await NativeRenderer.create(f.project);
    try {
      const out = r.render(f.state, 0, { encoding: "rgba", transparent: true });
      let count = 0,
        total = 0;
      for (let y = 0; y < out.height; y++)
        for (let x = 0; x < out.width; x++) {
          const i = (y * out.width + x) * 4,
            a = out.png[i + 3];
          if (alpha && a > 20 && a < 235) {
            count++;
            assert.ok(
              out.png[i] > 245 && out.png[i + 1] > 245 && out.png[i + 2] > 245,
              `white transparent edge must not have dark fringes: ${[...out.png.slice(i, i + 4)]}`,
            );
          }
          if (!alpha && x >= 44 && x < 61 && y >= 34 && y < 51) {
            count++;
            total += Math.abs(out.png[i] - 128);
          }
        }
      assert.ok(count > 10);
      if (!alpha)
        assert.ok(total / count < 4, `checker alias error ${total / count}`);
      const surface=makeSurface(r.kit,8,8), snapshot=surface.makeImageSnapshot();
      try { assert.equal(snapshot.getImageInfo().alphaType, r.kit.AlphaType.Premul); }
      finally { snapshot.delete(); surface.dispose(); }
      assert.equal(nativeMemory(r.kit).live, 0);
      assert.deepEqual(
        r.render(f.state, 0, { encoding: "rgba", transparent: true }).png,
        out.png,
      );
    } finally {
      r.dispose();
      await f.cleanup();
    }
  }
});
test("native text and fractional curved vector strokes have real partial coverage without changing layout during seek", async () => {
  const f = await identityFixture(1, (ss) => {
    ss[0].properties.fills = [];
    const t = node("text", "Text", 3.25, 4.75, 180, 65);
    t.type = "TEXT";
    t.text = {
      characters: "Smooth Ag\nSmall type",
      fontName: { family: "Arial", style: "Regular" },
      fontSize: 22,
    };
    t.properties.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
    const v = node("curve", "Curve", 15.25, 90.75, 130, 20);
    v.type = "VECTOR";
    v.properties = {
      ...v.properties,
      fills: [],
      strokes: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }],
      strokeWeight: 1,
      strokeCap: "ROUND",
      vectorPaths: [
        { data: "M0 0 C20 -20 80 30 130 0", windingRule: "NONZERO" },
      ],
    };
    ss[0].children = [t, v];
  });
  const r = await NativeRenderer.create(f.project);
  try {
    const a = r.render(f.state, 0, { encoding: "rgba", transparent: true });
    let partial = 0,
      solid = 0;
    for (let i = 3; i < a.png.length; i += 4) {
      if (a.png[i] > 0 && a.png[i] < 255) partial++;
      if (a.png[i] === 255) solid++;
    }
    assert.ok(partial > 100);
    assert.ok(solid > 100);
    r.render(f.state, 5);
    const b = r.render(f.state, 0, { encoding: "rgba", transparent: true });
    assert.deepEqual(a.png, b.png);
    assert.deepEqual(a.text, b.text);
    assert.equal(a.width, 200);
    assert.equal(a.height, 120);
  } finally {
    r.dispose();
    await f.cleanup();
  }
});
test("native preview downsamples only display pixels with high-quality filtering and DPR-aware backing store", async () => {
  for (const launcher of [chromium, webkit]) {
    const browser = await launcher.launch();
    try {
      const page = await browser.newPage({
        viewport: { width: 400, height: 300 },
        deviceScaleFactor: 2,
      });
      await page.route("**/frame?**", (route) => {
        const metadata = Buffer.from(
            JSON.stringify({
              width: 1920,
              height: 1080,
              renderer: "skia-cpu/1",
              warnings: [],
              hits: [],
            }),
          ),
          header = Buffer.alloc(4);
        header.writeUInt32BE(metadata.length);
        return route.fulfill({
          body: Buffer.concat([
            header,
            metadata,
            Buffer.alloc(1920 * 1080 * 4, 255),
          ]),
          contentType: "application/octet-stream",
        });
      });
      await page.route("http://quality.test/", (route) =>
        route.fulfill({
          body: nativePreviewHtml("http://quality.test", 1920, 1080, "fixture"),
          contentType: "text/html",
        }),
      );
      await page.goto("http://quality.test/");
      await page.waitForSelector('body[data-rendered-frame="0"]');
      const first = await page.locator("canvas").evaluate((el) => {
        const c = el as HTMLCanvasElement,
          ctx = c.getContext("2d")!;
        return {
          width: c.width,
          height: c.height,
          smooth: ctx.imageSmoothingEnabled,
          quality: ctx.imageSmoothingQuality,
          source: document.body.dataset.sourceSize,
        };
      });
      assert.deepEqual(first, {
        width: 800,
        height: 450,
        smooth: true,
        quality: "high",
        source: "1920x1080",
      });
      await page.setViewportSize({ width: 600, height: 400 });
      await page.waitForFunction(
        () => document.querySelector("canvas")?.width === 1200,
      );
      assert.equal(
        await page
          .locator("canvas")
          .evaluate((el) => (el as HTMLCanvasElement).height),
        675,
      );
    } finally {
      await browser.close();
    }
  }
});
