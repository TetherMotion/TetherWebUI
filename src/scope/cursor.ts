/**
 * @file cursor.ts
 * @brief Pure helpers for scope cursor/crosshair measurement.
 *
 * Sample rows arrive in ascending time order, so nearest-sample lookup is a
 * binary search.  All functions are pure and unit-testable without WebGPU.
 */

import { formatTick } from './config';

export interface TimedRow {
  /** Relative timestamp in seconds. */
  t: number;
  /** One numeric value per channel. */
  values: number[];
}

/** Index of the row nearest to `t`, or -1 when `rows` is empty. */
export function nearestRowIndex(rows: readonly TimedRow[], t: number): number {
  if (!rows.length) return -1;
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && t - rows[lo - 1]!.t < rows[lo]!.t - t) return lo - 1;
  return lo;
}

/**
 * Readout lines for a crosshair/pinned cursor at `row`.
 * Channel list is capped at `maxChannels` to bound the overlay box height.
 */
export function describeCursor(row: TimedRow, names: readonly string[], maxChannels = 6): string[] {
  const lines = [`t = ${row.t.toFixed(3)} s`];
  for (let ch = 0; ch < Math.min(row.values.length, names.length, maxChannels); ch++) {
    lines.push(`${names[ch]}: ${formatTick(row.values[ch]!)}`);
  }
  if (row.values.length > maxChannels) lines.push(`… +${row.values.length - maxChannels} more`);
  return lines;
}

/**
 * Delta readout between two pinned cursors: Δt plus per-channel Δv.
 * Rows with different channel counts compare index-wise over the shared
 * prefix; `names` supplies the channel labels.
 */
export function describeDelta(
  a: TimedRow,
  b: TimedRow,
  names: readonly string[],
  maxChannels = 6,
): string[] {
  const dtMs = (b.t - a.t) * 1000;
  const lines = [`Δt = ${dtMs.toFixed(1)} ms`];
  const count = Math.min(a.values.length, b.values.length, names.length, maxChannels);
  for (let ch = 0; ch < count; ch++) {
    lines.push(`Δ ${names[ch]}: ${formatTick(b.values[ch]! - a.values[ch]!)}`);
  }
  if (Math.min(a.values.length, b.values.length) > maxChannels) {
    lines.push(`… +${Math.min(a.values.length, b.values.length) - maxChannels} more`);
  }
  return lines;
}
