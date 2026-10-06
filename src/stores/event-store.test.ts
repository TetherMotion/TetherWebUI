import { describe, expect, it } from 'vitest';
import { MachineEventPage } from '../domain/event-history';
import { EventStore } from './event-store';

function page(ids: bigint[], options: Partial<MachineEventPage> = {}): MachineEventPage {
  return {
    oldestCursor: ids[0] ?? 0n,
    latestCursor: ids.at(-1) ?? 0n,
    nextCursor: ids.at(-1) ?? 0n,
    gap: false,
    events: ids.map((eventId) => ({
      eventId, timestampUs: eventId * 100n, stateGeneration: eventId,
      eventType: 'StateChanged', sourceId: 'axis-x', severity: 0, code: 0, description: 'test',
    })),
    ...options,
  };
}

describe('EventStore', () => {
  it('merges pages by cursor and remains bounded', () => {
    const store = new EventStore(3);
    store.apply(page([1n, 2n]));
    store.apply(page([2n, 3n, 4n]));
    expect(store.events.map((event) => event.eventId)).toEqual([2n, 3n, 4n]);
    expect(store.cursor).toBe(4n);
    expect(store.gapDetected).toBe(false);
  });

  it('records retention gaps and server cursor resets', () => {
    const store = new EventStore();
    store.apply(page([1n, 2n]));
    store.apply(page([10n], { oldestCursor: 10n, latestCursor: 12n, nextCursor: 10n, gap: true }));
    expect(store.gapDetected).toBe(true);
    expect(store.events.at(-1)?.eventId).toBe(10n);
    store.apply(page([], { oldestCursor: 0n, latestCursor: 1n, nextCursor: 1n }));
    expect(store.gapDetected).toBe(true);
    expect(store.events).toEqual([]);
    expect(store.cursor).toBe(1n);
  });

  it('resets cursor and gap state explicitly', () => {
    const store = new EventStore();
    store.apply(page([1n], { gap: true }));
    store.reset();
    expect(store.cursor).toBe(0n);
    expect(store.gapDetected).toBe(false);
    expect(store.events).toEqual([]);
  });
});
