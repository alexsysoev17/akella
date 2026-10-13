import { rethrowAbort } from "./errors";
import type { ExportNode, Json, Matrix, Report } from "../types/scene";
import { AssetRegistry } from "./assets";
import { exportPaints } from "./images";
import { exportText } from "./text";
import { exportSvg, vectorTypes } from "./vectors";
import { relativeToScene } from "./transforms";
import { safeId, toJson } from "./serialization";
const supported = new Set([
  "FRAME",
  "GROUP",
  "TEXT",
  "RECTANGLE",
  "ELLIPSE",
  "LINE",
  "VECTOR",
  "POLYGON",
  "STAR",
  "BOOLEAN_OPERATION",
  "COMPONENT",
  "INSTANCE",
]);
// Explicit allowlist: never enumerate host node objects (parents form cycles).
const properties = [
  "visible",
  "locked",
  "opacity",
  "blendMode",
  "x",
  "y",
  "width",
  "height",
  "rotation",
  "relativeTransform",
  "absoluteTransform",
  "absoluteBoundingBox",
  "absoluteRenderBounds",
  "effects",
  "cornerRadius",
  "cornerSmoothing",
  "topLeftRadius",
  "topRightRadius",
  "bottomLeftRadius",
  "bottomRightRadius",
  "clipsContent",
  "isMask",
  "maskType",
  "strokeWeight",
  "strokeAlign",
  "strokeCap",
  "strokeJoin",
  "strokeMiterLimit",
  "dashPattern",
  "strokeGeometry",
  "fillGeometry",
  "strokeTopWeight",
  "strokeBottomWeight",
  "strokeLeftWeight",
  "strokeRightWeight",
  "vectorPaths",
  "vectorNetwork",
  "booleanOperation",
  "pointCount",
  "innerRadius",
  "arcData",
  "layoutMode",
  "itemReverseZIndex",
  "layoutSizingHorizontal",
  "layoutSizingVertical",
  "layoutAlign",
  "layoutGrow",
  "layoutPositioning",
  "primaryAxisSizingMode",
  "counterAxisSizingMode",
  "primaryAxisAlignItems",
  "counterAxisAlignItems",
  "paddingLeft",
  "paddingRight",
  "paddingTop",
  "paddingBottom",
  "itemSpacing",
  "counterAxisSpacing",
  "layoutWrap",
  "constraints",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "textTruncation",
  "maxLines",
  "hangingPunctuation",
  "hangingList",
  "autoRename",
  "fillStyleId",
  "strokeStyleId",
  "effectStyleId",
  "boundVariables",
  "componentProperties",
  "componentPropertyReferences",
  "isAsset",
  "exportSettings",
] as const;
export interface NodeContext {
  registry: AssetRegistry;
  report: Report;
  rootTransform: Matrix;
  tick: () => void;
}
export async function rasterFallback(
  node: SceneNode,
  ctx: NodeContext,
  reason: string,
): Promise<string | undefined> {
  if (!("exportAsync" in node)) return undefined;
  try {
    const bytes = await node.exportAsync({
      format: "PNG",
      constraint: { type: "SCALE", value: 1 },
    });
    const id = `fallback_${safeId(node.id)}`;
    await ctx.registry.add(
      {
        assetId: id,
        kind: "fallback",
        path: `assets/fallbacks/${id}.png`,
        mimeType: "image/png",
        byteLength: bytes.length,
        figmaNodeId: node.id,
      },
      bytes,
    );
    ctx.report.fallbackExports.push({
      figmaNodeId: node.id,
      assetId: id,
      reason,
    });
    return id;
  } catch (error) {
    rethrowAbort(error);
    ctx.report.errors.push({
      code: "FALLBACK_FAILED",
      message: String(error),
      figmaNodeId: node.id,
    });
    return undefined;
  }
}
export async function readNode(
  node: SceneNode,
  parentId: string | null,
  layerOrder: number,
  ctx: NodeContext,
): Promise<ExportNode> {
  ctx.report.nodes++;
  ctx.tick();
  const data: ExportNode = {
    figmaNodeId: node.id,
    name: node.name,
    alias: node.name,
    type: node.type,
    parentId,
    layerOrder,
    sceneTransform: relativeToScene(ctx.rootTransform, node.absoluteTransform),
    origin: {
      x: 0,
      y: 0,
      units: "local-pixels",
      description:
        "Top-left of node local geometry. Matrix includes Figma rotation/scale translation; no inferred pivot.",
    },
    properties: {},
    children: [],
  };
  const host = node as unknown as Record<string, unknown>;
  for (const key of properties) {
    if (key in node) {
      try {
        data.properties[key] = toJson(host[key]);
      } catch (error) {
        rethrowAbort(error);
        ctx.report.unsupportedProperties.push({
          code: "PROPERTY_READ_FAILED",
          message: String(error),
          figmaNodeId: node.id,
          property: key,
        });
      }
    }
  }
  for (const key of ["fills", "strokes", "backgrounds"] as const) {
    if (key in node) {
      try {
        const paints = host[key];
        if (typeof paints === "symbol" || Array.isArray(paints))
          data.properties[key] = await exportPaints(
            paints as readonly Paint[] | symbol,
            ctx.registry,
            ctx.report,
            node.id,
          );
      } catch (error) {
        rethrowAbort(error);
        ctx.report.errors.push({
          code: "PAINT_READ_FAILED",
          message: String(error),
          figmaNodeId: node.id,
          property: key,
        });
      }
    }
  }
  if ("fills" in node && typeof node.fills === "symbol" && node.type !== "TEXT")
    ctx.report.unsupportedProperties.push({
      code: "MIXED_PAINTS",
      message:
        "Mixed paints preserved; per-range paints unavailable for this node type",
      figmaNodeId: node.id,
      property: "fills",
    });
  if (node.type === "TEXT") {
    try {
      data.text = await exportText(node, ctx.registry, ctx.report);
    } catch (error) {
      rethrowAbort(error);
      ctx.report.errors.push({
        code: "TEXT_READ_FAILED",
        message: String(error),
        figmaNodeId: node.id,
      });
      data.properties.characters = node.characters;
      data.serializationError = String(error);
    }
  }
  if (vectorTypes.has(node.type)) {
    data.svgAssetId = await exportSvg(node, ctx.registry, ctx.report);
    if (!data.svgAssetId)
      data.fallbackAssetId = await rasterFallback(
        node,
        ctx,
        "SVG failed; raster visual fallback",
      );
    if (node.type === "BOOLEAN_OPERATION" || node.type === "VECTOR")
      ctx.report.warnings.push({
        code: "VECTOR_ANIMATION_LIMITATION",
        message:
          "SVG may contain masks/clips or outlined strokes. Trim Paths compatibility is not guaranteed.",
        figmaNodeId: node.id,
      });
  }
  if (!supported.has(node.type)) {
    ctx.report.unsupportedProperties.push({
      code: "UNSUPPORTED_NODE_TYPE",
      message: `${node.type}: common properties/hierarchy retained; raster fallback attempted`,
      figmaNodeId: node.id,
    });
    data.fallbackAssetId = await rasterFallback(
      node,
      ctx,
      `Unsupported node type: ${node.type}`,
    );
  }
  const hasMissingPaint = (v: Json): boolean =>
    Array.isArray(v)
      ? v.some(hasMissingPaint)
      : v !== null && typeof v === "object"
        ? v.assetStatus === "missing" || Object.values(v).some(hasMissingPaint)
        : false;
  if (
    hasMissingPaint(toJson({ properties: data.properties, text: data.text })) &&
    !data.fallbackAssetId
  )
    data.fallbackAssetId = await rasterFallback(
      node,
      ctx,
      "Original image unavailable; rendered node fallback does not preserve original image",
    );
  if ("children" in node) {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      try {
        data.children.push(await readNode(child, node.id, i, ctx));
      } catch (error) {
        rethrowAbort(error);
        ctx.report.errors.push({
          code: "NODE_READ_FAILED",
          message: String(error),
          figmaNodeId: child.id,
        });
        data.children.push({
          figmaNodeId: child.id,
          name: child.name,
          alias: child.name,
          type: child.type,
          parentId: node.id,
          layerOrder: i,
          sceneTransform: relativeToScene(
            ctx.rootTransform,
            child.absoluteTransform,
          ),
          origin: data.origin,
          properties: {},
          children: [],
          serializationError: String(error),
          fallbackAssetId: await rasterFallback(
            child,
            ctx,
            "Node serialization failed",
          ),
        });
      }
    }
  }
  return data;
}
