import { BinaryReader, ValueType } from '../protocol';
import { SchemaCatalogV6, SchemaFieldV6, SchemaNodeV6, SchemaRefV6 } from './types';

const keyString = (key: Uint8Array): string => [...key].map((byte) => byte.toString(16).padStart(2, '0')).join('');

export function decodeSchemaValue(catalog: SchemaCatalogV6, slot: number, bytes: Uint8Array): unknown {
  const root = catalog.slotToNode[slot];
  if (!root) throw new Error(`unknown schema slot ${slot} in epoch ${catalog.epoch}`);
  const reader = new BinaryReader(bytes);
  const value = decodeNode(catalog, root, reader, 0);
  reader.assertEnd();
  return value;
}

function decodeNode(catalog: SchemaCatalogV6, node: SchemaNodeV6, reader: BinaryReader, depth: number): unknown {
  if (depth > 32) throw new Error('schema value exceeds maximum depth');
  if (node.kind === 11) {
    const target = node.target && catalog.nodesByKey.get(keyString(node.target.key));
    if (!target) throw new Error('unresolved alias schema');
    return decodeNode(catalog, target, reader, depth + 1);
  }
  if (node.kind === 1 || node.kind === 4) return decodeScalar(reader, node.scalarType);
  if (node.kind === 2) {
    const chars: number[] = [];
    while (reader.remaining > 0) {
      const byte = reader.u8();
      if (byte === 0) return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(chars));
      if (chars.length >= node.maxBytes) throw new Error('schema string exceeds maximum length');
      chars.push(byte);
    }
    throw new Error('unterminated schema string');
  }
  if (node.kind === 3) {
    const length = readU64Varint(reader);
    if (length > node.maxBytes || length > reader.remaining) throw new Error('schema bytes exceed maximum length');
    return reader.bytesOf(Number(length));
  }
  if (node.kind === 5) return decodeStruct(catalog, node, reader, depth);
  if (node.kind === 6 || node.kind === 7) return decodeArray(catalog, node, reader, depth);
  if (node.kind === 8) return decodeOptional(catalog, node, reader, depth);
  if (node.kind === 9) return decodeMap(catalog, node, reader, depth);
  if (node.kind === 10) return decodeOneOf(catalog, node, reader, depth);
  throw new Error(`unsupported schema kind ${node.kind}`);
}

function decodeStruct(catalog: SchemaCatalogV6, node: SchemaNodeV6, reader: BinaryReader, depth: number): Record<string, unknown> {
  const fieldsByKey = new Map(node.fields.map((field) => [field.key, field]));
  const decodeField = (field: SchemaFieldV6, targetReader: BinaryReader, requireEnd: boolean): unknown => {
    const child = catalog.nodesByKey.get(keyString(field.schema.key));
    if (!child) throw new Error(`unresolved field schema ${field.name}`);
    const start = targetReader.position;
    const decoded = decodeNode(catalog, child, targetReader, depth + 1);
    if (requireEnd && targetReader.remaining !== 0) throw new Error(`trailing bytes in field ${field.name}`);
    validateFieldRestrictions(catalog, field, child, decoded, targetReader.slice(start, targetReader.position));
    return decoded;
  };
  const value: Record<string, unknown> = {};
  if (node.structEncoding === 1) {
    for (const field of node.fields) value[field.name || String(field.key)] = decodeField(field, reader, false);
    return value;
  }
  const fieldCount = Number(readU64Varint(reader));
  if (fieldCount > node.fields.length) throw new Error('tagged struct contains too many fields');
  let previousKey = 0;
  const seen = new Set<number>();
  for (let index = 0; index < fieldCount; index += 1) {
    const key = Number(readU64Varint(reader));
    const length = Number(readU64Varint(reader));
    if (key <= previousKey || length > reader.remaining) throw new Error('invalid tagged struct field');
    previousKey = key;
    const field = fieldsByKey.get(key);
    if (!field) throw new Error(`unknown tagged struct field ${key}`);
    const fieldReader = new BinaryReader(reader.bytesOf(length));
    value[field.name || String(field.key)] = decodeField(field, fieldReader, true);
    seen.add(key);
  }
  if (node.fields.some((field) => field.presence === 1 && !seen.has(field.key))) {
    throw new Error('required tagged struct field is missing');
  }
  return value;
}

function decodeArray(catalog: SchemaCatalogV6, node: SchemaNodeV6, reader: BinaryReader, depth: number): unknown[] {
  if (!node.element) throw new Error('array schema has no element');
  const count = node.kind === 6 ? node.fixedCount : Number(readU64Varint(reader));
  if (count > 1_000_000) throw new Error('schema array exceeds element limit');
  if (node.kind === 7 && (count < node.minCount || count > node.maxCount)) throw new Error('schema array violates its count bounds');
  const child = catalog.nodesByKey.get(keyString(node.element.key));
  if (!child) throw new Error('unresolved array element schema');
  return Array.from({ length: count }, () => {
    if (node.kind === 6) return decodeNode(catalog, child, reader, depth + 1);
    const byteLength = Number(readU64Varint(reader));
    if (byteLength > reader.remaining) throw new Error('truncated array element');
    const elementReader = new BinaryReader(reader.bytesOf(byteLength));
    const value = decodeNode(catalog, child, elementReader, depth + 1);
    elementReader.assertEnd();
    return value;
  });
}

function decodeOptional(catalog: SchemaCatalogV6, node: SchemaNodeV6, reader: BinaryReader, depth: number): unknown {
  const present = reader.u8();
  if (present > 1) throw new Error('invalid optional marker');
  if (!present) return null;
  const child = node.element && catalog.nodesByKey.get(keyString(node.element.key));
  if (!child) throw new Error('optional schema has no target');
  return decodeNode(catalog, child, reader, depth + 1);
}

function decodeOneOf(catalog: SchemaCatalogV6, node: SchemaNodeV6, reader: BinaryReader, depth: number): { key: number; value: unknown } {
  const key = Number(readU64Varint(reader));
  const size = readU64Varint(reader);
  if (size > reader.remaining) throw new Error('truncated oneof value');
  const payloadReader = new BinaryReader(reader.bytesOf(Number(size)));
  const member = node.oneOfMembers.find((item) => item.key === key);
  if (!member) throw new Error(`unknown oneof key ${key}`);
  const child = catalog.nodesByKey.get(keyString(member.schema.key));
  if (!child) throw new Error(`unresolved oneof schema ${key}`);
  const value = decodeNode(catalog, child, payloadReader, depth + 1);
  payloadReader.assertEnd();
  return { key, value };
}

function decodeMap(catalog: SchemaCatalogV6, node: SchemaNodeV6, reader: BinaryReader, depth: number): [unknown, unknown][] {
  if (!node.mapKey || !node.mapValue) throw new Error('map schema has incomplete key/value types');
  const keyNode = catalog.nodesByKey.get(keyString(node.mapKey.key));
  const valueNode = catalog.nodesByKey.get(keyString(node.mapValue.key));
  if (!keyNode || !valueNode) throw new Error('map schema references unresolved types');
  const count = Number(readU64Varint(reader));
  if (count > 1_000_000) throw new Error('schema map exceeds entry limit');
  if (count < node.minCount || count > node.maxCount) throw new Error('schema map violates its count bounds');
  const result: [unknown, unknown][] = [];
  for (let index = 0; index < count; index += 1) {
    const keyLength = Number(readU64Varint(reader));
    if (keyLength > reader.remaining) throw new Error('truncated map key');
    const keyReader = new BinaryReader(reader.bytesOf(keyLength));
    const key = decodeNode(catalog, keyNode, keyReader, depth + 1);
    keyReader.assertEnd();
    const valueLength = Number(readU64Varint(reader));
    if (valueLength > reader.remaining) throw new Error('truncated map value');
    const valueReader = new BinaryReader(reader.bytesOf(valueLength));
    const value = decodeNode(catalog, valueNode, valueReader, depth + 1);
    valueReader.assertEnd();
    result.push([key, value]);
  }
  return result;
}

function readU64Varint(reader: BinaryReader): bigint {
  let value = 0n;
  for (let index = 0; index < 10; index += 1) {
    const byte = reader.u8();
    if (index === 9 && byte > 1) throw new Error('invalid 64-bit varint');
    value |= BigInt(byte & 0x7f) << BigInt(index * 7);
    if ((byte & 0x80) === 0) {
      if (index > 0 && byte === 0) throw new Error('non-canonical 64-bit varint');
      return value;
    }
  }
  throw new Error('invalid 64-bit varint');
}

function validateFieldRestrictions(
  catalog: SchemaCatalogV6,
  field: SchemaFieldV6,
  schema: SchemaNodeV6,
  value: unknown,
  encoded: Uint8Array,
): void {
  if (field.restrictions.length === 0) return;
  const resolved = resolveAlias(catalog, schema);
  for (const restriction of field.restrictions) {
    const reader = new BinaryReader(restriction.payload);
    switch (restriction.kind) {
      case 1: {
        const hasLower = reader.u8();
        if (hasLower > 1) throw new Error(`invalid lower-bound marker for ${field.name}`);
        const lower = hasLower ? readRestrictedNumber(reader, resolved.scalarType) : undefined;
        const hasUpper = reader.u8();
        if (hasUpper > 1) throw new Error(`invalid upper-bound marker for ${field.name}`);
        const upper = hasUpper ? readRestrictedNumber(reader, resolved.scalarType) : undefined;
        reader.assertEnd();
        const actual = requireNumber(value, field.name);
        if ((lower !== undefined && compareNumber(actual, lower) < 0) ||
            (upper !== undefined && compareNumber(actual, upper) > 0)) {
          throw new Error(`numeric range restriction failed for ${field.name}`);
        }
        break;
      }
      case 2: {
        const divisor = readRestrictedNumber(reader, resolved.scalarType);
        reader.assertEnd();
        const actual = requireNumber(value, field.name);
        if (typeof actual !== 'bigint' || typeof divisor !== 'bigint' || divisor === 0n || actual % divisor !== 0n) {
          throw new Error(`multiple-of restriction failed for ${field.name}`);
        }
        break;
      }
      case 3:
        reader.assertEnd();
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`finite restriction failed for ${field.name}`);
        break;
      case 4: {
        const minimum = readU64Varint(reader);
        const maximum = readU64Varint(reader);
        reader.assertEnd();
        const length = BigInt(logicalLength(value));
        if (minimum > maximum || length < minimum || length > maximum) throw new Error(`length restriction failed for ${field.name}`);
        break;
      }
      case 5: {
        const count = Number(readU64Varint(reader));
        if (count < 1 || count > 1_000_000) throw new Error(`invalid allowed-values restriction for ${field.name}`);
        let previous: Uint8Array | undefined;
        let allowed = false;
        for (let index = 0; index < count; index += 1) {
          const length = Number(readU64Varint(reader));
          const candidate = reader.bytesOf(length);
          validateSchemaValueBytes(catalog, field.schema, candidate);
          if (previous && compareBytes(previous, candidate) >= 0) throw new Error(`unsorted allowed-values restriction for ${field.name}`);
          if (equalBytes(candidate, encoded)) allowed = true;
          previous = candidate;
        }
        reader.assertEnd();
        if (!allowed) throw new Error(`allowed-values restriction failed for ${field.name}`);
        break;
      }
      case 6: {
        const member = readU64Varint(new BinaryReader(encoded));
        let allowed = false;
        let previous = 0n;
        while (reader.remaining > 0) {
          const candidate = readU64Varint(reader);
          if (candidate === 0n || candidate <= previous) throw new Error(`invalid allowed-members restriction for ${field.name}`);
          previous = candidate;
          allowed ||= candidate === member;
        }
        if (!allowed) throw new Error(`allowed-members restriction failed for ${field.name}`);
        break;
      }
      case 7: {
        if (resolved.kind !== 7) throw new Error(`unique-elements applies to a non-array field ${field.name}`);
        reader.assertEnd();
        validateUniqueArrayElements(encoded, field.name);
        break;
      }
      default:
        throw new Error(`unknown restriction ${restriction.kind} for ${field.name}`);
    }
  }
}

function validateUniqueArrayElements(encoded: Uint8Array, fieldName: string): void {
  const reader = new BinaryReader(encoded);
  const count = Number(readU64Varint(reader));
  const values = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const length = Number(readU64Varint(reader));
    const key = bytesKey(reader.bytesOf(length));
    if (values.has(key)) throw new Error(`unique-elements restriction failed for ${fieldName}`);
    values.add(key);
  }
  reader.assertEnd();
}

function resolveAlias(catalog: SchemaCatalogV6, initial: SchemaNodeV6): SchemaNodeV6 {
  let node = initial;
  let depth = 0;
  while (node.kind === 11) {
    if (!node.target || depth++ > 32) throw new Error('invalid alias schema chain');
    const target = catalog.nodesByKey.get(keyString(node.target.key));
    if (!target) throw new Error('unresolved alias schema');
    node = target;
  }
  return node;
}

function readRestrictedNumber(reader: BinaryReader, type: ValueType): number | bigint {
  const value = decodeScalar(reader, type);
  if (typeof value !== 'number' && typeof value !== 'bigint') throw new Error('numeric restriction has non-numeric bound');
  return value;
}

function requireNumber(value: unknown, fieldName: string): number | bigint {
  if (typeof value !== 'number' && typeof value !== 'bigint') throw new Error(`numeric restriction applied to non-numeric field ${fieldName}`);
  return value;
}

function compareNumber(left: number | bigint, right: number | bigint): number {
  if (typeof left === 'bigint' && typeof right === 'bigint') {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }
  const a = Number(left);
  const b = Number(right);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function logicalLength(value: unknown): number {
  if (typeof value === 'string') return new TextEncoder().encode(value).length;
  if (value instanceof Uint8Array) return value.length;
  if (Array.isArray(value)) return value.length;
  throw new Error('length restriction applied to unsupported value');
}

function validateSchemaValueBytes(catalog: SchemaCatalogV6, ref: SchemaRefV6, bytes: Uint8Array): void {
  const child = catalog.nodesByKey.get(keyString(ref.key));
  if (!child) throw new Error('restriction references unresolved schema');
  const reader = new BinaryReader(bytes);
  decodeNode(catalog, child, reader, 0);
  reader.assertEnd();
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return left.length - right.length;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function decodeScalar(reader: BinaryReader, type: ValueType): unknown {
  switch (type) {
    case ValueType.U8: return reader.u8();
    case ValueType.U16: return reader.u16();
    case ValueType.U32: return reader.u32();
    case ValueType.U64: return reader.u64();
    case ValueType.I8: { const value = reader.u8(); return value > 127 ? value - 256 : value; }
    case ValueType.I16: { const view = new DataView(reader.bytesOf(2).buffer); return view.getInt16(0, true); }
    case ValueType.I32: { const view = new DataView(reader.bytesOf(4).buffer); return view.getInt32(0, true); }
    case ValueType.I64: { const view = new DataView(reader.bytesOf(8).buffer); return view.getBigInt64(0, true); }
    case ValueType.F32: { const view = new DataView(reader.bytesOf(4).buffer); return view.getFloat32(0, true); }
    case ValueType.F64: { const view = new DataView(reader.bytesOf(8).buffer); return view.getFloat64(0, true); }
    case ValueType.Bool: {
      const value = reader.u8();
      if (value > 1) throw new Error('invalid boolean');
      return value !== 0;
    }
    case ValueType.UVarint: return readU64Varint(reader);
    case ValueType.IVarint: { const raw = readU64Varint(reader); return (raw >> 1n) ^ -(raw & 1n); }
    case ValueType.Enum: return readU64Varint(reader);
    case ValueType.String: return readNullTerminatedString(reader);
    case ValueType.IPv4: return reader.bytesOf(4);
    case ValueType.IPv6: return reader.bytesOf(16);
    case ValueType.MAC: return reader.bytesOf(6);
    default: throw new Error(`unsupported scalar value type ${type}`);
  }
}

function readNullTerminatedString(reader: BinaryReader): string {
  const chars: number[] = [];
  while (reader.remaining > 0) {
    const byte = reader.u8();
    if (byte === 0) return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(chars));
    if (chars.length >= 1 << 20) throw new Error('scalar string exceeds maximum length');
    chars.push(byte);
  }
  throw new Error('unterminated scalar string');
}

function bytesKey(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
