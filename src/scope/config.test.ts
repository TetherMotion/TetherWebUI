import { describe, expect, it } from 'vitest';
import { dimColor, finiteValueRange, formatTick, legendChannelAtPoint, niceStep } from './config';

describe('scope plotting helpers', () => {
  it('chooses readable 1-2-5 tick intervals', () => {
    expect(niceStep(10, 5)).toBe(2);
    expect(niceStep(12, 6)).toBe(2);
    expect(niceStep(60, 6)).toBe(10);
  });

  it('formats ticks without redundant zeros', () => {
    expect(formatTick(0)).toBe('0');
    expect(formatTick(1.25)).toBe('1.25');
    expect(formatTick(1200)).toBe('1.2e+3');
    expect(formatTick(0.0001)).toBe('1.0e-4');
  });

  it('desaturates colors toward the plot background', () => {
    const source: [number, number, number] = [0.2, 0.4, 0.8];
    expect(dimColor(source, 0)).toEqual(source);
    expect(dimColor(source, 1)).toEqual([0.97, 0.97, 0.97]);
  });

  it('maps pointer coordinates to legend rows', () => {
    expect(legendChannelAtPoint(710, 20, 800, 3)).toBe(0);
    expect(legendChannelAtPoint(710, 38, 800, 3)).toBe(1);
    expect(legendChannelAtPoint(20, 20, 800, 3)).toBeNull();
    expect(legendChannelAtPoint(710, 20, 800, 0)).toBeNull();
  });

  it('computes autoscale bounds from finite active-channel values', () => {
    expect(
      finiteValueRange(
        [{ values: [2, -4, 100] }, { values: [Number.NaN, 7, 200] }],
        2,
      ),
    ).toEqual({ min: -4, max: 7 });
    expect(finiteValueRange([{ values: [Number.NaN] }], 1)).toBeNull();
    expect(finiteValueRange([], 1)).toBeNull();
  });
});
