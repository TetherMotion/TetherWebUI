/**
 * Board persistence + built-in boards + app-profile conversion.
 *
 * User and materialized built-in boards persist in localStorage under
 * `tether.boards.v1`. Built-ins are materialized as editable copies on first
 * run (resettable); server-signed app profiles convert to read-only boards
 * regenerated on every connect — never persisted.
 */
import { AppProfile, AppProfileWidget } from '../domain/app-profile';
import { compact, findFreeSpot } from './layout';
import { BOARD_FORMAT, BoardDoc, TileDef, makeTile } from './model';
import { TILE_SPEC_BY_TYPE } from './registry';

const STORAGE_KEY = 'tether.boards.v1';

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function loadBoards(): BoardDoc[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (b): b is BoardDoc =>
        !!b && typeof b === 'object' && b.format === BOARD_FORMAT && Array.isArray(b.tiles),
    );
  } catch {
    return [];
  }
}

export function saveBoards(boards: BoardDoc[]): void {
  const persist = boards.filter((b) => b.source !== 'profile');
  localStorage.setItem(STORAGE_KEY, JSON.stringify(persist));
}

/** Insert any missing built-in boards (matched by stable id). */
export function ensureBuiltinBoards(boards: BoardDoc[]): BoardDoc[] {
  const ids = new Set(boards.map((b) => b.id));
  const out = [...boards];
  for (const builtin of builtinBoards()) {
    if (!ids.has(builtin.id)) out.push(builtin);
  }
  return out;
}

export function resetBuiltinBoard(id: string): BoardDoc | undefined {
  return builtinBoards().find((b) => b.id === id);
}

// ---------------------------------------------------------------------------
// Built-in boards
// ---------------------------------------------------------------------------

function builtinBoards(): BoardDoc[] {
  return [
    {
      format: BOARD_FORMAT,
      id: 'builtin.machine',
      title: 'Machine',
      source: 'builtin',
      tiles: [
        makeTile('machine-state', { x: 0, y: 0, w: 4, h: 3 }, { title: 'Fieldbus health' }),
        makeTile('drive-cards', { x: 4, y: 0, w: 8, h: 5 }, { title: 'Drive fleet' }),
        makeTile('diag-bus', { x: 0, y: 3, w: 4, h: 3 }, { title: 'Bus health' }),
        makeTile('alarm-list', { x: 0, y: 6, w: 7, h: 4 }, { title: 'Alarms' }),
        makeTile('event-timeline', { x: 7, y: 5, w: 5, h: 5 }, { title: 'Events' }),
      ],
    },
    {
      format: BOARD_FORMAT,
      id: 'builtin.motion',
      title: 'Motion',
      source: 'builtin',
      tiles: [
        makeTile('authority', { x: 0, y: 0, w: 5, h: 3 }, { title: 'Control authority' }),
        makeTile('jog', { x: 5, y: 0, w: 7, h: 5 }, { title: 'Jog' }),
        makeTile('command', { x: 0, y: 3, w: 5, h: 6 }, { title: 'Command dispatch' }),
        makeTile('homing', { x: 5, y: 5, w: 7, h: 4 }, { title: 'Guided homing' }),
        makeTile('operations', { x: 0, y: 9, w: 12, h: 3 }, { title: 'Operations' }),
      ],
    },
    {
      format: BOARD_FORMAT,
      id: 'builtin.analyze',
      title: 'Analyze',
      source: 'builtin',
      tiles: [
        makeTile(
          'scope',
          { x: 0, y: 0, w: 12, h: 6 },
          {
            title: 'Scope',
            options: { signals: '', preset: 'motion', fft: true },
          },
        ),
        makeTile('diag-cyclic', { x: 0, y: 6, w: 6, h: 4 }, { title: 'Cyclic loop' }),
        makeTile('diag-topology', { x: 6, y: 6, w: 6, h: 4 }, { title: 'Topology' }),
        makeTile('supervisor', { x: 0, y: 10, w: 6, h: 3 }, { title: 'Supervisor' }),
        makeTile('pdo-map', { x: 6, y: 10, w: 6, h: 3 }, { title: 'PDO map' }),
      ],
    },
    {
      format: BOARD_FORMAT,
      id: 'builtin.service',
      title: 'Service',
      source: 'builtin',
      tiles: [
        makeTile('config-txn', { x: 0, y: 0, w: 6, h: 5 }, { title: 'Config transaction' }),
        makeTile('capture', { x: 6, y: 0, w: 6, h: 5 }, { title: 'Capture' }),
        makeTile('sdo-inspector', { x: 0, y: 5, w: 7, h: 7 }, { title: 'SDO inspector' }),
        makeTile('baseline', { x: 7, y: 5, w: 5, h: 5 }, { title: 'Baseline' }),
        makeTile('checklist', { x: 7, y: 10, w: 5, h: 5 }, { title: 'Checklist' }),
        makeTile('recipes', { x: 0, y: 12, w: 7, h: 4 }, { title: 'Recipes' }),
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// App-profile → boards
// ---------------------------------------------------------------------------

const WIDGET_TILE_SIZE: Record<string, { w: number; h: number }> = {
  value: { w: 3, h: 2 },
  dro: { w: 3, h: 2 },
  bar: { w: 3, h: 2 },
  gauge: { w: 3, h: 3 },
  state: { w: 3, h: 2 },
  lamp: { w: 3, h: 2 },
  sparkline: { w: 4, h: 2 },
  scene: { w: 4, h: 5 },
  jog: { w: 3, h: 2 },
  command: { w: 3, h: 2 },
  button: { w: 3, h: 2 },
};

function profileWidgetTile(widget: AppProfileWidget): TileDef | undefined {
  const size = WIDGET_TILE_SIZE[widget.kind] ?? { w: 3, h: 2 };
  const tile = makeTile(
    widget.kind === 'dro' ? 'value' : widget.kind,
    { x: 0, y: 0, ...size },
    {
      title: widget.label,
    },
  );
  if (widget.kind === 'dro') tile.options = { ...(tile.options ?? {}), viz: 'dro' };
  if (widget.entry) tile.bindings = [{ entry: widget.entry, field: widget.field }];
  if (widget.kind === 'scene' && widget.axes)
    tile.axes = widget.axes.map((a) => ({
      name: a.name,
      entry: a.entry,
      field: a.field,
      targetField: a.targetField,
      min: a.min,
      max: a.max,
    }));
  const options: Record<string, unknown> = { ...(tile.options ?? {}) };
  if (widget.unit !== undefined) options.unit = widget.unit;
  if (widget.min !== undefined) options.min = widget.min;
  if (widget.max !== undefined) options.max = widget.max;
  if (widget.decimals !== undefined) options.decimals = widget.decimals;
  if (widget.warnAbove !== undefined) options.warnAbove = widget.warnAbove;
  if (widget.critAbove !== undefined) options.critAbove = widget.critAbove;
  if (widget.states !== undefined) options.states = JSON.stringify(widget.states);
  if (widget.axis !== undefined) options.axis = widget.axis;
  if (widget.action !== undefined) options.action = String(widget.action);
  if (widget.fn !== undefined) options.fn = widget.fn;
  if (widget.kind === 'jog') tile.type = 'jog-pair';
  if (widget.kind === 'command') tile.type = 'command-button';
  if (widget.kind === 'button') tile.type = 'fn-button';
  if (Object.keys(options).length) tile.options = options;
  // Profile widget kinds without a registered tile type are dropped.
  if (!TILE_SPEC_BY_TYPE.has(tile.type)) return undefined;
  return tile;
}

/** Convert a signed server profile into read-only boards (one per panel). */
export function boardsFromProfile(profile: AppProfile): BoardDoc[] {
  return profile.panels.map((panel) => {
    const tiles: TileDef[] = [];
    for (const widget of panel.widgets) {
      const tile = profileWidgetTile(widget);
      if (!tile) continue;
      const spot = findFreeSpot(tiles, tile.w, tile.h);
      tile.x = spot.x;
      tile.y = spot.y;
      tiles.push(tile);
    }
    compact(tiles);
    return {
      format: BOARD_FORMAT,
      id: `profile.${panel.id}`,
      title: panel.title,
      source: 'profile' as const,
      profileTag: `${profile.name} v${profile.version}`,
      tiles,
    };
  });
}
