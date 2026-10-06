import { beforeEach, describe, expect, it } from 'vitest';
import { ValueType } from '../protocol';
import { computeSchemaDigestV6, SchemaNodeV6 } from '../schema-v6';
import {
  clearCatalog,
  loadCachedManifest,
  loadCatalog,
  manifestFingerprint,
  storeCatalog,
} from './cache';

const key = (id: number): Uint8Array => {
  const result = new Uint8Array(16);
  result[15] = id;
  return result;
};
const ref = (node: SchemaNodeV6) => ({ key: node.key, digest: computeSchemaDigestV6(node) });
const scalar = (id: number, type: ValueType, name = ''): SchemaNodeV6 => ({
  key: key(id),
  revision: 1,
  kind: 1,
  flags: 0,
  name,
  description: '',
  annotations: new Map(),
  scalarType: type,
  maxBytes: 0,
  fixedCount: 0,
  minCount: 0,
  maxCount: 0,
  structEncoding: 1,
  fields: [],
  oneOfMembers: [],
});

const URL_A = 'ws://a/tether-io';
const URL_B = 'ws://b/tether-io';

function fixture() {
  const u32 = scalar(1, ValueType.U32);
  const root: SchemaNodeV6 = {
    key: key(2),
    revision: 1,
    kind: 5,
    flags: 0,
    name: 'Snapshot',
    description: '',
    annotations: new Map(),
    scalarType: ValueType.Binary,
    maxBytes: 0,
    fixedCount: 0,
    minCount: 0,
    maxCount: 0,
    structEncoding: 1,
    fields: [
      {
        key: 1,
        flags: 0,
        presence: 1,
        schema: ref(u32),
        name: 'count',
        description: '',
        restrictions: [],
        defaultValue: new Uint8Array(),
      },
    ],
    oneOfMembers: [],
  };
  const manifest = [root, u32].map((node) => ({ ref: ref(node), revision: node.revision }));
  return { nodes: [root, u32], manifest };
}

beforeEach(() => localStorage.clear());

describe('schema catalog cache', () => {
  it('round-trips a verified catalog keyed by URL and manifest fingerprint', () => {
    const { nodes, manifest } = fixture();
    storeCatalog(URL_A, {
      epoch: 9,
      manifest,
      nodesByKey: new Map(nodes.map((n) => [btoa(String.fromCharCode(...n.key)), n])),
      slotToNode: nodes,
    });

    const loaded = loadCatalog(URL_A, manifest);
    expect(loaded).toBeDefined();
    expect(loaded?.nodesByKey.size).toBe(2);
    expect(loaded?.slotToNode).toHaveLength(2);
    // Cached manifest is advertised back on the next ClientHello.
    expect(loadCachedManifest(URL_A)).toHaveLength(2);
    // Different URL → miss.
    expect(loadCatalog(URL_B, manifest)).toBeUndefined();
  });

  it('rejects a manifest that does not match the cached fingerprint', () => {
    const { nodes, manifest } = fixture();
    storeCatalog(URL_A, { epoch: 1, manifest, nodesByKey: new Map(), slotToNode: [] });
    const other = scalar(9, ValueType.U16, 'Other');
    const changed = [{ ref: ref(other), revision: 1 }];
    expect(manifestFingerprint(changed)).not.toBe(manifestFingerprint(manifest));
    expect(loadCatalog(URL_A, changed)).toBeUndefined();
  });

  it('rejects a corrupted node whose digest no longer matches the manifest', () => {
    const { nodes, manifest } = fixture();
    storeCatalog(URL_A, {
      epoch: 1,
      manifest,
      nodesByKey: new Map(nodes.map((n) => [btoa(String.fromCharCode(...n.key)), n])),
      slotToNode: nodes,
    });
    const raw = JSON.parse(localStorage.getItem(`tether.io.schema.${URL_A}`)!) as {
      nodes: { name: string }[];
    };
    raw.nodes[0]!.name = 'Tampered';
    localStorage.setItem(`tether.io.schema.${URL_A}`, JSON.stringify(raw));
    expect(loadCatalog(URL_A, manifest)).toBeUndefined();
  });

  it('clearCatalog drops the entry and tolerate corrupt payloads', () => {
    const { nodes, manifest } = fixture();
    storeCatalog(URL_A, {
      epoch: 1,
      manifest,
      nodesByKey: new Map(nodes.map((n) => [btoa(String.fromCharCode(...n.key)), n])),
      slotToNode: nodes,
    });
    clearCatalog(URL_A);
    expect(loadCatalog(URL_A, manifest)).toBeUndefined();
    localStorage.setItem(`tether.io.schema.${URL_A}`, '{not json');
    expect(loadCatalog(URL_A, manifest)).toBeUndefined();
    expect(loadCachedManifest(URL_A)).toBeUndefined();
  });
});
