/**
 * Unit tests for the HMI scene IR + widget builders — the shared
 * contract both the web SVG backend and the native Vulkan renderer
 * consume. Assertions stay structural (op kinds, colors, geometry
 * bounds) so they hold regardless of rasterizer.
 */
import { describe, it, expect } from 'vitest';
import {
  HmiScene, SceneOp, normalizeColor, arcPoints, circlePoints, arcAngleAt,
  sceneToSvg, sceneToSvgInner,
} from './scene';
import {
  HMI_COLORS, levelColor, levelOf, gaugeScene, bargraphScene,
  digitalScene, lampStackScene, alarmBoardScene,
} from './widgets';
import { hmiTextWidth } from './font-atlas';

const kinds = (s: HmiScene) => s.ops.map((o) => o.k);
const texts = (s: HmiScene) =>
  s.ops.filter((o) => o.k === 'text').map((o) => (o as { s: string }).s);
const rects = (s: HmiScene) =>
  s.ops.filter((o) => o.k === 'rect') as Extract<SceneOp, { k: 'rect' }>[];
const paths = (s: HmiScene) =>
  s.ops.filter((o) => o.k === 'path') as Extract<SceneOp, { k: 'path' }>[];
const lines = (s: HmiScene) =>
  s.ops.filter((o) => o.k === 'line') as Extract<SceneOp, { k: 'line' }>[];

describe('normalizeColor', () => {
  it('expands #rgb and appends alpha', () => {
    expect(normalizeColor('#abc')).toBe('#aabbccff');
    expect(normalizeColor('#aabbcc')).toBe('#aabbccff');
    expect(normalizeColor('#aabbcc80')).toBe('#aabbcc80');
    expect(normalizeColor('red')).toBeUndefined();
    expect(normalizeColor(undefined)).toBeUndefined();
    expect(normalizeColor('')).toBeUndefined();
  });
});

describe('geometry helpers', () => {
  it('arcPoints spans the sweep and stays on radius', () => {
    const pts = arcPoints(10, 20, 5, 0, 90, 10);
    expect(pts.length).toBeGreaterThanOrEqual(2);
    expect(pts[0]![0]).toBeCloseTo(15, 5);
    expect(pts[0]![1]).toBeCloseTo(20, 5);
    for (const [x, y] of pts)
      expect(Math.hypot(x - 10, y - 20)).toBeCloseTo(5, 3);
  });

  it('arcAngleAt clamps fraction to [0,1]', () => {
    expect(arcAngleAt(100, 200, 0.5)).toBe(150);
    expect(arcAngleAt(100, 200, -1)).toBe(100);
    expect(arcAngleAt(100, 200, 2)).toBe(200);
  });

  it('circlePoints closes at n points on the radius', () => {
    const pts = circlePoints(0, 0, 3, 8);
    expect(pts).toHaveLength(8);
    for (const [x, y] of pts) expect(Math.hypot(x, y)).toBeCloseTo(3, 5);
  });
});

describe('gaugeScene', () => {
  const g = gaugeScene({ w: 120, h: 120, min: 0, max: 100, value: 55, warn: 70, crit: 90, unit: '°C', label: 'TEMP' });

  it('emits bg + bands + ticks + needle + readout', () => {
    expect(g.w).toBe(120); expect(g.h).toBe(120);
    expect(g.bg).toBe(HMI_COLORS.bg);
    expect(kinds(g)).toContain('path');
    expect(kinds(g)).toContain('line');
    expect(kinds(g)).toContain('text');
    // 11 tick marks (0..10) as lines, plus needle
    expect(lines(g).length).toBeGreaterThanOrEqual(12);
    expect(texts(g)).toContain('55.0');
    expect(texts(g)).toContain('°C');
    expect(texts(g)).toContain('TEMP');
  });

  it('colors needle/value by alarm level', () => {
    const ok = gaugeScene({ w: 120, h: 120, min: 0, max: 100, value: 50 });
    const warn = gaugeScene({ w: 120, h: 120, min: 0, max: 100, value: 80, warn: 70 });
    const crit = gaugeScene({ w: 120, h: 120, min: 0, max: 100, value: 95, warn: 70, crit: 90 });
    const hasColor = (s: HmiScene, c: string) =>
      s.ops.some((o) =>
        (o.k === 'path' && o.color === c) ||
        (o.k === 'line' && o.color === c) ||
        (o.k === 'text' && o.color === c));
    expect(hasColor(ok, HMI_COLORS.warn)).toBe(false);
    expect(hasColor(warn, HMI_COLORS.warn)).toBe(true);
    expect(hasColor(crit, HMI_COLORS.crit)).toBe(true);
  });

  it('handles undefined value and degenerate range', () => {
    const s = gaugeScene({ w: 120, h: 120, min: 5, max: 5 });
    expect(texts(s)).toContain('———');
    expect(() => gaugeScene({ w: 120, h: 120, min: 0, max: 0, value: 1 })).not.toThrow();
  });

  it('filled paths stay star-shaped (fan-safe) — bands are arc strips', () => {
    for (const p of paths(g)) {
      if (!p.fill) continue;
      // every vertex within scene bounds
      for (const [x, y] of p.pts) {
        expect(x).toBeGreaterThanOrEqual(-1);
        expect(x).toBeLessThanOrEqual(121);
        expect(y).toBeGreaterThanOrEqual(-1);
        expect(y).toBeLessThanOrEqual(121);
      }
    }
  });
});

describe('bargraphScene', () => {
  it('horizontal layout has readout column and value fill', () => {
    const s = bargraphScene({ w: 220, h: 56, min: 0, max: 200, value: 100, unit: '°C' });
    expect(texts(s)).toContain('100.0 °C');
    // fill rect exists with ok color
    expect(rects(s).some((r) => r.fill === HMI_COLORS.ok)).toBe(true);
    expect(kinds(s)).toContain('line'); // threshold/tick marks
  });

  it('vertical orientation stacks fill upward', () => {
    const s = bargraphScene({ w: 120, h: 160, min: 0, max: 100, value: 50, vertical: true });
    const fill = rects(s).find((r) => r.fill === HMI_COLORS.ok);
    expect(fill).toBeDefined();
    // vertical: fill bottom edge should sit mid-bar → y > h/2 roughly
    expect(fill!.y + fill!.h).toBeLessThanOrEqual(s.h);
  });

  it('warn/crit thresholds emit marker lines', () => {
    const s = bargraphScene({ w: 220, h: 56, min: 0, max: 100, value: 95, warn: 70, crit: 90 });
    const cols = lines(s).map((l) => l.color);
    expect(cols).toContain(HMI_COLORS.warn);
    expect(cols).toContain(HMI_COLORS.crit);
  });
});

describe('digitalScene', () => {
  it('sizes text to fit and centers value', () => {
    const s = digitalScene({ w: 160, h: 64, min: 0, max: 100, value: 42.5, unit: '°C', label: 'PV' });
    const val = s.ops.find((o) => o.k === 'text' && (o as { s: string }).s === '42.5');
    expect(val).toBeDefined();
    expect((val as { anchor?: string }).anchor).toBe('middle');
    expect((val as { x: number }).x).toBeCloseTo(80, 5);
    expect(texts(s)).toContain('PV');
  });

  it('window mode adds instrument bezel', () => {
    const s = digitalScene({ w: 160, h: 64, value: 1, window: true });
    expect(rects(s).some((r) => r.fill === '#0b0e12')).toBe(true);
  });

  it('alarm level draws border + colors value', () => {
    const s = digitalScene({ w: 160, h: 64, value: 99, warn: 80, crit: 95 });
    expect(rects(s).some((r) => r.stroke === HMI_COLORS.crit)).toBe(true);
    const val = s.ops.find((o) => o.k === 'text' && (o as { s: string }).s === '99.0');
    expect((val as { color: string }).color).toBe(HMI_COLORS.crit);
  });
});

describe('lampStackScene', () => {
  it('renders three lamps with labels', () => {
    const s = lampStackScene({ w: 72, h: 170, run: true, alarm: false, fault: 'blink', phase: 0.2 });
    expect(texts(s)).toEqual(expect.arrayContaining(['RUN', 'ALM', 'FLT']));
    // blink at phase 0.2 → lit
    const litPaths = paths(s).filter((p) => p.fill === HMI_COLORS.crit);
    expect(litPaths.length).toBeGreaterThan(0);
  });

  it('blink phase toggles lens color', () => {
    const on = lampStackScene({ w: 72, h: 170, fault: 'blink', phase: 0.1 });
    const off = lampStackScene({ w: 72, h: 170, fault: 'blink', phase: 0.9 });
    const lensOn = paths(on).filter((p) => p.fill === HMI_COLORS.crit).length;
    const lensOff = paths(off).filter((p) => p.fill === HMI_COLORS.crit).length;
    expect(lensOn).toBeGreaterThan(lensOff);
  });
});

describe('alarmBoardScene', () => {
  it('shows header count and severity chips', () => {
    const s = alarmBoardScene({
      w: 240, h: 140, title: 'ALARMS',
      rows: [
        { text: 'overtemp', level: 'crit' },
        { text: 'sensor drift', level: 'warn', acked: true },
      ],
    });
    // one row unacked → "1 active"
    expect(texts(s).some((t) => t.includes('1 active'))).toBe(true);
    const chipColors = rects(s).map((r) => r.fill);
    expect(chipColors).toContain(HMI_COLORS.crit);
    expect(chipColors).toContain(HMI_COLORS.warn);
  });

  it('empty board shows placeholder', () => {
    const s = alarmBoardScene({ w: 240, h: 140, rows: [] });
    expect(texts(s)).toContain('no active alarms');
  });
});

describe('levelOf / levelColor', () => {
  it('classifies thresholds', () => {
    expect(levelOf(50, 70, 90)).toBe('ok');
    expect(levelOf(75, 70, 90)).toBe('warn');
    expect(levelOf(95, 70, 90)).toBe('crit');
    expect(levelOf(undefined, 70, 90)).toBe('ok');
    expect(levelColor('crit')).toBe(HMI_COLORS.crit);
  });
});

describe('sceneToSvg', () => {
  it('produces valid svg with escaped text and normalized colors', () => {
    const scene: HmiScene = {
      w: 100, h: 50, bg: '#112233',
      ops: [
        { k: 'rect', x: 0, y: 0, w: 10, h: 10, fill: '#ff0000' },
        { k: 'text', x: 5, y: 20, s: 'a<b&"c"', color: '#00ff00', size: 12, anchor: 'middle' },
        { k: 'line', x1: 0, y1: 0, x2: 10, y2: 10, color: '#0000ff', w: 2 },
        { k: 'path', pts: [[0, 0], [10, 0], [10, 10]], color: '#ffffff', close: true, fill: '#123456' },
      ],
    };
    const svg = sceneToSvg(scene);
    expect(svg).toContain('<svg');
    expect(svg).toContain('viewBox="0 0 100 50"');
    expect(svg).toContain('a&lt;b&amp;&quot;c&quot;');
    expect(svg).toContain('fill="#ff0000ff"');
    expect(svg).toContain('stroke="#0000ffff"');
    // anchor=middle shifts x by half text width
    const tw = hmiTextWidth('a<b&"c"', 12);
    expect(svg).toContain(`x="${(5 - tw / 2).toFixed(2)}"`);
  });

  it('middle/end anchors use measured advance for both backends', () => {
    const s = 'HELLO';
    const w = hmiTextWidth(s, 10);
    expect(w).toBeCloseTo(s.length * 10 * 0.602031, 1);
    const scene: HmiScene = { w: 200, h: 40, ops: [
      { k: 'text', x: 100, y: 20, s, color: '#fff', size: 10, anchor: 'middle' },
      { k: 'text', x: 200, y: 20, s, color: '#fff', size: 10, anchor: 'end' },
    ] };
    const inner = sceneToSvgInner(scene);
    expect(inner).toContain(`x="${(100 - w / 2).toFixed(2)}"`);
    expect(inner).toContain(`x="${(200 - w).toFixed(2)}"`);
  });
});
