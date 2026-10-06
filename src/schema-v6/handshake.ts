import { blake3 } from '@noble/hashes/blake3';
import { BinaryReader, BinaryWriter, ValueType } from '../protocol';
import {
  SchemaCatalogV6,
  SchemaFieldV6,
  SchemaManifestEntryV6,
  SchemaNodeV6,
  SchemaRefV6,
  ServerHelloV6,
} from './types';

export const SCHEMA_PROTOCOL_VERSION = 6;
export const SchemaMessage = {
  clientHello: 0x50,
  serverHello: 0x51,
  request: 0x52,
  definition: 0x53,
  commit: 0x54,
  reject: 0x55,
  update: 0x56,
} as const;

const MAX_ITEMS = 4096;
const MAX_STRING_BYTES = 1 << 20;
const keyString = (key: Uint8Array): string => [...key].map((byte) => byte.toString(16).padStart(2, '0')).join('');

function readString32(reader: BinaryReader): string {
  const length = reader.u32();
  if (length > MAX_STRING_BYTES) throw new Error('schema string exceeds limit');
  return new TextDecoder('utf-8', { fatal: true }).decode(reader.bytesOf(length));
}

function writeString32(writer: BinaryWriter, value: string): void {
  const bytes = new TextEncoder().encode(value);
  writer.u32(bytes.length).bytes(bytes);
}

function readRef(reader: BinaryReader): SchemaRefV6 {
  return { key: reader.bytesOf(16), digest: reader.bytesOf(32) };
}

function writeRef(writer: BinaryWriter, ref: SchemaRefV6): void {
  if (ref.key.length !== 16 || ref.digest.length !== 32) throw new Error('invalid schema reference');
  writer.bytes(ref.key).bytes(ref.digest);
}

function readManifest(reader: BinaryReader): SchemaManifestEntryV6[] {
  const count = reader.u32();
  if (count > MAX_ITEMS) throw new Error('schema manifest exceeds limit');
  return Array.from({ length: count }, () => ({ ref: readRef(reader), revision: reader.u32() }));
}

function writeManifest(writer: BinaryWriter, manifest: SchemaManifestEntryV6[]): void {
  if (manifest.length > MAX_ITEMS) throw new Error('schema manifest exceeds limit');
  writer.u32(manifest.length);
  for (const item of manifest) {
    writeRef(writer, item.ref);
    writer.u32(item.revision);
  }
}

export function makeClientHelloV6(cached: SchemaManifestEntryV6[] = []): Uint8Array {
  const writer = new BinaryWriter(1 + 2 + 4 + 24 + 4 + cached.length * 52);
  writer.u8(SchemaMessage.clientHello).u8(SCHEMA_PROTOCOL_VERSION).u8(SCHEMA_PROTOCOL_VERSION);
  writer.u32(0);
  writer.u32(1 << 20).u32(1 << 16).u32(MAX_ITEMS).u32(1 << 20).u32(32).u32(1_000_000);
  writeManifest(writer, cached);
  return writer.finish();
}

export function decodeServerHelloV6(frame: Uint8Array): ServerHelloV6 {
  const reader = new BinaryReader(frame);
  if (reader.u8() !== SchemaMessage.serverHello) throw new Error('expected V6 ServerHello');
  if (reader.u8() !== SCHEMA_PROTOCOL_VERSION) throw new Error('server selected unsupported protocol version');
  reader.u32();
  for (let index = 0; index < 6; index += 1) reader.u32();
  const epoch = reader.u32();
  const manifest = readManifest(reader);
  reader.assertEnd();
  return { epoch, manifest };
}

export function makeSchemaRequestV6(epoch: number, manifest: SchemaManifestEntryV6[]): Uint8Array {
  const writer = new BinaryWriter(1 + 4 + 4 + manifest.length * 48);
  writer.u8(SchemaMessage.request).u32(epoch).u32(manifest.length);
  manifest.forEach(({ ref }) => writeRef(writer, ref));
  return writer.finish();
}

export function decodeSchemaDefinitionV6(frame: Uint8Array): { epoch: number; node: SchemaNodeV6 } {
  const reader = new BinaryReader(frame);
  if (reader.u8() !== SchemaMessage.definition) throw new Error('expected SchemaDefinition');
  const epoch = reader.u32();
  const key = reader.bytesOf(16);
  const revision = reader.u32();
  const kind = reader.u8();
  const flags = reader.u32();
  const name = readString32(reader);
  const description = readString32(reader);
  const annotationCount = reader.u32();
  if (annotationCount > MAX_ITEMS) throw new Error('too many schema annotations');
  const annotations = new Map<string, string>();
  for (let index = 0; index < annotationCount; index += 1) {
    const annotationKey = readString32(reader);
    if (annotations.has(annotationKey)) throw new Error('duplicate schema annotation');
    annotations.set(annotationKey, readString32(reader));
  }
  const scalarType = reader.u8() as ValueType;
  const maxBytes = reader.u32();
  const fixedCount = reader.u32();
  const minCount = reader.u32();
  const maxCount = reader.u32();
  const structEncoding = reader.u8();
  const optionalRef = (): SchemaRefV6 | undefined => {
    const has = reader.u8();
    if (has > 1) throw new Error('invalid optional schema reference');
    return has ? readRef(reader) : undefined;
  };
  const element = optionalRef();
  const mapKey = optionalRef();
  const mapValue = optionalRef();
  const target = optionalRef();
  const fieldCount = reader.u32();
  if (fieldCount > MAX_ITEMS) throw new Error('too many schema fields');
  const fields: SchemaFieldV6[] = [];
  for (let index = 0; index < fieldCount; index += 1) {
    const fieldKey = reader.u32();
    const fieldFlags = reader.u32();
    const presence = reader.u8();
    const schema = readRef(reader);
    const fieldName = readString32(reader);
    const fieldDescription = readString32(reader);
    const restrictionCount = reader.u32();
    if (restrictionCount > MAX_ITEMS) throw new Error('too many field restrictions');
    const restrictions = Array.from({ length: restrictionCount }, () => {
      const restrictionKind = reader.u8();
      const length = reader.u32();
      if (length > reader.remaining) throw new Error('truncated schema restriction');
      return { kind: restrictionKind, payload: reader.bytesOf(length) };
    });
    const defaultLength = reader.u32();
    if (defaultLength > reader.remaining) throw new Error('truncated schema default');
    fields.push({
      key: fieldKey, flags: fieldFlags, presence, schema, name: fieldName,
      description: fieldDescription, restrictions, defaultValue: reader.bytesOf(defaultLength),
    });
  }
  const memberCount = reader.u32();
  if (memberCount > MAX_ITEMS) throw new Error('too many oneof members');
  const oneOfMembers = Array.from({ length: memberCount }, () => ({ key: reader.u32(), schema: readRef(reader) }));
  reader.assertEnd();
  return {
    epoch,
    node: {
      key, revision, kind, flags, name, description, annotations, scalarType, maxBytes,
      fixedCount, minCount, maxCount, structEncoding, element, mapKey, mapValue, target,
      fields, oneOfMembers,
    },
  };
}

/** Recreate Schema.hpp's canonical descriptor byte-for-byte before hashing. */
export function canonicalDescriptorV6(node: SchemaNodeV6): Uint8Array {
  let size = 16 + 4 + 1 + 4 + 4 + new TextEncoder().encode(node.name).length + 4 +
    new TextEncoder().encode(node.description).length + 4 + 1 + 4 * 4 + 1 + 4 * 4 + 4;
  const addStringSize = (text: string) => 4 + new TextEncoder().encode(text).length;
  for (const [key, value] of node.annotations) size += addStringSize(key) + addStringSize(value);
  const refs = [node.element, node.mapKey, node.mapValue, node.target];
  for (const ref of refs) if (ref) size += 48;
  for (const field of node.fields) {
    size += 4 + 4 + 1 + 48 + addStringSize(field.name) + addStringSize(field.description) + 4 + 4 + field.defaultValue.length;
    for (const restriction of field.restrictions) size += 1 + 4 + restriction.payload.length;
  }
  size += node.oneOfMembers.length * (4 + 48);
  const writer = new BinaryWriter(size);
  writer.bytes(node.key).u32(node.revision).u8(node.kind).u32(node.flags);
  writeString32(writer, node.name);
  writeString32(writer, node.description);
  writer.u32(node.annotations.size);
  for (const [key, value] of [...node.annotations.entries()].sort(([left], [right]) => compareUtf8(left, right))) {
    writeString32(writer, key);
    writeString32(writer, value);
  }
  writer.u8(node.scalarType).u32(node.maxBytes).u32(node.fixedCount).u32(node.minCount).u32(node.maxCount).u8(node.structEncoding);
  for (const ref of refs) {
    writer.u8(ref ? 1 : 0);
    if (ref) writeRef(writer, ref);
  }
  writer.u32(node.fields.length);
  for (const field of node.fields) {
    writer.u32(field.key).u32(field.flags).u8(field.presence);
    writeRef(writer, field.schema);
    writeString32(writer, field.name);
    writeString32(writer, field.description);
    writer.u32(field.restrictions.length);
    for (const restriction of field.restrictions) writer.u8(restriction.kind).u32(restriction.payload.length).bytes(restriction.payload);
    writer.u32(field.defaultValue.length).bytes(field.defaultValue);
  }
  writer.u32(node.oneOfMembers.length);
  for (const member of node.oneOfMembers) {
    writer.u32(member.key);
    writeRef(writer, member.schema);
  }
  return writer.finish();
}

export function computeSchemaDigestV6(node: SchemaNodeV6): Uint8Array {
  return blake3(canonicalDescriptorV6(node), { dkLen: 32 });
}

export async function verifyAndBuildCatalog(
  hello: ServerHelloV6,
  definitions: { epoch: number; node: SchemaNodeV6 }[],
): Promise<SchemaCatalogV6> {
  const nodesByKey = new Map<string, SchemaNodeV6>();
  const manifestByKey = new Map(hello.manifest.map((entry) => [keyString(entry.ref.key), entry]));
  if (manifestByKey.size !== hello.manifest.length) throw new Error('duplicate schema manifest key');
  if (hello.manifest.length > 1024) throw new Error('schema manifest exceeds negotiated definition limit');
  // Digests of fetched nodes verified during the dependency walk.
  const verifiedDigest = new Map<string, Uint8Array>();
  for (const { epoch, node } of definitions) {
    if (epoch !== hello.epoch) throw new Error('schema definition belongs to a stale epoch');
    const key = keyString(node.key);
    if (node.key.every((byte) => byte === 0)) throw new Error('invalid schema identity');
    const entry = manifestByKey.get(key);
    const digest = computeSchemaDigestV6(node);
    if (entry) {
      if (entry.revision !== node.revision) throw new Error('schema revision mismatches the manifest');
      if (!digest.every((value, index) => value === entry.ref.digest[index])) {
        throw new Error(`schema digest mismatch for ${node.name || key}`);
      }
    }
    verifiedDigest.set(key, digest);
    if (nodesByKey.has(key)) throw new Error('duplicate schema definition');
    nodesByKey.set(key, node);
  }
  for (const entry of hello.manifest) {
    if (!nodesByKey.has(keyString(entry.ref.key))) throw new Error('manifest root schema is missing');
  }
  const hasRef = (ref?: SchemaRefV6): boolean => {
    if (!ref) return true;
    const node = nodesByKey.get(keyString(ref.key));
    const digest = verifiedDigest.get(keyString(ref.key));
    return !!node && !!digest && digest.every((byte, index) => byte === ref.digest[index]);
  };
  for (const node of nodesByKey.values()) {
    if (![node.element, node.mapKey, node.mapValue, node.target].every(hasRef) ||
      node.fields.some((field) => !hasRef(field.schema)) ||
      node.oneOfMembers.some((member) => !hasRef(member.schema))) throw new Error(`incomplete schema graph at ${node.name}`);
    if (node.kind < 1 || node.kind > 11) throw new Error(`unknown schema kind ${node.kind}`);
    if ((node.kind === 6 || node.kind === 7) && !node.element) throw new Error(`schema ${node.name} is missing an element type`);
    if (node.kind === 8 && !node.element) throw new Error(`optional schema ${node.name} is missing an element type`);
    if (node.kind === 9 && (!node.mapKey || !node.mapValue)) throw new Error(`map schema ${node.name} is missing key/value types`);
    if (node.kind === 11 && !node.target) throw new Error(`alias schema ${node.name} is missing its target`);
    validateStructShape(node);
    if ((node.kind === 7 || node.kind === 9) && (node.minCount > node.maxCount || node.maxCount > 1_000_000)) {
      throw new Error(`invalid collection bounds in ${node.name}`);
    }
    if (node.kind === 6 && node.fixedCount > 1_000_000) throw new Error(`fixed array exceeds limit in ${node.name}`);
    validateOneOfMembers(node);
  }
  validateAcyclicGraph(nodesByKey);
  const slotToNode = hello.manifest.map((entry) => nodesByKey.get(keyString(entry.ref.key))!);
  return { epoch: hello.epoch, manifest: hello.manifest, nodesByKey, slotToNode };
}

function validateStructShape(node: SchemaNodeV6): void {
  if (node.kind !== 5) return;
  if (node.structEncoding !== 1 && node.structEncoding !== 2) throw new Error(`invalid struct encoding in ${node.name}`);
  let prior = 0;
  for (const field of node.fields) {
    if (field.key === 0 || field.key <= prior) throw new Error(`invalid field ordering in ${node.name}`);
    if (field.presence !== 1 && field.presence !== 2) throw new Error(`invalid field presence in ${node.name}`);
    if (node.structEncoding === 1 && field.presence !== 1) throw new Error(`packed struct ${node.name} has an optional field`);
    if (field.presence === 1 && field.defaultValue.length !== 0) throw new Error(`required field ${field.name} has a default`);
    let previousRestriction = 0;
    for (const restriction of field.restrictions) {
      if (restriction.kind < 1 || restriction.kind > 7 || restriction.kind <= previousRestriction) {
        throw new Error(`invalid restriction ordering in ${node.name}.${field.name}`);
      }
      previousRestriction = restriction.kind;
    }
    prior = field.key;
  }
}

function validateOneOfMembers(node: SchemaNodeV6): void {
  let memberKey = 0;
  for (const member of node.oneOfMembers) {
    if (member.key === 0 || member.key <= memberKey) throw new Error(`invalid oneof ordering in ${node.name}`);
    memberKey = member.key;
  }
  if (node.kind === 10 && node.oneOfMembers.length === 0) throw new Error(`oneof schema ${node.name} has no members`);
}

function validateAcyclicGraph(nodesByKey: Map<string, SchemaNodeV6>): void {
  const marks = new Map<string, number>();
  const visit = (node: SchemaNodeV6, depth: number): void => {
    if (depth > 32) throw new Error('schema graph exceeds maximum depth');
    const key = keyString(node.key);
    const mark = marks.get(key) ?? 0;
    if (mark === 1) throw new Error('schema graph contains a cycle');
    if (mark === 2) return;
    marks.set(key, 1);
    const refs = [node.element, node.mapKey, node.mapValue, node.target,
      ...node.fields.map((field) => field.schema), ...node.oneOfMembers.map((member) => member.schema)];
    for (const ref of refs) {
      if (!ref) continue;
      const dependency = nodesByKey.get(keyString(ref.key));
      if (!dependency) throw new Error('schema graph contains an unresolved reference');
      visit(dependency, depth + 1);
    }
    marks.set(key, 2);
  };
  for (const node of nodesByKey.values()) visit(node, 1);
}

export function makeSchemaCommitV6(epoch: number): Uint8Array {
  return new BinaryWriter(5).u8(SchemaMessage.commit).u32(epoch).finish();
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return left.length - right.length;
}

function compareUtf8(left: string, right: string): number {
  return compareBytes(new TextEncoder().encode(left), new TextEncoder().encode(right));
}
