/** Shared plot configuration and pure formatting/color helpers. */
export interface ChannelInfo {
  name: string;
  color: [number, number, number];
}

export const WINDOW_SEC = 5.0;
export const MAX_SAMPLE_RATE = 1000;
export const WINDOW_SAMPLES = MAX_SAMPLE_RATE * WINDOW_SEC;
export const BUFFER_PADDING = 100;
export const BUFFER_SAMPLES = WINDOW_SAMPLES + BUFFER_PADDING;
export const MSAA_SAMPLE_COUNTS = [1, 2, 4, 8, 16];
export const TARGET_MSAA = 4;
export const MARGIN_LEFT = 64;
export const MARGIN_RIGHT = 100;
export const MARGIN_TOP = 16;
export const MARGIN_BOTTOM = 48;
export const MAX_CHANNELS = 16;
export const DEFAULT_COLORS: [number, number, number][] = [
  [0.0, 0.45, 0.75], [0.85, 0.33, 0.1], [0.0, 0.62, 0.45], [0.8, 0.1, 0.2],
  [0.58, 0.4, 0.74], [0.91, 0.59, 0.09], [0.75, 0.31, 0.5], [0.4, 0.4, 0.4],
  [0.0, 0.0, 0.0], [0.2, 0.6, 0.8], [0.55, 0.23, 0.12], [0.34, 0.71, 0.91],
  [0.62, 0.85, 0.34], [0.89, 0.47, 0.76], [0.5, 0.5, 0.0], [0.0, 0.5, 0.5],
];

export function niceStep(range: number, targetCount: number): number {
  const raw = range / targetCount;
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const normalized = raw / magnitude;
  let step: number;
  if (normalized <= 1.5) step = 1;
  else if (normalized <= 3) step = 2;
  else if (normalized <= 7) step = 5;
  else step = 10;
  return step * magnitude;
}

export function formatTick(value: number): string {
  const absolute = Math.abs(value);
  if (absolute === 0) return '0';
  if (absolute >= 1000 || absolute < 1e-3) return value.toExponential(1);
  let formatted = value.toFixed(3);
  while (formatted.endsWith('0')) formatted = formatted.slice(0, -1);
  if (formatted.endsWith('.')) formatted = formatted.slice(0, -1);
  return formatted;
}

export function dimColor(color: [number, number, number], factor: number): [number, number, number] {
  if (factor <= 0) return color;
  const background = 0.97;
  const gray = 0.299 * color[0] + 0.587 * color[1] + 0.114 * color[2];
  const desaturated = color.map((channel) => 0.5 * channel + 0.5 * gray) as [number, number, number];
  return desaturated.map((channel) => channel + (background - channel) * factor) as [number, number, number];
}

export function legendChannelAtPoint(
  mouseX: number,
  mouseY: number,
  cssWidth: number,
  channelCount: number,
): number | null {
  const plotWidth = cssWidth - MARGIN_LEFT - MARGIN_RIGHT;
  const legendX = MARGIN_LEFT + plotWidth + 8;
  const legendY = MARGIN_TOP + 4;
  const itemWidth = 96;
  for (let index = 0; index < channelCount; index += 1) {
    const rowY = legendY + index * 18;
    if (mouseX >= legendX - 4 && mouseX <= legendX + itemWidth && mouseY >= rowY - 9 && mouseY <= rowY + 9) {
      return index;
    }
  }
  return null;
}

export function finiteValueRange(
  rows: Array<{ values: number[] }>,
  channelCount: number,
): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const row of rows) {
    for (const value of row.values.slice(0, channelCount)) {
      if (!Number.isFinite(value)) continue;
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  }
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
}
