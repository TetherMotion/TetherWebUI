/**
 * @file machine-control.ts
 * @brief Typed domain client for the machine.cia402.v1 control surface.
 *
 * Mirrors the tagged-struct wire encoding used by `MachineService` on the
 * C++ side (`detail::encodeTagged` / `parseTagged`): a field-count varint,
 * then per-field [key varint][length varint][payload].  Scalars are little
 * endian, strings are NUL-terminated UTF-8, byte fields carry a varint
 * length prefix, and arrays are a count varint followed by
 * length-prefixed elements.
 *
 * All functions fail closed on the server: this layer only builds the
 * request payload and interprets the receipt — it never decides whether a
 * command is permissible.  Browser commands are bounded by authority
 * leases, deadlines, and state generations and do not replace functional
 * safety systems (E-stop, STO, hardware interlocks).
 */

import { BinaryWriter } from '../protocol/binary';
import { FunctionEntry } from '../protocol/types';
import { TetherIOClient, InvokeOptions } from '../client';

// ---------------------------------------------------------------------------
// Function-name contract (registered by MachineService::install)
// ---------------------------------------------------------------------------

export const MACHINE_FUNCTION_NAMES = {
  authorityAcquire: 'machine.authority.acquire',
  authorityRenew: 'machine.authority.renew',
  authorityRelease: 'machine.authority.release',
  authorityTakeover: 'machine.authority.takeover',
  command: 'machine.command',
  commandCancel: 'machine.command.cancel',
  operationRead: 'machine.operation.read',
  operationsList: 'machine.operations.list',
  alarmsRead: 'machine.alarms.read',
  alarmsAcknowledge: 'machine.alarms.acknowledge',
  alarmsClear: 'machine.alarms.clear',
  captureConfigure: 'machine.capture.configure',
  captureStatus: 'machine.capture.status',
  captureCancel: 'machine.capture.cancel',
  captureExport: 'machine.capture.export',
  configStage: 'machine.config.stage',
  configValidate: 'machine.config.validate',
  configCommit: 'machine.config.commit',
  configRollback: 'machine.config.rollback',
  configStatus: 'machine.config.status',
  configExport: 'machine.config.export',
  configDiff: 'machine.config.diff',
  configImport: 'machine.config.import',
  checklistList: 'machine.checklist.list',
  checklistReport: 'machine.checklist.report',
  recipeList: 'machine.recipe.list',
  recipeApply: 'machine.recipe.apply',
  sdoList: 'machine.sdo.list',
  sdoRead: 'machine.sdo.read',
  sdoWrite: 'machine.sdo.write',
  pdoMap: 'machine.pdo.map',
  supervisorStatus: 'machine.supervisor.status',
  supervisorRetry: 'machine.supervisor.retry',
} as const;

export const AUTHORITY_SNAPSHOT_SIGNAL = 'machine.authority.snapshot';
export const ALARM_CURSOR_SIGNAL = 'machine.alarms.cursor';

// ---------------------------------------------------------------------------
// Tagged-struct wire codec (must match MachineService detail::* exactly)
// ---------------------------------------------------------------------------

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function varintBytes(value: number | bigint): Uint8Array {
  const writer = new BinaryWriter(10);
  let remaining = BigInt(value);
  do {
    const byte = Number(remaining % 128n);
    remaining /= 128n;
    writer.u8(remaining ? byte | 0x80 : byte);
  } while (remaining);
  return writer.finish();
}

function readVarint(bytes: Uint8Array, position: { offset: number }): bigint {
  let value = 0n;
  for (let index = 0; index < 10; index++) {
    if (position.offset >= bytes.length) throw new Error('truncated varint');
    const byte = bytes[position.offset++]!;
    if (index === 9 && byte > 1) throw new Error('varint overflow');
    value |= BigInt(byte & 0x7f) << BigInt(index * 7);
    if (!(byte & 0x80)) return value;
  }
  throw new Error('truncated varint');
}

export function fieldString(value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  const out = new Uint8Array(encoded.length + 1);
  out.set(encoded);
  return out;
}

export function fieldScalar(value: number | bigint, width: number): Uint8Array {
  const out = new Uint8Array(width);
  const view = new DataView(out.buffer);
  switch (width) {
    case 1:
      view.setUint8(0, Number(value));
      break;
    case 2:
      view.setUint16(0, Number(value), true);
      break;
    case 4:
      view.setUint32(0, Number(value), true);
      break;
    case 8:
      view.setBigUint64(0, BigInt(value), true);
      break;
    default:
      throw new Error(`unsupported scalar width ${width}`);
  }
  return out;
}

export function fieldBool(value: boolean): Uint8Array {
  return Uint8Array.of(value ? 1 : 0);
}

export function fieldBytes(value: Uint8Array): Uint8Array {
  return concat([varintBytes(value.length), value]);
}

/** Tagged struct: [count varint] then ascending [key varint][len varint][bytes]. */
export function encodeTagged(fields: [number, Uint8Array][]): Uint8Array {
  const ordered = [...fields].sort((a, b) => a[0] - b[0]);
  const parts = [varintBytes(ordered.length)];
  for (const [key, value] of ordered) {
    parts.push(varintBytes(key), varintBytes(value.length), value);
  }
  return concat(parts);
}

/** Dynamic array: count varint + per-element [len varint][bytes]. */
export function encodeTaggedArray(elements: Uint8Array[]): Uint8Array {
  const parts = [varintBytes(elements.length)];
  for (const element of elements) parts.push(varintBytes(element.length), element);
  return concat(parts);
}

export function parseTagged(bytes: Uint8Array): Map<number, Uint8Array> {
  const fields = new Map<number, Uint8Array>();
  const position = { offset: 0 };
  const count = readVarint(bytes, position);
  if (count > 1024n) throw new Error('tagged struct field count out of bounds');
  let previous = 0n;
  for (let index = 0n; index < count; index++) {
    const key = readVarint(bytes, position);
    const length = readVarint(bytes, position);
    if (key <= previous || key > 0xffffffffn) throw new Error('tagged struct keys out of order');
    previous = key;
    if (Number(length) > bytes.length - position.offset) throw new Error('tagged field truncated');
    fields.set(Number(key), bytes.slice(position.offset, position.offset + Number(length)));
    position.offset += Number(length);
  }
  if (position.offset !== bytes.length) throw new Error('tagged struct has trailing bytes');
  return fields;
}

export function getTaggedString(fields: Map<number, Uint8Array>, key: number): string {
  const bytes = fields.get(key);
  if (!bytes || bytes.length === 0 || bytes[bytes.length - 1] !== 0)
    throw new Error(`tagged field ${key} is not a string`);
  if (bytes.subarray(0, bytes.length - 1).includes(0))
    throw new Error(`tagged field ${key} contains an embedded NUL`);
  const text = new TextDecoder().decode(bytes.subarray(0, bytes.length - 1));
  return text;
}

export function getTaggedU64(fields: Map<number, Uint8Array>, key: number): bigint {
  const bytes = fields.get(key);
  if (!bytes || bytes.length !== 8) throw new Error(`tagged field ${key} is not a u64`);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true);
}

export function getTaggedU32(fields: Map<number, Uint8Array>, key: number): number {
  const bytes = fields.get(key);
  if (!bytes || bytes.length !== 4) throw new Error(`tagged field ${key} is not a u32`);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
}

export function getTaggedU8(fields: Map<number, Uint8Array>, key: number): number {
  const bytes = fields.get(key);
  if (!bytes || bytes.length !== 1) throw new Error(`tagged field ${key} is not a u8`);
  return bytes[0]!;
}

export function getTaggedU16(fields: Map<number, Uint8Array>, key: number): number {
  const bytes = fields.get(key);
  if (!bytes || bytes.length !== 2) throw new Error(`tagged field ${key} is not a u16`);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(0, true);
}

export function getTaggedF64(fields: Map<number, Uint8Array>, key: number): number {
  const bytes = fields.get(key);
  if (!bytes || bytes.length !== 8) throw new Error(`tagged field ${key} is not an f64`);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(0, true);
}

export function getTaggedBool(fields: Map<number, Uint8Array>, key: number): boolean {
  const value = getTaggedU8(fields, key);
  if (value > 1) throw new Error(`tagged field ${key} is not a bool`);
  return value !== 0;
}

/** Decode an element array into raw element payloads. */
export function decodeTaggedArray(bytes: Uint8Array): Uint8Array[] {
  const position = { offset: 0 };
  const count = readVarint(bytes, position);
  const elements: Uint8Array[] = [];
  for (let index = 0n; index < count; index++) {
    const length = readVarint(bytes, position);
    if (Number(length) > bytes.length - position.offset)
      throw new Error('tagged array element truncated');
    elements.push(bytes.slice(position.offset, position.offset + Number(length)));
    position.offset += Number(length);
  }
  if (position.offset !== bytes.length) throw new Error('tagged array has trailing bytes');
  return elements;
}

function decodeStringArray(bytes: Uint8Array): string[] {
  return decodeTaggedArray(bytes).map((element) => {
    const map = new Map<number, Uint8Array>([[1, element]]);
    return getTaggedString(map, 1);
  });
}

// ---------------------------------------------------------------------------
// DTOs (machine.cia402.v1 profile)
// ---------------------------------------------------------------------------

/** CommandState values from the wire (MachineControl.hpp). */
export const CommandState = {
  InProgress: 0,
  Accepted: 1,
  Rejected: 2,
  Failed: 3,
} as const;
export type CommandStateValue = (typeof CommandState)[keyof typeof CommandState];

/** Action values (MachineControl.hpp, declaration order = wire value). */
export const MachineAction = {
  Enable: 0,
  Disable: 1,
  QuickStop: 2,
  FaultReset: 3,
  Recover: 4,
  SetMode: 5,
  JogStart: 6,
  JogRenew: 7,
  JogStop: 8,
  StepMove: 9,
  MoveToPosition: 10,
  GroupMove: 11,
  HomePrepare: 12,
  HomeStart: 13,
  HomeCancel: 14,
  ConfigurationStage: 15,
  ConfigurationValidate: 16,
  ConfigurationCommit: 17,
  ConfigurationRollback: 18,
  CancelOperation: 19,
  AcknowledgeAlarm: 20,
} as const;
export type MachineActionValue = (typeof MachineAction)[keyof typeof MachineAction];

export const OperationState = {
  Queued: 0,
  Running: 1,
  Completed: 2,
  Failed: 3,
  Cancelled: 4,
} as const;

export const AlarmState = {
  Active: 0,
  Acknowledged: 1,
  Cleared: 2,
} as const;

export interface AuthorityResultView {
  granted: boolean;
  scope: string;
  token: bigint;
  remainingMs: number;
  owner: string;
  blocker: string;
}

export interface AuthorityLeaseView {
  scope: string;
  ownerActor: string;
  token: bigint;
  remainingMs: number;
}

export interface AuthoritySnapshotView {
  timestampUs: bigint;
  leases: AuthorityLeaseView[];
}

export interface CommandRequestInput {
  /** Client-generated UUID — the server deduplicates on this key. */
  requestUuid: string;
  scope: string;
  authorityToken: bigint;
  action: MachineActionValue;
  /** Parallel arrays: target resource ids and their expected generations. */
  targets: string[];
  expectedGenerations: bigint[];
  /** Relative validity budget in microseconds measured from server receipt. */
  deadlineUs: bigint;
  configurationRevision?: bigint;
  parameters?: Uint8Array;
}

export interface CommandReceiptView {
  requestUuid: string;
  state: CommandStateValue;
  message: string;
  operationId: string;
  auditId: string;
  blockers: string[];
}

export interface OperationView {
  operationId: string;
  requestUuid: string;
  state: number;
  progress: number;
  action: number;
  target: string;
  message: string;
  startedUs: bigint;
  finishedUs: bigint;
  resultCode: number;
}

export interface AlarmView {
  alarmId: bigint;
  raisedUs: bigint;
  updatedUs: bigint;
  state: number;
  severity: number;
  code: number;
  sourceId: string;
  description: string;
  actor: string;
}

export interface AlarmPageView {
  oldestCursor: bigint;
  latestCursor: bigint;
  nextCursor: bigint;
  gap: boolean;
  alarms: AlarmView[];
}

/** Result of machine.alarms.acknowledge / clear (server status byte). */
export const AlarmMutationStatus = {
  Ok: 0,
  AbsentOrTerminal: 1,
  Denied: 2,
} as const;

/** DatalogState values from the wire (Datalogging.hpp). */
export const CaptureState = {
  Idle: 0,
  Recording: 1,
  Stopped: 2,
  Error: 3,
} as const;

/** ConfigTxnState values from the wire (MachineService.hpp). */
export const ConfigTxnState = {
  Idle: 0,
  Staged: 1,
  Validated: 2,
  Committed: 3,
  Failed: 4,
  RolledBack: 5,
} as const;
export type ConfigTxnStateValue = (typeof ConfigTxnState)[keyof typeof ConfigTxnState];

export interface CaptureStatusView {
  timestampUs: bigint;
  state: number;
  recordsWritten: bigint;
  bytesWritten: bigint;
  logName: string;
  sampleRateHz: number;
  fieldCount: number;
  enabled: boolean;
  /** 0 none, 1 armed (pre-trigger ring), 2 post-trigger collecting, 3 complete. */
  triggerState: number;
  recordsAvailable: bigint;
  recordsDropped: bigint;
  /** Binary layout of each exported record (empty on older servers). */
  recordFields: { entryId: bigint; offset: number; size: number }[];
}

export interface CaptureTriggerSpec {
  /** Signal entry id evaluated per record. */
  entryId: bigint;
  /** 0 = value > level, 1 = value < level, 2 = |value| > level. */
  op: number;
  level: number;
  preRecords: number;
  postRecords: number;
}

export interface CaptureExportChunkView {
  offset: bigint;
  totalRecords: bigint;
  droppedRecords: bigint;
  recordSize: number;
  payload: Uint8Array;
}

export interface ConfigEntryView {
  entryId: bigint;
  value: Uint8Array;
}

/**
 * Transaction failures arrive as state=Failed inside this struct — the
 * InvokeEx call itself succeeds so the full status is preserved.
 */
export interface ConfigStatusView {
  transactionId: bigint;
  state: ConfigTxnStateValue;
  revision: bigint;
  stagedCount: number;
  message: string;
  staged: ConfigEntryView[];
}

/** One known object-dictionary entry (SdoEntryV1). */
export interface SdoEntryView {
  index: number;
  subindex: number;
  dataType: number;
  /** 1 read-only, 3 read/write */
  access: number;
  name: string;
  /** ESI/device-profile description (absent on older servers). */
  description?: string;
  /** Bounds from the object table; NaN = unbounded. */
  minValue?: number;
  maxValue?: number;
}

/** SDO transfer outcome (SdoResultV1). */
export interface SdoResultView {
  ok: boolean;
  /** CoE SDO abort code, or zero */
  abortCode: number;
  data: Uint8Array;
  error: string;
  /** Decoded CiA 301 abort-code name (absent on older servers). */
  abortName?: string;
  /** Post-write verification payload (writes only, absent on older servers). */
  readback?: Uint8Array;
}

// ---------------------------------------------------------------------------
// Decoders for function return values
// ---------------------------------------------------------------------------

function decodeAuthorityResult(bytes: Uint8Array): AuthorityResultView {
  const fields = parseTagged(bytes);
  return {
    granted: getTaggedBool(fields, 1),
    scope: getTaggedString(fields, 2),
    token: getTaggedU64(fields, 3),
    remainingMs: getTaggedU32(fields, 4),
    owner: getTaggedString(fields, 5),
    blocker: getTaggedString(fields, 6),
  };
}

function decodeCommandReceipt(bytes: Uint8Array): CommandReceiptView {
  const fields = parseTagged(bytes);
  const blockersField = fields.get(6);
  return {
    requestUuid: getTaggedString(fields, 1),
    state: getTaggedU8(fields, 2) as CommandStateValue,
    message: getTaggedString(fields, 3),
    operationId: getTaggedString(fields, 4),
    auditId: getTaggedString(fields, 5),
    blockers: blockersField ? decodeStringArray(blockersField) : [],
  };
}

function decodeOperation(bytes: Uint8Array): OperationView {
  const fields = parseTagged(bytes);
  return {
    operationId: getTaggedString(fields, 1),
    requestUuid: getTaggedString(fields, 2),
    state: getTaggedU8(fields, 3),
    progress: getTaggedU8(fields, 4),
    action: getTaggedU8(fields, 5),
    target: getTaggedString(fields, 6),
    message: getTaggedString(fields, 7),
    startedUs: getTaggedU64(fields, 8),
    finishedUs: getTaggedU64(fields, 9),
    resultCode: getTaggedU32(fields, 10),
  };
}

export function decodeAuthoritySnapshot(bytes: Uint8Array): AuthoritySnapshotView {
  const fields = parseTagged(bytes);
  const leasesField = fields.get(2);
  const leases: AuthorityLeaseView[] = leasesField
    ? decodeTaggedArray(leasesField).map((leaseBytes) => {
        const lease = parseTagged(leaseBytes);
        return {
          scope: getTaggedString(lease, 1),
          ownerActor: getTaggedString(lease, 2),
          token: getTaggedU64(lease, 3),
          remainingMs: getTaggedU32(lease, 4),
        };
      })
    : [];
  return { timestampUs: getTaggedU64(fields, 1), leases };
}

function decodeAlarmPage(bytes: Uint8Array): AlarmPageView {
  const fields = parseTagged(bytes);
  const alarmsField = fields.get(5);
  const alarms: AlarmView[] = alarmsField
    ? decodeTaggedArray(alarmsField).map((alarmBytes) => {
        const alarm = parseTagged(alarmBytes);
        return {
          alarmId: getTaggedU64(alarm, 1),
          raisedUs: getTaggedU64(alarm, 2),
          updatedUs: getTaggedU64(alarm, 3),
          state: getTaggedU8(alarm, 4),
          severity: getTaggedU8(alarm, 5),
          code: getTaggedU32(alarm, 6),
          sourceId: getTaggedString(alarm, 7),
          description: getTaggedString(alarm, 8),
          actor: getTaggedString(alarm, 9),
        };
      })
    : [];
  return {
    oldestCursor: getTaggedU64(fields, 1),
    latestCursor: getTaggedU64(fields, 2),
    nextCursor: getTaggedU64(fields, 3),
    gap: getTaggedBool(fields, 4),
    alarms,
  };
}

function decodeCaptureStatus(bytes: Uint8Array): CaptureStatusView {
  const fields = parseTagged(bytes);
  return {
    timestampUs: getTaggedU64(fields, 1),
    state: getTaggedU8(fields, 2),
    recordsWritten: getTaggedU64(fields, 3),
    bytesWritten: getTaggedU64(fields, 4),
    logName: getTaggedString(fields, 5),
    sampleRateHz: getTaggedU32(fields, 6),
    fieldCount: getTaggedU32(fields, 7),
    enabled: getTaggedBool(fields, 8),
    // Fields 9-11 are optional: servers predating trigger support omit them.
    triggerState: fields.get(9)?.[0] ?? 0,
    recordsAvailable: getTaggedU64Or(fields, 10, 0n),
    recordsDropped: getTaggedU64Or(fields, 11, 0n),
    recordFields: decodeCaptureFieldArray(fields.get(12)),
  };
}

/** Tagged array of {entry_id, offset, size} structs (field 12). */
function decodeCaptureFieldArray(
  bytes: Uint8Array | undefined,
): { entryId: bigint; offset: number; size: number }[] {
  if (!bytes?.length) return [];
  const elements = decodeTaggedArray(bytes);
  return elements.map((element) => {
    const fields = parseTagged(element);
    return {
      entryId: getTaggedU64(fields, 1),
      offset: getTaggedU32(fields, 2),
      size: getTaggedU32(fields, 3),
    };
  });
}

function getTaggedU64Or(fields: Map<number, Uint8Array>, key: number, fallback: bigint): bigint {
  const bytes = fields.get(key);
  if (!bytes) return fallback;
  return getTaggedU64(fields, key);
}

function decodeCaptureExport(bytes: Uint8Array): CaptureExportChunkView {
  const fields = parseTagged(bytes);
  return {
    offset: getTaggedU64(fields, 1),
    totalRecords: getTaggedU64(fields, 2),
    droppedRecords: getTaggedU64(fields, 3),
    recordSize: getTaggedU32(fields, 4),
    payload: fields.get(5) ?? new Uint8Array(),
  };
}

function decodeConfigEntry(bytes: Uint8Array): ConfigEntryView {
  const fields = parseTagged(bytes);
  const raw = fields.get(2);
  if (!raw) throw new Error('ConfigEntryV1 value is missing');
  // value is a Bytes field: varint length + payload.
  const position = { offset: 0 };
  const length = readVarint(raw, position);
  if (Number(length) !== raw.length - position.offset)
    throw new Error('ConfigEntryV1 value is malformed');
  return {
    entryId: getTaggedU64(fields, 1),
    value: raw.slice(position.offset),
  };
}

function decodeConfigStatus(bytes: Uint8Array): ConfigStatusView {
  const fields = parseTagged(bytes);
  const stagedField = fields.get(6);
  return {
    transactionId: getTaggedU64(fields, 1),
    state: getTaggedU8(fields, 2) as ConfigTxnStateValue,
    revision: getTaggedU64(fields, 3),
    stagedCount: getTaggedU32(fields, 4),
    message: getTaggedString(fields, 5),
    staged: stagedField ? decodeTaggedArray(stagedField).map(decodeConfigEntry) : [],
  };
}

function decodeSdoEntry(bytes: Uint8Array): SdoEntryView {
  const fields = parseTagged(bytes);
  return {
    index: getTaggedU16(fields, 1),
    subindex: getTaggedU8(fields, 2),
    dataType: getTaggedU16(fields, 3),
    access: getTaggedU8(fields, 4),
    name: getTaggedString(fields, 5),
    description: fields.has(6) ? getTaggedString(fields, 6) : undefined,
    minValue: fields.has(7) ? getTaggedF64(fields, 7) : undefined,
    maxValue: fields.has(8) ? getTaggedF64(fields, 8) : undefined,
  };
}

function decodeBytesField(fields: Map<number, Uint8Array>, key: number): Uint8Array | undefined {
  const field = fields.get(key);
  if (!field) return undefined;
  const position = { offset: 0 };
  const length = Number(readVarint(field, position));
  if (!Number.isSafeInteger(length) || field.length - position.offset < length) return undefined;
  return field.subarray(position.offset, position.offset + length);
}

function decodeSdoResult(bytes: Uint8Array): SdoResultView {
  const fields = parseTagged(bytes);
  return {
    ok: getTaggedBool(fields, 1),
    abortCode: getTaggedU32(fields, 2),
    data: decodeBytesField(fields, 3) ?? new Uint8Array(),
    error: getTaggedString(fields, 4),
    abortName: fields.has(5) ? getTaggedString(fields, 5) : undefined,
    readback: decodeBytesField(fields, 6),
  };
}

// ---------------------------------------------------------------------------
// MachineControlClient — typed wrapper over catalog functions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Config baseline export/diff + commissioning checklist
// ---------------------------------------------------------------------------

export interface ConfigExportView {
  revision: bigint;
  entries: ConfigEntryView[];
}

export function decodeConfigExport(bytes: Uint8Array): ConfigExportView {
  const fields = parseTagged(bytes);
  const entriesField = fields.get(2);
  return {
    revision: getTaggedU64(fields, 1),
    entries: entriesField ? decodeTaggedArray(entriesField).map(decodeConfigEntry) : [],
  };
}

export interface ConfigDiffEntryView {
  entryId: bigint;
  expected: Uint8Array;
  actual: Uint8Array;
}

export interface ConfigDiffView {
  revision: bigint;
  diffs: ConfigDiffEntryView[];
}

export function decodeConfigDiff(bytes: Uint8Array): ConfigDiffView {
  const fields = parseTagged(bytes);
  const entriesField = fields.get(3);
  const diffs = entriesField
    ? decodeTaggedArray(entriesField).map((element) => {
        const f = parseTagged(element);
        return {
          entryId: getTaggedU64(f, 1),
          expected: decodeBytesField(f, 2) ?? new Uint8Array(),
          actual: decodeBytesField(f, 3) ?? new Uint8Array(),
        };
      })
    : [];
  return { revision: getTaggedU64(fields, 1), diffs };
}

export interface ChecklistItemView {
  itemId: number;
  label: string;
  required: boolean;
  passed: boolean;
  evidence: string;
}

export function decodeChecklistItem(bytes: Uint8Array): ChecklistItemView {
  const fields = parseTagged(bytes);
  return {
    itemId: getTaggedU32(fields, 1),
    label: getTaggedString(fields, 2),
    required: getTaggedBool(fields, 3),
    passed: getTaggedBool(fields, 4),
    evidence: fields.has(5) ? getTaggedString(fields, 5) : '',
  };
}

export interface ChecklistReportView {
  generatedUs: bigint;
  revision: bigint;
  allRequiredPassed: boolean;
  items: ChecklistItemView[];
}

export function decodeChecklistReport(bytes: Uint8Array): ChecklistReportView {
  const fields = parseTagged(bytes);
  const itemsField = fields.get(4);
  return {
    generatedUs: getTaggedU64(fields, 1),
    revision: getTaggedU64(fields, 2),
    allRequiredPassed: getTaggedBool(fields, 3),
    items: itemsField ? decodeTaggedArray(itemsField).map(decodeChecklistItem) : [],
  };
}

function encodeConfigEntryArray(entries: ConfigEntryView[]): Uint8Array {
  return encodeTaggedArray(
    entries.map((entry) =>
      encodeTagged([
        [1, fieldScalar(entry.entryId, 8)],
        [2, fieldBytes(entry.value)],
      ]),
    ),
  );
}

// ---------------------------------------------------------------------------
// Recipes (optional; staged through the configuration transaction machinery)
// ---------------------------------------------------------------------------

export interface RecipeInfoView {
  name: string;
  description: string;
  entryCount: number;
}

export function decodeRecipeInfo(bytes: Uint8Array): RecipeInfoView {
  const fields = parseTagged(bytes);
  return {
    name: getTaggedString(fields, 1),
    description: fields.has(2) ? getTaggedString(fields, 2) : '',
    entryCount: getTaggedU32(fields, 3),
  };
}

// ---------------------------------------------------------------------------
// PDO map + supervisor (optional pluggable surfaces)
// ---------------------------------------------------------------------------

export interface PdoEntryView {
  slaveIndex: number;
  pdoIndex: number;
  /** 0 = RxPDO (master→slave output), 1 = TxPDO (slave→master input). */
  direction: number;
  /** Logical byte offset in the process image. */
  logicalOffset: number;
  length: number;
  entryIndex: number;
}

export function decodePdoEntry(bytes: Uint8Array): PdoEntryView {
  const f = parseTagged(bytes);
  return {
    slaveIndex: getTaggedU16(f, 1),
    pdoIndex: getTaggedU16(f, 2),
    direction: getTaggedU8(f, 3),
    logicalOffset: getTaggedU32(f, 4),
    length: getTaggedU16(f, 5),
    entryIndex: getTaggedU16(f, 6),
  };
}

export interface SupervisorEntryView {
  slaveIndex: number;
  /** SlaveRecoveryState ordinal: 0 Normal … 4 Failed. */
  state: number;
  suspended: boolean;
  recovering: boolean;
  attemptCount: number;
}

export const SUPERVISOR_STATE_LABELS = [
  'normal',
  'critical',
  'recovering',
  'recovered',
  'failed',
] as const;

export function decodeSupervisorEntry(bytes: Uint8Array): SupervisorEntryView {
  const f = parseTagged(bytes);
  return {
    slaveIndex: getTaggedU16(f, 1),
    state: getTaggedU8(f, 2),
    suspended: getTaggedBool(f, 3),
    recovering: getTaggedBool(f, 4),
    attemptCount: getTaggedU16(f, 5),
  };
}

export interface SupervisorResultView {
  ok: boolean;
  state: number;
  error: string;
}

export function decodeSupervisorResult(bytes: Uint8Array): SupervisorResultView {
  const f = parseTagged(bytes);
  return {
    ok: getTaggedBool(f, 1),
    state: getTaggedU8(f, 2),
    error: f.has(3) ? getTaggedString(f, 3) : '',
  };
}

/**
 * Typed client over the `machine.*` function surface.  The client resolves
 * function IDs from the negotiated function catalog by name so servers can
 * choose their own numeric IDs.
 */

export class MachineControlClient {
  private readonly ids = new Map<string, bigint>();

  constructor(
    private readonly client: TetherIOClient,
    functions: FunctionEntry[],
  ) {
    for (const entry of functions) this.ids.set(entry.name, entry.id);
  }

  /** Whether the server advertises the full control surface. */
  get controlsAvailable(): boolean {
    return (
      this.ids.has(MACHINE_FUNCTION_NAMES.authorityAcquire) &&
      this.ids.has(MACHINE_FUNCTION_NAMES.command) &&
      this.ids.has(MACHINE_FUNCTION_NAMES.alarmsRead)
    );
  }

  functionId(name: string): bigint {
    const id = this.ids.get(name);
    if (id === undefined) throw new Error(`server does not expose ${name}`);
    return id;
  }

  // ---- Authority ----------------------------------------------------------

  acquireAuthority(scope: string, leaseMs: number): Promise<AuthorityResultView> {
    return this.invokeStruct(MACHINE_FUNCTION_NAMES.authorityAcquire, [
      { key: 1, value: fieldString(scope) },
      { key: 2, value: fieldScalar(leaseMs, 4) },
    ]).then(decodeAuthorityResult);
  }

  renewAuthority(token: bigint, scope: string, leaseMs: number): Promise<AuthorityResultView> {
    return this.invokeStruct(MACHINE_FUNCTION_NAMES.authorityRenew, [
      { key: 1, value: fieldScalar(token, 8) },
      { key: 2, value: fieldString(scope) },
      { key: 3, value: fieldScalar(leaseMs, 4) },
    ]).then(decodeAuthorityResult);
  }

  releaseAuthority(token: bigint, scope: string): Promise<AuthorityResultView> {
    return this.invokeStruct(MACHINE_FUNCTION_NAMES.authorityRelease, [
      { key: 1, value: fieldScalar(token, 8) },
      { key: 2, value: fieldString(scope) },
    ]).then(decodeAuthorityResult);
  }

  /**
   * Force-take a scope lease from its current owner. Server-side role policy
   * (controls engineer or administrator) applies; the evicted owner is
   * recorded in the audit trail.
   */
  takeoverAuthority(scope: string, leaseMs: number): Promise<AuthorityResultView> {
    return this.invokeStruct(MACHINE_FUNCTION_NAMES.authorityTakeover, [
      { key: 1, value: fieldString(scope) },
      { key: 2, value: fieldScalar(leaseMs, 4) },
    ]).then(decodeAuthorityResult);
  }

  // ---- Commands -----------------------------------------------------------

  /**
   * Submit a validated machine command.
   *
   * The returned promise resolves once the server issues a receipt —
   * `state` may still be `InProgress`, `Rejected`, or `Failed`.  Rejected
   * receipts carry structured `blockers` suitable for display.
   */
  async command(
    request: CommandRequestInput,
    options?: InvokeOptions,
  ): Promise<CommandReceiptView> {
    if (
      request.targets.length === 0 ||
      request.targets.length !== request.expectedGenerations.length
    )
      throw new Error('targets and expectedGenerations must be non-empty parallel arrays');
    const payload = encodeTagged([
      [1, fieldString(request.requestUuid)],
      [2, fieldString(request.scope)],
      [3, fieldScalar(request.authorityToken, 8)],
      [4, fieldScalar(request.action, 1)],
      [5, encodeTaggedArray(request.targets.map(fieldString))],
      [6, encodeTaggedArray(request.expectedGenerations.map((g) => fieldScalar(g, 8)))],
      [7, fieldScalar(request.deadlineUs, 8)],
      ...(request.configurationRevision !== undefined
        ? [[8, fieldScalar(request.configurationRevision, 8)] as [number, Uint8Array]]
        : []),
      ...(request.parameters ? [[9, fieldBytes(request.parameters)] as [number, Uint8Array]] : []),
    ]);
    const bytes = await this.client.callFunctionOrThrow(
      this.functionId(MACHINE_FUNCTION_NAMES.command),
      [{ key: 1, value: payload }],
      options,
    );
    return decodeCommandReceipt(bytes);
  }

  cancelOperation(operationId: string): Promise<OperationView> {
    return this.invokeStruct(MACHINE_FUNCTION_NAMES.commandCancel, [
      { key: 1, value: fieldString(operationId) },
    ]).then(decodeOperation);
  }

  // ---- Operations ---------------------------------------------------------

  readOperation(operationId: string): Promise<OperationView> {
    return this.invokeStruct(MACHINE_FUNCTION_NAMES.operationRead, [
      { key: 1, value: fieldString(operationId) },
    ]).then(decodeOperation);
  }

  async listOperations(limit = 32): Promise<OperationView[]> {
    const bytes = await this.client.callFunctionOrThrow(
      this.functionId(MACHINE_FUNCTION_NAMES.operationsList),
      [{ key: 1, value: fieldScalar(limit, 4) }],
    );
    return decodeTaggedArray(bytes).map(decodeOperation);
  }

  // ---- Alarms -------------------------------------------------------------

  async readAlarms(afterCursor: bigint, limit = 50): Promise<AlarmPageView> {
    const bytes = await this.client.callFunctionOrThrow(
      this.functionId(MACHINE_FUNCTION_NAMES.alarmsRead),
      [
        { key: 1, value: fieldScalar(afterCursor, 8) },
        { key: 2, value: fieldScalar(limit, 4) },
      ],
    );
    return decodeAlarmPage(bytes);
  }

  acknowledgeAlarm(alarmId: bigint): Promise<number> {
    return this.alarmMutation(MACHINE_FUNCTION_NAMES.alarmsAcknowledge, alarmId);
  }

  clearAlarm(alarmId: bigint): Promise<number> {
    return this.alarmMutation(MACHINE_FUNCTION_NAMES.alarmsClear, alarmId);
  }

  // ---- Capture ------------------------------------------------------------

  /** Whether the server advertises the capture service. */
  get captureAvailable(): boolean {
    return (
      this.ids.has(MACHINE_FUNCTION_NAMES.captureConfigure) &&
      this.ids.has(MACHINE_FUNCTION_NAMES.captureStatus)
    );
  }

  /**
   * Configure server-side recording. Recorded bytes stay on the server;
   * the returned status carries counters and layout metadata only.
   * `entryIds` empty = all fixed-size entries.
   */
  configureCapture(
    logName: string,
    sampleRateHz: number,
    enabled: boolean,
    entryIds: bigint[],
    trigger?: CaptureTriggerSpec,
    template?: number,
  ): Promise<CaptureStatusView> {
    const args: { key: number; value: Uint8Array }[] = [
      { key: 1, value: fieldString(logName) },
      { key: 2, value: fieldScalar(sampleRateHz, 4) },
      { key: 3, value: fieldBool(enabled) },
      { key: 4, value: encodeTaggedArray(entryIds.map((id) => fieldScalar(id, 8))) },
    ];
    if (trigger) {
      const level = new Uint8Array(8);
      new DataView(level.buffer).setFloat64(0, trigger.level, true);
      args.push(
        { key: 5, value: fieldScalar(trigger.entryId, 8) },
        { key: 6, value: fieldScalar(trigger.op, 1) },
        { key: 7, value: level },
        { key: 8, value: fieldScalar(trigger.preRecords, 4) },
        { key: 9, value: fieldScalar(trigger.postRecords, 4) },
      );
    } else if (template !== undefined) {
      args.push(
        { key: 5, value: fieldScalar(0n, 8) },
        { key: 6, value: fieldScalar(0, 1) },
        { key: 7, value: new Uint8Array(8) },
        { key: 8, value: fieldScalar(0, 4) },
        { key: 9, value: fieldScalar(0, 4) },
      );
    }
    if (template !== undefined) args.push({ key: 10, value: fieldScalar(template, 1) });
    return this.invokeStruct(MACHINE_FUNCTION_NAMES.captureConfigure, args).then(
      decodeCaptureStatus,
    );
  }

  captureStatus(): Promise<CaptureStatusView> {
    return this.invokeStruct(MACHINE_FUNCTION_NAMES.captureStatus, []).then(decodeCaptureStatus);
  }

  /** Stop recording and discard retained records (technician role). */
  captureCancel(): Promise<CaptureStatusView> {
    return this.invokeStruct(MACHINE_FUNCTION_NAMES.captureCancel, []).then(decodeCaptureStatus);
  }

  /**
   * Export one bounded chunk of retained records (technician role, audited
   * server-side per call). Paginate via `offset` until `totalRecords` is
   * reached; `maxBytes` is hard-capped at 64 KiB on the server.
   */
  captureExport(offset: bigint, maxBytes = 65536): Promise<CaptureExportChunkView> {
    return this.invokeStruct(MACHINE_FUNCTION_NAMES.captureExport, [
      { key: 1, value: fieldScalar(offset, 8) },
      { key: 2, value: fieldScalar(maxBytes, 4) },
    ]).then(decodeCaptureExport);
  }

  // ---- Staged configuration ------------------------------------------------

  /** Whether the server advertises staged configuration transactions. */
  get configAvailable(): boolean {
    return (
      this.ids.has(MACHINE_FUNCTION_NAMES.configStage) &&
      this.ids.has(MACHINE_FUNCTION_NAMES.configCommit) &&
      this.ids.has(MACHINE_FUNCTION_NAMES.configStatus)
    );
  }

  /**
   * Stage parameter writes — nothing is applied until validate + commit.
   * `value` is the raw little-endian parameter bytes.
   */
  async stageConfig(entries: ConfigEntryView[]): Promise<ConfigStatusView> {
    if (entries.length === 0 || entries.length > 256)
      throw new Error('a staged transaction must contain 1-256 entries');
    const elements = entries.map((entry) =>
      encodeTagged([
        [1, fieldScalar(entry.entryId, 8)],
        [2, fieldBytes(entry.value)],
      ]),
    );
    return this.invokeStruct(MACHINE_FUNCTION_NAMES.configStage, [
      { key: 1, value: encodeTaggedArray(elements) },
    ]).then(decodeConfigStatus);
  }

  validateConfig(): Promise<ConfigStatusView> {
    return this.invokeStruct(MACHINE_FUNCTION_NAMES.configValidate, []).then(decodeConfigStatus);
  }

  /** Commit requires an authenticated technician-or-higher role on the server. */
  commitConfig(): Promise<ConfigStatusView> {
    return this.invokeStruct(MACHINE_FUNCTION_NAMES.configCommit, []).then(decodeConfigStatus);
  }

  rollbackConfig(): Promise<ConfigStatusView> {
    return this.invokeStruct(MACHINE_FUNCTION_NAMES.configRollback, []).then(decodeConfigStatus);
  }

  configStatus(): Promise<ConfigStatusView> {
    return this.invokeStruct(MACHINE_FUNCTION_NAMES.configStatus, []).then(decodeConfigStatus);
  }

  // ---- SDO inspection (optional surface) ------------------------------------

  /** Whether the server plugged in an IMachineSdoAccess backend. */
  get sdoAvailable(): boolean {
    return (
      this.ids.has(MACHINE_FUNCTION_NAMES.sdoList) &&
      this.ids.has(MACHINE_FUNCTION_NAMES.sdoRead) &&
      this.ids.has(MACHINE_FUNCTION_NAMES.sdoWrite)
    );
  }

  /** Known object-dictionary entries for a slave (may be empty — transfers
   *  by explicit index still work). */
  sdoList(slave: number): Promise<SdoEntryView[]> {
    return this.invokeStruct(MACHINE_FUNCTION_NAMES.sdoList, [
      { key: 1, value: fieldScalar(slave, 2) },
    ]).then((bytes) => decodeTaggedArray(bytes).map(decodeSdoEntry));
  }

  sdoRead(slave: number, index: number, subindex: number, maxBytes = 256): Promise<SdoResultView> {
    const request = encodeTagged([
      [1, fieldScalar(slave, 2)],
      [2, fieldScalar(index, 2)],
      [3, fieldScalar(subindex, 1)],
      [4, fieldScalar(maxBytes, 2)],
    ]);
    return this.invokeStruct(MACHINE_FUNCTION_NAMES.sdoRead, [{ key: 1, value: request }]).then(
      decodeSdoResult,
    );
  }

  /**
   * Requires technician role server-side; the write is journaled,
   * rate-limited (one per 50 ms server-wide), and followed by a
   * verification read unless `verifyReadback` is false.
   */
  sdoWrite(
    slave: number,
    index: number,
    subindex: number,
    data: Uint8Array,
    verifyReadback = true,
  ): Promise<SdoResultView> {
    const request = encodeTagged([
      [1, fieldScalar(slave, 2)],
      [2, fieldScalar(index, 2)],
      [3, fieldScalar(subindex, 1)],
      [4, fieldBytes(data)],
      [5, fieldScalar(verifyReadback ? 1 : 0, 1)],
    ]);
    return this.invokeStruct(MACHINE_FUNCTION_NAMES.sdoWrite, [{ key: 1, value: request }]).then(
      decodeSdoResult,
    );
  }

  // ---- Config baseline export/diff/import + commissioning checklist --------

  /** Whether the extended config surface (export/diff/import) is present. */
  get configBaselineAvailable(): boolean {
    return (
      this.ids.has(MACHINE_FUNCTION_NAMES.configExport) &&
      this.ids.has(MACHINE_FUNCTION_NAMES.configDiff) &&
      this.ids.has(MACHINE_FUNCTION_NAMES.configImport)
    );
  }

  /** Whether the commissioning checklist surface is present. */
  get checklistAvailable(): boolean {
    return (
      this.ids.has(MACHINE_FUNCTION_NAMES.checklistList) &&
      this.ids.has(MACHINE_FUNCTION_NAMES.checklistReport)
    );
  }

  /** Live values of every writable parameter (observer+). */
  configExport(): Promise<ConfigExportView> {
    return this.invokeStruct(MACHINE_FUNCTION_NAMES.configExport, []).then(decodeConfigExport);
  }

  /** Mismatches between a submitted baseline and live values (observer+). */
  configDiff(baseline: ConfigEntryView[]): Promise<ConfigDiffView> {
    return this.invokeStruct(MACHINE_FUNCTION_NAMES.configDiff, [
      { key: 1, value: encodeConfigEntryArray(baseline) },
    ]).then(decodeConfigDiff);
  }

  /**
   * Import a baseline as a staged transaction (technician+, audited).
   * The transaction still requires validate + commit before anything applies.
   */
  configImport(entries: ConfigEntryView[]): Promise<ConfigStatusView> {
    return this.invokeStruct(MACHINE_FUNCTION_NAMES.configImport, [
      { key: 1, value: encodeConfigEntryArray(entries) },
    ]).then(decodeConfigStatus);
  }

  /** Evaluate every checklist item against live state (observer+). */
  checklistList(): Promise<ChecklistItemView[]> {
    return this.invokeStruct(MACHINE_FUNCTION_NAMES.checklistList, []).then((bytes) =>
      decodeTaggedArray(bytes).map(decodeChecklistItem),
    );
  }

  /**
   * Generate an audited acceptance report (technician+). Rejected by the
   * server while any required checklist item is failing.
   */
  checklistReport(): Promise<ChecklistReportView> {
    return this.invokeStruct(MACHINE_FUNCTION_NAMES.checklistReport, []).then(
      decodeChecklistReport,
    );
  }

  // ---- Recipes (optional; requires the staged-config service) --------------

  /** Whether machine.recipe.* is advertised. */
  get recipesAvailable(): boolean {
    return (
      this.ids.has(MACHINE_FUNCTION_NAMES.recipeList) &&
      this.ids.has(MACHINE_FUNCTION_NAMES.recipeApply)
    );
  }

  /** Named parameter sets the server offers (observer+). */
  recipeList(): Promise<RecipeInfoView[]> {
    return this.invokeStruct(MACHINE_FUNCTION_NAMES.recipeList, []).then((bytes) =>
      decodeTaggedArray(bytes).map(decodeRecipeInfo),
    );
  }

  /**
   * Stage a recipe as a configuration transaction (technician+, audited).
   * Returns the transaction status — validate + commit remain separate steps.
   */
  recipeApply(name: string): Promise<ConfigStatusView> {
    return this.invokeStruct(MACHINE_FUNCTION_NAMES.recipeApply, [
      { key: 1, value: fieldString(name) },
    ]).then(decodeConfigStatus);
  }

  // ---- PDO map + supervisor (optional surfaces) ----------------------------

  /** Whether the server plugged in an IMachinePdoSource backend. */
  get pdoMapAvailable(): boolean {
    return this.ids.has(MACHINE_FUNCTION_NAMES.pdoMap);
  }

  /** Whether the server plugged in an IMachineSupervisorAccess backend. */
  get supervisorAvailable(): boolean {
    return (
      this.ids.has(MACHINE_FUNCTION_NAMES.supervisorStatus) &&
      this.ids.has(MACHINE_FUNCTION_NAMES.supervisorRetry)
    );
  }

  /** Logical-address placement of every enabled PDO entry (observer+). */
  pdoMap(): Promise<PdoEntryView[]> {
    return this.invokeStruct(MACHINE_FUNCTION_NAMES.pdoMap, []).then((bytes) =>
      decodeTaggedArray(bytes).map(decodePdoEntry),
    );
  }

  /** Per-slave recovery state (observer+). Diagnostic only — not a protective
   *  channel; suspended/recovering reflect the supervisor, not safety HW. */
  supervisorStatus(): Promise<SupervisorEntryView[]> {
    return this.invokeStruct(MACHINE_FUNCTION_NAMES.supervisorStatus, []).then((bytes) =>
      decodeTaggedArray(bytes).map(decodeSupervisorEntry),
    );
  }

  /**
   * Controlled retry of a failed/critical slave. Technician+ only,
   * audited, server-side rate-limited to one retry per second.
   */
  supervisorRetry(slave: number): Promise<SupervisorResultView> {
    return this.invokeStruct(MACHINE_FUNCTION_NAMES.supervisorRetry, [
      { key: 1, value: fieldScalar(slave, 2) },
    ]).then(decodeSupervisorResult);
  }

  private async alarmMutation(name: string, alarmId: bigint): Promise<number> {
    const bytes = await this.client.callFunctionOrThrow(this.functionId(name), [
      { key: 1, value: fieldScalar(alarmId, 8) },
    ]);
    // Return value is a bare fieldScalar(u8 status), not a tagged struct.
    if (bytes.length !== 1 || bytes[0]! > 2) throw new Error('invalid alarm status response');
    return bytes[0]!;
  }

  private async invokeStruct(
    name: string,
    args: { key: number; value: Uint8Array }[],
  ): Promise<Uint8Array> {
    return this.client.callFunctionOrThrow(this.functionId(name), args);
  }
}
