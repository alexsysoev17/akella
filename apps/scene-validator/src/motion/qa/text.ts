import type { Page } from "playwright";
export const TEXT_TRANSPORT_TOLERANCE = 0.125;
/** Alpha moments distinguish intentional translation from glyph baseline pixel snapping. */
export async function textRasterQA(
  page: Page,
  targetId: string,
  sceneId: string,
  unitIndex = 0,
  legacy = false,
  beforeRender?: () => void,
) {
  const probe = await page.evaluate((o) => window.motionTextProbe("start", o), {
    targetId,
    sceneId,
    unitIndex,
    legacy,
  });
  if (!probe)
    return { status: "NOT_TESTED" as const, reason: "No rendered text unit" };
  const viewport = page.viewportSize()!;
  try {
    if (probe.width > viewport.width || probe.height > viewport.height)
      return {
        status: "NOT_TESTED" as const,
        reason: "Local probe exceeds viewport; no cropped success reported",
      };
    const samples = [];
    for (const offset of [0, 0.25, 0.375, 0.5, 0.625, 0.75, -0.25]) {
      await page.evaluate(
        (y) => window.motionTextProbe("offset", { y }),
        offset,
      );
      beforeRender?.();
      const png = await page.screenshot({
        omitBackground: true,
        clip: { x: 0, y: 0, width: probe.width, height: probe.height },
      });
      const moment = await page.evaluate(
        async (src) => {
          const image = new Image();
          image.src = src;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(image, 0, 0);
          const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
          let mass = 0,
            x = 0,
            y = 0;
          for (let i = 3; i < pixels.length; i += 4) {
            const a = pixels[i] / 255,
              p = (i - 3) / 4;
            mass += a;
            x += (p % image.width) * a;
            y += Math.floor(p / image.width) * a;
          }
          return {
            mass,
            x: x / mass,
            y: y / mass,
            width: image.width,
            height: image.height,
          };
        },
        "data:image/png;base64," + png.toString("base64"),
      );
      samples.push({
        offset,
        ...moment,
        x: moment.x / (moment.width / probe.width),
        y: moment.y / (moment.height / probe.height),
        pixelRatio: moment.height / probe.height,
      });
    }
    const first = samples[0];
    if (!(first.mass > 0))
      return {
        status: "NOT_TESTED" as const,
        reason: "Probe has no visible glyph alpha",
      };
    const errors = samples.map((s) => Math.abs(s.y - first.y - s.offset)),
      maximumError = Math.max(...errors);
    return {
      status:
        maximumError <= TEXT_TRANSPORT_TOLERANCE
          ? ("PASSED" as const)
          : ("FAILED" as const),
      reason:
        "Actual alpha-centroid transport versus fractional offsets; local renderer test, not artistic approval",
      metrics: {
        maximumError,
        tolerance: TEXT_TRANSPORT_TOLERANCE,
        samples,
        renderer: probe.renderer,
      },
    };
  } finally {
    await page.evaluate(() => window.motionTextProbe("stop"));
  }
}
