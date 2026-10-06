import { TetherIOClient } from '../client';
import { CatalogEntry, FunctionEntry, FunctionCallArg } from '../protocol';
import { SchemaCatalogV6, decodeSchemaValue } from '../schema-v6';

export const EVENT_PAGE_ROOT = 'tether.machine.cia402.EventPageV1';
export const EVENT_CURSOR_SIGNAL = 'machine.events.cursor';
export const EVENT_READ_FUNCTION = 'machine.events.read';

export interface EventServiceAvailability {
  cursorEntry?: CatalogEntry;
  readFunction?: FunctionEntry;
  returnSchemaSlot?: number;
  available: boolean;
}

export interface MachineEvent {
  eventId: bigint;
  timestampUs: bigint;
  stateGeneration: bigint;
  eventType: string;
  sourceId: string;
  severity: 0 | 1 | 2 | 3;
  code: number;
  description: string;
}

export interface MachineEventPage {
  oldestCursor: bigint;
  latestCursor: bigint;
  nextCursor: bigint;
  gap: boolean;
  events: MachineEvent[];
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} is not a structured value`);
  return value as Record<string, unknown>;
}

function bigIntField(value: Record<string, unknown>, key: string): bigint {
  const item = value[key];
  if (typeof item === 'bigint' && item >= 0n) return item;
  if (typeof item === 'number' && Number.isSafeInteger(item) && item >= 0) return BigInt(item);
  throw new Error(`Event profile field ${key} is invalid`);
}

function numberField(value: Record<string, unknown>, key: string): number {
  const item = value[key];
  if (typeof item === 'bigint' && item <= BigInt(Number.MAX_SAFE_INTEGER) && item >= BigInt(Number.MIN_SAFE_INTEGER)) return Number(item);
  if (typeof item === 'number' && Number.isFinite(item)) return item;
  throw new Error(`Event profile field ${key} is invalid`);
}

function stringField(value: Record<string, unknown>, key: string): string {
  const item = value[key];
  if (typeof item !== 'string') throw new Error(`Event profile field ${key} is invalid`);
  return item;
}

function u64Bytes(value: bigint): Uint8Array {
  if (value < 0n || value >= (1n << 64n)) throw new Error('Event cursor is outside the U64 range');
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

export function decodeEventPage(value: unknown): MachineEventPage {
  const page = record(value, 'EventPageV1');
  if (typeof page.gap !== 'boolean' || !Array.isArray(page.events)) throw new Error('EventPageV1 has invalid fields');
  const events = page.events.map((entry): MachineEvent => {
    const event = record(entry, 'EventRecordV1');
    const severity = numberField(event, 'severity');
    if (!Number.isInteger(severity) || severity < 0 || severity > 3) throw new Error('EventRecordV1 severity is unknown');
    const id = bigIntField(event, 'event_id');
    if (id === 0n) throw new Error('EventRecordV1 event_id must be nonzero');
    return {
      eventId: id,
      timestampUs: bigIntField(event, 'timestamp_us'),
      stateGeneration: bigIntField(event, 'state_generation'),
      eventType: stringField(event, 'event_type'),
      sourceId: stringField(event, 'source_id'),
      severity: severity as MachineEvent['severity'],
      code: numberField(event, 'code'),
      description: stringField(event, 'description'),
    };
  });
  const result: MachineEventPage = {
    oldestCursor: bigIntField(page, 'oldest_cursor'),
    latestCursor: bigIntField(page, 'latest_cursor'),
    nextCursor: bigIntField(page, 'next_cursor'),
    gap: page.gap,
    events,
  };
  if ((result.oldestCursor !== 0n && result.oldestCursor > result.latestCursor) || result.nextCursor > result.latestCursor) {
    throw new Error('EventPageV1 cursor bounds are inconsistent');
  }
  for (let index = 1; index < events.length; index += 1) {
    if (events[index]!.eventId <= events[index - 1]!.eventId) throw new Error('EventPageV1 events are not strictly ordered');
  }
  if (events.length && result.nextCursor !== events.at(-1)!.eventId) throw new Error('EventPageV1 next_cursor does not match its last event');
  return result;
}

export function discoverEventService(
  catalog: SchemaCatalogV6 | undefined,
  signals: CatalogEntry[],
  functions: FunctionEntry[],
): EventServiceAvailability {
  if (!catalog) return { available: false };
  const cursorEntry = signals.find((entry) => entry.name === EVENT_CURSOR_SIGNAL && entry.kind === 'signal' &&
    entry.schemaEpoch === BigInt(catalog.epoch));
  const readFunction = functions.find((entry) => entry.name === EVENT_READ_FUNCTION && entry.returnPresent);
  const returnSchemaSlot = readFunction?.returnSchemaSlot;
  const returnNode = returnSchemaSlot === undefined ? undefined : catalog.slotToNode[returnSchemaSlot];
  const validSignature = readFunction?.parameters.length === 2 &&
    readFunction.parameters[0]?.key === 1 && readFunction.parameters[1]?.key === 2 &&
    returnNode?.name === EVENT_PAGE_ROOT;
  const available = !!cursorEntry && !!readFunction && !!validSignature;
  return { cursorEntry, readFunction: available ? readFunction : undefined,
    returnSchemaSlot: available ? returnSchemaSlot : undefined, available };
}

export async function readEventCursor(client: TetherIOClient, catalog: SchemaCatalogV6, entry: CatalogEntry): Promise<bigint> {
  if (client.schemaCatalog !== catalog || entry.schemaEpoch !== BigInt(catalog.epoch)) {
    throw new Error('Event cursor belongs to a stale schema epoch');
  }
  const bytes = await client.get('signal', entry.id);
  if (client.schemaCatalog !== catalog) throw new Error('Schema catalog changed during event cursor read');
  if (bytes.length !== 8) throw new Error('Event cursor signal has an invalid size');
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true);
}

export async function readEventPage(
  client: TetherIOClient,
  catalog: SchemaCatalogV6,
  service: EventServiceAvailability,
  afterCursor: bigint,
  limit = 50,
): Promise<MachineEventPage> {
  const fn = service.readFunction;
  const slot = service.returnSchemaSlot;
  if (!service.available || !fn || slot === undefined) throw new Error('Typed event history is unavailable');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Event page limit must be between 1 and 100');
  const args: FunctionCallArg[] = [
    { key: 1, value: u64Bytes(afterCursor) },
    { key: 2, value: Uint8Array.from([limit & 0xff, (limit >>> 8) & 0xff, (limit >>> 16) & 0xff, (limit >>> 24) & 0xff]) },
  ];
  const bytes = await client.callFunctionOrThrow(fn.id, args);
  if (client.schemaCatalog !== catalog) throw new Error('Schema catalog changed during event page read');
  const value = decodeSchemaValue(catalog, slot, bytes);
  return decodeEventPage(value);
}

export const eventSeverityLabel = (severity: MachineEvent['severity']): string =>
  (['Info', 'Warning', 'Fault', 'Critical'] as const)[severity];
