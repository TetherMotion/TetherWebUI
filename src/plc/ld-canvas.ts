/**
 * <ld-canvas> — ladder-diagram canvas for networks with kind === 'ld'.
 *
 * The project model stores LD networks as the same blocks+wires
 * structure as FBD (PLCopen import maps contacts/coils/boxes onto
 * variable/function blocks with role + pos). This canvas renders them
 * rung-style: power rails on both sides, NO/NC contacts and coils as
 * ladder glyphs, other blocks as labeled boxes, wires as connectors.
 *
 * Editing mirrors <fbd-canvas>: click the toolbar to arm a symbol,
 * click the canvas to place it on the grid; drag blocks (grid/rung
 * snapped), shift-click or marquee multi-select, copy/paste/duplicate,
 * undo/redo snapshots, wire-end reconnect by dragging a wire endpoint,
 * live values on variables and probed wires. All edits mutate the
 * shared Network model and emit `change` so the IDE persists them.
 */
import { LitElement, html, nothing, TemplateResult } from 'lit';
import { Block, Comment, Jump, Label, Network, Pou, ReturnMarker, VarRole, Wire, nextNodeId } from './model';
import { probeKeys, resolveKey, varKeys } from './mon';

const GRID = 28;          // px per grid step
const SYM_W = 84;         // contact/coil symbol width
const SYM_H = 44;         // symbol height
const RAIL_L = 24;
const RAIL_R = 24;
const VB_W = 1100;        // view window, content px
const VB_H = 620;

function fmtLive(v: unknown): string {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3);
  if (typeof v === 'boolean') return v ? 'T' : 'F';
  return String(v);
}

type Tool = 'select' | 'no' | 'nc' | 'coil' | 'box' | 'wire';

const TOOL_TITLES: Record<Tool, string> = {
  select: 'select/move elements — drag to move, click to select',
  no: 'place a normally-open contact',
  nc: 'place a normally-closed contact',
  coil: 'place an output coil',
  box: 'place a function block',
  wire: 'start a wire — click destinations to connect',
};

interface Drag {
  anchor: number;
  starts: Map<number, { x: number; y: number }>;
  /** pointer svg pos at drag start minus anchor pos (grab offset). */
  gx: number;
  gy: number;
  moved: boolean;
}

interface Marquee {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  additive: boolean;
  moved: boolean;
}

interface Pan {
  sx: number;
  sy: number;
  vx: number;
  vy: number;
}

/** Wire-end reconnect drag: which wire, which end, cursor pos. */
interface PendingWire {
  wire: number;
  end: 'src' | 'dst';
  di: number; // dsts index when end === 'dst'
  x: number;
  y: number;
}

interface Clipboard {
  blocks: Block[];
  wires: Wire[];
}

export class LdCanvas extends LitElement {
  static properties = {
    pou: { attribute: false },
    netIndex: { type: Number },
    pous: { attribute: false },
    values: { attribute: false },
    tool: { state: true },
    selIds: { state: true },
    selWire: { state: true },
    marquee: { state: true },
    pending: { state: true },
    vb: { state: true },
  };

  declare pou?: Pou;
  declare netIndex: number;
  declare pous: Pou[];
  declare values?: Map<string, unknown>;
  declare tool: Tool;
  declare selIds: Set<number>;
  declare selWire?: number;
  declare marquee?: Marquee;
  declare pending?: PendingWire;
  declare vb: { x: number; y: number; s: number };

  /** wire tool: armed source block awaiting destinations. */
  private wireSrc = 0;
  /** single-selection compat — first id of selIds (tests/IDE read it). */
  get selId(): number {
    return [...this.selIds][0] ?? 0;
  }
  set selId(v: number) {
    this.selIds = v ? new Set([v]) : new Set();
  }

  private drag?: Drag;
  private pan?: Pan;
  private clipboard?: Clipboard;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private stackNet?: Network;
  private suppressClick = false;

  constructor() {
    super();
    this.netIndex = 0;
    this.pous = [];
    this.tool = 'select';
    this.selIds = new Set();
    this.vb = { x: -10, y: -10, s: 1 };
  }

  createRenderRoot(): this {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.tabIndex = 0;
    this.addEventListener('keydown', this.onKey);
  }

  disconnectedCallback(): void {
    this.removeEventListener('keydown', this.onKey);
    super.disconnectedCallback();
  }

  /** net/pou switches invalidate undo stacks (they hold one net's JSON)
      and transient gesture state; the clipboard deliberately survives
      so copy in one network pastes into another. */
  private syncNet(): void {
    const net = this.net;
    if (net === this.stackNet) return;
    /* only a real switch (known net → different net) clears transient
       state — first adoption must not wipe a fresh selection */
    const switching = this.stackNet !== undefined;
    this.stackNet = net;
    this.undoStack = [];
    this.redoStack = [];
    if (!switching) {
      if (net) this.fitView();
      return;
    }
    this.selIds = new Set();
    this.selWire = undefined;
    this.wireSrc = 0;
    this.drag = undefined;
    this.pan = undefined;
    this.marquee = undefined;
    this.pending = undefined;
    this.suppressClick = false;
    if (net) this.fitView();
  }

  private fitView(): void {
    const net = this.net;
    if (!net) return;
    const w = this.svgW();
    const h = this.svgH();
    const s = Math.min(1.4, Math.max(0.35, VB_W / Math.max(w + 60, 200), VB_H / Math.max(h + 60, 200)));
    this.vb = { x: -12, y: -12, s };
  }

  private get net(): Network | undefined {
    return this.pou?.networks[this.netIndex];
  }

  private emit(): void {
    this.dispatchEvent(new CustomEvent('change', { bubbles: true, composed: true }));
  }

  // ---- mutation + undo -----------------------------------------------

  private snapshot(): void {
    this.syncNet();
    const net = this.net;
    if (!net) return;
    this.undoStack.push(JSON.stringify(net));
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }

  private restore(json: string): void {
    const net = this.net;
    const pou = this.pou;
    if (!net || !pou) return;
    pou.networks[this.netIndex] = JSON.parse(json) as Network;
    /* the restored object is a new identity — keep stackNet pointing
       at it or the next syncNet() would treat this as a network
       switch and wipe the undo/redo stacks */
    this.stackNet = pou.networks[this.netIndex];
    this.selIds = new Set();
    this.selWire = undefined;
    this.emit();
    this.requestUpdate();
  }

  private undo(): void {
    this.syncNet();
    const prev = this.undoStack.pop();
    const net = this.net;
    if (prev === undefined || !net) return;
    this.redoStack.push(JSON.stringify(net));
    this.restore(prev);
  }

  private redo(): void {
    this.syncNet();
    const next = this.redoStack.pop();
    const net = this.net;
    if (next === undefined || !net) return;
    this.undoStack.push(JSON.stringify(net));
    this.restore(next);
  }

  private mutate(fn: (net: Network) => void): void {
    this.syncNet();
    const net = this.net;
    if (!net) return;
    this.snapshot();
    fn(net);
    this.emit();
    this.requestUpdate();
  }

  // ---- rung geometry ---------------------------------------------------

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
    for (const c of this.net?.comments ?? []) max = Math.max(max, c.pos.x + 190);
    return max + RAIL_R;
  }

  private svgH(): number {
    const rungs = this.blocksByRung();
    const n = Math.max(1, ...[...rungs.keys()].map((r) => r + 1), 0);
    let h = n * GRID * 2 + 40;
    for (const c of this.net?.comments ?? []) h = Math.max(h, c.pos.y + 50);
    return h;
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
    return b.kind === 'variable' && b.role !== 'out' && b.flow !== 'data';
  }

  private isCoil(b: Block): boolean {
    return b.kind === 'variable' && b.role === 'out' && b.flow !== 'data';
  }

  /** series (through-power) element: contacts and function boxes. */
  private isSeries(b: Block): boolean {
    return this.isContact(b) || (b.kind === 'function' && b.flow !== 'data');
  }

  private canWireSrc(b: Block): boolean {
    return this.isSeries(b);
  }

  private canWireDst(b: Block): boolean {
    return this.isSeries(b) || this.isCoil(b);
  }

  /** live catalog value for a variable block, if published. */
  private liveOf(b: Block): { key: string; v: unknown } | undefined {
    if (!this.values || !this.pou || b.kind !== 'variable' || !b.name) return undefined;
    const k = resolveKey(varKeys(this.pou, b), this.values);
    return k !== undefined ? { key: k, v: this.values.get(k) } : undefined;
  }

  // ---- selection + clipboard -------------------------------------------

  private deleteSel(): void {
    this.syncNet();
    const net = this.net;
    const ids = this.selIds;
    const wire = this.selWire;
    if (!net || (!ids.size && wire === undefined)) return;
    this.mutate((n) => {
      if (ids.size) {
        n.blocks = n.blocks.filter((b) => !ids.has(b.id));
        for (const w of n.wires) {
          w.dsts = w.dsts.filter((d) => !ids.has(d.block));
        }
        n.wires = n.wires.filter((w) => !ids.has(w.src.block) && w.dsts.length > 0);
        n.assocs = n.assocs.filter((a) => !ids.has(a.dst.block));
      }
      if (wire !== undefined) n.wires = n.wires.filter((w) => w.id !== wire);
      if (this.wireSrc && ids.has(this.wireSrc)) this.wireSrc = 0;
      this.selIds = new Set();
      this.selWire = undefined;
    });
  }

  private copySel(): void {
    this.syncNet();
    const net = this.net;
    const ids = this.selIds;
    if (!net || !ids.size) return;
    const blocks = net.blocks.filter((b) => ids.has(b.id)).map((b) => structuredClone(b));
    const wires = net.wires
      .filter((w) => ids.has(w.src.block) && w.dsts.every((d) => ids.has(d.block)))
      .map((w) => structuredClone(w));
    this.clipboard = { blocks, wires };
  }

  private paste(): void {
    this.syncNet();
    const cb = this.clipboard;
    const net = this.net;
    if (!cb?.blocks.length || !net) return;
    this.mutate((n) => {
      const idMap = new Map<number, number>();
      const pasted: Block[] = [];
      for (const b of cb.blocks) {
        const nb = structuredClone(b);
        nb.id = nextNodeId(this.pou!);
        /* keep rung-grid alignment: 2 grid steps right, one rung down */
        nb.pos = { x: nb.pos.x + GRID * 2, y: nb.pos.y + GRID * 2 };
        idMap.set(b.id, nb.id);
        n.blocks.push(nb);
        pasted.push(nb);
      }
      for (const w of cb.wires) {
        const srcB = idMap.get(w.src.block);
        if (srcB === undefined) continue;
        const dsts = w.dsts
          .filter((d) => idMap.has(d.block))
          .map((d) => ({ block: idMap.get(d.block)!, port: d.port }));
        if (!dsts.length) continue;
        n.wires.push({
          id: nextNodeId(this.pou!),
          src: { block: srcB, port: w.src.port },
          dsts,
          ...(w.probe ? { probe: true } : {}),
        });
      }
      /* splice pasted elements into their rung chains so they don't
         sit stranded next to wired neighbours */
      for (const b of pasted.sort((a, b2) => a.pos.x - b2.pos.x)) this.integrateRung(n, b);
      this.selIds = new Set(idMap.values());
      this.selWire = undefined;
    });
  }

  // ---- rung wire integration --------------------------------------------

  /** peers of b's rung that participate in power flow, x-sorted. */
  private rungPeers(net: Network, b: Block): Block[] {
    return net.blocks
      .filter((x) => this.rungOf(x) === this.rungOf(b) && (this.isSeries(x) || this.isCoil(x)))
      .sort((a, c) => a.pos.x - c.pos.x);
  }

  /** remove every dst feed into `blockId`; drops emptied wires. */
  private removeDstFeed(net: Network, blockId: number): void {
    for (const w of net.wires) {
      w.dsts = w.dsts.filter((d) => d.block !== blockId);
    }
    net.wires = net.wires.filter((w) => w.dsts.length > 0);
  }

  /** chain one rung's series elements and feed its coils from the
      last series element (positional AND semantics frozen as wires). */
  private wireRungSeries(net: Network, peers: Block[]): void {
    const series = peers.filter((b) => this.isSeries(b));
    const coils = peers.filter((b) => this.isCoil(b));
    for (let i = 0; i + 1 < series.length; i++) this.addWire(net, series[i]!.id, series[i + 1]!.id);
    const last = series[series.length - 1];
    if (last) for (const c of coils) this.addWire(net, last.id, c.id);
  }

  /** After placing/pasting `b`: if its rung is already wired, splice b
      into the local series chain; if the rung is unwired but has
      peers, freeze the whole rung into series wires. */
  integrateRung(net: Network, b: Block): void {
    const peers = this.rungPeers(net, b);
    if (!peers.some((p) => p.id === b.id)) return;
    const ids = new Set(peers.map((p) => p.id));
    const rungWired = net.wires.some(
      (w) => ids.has(w.src.block) || w.dsts.some((d) => ids.has(d.block)),
    );
    if (!rungWired) {
      if (peers.length > 1) this.wireRungSeries(net, peers);
      return;
    }
    if (this.isSeries(b)) {
      const series = peers.filter((p) => this.isSeries(p));
      const idx = series.findIndex((p) => p.id === b.id);
      if (idx < 0) return;
      const prev = idx > 0 ? series[idx - 1] : undefined;
      const next = idx + 1 < series.length ? series[idx + 1] : undefined;
      if (next) this.removeDstFeed(net, next.id);
      if (prev) this.addWire(net, prev.id, b.id);
      if (next) this.addWire(net, b.id, next.id);
      if (!next) {
        /* b is the last series element — coils re-feed from it */
        for (const c of peers.filter((p) => this.isCoil(p))) {
          this.removeDstFeed(net, c.id);
          this.addWire(net, b.id, c.id);
        }
      }
    } else if (this.isCoil(b)) {
      const last = [...peers].reverse().find((p) => this.isSeries(p));
      if (last) this.addWire(net, last.id, b.id);
    }
  }

  /** Convert each rung row's positional order into series wires:
      contacts chained left→right by x, every coil fed by the last
      contact. Semantics identical to positional lowering. */
  private autoWireSeries(net: Network): void {
    const rows = new Map<number, Block[]>();
    for (const b of net.blocks) {
      if (!this.isSeries(b) && !this.isCoil(b)) continue;
      const r = this.rungOf(b);
      const arr = rows.get(r) ?? [];
      arr.push(b);
      rows.set(r, arr);
    }
    for (const arr of rows.values()) this.wireRungSeries(net, arr);
  }

  /** dst into an existing same-src wire's dsts, else a new wire. */
  private addWire(net: Network, src: number, dst: number): void {
    if (src === dst) return;
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

  // ---- placement --------------------------------------------------------

  private placeBlock(x: number, y: number): void {
    this.syncNet();
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
    this.mutate((n) => {
      n.blocks.push(b);
      this.integrateRung(n, b);
      this.selIds = new Set([b.id]);
      this.selWire = undefined;
    });
  }

  private renameBlock(b: Block): void {
    const cur = b.name ?? '';
    const v = window.prompt('variable name', cur);
    if (v === null) return;
    this.mutate((n) => {
      const blk = n.blocks.find((x) => x.id === b.id);
      if (blk) blk.name = v.trim() || undefined;
    });
  }

  // ---- wire tool ---------------------------------------------------------

  /** wire tool: click a series element to arm it as source, then click
      elements to add destinations. Click empty space or the source
      again to disarm. */
  private onWireClick(x: number, y: number): void {
    this.syncNet();
    const net = this.net;
    if (!net) return;
    const b = this.blockAt(x, y);
    if (!b) { this.wireSrc = 0; this.requestUpdate(); return; }
    if (!this.wireSrc) {
      if (this.canWireSrc(b)) {
        this.wireSrc = b.id;
        this.selIds = new Set([b.id]);
        this.selWire = undefined;
        this.requestUpdate();
      }
      return;
    }
    if (b.id === this.wireSrc) { this.wireSrc = 0; this.requestUpdate(); return; }
    if (this.canWireDst(b)) {
      this.mutate((n) => {
        /* first wire in the network: freeze every rung's positional
           series order into explicit wires so branch edits don't
           strand unwired elements (series wires ≡ positional ANDs) */
        if (n.wires.length === 0) this.autoWireSeries(n);
        this.addWire(n, this.wireSrc, b.id);
      });
    }
  }

  /** wire-end reconnect: move dst `di` of wire `id` to `dstBlock`. */
  private moveWireDst(net: Network, id: number, di: number, dstBlock: number): void {
    const w = net.wires.find((x) => x.id === id);
    if (!w || di < 0 || di >= w.dsts.length) return;
    const d = w.dsts[di]!;
    /* already there? */
    if (d.block === dstBlock) return;
    w.dsts.splice(di, 1);
    if (!w.dsts.length) net.wires = net.wires.filter((x) => x.id !== id);
    this.addWire(net, w.src.block, dstBlock);
  }

  /** wire-end reconnect: move the src of wire `id` to `srcBlock`. */
  private moveWireSrc(net: Network, id: number, srcBlock: number): void {
    const w = net.wires.find((x) => x.id === id);
    if (!w || w.src.block === srcBlock) return;
    const dsts = w.dsts;
    net.wires = net.wires.filter((x) => x.id !== id);
    const existing = net.wires.find((x) => x.src.block === srcBlock);
    if (existing) {
      for (const d of dsts) {
        if (!existing.dsts.some((e) => e.block === d.block)) existing.dsts.push(d);
      }
    } else {
      net.wires.push({ id: nextNodeId(this.pou!), src: { block: srcBlock, port: 0 }, dsts });
    }
  }

  // ---- pointer / keyboard -----------------------------------------------

  private svgPt(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const el = this.querySelector('svg');
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    const vw = VB_W / this.vb.s;
    const vh = VB_H / this.vb.s;
    return {
      x: this.vb.x + ((e.clientX - r.left) / r.width) * vw,
      y: this.vb.y + ((e.clientY - r.top) / r.height) * vh,
    };
  }

  /** snap a content-px point to the placement grid (x grid, y rung). */
  private snapPos(x: number, y: number): { x: number; y: number } {
    return {
      x: Math.round((x - RAIL_L) / GRID) * GRID,
      y: Math.round(y / (GRID * 2)) * GRID * 2 + GRID / 2,
    };
  }

  private blockAt(x: number, y: number): Block | undefined {
    return this.net?.blocks.find(
      (b) =>
        x >= RAIL_L + b.pos.x && x <= RAIL_L + b.pos.x + SYM_W &&
        y >= b.pos.y && y <= b.pos.y + SYM_H,
    );
  }

  private onBlockDown(e: PointerEvent, b: Block): void {
    if (this.pending) return;
    if (this.tool === 'wire') return; // wire clicks handled on click
    if (e.button !== 0) return;
    if (e.shiftKey) {
      const s = new Set(this.selIds);
      if (s.has(b.id)) s.delete(b.id);
      else s.add(b.id);
      this.selIds = s;
      this.selWire = undefined;
      e.stopPropagation();
      return;
    }
    if (!this.selIds.has(b.id)) this.selIds = new Set([b.id]);
    this.selWire = undefined;
    const p = this.svgPt(e);
    const starts = new Map<number, { x: number; y: number }>();
    for (const id of this.selIds) {
      const bb = this.net?.blocks.find((x) => x.id === id);
      if (bb) starts.set(id, { x: bb.pos.x, y: bb.pos.y });
    }
    /* grab offset = pointer minus the anchor's symbol centre, so the
       block doesn't jump to centre under the cursor */
    this.drag = {
      anchor: b.id,
      starts,
      gx: p.x - this.termX(b, false) - SYM_W / 2,
      gy: p.y - this.termY(b),
      moved: false,
    };
    try {
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } catch {
      /* synthetic events */
    }
    e.stopPropagation();
  }

  private onBlockClick(e: MouseEvent, b: Block): void {
    if (this.suppressClick) { this.suppressClick = false; return; }
    e.stopPropagation();
    if (this.tool === 'wire') {
      const c = this.svgPt(e);
      this.onWireClick(c.x, c.y);
      return;
    }
    if (this.tool === 'select') {
      /* pointerdown already selected; plain click keeps selection */
      return;
    }
    /* placement tools: clicking a symbol does not stack a new block */
  }

  private onWireEndDown(e: PointerEvent, w: Wire, end: 'src' | 'dst', di: number): void {
    e.stopPropagation();
    const p = this.svgPt(e);
    this.pending = { wire: w.id, end, di, x: p.x, y: p.y };
    try {
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } catch {
      /* synthetic events */
    }
  }

  private onSvgMove(e: PointerEvent): void {
    if (this.pan) {
      const el = this.querySelector('svg');
      if (el) {
        const r = el.getBoundingClientRect();
        /* content px per screen px = viewW / rect.width */
        const kx = (VB_W / this.vb.s) / r.width;
        const ky = (VB_H / this.vb.s) / r.height;
        this.vb = {
          ...this.vb,
          x: this.pan.vx - (e.clientX - this.pan.sx) * kx,
          y: this.pan.vy - (e.clientY - this.pan.sy) * ky,
        };
      }
      return;
    }
    const p = this.svgPt(e);
    if (this.marquee) {
      const moved =
        this.marquee.moved ||
        Math.abs(p.x - this.marquee.x0) + Math.abs(p.y - this.marquee.y0) > 4;
      this.marquee = { ...this.marquee, x1: p.x, y1: p.y, moved };
      return;
    }
    if (this.pending) {
      this.pending = { ...this.pending, x: p.x, y: p.y };
      return;
    }
    const d = this.drag;
    if (!d) return;
    const net = this.net;
    const a = d.starts.get(d.anchor);
    if (!net || !a) return;
    /* desired anchor pos: pointer minus grab offset, snapped to the
       placement grid (x grid, y rung centre). wantX/wantY are already
       pos coords (RAIL_L excluded), so snap directly. The snapped
       delta is rigid — every selected block moves together. */
    const wantX = p.x - d.gx - SYM_W / 2 - RAIL_L;
    const wantY = p.y - d.gy - SYM_H / 2;
    const snapped = {
      x: Math.round(wantX / GRID) * GRID,
      y: Math.round(wantY / (GRID * 2)) * GRID * 2 + GRID / 2,
    };
    const ddx = snapped.x - a.x;
    const ddy = snapped.y - a.y;
    if (!ddx && !ddy && d.moved) return;
    if (!d.moved) {
      d.moved = true;
      this.snapshot();
    }
    for (const [id, s] of d.starts) {
      const bb = net.blocks.find((x) => x.id === id);
      if (bb) bb.pos = { x: s.x + ddx, y: s.y + ddy };
    }
    this.requestUpdate();
  }

  private onSvgUp(e: PointerEvent): void {
    if (this.pan) { this.pan = undefined; return; }
    const m = this.marquee;
    if (m) {
      this.marquee = undefined;
      const net = this.net;
      if (net && m.moved) {
        const x0 = Math.min(m.x0, m.x1);
        const x1 = Math.max(m.x0, m.x1);
        const y0 = Math.min(m.y0, m.y1);
        const y1 = Math.max(m.y0, m.y1);
        const hit = net.blocks
          .filter((b) => {
            const bx = RAIL_L + b.pos.x;
            const by = b.pos.y;
            return bx < x1 && bx + SYM_W > x0 && by < y1 && by + SYM_H > y0;
          })
          .map((b) => b.id);
        this.selIds = m.additive ? new Set([...this.selIds, ...hit]) : new Set(hit);
        this.selWire = undefined;
      } else if (net && !m.moved) {
        /* plain click on empty canvas */
        this.onCanvasClick(e);
      }
      return;
    }
    if (this.pending) {
      const pend = this.pending;
      this.pending = undefined;
      const p = this.svgPt(e);
      const b = this.blockAt(p.x, p.y);
      if (b && this.net) {
        this.mutate((n) => {
          if (pend.end === 'dst') {
            if (this.canWireDst(b)) this.moveWireDst(n, pend.wire, pend.di, b.id);
          } else {
            if (this.canWireSrc(b)) this.moveWireSrc(n, pend.wire, b.id);
          }
        });
      }
      return;
    }
    const d = this.drag;
    if (!d) return;
    this.drag = undefined;
    if (d.moved) {
      this.suppressClick = true;
      this.emit();
      this.requestUpdate();
    }
  }

  private onSvgDown(e: PointerEvent): void {
    this.syncNet();
    const onBg = e.target === e.currentTarget || (e.target as Element).tagName === 'rect';
    if (!onBg) return;
    if (e.button === 1 || (e.button === 0 && (e.ctrlKey || e.metaKey))) {
      this.pan = { sx: e.clientX, sy: e.clientY, vx: this.vb.x, vy: this.vb.y };
      this.selIds = new Set();
      this.selWire = undefined;
    } else if (e.button === 0) {
      const p = this.svgPt(e);
      this.marquee = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, additive: e.shiftKey, moved: false };
      try {
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      } catch {
        /* synthetic events */
      }
    }
  }

  private onCanvasClick(e: MouseEvent): void {
    const p = this.svgPt(e);
    if (this.tool === 'wire') {
      this.onWireClick(p.x, p.y);
      return;
    }
    if (this.tool === 'select') {
      this.selIds = new Set();
      this.selWire = undefined;
      this.wireSrc = 0;
      return;
    }
    const g = this.snapPos(p.x, p.y);
    if (g.x < 0 || g.y < GRID / 2) return;
    this.placeBlock(g.x, g.y);
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const p = this.svgPt(e);
    const ns = Math.min(3, Math.max(0.3, this.vb.s * (e.deltaY < 0 ? 1.1 : 0.9)));
    this.vb = {
      s: ns,
      x: p.x - (p.x - this.vb.x) * (this.vb.s / ns),
      y: p.y - (p.y - this.vb.y) * (this.vb.s / ns),
    };
  }

  private onKey = (e: KeyboardEvent): void => {
    const t = e.target as HTMLElement | null;
    if (
      t &&
      (t.tagName === 'INPUT' ||
        t.tagName === 'TEXTAREA' ||
        t.tagName === 'SELECT' ||
        t.isContentEditable)
    )
      return;
    const mod = e.ctrlKey || e.metaKey;
    if (
      (e.key === 'Delete' || e.key === 'Backspace') &&
      (this.selIds.size || this.selWire !== undefined)
    ) {
      this.deleteSel();
      e.preventDefault();
    } else if (e.key === 'Escape') {
      this.wireSrc = 0;
      this.pending = undefined;
      this.selIds = new Set();
      this.selWire = undefined;
      this.marquee = undefined;
      this.requestUpdate();
    } else if ((e.key === 'p' || e.key === 'P') && this.selWire !== undefined) {
      this.toggleProbe();
      e.preventDefault();
    } else if (mod && e.key === 'z' && !e.shiftKey) {
      this.undo();
      e.preventDefault();
    } else if (mod && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      this.redo();
      e.preventDefault();
    } else if (mod && e.key === 'c') {
      this.copySel();
      e.preventDefault();
    } else if (mod && e.key === 'v') {
      this.paste();
      e.preventDefault();
    } else if (mod && e.key === 'd') {
      this.copySel();
      this.paste();
      e.preventDefault();
    } else if (mod && e.key === 'a') {
      this.selIds = new Set(this.net?.blocks.map((b) => b.id));
      this.selWire = undefined;
      e.preventDefault();
    }
  };

  /** P on a selected wire toggles its live probe — the lowerer emits a
      `__probe_<id>` field whose value renders beside the wire. */
  private toggleProbe(): void {
    const id = this.selWire;
    if (id === undefined) return;
    this.mutate((net) => {
      const w = net.wires.find((x) => x.id === id);
      if (!w) return;
      if (w.probe) delete w.probe;
      else w.probe = true;
    });
  }

  // ---- render ------------------------------------------------------------

  override render(): TemplateResult {
    this.syncNet();
    const net = this.net;
    if (!net) return html`<p class="plc-dim">Select an LD network in the explorer.</p>`;
    const vb = this.vb;
    const vw = VB_W / vb.s;
    const vh = VB_H / vb.s;
    return html`
      <div class="ld-toolbar">
        ${(['select', 'no', 'nc', 'coil', 'box', 'wire'] as Tool[]).map(
          (t) => html`<button
            class="chip-btn ${this.tool === t ? 'active' : ''}"
            title=${TOOL_TITLES[t]}
            @click=${() => { this.tool = t; if (t !== 'wire') this.wireSrc = 0; }}
          >${{ select: 'select', no: 'NO | |', nc: 'NC |/|', coil: 'coil -( )-', box: 'box', wire: 'wire →' }[t]}</button>`,
        )}
        <button class="chip-btn" title="Undo (ctrl-z)" ?disabled=${!this.undoStack.length}
          @click=${() => this.undo()}>↶</button>
        <button class="chip-btn" title="Redo (ctrl-y)" ?disabled=${!this.redoStack.length}
          @click=${() => this.redo()}>↷</button>
        <button class="chip-btn" title="Copy (ctrl-c)" ?disabled=${!this.selIds.size}
          @click=${() => this.copySel()}>⧉</button>
        <button class="chip-btn" title="Paste (ctrl-v)" ?disabled=${!this.clipboard?.blocks.length}
          @click=${() => this.paste()}>⎘</button>
        <button class="chip-btn" title="Delete (del)"
          ?disabled=${!this.selIds.size && this.selWire === undefined}
          @click=${() => this.deleteSel()}>delete</button>
        <button class="chip-btn"
          title="toggle live probe on the selected wire (P)"
          ?disabled=${this.selWire === undefined}
          class="${this.selWire !== undefined && net.wires.find((w) => w.id === this.selWire)?.probe ? 'active' : ''}"
          @click=${() => this.toggleProbe()}>⌁</button>
        <span class="plc-dim">${net.blocks.length} elements · ${net.wires?.length ?? 0} wires · ${net.kind}</span>
        ${this.wireSrc
          ? html`<span class="plc-dim">wire: click destinations (Esc to finish)</span>`
          : nothing}
        ${this.selWire !== undefined
          ? html`<span class="plc-dim">wire #${this.selWire} — drag an end dot to reconnect, Del removes, P probes</span>`
          : nothing}
      </div>
      <svg class="ld-svg" tabindex="0"
        viewBox="${vb.x} ${vb.y} ${vw} ${vh}" preserveAspectRatio="xMinYMin meet"
        @pointerdown=${(e: PointerEvent) => this.onSvgDown(e)}
        @pointermove=${(e: PointerEvent) => this.onSvgMove(e)}
        @pointerup=${(e: PointerEvent) => this.onSvgUp(e)}
        @wheel=${(e: WheelEvent) => this.onWheel(e)}
        @keydown=${(e: KeyboardEvent) => this.onKey(e)}>
        <!-- power rails -->
        <line x1=${RAIL_L} y1="8" x2=${RAIL_L} y2=${this.svgH() - 8} stroke="currentColor" stroke-width="3" />
        <line x1=${this.svgW() - RAIL_R} y1="8" x2=${this.svgW() - RAIL_R} y2=${this.svgH() - 8} stroke="currentColor" stroke-width="3" />
        <!-- rung guides -->
        ${[...this.blocksByRung().keys()].map(
          (r) => html`<line x1=${RAIL_L} y1=${r * GRID * 2 + GRID}
            x2=${this.svgW() - RAIL_R} y2=${r * GRID * 2 + GRID}
            stroke="currentColor" stroke-width="0.4" opacity="0.25"
            stroke-dasharray="4 4" />`,
        )}
        ${this.renderNotes(net)}
        ${(net.wires ?? []).map((wr) => this.renderWire(wr))}
        ${net.blocks.map((b) => this.renderSymbol(b))}
        ${this.pending ? this.pendingSvg() : nothing}
        ${this.marquee ? this.marqueeSvg() : nothing}
      </svg>
    `;
  }

  /** comments / labels / jumps / returns — same model nodes FBD draws. */
  private renderNotes(net: Network): TemplateResult {
    const items: TemplateResult[] = [];
    for (const c of net.comments as Comment[])
      items.push(html`<g transform="translate(${RAIL_L + c.pos.x} ${c.pos.y})">
        <rect class="fbd-note" width="180" height="40"></rect>
        <text class="fbd-note-text" x="4" y="14">${c.text}</text>
      </g>`);
    for (const l of net.labels as Label[])
      items.push(html`<text class="fbd-label" x=${RAIL_L + l.pos.x} y=${l.pos.y}>${l.name}:</text>`);
    for (const j of net.jumps as Jump[])
      items.push(html`<text class="fbd-label" x=${RAIL_L + j.pos.x} y=${j.pos.y}>→ ${j.target}</text>`);
    for (const _r of net.returns as ReturnMarker[])
      items.push(html`<text class="fbd-label" x=${RAIL_L + _r.pos.x} y=${_r.pos.y}>RET</text>`);
    return html`${items}`;
  }

  private renderSymbol(b: Block): TemplateResult {
    const x = RAIL_L + b.pos.x;
    const y = b.pos.y;
    const cx = x + SYM_W / 2;
    const cy = y + SYM_H / 2;
    const sel = this.selIds.has(b.id);
    const stroke = sel ? 'var(--accent,#6cf)' : 'currentColor';
    const live = this.liveOf(b);
    const liveText = live !== undefined
      ? html`<text class="ld-live" x=${cx} y=${y + SYM_H + 12} text-anchor="middle">${fmtLive(live.v)}</text>`
      : nothing;
    const label = this.blockLabel(b);
    if (this.isContact(b) || this.isSeries(b) && b.kind === 'function') {
      const nc = b.negated.length > 0;
      /* | | or |/| contact between two horizontal wires */
      return html`<g class="ld-sym ${sel ? 'sel' : ''}"
          @pointerdown=${(e: PointerEvent) => this.onBlockDown(e, b)}
          @click=${(e: MouseEvent) => this.onBlockClick(e, b)}
          @dblclick=${() => this.renameBlock(b)}>
        <line x1=${x} y1=${cy} x2=${x + 14} y2=${cy} stroke=${stroke} />
        <line x1=${x + SYM_W - 14} y1=${cy} x2=${x + SYM_W} y2=${cy} stroke=${stroke} />
        <line x1=${x + 14} y1=${cy - 12} x2=${x + SYM_W - 14} y2=${cy - 12} stroke=${stroke} />
        <line x1=${x + 14} y1=${cy + 12} x2=${x + SYM_W - 14} y2=${cy + 12} stroke=${stroke} />
        ${nc
          ? html`<line x1=${x + 14} y1=${cy + 12} x2=${x + SYM_W - 14} y2=${cy - 12}
              stroke=${stroke} />`
          : nothing}
        <text x=${cx} y=${y - 4} text-anchor="middle" class="ld-lbl">${label}</text>
        ${liveText}
      </g>`;
    }
    if (this.isCoil(b)) {
      return html`<g class="ld-sym ${sel ? 'sel' : ''}"
          @pointerdown=${(e: PointerEvent) => this.onBlockDown(e, b)}
          @click=${(e: MouseEvent) => this.onBlockClick(e, b)}
          @dblclick=${() => this.renameBlock(b)}>
        <line x1=${x} y1=${cy} x2=${x + 20} y2=${cy} stroke=${stroke} />
        <circle cx=${cx} cy=${cy} r=${SYM_H / 2 - 8} fill="none" stroke=${stroke} />
        <line x1=${x + SYM_W - 20} y1=${cy} x2=${x + SYM_W} y2=${cy} stroke=${stroke} />
        <text x=${cx} y=${y - 4} text-anchor="middle" class="ld-lbl">${label}</text>
        ${liveText}
      </g>`;
    }
    /* generic block: box with label */
    return html`<g class="ld-sym ${sel ? 'sel' : ''}"
        @pointerdown=${(e: PointerEvent) => this.onBlockDown(e, b)}
        @click=${(e: MouseEvent) => this.onBlockClick(e, b)}
        @dblclick=${() => this.renameBlock(b)}>
      <rect x=${x} y=${y} width=${SYM_W} height=${SYM_H} fill="none"
        stroke=${stroke} rx="3" />
      <text x=${cx} y=${cy + 4} text-anchor="middle" class="ld-lbl">
        ${label}
      </text>
      ${liveText}
    </g>`;
  }

  private renderWire(w: Wire): TemplateResult | typeof nothing {
    const net = this.net;
    if (!net) return nothing;
    const sb = net.blocks.find((b) => b.id === w.src.block);
    if (!sb) return nothing;
    const x1 = this.termX(sb, true);
    const y1 = this.termY(sb);
    const sel = this.selWire === w.id;
    const live =
      w.probe && this.values && this.pou
        ? resolveKey(probeKeys(this.pou, w.id), this.values)
        : undefined;
    const segs = w.dsts
      .map((d) => {
        const db = net.blocks.find((b) => b.id === d.block);
        if (!db) return undefined;
        const x2 = this.termX(db, false);
        const y2 = this.termY(db);
        return { d, x2, y2 };
      })
      .filter((s): s is { d: { block: number; port: 0 }; x2: number; y2: number } => !!s);
    return html`<g class="ld-wire ${sel ? 'sel' : ''} ${w.probe ? 'probe' : ''}"
        @click=${(e: MouseEvent) => {
          e.stopPropagation();
          this.selWire = w.id;
          this.selIds = new Set();
        }}>
      ${live !== undefined
        ? html`<text class="ld-live" x=${x1 + 8} y=${y1 - 6}>${String(this.values!.get(live))}</text>`
        : nothing}
      ${segs.map(({ d, x2, y2 }) => html`<polyline
        points=${`${x1},${y1} ${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`}
        fill="none" stroke="${live !== undefined ? 'var(--accent,#6cf)' : sel ? 'var(--accent,#6cf)' : 'currentColor'}"
        stroke-width="${sel ? 2.5 : 1.5}" opacity="0.8" />`)}
      ${sel
        ? html`
            <!-- reconnect handles: drag an end dot onto a new element -->
            <circle class="ld-wire-end" cx=${x1} cy=${y1} r="5"
              @pointerdown=${(e: PointerEvent) => this.onWireEndDown(e, w, 'src', -1)} />
            ${segs.map(({ d, x2, y2 }, i) => html`
              <circle class="ld-wire-end" cx=${x2} cy=${y2} r="5"
                data-di=${i}
                @pointerdown=${(e: PointerEvent) => this.onWireEndDown(e, w, 'dst', i)} />`)}
          `
        : nothing}
    </g>`;
  }

  private pendingSvg(): TemplateResult | typeof nothing {
    const p = this.pending;
    if (!p || !this.net) return nothing;
    const w = this.net.wires.find((x) => x.id === p.wire);
    if (!w) return nothing;
    let ax = 0, ay = 0;
    if (p.end === 'src') {
      const sb = this.net.blocks.find((b) => b.id === w.src.block);
      if (!sb) return nothing;
      ax = this.termX(sb, true); ay = this.termY(sb);
    } else {
      const d = w.dsts[p.di];
      const db = d && this.net.blocks.find((b) => b.id === d.block);
      if (!db) return nothing;
      ax = this.termX(db, false); ay = this.termY(db);
    }
    const mx = (ax + p.x) / 2;
    return html`<polyline class="ld-pending" fill="none"
      points="${ax},${ay} ${mx},${ay} ${mx},${p.y} ${p.x},${p.y}"
      stroke="var(--accent,#6cf)" stroke-width="1.5" stroke-dasharray="5 3" />`;
  }

  private marqueeSvg(): TemplateResult | typeof nothing {
    const m = this.marquee;
    if (!m) return nothing;
    return html`<rect class="ld-marquee"
      x=${Math.min(m.x0, m.x1)} y=${Math.min(m.y0, m.y1)}
      width=${Math.abs(m.x1 - m.x0)} height=${Math.abs(m.y1 - m.y0)} />`;
  }
}

customElements.define('ld-canvas', LdCanvas);
