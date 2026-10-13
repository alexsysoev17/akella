import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { identityFixture } from "./identity-fixture.js";
import { logicalId } from "../src/motion/registry.js";
import { validateMentions } from "../src/motion/mentions.js";
import { resolveTarget } from "../src/motion/autonomy.js";
import { servePlatform } from "../src/platform-server.js";
import { proposeMotion } from "../src/motion/service.js";
import { readMotion } from "../src/motion/store.js";
import { readFile } from "node:fs/promises";
import path from "node:path";

test("mentions validate exact registry instances across scenes and override selection; stale references reject", async () => {
  const f = await identityFixture();
  try {
    const mention = {
      displayName: "QR",
      logicalObjectId: logicalId("QR"),
      sceneId: "s1",
      sourceNodeId: "qr1",
      start: 0,
      end: 2,
    };
    const accepted = validateMentions(f.project, "QR растёт", [mention]);
    assert.equal(
      resolveTarget(
        f.project,
        f.state,
        {
          request: "QR растёт",
          mentions: accepted,
          selectedObjectId: "qr2",
          selectedSceneId: "s2",
        },
        [],
      ).target.targetId,
      "qr1",
    );
    assert.equal(
      validateMentions(f.project, "QR", [
        { ...mention, sceneId: "s2", sourceNodeId: "qr2" },
      ])[0].logicalObjectId,
      mention.logicalObjectId,
    );
    assert.throws(() => validateMentions(f.project, "QQ", [mention]));
    assert.throws(() =>
      validateMentions(f.project, "QR", [
        { ...mention, sourceNodeId: "missing" },
      ]),
    );
    const doc = await readMotion(f.project);
    await proposeMotion(f.project, {
      mode: "create",
      request: "QR растёт",
      mentions: [mention],
      expectedRevision: doc.revision,
      settings: { provider: "manual-response", model: "" },
    });
    const { readdir } = await import("node:fs/promises");
    const dirs = await readdir(path.join(f.project.root, "motion/ai"), {
      withFileTypes: true,
    });
    const dir = dirs.find((d) => d.isDirectory())!;
    const context = JSON.parse(
      await readFile(
        path.join(f.project.root, "motion/ai", dir.name, "context.json"),
        "utf8",
      ),
    );
    assert.deepEqual(context.mentions, [mention]);
    assert.equal(context.runtimeTarget.targetId, "qr1");
  } finally {
    await f.cleanup();
  }
});

test("native prompt ghost, middle insertion, multiple references, edits, undo/redo, escape, IME and paste", async () => {
  const f = await identityFixture(),
    server = await servePlatform(path.dirname(f.project.root), 0),
    browser = await chromium.launch();
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const page = await browser.newPage();
    await page.goto("http://127.0.0.1:" + address.port);
    await page.evaluate(async () => {
      document.body.innerHTML =
        '<div style="position:relative;width:300px"><textarea id="prompt" style="width:300px;height:150px"></textarea></div>';
      const { attachMentions } = await import(String("/mentions.js"));
      const w = window as any;
      w.editor = attachMentions(document.querySelector("textarea"));
      w.suggest = (name = "QR", id = "qr1") =>
        w.editor.suggest({
          name,
          type: "RECTANGLE",
          logicalObjectId: "object_" + name,
          sceneId: "s1",
          targetId: id,
        });
    });
    const input = page.locator("#prompt");
    await page.evaluate("suggest()");
    assert.equal(await input.inputValue(), "");
    assert.equal(await page.locator(".ghost-name").textContent(), "QR");
    await input.press("Space");
    assert.equal(await input.inputValue(), "QR ");
    await input.pressSequentially("растёт, а ");
    await page.evaluate("suggest('Телефон <&>','phone')");
    await input.press("Space");
    assert.equal(
      ((await page.evaluate("editor.references()")) as any[]).length,
      2,
    );
    await input.press("Escape");
    await input.press("Space");
    assert.ok((await input.inputValue()).endsWith("  "));
    await page.evaluate("suggest('Cancel')");
    await input.press("Escape");
    assert.equal(await page.locator(".prompt-ghost").isHidden(), true);
    await input.evaluate((el: HTMLTextAreaElement) =>
      el.setSelectionRange(0, 2),
    );
    await input.press("Backspace");
    assert.equal(
      ((await page.evaluate("editor.references()")) as any[]).length,
      1,
    );
    await input.press("ControlOrMeta+z");
    assert.equal(
      ((await page.evaluate("editor.references()")) as any[]).length,
      2,
    );
    await input.press("ControlOrMeta+Shift+z");
    assert.equal(
      ((await page.evaluate("editor.references()")) as any[]).length,
      1,
    );
    await input.fill("Сделай так, чтобы конец");
    await input.evaluate((el: HTMLTextAreaElement) =>
      el.setSelectionRange(18, 18),
    );
    await page.evaluate("suggest()");
    await input.press("Space");
    assert.equal(await input.inputValue(), "Сделай так, чтобы QR конец");
    await input.press("ControlOrMeta+z");
    assert.equal(await input.inputValue(), "Сделай так, чтобы конец");
    assert.equal(
      ((await page.evaluate("editor.references()")) as any[]).length,
      0,
    );
    await input.press("ControlOrMeta+Shift+z");
    assert.equal(
      ((await page.evaluate("editor.references()")) as any[]).length,
      1,
    );
    await page.evaluate("suggest('IME')");
    await input.dispatchEvent("compositionstart");
    assert.equal(await page.locator(".prompt-ghost").isHidden(), true);
    await input.dispatchEvent("compositionend");
    await input.press("Shift+Enter");
    assert.ok((await input.inputValue()).includes("\n"));
    const long = "длинный текст ".repeat(100);
    await input.fill(long);
    await page.evaluate("suggest('Имя с пробелами <&>')");
    await input.press("Space");
    assert.equal(await input.inputValue(), long + "Имя с пробелами <&> ");
    await input.evaluate((el: HTMLTextAreaElement) => {
      el.select();
      document.execCommand("insertText", false, "Вставка");
    });
    assert.deepEqual(await page.evaluate("editor.references()"), []);
  } finally {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
    await f.cleanup();
  }
});

test("viewport click → ghost → Space → structured request → fixture animation → autoplay", async () => {
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
    await page.locator("#m-open-settings").click();
    await page.locator("#m-provider").selectOption("manual-response");
    await page.locator("#m-close-settings").click();
    await page.locator('[data-scene-button="s1"]').click();
    await page
      .frameLocator("#m-preview")
      .locator('[data-motion-target="qr1"]')
      .click();
    await page.locator(".ghost-name").waitFor();
    assert.equal(await page.locator(".ghost-name").textContent(), "QR");
    assert.equal(await page.locator("#m-ai").inputValue(), "");
    await page.keyboard.press("Space");
    await page.keyboard.type("увеличивается");
    const sent = page.waitForRequest(
      (r) => r.url().endsWith("/execute") && r.method() === "POST",
    );
    await page.keyboard.press("Enter");
    const body = (await sent).postDataJSON();
    assert.equal(body.request, "QR увеличивается");
    assert.equal(body.mentions[0].logicalObjectId, logicalId("QR"));
    assert.equal(body.mentions[0].sourceNodeId, "qr1");
    await page.locator("#m-manual").waitFor({ state: "visible" });
    await page.locator("#m-manual-response").fill(
      JSON.stringify({
        summary: "Synthetic mention workflow",
        questions: [],
        warnings: [],
        operations: [
          {
            type: "addAnimation",
            animation: {
              animationId: "mention-scale",
              sceneId: "s1",
              targetId: "qr1",
              effect: "scaleIn",
              parameters: { from: 0.5, to: 1 },
              startFrame: 0,
              durationFrames: 12,
              easing: "easeOutCubic",
              enabled: true,
            },
          },
        ],
      }),
    );
    await page.locator("#m-read-response").click();
    await page.waitForFunction(
      () => document.querySelector("#m-play")?.textContent === "❚❚ Пауза",
    );
    assert.equal(
      (await readMotion(f.project)).state.animations[0].targetId,
      "qr1",
    );
  } finally {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
    await f.cleanup();
  }
});
