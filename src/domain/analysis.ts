/**
 * Offline analysis helpers: exported capture-record decoding, derived
 * channels, and a small radix-2 FFT for magnitude spectra. All pure —
 * no DOM, no client state — so they are unit-testable in isolation.
 */

import { CaptureStatusView } from './machine-control';
import { CatalogEntry } from '../protocol/types';

/** One decoded field position inside an exported capture record. */
export interface RecordField {
  entryId: bigint;
  offset: number;
  size: number;
}

/** Decode one capture record's fields to numbers, in layout order. */
export function decodeCaptureRecord(
  record: Uint8Array,
  fields: RecordField[],
  entryById: (id: bigint) => CatalogEntry | undefined,
): number[] {
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  return fields.map((field) => {
    const entry = entryById(field.entryId);
    const type = entry?.metadata?.value_type ?? entry?.metadata?.valueType ?? '';
    const offset = field.offset;
    if (offset + field.size > record.length) return NaN;
    switch (type) {
      case 'f64':
      case 'F64':
        return view.getFloat64(offset, true);
      case 'f32':
      case 'F32':
        return view.getFloat32(offset, true);
      case 'i8':
        return view.getInt8(offset);
      case 'i16':
        return view.getInt16(offset, true);
      case 'i32':
        return view.getInt32(offset, true);
      case 'i64':
        return Number(view.getBigInt64(offset, true));
      case 'u8':
        return view.getUint8(offset);
      case 'u16':
        return view.getUint16(offset, true);
      case 'u32':
        return view.getUint32(offset, true);
      case 'u64':
        return Number(view.getBigUint64(offset, true));
      case 'bool':
        return view.getUint8(offset) !== 0 ? 1 : 0;
      default:
        // Unknown type — fall back to an unsigned little-endian read.
        switch (field.size) {
          case 1:
            return view.getUint8(offset);
          case 2:
            return view.getUint16(offset, true);
          case 4:
            return view.getUint32(offset, true);
          case 8:
            return Number(view.getBigUint64(offset, true));
          default:
            return NaN;
        }
    }
  });
}

/** Split a concatenated capture export into fixed-size records. */
export function splitCaptureRecords(payload: Uint8Array, recordSize: number): Uint8Array[] {
  if (recordSize < 1) return [];
  const records: Uint8Array[] = [];
  for (let offset = 0; offset + recordSize <= payload.length; offset += recordSize) {
    records.push(payload.subarray(offset, offset + recordSize));
  }
  return records;
}

/** Apply a derived-channel op across per-row channel values. */
export function applyDerivedOp(op: 'diff' | 'sum' | 'abs', values: number[]): number | undefined {
  if (values.length < 2) return undefined;
  switch (op) {
    case 'diff':
      return values[0]! - values[1]!;
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'abs':
      return Math.abs(values[0]!);
  }
}

/**
 * Radix-2 FFT magnitude spectrum (single-sided, bins 0..N/2).
 * Input is truncated/padded to the next power of two ≤ its length.
 * Returns magnitudes normalized by N/2 so a unit sine reads ≈1.
 */
export function fftMagnitudes(samples: number[]): number[] {
  let size = 1;
  while (size * 2 <= samples.length) size *= 2;
  if (size < 4) return [];
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < size; i += 1) re[i] = samples[i] ?? 0;
  // Iterative Cooley–Tukey with bit-reversal permutation.
  for (let i = 1, j = 0; i < size; i += 1) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= size; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < size; i += len) {
      let cRe = 1;
      let cIm = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const uRe = re[i + k]!;
        const uIm = im[i + k]!;
        const vRe = re[i + k + len / 2]! * cRe - im[i + k + len / 2]! * cIm;
        const vIm = re[i + k + len / 2]! * cIm + im[i + k + len / 2]! * cRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextRe = cRe * wRe - cIm * wIm;
        cIm = cRe * wIm + cIm * wRe;
        cRe = nextRe;
      }
    }
  }
  const half = size / 2;
  const magnitudes: number[] = [];
  for (let i = 0; i <= half; i += 1) {
    magnitudes.push(Math.hypot(re[i]!, im[i]!) / half);
  }
  return magnitudes;
}

/**
 * Build a redacted support bundle: strips tokens, source addresses, and
 * actor identifiers so the bundle can be shared with support without
 * leaking credentials or topology-internal identifiers.
 */
export function buildSupportBundle(input: {
  url?: string;
  catalog?: { id: bigint; name: string; kind: string; group: string }[];
  snapshot?: unknown;
  events?: { severity: number; type: string; description: string; timestampUs: bigint }[];
  status?: { capture?: unknown; config?: unknown };
}): Record<string, unknown> {
  const strip = (text: string) =>
    text
      .replace(/token=[^&\s]*/gi, 'token=<redacted>')
      .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '<ip>')
      .replace(/([0-9a-f]{2}:){5}[0-9a-f]{2}/gi, '<mac>');
  const redact = (value: unknown): unknown => {
    if (typeof value === 'string') return strip(value);
    if (typeof value === 'bigint') return value.toString();
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([key]) => !/token|secret|password|credential/i.test(key))
          .map(([key, v]) => [key, redact(v)]),
      );
    }
    return value;
  };
  return redact({
    generatedAt: new Date().toISOString(),
    serverUrl: strip(input.url ?? ''),
    catalog: input.catalog ?? [],
    snapshot: input.snapshot ?? null,
    events: input.events ?? [],
    status: input.status ?? {},
  }) as Record<string, unknown>;
}

export type { CaptureStatusView };
