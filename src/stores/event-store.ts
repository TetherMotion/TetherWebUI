import { MachineEvent, MachineEventPage } from '../domain/event-history';

/** Client-side bounded event cache with explicit retention/restart gap tracking. */
export class EventStore {
  private readonly capacity: number;
  private cursorValue = 0n;
  private gapValue = false;
  private eventsValue: MachineEvent[] = [];

  constructor(capacity = 200) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Event store capacity must be positive');
    this.capacity = capacity;
  }

  get cursor(): bigint { return this.cursorValue; }
  get gapDetected(): boolean { return this.gapValue; }
  get events(): readonly MachineEvent[] { return this.eventsValue; }

  apply(page: MachineEventPage): void {
    if (page.latestCursor < this.cursorValue && page.events.length === 0) {
      this.eventsValue = [];
      this.gapValue = true;
    }
    if (page.gap) this.gapValue = true;
    const byId = new Map(this.eventsValue.map((event) => [event.eventId, event]));
    for (const event of page.events) byId.set(event.eventId, event);
    this.eventsValue = [...byId.values()]
      .sort((left, right) => {
        if (left.eventId < right.eventId) return -1;
        if (left.eventId > right.eventId) return 1;
        return 0;
      })
      .slice(-this.capacity);
    this.cursorValue = page.nextCursor;
  }

  reset(): void {
    this.cursorValue = 0n;
    this.gapValue = false;
    this.eventsValue = [];
  }
}
