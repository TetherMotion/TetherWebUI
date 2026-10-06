/**
 * @file jog.ts
 * @brief `<tether-jog-panel>` — operator jogging surface for the dashboard.
 *
 * The panel discovers everything it renders from the server:
 *
 *   1. `jog.describe` (function) — JSON listing axes, groups, presets and
 *      server-enforced limits.  Nothing about axis count, names, units or
 *      presets is hardcoded here.
 *   2. `jog.<axis>.jog / .move / .stop` (functions) — commands.
 *   3. `jog.<axis>.state` (Binary signal) — polled for live mode, rate,
 *      position and remaining lease time.
 *
 * ## Failsafe behaviour
 *
 * Continuous jogging is lease-based: while a ± button is held the panel
 * refreshes `jog(rate, leaseMs)` at ~10 Hz.  Releasing the button sends a
 * final `jog(0, …)` hold-alive — but correctness never depends on any
 * final packet: if this tab freezes, loses the WebSocket or the whole
 * browser dies, the server-side lease simply expires and the axis ramps
 * to a stop.  `jog.stop_all` is a polite convenience, not the safety
 * mechanism.
 */

import { TetherIOClient } from './client';
import {
  CatalogEntry,
  FunctionEntry,
  ValueType,
  decodeValueBytes,
  encodeScalarArgument,
} from './protocol';

// ---------------------------------------------------------------------------
// Types matching jog.describe JSON (tether::control::JogController)
// ---------------------------------------------------------------------------

interface JogAxisDesc {
  name: string;
  unit: string;
  maxRate: number;
  accel: number;
  maxLeaseMs: number;
  maxIncrement: number;
  ratePresets: number[];
  incrementPresets: number[];
}

interface JogGroupDesc {
  name: string;
  axes: string[]; // axis names
  ratePresets: number[]; // empty = per-axis
  incrementPresets: number[]; // empty = per-axis
}

interface JogDescription {
  version: number;
  defaultLeaseMs: number;
  axes: JogAxisDesc[];
  groups: JogGroupDesc[];
}

/** Decoded `jog.<axis>.state` Binary snapshot (POD, see AxisSnapshot). */
interface JogAxisState {
  mode: number; // 0 Idle, 1 Continuous, 2 Incremental, 3 Stopping
  active: boolean;
  rate: number;
  position: number;
  remaining: number;
  leaseLeftMs: number;
  maxLeaseMs: number;
  maxRate: number;
  maxIncrement: number;
}

interface JogIds {
  jog?: bigint;
  move?: bigint;
  stop?: bigint;
  state?: bigint;
}

/** Refresh cadence for the lease while a jog button is held (ms). */
const JOG_REFRESH_MS = 100;
/** Fraction of the granted lease used as refresh lease (safety margin). */
const LEASE_MS = 300;
/** State polling interval (ms). */
const POLL_MS = 250;

const MODE_LABEL = ['IDLE', 'JOG', 'STEP', 'STOPPING'] as const;

/**
 * Decode the fixed-layout AxisSnapshot POD:
 *   mode u8 @0, active u8 @1, rate f64 @8, position f64 @16,
 *   remaining f64 @24, leaseLeftMs u32 @32, maxLeaseMs u32 @36,
 *   maxRate f64 @40, maxIncrement f64 @48.
 */
function decodeAxisSnapshot(bytes: Uint8Array): JogAxisState | undefined {
  if (bytes.length < 56) return undefined;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    mode: v.getUint8(0),
    active: v.getUint8(1) !== 0,
    rate: v.getFloat64(8, true),
    position: v.getFloat64(16, true),
    remaining: v.getFloat64(24, true),
    leaseLeftMs: v.getUint32(32, true),
    maxLeaseMs: v.getUint32(36, true),
    maxRate: v.getFloat64(40, true),
    maxIncrement: v.getFloat64(48, true),
  };
}

// ---------------------------------------------------------------------------
// TetherJogPanel
// ---------------------------------------------------------------------------

/**
 * Dynamic jogging panel.
 *
 * Set `model` to `{ client, functions, signals }` once the catalogs are
 * available; the panel stays hidden when the server exposes no `jog.*`
 * surface.
 */
export class TetherJogPanel extends HTMLElement {
  private client?: TetherIOClient;
  private desc?: JogDescription;
  private fnIds = new Map<string, JogIds>(); // axis name -> entry ids
  private stopAllId?: bigint;
  private describeId?: bigint;
  /** Per-axis live state from the last poll. */
  private states = new Map<string, JogAxisState>();
  /** Lease-refresh timer while a jog button is held. */
  private refreshTimer?: number;
  private refreshAxis?: { name: string; dir: number; rate: number };
  private pollTimer?: number;
  /** Selected presets per group (index into the preset list). */
  private groupRateSel = new Map<string, number>();
  private groupStepSel = new Map<string, number>();
  private online = false;

  /** Provide catalogs + client; triggers discovery + first render. */
  set model(value: {
    client: TetherIOClient;
    functions: FunctionEntry[];
    signals: CatalogEntry[];
  }) {
    this.client = value.client;
    this.resolveIds(value.functions, value.signals);
    void this.discover();
  }

  connectedCallback(): void {
    this.classList.add('jog-panel');
    this.innerHTML = '<p class="empty">Discovering jog surface…</p>';
  }

  disconnectedCallback(): void {
    this.stopRefresh();
    this.stopPolling();
  }

  // ---- Discovery --------------------------------------------------------

  /** Map jog.* function/signal names to their entry IDs. */
  private resolveIds(functions: FunctionEntry[], signals: CatalogEntry[]): void {
    this.fnIds.clear();
    const byName = new Map(functions.map((f) => [f.name, f.id]));
    this.describeId = byName.get('jog.describe');
    this.stopAllId = byName.get('jog.stop_all');
    const get = (axis: string): JogIds => {
      let ids = this.fnIds.get(axis);
      if (!ids) {
        ids = {};
        this.fnIds.set(axis, ids);
      }
      return ids;
    };
    for (const f of functions) {
      const m = /^jog\.([^.]+)\.(jog|move|stop)$/.exec(f.name);
      if (!m) continue;
      const ids = get(m[1]!);
      if (m[2] === 'jog') ids.jog = f.id;
      else if (m[2] === 'move') ids.move = f.id;
      else ids.stop = f.id;
    }
    for (const s of signals) {
      const m = /^jog\.([^.]+)\.state$/.exec(s.name);
      if (m) get(m[1]!).state = s.id;
    }
  }

  /** Call jog.describe and render the discovered surface. */
  private async discover(): Promise<void> {
    if (!this.client || this.describeId === undefined) {
      this.innerHTML = '';
      this.classList.add('jog-hidden');
      return;
    }
    try {
      const bytes = await this.client.callFunctionOrThrow(this.describeId);
      this.desc = JSON.parse(decodeValueBytes(bytes, ValueType.String) as string);
    } catch (error) {
      this.innerHTML = `<p class="empty">jog.describe failed: ${
        error instanceof Error ? error.message : String(error)
      }</p>`;
      return;
    }
    this.render();
    this.startPolling();
  }

  // ---- Commands ---------------------------------------------------------

  private async sendJog(axis: string, rate: number, leaseMs: number): Promise<void> {
    const id = this.fnIds.get(axis)?.jog;
    if (id === undefined || !this.client) return;
    try {
      await this.client.callFunction(id, [
        { key: 1, value: encodeScalarArgument(ValueType.F64, rate) },
        { key: 2, value: encodeScalarArgument(ValueType.U32, leaseMs) },
      ]);
    } catch {
      // Transport-level failure — the server-side lease will expire and
      // stop the axis; nothing else to do here.
    }
  }

  private async sendMove(axis: string, distance: number): Promise<void> {
    const id = this.fnIds.get(axis)?.move;
    if (id === undefined || !this.client) return;
    const result = await this.client
      .callFunction(id, [
        { key: 1, value: encodeScalarArgument(ValueType.F64, distance) },
      ])
      .catch(() => undefined);
    if (result && !result.success)
      this.dispatchEvent(
        new CustomEvent('jog-error', { detail: `${axis}: ${result.errorMessage}` }),
      );
  }

  private async sendStop(axis?: string): Promise<void> {
    if (!this.client) return;
    const id = axis === undefined ? this.stopAllId : this.fnIds.get(axis)?.stop;
    if (id === undefined) return;
    try {
      await this.client.callFunction(id);
    } catch {
      // Best effort — lease expiry remains the failsafe.
    }
  }

  // ---- Hold-to-jog ------------------------------------------------------

  private startJog(axis: string, dir: number): void {
    if (!this.desc) return;
    const desc = this.desc.axes.find((a) => a.name === axis);
    if (!desc) return;
    const group = this.desc.groups.find((g) => g.axes.includes(axis));
    const presets = group?.ratePresets.length ? group.ratePresets : desc.ratePresets;
    const rate = presets[this.groupRateSel.get(group?.name ?? '') ?? 0] ?? presets[0] ?? 1;
    const lease = Math.min(LEASE_MS, desc.maxLeaseMs);
    this.refreshAxis = { name: axis, dir, rate };
    void this.sendJog(axis, dir * rate, lease);
    this.stopRefresh(); // clears any previous timer (not the axis state)
    this.refreshTimer = window.setInterval(() => {
      if (!this.refreshAxis) return;
      void this.sendJog(this.refreshAxis.name, this.refreshAxis.dir * this.refreshAxis.rate, lease);
    }, JOG_REFRESH_MS);
  }

  /** Button released: polite hold-alive (rate 0), then let the lease lapse. */
  private endJog(): void {
    const axis = this.refreshAxis;
    this.stopRefresh();
    if (!axis || !this.desc) return;
    const desc = this.desc.axes.find((a) => a.name === axis.name);
    if (!desc) return;
    void this.sendJog(axis.name, 0, Math.min(120, desc.maxLeaseMs));
  }

  private stopRefresh(): void {
    if (this.refreshTimer !== undefined) window.clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    this.refreshAxis = undefined;
  }

  /** Hard disconnect: stop local timers; server leases expire on their own. */
  setOnline(online: boolean): void {
    this.online = online;
    if (!online) this.stopRefresh();
    this.classList.toggle('jog-offline', !online);
  }

  // ---- Polling ----------------------------------------------------------

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = window.setInterval(() => void this.poll(), POLL_MS);
    void this.poll();
  }

  private stopPolling(): void {
    if (this.pollTimer !== undefined) window.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private async poll(): Promise<void> {
    if (!this.client || !this.desc) return;
    await Promise.all(
      this.desc.axes.map(async (axis) => {
        const id = this.fnIds.get(axis.name)?.state;
        if (id === undefined) return;
        try {
          const bytes = await this.client!.get('signal', id);
          const state = decodeAxisSnapshot(bytes);
          if (state) this.states.set(axis.name, state);
        } catch {
          // Leave stale state visible; connection badge covers outages.
        }
      }),
    );
    this.updateLive();
  }

  // ---- Rendering --------------------------------------------------------

  private render(): void {
    if (!this.desc) return;
    this.classList.remove('jog-hidden');
    const desc = this.desc;

    // Axes claimed by a group; ungrouped axes render in an implicit group.
    const grouped = new Set(desc.groups.flatMap((g) => g.axes));
    const ungrouped = desc.axes.filter((a) => !grouped.has(a.name)).map((a) => a.name);
    const groups: JogGroupDesc[] = [
      ...desc.groups,
      ...(ungrouped.length
        ? [{ name: 'axes', axes: ungrouped, ratePresets: [], incrementPresets: [] }]
        : []),
    ];

    this.innerHTML = `
      <div class="jog-head">
        <div>
          <span class="eyebrow">Manual control</span>
          <h2>Jogging</h2>
        </div>
        <div class="jog-head-actions">
          <span class="jog-lease-hint" title="Motion continues only while commands
are received — comms loss stops the axis automatically">
            failsafe lease ≤ ${Math.max(...desc.axes.map((a) => a.maxLeaseMs))} ms
          </span>
          <button class="jog-stop-all" title="Stop all axes">■ STOP ALL</button>
        </div>
      </div>
      <div class="jog-groups">
        ${groups.map((g) => this.renderGroup(g)).join('')}
      </div>
    `;

    // STOP ALL
    this.querySelector('.jog-stop-all')?.addEventListener('click', () => void this.sendStop());

    // Preset chips
    this.querySelectorAll<HTMLButtonElement>('.jog-chip').forEach((chip) =>
      chip.addEventListener('click', () => {
        const map = chip.dataset.kind === 'rate' ? this.groupRateSel : this.groupStepSel;
        map.set(chip.dataset.group!, Number(chip.dataset.index));
        this.querySelectorAll(
          `.jog-chip[data-group="${chip.dataset.group}"][data-kind="${chip.dataset.kind}"]`,
        ).forEach((c) => c.classList.toggle('jog-chip-active', c === chip));
      }),
    );

    // Increment buttons
    this.querySelectorAll<HTMLButtonElement>('[data-move]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const [axis, dir] = btn.dataset.move!.split(':');
        const group = this.desc?.groups.find((g) => g.axes.includes(axis!));
        const axisDesc = this.desc?.axes.find((a) => a.name === axis);
        const presets = group?.incrementPresets.length
          ? group.incrementPresets
          : (axisDesc?.incrementPresets ?? []);
        const step = presets[this.groupStepSel.get(group?.name ?? '') ?? 0] ?? presets[0] ?? 1;
        void this.sendMove(axis!, Number(dir) * step);
      }),
    );

    // Continuous jog buttons — pointer events for hold-to-jog.
    this.querySelectorAll<HTMLButtonElement>('[data-hold]').forEach((btn) => {
      const [axis, dir] = btn.dataset.hold!.split(':');
      const start = (e: Event) => {
        e.preventDefault();
        btn.classList.add('jog-held');
        this.startJog(axis!, Number(dir));
      };
      const end = () => {
        if (!btn.classList.contains('jog-held')) return;
        btn.classList.remove('jog-held');
        this.endJog();
      };
      btn.addEventListener('pointerdown', start);
      btn.addEventListener('pointerup', end);
      btn.addEventListener('pointerleave', end);
      btn.addEventListener('pointercancel', end);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    });

    // Per-axis stop buttons
    this.querySelectorAll<HTMLButtonElement>('[data-stop]').forEach((btn) =>
      btn.addEventListener('click', () => void this.sendStop(btn.dataset.stop!)),
    );

    this.updateLive();
  }

  private renderGroup(group: JogGroupDesc): string {
    if (!this.desc) return '';
    const gname = group.name;
    const axes = group.axes
      .map((name) => this.desc!.axes.find((a) => a.name === name))
      .filter((a): a is JogAxisDesc => a !== undefined);
    if (axes.length === 0) return '';

    // Group presets override per-axis presets (server config decides).
    const ratePresets = group.ratePresets.length ? group.ratePresets : axes[0]!.ratePresets;
    const stepPresets = group.incrementPresets.length
      ? group.incrementPresets
      : axes[0]!.incrementPresets;
    const unit = axes[0]!.unit;
    const showGroupPresets = group.ratePresets.length > 0 || group.incrementPresets.length > 0;

    const chipRow = (kind: 'rate' | 'step', presets: number[], label: string) => `
      <div class="jog-presets">
        <span class="jog-preset-label">${label}</span>
        ${presets
          .map((p, i) => {
            const sel =
              kind === 'rate'
                ? (this.groupRateSel.get(gname) ?? 0)
                : (this.groupStepSel.get(gname) ?? 0);
            return `<button class="jog-chip ${i === sel ? 'jog-chip-active' : ''}"
                      data-kind="${kind}" data-group="${gname}" data-index="${i}">${p}</button>`;
          })
          .join('')}
        <small>${unit}${kind === 'rate' ? '/s' : ''}</small>
      </div>`;

    return `
      <section class="jog-group" data-group="${gname}">
        <header class="jog-group-head">
          <h3>${gname}</h3>
          ${
            showGroupPresets
              ? `<div class="jog-group-presets">
            ${chipRow('rate', ratePresets, 'rate')}
            ${chipRow('step', stepPresets, 'step')}
          </div>`
              : ''
          }
        </header>
        <div class="jog-axes">
          ${axes.map((a) => this.renderAxis(a, group)).join('')}
        </div>
      </section>`;
  }

  private renderAxis(axis: JogAxisDesc, group: JogGroupDesc): string {
    const gname = group.name;
    const ratePresets = group.ratePresets.length ? group.ratePresets : axis.ratePresets;
    const stepPresets = group.incrementPresets.length
      ? group.incrementPresets
      : axis.incrementPresets;
    const showAxisPresets = group.ratePresets.length === 0 && group.incrementPresets.length === 0;

    return `
      <article class="jog-axis" data-axis="${axis.name}">
        <header class="jog-axis-head">
          <strong class="jog-axis-name">${axis.name.toUpperCase()}</strong>
          <span class="jog-badge" data-mode>IDLE</span>
          <button class="jog-axis-stop" data-stop="${axis.name}" title="Stop ${axis.name}">■</button>
        </header>
        <div class="jog-readouts">
          <div><small>pos</small><span data-pos>—</span><small>${axis.unit}</small></div>
          <div><small>rate</small><span data-rate>—</span><small>${axis.unit}/s</small></div>
          <div><small>lease</small><span data-lease>—</span><small>ms</small></div>
        </div>
        <div class="jog-controls">
          <button class="jog-btn jog-minus" data-hold="${axis.name}:-1"
                  aria-label="Jog ${axis.name} negative">−</button>
          <button class="jog-btn jog-plus" data-hold="${axis.name}:1"
                  aria-label="Jog ${axis.name} positive">+</button>
        </div>
        <div class="jog-inc-row">
          <button class="jog-inc" data-move="${axis.name}:-1">◄ step</button>
          <button class="jog-inc" data-move="${axis.name}:1">step ►</button>
        </div>
        ${
          showAxisPresets
            ? `<div class="jog-axis-presets">
                 <div class="jog-presets">
                   <span class="jog-preset-label">rate</span>
                   ${ratePresets
                     .map(
                       (p, i) =>
                         `<button class="jog-chip ${i === 0 ? 'jog-chip-active' : ''}"
                            data-kind="rate" data-group="${gname}" data-index="${i}">${p}</button>`,
                     )
                     .join('')}
                 </div>
                 <div class="jog-presets">
                   <span class="jog-preset-label">step</span>
                   ${stepPresets
                     .map(
                       (p, i) =>
                         `<button class="jog-chip ${i === 0 ? 'jog-chip-active' : ''}"
                            data-kind="step" data-group="${gname}" data-index="${i}">${p}</button>`,
                     )
                     .join('')}
                 </div>
               </div>`
            : ''
        }
        <div class="jog-limits">
          <small>≤ ${axis.maxRate} ${axis.unit}/s · ≤ ${axis.maxIncrement} ${axis.unit}/step ·
          lease ≤ ${axis.maxLeaseMs} ms</small>
        </div>
      </article>`;
  }

  /** Update live readouts in place (called after each poll). */
  private updateLive(): void {
    if (!this.desc) return;
    for (const axis of this.desc.axes) {
      const card = this.querySelector(`.jog-axis[data-axis="${axis.name}"]`);
      if (!card) continue;
      const s = this.states.get(axis.name);
      const mode = card.querySelector('[data-mode]')!;
      const pos = card.querySelector('[data-pos]')!;
      const rate = card.querySelector('[data-rate]')!;
      const lease = card.querySelector('[data-lease]')!;
      if (!s) {
        mode.textContent = this.online === false ? 'OFFLINE' : '—';
        continue;
      }
      mode.textContent = MODE_LABEL[s.mode] ?? `M${s.mode}`;
      mode.className = 'jog-badge ' + (s.active ? 'jog-badge-active' : '');
      pos.textContent = s.position.toFixed(3);
      rate.textContent = s.rate.toFixed(2);
      lease.textContent = s.leaseLeftMs > 0 ? String(s.leaseLeftMs) : '—';
      card.classList.toggle('jog-axis-active', s.active);
    }
  }
}

customElements.define('tether-jog-panel', TetherJogPanel);
