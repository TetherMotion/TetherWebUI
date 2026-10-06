/**
 * @file webgpu-scope.ts
 * @brief WebGPU-based real-time oscilloscope for streaming Tether IO data.
 *
 * Based on the WebGPU oscilloscope from
 * https://techoverflow.net/2026/08/19/real-time-1-khz-webgpu-oscilloscope-with-ring-buffer-auto-scroll/
 * adapted for the Tether IO dashboard.
 *
 * Architecture:
 *   - Data arrives via {@link WebGPUScope.push} (called from StreamData events).
 *   - Samples are stored in a GPU ring buffer (timestamp + value per channel,
 *     interleaved) and uploaded asynchronously via `queue.writeBuffer`.
 *   - The GPU renders a grid background + one line strip per channel in a
 *     single instanced draw call with MSAA anti-aliasing.
 *   - Auto-scroll: the X viewport is always `[currentTime - windowSec, currentTime]`;
 *     old samples map off-screen left and are clipped by the rasterizer.
 *   - Axis labels and legend are drawn on a 2D canvas overlay.
 *
 * @license CC0-1.0 (original source by Uli Köhler, TechOverflow.net)
 */

import {
  BUFFER_SAMPLES,
  ChannelInfo,
  dimColor,
  finiteValueRange,
  legendChannelAtPoint,
  MAX_CHANNELS,
  MARGIN_BOTTOM,
  MARGIN_LEFT,
  MARGIN_RIGHT,
  MARGIN_TOP,
  MSAA_SAMPLE_COUNTS,
  niceStep,
  TARGET_MSAA,
  WINDOW_SAMPLES,
  WINDOW_SEC,
} from './scope/config';
import { drawScopeOverlay } from './scope/overlay';
import { describeCursor, describeDelta, nearestRowIndex } from './scope/cursor';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single sample row: one timestamp + one value per channel. */
interface ScopeRow {
  /** Timestamp in seconds (relative or absolute — only deltas matter). */
  t: number;
  /** One numeric value per channel. */
  values: number[];
}

// ---------------------------------------------------------------------------
// WGSL shader
// ---------------------------------------------------------------------------

/**
 * WebGPU shader source.  Two pipelines:
 *   1. `vs_line` / `fs_line` — renders N line strips (one per channel) with MSAA.
 *   2. `vs_grid` / `fs_grid` — renders the plot background with anti-aliased grid lines.
 *
 * The ring buffer stores `(timestamp, value)` pairs for all channels,
 * interleaved: sample `i` has channel `ch` at index `(i * MAX_CHANNELS + ch) * 2`.
 *
 * Auto-scroll: the uniform `currentTime` is the timestamp of the most recent
 * sample.  The X viewport is `[currentTime - windowSec, currentTime]`.
 * Samples older than `currentTime - windowSec` map to X < -1 (off-screen).
 */
const SHADER = /* wgsl */ `
  struct RenderUniforms {
    viewTimeMin   : f32,   // left edge of the visible time window
    viewTimeSpan  : f32,   // width of the visible time window
    yMin          : f32,
    yMax          : f32,
    plotX         : f32,
    plotY         : f32,
    plotW         : f32,
    plotH         : f32,
    canvasW       : f32,
    canvasH       : f32,
    xMajorStep    : f32,
    yMajorStep    : f32,
    writeIndex    : u32,
    bufferSamples : u32,
    numChannels   : u32,
    _pad0         : u32,
  };

  @group(0) @binding(0) var<uniform> ru : RenderUniforms;
  @group(0) @binding(1) var<storage, read> ringBuffer : array<f32>;
  @group(0) @binding(2) var<storage, read> channelColors : array<vec4<f32>>;

  fn worldToClip(t : f32, v : f32) -> vec4<f32> {
    let xMin = ru.viewTimeMin;
    let xMax = ru.viewTimeMin + ru.viewTimeSpan;
    let plotPx = (t - xMin) / (xMax - xMin) * ru.plotW;
    let plotPy = (ru.yMax - v) / (ru.yMax - ru.yMin) * ru.plotH;
    let canvasPx = ru.plotX + plotPx;
    let canvasPy = ru.plotY + plotPy;
    return vec4<f32>(
      (canvasPx / ru.canvasW) * 2.0 - 1.0,
      1.0 - (canvasPy / ru.canvasH) * 2.0,
      0.0, 1.0
    );
  }

  // ── Thick line pipeline (triangle-strip expansion) ──────────────────
  // WebGPU line-strip topology is always 1px wide.  To get wider lines
  // we render each sample as two vertices (one per side), expanding
  // perpendicular to the line direction in screen space.  The result
  // is a triangle strip that forms a thick ribbon.
  struct LineVSOut {
    @builtin(position) clipPos : vec4<f32>,
    @location(0)       color   : vec3<f32>,
  };

  // Convert a world-space (t, v) to pixel coordinates on the canvas.
  fn worldToPx(t : f32, v : f32) -> vec2<f32> {
    let clip = worldToClip(t, v);
    return vec2<f32>(
      (clip.x * 0.5 + 0.5) * ru.canvasW,
      (1.0 - clip.y * 0.5 - 0.5) * ru.canvasH,
    );
  }

  @vertex
  fn vs_line(@builtin(vertex_index) vi : u32,
             @builtin(instance_index) ch : u32) -> LineVSOut {
    let sampleI = vi >> 1u;       // which sample
    let side    = vi & 1u;        // 0 = one side, 1 = other side

    let sampleIdx = (ru.writeIndex + ru.bufferSamples - ${WINDOW_SAMPLES}u + sampleI) % ru.bufferSamples;
    let base = (sampleIdx * ${MAX_CHANNELS}u + ch) * 2u;
    let t = ringBuffer[base];
    let v = ringBuffer[base + 1u];

    // Neighbouring samples for direction estimation.
    let prevIdx = (sampleIdx + ru.bufferSamples - 1u) % ru.bufferSamples;
    let nextIdx = (sampleIdx + 1u) % ru.bufferSamples;
    let prevBase = (prevIdx * ${MAX_CHANNELS}u + ch) * 2u;
    let nextBase = (nextIdx * ${MAX_CHANNELS}u + ch) * 2u;
    let prevT = ringBuffer[prevBase];
    let prevV = ringBuffer[prevBase + 1u];
    let nextT = ringBuffer[nextBase];
    let nextV = ringBuffer[nextBase + 1u];

    let px  = worldToPx(t, v);
    let prevPx = worldToPx(prevT, prevV);
    let nextPx = worldToPx(nextT, nextV);

    // Direction: centered difference, falling back to one-sided
    // when a neighbour is a sentinel (t < -1e20).
    var dx = 1.0;
    var dy = 0.0;
    let hasPrev = prevT > -1e20;
    let hasNext = nextT > -1e20;
    if (hasPrev && hasNext) {
      dx = nextPx.x - prevPx.x;
      dy = nextPx.y - prevPx.y;
    } else if (hasPrev) {
      dx = px.x - prevPx.x;
      dy = px.y - prevPx.y;
    } else if (hasNext) {
      dx = nextPx.x - px.x;
      dy = nextPx.y - px.y;
    }
    let len = max(length(vec2<f32>(dx, dy)), 0.0001);
    let dirX = dx / len;
    let dirY = dy / len;

    // Perpendicular (rotate 90°).
    let perpX = -dirY;
    let perpY = dirX;

    // Offset by ±half line width (in pixels).
    let LINE_WIDTH_PX = 2.0;
    let offset = (f32(side) * 2.0 - 1.0) * LINE_WIDTH_PX * 0.5;
    let outPx = vec2<f32>(px.x + perpX * offset, px.y + perpY * offset);

    var out : LineVSOut;
    out.clipPos = vec4<f32>(
      (outPx.x / ru.canvasW) * 2.0 - 1.0,
      1.0 - (outPx.y / ru.canvasH) * 2.0,
      0.0, 1.0,
    );
    out.color = channelColors[ch].rgb;
    return out;
  }

  @fragment
  fn fs_line(in : LineVSOut) -> @location(0) vec4<f32> {
    return vec4<f32>(in.color, 1.0);
  }

  // ── Point pipeline (circles at sample positions) ───────────────────
  // Renders a filled circle per sample per channel.  Each circle is
  // made of POINT_SEGMENTS triangles, each triangle being (center,
  // ring[i], ring[i+1]).  With triangle-list topology we need
  // POINT_SEGMENTS * 3 vertices per circle.
  struct PointVSOut {
    @builtin(position) clipPos : vec4<f32>,
    @location(0)       color   : vec3<f32>,
  };

  @vertex
  fn vs_point(@builtin(vertex_index) vi : u32,
              @builtin(instance_index) ii : u32) -> PointVSOut {
    let POINT_SEGMENTS = 12u;
    let sampleI = ii / ru.numChannels;
    let ch      = ii % ru.numChannels;

    // Each triangle uses 3 vertices: vi=0 → center, vi=1 → ring[i],
    // vi=2 → ring[i+1].  triangle_index = vi / 3, vertex_in_tri = vi % 3.
    let triIdx  = vi / 3u;
    let vertInTri = vi % 3u;

    let sampleIdx = (ru.writeIndex + ru.bufferSamples - ${WINDOW_SAMPLES}u + sampleI) % ru.bufferSamples;
    let base = (sampleIdx * ${MAX_CHANNELS}u + ch) * 2u;
    let t = ringBuffer[base];
    let v = ringBuffer[base + 1u];

    let centerPx = worldToPx(t, v);

    // Circle radius in pixels (3× line width).
    let RADIUS_PX = 6.0;

    var outPx = centerPx;
    if (vertInTri == 1u) {
      let angle = f32(triIdx) * (2.0 * 3.14159265 / f32(POINT_SEGMENTS));
      outPx = vec2<f32>(
        centerPx.x + cos(angle) * RADIUS_PX,
        centerPx.y + sin(angle) * RADIUS_PX,
      );
    } else if (vertInTri == 2u) {
      let angle = f32(triIdx + 1u) * (2.0 * 3.14159265 / f32(POINT_SEGMENTS));
      outPx = vec2<f32>(
        centerPx.x + cos(angle) * RADIUS_PX,
        centerPx.y + sin(angle) * RADIUS_PX,
      );
    }

    var out : PointVSOut;
    out.clipPos = vec4<f32>(
      (outPx.x / ru.canvasW) * 2.0 - 1.0,
      1.0 - (outPx.y / ru.canvasH) * 2.0,
      0.0, 1.0,
    );
    out.color = channelColors[ch].rgb;
    return out;
  }

  @fragment
  fn fs_point(in : PointVSOut) -> @location(0) vec4<f32> {
    return vec4<f32>(in.color, 1.0);
  }

  // ── Grid pipeline ───────────────────────────────────────────────────
  struct GridVSOut {
    @builtin(position) clipPos : vec4<f32>,
    @location(0)       canvasPx : vec2<f32>,
  };

  @vertex
  fn vs_grid(@builtin(vertex_index) vi : u32) -> GridVSOut {
    var pos = array<vec2<f32>, 6>(
      vec2<f32>(-1.0, -1.0),
      vec2<f32>( 1.0, -1.0),
      vec2<f32>( 1.0,  1.0),
      vec2<f32>(-1.0, -1.0),
      vec2<f32>( 1.0,  1.0),
      vec2<f32>(-1.0,  1.0),
    );
    var out : GridVSOut;
    out.clipPos = vec4<f32>(pos[vi], 0.0, 1.0);
    out.canvasPx = vec2<f32>(
      (pos[vi].x * 0.5 + 0.5) * ru.canvasW,
      (1.0 - pos[vi].y * 0.5 - 0.5) * ru.canvasH,
    );
    return out;
  }

  fn gridLineDistPx(coord : f32, step : f32, pxPerWorld : f32) -> f32 {
    let p = coord / step;
    let frac_p = fract(p);
    let dWorld = min(frac_p, 1.0 - frac_p);
    return dWorld * pxPerWorld;
  }

  fn gridLineIntensity(distPx : f32, width : f32) -> f32 {
    return 1.0 - smoothstep(0.0, max(width, 0.0001), distPx);
  }

  @fragment
  fn fs_grid(in : GridVSOut) -> @location(0) vec4<f32> {
    let marginColor = vec3<f32>(0.94, 0.94, 0.94);
    let plotBg = vec3<f32>(0.97, 0.97, 0.97);

    let px = in.canvasPx.x;
    let py = in.canvasPx.y;
    let inside = px >= ru.plotX && px < ru.plotX + ru.plotW
              && py >= ru.plotY && py < ru.plotY + ru.plotH;

    if (!inside) {
      return vec4<f32>(marginColor, 1.0);
    }

    let xMin = ru.viewTimeMin;
    let worldX = xMin + (px - ru.plotX) / ru.plotW * ru.viewTimeSpan;
    let worldY = ru.yMax - (py - ru.plotY) / ru.plotH * (ru.yMax - ru.yMin);

    let pxPerWorldX = ru.plotW / ru.viewTimeSpan;
    let pxPerWorldY = ru.plotH / (ru.yMax - ru.yMin);

    let minorD = min(gridLineDistPx(worldX, ru.xMajorStep * 0.5, pxPerWorldX),
                     gridLineDistPx(worldY, ru.yMajorStep * 0.5, pxPerWorldY));
    let majorD = min(gridLineDistPx(worldX, ru.xMajorStep, pxPerWorldX),
                     gridLineDistPx(worldY, ru.yMajorStep, pxPerWorldY));

    let xMinor = gridLineIntensity(minorD, 1.0);
    let xMajor = gridLineIntensity(majorD, 1.0);

    let minorColor = vec3<f32>(0.88, 0.88, 0.88);
    let majorColor = vec3<f32>(0.75, 0.75, 0.78);

    var color = plotBg;
    color = mix(color, minorColor, xMinor * 0.5);
    color = mix(color, majorColor, xMajor * 0.7);

    return vec4<f32>(color, 1.0);
  }
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// WebGPUScope
// ---------------------------------------------------------------------------

/**
 * WebGPU-based real-time oscilloscope web component.
 *
 * Replaces the canvas-based `TetherScope`.  Uses a GPU ring buffer with
 * modulo addressing and auto-scroll, MSAA anti-aliased line strips, and a
 * 2D canvas overlay for axis labels and legend.
 *
 * Based on https://techoverflow.net/2026/08/19/real-time-1-khz-webgpu-oscilloscope-with-ring-buffer-auto-scroll/
 *
 * @customElement tether-webgpu-scope
 */
export class WebGPUScope extends HTMLElement {
  // ---- WebGPU state ----
  private device?: GPUDevice;
  private ctx?: GPUCanvasContext;
  private format?: GPUTextureFormat;
  private ringBuffer?: GPUBuffer;
  /** Frozen copy of the ring buffer, used for rendering while paused. */
  private frozenBuffer?: GPUBuffer;
  private renderUniforms?: GPUBuffer;
  private colorBuffer?: GPUBuffer;
  private bindGroup?: GPUBindGroup;
  /** Bind group using the frozen buffer (active while paused). */
  private frozenBindGroup?: GPUBindGroup;
  private linePipeline?: GPURenderPipeline;
  private gridPipeline?: GPURenderPipeline;
  private pointPipeline?: GPURenderPipeline;
  private msaaTexture?: GPUTexture | null;
  private msaaSC = 0;
  private msaaW = 0;
  private msaaH = 0;
  private canvasEl?: HTMLCanvasElement;
  private overlayEl?: HTMLCanvasElement;
  private octx?: CanvasRenderingContext2D | null;
  private rafId?: number;
  private initialized = false;

  // ---- Ring buffer state ----
  /** Next sample slot to write (0..BUFFER_SAMPLES-1). */
  private writeIndex = 0;
  /** Timestamp of the most recent sample (seconds, relative to reference). */
  private currentTime = 0.0;
  /** Total samples written so far (for firstVertex calculation). */
  private sampleCounter = 0;
  /** Pending samples not yet uploaded to the GPU. */
  private pendingRows: ScopeRow[] = [];
  /**
   * Reference timestamp (µs) subtracted from all incoming timestamps.
   *
   * The WGSL shader uses f32 for timestamps.  Absolute microsecond
   * timestamps (~6×10⁵ seconds) far exceed f32 mantissa precision
   * (~7 digits), so consecutive 1 ms samples would all collapse to the
   * same f32 value and render as vertical bars.  Storing timestamps
   * relative to the first sample keeps them in the 0–5 s range where
   * f32 has sub-microsecond precision.
   */
  private referenceTimeUs: bigint | null = null;

  // ---- Channel configuration ----
  /** Number of active channels (set by setChannels). */
  private numChannels = 0;
  /** Per-channel info (name + color). */
  private channels: ChannelInfo[] = [];
  /**
   * Index of the channel highlighted by legend hover, or `null` if none.
   * When set, non-highlighted channels are desaturated and lightened
   * towards the plot background color.
   */
  private highlightedChannel: number | null = null;

  // ---- Y auto-scale ----
  /** Rolling min/max of visible samples for Y auto-scaling. */
  private yMin = -1.2;
  private yMax = 1.2;

  // ---- Pause / zoom state ----
  /** When true, the view is frozen — currentTime stops advancing. */
  private paused = false;
  /**
   * Frozen time-window left edge (seconds) when paused or zoomed.
   * When null, the view auto-scrolls to follow currentTime.
   */
  private viewTimeMin: number | null = null;
  /** Frozen time-window span (seconds) when zoomed. */
  private viewTimeSpan = WINDOW_SEC;
  /** Frozen Y range when zoomed. */
  private zoomYMin: number | null = null;
  private zoomYMax: number | null = null;
  /** Frozen copies of ring buffer state, captured at pause time. */
  private frozenWriteIndex = 0;
  private frozenSampleCounter = 0;
  private frozenCurrentTime = 0.0;
  /** Drag-rectangle zoom state (in CSS pixels relative to canvas). */
  private dragActive = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragCurX = 0;
  private dragCurY = 0;
  /** Right-click pan state. */
  private panActive = false;
  private panStartX = 0;
  private panStartY = 0;
  /** View state at the start of a pan (for delta computation). */
  private panStartTimeMin = 0;
  private panStartYMin = 0;
  private panStartYMax = 0;

  // ---- Measurement cursor state ----
  /**
   * CPU-side copy of the most recent rows for cursor measurement.  The GPU
   * ring buffer cannot be read back cheaply, so push() mirrors rows here,
   * capped at the visible window size.
   */
  private recentRows: ScopeRow[] = [];
  /** Hover crosshair position in CSS pixels, or null outside the plot. */
  private cursorHover: { x: number; y: number } | null = null;
  /**
   * Pinned measurement cursors (snapshot at pin time so the readout stays
   * stable while streaming).  At most two; a third click restarts at A.
   */
  private measureCursors: { t: number; values: number[] }[] = [];

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /** Lifecycle: element inserted into the DOM. */
  async connectedCallback(): Promise<void> {
    this.innerHTML =
      '<canvas class="realtime-plot-canvas" style="width:100%;height:100%;display:block;"></canvas>';
    this.style.position = 'relative';
    this.canvasEl = this.querySelector('canvas')!;

    await this.initWebGPU();
    if (this.initialized) {
      this.startRenderLoop();
    }
  }

  /** Lifecycle: element removed from the DOM. */
  disconnectedCallback(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.msaaTexture?.destroy();
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Set the channel configuration (names and colors).
   *
   * Must be called before pushing data.  Allocates the color buffer on the GPU.
   *
   * @param channels Array of channel info (name + RGB color).
   */
  setChannels(channels: ChannelInfo[]): void {
    this.channels = channels;
    this.numChannels = channels.length;
    if (this.device && this.colorBuffer) {
      this.writeColors();
    }
  }

  /** Toggle pause.  When paused, the view freezes at the current time. */
  togglePause(): boolean {
    this.paused = !this.paused;
    if (this.paused) {
      // Snapshot the live ring buffer into the frozen buffer so the
      // paused view is unaffected by continued data uploads.
      this.copyToFrozen();
      this.frozenWriteIndex = this.writeIndex;
      this.frozenSampleCounter = this.sampleCounter;
      this.frozenCurrentTime = this.currentTime;
      // Freeze the view at the current position.
      this.viewTimeMin = this.currentTime - WINDOW_SEC;
      this.viewTimeSpan = WINDOW_SEC;
      this.zoomYMin = null;
      this.zoomYMax = null;
    } else {
      // Resume auto-scroll — the live buffer has been recording
      // continuously, so just switch the view back.
      this.viewTimeMin = null;
      this.viewTimeSpan = WINDOW_SEC;
      this.zoomYMin = null;
      this.zoomYMax = null;
    }
    return this.paused;
  }

  /** Whether the display is paused (frozen at pause time). */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Copy the live ring buffer into the frozen buffer via the GPU
   * copy queue.  This is a GPU-side memcpy — no CPU readback.
   */
  private copyToFrozen(): void {
    if (!this.device || !this.ringBuffer || !this.frozenBuffer) return;
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.ringBuffer, 0, this.frozenBuffer, 0, this.ringBuffer.size);
    this.device.queue.submit([encoder.finish()]);
  }

  /** Reset zoom only — keeps paused state.  Returns to the full 5s window. */
  resetView(): void {
    this.viewTimeMin = null;
    this.viewTimeSpan = WINDOW_SEC;
    this.zoomYMin = null;
    this.zoomYMax = null;
  }

  /** Returns true if the view is currently zoomed or paused. */
  isViewFrozen(): boolean {
    return this.paused || this.viewTimeMin !== null;
  }

  /**
   * Push a stream row into the oscilloscope.
   *
   * The row is queued and uploaded to the GPU ring buffer on the next
   * animation frame (batched for efficiency).
   *
   * @param timestampUs Timestamp in microseconds (from StreamRow).
   * @param values      One numeric value per channel.
   */
  push(timestampUs: bigint, values: number[]): void {
    if (this.numChannels === 0) return;
    // Use relative timestamps to stay within f32 precision range.
    // Absolute timestamps (~6×10⁵ s) overflow f32 mantissa and cause
    // consecutive 1 ms samples to collapse to the same X position.
    this.referenceTimeUs ??= timestampUs;
    const t = Number(timestampUs - this.referenceTimeUs) / 1e6;
    const row = { t, values };
    this.pendingRows.push(row);
    this.recentRows.push(row);
    if (this.recentRows.length > BUFFER_SAMPLES) {
      this.recentRows.splice(0, this.recentRows.length - BUFFER_SAMPLES);
    }
    this.currentTime = t;
  }

  /** Clear all data from the oscilloscope. */
  clear(): void {
    this.pendingRows = [];
    this.recentRows = [];
    this.cursorHover = null;
    this.measureCursors = [];
    this.writeIndex = 0;
    this.currentTime = 0.0;
    this.sampleCounter = 0;
    this.yMin = -1.2;
    this.yMax = 1.2;
    this.referenceTimeUs = null;
    this.paused = false;
    this.viewTimeMin = null;
    this.viewTimeSpan = WINDOW_SEC;
    this.zoomYMin = null;
    this.zoomYMax = null;
    if (this.device && this.ringBuffer) {
      // Re-initialize ring buffer with sentinel timestamps.
      const initBuf = new Float32Array(new ArrayBuffer(BUFFER_SAMPLES * MAX_CHANNELS * 2 * 4));
      for (let i = 0; i < BUFFER_SAMPLES; i++) {
        for (let ch = 0; ch < MAX_CHANNELS; ch++) {
          const idx = (i * MAX_CHANNELS + ch) * 2;
          initBuf[idx] = -1e30;
          initBuf[idx + 1] = 0.0;
        }
      }
      this.device.queue.writeBuffer(this.ringBuffer, 0, initBuf);
    }
  }

  // =========================================================================
  // WebGPU initialization
  // =========================================================================

  /** Initialize WebGPU device, buffers, pipelines, and overlay canvas. */
  private async initWebGPU(): Promise<void> {
    const canvas = this.canvasEl!;

    if (!navigator.gpu) {
      canvas.replaceWith(document.createTextNode('WebGPU is not supported in this browser.'));
      return;
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      canvas.replaceWith(document.createTextNode('No WebGPU adapter available.'));
      return;
    }

    const device = await adapter.requestDevice();
    this.device = device;
    this.ctx = canvas.getContext('webgpu')!;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({ device, format: this.format, alphaMode: 'premultiplied' });

    const module = device.createShaderModule({ code: SHADER });

    // Bind group layout: uniforms + ring buffer + color buffer.
    const renderLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'read-only-storage' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'read-only-storage' },
        },
      ],
    });

    // Probe MSAA sample counts and create pipelines.
    const supportedSC: number[] = [];
    const linePipelines: GPURenderPipeline[] = [];
    const gridPipelines: GPURenderPipeline[] = [];
    const pointPipelines: GPURenderPipeline[] = [];
    const layout = device.createPipelineLayout({ bindGroupLayouts: [renderLayout] });
    const format = this.format!;
    const pipelineResults = await Promise.all(
      MSAA_SAMPLE_COUNTS.map(async (sampleCount) => {
        try {
          const pipelines = await Promise.all([
            device.createRenderPipelineAsync({
              layout,
              vertex: { module, entryPoint: 'vs_line' },
              fragment: { module, entryPoint: 'fs_line', targets: [{ format }] },
              primitive: { topology: 'triangle-strip' },
              multisample: { count: sampleCount },
            }),
            device.createRenderPipelineAsync({
              layout,
              vertex: { module, entryPoint: 'vs_grid' },
              fragment: { module, entryPoint: 'fs_grid', targets: [{ format }] },
              primitive: { topology: 'triangle-list' },
              multisample: { count: sampleCount },
            }),
            device.createRenderPipelineAsync({
              layout,
              vertex: { module, entryPoint: 'vs_point' },
              fragment: { module, entryPoint: 'fs_point', targets: [{ format }] },
              primitive: { topology: 'triangle-list' },
              multisample: { count: sampleCount },
            }),
          ]);
          return { sampleCount, pipelines };
        } catch {
          // Unsupported sample count — skip.
          return null;
        }
      }),
    );
    for (const result of pipelineResults) {
      if (!result) continue;
      supportedSC.push(result.sampleCount);
      linePipelines.push(result.pipelines[0]);
      gridPipelines.push(result.pipelines[1]);
      pointPipelines.push(result.pipelines[2]);
    }

    // Prefer 4× MSAA; fall back to highest available.
    let msaaIndex = supportedSC.length - 1;
    const targetIdx = supportedSC.indexOf(TARGET_MSAA);
    if (targetIdx !== -1) msaaIndex = targetIdx;

    // Ring buffer: (t, v) for MAX_CHANNELS channels, interleaved per sample.
    const bufferFloats = BUFFER_SAMPLES * MAX_CHANNELS * 2;
    const bufferBytes = bufferFloats * 4;
    this.ringBuffer = device.createBuffer({
      size: bufferBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });

    // Render uniforms (64 bytes: 12 × f32 + 4 × u32, 16-byte aligned).
    this.renderUniforms = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Channel colors storage buffer: MAX_CHANNELS × vec4<f32>.
    this.colorBuffer = device.createBuffer({
      size: MAX_CHANNELS * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Initialize ring buffer with sentinel timestamps (far off-screen).
    const initBuf = new Float32Array(new ArrayBuffer(bufferFloats * 4));
    for (let i = 0; i < BUFFER_SAMPLES; i++) {
      for (let ch = 0; ch < MAX_CHANNELS; ch++) {
        const idx = (i * MAX_CHANNELS + ch) * 2;
        initBuf[idx] = -1e30;
        initBuf[idx + 1] = 0.0;
      }
    }
    device.queue.writeBuffer(this.ringBuffer, 0, initBuf);

    // Frozen buffer: same size as ring buffer, used as a snapshot
    // while paused.  Needs COPY_DST for the copyBufferToBuffer call.
    this.frozenBuffer = device.createBuffer({
      size: bufferBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.frozenBuffer, 0, initBuf);

    // Write channel colors (defaults if setChannels not yet called).
    this.writeColors();

    this.bindGroup = device.createBindGroup({
      layout: renderLayout,
      entries: [
        { binding: 0, resource: { buffer: this.renderUniforms } },
        { binding: 1, resource: { buffer: this.ringBuffer } },
        { binding: 2, resource: { buffer: this.colorBuffer } },
      ],
    });

    this.frozenBindGroup = device.createBindGroup({
      layout: renderLayout,
      entries: [
        { binding: 0, resource: { buffer: this.renderUniforms } },
        { binding: 1, resource: { buffer: this.frozenBuffer } },
        { binding: 2, resource: { buffer: this.colorBuffer } },
      ],
    });

    this.linePipeline = linePipelines[msaaIndex]!;
    this.gridPipeline = gridPipelines[msaaIndex]!;
    this.pointPipeline = pointPipelines[msaaIndex]!;
    this.msaaSC = supportedSC[msaaIndex] ?? 1;

    // 2D canvas overlay for axis labels + legend.
    this.overlayEl = document.createElement('canvas');
    this.overlayEl.style.position = 'absolute';
    this.overlayEl.style.left = '0';
    this.overlayEl.style.top = '0';
    this.overlayEl.style.width = '100%';
    this.overlayEl.style.height = '100%';
    this.overlayEl.style.pointerEvents = 'none';
    this.appendChild(this.overlayEl);
    this.octx = this.overlayEl.getContext('2d');

    // Legend hover detection + drag-zoom + right-click pan: the overlay
    // itself has pointerEvents:none, so attach mouse listeners to the
    // scope container.
    this.addEventListener('mousedown', (e: MouseEvent) => {
      const rect = this.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      // Only start inside the plot area.
      const ml = MARGIN_LEFT;
      const mr = MARGIN_RIGHT;
      const mt = MARGIN_TOP;
      const mb = MARGIN_BOTTOM;
      const pw = rect.width - ml - mr;
      const ph = rect.height - mt - mb;
      if (x < ml || x >= ml + pw || y < mt || y >= mt + ph) return;

      if (e.button === 2) {
        // Right-click: start panning.  Freeze the view if not already.
        if (!this.paused) {
          this.paused = true;
          this.copyToFrozen();
          this.frozenWriteIndex = this.writeIndex;
          this.frozenSampleCounter = this.sampleCounter;
          this.frozenCurrentTime = this.currentTime;
          this.viewTimeMin = this.currentTime - WINDOW_SEC;
          this.viewTimeSpan = WINDOW_SEC;
        }
        this.panActive = true;
        this.panStartX = x;
        this.panStartY = y;
        this.panStartTimeMin = this.viewTimeMin ?? 0;
        this.panStartYMin = this.zoomYMin ?? this.yMin;
        this.panStartYMax = this.zoomYMax ?? this.yMax;
        e.preventDefault();
      } else if (e.button === 0) {
        // Left-click: start drag-zoom rectangle.
        this.dragActive = true;
        this.dragStartX = x;
        this.dragStartY = y;
        this.dragCurX = x;
        this.dragCurY = y;
        e.preventDefault();
      }
    });
    this.addEventListener('contextmenu', (e: MouseEvent) => e.preventDefault());
    this.addEventListener('mousemove', (e: MouseEvent) => {
      const rect = this.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (this.panActive) {
        // Pan: convert pixel delta to world delta.
        const ml = MARGIN_LEFT;
        const mr = MARGIN_RIGHT;
        const mt = MARGIN_TOP;
        const mb = MARGIN_BOTTOM;
        const pw = rect.width - ml - mr;
        const ph = rect.height - mt - mb;
        const dxPx = x - this.panStartX;
        const dyPx = y - this.panStartY;
        const timeDelta = (dxPx / pw) * this.viewTimeSpan;
        const yDelta = (dyPx / ph) * (this.panStartYMax - this.panStartYMin);
        this.viewTimeMin = this.panStartTimeMin - timeDelta;
        this.zoomYMin = this.panStartYMin + yDelta;
        this.zoomYMax = this.panStartYMax + yDelta;
      } else if (this.dragActive) {
        this.dragCurX = x;
        this.dragCurY = y;
      } else {
        this.updateLegendHover(x, y);
        this.updateCursorHover(x, y, rect);
      }
    });
    this.addEventListener('mouseup', (e: MouseEvent) => {
      if (e.button === 2 && this.panActive) {
        this.panActive = false;
      }
      if (e.button === 0 && this.dragActive) {
        this.dragActive = false;
        const moved = Math.hypot(this.dragCurX - this.dragStartX, this.dragCurY - this.dragStartY);
        if (moved < 4) this.pinCursor(this.dragStartX);
        else this.applyDragZoom();
      }
    });
    this.addEventListener('mouseleave', () => {
      this.cursorHover = null;
      if (this.dragActive) {
        this.dragActive = false;
      }
      if (this.panActive) {
        this.panActive = false;
      }
      if (this.highlightedChannel !== null) {
        this.highlightedChannel = null;
        this.writeColors();
      }
    });

    this.initialized = true;
  }

  /**
   * Apply zoom from the drag rectangle.  Converts the drag rectangle
   * (in CSS pixels) to world coordinates and sets the frozen view.
   */
  private applyDragZoom(): void {
    if (!this.canvasEl) return;
    const cssW = this.canvasEl.clientWidth;
    const ml = MARGIN_LEFT;
    const mr = MARGIN_RIGHT;
    const mt = MARGIN_TOP;
    const mb = MARGIN_BOTTOM;
    const pw = cssW - ml - mr;
    const ph = this.canvasEl.clientHeight - mt - mb;

    // Normalise the rectangle.
    const x0 = Math.min(this.dragStartX, this.dragCurX);
    const x1 = Math.max(this.dragStartX, this.dragCurX);
    const y0 = Math.min(this.dragStartY, this.dragCurY);
    const y1 = Math.max(this.dragStartY, this.dragCurY);

    // Ignore tiny drags (clicks).
    if (x1 - x0 < 4 || y1 - y0 < 4) return;

    // Current view bounds.
    const curMin = this.viewTimeMin ?? this.currentTime - WINDOW_SEC;
    const curSpan = this.viewTimeSpan;
    const curYMin = this.zoomYMin ?? this.yMin;
    const curYMax = this.zoomYMax ?? this.yMax;

    // Convert pixel rect to world coordinates.
    const newTimeMin = curMin + ((x0 - ml) / pw) * curSpan;
    const newTimeMax = curMin + ((x1 - ml) / pw) * curSpan;
    const newYMax = curYMax - ((y0 - mt) / ph) * (curYMax - curYMin);
    const newYMin = curYMax - ((y1 - mt) / ph) * (curYMax - curYMin);

    this.viewTimeMin = newTimeMin;
    this.viewTimeSpan = newTimeMax - newTimeMin;
    this.zoomYMin = newYMin;
    this.zoomYMax = newYMax;
    // Zooming implies paused — snapshot the buffer if not already paused.
    if (!this.paused) {
      this.paused = true;
      this.copyToFrozen();
      this.frozenWriteIndex = this.writeIndex;
      this.frozenSampleCounter = this.sampleCounter;
      this.frozenCurrentTime = this.currentTime;
    }
  }

  /** Write channel colors to the GPU color buffer. */
  private writeColors(): void {
    if (!this.device || !this.colorBuffer) return;
    const colorData = new Float32Array(new ArrayBuffer(MAX_CHANNELS * 4 * 4));
    for (let ch = 0; ch < MAX_CHANNELS; ch++) {
      let color: [number, number, number] =
        ch < this.channels.length ? this.channels[ch]!.color : [0.5, 0.5, 0.5];
      // Dim non-highlighted channels when one is highlighted.
      if (this.highlightedChannel !== null && ch !== this.highlightedChannel) {
        color = dimColor(color, 0.7);
      }
      colorData[ch * 4] = color[0]!;
      colorData[ch * 4 + 1] = color[1]!;
      colorData[ch * 4 + 2] = color[2]!;
      colorData[ch * 4 + 3] = 1.0;
    }
    this.device.queue.writeBuffer(this.colorBuffer, 0, colorData);
  }

  // =========================================================================
  // Data upload
  // =========================================================================

  /**
   * Upload all pending rows to the GPU ring buffer.
   * Called once per animation frame (batches multiple push() calls).
   */
  private flushPending(): void {
    if (!this.device || !this.ringBuffer) return;
    const count = this.pendingRows.length;
    if (count === 0) return;

    // Update the scale while the batch is still available. The upload then
    // clears pendingRows, so doing this in the render loop afterward loses
    // every sample before the autoscaler can inspect it.
    this.updateYScale();

    // Build one contiguous upload buffer for all pending rows, then write it
    // in at most two pieces (before/after the ring wraparound).  This avoids
    // the per-sample race from reusing the same typed-array view.
    const floatsPerSample = MAX_CHANNELS * 2;
    const data = new Float32Array(count * floatsPerSample);
    for (let i = 0; i < count; i++) {
      const row = this.pendingRows[i]!;
      for (let ch = 0; ch < MAX_CHANNELS; ch++) {
        const hasValue = ch < row.values.length;
        const idx = i * floatsPerSample + ch * 2;
        data[idx] = hasValue ? row.t : -1e30;
        data[idx + 1] = hasValue ? (row.values[ch] ?? 0.0) : 0.0;
      }
    }

    const start = this.writeIndex;
    const fits = Math.min(count, BUFFER_SAMPLES - start);
    if (fits > 0) {
      this.device.queue.writeBuffer(
        this.ringBuffer,
        start * floatsPerSample * 4,
        data.subarray(0, fits * floatsPerSample),
      );
    }
    if (count > fits) {
      this.device.queue.writeBuffer(this.ringBuffer, 0, data.subarray(fits * floatsPerSample));
    }

    this.writeIndex = (this.writeIndex + count) % BUFFER_SAMPLES;
    this.sampleCounter += count;
    this.pendingRows = [];
  }

  // =========================================================================
  // Y auto-scale
  // =========================================================================

  /**
   * Compute Y min/max from the visible window of samples.
   * Called each frame to auto-scale the Y axis.
   */
  private updateYScale(): void {
    if (this.numChannels === 0 || this.pendingRows.length === 0) return;
    const bounds = finiteValueRange(this.pendingRows, this.numChannels);
    if (!bounds) return;
    const range = bounds.max - bounds.min || 1;
    const padding = range * 0.1;
    const targetMin = bounds.min - padding;
    const targetMax = bounds.max + padding;
    this.yMin += (targetMin - this.yMin) * 0.1;
    this.yMax += (targetMax - this.yMax) * 0.1;
  }

  // =========================================================================
  // MSAA texture management
  // =========================================================================

  /** Ensure the MSAA texture matches the canvas size and sample count. */
  private ensureMsaa(w: number, h: number, sc: number): void {
    if (!this.device || !this.format) return;
    if (sc === 1) {
      if (this.msaaTexture) {
        this.msaaTexture.destroy();
        this.msaaTexture = null;
      }
      this.msaaSC = 1;
      this.msaaW = w;
      this.msaaH = h;
      return;
    }
    if (this.msaaTexture && this.msaaSC === sc && this.msaaW === w && this.msaaH === h) return;
    if (this.msaaTexture) this.msaaTexture.destroy();
    this.msaaTexture = this.device.createTexture({
      size: [w, h, 1],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
      sampleCount: sc,
    });
    this.msaaSC = sc;
    this.msaaW = w;
    this.msaaH = h;
  }

  // =========================================================================
  // Render loop
  // =========================================================================

  /** Start the requestAnimationFrame render loop. */
  private startRenderLoop(): void {
    const frame = () => {
      this.flushPending();
      this.render();
      this.rafId = requestAnimationFrame(frame);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  /** Render one frame: grid + line strips + points + axis overlay. */
  private render(): void {
    if (
      !this.device ||
      !this.ctx ||
      !this.canvasEl ||
      !this.renderUniforms ||
      !this.bindGroup ||
      !this.frozenBindGroup ||
      !this.linePipeline ||
      !this.gridPipeline ||
      !this.pointPipeline
    )
      return;

    const canvas = this.canvasEl;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const ch = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }

    const ml = MARGIN_LEFT * dpr;
    const mr = MARGIN_RIGHT * dpr;
    const mt = MARGIN_TOP * dpr;
    const mb = MARGIN_BOTTOM * dpr;
    const plotX = ml;
    const plotY = mt;
    const plotW = Math.max(1, cw - ml - mr);
    const plotH = Math.max(1, ch - mt - mb);

    // When paused, render from the frozen snapshot.  The live buffer
    // keeps recording new data in the background.
    const activeBindGroup = this.paused ? this.frozenBindGroup : this.bindGroup;
    const activeWriteIndex = this.paused ? this.frozenWriteIndex : this.writeIndex;
    const activeSampleCounter = this.paused ? this.frozenSampleCounter : this.sampleCounter;
    const activeCurrentTime = this.paused ? this.frozenCurrentTime : this.currentTime;

    // Determine the effective view bounds.
    const viewMin = this.viewTimeMin ?? activeCurrentTime - WINDOW_SEC;
    const viewSpan = this.viewTimeSpan;
    const effYMin = this.zoomYMin ?? this.yMin;
    const effYMax = this.zoomYMax ?? this.yMax;

    const sc = this.msaaSC;
    const xMajorStep = niceStep(viewSpan, 8);
    const yMajorStep = niceStep(effYMax - effYMin, 6);

    // Write render uniforms (12 × f32).
    const ruData = new Float32Array(new ArrayBuffer(12 * 4));
    ruData[0] = viewMin;
    ruData[1] = viewSpan;
    ruData[2] = effYMin;
    ruData[3] = effYMax;
    ruData[4] = plotX;
    ruData[5] = plotY;
    ruData[6] = plotW;
    ruData[7] = plotH;
    ruData[8] = cw;
    ruData[9] = ch;
    ruData[10] = xMajorStep;
    ruData[11] = yMajorStep;
    this.device.queue.writeBuffer(this.renderUniforms, 0, ruData);

    // Write writeIndex, bufferSamples, numChannels, pad as u32 at offset 48.
    const bufInfo = new Uint32Array(new ArrayBuffer(4 * 4));
    bufInfo[0] = activeWriteIndex;
    bufInfo[1] = BUFFER_SAMPLES;
    bufInfo[2] = this.numChannels;
    bufInfo[3] = 0; // padding
    this.device.queue.writeBuffer(this.renderUniforms, 48, bufInfo);

    this.ensureMsaa(cw, ch, sc);

    const encoder = this.device.createCommandEncoder();
    const canvasView = this.ctx.getCurrentTexture().createView();
    let colorAttachment: GPURenderPassColorAttachment;
    if (sc > 1 && this.msaaTexture) {
      colorAttachment = {
        view: this.msaaTexture.createView(),
        resolveTarget: canvasView,
        clearValue: { r: 0.94, g: 0.94, b: 0.94, a: 1 },
        loadOp: 'clear',
        storeOp: 'discard',
      };
    } else {
      colorAttachment = {
        view: canvasView,
        clearValue: { r: 0.94, g: 0.94, b: 0.94, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      };
    }

    const rp = encoder.beginRenderPass({ colorAttachments: [colorAttachment] });

    // 1) Grid background.
    rp.setPipeline(this.gridPipeline);
    rp.setBindGroup(0, activeBindGroup);
    rp.draw(6);

    // 2) Line strips — single instanced draw, one instance per channel.
    // Clip to the plot area so traces do not spill into the left/right margins.
    if (this.numChannels > 0) {
      rp.setScissorRect(plotX, plotY, plotW, plotH);
      rp.setPipeline(this.linePipeline);
      rp.setBindGroup(0, activeBindGroup);
      const validSamples = Math.min(activeSampleCounter, WINDOW_SAMPLES);
      // Each sample generates 2 vertices (one per side of the thick line).
      const vertexCount = Math.max(0, validSamples * 2 - 2);
      const firstVertex = (WINDOW_SAMPLES - validSamples) * 2;
      rp.draw(vertexCount, this.numChannels, firstVertex, 0);

      // 3) Points — render dots at every sample when the visible sample
      //    count is low enough (< 250 per channel) AND the view is
      //    zoomed in beyond the default 5s window.  At full zoom-out
      //    dots are never shown — they would just blur into the line.
      // Estimate visible samples: sample rate × visible time span.
      const sampleRate = WINDOW_SAMPLES / WINDOW_SEC; // ~1000 Hz
      const estVisible = Math.min(validSamples, Math.ceil(sampleRate * viewSpan));
      const isZoomedIn = viewSpan < WINDOW_SEC - 1e-6;
      if (isZoomedIn && estVisible < 250) {
        const POINT_SEGMENTS = 12;
        const vertsPerCircle = POINT_SEGMENTS * 3;
        const pointInstances = validSamples * this.numChannels;
        // Offset instances to start at the first valid sample, matching
        // the line shader's firstVertex = (WINDOW_SAMPLES - validSamples) * 2.
        const firstInstance = (WINDOW_SAMPLES - validSamples) * this.numChannels;
        rp.setPipeline(this.pointPipeline);
        rp.setBindGroup(0, activeBindGroup);
        rp.draw(vertsPerCircle, pointInstances, 0, firstInstance);
      }
    }

    rp.end();
    this.device.queue.submit([encoder.finish()]);

    // Draw axis labels + legend + drag rectangle on the 2D overlay.
    this.drawAxes(canvas.clientWidth, canvas.clientHeight, dpr, activeCurrentTime);
  }

  // =========================================================================
  // Axis labels & legend (2D canvas overlay)
  // =========================================================================

  /** Draw axis labels, channel legend, and drag selection on the overlay. */
  private drawAxes(cssW: number, cssH: number, dpr: number, activeCurrentTime: number): void {
    if (!this.overlayEl || !this.octx || !this.canvasEl) return;
    drawScopeOverlay({
      canvas: this.canvasEl,
      overlay: this.overlayEl,
      context: this.octx,
      cssWidth: cssW,
      cssHeight: cssH,
      pixelRatio: dpr,
      activeCurrentTime,
      viewTimeMin: this.viewTimeMin,
      viewTimeSpan: this.viewTimeSpan,
      yMin: this.yMin,
      yMax: this.yMax,
      zoomYMin: this.zoomYMin,
      zoomYMax: this.zoomYMax,
      channels: this.channels,
      highlightedChannel: this.highlightedChannel,
      dragActive: this.dragActive,
      dragStartX: this.dragStartX,
      dragStartY: this.dragStartY,
      dragCurrentX: this.dragCurX,
      dragCurrentY: this.dragCurY,
      ...this.cursorOverlayState(),
    });
  }

  /**
   * Build the crosshair/pinned-cursor overlay state: hover readout at the
   * nearest sample, pinned cursor positions, and the A↔B delta block.
   */
  private cursorOverlayState(): {
    crosshairX: number | null;
    crosshairY: number | null;
    crosshairLines: string[];
    cursors: { x: number; label: string }[];
    measureLines: string[];
  } {
    const names = this.channels.map((c) => c.name);
    let crosshairX: number | null = null;
    let crosshairY: number | null = null;
    let crosshairLines: string[] = [];
    if (this.cursorHover) {
      crosshairX = this.cursorHover.x;
      crosshairY = this.cursorHover.y;
      const t = this.timeAtCssX(this.cursorHover.x);
      if (t !== null) {
        const idx = nearestRowIndex(this.recentRows, t);
        if (idx >= 0) crosshairLines = describeCursor(this.recentRows[idx]!, names);
      }
    }
    const cursors: { x: number; label: string }[] = [];
    for (const [i, cursor] of this.measureCursors.entries()) {
      const x = this.cssXAtTime(cursor.t);
      if (x !== null) cursors.push({ x, label: i === 0 ? 'A' : 'B' });
    }
    const measureLines =
      this.measureCursors.length >= 2
        ? describeDelta(this.measureCursors[0]!, this.measureCursors[1]!, names)
        : [];
    return { crosshairX, crosshairY, crosshairLines, cursors, measureLines };
  }

  /**
   * Track the hover crosshair while the pointer is inside the plot area.
   * Hidden when panning, dragging, or outside the plot.
   */
  private updateCursorHover(x: number, y: number, rect: DOMRect): void {
    const pw = rect.width - MARGIN_LEFT - MARGIN_RIGHT;
    const ph = rect.height - MARGIN_TOP - MARGIN_BOTTOM;
    if (x >= MARGIN_LEFT && x < MARGIN_LEFT + pw && y >= MARGIN_TOP && y < MARGIN_TOP + ph) {
      this.cursorHover = { x, y };
    } else {
      this.cursorHover = null;
    }
  }

  /**
   * Left-click (non-drag) pins a measurement cursor at the nearest sample.
   * First click sets A, second sets B, a third clears both and restarts at A.
   * Snapshot values are captured now so the readout stays stable while live
   * data scrolls the pinned timestamp off-screen.
   */
  private pinCursor(cssX: number): void {
    const t = this.timeAtCssX(cssX);
    if (t === null) return;
    const idx = nearestRowIndex(this.recentRows, t);
    const row = idx >= 0 ? this.recentRows[idx]! : null;
    if (this.measureCursors.length >= 2) this.measureCursors = [];
    this.measureCursors.push({ t: row?.t ?? t, values: row?.values ?? [] });
    this.measureCursors.sort((a, b) => a.t - b.t);
  }

  /** Convert a CSS-pixel X position to the relative timestamp shown there. */
  private timeAtCssX(cssX: number): number | null {
    const w = this.canvasEl?.clientWidth ?? 0;
    const pw = w - MARGIN_LEFT - MARGIN_RIGHT;
    if (pw <= 0) return null;
    const now = this.paused ? this.frozenCurrentTime : this.currentTime;
    const viewMin = this.viewTimeMin ?? now - WINDOW_SEC;
    return viewMin + ((cssX - MARGIN_LEFT) / pw) * this.viewTimeSpan;
  }

  /** Inverse of {@link timeAtCssX} — pixel X for a timestamp, or null. */
  private cssXAtTime(t: number): number | null {
    const w = this.canvasEl?.clientWidth ?? 0;
    const pw = w - MARGIN_LEFT - MARGIN_RIGHT;
    if (pw <= 0) return null;
    const now = this.paused ? this.frozenCurrentTime : this.currentTime;
    const viewMin = this.viewTimeMin ?? now - WINDOW_SEC;
    return MARGIN_LEFT + ((t - viewMin) / this.viewTimeSpan) * pw;
  }

  /**
   * Check whether the given CSS-pixel coordinates are over a legend item
   * and update `highlightedChannel` accordingly.  Called on mousemove.
   */
  private updateLegendHover(mouseX: number, mouseY: number): void {
    if (!this.canvasEl || !this.overlayEl) return;
    const newHighlight = legendChannelAtPoint(
      mouseX,
      mouseY,
      this.canvasEl.clientWidth,
      this.numChannels,
    );
    if (newHighlight !== this.highlightedChannel) {
      this.highlightedChannel = newHighlight;
      this.writeColors();
    }
  }
}

customElements.define('tether-webgpu-scope', WebGPUScope);
