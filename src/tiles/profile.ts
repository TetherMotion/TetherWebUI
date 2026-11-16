/**
 * Profile tile — operator panel for an FB_AtcProfile temperature
 * profile run (reflow, wave, selective, brazing, anneal, ...).
 *
 * The whole panel binds one catalog prefix — e.g.
 * `options.prefix = "plc.Main.Prof"` for an FB_AtcProfile instance
 * named `Prof` inside program `Main`. Every known member
 * (Done/Busy/Err/SegIdx/SegTime/SegTgt/RateNow/RemTime/SP/EV plus the
 * RUN/HOLD/RESET/NUM_SEG/PV inputs) is polled through the hub's normal
 * binding mechanism; member names are library-declared so PascalCase
 * candidates match, and the hub resolves case-insensitively anyway.
 *
 * Command semantics: RESET is momentary (press=1, release=0); RUN and
 * HOLD are level inputs shown as state lamps — clicking toggles them
 * (write !current) through the audited setParameter path, enabled only
 * for catalog-writable entries.
 */
import { html, nothing, TemplateResult } from 'lit';
import { HubTopic } from '../data/hub';
import { TileElement, optString, optNumber } from './base';
import { CatalogEntry } from '../protocol';
import { entryWritable, writeScalar } from '../plc/mon';

/** Members polled under the prefix, in display order where relevant. */
const MEMBERS = [
  'Done', 'Busy', 'Err', 'EV',
  'SegIdx', 'SegTime', 'SegTgt', 'RateNow', 'RemTime', 'SP',
  'RUN', 'HOLD', 'RESET', 'NUM_SEG', 'PV',
] as const;
type Member = (typeof MEMBERS)[number];

interface Bound {
  /** literal polled key (hub.values is keyed by this) */
  bind: string;
  /** canonical catalog name */
  name?: string;
  entry?: CatalogEntry;
}

export class TileProfile extends TileElement {
  /** lowercase catalog index, rebuilt when the catalog size changes —
      member() runs ~20×/render and catalogs can hold thousands of
      plc.* expansions */
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

  protected bindingKeys(): string[] {
    const keys = super.bindingKeys();
    const prefix = optString(this.def, 'prefix');
    if (prefix) for (const m of MEMBERS) keys.push(`${prefix}.${m}`);
    return [...new Set(keys)];
  }

  private profPrefix(): string | undefined {
    return optString(this.def, 'prefix');
  }

  /** Resolve one member against the catalog (case-insensitive). */
  private member(m: Member): Bound | undefined {
    const hub = this.hub;
    const prefix = this.profPrefix();
    if (!hub || !prefix) return undefined;
    const bind = `${prefix}.${m}`;
    const entry = this.catMap().get(bind.toLowerCase());
    if (!entry && !hub.values.has(bind)) return undefined;
    return { bind, name: entry?.name, entry };
  }

  private val(m: Member): number | string | undefined {
    const b = this.member(m);
    if (!b || !this.hub) return undefined;
    return this.hub.values.get(b.bind);
  }

  private num(m: Member): number | undefined {
    const v = this.val(m);
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  }

  private bit(m: Member): boolean {
    return (this.num(m) ?? 0) !== 0;
  }

  private fmt(m: Member, decimals = 1, unit = ''): string {
    const n = this.num(m);
    return n === undefined ? '—' : `${n.toFixed(decimals)}${unit}`;
  }

  private writable(m: Member): boolean {
    const b = this.member(m);
    return !!b?.entry && b.entry.kind === 'param' && entryWritable(b.entry);
  }

  private async write(m: Member, value: number): Promise<void> {
    const b = this.member(m);
    const hub = this.hub;
    if (!hub || !b?.entry || !this.writable(m)) return;
    try {
      await writeScalar(hub.client, b.entry, value);
    } catch { /* surfaced via catalog value staying stale */ }
    this.requestUpdate();
  }

  /** Level input toggle: write the inverse of the current catalog value. */
  private toggle(m: Member): void {
    void this.write(m, this.bit(m) ? 0 : 1);
  }

  /** Momentary command: press=1, release=0. */
  private momentary(m: Member, down: boolean): void {
    void this.write(m, down ? 1 : 0);
  }

  private state(): { label: string; cls: string } {
    if (this.bit('Err')) return { label: 'ERROR', cls: 'err' };
    if (this.bit('Done')) return { label: 'DONE', cls: 'done' };
    if (this.bit('Busy')) return { label: 'RUNNING', cls: 'run' };
    if (this.bit('HOLD')) return { label: 'HOLD', cls: 'hold' };
    if (this.bit('RUN')) return { label: 'ARMED', cls: 'armed' };
    return { label: 'IDLE', cls: 'idle' };
  }

  private segBar(): TemplateResult {
    const idx = this.num('SegIdx') ?? 0;
    const n = this.num('NUM_SEG') ?? optNumber(this.def, 'numSeg') ?? 0;
    const pct = n > 0 ? Math.max(0, Math.min(100, (idx / n) * 100)) : 0;
    return html`<div class="fp-bar"><div class="fp-fill" style="width:${pct}%"></div></div>
      <span class="fp-seg">${idx}/${n || '?'}</span>`;
  }

  private cmdButton(m: 'RUN' | 'HOLD', label: string): TemplateResult {
    const on = this.bit(m);
    const disabled = !this.writable(m);
    return html`<button class="fp-btn ${on ? 'on' : ''}" ?disabled=${disabled}
      @click=${() => this.toggle(m)}>${label}</button>`;
  }

  private resetButton(): TemplateResult {
    const disabled = !this.writable('RESET');
    return html`<button class="fp-btn danger" ?disabled=${disabled}
      @pointerdown=${(e: Event) => { e.preventDefault(); this.momentary('RESET', true); }}
      @pointerup=${() => this.momentary('RESET', false)}
      @pointerleave=${() => this.momentary('RESET', false)}>RESET</button>`;
  }

  protected render(): TemplateResult {
    const hub = this.hub;
    const title = optString(this.def, 'title')
      ?? this.profPrefix()?.split('.').pop()
      ?? 'Profile';
    if (!hub) return html`<div class="fp fp-empty">no connection</div>`;

    const st = this.state();
    const pv = this.num('PV');
    const sp = this.num('SP');
    const pvUnit = optString(this.def, 'unit') ?? '';

    return html`<div class="fp fp-profile fp-${st.cls}">
      <div class="fp-head">
        <span class="fp-title">${title}</span>
        <span class="fp-state ${st.cls}">${st.label}</span>
      </div>
      <div class="fp-pv">
        <span class="fp-pv-val">${this.fmt('SP', 1, pvUnit)}</span>
        <span class="fp-dim">SP</span>
        ${this.segBar()}
      </div>
      <div class="fp-row fp-detail">
        <span>seg <b>${this.num('SegIdx') ?? '—'}</b></span>
        <span>t <b>${this.fmt('SegTime', 1)}</b>s</span>
        <span>~<b>${this.fmt('RemTime', 0)}</b>s</span>
        <span><b>${this.fmt('RateNow', 2)}</b>°/s</span>
        <span>tgt <b>${this.fmt('SegTgt', 0)}</b></span>
      </div>
      <div class="fp-row">
        <span class="fp-pv-inline">PV <b>${this.fmt('PV', 1, pvUnit)}</b></span>
        ${this.cmdButton('RUN', 'RUN')}
        ${this.cmdButton('HOLD', 'HOLD')}
        ${this.resetButton()}
      </div>
      ${this.bit('Err') && this.num('EV') !== undefined
        ? html`<div class="fp-msg err">profile error EV=0x${(this.num('EV') ?? 0).toString(16).toUpperCase()}</div>`
        : nothing}
    </div>`;
  }
}

customElements.define('tile-profile', TileProfile);
