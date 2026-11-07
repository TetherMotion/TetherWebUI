import { describe, expect, it } from 'vitest';
import { AppProfile, AppProfileWidget } from '../domain/app-profile';
import { clampRect, collides, compact, findFreeSpot, resolveCollisions } from './layout';
import {
  BOARD_FORMAT,
  BoardDoc,
  makeTile,
  parseBoardDoc,
  serializeBoard,
  TileDef,
} from './model';
import { TILE_SPEC_BY_TYPE } from './registry';
import {
  boardsFromProfile,
  ensureBuiltinBoards,
  loadBoards,
  resetBuiltinBoard,
  saveBoards,
} from './store';

function tile(partial: Partial<TileDef> & { type: string }): TileDef {
  return { id: partial.type, x: 0, y: 0, w: 3, h: 2, ...partial };
}

describe('board document model', () => {
  it('round-trips a board through serialize/parse', () => {
    const doc: BoardDoc = {
      format: BOARD_FORMAT,
      id: 'user.abc',
      title: 'Test',
      source: 'user' as const,
      tiles: [
        makeTile(
          'value',
          { x: 1, y: 2, w: 3, h: 2 },
          {
            title: 'Pos',
            bindings: [{ entry: 'axis.x.position', field: 'actual' }],
            options: { decimals: 3 },
          },
        ),
      ],
    };
    const parsed = parseBoardDoc(serializeBoard(doc));
    expect(parsed?.id).toBe('user.abc');
    expect(parsed?.tiles[0]?.bindings?.[0]).toEqual({
      entry: 'axis.x.position',
      field: 'actual',
    });
    expect(parsed?.tiles[0]?.options?.['decimals']).toBe(3);
  });

  it('rejects malformed documents', () => {
    expect(parseBoardDoc('not json')).toBeUndefined();
    expect(parseBoardDoc('{"format":"other"}')).toBeUndefined();
    expect(
      parseBoardDoc('{"format":"tether.dashboard.v1","id":"x","title":"t","tiles":"no"}'),
    ).toBeUndefined();
  });

  it('clamps tile rects into the 12-column grid', () => {
    const parsed = parseBoardDoc(
      JSON.stringify({
        format: BOARD_FORMAT,
        id: 'x',
        title: 't',
        tiles: [{ type: 'value', x: 99, y: -4, w: 99, h: 0 }],
      }),
    );
    const t = parsed?.tiles[0];
    expect(t?.x).toBe(11);
    expect(t?.w).toBe(12);
    expect(t?.y).toBe(0);
    expect(t?.h).toBe(1);
  });
});

describe('grid layout', () => {
  it('collides only on real overlap', () => {
    expect(collides({ x: 0, y: 0, w: 2, h: 2 }, { x: 2, y: 0, w: 2, h: 2 })).toBe(false);
    expect(collides({ x: 0, y: 0, w: 2, h: 2 }, { x: 1, y: 1, w: 2, h: 2 })).toBe(true);
  });

  it('compacts tiles upward without overlap', () => {
    const tiles = [
      tile({ type: 'a', x: 0, y: 5, w: 4, h: 2 }),
      tile({ type: 'b', x: 4, y: 3, w: 4, h: 2 }),
      tile({ type: 'c', x: 0, y: 7, w: 12, h: 1 }),
    ];
    compact(tiles);
    expect(tiles[0]!.y).toBe(0);
    expect(tiles[1]!.y).toBe(0);
    expect(tiles[2]!.y).toBe(2);
  });

  it('findFreeSpot skips occupied cells', () => {
    const tiles = [tile({ type: 'a', x: 0, y: 0, w: 12, h: 2 })];
    const spot = findFreeSpot(tiles, 4, 2);
    expect(spot.y).toBe(2);
    expect(spot.x).toBe(0);
  });

  it('resolveCollisions pushes the displaced tile down', () => {
    const moved = tile({ type: 'a', x: 0, y: 0, w: 4, h: 2 });
    const other = tile({ type: 'b', x: 0, y: 1, w: 4, h: 2 });
    resolveCollisions(moved, [moved, other]);
    expect(other.y).toBe(2);
  });

  it('clampRect bounds w/x to the grid', () => {
    expect(clampRect({ x: -3, y: -2, w: 20, h: 0 })).toEqual({ x: 0, y: 0, w: 12, h: 1 });
    expect(clampRect({ x: 10, y: 1, w: 4, h: 2 })).toEqual({ x: 8, y: 1, w: 4, h: 2 });
  });
});

describe('board store', () => {
  it('persists user boards and materializes builtins', () => {
    localStorage.clear();
    const boards = ensureBuiltinBoards(loadBoards());
    expect(boards.some((b) => b.id === 'builtin.machine')).toBe(true);
    saveBoards(boards);
    const reloaded = loadBoards();
    expect(reloaded.length).toBe(boards.length);
    localStorage.clear();
  });

  it('resetBuiltinBoard restores the default', () => {
    const fresh = resetBuiltinBoard('builtin.machine');
    expect(fresh?.tiles.length).toBeGreaterThan(0);
  });
});

describe('app profile → boards', () => {
  const widget = (partial: Partial<AppProfileWidget> & { kind: AppProfileWidget['kind'] }) =>
    partial as AppProfileWidget;

  it('maps widget kinds to tile types', () => {
    const profile: AppProfile = {
      name: 'test',
      version: '1',
      signatureHex: 'aa',
      panels: [
        {
          id: 'p1',
          title: 'Panel',
          widgets: [
            widget({ kind: 'value', label: 'V', entry: 'sig.a' }),
            widget({ kind: 'dro', label: 'D', entry: 'sig.b', field: 'actual' }),
            widget({ kind: 'jog', label: 'J', axis: 'x' }),
            widget({ kind: 'command', label: 'C', axis: 'x', action: 0 }),
            widget({ kind: 'button', label: 'B', fn: 'machine.ping' }),
          ],
        },
      ],
    };
    const [board] = boardsFromProfile(profile);
    expect(board?.source).toBe('profile');
    expect(board?.profileTag).toBe('test v1');
    const types = board?.tiles.map((t) => t.type);
    expect(types).toEqual(['value', 'value', 'jog-pair', 'command-button', 'fn-button']);
    const dro = board?.tiles[1];
    expect(dro?.options?.['viz']).toBe('dro');
    expect(dro?.bindings?.[0]).toEqual({ entry: 'sig.b', field: 'actual' });
    const cmd = board?.tiles[3];
    expect(cmd?.options?.['action']).toBe('0');
    expect(cmd?.options?.['axis']).toBe('x');
  });

  it('maps scene axes and drops unregistered kinds', () => {
    const profile: AppProfile = {
      name: 't',
      version: '1',
      signatureHex: 'bb',
      panels: [
        {
          id: 'p',
          title: 'P',
          widgets: [
            widget({
              kind: 'scene',
              label: 'Scene',
              axes: [
                {
                  name: 'X',
                  entry: 'ax.x.pos',
                  field: 'actual',
                  targetField: 'target',
                  min: 0,
                  max: 100,
                },
                { name: 'Y', entry: 'ax.y.pos', field: 'actual' },
              ],
            }),
            widget({ kind: 'value' } as Partial<AppProfileWidget> & {
              kind: AppProfileWidget['kind'];
            }),
          ],
        },
      ],
    };
    const [board] = boardsFromProfile(profile);
    const scene = board?.tiles.find((t) => t.type === 'scene');
    expect(scene?.axes?.length).toBe(2);
    expect(scene?.axes?.[0]?.targetField).toBe('target');
    // every produced tile type must be registered
    for (const t of board?.tiles ?? []) expect(TILE_SPEC_BY_TYPE.has(t.type)).toBe(true);
  });
});
