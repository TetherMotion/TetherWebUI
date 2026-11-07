/**
 * Board document model (`tether.dashboard.v1`).
 *
 * A board is a 12-column grid of tiles. Tiles are positioned by {x, y, w, h}
 * in grid units; layout is compacted upward after every edit so boards stay
 * tidy without manual y-management. Documents serialize to plain JSON —
 * signal bindings use entry *names* (stable across schema epochs, unlike
 * entry ids).
 */

export const BOARD_FORMAT = 'tether.dashboard.v1';
export const GRID_COLS = 12;

/** One signal binding: catalog entry name + optional struct field. */
export interface TileBinding {
  entry: string;
  field?: string;
}

/** Axis binding for the `scene` tile (top-down XY + optional Z bar). */
export interface SceneAxisBinding {
  name?: string;
  entry: string;
  field: string;
  targetField?: string;
  min?: number;
  max?: number;
}

export interface TileDef {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Optional display title override. */
  title?: string;
  /** Signal bindings for display tiles (`value`, `gauge`, `sparkline`, …). */
  bindings?: TileBinding[];
  /** Axis bindings for `scene` tiles. */
  axes?: SceneAxisBinding[];
  /** Free-form per-type options (see each spec's config fields). */
  options?: Record<string, unknown>;
}

export interface BoardDoc {
  format: typeof BOARD_FORMAT;
  id: string;
  title: string;
  /** builtin = code default · user = editable · profile = server-signed, cloneable */
  source: 'builtin' | 'user' | 'profile';
  /** For profile boards: the profile name/version they were generated from. */
  profileTag?: string;
  tiles: TileDef[];
}

export function newTileId(): string {
  return `t-${crypto.randomUUID().slice(0, 8)}`;
}

export function makeTile(
  type: string,
  rect: { x: number; y: number; w: number; h: number },
  extra: Partial<TileDef> = {},
): TileDef {
  return { id: newTileId(), type, ...rect, ...extra };
}

/** Validate a parsed document; returns undefined on malformed input. */
export function parseBoardDoc(text: string): BoardDoc | undefined {
  try {
    const doc = JSON.parse(text) as Record<string, unknown>;
    if (doc.format !== BOARD_FORMAT) return undefined;
    if (typeof doc.id !== 'string' || typeof doc.title !== 'string') return undefined;
    if (!Array.isArray(doc.tiles)) return undefined;
    const tiles: TileDef[] = [];
    for (const raw of doc.tiles) {
      const tile = asTile(raw);
      if (tile) tiles.push(tile);
    }
    const source =
      doc.source === 'builtin' || doc.source === 'profile' ? doc.source : ('user' as const);
    return {
      format: BOARD_FORMAT,
      id: doc.id,
      title: doc.title,
      source,
      profileTag: typeof doc.profileTag === 'string' ? doc.profileTag : undefined,
      tiles,
    };
  } catch {
    return undefined;
  }
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function asTile(value: unknown): TileDef | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.type !== 'string' || !raw.type.length) return undefined;
  const tile: TileDef = {
    id: typeof raw.id === 'string' && raw.id.length ? raw.id : newTileId(),
    type: raw.type,
    x: Math.max(0, Math.min(GRID_COLS - 1, num(raw.x, 0))),
    y: Math.max(0, num(raw.y, 0)),
    w: Math.max(1, Math.min(GRID_COLS, num(raw.w, 3))),
    h: Math.max(1, num(raw.h, 3)),
  };
  if (typeof raw.title === 'string' && raw.title.length) tile.title = raw.title;
  if (Array.isArray(raw.bindings)) {
    const bindings = raw.bindings
      .map((b): TileBinding | undefined => {
        if (!b || typeof b !== 'object') return undefined;
        const br = b as Record<string, unknown>;
        if (typeof br.entry !== 'string' || !br.entry.length) return undefined;
        return {
          entry: br.entry,
          field: typeof br.field === 'string' && br.field.length ? br.field : undefined,
        };
      })
      .filter((b): b is TileBinding => !!b);
    if (bindings.length) tile.bindings = bindings;
  }
  if (Array.isArray(raw.axes)) {
    const axes = raw.axes
      .map((b): SceneAxisBinding | undefined => {
        if (!b || typeof b !== 'object') return undefined;
        const br = b as Record<string, unknown>;
        if (typeof br.entry !== 'string' || typeof br.field !== 'string') return undefined;
        return {
          name: typeof br.name === 'string' ? br.name : undefined,
          entry: br.entry,
          field: br.field,
          targetField: typeof br.targetField === 'string' ? br.targetField : undefined,
          min: typeof br.min === 'number' ? br.min : undefined,
          max: typeof br.max === 'number' ? br.max : undefined,
        };
      })
      .filter((b): b is SceneAxisBinding => !!b);
    if (axes.length) tile.axes = axes;
  }
  if (raw.options && typeof raw.options === 'object' && !Array.isArray(raw.options)) {
    tile.options = raw.options as Record<string, unknown>;
  }
  return tile;
}

export function serializeBoard(board: BoardDoc): string {
  return JSON.stringify(board, null, 2);
}
