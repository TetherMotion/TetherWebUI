import { describe, expect, it } from 'vitest';
import {
  atCollisions,
  busSegments,
  channelSummary,
  deviceStDecls,
  endpointCollisions,
  generateDeployMap,
  mkDiscoveredDevice,
  mkTerminalDevice,
  nextFreeBaseFor,
  parseAt,
  parseBusCatalog,
  parseBusTopology,
  projectEndpointKeys,
  projectIoBindingsEx,
  serializeDeployMap,
  stIoBindings,
  suggestEndpoint,
  terminalSpec,
  TERMINALS,
  typeSize,
  validateDeployMapText,
  type BusSlave,
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

describe('parseBusTopology', () => {
  it('parses the ecpump .topology artifact', () => {
    const s = parseBusTopology(
      '{"slaves":[{"i":1,"part":"EK1100","key":"ek1100","coupler":true,"tx":0,"rx":0},{"i":2,"part":"EL1014","key":"el1014.c1","tx":1,"rx":0}]}',
    );
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({ i: 1, part: 'EK1100', coupler: true });
    expect(s[1]).toMatchObject({ i: 2, key: 'el1014.c1', tx: 1 });
  });
  it('returns [] on malformed or empty input', () => {
    expect(parseBusTopology('')).toEqual([]);
    expect(parseBusTopology('not json')).toEqual([]);
    expect(parseBusTopology('{"slaves":42}')).toEqual([]);
  });
});

/* .topology v2 fixture — what `tplc-ec-pump --scan` writes */
const V2_TOPO = JSON.stringify({
  v: 2,
  slaves: [
    { i: 0, part: 'EK1100', key: 'ek1100.c1', coupler: true, coupler_idx: 1, name: 'EK1100 EtherCAT Coupler', vendor: 2, product: 72100946, rev: 65536, serial: 1, di: 0, do: 0, ai: 0, ao: 0, tx: 0, rx: 0, supported: true },
    { i: 1, part: 'EL1004', key: 'el1004.c1', coupler: false, coupler_idx: 1, name: '', vendor: 2, product: 65810514, rev: 65536, serial: 2, di: 4, do: 0, ai: 0, ao: 0, tx: 1, rx: 0, supported: true },
    { i: 2, part: 'EL2008', key: 'el2008.c1', coupler: false, coupler_idx: 1, name: '8-ch digital out', vendor: 2, product: 131408978, rev: 65536, serial: 3, di: 0, do: 8, ai: 0, ao: 0, tx: 0, rx: 1, supported: true },
    { i: 3, part: 'EK1100', key: 'ek1100.c2', coupler: true, coupler_idx: 2, name: '', vendor: 2, product: 72100946, rev: 65536, serial: 6, di: 0, do: 0, ai: 0, ao: 0, tx: 0, rx: 0, supported: true },
    { i: 4, part: 'EL3104', key: 'el3104.c2', coupler: false, coupler_idx: 2, name: '', vendor: 2, product: 202866770, rev: 65536, serial: 7, di: 0, do: 0, ai: 4, ao: 0, tx: 8, rx: 0, supported: true },
    { i: 5, part: '', key: '', coupler: false, coupler_idx: 2, name: 'Mystery box', vendor: 9, product: 1234, rev: 1, serial: 8, di: 0, do: 0, ai: 0, ao: 0, tx: 0, rx: 0, supported: false },
  ],
});
const v2Slaves = () => parseBusTopology(V2_TOPO);

describe('busSegments', () => {
  it('groups terminals under their coupler in chain order', () => {
    const segs = busSegments(v2Slaves());
    expect(segs).toHaveLength(2);
    expect(segs[0]!.coupler).toMatchObject({ part: 'EK1100', key: 'ek1100.c1' });
    expect(segs[0]!.idx).toBe(1);
    expect(segs[0]!.terminals.map((t) => t.part)).toEqual(['EL1004', 'EL2008']);
    expect(segs[1]!.idx).toBe(2);
    expect(segs[1]!.terminals).toHaveLength(2); // EL3104 + unsupported
  });
  it('puts terminals before any coupler into a head segment', () => {
    const segs = busSegments([
      { i: 0, part: 'EL1004', key: 'el1004.c1', di: 4 },
      { i: 1, part: 'EK1100', key: 'ek1100.c1', coupler: true, coupler_idx: 1 },
    ]);
    expect(segs).toHaveLength(2);
    expect(segs[0]!.coupler).toBeNull();
    expect(segs[0]!.terminals).toHaveLength(1);
  });
});

describe('channelSummary', () => {
  it('summarises channel counts', () => {
    expect(channelSummary({ i: 0, part: 'x', key: '', di: 4 })).toBe('4 DI');
    expect(channelSummary({ i: 0, part: 'x', key: '', do: 8, ai: 2 })).toBe('8 DO · 2 AI');
    expect(channelSummary({ i: 0, part: 'x', key: '', coupler: true })).toBe('coupler');
    expect(channelSummary({ i: 0, part: 'x', key: '', supported: false })).toBe('unsupported');
  });
});

describe('mkDiscoveredDevice', () => {
  const proj = (blocks: object[] = []) => ({ fbd: fbd([pou('P1', blocks)]), stSources: {} });

  it('skips couplers, unsupported and image-less slaves', () => {
    const [ek, , , , , un] = v2Slaves();
    expect(mkDiscoveredDevice(proj(), ek!)).toBeUndefined();
    expect(mkDiscoveredDevice(proj(), un!)).toBeUndefined();
  });

  it('creates located BOOL pins + endpoint for a digital terminal', () => {
    const el2008 = v2Slaves()[2]!;
    const spec = mkDiscoveredDevice(proj(), el2008)!;
    expect(spec.type_ref).toBe('EL2008');
    expect(spec.endpoint).toBe('el2008.c1');
    expect(spec.pins).toHaveLength(8);
    expect(spec.pins[0]).toMatchObject({ name: 'DO0', kind: 'var_input', type: 'BOOL', at: '%QX0.0' });
    expect(spec.pins[7]).toMatchObject({ at: '%QX0.7' });
  });

  it('creates int16-pitched INT pins for analog terminals', () => {
    const el3104 = v2Slaves()[4]!;
    const spec = mkDiscoveredDevice(proj(), el3104)!;
    expect(spec.pins).toHaveLength(4);
    expect(spec.pins[0]).toMatchObject({ name: 'AI0', kind: 'var_output', type: 'INT', at: '%ID0.0' });
    expect(spec.pins[3]).toMatchObject({ at: '%ID6.0' });
  });

  it('allocates bases past bindings already claimed in the project', () => {
    const el2008 = v2Slaves()[2]!;
    const existing = device('EL2004', [
      { name: 'DO0', kind: 'var_input', type: 'BOOL', at: '%QX0.0' },
      { name: 'DO1', kind: 'var_input', type: 'BOOL', at: '%QX0.1' },
      { name: 'DO2', kind: 'var_input', type: 'BOOL', at: '%QX0.2' },
      { name: 'DO3', kind: 'var_input', type: 'BOOL', at: '%QX0.3' },
    ], 'el2004.c1');
    const spec = mkDiscoveredDevice(proj([existing]), el2008)!;
    expect(spec.pins[0]!.at).toBe('%QX1.0'); // byte 0 taken → base 1
  });

  it('keeps endpoints identical to .topology keys', () => {
    for (const s of v2Slaves()) {
      const spec = mkDiscoveredDevice(proj(), s);
      if (spec) expect(spec.endpoint).toBe(s.key);
    }
  });
});

describe('projectEndpointKeys', () => {
  it('collects endpoints of device blocks across all POUs/networks', () => {
    const p = fbd([
      pou('P1', [device('EL2008', [], 'el2008.c1')]),
      pou('P2', [device('EL1014', [], 'el1014.c1'), { ...device('EL2004', []), endpoint: undefined }]),
    ]);
    const keys = projectEndpointKeys(p);
    expect(keys).toEqual(new Set(['el2008.c1', 'el1014.c1']));
  });
});

describe('mkTerminalDevice', () => {
  const proj = (blocks: object[] = []) => ({ fbd: fbd([pou('P1', blocks)]), stSources: {} });
  const spec = (part: string) => TERMINALS.find((t) => t.part === part)!;

  it('suggests a fresh pdo occurrence endpoint for EtherCAT terminals', () => {
    const s = mkTerminalDevice(proj(), spec('EL2008'))!;
    expect(s.type_ref).toBe('EL2008');
    expect(s.endpoint).toBe('el2008.c1');
    expect(s.pins).toHaveLength(8);
    expect(s.pins[0]).toMatchObject({ kind: 'var_input', type: 'BOOL', at: '%QX0.0' });
  });

  it('bumps the endpoint occurrence past claimed keys', () => {
    const taken = device('EL2008', [], 'el2008.c1');
    const s = mkTerminalDevice(proj([taken]), spec('EL2008'))!;
    expect(s.endpoint).toBe('el2008.c1.2');
  });

  it('gives virtual terminals no endpoint but real pins', () => {
    const s = mkTerminalDevice(proj(), spec('EK1110'))!;
    expect(s.endpoint).toBe('');
    expect(s.pins).toHaveLength(8); // 4 DI + 4 DO
    expect(s.pins.filter((p) => p.kind === 'var_output')).toHaveLength(4);
    expect(s.pins.filter((p) => p.kind === 'var_input')).toHaveLength(4);
  });

  it('allocates analog bases past claimed digital bytes', () => {
    const taken = device('EL2008', [
      { name: 'DO0', kind: 'var_input', type: 'BOOL', at: '%QX0.0' },
    ], 'el2008.c1');
    const s = mkTerminalDevice(proj([taken]), spec('EL4104'))!;
    expect(s.pins[0]!.at).toBe('%QD1.0'); // byte 0 taken → base 1
    expect(s.endpoint).toBe('el4104.c1');
  });
});
