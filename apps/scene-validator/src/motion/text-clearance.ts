/** Parent-independent viewport displacement for a shaped text unit.
 * Direction names describe the movement; mode chooses its offscreen endpoint. */
export function textViewportOffset(
  points: {x:number;y:number}[],
  viewport: {x:number;y:number;width:number;height:number},
  effect: string,
  mode: "in" | "out",
) {
  const vertical = effect === "slideUp" || effect === "slideDown";
  const positive = (effect === "slideUp" || effect === "slideLeft") === (mode === "in");
  const values = points.map(p => vertical ? p.y : p.x);
  const edge = vertical ? viewport.y : viewport.x;
  const size = vertical ? viewport.height : viewport.width;
  const displacement = positive ? edge + size - Math.min(...values) + 1 : edge - Math.max(...values) - 1;
  return {x:vertical ? 0 : displacement,y:vertical ? displacement : 0};
}
