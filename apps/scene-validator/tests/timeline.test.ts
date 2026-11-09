import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { identityFixture } from "./identity-fixture.js";
import { servePlatform } from "../src/platform-server.js";
import path from "node:path";

test("timeline hover stays fixed; captured click/drag syncs preview, clamps, releases and has exact tick dimensions", async () => {
  const f = await identityFixture(),
    server = await servePlatform(path.dirname(f.project.root), 0),
    browser = await chromium.launch();
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const page = await browser.newPage({
      viewport: { width: 1400, height: 950 },
    });
    await page.goto(
      `http://127.0.0.1:${address.port}/#project/${f.project.config.projectId}`,
    );
    const track = page.locator("#m-timeline");
    await track.waitFor();
    const preview = page.frameLocator("#m-preview");
    await preview.locator("svg").first().waitFor({state:"attached"});
    await preview.locator("body").evaluate(() => {
      window.addEventListener("message", event => {
        if(event.data?.type === "motion-frame") document.body.dataset.lastSeek = String(event.data.frame);
      });
    });
    const box = (await track.boundingBox())!;
    const frame = () => page.locator("#m-frame").inputValue();
    await page.mouse.move(box.x + box.width * 0.7, box.y + 15);
    assert.equal(await frame(), "0");
    await page.mouse.down();
    assert.ok(Number(await frame()) > 0);
    await page.mouse.move(box.x + box.width * 0.3, box.y + 15);
    const middle = await frame();
    assert.ok(Number(middle) > 0);
    await page.waitForTimeout(50);
    assert.equal(await preview.locator("body").getAttribute("data-last-seek"),middle);
    const last = Number(await track.getAttribute("aria-valuemax"));
    await page.mouse.move(box.x + box.width + 40, box.y - 20);
    assert.equal(Number(await frame()), last);
    await page.mouse.move(box.x - 40, box.y - 20);
    assert.equal(await frame(), "0");
    await page.mouse.move(box.x + box.width * 0.5, box.y + 15);
    await page.mouse.up();
    const held = await frame();
    await page.mouse.move(box.x + box.width * 0.9, box.y + 15);
    assert.equal(await frame(), held);
    await track.focus();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(()=>[...document.querySelectorAll<HTMLElement>(".timeline-bar")].every(el=>Math.abs(el.getBoundingClientRect().height-parseFloat(el.style.height))<.01));
    const ticks = await track.locator(".timeline-bar").evaluateAll((elements) =>
      elements.map((el) => {
        const r = el.getBoundingClientRect();
        return { height: r.height, width: r.width, x: r.x, bottom: r.bottom };
      }),
    );
    assert.deepEqual(
      [...new Set(ticks.map((t) => t.height))].sort((a, b) => a - b),
      [6, 10, 14, 20, 26],
    );
    ticks.forEach((t) => {
      assert.equal(t.width, 2);
      assert.equal(t.bottom, ticks[0].bottom);
    });
    for (let i = 1; i < ticks.length; i++)
      assert.equal(ticks[i].x - ticks[i - 1].x, 10);
    await page.setViewportSize({ width: 800, height: 800 });
    await page.waitForTimeout(100);
    await track.focus();
    await page.keyboard.press("End");
    assert.equal(Number(await frame()), last);
    await page.locator("#m-play").click();
    await page.waitForFunction(
      () => document.querySelector("#m-play")?.textContent === "Пауза",
    );
    await page.locator("#m-play").click();
    for(const fps of [24,60]){
      await page.locator("#m-open-settings").click();
      await page.locator("#m-fps").fill(String(fps));
      await page.locator("#m-seconds").fill("30");
      await page.locator("#m-settings").click();
      await page.waitForFunction(expected => document.querySelector("#m-timeline")?.getAttribute("aria-valuemax") === String(expected),fps*30-1);
      await page.locator("#m-close-settings").click();
      await track.focus(); await page.keyboard.press("End");
      assert.equal(Number(await frame()),fps*30-1);
      assert.ok((await page.locator("#m-time").textContent())?.includes("30.00"));
    }
  } finally {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
    await f.cleanup();
  }
});
