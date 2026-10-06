import { describe, expect, it } from 'vitest';
import { CatalogEntry, FunctionEntry } from '../protocol';
import {
  EVENT_PAGE_ROOT,
  decodeEventPage,
  discoverEventService,
  eventSeverityLabel,
} from './event-history';

const catalog = { epoch: 1, slotToNode: [{ name: 'unused' }, { name: EVENT_PAGE_ROOT }] } as never;
const signal: CatalogEntry = {
  id: 9n, schemaEpoch: 1n, schemaSlot: 0, flags: 1,
  name: 'machine.events.cursor', description: '', group: '', kind: 'signal',
};
const readFunction: FunctionEntry = {
  id: 10n, name: 'machine.events.read', description: '', group: '',
  parameters: [
    { key: 1, name: 'after_cursor', description: '', schemaSlot: 0, flags: 0, metadata: {} },
    { key: 2, name: 'limit', description: '', schemaSlot: 0, flags: 0, metadata: {} },
  ],
  returnPresent: true, returnSchemaSlot: 1, metadata: {},
};

const validPage = {
  oldest_cursor: 4n,
  latest_cursor: 5n,
  next_cursor: 5n,
  gap: true,
  events: [{
    event_id: 5n,
    timestamp_us: 1000n,
    state_generation: 8n,
    event_type: 'UnrecognizedFutureEvent',
    source_id: 'axis-x',
    severity: 2n,
    code: 42,
    description: 'A future profile event',
  }],
};

describe('machine event history', () => {
  it('discovers only the complete typed cursor/read service', () => {
    expect(discoverEventService(catalog, [signal], [readFunction]).available).toBe(true);
    expect(discoverEventService(catalog, [], [readFunction]).available).toBe(false);
    expect(discoverEventService(catalog, [signal], [{ ...readFunction, returnSchemaSlot: 0 }]).available).toBe(false);
  });

  it('decodes unknown event types without discarding data', () => {
    const page = decodeEventPage(validPage);
    expect(page.events[0]?.eventType).toBe('UnrecognizedFutureEvent');
    expect(page.events[0]?.eventId).toBe(5n);
    expect(page.gap).toBe(true);
    expect(eventSeverityLabel(page.events[0]!.severity)).toBe('Fault');
  });

  it('rejects unordered events and inconsistent cursors', () => {
    expect(() => decodeEventPage({ ...validPage, next_cursor: 4n })).toThrow(/next_cursor/);
    expect(() => decodeEventPage({ ...validPage, events: [
      { ...validPage.events[0]!, event_id: 5n },
      { ...validPage.events[0]!, event_id: 5n },
    ], next_cursor: 5n })).toThrow(/strictly ordered/);
    expect(() => decodeEventPage({ ...validPage, events: [{ ...validPage.events[0]!, severity: 9 }] })).toThrow(/severity/);
  });
});
