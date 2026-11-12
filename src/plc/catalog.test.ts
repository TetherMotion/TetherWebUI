import { describe, expect, it } from 'vitest';
import {
  blockSource,
  catalogGroups,
  catalogPous,
  libStem,
  srcBase,
  type CatalogLib,
} from './catalog';
import { blockSig } from './sigs';
import { parseTy } from './types';

const LIBS: CatalogLib[] = [
  {
    name: 'tempctrl',
    dir: '/libs/tempctrl',
    catalog: {
      pous: 2,
      errors: 0,
      enums: {},
      blocks: [
        {
          name: 'FB_AtcPid',
          kind: 'fb',
          file: '/libs/tempctrl/atc_tempctrl.st',
          pins: [
            { name: 'Setpoint', dir: 'in', ty: 'REAL' },
            { name: 'Actual', dir: 'in', ty: 'REAL' },
            { name: 'Out', dir: 'out', ty: 'REAL' },
            { name: 'SEG', dir: 'inout', ty: 'ARRAY[1..32] OF ST_AtcSeg' },
          ],
        },
        {
          name: 'F_Clamp',
          kind: 'function',
          ret_ty: 'REAL',
          file: '/libs/tempctrl/atc_tempctrl.st',
          pins: [
            { name: 'X', dir: 'in', ty: 'REAL' },
            { name: 'LO', dir: 'in', ty: 'REAL', init: '0.0' },
          ],
        },
      ],
    },
  },
  {
    name: 'tc2',
    dir: '/libs/tc2',
    catalog: {
      pous: 1,
      errors: 0,
      enums: { E_Mode: ['AUTO', 'MAN'] },
      blocks: [
        {
          name: 'FB_MathMean',
          kind: 'fb',
          file: '/libs/tc2/tc2_math.st',
          pins: [{ name: 'IN', dir: 'inout', ty: 'ARRAY[1..16] OF LREAL' }],
        },
      ],
    },
  },
];

describe('catalog', () => {
  it('derives basenames and stems from catalog file paths', () => {
    expect(srcBase('/a/b/atc_tempctrl.st')).toBe('atc_tempctrl.st');
    expect(srcBase('atc_tempctrl.st')).toBe('atc_tempctrl.st');
    expect(libStem('/a/b/atc_tempctrl.st')).toBe('atc_tempctrl');
    expect(libStem('my lib.ST')).toBe('my lib');
  });

  it('synthesizes typed POU decls usable by sigs/types', () => {
    const pous = catalogPous(LIBS);
    expect(pous).toHaveLength(3);
    const pid = pous.find((p) => p.name === 'FB_AtcPid')!;
    expect(pid.id).toBe('lib:tempctrl:FB_AtcPid');
    expect(pid.kind).toBe('function_block');
    expect(pid.interface.map((v) => `${v.kind}:${v.name}`)).toEqual([
      'var_input:Setpoint',
      'var_input:Actual',
      'var_output:Out',
      'var_in_out:SEG',
    ]);
    const fn = pous.find((p) => p.name === 'F_Clamp')!;
    expect(fn.kind).toBe('function');
    expect(fn.ret_ty).toBe('REAL');
    // signature resolution sees catalog blocks exactly like project POUs
    const sig = blockSig(
      { id: 1, kind: 'fb', type_ref: 'FB_AtcPid', pos: { x: 0, y: 0 }, params: {}, exec_order: 0, negated: [], comment: '' },
      pous,
    );
    expect(sig.ins).toEqual(['Setpoint', 'Actual', 'SEG']);
    expect(sig.outs).toEqual(['Out']);
    const fnSig = blockSig(
      { id: 2, kind: 'function', type_ref: 'F_Clamp', pos: { x: 0, y: 0 }, params: {}, exec_order: 0, negated: [], comment: '' },
      pous,
    );
    // FUNCTION return value is the first output pin
    expect(fnSig.outs[0]).toBe('F_Clamp');
  });

  it('groups palette items per library file with attach metadata', () => {
    const groups = catalogGroups(LIBS);
    expect(groups.map((g) => g.name).sort()).toEqual([
      'tc2 · tc2_math',
      'tempctrl · atc_tempctrl',
    ]);
    const g = groups.find((x) => x.name === 'tempctrl · atc_tempctrl')!;
    expect(new Set(g.items.map((i) => i.type))).toEqual(new Set(['F_Clamp', 'FB_AtcPid']));
    const pid = g.items.find((i) => i.type === 'FB_AtcPid')!;
    expect(pid.kind).toBe('fb');
    expect(pid.lib).toBe('tempctrl');
    expect(pid.srcFile).toBe('atc_tempctrl.st');
  });

  it('resolves block → source for auto-attach', () => {
    expect(blockSource(LIBS, 'FB_AtcPid')).toEqual({ lib: 'tempctrl', file: 'atc_tempctrl.st' });
    expect(blockSource(LIBS, 'NOPE')).toBeUndefined();
  });

  it('parses catalog pin types including arrays', () => {
    const t = parseTy('ARRAY[1..32] OF ST_AtcSeg', catalogPous(LIBS));
    expect(t.k).toBe('array');
    if (t.k === 'array') expect(t.hi).toBe(32);
  });
});
