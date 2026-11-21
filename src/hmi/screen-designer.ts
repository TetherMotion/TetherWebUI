/**
 * <hmi-screen-designer> — freeform HMI screen editor.
 *
 * Fixed design surface (screen.w x screen.h) with absolutely-positioned
 * widgets from a palette. Click selects, drag moves (4px snap), the SE
 * handle resizes, Del removes. The right-hand panel edits kind-specific
 * props and binds `signal` to a catalog key; live `values` drive the
 * preview so the screen shows real PLC data while designing.
 *
 * Emits `change` with the screen JSON on every mutation; the host owns
 * persistence (localStorage helpers live in ./screen.ts).
 */
import { LitElement, html, nothing, TemplateResult } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { sceneToSvg } from './scene';
import {
  HmiScreen, ScreenWidget, ScreenWidgetKind, ScreenValues,
  SCREEN_KINDS, defaultScreen, widgetScene,
} from './screen';

const SNAP = 4;
const MIN_W = 24, MIN_H = 20;

export class HmiScreenDesigner extends LitElement {
  declare screen: HmiScreen;
  /** catalog signal keys offered in the binding dropdown */
  declare signals: string[];
  /** live values for preview (catalog key → value) */
  declare values: ScreenValues;

  static properties = {
    screen: { attribute: false },
    signals: { attribute: false },
    values: { attribute: false },
  };

  private selId = 0;
  private viewW = 800;
  private ro?: ResizeObserver;
  private drag?: {
    id: number; mode: 'move' | 'resize';
    sx: number; sy: number; ox: number; oy: number; ow: number; oh: number;
  };
  private sceneCache = new Map<number, string>();

  constructor() {
    super();
    this.screen = defaultScreen();
    this.signals = [];
    this.values = {};
  }

  createRenderRoot(): this { return this; }

  firstUpdated(): void {
    const outer = this.querySelector<HTMLElement>('.hmi-d-outer');
    if (outer && typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => {
        this.viewW = outer.clientWidth || this.viewW;
        this.requestUpdate();
      });
      this.ro.observe(outer);
      this.viewW = outer.clientWidth || this.viewW;
    }
  }

  disconnectedCallback(): void {
    this.ro?.disconnect();
    super.disconnectedCallback();
  }

  private get scale(): number {
    return this.viewW > 0 ? this.viewW / this.screen.w : 1;
  }

  private emit(): void {
    this.sceneCache.clear();
    this.dispatchEvent(new CustomEvent('change', {
      detail: JSON.stringify(this.screen), bubbles: true, composed: true,
    }));
    this.requestUpdate();
  }

  private sel(): ScreenWidget | undefined {
    return this.screen.widgets.find((w) => w.id === this.selId);
  }

  // ---- widget ops ----------------------------------------------------

  private addWidget(kind: ScreenWidgetKind): void {
    const def = SCREEN_KINDS.find((k) => k.kind === kind)!;
    const id = Math.max(0, ...this.screen.widgets.map((w) => w.id)) + 1;
    this.screen.widgets.push({
      id, kind,
      x: Math.round((this.screen.w - def.defW) / 2 / SNAP) * SNAP,
      y: Math.round((this.screen.h - def.defH) / 2 / SNAP) * SNAP,
      w: def.defW, h: def.defH,
      label: kind === 'text' ? 'Text' : kind === 'lamp' ? 'RUN' : undefined,
      text: kind === 'text' ? 'Static text' : undefined,
      min: kind === 'gauge' || kind === 'bar' || kind === 'digital' ? 0 : undefined,
      max: kind === 'gauge' || kind === 'bar' || kind === 'digital' ? 100 : undefined,
      decimals: 1,
    });
    this.selId = id;
    this.emit();
  }

  private delWidget(id: number): void {
    this.screen.widgets = this.screen.widgets.filter((w) => w.id !== id);
    if (this.selId === id) this.selId = 0;
    this.emit();
  }

  // ---- pointer handling ----------------------------------------------

  /** client px → screen units via the layer's post-transform rect. */
  private svgPoint(e: PointerEvent, layer: HTMLElement): { x: number; y: number } {
    const r = layer.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * this.screen.w,
      y: ((e.clientY - r.top) / r.height) * this.screen.h,
    };
  }

  private onCanvasDown(e: PointerEvent): void {
    const layer = e.currentTarget as HTMLElement;
    const p = this.svgPoint(e, layer);
    const w = [...this.screen.widgets].reverse().find(
      (x) => p.x >= x.x && p.x <= x.x + x.w && p.y >= x.y && p.y <= x.y + x.h,
    );
    if (!w) { this.selId = 0; this.requestUpdate(); return; }
    this.selId = w.id;
    const onHandle = p.x > w.x + w.w - 14 && p.y > w.y + w.h - 14;
    this.drag = {
      id: w.id, mode: onHandle ? 'resize' : 'move',
      sx: p.x, sy: p.y, ox: w.x, oy: w.y, ow: w.w, oh: w.h,
    };
    layer.setPointerCapture(e.pointerId);
    this.requestUpdate();
  }

  private onCanvasMove(e: PointerEvent): void {
    if (!this.drag) return;
    const layer = e.currentTarget as HTMLElement;
    const p = this.svgPoint(e, layer);
    const w = this.screen.widgets.find((x) => x.id === this.drag!.id);
    if (!w) return;
    const dx = p.x - this.drag.sx, dy = p.y - this.drag.sy;
    if (this.drag.mode === 'move') {
      w.x = Math.max(0, Math.round((this.drag.ox + dx) / SNAP) * SNAP);
      w.y = Math.max(0, Math.round((this.drag.oy + dy) / SNAP) * SNAP);
    } else {
      w.w = Math.max(MIN_W, Math.round((this.drag.ow + dx) / SNAP) * SNAP);
      w.h = Math.max(MIN_H, Math.round((this.drag.oh + dy) / SNAP) * SNAP);
    }
    this.sceneCache.delete(w.id);
    this.requestUpdate();
  }

  private onCanvasUp(e: PointerEvent): void {
    if (this.drag) {
      this.drag = undefined;
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
      this.emit();
    }
  }

  protected onKeyDown(e: KeyboardEvent): void {
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selId) {
      this.delWidget(this.selId);
      e.preventDefault();
    }
  }

  // ---- property edits -------------------------------------------------

  private setProp(k: string, v: unknown): void {
    const w = this.sel();
    if (!w) return;
    const rec = w as unknown as Record<string, unknown>;
    if (v === undefined || v === '') delete rec[k];
    else rec[k] = v;
    this.emit();
  }

  private numProp(k: string, raw: string): void {
    const v = raw.trim() === '' ? undefined : Number(raw);
    this.setProp(k, Number.isFinite(v) ? v : undefined);
  }

  // ---- render ---------------------------------------------------------

  private widgetSvg(w: ScreenWidget): string {
    const hit = this.sceneCache.get(w.id);
    if (hit) return hit;
    const svg = sceneToSvg(widgetScene(w, this.values), 'hmi-scene-svg');
    this.sceneCache.set(w.id, svg);
    return svg;
  }

  render(): TemplateResult {
    const s = this.screen;
    const sel = this.sel();
    const k = this.scale;
    return html`
      <div class="hmi-designer" @keydown=${(e: KeyboardEvent) => this.onKeyDown(e)} tabindex="0">
        <div class="hmi-d-left">
          <div class="hmi-d-palette">
            ${SCREEN_KINDS.map((kd) => html`
              <button class="chip-btn" @click=${() => this.addWidget(kd.kind)}>${kd.label}</button>
            `)}
          </div>
          <div class="hmi-d-outer" style="height:${(s.h * k).toFixed(1)}px">
            <div class="hmi-d-layer"
                 style="width:${s.w}px;height:${s.h}px;transform:scale(${k})"
                 @pointerdown=${(e: PointerEvent) => this.onCanvasDown(e)}
                 @pointermove=${(e: PointerEvent) => this.onCanvasMove(e)}
                 @pointerup=${(e: PointerEvent) => this.onCanvasUp(e)}>
              ${s.widgets.map((w) => html`
                <div class="hmi-d-wdg ${w.id === this.selId ? 'sel' : ''}"
                     style="left:${w.x}px;top:${w.y}px;width:${w.w}px;height:${w.h}px"
                     @pointerdown=${(e: PointerEvent) => { e.stopPropagation(); this.onCanvasDown(e); }}>
                  ${unsafeHTML(this.widgetSvg(w))}
                  ${w.id === this.selId ? html`<div class="hmi-d-rsz"></div>` : nothing}
                </div>
              `)}
            </div>
          </div>
        </div>
        <div class="hmi-d-props">
          ${sel ? this.propsPanel(sel) : html`<p class="plc-dim">Select a widget.</p>`}
        </div>
      </div>
    `;
  }

  private propsPanel(w: ScreenWidget): TemplateResult {
    const numIn = (key: string, label: string) => html`
      <label>${label}<input type="number" step="any"
        .value=${(w as unknown as Record<string, unknown>)[key] ?? ''}
        @change=${(e: Event) => this.numProp(key, (e.target as HTMLInputElement).value)} /></label>`;
    const showRange = w.kind === 'gauge' || w.kind === 'bar' || w.kind === 'digital';
    return html`
      <h4>${SCREEN_KINDS.find((kd) => kd.kind === w.kind)?.label ?? w.kind}
        <button class="chip-btn" @click=${() => this.delWidget(w.id)}>delete</button></h4>
      <label>Label<input .value=${w.label ?? ''}
        @change=${(e: Event) => this.setProp('label', (e.target as HTMLInputElement).value)} /></label>
      ${w.kind === 'text' ? html`
        <label>Text<input .value=${w.text ?? ''}
          @change=${(e: Event) => this.setProp('text', (e.target as HTMLInputElement).value)} /></label>` : nothing}
      <label>Signal
        <select .value=${w.signal ?? ''}
          @change=${(e: Event) => this.setProp('signal', (e.target as HTMLSelectElement).value)}>
          <option value="">— unbound —</option>
          ${this.signals.map((sg) => html`<option value=${sg} ?selected=${sg === w.signal}>${sg}</option>`)}
          ${w.signal && !this.signals.includes(w.signal)
            ? html`<option value=${w.signal} selected>${w.signal}</option>` : nothing}
        </select></label>
      ${showRange ? html`
        ${numIn('min', 'min')}${numIn('max', 'max')}${numIn('warn', 'warn ≥')}
        ${numIn('crit', 'crit ≥')}${numIn('decimals', 'decimals')}
        <label>Unit<input .value=${w.unit ?? ''}
          @change=${(e: Event) => this.setProp('unit', (e.target as HTMLInputElement).value)} /></label>` : nothing}
      ${w.kind === 'bar' ? html`
        <label><input type="checkbox" .checked=${w.vertical === true}
          @change=${(e: Event) => this.setProp('vertical', (e.target as HTMLInputElement).checked ? true : undefined)} /> vertical</label>` : nothing}
      <div class="hmi-d-pos">${w.x},${w.y} — ${w.w}×${w.h}</div>
    `;
  }
}

customElements.define('hmi-screen-designer', HmiScreenDesigner);
