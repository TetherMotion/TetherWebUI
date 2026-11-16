/**
 * Scene-native HMI tiles — every visual is an {@link HmiScene} built
 * by the pure builders in ../hmi/widgets.ts and rendered through
 * sceneToSvg(). The same scene JSON feeds the native Vulkan backend
 * (Tether examples/hmi_vulkan.cpp) so web and native views are
 * identical by construction — not just similar.
 *
 * Widgets:
 *   tile-hmi-gauge    circular process gauge (alarm bands, needle)
 *   tile-hmi-bar      horizontal/vertical bargraph with thresholds
 *   tile-hmi-digital  large numeric readout with alarm coloring
 *   tile-hmi-lamp     RUN/ALM/FLT stack light (blink support)
 *   tile-hmi-alarms   active-alarm summary board (hub.alarms)
 *
 * Each tile exposes `sceneJson()` returning the exact JSON document a
 * native renderer consumes — used by the identical-view e2e tests.
 */
import { html, nothing, TemplateResult } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { HubTopic } from '../data/hub';
import { TileDef } from '../dash/model';
import { TileElement, bindingKeysOf, firstBinding, optNumber, optString } from './base';
import { AlarmView } from '../domain/machine-control';
import {
  HmiScene, sceneToSvg,
} from '../hmi/scene';
import {
  AlarmLevel, GaugeOpts, BarOpts, DigitalOpts, LampOpts, AlarmBoardOpts,
  gaugeScene, bargraphScene, digitalScene, lampStackScene, alarmBoardScene,
} from '../hmi/widgets';

/** Render an HmiScene into the tile — meet-scaled, undistorted. */
function sceneHtml(scene: HmiScene): TemplateResult {
  return html`<div class="hmi-scene-wrap">${unsafeHTML(sceneToSvg(scene, 'hmi-scene-svg'))}</div>`;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Shared option extraction for single-signal process widgets. */
function processOpts(def: TileDef | undefined, value: number | undefined) {
  return {
    label: optString(def, 'label'),
    unit: optString(def, 'unit'),
    min: optNumber(def, 'min') ?? 0,
    max: optNumber(def, 'max') ?? 100,
    value,
    warn: optNumber(def, 'warn'),
    crit: optNumber(def, 'crit'),
    decimals: optNumber(def, 'decimals'),
  };
}

abstract class SceneSignalTile extends TileElement {
  /** design-space size — fixed per widget so text never distorts */
  protected abstract sceneSize(): { w: number; h: number };
  protected abstract build(value: number | undefined): HmiScene;
  protected lastScene?: HmiScene;

  protected topics(): HubTopic[] {
    return ['values', 'connection'];
  }

  protected render(): TemplateResult {
    const hub = this.hub;
    const def = this.def;
    const b = firstBinding(def);
    if (!hub) return html`<p class="widget-empty">no connection</p>`;
    if (!b) return html`<p class="widget-empty">Unbound — pick a signal in the tile settings.</p>`;
    const raw = hub.values.get(b.key);
    const value = num(raw);
    const { w, h } = this.sceneSize();
    const scene = this.build(value);
    this.lastScene = scene;
    const stale = hub.connected ? '' : ' hmi-stale';
    return html`<div class="hmi-tile${stale}">${sceneHtml(scene)}</div>`;
  }

  /** Exact JSON document for the native Vulkan backend. */
  sceneJson(): string | undefined {
    return this.lastScene ? JSON.stringify(this.lastScene) : undefined;
  }
}

// ---------------------------------------------------------------------------
// gauge
// ---------------------------------------------------------------------------

export class TileHmiGauge extends SceneSignalTile {
  protected sceneSize() { return { w: 120, h: 120 }; }
  protected build(value: number | undefined): HmiScene {
    const o = processOpts(this.def, value) as GaugeOpts & { w: number; h: number };
    const { w, h } = this.sceneSize();
    return gaugeScene({ ...o, w, h });
  }
}
customElements.define('tile-hmi-gauge', TileHmiGauge);

// ---------------------------------------------------------------------------
// bargraph
// ---------------------------------------------------------------------------

export class TileHmiBar extends SceneSignalTile {
  protected sceneSize() { return { w: 220, h: 56 }; }
  protected build(value: number | undefined): HmiScene {
    const o = processOpts(this.def, value) as BarOpts & { w: number; h: number };
    const { w, h } = this.sceneSize();
    return bargraphScene({
      ...o, w, h,
      vertical: optString(this.def, 'orientation') === 'vertical',
    });
  }
}
customElements.define('tile-hmi-bar', TileHmiBar);

// ---------------------------------------------------------------------------
// digital
// ---------------------------------------------------------------------------

export class TileHmiDigital extends SceneSignalTile {
  protected sceneSize() { return { w: 160, h: 64 }; }
  protected build(value: number | undefined): HmiScene {
    const o = processOpts(this.def, value) as DigitalOpts & { w: number; h: number };
    const { w, h } = this.sceneSize();
    return digitalScene({
      ...o, w, h,
      window: optString(this.def, 'window') === '1' || optString(this.def, 'window') === 'true',
    });
  }
}
customElements.define('tile-hmi-digital', TileHmiDigital);

// ---------------------------------------------------------------------------
// lamp stack — three bindings (run/alarm/fault), blink via timer
// ---------------------------------------------------------------------------

export class TileHmiLamp extends TileElement {
  private phase = 0;
  private timer?: number;
  private lastScene?: HmiScene;

  connectedCallback(): void {
    super.connectedCallback();
    if (this.timer === undefined)
      this.timer = window.setInterval(() => {
        this.phase = (this.phase + 0.1) % 1;
        this.requestUpdate();
      }, 100);
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

  /* lamp value convention: 0=off, nonzero=on, 2=blink (phase-driven) */
  private lampState(key: string | undefined): boolean | 'blink' | undefined {
    if (!key || !this.hub) return undefined;
    const v = this.hub.values.get(key);
    if (typeof v !== 'number') return undefined;
    if (v === 2) return 'blink';
    return v !== 0;
  }

  private bindingAt(i: number): string | undefined {
    const b = this.def?.bindings?.[i];
    return b ? (b.field ? `${b.entry}.${b.field}` : b.entry) : undefined;
  }

  protected render(): TemplateResult {
    const hub = this.hub;
    const keys = bindingKeysOf(this.def);
    if (!hub) return html`<p class="widget-empty">no connection</p>`;
    if (!keys.length)
      return html`<p class="widget-empty">Unbound — bind RUN/ALARM/FAULT signals.</p>`;
    const labels = (() => {
      try {
        const p = JSON.parse(optString(this.def, 'labels') ?? '{}');
        return p && typeof p === 'object' ? p : {};
      } catch { return {}; }
    })() as { run?: string; alarm?: string; fault?: string };

    const scene = lampStackScene({
      w: 72, h: 170,
      run: this.lampState(this.bindingAt(0)),
      alarm: this.lampState(this.bindingAt(1)),
      fault: this.lampState(this.bindingAt(2)),
      labels,
      phase: this.phase,
    } satisfies LampOpts & { w: number; h: number });
    this.lastScene = scene;
    const stale = hub.connected ? '' : ' hmi-stale';
    return html`<div class="hmi-tile${stale}">${sceneHtml(scene)}</div>`;
  }

  sceneJson(): string | undefined {
    return this.lastScene ? JSON.stringify(this.lastScene) : undefined;
  }
}
customElements.define('tile-hmi-lamp', TileHmiLamp);

// ---------------------------------------------------------------------------
// alarm board — consumes hub.alarms directly (no signal bindings)
// ---------------------------------------------------------------------------

export class TileHmiAlarms extends TileElement {
  private lastScene?: HmiScene;

  protected topics(): HubTopic[] {
    return ['alarms', 'connection'];
  }

  protected bindingKeys(): string[] {
    return [];   // alarm data comes from the alarm service, not signals
  }

  /* severity: 0=Info 1=Warning 2=Fault 3=Critical (machine-control.ts) */
  private levelOf(severity: number): AlarmLevel {
    return severity >= 3 ? 'crit' : severity >= 1 ? 'warn' : 'ok';
  }

  protected render(): TemplateResult {
    const hub = this.hub;
    if (!hub) return html`<p class="widget-empty">no connection</p>`;
    const maxRows = optNumber(this.def, 'maxRows') ?? 8;
    /* journal order newest-first; cleared (state 2) rows shown dimmed */
    const rows = [...hub.alarms.values()]
      .sort((a, b) => (a.alarmId < b.alarmId ? 1 : -1))
      .slice(0, maxRows)
      .map((a: AlarmView) => ({
        text: `#${a.alarmId.toString()} ${a.description || a.sourceId || 'alarm'}`,
        level: this.levelOf(a.severity),
        acked: a.state === 1 || a.state === 2,
      }));
    const scene = alarmBoardScene({
      w: 240, h: 140,
      title: optString(this.def, 'title'),
      rows,
      maxRows,
    } satisfies AlarmBoardOpts & { w: number; h: number });
    this.lastScene = scene;
    const stale = hub.connected ? '' : ' hmi-stale';
    return html`<div class="hmi-tile${stale}">${sceneHtml(scene)}</div>`;
  }

  sceneJson(): string | undefined {
    return this.lastScene ? JSON.stringify(this.lastScene) : undefined;
  }
}
customElements.define('tile-hmi-alarms', TileHmiAlarms);
