export function inBounds(g, x, y) {
  return x >= 0 && y >= 0 && x < g.width && y < g.height;
}
/** Cardinal neighbours (N/S/E/W). */
export function neighbors4(x, y) {
  return [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
}
/** 8-directional neighbours including diagonals. */
export function neighbors8(x, y) {
  return [
    [x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1],
    [x + 1, y + 1], [x - 1, y + 1], [x + 1, y - 1], [x - 1, y - 1],
  ];
}
export function manhattan(ax, ay, bx, by) {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}
/** Chebyshev distance — same formula used for weapon range checks. */
export function chebyshev(ax, ay, bx, by) {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}
