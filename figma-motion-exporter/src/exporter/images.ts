import { rethrowAbort } from "./errors";
import type { Json, Report } from "../types/scene";
import { AssetRegistry } from "./assets";
import { detectFormat } from "./formats";
import { safeId, toJson } from "./serialization";
export async function exportPaints(
  paints: readonly Paint[] | symbol,
  registry: AssetRegistry,
  report: Report,
  nodeId: string,
): Promise<Json> {
  if (typeof paints === "symbol") return { mixed: true };
  const result: Json[] = [];
  for (const paint of paints) {
    const value = toJson(paint) as Record<string, Json>;
    if (paint.type === "IMAGE") {
      value.clipping = {
        ownerNodeId: nodeId,
        geometry: "owner-node",
        ancestorClipping: "see hierarchy",
      };
      if (paint.imageHash) {
        const hash = paint.imageHash;
        const asset = await registry.once(`image:${hash}`, async () => {
          try {
            const image = figma.getImageByHash(hash);
            if (!image) throw new Error("Image hash cannot be resolved");
            const bytes = await image.getBytesAsync();
            const format = detectFormat(bytes);
            const id = `image_${safeId(hash)}`;
            return await registry.add(
              {
                assetId: id,
                kind: "image",
                path: `assets/images/${id}.${format.extension}`,
                mimeType: format.mimeType,
                byteLength: bytes.length,
                imageHash: hash,
              },
              bytes,
            );
          } catch (error) {
            rethrowAbort(error);
            report.errors.push({
              code: "IMAGE_EXTRACTION_FAILED",
              message: String(error),
              figmaNodeId: nodeId,
              property: hash,
            });
            return undefined;
          }
        });
        if (asset) value.assetId = asset.assetId;
        else value.assetStatus = "missing";
      } else {
        value.assetStatus = "missing";
        report.errors.push({
          code: "EMPTY_IMAGE_HASH",
          message: "Image paint has no imageHash",
          figmaNodeId: nodeId,
        });
      }
    }
    result.push(value);
  }
  return result;
}
