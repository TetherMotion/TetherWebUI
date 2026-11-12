import { describe, expect, it } from 'vitest';
import { Block, Network, Pou } from './model';
import {
  atTy,
  BOOL,
  coerce,
  convertible,
  inferNetwork,
  INT,
  narrows,
  opResultTy,
  parseTy,
  REAL,
  tyName,
  unifyNum,
} from './types';
import { PALETTE, castGroup, libraryFbItems, projectFbItems, livePin } from './palette';

function pou(name = 'Main', kind: Pou['kind'] = 'program', iface: Pou['interface'] = []): Pou {
  return {
    id: name,
    name,
    kind,
    en_eno: 'off',
    interface: iface,
    networks: [
      {
        id: 'n1',
        kind: 'fbd',
        label: '',
        blocks: [],
        wires: [],
        assocs: [],
        comments: [],
        labels: [],
        jumps: [],
        returns: [],
      },
    ],
  };
}

function net(blocks: Block[], wires: Network['wires'] = []): Network {
  return {
    id: 'n1',
    kind: 'fbd',
    label: '',
    blocks,
    wires,
    assocs: [],
    comments: [],
    labels: [],
    jumps: [],
    returns: [],
  };
}

const varIn = (id: number, name: string): Block => ({
  id,
  kind: 'variable',
  type_ref: '',
  pos: { x: 0, y: 0 },
  params: {},
  exec_order: 0,
  negated: [],
  comment: '',
  role: 'in',
  name,
});
const varOut = (id: number, name: string): Block => ({
  id,
  kind: 'variable',
  type_ref: '',
  pos: { x: 0, y: 0 },
  params: {},
  exec_order: 0,
  negated: [],
  comment: '',
  role: 'out',
  name,
});
const opBlk = (id: number, type: string): Block => ({
  id,
  kind: 'operator',
  type_ref: type,
  pos: { x: 0, y: 0 },
  params: {},
  exec_order: 0,
  negated: [],
  comment: '',
});

describe('type model', () => {
  it('parses IEC scalars, strings and arrays', () => {
    expect(parseTy('BOOL', [])).toEqual(BOOL);
    expect(parseTy('LREAL', [])).toEqual(REAL(64));
    expect(parseTy('DINT', [])).toEqual(INT(32, true));
    expect(parseTy('UDINT', [])).toEqual(INT(32, false));
    expect(parseTy('ARRAY[1..8] OF REAL', [])).toEqual({
      k: 'array',
      lo: 1,
      hi: 8,
      elem: REAL(32),
    });
    expect(parseTy('STRING(20)', [])).toEqual({ k: 'str', cap: 20, w: false });
    expect(parseTy('WSTRING', [])).toEqual({ k: 'str', cap: 80, w: true });
    expect(parseTy('MyFb', [pou('MyFb', 'function_block')])).toEqual({ k: 'fb', name: 'MYFB' });
    expect(parseTy('Nope', [])).toEqual({ k: 'unknown' });
  });

  it('mirrors the compiler coercion matrix', () => {
    // exact
    expect(coerce(REAL(64), REAL(64))).toBe('exact');
    expect(coerce(INT(32), INT(32))).toBe('exact');
    // widening / convertible
    expect(coerce(INT(16), REAL(64))).toBe('ok');
    expect(coerce(INT(16), INT(32))).toBe('ok');
    // narrowing warns
    expect(coerce(REAL(64), REAL(32))).toBe('narrow');
    expect(coerce(REAL(32), INT(32))).toBe('narrow');
    expect(coerce(INT(32), BOOL)).toBe('narrow');
    // incompatible
    expect(coerce(BOOL, REAL(32))).toBe('bad');
    expect(coerce({ k: 'array', lo: 1, hi: 2, elem: BOOL }, REAL(32))).toBe('bad');
    expect(coerce({ k: 'fb', name: 'X' }, { k: 'fb', name: 'Y' })).toBe('bad');
    // helpers
    expect(convertible(BOOL, INT(16))).toBe(true);
    expect(narrows(INT(32), INT(16))).toBe(true);
    expect(narrows(INT(16), INT(32))).toBe(false);
    expect(unifyNum(INT(16), REAL(32))).toEqual(REAL(32));
    expect(unifyNum(INT(16), INT(32))).toEqual(INT(32, true));
    expect(unifyNum(INT(16, true), INT(16, false))).toEqual(INT(16, false));
  });

  it('types %locations', () => {
    expect(atTy('%IX0.0')).toEqual(BOOL);
    expect(atTy('%IW2')).toEqual(INT(16, true));
    expect(atTy('%QD4')).toEqual(INT(32, true));
    expect(atTy('%ML0')).toEqual(INT(64, true));
    expect(atTy(undefined)).toEqual({ k: 'unknown' });
  });

  it('derives operator result types', () => {
    expect(opResultTy('ADD', [REAL(32), REAL(32)])).toEqual(REAL(32));
    expect(opResultTy('ADD', [INT(16), REAL(64)])).toEqual(REAL(64));
    expect(opResultTy('GT', [REAL(32), REAL(32)])).toEqual(BOOL);
    expect(opResultTy('AND', [BOOL, BOOL])).toEqual(BOOL);
    expect(opResultTy('NOT', [BOOL])).toEqual(BOOL);
    expect(opResultTy('SEL', [BOOL, INT(16), INT(32)])).toEqual(INT(32, true));
    expect(opResultTy('MUX', [INT(32), REAL(32), REAL(32)])).toEqual(REAL(32));
    expect(opResultTy('LIMIT', [INT(16), INT(16), INT(16)])).toEqual(INT(16, true));
    expect(opResultTy('REAL_TO_DINT', [REAL(32)])).toEqual(INT(32, true));
    expect(opResultTy('DINT_TO_REAL', [INT(32)])).toEqual(REAL(32));
    expect(tyName(opResultTy('REAL_TO_DINT', [REAL(32)]))).toBe('DINT');
  });
});

describe('network inference', () => {
  it('propagates through operators and flags mismatches', () => {
    const main = pou('Main', 'program', [
      { name: 'T', kind: 'var_input', type: 'LREAL' },
      { name: 'Q', kind: 'var_output', type: 'REAL' },
    ]);
    // T (LREAL) → ADD with 1.0 → REAL pin? then into BOOL output
    const n = net(
      [varIn(1, 'T'), opBlk(2, 'ADD'), varOut(3, 'Q')],
      [
        { id: 10, src: { block: 1, port: 0 }, dsts: [{ block: 2, port: 0 }] },
        { id: 11, src: { block: 2, port: 0 }, dsts: [{ block: 3, port: 0 }] },
      ],
    );
    main.networks[0] = n;
    const inf = inferNetwork(n, main, [main]);
    expect(inf.pin.get('1:out:0')).toEqual(REAL(64));
    expect(inf.pin.get('2:out:0')).toEqual(REAL(64));
    // LREAL → REAL output pin is a narrowing, not an error
    expect(inf.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
    expect(
      inf.issues.some((i) => i.severity === 'warning' && i.message.includes('narrowing')),
    ).toBe(true);
  });

  it('reports BOOL→REAL as an error and BOOL operands of ADD', () => {
    const main = pou('Main', 'program', [
      { name: 'B', kind: 'var_input', type: 'BOOL' },
      { name: 'R', kind: 'var_output', type: 'REAL' },
    ]);
    const n = net(
      [varIn(1, 'B'), opBlk(2, 'MOVE'), varOut(3, 'R')],
      [
        { id: 10, src: { block: 1, port: 0 }, dsts: [{ block: 2, port: 0 }] },
        { id: 11, src: { block: 2, port: 0 }, dsts: [{ block: 3, port: 0 }] },
      ],
    );
    main.networks[0] = n;
    const inf = inferNetwork(n, main, [main]);
    const errs = inf.issues.filter((i) => i.severity === 'error').map((i) => i.message);
    expect(errs.join('\n')).toMatch(/type mismatch: BOOL → REAL/);

    // REAL → BOOL is not convertible (matches tplc-mir::ty)
    const n3 = net(
      [varIn(1, 'R'), varOut(2, 'B')],
      [{ id: 10, src: { block: 1, port: 0 }, dsts: [{ block: 2, port: 0 }] }],
    );
    const main3 = pou('Main', 'program', [
      { name: 'R', kind: 'var_input', type: 'REAL' },
      { name: 'B', kind: 'var_output', type: 'BOOL' },
    ]);
    const inf3 = inferNetwork(n3, main3, [main3]);
    expect(inf3.issues.some((i) => i.message.includes('REAL → BOOL'))).toBe(true);

    // ADD fed by a BOOL is an operator-class error
    const n2 = net(
      [varIn(1, 'B'), opBlk(2, 'ADD')],
      [{ id: 10, src: { block: 1, port: 0 }, dsts: [{ block: 2, port: 0 }] }],
    );
    const inf2 = inferNetwork(n2, main, [main]);
    expect(inf2.issues.some((i) => i.message.includes('ADD: operands must be numeric'))).toBe(true);
  });

  it('types builtin FB pins', () => {
    const main = pou('Main', 'program', [{ name: 'Go', kind: 'var_input', type: 'BOOL' }]);
    const ton: Block = {
      id: 2,
      kind: 'fb',
      type_ref: 'TON',
      instance: 't1',
      pos: { x: 0, y: 0 },
      params: {},
      exec_order: 0,
      negated: [],
      comment: '',
    };
    const n = net(
      [varIn(1, 'Go'), ton],
      [{ id: 10, src: { block: 1, port: 0 }, dsts: [{ block: 2, port: 'IN' }] }],
    );
    const inf = inferNetwork(n, main, [main]);
    expect(inf.pin.get('2:in:0')).toEqual(BOOL);
    expect(inf.pin.get('2:in:1')).toEqual({ k: 'time' });
    expect(inf.pin.get('2:out:0')).toEqual(BOOL);
    expect(inf.pin.get('2:out:1')).toEqual({ k: 'time' });
    expect(inf.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });
});

describe('palette', () => {
  it('covers every operator the compiler accepts', () => {
    const types = PALETTE.flatMap((g) => g.items.map((i) => i.type));
    for (const op of [
      'AND',
      'OR',
      'XOR',
      'NOT',
      'ADD',
      'SUB',
      'MUL',
      'DIV',
      'MOD',
      'ABS',
      'MIN',
      'MAX',
      'GT',
      'GE',
      'LT',
      'LE',
      'EQ',
      'NE',
      'SEL',
      'LIMIT',
      'MUX',
      'MOVE',
      'SHL',
      'SHR',
      'ROL',
      'ROR',
    ])
      expect(types).toContain(op);
    for (const fb of ['TON', 'TOF', 'TP', 'R_TRIG', 'F_TRIG', 'SR', 'RS', 'CTU', 'CTD', 'CTUD'])
      expect(types).toContain(fb);
  });

  it('offers conversions for scalar pairs', () => {
    const casts = castGroup().items;
    expect(casts.some((c) => c.type === 'REAL_TO_DINT')).toBe(true);
    expect(casts.some((c) => c.type === 'INT_TO_LREAL')).toBe(true);
    expect(casts.every((c) => c.type.includes('_TO_'))).toBe(true);
  });

  it('lists project POUs and library FBs', () => {
    const fbPou = pou('Mixer', 'function_block', [{ name: 'X', kind: 'var_input', type: 'REAL' }]);
    const items = projectFbItems([pou('Main'), fbPou], pou('Main'));
    expect(items.map((i) => i.type)).toEqual(['Mixer']);
    expect(items[0]!.hint).toContain('X');

    const lib =
      'FUNCTION_BLOCK FB_AtcPid\nEND_FUNCTION_BLOCK\nFUNCTION_BLOCK FB_AtcProfile\nEND_FUNCTION_BLOCK\n';
    const libs = libraryFbItems([lib], []);
    expect(libs.map((i) => i.type)).toEqual(['FB_AtcPid', 'FB_AtcProfile']);
    // project POUs shadow library names
    expect(libraryFbItems([lib], [pou('FB_AtcPid', 'function_block')]).map((i) => i.type)).toEqual([
      'FB_AtcProfile',
    ]);
  });

  it('resolves live values for FB pins and variables', () => {
    const main = pou('Main');
    const fb: Block = {
      id: 2,
      kind: 'fb',
      type_ref: 'FB_AtcPid',
      instance: 'ctl',
      pos: { x: 0, y: 0 },
      params: {},
      exec_order: 0,
      negated: [],
      comment: '',
    };
    const values = new Map<string, unknown>([
      ['plc.Main.ctl.Out', 42.5],
      ['plc.Main.pv', 21],
    ]);
    expect(livePin(main, fb, 'Out', values)).toBe(42.5);
    expect(livePin(main, fb, 'Setpoint', values)).toBeUndefined();
    expect(livePin(main, varIn(1, 'pv'), '', values)).toBe(21);
    expect(livePin(main, fb, 'Out', undefined)).toBeUndefined();
  });
});
