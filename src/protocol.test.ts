import { describe, expect, it } from 'vitest';
import {
  BinaryWriter,
  MessageType,
  SlipDecoder,
  decodeValueBytes,
  encodeScalarArgument,
  makeCallFunctionRequest,
  readCallFunctionResponse,
  slipEncode,
  ValueType,
} from './protocol';

describe('Tether IO protocol', () => {
  it('round trips fragmented escaped SLIP frames', () => {
    const encoded = slipEncode(Uint8Array.from([1, 0xc0, 2, 0xdb, 3]));
    const decoder = new SlipDecoder();
    expect(decoder.push(encoded.slice(0, 2))).toHaveLength(0);
    expect([...decoder.push(encoded.slice(2))][0]).toEqual(Uint8Array.from([1, 0xc0, 2, 0xdb, 3]));
  });
  it('decodes fixed scalar values', () => {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, 12.5, true);
    expect(decodeValueBytes(bytes, ValueType.F64)).toBe(12.5);
    expect(MessageType.streamData).toBe(7);
  });
  it('rejects oversized in-progress frames', () => {
    const decoder = new SlipDecoder(3);
    expect(decoder.push(Uint8Array.from([1, 2, 3, 4, 0xc0]))).toEqual([]);
  });

  it('encodes scalar function arguments little-endian', () => {
    expect(encodeScalarArgument(ValueType.F64, 12.5)).toEqual(
      Uint8Array.from([0, 0, 0, 0, 0, 0, 0x29, 0x40]),
    );
    expect(encodeScalarArgument(ValueType.U32, 300)).toEqual(
      Uint8Array.from([0x2c, 0x01, 0x00, 0x00]),
    );
    expect(encodeScalarArgument(ValueType.Bool, 1)).toEqual(Uint8Array.from([1]));
  });

  it('builds CallFunctionReq with keyed schema payloads', () => {
    const req = makeCallFunctionRequest(0x1122334455667788n, [
      { key: 1, value: encodeScalarArgument(ValueType.F64, 2.5) },
      { key: 2, value: encodeScalarArgument(ValueType.U32, 300) },
    ]);
    const view = new DataView(req.buffer, req.byteOffset, req.byteLength);
    expect(view.getUint8(0)).toBe(MessageType.callFunctionReq);
    expect(view.getBigUint64(1, true)).toBe(0x1122334455667788n);
    expect(view.getUint32(9, true)).toBe(2);
    // First value: key 1, length 8, payload.
    expect(view.getUint8(13)).toBe(1);
    expect(view.getUint8(14)).toBe(8);
    expect(view.getFloat64(15, true)).toBe(2.5);
    // Second value: key 2, length 4, payload.
    expect(view.getUint8(23)).toBe(2);
    expect(view.getUint8(24)).toBe(4);
    expect(view.getUint32(25, true)).toBe(300);
    expect(req.length).toBe(29);
  });

  it('parses CallFunctionResp success with keyed return payload', () => {
    // type + id + success(0) + error(0) + msg("") + hasReturn + key + len + value
    const w = new BinaryWriter(1 + 8 + 1 + 4 + 2 + 1 + 1 + 1 + 8);
    w.u8(MessageType.callFunctionResp)
      .u64(0xdeadbeefn)
      .u8(0)
      .u32(0)
      .u16(0)
      .u8(1)
      .varint(1)
      .varint(8)
      .bytes(encodeScalarArgument(ValueType.F64, 42.0));
    const resp = readCallFunctionResponse(w.finish());
    expect(resp.success).toBe(true);
    expect(resp.functionId).toBe(0xdeadbeefn);
    expect(decodeValueBytes(resp.returnValue, ValueType.F64)).toBe(42.0);
  });

  it('parses CallFunctionResp failure with error message', () => {
    const msg = new TextEncoder().encode('move rejected');
    const w = new BinaryWriter(1 + 8 + 1 + 4 + 2 + msg.length);
    w.u8(MessageType.callFunctionResp).u64(0x1234n).u8(1).u32(14).u16(msg.length).bytes(msg);
    const resp = readCallFunctionResponse(w.finish());
    expect(resp.success).toBe(false);
    expect(resp.error).toBe(14);
    expect(resp.errorMessage).toBe('move rejected');
    expect(resp.returnValue).toHaveLength(0);
  });
});
