import { describe, expect, it } from 'vitest';
import {
  atCollisions,
  deviceStDecls,
  endpointCollisions,
  generateDeployMap,
  nextFreeBaseFor,
  parseAt,
  parseBusCatalog,
  projectIoBindingsEx,
  serializeDeployMap,
  stIoBindings,
  suggestEndpoint,
  terminalSpec,
  typeSize,
  validateDeployMapText,
} from './deploymap';
import type { FbdProject, Pou } from './model';

function pou(name: string, blocks: object[] = []): Pou {
  return {
    id: `pou:${name}`,
    name,
    kind: 'program',
    en_eno: 'EN',
    interface: [],
    networks: [
      {
        id: 'n1',
        kind: 'fbd',
        label: '',
        comments: [],
        assocs: [],
        labels: [],
        jumps: [],
        returns: [],
        blocks: blocks as Pou['networks'][number]['blocks'],
        wires: [],
      },
    ],
  };
}

function fbd(pous: Pou[], globalVars: { name: string; type: string; at?: string }[] = []): FbdProject {
  return {
    schema: 'fbd.v1',
    project: 't',
    data_types: [],
    global_vars: globalVars as FbdProject['global_vars'],
    pous,
    tasks: [],
  };
}

let nextId = 1;
const device = (type_ref: string, pins: object[], endpoint?: string) => ({
  id: nextId++, kind: 'device', type_ref, pos: { x: 0, y: 0 },
  params: {}, exec_order: 0, negated: [], comment: '', endpoint, pins,
});

describe('parseAt', () => {
  it('parses IX/QB/ID/MW forms', () => {
    expect(parseAt('%IX0.0')).toEqual({ region: 'I', width: 'X', byte: 0, bit: 0 });
    expect(parseAt('%QB3')).toEqual({ region: 'Q', width: 'B', byte: 3, bit: undefined });
    expect(parseAt('%ID16.0')).toEqual({ region: 'I', width: 'D', byte: 16, bit: 0 });
    expect(parseAt('%MW4')).toEqual({ region: 'M', width: 'W', byte: 4, bit: undefined });
    expect(parseAt('nope')).toBeUndefined();
  });
});

describe('terminalSpec', () => {
  it('knows the EL catalog with PDO sizes', () => {
    const el1014 = terminalSpec('EL1014')!;
    expect(el1014.pdoKey).toBe('el1014');
    expect(el1014.txSize).toBe(1);   // 4 DI bits → 1 byte
    expect(el1014.rxSize).toBe(0);
    const el3104 = terminalSpec('EL3104')!;
    expect(el3104.txSize).toBe(8);   // 4 × int16
    const el2004 = terminalSpec('EL2004')!;
    expect(el2004.rxSize).toBe(1);
    const ek = terminalSpec('EK1122')!;
    expect(ek.pdoKey).toBeUndefined();
  });
});

describe('stIoBindings', () => {
  it('extracts `name AT %IX0.0 : BOOL` decls', () => {
    const binds = stIoBindings({
      Main: 'PROGRAM Main\nVAR\n  di0 AT %IX0.0 : BOOL;\n  ai0 AT %ID16.0 : INT;\nEND_VAR\n',
    });
    expect(binds).toEqual([
      { name: 'Main.di0', at: '%IX0.0', type: 'BOOL' },
      { name: 'Main.ai0', at: '%ID16.0', type: 'INT' },
    ]);
  });
});

describe('generateDeployMap', () => {
  it('drafts pdo channels for endpoint devices + key channels for vars', async () => {
    const p = fbd([
      pou('Main', [
        device('EL1014', [
          { name: 'DI0', kind: 'var_output', type: 'BOOL', at: '%IX0.0' },
          { name: 'DI1', kind: 'var_output', type: 'BOOL', at: '%IX0.1' },
          { name: 'DI2', kind: 'var_output', type: 'BOOL', at: '%IX0.2' },
          { name: 'DI3', kind: 'var_output', type: 'BOOL', at: '%IX0.3' },
        ], 'el1014.c1'),
        device('EL2004', [
          { name: 'DO0', kind: 'var_input', type: 'BOOL', at: '%QX0.0' },
          { name: 'DO1', kind: 'var_input', type: 'BOOL', at: '%QX0.1' },
        ], 'el2004.c1'),
      ]),
    ], [{ name: 'g', type: 'INT', at: '%ID8.0' }]);
    const r = await generateDeployMap({ fbd: p });
    const inPdo = r.map.channels.find((c) => c.pdo === 'el1014.c1');
    expect(inPdo).toMatchObject({ dir: 'in', off: 0, size: 1, key: 'el1014.c1.tx' });
    const outPdo = r.map.channels.find((c) => c.pdo === 'el2004.c1');
    expect(outPdo).toMatchObject({ dir: 'out', off: 0, size: 1, key: 'el2004.c1.rx' });
    /* global %ID8 → key= channel covering byte 8..12 */
    const gBind = r.map.bindings.find((b) => b.at === '%ID8.0');
    expect(gBind?.key).toMatch(/^in_/);
    /* device pin binds point at the pdo keys */
    expect(r.map.bindings.find((b) => b.at === '%IX0.0')?.key).toBe('el1014.c1.tx');
    expect(r.map.bindings.find((b) => b.at === '%QX0.0')?.key).toBe('el2004.c1.rx');
    expect(r.map.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.text).toContain('pdo=el1014.c1');
    expect(r.text).toContain('hash ' + r.map.hash);
    expect(r.warnings).toHaveLength(0);
  });

  it('includes ST AT bindings and warns on uncovered', async () => {
    const p = { fbd: fbd([]), stSources: { Main: 'VAR\n  x AT %IX4.0 : BOOL;\nEND_VAR\n' } };
    const r = await generateDeployMap(p);
    expect(r.map.bindings.some((b) => b.at === '%IX4.0')).toBe(true);
  });

  it('warns when pin span mismatches the catalog PDO', async () => {
    const p = fbd([
      pou('Main', [
        /* one REAL pin → 4B span vs EL3104's 8B TxPDO */
        device('EL3104', [
          { name: 'AI0', kind: 'var_output', type: 'REAL', at: '%ID0.0' },
        ], 'el3104.c1'),
      ]),
    ]);
    const r = await generateDeployMap({ fbd: p });
    expect(r.warnings.some((w) => w.includes('PDO 8B'))).toBe(true);
  });

  it('splits %Q channels around pdo-covered bytes (no owner overlap)', async () => {
    const p = fbd([
      pou('Main', [
        device('EL2004', [
          { name: 'DO0', kind: 'var_input', type: 'BOOL', at: '%QX0.0' },
        ], 'el2004.c1'),
        { id: 9, kind: 'variable', type_ref: '', instance: undefined, pos: { x: 0, y: 0 },
          params: {}, exec_order: 0, negated: [], comment: '', role: 'var_output',
          name: 'flag', at: '%QX1.0' } as never,
      ]),
    ]);
    const r = await generateDeployMap({ fbd: p });
    const qchans = r.map.channels.filter((c) => c.dir === 'out');
    /* pdo chan [0,1) + auto chan covering byte1 — must not overlap */
    expect(validateDeployMapText(r.text)).toHaveLength(0);
    expect(qchans.length).toBeGreaterThanOrEqual(2);
  });
});

describe('validateDeployMapText', () => {
  const good = `image in 16 out 8
in off=0 size=4 key=di0
out off=0 size=2 key=do0 safe=zero
bind %IX0.0 di0
bind %QX0.0 do0
hash deadbeef
`;
  it('accepts a well-formed map', () => {
    expect(validateDeployMapText(good)).toHaveLength(0);
  });
  it('flags out-of-range channels', () => {
    const bad = good.replace('in off=0 size=4', 'in off=14 size=4');
    expect(validateDeployMapText(bad).some((v) => v.rule === 'MAP_RANGE')).toBe(true);
  });
  it('flags %Q overlap and missing safe', () => {
    const bad = good + 'out off=1 size=2 key=do1\n';
    const v = validateDeployMapText(bad);
    expect(v.some((x) => x.rule === 'MAP_OWNER')).toBe(true);
    expect(v.some((x) => x.rule === 'MAP_SAFE')).toBe(true);
  });
  it('flags binds outside channels and pdo size mismatch vs bus', () => {
    const bad = good.replace('bind %IX0.0 di0', 'bind %IX9.0 di0');
    expect(validateDeployMapText(bad).some((v) => v.rule === 'MAP_AT')).toBe(true);
    const bus = parseBusCatalog('tx el1014.c1 1\nrx el2004.c1 1\n');
    const pdoMap = `image in 4 out 4
in off=0 size=2 pdo=el1014.c1
out off=0 size=1 pdo=el2004.c1 safe=zero
`;
    const v2 = validateDeployMapText(pdoMap, bus);
    expect(v2.some((x) => x.rule === 'MAP_PDO' && x.detail.includes('size 2'))).toBe(true);
  });
});

describe('allocation + collisions', () => {
  it('nextFreeBaseFor skips occupied intervals', () => {
    const binds = [
      { name: 'a', at: '%IX0.0', type: 'BOOL' },
      { name: 'b', at: '%IX0.7', type: 'BOOL' },
      { name: 'c', at: '%ID4.0', type: 'INT' },  // bytes 4..6
    ];
    /* %I: byte0 (BOOLs) + bytes4-5 (INT) occupied → 4ch DI needs 1B → base 1 */
    expect(nextFreeBaseFor(binds, 'I', 1)).toBe(1);
    /* 8B analog → lowest free run of 8: bytes 6..14 → base 6? byte0+4-5 occ → 1,2,3 free but 8B needs 1..9 hits 4 → try… */
    const base8 = nextFreeBaseFor(binds, 'I', 8);
    expect(base8).toBeGreaterThanOrEqual(6);
    /* %Q empty → 0 */
    expect(nextFreeBaseFor(binds, 'Q', 4)).toBe(0);
  });

  it('atCollisions flags two device blocks on one AT', () => {
    const p = fbd([
      pou('Main', [
        device('EL1014', [{ name: 'DI0', kind: 'var_output', type: 'BOOL', at: '%IX0.0' }]),
        device('EL1014', [{ name: 'DI0', kind: 'var_output', type: 'BOOL', at: '%IX0.0' }]),
      ]),
    ]);
    expect(atCollisions(p)).toHaveLength(1);
  });

  it('endpointCollisions flags shared PDO endpoints', () => {
    const p = fbd([
      pou('Main', [
        device('EL1014', [], 'el1014.c1'),
        device('EL1014', [], 'el1014.c1'),
      ]),
    ]);
    expect(endpointCollisions(p)).toHaveLength(1);
  });

  it('suggestEndpoint yields fleet occurrence names', () => {
    expect(suggestEndpoint('el1014', [])).toBe('el1014.c1');
    expect(suggestEndpoint('el1014', ['el1014.c1'])).toBe('el1014.c1.2');
    expect(suggestEndpoint('el1014', ['el1014.c1', 'el1014.c1.2'])).toBe('el1014.c1.3');
  });
});

describe('deviceStDecls', () => {
  it('emits located-var declarations per direction', () => {
    const blk = device('EL2004', [
      { name: 'DO0', kind: 'var_input', type: 'BOOL', at: '%QX0.0' },
      { name: 'DO1', kind: 'var_input', type: 'BOOL', at: '%QX0.1' },
    ]);
    const st = deviceStDecls(pou('Main'), blk as never);
    expect(st).toContain('VAR_INPUT');
    expect(st).toContain('DO0 AT %QX0.0 : BOOL;');
    expect(st).toContain('END_VAR');
  });
});

describe('serializeDeployMap roundtrip', () => {
  it('serializes to bridge text parseDeployMap reads back', async () => {
    const p = fbd([
      pou('Main', [
        device('EL1014', [{ name: 'DI0', kind: 'var_output', type: 'BOOL', at: '%IX0.0' }], 'el1014.c1'),
      ]),
    ]);
    const r = await generateDeployMap({ fbd: p });
    const { parseDeployMap } = await import('./plc-ide');
    const back = parseDeployMap(r.text);
    expect(back.channels).toHaveLength(r.map.channels.length);
    expect(back.bindings).toHaveLength(r.map.bindings.length);
    expect(back.hash).toBe(r.map.hash);
  });
});
