/**
 * WebKit paints composited HTML inside foreignObject at the SVG root, ignoring
 * ancestor transforms (even though getScreenCTM/getBoundingClientRect are correct).
 * Keep its motion/alpha on SVG; Chromium retains the subpixel HTML transport.
 * Neither transport owns source position or changes typography/layout.
 */
export function configureTextPlane(source: SVGForeignObjectElement) {
  const agent = source.ownerDocument.defaultView?.navigator.userAgent ?? "";
  const webkit =
    /AppleWebKit/.test(agent) && !/(Chrome|Chromium|Edg|OPR)\//.test(agent);
  const html = source.firstElementChild as HTMLElement | null;
  if (!html) throw new Error("TEXT_NATIVE_LAYOUT_REQUIRED");
  if (!webkit) return "html-compositor";
  html.style.willChange = "auto";
  html.style.transformOrigin = "0 0";
  html.style.transform = "none";
  html.style.opacity = "1";
  const transport = "svg-native";
  source.dataset.textTransport = transport;
  return transport;
}
