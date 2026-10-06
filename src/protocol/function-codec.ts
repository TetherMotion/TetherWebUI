/** Request builders and correlated function-call codecs. */
import { BinaryReader, BinaryWriter } from './binary';
import { MessageType, ValueType } from './types';

export function encodeVarint(value: number): Uint8Array {
  return new BinaryWriter(5).varint(value).finish();
}

export function makeListRequest(type: number, offset = 0, count = 1000): Uint8Array {
  return new BinaryWriter(9).u8(type).u32(offset).u32(count).finish();
}

export function makeGetRequest(type: number, id: bigint): Uint8Array {
  return new BinaryWriter(9).u8(type).u64(id).finish();
}

export interface FunctionCallArg {
  key: number;
  value: Uint8Array;
}

export function makeCallFunctionRequest(functionId: bigint, args: FunctionCallArg[]): Uint8Array {
  const total = args.reduce((sum, arg) => sum + arg.value.length + 10, 0);
  const writer = new BinaryWriter(1 + 8 + 4 + total);
  writer.u8(MessageType.callFunctionReq).u64(functionId).u32(args.length);
  for (const arg of args) {
    if (arg.key <= 0) throw new Error('function parameter key must be non-zero');
    writer.varint(arg.key).varint(arg.value.length).bytes(arg.value);
  }
  return writer.finish();
}

export function encodeScalarArgument(type: ValueType, value: number): Uint8Array {
  const size = scalarWidth(type);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  switch (type) {
    case ValueType.F64: view.setFloat64(0, value, true); break;
    case ValueType.F32: view.setFloat32(0, value, true); break;
    case ValueType.U64: view.setBigUint64(0, BigInt(value), true); break;
    case ValueType.I64: view.setBigInt64(0, BigInt(value), true); break;
    case ValueType.U32: view.setUint32(0, value, true); break;
    case ValueType.I32: view.setInt32(0, value, true); break;
    case ValueType.U16: view.setUint16(0, value, true); break;
    case ValueType.I16: view.setInt16(0, value, true); break;
    case ValueType.Bool:
    case ValueType.U8: view.setUint8(0, value); break;
    case ValueType.I8: view.setInt8(0, value); break;
    default: throw new Error(`unsupported scalar argument type ${ValueType[type] ?? type}`);
  }
  return out;
}

function scalarWidth(type: ValueType): number {
  switch (type) {
    case ValueType.F64:
    case ValueType.I64:
    case ValueType.U64:
      return 8;
    case ValueType.F32:
    case ValueType.I32:
    case ValueType.U32:
      return 4;
    case ValueType.I16:
    case ValueType.U16:
      return 2;
    default:
      return 1;
  }
}

export interface FunctionCallResponse {
  functionId: bigint;
  success: boolean;
  error: number;
  errorMessage: string;
  returnValue: Uint8Array;
}

export interface InvokeExResponse extends FunctionCallResponse {
  requestId: bigint;
}

export function makeInvokeExRequest(
  requestId: bigint,
  functionId: bigint,
  args: FunctionCallArg[] = [],
  deadlineUs = 0n,
): Uint8Array {
  const total = args.reduce((sum, arg) => sum + arg.value.length + 10, 0);
  const writer = new BinaryWriter(1 + 8 + 8 + 8 + 4 + total);
  writer.u8(MessageType.invokeExReq).u64(requestId).u64(functionId).u64(deadlineUs).u32(args.length);
  for (const arg of args) {
    if (!Number.isSafeInteger(arg.key) || arg.key <= 0) throw new Error('function parameter key must be non-zero');
    writer.varint(arg.key).varint(arg.value.length).bytes(arg.value);
  }
  return writer.finish();
}

export function readInvokeExResponse(payload: Uint8Array): InvokeExResponse {
  const reader = new BinaryReader(payload);
  if (reader.u8() !== MessageType.invokeExResp) throw new Error('expected InvokeExResp');
  const requestId = reader.u64();
  const success = reader.u8() === 0;
  const error = reader.u32();
  const errorMessage = reader.string16();
  let returnValue: Uint8Array = new Uint8Array();
  if (success && reader.u8() !== 0) {
    if (reader.varint() !== 1) throw new Error('invalid function return key');
    returnValue = reader.bytesOf(reader.varint());
  }
  reader.assertEnd();
  return { requestId, functionId: 0n, success, error, errorMessage, returnValue };
}

export function readCallFunctionResponse(payload: Uint8Array): FunctionCallResponse {
  const reader = new BinaryReader(payload);
  reader.u8();
  const functionId = reader.u64();
  const success = reader.u8() === 0;
  const error = reader.u32();
  const errorMessage = reader.string16();
  let returnValue: Uint8Array = new Uint8Array();
  if (success) {
    const hasReturn = reader.u8() !== 0;
    if (hasReturn) {
      if (reader.varint() !== 1) throw new Error('invalid function return key');
      returnValue = reader.bytesOf(reader.varint());
    }
  }
  reader.assertEnd();
  return { functionId, success, error, errorMessage, returnValue };
}
