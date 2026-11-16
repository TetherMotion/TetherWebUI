/**
 * Pixel-parity tests: every scene-native widget must produce an
 * identical view through both backends —
 *
 *   web:    sceneToSvg() rasterized by resvg (same pipeline family a
 *           browser uses for SVG)
 *   vulkan: examples/hmi_vulkan.cpp (Tether repo) rendering the same
 *           scene JSON through the glyb/Vulkan pipeline
 *
 * The test builds each widget scene once, rasterizes both ways at
 * scale 1 (scene units == pixels), and diffs the pixel buffers. Text
 * is the only expected divergence source (different rasterizers), so
 * thresholds tolerate AA edge differences while still catching real
 * layout/color bugs.
 *
 * Requires the hmi_vulkan binary — set HMI_VULKAN_BIN or rely on the
 * sibling ../Tether/build/bin/hmi_vulkan default. Skipped when absent
 * (e.g. CI without the Tether build).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { sceneToSvg, type HmiScene } from './scene';
import {
  gaugeScene, bargraphScene, digitalScene, lampStackScene,
  alarmBoardScene,
} from './widgets';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_TETHER = join(HERE, '..', '..', '..', 'Tether');
const BIN_CANDIDATES = [
  process.env.HMI_VULKAN_BIN ?? '',
  join(REPO_TETHER, 'build', 'bin', 'hmi_vulkan'),
].filter(Boolean);
const HMI_VULKAN = BIN_CANDIDATES.find((p) => existsSync(p));
const DEJAVU_MONO =
  process.env.HMI_FONT ??
  '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';

const hasBinary = !!HMI_VULKAN && existsSync(DEJAVU_MONO);

// ---------------------------------------------------------------------------
// rasterizers
// ---------------------------------------------------------------------------

function svgPixels(scene: HmiScene): Uint8Array {
  let svg = sceneToSvg(scene);
  // inject explicit pixel size — the contract only carries viewBox
  svg = svg.replace(
    '<svg ',
    `<svg width="${scene.w}" height="${scene.h}" `,
  );
  const r = new Resvg(svg, {
    font: {
      fontFiles: [DEJAVU_MONO],
      loadSystemFonts: false,
      defaultFontFamily: 'DejaVu Sans Mono',
    },
    fitTo: { mode: 'original' },
  });
  const img = r.render();
  return img.pixels; // RGBA
}

function ppmPixels(path: string): { w: number; h: number; rgb: Uint8Array } {
  const buf = readFileSync(path);
  // parse P6 header: magic, whitespace-separated w h maxval, single ws
  let i = 0;
  const tok = () => {
    while (i < buf.length && /\s/.test(String.fromCharCode(buf[i]!))) i++;
    if (buf[i] === 0x23) { while (buf[i]! !== 0x0a) i++; return tok(); }
    let s = '';
    while (i < buf.length && !/\s/.test(String.fromCharCode(buf[i]!))) {
      s += String.fromCharCode(buf[i++]!);
    }
    return s;
  };
  const magic = tok();
  expect(magic).toBe('P6');
  const w = parseInt(tok(), 10);
  const h = parseInt(tok(), 10);
  tok(); // maxval
  i++;  // single whitespace before raster
  return { w, h, rgb: buf.subarray(i, i + w * h * 3) };
}

function vulkanPixels(scene: HmiScene, dir: string, name: string) {
  const scenePath = join(dir, `${name}.json`);
  const ppmPath = join(dir, `${name}.ppm`);
  writeFileSync(scenePath, JSON.stringify(scene));
  execFileSync(HMI_VULKAN!, [scenePath, ppmPath, '--scale', '1',
    '--font', DEJAVU_MONO], { stdio: 'pipe' });
  return ppmPixels(ppmPath);
}

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

interface DiffReport {
  total: number;
  exact: number;
  close: number;   // per-channel |d| <= 48
  far: number;     // anything else
  maxDelta: number;
}

function diffPixels(
  web: Uint8Array, webW: number, webH: number,
  vk: { w: number; h: number; rgb: Uint8Array },
): DiffReport {
  expect(vk.w).toBe(webW);
  expect(vk.h).toBe(webH);
  const rep: DiffReport = {
    total: webW * webH, exact: 0, close: 0, far: 0, maxDelta: 0,
  };
  for (let p = 0; p < rep.total; ++p) {
    const o = p * 4, v = p * 3;
    // resvg pixels are RGBA; ignore alpha (both backends opaque here)
    let md = 0;
    for (let c = 0; c < 3; ++c) {
      md = Math.max(md, Math.abs((web[o + c] ?? 0) - (vk.rgb[v + c] ?? 0)));
    }
    rep.maxDelta = Math.max(rep.maxDelta, md);
    if (md === 0) rep.exact++;
    else if (md <= 48) rep.close++;
    else rep.far++;
  }
  return rep;
}

function expectParity(rep: DiffReport, label: string) {
  const ok = rep.far / rep.total;
  // >97.5% of pixels within loose tolerance; >60% bit-exact is typical
  // for flat fills, text AA accounts for the rest
  expect(
    ok, `${label}: ${(ok * 100).toFixed(2)}% pixels diverge ` +
      `(exact ${(rep.exact / rep.total * 100).toFixed(1)}%, ` +
      `close ${(rep.close / rep.total * 100).toFixed(1)}%, ` +
      `maxDelta ${rep.maxDelta})`,
  ).toBeLessThan(0.025);
}

// ---------------------------------------------------------------------------
// scenes — one representative instance per widget type
// ---------------------------------------------------------------------------

const SCENES: Record<string, () => HmiScene> = {
  gauge: () => gaugeScene({
    w: 240, h: 180, label: 'LOOP PV', value: 67.3,
    min: 0, max: 100, unit: '°C', warn: 80, crit: 95,
    decimals: 1,
  }),
  bar: () => bargraphScene({
    w: 220, h: 56, label: 'HEATER OUT', value: 42.5,
    min: 0, max: 100, unit: '%', warn: 90, decimals: 1,
  }),
  digital: () => digitalScene({
    w: 160, h: 64, label: 'SP', value: 180.0,
    unit: '°C', warn: 200, crit: 230, decimals: 1, window: true,
  }),
  lamp: () => lampStackScene({
    w: 120, h: 120,
    run: true, alarm: 'blink', fault: false, phase: 0.5,
    labels: { run: 'RUN', alarm: 'WARN', fault: 'FLT' },
  }),
  alarms: () => alarmBoardScene({
    w: 240, h: 140, title: 'ALARMS',
    rows: [
      { text: 'OVERTEMP zone2', level: 'crit' },
      { text: 'sensor drift', level: 'warn', acked: true },
      { text: 'door open', level: 'ok' },
    ],
  }),
};

// ---------------------------------------------------------------------------

describe.skipIf(!hasBinary)('HMI scene backend parity (SVG vs Vulkan)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hmi-parity-'));

  for (const [name, build] of Object.entries(SCENES)) {
    it(`${name} widget renders identically`, () => {
      const scene = build();
      const web = svgPixels(scene);
      const vkImg = vulkanPixels(scene, dir, name);
      const webW = scene.w, webH = scene.h;
      expect(vkImg.w).toBe(webW);
      expect(vkImg.h).toBe(webH);
      const rep = diffPixels(web, webW, webH, vkImg);
      expectParity(rep, name);
    });
  }
});
