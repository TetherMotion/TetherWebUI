/** Grid math for the board host: collision, compaction, free-spot search. */
import { GRID_COLS, TileDef } from './model';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function collides(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Compact tiles upward in-place (top-down order preserves relative layout). */
export function compact(tiles: TileDef[]): void {
  const sorted = [...tiles].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const tile of sorted) {
    while (tile.y > 0) {
      tile.y -= 1;
      if (sorted.some((other) => other !== tile && collides(tile, other))) {
        tile.y += 1;
        break;
      }
    }
  }
}

/** Lowest row where `w×h` fits; returns x=0 if the board is full at that row. */
export function findFreeSpot(tiles: TileDef[], w: number, h: number): { x: number; y: number } {
  const width = Math.min(w, GRID_COLS);
  for (let y = 0; y < 200; y += 1) {
    for (let x = 0; x <= GRID_COLS - width; x += 1) {
      const candidate: Rect = { x, y, w: width, h };
      if (!tiles.some((t) => collides(candidate, t))) return { x, y };
    }
  }
  // Fallback: below everything.
  const bottom = tiles.reduce((max, t) => Math.max(max, t.y + t.h), 0);
  return { x: 0, y: bottom };
}

/** Resolve a moving rect against others by pushing colliders down. */
export function resolveCollisions(moving: TileDef, tiles: TileDef[]): void {
  for (let guard = 0; guard < 500; guard += 1) {
    const hit = tiles.find((t) => t !== moving && collides(moving, t));
    if (!hit) return;
    hit.y = moving.y + moving.h;
  }
}

/** Clamp a rect to the grid; returns the clamped values. */
export function clampRect(rect: Rect): Rect {
  const w = Math.max(1, Math.min(GRID_COLS, Math.round(rect.w)));
  const h = Math.max(1, Math.round(rect.h));
  const x = Math.max(0, Math.min(GRID_COLS - w, Math.round(rect.x)));
  const y = Math.max(0, Math.round(rect.y));
  return { x, y, w, h };
}
