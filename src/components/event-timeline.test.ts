import { describe, expect, it } from 'vitest';
import { TetherEventTimeline } from './event-timeline';

const event = (eventId: bigint, eventType: string) => ({
  eventId, timestampUs: eventId * 1000n, stateGeneration: eventId,
  eventType, sourceId: 'sim-axis-x', severity: 2 as const, code: 42,
  description: '<script>text stays inert</script>',
});

describe('TetherEventTimeline', () => {
  it('renders newest events first with inert text and severity labels', () => {
    const timeline = new TetherEventTimeline();
    timeline.model = { events: [event(1n, 'FaultSet'), event(2n, 'DriveStateChanged')], gapDetected: false, available: true };
    expect(timeline.querySelector('ol')?.firstElementChild?.textContent).toContain('DriveStateChanged');
    expect(timeline.textContent).toContain('<script>text stays inert</script>');
    expect(timeline.querySelector('script')).toBeNull();
    expect(timeline.textContent).toContain('Fault');
  });

  it('shows retention gaps and distinguishes unavailable service', () => {
    const timeline = new TetherEventTimeline();
    timeline.model = { events: [], gapDetected: true, available: true };
    expect(timeline.textContent).toContain('Event history gap detected');
    expect(timeline.textContent).toContain('No retained events');
    timeline.model = { events: [], gapDetected: false, available: false };
    expect(timeline.textContent).toContain('does not advertise typed event history');
  });
});
