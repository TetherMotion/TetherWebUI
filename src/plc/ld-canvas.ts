/**
 * Ladder-diagram canvas for networks with kind === 'ld'.
 *
 * The project model stores LD networks as the same blocks+wires
 * structure as FBD (PLCopen import maps contacts/coils/boxes onto
 * variable/function blocks with role + pos). This canvas renders them
 * rung-style: power rails on both sides, NO/NC contacts and coils as
 * ladder glyphs, other blocks as labeled boxes, wires as connectors.
 *
 * Editing: click the toolbar to arm a symbol, click the canvas to
 * place it on the grid; click a symbol to select, Delete removes,
 * double-click renames the variable. All edits mutate the shared
 * Network model and emit `change` so the IDE persists them.
 */
import { LitElement, html, nothing, TemplateResult } from 'lit';
import { Block, Network, Pou, VarRole, Wire, nextNodeId } from './model';

const GRID = 28;          // px per grid step
const SYM_W = 84;         // contact/coil symbol width
const SYM_H = 44;         // symbol height
const RAIL_L = 24;
const RAIL_R = 24;

type Tool = 'select' | 'no' | 'nc' | 'coil' | 'box' | 'wire';

export class LdCanvas extends LitElement {
  static properties = {
    pou: { attribute: false },
    netIndex: { type: Number },
    pous: { attribute: false },
    values: { attribute: false },
    tool: { state: true },
    selId: { state: true },
  };

  declare pou?: Pou;
  declare netIndex: number;
  declare pous: Pou[];
  declare values?: Map<string, unknown>;
  declare tool: Tool;
  declare selId: number;
  /** wire tool: armed source block awaiting destinations. */
  private wireSrc = 0;

  constructor() {
    super();
    this.netIndex = 0;
    this.pous = [];
    this.tool = 'select';
    this.selId = 0;
  }

  private get net(): Network | undefined {
    return this.pou?.networks[this.netIndex];
  }

  private emit(): void {
    this.dispatchEvent(new CustomEvent('change', { bubbles: true, composed: true }));
  }

  /** rung row for a block: y snapped to grid, x order within rung. */
  private rungOf(b: Block): number {
    return Math.round(b.pos.y / GRID);
  }

  private blocksByRung(): Map<number, Block[]> {
    const m = new Map<number, Block[]>();
    for (const b of this.net?.blocks ?? []) {
      const r = this.rungOf(b);
      const arr = m.get(r) ?? [];
      arr.push(b);
      m.set(r, arr);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.pos.x - b.pos.x);
    return m;
  }

  private svgW(): number {
    let max = 20;
    for (const b of this.net?.blocks ?? []) max = Math.max(max, b.pos.x + SYM_W + 40);
    return max + RAIL_R;
  }

  private svgH(): number {
    const rungs = this.blocksByRung();
    const n = Math.max(1, ...[...rungs.keys()].map((r) => r + 1), 0);
    return n * GRID * 2 + 40;
  }

  /** pixel position of a block's left/right terminals. */
  private termX(b: Block, right: boolean): number {
    return RAIL_L + b.pos.x + (right ? SYM_W : 0);
  }

  private termY(b: Block): number {
    return b.pos.y + SYM_H / 2;
  }

  private blockLabel(b: Block): string {
    if (b.name) return b.name;
    if (b.kind === 'variable') return b.role === 'out' ? 'coil' : 'contact';
    return b.instance ?? b.type_ref;
  }

  private isContact(b: Block): boolean {
    return b.kind === 'variable' && b.role !== 'out';
  }

  private isCoil(b: Block): boolean {
    return b.kind === 'variable' && b.role === 'out';
  }

  private renderSymbol(b: Block): TemplateResult {
    const x = RAIL_L + b.pos.x;
    const y = b.pos.y;
    const cx = x + SYM_W / 2;
    const cy = y + SYM_H / 2;
    const sel = this.selId === b.id;
    const stroke = sel ? 'var(--accent,#6cf)' : 'currentColor';
    if (this.isContact(b)) {
      const nc = b.negated.length > 0;
      /* | | or |/| contact between two horizontal wires */
      return html`<g class="ld-sym ${sel ? 'sel' : ''}"
          @click=${(e: Event) => { e.stopPropagation(); this.selId = b.id; }}
          @dblclick=${() => this.renameBlock(b)}>
        <line x1=${x} y1=${cy} x2=${x + 14} y2=${cy} stroke=${stroke} />
        <line x1=${x + SYM_W - 14} y1=${cy} x2=${x + SYM_W} y2=${cy} stroke=${stroke} />
        <line x1=${x + 14} y1=${cy - 12} x2=${x + SYM_W - 14} y2=${cy - 12} stroke=${stroke} />
        <line x1=${x + 14} y1=${cy + 12} x2=${x + SYM_W - 14} y2=${cy + 12} stroke=${stroke} />
        ${nc
          ? html`<line x1=${x + 14} y1=${cy + 12} x2=${x + SYM_W - 14} y2=${cy - 12}
              stroke=${stroke} />`
          : nothing}
        <text x=${cx} y=${y - 4} text-anchor="middle" class="ld-lbl">${b.name ?? ''}</text>
      </g>`;
    }
    if (this.isCoil(b)) {
      return html`<g class="ld-sym ${sel ? 'sel' : ''}"
          @click=${(e: Event) => { e.stopPropagation(); this.selId = b.id; }}
          @dblclick=${() => this.renameBlock(b)}>
        <line x1=${x} y1=${cy} x2=${x + 20} y2=${cy} stroke=${stroke} />
        <circle cx=${cx} cy=${cy} r=${SYM_H / 2 - 8} fill="none" stroke=${stroke} />
        <line x1=${x + SYM_W - 20} y1=${cy} x2=${x + SYM_W} y2=${cy} stroke=${stroke} />
        <text x=${cx} y=${y - 4} text-anchor="middle" class="ld-lbl">${b.name ?? ''}</text>
      </g>`;
    }
    /* generic block: box with label */
    return html`<g class="ld-sym ${sel ? 'sel' : ''}"
        @click=${(e: Event) => { e.stopPropagation(); this.selId = b.id; }}
        @dblclick=${() => this.renameBlock(b)}>
      <rect x=${x} y=${y} width=${SYM_W} height=${SYM_H} fill="none"
        stroke=${stroke} rx="3" />
      <text x=${cx} y=${cy + 4} text-anchor="middle" class="ld-lbl">
        ${this.blockLabel(b)}
      </text>
    </g>`;
  }

  private renderWire(w: Wire): TemplateResult | typeof nothing {
    const net = this.net;
    if (!net) return nothing;
    const sb = net.blocks.find((b) => b.id === w.src.block);
    if (!sb) return nothing;
    const x1 = this.termX(sb, true);
    const y1 = this.termY(sb);
    return html`${w.dsts.map((d) => {
      const db = net.blocks.find((b) => b.id === d.block);
      if (!db) return nothing;
      const x2 = this.termX(db, false);
      const y2 = this.termY(db);
      const live = this.values?.get(`plc.${this.pou!.name}.__probe_${w.id}`);
      return html`<polyline
        points=${`${x1},${y1} ${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`}
        fill="none" stroke="${live !== undefined ? 'var(--accent,#6cf)' : 'currentColor'}"
        stroke-width="1.5" opacity="0.8" />`;
    })}`;
  }

  private onCanvasClick(e: MouseEvent): void {
    const svg = (e.currentTarget as SVGSVGElement);
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const loc = pt.matrixTransform(svg.getScreenCTM()?.inverse());
    if (this.tool === 'wire') {
      this.onWireClick(loc.x, loc.y);
      return;
    }
    if (this.tool === 'select') { this.selId = 0; this.wireSrc = 0; return; }
    const gx = Math.round((loc.x - RAIL_L) / GRID) * GRID;
    const gy = Math.round(loc.y / (GRID * 2)) * GRID * 2 + GRID / 2;
    if (gx < 0 || gy < 0) return;
    this.placeBlock(gx, gy);
  }

  /** block whose symbol contains the svg point, if any. */
  private blockAt(x: number, y: number): Block | undefined {
    return this.net?.blocks.find(
      (b) =>
        x >= RAIL_L + b.pos.x && x <= RAIL_L + b.pos.x + SYM_W &&
        y >= b.pos.y && y <= b.pos.y + SYM_H,
    );
  }

  /** wire tool: click a contact to arm it as source, then click
      contacts/coils to add destinations. Click empty space or the
      source again to disarm. */
  private onWireClick(x: number, y: number): void {
    const net = this.net;
    if (!net) return;
    const b = this.blockAt(x, y);
    if (!b) { this.wireSrc = 0; this.requestUpdate(); return; }
    if (!this.wireSrc) {
      // only contacts source flow
      if (this.isContact(b)) {
        this.wireSrc = b.id;
        this.selId = b.id;
        this.requestUpdate();
      }
      return;
    }
    if (b.id === this.wireSrc) { this.wireSrc = 0; this.requestUpdate(); return; }
    if (this.isContact(b) || this.isCoil(b)) {
      // first wire in the network: freeze every rung's positional
      // series order into explicit wires so branch edits don't
      // strand unwired elements (series wires ≡ positional ANDs)
      if (net.wires.length === 0) this.autoWireSeries(net);
      this.addWire(this.wireSrc, b.id);
      this.emit();
    }
  }

  /** dst into an existing same-src wire's dsts, else a new wire. */
  private addWire(src: number, dst: number): void {
    const net = this.net;
    if (!net || src === dst) return;
    const w = net.wires.find((w) => w.src.block === src);
    const ref = { block: dst, port: 0 as const };
    if (w) {
      if (!w.dsts.some((d) => d.block === dst)) w.dsts.push(ref);
    } else {
      net.wires.push({
        id: nextNodeId(this.pou!),
        src: { block: src, port: 0 },
        dsts: [ref],
      });
    }
  }

  /** Convert each rung row's positional order into series wires:
      contacts chained left→right by x, every coil fed by the last
      contact. Semantics identical to positional lowering. */
  private autoWireSeries(net: Network): void {
    const rows = new Map<number, Block[]>();
    for (const b of net.blocks) {
      if (b.kind !== 'variable') continue;
      const r = this.rungOf(b);
      const arr = rows.get(r) ?? [];
      arr.push(b);
      rows.set(r, arr);
    }
    for (const arr of rows.values()) {
      arr.sort((a, b) => a.pos.x - b.pos.x);
      const contacts = arr.filter((b) => this.isContact(b));
      const coils = arr.filter((b) => this.isCoil(b));
      for (let i = 0; i + 1 < contacts.length; i++)
        this.addWire(contacts[i]!.id, contacts[i + 1]!.id);
      const last = contacts[contacts.length - 1];
      if (last) for (const c of coils) this.addWire(last.id, c.id);
    }
  }

  private placeBlock(x: number, y: number): void {
    const net = this.net;
    if (!net) return;
    let role: VarRole | undefined;
    let kind: Block['kind'] = 'function';
    let typeRef = '';
    let name: string | undefined;
    if (this.tool === 'no' || this.tool === 'nc') {
      kind = 'variable'; role = 'in';
      name = `c${nextNodeId(this.pou!)}`;
    } else if (this.tool === 'coil') {
      kind = 'variable'; role = 'out';
      name = `q${nextNodeId(this.pou!)}`;
    } else if (this.tool === 'box') {
      typeRef = 'TON';
    }
    const b: Block = {
      id: nextNodeId(this.pou!),
      kind,
      type_ref: typeRef,
      ...(name ? { name } : {}),
      pos: { x, y },
      params: {},
      exec_order: 0,
      negated: this.tool === 'nc' ? [0] : [],
      comment: '',
      ...(role ? { role } : {}),
    };
    net.blocks.push(b);
    this.selId = b.id;
    this.emit();
  }

  private renameBlock(b: Block): void {
    const cur = b.name ?? '';
    const v = window.prompt('variable name', cur);
    if (v === null) return;
    b.name = v.trim() || undefined;
    this.emit();
  }

  private deleteSel(): void {
    const net = this.net;
    if (!net || !this.selId) return;
    net.blocks = net.blocks.filter((b) => b.id !== this.selId);
    net.wires = net.wires.filter(
      (w) => w.src.block !== this.selId && !w.dsts.some((d) => d.block === this.selId));
    if (this.wireSrc === this.selId) this.wireSrc = 0;
    this.selId = 0;
    this.emit();
  }

  private onKey(e: KeyboardEvent): void {
    if ((e.target as HTMLElement).closest('input,textarea,select')) return;
    if (e.key === 'Escape') { this.wireSrc = 0; this.requestUpdate(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      this.deleteSel();
    }
  }

  override render(): TemplateResult {
    const net = this.net;
    if (!net) return html`<p class="plc-dim">Select an LD network in the explorer.</p>`;
    const w = this.svgW();
    const h = this.svgH();
    return html`
      <div class="ld-toolbar">
        ${(['select', 'no', 'nc', 'coil', 'box', 'wire'] as Tool[]).map(
          (t) => html`<button
            class="chip-btn ${this.tool === t ? 'active' : ''}"
            @click=${() => { this.tool = t; if (t !== 'wire') this.wireSrc = 0; }}
          >${{ select: 'select', no: 'NO | |', nc: 'NC |/|', coil: 'coil -( )-', box: 'box', wire: 'wire →' }[t]}</button>`,
        )}
        <button class="chip-btn" ?disabled=${!this.selId}
          @click=${() => this.deleteSel()}>delete</button>
        <span class="plc-dim">${net.blocks.length} elements · ${net.wires?.length ?? 0} wires · ${net.kind}</span>
        ${this.wireSrc
          ? html`<span class="plc-dim">wire: click destinations (Esc to finish)</span>`
          : nothing}
      </div>
      <svg class="ld-svg" width=${w} height=${h} tabindex="0"
        @click=${(e: MouseEvent) => this.onCanvasClick(e)}
        @keydown=${(e: KeyboardEvent) => this.onKey(e)}>
        <!-- power rails -->
        <line x1=${RAIL_L} y1="8" x2=${RAIL_L} y2=${h - 8} stroke="currentColor" stroke-width="3" />
        <line x1=${w - RAIL_R} y1="8" x2=${w - RAIL_R} y2=${h - 8} stroke="currentColor" stroke-width="3" />
        <!-- rung guides -->
        ${[...this.blocksByRung().keys()].map(
          (r) => html`<line x1=${RAIL_L} y1=${r * GRID * 2 + GRID}
            x2=${w - RAIL_R} y2=${r * GRID * 2 + GRID}
            stroke="currentColor" stroke-width="0.4" opacity="0.25"
            stroke-dasharray="4 4" />`,
        )}
        ${(net.wires ?? []).map((wr) => this.renderWire(wr))}
        ${net.blocks.map((b) => this.renderSymbol(b))}
      </svg>
    `;
  }

  createRenderRoot(): this {
    return this;
  }
}

customElements.define('ld-canvas', LdCanvas);
