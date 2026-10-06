import { describe, expect, it } from 'vitest';
import { BinaryWriter, ValueType } from '../protocol';
import { computeSchemaDigestV6 } from './handshake';
import { verifyAndBuildCatalog } from './handshake';
import type { SchemaCatalogV6, SchemaFieldV6, SchemaNodeV6 } from './types';
import { decodeSchemaValue } from './value-codec';

const key = (id: number): Uint8Array => {
  const result = new Uint8Array(16);
  result[15] = id;
  return result;
};
const ref = (node: SchemaNodeV6) => ({ key: node.key, digest: computeSchemaDigestV6(node) });

const node = (partial: Partial<SchemaNodeV6> & { key: Uint8Array }): SchemaNodeV6 => ({
  revision: 1,
  kind: 1,
  flags: 0,
  name: '',
  description: '',
  annotations: new Map(),
  scalarType: ValueType.Binary,
  maxBytes: 0,
  fixedCount: 0,
  minCount: 0,
  maxCount: 0,
  structEncoding: 1,
  fields: [],
  oneOfMembers: [],
  ...partial,
});

const field = (
  partial: Omit<Partial<SchemaFieldV6>, 'schema'> & { key: number; schema: SchemaNodeV6 },
): SchemaFieldV6 => ({
  flags: 0,
  presence: 1,
  name: `f${partial.key}`,
  description: '',
  restrictions: [],
  defaultValue: new Uint8Array(),
  ...partial,
  schema: ref(partial.schema),
});

async function catalogOf(nodes: SchemaNodeV6[]): Promise<SchemaCatalogV6> {
  const manifest = nodes.map((n) => ({ ref: ref(n), revision: n.revision }));
  return verifyAndBuildCatalog(
    { epoch: 1, manifest },
    nodes.map((n) => ({ epoch: 1, node: n })),
  );
}

/** Build a packed-struct catalog whose single field `f1` carries `restrictions`. */
async function restrictedFieldCatalog(
  fieldType: ValueType,
  restrictions: { kind: number; payload: Uint8Array }[],
  schemaExtras: Partial<SchemaNodeV6> = {},
): Promise<SchemaCatalogV6> {
  const inner = node({ key: key(1), kind: 1, scalarType: fieldType, ...schemaExtras });
  const root = node({
    key: key(2),
    kind: 5,
    fields: [field({ key: 1, schema: inner, restrictions })],
  });
  return catalogOf([inner, root]);
}

const u32bytes = (v: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, true);
  return b;
};
const f64bytes = (v: number): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v, true);
  return b;
};

describe('restriction validation', () => {
  it('kind 1: enforces lower, upper, and combined bounds', async () => {
    // One payload may carry both bounds; restriction kinds must be unique and
    // sorted per field, so the variants live on separate fields.
    const both = new BinaryWriter(10).u8(1).u32(10).u8(1).u32(100).finish();
    const lowerOnly = new BinaryWriter(6).u8(1).u32(10).u8(0).finish();
    const upperOnly = new BinaryWriter(6).u8(0).u8(1).u32(100).finish();
    const u32 = node({ key: key(1), scalarType: ValueType.U32 });
    const root = node({
      key: key(2),
      kind: 5,
      fields: [
        field({ key: 1, schema: u32, name: 'ranged', restrictions: [{ kind: 1, payload: both }] }),
        field({
          key: 2,
          schema: u32,
          name: 'lowered',
          restrictions: [{ kind: 1, payload: lowerOnly }],
        }),
        field({
          key: 3,
          schema: u32,
          name: 'uppered',
          restrictions: [{ kind: 1, payload: upperOnly }],
        }),
      ],
    });
    const cat = await catalogOf([u32, root]);
    const enc = (a: number, b: number, c: number) =>
      Uint8Array.from([...u32bytes(a), ...u32bytes(b), ...u32bytes(c)]);
    expect(decodeSchemaValue(cat, 1, enc(50, 10, 100))).toEqual({
      ranged: 50,
      lowered: 10,
      uppered: 100,
    });
    expect(() => decodeSchemaValue(cat, 1, enc(5, 10, 0))).toThrow(/range/);
    expect(() => decodeSchemaValue(cat, 1, enc(101, 10, 0))).toThrow(/range/);
    expect(() => decodeSchemaValue(cat, 1, enc(50, 9, 0))).toThrow(/range/);
    expect(() => decodeSchemaValue(cat, 1, enc(50, 10, 101))).toThrow(/range/);
  });

  it('kind 2: multiple-of applies to integer varints only', async () => {
    const cat = await restrictedFieldCatalog(ValueType.UVarint, [
      { kind: 2, payload: new Uint8Array([4]) },
    ]);
    expect(decodeSchemaValue(cat, 1, new Uint8Array([8]))).toEqual({ f1: 8n });
    expect(() => decodeSchemaValue(cat, 1, new Uint8Array([6]))).toThrow(/multiple-of/);
    // Divisor zero is rejected outright.
    const bad = await restrictedFieldCatalog(ValueType.UVarint, [
      { kind: 2, payload: new Uint8Array([0]) },
    ]);
    expect(() => decodeSchemaValue(bad, 1, new Uint8Array([8]))).toThrow(/multiple-of/);
    // Fixed-width integers decode to number, not bigint — the restriction
    // cannot be satisfied and must fail closed.
    const u8 = await restrictedFieldCatalog(ValueType.U8, [
      { kind: 2, payload: new Uint8Array([4]) },
    ]);
    expect(() => decodeSchemaValue(u8, 1, new Uint8Array([8]))).toThrow(/multiple-of/);
  });

  it('kind 3: finite rejects NaN and Infinity on floats', async () => {
    const cat = await restrictedFieldCatalog(ValueType.F64, [
      { kind: 3, payload: new Uint8Array() },
    ]);
    expect(decodeSchemaValue(cat, 1, f64bytes(1.5))).toEqual({ f1: 1.5 });
    expect(() => decodeSchemaValue(cat, 1, f64bytes(NaN))).toThrow(/finite/);
    expect(() => decodeSchemaValue(cat, 1, f64bytes(Infinity))).toThrow(/finite/);
  });

  it('kind 4: length range applies to strings, bytes, and arrays', async () => {
    // String element schema (kind 2, maxBytes 16).
    const str = node({ key: key(1), kind: 2, maxBytes: 16 });
    const strRoot = node({
      key: key(2),
      kind: 5,
      fields: [
        field({
          key: 1,
          schema: str,
          restrictions: [{ kind: 4, payload: new BinaryWriter(2).u8(2).u8(8).finish() }],
        }),
      ],
    });
    const strCat = await catalogOf([str, strRoot]);
    const ok = new TextEncoder().encode('abcd\0');
    expect(decodeSchemaValue(strCat, 1, ok)).toEqual({ f1: 'abcd' });
    const short = new TextEncoder().encode('x\0');
    expect(() => decodeSchemaValue(strCat, 1, short)).toThrow(/length/);

    // Dynamic array element (u8), restricted to 2..4 elements.
    const u8 = node({ key: key(3), scalarType: ValueType.U8 });
    const arr = node({ key: key(4), kind: 7, minCount: 0, maxCount: 8, element: ref(u8) });
    const arrRoot = node({
      key: key(5),
      kind: 5,
      fields: [
        field({
          key: 1,
          schema: arr,
          restrictions: [{ kind: 4, payload: new BinaryWriter(2).u8(2).u8(4).finish() }],
        }),
      ],
    });
    const arrCat = await catalogOf([u8, arr, arrRoot]);
    const enc = (vals: number[]) => Uint8Array.from([vals.length, ...vals.flatMap((v) => [1, v])]);
    expect(decodeSchemaValue(arrCat, 2, enc([1, 2]))).toEqual({ f1: [1, 2] });
    expect(() => decodeSchemaValue(arrCat, 2, enc([1]))).toThrow(/length/);
    expect(() => decodeSchemaValue(arrCat, 2, enc([1, 2, 3, 4, 5]))).toThrow(/length/);
  });

  it('kind 5: allowed-values accepts only listed encodings', async () => {
    // Two allowed u8 encodings: 0x01, 0x02 (count=2, len=1 each).
    const cat = await restrictedFieldCatalog(ValueType.U8, [
      { kind: 5, payload: new Uint8Array([2, 1, 1, 1, 2]) },
    ]);
    expect(decodeSchemaValue(cat, 1, new Uint8Array([1]))).toEqual({ f1: 1 });
    expect(decodeSchemaValue(cat, 1, new Uint8Array([2]))).toEqual({ f1: 2 });
    expect(() => decodeSchemaValue(cat, 1, new Uint8Array([3]))).toThrow(/allowed-values/);
    // Unsorted allowed-values payloads are rejected.
    const unsorted = await restrictedFieldCatalog(ValueType.U8, [
      { kind: 5, payload: new Uint8Array([2, 1, 2, 1, 1]) },
    ]);
    expect(() => decodeSchemaValue(unsorted, 1, new Uint8Array([1]))).toThrow(/allowed-values/);
  });

  it('kind 6: allowed-members restricts the oneof member key', async () => {
    const u32 = node({ key: key(1), scalarType: ValueType.U32 });
    const f64 = node({ key: key(2), scalarType: ValueType.F64 });
    const oneof = node({
      key: key(3),
      kind: 10,
      oneOfMembers: [
        { key: 1, schema: ref(u32) },
        { key: 2, schema: ref(f64) },
      ],
    });
    const root = node({
      key: key(4),
      kind: 5,
      fields: [
        field({
          key: 1,
          schema: oneof,
          restrictions: [{ kind: 6, payload: new Uint8Array([1]) }],
        }),
      ],
    });
    const cat = await catalogOf([u32, f64, oneof, root]);
    // Member key 1 (u32) is allowed; key 2 (f64) is not.
    const encOneof = (memberKey: number, payload: number[]) =>
      Uint8Array.from([memberKey, payload.length, ...payload]);
    expect(decodeSchemaValue(cat, 3, encOneof(1, [...u32bytes(7)]))).toEqual({
      f1: { key: 1, value: 7 },
    });
    expect(() => decodeSchemaValue(cat, 3, encOneof(2, [...f64bytes(1)]))).toThrow(
      /allowed-members/,
    );
  });

  it('kind 7: unique-elements rejects duplicate array entries', async () => {
    const u8 = node({ key: key(1), scalarType: ValueType.U8 });
    const arr = node({ key: key(2), kind: 7, minCount: 0, maxCount: 8, element: ref(u8) });
    const root = node({
      key: key(3),
      kind: 5,
      fields: [
        field({
          key: 1,
          schema: arr,
          restrictions: [{ kind: 7, payload: new Uint8Array() }],
        }),
      ],
    });
    const cat = await catalogOf([u8, arr, root]);
    const enc = (vals: number[]) => Uint8Array.from([vals.length, ...vals.flatMap((v) => [1, v])]);
    expect(decodeSchemaValue(cat, 2, enc([1, 2, 3]))).toEqual({ f1: [1, 2, 3] });
    expect(() => decodeSchemaValue(cat, 2, enc([1, 2, 1]))).toThrow(/unique-elements/);
  });

  it('rejects unknown restriction kinds even without catalog verification', async () => {
    // Shape validation would refuse kind 99 during handshake; the decoder must
    // still fail closed if it ever sees one on the wire.
    const inner = node({ key: key(9), scalarType: ValueType.U8 });
    const root = node({
      key: key(10),
      kind: 5,
      fields: [
        field({ key: 1, schema: inner, restrictions: [{ kind: 99, payload: new Uint8Array() }] }),
      ],
    });
    const keyHex = (k: Uint8Array) => [...k].map((b) => b.toString(16).padStart(2, '0')).join('');
    const cat: SchemaCatalogV6 = {
      epoch: 1,
      manifest: [{ ref: ref(root), revision: 1 }],
      nodesByKey: new Map([
        [keyHex(inner.key), inner],
        [keyHex(root.key), root],
      ]),
      slotToNode: [root],
    };
    expect(() => decodeSchemaValue(cat, 0, new Uint8Array([1]))).toThrow(/unknown restriction/);
  });

  it('rejects unique-elements on non-array fields', async () => {
    const cat = await restrictedFieldCatalog(ValueType.U8, [
      { kind: 7, payload: new Uint8Array() },
    ]);
    expect(() => decodeSchemaValue(cat, 1, new Uint8Array([1]))).toThrow(/non-array field/);
  });
});

describe('struct encodings', () => {
  it('decodes tagged structs, skipping absent optionals and rejecting unknown keys', async () => {
    const u32 = node({ key: key(1), scalarType: ValueType.U32 });
    const str = node({ key: key(2), kind: 2, maxBytes: 32 });
    const root = node({
      key: key(3),
      kind: 5,
      structEncoding: 2,
      fields: [
        field({ key: 1, schema: u32, name: 'count' }),
        field({ key: 2, schema: str, name: 'label', presence: 2 }),
      ],
    });
    const cat = await catalogOf([u32, str, root]);
    // count=7 present, label present ("hi"), then no trailing bytes.
    const present = Uint8Array.from([
      2, // field count
      1,
      4,
      ...u32bytes(7), // key=1, len=4
      2,
      3,
      ...new TextEncoder().encode('hi\0'), // key=2, len=3
    ]);
    expect(decodeSchemaValue(cat, 2, present)).toEqual({ count: 7, label: 'hi' });
    // Absent optional is fine.
    const absent = Uint8Array.from([1, 1, 4, ...u32bytes(7)]);
    expect(decodeSchemaValue(cat, 2, absent)).toEqual({ count: 7 });
    // Missing required field fails.
    const missing = Uint8Array.from([1, 2, 3, ...new TextEncoder().encode('hi\0')]);
    expect(() => decodeSchemaValue(cat, 2, missing)).toThrow(/required tagged struct field/);
    // Unknown field key fails.
    const unknown = Uint8Array.from([1, 9, 4, ...u32bytes(1)]);
    expect(() => decodeSchemaValue(cat, 2, unknown)).toThrow(/unknown tagged struct field/);
    // Out-of-order keys fail.
    const unordered = Uint8Array.from([
      2,
      2,
      3,
      ...new TextEncoder().encode('hi\0'),
      1,
      4,
      ...u32bytes(7),
    ]);
    expect(() => decodeSchemaValue(cat, 2, unordered)).toThrow(/invalid tagged struct field/);
  });

  it('enforces trailing-byte rules inside tagged field payloads', async () => {
    const u32 = node({ key: key(1), scalarType: ValueType.U32 });
    const root = node({
      key: key(2),
      kind: 5,
      structEncoding: 2,
      fields: [field({ key: 1, schema: u32, name: 'count' })],
    });
    const cat = await catalogOf([u32, root]);
    const trailing = Uint8Array.from([1, 1, 5, ...u32bytes(7), 0xff]);
    expect(() => decodeSchemaValue(cat, 1, trailing)).toThrow(/trailing bytes/);
  });

  it('rejects schema values exceeding the recursion depth limit', async () => {
    // Chain of 40 alias nodes → decode hits the depth guard.
    const nodes: SchemaNodeV6[] = [node({ key: key(200), scalarType: ValueType.U8 })];
    for (let i = 0; i < 40; i++) {
      nodes.push(node({ key: key(100 + i), kind: 11, target: ref(nodes[i]!) }));
    }
    const cat = await catalogOf(nodes);
    expect(() => decodeSchemaValue(cat, 40, new Uint8Array([1]))).toThrow(/maximum depth/);
  });
});

describe('scalar encodings', () => {
  it('decodes varint, zigzag, and enum scalars canonically', async () => {
    const uv = node({ key: key(1), scalarType: ValueType.UVarint });
    const iv = node({ key: key(2), scalarType: ValueType.IVarint });
    const en = node({ key: key(3), kind: 4, scalarType: ValueType.Enum });
    const cat = await catalogOf([uv, iv, en]);
    expect(decodeSchemaValue(cat, 0, new Uint8Array([0x80, 0x01]))).toBe(128n);
    // Zigzag: -1 → 1, 1 → 2, -2 → 3.
    expect(decodeSchemaValue(cat, 1, new Uint8Array([1]))).toBe(-1n);
    expect(decodeSchemaValue(cat, 1, new Uint8Array([2]))).toBe(1n);
    expect(decodeSchemaValue(cat, 2, new Uint8Array([5]))).toBe(5n);
  });

  it('rejects non-canonical and overlong varints', async () => {
    const uv = node({ key: key(1), scalarType: ValueType.UVarint });
    const cat = await catalogOf([uv]);
    // 0x80 0x00 encodes 0 non-canonically (trailing zero group).
    expect(() => decodeSchemaValue(cat, 0, new Uint8Array([0x80, 0x00]))).toThrow(/non-canonical/);
    // 11 continuation bytes is overlong for u64.
    expect(() =>
      decodeSchemaValue(
        cat,
        0,
        new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]),
      ),
    ).toThrow(/varint/);
  });

  it('enforces string and bytes maxBytes at the node level', async () => {
    const str = node({ key: key(1), kind: 2, maxBytes: 4 });
    const bin = node({ key: key(2), kind: 3, maxBytes: 2 });
    const cat = await catalogOf([str, bin]);
    expect(decodeSchemaValue(cat, 0, new TextEncoder().encode('abcd\0'))).toBe('abcd');
    expect(() => decodeSchemaValue(cat, 0, new TextEncoder().encode('abcde\0'))).toThrow(
      /maximum length/,
    );
    expect(() => decodeSchemaValue(cat, 0, new TextEncoder().encode('abcd'))).toThrow(
      /unterminated/,
    );
    expect(decodeSchemaValue(cat, 1, Uint8Array.from([2, 9, 9]))).toEqual(Uint8Array.from([9, 9]));
    expect(() => decodeSchemaValue(cat, 1, Uint8Array.from([3, 9, 9, 9]))).toThrow(
      /maximum length/,
    );
  });

  it('rejects invalid optional markers and bool payloads', async () => {
    const u8 = node({ key: key(1), scalarType: ValueType.U8 });
    const opt = node({ key: key(2), kind: 8, element: ref(u8) });
    const bool = node({ key: key(3), scalarType: ValueType.Bool });
    const cat = await catalogOf([u8, opt, bool]);
    expect(decodeSchemaValue(cat, 1, new Uint8Array([0]))).toBeNull();
    expect(decodeSchemaValue(cat, 1, new Uint8Array([1, 9]))).toBe(9);
    expect(() => decodeSchemaValue(cat, 1, new Uint8Array([2]))).toThrow(/optional marker/);
    expect(() => decodeSchemaValue(cat, 2, new Uint8Array([2]))).toThrow(/invalid boolean/);
  });
});
