/** Shared wire identifiers and protocol DTOs. */

export const MessageType = {
  listParamsReq: 0x01,
  listParamsResp: 0x02,
  configureStream: 0x03,
  configureAck: 0x04,
  startStream: 0x05,
  stopStream: 0x06,
  streamData: 0x07,
  error: 0x08,
  setParameterReq: 0x0b,
  setParameterResp: 0x0c,
  listSignalsReq: 0x20,
  listSignalsResp: 0x21,
  getParamReq: 0x22,
  getParamResp: 0x23,
  getSignalReq: 0x24,
  getSignalResp: 0x25,
  listFunctionsReq: 0x35,
  listFunctionsResp: 0x36,
  callFunctionReq: 0x37,
  callFunctionResp: 0x38,
  getMetadataReq: 0x09,
  getMetadataResp: 0x0a,
  snapshotParamsReq: 0x26,
  snapshotParamsResp: 0x27,
  snapshotSignalsReq: 0x28,
  snapshotSignalsResp: 0x29,
  catalogChanged: 0x2c,
  subscribeLogReq: 0x0f,
  subscribeLogResp: 0x10,
  unsubscribeLogReq: 0x11,
  unsubscribeLogResp: 0x12,
  logData: 0x13,
  configureDatalogReq: 0x2d,
  configureDatalogResp: 0x2e,
  datalogStatusReq: 0x2f,
  datalogStatusResp: 0x30,
  configureThresholdReq: 0x31,
  configureThresholdResp: 0x32,
  invokeExReq: 0x3e,
  invokeExResp: 0x3f,
  clientHello: 0x50,
  serverHello: 0x51,
  schemaRequest: 0x52,
  schemaDefinition: 0x53,
  schemaCommit: 0x54,
  schemaReject: 0x55,
  schemaUpdate: 0x56,
} as const;

export enum ValueType {
  U8 = 1,
  U16,
  U32,
  U64,
  I8,
  I16,
  I32,
  I64,
  F32,
  F64,
  Bool,
  String,
  Binary,
  IPv4,
  IPv6,
  MAC,
  Enum,
  UVarint,
  IVarint,
  Struct,
  Array,
  Stream,
}

export interface CatalogEntry {
  id: bigint;
  schemaEpoch: bigint;
  schemaSlot: number;
  flags: number;
  name: string;
  description: string;
  group: string;
  kind: 'param' | 'signal';
  metadata?: Record<string, string>;
}

export interface FunctionParameter {
  key: number;
  name: string;
  description: string;
  schemaSlot: number;
  flags: number;
  defaultValue?: Uint8Array;
  descriptor?: unknown;
  metadata: Record<string, string>;
}

export interface FunctionEntry {
  id: bigint;
  name: string;
  description: string;
  group: string;
  parameters: FunctionParameter[];
  returnPresent: boolean;
  returnSchemaSlot?: number;
  returnMetadata?: Record<string, string>;
  metadata: Record<string, string>;
}

export interface StreamLayoutEntry {
  id: bigint;
  schemaEpoch: bigint;
  schemaSlot: number;
  valueSize: number;
}

export interface StreamRow {
  specId: number;
  timestampUs: bigint;
  values: Uint8Array[];
}

export enum LogSeverity {
  Debug = 0,
  Info = 1,
  Warning = 2,
  Error = 3,
  Critical = 4,
}

export interface LogRecord {
  timestampUs: bigint;
  severity: LogSeverity;
  component: string;
  message: string;
  location: string;
}

export enum DatalogState {
  Idle = 0,
  Recording = 1,
  Stopped = 2,
  Error = 3,
}

export interface DatalogField {
  entryId: bigint;
  name: string;
  schemaEpoch: bigint;
  schemaSlot: number;
  offset: number;
  size: number;
  kind: 'param' | 'signal';
}

export interface DatalogMetadata {
  logName: string;
  recordSize: number;
  sampleRateHz: number;
  fields: DatalogField[];
}

export interface DatalogStatus {
  state: DatalogState;
  recordsWritten: bigint;
  bytesWritten: bigint;
  metadata: DatalogMetadata;
}

export enum ThresholdType {
  /** No threshold — always send. */
  None = 0,
  /** Send when |new − old| > threshold. */
  Absolute = 1,
  /** Send when |new − old| / |old| > threshold. */
  Relative = 2,
  /** Implementation-defined logic (customName + customConfig primitives). */
  Custom = 3,
}

export interface ConfigPrimitive {
  name: string;
  type: ValueType;
  value: Uint8Array;
}

export interface ThresholdRule {
  /** 0 = default rule applying to all entries. */
  entryId: bigint;
  type: ThresholdType;
  threshold: number;
  customName: string;
  customConfig: ConfigPrimitive[];
}

export interface ThresholdConfig {
  name: string;
  /** true = only entries matching rules are streamed; false = matches excluded. */
  isWhitelist: boolean;
  rules: ThresholdRule[];
}
