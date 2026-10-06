import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ValueType } from '../protocol';
import { computeSchemaDigestV6 } from './handshake';
import type { SchemaNodeV6, SchemaRefV6 } from './types';

/**
 * Cross-language digest fixtures shared with tests/io/test_io_schema.cpp.
 * Both sides reconstruct the same schema graphs and must produce identical
 * BLAKE3 digests of the canonical descriptor.  Regenerate the digests with
 * `UPDATE_DIGEST_VECTORS=1 npx vitest run digest-vectors`, then keep the C++
 * expected values in sync.
 */

interface NodeSpec {
  label: string;
  key: string;
  revision: number;
  kind: number;
  flags: number;
  name: string;
  description: string;
  annotations: Record<string, string>;
  scalarType: number;
  maxBytes: number;
  fixedCount: number;
  minCount: number;
  maxCount: number;
  structEncoding: number;
  element?: string;
  mapKey?: string;
  mapValue?: string;
  target?: string;
  fields: {
    key: number;
    flags: number;
    presence: number;
    schema: string;
    name: string;
    description: string;
    restrictions: { kind: number; payload: string }[];
    defaultValue: string;
  }[];
  oneOfMembers: { key: number; schema: string }[];
}

interface Vector {
  name: string;
  root: string;
  digest: string;
  nodes: NodeSpec[];
}

const unhex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g)?.map((b) => parseInt(b, 16)) ?? []);
const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(here, '../../test-fixtures/schema-digest-vectors.json'), 'utf8'),
) as { vectors: Vector[] };

function buildNodes(spec: NodeSpec[]): Map<string, SchemaNodeV6> {
  const zeroRef: SchemaRefV6 = { key: new Uint8Array(16), digest: new Uint8Array(32) };
  const nodes = new Map<string, SchemaNodeV6>();
  for (const n of spec) {
    nodes.set(n.label, {
      key: unhex(n.key),
      revision: n.revision,
      kind: n.kind,
      flags: n.flags,
      name: n.name,
      description: n.description,
      annotations: new Map(Object.entries(n.annotations)),
      scalarType: n.scalarType as ValueType,
      maxBytes: n.maxBytes,
      fixedCount: n.fixedCount,
      minCount: n.minCount,
      maxCount: n.maxCount,
      structEncoding: n.structEncoding,
      fields: n.fields.map((f) => ({
        key: f.key,
        flags: f.flags,
        presence: f.presence,
        schema: { ...zeroRef },
        name: f.name,
        description: f.description,
        restrictions: f.restrictions.map((r) => ({ kind: r.kind, payload: unhex(r.payload) })),
        defaultValue: unhex(f.defaultValue),
      })),
      oneOfMembers: n.oneOfMembers.map((m) => ({ key: m.key, schema: { ...zeroRef } })),
    });
  }
  // Wire up refs by label, then resolve digests bottom-up (graphs are acyclic).
  const refFor = (label: string): SchemaRefV6 => ({
    key: nodes.get(label)!.key,
    digest: new Uint8Array(32),
  });
  for (const n of spec) {
    const node = nodes.get(n.label)!;
    if (n.element) node.element = refFor(n.element);
    if (n.mapKey) node.mapKey = refFor(n.mapKey);
    if (n.mapValue) node.mapValue = refFor(n.mapValue);
    if (n.target) node.target = refFor(n.target);
    n.fields.forEach((f, i) => {
      node.fields[i]!.schema = refFor(f.schema);
    });
    n.oneOfMembers.forEach((m, i) => {
      node.oneOfMembers[i]!.schema = refFor(m.schema);
    });
  }
  const memo = new Map<string, Uint8Array>();
  const digestOf = (label: string): Uint8Array => {
    const cached = memo.get(label);
    if (cached) return cached;
    const node = nodes.get(label)!;
    const fill = (ref: SchemaRefV6 | undefined, target: string | undefined) => {
      if (ref && target) ref.digest = digestOf(target);
    };
    const specNode = spec.find((s) => s.label === label)!;
    fill(node.element, specNode.element);
    fill(node.mapKey, specNode.mapKey);
    fill(node.mapValue, specNode.mapValue);
    fill(node.target, specNode.target);
    specNode.fields.forEach((f, i) => {
      node.fields[i]!.schema.digest = digestOf(f.schema);
    });
    specNode.oneOfMembers.forEach((m, i) => {
      node.oneOfMembers[i]!.schema.digest = digestOf(m.schema);
    });
    const digest = computeSchemaDigestV6(node);
    memo.set(label, digest);
    return digest;
  };
  for (const label of nodes.keys()) digestOf(label);
  return nodes;
}

describe('cross-language schema digest vectors', () => {
  for (const vector of fixture.vectors) {
    it(`matches the fixture digest for ${vector.name}`, () => {
      const nodes = buildNodes(vector.nodes);
      const actual = toHex(computeSchemaDigestV6(nodes.get(vector.root)!));
      if (process.env.UPDATE_DIGEST_VECTORS) {
        console.log(`${vector.name}: ${actual}`);
      }
      expect(actual).toBe(vector.digest);
    });
  }
});
