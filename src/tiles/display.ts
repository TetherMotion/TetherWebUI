/**
 * Signal-bound display tiles — the app-profile widget model generalized to
 * user boards. All kinds share one base; the tag selects the viz. Control
 * widgets (jog/command/button) live in actions.ts.
 */
import { html, TemplateResult } from 'lit';
import { HubTopic } from '../data/hub';
import { TileDef } from '../dash/model';
import { TileElement, bindingKeysOf, firstBinding, optNumber, optString } from './base';

type Viz = 'value' | 'dro' | 'gauge' | 'bar' | 'state' | 'lamp' | 'sparkline';

function shownValue(
  def: TileDef | undefined,
  kind: Viz,
  value: number | string | undefined,
): string {
  if (value === undefined) return '—';
  if (typeof value !== 'number') return value;
  const decimals = optNumber(def, 'decimals') ?? (kind === 'dro' ? 3 : undefined);
  if (decimals !== undefined) return value.toFixed(decimals);
  return formatNumber(value);
}

function thresholdClass(def: TileDef | undefined, value: number | string | undefined): string {
  if (typeof value !== 'number') return '';
  const crit = optNumber(def, 'critAbove');
  const warn = optNumber(def, 'warnAbove');
  if (crit !== undefined && value > crit) return ' widget-crit';
  if (warn !== undefined && value > warn) return ' widget-warn';
  return '';
}

function statesMap(def: TileDef | undefined): Record<string, string> {
  const raw = optString(def, 'states');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
      return out;
    }
  } catch {
    /* malformed states JSON — ignored */
  }
  return {};
}

function formatNumber(value: number): string {
  return Math.abs(value) >= 1000 ? value.toPrecision(4) : String(Math.round(value * 1000) / 1000);
}

abstract class SignalTile extends TileElement {
  protected abstract viz(): Viz;

  protected topics(): HubTopic[] {
    return ['values', 'connection'];
  }

  protected render(): TemplateResult {
    const hub = this.hub;
    const def = this.def;
    const kind = this.viz();
    const binding = firstBinding(def);
    if (!binding)
      return html`<p class="widget-empty">Unbound — pick a signal in the tile settings.</p>`;
    const value = hub?.values.get(binding.key);
    const cls =
      `panel-widget widget-${kind}${thresholdClass(def, value)}` +
      `${hub?.connected ? '' : ' widget-stale'}`;
    const unit = optString(def, 'unit');
    const shown = shownValue(def, kind, value);

    switch (kind) {
      case 'gauge':
      case 'bar': {
        const min = optNumber(def, 'min') ?? 0;
        const max = optNumber(def, 'max') ?? 1;
        const fraction =
          typeof value === 'number' && max > min
            ? Math.min(1, Math.max(0, (value - min) / (max - min)))
            : 0;
        const pct = fraction * 100;
        return html`<div
          class="${cls}"
          role="meter"
          aria-valuemin="${min}"
          aria-valuemax="${max}"
          aria-valuenow="${typeof value === 'number' ? value : 0}"
        >
          ${
            kind === 'gauge'
              ? html`<div class="widget-gauge" style="--fill:${pct.toFixed(1)}%">
                  <div class="widget-gauge-arc"></div>
                  <span class="widget-gauge-value"
                    >${shown}${unit ? html`<span class="widget-unit">${unit}</span>` : ''}</span
                  >
                </div>`
              : html`<span class="widget-value"
                    >${shown}${unit ? html`<span class="widget-unit">${unit}</span>` : ''}</span
                  >
                  <div class="widget-bar">
                    <div class="widget-bar-fill" style="width:${pct.toFixed(1)}%"></div>
                  </div>`
          }
        </div>`;
      }
      case 'dro':
      case 'value':
        return html`<div class="${cls}">
          <span class="${kind === 'dro' ? 'widget-dro' : 'widget-value'}"
            >${shown}${unit ? html`<span class="widget-unit">${unit}</span>` : ''}</span
          >
        </div>`;
      case 'sparkline': {
        const samples = hub?.history.get(binding.key) ?? [];
        const min = optNumber(def, 'min') ?? Math.min(...samples, 0);
        const max = optNumber(def, 'max') ?? Math.max(...samples, 1);
        const span = max > min ? max - min : 1;
        const points = samples
          .map(
            (v, i) =>
              `${((i / Math.max(1, samples.length - 1)) * 100).toFixed(1)},${(30 - ((v - min) / span) * 28 - 1).toFixed(1)}`,
          )
          .join(' ');
        return html`<div class="${cls}">
          <svg
            class="widget-spark"
            viewBox="0 0 100 30"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            ${samples.length > 1 ? html`<polyline points="${points}" fill="none" />` : ''}
          </svg>
          <span class="widget-value"
            >${shown}${unit ? html`<span class="widget-unit">${unit}</span>` : ''}</span
          >
        </div>`;
      }
      case 'state':
      case 'lamp': {
        const text = statesMap(def)[String(value)] ?? shown;
        const level =
          typeof value === 'number' &&
          optNumber(def, 'critAbove') !== undefined &&
          value > optNumber(def, 'critAbove')!
            ? 'crit'
            : typeof value === 'number' &&
                optNumber(def, 'warnAbove') !== undefined &&
                value > optNumber(def, 'warnAbove')!
              ? 'warn'
              : 'ok';
        return kind === 'lamp'
          ? html`<div class="${cls}">
              <span class="widget-lamp lamp-${level}" role="img" aria-label="${text}"></span>
              <span class="widget-state">${text}</span>
            </div>`
          : html`<div class="${cls}"><span class="widget-state">${text}</span></div>`;
      }
    }
  }
}

export class TileValue extends SignalTile {
  protected viz(): Viz {
    return optString(this.def, 'viz') === 'dro' ? 'dro' : 'value';
  }
}

export class TileGauge extends SignalTile {
  protected viz(): Viz {
    return 'gauge';
  }
}

export class TileBar extends SignalTile {
  protected viz(): Viz {
    return 'bar';
  }
}

export class TileState extends SignalTile {
  protected viz(): Viz {
    return 'state';
  }
}

export class TileLamp extends SignalTile {
  protected viz(): Viz {
    return 'lamp';
  }
}

export class TileSparkline extends SignalTile {
  protected viz(): Viz {
    return 'sparkline';
  }
}

// ---------------------------------------------------------------------------
// Scene — top-down XY view of actual vs target positions.
// ---------------------------------------------------------------------------

export class TileScene extends TileElement {
  protected topics(): HubTopic[] {
    return ['values', 'connection'];
  }

  protected bindingKeys(): string[] {
    return bindingKeysOf(this.def);
  }

  protected render(): TemplateResult {
    const hub = this.hub;
    const def = this.def;
    const axes = def?.axes ?? [];
    if (axes.length < 2)
      return html`<p class="widget-empty">Bind at least an X and Y axis in the tile settings.</p>`;
    const norm = (i: number) => {
      const a = axes[i];
      if (!a) return undefined;
      const v = hub?.values.get(`${a.entry}.${a.field}`);
      if (typeof v !== 'number') return undefined;
      const min = a.min ?? 0;
      const max = a.max ?? 1;
      return max > min ? Math.min(1, Math.max(0, (v - min) / (max - min))) : 0;
    };
    const normTarget = (i: number) => {
      const a = axes[i];
      if (!a?.targetField) return undefined;
      const v = hub?.values.get(`${a.entry}.${a.targetField}`);
      if (typeof v !== 'number') return undefined;
      const min = a.min ?? 0;
      const max = a.max ?? 1;
      return max > min ? Math.min(1, Math.max(0, (v - min) / (max - min))) : 0;
    };
    const xa = norm(0);
    const ya = norm(1);
    const xt = normTarget(0);
    const yt = normTarget(1);
    const za = norm(2);
    const zt = normTarget(2);
    const px = (f: number) => (8 + f * 84).toFixed(1);
    const py = (f: number) => (92 - f * 84).toFixed(1);
    const nameOf = (i: number) => axes[i]?.name ?? 'xyz'[i] ?? `a${i}`;
    const shown = (v: number | string | undefined) =>
      v === undefined ? '—' : typeof v === 'number' ? formatNumber(v) : v;
    const summary = axes
      .map((a, i) => `${a.name ?? 'xyz'[i]}=${shown(hub?.values.get(`${a.entry}.${a.field}`))}`)
      .join(' ');

    return html`<div class="panel-widget widget-scene${hub?.connected ? '' : ' widget-stale'}">
      <svg
        class="widget-scene"
        viewBox="0 0 ${axes.length > 2 ? 114 : 100} 100"
        role="img"
        aria-label="Scene: ${summary}"
      >
        <rect x="8" y="8" width="84" height="84" class="scene-frame" />
        ${
          xt !== undefined && yt !== undefined
            ? html`<circle class="scene-target" cx="${px(xt)}" cy="${py(yt)}" r="4" />`
            : ''
        }
        ${
          xa !== undefined && ya !== undefined
            ? html`<circle class="scene-actual" cx="${px(xa)}" cy="${py(ya)}" r="4" />`
            : ''
        }
        ${
          axes.length > 2
            ? html`<rect x="104" y="8" width="6" height="84" class="scene-frame" />
                ${
                  za !== undefined
                    ? html`<rect
                        x="104"
                        y="${(92 - za * 84).toFixed(1)}"
                        width="6"
                        height="${(za * 84).toFixed(1)}"
                        class="scene-actual"
                      />`
                    : ''
                }
                ${
                  zt !== undefined
                    ? html`<line
                        x1="102"
                        y1="${(92 - zt * 84).toFixed(1)}"
                        x2="112"
                        y2="${(92 - zt * 84).toFixed(1)}"
                        class="scene-target"
                      />`
                    : ''
                }
                <text x="107" y="98" class="scene-axis-label" text-anchor="middle"
                  >${nameOf(2)}</text
                >`
            : ''
        }
        <text x="50" y="4" class="scene-axis-label" text-anchor="middle">${nameOf(1)}</text>
        <text x="96" y="98" class="scene-axis-label" text-anchor="end">${nameOf(0)}</text>
      </svg>
      <span class="widget-value">${summary}</span>
    </div>`;
  }
}

customElements.define('tile-value', TileValue);
customElements.define('tile-gauge', TileGauge);
customElements.define('tile-bar', TileBar);
customElements.define('tile-state', TileState);
customElements.define('tile-lamp', TileLamp);
customElements.define('tile-sparkline', TileSparkline);
customElements.define('tile-scene', TileScene);
