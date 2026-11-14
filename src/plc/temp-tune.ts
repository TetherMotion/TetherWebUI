/**
 * <temp-tune> — graphical autotune configurator for the Atc_TempCtrl
 * tuner family (relay / step-identification / LQR / LQG). Edits a
 * TuneCfg, shows the tuner's default params, binds run/PV/SP/out/apply
 * interface vars, mirrors live tuner outputs from the catalog, and
 * inserts the tuner blocks + ST handoff into the selected POU's FBD
 * network (see src/plc/tune.ts).
 */
import { html, LitElement, nothing, PropertyValues, TemplateResult } from 'lit';
import { Pou } from './model';
import {
  applyTunerToPou,
  controllerFb,
  liveVarName,
  srcInstance,
  SRC_DEFS_FOR_UI,
  TUNE_KINDS,
  tunePins,
  TuneCfg,
  TuneKind,
  tunerFromPou,
} from './tune';

export class TempTune extends LitElement {
  declare pou?: Pou;
  /** persisted editor model for the selected POU (PlcProject.tunes). */
  declare tune?: TuneCfg;
  /** live catalog values (hub.values) for the tuner readout. */
  declare values?: Map<string, unknown>;

  static properties = {
    pou: { attribute: false },
    tune: { attribute: false },
    values: { attribute: false },
    cfg: { state: true },
  };

  declare cfg: TuneCfg;

  constructor() {
    super();
    this.cfg = { kind: 'relay', instance: 'tune' };
  }

  createRenderRoot(): this {
    return this;
  }

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has('tune')) {
      this.cfg = this.tune
        ? { ...this.tune, params: { ...(this.tune.params ?? {}) } }
        : { kind: 'relay', instance: 'tune' };
    } else if (changed.has('pou') && this.pou && !this.tune) {
      const rec = tunerFromPou(this.pou);
      if (rec) this.cfg = rec;
    }
  }

  private emit(): void {
    this.dispatchEvent(
      new CustomEvent('change', { detail: this.cfg, bubbles: true, composed: true }),
    );
  }

  private set(patch: Partial<TuneCfg>, emit = true): void {
    this.cfg = { ...this.cfg, ...patch };
    this.requestUpdate();
    if (emit) this.emit();
  }

  private setParam(name: string, value: string): void {
    const params = { ...(this.cfg.params ?? {}) };
    if (value === '') delete params[name];
    else params[name] = value;
    this.set({ params }, false);
  }

  private setKind(kind: TuneKind): void {
    const base: TuneCfg =
      kind === 'step'
        ? { kind, instance: 'ident', instance2: 'rules' }
        : kind === 'lqg'
          ? { kind, instance: 'kal', instance2: 'lqr' }
          : { kind, instance: kind === 'lqr' ? 'lqr' : 'tune' };
    this.cfg = { ...base, ctlInstance: this.cfg.ctlInstance, params: this.cfg.params };
    this.requestUpdate();
    this.emit();
  }

  private insert(): void {
    if (!this.pou) return;
    applyTunerToPou(this.pou, this.cfg);
    this.emit();
  }

  /** merged param list: defaults overridden by cfg.params. */
  private params(): [string, string][] {
    const out = new Map<string, string>();
    for (const s of SRC_DEFS_FOR_UI[this.cfg.kind]) {
      for (const [k, v] of Object.entries(s.params)) out.set(k, v);
    }
    for (const [k, v] of Object.entries(this.cfg.params ?? {})) out.set(k, v);
    return [...out.entries()];
  }

  private liveRows(): { name: string; type: string; value: unknown }[] {
    const rows: { name: string; type: string; value: unknown }[] = [];
    const pouName = this.pou?.name ?? '';
    for (const pin of tunePins(this.cfg)) {
      if (pin.kind !== 'var_output') continue;
      rows.push({
        name: pin.name,
        type: pin.type,
        value: this.values?.get(`plc.${pouName}.${pin.name}`),
      });
    }
    return rows;
  }

  private fmt(v: unknown): string {
    if (v === undefined || v === null) return '—';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(4);
    return String(v);
  }

  render(): TemplateResult {
    const c = this.cfg;
    const two = c.kind === 'step' || c.kind === 'lqg';
    const live = this.liveRows();
    return html`
      <div class="curve-editor">
        <div class="curve-head">
          <b>autotune</b>
          <label
            >method
            <select
              .value=${c.kind}
              @change=${(e: Event) => this.setKind((e.target as HTMLSelectElement).value as TuneKind)}
            >
              ${TUNE_KINDS.map((k) => html`<option value=${k.id}>${k.label}</option>`)}
            </select>
          </label>
          <label
            >instance
            <input
              class="fbd-in"
              .value=${c.instance}
              @change=${(e: Event) => this.set({ instance: (e.target as HTMLInputElement).value || 'tune' })}
            />
          </label>
          ${two
            ? html`<label
                >instance2
                <input
                  class="fbd-in"
                  .value=${c.instance2 ?? ''}
                  @change=${(e: Event) => this.set({ instance2: (e.target as HTMLInputElement).value || undefined })}
                />
              </label>`
            : nothing}
          <label
            >ctl inst
            <input
              class="fbd-in"
              placeholder="(mirror only)"
              title="controller instance receiving the tuned gains"
              .value=${c.ctlInstance ?? ''}
              @change=${(e: Event) => this.set({ ctlInstance: (e.target as HTMLInputElement).value.trim() || undefined })}
            />
          </label>
          <span class="spacer"></span>
          <button
            class="chip-btn"
            ?disabled=${!this.pou}
            @click=${this.insert}
            title="add tuner blocks + handoff to the selected POU's first network"
          >
            insert into ${this.pou?.name ?? 'POU'}
          </button>
        </div>
        <div class="curve-head">
          <label
            >run
            <input
              class="fbd-in"
              placeholder="(param TRUE)"
              title="interface BOOL wired to the tuner Execute pins"
              .value=${c.runVar ?? ''}
              @change=${(e: Event) => this.set({ runVar: (e.target as HTMLInputElement).value.trim() || undefined })}
            />
          </label>
          <label
            >pv
            <input
              class="fbd-in"
              placeholder="(required)"
              title="interface LREAL wired to the tuner Actual input"
              .value=${c.pvVar ?? ''}
              @change=${(e: Event) => this.set({ pvVar: (e.target as HTMLInputElement).value.trim() || undefined })}
            />
          </label>
          ${c.kind === 'relay'
            ? html`<label
                >sp
                <input
                  class="fbd-in"
                  placeholder="(none)"
                  title="interface LREAL wired to the relay Setpoint"
                  .value=${c.spVar ?? ''}
                  @change=${(e: Event) => this.set({ spVar: (e.target as HTMLInputElement).value.trim() || undefined })}
                />
              </label>`
            : nothing}
          ${c.kind === 'relay' || c.kind === 'step'
            ? html`<label
                >out
                <input
                  class="fbd-in"
                  placeholder="(none)"
                  title="interface LREAL driven by the tuner Out (plant input during tuning)"
                  .value=${c.outVar ?? ''}
                  @change=${(e: Event) => this.set({ outVar: (e.target as HTMLInputElement).value.trim() || undefined })}
                />
              </label>`
            : nothing}
          <label
            >apply
            <input
              class="fbd-in"
              placeholder="(auto)"
              title="interface BOOL strobe — copies tuned gains into the controller once"
              .value=${c.applyVar ?? ''}
              @change=${(e: Event) => this.set({ applyVar: (e.target as HTMLInputElement).value.trim() || undefined })}
            />
          </label>
          <label
            >reset
            <input
              class="fbd-in"
              placeholder="(param FALSE)"
              title="interface BOOL wired to the tuner Reset pins"
              .value=${c.resetVar ?? ''}
              @change=${(e: Event) => this.set({ resetVar: (e.target as HTMLInputElement).value.trim() || undefined })}
            />
          </label>
        </div>
        <table class="plc-table curve-table">
          <thead>
            <tr>
              <th>parameter</th>
              <th>value</th>
            </tr>
          </thead>
          <tbody>
            ${this.params().map(
              ([k, v]) => html`
                <tr>
                  <td>${k}</td>
                  <td>
                    <input
                      class="fbd-in"
                      .value=${v}
                      @change=${(e: Event) => this.setParam(k, (e.target as HTMLInputElement).value)}
                    />
                  </td>
                </tr>
              `,
            )}
          </tbody>
        </table>
        <div class="curve-head">
          <b>live</b>
          <span class="plc-dim"
            >${c.ctlInstance
              ? `gains → ${controllerFb(c.kind)} ${c.ctlInstance} on APPLY`
              : 'mirror only — no controller bound'}</span
          >
        </div>
        <table class="plc-table curve-table">
          <thead>
            <tr>
              <th>signal</th>
              <th>type</th>
              <th>value</th>
            </tr>
          </thead>
          <tbody>
            ${live.map(
              (r) => html`
                <tr>
                  <td>${r.name}</td>
                  <td class="plc-dim">${r.type}</td>
                  <td>${this.fmt(r.value)}</td>
                </tr>
              `,
            )}
          </tbody>
        </table>
        <span class="plc-dim">
          ${SRC_DEFS_FOR_UI[c.kind].map((s, i) => `${srcInstance(c, s.inst as 'instance' | 'instance2')}:${s.fb}`).join(' + ')}
          · gains land in the controller's input storage on the APPLY strobe — keep the
          tuned members unbound on the controller block
        </span>
      </div>
    `;
  }
}

customElements.define('temp-tune', TempTune);
