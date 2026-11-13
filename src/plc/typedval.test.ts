import { describe, expect, it } from 'vitest';
import { defaultCodec, odDecode, odEncode, odTypeName, parseHex } from './typedval';
import type { OdValue } from './ctl';

const od = (type: number, data: number[]): OdValue => ({
  type,
  access: 1,
  data: new Uint8Array(data),
});

describe('odDecode', () => {
  it('decodes each OD_T_* wire type', () => {
    expect(odDecode(od(0, [0x2a]))).toBe('42');
    expect(odDecode(od(1, [0x39, 0x30]))).toBe('12345');
    expect(odDecode(od(2, [0xff, 0xff, 0xff, 0xff]))).toBe('4294967295');
    expect(odDecode(od(3, [1, 0, 0, 0, 0, 0, 0, 0]))).toBe('1');
    expect(odDecode(od(4, [0xff, 0xff, 0xff, 0xff]))).toBe('-1');
    expect(odDecode(od(5, [...new TextEncoder().encode('hi')]))).toBe('hi');
    expect(odDecode(od(6, [0xde, 0xad]))).toBe('de ad');
  });
});

describe('odEncode', () => {
  it('round-trips every fixed-width type', () => {
    expect([...odEncode(0, '200')]).toEqual([200]);
    expect([...odEncode(1, '65535')]).toEqual([0xff, 0xff]);
    expect([...odEncode(2, '4294967295')]).toEqual([0xff, 0xff, 0xff, 0xff]);
    expect([...odEncode(3, '18446744073709551615')]).toEqual(
      Array(8).fill(0xff),
    );
    expect([...odEncode(4, '-2')]).toEqual([0xfe, 0xff, 0xff, 0xff]);
  });

  it('rejects out-of-range and non-integer input', () => {
    expect(() => odEncode(0, '256')).toThrow();
    expect(() => odEncode(0, '-1')).toThrow();
    expect(() => odEncode(1, '70000')).toThrow();
    expect(() => odEncode(2, '1.5')).toThrow();
    expect(() => odEncode(4, 'abc')).toThrow();
  });

  it('encodes str as UTF-8 and bytes as hex', () => {
    expect([...odEncode(5, 'hé')]).toEqual([...new TextEncoder().encode('hé')]);
    expect([...odEncode(6, 'de ad')]).toEqual([0xde, 0xad]);
    expect([...odEncode(6, '0xDE 0xAD')]).toEqual([0xde, 0xad]);
  });

  it('odEncode output feeds odDecode back to the same value', () => {
    for (const [ty, text] of [
      [0, '7'],
      [1, '300'],
      [2, '70000'],
      [3, '123456789012345'],
      [4, '-42'],
    ] as const) {
      const v: OdValue = { type: ty, access: 1, data: odEncode(ty, text) };
      expect(odDecode(v)).toBe(odDecode({ type: ty, access: 1, data: odEncode(ty, text) }));
    }
  });
});

describe('odTypeName', () => {
  it('names the OD_T_* codes', () => {
    expect(odTypeName(0)).toBe('u8');
    expect(odTypeName(4)).toBe('i32');
    expect(odTypeName(5)).toBe('str');
    expect(odTypeName(6)).toBe('bytes');
    expect(odTypeName(99)).toBe('raw');
  });
});

describe('defaultCodec', () => {
  it('picks the widest signed int for the width', () => {
    expect(defaultCodec(4).label).toBe('DINT');
    expect(defaultCodec(8).label).toBe('LINT');
    expect(defaultCodec(2).label).toBe('INT');
    expect(defaultCodec(1).label).toBe('SINT');
  });
});

describe('parseHex', () => {
  it('tolerates spaces, 0x prefixes and case', () => {
    expect([...parseHex('DE AD')]).toEqual([0xde, 0xad]);
    expect([...parseHex('0xde,0xad')]).toEqual([0xde, 0xad]);
    expect(() => parseHex('abc')).toThrow();
  });
});
