/**
 * HMI scene IR — the single source of truth for widget appearance.
 *
 * Every scene-native HMI widget (gauge, bargraph, digital, alarm
 * board, …) describes its visuals as an {@link HmiScene}: a flat list
 * of draw ops in a top-left-origin, y-down coordinate space. Two
 * backends consume the identical document:
 *
 *   - web:    {@link sceneToSvg} → inline SVG in the board tile
 *   - vulkan: examples/hmi_vulkan.cpp (Tether repo) parses the same
 *             JSON and rasterizes with Vulkan
 *
 * The contract is deliberately small — rect / line / path / text —
 * so a native renderer stays simple and views stay identical by
 * construction. Filled paths must be star-shaped w.r.t. their first
 * point (the Vulkan backend triangulates as a fan; SVG fills natively).
 *
 * Text convention (shared with hmi_font_atlas.hpp): op (x, y) is the
 * baseline origin of the first glyph's pen; `size` is the em size in
 * scene units; horizontal anchor shifts by hmiTextWidth() so both
 * backends center/right-align identically.
 *
 * Color format: '#rgb', '#rrggbb' or '#rrggbbaa' (alpha optional,
 * defaults ff). Anything else is rejected by normalizeColor().
 */
import { hmiTextWidth } from './font-atlas';

export type ScenePt = [number, number];

export type SceneOp =
  | {
      k: 'rect';
      x: number; y: number; w: number; h: number;
      fill?: string; stroke?: string; sw?: number;
    }
  | { k: 'line'; x1: number; y1: number; x2: number; y2: number; color: string; w?: number }
  | {
      k: 'path';
      pts: ScenePt[];
      color: string;
      w?: number;
      close?: boolean;
      fill?: string;
    }
  | {
      k: 'text';
      x: number; y: number;
      s: string;
      color: string;
      size?: number;
      anchor?: 'start' | 'middle' | 'end';
    };

export interface HmiScene {
  /** design-space size in scene units */
  w: number;
  h: number;
  /** background color (default transparent) */
  bg?: string;
  ops: SceneOp[];
}

// ---------------------------------------------------------------------------
// colors
// ---------------------------------------------------------------------------

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Normalize '#rgb'/'#rrggbb'/'#rrggbbaa' → '#rrggbbaa'; null if invalid. */
export function normalizeColor(c: string | undefined): string | undefined {
  if (!c) return undefined;
  if (!HEX_RE.test(c)) return undefined;
  let h = c.slice(1);
  if (h.length === 3) h = [...h].map((x) => x + x).join('');
  if (h.length === 6) h += 'ff';
  return `#${h.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// geometry helpers used by widget builders (pure, testable)
// ---------------------------------------------------------------------------

/** Sample an arc/polyline. Angles in degrees, 0 = +x (east), positive
 *  sweeps toward +y (screen down, i.e. visually clockwise). Both
 *  backends must use this exact segmentation for identical curves. */
export function arcPoints(
  cx: number, cy: number, r: number,
  a0: number, a1: number, stepDeg = 4,
): ScenePt[] {
  const sweep = a1 - a0;
  const n = Math.max(2, Math.ceil(Math.abs(sweep) / stepDeg));
  const pts: ScenePt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = ((a0 + (sweep * i) / n) * Math.PI) / 180;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/** Regular polygon approximating a circle (for gauges, hubs). */
export function circlePoints(cx: number, cy: number, r: number, n = 48): ScenePt[] {
  const pts: ScenePt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/** Map a fraction [0..1] onto an arc span [a0..a1] (deg). */
export function arcAngleAt(a0: number, a1: number, frac: number): number {
  return a0 + (a1 - a0) * Math.min(1, Math.max(0, frac));
}

// ---------------------------------------------------------------------------
// SVG backend (web)
// ---------------------------------------------------------------------------

const escXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function opToSvg(op: SceneOp): string {
  switch (op.k) {
    case 'rect': {
      const fill = normalizeColor(op.fill);
      const stroke = normalizeColor(op.stroke);
      const sw = op.sw ?? 1;
      const attrs = [
        `x="${op.x}" y="${op.y}" width="${Math.max(0, op.w)}" height="${Math.max(0, op.h)}"`,
        fill ? `fill="${fill}"` : 'fill="none"',
      ];
      if (stroke) attrs.push(`stroke="${stroke}" stroke-width="${sw}"`);
      return `<rect ${attrs.join(' ')} vector-effect="non-scaling-stroke"/>`;
    }
    case 'line': {
      const color = normalizeColor(op.color) ?? '#000';
      return `<line x1="${op.x1}" y1="${op.y1}" x2="${op.x2}" y2="${op.y2}" stroke="${color}" stroke-width="${op.w ?? 1}" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
    }
    case 'path': {
      const color = normalizeColor(op.color) ?? '#000';
      const d = op.pts
        .map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(2)},${p[1].toFixed(2)}`)
        .join(' ') + (op.close ? ' Z' : '');
      const fill = normalizeColor(op.fill);
      return `<path d="${d}" fill="${fill ?? 'none'}"${fill ? '' : ` stroke="${color}" stroke-width="${op.w ?? 1}" stroke-linejoin="round" stroke-linecap="round"`} vector-effect="non-scaling-stroke"/>`;
    }
    case 'text': {
      const color = normalizeColor(op.color) ?? '#000';
      const size = op.size ?? 10;
      /* anchor shifts by measured advance so middle/end alignment
         matches the Vulkan backend's identical math */
      const w = hmiTextWidth(op.s, size);
      const dx = op.anchor === 'middle' ? -w / 2 : op.anchor === 'end' ? -w : 0;
      const len = op.anchor === 'start' ? undefined : w;
      return `<text x="${(op.x + dx).toFixed(2)}" y="${op.y.toFixed(2)}" font-size="${size}" fill="${color}" font-family="'DejaVu Sans Mono','Liberation Mono',monospace"${len !== undefined ? ` textLength="${len.toFixed(2)}" lengthAdjust="spacingAndGlyphs"` : ''}>${escXml(op.s)}</text>`;
    }
  }
}

/** Render a scene to an SVG document fragment (no outer <svg> wrapper —
 *  callers wrap it; viewBox covers the design space). */
export function sceneToSvgInner(scene: HmiScene): string {
  const bg = normalizeColor(scene.bg);
  const bgRect = bg
    ? `<rect x="0" y="0" width="${scene.w}" height="${scene.h}" fill="${bg}"/>`
    : '';
  return bgRect + scene.ops.map(opToSvg).join('');
}

/** Full <svg> element string sized to fill its container. */
export function sceneToSvg(scene: HmiScene, cls = 'hmi-scene'): string {
  return (
    `<svg class="${cls}" viewBox="0 0 ${scene.w} ${scene.h}" ` +
    `preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">` +
    sceneToSvgInner(scene) +
    `</svg>`
  );
}
