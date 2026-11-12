/**
 * <temp-curve> — graphical temperature-profile editor for the
 * Atc_TempCtrl library. Edits a CurveProfile (segment table + options),
 * draws the SP-vs-time trajectory, and inserts the curve into the
 * selected POU's FBD network as an inline `st` config block wired to
 * an FB_AtcProfile instance through a var_in_out pin — the same model
 * the compiler's mixed FBD+ST path lowers (see src/plc/curve.ts).
 */
import { html, LitElement, nothing, PropertyValues, svg, TemplateResult } from 'lit';
import { Pou } from './model';
import {
  applyToPou,
  CONTROLLERS,
  CurveProfile,
  CurveSeg,
  defaultProfile,
  emitPou,
  preview,
  SEG_KINDS,
} from './curve';

const W = 560;
const H = 220;
const PAD = 34;

export class TempCurve extends LitElement {
  declare pou?: Pou;
  /** persisted editor model for the selected POU (PlcProject.curves). */
  declare profile?: CurveProfile;

  static properties = {
    pou: { attribute: false },
    profile: { attribute: false },
    prof: { state: true },
    selSeg: { state: true },
  };

  declare prof: CurveProfile;
  declare selSeg: number;

  private dragSeg = -1;

  constructor() {
    super();
    this.prof = defaultProfile();
    this.selSeg = -1;
  }

  createRenderRoot(): this {
    return this;
  }

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has('profile')) {
      this.prof = this.profile
        ? { ...this.profile, segs: this.profile.segs.map((s) => ({ ...s })) }
        : defaultProfile();
    }
  }

  private emit(): void {
    this.dispatchEvent(
      new CustomEvent('change', { detail: this.prof, bubbles: true, composed: true }),
    );
  }

  private set(patch: Partial<CurveProfile>, emit = true): void {
    this.prof = { ...this.prof, ...patch };
    this.requestUpdate();
    if (emit) this.emit();
  }

  private setSeg(i: number, patch: Partial<CurveSeg>, emit = true): void {
    const segs = this.prof.segs.map((s, j) => (j === i ? { ...s, ...patch } : s));
    this.set({ segs }, emit);
  }

  private addSeg(): void {
    const segs = [...this.prof.segs];
    const at = Math.max(
      0,
      segs.findIndex((s) => s.kind === 'end'),
    );
    segs.splice(at === -1 ? segs.length : at, 0, {
      kind: 'dwell',
      tgt: segs.at(-2)?.tgt ?? segs.at(-1)?.tgt ?? 100,
      p1: 60,
      p2: 0,
      ev: 0,
    });
    this.set({ segs });
  }

  private delSeg(i: number): void {
    this.set({ segs: this.prof.segs.filter((_, j) => j !== i) });
    this.selSeg = -1;
  }

  private moveSeg(i: number, dir: -1 | 1): void {
    const segs = [...this.prof.segs];
    const j = i + dir;
    if (j < 0 || j >= segs.length) return;
    [segs[i], segs[j]] = [segs[j]!, segs[i]!];
    this.set({ segs });
  }

  // ---- preview geometry ------------------------------------------------

  private scale() {
    const pts = preview(this.prof);
    const tMax = Math.max(1, ...pts.map((p) => p.t));
    const tMin = Math.min(0, ...pts.map((p) => p.temp));
    const tHi = Math.max(1, ...pts.map((p) => p.temp));
    const sx = (x: number) => PAD + (x / tMax) * (W - 2 * PAD);
    const sy = (v: number) => H - PAD - ((v - tMin) / (tHi - tMin || 1)) * (H - 2 * PAD);
    return { pts, tMax, tMin, tHi, sx, sy };
  }

  private onPtDown(e: PointerEvent, seg: number): void {
    this.dragSeg = seg;
    this.selSeg = seg;
    try {
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } catch {
      /* synthetic */
    }
    e.stopPropagation();
  }

  private onPtMove(e: PointerEvent): void {
    const i = this.dragSeg;
    if (i < 0) return;
    const el = this.querySelector('svg');
    if (!el) return;
    const { tMax, tMin, tHi, pts } = this.scale();
    const r = el.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const py = ((e.clientY - r.top) / r.height) * H;
    const s = this.prof.segs[i];
    if (!s || s.kind === 'end' || s.kind === 'loop') return;
    // y → target temperature
    const tgt = tMin + ((H - PAD - py) / (H - 2 * PAD)) * (tHi - tMin || 1);
    const patch: Partial<CurveSeg> = { tgt: Math.round(tgt * 10) / 10 };
    // x → duration for dwell/rampt (distance from previous point)
    if (s.kind === 'dwell' || s.kind === 'rampt') {
      const prev = pts.find((p) => p.seg === i - 1) ?? pts[0]!;
      const t = (px - PAD) / (W - 2 * PAD);
      patch.p1 = Math.max(0, Math.round(t * tMax - prev.t));
    }
    this.setSeg(i, patch, false);
  }

  private onPtUp(): void {
    if (this.dragSeg >= 0) {
      this.dragSeg = -1;
      this.emit();
    }
  }

  private previewSvg(): TemplateResult {
    const { pts, tMax, tHi, sx, sy } = this.scale();
    const poly = pts.map((p) => `${sx(p.t)},${sy(p.temp)}`).join(' ');
    return svg`
      <svg class="curve-svg" viewBox="0 0 ${W} ${H}"
        @pointermove=${this.onPtMove} @pointerup=${this.onPtUp}>
        <line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}" class="curve-axis"></line>
        <line x1="${PAD}" y1="${PAD}" x2="${PAD}" y2="${H - PAD}" class="curve-axis"></line>
        <text x="${W - PAD}" y="${H - PAD + 16}" text-anchor="end" class="curve-lab">${Math.round(tMax)}s</text>
        <text x="${PAD - 4}" y="${PAD + 4}" text-anchor="end" class="curve-lab">${Math.round(tHi)}°</text>
        <polyline points="${poly}" fill="none" class="curve-line"></polyline>
        ${pts.map((p) => {
          if (p.seg < 0) return nothing;
          const s = this.prof.segs[p.seg]!;
          if (s.kind === 'loop') {
            return svg`<text x="${sx(p.t)}" y="${sy(p.temp) - 8}" class="curve-lab">↺→seg${Math.trunc(s.tgt)} ×${Math.trunc(s.p1)}</text>`;
          }
          return svg`
            <circle cx="${sx(p.t)}" cy="${sy(p.temp)}" r="5"
              class="curve-pt ${p.seg === this.selSeg ? 'sel' : ''}"
              @pointerdown=${(e: PointerEvent) => this.onPtDown(e, p.seg)}></circle>`;
        })}
      </svg>
    `;
  }

  // ---- actions ---------------------------------------------------------

  private insert(): void {
    if (!this.pou) return;
    applyToPou(this.pou, this.prof);
    this.emit();
  }

  private exportSt(): void {
    const name = `FB_${this.prof.instance}_cfg`;
    this.dispatchEvent(
      new CustomEvent('export-st', {
        detail: { name, source: emitPou(name, this.prof) },
        bubbles: true,
        composed: true,
      }),
    );
  }

  render(): TemplateResult {
    const p = this.prof;
    return html`
      <div class="curve-editor">
        <div class="curve-head">
          <b>temperature profile</b>
          <label
            >instance
            <input
              class="fbd-in"
              .value=${p.instance}
              @change=${(e: Event) => this.set({ instance: (e.target as HTMLInputElement).value || 'prof' })}
            />
          </label>
          <label
            >controller
            <select
              .value=${p.controller}
              @change=${(e: Event) => this.set({ controller: (e.target as HTMLSelectElement).value })}
            >
              <option value="">(none)</option>
              ${CONTROLLERS.map((c) => html`<option value=${c.name}>${c.name}</option>`)}
            </select>
          </label>
          <label
            >ctl inst
            <input
              class="fbd-in"
              .value=${p.ctlInstance}
              @change=${(e: Event) => this.set({ ctlInstance: (e.target as HTMLInputElement).value || 'ctl' })}
            />
          </label>
          <label
            >cycle s
            <input
              class="fbd-in"
              type="number"
              step="0.01"
              min="0.001"
              .value=${String(p.cycleTime)}
              @change=${(e: Event) => this.set({ cycleTime: Number((e.target as HTMLInputElement).value) || 0.1 })}
            />
          </label>
          <label
            ><input
              type="checkbox"
              .checked=${p.pvStart}
              @change=${(e: Event) => this.set({ pvStart: (e.target as HTMLInputElement).checked })}
            />
            pv-start</label
          >
          <label
            >run
            <input
              class="fbd-in"
              placeholder="(none)"
              title="interface BOOL wired to RUN and the controller enable"
              .value=${p.runVar ?? ''}
              @change=${(e: Event) => this.set({ runVar: (e.target as HTMLInputElement).value.trim() })}
            />
          </label>
          <label
            >pv
            <input
              class="fbd-in"
              placeholder="(none)"
              title="interface LREAL wired to the profile and controller process value"
              .value=${p.pvVar ?? ''}
              @change=${(e: Event) => this.set({ pvVar: (e.target as HTMLInputElement).value.trim() })}
            />
          </label>
          <label
            >hold
            <input
              class="fbd-in"
              placeholder="(none)"
              title="interface BOOL wired to HOLD"
              .value=${p.holdVar ?? ''}
              @change=${(e: Event) => this.set({ holdVar: (e.target as HTMLInputElement).value.trim() })}
            />
          </label>
          <label
            >reset
            <input
              class="fbd-in"
              placeholder="(none)"
              title="interface BOOL wired to RESET"
              .value=${p.resetVar ?? ''}
              @change=${(e: Event) => this.set({ resetVar: (e.target as HTMLInputElement).value.trim() })}
            />
          </label>
          <label
            >out
            <input
              class="fbd-in"
              placeholder="(none)"
              title="interface LREAL driven by the controller output"
              .value=${p.outVar ?? ''}
              @change=${(e: Event) => this.set({ outVar: (e.target as HTMLInputElement).value.trim() })}
            />
          </label>
          <span class="spacer"></span>
          <button
            class="chip-btn"
            ?disabled=${!this.pou}
            @click=${this.insert}
            title="add profile blocks to the selected POU's first network"
          >
            insert into ${this.pou?.name ?? 'POU'}
          </button>
          <button
            class="chip-btn"
            @click=${this.exportSt}
            title="emit a FUNCTION_BLOCK ST source instead"
          >
            export .st
          </button>
        </div>
        ${this.previewSvg()}
        <table class="plc-table curve-table">
          <thead>
            <tr>
              <th>#</th>
              <th>kind</th>
              <th>tgt °</th>
              <th>p1 s|°/s|×</th>
              <th>soak ±°</th>
              <th>ev</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${p.segs.map(
              (s, i) => html`
                <tr class="${i === this.selSeg ? 'sel' : ''}" @click=${() => (this.selSeg = i)}>
                  <td>${i + 1}</td>
                  <td>
                    <select
                      .value=${s.kind}
                      @change=${(e: Event) =>
                        this.setSeg(i, {
                          kind: (e.target as HTMLSelectElement).value as typeof s.kind,
                        })}
                    >
                      ${SEG_KINDS.map((k) => html`<option value=${k.id}>${k.label}</option>`)}
                    </select>
                  </td>
                  <td>
                    <input
                      class="fbd-in"
                      type="number"
                      .value=${String(s.tgt)}
                      @change=${(e: Event) => this.setSeg(i, { tgt: Number((e.target as HTMLInputElement).value) })}
                    />
                  </td>
                  <td>
                    <input
                      class="fbd-in"
                      type="number"
                      step="0.1"
                      .value=${String(s.p1)}
                      @change=${(e: Event) => this.setSeg(i, { p1: Number((e.target as HTMLInputElement).value) })}
                    />
                  </td>
                  <td>
                    <input
                      class="fbd-in"
                      type="number"
                      step="0.1"
                      .value=${String(s.p2)}
                      @change=${(e: Event) => this.setSeg(i, { p2: Number((e.target as HTMLInputElement).value) })}
                    />
                  </td>
                  <td>
                    <input
                      class="fbd-in"
                      type="number"
                      .value=${String(s.ev)}
                      @change=${(e: Event) => this.setSeg(i, { ev: Number((e.target as HTMLInputElement).value) })}
                    />
                  </td>
                  <td class="curve-ops">
                    <button class="chip-btn" @click=${() => this.moveSeg(i, -1)}>↑</button>
                    <button class="chip-btn" @click=${() => this.moveSeg(i, 1)}>↓</button>
                    <button class="chip-btn" @click=${() => this.delSeg(i)}>✕</button>
                  </td>
                </tr>
              `,
            )}
          </tbody>
        </table>
        <button class="chip-btn" @click=${this.addSeg}>+ segment</button>
        <span class="plc-dim">
          dwell: p1=s, soak-band holds the timer · ramp: p1=°/s · rampt: p1=s · loop: tgt=seg,
          p1=count · drag points to retune</span
        >
      </div>
    `;
  }
}

customElements.define('temp-curve', TempCurve);
