/**
 * Generic HMI widgets — the primitives every operator board needs
 * beyond the PLC-specific faceplate/profile panels:
 *
 *  - tile-trend: multi-pen time-series chart. Bindings come from the
 *    tile's `signals` field (def.bindings[]); each pen gets a palette
 *    color, autoscale (or fixed min/max), optional hi/lo threshold
 *    lines, and a legend with live values. Samples are ring-buffered
 *    per series on 'values' emissions (~2.5 Hz cap like faceplate).
 *
 *  - tile-bitbutton: generic catalog-param pushbutton. Momentary
 *    (press=1/release=0, PLC command-bit convention) or toggle mode;
 *    writes go through the audited setParameter path and are enabled
 *    only for catalog-writable params.
 */
import { html, nothing, TemplateResult } from 'lit';
import { HubTopic } from '../data/hub';
import { TileDef } from '../dash/model';
import { TileElement, bindingKeysOf, optNumber, optString } from './base';
import { CatalogEntry } from '../protocol';
import { entryWritable, writeScalar } from '../plc/mon';

const PEN_COLORS = ['#6af', '#4c4', '#fc4', '#f66', '#c8f', '#f8f'];
const TREND_H = 120;
const TREND_W = 400;
const TREND_LEN = 480;
const SAMPLE_MIN_MS = 400;

interface TrendPt { t: number; v: number }

/** Multi-signal bindings → polled keys (entry[.field] rejoined). */
export function bindingKeys(def?: TileDef): string[] {
  return bindingKeysOf(def);
}

/** Label for a binding: explicit title option per index, else leaf name. */
export function bindingLabel(def: TileDef | undefined, key: string, index: number): string {
  const titles = optString(def, 'labels');
  if (titles) {
    try {
      const arr = JSON.parse(titles);
      if (Array.isArray(arr) && typeof arr[index] === 'string' && arr[index]) return arr[index];
    } catch { /* ignored */ }
  }
  return key.split('.').pop() ?? key;
}

export class TileTrend extends TileElement {
  private series = new Map<string, TrendPt[]>();
  private lastSample = 0;
  private timer?: number;

  connectedCallback(): void {
    super.connectedCallback();
    /* 'values' only emits on change — a steady signal would stop
       sampling and the window would drain to empty. Charts need a
       wall-clock cadence, so sample + redraw on a fixed interval. */
    if (this.timer === undefined)
      this.timer = window.setInterval(() => {
        this.sample();
        this.requestUpdate();
      }, 500);
  }

  disconnectedCallback(): void {
    if (this.timer !== undefined) {
      window.clearInterval(this.timer);
      this.timer = undefined;
    }
    super.disconnectedCallback();
  }

  protected topics(): HubTopic[] {
    return ['values', 'connection'];
  }
  /* base bindingKeys() → bindingKeysOf(def) already polls every
     def.bindings entry[.field] key — no override needed */

  protected onHub(topic: HubTopic): void {
    if (topic === 'values') this.sample();
    this.requestUpdate();
  }

  private sample(): void {
    const now = Date.now();
    if (now - this.lastSample < SAMPLE_MIN_MS) return;
    this.lastSample = now;
    const hub = this.hub;
    if (!hub) return;
    for (const key of bindingKeys(this.def)) {
      const v = hub.values.get(key);
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      let buf = this.series.get(key);
      if (!buf) { buf = []; this.series.set(key, buf); }
      const last = buf[buf.length - 1];
      if (last && now - last.t < SAMPLE_MIN_MS) continue;
      buf.push({ t: now, v });
      if (buf.length > TREND_LEN) buf.shift();
    }
    /* drop series whose binding was removed */
    const live = new Set(bindingKeys(this.def));
    for (const k of [...this.series.keys()]) if (!live.has(k)) this.series.delete(k);
  }

  protected render(): TemplateResult {
    const hub = this.hub;
    const def = this.def;
    const keys = bindingKeys(def);
    if (!hub) return html`<div class="fp fp-empty">no connection</div>`;
    if (!keys.length)
      return html`<p class="widget-empty">Unbound — add signals in the tile settings.</p>`;

    const windowMs = (optNumber(def, 'windowSec') ?? 120) * 1000;
    const now = Date.now();
    const t0 = now - windowMs;

    /* visible points per series + global y-range */
    const fixedMin = optNumber(def, 'min');
    const fixedMax = optNumber(def, 'max');
    let lo = fixedMin ?? Infinity, hi = fixedMax ?? -Infinity;
    const visible = keys.map((key) => {
      const pts = (this.series.get(key) ?? []).filter((p) => p.t >= t0);
      for (const p of pts) {
        if (fixedMin === undefined) lo = Math.min(lo, p.v);
        if (fixedMax === undefined) hi = Math.max(hi, p.v);
      }
      return { key, pts };
    });
    if (lo === Infinity) lo = 0;
    if (hi === -Infinity || hi <= lo) hi = lo + 1;
    const span = hi - lo;
    const pad = span * 0.08;
    lo -= fixedMin === undefined ? pad : 0;
    hi += fixedMax === undefined ? pad : 0;

    const x = (t: number) => ((t - t0) / windowMs) * TREND_W;
    const y = (v: number) => TREND_H - 4 - ((v - lo) / (hi - lo)) * (TREND_H - 18);

    /* grid: 4 horizontal lines with y labels */
    const grid = [0, 1, 2, 3].map((i) => {
      const v = hi - (i / 3) * (hi - lo);
      const gy = 4 + (i / 3) * (TREND_H - 18);
      return html`<line x1="0" x2="${TREND_W}" y1="${gy}" y2="${gy}" class="trend-grid"/>
        <text x="2" y="${gy - 2}" class="trend-axis">${v >= 100 ? v.toFixed(0) : v.toFixed(1)}</text>`;
    });

    const warnHi = optNumber(def, 'warnAbove');
    const critHi = optNumber(def, 'critAbove');
    const threshold = (v: number | undefined, cls: string) =>
      v === undefined || v < lo || v > hi
        ? nothing
        : html`<line x1="0" x2="${TREND_W}" y1="${y(v)}" y2="${y(v)}" class="trend-th ${cls}"/>`;

    const pens = visible.map(({ key, pts }, i) => {
      const color = PEN_COLORS[i % PEN_COLORS.length];
      const d = pts.map((p, j) => `${j === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
      const cur = hub.values.get(key);
      return html`<g>
        ${pts.length > 1 ? html`<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5"/>` : nothing}
        ${pts.length === 1 ? html`<circle cx="${x(pts[0]!.t)}" cy="${y(pts[0]!.v)}" r="2" fill="${color}"/>` : nothing}
      </g>`;
    });

    return html`<div class="fp fp-trend-tile">
      <svg class="trend-svg" viewBox="0 0 ${TREND_W} ${TREND_H}" preserveAspectRatio="none">
        ${grid} ${threshold(warnHi, 'warn')} ${threshold(critHi, 'crit')} ${pens}
      </svg>
      <div class="trend-legend">
        ${visible.map(({ key }, i) => {
          const cur = hub.values.get(key);
          const shown = typeof cur === 'number' ? cur.toFixed(1) : '—';
          return html`<span class="trend-pen">
            <i style="background:${PEN_COLORS[i % PEN_COLORS.length]}"></i>
            ${bindingLabel(def, key, i)} <b>${shown}</b>
          </span>`;
        })}
      </div>
    </div>`;
  }
}

export class TileBitButton extends TileElement {
  private catCache?: { key: string; map: Map<string, CatalogEntry> };

  protected topics(): HubTopic[] {
    return ['values', 'catalog', 'connection'];
  }

  protected onHub(topic: HubTopic): void {
    if (topic === 'catalog') this.catCache = undefined;
    this.requestUpdate();
  }

  private catMap(): Map<string, CatalogEntry> {
    const hub = this.hub!;
    const key = `${hub.params.length}+${hub.signals.length}`;
    if (this.catCache?.key !== key) {
      const map = new Map<string, CatalogEntry>();
      for (const e of [...hub.params, ...hub.signals])
        if (!map.has(e.name.toLowerCase())) map.set(e.name.toLowerCase(), e);
      this.catCache = { key, map };
    }
    return this.catCache.map;
  }

  private key(): string | undefined {
    const b = this.def?.bindings?.[0];
    if (b) return b.field ? `${b.entry}.${b.field}` : b.entry;
    return optString(this.def, 'entry');
  }

  private entry(): CatalogEntry | undefined {
    const key = this.key();
    if (!key || !this.hub) return undefined;
    return this.catMap().get(key.toLowerCase());
  }

  private val(): number | string | undefined {
    const key = this.key();
    return key && this.hub ? this.hub.values.get(key) : undefined;
  }

  private writable(): boolean {
    const e = this.entry();
    return !!e && e.kind === 'param' && entryWritable(e);
  }

  private async write(value: number): Promise<void> {
    const e = this.entry();
    const hub = this.hub;
    if (!hub || !e || !this.writable()) return;
    try {
      await writeScalar(hub.client, e, value);
    } catch { /* value stays stale until next poll */ }
    this.requestUpdate();
  }

  private onValue(): number {
    return optNumber(this.def, 'onValue') ?? 1;
  }

  private offValue(): number {
    return optNumber(this.def, 'offValue') ?? 0;
  }

  protected render(): TemplateResult {
    const hub = this.hub;
    const def = this.def;
    const label = optString(def, 'label') ?? this.key()?.split('.').pop() ?? 'Button';
    const key = this.key();
    if (!hub || !key)
      return html`<div class="fp fp-empty">unbound — set a signal in tile settings</div>`;

    const mode = optString(def, 'mode') ?? 'momentary';
    const raw = this.val();
    const isOn = typeof raw === 'number' && raw !== this.offValue() && raw !== 0;
    const disabled = !this.writable();
    const momentary = mode !== 'toggle';

    const press = () => {
      if (disabled) return;
      if (momentary) void this.write(this.onValue());
      else void this.write(isOn ? this.offValue() : this.onValue());
    };
    const release = () => {
      if (!disabled && momentary) void this.write(this.offValue());
    };

    return html`<button
      class="bitbtn ${isOn ? 'on' : ''}"
      ?disabled=${disabled}
      title="${key}"
      @pointerdown=${(e: Event) => { e.preventDefault(); if (momentary) press(); }}
      @pointerup=${() => { if (momentary) release(); }}
      @pointerleave=${() => { if (momentary) release(); }}
      @click=${() => { if (!momentary) press(); }}
    >
      <span class="bitbtn-state"></span>${label}
    </button>`;
  }
}

customElements.define('tile-trend', TileTrend);
customElements.define('tile-bitbutton', TileBitButton);
