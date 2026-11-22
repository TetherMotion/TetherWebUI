import { describe, expect, it } from 'vitest';
import {
  blockSource,
  catalogGroups,
  catalogPous,
  libStem,
  projectLibRefs,
  srcBase,
  type CatalogLib,
} from './catalog';
import { emptyProject, type Block, type Network, type Pou } from './model';
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

describe('projectLibRefs', () => {
  const blk = (type_ref: string, patch: Partial<Block> = {}): Block => ({
    id: 1,
    kind: 'fb',
    type_ref,
    pos: { x: 0, y: 0 },
    params: {},
    exec_order: 0,
    negated: [],
    comment: '',
    ...patch,
  });
  const net = (blocks: Block[]): Network => ({
    id: 'n1', kind: 'fbd', label: '', comments: [], assocs: [],
    labels: [], jumps: [], returns: [], blocks, wires: [],
  });
  const pou = (patch: Partial<Pou> = {}): Pou => ({
    id: 'p1', name: 'Main', kind: 'program', en_eno: 'off',
    interface: [], networks: [], ...patch,
  });

  it('collects refs from block types, pins, interface, and globals', () => {
    const fbd = emptyProject('t');
    fbd.pous.push(
      pou({
        interface: [{ name: 'PROF', kind: 'var_in_out', type: 'FB_AtcProfile' }],
        networks: [
          net([
            blk('FB_AtcPid'),
            blk('st', {
              pins: [{ name: 'Q', kind: 'var_in_out', type: 'ARRAY[1..4] OF FB_Queue' }],
            }),
          ]),
        ],
      }),
    );
    fbd.global_vars.push({ name: 'mq', kind: 'var_global', type: 'FB_Mqtt' });
    const refs = projectLibRefs(fbd, {});
    for (const r of ['FB_ATCPID', 'FB_ATCPROFILE', 'FB_QUEUE', 'FB_MQTT'])
      expect(refs.has(r)).toBe(true);
  });

  it('collects refs from attached ST sources and inline-ST bodies', () => {
    const fbd = emptyProject('t');
    fbd.pous.push(
      pou({
        networks: [
          net([
            blk('st', { params: { CODE: 'VAR\n  tuner : FB_AtcTune;\nEND_VAR\nOut := 1;' } }),
          ]),
        ],
      }),
    );
    const srcs = { main: 'PROGRAM Main\nVAR\n  pid : FB_AtcPid;\nEND_VAR\nEND_PROGRAM' };
    const refs = projectLibRefs(fbd, srcs);
    expect(refs.has('FB_ATCTUNE')).toBe(true);
    expect(refs.has('FB_ATCPID')).toBe(true);
  });

  it('excludes names the project declares itself', () => {
    const fbd = emptyProject('t');
    fbd.pous.push(pou({ name: 'FB_MyCtrl' }));
    const srcs = {
      mine: 'FUNCTION_BLOCK FB_MyLib\nVAR x : INT; END_VAR\nEND_FUNCTION_BLOCK',
    };
    const refs = projectLibRefs(fbd, srcs);
    expect(refs.has('FB_MYCTRL')).toBe(false);
    expect(refs.has('FB_MYLIB')).toBe(false);
  });
});
