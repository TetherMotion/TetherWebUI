import { describe, expect, it } from 'vitest';
import { BinaryWriter, ValueType } from './protocol';
import {
  SchemaMessage,
  SchemaNodeV6,
  canonicalDescriptorV6,
  computeSchemaDigestV6,
  decodeSchemaValue,
  decodeServerHelloV6,
  makeClientHelloV6,
  verifyAndBuildCatalog,
} from './schema-v6';

const key = (id: number): Uint8Array => {
  const result = new Uint8Array(16);
  result[15] = id;
  return result;
};
const ref = (node: SchemaNodeV6) => ({ key: node.key, digest: computeSchemaDigestV6(node) });
const scalar = (id: number, type: ValueType, name = ''): SchemaNodeV6 => ({
  key: key(id), revision: 1, kind: 1, flags: 0, name, description: '', annotations: new Map(),
  scalarType: type, maxBytes: 0, fixedCount: 0, minCount: 0, maxCount: 0,
  structEncoding: 1, fields: [], oneOfMembers: [],
});

describe('V6 schema negotiation', () => {
  it('encodes a V6-only ClientHello with bounded negotiated limits', () => {
    const hello = makeClientHelloV6();
    expect(hello[0]).toBe(SchemaMessage.clientHello);
    expect(hello[1]).toBe(6);
    expect(hello[2]).toBe(6);
    expect(hello).toHaveLength(35);
  });

  it('decodes ServerHello epoch and manifest', () => {
    const schema = scalar(1, ValueType.U32, 'Counter');
    const digest = computeSchemaDigestV6(schema);
    const writer = new BinaryWriter(1 + 1 + 4 + 24 + 4 + 4 + 4 + 48 + 4);
    writer.u8(SchemaMessage.serverHello).u8(6).u32(0);
    for (let i = 0; i < 6; i += 1) writer.u32(1024);
    writer.u32(7).u32(1).bytes(schema.key).bytes(digest).u32(1);
    const hello = decodeServerHelloV6(writer.finish());
    expect(hello.epoch).toBe(7);
    expect(hello.manifest).toHaveLength(1);
    expect(hello.manifest[0]?.revision).toBe(1);
  });

  it('serializes annotation keys in bytewise order', () => {
    const node = scalar(7, ValueType.U32);
    node.annotations.set('a', 'lower');
    node.annotations.set('Z', 'upper');
    const descriptor = canonicalDescriptorV6(node);
    // Header is 33 bytes, followed by the annotation count; first key is at 41.
    expect(new TextDecoder().decode(descriptor.slice(41, 42))).toBe('Z');
  });

  it('validates descriptor digests and decodes a packed schema value by field name', async () => {
    const u32 = scalar(1, ValueType.U32);
    const f64 = scalar(2, ValueType.F64);
    const root: SchemaNodeV6 = {
      key: key(3), revision: 1, kind: 5, flags: 0, name: 'Snapshot', description: '',
      annotations: new Map(), scalarType: ValueType.Binary, maxBytes: 0, fixedCount: 0,
      minCount: 0, maxCount: 0, structEncoding: 1,
      fields: [
        { key: 1, flags: 0, presence: 1, schema: ref(u32), name: 'count', description: '', restrictions: [], defaultValue: new Uint8Array() },
        { key: 2, flags: 0, presence: 1, schema: ref(f64), name: 'position', description: '', restrictions: [], defaultValue: new Uint8Array() },
      ], oneOfMembers: [],
    };
    const nodes = [u32, f64, root];
    const manifest = nodes.map((node) => ({ ref: ref(node), revision: node.revision }));
    const catalog = await verifyAndBuildCatalog({ epoch: 11, manifest }, nodes.map((node) => ({ epoch: 11, node })));
    const bytes = new Uint8Array(12);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 42, true);
    view.setFloat64(4, 1.25, true);
    expect(decodeSchemaValue(catalog, 2, bytes)).toEqual({ count: 42, position: 1.25 });
  });

  it('rejects stale definitions and digest mismatches', async () => {
    const node = scalar(4, ValueType.U16, 'Stale');
    const manifest = [{ ref: ref(node), revision: node.revision }];
    await expect(verifyAndBuildCatalog({ epoch: 5, manifest }, [{ epoch: 4, node }])).rejects.toThrow(/stale epoch/);
    const wrongDigest = new Uint8Array(32);
    await expect(verifyAndBuildCatalog(
      { epoch: 5, manifest: [{ ref: { key: node.key, digest: wrongDigest }, revision: node.revision }] },
      [{ epoch: 5, node }],
    )).rejects.toThrow(/digest mismatch/);
  });

  it('enforces packed-field numeric range restrictions', async () => {
    const u32 = scalar(5, ValueType.U32);
    const restriction = new BinaryWriter(10).u8(1).u32(0).u8(1).u32(10).finish();
    const root: SchemaNodeV6 = {
      key: key(6), revision: 1, kind: 5, flags: 0, name: 'Bounded', description: '',
      annotations: new Map(), scalarType: ValueType.Binary, maxBytes: 0, fixedCount: 0,
      minCount: 0, maxCount: 0, structEncoding: 1,
      fields: [{
        key: 1, flags: 0, presence: 1, schema: ref(u32), name: 'value', description: '',
        restrictions: [{ kind: 1, payload: restriction }], defaultValue: new Uint8Array(),
      }],
      oneOfMembers: [],
    };
    const nodes = [u32, root];
    const manifest = nodes.map((node) => ({ ref: ref(node), revision: node.revision }));
    const catalog = await verifyAndBuildCatalog({ epoch: 12, manifest }, nodes.map((node) => ({ epoch: 12, node })));
    const inRange = new Uint8Array(4);
    new DataView(inRange.buffer).setUint32(0, 5, true);
    expect(decodeSchemaValue(catalog, 1, inRange)).toEqual({ value: 5 });
    const outOfRange = new Uint8Array(4);
    new DataView(outOfRange.buffer).setUint32(0, 11, true);
    expect(() => decodeSchemaValue(catalog, 1, outOfRange)).toThrow(/numeric range restriction/);
  });
});
