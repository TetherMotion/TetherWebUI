/**
 * Scene-native HMI widget builders — each produces an {@link HmiScene}
 * (the shared IR in ./scene.ts) that BOTH backends render:
 *
 *   - web:    sceneToSvg() → inline SVG in the tile
 *   - vulkan: examples/hmi_vulkan.cpp (Tether repo) parses the same
 *             JSON and rasterizes with glyb/FreeType+HarfBuzz text
 *
 * Builders are pure functions of resolved state + options so unit
 * tests can assert scene structure without a DOM or GPU. Keep every
 * shape within the IR contract: rect / line / path (star-shaped fills)
 * / text (baseline origin, anchor by hmiTextWidth).
 */
import {
  HmiScene, SceneOp, ScenePt, arcPoints, circlePoints, arcAngleAt,
} from './scene';

// ---------------------------------------------------------------------------
// shared palette — keep in sync with boards.css dark theme
// ---------------------------------------------------------------------------

export const HMI_COLORS = {
  bg: '#14181d',
  panel: '#1d242c',
  panelEdge: '#33404d',
  text: '#d7dee8',
  dim: '#8b98a5',
  ok: '#5fd07a',
  warn: '#ffb347',
  crit: '#ff5f56',
  info: '#6ab0ff',
  needle: '#e8eef5',
  track: '#2b3540',
} as const;

export type AlarmLevel = 'ok' | 'warn' | 'crit';

export function levelColor(level: AlarmLevel): string {
  return level === 'crit' ? HMI_COLORS.crit
       : level === 'warn' ? HMI_COLORS.warn
       : HMI_COLORS.ok;
}

/** Classify a value against optional warn/crit thresholds. */
export function levelOf(
  value: number | undefined,
  warn: number | undefined,
  crit: number | undefined,
): AlarmLevel {
  if (value === undefined) return 'ok';
  if (crit !== undefined && value >= crit) return 'crit';
  if (warn !== undefined && value >= warn) return 'warn';
  return 'ok';
}

function txt(
  x: number, y: number, s: string,
  color: string = HMI_COLORS.text, size = 11,
  anchor: 'start' | 'middle' | 'end' = 'start',
): SceneOp {
  return { k: 'text', x, y, s, color, size, anchor };
}

function rect(
  x: number, y: number, w: number, h: number,
  fill?: string, stroke?: string, sw = 1,
): SceneOp {
  return { k: 'rect', x, y, w, h, fill, stroke, sw };
}

function path(pts: ScenePt[], color: string, w = 1, close = false, fill?: string): SceneOp {
  return { k: 'path', pts, color, w, close, fill };
}

/** Filled circle as a polygon path (48-gon — same approximation the
 *  SVG backend draws natively as a path). */
function disc(cx: number, cy: number, r: number, fill: string): SceneOp {
  return path(circlePoints(cx, cy, r, 48), '#00000000', 0, true, fill);
}

function ring(cx: number, cy: number, r: number, color: string, w: number): SceneOp {
  return path(circlePoints(cx, cy, r, 48), color, w, true);
}

// ---------------------------------------------------------------------------
// gauge — circular process gauge with alarm bands, needle, readout
// ---------------------------------------------------------------------------

export interface GaugeOpts {
  w: number; h: number;
  label?: string;
  unit?: string;
  min: number; max: number;
  value?: number;
  warn?: number;   // >= warn → amber zone/needle
  crit?: number;   // >= crit → red zone/needle
  decimals?: number;
}

const GAUGE_A0 = 135;   // degrees — bottom-left
const GAUGE_A1 = 405;   // bottom-right (270° sweep through top)
const GAUGE_TICKS = 10;

export function gaugeScene(o: GaugeOpts): HmiScene {
  const ops: SceneOp[] = [];
  const w = o.w, h = o.h;
  ops.push(rect(0, 0, w, h, HMI_COLORS.bg));

  const cx = w / 2;
  const cy = h * 0.62;
  const rOut = Math.min(w * 0.44, h * 0.52);
  const rIn = rOut * 0.78;
  const rNeedle = rIn * 0.92;

  const fracOf = (v: number) =>
    o.max > o.min ? Math.min(1, Math.max(0, (v - o.min) / (o.max - o.min))) : 0;

  // colored alarm bands on the track (ok → warn → crit spans)
  const band = (f0: number, f1: number, color: string, width: number) => {
    const pts = arcPoints(cx, cy, rOut - width / 2,
      arcAngleAt(GAUGE_A0, GAUGE_A1, f0),
      arcAngleAt(GAUGE_A0, GAUGE_A1, f1), 2);
    ops.push(path(pts, color, width));
  };
  const warnF = o.warn !== undefined ? fracOf(o.warn) : 1;
  const critF = o.crit !== undefined ? fracOf(o.crit) : 1;
  band(0, Math.min(warnF, critF), HMI_COLORS.ok, rOut - rIn);
  if (warnF < 1)
    band(Math.min(warnF, critF), critF, HMI_COLORS.warn, rOut - rIn);
  if (critF < 1 && critF > warnF)
    band(critF, 1, HMI_COLORS.crit, rOut - rIn);
  else if (critF <= warnF && critF < 1)
    band(critF, warnF, HMI_COLORS.crit, rOut - rIn);

  // tick marks
  for (let i = 0; i <= GAUGE_TICKS; i++) {
    const f = i / GAUGE_TICKS;
    const a = (arcAngleAt(GAUGE_A0, GAUGE_A1, f) * Math.PI) / 180;
    const major = i % 5 === 0;
    const r1 = rOut + (major ? 4 : 2);
    const r2 = rOut + (major ? 9 : 6);
    ops.push({
      k: 'line',
      x1: cx + Math.cos(a) * r1, y1: cy + Math.sin(a) * r1,
      x2: cx + Math.cos(a) * r2, y2: cy + Math.sin(a) * r2,
      color: HMI_COLORS.dim, w: major ? 1.4 : 1,
    });
  }

  // value arc (thick colored sweep to current value)
  if (o.value !== undefined) {
    const f = fracOf(o.value);
    if (f > 0.001) {
      const lvl = levelOf(o.value, o.warn, o.crit);
      ops.push(path(
        arcPoints(cx, cy, (rOut + rIn) / 2,
          arcAngleAt(GAUGE_A0, GAUGE_A1, 0),
          arcAngleAt(GAUGE_A0, GAUGE_A1, f), 2),
        levelColor(lvl), rOut - rIn - 2));
    }
  }

  // needle
  if (o.value !== undefined) {
    const a = (arcAngleAt(GAUGE_A0, GAUGE_A1, fracOf(o.value)) * Math.PI) / 180;
    const lvl = levelOf(o.value, o.warn, o.crit);
    ops.push({
      k: 'line',
      x1: cx - Math.cos(a) * rNeedle * 0.18,
      y1: cy - Math.sin(a) * rNeedle * 0.18,
      x2: cx + Math.cos(a) * rNeedle,
      y2: cy + Math.sin(a) * rNeedle,
      color: lvl === 'ok' ? HMI_COLORS.needle : levelColor(lvl),
      w: Math.max(1.6, rOut * 0.035),
    });
  }
  ops.push(disc(cx, cy, rOut * 0.09, HMI_COLORS.panelEdge));
  ops.push(disc(cx, cy, rOut * 0.05, HMI_COLORS.text));

  // readout + scale labels
  const dec = o.decimals ?? 1;
  const valStr = o.value === undefined ? '———' : o.value.toFixed(dec);
  const lvl = levelOf(o.value, o.warn, o.crit);
  ops.push(txt(cx, cy - rOut * 0.34, valStr, levelColor(lvl),
    Math.max(12, rOut * 0.3), 'middle'));
  if (o.unit)
    ops.push(txt(cx, cy - rOut * 0.34 + Math.max(12, rOut * 0.3) * 0.9,
      o.unit, HMI_COLORS.dim, Math.max(8, rOut * 0.13), 'middle'));
  if (o.label)
    ops.push(txt(cx, h - 6, o.label, HMI_COLORS.dim,
      Math.max(8, rOut * 0.11), 'middle'));
  ops.push(txt(6, h - 6, fmtNum(o.min, dec), HMI_COLORS.dim, 8));
  ops.push(txt(w - 6, h - 6, fmtNum(o.max, dec), HMI_COLORS.dim, 8, 'end'));

  return { w, h, bg: HMI_COLORS.bg, ops };
}

// ---------------------------------------------------------------------------
// bargraph — horizontal process bar with scale, alarm bands, readout
// ---------------------------------------------------------------------------

export interface BarOpts {
  w: number; h: number;
  label?: string;
  unit?: string;
  min: number; max: number;
  value?: number;
  warn?: number; crit?: number;
  vertical?: boolean;
  decimals?: number;
}

export function bargraphScene(o: BarOpts): HmiScene {
  const ops: SceneOp[] = [];
  const w = o.w, h = o.h;
  ops.push(rect(0, 0, w, h, HMI_COLORS.bg));

  const vertical = o.vertical === true;
  const dec = o.decimals ?? 1;
  const fracOf = (v: number) =>
    o.max > o.min ? Math.min(1, Math.max(0, (v - o.min) / (o.max - o.min))) : 0;

  // geometry: bar area inset for labels
  const labelW = 34;           // readout column
  const labH = o.label ? 14 : 0;
  const bx = vertical ? 8 : 4;
  const by = labH + (vertical ? 4 : 8);
  const bw = vertical ? w - 16 : w - labelW - 10;
  const bh = vertical ? h - labH - 22 : h - labH - 16;

  // track
  ops.push(rect(bx, by, bw, bh, HMI_COLORS.track,
    HMI_COLORS.panelEdge, 1));

  // threshold marker lines (bands would need translucent fills — the
  // IR colors support alpha but both backends blend differently at
  // overlaps, so markers keep views identical)
  const warnF = o.warn !== undefined ? fracOf(o.warn) : 1;
  const critF = o.crit !== undefined ? fracOf(o.crit) : 1;
  const marker = (f: number, color: string) => {
    if (f <= 0 || f >= 1) return;
    if (vertical)
      ops.push({ k: 'line',
        x1: bx + bw * f, y1: by, x2: bx + bw * f, y2: by + bh,
        color, w: 1 });
    else
      ops.push({ k: 'line',
        x1: bx, y1: by + bh * (1 - f), x2: bx + bw, y2: by + bh * (1 - f),
        color, w: 1 });
  };
  marker(warnF, HMI_COLORS.warn);
  marker(critF, HMI_COLORS.crit);

  // fill
  if (o.value !== undefined) {
    const f = fracOf(o.value);
    const lvl = levelOf(o.value, o.warn, o.crit);
    const col = levelColor(lvl);
    if (vertical)
      ops.push(rect(bx, by + bh * (1 - f), bw, bh * f, col));
    else
      ops.push(rect(bx, by, bw * f, bh, col));
  }

  // scale ticks + labels
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const f = i / ticks;
    if (vertical) {
      const y = by + bh * (1 - f);
      ops.push({ k: 'line', x1: bx - 3, y1: y, x2: bx, y2: y,
                 color: HMI_COLORS.dim, w: 1 });
      if (i % 1 === 0)
        ops.push(txt(bx - 5, y + 3, fmtNum(o.min + (o.max - o.min) * f, 0),
          HMI_COLORS.dim, 7, 'end'));
    } else {
      const x = bx + bw * f;
      ops.push({ k: 'line', x1: x, y1: by + bh, x2: x, y2: by + bh + 3,
                 color: HMI_COLORS.dim, w: 1 });
      ops.push(txt(x, by + bh + 10, fmtNum(o.min + (o.max - o.min) * f, 0),
        HMI_COLORS.dim, 7, 'middle'));
    }
  }

  // readout
  const valStr = o.value === undefined ? '———' : o.value.toFixed(dec);
  const lvl = levelOf(o.value, o.warn, o.crit);
  const unitStr = o.unit ? ` ${o.unit}` : '';
  if (vertical) {
    ops.push(txt(w / 2, h - 4, `${valStr}${unitStr}`, levelColor(lvl), 13, 'middle'));
  } else {
    ops.push(txt(bx + bw + 4, by + bh / 2 + 4,
      `${valStr}${unitStr}`, levelColor(lvl), 12, 'start'));
  }
  if (o.label)
    ops.push(txt(4, 11, o.label, HMI_COLORS.dim, 9));

  return { w, h, bg: HMI_COLORS.bg, ops };
}

// ---------------------------------------------------------------------------
// digital — large numeric display with unit, label, alarm coloring
// ---------------------------------------------------------------------------

export interface DigitalOpts {
  w: number; h: number;
  label?: string;
  unit?: string;
  min?: number; max?: number;
  value?: number;
  warn?: number; crit?: number;
  decimals?: number;
  /** '7seg' style: darker inset window like an instrument display */
  window?: boolean;
}

export function digitalScene(o: DigitalOpts): HmiScene {
  const ops: SceneOp[] = [];
  const w = o.w, h = o.h;
  ops.push(rect(0, 0, w, h, HMI_COLORS.bg));

  const dec = o.decimals ?? 1;
  const valStr = o.value === undefined ? '———' : o.value.toFixed(dec);
  const lvl = levelOf(o.value, o.warn, o.crit);
  const col = levelColor(lvl);

  if (o.window) {
    // instrument-style dark window with subtle border
    ops.push(rect(2, 2, w - 4, h - 4, '#0b0e12', HMI_COLORS.panelEdge, 1));
  }

  // fit text size to width: mono advance ≈ 0.602em per char
  const chars = valStr.length + (o.unit ? o.unit.length + 1 : 0);
  const availW = w - 12;
  const size = Math.max(10, Math.min(h * 0.52,
    availW / Math.max(1, chars * 0.62)));

  // value centered
  const valY = h * 0.58;
  ops.push(txt(w / 2, valY, valStr, col, size, 'middle'));
  if (o.unit) {
    const unitSize = Math.max(8, size * 0.42);
    // right after value — approximate width via hmiTextWidth semantics
    const valW = valStr.length * size * 0.602031;
    ops.push(txt(w / 2 + valW / 2 + 3, valY - size * 0.28, o.unit,
      HMI_COLORS.dim, unitSize, 'start'));
  }
  if (o.label)
    ops.push(txt(w / 2, h - 5, o.label, HMI_COLORS.dim, 9, 'middle'));

  // alarm edge glow — thin border strip colored by level
  if (lvl !== 'ok')
    ops.push(rect(1, 1, w - 2, h - 2, undefined, col, 2));

  return { w, h, bg: HMI_COLORS.bg, ops };
}

// ---------------------------------------------------------------------------
// lamp stack — RUN / ALARM / FAULT stack light with blink phase
// ---------------------------------------------------------------------------

export interface LampOpts {
  w: number; h: number;
  /** per-lamp state: true = lit; 'blink' handled via phase */
  run?: boolean | 'blink';
  alarm?: boolean | 'blink';
  fault?: boolean | 'blink';
  labels?: { run?: string; alarm?: string; fault?: string };
  /** blink phase 0..1 — tile timer drives this */
  phase?: number;
}

export function lampStackScene(o: LampOpts): HmiScene {
  const ops: SceneOp[] = [];
  const w = o.w, h = o.h;
  ops.push(rect(0, 0, w, h, HMI_COLORS.bg));

  const lamps: { key: 'run' | 'alarm' | 'fault';
                 color: string; label: string }[] = [
    { key: 'run',   color: HMI_COLORS.ok,   label: o.labels?.run   ?? 'RUN' },
    { key: 'alarm', color: HMI_COLORS.warn, label: o.labels?.alarm ?? 'ALM' },
    { key: 'fault', color: HMI_COLORS.crit, label: o.labels?.fault ?? 'FLT' },
  ];

  const lit = (s: boolean | 'blink' | undefined): boolean => {
    if (s === true) return true;
    if (s === 'blink') return (o.phase ?? 0) < 0.5;
    return false;
  };

  const r = Math.min(w * 0.16, h * 0.14);
  const gap = h * 0.2;
  const cx = w / 2;
  const firstY = h * 0.5 - gap;   // three lamps centered vertically

  lamps.forEach((l, i) => {
    const cy = firstY + i * gap;
    const on = lit(o[l.key]);
    // housing
    ops.push(disc(cx, cy, r * 1.25, HMI_COLORS.panel));
    ops.push(ring(cx, cy, r * 1.25, HMI_COLORS.panelEdge, 1));
    // lens
    ops.push(disc(cx, cy, r,
      on ? l.color : '#232a33'));
    if (on) {
      // highlight
      ops.push(disc(cx - r * 0.25, cy - r * 0.25, r * 0.45,
        l.color === HMI_COLORS.crit ? '#ffb0ac'
        : l.color === HMI_COLORS.warn ? '#ffd9a0'
        : '#b8f0c8'));
    }
    ops.push(txt(cx + r * 1.5, cy + 3, l.label,
      on ? l.color : HMI_COLORS.dim, 9, 'start'));
  });

  return { w, h, bg: HMI_COLORS.bg, ops };
}

// ---------------------------------------------------------------------------
// alarm board — active alarm summary with severity chips
// ---------------------------------------------------------------------------

export interface AlarmRow {
  /** display text (message or name) */
  text: string;
  level: AlarmLevel;
  /** acked → dimmed */
  acked?: boolean;
}

export interface AlarmBoardOpts {
  w: number; h: number;
  title?: string;
  rows: AlarmRow[];
  maxRows?: number;
}

export function alarmBoardScene(o: AlarmBoardOpts): HmiScene {
  const ops: SceneOp[] = [];
  const w = o.w, h = o.h;
  ops.push(rect(0, 0, w, h, HMI_COLORS.bg));

  const headerH = 16;
  const rowH = Math.max(12, (h - headerH - 4) / Math.max(1, o.maxRows ?? 8));
  const maxRows = Math.min(o.rows.length, Math.floor((h - headerH - 4) / rowH));

  // header
  ops.push(rect(0, 0, w, headerH, HMI_COLORS.panel, HMI_COLORS.panelEdge, 1));
  const nActive = o.rows.filter((r) => !r.acked).length;
  const headerTxt = `${o.title ?? 'ALARMS'} — ${nActive} active`;
  ops.push(txt(4, 11, headerTxt,
    nActive > 0 ? HMI_COLORS.warn : HMI_COLORS.dim, 10));

  // rows
  for (let i = 0; i < maxRows; i++) {
    const r = o.rows[i];
    if (!r) continue;
    const y = headerH + i * rowH;
    const bg = i % 2 ? '#182028' : '#141b23';
    ops.push(rect(0, y, w, rowH - 1, bg));
    // severity chip
    ops.push(rect(2, y + 2, 6, rowH - 5, levelColor(r.level)));
    const txtCol = r.acked ? HMI_COLORS.dim : HMI_COLORS.text;
    const label = r.acked ? `✓ ${r.text}` : r.text;
    ops.push(txt(12, y + rowH - 4, label, txtCol, 9));
  }

  if (o.rows.length === 0)
    ops.push(txt(w / 2, h / 2, 'no active alarms', HMI_COLORS.ok, 11, 'middle'));

  return { w, h, bg: HMI_COLORS.bg, ops };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function fmtNum(v: number, dec: number): string {
  if (!isFinite(v)) return '———';
  const a = Math.abs(v);
  if (a >= 10000) return v.toExponential(0);
  if (a >= 100) return v.toFixed(0);
  return v.toFixed(dec);
}
