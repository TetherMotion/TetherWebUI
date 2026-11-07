/**
 * Analysis tiles — alarms, event timeline, operations ledger, and the
 * streaming scope. The scope registers its channels with the hub's stream
 * mux (one upstream union across all scopes) and keeps its own paused
 * history for stats/FFT.
 */
import { html, TemplateResult } from 'lit';
import { applyDerivedOp, fftMagnitudes } from '../domain/analysis';
import { MachineEvent } from '../domain/event-history';
import { HubTopic } from '../data/hub';
import { renderAlarms, renderOperations } from '../views/motion';
import { loadVolcanoPlot, VolcanoPlotCanvas } from '../vendor/volcanoplot';
import '../components';
import { icon } from '../icons';
import { optString, TileElement } from './base';

type ScopeElement = HTMLElement & {
  setChannels(channels: { name: string; color: [number, number, number] }[]): void;
  push(timestampUs: bigint, values: number[]): void;
  clear(): void;
  togglePause(): boolean;
  isPaused(): boolean;
  resetView(): void;
};

const TRACE_COLORS: [number, number, number][] = [
  [0, 0.45, 0.75],
  [0.85, 0.33, 0.1],
  [0, 0.62, 0.45],
  [0.8, 0.1, 0.2],
  [0.58, 0.4, 0.74],
  [0.91, 0.59, 0.09],
  [0.75, 0.31, 0.5],
  [0.4, 0.4, 0.4],
];

const PRESETS: Record<string, RegExp> = {
  motion: /position|velocity|torque|target|actual/i,
  error: /following.?error|error|deviation/i,
  network: /wkc|working.?counter|dc|distributed.?clock|link|al.?state/i,
};

export class TileAlarmList extends TileElement {
  protected topics(): HubTopic[] {
    return ['alarms', 'connection'];
  }

  protected render(): TemplateResult {
    return html`<div class="table-wrap tile-scroll">
      <table class="drive-table">
        <thead>
          <tr>
            <th>Alarm</th>
            <th>Severity</th>
            <th>Source</th>
            <th>Description</th>
            <th>State</th>
            <th>Raised</th>
            <th>Actor</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="alarm-table-body"></tbody>
      </table>
    </div>`;
  }

  protected updated(): void {
    const hub = this.hub;
    const tbody = this.querySelector<HTMLElement>('#alarm-table-body');
    if (!hub || !tbody) return;
    const ordered = [...hub.alarms.values()].sort((a, b) => (a.alarmId > b.alarmId ? -1 : 1));
    renderAlarms(tbody, ordered, hub.control?.controlsAvailable ?? false);
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest('button');
      if (!button || !this.hub) return;
      const ack = button.dataset.alarmAck;
      const clear = button.dataset.alarmClear;
      if (ack) void this.hub.alarmMutation(BigInt(ack), false);
      else if (clear) void this.hub.alarmMutation(BigInt(clear), true);
    });
  }
}

export class TileEventTimeline extends TileElement {
  protected topics(): HubTopic[] {
    return ['events', 'connection'];
  }

  protected render(): TemplateResult {
    return html`<div class="tile-scroll"><tether-event-timeline></tether-event-timeline></div>`;
  }

  protected updated(): void {
    const hub = this.hub;
    const timeline = this.querySelector<
      HTMLElement & {
        model: { events: readonly MachineEvent[]; gapDetected: boolean; available: boolean };
      }
    >('tether-event-timeline');
    if (!hub || !timeline) return;
    timeline.model = {
      events: hub.eventStore.events,
      gapDetected: hub.eventStore.gapDetected,
      available: hub.eventService.available,
    };
  }
}

export class TileOperations extends TileElement {
  protected topics(): HubTopic[] {
    return ['operations', 'connection'];
  }

  protected render(): TemplateResult {
    return html`<div class="table-wrap tile-scroll">
      <table class="drive-table">
        <thead>
          <tr>
            <th>Operation</th>
            <th>Action</th>
            <th>Target</th>
            <th>State</th>
            <th>Progress</th>
            <th>Message</th>
          </tr>
        </thead>
        <tbody id="operations-table-body"></tbody>
      </table>
    </div>`;
  }

  protected updated(): void {
    const tbody = this.querySelector<HTMLElement>('#operations-table-body');
    if (tbody && this.hub) renderOperations(tbody, this.hub.operations);
  }
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

export class TileScope extends TileElement {
  private streamRelease?: () => void;
  private history: number[][] = [];
  private stats: { last: number; min: number; max: number }[] = [];
  private paused = false;
  private plot?: VolcanoPlotCanvas;

  protected topics(): HubTopic[] {
    return ['catalog', 'connection'];
  }

  protected onHub(topic: HubTopic): void {
    if (topic === 'catalog') this.resubscribe();
    this.requestUpdate();
  }

  disconnectedCallback(): void {
    this.streamRelease?.();
    this.streamRelease = undefined;
    this.plot?.destroy();
    this.plot = undefined;
    super.disconnectedCallback();
  }

  willUpdate(changed: Map<string, unknown>): void {
    super.willUpdate(changed);
    if (changed.has('def')) this.resubscribe();
  }

  protected afterSubscribe(): void {
    this.resubscribe();
  }

  /** Signal names bound on this tile (options.signals: one name per line). */
  private signalNames(): string[] {
    const raw = optString(this.def, 'signals') ?? '';
    return raw
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private presetApply(): void {
    const preset = optString(this.def, 'preset');
    if (!preset || !this.hub || !PRESETS[preset]) return;
    const pattern = PRESETS[preset];
    const names = this.hub.signals
      .filter((s) => pattern!.test(s.name) || pattern!.test(s.group))
      .map((s) => s.name);
    this.updateDef({ signals: names.join('\n'), preset: '' });
  }

  /** Persist an options change back through the frame (immutable def swap). */
  private updateDef(options: Record<string, unknown>): void {
    this.dispatchEvent(
      new CustomEvent('tile-config', {
        bubbles: true,
        composed: true,
        detail: { options },
      }),
    );
  }

  private resubscribe(): void {
    this.streamRelease?.();
    this.streamRelease = undefined;
    const hub = this.hub;
    if (!hub || !this.isConnected) return;
    const names = this.signalNames();
    if (!names.length && optString(this.def, 'preset')) {
      // Apply the preset once the catalog is known.
      queueMicrotask(() => this.presetApply());
      return;
    }
    const ids = names
      .map((name) => hub.signalByName(name)?.id)
      .filter((id): id is bigint => id !== undefined);
    if (!ids.length) {
      const scope = this.scopeEl();
      scope?.setChannels([]);
      return;
    }
    const scope = this.scopeEl();
    const derive = optString(this.def, 'derive') ?? '';
    scope?.setChannels([
      ...names.map((name, i) => {
        const signal = hub.signalByName(name);
        const unit = signal?.metadata?.unit;
        return {
          name: name + (unit ? ` [${unit}]` : ''),
          color: TRACE_COLORS[i % TRACE_COLORS.length]!,
        };
      }),
      ...(derive && ids.length >= 2
        ? [{ name: `derived ${derive}`, color: TRACE_COLORS[ids.length % TRACE_COLORS.length]! }]
        : []),
    ]);
    scope?.clear();
    this.history = [];
    this.stats = [];
    this.streamRelease = hub.subscribeStream(ids, (ts, values) => {
      const extra = derive ? applyDerivedOp(derive as 'diff' | 'sum' | 'abs', values) : undefined;
      const pushed = extra === undefined ? values : [...values, extra];
      scope?.push(ts, pushed);
      this.history.push(pushed);
      if (this.history.length > 4096) this.history.splice(0, this.history.length - 4096);
      this.trackStats(values);
    });
  }

  private trackStats(values: number[]): void {
    if (this.stats.length !== values.length) {
      this.stats = values.map((v) => ({ last: v, min: v, max: v }));
    } else {
      for (let i = 0; i < values.length; i += 1) {
        const stat = this.stats[i]!;
        stat.last = values[i]!;
        if (values[i]! < stat.min) stat.min = values[i]!;
        if (values[i]! > stat.max) stat.max = values[i]!;
      }
    }
    const output = this.querySelector<HTMLOutputElement>('.scope-stats');
    if (!output) return;
    const names = this.signalNames();
    const fmt = (v: number) => (Number.isFinite(v) ? v.toPrecision(4) : '—');
    output.textContent = this.stats
      .map(
        (stat, i) =>
          `${names[i] ?? 'ch'}: last=${fmt(stat.last)} min=${fmt(stat.min)} max=${fmt(stat.max)}`,
      )
      .join('  ·  ');
  }

  private scopeEl(): ScopeElement | undefined {
    return this.querySelector<ScopeElement>('tether-webgpu-scope') ?? undefined;
  }

  private togglePause(): void {
    const scope = this.scopeEl();
    if (!scope) return;
    this.paused = scope.togglePause();
    this.requestUpdate();
  }

  private async showFft(): Promise<void> {
    const hub = this.hub;
    if (!hub || !this.history.length) {
      hub?.toast('No samples retained yet', 'error');
      return;
    }
    const channel = this.history.map((row) => row[0]!);
    const magnitudes = fftMagnitudes(channel);
    if (!magnitudes.length) {
      hub.toast('Need at least 4 samples for a spectrum', 'error');
      return;
    }
    const bundle = await loadVolcanoPlot();
    const canvas = this.querySelector<HTMLCanvasElement>('.scope-plot-canvas');
    const overlay = this.querySelector<HTMLElement>('.scope-plot-overlay');
    if (!bundle || !canvas || !overlay) return;
    this.plot?.destroy();
    overlay.hidden = false;
    this.plot = await bundle.createCanvas(canvas);
    this.plot.spectrum(channel, 1000 / hub.prefs.streamMs);
    this.plot.title('Magnitude spectrum');
    this.plot.xlabel('Frequency (Hz)');
    this.plot.ylabel('Magnitude');
    this.plot.grid(true);
    this.plot.enableInteraction(true);
    this.plot.render();
  }

  protected render(): TemplateResult {
    const names = this.signalNames();
    const unresolved = this.hub ? names.filter((n) => !this.hub!.signalByName(n)) : [];
    return html`<div class="scope-tile">
      <div class="scope-actions">
        <span class="${this.paused ? 'live-dot paused' : 'live-dot'}"
          >${this.paused ? icon('pause') : icon('activity')}
          ${this.paused ? 'PAUSED' : 'LIVE'}</span
        >
        <button class="secondary" @click=${this.togglePause}>
          ${this.paused ? 'Resume' : 'Pause'}
        </button>
        <button
          class="secondary"
          ?hidden=${!this.paused}
          @click=${() => this.scopeEl()?.resetView()}
        >
          Reset zoom
        </button>
        ${
          optString(this.def, 'fft') || this.def?.options?.['fft'] === true
            ? html`<button class="secondary" @click=${() => void this.showFft()}>FFT</button>`
            : ''
        }
      </div>
      ${
        unresolved.length
          ? html`<p class="form-result" role="status">
              Unresolved signals: ${unresolved.join(', ')}
            </p>`
          : ''
      }
      ${
        names.length === 0
          ? html`<p class="widget-empty">
              No channels — open tile settings to pick signals (or a preset).
            </p>`
          : ''
      }
      <tether-webgpu-scope></tether-webgpu-scope>
      <output class="scope-stats" aria-live="off"></output>
      <div class="scope-plot-overlay" hidden>
        <div class="scope-plot-dialog" role="dialog" aria-label="Frequency plot">
          <div class="scope-plot-head">
            <h3>Frequency spectrum</h3>
            <button
              class="secondary"
              @click=${() => {
                this.querySelector<HTMLElement>('.scope-plot-overlay')!.hidden = true;
                this.plot?.destroy();
                this.plot = undefined;
              }}
            >
              Close
            </button>
          </div>
          <canvas class="scope-plot-canvas"></canvas>
        </div>
      </div>
    </div>`;
  }
}

customElements.define('tile-alarm-list', TileAlarmList);
customElements.define('tile-event-timeline', TileEventTimeline);
customElements.define('tile-operations', TileOperations);
customElements.define('tile-scope', TileScope);
