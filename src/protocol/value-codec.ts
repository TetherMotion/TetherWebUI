/** Primitive value decoding and display formatting. */
import { ValueType } from './types';

export function decodeValueBytes(
  bytes: Uint8Array,
  type: ValueType,
): number | bigint | boolean | string | Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (type) {
    case ValueType.U8: return view.getUint8(0);
    case ValueType.U16: return view.getUint16(0, true);
    case ValueType.U32: return view.getUint32(0, true);
    case ValueType.U64: return view.getBigUint64(0, true);
    case ValueType.I8: return view.getInt8(0);
    case ValueType.I16: return view.getInt16(0, true);
    case ValueType.I32: return view.getInt32(0, true);
    case ValueType.I64: return view.getBigInt64(0, true);
    case ValueType.F32: return view.getFloat32(0, true);
    case ValueType.F64: return view.getFloat64(0, true);
    case ValueType.Bool: return view.getUint8(0) !== 0;
    case ValueType.String: return new TextDecoder().decode(bytes);
    default: return bytes;
  }
}

export function formatValue(value: ReturnType<typeof decodeValueBytes>): string {
  if (value instanceof Uint8Array) {
    return `0x${[...value].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }
  return typeof value === 'bigint' ? value.toString() : String(value);
}
