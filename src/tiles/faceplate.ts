/**
 * Faceplate tile — operator panel for a PLC loop/device.
 *
 * HMI convention: one faceplate per controlled object. The tile binds
 * catalog signals by naming convention — `options.prefix` (e.g.
 * `plc.Main.TIC101`) plus per-kind role suffixes — or explicitly via
 * `options.roles` JSON (`{"pv":"plc.x.ACT", ...}`). Every resolved role
 * is polled through the hub's normal binding mechanism; writable
 * catalog params get live editors that route through the audited
 * `setParameter` path (same as the watch pane).
 *
 * Command pushbuttons are momentary by default (press → 1, release →
 * 0) matching PLC command-bit convention; `options.momentary=0`
 * switches to toggle/maintained writes.
 */
import { html, nothing, TemplateResult } from 'lit';
import { HubTopic } from '../data/hub';
import { TileElement, optString, optNumber } from './base';
import { CatalogEntry } from '../protocol';
import { entryWritable, writeScalar } from '../plc/mon';

export type FaceKind = 'loop' | 'motor' | 'valve' | 'generic';

/** Role → candidate name suffixes tried under the prefix, in order. */
const ROLE_SUFFIXES: Record<FaceKind, Record<string, string[]>> = {
  loop: {
    pv: ['PV', 'ACT', 'TEMP', 'IN'],
    sp: ['SP', 'SETPOINT', 'SPP'],
    out: ['OUT', 'OUTPUT', 'OP'],
    auto: ['AUTO_CMD', 'AUTO', 'AM'],
    man: ['MAN_CMD', 'MAN', 'MANUAL'],
    rem: ['REM_CMD', 'REM'],
    fault: ['FAULT', 'ALARM', 'ALM'],
    run: ['RUN', 'RUNNING'],
  },
  motor: {
    state: ['STATE', 'STS', 'STATUS'],
    run: ['RUN', 'RUN_CMD'],
    fwd: ['FWD', 'DIR_FWD'],
    rev: ['REV', 'DIR_REV'],
    ready: ['READY', 'RDY'],
    fault: ['FAULT', 'ALM'],
    sp: ['SPD_SP', 'SPEED_SP', 'SP'],
    act: ['SPD', 'SPEED', 'ACT', 'PV'],
    out: ['OUT', 'TORQUE', 'I_OUT'],
  },
  valve: {
    pos: ['POS', 'POSITION', 'PV'],
    cmd: ['CMD', 'SP', 'TARGET'],
    open: ['OPEN', 'OPEN_CMD'],
    close: ['CLOSE', 'CLOSE_CMD'],
    fault: ['FAULT', 'ALM'],
    state: ['STATE', 'STATUS'],
  },
  generic: {},
};

/** Display order + labels for resolved roles per kind. */
const ROLE_LABELS: Record<string, string> = {
  pv: 'PV', sp: 'SP', out: 'OUT',
  auto: 'AUTO', man: 'MAN', rem: 'REM',
  fault: 'FAULT', run: 'RUN',
  state: 'STATE', fwd: 'FWD', rev: 'REV',
  ready: 'READY', act: 'ACT',
  pos: 'POS', cmd: 'CMD', open: 'OPEN', close: 'CLOSE',
};

export interface FaceRole {
  role: string;
  /** Resolved catalog entry name (undefined = role not found). */
  name?: string;
  /** Literal key pushed to bindingKeys — hub.values is keyed by this,
      which may differ in case from the canonical catalog `name`. */
  bind?: string;
  entry?: CatalogEntry;
}

const lc = (s: string) => s.toLowerCase();

/**
 * Resolve role → catalog entry. Precedence:
 *   options.roles[role] (explicit) → prefix + suffix candidates.
 * Catalog matching is case-insensitive (ST identifiers are).
 */
export function resolveRoles(
  kind: FaceKind,
  prefix: string | undefined,
  rolesJson: string | undefined,
  entries: CatalogEntry[],
): FaceRole[] {
  const byLower = new Map<string, CatalogEntry>();
  for (const e of entries) if (!byLower.has(lc(e.name))) byLower.set(lc(e.name), e);

  let explicit: Record<string, string> = {};
  if (rolesJson) {
    try {
      const p = JSON.parse(rolesJson);
      if (p && typeof p === 'object' && !Array.isArray(p)) {
        for (const [k, v] of Object.entries(p))
          if (typeof v === 'string') explicit[k] = v;
      }
    } catch { /* malformed roles JSON — ignored */ }
  }

  const wanted = kind === 'generic'
    ? []
    : Object.keys(ROLE_SUFFIXES[kind] ?? {});
  const out: FaceRole[] = [];
  for (const role of wanted) {
    /* `bind` is the literal string bindingKeys() polls — a prefix
       candidate or an explicit roles-JSON name. `name` stays the
       canonical catalog spelling for display. */
    let bind: string | undefined = explicit[role];
    if (!bind && prefix) {
      for (const suf of ROLE_SUFFIXES[kind][role] ?? []) {
        const cand = `${prefix}.${suf}`;
        if (byLower.has(lc(cand))) { bind = cand; break; }
      }
    }
    const entry = bind ? byLower.get(lc(bind)) : undefined;
    out.push({ role, name: entry?.name ?? bind, bind, entry });
  }
  return out;
}

/** First binding entry as an implicit prefix (entry minus last segment). */
export function prefixFromBinding(entry: string | undefined): string | undefined {
  if (!entry) return undefined;
  const i = entry.lastIndexOf('.');
  return i > 0 ? entry.slice(0, i) : undefined;
}

interface Pt { t: number; v: number }
const HIST_LEN = 160;

export class TileFaceplate extends TileElement {
  private hist: Pt[] = [];
  private histKey?: string;
  private writeMsg = '';
  private writeErr = '';
  /** memoized role resolution — catalog scans are O(entries) and the
      catalog can hold thousands of plc.* expansions */
  private rolesCache?: { key: string; roles: FaceRole[] };

  protected topics(): HubTopic[] {
    return ['values', 'catalog', 'connection'];
  }

  protected bindingKeys(): string[] {
    /* Poll literal candidate names — NOT catalog-resolved ones: the
       catalog is usually still empty when subscriptions are set up,
       and the hub tolerates names that resolve later. Prefix+suffix
       candidates cover convention roles; roles-JSON values are literal
       catalog names already. */
    const keys = super.bindingKeys();
    const prefix = this.facePrefix();
    const kind = this.kind();
    if (prefix && kind !== 'generic') {
      for (const suffixes of Object.values(ROLE_SUFFIXES[kind]))
        for (const s of suffixes) keys.push(`${prefix}.${s}`);
    }
    try {
      const p = JSON.parse(optString(this.def, 'roles') ?? '{}');
      if (p && typeof p === 'object' && !Array.isArray(p))
        for (const v of Object.values(p))
          if (typeof v === 'string') keys.push(v);
    } catch { /* malformed roles JSON — ignored */ }
    return [...new Set(keys)];
  }

  private kind(): FaceKind {
    const k = optString(this.def, 'kind');
    return k === 'motor' || k === 'valve' || k === 'generic' ? k : 'loop';
  }

  private facePrefix(): string | undefined {
    return optString(this.def, 'prefix') ?? prefixFromBinding(this.def?.bindings?.[0]?.entry);
  }

  private roles(): FaceRole[] {
    const hub = this.hub;
    if (!hub) return [];
    const key = `${this.kind()}|${this.facePrefix() ?? ''}|${optString(this.def, 'roles') ?? ''}|${hub.params.length}+${hub.signals.length}`;
    if (this.rolesCache?.key !== key) {
      this.rolesCache = {
        key,
        roles: resolveRoles(this.kind(), this.facePrefix(), optString(this.def, 'roles'), [
          ...hub.params, ...hub.signals,
        ]),
      };
    }
    return this.rolesCache.roles;
  }

  private val(role: FaceRole | undefined): number | string | undefined {
    if (!role?.name || !this.hub) return undefined;
    /* values are keyed by the polled binding string, which may differ
       in case from the canonical catalog name */
    return this.hub.values.get(role.bind ?? role.name);
  }

  private writable(role: FaceRole | undefined): boolean {
    return !!role?.entry && role.entry.kind === 'param' && entryWritable(role.entry);
  }

  protected onHub(topic: HubTopic): void {
    if (topic === 'catalog') this.rolesCache = undefined;
    if (topic === 'values') this.samplePv();
    this.requestUpdate();
  }

  /** Ring-buffer the PV for the trend sparkline. */
  private samplePv(): void {
    const pv = this.roles().find((r) => r.role === 'pv' || r.role === 'pos' || r.role === 'act');
    const v = this.val(pv);
    if (typeof v !== 'number') return;
    if (this.histKey !== (pv?.bind ?? pv?.name)) { this.hist = []; this.histKey = pv?.bind ?? pv?.name; }
    const last = this.hist[this.hist.length - 1];
    const now = Date.now();
    if (last && now - last.t < 400) return;   // ~2.5 Hz max sample rate
    this.hist.push({ t: now, v });
    if (this.hist.length > HIST_LEN) this.hist.shift();
  }

  private async write(role: FaceRole | undefined, value: number): Promise<void> {
    const hub = this.hub;
    if (!hub || !this.writable(role) || !role?.entry) return;
    try {
      await writeScalar(hub.client, role.entry, value);
      this.writeMsg = `${ROLE_LABELS[role.role] ?? role.role} → ${value}`;
      this.writeErr = '';
    } catch (e) {
      this.writeErr = e instanceof Error ? e.message : 'write failed';
      this.writeMsg = '';
    }
    this.requestUpdate();
  }

  /** Momentary pushbutton: press=1, release=0 (or toggle when configured). */
  private push(role: FaceRole | undefined, down: boolean): void {
    const m = this.def?.options?.['momentary'];
    const momentary = !(m === false || m === '0' || m === 'false');
    if (!momentary) {
      if (down) void this.write(role, 1);
      return;
    }
    void this.write(role, down ? 1 : 0);
  }

  private roleOf(name: string): FaceRole | undefined {
    return this.roles().find((r) => r.role === name);
  }

  private num(v: number | string | undefined): number | undefined {
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  }

  private fmt(v: number | string | undefined, decimals = 1): string {
    const n = this.num(v);
    return n === undefined ? '—' : n.toFixed(decimals);
  }

  private bit(v: number | string | undefined): boolean {
    return this.num(v) !== undefined && this.num(v)! !== 0;
  }

  private pvBar(): TemplateResult {
    const pv = this.num(this.val(this.roleOf('pv') ?? this.roleOf('pos')));
    const lo = optNumber(this.def, 'min') ?? 0;
    const hi = optNumber(this.def, 'max') ?? 100;
    const pct = pv === undefined ? 0 : Math.max(0, Math.min(100, ((pv - lo) / (hi - lo)) * 100));
    return html`<div class="fp-bar"><div class="fp-fill" style="width:${pct}%"></div></div>`;
  }

  private outBar(): TemplateResult {
    const out = this.num(this.val(this.roleOf('out')));
    const pct = out === undefined ? 0 : Math.max(0, Math.min(100, out));
    return html`<div class="fp-bar fp-out"><div class="fp-fill" style="width:${pct}%"></div></div>`;
  }

  private trend(): TemplateResult {
    if (this.hist.length < 2) return html``;
    const w = 200, h = 36;
    const vs = this.hist.map((p) => p.v);
    const lo = Math.min(...vs), hi = Math.max(...vs);
    const span = hi - lo || 1;
    const pts = this.hist
      .map((p, i) => `${(i / (this.hist.length - 1)) * w},${h - 3 - ((p.v - lo) / span) * (h - 6)}`)
      .join(' ');
    return html`<svg class="fp-trend" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5"/>
    </svg>`;
  }

  private lamp(on: boolean, label: string, cls = ''): TemplateResult {
    return html`<span class="fp-lamp ${on ? 'on' : ''} ${cls}">${label}</span>`;
  }

  private cmdButton(role: string, label: string): TemplateResult {
    const r = this.roleOf(role);
    const disabled = !this.writable(r);
    return html`<button
      class="fp-btn ${role === 'fault' ? 'danger' : ''}"
      ?disabled=${disabled}
      @pointerdown=${(e: Event) => { e.preventDefault(); this.push(r, true); }}
      @pointerup=${() => this.push(r, false)}
      @pointerleave=${() => this.push(r, false)}
    >${label}</button>`;
  }

  /** Numeric setpoint editor for a writable role (SP for loop/motor,
      CMD for valve). Enter or Set commits through setParameter. */
  private valueEditor(roleName: string): TemplateResult {
    const r = this.roleOf(roleName);
    const disabled = !this.writable(r);
    return html`<span class="fp-sp">
      <input class="fp-input" type="number" step="any" ?disabled=${disabled}
        placeholder="${ROLE_LABELS[roleName] ?? roleName}"
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            const v = Number((e.target as HTMLInputElement).value);
            if (Number.isFinite(v)) void this.write(r, v);
          }
        }} />
      <button class="fp-btn" ?disabled=${disabled}
        @click=${(e: Event) => {
          const inp = (e.target as HTMLElement).closest('.fp-sp')?.querySelector('input');
          const v = Number(inp?.value);
          if (Number.isFinite(v)) void this.write(r, v);
        }}>Set</button>
    </span>`;
  }

  private statusLine(): TemplateResult {
    if (this.writeErr) return html`<div class="fp-msg err">${this.writeErr}</div>`;
    if (this.writeMsg) return html`<div class="fp-msg">${this.writeMsg}</div>`;
    return html``;
  }

  protected render(): TemplateResult {
    const hub = this.hub;
    const title = optString(this.def, 'title')
      ?? this.facePrefix()?.split('.').pop()
      ?? 'Faceplate';
    if (!hub) return html`<div class="fp fp-empty">no connection</div>`;

    const kind = this.kind();
    if (kind === 'generic') return this.renderGeneric(title);

    const fault = this.roleOf('fault');
    const faultOn = this.bit(this.val(fault));

    return html`<div class="fp fp-${kind}${faultOn ? ' fp-fault' : ''}">
      <div class="fp-head">
        <span class="fp-title">${title}</span>
        <span class="fp-modes">
          ${kind === 'loop' ? html`
            ${this.lamp(this.bit(this.val(this.roleOf('auto'))), 'AUTO')}
            ${this.lamp(this.bit(this.val(this.roleOf('man'))), 'MAN')}
            ${this.lamp(this.bit(this.val(this.roleOf('rem'))), 'REM')}
          ` : nothing}
          ${kind === 'motor' ? html`
            ${this.lamp(this.bit(this.val(this.roleOf('ready'))), 'RDY', 'ok')}
            ${this.lamp(this.bit(this.val(this.roleOf('run'))), 'RUN', 'run')}
          ` : nothing}
          ${this.lamp(faultOn, 'FAULT', 'fault')}
        </span>
      </div>
      <div class="fp-pv">
        <span class="fp-pv-val">${this.fmt(this.val(this.roleOf('pv') ?? this.roleOf('pos') ?? this.roleOf('act')), 1)}</span>
        ${this.pvBar()}
        ${this.trend()}
      </div>
      <div class="fp-row">
        ${kind === 'loop' || kind === 'motor' ? this.valueEditor('sp') : nothing}
        ${kind === 'valve' ? this.valueEditor('cmd') : nothing}
        ${this.outBar()}
      </div>
      <div class="fp-row fp-cmds">
        ${kind === 'loop' ? html`
          ${this.cmdButton('auto', 'AUTO')}
          ${this.cmdButton('man', 'MAN')}
          ${this.cmdButton('rem', 'REM')}
          ${this.cmdButton('run', 'RUN')}
        ` : nothing}
        ${kind === 'motor' ? html`
          ${this.cmdButton('fwd', 'FWD')}
          ${this.cmdButton('rev', 'REV')}
          ${this.cmdButton('run', 'RUN')}
        ` : nothing}
        ${kind === 'valve' ? html`
          ${this.cmdButton('open', 'OPEN')}
          ${this.cmdButton('close', 'CLOSE')}
        ` : nothing}
      </div>
      ${this.statusLine()}
    </div>`;
  }

  /** Generic kind: every bound signal as a label:value row; writable
      params get an inline editor (Enter commits through setParameter). */
  private renderGeneric(title: string): TemplateResult {
    const hub = this.hub!;
    const rows: { label: string; key: string; w: boolean; entry?: CatalogEntry }[] = [];
    const seen = new Set<string>();
    /* `name` is always the full catalog key (bindings arrive as
       entry[.field] — rejoin so flat plc.* dotted names survive) */
    const push = (label: string, name: string) => {
      if (!name || seen.has(name)) return;
      seen.add(name);
      const entry = [...hub.params, ...hub.signals].find((e) => e.name === name);
      rows.push({
        label, key: name,
        w: !!entry && entry.kind === 'param' && entryWritable(entry),
        entry,
      });
    };
    for (const b of this.def?.bindings ?? []) {
      const full = b.field ? `${b.entry}.${b.field}` : b.entry;
      push(full.split('.').pop() ?? full, full);
    }
    /* roles JSON also contributes rows for generic kind */
    try {
      const p = JSON.parse(optString(this.def, 'roles') ?? '{}');
      if (p && typeof p === 'object')
        for (const [role, name] of Object.entries(p))
          if (typeof name === 'string') push(role, name);
    } catch { /* ignored */ }
    return html`<div class="fp fp-generic">
      <div class="fp-head"><span class="fp-title">${title}</span></div>
      <table class="fp-table">
        ${rows.map((r) => html`<tr>
          <td class="fp-lbl">${r.label}</td>
          <td class="fp-val">${this.fmt(hub.values.get(r.key))}</td>
          <td>${r.w ? html`<input class="fp-input fp-input-sm" type="number" step="any"
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === 'Enter' && r.entry) {
                const v = Number((e.target as HTMLInputElement).value);
                if (Number.isFinite(v)) void writeScalar(hub.client, r.entry, v);
              }
            }} />` : ''}</td>
        </tr>`)}
      </table>
      ${this.statusLine()}
    </div>`;
  }
}

customElements.define('tile-faceplate', TileFaceplate);
