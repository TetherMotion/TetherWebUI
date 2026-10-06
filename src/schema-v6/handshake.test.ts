import { describe, expect, it } from 'vitest';
import { computeSchemaDigestV6 } from './handshake';
import type { SchemaNodeV6, SchemaRefV6 } from './types';
import { ValueType } from '../protocol/types';

/**
 * Cross-language fixtures mirrored in tests/io/test_io_cia402_profile.cpp
 * (DigestFixturesMatchBrowserClient). The hex constants were produced by the
 * C++ implementation; a divergence here means the browser and server would
 * reject each other's catalogs.
 */

const keyOf = (id: number): Uint8Array => {
  const key = new Uint8Array(16);
  key[15] = id;
  return key;
};

const base = (): SchemaNodeV6 => ({
  key: new Uint8Array(16),
  revision: 1,
  kind: 1, // Scalar
  flags: 0,
  name: '',
  description: '',
  annotations: new Map(),
  scalarType: 13 as ValueType, // ValueType::Binary — C++ default
  maxBytes: 0,
  fixedCount: 0,
  minCount: 0,
  maxCount: 0,
  structEncoding: 2, // StructEncoding::Tagged
  fields: [],
  oneOfMembers: [],
});

const scalar = (id: number, type: ValueType, name: string): SchemaNodeV6 => ({
  ...base(),
  key: keyOf(id),
  scalarType: type,
  name,
});

const hex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

describe('cross-language schema digest fixtures', () => {
  it('matches the C++ digests for Bool/F64/String128', () => {
    expect(hex(computeSchemaDigestV6(scalar(10, ValueType.Bool, 'tether.machine.cia402.Bool'))))
      .toBe('d41be435b890f0b0053c078844c3ad08b5ac355d6ec4bb209e58fb677df55fa1');
    expect(hex(computeSchemaDigestV6(scalar(11, ValueType.F64, 'tether.machine.cia402.F64'))))
      .toBe('b16d032d88099a23ae8358d9b42247e5f15ee9749f84b009807d9a6ebeda7b25');

    const string128: SchemaNodeV6 = {
      ...base(),
      key: keyOf(9),
      kind: 2, // SchemaKind::String
      maxBytes: 128,
      name: 'tether.machine.cia402.String128',
    };
    expect(hex(computeSchemaDigestV6(string128)))
      .toBe('fff72e569203f9a95998a207598a2804d3c5cb84e94568f0f1b90ddac3a0cea5');
  });

  it('matches the C++ digest for the tagged AuthorityLeaseV1 struct', () => {
    const ref = (node: SchemaNodeV6): SchemaRefV6 => ({
      key: node.key,
      digest: computeSchemaDigestV6(node),
    });
    // The driveSnapshot subgraph scalars are anonymous (no name/description).
    const u32Ref = ref(scalar(3, ValueType.U32, ''));
    const u64Ref = ref(scalar(4, ValueType.U64, ''));
    const strRef = ref({
      ...base(),
      key: keyOf(9),
      kind: 2,
      maxBytes: 128,
      name: 'tether.machine.cia402.String128',
    });
    const field = (key: number, schema: SchemaRefV6, name: string, description: string) => ({
      key,
      flags: 0,
      presence: 1, // FieldPresence::Required
      schema,
      name,
      description,
      restrictions: [],
      defaultValue: new Uint8Array(),
    });
    const lease: SchemaNodeV6 = {
      ...base(),
      key: keyOf(23),
      kind: 5, // SchemaKind::Struct
      structEncoding: 2,
      name: 'tether.machine.cia402.AuthorityLeaseV1',
      description: 'One server-owned control-authority lease',
      fields: [
        field(1, strRef, 'scope', 'Machine or motion-group scope'),
        field(2, strRef, 'owner_actor', 'Authenticated actor holding the lease'),
        field(3, u64Ref, 'token', 'Server-issued lease token'),
        field(4, u32Ref, 'remaining_ms', 'Milliseconds until server-side expiry'),
      ],
    };
    expect(hex(computeSchemaDigestV6(lease)))
      .toBe('4f29338832c015926f717cc39d5f0a37c4101417dcc3dcf04ee9cfa35027def4');
  });
});
