import { describe, expect, it } from 'vitest';
import {
  applyDerivedOp,
  buildSupportBundle,
  decodeCaptureRecord,
  fftMagnitudes,
  splitCaptureRecords,
} from './analysis';
import { CatalogEntry } from '../protocol/types';

const entry = (id: bigint, type: string): CatalogEntry => ({
  id,
  schemaEpoch: 0n,
  schemaSlot: 0,
  flags: 0,
  name: `sig-${id}`,
  description: '',
  group: 'test',
  kind: 'signal',
  metadata: { value_type: type },
});

describe('capture record decoding', () => {
  it('splits concatenated payloads into fixed-size records', () => {
    const payload = new Uint8Array(30);
    expect(splitCaptureRecords(payload, 12)).toHaveLength(2);
    expect(splitCaptureRecords(payload, 0)).toHaveLength(0);
    expect(splitCaptureRecords(payload, 64)).toHaveLength(0);
  });

  it('decodes fields by catalog value type', () => {
    const record = new Uint8Array(20);
    const view = new DataView(record.buffer);
    view.setBigUint64(0, 1234n, true); // timestamp
    view.setFloat64(8, 1.5, true);
    view.setUint32(16, 77, true);
    const fields = [
      { entryId: 10n, offset: 8, size: 8 },
      { entryId: 11n, offset: 16, size: 4 },
    ];
    const byId = (id: bigint) => (id === 10n ? entry(10n, 'f64') : entry(11n, 'u32'));
    expect(decodeCaptureRecord(record, fields, byId)).toEqual([1.5, 77]);
  });

  it('falls back to unsigned decode for unknown types and marks OOB NaN', () => {
    const record = new Uint8Array(16);
    const view = new DataView(record.buffer);
    view.setUint16(8, 0xBEEF, true);
    const fields = [
      { entryId: 1n, offset: 8, size: 2 },
      { entryId: 1n, offset: 14, size: 8 },
    ];
    const byId = () => entry(1n, 'mystery');
    const [value, oob] = decodeCaptureRecord(record, fields, byId);
    expect(value).toBe(0xbeef);
    expect(oob).toBeNaN();
  });
});

describe('derived channels', () => {
  it('computes diff, sum, and abs', () => {
    expect(applyDerivedOp('diff', [10, 4])).toBe(6);
    expect(applyDerivedOp('sum', [1, 2, 3])).toBe(6);
    expect(applyDerivedOp('abs', [-7, 1])).toBe(7);
    expect(applyDerivedOp('diff', [1])).toBeUndefined();
  });
});

describe('fftMagnitudes', () => {
  it('peaks at the sine frequency bin', () => {
    const n = 256;
    const bin = 8;
    const samples = Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * bin * i) / n));
    const mags = fftMagnitudes(samples);
    expect(mags).toHaveLength(n / 2 + 1);
    const peak = mags.indexOf(Math.max(...mags));
    expect(peak).toBe(bin);
    expect(mags[bin]).toBeGreaterThan(0.9);
  });

  it('returns empty for fewer than 4 samples', () => {
    expect(fftMagnitudes([1, 2, 3])).toHaveLength(0);
  });
});

describe('support bundle redaction', () => {
  it('strips tokens, IPs, MACs and credential keys', () => {
    const bundle = buildSupportBundle({
      url: 'ws://192.168.1.10:8000?token=secret123',
      snapshot: { authToken: 'x', note: 'path 10.0.0.5 mac aa:bb:cc:dd:ee:ff' },
      catalog: [{ id: 5n, name: 'p', kind: 'param', group: 'g' }],
    });
    const text = JSON.stringify(bundle);
    expect(text).not.toContain('secret123');
    expect(text).not.toContain('192.168.1.10');
    expect(text).not.toContain('aa:bb:cc:dd:ee:ff');
    expect(text).not.toContain('authToken');
    expect(text).toContain('"id":"5"');
  });
});
