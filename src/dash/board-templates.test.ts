import { describe, expect, it } from 'vitest';

import { BOARD_TEMPLATES, boardFromTemplate } from './board-templates';
import { TILE_SPEC_BY_TYPE } from './registry';

describe('board templates', () => {
  it('every template produces only registered tile types', () => {
    for (const tpl of BOARD_TEMPLATES) {
      const doc = boardFromTemplate(tpl.id);
      expect(doc).toBeDefined();
      for (const t of doc!.tiles) {
        expect(TILE_SPEC_BY_TYPE.has(t.type), `${tpl.id}:${t.type}`).toBe(true);
        expect(t.id).toMatch(/^t-/);
      }
    }
  });

  it('temperature-cell pre-places faceplate + profile + alarms', () => {
    const doc = boardFromTemplate('temperature-cell')!;
    expect(doc.source).toBe('user');
    const types = doc.tiles.map((t) => t.type);
    expect(types).toContain('faceplate');
    expect(types).toContain('profile');
    expect(types).toContain('alarm-list');
    const fp = doc.tiles.find((t) => t.type === 'faceplate')!;
    expect(fp.options?.['kind']).toBe('loop');
    expect(fp.options?.['prefix']).toBe('plc.Main.TIC101');
    const prof = doc.tiles.find((t) => t.type === 'profile')!;
    expect(prof.options?.['prefix']).toBe('plc.Main.Prof');
  });

  it('fresh tile ids per call; blank stays empty', () => {
    const a = boardFromTemplate('temperature-cell')!;
    const b = boardFromTemplate('temperature-cell')!;
    expect(a.tiles.map((t) => t.id)).not.toEqual(b.tiles.map((t) => t.id));
    expect(boardFromTemplate('blank')!.tiles).toEqual([]);
    expect(boardFromTemplate('nope')).toBeUndefined();
  });
});
