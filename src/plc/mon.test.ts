import { describe, expect, it, vi } from 'vitest';
import { ValueType, type CatalogEntry } from '../protocol';
import type { SchemaNodeV6 } from '../schema-v6/types';
import type { TetherIOClient } from '../client';
import { entryWritable, probeKeys, resolveKey, varKeys, writeScalar } from './mon';
import { encodeScalarArgument } from '../protocol/function-codec';
import type { Block, Pou } from './model';

const scalarNode = (scalarType: ValueType): SchemaNodeV6 => ({
  key: new Uint8Array([1]),
  revision: 1,
  kind: 1,
  flags: 0,
  name: 't',
  description: '',
  annotations: new Map(),
  scalarType,
  maxBytes: 0,
  fixedCount: 0,
  minCount: 0,
  maxCount: 0,
  structEncoding: 0,
  fields: [],
  oneOfMembers: [],
});

const entry = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id: 7n,
  schemaEpoch: 0n,
  schemaSlot: 0,
  flags: 0,
  name: 'plc.main.x',
  description: '',
  group: '',
  kind: 'param',
  ...over,
});

const pou: Pou = {
  id: 'p1',
  name: 'main',
  kind: 'program',
  en_eno: 'off',
  interface: [],
  networks: [],
};

const varBlock = (over: Partial<Block> = {}): Block => ({
  id: 1,
  kind: 'variable',
  type_ref: '',
  pos: { x: 0, y: 0 },
  params: {},
  exec_order: 0,
  negated: [],
  comment: '',
  ...over,
});

function fakeClient(node?: SchemaNodeV6) {
  const setParameter = vi.fn(async () => {});
  const client = {
    schemaCatalog: node
      ? { epoch: 0, manifest: [], nodesByKey: new Map(), slotToNode: [node] }
      : undefined,
    setParameter,
  } as unknown as TetherIOClient;
  return { client, setParameter };
}

describe('entryWritable', () => {
  it('gates on the 0x02 catalog flag', () => {
    expect(entryWritable(entry({ flags: 0 }))).toBe(false);
    expect(entryWritable(entry({ flags: 0x02 }))).toBe(true);
    expect(entryWritable(entry({ flags: 0x06 }))).toBe(true);
    expect(entryWritable(entry({ flags: 0x01 }))).toBe(false);
  });
});

describe('key resolution', () => {
  it('probeKeys builds the lowered probe var name', () => {
    expect(probeKeys(pou, 42)).toEqual(['plc.main.__probe_42']);
  });

  it('varKeys covers name, io shadow, and image channel', () => {
    const b = varBlock({ name: 'btn', at: '%IX0.0' });
    expect(varKeys(pou, b)).toEqual(['plc.main.btn', 'plc.main.__io_btn', 'plc.image.I.ch.btn']);
  });

  it('resolveKey picks the first key present in values', () => {
    const values = new Map<string, unknown>([['plc.main.__io_btn', true]]);
    expect(resolveKey(['plc.main.btn', 'plc.main.__io_btn'], values)).toBe('plc.main.__io_btn');
    expect(resolveKey(['plc.main.nope'], values)).toBeUndefined();
  });
});

describe('writeScalar', () => {
  it('encodes with the schema scalar type and writes raw bytes', async () => {
    const { client, setParameter } = fakeClient(scalarNode(ValueType.I16));
    await writeScalar(client, entry(), -3);
    expect(setParameter).toHaveBeenCalledWith(7n, encodeScalarArgument(ValueType.I16, -3));
  });

  it('writes unsigned widths too', async () => {
    const { client, setParameter } = fakeClient(scalarNode(ValueType.U32));
    await writeScalar(client, entry(), 70000);
    expect(setParameter).toHaveBeenCalledWith(7n, encodeScalarArgument(ValueType.U32, 70000));
  });

  it('rejects non-scalar schema kinds', async () => {
    const struct = { ...scalarNode(ValueType.F64), kind: 5 };
    const { client } = fakeClient(struct);
    await expect(writeScalar(client, entry(), 1)).rejects.toThrow('not a scalar');
  });

  it('rejects when no schema catalog is present', async () => {
    const { client } = fakeClient();
    await expect(writeScalar(client, entry(), 1)).rejects.toThrow('not a scalar');
  });
});
