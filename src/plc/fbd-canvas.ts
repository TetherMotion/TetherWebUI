/**
 * <fbd-canvas> — SVG canvas for one FBD network.
 *
 * Grid-snapped integer positions (fbd.v1 Pos), block/group drag,
 * port-snap wiring (click an out-pin then an in-pin), shift-click pin
 * negation, marquee + shift multi-select, copy/paste/duplicate,
 * align, delete, undo/redo snapshots, middle/ctrl-drag pan and wheel
 * zoom. Mutations edit the network in place and emit `change` for the
 * host to persist.
 *
 * Not yet: comment/label editing UI, wire-end reconnect, clipboard
 * across networks.
 */
import { html, LitElement, nothing, svg, TemplateResult } from 'lit';
import { Assoc, Block, IfaceVar, Network, PortSel, Pou, Wire, nextNodeId, portLabel } from './model';
import { probeKeys, resolveKey, varKeys } from './mon';
import { blockSig, builtinFbSig, inIndex, opRequiredIns, outIndex } from './sigs';
import {
  filterGroup,
  castGroup,
  libraryFbItems,
  livePin,
  PALETTE,
  projectFbItems,
  type DeviceTemplate,
  type PaletteGroup,
  type PaletteItem,
} from './palette';
import { inferNetwork, tyName, type Inference, type TypeIssue } from './types';

/** Compact live-value formatting for pin labels. */
function fmtLive(v: unknown): string {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3);
  if (typeof v === 'boolean') return v ? 'T' : 'F';
  return String(v);
}

const GX = 14; // px per grid unit
const ROW = 24; // px per pin row
const PIN_R = 4;

interface Drag {
  anchor: number;
  starts: Map<number, { x: number; y: number }>;
  dx: number;
  dy: number;
  moved: boolean;
}

interface PendingWire {
  block: number;
  port: number; // out index
  x: number;
  y: number;
}

interface Pan {
  sx: number;
  sy: number;
  vx: number;
  vy: number;
}

interface Marquee {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  additive: boolean;
}

interface Clipboard {
  blocks: Block[];
  wires: Wire[];
  assocs: Assoc[];
}

/** "add device" wizard form state. */
interface DeviceForm {
  name: string;
  channel: 'DI' | 'DO' | 'AI' | 'AO';
  count: number;
  ty: string;
  base: number;
}

export class FbdCanvas extends LitElement {
  declare pou?: Pou;
  declare netIndex: number;
  declare pous: Pou[];

  static properties = {
    pou: { attribute: false },
    netIndex: { type: Number },
    pous: { attribute: false },
    values: { attribute: false },
    diags: { attribute: false },
    libSources: { attribute: false },
    devDlg: { state: true },
    devForm: { state: true },
    catalog: { attribute: false },
    paletteQ: { state: true },
    selIds: { state: true },
    selWire: { state: true },
    pending: { state: true },
    marquee: { state: true },
    vb: { state: true },
  };

  /** polled catalog values for live overlays (key = catalog name). */
  declare values?: Map<string, unknown>;
  /** compile diags; blocks flagged via fbd{sheet,node} get an error outline. */
  declare diags?: { fbd?: { sheet: number; node: number; pin: number } }[];
  /** attached ST sources — scanned for library FUNCTION_BLOCKs. */
  declare libSources?: string[];
  /** "add device" wizard state (template preselected by the palette). */
  declare devDlg?: { tpl?: DeviceTemplate };
  /** wizard form fields. */
  declare devForm?: DeviceForm;
  /** installed-library palette groups (from the proxy /blocks catalog). */
  declare catalog?: PaletteGroup[];
  /** palette search filter. */
  declare paletteQ: string;

  /** last inference (pin types + type issues) for rendering. */
  private inf?: Inference;

  declare selIds: Set<number>;
  declare selWire?: number;
  declare pending?: PendingWire;
  declare marquee?: Marquee;
  declare vb: { x: number; y: number; s: number };

  private drag?: Drag;
  private pan?: Pan;
  private clipboard?: Clipboard;
  private undoStack: string[] = [];
  private redoStack: string[] = [];

  constructor() {
    super();
    this.netIndex = 0;
    this.pous = [];
    this.selIds = new Set();
    this.vb = { x: -20, y: -20, s: 1 };
    this.paletteQ = '';
  }

  createRenderRoot(): this {
    return this;
  }

  private get net(): Network | undefined {
    return this.pou?.networks[this.netIndex];
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

  // ---- mutation + undo -----------------------------------------------

  private emitChange(): void {
    this.dispatchEvent(new CustomEvent('change', { bubbles: true, composed: true }));
  }

  private snapshot(): void {
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
    this.selIds = new Set();
    this.selWire = undefined;
    this.emitChange();
    this.requestUpdate();
  }

  private undo(): void {
    const prev = this.undoStack.pop();
    const net = this.net;
    if (prev === undefined || !net) return;
    this.redoStack.push(JSON.stringify(net));
    this.restore(prev);
  }

  private redo(): void {
    const next = this.redoStack.pop();
    const net = this.net;
    if (next === undefined || !net) return;
    this.undoStack.push(JSON.stringify(net));
    this.restore(next);
  }

  private mutate(fn: (net: Network) => void): void {
    const net = this.net;
    if (!net) return;
    this.snapshot();
    fn(net);
    this.emitChange();
    this.requestUpdate();
  }

  // ---- palette --------------------------------------------------------

  /** Grid x for a new block — right of the rightmost existing block so
      pins never hide under a later block's rect. */
  private nextBlockX(net: Network, kind: Block['kind']): number {
    const uw = (k: Block['kind']) => (k === 'variable' ? 7 : 8);
    const right = net.blocks.reduce((m, b) => Math.max(m, b.pos.x + uw(b.kind)), 0);
    return right + 2;
  }

  private addBlock(kind: Block['kind'], typeRef: string, role?: Block['role']): void {
    this.mutate((net) => {
      net.blocks.push({
        id: nextNodeId(this.pou!),
        kind,
        type_ref: typeRef,
        pos: { x: this.nextBlockX(net, kind), y: 2 },
        params: {},
        exec_order: 0,
        negated: [],
        comment: '',
        ...(role ? { role } : {}),
        ...(kind === 'variable' ? { name: `v${net.blocks.length}` } : {}),
      });
    });
  }

  private deleteSel(): void {
    const ids = this.selIds;
    const wire = this.selWire;
    if (!ids.size && wire === undefined) return;
    this.mutate((net) => {
      if (ids.size) {
        net.blocks = net.blocks.filter((b) => !ids.has(b.id));
        for (const w of net.wires) {
          w.dsts = w.dsts.filter((d) => !ids.has(d.block));
        }
        net.wires = net.wires.filter((w) => !ids.has(w.src.block) && w.dsts.length > 0);
        net.assocs = net.assocs.filter((a) => !ids.has(a.dst.block));
      }
      if (wire !== undefined) net.wires = net.wires.filter((w) => w.id !== wire);
      this.selIds = new Set();
      this.selWire = undefined;
    });
  }

  // ---- clipboard + align ----------------------------------------------

  private copySel(): void {
    const net = this.net;
    const ids = this.selIds;
    if (!net || !ids.size) return;
    const blocks = net.blocks.filter((b) => ids.has(b.id)).map((b) => structuredClone(b));
    const wires = net.wires
      .filter((w) => ids.has(w.src.block) && w.dsts.every((d) => ids.has(d.block)))
      .map((w) => structuredClone(w));
    const assocs = net.assocs.filter((a) => ids.has(a.dst.block)).map((a) => structuredClone(a));
    this.clipboard = { blocks, wires, assocs };
  }

  private paste(): void {
    const cb = this.clipboard;
    if (!cb?.blocks.length) return;
    this.mutate((net) => {
      const idMap = new Map<number, number>();
      for (const b of cb.blocks) {
        const nb = structuredClone(b);
        nb.id = nextNodeId(this.pou!);
        nb.pos = { x: nb.pos.x + 1, y: nb.pos.y + 1 };
        idMap.set(b.id, nb.id);
        net.blocks.push(nb);
      }
      for (const w of cb.wires) {
        const srcB = idMap.get(w.src.block);
        if (srcB === undefined) continue;
        const dsts = w.dsts
          .filter((d) => idMap.has(d.block))
          .map((d) => ({ block: idMap.get(d.block)!, port: d.port }));
        if (!dsts.length) continue;
        net.wires.push({
          id: nextNodeId(this.pou!),
          src: { block: srcB, port: w.src.port },
          dsts,
          ...(w.probe ? { probe: true } : {}),
        });
      }
      for (const a of cb.assocs) {
        const d = idMap.get(a.dst.block);
        if (d !== undefined) {
          net.assocs.push({ src_name: a.src_name, dst: { block: d, port: a.dst.port } });
        }
      }
      this.selIds = new Set(idMap.values());
      this.selWire = undefined;
    });
  }

  private alignSel(axis: 'x' | 'y'): void {
    if (this.selIds.size < 2) return;
    this.mutate((net) => {
      const bs = net.blocks.filter((b) => this.selIds.has(b.id));
      if (bs.length < 2) return;
      const m = Math.min(...bs.map((b) => (axis === 'x' ? b.pos.x : b.pos.y)));
      for (const b of bs) {
        b.pos = axis === 'x' ? { x: m, y: b.pos.y } : { x: b.pos.x, y: m };
      }
    });
  }

  // ---- geometry --------------------------------------------------------

  private blockSize(b: Block): { w: number; h: number } {
    const sig = blockSig(b, this.pous);
    const pins = Math.max(sig.ins.length, sig.outs.length);
    const uw = b.kind === 'variable' ? 7 : 8;
    return { w: uw * GX, h: Math.max(2 * ROW, (pins + 1) * ROW) };
  }

  private inPinPos(b: Block, i: number): { x: number; y: number } {
    return { x: b.pos.x * GX, y: b.pos.y * GX + ROW + i * ROW + ROW / 2 };
  }

  private outPinPos(b: Block, i: number): { x: number; y: number } {
    const { w } = this.blockSize(b);
    return { x: b.pos.x * GX + w, y: b.pos.y * GX + ROW + i * ROW + ROW / 2 };
  }

  /** Visible input pin count — variadic ops grow past their base arity. */
  private visibleIns(b: Block, net: Network): string[] {
    const sig = blockSig(b, this.pous);
    if (b.kind !== 'operator') return sig.ins;
    let maxIdx = opRequiredIns(b.type_ref) - 1;
    for (const w of net.wires)
      for (const d of w.dsts)
        if (d.block === b.id) maxIdx = Math.max(maxIdx, inIndex(b, d.port, this.pous));
    for (const a of net.assocs)
      if (a.dst.block === b.id) maxIdx = Math.max(maxIdx, inIndex(b, a.dst.port, this.pous));
    const ins = [...sig.ins];
    while (ins.length <= maxIdx + 1) ins.push(`IN${ins.length}`);
    return ins;
  }

  // ---- validation (client-side subset) ---------------------------------

  validate(): string[] {
    const net = this.net;
    if (!net) return [];
    const out: string[] = [];
    const byId = new Map(net.blocks.map((b) => [b.id, b]));
    const dstTaken = new Set<string>();
    const paramTaken = new Set<string>();
    for (const w of net.wires) {
      if (!byId.has(w.src.block)) out.push(`wire ${w.id}: missing src block ${w.src.block}`);
      for (const d of w.dsts) {
        const b = byId.get(d.block);
        if (!b) {
          out.push(`wire ${w.id}: missing dst block ${d.block}`);
          continue;
        }
        const idx = inIndex(b, d.port, this.pous);
        if (idx < 0) out.push(`wire ${w.id}: bad dst pin ${portLabel(d.port)} on b${d.block}`);
        const key = `${d.block}:${idx}`;
        if (dstTaken.has(key)) out.push(`b${d.block}: in-pin ${idx} driven twice`);
        dstTaken.add(key);
      }
    }
    for (const a of net.assocs) {
      const b = byId.get(a.dst.block);
      if (!b) continue;
      dstTaken.add(`${a.dst.block}:${inIndex(b, a.dst.port, this.pous)}`);
    }
    for (const b of net.blocks) {
      for (const k of Object.keys(b.params)) paramTaken.add(`${b.id}:${inIndex(b, k, this.pous)}`);
      if (b.kind === 'variable' && !b.name && !b.at)
        out.push(`b${b.id}: variable has no name or %location`);
      if (b.kind === 'operator' || b.kind === 'fb' || b.kind === 'function' || b.kind === 'st') {
        const ins = b.kind === 'operator' ? this.visibleIns(b, net) : blockSig(b, this.pous).ins;
        ins.forEach((_, i) => {
          if (b.kind === 'operator' && i >= opRequiredIns(b.type_ref)) return;
          // User/library FB inputs are optional by contract: an unbound
          // pin holds its blob value (fbd-lower), so only builtin FBs
          // and inline `st` pins are required to be driven.
          if ((b.kind === 'fb' || b.kind === 'function') && !builtinFbSig(b.type_ref)) return;
          if (!dstTaken.has(`${b.id}:${i}`) && !paramTaken.has(`${b.id}:${i}`)) {
            out.push(`b${b.id} ${b.type_ref || b.kind}: input ${ins[i] ?? i} unconnected`);
          }
        });
      }
    }
    // algebraic cycle check (edges into FB blocks may be legal feedback)
    const adj = new Map<number, number[]>();
    const indeg = new Map<number, number>();
    const addEdge = (u: number, v: number) => {
      const t = byId.get(v);
      if (t?.kind === 'fb' || !byId.has(u) || !byId.has(v)) return;
      // a device block may wire its own pins (AI→AO on one terminal) —
      // each pin aliases a distinct located var, no ordering cycle
      if (u === v && t?.kind === 'device') return;
      adj.set(u, [...(adj.get(u) ?? []), v]);
      indeg.set(v, (indeg.get(v) ?? 0) + 1);
    };
    for (const w of net.wires) for (const d of w.dsts) addEdge(w.src.block, d.block);
    for (const a of net.assocs) {
      const src = net.blocks.find((b) => b.name === a.src_name || b.instance === a.src_name);
      if (src) addEdge(src.id, a.dst.block);
    }
    const q = net.blocks.filter((b) => !indeg.get(b.id)).map((b) => b.id);
    let seen = 0;
    while (q.length) {
      const u = q.pop()!;
      seen++;
      for (const v of adj.get(u) ?? []) {
        indeg.set(v, indeg.get(v)! - 1);
        if (indeg.get(v) === 0) q.push(v);
      }
    }
    if (seen < net.blocks.length) out.push('algebraic cycle detected');
    return out;
  }

  // ---- events ----------------------------------------------------------

  private svgPt(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const el = this.querySelector('svg');
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / this.vb.s + this.vb.x,
      y: (e.clientY - r.top) / this.vb.s + this.vb.y,
    };
  }

  private onKey = (e: KeyboardEvent): void => {
    const mod = e.ctrlKey || e.metaKey;
    if (
      (e.key === 'Delete' || e.key === 'Backspace') &&
      (this.selIds.size || this.selWire !== undefined)
    ) {
      this.deleteSel();
      e.preventDefault();
    } else if (e.key === 'Escape') {
      this.pending = undefined;
      this.selIds = new Set();
      this.selWire = undefined;
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
      e.preventDefault();
    }
  };

  private onBlockDown(e: PointerEvent, b: Block): void {
    if (this.pending || e.button !== 0) return;
    if (e.shiftKey) {
      const s = new Set(this.selIds);
      if (s.has(b.id)) s.delete(b.id);
      else s.add(b.id);
      this.selIds = s;
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
    this.drag = {
      anchor: b.id,
      starts,
      dx: p.x - b.pos.x * GX,
      dy: p.y - b.pos.y * GX,
      moved: false,
    };
    try {
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } catch {
      /* synthetic events */
    }
    e.stopPropagation();
  }

  private onOutPinDown(e: PointerEvent, b: Block, i: number): void {
    const p = this.svgPt(e);
    this.pending = { block: b.id, port: i, x: p.x, y: p.y };
    try {
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } catch {
      /* synthetic events */
    }
    e.stopPropagation();
  }

  private onInPinUp(e: PointerEvent, b: Block, i: number): void {
    if (!this.pending) return;
    e.stopPropagation();
    this.completeWire(b, i);
  }

  /** Connect the pending out-pin to input pin `i` of block `b`. */
  private completeWire(b: Block, i: number): void {
    const pend = this.pending;
    if (!pend) return;
    if (pend.block === b.id && pend.port === i) return;
    this.mutate((net) => {
      const dst = { block: b.id, port: i as PortSel };
      const src = net.blocks.find((x) => x.id === pend.block);
      const sel: PortSel =
        src &&
        (src.kind === 'fb' ||
          src.kind === 'function' ||
          src.kind === 'device' ||
          src.kind === 'st')
          ? (blockSig(src, this.pous).outs[pend.port] ?? pend.port)
          : pend.port;
      const existing = net.wires.find(
        (w) => w.src.block === pend.block && samePort(w.src.port, sel),
      );
      if (existing) existing.dsts.push(dst);
      else
        net.wires.push({
          id: nextNodeId(this.pou!),
          src: { block: pend.block, port: sel },
          dsts: [dst],
        });
    });
    this.pending = undefined;
  }

  private onPinClick(e: MouseEvent, b: Block, i: number): void {
    if (!e.shiftKey) return;
    e.stopPropagation();
    this.mutate((net) => {
      const blk = net.blocks.find((x) => x.id === b.id);
      if (!blk) return;
      const s = new Set(blk.negated);
      if (s.has(i)) s.delete(i);
      else s.add(i);
      blk.negated = [...s].sort((a, b2) => a - b2);
    });
  }

  private onSvgMove(e: PointerEvent): void {
    if (this.pan) {
      this.vb = {
        ...this.vb,
        x: this.pan.vx - (e.clientX - this.pan.sx) / this.vb.s,
        y: this.pan.vy - (e.clientY - this.pan.sy) / this.vb.s,
      };
      return;
    }
    const p = this.svgPt(e);
    if (this.marquee) {
      this.marquee = { ...this.marquee, x1: p.x, y1: p.y };
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
    const ddx = Math.round((p.x - d.dx) / GX) - a.x;
    const ddy = Math.round((p.y - d.dy) / GX) - a.y;
    if (!ddx && !ddy) return;
    if (!d.moved) this.snapshot();
    d.moved = true;
    for (const [id, s] of d.starts) {
      const bb = net.blocks.find((x) => x.id === id);
      if (bb) bb.pos = { x: s.x + ddx, y: s.y + ddy };
    }
    this.requestUpdate();
  }

  private onSvgUp(e: PointerEvent): void {
    if (this.pan) {
      this.pan = undefined;
      return;
    }
    const m = this.marquee;
    if (m) {
      this.marquee = undefined;
      const net = this.net;
      if (net) {
        const x0 = Math.min(m.x0, m.x1);
        const x1 = Math.max(m.x0, m.x1);
        const y0 = Math.min(m.y0, m.y1);
        const y1 = Math.max(m.y0, m.y1);
        const hit = net.blocks
          .filter((b) => {
            const { w, h } = this.blockSize(b);
            const bx = b.pos.x * GX;
            const by = b.pos.y * GX;
            return bx < x1 && bx + w > x0 && by < y1 && by + h > y0;
          })
          .map((b) => b.id);
        this.selIds = m.additive ? new Set([...this.selIds, ...hit]) : new Set(hit);
        this.selWire = undefined;
      }
      return;
    }
    if (this.pending) {
      /* pointer capture retargets pointerup to the out-pin, so the in-pin's
         own handler never sees drag releases — resolve the drop target here
         by hit-testing the release point instead */
      const pend = this.pending;
      /* elementsFromPoint is missing in some DOM impls (jsdom) — fall back
         to the legacy direct pin handler, which still fires there */
      const stack =
        typeof document.elementsFromPoint === 'function'
          ? document.elementsFromPoint(e.clientX, e.clientY)
          : [];
      const pinEl = stack
        .map((el) => el.closest?.('.fbd-pin.in'))
        .find((el): el is Element => !!el);
      if (pinEl) {
        const net = this.net;
        const b = net?.blocks.find((x) => x.id === Number(pinEl.getAttribute('data-node')));
        const i = Number(pinEl.getAttribute('data-pin'));
        if (b && Number.isInteger(i)) {
          this.completeWire(b, i);
        } else {
          this.pending = undefined;
        }
        return;
      }
      /* released over the same out-pin: keep pending so a following click
         on an input completes the wire (click-click wiring) */
      const sameOut = stack
        .map((el) => el.closest?.('.fbd-pin.out'))
        .find((el): el is Element => !!el);
      if (
        sameOut &&
        Number(sameOut.getAttribute('data-node')) === pend.block &&
        Number(sameOut.getAttribute('data-pin')) === pend.port
      ) {
        return;
      }
      this.pending = undefined;
      return;
    }
    const d = this.drag;
    if (!d) return;
    this.drag = undefined;
    if (d.moved) {
      this.emitChange();
      this.requestUpdate();
    }
    void e;
  }

  private onSvgDown(e: PointerEvent): void {
    const onBg = e.target === e.currentTarget || (e.target as Element).tagName === 'rect';
    if (!onBg) return;
    if (e.button === 1 || (e.button === 0 && (e.ctrlKey || e.metaKey))) {
      this.pan = { sx: e.clientX, sy: e.clientY, vx: this.vb.x, vy: this.vb.y };
      this.selIds = new Set();
      this.selWire = undefined;
    } else if (e.button === 0) {
      const p = this.svgPt(e);
      this.marquee = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, additive: e.shiftKey };
      try {
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      } catch {
        /* synthetic events */
      }
    }
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

  // ---- render ----------------------------------------------------------

  render(): TemplateResult {
    const net = this.net;
    if (!this.pou || !net) return html`<div class="fbd-canvas-empty">no network</div>`;
    const vb = this.vb;
    this.inf = inferNetwork(net, this.pou, this.pous);
    return html`
      <div class="fbd-canvas">
        ${this.paletteSvg()}
        <svg
          tabindex="0"
          viewBox="${vb.x} ${vb.y} ${1200 / vb.s} ${700 / vb.s}"
          preserveAspectRatio="xMinYMin meet"
          @pointerdown=${this.onSvgDown}
          @pointermove=${this.onSvgMove}
          @pointerup=${this.onSvgUp}
          @wheel=${this.onWheel}
        >
          ${net.comments.map(
            (c) => svg`<g transform="translate(${c.pos.x * GX} ${c.pos.y * GX})">
              <rect class="fbd-note" width="180" height="40"></rect>
              <text class="fbd-note-text" x="4" y="14">${c.text}</text>
            </g>`,
          )}
          ${net.labels.map(
            (l) =>
              svg`<text class="fbd-label" x="${l.pos.x * GX}" y="${l.pos.y * GX}">${l.name}:</text>`,
          )}
          ${net.jumps.map(
            (j) =>
              svg`<text class="fbd-label" x="${j.pos.x * GX}" y="${j.pos.y * GX}">→ ${j.target}</text>`,
          )}
          ${net.wires.map((w) => this.wireSvg(w, net))}
          ${net.blocks.map((b) => this.blockSvg(b, net))}
          ${this.pending ? this.pendingSvg(net) : nothing}
          ${this.marquee ? this.marqueeSvg() : nothing}
        </svg>
        <div class="fbd-status">
          ${(() => {
            const issues = this.validateIssues();
            const errs = issues.filter((i) => i.severity === 'error').length;
            const warns = issues.length - errs;
            if (!issues.length)
              return html`<span class="plc-dim"
                >ok · drag bg = box select · ctrl/middle-drag = pan · shift-click pin
                negates</span
              >`;
            return html`<span class=${errs ? 'fbd-warn' : 'fbd-note-warn'}
              >${errs} error${errs === 1 ? '' : 's'}${warns
                ? `, ${warns} warning${warns === 1 ? '' : 's'}`
                : ''}: ${issues[0]!.message}${issues.length > 1 ? ' …' : ''}</span
            >`;
          })()}
        </div>
        ${this.selProps()}
        ${this.devDlg ? this.deviceWizard() : nothing}
      </div>
    `;
  }

  /** "Add device" wizard — terminal name, channel kind/count/type, base address. */
  private deviceWizard(): TemplateResult {
    const f = this.devForm ?? {
      name: 'EK1108',
      channel: 'DI' as const,
      count: 8,
      ty: 'BOOL',
      base: 0,
    };
    const setF = (patch: Partial<DeviceForm>) => {
      this.devForm = { ...f, ...patch };
      this.requestUpdate();
    };
    const digital = f.channel === 'DI' || f.channel === 'DO';
    const region = f.channel === 'DO' || f.channel === 'AO' ? '%Q' : '%I';
    const width = digital ? 'X' : 'D';
    const preview = this.devicePins(f).slice(0, 4);
    return html`
      <div class="fbd-devdlg" @pointerdown=${(e: Event) => e.stopPropagation()}>
        <div class="fbd-devdlg-box">
          <b>Add device / terminal</b>
          <label>name <input class="fbd-in" .value=${f.name}
            @change=${(e: Event) => setF({ name: (e.target as HTMLInputElement).value })} /></label>
          <label>channels
            <select class="fbd-in" .value=${f.channel}
              @change=${(e: Event) => {
                const c = (e.target as HTMLSelectElement).value as DeviceForm['channel'];
                setF({ channel: c, ty: c === 'DI' || c === 'DO' ? 'BOOL' : 'REAL' });
              }}>
              <option value="DI">digital in (device → logic, %I)</option>
              <option value="DO">digital out (logic → device, %Q)</option>
              <option value="AI">analog in (device → logic, %I)</option>
              <option value="AO">analog out (logic → device, %Q)</option>
            </select></label>
          <label>count <input class="fbd-in num" type="number" min="1" max="64" .value=${f.count}
            @change=${(e: Event) => setF({ count: Math.max(1, Math.min(64, Number((e.target as HTMLInputElement).value) || 1)) })} /></label>
          <label>type
            <select class="fbd-in" .value=${f.ty}
              @change=${(e: Event) => setF({ ty: (e.target as HTMLSelectElement).value })}>
              ${['BOOL', 'SINT', 'INT', 'DINT', 'USINT', 'UINT', 'UDINT', 'REAL', 'LREAL'].map(
                (t) => html`<option value=${t}>${t}</option>`,
              )}
            </select></label>
          <label>base byte <input class="fbd-in num" type="number" min="0" .value=${f.base}
            @change=${(e: Event) => setF({ base: Math.max(0, Number((e.target as HTMLInputElement).value) || 0) })} /></label>
          <div class="plc-dim">
            e.g. ${preview.map((p) => p.at ?? '?').join(', ')}${f.count > 4 ? ' …' : ''}
            <br />${region}${width}${f.base}.0 … — channels become block pins
            ${this.devDlg?.tpl?.channel2
              ? html`<br />+ ${this.devDlg.tpl.count2 ?? 8}× ${this.devDlg.tpl.channel2} (${this.devDlg.tpl.ty2 ?? 'BOOL'})`
              : ''}
          </div>
          <div class="fbd-devdlg-btns">
            <button class="chip-btn primary" @click=${() => this.addDevice()}>Add</button>
            <button class="chip-btn" @click=${() => { this.devDlg = undefined; this.devForm = undefined; }}>Cancel</button>
          </div>
        </div>
      </div>
    `;
  }

  /** Grouped, searchable block palette (operators, builtins, POUs, libraries). */
  private paletteSvg(): TemplateResult {
    const allPous = this.pous ?? [];
    const projPous = allPous.filter((p) => !p.id.startsWith('lib:'));
    const groups = [
      ...PALETTE,
      castGroup(),
      ...(this.catalog ?? []),
      { name: 'Project', items: projectFbItems(projPous, this.pou) },
      { name: 'Libraries', items: libraryFbItems(this.libSources ?? [], projPous) },
    ]
      .map((g) => filterGroup(g, this.paletteQ))
      .filter((g): g is NonNullable<typeof g> => !!g);
    const add = (i: PaletteItem) => {
      // catalog blocks need their library source attached to compile —
      // the host fetches /libsrc and stores it in stSources
      if (i.lib && i.srcFile) {
        this.dispatchEvent(
          new CustomEvent('need-libsrc', {
            bubbles: true,
            composed: true,
            detail: { lib: i.lib, file: i.srcFile },
          }),
        );
      }
      if (i.kind === 'fb' || i.kind === 'function') this.addFb(i.type, i.kind);
      else if (i.kind === 'device') this.openDeviceWizard(i.template);
      else this.addOperator(i.type);
    };
    return html`
      <div class="fbd-palette">
        <input
          class="fbd-in fbd-palette-q"
          placeholder="find block…"
          .value=${this.paletteQ}
          @input=${(e: Event) => {
            this.paletteQ = (e.target as HTMLInputElement).value;
          }}
        />
        <button class="chip-btn" title="add an interface variable input" @click=${() => this.addBlock('variable', '', 'in')}>
          var-in
        </button>
        <button class="chip-btn" title="add an interface variable output" @click=${() => this.addBlock('variable', '', 'out')}>
          var-out
        </button>
        <button
          class="chip-btn"
          title="inline ST block (expands to a FUNCTION_BLOCK)"
          @click=${() => this.addFromPalette('ST')}
        >ST</button>
        ${groups.map(
          (g) => html`
            <span class="fbd-pgroup">
              <b class="fbd-pgroup-name">${g.name}</b>
              ${g.items.map(
                (i) =>
                  html`<button class="chip-btn fbd-pitem" title=${i.hint} @click=${() => add(i)}>${i.label}</button>`,
              )}
            </span>
          `,
        )}
        <span class="spacer"></span>
        <button class="chip-btn" title="Undo (ctrl-z)" @click=${this.undo}>↶</button>
        <button class="chip-btn" title="Redo (ctrl-y)" @click=${this.redo}>↷</button>
      </div>
    `;
  }

  /** Add an operator block of `type` (AND/ADD/…/X_TO_Y). */
  private addOperator(type: string): void {
    const net = this.net;
    if (!net) return;
    this.mutate((n) => {
      n.blocks.push({
        id: nextNodeId(this.pou!),
        kind: 'operator',
        type_ref: type,
        pos: { x: this.nextBlockX(n, 'operator'), y: 2 },
        params: {},
        exec_order: 0,
        negated: [],
        comment: '',
      });
    });
  }

  /** Add an FB/function block instance with an auto instance name. */
  private addFb(type: string, kind: 'fb' | 'function' = 'fb'): void {
    const net = this.net;
    if (!net) return;
    this.mutate((n) => {
      const used = new Set(n.blocks.map((b) => b.instance ?? ''));
      let i = 1;
      while (used.has(`i${i}`)) i++;
      n.blocks.push({
        id: nextNodeId(this.pou!),
        kind,
        type_ref: type,
        instance: `i${i}`,
        pos: { x: this.nextBlockX(n, kind), y: 2 },
        params: {},
        exec_order: 0,
        negated: [],
        comment: '',
      });
    });
  }

  /** Open the "add device" wizard (optionally prefilled by a template). */
  private openDeviceWizard(tpl?: DeviceTemplate): void {
    const digital = tpl?.channel === 'DI' || tpl?.channel === 'DO';
    this.devForm = {
      name: tpl?.name ?? 'EK1108',
      channel: tpl?.channel ?? 'DI',
      count: Math.max(1, Math.min(64, tpl?.count ?? 8)),
      ty: tpl?.ty ?? (digital ? 'BOOL' : 'REAL'),
      base: 0,
    };
    this.devDlg = { tpl };
  }

  /** Generate channel pins for a channel spec (wizard or template group). */
  private devicePins(
    f: { channel: 'DI' | 'DO' | 'AI' | 'AO'; count: number; ty: string; base: number },
    prefix?: string,
  ): IfaceVar[] {
    const p = prefix ?? '';
    const out: IfaceVar[] = [];
    const digital = f.channel === 'DI' || f.channel === 'DO';
    const dir = f.channel === 'DI' || f.channel === 'AI' ? 'var_output' : 'var_input';
    const region = f.channel === 'DO' || f.channel === 'AO' ? 'Q' : 'I';
    const width = digital ? 'X' : 'D';
    for (let i = 0; i < f.count; i++) {
      const name = `${p}${f.channel}${i}`;
      if (digital) {
        const byte = f.base + (i >> 3);
        const bit = i & 7;
        out.push({ name, kind: dir, type: f.ty, at: `%${region}${width}${byte}.${bit}` });
      } else {
        /* analog: 4-byte channels at byte offsets (REAL-sized steps) */
        const byte = f.base + i * 4;
        out.push({ name, kind: dir, type: f.ty, at: `%${region}${width}${byte}.0` });
      }
    }
    return out;
  }

  /** Create a device block from the wizard form (+ template group 2). */
  private addDevice(): void {
    const f = this.devForm;
    if (!f) return;
    const tpl = this.devDlg?.tpl;
    this.devDlg = undefined;
    this.devForm = undefined;
    const pins = this.devicePins(f);
    /* mixed terminals (EK1110 DI+DO, EK1122 AI+AO): the template's
       second group lands in the other %I/%Q region or a different pin
       prefix, so it shares base 0 without address collisions */
    if (tpl?.channel2) {
      const d2 = tpl.channel2 === 'DI' || tpl.channel2 === 'DO';
      pins.push(
        ...this.devicePins({
          channel: tpl.channel2,
          count: Math.max(1, Math.min(64, tpl.count2 ?? 8)),
          ty: tpl.ty2 ?? (d2 ? 'BOOL' : 'REAL'),
          base: 0,
        }),
      );
    }
    this.mutate((net) => {
      net.blocks.push({
        id: nextNodeId(this.pou!),
        kind: 'device',
        type_ref: f.name,
        pos: { x: this.nextBlockX(net, 'device'), y: 2 },
        params: {},
        exec_order: 0,
        negated: [],
        comment: tpl?.channel2
          ? `${f.name} — ${f.channel}${f.count} + ${tpl.channel2}${tpl.count2 ?? ''}`
          : `${f.channel} terminal — ${f.count}ch ${f.ty}`,
        pins,
      });
      const nb = net.blocks[net.blocks.length - 1]!;
      this.selIds = new Set([nb.id]);
    });
  }

  /**
   * Graphical channel editor for a device block — the same table the
   * wizard generates, editable per channel (name / direction / type /
   * process-image address).
   */
  private deviceEditor(b: Block, set: (f: (blk: Block) => void) => void): TemplateResult {
    const pins = b.pins ?? [];
    const setPin = (i: number, patch: Partial<IfaceVar>) =>
      set((x) => {
        x.pins = (x.pins ?? []).map((p, j) => (j === i ? { ...p, ...patch } : p));
      });
    const DIRS: IfaceVar['kind'][] = ['var_output', 'var_input', 'var_in_out'];
    return html`
      <div class="fbd-devedit">
        <b>channels</b>
        <table class="fbd-devtbl">
          <tr><th>name</th><th>dir</th><th>type</th><th>at</th><th></th></tr>
          ${pins.map(
            (p, i) => html`
              <tr>
                <td><input class="fbd-in" .value=${p.name}
                  @change=${(e: Event) => setPin(i, { name: (e.target as HTMLInputElement).value })} /></td>
                <td><select class="fbd-in" .value=${p.kind}
                  @change=${(e: Event) => setPin(i, { kind: (e.target as HTMLSelectElement).value as IfaceVar['kind'] })}>
                  ${DIRS.map((d) => html`<option value=${d}>${d.replace('var_', '')}</option>`)}
                </select></td>
                <td><input class="fbd-in" .value=${p.type}
                  @change=${(e: Event) => setPin(i, { type: (e.target as HTMLInputElement).value })} /></td>
                <td><input class="fbd-in" .value=${p.at ?? ''} placeholder="%IX0.0"
                  @change=${(e: Event) => setPin(i, { at: (e.target as HTMLInputElement).value || undefined })} /></td>
                <td><button class="chip-btn" title="remove channel"
                  @click=${() => set((x) => { x.pins = (x.pins ?? []).filter((_, j) => j !== i); })}>×</button></td>
              </tr>`,
          )}
        </table>
        <button class="chip-btn" @click=${() =>
          set((x) => {
            const cur = x.pins ?? [];
            const last = cur[cur.length - 1];
            const kind = last?.kind === 'var_input' ? 'var_input' : 'var_output';
            x.pins = [...cur, { name: `CH${cur.length}`, kind, type: last?.type ?? 'BOOL', at: '' }];
          })}>+ channel</button>
      </div>
    `;
  }

  /**
   * Typed parameter editors for unconnected input pins — one row per
   * pin: BOOL → checkbox, numeric/TIME/STRING → literal input,
   * enum → dropdown when the catalog knows the values. Wired pins show
   * a dim "wired" marker instead.
   */
  private pinParamEditor(
    b: Block,
    net: Network,
    set: (f: (blk: Block) => void) => void,
  ): TemplateResult | typeof nothing {
    if (b.kind !== 'fb' && b.kind !== 'function' && b.kind !== 'st' && b.kind !== 'device')
      return nothing;
    const sig = blockSig(b, this.pous);
    if (!sig.ins.length) return nothing;
    const wired = new Set<number>();
    for (const w of net.wires)
      for (const d of w.dsts)
        if (d.block === b.id) {
          const i = inIndex(b, d.port, this.pous);
          if (i >= 0) wired.add(i);
        }
    for (const a of net.assocs)
      if (a.dst.block === b.id) {
        const i = inIndex(b, a.dst.port, this.pous);
        if (i >= 0) wired.add(i);
      }
    const rows = sig.ins.map((pn, i) => {
      const ty = this.inf?.pin.get(`${b.id}:in:${i}`);
      const key = pn || `IN${i}`;
      const cur = Object.entries(b.params).find(([k]) => k.toUpperCase() === key.toUpperCase())?.[1];
      const setParam = (v: string) =>
        set((x) => {
          const p = { ...x.params };
          const existing = Object.keys(p).find((k) => k.toUpperCase() === key.toUpperCase());
          p[existing ?? key] = v;
          if (x.kind === 'st' && x.params.CODE !== undefined) p.CODE = x.params.CODE;
          x.params = p;
        });
      const tname = ty ? tyName(ty) : '';
      let widget: TemplateResult;
      if (wired.has(i)) {
        widget = html`<span class="plc-dim">wired</span>`;
      } else if (ty?.k === 'bool') {
        widget = html`<input type="checkbox" .checked=${cur === 'TRUE' || cur === 'true' || cur === '1'}
          @change=${(e: Event) => setParam((e.target as HTMLInputElement).checked ? 'TRUE' : 'FALSE')} />`;
      } else {
        widget = html`<input class="fbd-in" .value=${cur ?? ''}
          placeholder=${ty ? tname : 'literal'}
          @change=${(e: Event) => setParam((e.target as HTMLInputElement).value)} />`;
      }
      return html`<tr>
        <td class="fbd-pname" title=${tname}>${key}</td>
        <td>${widget}</td>
      </tr>`;
    });
    return html`
      <div class="fbd-pinparams">
        <b>pin params</b>
        <table class="fbd-devtbl">${rows}</table>
      </div>
    `;
  }

  /** Structural + type issues with severities (client-side check). */
  validateIssues(): TypeIssue[] {
    const out: TypeIssue[] = [];
    for (const m of this.validate()) out.push({ severity: 'error', message: m });
    const net = this.net;
    if (net && this.pou) out.push(...(this.inf ?? inferNetwork(net, this.pou, this.pous)).issues);
    return out;
  }

  private addFromPalette(t: string): void {
    if (t === 'var-in') this.addBlock('variable', '', 'in');
    else if (t === 'var-out') this.addBlock('variable', '', 'out');
    else if (t === 'ST') {
      this.mutate((net) => {
        net.blocks.push({
          id: nextNodeId(this.pou!),
          kind: 'st',
          type_ref: 'ST',
          pos: { x: this.nextBlockX(net, 'st'), y: 2 },
          params: { CODE: 'OUT := IN;\n' },
          exec_order: 0,
          negated: [],
          comment: '',
          pins: [
            { name: 'IN', kind: 'var_input', type: 'REAL' },
            { name: 'OUT', kind: 'var_output', type: 'REAL' },
          ],
        });
      });
    } else if (
      [
        'AND',
        'OR',
        'XOR',
        'NOT',
        'ADD',
        'SUB',
        'MUL',
        'DIV',
        'GT',
        'GE',
        'LT',
        'LE',
        'EQ',
        'NE',
        'SEL',
        'LIMIT',
        'MUX',
        'MOVE',
        'MIN',
        'MAX',
        'ABS',
        'MOD',
        'SHL',
        'SHR',
      ].includes(t)
    )
      this.addBlock('operator', t);
    else this.addBlock('fb', t);
  }

  private selProps(): TemplateResult | typeof nothing {
    const net = this.net;
    if (!net) return nothing;
    if (this.selIds.size > 1) {
      return html`
        <div class="fbd-props">
          <b>${this.selIds.size} blocks</b>
          <button class="chip-btn" title="Align left edges" @click=${() => this.alignSel('x')}>
            align ⇤
          </button>
          <button class="chip-btn" title="Align top edges" @click=${() => this.alignSel('y')}>
            align ⤒
          </button>
          <button class="chip-btn" @click=${() => this.deleteSel()}>Delete</button>
        </div>
      `;
    }
    const selId = [...this.selIds][0];
    const b = net.blocks.find((x) => x.id === selId);
    if (!b) return nothing;
    const set = (f: (blk: Block) => void) =>
      this.mutate((net2) => {
        const blk = net2.blocks.find((x) => x.id === selId);
        if (blk) f(blk);
      });
    return html`
      <div class="fbd-props">
        <span class="plc-kind">b${b.id}</span> <b>${b.type_ref || b.kind}</b> ${
          b.kind === 'variable'
            ? html`name
                <input
                  class="fbd-in"
                  .value=${b.name ?? ''}
                  @change=${(e: Event) => set((x) => (x.name = (e.target as HTMLInputElement).value || undefined))}
                />`
            : nothing
        }
        at
        <input
          class="fbd-in"
          .value=${b.at ?? ''}
          placeholder="%QX0.0"
          @change=${(e: Event) => set((x) => (x.at = (e.target as HTMLInputElement).value || undefined))}
        />
        ${
          b.kind === 'fb'
            ? html`inst
                <input
                  class="fbd-in"
                  .value=${b.instance ?? ''}
                  @change=${(e: Event) => set((x) => (x.instance = (e.target as HTMLInputElement).value || undefined))}
                />`
            : nothing
        }
        params
        <input
          class="fbd-in wide"
          .value=${Object.entries(b.params)
            .filter(([k]) => !(b.kind === 'st' && k === 'CODE'))
            .map(([k, v]) => `${k}=${v}`)
            .join(' ')}
          placeholder="PT=T#200ms"
          @change=${(e: Event) =>
            set((x) => {
              const p: Record<string, string> = {};
              for (const tok of (e.target as HTMLInputElement).value.split(/\s+/)) {
                const i = tok.indexOf('=');
                if (i > 0) p[tok.slice(0, i)] = tok.slice(i + 1);
              }
              if (x.kind === 'st' && x.params.CODE !== undefined) p.CODE = x.params.CODE;
              x.params = p;
            })}
        />
        <button class="chip-btn" @click=${() => this.deleteSel()}>Delete</button>
      </div>
      ${b.kind === 'device' ? this.deviceEditor(b, set) : nothing}
      ${this.pinParamEditor(b, net, set)}
      ${b.kind === 'st' ? this.stBlockEditor(b, set) : nothing}
    `;
  }

  /** pin table + ST body for an inline `st` block. */
  private stBlockEditor(b: Block, set: (f: (blk: Block) => void) => void): TemplateResult {
    const pins = b.pins ?? [];
    const setPin = (i: number, patch: Partial<IfaceVar>) =>
      set((x) => {
        if (!x.pins) x.pins = [];
        x.pins[i] = { ...x.pins[i]!, ...patch };
      });
    return html`
      <div class="fbd-props fbd-stprops">
        <b>pins</b>
        ${pins.map(
          (p, i) => html`
            <span class="fbd-stpin">
              <input
                class="fbd-in"
                .value=${p.name}
                placeholder="NAME"
                @change=${(e: Event) => setPin(i, { name: (e.target as HTMLInputElement).value })}
              />
              <select
                .value=${p.kind}
                @change=${(e: Event) =>
                  setPin(i, { kind: (e.target as HTMLSelectElement).value as typeof p.kind })}
              >
                <option value="var_input">in</option>
                <option value="var_output">out</option>
                <option value="var_in_out">in_out</option>
                <option value="var">var</option>
              </select>
              <input
                class="fbd-in"
                .value=${p.type}
                placeholder="REAL"
                @change=${(e: Event) => setPin(i, { type: (e.target as HTMLInputElement).value })}
              />
              <input
                class="fbd-in"
                .value=${p.init ?? ''}
                placeholder="init"
                @change=${(e: Event) =>
                  setPin(i, { init: (e.target as HTMLInputElement).value || undefined })}
              />
              <button
                class="chip-btn"
                @click=${() => set((x) => x.pins?.splice(i, 1))}
                title="remove pin"
              >
                ×
              </button>
            </span>
          `,
        )}
        <button
          class="chip-btn"
          @click=${() =>
            set((x) => {
              (x.pins ??= []).push({
                name: `P${(x.pins?.length ?? 0) + 1}`,
                kind: 'var_input',
                type: 'REAL',
              });
            })}
        >
          + pin
        </button>
        <textarea
          class="fbd-stcode"
          spellcheck="false"
          .value=${b.params.CODE ?? ''}
          @change=${(e: Event) =>
            set((x) => (x.params = { ...x.params, CODE: (e.target as HTMLTextAreaElement).value }))}
        ></textarea>
      </div>
    `;
  }

  private blockSvg(b: Block, net: Network) {
    const { w, h } = this.blockSize(b);
    const x = b.pos.x * GX;
    const y = b.pos.y * GX;
    const ins = this.visibleIns(b, net);
    const outs = blockSig(b, this.pous).outs;
    const sel = this.selIds.has(b.id);
    const neg = new Set(b.negated);
    const title =
      b.kind === 'variable'
        ? b.name || b.at || 'var'
        : `${b.type_ref}${b.instance ? ` (${b.instance})` : ''}`;
    const flagged = this.diags?.some(
      (d) => d.fbd && d.fbd.node === b.id && d.fbd.sheet === this.netIndex,
    );
    const pinTy = (dir: 'in' | 'out', i: number): string => {
      const t = this.inf?.pin.get(`${b.id}:${dir}:${i}`);
      return t ? tyName(t) : '';
    };
    const bad = (pin?: string): boolean =>
      !!this.inf?.issues.some(
        (i) => i.block === b.id && i.severity === 'error' && (!pin || i.pin === pin),
      );
    const warn = (pin?: string): boolean =>
      !!this.inf?.issues.some(
        (i) => i.block === b.id && i.severity === 'warning' && (!pin || i.pin === pin),
      );
    const liveOf = (pn: string) =>
      this.pou ? livePin(this.pou, b, pn, this.values) : undefined;
    const pinCls = (pn: string, dir: 'in' | 'out') =>
      `${bad(pn) ? 'err' : warn(pn) ? 'warn' : ''}${dir === 'in' && neg.has(ins.indexOf(pn)) ? ' negated' : ''}`;
    return svg`
      <g class="fbd-block ${sel ? 'sel' : ''} ${flagged || bad() ? 'diag' : ''}" transform="translate(${x} ${y})"
         @pointerdown=${(e: PointerEvent) => this.onBlockDown(e, b)}>
        <rect class="fbd-rect" width="${w}" height="${h}" rx="3"></rect>
        <text class="fbd-title" x="${w / 2}" y="13">${title}</text>
        ${b.at ? svg`<text class="fbd-at" x="${w / 2}" y="${h - 4}">${b.at}</text>` : nothing}
        ${ins.map((pn, i) => {
          const t = pinTy('in', i);
          const v = pn ? liveOf(pn) : undefined;
          return svg`
            <circle class="fbd-pin in ${pinCls(pn, 'in')}" cx="0" cy="${ROW + i * ROW + ROW / 2}" r="${PIN_R}"
              data-node="${b.id}" data-pin="${i}"
              @pointerdown=${(e: PointerEvent) => e.stopPropagation()}
              @pointerup=${(e: PointerEvent) => this.onInPinUp(e, b, i)}
              @click=${(e: MouseEvent) => this.onPinClick(e, b, i)}>
              ${pn || t ? svg`<title>${pn}${pn && t ? ' : ' : ''}${t}</title>` : nothing}
            </circle>
            ${neg.has(i) ? svg`<circle class="fbd-neg" cx="0" cy="${ROW + i * ROW + ROW / 2}" r="${PIN_R + 2.5}"></circle>` : nothing}
            ${pn ? svg`<text class="fbd-pin-name" x="6" y="${ROW + i * ROW + ROW / 2 + 3}">${pn}</text>` : nothing}
            ${v !== undefined ? svg`<text class="fbd-pin-live" x="6" y="${ROW + i * ROW + ROW / 2 + 14}">${fmtLive(v)}</text>` : nothing}
          `;
        })}
        ${outs.map((pn, i) => {
          const t = pinTy('out', i);
          const v = pn ? liveOf(pn) : undefined;
          return svg`
            <circle class="fbd-pin out ${pinCls(pn, 'out')}" cx="${w}" cy="${ROW + i * ROW + ROW / 2}" r="${PIN_R}"
              data-node="${b.id}" data-pin="${i}"
              @pointerdown=${(e: PointerEvent) => this.onOutPinDown(e, b, i)}>
              ${pn || t ? svg`<title>${pn}${pn && t ? ' : ' : ''}${t}</title>` : nothing}
            </circle>
            ${pn ? svg`<text class="fbd-pin-name" x="${w - 6}" y="${ROW + i * ROW + ROW / 2 + 3}" text-anchor="end">${pn}</text>` : nothing}
            ${v !== undefined ? svg`<text class="fbd-pin-live" x="${w - 6}" y="${ROW + i * ROW + ROW / 2 + 14}" text-anchor="end">${fmtLive(v)}</text>` : nothing}
          `;
        })}
      </g>
    `;
  }

  private wireSvg(w: Wire, net: Network) {
    const sb = net.blocks.find((b) => b.id === w.src.block);
    if (!sb) return nothing;
    const si = outIndex(sb, w.src.port, this.pous);
    const from = this.outPinPos(sb, Math.max(0, si));
    const sel = this.selWire === w.id;
    const live =
      w.probe && this.values && this.pou
        ? resolveKey(probeKeys(this.pou, w.id), this.values)
        : undefined;
    const dstIssue = (): 'err' | 'warn' | '' => {
      let worst: 'err' | 'warn' | '' = '';
      for (const d of w.dsts) {
        const db = net.blocks.find((b) => b.id === d.block);
        if (!db) continue;
        const di = inIndex(db, d.port, this.pous);
        const name = blockSig(db, this.pous).ins[di];
        for (const is of this.inf?.issues ?? []) {
          if (is.block === db.id && is.pin === name) {
            if (is.severity === 'error') return 'err';
            worst = 'warn';
          }
        }
      }
      return worst;
    };
    const bad = dstIssue();
    return svg`
      <g class="fbd-wire ${sel ? 'sel' : ''} ${w.probe ? 'probe' : ''} ${bad}"
         @pointerdown=${(e: PointerEvent) => {
           this.selWire = w.id;
           this.selIds = new Set();
           e.stopPropagation();
         }}>
        ${
          live !== undefined
            ? svg`<text class="fbd-live" x="${from.x + 8}" y="${from.y - 5}">${String(
                this.values!.get(live),
              )}</text>`
            : nothing
        }
        ${w.dsts.map((d) => {
          const db = net.blocks.find((b) => b.id === d.block);
          if (!db) return nothing;
          const di = inIndex(db, d.port, this.pous);
          const to = this.inPinPos(db, Math.max(0, di));
          const mx = (from.x + to.x) / 2;
          return svg`<polyline class="fbd-line" fill="none"
              points="${from.x},${from.y} ${mx},${from.y} ${mx},${to.y} ${to.x},${to.y}"></polyline>`;
        })}
      </g>
    `;
  }

  private pendingSvg(net: Network) {
    const p = this.pending!;
    const sb = net.blocks.find((b) => b.id === p.block);
    if (!sb) return nothing;
    const from = this.outPinPos(sb, p.port);
    return svg`<line class="fbd-line pend" x1="${from.x}" y1="${from.y}" x2="${p.x}" y2="${p.y}"></line>`;
  }

  private marqueeSvg() {
    const m = this.marquee!;
    return svg`<rect class="fbd-marquee" x="${Math.min(m.x0, m.x1)}" y="${Math.min(
      m.y0,
      m.y1,
    )}" width="${Math.abs(m.x1 - m.x0)}" height="${Math.abs(m.y1 - m.y0)}"></rect>`;
  }
}

function samePort(a: PortSel, b: PortSel): boolean {
  return a === b;
}

customElements.define('fbd-canvas', FbdCanvas);
