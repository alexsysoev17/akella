import test from "node:test";
import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { identityFixture, node } from "./identity-fixture.js";
import { servePlatform } from "../src/platform-server.js";
import {
  closeNativeRenderer,
  renderNativeFrame,
} from "../src/native/client.js";
import { readMotion } from "../src/motion/store.js";
import path from "node:path";
process.env.AKELLA_RENDERER = "native";
test("native HTTP frames, sequence jobs and cross-browser Preview preserve the production UI workflow", async () => {
  const f = await identityFixture(15, (ss) => {
      const t = node("text", "Headline", 20, 30, 160, 75);
      t.type = "TEXT";
      t.text = {
        characters: "Native\nFrame",
        fontName: { family: "Arial", style: "Regular" },
        fontSize: 22,
      };
      t.properties.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
      ss[0].children = [t];
    }),
    server = await servePlatform(path.dirname(f.project.root), 0),
    address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`,
    base = origin + `/api/projects/${f.project.config.projectId}/motion`;
  try {
    const response = await fetch(base + "/frame?frame=0"),
      png = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-akella-renderer"), "skia-cpu/1");
    assert.deepEqual(
      png,
      Buffer.from(
        (
          await renderNativeFrame(
            f.project,
            (await readMotion(f.project)).state,
            0,
          )
        ).png,
      ),
    );
    const thumbnails = await Promise.all(
      f.project.inspection.document.scenes.map((scene) =>
        fetch(base + "/thumbnail/" + encodeURIComponent(scene.sceneId)),
      ),
    );
    for (const thumbnail of thumbnails) {
      assert.equal(thumbnail.status, 200, await thumbnail.clone().text());
      assert.equal(thumbnail.headers.get("x-akella-renderer"), "skia-cpu/1");
    }
    const invalid = await fetch(base + "/frame?frame=-1");
    assert.notEqual(invalid.status, 200);
    const seq = await fetch(base + "/render-sequence", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ frames: [0, 1, 2] }),
    });
    assert.equal(seq.status, 202);
    const job = await seq.json();
    let status;
    for (let i = 0; i < 100; i++) {
      status = await (await fetch(base + "/jobs/" + job.jobId)).json();
      if (status.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(status.status, "completed", JSON.stringify(status));
    for (const [engine, launcher] of Object.entries({ chromium, webkit })) {
      const browser = await launcher.launch();
      try {
        const page = await browser.newPage({
          viewport: { width: 1200, height: 850 },
        });
        await page.goto(origin + `/#project/${f.project.config.projectId}`);
        const preview = page.frameLocator("#m-preview");
        await preview
          .locator('body[data-native-renderer="skia-cpu/1"]')
          .waitFor({ timeout: 20000 });
        assert.equal(await preview.locator("foreignObject,svg").count(), 0);
        assert.equal(await preview.locator("canvas#native-frame").count(), 1);
        const iframe = page
          .frames()
          .find((fr) => fr.url().includes("/motion/preview"))!;
        await page.locator('#m-preview-quality').selectOption('full');
        await iframe.evaluate(() => window.motionFrame(4));
        await preview.locator('body[data-rendered-frame="4"][data-preview-scale="1"]').waitFor();
        const pixels = await preview
          .locator("canvas")
          .evaluate((el) => [
            ...(el as HTMLCanvasElement)
              .getContext("2d")!
              .getImageData(0, 0, 200, 120).data,
          ]);
        const raw = await renderNativeFrame(
          f.project,
          (await readMotion(f.project)).state,
          4,
          { encoding: "rgba" },
        );
        assert.deepEqual(
          Uint8Array.from(pixels),
          raw.png,
          engine + " performs only exact RGBA blit",
        );
        const box = (await page.locator("#m-timeline").boundingBox())!;
        await page.mouse.click(box.x + box.width * 0.6, box.y + 12);
        assert.ok(Number(await page.locator("#m-frame").inputValue()) > 0);
        await page.locator("#m-play").click();
        await page.locator("#m-play").click();
        assert.ok(await page.locator("#m-render").isEnabled());
      } finally {
        await browser.close();
      }
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeNativeRenderer();
    await f.cleanup();
  }
});
