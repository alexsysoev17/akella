import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
/** Compare RGBA after compositing over white; hidden RGB of transparent pixels is irrelevant. */
export function comparePixels(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  threshold = 8,
) {
  if (a.length !== b.length || a.length % 4)
    throw new Error("Pixel dimensions differ");
  let changedPixels = 0,
    sum = 0;
  const difference = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i += 4) {
    let maximum = 0;
    for (let c = 0; c < 3; c++) {
      const delta = Math.abs(
        (a[i + c] * a[i + 3]) / 255 +
          255 -
          a[i + 3] -
          ((b[i + c] * b[i + 3]) / 255 + 255 - b[i + 3]),
      );
      maximum = Math.max(maximum, delta);
      sum += delta;
    }
    if (maximum > threshold) changedPixels++;
    difference.set([Math.round(maximum), 0, Math.round(maximum), 255], i);
  }
  const totalPixels = a.length / 4;
  return {
    difference,
    metrics: {
      changedPixels,
      totalPixels,
      changedPercent: totalPixels ? (changedPixels / totalPixels) * 100 : 0,
      meanAbsoluteError: totalPixels ? sum / (totalPixels * 3) : 0,
      threshold,
    },
  };
}
export async function comparePngs(
  original: string,
  reconstructed: string,
  output: string,
) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const data = await page.evaluate(
      async (sources) => {
        return Promise.all(
          sources.map(async (source: string) => {
            const image = new Image();
            image.src = source;
            await image.decode();
            if (image.width * image.height > 32_000_000)
              throw new Error("Comparison exceeds 32 megapixel limit");
            const canvas = document.createElement("canvas");
            canvas.width = image.width;
            canvas.height = image.height;
            const ctx = canvas.getContext("2d")!;
            ctx.drawImage(image, 0, 0);
            const bytes = ctx.getImageData(
              0,
              0,
              image.width,
              image.height,
            ).data;
            let binary = "";
            for (let i = 0; i < bytes.length; i += 32768)
              binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
            return {
              width: image.width,
              height: image.height,
              pixels: btoa(binary),
            };
          }),
        );
      },
      await Promise.all(
        [original, reconstructed].map(
          async (f) =>
            "data:image/png;base64," + (await readFile(f)).toString("base64"),
        ),
      ),
    );
    if (data[0].width !== data[1].width || data[0].height !== data[1].height)
      throw new Error("Original and reconstruction dimensions differ");
    const result = comparePixels(
      Buffer.from(data[0].pixels, "base64"),
      Buffer.from(data[1].pixels, "base64"),
    );
    const png = await page.evaluate(
      ({ width, height, pixels }) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d")!.putImageData(
          new ImageData(
            Uint8ClampedArray.from(atob(pixels), (c) => c.charCodeAt(0)),
            width,
            height,
          ),
          0,
          0,
        );
        return canvas.toDataURL("image/png").split(",")[1];
      },
      {
        width: data[0].width,
        height: data[0].height,
        pixels: Buffer.from(result.difference).toString("base64"),
      },
    );
    await writeFile(output, Buffer.from(png, "base64"));
    return result.metrics;
  } finally {
    await browser.close();
  }
}
