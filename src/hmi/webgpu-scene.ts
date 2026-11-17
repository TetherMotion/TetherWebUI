/**
 * WebGPU backend for the HMI scene IR — the browser counterpart of
 * Tether's Vulkan renderer (examples/common/HmiVulkan.cpp). Consumes
 * the identical {@link HmiScene} document and rasterizes every op:
 *
 *   rect  → filled quad / non-overlapping stroke frame
 *   line  → body quad + round end caps (half-disc fans)
 *   path  → triangle fan (fill, star-shaped per contract) or per-
 *           segment quads + join discs + round caps (stroke)
 *   text  → per-glyph quads over a canvas-rasterized atlas, advances
 *           from hmiTextWidth() so anchors match the SVG/Vulkan
 *           backends exactly
 *
 * The scene maps to the canvas with the same non-uniform stretch the
 * SVG backend uses (viewBox + preserveAspectRatio="none"). Output is
 * premultiplied alpha over a transparent clear (or scene.bg).
 *
 * Usage is opt-in: tiles render SVG unless
 * `localStorage['tether.hmi.webgpu'] === '1'` (or `?hmiwebgpu=1`).
 * Every entry point degrades gracefully — no navigator.gpu, no
 * adapter, or a lost device all fall back to the SVG path.
 */
import { HmiScene, SceneOp, normalizeColor } from './scene';
import { hmiTextWidth } from './font-atlas';

// ---------------------------------------------------------------------------
// WGSL
// ---------------------------------------------------------------------------

const WGSL = /* wgsl */ `
struct VIn {
  @location(0) pos : vec2f,
  @location(1) uv  : vec2f,
  @location(2) col : vec4f,
};
struct VOut {
  @builtin(position) p : vec4f,
  @location(0) uv : vec2f,
  @location(1) col : vec4f,
};
@group(0) @binding(0) var<uniform> uScene : vec4f;  // x=sceneW y=sceneH
@group(0) @binding(1) var atlasTex : texture_2d<f32>;
@group(0) @binding(2) var atlasSmp : sampler;

@vertex
fn vs(v : VIn) -> VOut {
  var o : VOut;
  o.p = vec4f(v.pos.x / uScene.x * 2.0 - 1.0,
              1.0 - v.pos.y / uScene.y * 2.0, 0.0, 1.0);
  o.uv = v.uv;
  o.col = v.col;
  return o;
}

@fragment
fn fsSolid(v : VOut) -> @location(0) vec4f {
  return vec4f(v.col.rgb * v.col.a, v.col.a);
}

@fragment
fn fsText(v : VOut) -> @location(0) vec4f {
  let c = textureSample(atlasTex, atlasSmp, v.uv).a;
  return vec4f(v.col.rgb * v.col.a * c, v.col.a * c);
}
`;

// ---------------------------------------------------------------------------
// color
// ---------------------------------------------------------------------------

function hexRgba(c: string | undefined): [number, number, number, number] {
  const n = normalizeColor(c);
  if (!n) return [0, 0, 0, 0];
  const h = n.slice(1);
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
    parseInt(h.slice(6, 8), 16) / 255,
  ];
}

// ---------------------------------------------------------------------------
// glyph atlas — canvas 2D rasterization of the shared HMI font
// ---------------------------------------------------------------------------

/** Em size the atlas rasterizes at (scene units map via size/EM). */
const ATLAS_EM = 48;
const CELL = 72;          // px per glyph cell (em + bearing room)
const PEN_X = 8;          // pen origin x inside cell
const BASE_Y = 56;        // baseline y inside cell
const PAD_U = 1;          // half-texel bleed guard, in atlas px

export interface GlyphEntry {
  /** ink bbox relative to pen origin, in atlas px (top = px above baseline) */
  left: number; top: number; w: number; h: number;
  /** normalized atlas uv rect */
  u0: number; v0: number; u1: number; v1: number;
}

/** Character set: printable ASCII + every glyph named in font-atlas.ts. */
const ATLAS_CHARS =
  ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
  '[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~' +
  '°µ±²³×÷·—–…■●▲▼←→↑↓≈≤≥≠∞ΩαβγΔΣπτφω□';

export interface Atlas {
  texture: GPUTexture;
  sampler: GPUSampler;
  glyphs: Map<string, GlyphEntry>;
  width: number;
  height: number;
}

function buildAtlas(device: GPUDevice): Atlas | null {
  const chars = [...new Set(ATLAS_CHARS)];
  const columns = Math.ceil(Math.sqrt(chars.length));
  const rows = Math.ceil(chars.length / columns);
  const w = columns * CELL;
  const h = rows * CELL;

  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const cx = cv.getContext('2d');
  if (!cx) return null;
  cx.clearRect(0, 0, w, h);
  cx.fillStyle = '#fff';
  cx.font = `${ATLAS_EM}px 'DejaVu Sans Mono','Liberation Mono',monospace`;
  cx.textBaseline = 'alphabetic';
  cx.textAlign = 'left';

  const glyphs = new Map<string, GlyphEntry>();
  chars.forEach((ch, i) => {
    const gx = (i % columns) * CELL;
    const gy = Math.floor(i / columns) * CELL;
    cx.fillText(ch, gx + PEN_X, gy + BASE_Y);
  });

  const img = cx.getImageData(0, 0, w, h).data;
  chars.forEach((ch, i) => {
    const gx = (i % columns) * CELL;
    const gy = Math.floor(i / columns) * CELL;
    // ink bbox within the cell
    let x0 = CELL, y0 = CELL, x1 = -1, y1 = -1;
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        if ((img[((gy + y) * w + gx + x) * 4 + 3] ?? 0) > 8) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) { glyphs.set(ch, { left: 0, top: 0, w: 0, h: 0, u0: 0, v0: 0, u1: 0, v1: 0 }); return; }
    // shrink uv by half a texel to avoid bleeding into neighbours
    const u0 = (gx + Math.max(0, x0 - PAD_U)) / w;
    const v0 = (gy + Math.max(0, y0 - PAD_U)) / h;
    const u1 = (gx + Math.min(CELL, x1 + 1 + PAD_U)) / w;
    const v1 = (gy + Math.min(CELL, y1 + 1 + PAD_U)) / h;
    glyphs.set(ch, {
      left: x0 - PEN_X, top: BASE_Y - y0,
      w: x1 - x0 + 1, h: y1 - y0 + 1,
      u0, v0, u1, v1,
    });
  });

  const texture = device.createTexture({
    size: [w, h],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.copyExternalImageToTexture(
    { source: cv }, { texture }, { width: w, height: h });

  const sampler = device.createSampler({
    magFilter: 'linear', minFilter: 'linear',
  });
  return { texture, sampler, glyphs, width: w, height: h };
}

// ---------------------------------------------------------------------------
// geometry builder — scene ops → interleaved vertex stream
// ---------------------------------------------------------------------------

const STRIDE = 8; // floats per vertex: x y u v r g b a

class VertStream {
  /** solid and text verts are segregated: solid first, text after,
      so two draw calls can bind different pipelines over one buffer */
  private solidData: number[] = [];
  private textData: number[] = [];
  private inText = false;

  private push(x: number, y: number, u: number, v: number,
               c: [number, number, number, number]) {
    (this.inText ? this.textData : this.solidData)
      .push(x, y, u, v, c[0], c[1], c[2], c[3]);
  }

  /** solid quad (two tris, non-indexed) */
  quad(x: number, y: number, w: number, h: number,
       c: [number, number, number, number]) {
    const x1 = x + w, y1 = y + h;
    this.push(x, y, 0, 0, c); this.push(x1, y, 0, 0, c); this.push(x1, y1, 0, 0, c);
    this.push(x, y, 0, 0, c); this.push(x1, y1, 0, 0, c); this.push(x, y1, 0, 0, c);
  }

  /** solid triangle */
  tri(ax: number, ay: number, bx: number, by: number,
      cx2: number, cy: number, c: [number, number, number, number]) {
    this.push(ax, ay, 0, 0, c); this.push(bx, by, 0, 0, c); this.push(cx2, cy, 0, 0, c);
  }

  /** filled polygon fan around pts[0] (contract: star-shaped) */
  fan(pts: [number, number][], c: [number, number, number, number]) {
    const p0 = pts[0]!;
    for (let i = 1; i + 1 < pts.length; i++) {
      const a = pts[i]!, b = pts[i + 1]!;
      this.tri(p0[0], p0[1], a[0], a[1], b[0], b[1], c);
    }
  }

  /** disc fan: center + arc from a0 sweeping `sweep` rad, n segments */
  disc(cx: number, cy: number, r: number, a0: number, sweep: number, n: number,
       c: [number, number, number, number]) {
    for (let i = 0; i < n; i++) {
      const t0 = a0 + (sweep * i) / n;
      const t1 = a0 + (sweep * (i + 1)) / n;
      this.tri(cx, cy,
        cx + r * Math.cos(t0), cy + r * Math.sin(t0),
        cx + r * Math.cos(t1), cy + r * Math.sin(t1), c);
    }
  }

  /** thick segment as a quad (no caps) */
  segQuad(x1: number, y1: number, x2: number, y2: number, w: number,
          c: [number, number, number, number]) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) { this.disc(x1, y1, w / 2, 0, Math.PI * 2, 12, c); return; }
    const nx = (-dy / len) * (w / 2), ny = (dx / len) * (w / 2);
    this.quadStrip(x1 + nx, y1 + ny, x2 + nx, y2 + ny, x2 - nx, y2 - ny, x1 - nx, y1 - ny, c);
  }

  private quadStrip(ax: number, ay: number, bx: number, by: number,
                    cx2: number, cy: number, dx: number, dy: number,
                    c: [number, number, number, number]) {
    this.push(ax, ay, 0, 0, c); this.push(bx, by, 0, 0, c); this.push(cx2, cy, 0, 0, c);
    this.push(ax, ay, 0, 0, c); this.push(cx2, cy, 0, 0, c); this.push(dx, dy, 0, 0, c);
  }

  /** round cap at (x,y) pointing along angle `dir` (radians) */
  cap(x: number, y: number, r: number, dir: number,
      c: [number, number, number, number]) {
    this.disc(x, y, r, dir - Math.PI / 2, Math.PI, 8, c);
  }

  beginText() { this.inText = true; }
  endText() { this.inText = false; }

  get data(): number[] { return [...this.solidData, ...this.textData]; }
  get solidVerts(): number { return this.solidData.length / STRIDE; }
  get totalVerts(): number { return (this.solidData.length + this.textData.length) / STRIDE; }

  textQuad(x: number, y: number, w: number, h: number,
           u0: number, v0: number, u1: number, v1: number,
           c: [number, number, number, number]) {
    const x1 = x + w, y1 = y + h;
    this.push(x, y, u0, v0, c); this.push(x1, y, u1, v0, c); this.push(x1, y1, u1, v1, c);
    this.push(x, y, u0, v0, c); this.push(x1, y1, u1, v1, c); this.push(x, y1, u0, v1, c);
  }
}

// ---------------------------------------------------------------------------
// op lowering
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;

function strokeFrame(v: VertStream, x: number, y: number, w: number, h: number,
                      sw: number, c: [number, number, number, number]) {
  const half = sw / 2;
  const ow = Math.max(0, w + sw), oh = Math.max(0, h + sw);
  const ox = x - half, oy = y - half;
  // 4 non-overlapping strips forming the centered stroke frame
  v.quad(ox, oy, ow, sw, c);                                  // top
  v.quad(ox, oy + oh - sw, ow, sw, c);                        // bottom
  const midH = Math.max(0, oh - sw);
  v.quad(ox, oy + sw, sw, midH, c);                           // left
  v.quad(ox + ow - sw, oy + sw, sw, midH, c);                 // right
}

function strokePolyline(v: VertStream, pts: [number, number][], w: number,
                        closed: boolean, c: [number, number, number, number]) {
  const n = pts.length;
  if (n < 2) return;
  const r = w / 2;
  const lastSeg = closed ? n : n - 1;
  for (let i = 0; i < lastSeg; i++) {
    const a = pts[i]!, b = pts[(i + 1) % n]!;
    v.segQuad(a[0], a[1], b[0], b[1], w, c);
  }
  // joins: full disc at every interior vertex (all vertices when closed)
  for (let i = closed ? 0 : 1; i <= (closed ? n - 1 : n - 2); i++) {
    const p = pts[i]!;
    v.disc(p[0], p[1], r, 0, TAU, 10, c);
  }
  if (!closed) {
    // round caps at the two open ends
    const p0 = pts[0]!, p1 = pts[1]!, pn = pts[n - 1]!, pm = pts[n - 2]!;
    const d0 = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
    v.cap(p0[0], p0[1], r, d0 + Math.PI, c);
    const d1 = Math.atan2(pn[1] - pm[1], pn[0] - pm[0]);
    v.cap(pn[0], pn[1], r, d1, c);
  }
}

function emitOp(v: VertStream, op: SceneOp, atlas: Atlas | null) {
  switch (op.k) {
    case 'rect': {
      const c = hexRgba(op.fill);
      const sc = hexRgba(op.stroke);
      const hasFill = op.fill !== undefined && c[3] > 0;
      const hasStroke = op.stroke !== undefined && sc[3] > 0;
      if (hasFill) v.quad(op.x, op.y, Math.max(0, op.w), Math.max(0, op.h), c);
      if (hasStroke) strokeFrame(v, op.x, op.y, op.w, op.h, op.sw ?? 1, sc);
      break;
    }
    case 'line': {
      const c = hexRgba(op.color);
      if (c[3] === 0) break;
      const w = op.w ?? 1;
      const dx = op.x2 - op.x1, dy = op.y2 - op.y1;
      const len = Math.hypot(dx, dy);
      v.segQuad(op.x1, op.y1, op.x2, op.y2, w, c);
      if (len > 1e-6) {
        const d = Math.atan2(dy, dx);
        v.cap(op.x1, op.y1, w / 2, d + Math.PI, c);
        v.cap(op.x2, op.y2, w / 2, d, c);
      } else {
        v.disc(op.x1, op.y1, w / 2, 0, TAU, 12, c);
      }
      break;
    }
    case 'path': {
      const pts = op.pts;
      if (pts.length < 2) break;
      const fill = op.fill !== undefined ? hexRgba(op.fill) : null;
      const stroke = hexRgba(op.color);
      if (fill && fill[3] > 0) {
        v.fan(pts, fill);
      } else if (stroke[3] > 0) {
        strokePolyline(v, pts, op.w ?? 1, !!op.close, stroke);
      }
      break;
    }
    case 'text': {
      if (!atlas) break;
      const c = hexRgba(op.color);
      if (c[3] === 0) break;
      const size = op.size ?? 10;
      const wpx = hmiTextWidth(op.s, size);
      const dx = op.anchor === 'middle' ? -wpx / 2 : op.anchor === 'end' ? -wpx : 0;
      const fallback = atlas.glyphs.get('?') ?? atlas.glyphs.get(' ');
      let pen = op.x + dx;
      const base = op.y;
      v.beginText();
      for (const ch of op.s) {
        const adv = hmiTextWidth(ch, size);
        const g = atlas.glyphs.get(ch) ?? fallback;
        if (g && g.w > 0 && g.h > 0) {
          const s = size / ATLAS_EM;
          v.textQuad(
            pen + g.left * s, base - g.top * s, g.w * s, g.h * s,
            g.u0, g.v0, g.u1, g.v1, c);
        }
        pen += adv;
      }
      v.endText();
      break;
    }
  }
}

export interface SceneVertices {
  /** interleaved [x y u v r g b a] floats */
  data: Float32Array<ArrayBuffer>;
  /** vertex count drawn with the solid pipeline (text comes after) */
  solidVerts: number;
  totalVerts: number;
}

/**
 * Lower a scene to the interleaved vertex stream the GPU consumes.
 * `atlas` may be null — text ops are then skipped (used by unit tests;
 * the renderer always passes the real atlas).
 */
export function sceneToVertices(scene: HmiScene, atlas: Atlas | null): SceneVertices {
  const v = new VertStream();
  for (const op of scene.ops) emitOp(v, op, atlas);
  return {
    data: new Float32Array(v.data),
    solidVerts: v.solidVerts,
    totalVerts: v.totalVerts,
  };
}

// ---------------------------------------------------------------------------
// shared GPU context
// ---------------------------------------------------------------------------

interface Shared {
  device: GPUDevice;
  bgl: GPUBindGroupLayout;
  module: GPUShaderModule;
  pl: GPUPipelineLayout;
  vert: GPUVertexState;
  prim: GPUPrimitiveState;
  blend: GPUBlendState;
  atlas: Atlas;
  uniform: GPUBuffer;
  vbuf: GPUBuffer;
  vbufCap: number;
}

let shared: Shared | null = null;
let sharedPromise: Promise<Shared | null> | null = null;

const VERTEX_BYTES = STRIDE * 4;
const VBUF_INIT = 1 << 18;

async function getShared(): Promise<Shared | null> {
  if (shared) return shared;
  if (!sharedPromise) sharedPromise = initShared();
  return sharedPromise;
}

async function initShared(): Promise<Shared | null> {
  if (typeof navigator === 'undefined' || !navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  if (!device) return null;

  const module = device.createShaderModule({ code: WGSL });
  const bgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' } },
    ],
  });
  const pl = device.createPipelineLayout({ bindGroupLayouts: [bgl] });

  const vert: GPUVertexState = {
    module, entryPoint: 'vs',
    buffers: [{
      arrayStride: VERTEX_BYTES,
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x2' },
        { shaderLocation: 1, offset: 8, format: 'float32x2' },
        { shaderLocation: 2, offset: 16, format: 'float32x4' },
      ],
    }],
  };
  const prim: GPUPrimitiveState = {
    topology: 'triangle-list',
    cullMode: 'none',
  };
  const blend: GPUBlendState = {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  };

  const atlas = buildAtlas(device);
  if (!atlas) return null;

  const uniform = device.createBuffer({
    size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const vbuf = device.createBuffer({
    size: VBUF_INIT, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });

  shared = { device, bgl, module, pl, vert, prim, blend, atlas, uniform, vbuf, vbufCap: VBUF_INIT };
  return shared;
}

// ---------------------------------------------------------------------------
// public renderer
// ---------------------------------------------------------------------------

/**
 * Renders {@link HmiScene} documents to a canvas via WebGPU.
 * One shared device/pipelines/atlas; each canvas gets its own
 * GPUCanvasContext + bind group.
 */
export class WebGpuSceneRenderer {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: GPUCanvasContext | null = null;
  private format: GPUTextureFormat = 'bgra8unorm';
  private pipes = new Map<GPUTextureFormat, { solid: GPURenderPipeline; text: GPURenderPipeline }>();
  private bg: GPUBindGroup | null = null;
  private pending: HmiScene | null = null;
  private ready = false;

  /** Async init — resolves false when WebGPU is unavailable. */
  static async create(): Promise<WebGpuSceneRenderer | null> {
    const s = await getShared();
    if (!s) return null;
    return new WebGpuSceneRenderer();
  }

  private get shared() { return shared; }

  /** True when the renderer is already attached to this canvas. */
  attachedTo(canvas: HTMLCanvasElement): boolean {
    return this.canvas === canvas;
  }

  /** Attach (or re-attach) a canvas; returns false if context fails. */
  attach(canvas: HTMLCanvasElement): boolean {
    const s = this.shared;
    if (!s) return false;
    this.canvas = canvas;
    this.ctx = canvas.getContext('webgpu');
    if (!this.ctx) return false;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({
      device: s.device,
      format: this.format,
      alphaMode: 'premultiplied',
    });
    this.bg = s.device.createBindGroup({
      layout: s.bgl,
      entries: [
        { binding: 0, resource: { buffer: s.uniform } },
        { binding: 1, resource: s.atlas.texture.createView() },
        { binding: 2, resource: s.atlas.sampler },
      ],
    });
    this.ready = true;
    if (this.pending) { const p = this.pending; this.pending = null; this.render(p); }
    return true;
  }

  /** Render a scene; safe to call before attach() resolves. */
  render(scene: HmiScene) {
    const s = this.shared;
    if (!s) return;
    if (!this.ready || !this.ctx || !this.canvas || !this.bg) {
      this.pending = scene;
      return;
    }
    try {
      this.draw(scene);
    } catch {
      // lost device / zero-size canvas — keep the last frame, don't crash the tile
    }
  }

  private draw(scene: HmiScene) {
    const s = this.shared!;
    const canvas = this.canvas!;
    // size canvas to its CSS box × dpr
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const ch = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw; canvas.height = ch;
    }

    // build geometry
    const bg = hexRgba(scene.bg);
    const { data: bytes, solidVerts, totalVerts: vertCount } =
      sceneToVertices(scene, s.atlas);
    if (bytes.byteLength > s.vbufCap) {
      const cap = Math.max(bytes.byteLength * 2, 1 << 18);
      s.vbuf.destroy();
      s.vbuf = s.device.createBuffer({
        size: cap, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      s.vbufCap = cap;
    }
    s.device.queue.writeBuffer(s.vbuf, 0, bytes);
    s.device.queue.writeBuffer(s.uniform, 0,
      new Float32Array([scene.w, scene.h, 0, 0]));

    // pipelines per format (created lazily — format known post-configure)
    let pipes = this.pipes.get(this.format);
    if (!pipes) {
      const targets = [{ format: this.format, blend: s.blend }];
      const solid = s.device.createRenderPipeline({
        layout: s.pl, vertex: s.vert,
        fragment: { module: s.module, entryPoint: 'fsSolid', targets },
        primitive: s.prim });
      const text = s.device.createRenderPipeline({
        layout: s.pl, vertex: s.vert,
        fragment: { module: s.module, entryPoint: 'fsText', targets },
        primitive: s.prim });
      pipes = { solid, text };
      this.pipes.set(this.format, pipes);
    }

    const enc = s.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: this.ctx!.getCurrentTexture().createView(),
        clearValue: bg[3] > 0
          ? { r: bg[0] * bg[3], g: bg[1] * bg[3], b: bg[2] * bg[3], a: bg[3] }
          : { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setVertexBuffer(0, s.vbuf);
    pass.setBindGroup(0, this.bg);
    if (solidVerts > 0) {
      pass.setPipeline(pipes.solid);
      pass.draw(solidVerts);
    }
    const textVerts = vertCount - solidVerts;
    if (textVerts > 0) {
      pass.setPipeline(pipes.text);
      pass.draw(textVerts, 1, solidVerts, 0);
    }
    pass.end();
    s.device.queue.submit([enc.finish()]);
  }
}

// ---------------------------------------------------------------------------
// feature flag + tile integration helper
// ---------------------------------------------------------------------------

let flagCache: boolean | undefined;

/** WebGPU scene backend is opt-in (e2e + SVG fallback stay default). */
export function webgpuSceneEnabled(): boolean {
  if (flagCache !== undefined) return flagCache;
  try {
    const ls = typeof localStorage !== 'undefined' ? localStorage : null;
    const q = typeof location !== 'undefined' ? location.search : '';
    flagCache = (ls?.getItem('tether.hmi.webgpu') === '1') ||
                q.includes('hmiwebgpu=1');
  } catch { flagCache = false; }
  return flagCache;
}

/** Test hook — reset the flag cache (e.g. after setting localStorage). */
export function resetWebgpuSceneFlag() { flagCache = undefined; }

const renderers = new WeakMap<HTMLElement, WebGpuSceneRenderer>();

/**
 * Paint `scene` into `host`'s `.hmi-gpu-host` child using WebGPU.
 * Call from a Lit `updated()` when webgpuSceneEnabled(). Async device
 * init resolves later; the scene is kept pending until then.
 */
export function paintWebGpuScene(host: HTMLElement, scene: HmiScene): void {
  const mount = host.shadowRoot?.querySelector('.hmi-gpu-host') ??
                host.querySelector('.hmi-gpu-host');
  if (!mount) return;
  let canvas = mount.querySelector('canvas') as HTMLCanvasElement | null;
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.className = 'hmi-gpu-canvas';
    mount.appendChild(canvas);
  }
  let r = renderers.get(host);
  if (!r) {
    WebGpuSceneRenderer.create().then((created) => {
      if (!created) return;
      renderers.set(host, created);
      created.attach(canvas!);
      created.render(scene);
    });
    return;
  }
  if (!r.attachedTo(canvas)) r.attach(canvas);
  r.render(scene);
}
