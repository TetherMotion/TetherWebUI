import { describe, expect, it } from 'vitest';

import type { CatalogEntry } from '../protocol';
import { prefixFromBinding, resolveRoles } from './faceplate';

function entry(name: string, kind: 'param' | 'signal' = 'signal'): CatalogEntry {
  return {
    id: 1n, schemaEpoch: 1n, schemaSlot: 0, flags: 0,
    name, description: '', group: '', kind,
  };
}

const CATALOG: CatalogEntry[] = [
  entry('plc.Main.TIC101.PV'),
  entry('plc.Main.TIC101.SP', 'param'),
  entry('plc.Main.TIC101.OUT'),
  entry('plc.Main.TIC101.AUTO'),
  entry('plc.Main.TIC101.MAN'),
  entry('plc.Main.TIC101.FAULT'),
  entry('plc.Main.M101.STATE'),
  entry('plc.Main.M101.RUN'),
  entry('plc.Main.M101.FWD'),
  entry('plc.Main.M101.READY'),
  entry('plc.Main.V101.POS'),
  entry('plc.Main.V101.OPEN'),
  entry('plc.Main.V101.CMD', 'param'),
];

describe('faceplate role resolution', () => {
  it('resolves loop roles by prefix + suffix convention', () => {
    const roles = resolveRoles('loop', 'plc.Main.TIC101', undefined, CATALOG);
    const byRole = Object.fromEntries(roles.map((r) => [r.role, r.name]));
    expect(byRole.pv).toBe('plc.Main.TIC101.PV');
    expect(byRole.sp).toBe('plc.Main.TIC101.SP');
    expect(byRole.out).toBe('plc.Main.TIC101.OUT');
    expect(byRole.auto).toBe('plc.Main.TIC101.AUTO');
    expect(byRole.man).toBe('plc.Main.TIC101.MAN');
    expect(byRole.fault).toBe('plc.Main.TIC101.FAULT');
    /* REM has no matching signal — unresolved, not an error */
    expect(byRole.rem).toBeUndefined();
  });

  it('is case-insensitive on catalog names', () => {
    const roles = resolveRoles('loop', 'plc.main.tic101', undefined, CATALOG);
    expect(roles.find((r) => r.role === 'pv')?.name).toBe('plc.Main.TIC101.PV');
  });

  it('explicit roles JSON overrides convention', () => {
    const roles = resolveRoles(
      'loop', 'plc.Main.TIC101',
      '{"pv":"plc.Main.V101.POS","sp":"plc.Main.V101.CMD"}',
      CATALOG,
    );
    expect(roles.find((r) => r.role === 'pv')?.name).toBe('plc.Main.V101.POS');
    expect(roles.find((r) => r.role === 'sp')?.name).toBe('plc.Main.V101.CMD');
    /* untouched roles still resolve by convention */
    expect(roles.find((r) => r.role === 'out')?.name).toBe('plc.Main.TIC101.OUT');
  });

  it('resolves motor and valve suffix sets', () => {
    const m = resolveRoles('motor', 'plc.Main.M101', undefined, CATALOG);
    expect(m.find((r) => r.role === 'state')?.name).toBe('plc.Main.M101.STATE');
    expect(m.find((r) => r.role === 'fwd')?.name).toBe('plc.Main.M101.FWD');
    const v = resolveRoles('valve', 'plc.Main.V101', undefined, CATALOG);
    expect(v.find((r) => r.role === 'pos')?.name).toBe('plc.Main.V101.POS');
    expect(v.find((r) => r.role === 'cmd')?.name).toBe('plc.Main.V101.CMD');
  });

  it('bind records the literal polled key; name stays canonical', () => {
    /* lowercase ST vars: the polled candidate keeps suffix case while
       the catalog name keeps declared case — hub.values is keyed by
       the polled string, so lookups must use `bind` */
    const cat = [entry('plc.Main.TIC101.pv'), entry('plc.Main.TIC101.sp', 'param')];
    const roles = resolveRoles('loop', 'plc.Main.TIC101', undefined, cat);
    const pv = roles.find((r) => r.role === 'pv')!;
    expect(pv.name).toBe('plc.Main.TIC101.pv');
    expect(pv.bind).toBe('plc.Main.TIC101.PV');
    const sp = roles.find((r) => r.role === 'sp')!;
    expect(sp.bind).toBe('plc.Main.TIC101.SP');
  });

  it('generic kind resolves nothing (bindings drive it)', () => {
    expect(resolveRoles('generic', 'plc.x', undefined, CATALOG)).toEqual([]);
  });

  it('prefixFromBinding strips the leaf segment', () => {
    expect(prefixFromBinding('plc.Main.TIC101.PV')).toBe('plc.Main.TIC101');
    expect(prefixFromBinding('plc.Main')).toBe('plc');
    expect(prefixFromBinding('flat')).toBeUndefined();
    expect(prefixFromBinding(undefined)).toBeUndefined();
  });
});
