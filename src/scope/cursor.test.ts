import { describe, expect, it } from 'vitest';
import { describeCursor, describeDelta, nearestRowIndex } from './cursor';

const rows = [0, 1, 2, 3, 4].map((i) => ({ t: i * 0.5, values: [i * 10, -i] }));

describe('nearestRowIndex', () => {
  it('returns -1 for empty rows', () => {
    expect(nearestRowIndex([], 1.0)).toBe(-1);
  });

  it('finds the exact sample', () => {
    expect(nearestRowIndex(rows, 1.0)).toBe(2);
  });

  it('snaps to the closer sample', () => {
    expect(nearestRowIndex(rows, 1.1)).toBe(2);
    expect(nearestRowIndex(rows, 1.4)).toBe(3);
  });

  it('clamps to the first and last samples', () => {
    expect(nearestRowIndex(rows, -5)).toBe(0);
    expect(nearestRowIndex(rows, 99)).toBe(4);
  });
});

describe('describeCursor', () => {
  it('includes time and per-channel values', () => {
    const lines = describeCursor(rows[2]!, ['pos', 'vel']);
    expect(lines[0]).toBe('t = 1.000 s');
    expect(lines[1]).toBe('pos: 20');
    expect(lines[2]).toBe('vel: -2');
  });

  it('caps channels and notes the remainder', () => {
    const row = { t: 0, values: [1, 2, 3, 4, 5, 6, 7, 8] };
    const names = row.values.map((_, i) => `ch${i}`);
    const lines = describeCursor(row, names, 3);
    expect(lines).toHaveLength(5); // t + 3 channels + overflow note
    expect(lines.at(-1)).toBe('… +5 more');
  });
});

describe('describeDelta', () => {
  it('reports Δt in ms and per-channel deltas', () => {
    const lines = describeDelta(rows[0]!, rows[2]!, ['pos', 'vel']);
    expect(lines[0]).toBe('Δt = 1000.0 ms');
    expect(lines[1]).toBe('Δ pos: 20');
    expect(lines[2]).toBe('Δ vel: -2');
  });

  it('handles negative direction', () => {
    const lines = describeDelta(rows[3]!, rows[1]!, ['pos', 'vel']);
    expect(lines[0]).toBe('Δt = -1000.0 ms');
    expect(lines[1]).toBe('Δ pos: -20');
  });
});
