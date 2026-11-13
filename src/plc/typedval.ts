/**
 * Typed scalar codec for the debug plane: dbg write/force values,
 * break/capture compare values, OD object values, and catalog param
 * writes all move as raw LE bytes — this module translates between
 * IEC scalar types and those bytes so editors can show "80.5" instead
 * of hex.
 *
 * Sizes follow the TetherPLC blob layout: BOOL/SINT/USINT 1 B,
 * INT/UINT 2 B, DINT/UDINT/REAL 4 B, LINT/ULINT/LREAL/TIME 8 B,
 * all little-endian. TIME is stored as signed nanoseconds.
 */
import type { OdValue } from './ctl';

export interface ScalarCodec {
  /** IEC type name shown in the editor. */
  label: string;
  size: number;
  decode: (b: Uint8Array) => string;
  encode: (text: string) => Uint8Array;
}

const dec = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength);

function intCodec(label: string, size: number, signed: boolean): ScalarCodec {
  return {
    label,
    size,
    decode: (b) => {
      const v = dec(b);
      if (size === 1) return String(signed ? v.getInt8(0) : v.getUint8(0));
      if (size === 2) return String(signed ? v.getInt16(0, true) : v.getUint16(0, true));
      if (size === 4) return String(signed ? v.getInt32(0, true) : v.getUint32(0, true));
      return String(signed ? v.getBigInt64(0, true) : v.getBigUint64(0, true));
    },
    encode: (text) => {
      const n = Number(text);
      if (!Number.isFinite(n)) throw new Error(`${label}: not a number`);
      const out = new Uint8Array(size);
      const v = new DataView(out.buffer);
      if (size === 1) {
        if (signed) v.setInt8(0, n);
        else v.setUint8(0, Math.max(0, Math.min(255, Math.trunc(n))));
      } else if (size === 2) {
        if (signed) v.setInt16(0, n, true);
        else v.setUint16(0, Math.max(0, Math.min(65535, Math.trunc(n))), true);
      } else if (size === 4) {
        if (signed) v.setInt32(0, n, true);
        else v.setUint32(0, Math.max(0, Math.min(0xffffffff, Math.trunc(n))), true);
      } else if (signed) {
        v.setBigInt64(0, BigInt(Math.trunc(n)), true);
      } else {
        v.setBigUint64(0, BigInt(Math.max(0, Math.trunc(n))), true);
      }
      return out;
    },
  };
}

function floatCodec(label: string, size: 4 | 8): ScalarCodec {
  return {
    label,
    size,
    decode: (b) =>
      String(size === 8 ? dec(b).getFloat64(0, true) : dec(b).getFloat32(0, true)),
    encode: (text) => {
      const n = Number(text);
      if (!Number.isFinite(n)) throw new Error(`${label}: not a number`);
      const out = new Uint8Array(size);
      const v = new DataView(out.buffer);
      if (size === 8) v.setFloat64(0, n, true);
      else v.setFloat32(0, n, true);
      return out;
    },
  };
}

const boolCodec: ScalarCodec = {
  label: 'BOOL',
  size: 1,
  decode: (b) => (b[0] ? 'TRUE' : 'FALSE'),
  encode: (text) => {
    const t = text.trim().toUpperCase();
    const out = new Uint8Array(1);
    out[0] = t === 'TRUE' || t === '1' || t === 'ON' ? 1 : 0;
    return out;
  },
};

const timeCodec: ScalarCodec = {
  label: 'TIME',
  size: 8,
  decode: (b) => {
    const ns = Number(dec(b).getBigInt64(0, true));
    return `${ns / 1e6} ms`;
  },
  encode: (text) => {
    const m = /([\d.]+)\s*(ms|s|m|us|ns)?/i.exec(text.trim());
    if (!m) throw new Error('TIME: expected e.g. "500 ms" or "1.5 s"');
    const mult = { ns: 1, us: 1e3, ms: 1e6, s: 1e9, m: 60e9 }[
      (m[2] ?? 'ms').toLowerCase() as 'ns' | 'us' | 'ms' | 's' | 'm'
    ] ?? 1e6;
    const out = new Uint8Array(8);
    dec(out).setBigInt64(0, BigInt(Math.round(Number(m[1]) * mult)), true);
    return out;
  },
};

/** All scalar codecs grouped by byte size for picker UIs. */
export const IEC_SCALARS: ScalarCodec[] = [
  boolCodec,
  intCodec('SINT', 1, true),
  intCodec('USINT', 1, false),
  intCodec('INT', 2, true),
  intCodec('UINT', 2, false),
  intCodec('DINT', 4, true),
  intCodec('UDINT', 4, false),
  intCodec('LINT', 8, true),
  intCodec('ULINT', 8, false),
  floatCodec('REAL', 4),
  floatCodec('LREAL', 8),
  timeCodec,
];

/** Codecs whose byte size matches — for the debug editor fallback. */
export function codecsForSize(size: number): ScalarCodec[] {
  return IEC_SCALARS.filter((c) => c.size === size);
}

/** Size-only default: widest signed int for the width, REAL for floats
    is unknowable — prefer the integer codec so bit patterns stay exact. */
export function defaultCodec(size: number): ScalarCodec {
  const list = codecsForSize(size);
  return (
    list.find((c) => c.label === 'DINT' || c.label === 'LINT') ??
    list.find((c) => c.label.endsWith('INT')) ??
    list[0] ??
    IEC_SCALARS[0]!
  );
}

/** schema.name (tether_io catalog annotation) → codec, when scalar. */
export function codecFromSchema(schemaName: string | undefined, size: number): ScalarCodec | undefined {
  if (!schemaName) return undefined;
  const s = schemaName.toUpperCase();
  const map: Record<string, string> = {
    BOOL: 'BOOL', U8: 'USINT', I8: 'SINT', U16: 'UINT', I16: 'INT',
    U32: 'UDINT', I32: 'DINT', U64: 'ULINT', I64: 'LINT',
    F32: 'REAL', F64: 'LREAL',
  };
  const label = map[s];
  if (!label) return undefined;
  return IEC_SCALARS.find((c) => c.label === label && c.size === size);
}

/** Decode an OD_READ result for display. */
export function odDecode(v: OdValue): string {
  const b = v.data;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  switch (v.type) {
    case 0: return String(dv.getUint8(0));
    case 1: return String(dv.getUint16(0, true));
    case 2: return String(dv.getUint32(0, true));
    case 3: return String(dv.getBigUint64(0, true));
    case 4: return String(dv.getInt32(0, true));
    case 5: return new TextDecoder().decode(b);
    case 6: return hex(b);
    default: return hex(b);
  }
}

/** Encode text for an OD_WRITE per the object's declared OD_T_*
    type (0 u8, 1 u16, 2 u32, 3 u64, 4 i32, 5 str, 6 bytes). Throws on
    bad input; callers fall back to the length-codec/hex path when
    the type is unknown (write-only objects are never readable). */
export function odEncode(type: number, text: string): Uint8Array {
  const t = text.trim();
  const num = () => {
    if (!/^[+-]?\d+$/.test(t)) throw new Error(`OD: "${text}" is not an integer`);
    return BigInt(t);
  };
  const le = (size: number, v: bigint, signed: boolean) => {
    const out = new Uint8Array(size);
    const dv = new DataView(out.buffer);
    if (size === 1) { if (signed) dv.setInt8(0, Number(v)); else dv.setUint8(0, Number(v)); }
    else if (size === 2) { if (signed) dv.setInt16(0, Number(v), true); else dv.setUint16(0, Number(v), true); }
    else if (size === 4) { if (signed) dv.setInt32(0, Number(v), true); else dv.setUint32(0, Number(v), true); }
    else if (signed) dv.setBigInt64(0, v, true);
    else dv.setBigUint64(0, v, true);
    return out;
  };
  switch (type) {
    case 0: { const v = num(); if (v < 0n || v > 0xffn) throw new Error('OD u8: out of range'); return le(1, v, false); }
    case 1: { const v = num(); if (v < 0n || v > 0xffffn) throw new Error('OD u16: out of range'); return le(2, v, false); }
    case 2: { const v = num(); if (v < 0n || v > 0xffffffffn) throw new Error('OD u32: out of range'); return le(4, v, false); }
    case 3: return le(8, num(), false);
    case 4: return le(4, num(), true);
    case 5: return new TextEncoder().encode(t);
    case 6: return parseHex(t);
    default: return parseHex(t);
  }
}

/** OD_T_* type name for editor hints. */
export function odTypeName(type: number): string {
  return ['u8', 'u16', 'u32', 'u64', 'i32', 'str', 'bytes'][type] ?? 'raw';
}

export function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');
}

/** Parse "dead beef" / "DEADBEEF" / "0x12 0x34" into bytes. */
export function parseHex(text: string): Uint8Array {
  const clean = text.replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2) throw new Error('hex: odd digit count');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
