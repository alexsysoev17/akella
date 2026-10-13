export function detectFormat(bytes: Uint8Array): {
  extension: string;
  mimeType: string;
} {
  const starts = (signature: number[]) =>
    signature.every((v, i) => bytes[i] === v);
  if (starts([137, 80, 78, 71, 13, 10, 26, 10]))
    return { extension: "png", mimeType: "image/png" };
  if (starts([255, 216, 255]))
    return { extension: "jpg", mimeType: "image/jpeg" };
  if (starts([71, 73, 70, 56, 55, 97]) || starts([71, 73, 70, 56, 57, 97]))
    return { extension: "gif", mimeType: "image/gif" };
  if (
    starts([82, 73, 70, 70]) &&
    bytes[8] === 87 &&
    bytes[9] === 69 &&
    bytes[10] === 66 &&
    bytes[11] === 80
  )
    return { extension: "webp", mimeType: "image/webp" };
  throw new Error(
    "Unknown original image format; bytes cannot be labelled safely",
  );
}
