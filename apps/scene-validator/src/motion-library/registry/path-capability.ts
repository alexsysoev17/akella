/** Eligibility shared by context, technical validation and renderer. */
export function pathCapability(
  type: string,
  p: Record<string, unknown>,
  renderer: "native" | "browser-compat" = "native",
) {
  const visible = (v: unknown) =>
    Array.isArray(v)
      ? v.filter(
          (x) =>
            x &&
            typeof x === "object" &&
            (x as Record<string, unknown>).visible !== false,
        )
      : [];
  if (
    [p.strokeWeight, p.strokeCap, p.strokeJoin].some(
      (value) => value && typeof value === "object",
    )
  )
    return {
      supported: false,
      reason:
        "Mixed stroke widths/caps/joins need explicit per-path reveal geometry",
    };
  const paths = Array.isArray(p.vectorPaths)
    ? (p.vectorPaths as { data?: string }[])
    : [];
  if (!["VECTOR", "LINE"].includes(type))
    return { supported: false, reason: "Not a centerline vector" };
  if (type === "VECTOR" && (!paths.length || paths.some((p) => !p.data)))
    return {
      supported: false,
      reason:
        "Missing source centerline geometry; outlined fill cannot determine original stroke trajectory",
    };
  if (
    renderer === "browser-compat" &&
    paths.some((p) => (p.data?.match(/[Mm]/g)?.length ?? 0) > 1)
  )
    return {
      supported: false,
      reason: "Compound subpaths must be exported as separate vectorPaths",
    };
  if (visible(p.fills).length)
    return {
      supported: false,
      reason: "Filled shape is not a stroked centerline",
    };
  if (!visible(p.strokes).length)
    return { supported: false, reason: "No visible stroke" };
  if (p.strokeAlign && p.strokeAlign !== "CENTER")
    return {
      supported: false,
      reason: "Only centered strokes have exact reveal geometry",
    };
  if (
    Array.isArray(p.strokeGeometry) &&
    p.strokeGeometry.length &&
    paths.length !== 1 &&
    type !== "LINE"
  )
    return {
      supported: false,
      reason:
        "Multiple outlined strokes need explicit centerline-to-outline mapping",
    };
  if (
    typeof p.strokeCap === "string" &&
    !["NONE", "BUTT", "ROUND", "SQUARE"].includes(p.strokeCap)
  )
    return {
      supported: false,
      reason: "Decorated end caps require explicit reveal geometry",
    };
  return {
    supported: true,
    reason:
      "Native centerline paths; mask reveal preserves original stroke paint",
  };
}
