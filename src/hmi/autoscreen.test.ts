/**
 * Tests for catalog→board auto-generation — the web port of
 * tether::hmi::autoScreen(). Rules must stay in lockstep with
 * Tether/examples/common/HmiAuto.cpp.
 */
import { describe, it, expect } from 'vitest';
import {
  autoScreen, specToTiles, autoBoardTiles,
  type CatalogEntryLike,
} from './autoscreen';

const names = (entries: string[]): CatalogEntryLike[] =>
  entries.map((name) => ({ name }));
const sigs = (w: { signals: string[] }) => w.signals;

describe('autoScreen', () => {
  it('ignores non-plc.* entries', () => {
    const s = autoScreen(names(['machine.axis1.pos', 'ec.slave3.status']));
    expect(s.widgets.map((w) => w.type)).toEqual(['alarms']);
  });

  it('always appends the alarm board', () => {
    const s = autoScreen(names(['plc.Main.cnt']));
    const last = s.widgets[s.widgets.length - 1]!;
    expect(last.type).toBe('alarms');
    expect(last.options.title).toBe('ALARMS');
  });

  it('profile instance → single profile widget with member bindings', () => {
    const s = autoScreen(names([
      'plc.Main.prof.Done', 'plc.Main.prof.Busy', 'plc.Main.prof.Err',
      'plc.Main.prof.SegIdx', 'plc.Main.prof.SegTgt', 'plc.Main.prof.PV',
      'plc.Main.prof.SP', 'plc.Main.prof.EV',
    ]));
    const prof = s.widgets.find((w) => w.type === 'profile');
    expect(prof).toBeDefined();
    expect(prof!.signals).toContain('plc.Main.prof.Done');
    expect(prof!.signals).toContain('plc.Main.prof.PV');
    /* only ONE profile widget — members must not leak into readouts */
    expect(s.widgets.filter((w) => w.type === 'digital')).toHaveLength(0);
  });

  it('PV+SP instance → loop cluster (2 digital + bar)', () => {
    const s = autoScreen(names([
      'plc.Main.loop1.PV', 'plc.Main.loop1.SP', 'plc.Main.loop1.OUT',
      'plc.Main.loop1.Q',
    ]));
    const types = s.widgets.map((w) => w.type);
    expect(types).toEqual(['digital', 'digital', 'bar', 'alarms']);
    expect(s.widgets[0]!.options.label).toBe('loop1 PV');
    expect(s.widgets[2]!.signals).toEqual(['plc.Main.loop1.OUT']);
  });

  it('falls back U/EV for the bar when OUT is absent', () => {
    const s = autoScreen(names([
      'plc.Main.loop1.PV', 'plc.Main.loop1.SP', 'plc.Main.loop1.U',
    ]));
    const bar = s.widgets.find((w) => w.type === 'bar');
    expect(bar!.signals).toEqual(['plc.Main.loop1.U']);
  });

  it('boolean-only instance → lamp stack', () => {
    const s = autoScreen(names([
      'plc.Main.mot.run', 'plc.Main.mot.fault', 'plc.Main.mot.inpos',
    ]));
    const lamp = s.widgets.find((w) => w.type === 'lamp');
    expect(lamp).toBeDefined();
    expect(lamp!.signals).toHaveLength(3);
  });

  it('mixed instance members → capped digital readouts', () => {
    const entries = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta']
      .map((m) => `plc.Main.inst.${m}`);
    const s = autoScreen(names(entries));
    const digs = s.widgets.filter((w) => w.type === 'digital');
    expect(digs).toHaveLength(4); // cap
    expect(digs[0]!.options.label).toBe('inst Alpha');
  });

  it('program scalars → digital readouts, skips internal names', () => {
    const s = autoScreen(names([
      'plc.Main.cnt', 'plc.Main.retain', 'plc.Main.image',
      'plc.Main.status', 'plc.Other.val',
    ]));
    const digs = s.widgets.filter((w) => w.type === 'digital');
    /* cnt + val; retain/image/status skipped (substring match on leaf) */
    const labels = digs.map((d) => d.options.label);
    expect(labels).toContain('cnt');
    expect(labels).toContain('val');
    expect(labels.some((l) => (l ?? '').includes('retain') || l === 'image' || l === 'status')).toBe(false);
  });
});

describe('specToTiles', () => {
  it('maps spec types to tile types with bindings', () => {
    const tiles = specToTiles(autoScreen(names([
      'plc.Main.cnt', 'plc.Main.loop1.PV', 'plc.Main.loop1.SP',
    ])));
    const dig = tiles.find((t) => t.options?.label === 'cnt');
    expect(dig).toBeDefined();
    expect(dig!.bindings).toEqual([{ entry: 'plc.Main.cnt' }]);
  });

  it('profile spec → profile tile with prefix option', () => {
    const tiles = specToTiles(autoScreen(names([
      'plc.Main.prof.Done', 'plc.Main.prof.Busy', 'plc.Main.prof.Err',
      'plc.Main.prof.SegIdx',
    ])));
    const prof = tiles.find((t) => t.type === 'profile');
    expect(prof).toBeDefined();
    expect(prof!.options?.prefix).toBe('plc.Main.prof');
    expect(prof!.options?.title).toBe('prof');
  });

  it('lamp spec → hmi-lamp with ordered bindings + labels JSON', () => {
    const tiles = specToTiles(autoScreen(names([
      'plc.Main.mot.run', 'plc.Main.mot.fault', 'plc.Main.mot.inpos',
    ])));
    const lamp = tiles.find((t) => t.type === 'hmi-lamp');
    expect(lamp).toBeDefined();
    expect(lamp!.bindings).toHaveLength(3);
    const labels = JSON.parse(String(lamp!.options?.labels ?? '{}')) as Record<string, string>;
    expect(labels.run).toBe('RUN');
    expect(labels.fault).toBe('FAULT');
  });

  it('flows tiles left→right and wraps at 12 columns', () => {
    /* 5 scalars → 5 digital (3x2) + alarms (5x3): row1 = 4 tiles
       (12 cols), row2 = digital + alarms */
    const tiles = specToTiles(autoScreen(names([
      'plc.Main.a', 'plc.Main.b', 'plc.Main.c', 'plc.Main.d',
      'plc.Main.e',
    ])));
    const row1 = tiles.filter((t) => t.y === 0);
    const row2 = tiles.filter((t) => t.y === 2);
    expect(row1).toHaveLength(4);
    expect(row2.length).toBeGreaterThan(0);
    expect(row1.every((t) => t.x + t.w <= 12)).toBe(true);
  });

  it('autoBoardTiles end-to-end produces a non-empty board', () => {
    const tiles = autoBoardTiles(names(['plc.Main.cnt']));
    expect(tiles.length).toBeGreaterThanOrEqual(2); // digital + alarms
  });
});
