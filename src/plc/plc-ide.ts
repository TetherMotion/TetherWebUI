/**
 * <tether-plc-ide> — the PLC IDE surface for the TetherPLC tab.
 *
 * Owns the project document (fbd.v1 + ST sources) via src/plc/store.
 * Sub-views: explorer tree, ST source editor, FBD network inspector,
 * task table, watch (live plc.* catalog values), deploy status.
 * Backend channels (tplccd, ctl proxy) are not wired yet — deploy is a
 * stub view and watch reads whatever the hub catalog provides.
 */
import { html, LitElement, nothing, TemplateResult } from 'lit';
import { DataHub } from '../data/hub';
import './fbd-canvas';
import './ld-canvas';
import './st-editor';
import './tempcurve';
import { CtlError, DBG_CMP, DbgBreak, DbgForce, DbgState, DbgStateDiff, DbgSym, DbgTraceFrame, DbgTraceStatus, DbgWatchEntry, EV, OdEntry, OdValue, PlcCtl, ProgStatus, RetainStatus, RtStatus, ShadowDiff, ShadowStatus } from './ctl';
import { byteToOffset, compileProject, CompileDiag, diagsForFile } from './build';
import type { StEditor } from './st-editor';
import { IfaceKind, IfaceVar, Pou, Task } from './model';
import { entryWritable, writeScalar } from './mon';
import { codecFromSchema, codecsForSize, defaultCodec, hex, odDecode, parseHex, type ScalarCodec } from './typedval';
import { exportPlcopenXml, importPlcopenXml } from './plcopen';
import type { CatalogEntry } from '../protocol';
import { exportFbdJson, importFbdJson, loadProject, PlcProject, saveProject } from './store';
import { parseStInterfaces } from './stiface';
import { catalogGroups, catalogPous, fetchCatalog, fetchLibSrc, libStem, type CatalogLib } from './catalog';
import {
  CurveProfile,
  defaultProfile,
  hasProfileLibrary,
  profileFromPou,
  sourceStem,
} from './curve';

type Pane = 'explorer' | 'st' | 'fbd' | 'curves' | 'tasks' | 'watch' | 'deploy';

/** migrate rule kinds shared with the runtime's MIGD encoding */
const DBG_DIFF_KIND = ['copy', 'xform', 'init', 'drop', 'deny', 'alias'];

const IFACE_KINDS: IfaceKind[] = [
  'var_input',
  'var_output',
  'var_in_out',
  'var',
  'var_temp',
  'var_external',
  'var_global',
];

const PANES: { id: Pane; label: string }[] = [
  { id: 'explorer', label: 'Explorer' },
  { id: 'st', label: 'ST' },
  { id: 'fbd', label: 'FBD' },
  { id: 'curves', label: 'Curves' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'watch', label: 'Watch' },
  { id: 'deploy', label: 'Deploy' },
];

/** codec for a resolved symbol — prefer the user-picked label when it
    fits the symbol's byte size, else the size-based default. */
function codecForSym(s: DbgSym, preferred?: string): ScalarCodec {
  const opts = codecsForSize(s.size);
  if (preferred) {
    const hit = opts.find((o) => o.label === preferred);
    if (hit) return hit;
  }
  return defaultCodec(s.size);
}

function safeDecode(c: ScalarCodec, b: Uint8Array): string {
  try {
    return c.decode(b);
  } catch {
    return '—';
  }
}

/** inline SVG sparkline for a numeric history sample. */
function sparkline(samples: number[], w = 90, h = 22): TemplateResult {
  if (samples.length < 2) return html`<span class="plc-dim">·</span>`;
  let lo = Infinity, hi = -Infinity;
  for (const v of samples) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo === hi) { lo -= 1; hi += 1; }
  const pts = samples
    .map((v, i) => {
      const x = (i / (samples.length - 1)) * (w - 2) + 1;
      const y = h - 2 - ((v - lo) / (hi - lo)) * (h - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return html`<svg class="plc-spark" width=${w} height=${h}>
    <polyline points=${pts} fill="none" stroke="var(--accent, #6cf)" stroke-width="1" />
  </svg>`;
}

/** safe arithmetic evaluator for watch expressions: numbers, plc.*
    identifiers, + - * / % ( ) and unary minus. No eval(). */
function evalWatchExpr(expr: string, lookup: (name: string) => number | undefined): number | undefined {
  const tokens = expr.match(/(?:plc\.[A-Za-z0-9_.]+|[A-Za-z_][A-Za-z0-9_.]*|\d+\.?\d*|[-+*/%()])/g);
  if (!tokens || tokens.join('').replace(/\s+/g, '') !== expr.replace(/\s+/g, '')) return undefined;
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = () => tokens[pos++];
  function parseExpr(): number | undefined {
    let v = parseTerm();
    if (v === undefined) return undefined;
    while (peek() === '+' || peek() === '-') {
      const op = eat();
      const r = parseTerm();
      if (r === undefined) return undefined;
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  function parseTerm(): number | undefined {
    let v = parseFactor();
    if (v === undefined) return undefined;
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = eat();
      const r = parseFactor();
      if (r === undefined) return undefined;
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  }
  function parseFactor(): number | undefined {
    const t = peek();
    if (t === undefined) return undefined;
    if (t === '-') { eat(); const v = parseFactor(); return v === undefined ? undefined : -v; }
    if (t === '+') { eat(); return parseFactor(); }
    if (t === '(') { eat(); const v = parseExpr(); if (eat() !== ')') return undefined; return v; }
    if (/^\d/.test(t)) { eat(); return parseFloat(t); }
    if (/^[A-Za-z_]/.test(t)) {
      eat();
      /* strip a leading "plc." the lexer may have split oddly — names
         already include dots via the identifier pattern */
      const name = t.startsWith('plc.') ? t : `plc.${t}`;
      const v = lookup(name) ?? lookup(t);
      return typeof v === 'number' ? v : undefined;
    }
    return undefined;
  }
  const r = parseExpr();
  return pos === tokens.length ? r : undefined;
}

export class TetherPlcIde extends LitElement {
  declare hub?: DataHub;

  static properties = {
    hub: { attribute: false },
    pane: { state: true },
    selPou: { state: true },
    selNet: { state: true },
    status: { state: true },
    ctlOk: { state: true },
    ctlErr: { state: true },
    prog: { state: true },
    rt: { state: true },
    retain: { state: true },
    shadow: { state: true },
    shadowDiffs: { state: true },
    deployFrac: { state: true },
    diags: { state: true },
    compiling: { state: true },
    catalogLibs: { state: true },
    dbg: { state: true },
    dbgSym: { state: true },
    dbgHex: { state: true },
    forces: { state: true },
    breaks: { state: true },
    trace: { state: true },
    traceLines: { state: true },
  };

  declare pane: Pane;
  declare selPou: string;
  declare selNet: number;
  declare status: string;
  declare ctlOk?: boolean;
  declare ctlErr: string;
  declare prog?: ProgStatus;
  declare rt?: RtStatus;
  declare retain?: RetainStatus;
  declare shadow?: ShadowStatus;
  declare shadowDiffs?: ShadowDiff[];
  declare deployFrac?: number;
  declare diags?: CompileDiag[];
  /** memoized synthetic POU decls from attached library sources. */
  private libCache?: { key: string; pous: Pou[] };
  /** installed-library block catalog (proxy /blocks), fetched once. */
  declare catalogLibs?: CatalogLib[];
  /** memoized palette groups for catalogLibs. */
  private catGroups: ReturnType<typeof catalogGroups> = [];
  declare compiling: boolean;
  declare dbg?: DbgState;
  declare dbgSym?: DbgSym;
  declare dbgHex?: string;
  declare forces?: DbgForce[];
  declare breaks?: DbgBreak[];
  declare trace?: DbgTraceStatus;
  declare traceLines?: string[];
  private traceFrames: DbgTraceFrame[] = [];
  private traceFrameLen = 0;
  declare watches?: DbgWatchEntry[];
  declare journal?: string[];
  declare odEntries?: OdEntry[];
  declare odVals?: Record<string, string>;
  declare ioMap?: { name: string; region: string; byte: number; bit: number | null }[];
  declare odRaw?: Record<string, Uint8Array>;

  private ctl = new PlcCtl();
  private dbgSymName = '';
  private dbgSymShadow = false;
  private dbgWriteHex = '';
  private dbgMaskHex = '';
  private dbgCodec = '';           // ScalarCodec.label for the resolved sym
  private dbgTypedVal = '';        // typed text input alongside hex
  private dbgTypedDirty = false;   // user edited typed field → it wins over hex
  private dbgRawVal = '';          // decoded typed display of last read
  private brkTask = '0';
  private brkCmp = '4';
  private brkVal = '';
  private brkExpr = '';
  private brkKind = '0';
  private traceChs: { name: string; off: bigint; len: number }[] = [];
  private watchExprInput = '';
  private watchExprs: string[] = [];
  private exprHistories: number[][] = [];
  private traceNoFreeze = false;
  private watchChs: { name: string; off: bigint; len: number }[] = [];
  private watchVals = new Map<number, string[]>();
  private stateDiff: DbgStateDiff | undefined;
  private odWriteHex: Record<string, string> = {};
  private evSrc?: EventSource;
  private evTimer?: number;

  private project: PlcProject = loadProject();
  private unsubs: (() => void)[] = [];
  private bindingRelease?: () => void;

  constructor() {
    super();
    this.pane = 'explorer';
    /* restore the selection a persisted project implies — otherwise a
       reload lands on an empty detail pane until a POU is re-clicked */
    this.selPou = this.project.fbd.pous[0]?.id ?? '';
    this.selNet = 0;
    this.status = '';
    this.ctlErr = '';
  }

  createRenderRoot(): this {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.syncHub();
    void this.loadCatalog();
  }

  /** Fetch the proxy's library block catalog once (no-op without proxy/libs). */
  private async loadCatalog(): Promise<void> {
    const libs = await fetchCatalog(this.ctl.url);
    if (libs.length && JSON.stringify(libs) !== JSON.stringify(this.catalogLibs ?? [])) {
      this.catalogLibs = libs;
      this.catGroups = catalogGroups(libs);
      this.requestUpdate();
    }
  }

  /** Canvas placed a catalog block — attach its library source. */
  private onNeedLibSrc(e: CustomEvent<{ lib: string; file: string }>): void {
    const { lib, file } = e.detail;
    const stem = libStem(file);
    const have = Object.keys(this.project.stSources).some(
      (k) => k.toUpperCase() === stem.toUpperCase(),
    );
    if (have) return;
    void fetchLibSrc(this.ctl.url, lib, file).then((src) => {
      if (!src) {
        this.flash(`library source ${file} not available from proxy`);
        return;
      }
      this.project.stSources[stem] = src;
      this.save();
      this.requestUpdate();
      this.flash(`attached ${file}`);
    });
  }

  disconnectedCallback(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.bindingRelease?.();
    this.bindingRelease = undefined;
    this.evSrc?.close();
    this.evSrc = undefined;
    if (this.evTimer !== undefined) clearTimeout(this.evTimer);
    super.disconnectedCallback();
  }

  willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('hub')) this.syncHub();
  }

  private syncHub(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.bindingRelease?.();
    this.bindingRelease = undefined;
    if (!this.hub || !this.isConnected) return;
    this.unsubs.push(
      this.hub.on('catalog', () => {
        this.rebind();
        this.requestUpdate();
      }),
    );
    this.unsubs.push(this.hub.on('values', () => {
      this.sampleExprs();
      this.requestUpdate();
    }));
    this.rebind();
  }

  /** Bind every plc.* entry so the hub polls it; values land in hub.values. */
  private rebind(): void {
    this.bindingRelease?.();
    this.bindingRelease = undefined;
    const hub = this.hub;
    if (!hub) return;
    const keys = [...hub.params, ...hub.signals]
      .filter((e) => e.name.startsWith('plc.') || e.group.startsWith('plc'))
      .map((e) => e.name);
    if (keys.length) this.bindingRelease = hub.acquireBindings(keys);
  }

  private save(): void {
    saveProject(this.project);
    this.requestUpdate();
  }

  private flash(msg: string): void {
    this.status = msg;
    setTimeout(() => {
      this.status = '';
      this.requestUpdate();
    }, 3000);
  }

  // ---- actions -------------------------------------------------------

  private onImport(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.xml,application/json,application/xml,text/xml';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        let notes: string[] = [];
        if (/\.xml$/i.test(file.name) || /^\s*<\?xml|^\s*<project/.test(text)) {
          const res = importPlcopenXml(text);
          this.project = { fbd: res.project, stSources: {} };
          notes = res.notes;
        } else {
          this.project = importFbdJson(text);
        }
        this.selPou = this.project.fbd.pous[0]?.id ?? '';
        this.save();
        this.flash(`imported ${file.name}${notes.length ? ` (${notes.length} notes)` : ''}`);
      } catch (e) {
        this.flash(`import failed: ${e instanceof Error ? e.message : e}`);
      }
    };
    input.click();
  }

  private onExport(): void {
    const blob = new Blob([exportFbdJson(this.project)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${this.project.fbd.project || 'project'}.fbd.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  private onExportXml(): void {
    const blob = new Blob([exportPlcopenXml(this.project.fbd)], {
      type: 'application/xml',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${this.project.fbd.project || 'project'}.xml`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  private onNewPou(kind: Pou['kind']): void {
    const name = `POU${this.project.fbd.pous.length + 1}`;
    this.project.fbd.pous.push({
      id: name,
      name,
      kind,
      en_eno: 'inherit',
      interface: [],
      // FBD-authored functions need an explicit return type — it
      // becomes the implicit output pin and the MIR return var.
      ...(kind === 'function' ? { ret_ty: 'REAL' } : {}),
      networks: [
        {
          id: 'net1',
          kind: 'fbd',
          label: '',
          comments: [],
          assocs: [],
          labels: [],
          jumps: [],
          returns: [],
          blocks: [],
          wires: [],
        },
      ],
    });
    this.selPou = name;
    this.save();
  }

  private onStEdit(pou: Pou, text: string): void {
    this.project.stSources[pou.name] = text;
    this.save();
  }

  /** Write a scalar value to a writable catalog param (the force path). */
  private async onForce(entry: CatalogEntry, input: HTMLInputElement): Promise<void> {
    const hub = this.hub;
    if (!hub) return;
    const text = input.value.trim();
    /* accept BOOL spellings as well as numbers */
    const lower = text.toLowerCase();
    const v =
      lower === 'true' || lower === 'on' ? 1
      : lower === 'false' || lower === 'off' ? 0
      : Number(text);
    if (!Number.isFinite(v)) {
      this.flash(`${entry.name}: not a number`);
      return;
    }
    try {
      await writeScalar(hub.client, entry, v);
      input.value = '';
      this.flash(`${entry.name} := ${v}`);
    } catch (e) {
      this.flash(`write failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  // ---- render --------------------------------------------------------

  render(): TemplateResult {
    const fbd = this.project.fbd;
    return html`
      <div class="plc-ide">
        <div class="plc-toolbar">
          <span class="plc-brand">TetherPLC</span>
          <span class="plc-proj">${fbd.project}</span>
          <span class="spacer"></span>
          <button class="chip-btn" @click=${this.onImport}>Import…</button>
          <button class="chip-btn" @click=${this.onExport}>Export .fbd.json</button>
          <button class="chip-btn" @click=${this.onExportXml}>Export .xml</button>
          <button class="chip-btn" ?disabled=${this.compiling} @click=${() => void this.onCheck()}>
            ${this.compiling ? 'checking…' : 'check'}
          </button>
          ${this.status ? html`<span class="plc-status">${this.status}</span>` : nothing}
        </div>
        <div class="plc-nav">
          ${PANES.map(
            (p) => html`
              <button
                class="plc-nav-btn ${this.pane === p.id ? 'active' : ''}"
                @click=${() => {
                  this.flushStEditors();
                  this.pane = p.id;
                  if (p.id === 'deploy') void this.refreshCtl();
                }}
              >
                ${p.label}
              </button>
            `,
          )}
        </div>
        <div class="plc-main">${this.paneBody()}</div>
        ${this.diagsStrip()}
      </div>
    `;
  }

  /** compile diagnostics strip, docked under the pane area. */
  private diagsStrip(): TemplateResult | typeof nothing {
    if (!this.diags?.length) return nothing;
    return html`
      <div class="plc-diags tile-scroll">
        ${this.diags.map(
          (d) => html`
            <div class="plc-diag ${d.severity}" @click=${() => this.onDiagClick(d)}>
              <span class="plc-diag-sev"
                >${d.severity === 'error' ? '✕' : d.severity === 'warning' ? '!' : '·'}</span
              >
              <span class="plc-diag-code">${d.code}</span>
              <span
                >${d.file ? `${d.file}${d.line ? `:${d.line}:${d.col}` : ''}` : d.fbd ? `fbd net ${d.fbd.sheet + 1} node ${d.fbd.node}` : ''}</span
              >
              <span class="plc-diag-msg">${d.message}</span>
            </div>
          `,
        )}
      </div>
    `;
  }

  /** apply the current check diags to the ST editor's lint markers. */
  private applyEditorDiags(): void {
    const ed = this.querySelector<StEditor>('st-editor');
    const pou = this.project.fbd.pous.find((p) => p.id === this.selPou) ?? this.project.fbd.pous[0];
    if (!ed || !pou) return;
    const src = this.project.stSources[pou.name] ?? '';
    ed.setDiags(this.diags ? diagsForFile(this.diags, `${pou.name}.st`, src) : []);
  }

  protected updated(): void {
    if (this.pane === 'st') this.applyEditorDiags();
  }

  /** jump to the offending source: st pane on the file's POU, or the fbd network. */
  private async onDiagClick(d: CompileDiag): Promise<void> {
    if (d.file) {
      const name = d.file.replace(/\.st$/, '');
      const pou = this.project.fbd.pous.find((p) => p.name === name);
      if (pou) {
        this.selPou = pou.id;
        this.pane = 'st';
        if (d.offset !== undefined) {
          await this.updateComplete;
          const src = this.project.stSources[pou.name] ?? '';
          this.querySelector<StEditor>('st-editor')?.jumpTo(byteToOffset(src, d.offset));
        }
      }
    } else if (d.fbd) {
      // Prov::Fbd{sheet} is the network index inside its pou; find the
      // pou whose that network holds the flagged node id.
      const pou = this.project.fbd.pous.find((p) =>
        p.networks[d.fbd!.sheet]?.blocks.some((b) => b.id === d.fbd!.node),
      );
      if (pou) {
        this.selPou = pou.id;
        this.selNet = d.fbd.sheet;
        this.pane = 'fbd';
      }
    }
  }

  /** commit any debounced st-editor edits before they can be lost
      (pane unmount) or missed (compile reads stSources, not the DOM) */
  private flushStEditors(): void {
    this.querySelectorAll('st-editor').forEach((ed) =>
      (ed as HTMLElement & { flushPending?: () => void }).flushPending?.(),
    );
  }

  /** run `tplcc check` through the ctl proxy; results land in the diags strip. */
  private async onCheck(): Promise<void> {
    if (this.compiling) return;
    this.compiling = true;
    this.flushStEditors();
    try {
      const r = await compileProject(this.ctl.url, this.project);
      this.diags = r.diags;
      this.flash(r.ok ? 'check ok' : `${r.errors} error(s)`);
    } catch (e) {
      this.flash(`check failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.compiling = false;
    }
  }

  private paneBody(): TemplateResult {
    switch (this.pane) {
      case 'explorer':
        return this.explorerPane();
      case 'st':
        return this.stPane();
      case 'fbd':
        return this.fbdPane();
      case 'curves':
        return this.curvesPane();
      case 'tasks':
        return this.tasksPane();
      case 'watch':
        return this.watchPane();
      case 'deploy':
        return this.deployPane();
    }
  }

  // ---- explorer ------------------------------------------------------

  private explorerPane(): TemplateResult {
    const fbd = this.project.fbd;
    const sel = this.selPou;
    return html`
      <div class="plc-split">
        <div class="plc-tree tile-scroll">
          <div class="plc-tree-head">
            <span>Project</span>
            <button class="chip-btn" @click=${() => this.onNewPou('program')}>+PRG</button>
            <button class="chip-btn" @click=${() => this.onNewPou('function_block')}>+FB</button>
            <button class="chip-btn" @click=${() => this.onNewPou('function')}>+FN</button>
          </div>
          ${fbd.pous.map(
            (pou) => html`
              <div
                class="plc-tree-pou ${sel === pou.id ? 'sel' : ''}"
                @click=${() => {
                  this.selPou = pou.id;
                  this.selNet = 0;
                }}
              >
                <span class="plc-kind"
                  >${pou.kind === 'program' ? 'PRG' : pou.kind === 'function_block' ? 'FB' : 'FUN'}</span
                >
                ${pou.name}
              </div>
              ${
                sel === pou.id
                  ? pou.networks.map(
                      (n, i) => html`
                        <div
                          class="plc-tree-net ${this.selNet === i ? 'sel' : ''}"
                          @click=${() => {
                            this.selNet = i;
                            this.pane = 'fbd';
                          }}
                        >
                          net ${i + 1}${n.label ? ` · ${n.label}` : ''}
                          <span class="plc-dim">(${n.blocks.length}b ${n.wires.length}w)</span>
                        </div>
                      `,
                    )
                  : nothing
              }
            `,
          )}
          <div
            class="plc-tree-pou ${this.selPou === '__globals' ? 'sel' : ''}"
            @click=${() => {
              this.selPou = '__globals';
              this.selNet = 0;
            }}
          >
            <span class="plc-kind">VAR</span> globals
          </div>
          ${
            fbd.tasks.length
              ? html`<div class="plc-tree-head"><span>Tasks</span></div>
                  ${fbd.tasks.map(
                    (t) =>
                      html`<div class="plc-tree-net">
                        ${t.name} <span class="plc-dim">${t.period_ns / 1e6}ms</span>
                      </div>`,
                  )}`
              : nothing
          }
          ${(() => {
            // attached library sources: stSources with no POU of that name
            const pouNames = new Set(fbd.pous.map((p) => p.name.toUpperCase()));
            const libs = Object.keys(this.project.stSources).filter(
              (n) => this.project.stSources[n]!.trim() && !pouNames.has(n.toUpperCase()),
            );
            if (!libs.length) return nothing;
            return html`<div class="plc-tree-head"><span>Libraries</span></div>
              ${libs.map(
                (n) => html`<div class="plc-tree-net">
                  ${n} <span class="plc-dim">${this.project.stSources[n]!.length} B</span>
                  <button class="chip-btn" title="detach source" @click=${() => this.detachSource(n)}>
                    ✕
                  </button>
                </div>`,
              )}`;
          })()}
        </div>
        <div class="plc-detail">${this.selPouDetail()}</div>
      </div>
    `;
  }

  private selPouDetail(): TemplateResult {
    if (this.selPou === '__globals') return this.globalsDetail();
    const pou = this.project.fbd.pous.find((p) => p.id === this.selPou);
    if (!pou) return html`<p class="plc-dim">Select a POU, or create one.</p>`;
    return html`
      <h3>
        ${pou.name} <span class="plc-dim">${pou.kind}</span>
        <button class="chip-btn" @click=${() => this.onDelPou(pou)}>delete pou</button>
      </h3>
      ${
        pou.kind === 'function'
          ? html`<div class="plc-dim">
              return type
              <input
                class="fbd-in"
                .value=${pou.ret_ty ?? 'REAL'}
                @change=${(e: Event) => {
                  pou.ret_ty = (e.target as HTMLInputElement).value.trim() || 'REAL';
                  this.save();
                  this.requestUpdate();
                }}
              />
            </div>`
          : nothing
      }
      <h4>
        interface
        <button class="chip-btn" @click=${() => this.addIfaceVar(pou)}>+ var</button>
      </h4>
      <table class="plc-table">
        <thead>
          <tr>
            <th>name</th>
            <th>kind</th>
            <th>type</th>
            <th>init</th>
            <th>at</th>
            <th>retain</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${pou.interface.map(
            (v, vi) => html`
              <tr>
                <td>
                  <input
                    class="fbd-in"
                    .value=${v.name}
                    @change=${(e: Event) =>
                      this.editIfaceVar(pou, vi, { name: (e.target as HTMLInputElement).value })}
                  />
                </td>
                <td>
                  <select
                    .value=${v.kind}
                    @change=${(e: Event) =>
                      this.editIfaceVar(pou, vi, {
                        kind: (e.target as HTMLSelectElement).value as IfaceKind,
                      })}
                  >
                    ${IFACE_KINDS.map((k) => html`<option value=${k}>${k}</option>`)}
                  </select>
                </td>
                <td>
                  <input
                    class="fbd-in"
                    .value=${v.type}
                    @change=${(e: Event) =>
                      this.editIfaceVar(pou, vi, { type: (e.target as HTMLInputElement).value })}
                  />
                </td>
                <td>
                  <input
                    class="fbd-in"
                    .value=${v.init ?? ''}
                    @change=${(e: Event) =>
                      this.editIfaceVar(pou, vi, { init: (e.target as HTMLInputElement).value })}
                  />
                </td>
                <td>
                  <input
                    class="fbd-in"
                    .value=${v.at ?? ''}
                    @change=${(e: Event) =>
                      this.editIfaceVar(pou, vi, { at: (e.target as HTMLInputElement).value })}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    .checked=${v.retain === true}
                    @change=${(e: Event) =>
                      this.editIfaceVar(pou, vi, {
                        retain: (e.target as HTMLInputElement).checked || undefined,
                      })}
                  />
                </td>
                <td>
                  <button class="chip-btn" @click=${() => this.delIfaceVar(pou, vi)}>✕</button>
                </td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    `;
  }

  private onDelPou(pou: Pou): void {
    const fbd = this.project.fbd;
    fbd.pous = fbd.pous.filter((p) => p.id !== pou.id);
    delete this.project.stSources[pou.name];
    for (const t of fbd.tasks) t.programs = t.programs.filter((n) => n !== pou.name);
    this.selPou = fbd.pous[0]?.id ?? '';
    this.save();
  }

  private addIfaceVar(pou: Pou): void {
    let n = pou.interface.length + 1;
    while (pou.interface.some((v) => v.name === `var${n}`)) n++;
    pou.interface.push({ name: `var${n}`, kind: 'var', type: 'INT' });
    this.save();
  }

  private delIfaceVar(pou: Pou, i: number): void {
    pou.interface.splice(i, 1);
    this.save();
  }

  private editIfaceVar(pou: Pou, i: number, patch: Partial<IfaceVar>): void {
    Object.assign(pou.interface[i]!, patch);
    this.save();
  }

  // ---- globals ---------------------------------------------------------

  /** VAR_GLOBAL table — same columns as a POU interface, kind forced
      to var_global; emits a `g.<name>` symbol in the compiled package. */
  private globalsDetail(): TemplateResult {
    const gvars = this.project.fbd.global_vars;
    return html`
      <h3>globals <span class="plc-dim">VAR_GLOBAL</span></h3>
      <p class="plc-dim">
        Shared variables visible to every POU. Located globals carry an
        <code>at</code> process-image address.
      </p>
      <h4>
        variables
        <button class="chip-btn" @click=${this.addGlobalVar}>+ var</button>
      </h4>
      <table class="plc-table">
        <thead>
          <tr><th>name</th><th>type</th><th>init</th><th>at</th><th>retain</th><th></th></tr>
        </thead>
        <tbody>
          ${gvars.map(
            (v, vi) => html`
              <tr>
                <td>
                  <input class="fbd-in" .value=${v.name}
                    @change=${(e: Event) =>
                      this.editGlobalVar(vi, { name: (e.target as HTMLInputElement).value })} />
                </td>
                <td>
                  <input class="fbd-in" .value=${v.type}
                    @change=${(e: Event) =>
                      this.editGlobalVar(vi, { type: (e.target as HTMLInputElement).value })} />
                </td>
                <td>
                  <input class="fbd-in" .value=${v.init ?? ''}
                    @change=${(e: Event) =>
                      this.editGlobalVar(vi, { init: (e.target as HTMLInputElement).value })} />
                </td>
                <td>
                  <input class="fbd-in" .value=${v.at ?? ''} placeholder="%MW0 / %QX0.0"
                    @change=${(e: Event) =>
                      this.editGlobalVar(vi, { at: (e.target as HTMLInputElement).value })} />
                </td>
                <td>
                  <input type="checkbox" .checked=${v.retain === true}
                    @change=${(e: Event) =>
                      this.editGlobalVar(vi, { retain: (e.target as HTMLInputElement).checked || undefined })} />
                </td>
                <td>
                  <button class="chip-btn" @click=${() => this.delGlobalVar(vi)}>✕</button>
                </td>
              </tr>
            `,
          )}
          ${gvars.length ? nothing : html`<tr><td colspan="6" class="plc-dim">No globals — add shared variables here.</td></tr>`}
        </tbody>
      </table>
    `;
  }

  private addGlobalVar(): void {
    const gv = this.project.fbd.global_vars;
    let n = gv.length + 1;
    while (gv.some((v) => v.name === `gVar${n}`)) n++;
    gv.push({ name: `gVar${n}`, kind: 'var_global', type: 'INT' });
    this.save();
  }

  private delGlobalVar(i: number): void {
    this.project.fbd.global_vars.splice(i, 1);
    this.save();
  }

  private editGlobalVar(i: number, patch: Partial<IfaceVar>): void {
    const gv = this.project.fbd.global_vars;
    gv[i] = { ...gv[i]!, ...patch, kind: 'var_global' };
    this.save();
  }

  // ---- ST ------------------------------------------------------------

  private stPane(): TemplateResult {
    const pou = this.project.fbd.pous.find((p) => p.id === this.selPou) ?? this.project.fbd.pous[0];
    return html`
      <div class="plc-split">
        <div class="plc-tree tile-scroll">
          <div class="plc-tree-head"><span>ST sources</span></div>
          ${this.project.fbd.pous.map(
            (p) => html`
              <div
                class="plc-tree-pou ${pou && p.id === pou.id ? 'sel' : ''}"
                @click=${() => {
                  this.selPou = p.id;
                  this.pane = 'st';
                }}
              >
                ${p.name}
              </div>
            `,
          )}
        </div>
        <div class="plc-detail">
          ${
            pou
              ? html`
                  <h3>${pou.name} <span class="plc-dim">structured text</span></h3>
                  <st-editor
                    class="plc-st-editor"
                    .value=${this.project.stSources[pou.name] ?? ''}
                    .symbols=${{
                      pous: this.project.fbd.pous.map((p) => p.name),
                      vars: pou.interface.map((v) => v.name),
                    }}
                    @change=${(e: CustomEvent<string>) => this.onStEdit(pou, e.detail)}
                  ></st-editor>
                `
              : html`<p class="plc-dim">No POU selected.</p>`
          }
        </div>
      </div>
    `;
  }

  // ---- FBD -----------------------------------------------------------

  private fbdPane(): TemplateResult {
    const pou = this.project.fbd.pous.find((p) => p.id === this.selPou);
    const net = pou?.networks[this.selNet];
    if (!pou || !net) return html`<p class="plc-dim">Select a network in the explorer.</p>`;
    return html`
      <div class="plc-fbd-pane">
        <div class="plc-fbd-head">
          <b>${pou.name}</b> · net ${this.selNet + 1} of
          ${pou.networks.length}${net.label ? ` — ${net.label}` : ''}
          <span class="spacer"></span>
          <button
            class="chip-btn"
            title="Move network earlier (runs first)"
            ?disabled=${this.selNet === 0}
            @click=${() => this.moveNetwork(pou, -1)}
          >
            ◀
          </button>
          <button
            class="chip-btn"
            title="Move network later (runs after)"
            ?disabled=${this.selNet >= pou.networks.length - 1}
            @click=${() => this.moveNetwork(pou, 1)}
          >
            ▶
          </button>
          <button class="chip-btn" @click=${() => this.addNetwork(pou, 'fbd')}>+ fbd</button>
          <button class="chip-btn" @click=${() => this.addNetwork(pou, 'ld')}>+ ld</button>
        </div>
        ${
          pou.kind === 'function'
            ? html`<div class="plc-dim">
                function ${pou.name} : ${pou.ret_ty ?? 'REAL'} — a var-out block named
                <b>${pou.name}</b> writes the return value; callers see it as the first output pin
              </div>`
            : nothing
        }
        ${
          net.kind === 'ld'
            ? html`<ld-canvas
                .pou=${pou}
                .netIndex=${this.selNet}
                .pous=${this.pousWithLibraries()}
                .values=${this.hub ? new Map(this.hub.values) : undefined}
                @change=${() => this.save()}
              ></ld-canvas>`
            : html`<fbd-canvas
                .pou=${pou}
                .netIndex=${this.selNet}
                .pous=${this.pousWithLibraries()}
                .values=${this.hub ? new Map(this.hub.values) : undefined}
                .diags=${this.diags}
                .libSources=${Object.values(this.project.stSources)}
                .catalog=${this.catGroups}
                @change=${() => this.save()}
                @need-libsrc=${(e: CustomEvent<{ lib: string; file: string }>) => this.onNeedLibSrc(e)}
              ></fbd-canvas>`
        }
      </div>
    `;
  }

  // ---- temperature curves ----------------------------------------------

  /** Project POUs + synthetic decls from attached sources + catalog. */
  private pousWithLibraries(): Pou[] {
    const srcs = Object.values(this.project.stSources);
    const key = srcs.map((s) => s.length).join(',');
    if (this.libCache?.key !== key) {
      this.libCache = { key, pous: parseStInterfaces(srcs) };
    }
    // catalog decls fill in blocks whose source isn't attached yet;
    // skip names already declared so attached sources win
    const have = new Set(
      [...this.project.fbd.pous, ...this.libCache.pous].map((p) => p.name.toUpperCase()),
    );
    const cat = catalogPous(this.catalogLibs ?? []).filter((p) => !have.has(p.name.toUpperCase()));
    return [...this.project.fbd.pous, ...this.libCache.pous, ...cat];
  }

  private curvesPane(): TemplateResult {
    const pou = this.project.fbd.pous.find((p) => p.id === this.selPou);
    const key = pou?.name ?? '';
    // saved editor state wins; otherwise recover the profile from the
    // POU's own blocks (imported project, or one saved before the pane)
    const prof =
      (key ? this.project.curves?.[key] : undefined) ??
      (pou ? profileFromPou(pou) : undefined) ??
      defaultProfile();
    const hasLib = hasProfileLibrary(Object.values(this.project.stSources));
    return html`
      ${
        hasLib
          ? nothing
          : html`<div class="plc-dim">
              FB_AtcProfile is not in this project — the generated config block needs the
              Atc_TempCtrl library source. Attach it once per project:
              <input
                type="file"
                accept=".st,text/plain"
                @change=${(e: Event) => this.onAttachLibrary(e)}
              />
            </div>`
      }
      <temp-curve
        .pou=${pou}
        .profile=${prof}
        @change=${(e: CustomEvent<CurveProfile>) => {
          if (key) (this.project.curves ??= {})[key] = e.detail;
          this.save();
          this.requestUpdate();
        }}
        @export-st=${(e: CustomEvent<{ name: string; source: string }>) => {
          this.project.stSources[e.detail.name] = e.detail.source;
          // register the POU so the export shows up in the tree and the
          // ST pane (projectSources drops it from the fbd JSON: no blocks)
          if (!this.project.fbd.pous.some((p) => p.name === e.detail.name)) {
            this.project.fbd.pous.push({
              id: e.detail.name,
              name: e.detail.name,
              kind: 'function_block',
              en_eno: 'off',
              interface: [
                { name: 'CFG', kind: 'var_input', type: 'BOOL' },
                { name: 'PROF', kind: 'var_in_out', type: 'FB_AtcProfile' },
                { name: 'DONE', kind: 'var_output', type: 'BOOL' },
              ],
              networks: [],
            });
          }
          this.save();
          this.requestUpdate();
          this.flash(`exported ${e.detail.name}.st`);
        }}
      ></temp-curve>
    `;
  }

  /** Attach a library `.st` (e.g. atc_tempctrl.st) as a project source. */
  private onAttachLibrary(e: Event): void {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const name = sourceStem(file.name);
      this.project.stSources[name] = String(reader.result ?? '');
      this.save();
      this.requestUpdate();
      this.flash(`attached ${file.name} as ${name}.st`);
    };
    reader.readAsText(file);
  }

  /** Drop an attached library source. */
  private detachSource(name: string): void {
    delete this.project.stSources[name];
    this.save();
    this.requestUpdate();
  }

  /** Reorder networks — execution follows array order. */
  private moveNetwork(pou: Pou, dir: -1 | 1): void {
    const i = this.selNet;
    const j = i + dir;
    if (j < 0 || j >= pou.networks.length) return;
    const [n] = pou.networks.splice(i, 1);
    pou.networks.splice(j, 0, n!);
    this.selNet = j;
    this.save();
  }

  private addNetwork(pou: Pou, kind: 'fbd' | 'ld' = 'fbd'): void {
    pou.networks.push({
      id: `net${pou.networks.length + 1}`,
      kind,
      label: '',
      comments: [],
      assocs: [],
      labels: [],
      jumps: [],
      returns: [],
      blocks: [],
      wires: [],
    });
    this.selNet = pou.networks.length - 1;
    this.save();
  }

  // ---- tasks ---------------------------------------------------------

  private tasksPane(): TemplateResult {
    const tasks = this.project.fbd.tasks;
    const progs = this.project.fbd.pous.filter((p) => p.kind === 'program');
    return html`
      <div class="tile-scroll">
        <h3>
          Tasks
          <button class="chip-btn" @click=${this.addTask}>+ task</button>
        </h3>
        ${
          tasks.length
            ? html`
                <table class="plc-table">
                  <thead>
                    <tr>
                      <th>name</th>
                      <th>period (ms)</th>
                      <th>priority</th>
                      <th>programs</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    ${tasks.map(
                      (t, ti) => html`
                        <tr>
                          <td>
                            <input
                              class="fbd-in"
                              .value=${t.name}
                              @change=${(e: Event) =>
                                this.editTask(ti, { name: (e.target as HTMLInputElement).value })}
                            />
                          </td>
                          <td>
                            <input
                              class="fbd-in"
                              type="number"
                              min="1"
                              .value=${String(t.period_ns / 1e6)}
                              @change=${(e: Event) =>
                                this.editTask(ti, {
                                  period_ns:
                                    Math.max(1, Number((e.target as HTMLInputElement).value)) * 1e6,
                                })}
                            />
                          </td>
                          <td>
                            <input
                              class="fbd-in"
                              type="number"
                              min="0"
                              .value=${String(t.priority)}
                              @change=${(e: Event) =>
                                this.editTask(ti, {
                                  priority: Number((e.target as HTMLInputElement).value),
                                })}
                            />
                          </td>
                          <td>
                            ${progs.map(
                              (p) => html`
                                <label class="plc-task-prog">
                                  <input
                                    type="checkbox"
                                    .checked=${t.programs.includes(p.name)}
                                    @change=${(e: Event) =>
                                      this.toggleTaskProgram(
                                        ti,
                                        p.name,
                                        (e.target as HTMLInputElement).checked,
                                      )}
                                  />
                                  ${p.name}
                                </label>
                              `,
                            )}
                          </td>
                          <td>
                            <button class="chip-btn" @click=${() => this.delTask(ti)}>✕</button>
                          </td>
                        </tr>
                      `,
                    )}
                  </tbody>
                </table>
              `
            : html`<p class="plc-dim">No tasks defined. Tasks map program POUs to scan periods.</p>`
        }
      </div>
    `;
  }

  private addTask(): void {
    let n = this.project.fbd.tasks.length + 1;
    while (this.project.fbd.tasks.some((t) => t.name === `task${n}`)) n++;
    this.project.fbd.tasks.push({
      name: `task${n}`,
      period_ns: 10e6,
      priority: 1,
      programs: this.project.fbd.pous.filter((p) => p.kind === 'program').map((p) => p.name),
    });
    this.save();
  }

  private delTask(i: number): void {
    this.project.fbd.tasks.splice(i, 1);
    this.save();
  }

  private editTask(i: number, patch: Partial<Task>): void {
    Object.assign(this.project.fbd.tasks[i]!, patch);
    this.save();
  }

  private toggleTaskProgram(i: number, prog: string, on: boolean): void {
    const t = this.project.fbd.tasks[i];
    if (!t) return;
    t.programs = on ? [...new Set([...t.programs, prog])] : t.programs.filter((p) => p !== prog);
    this.save();
  }

  // ---- watch ---------------------------------------------------------

  /** push one sample per watch expression into its sparkline history. */
  private sampleExprs(): void {
    const hub = this.hub;
    if (!hub) return;
    this.watchExprs.forEach((ex, i) => {
      const v = evalWatchExpr(ex, (n) => {
        const raw = hub.values.get(n);
        return typeof raw === 'number' ? raw
          : typeof raw === 'string' ? Number(raw) : undefined;
      });
      if (v === undefined || !Number.isFinite(v)) return;
      const h = this.exprHistories[i] ?? (this.exprHistories[i] = []);
      if (h[h.length - 1] !== v) {
        h.push(v);
        if (h.length > 120) h.shift();
      }
    });
  }

  private addWatchExpr(): void {
    const ex = this.watchExprInput.trim();
    if (!ex || this.watchExprs.includes(ex)) return;
    this.watchExprs.push(ex);
    this.exprHistories.push([]);
    this.watchExprInput = '';
    this.requestUpdate();
  }

  private exprHistory(i: number): number[] {
    return this.exprHistories[i] ?? [];
  }

  private watchPane(): TemplateResult {
    const hub = this.hub;
    const entries = hub
      ? [...hub.params, ...hub.signals].filter(
          (e) => e.name.startsWith('plc.') || e.group.startsWith('plc'),
        )
      : [];
    /* evaluate watch expressions against live catalog values */
    const exprRows = this.watchExprs.map((ex, i) => {
      const v = hub ? evalWatchExpr(ex, (n) => {
        const raw = hub.values.get(n);
        return typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : undefined;
      }) : undefined;
      return { ex, i, v };
    });
    return html`
      <div class="tile-scroll">
        <h3>Watch <span class="plc-dim">plc.* catalog entries</span></h3>
        ${
          hub
            ? html`<div class="plc-ops">
                <input
                  class="fbd-in wide"
                  placeholder="expression e.g. plc.POU1.sp - plc.POU1.pv"
                  .value=${this.watchExprInput}
                  @input=${(e: Event) =>
                    (this.watchExprInput = (e.target as HTMLInputElement).value)}
                  @keydown=${(e: KeyboardEvent) => {
                    if (e.key === 'Enter') this.addWatchExpr();
                  }}
                />
                <button class="chip-btn" @click=${() => this.addWatchExpr()}>+ expr</button>
              </div>`
            : nothing
        }
        ${
          exprRows.length
            ? html`<table class="plc-table">
                <thead><tr><th>expr</th><th>value</th><th>trend</th><th></th></tr></thead>
                <tbody>
                  ${exprRows.map(
                    ({ ex, i, v }) => html`<tr>
                      <td><code>${ex}</code></td>
                      <td class=${v === undefined ? 'plc-dim' : ''}>
                        ${v === undefined ? '—' : v}
                      </td>
                      <td>${v === undefined ? nothing : sparkline(this.exprHistory(i))}</td>
                      <td><button class="chip-btn" @click=${() => {
                        this.watchExprs.splice(i, 1);
                        this.exprHistories.splice(i, 1);
                        this.requestUpdate();
                      }}>×</button></td>
                    </tr>`,
                  )}
                </tbody>
              </table>`
            : nothing
        }
        ${
          !hub
            ? html`<p class="plc-dim">No machine connection.</p>`
            : entries.length
              ? html`
                  <table class="plc-table">
                    <thead>
                      <tr>
                        <th>name</th>
                        <th>kind</th>
                        <th>value</th>
                        <th>trend</th>
                        <th>force</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${entries.map(
                        (e) => html`
                          <tr>
                            <td>${e.name}</td>
                            <td>${e.kind}</td>
                            <td>${hub.values.get(e.name) ?? '—'}</td>
                            <td>${sparkline(hub.history.get(e.name) ?? [])}</td>
                            <td>
                              ${
                                entryWritable(e)
                                  ? html`<input
                                        class="fbd-in plc-force-in"
                                        placeholder="val"
                                        @keydown=${(ev: KeyboardEvent) => {
                                          if (ev.key === 'Enter') {
                                            this.onForce(e, ev.target as HTMLInputElement);
                                          }
                                        }}
                                      />
                                      <button
                                        class="chip-btn"
                                        @click=${(ev: Event) =>
                                          this.onForce(
                                            e,
                                            (ev.target as HTMLElement)
                                              .previousElementSibling as HTMLInputElement,
                                          )}
                                      >
                                        set
                                      </button>`
                                  : nothing
                              }
                            </td>
                          </tr>
                        `,
                      )}
                    </tbody>
                  </table>
                `
              : html`<p class="plc-dim">
                  No plc.* entries in the connected catalog. Watch binds to the tether_io catalog
                  published by the PLC bridge.
                </p>`
        }
      </div>
    `;
  }

  // ---- deploy --------------------------------------------------------

  private deployPane(): TemplateResult {
    const ctl = this.ctl;
    return html`
      <div class="tile-scroll">
        <h3>Deploy</h3>
        <div class="plc-ctlbar">
          ctl proxy
          <input
            class="fbd-in wide"
            .value=${ctl.url}
            @change=${(e: Event) => this.setCtlUrl((e.target as HTMLInputElement).value)}
          />
          <button class="chip-btn" @click=${this.refreshCtl}>refresh</button>
          ${
            this.ctlOk === undefined
              ? nothing
              : html`<span class="${this.ctlOk ? 'plc-ok' : 'fbd-warn'}"
                  >${this.ctlOk ? 'connected' : 'unreachable'}</span
                >`
          }
        </div>
        ${this.ctlErr ? html`<p class="fbd-warn">${this.ctlErr}</p>` : nothing}
        <div class="plc-ops">
          <input type="file" id="plc-pkg" accept=".tplc" hidden @change=${this.onPkgFile} />
          <button
            class="chip-btn"
            ?disabled=${this.compiling}
            @click=${() => void this.onBuildDeploy()}
          >
            ${this.compiling ? 'building…' : 'build & deploy'}
          </button>
          <button
            class="chip-btn"
            @click=${() => this.querySelector<HTMLInputElement>('#plc-pkg')?.click()}
          >
            deploy .tplc…
          </button>
          <button class="chip-btn" @click=${() => this.ctlOp('start', () => ctl.progStart())}>
            start
          </button>
          <button class="chip-btn" @click=${() => this.ctlOp('stop', () => ctl.progStop())}>
            stop
          </button>
          <button class="chip-btn" @click=${() => this.ctlOp('rollback', () => ctl.progRollback())}>
            rollback
          </button>
          ${
            this.deployFrac !== undefined
              ? html`<span class="plc-dim">uploading ${(this.deployFrac * 100).toFixed(0)}%</span>`
              : nothing
          }
        </div>
        ${this.prog ? this.progTable(this.prog) : nothing}
        ${this.shadowCard()}
        ${this.dbg ? this.debugCard(this.dbg) : nothing}
        ${this.retain ? this.retainCard(this.retain) : nothing}
        ${this.ioMapCard()}
        ${this.odCard()}
        ${this.journalCard()}
        ${this.rt ? html`<p class="plc-dim">rt: up ${this.rt.uptimeS}s · ${this.rt.progCount} progs (${this.rt.runningCount} running) · master ${this.rt.masterStatus} plc ${this.rt.plcStatus}${this.rt.version ? ` · ${this.rt.version}` : ''}</p>` : nothing}
        <p class="plc-dim">
          Requires <code>tplc-ctl-proxy</code> running on the plc host. Online-change
          (state-preserving swap + rollback) is live through PROG_SWAP / PROG_ROLLBACK.
        </p>
      </div>
    `;
  }

  private progTable(p: ProgStatus): TemplateResult {
    return html`
      <h4>
        program ${p.name}
        <span class="plc-dim"
          >${['stopped', 'running', 'fault'][p.state] ?? p.state} · ${p.cycles} cycles${
            p.epoch !== undefined ? ` · epoch ${p.epoch}` : ''
          }</span
        >
      </h4>
      <table class="plc-table">
        <thead>
          <tr>
            <th>task</th>
            <th>state</th>
            <th>period</th>
            <th>runs</th>
            <th>late</th>
            <th>faults</th>
            <th>debug</th>
          </tr>
        </thead>
        <tbody>
          ${p.tasks.map(
            (t, i) =>
              html`<tr>
                <td>${t.name}</td>
                <td>${['idle', 'sched', 'susp'][t.state] ?? t.state}</td>
                <td>${Number(t.periodNs) / 1e6} ms</td>
                <td>${t.runs}</td>
                <td>${t.late}</td>
                <td>${t.faults}</td>
                <td class="plc-task-dbg">
                  ${t.state === 2
                    ? html`<button
                          class="chip-btn"
                          @click=${() =>
                            this.ctlOp('resume', () => this.ctl.taskResume(i))}
                          >resume</button
                        ><button
                          class="chip-btn"
                          @click=${() =>
                            this.ctlOp('step', () => this.ctl.taskStep(i, 1))}
                          >step</button
                        ><button
                          class="chip-btn"
                          @click=${() =>
                            this.ctlOp('step×10', () => this.ctl.taskStep(i, 10))}
                          >+10</button
                        >`
                    : html`<button
                        class="chip-btn"
                        ?disabled=${p.state !== 1}
                        @click=${() =>
                          this.ctlOp('suspend', () => this.ctl.taskSuspend(i))}
                        >suspend</button
                      >`}
                </td>
              </tr>`,
          )}
        </tbody>
      </table>
      ${this.progMeta(p)}
    `;
  }

  /** v2+ program metadata: version, deploy time, fault/force/retain
      and online-change quarantine state — omitted when all default */
  private progMeta(p: ProgStatus): TemplateResult | typeof nothing {
    const parts: string[] = [];
    if (p.version) parts.push(`v${p.version}`);
    if (p.deployedAtNs)
      parts.push(
        `deployed ${new Date(Number(p.deployedAtNs / 1000000n)).toLocaleString()}`,
      );
    if (p.lastFaultCode)
      parts.push(
        `last fault rc=${p.lastFaultCode}` +
          (p.faultCycle !== undefined ? ` @cycle ${p.faultCycle}` : ''),
      );
    if (p.forceCount) parts.push(`${p.forceCount} force(s) active`);
    if (p.retainDirtyBytes) parts.push(`retain dirty ${p.retainDirtyBytes} B`);
    if (p.swapStage)
      parts.push(
        `swap stage ${p.swapStage}` +
          (p.quarantineLeft ? ` (${p.quarantineLeft} left)` : ''),
      );
    if (!parts.length) return nothing;
    return html`<div class="plc-dim plc-progmeta">${parts.join(' · ')}</div>`;
  }

  private shadowCard(): TemplateResult | typeof nothing {
    if (!this.ctlOk || !this.prog) return nothing;
    const sh = this.shadow;
    const diffs = this.shadowDiffs ?? [];
    const hex = (b: Uint8Array) =>
      [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');
    return html`
      <h4>
        shadow run
        ${sh?.loaded
          ? html`<span class="plc-dim"
              >${sh.name} ${sh.uuid?.slice(0, 8)} ·
              ${['stopped', 'running', 'fault'][sh.state ?? 0] ?? sh.state} ·
              ${sh.cycles} cycles · ${sh.missed} missed · ${sh.diffCount} diffs
              ${sh.diffCount
                ? html`· last @ cycle ${sh.lastDiffCycle}`
                : nothing}</span
            >`
          : html`<span class="plc-dim">none loaded</span>`}
      </h4>
      <div class="plc-ops">
        <input
          type="file"
          id="plc-shpkg"
          accept=".tplc"
          hidden
          @change=${this.onShadowPkgFile}
        />
        <button
          class="chip-btn"
          ?disabled=${this.prog.state !== 1}
          title="deploy a .tplc package and run it as the shadow candidate"
          @click=${() => this.querySelector<HTMLInputElement>('#plc-shpkg')?.click()}
        >
          ${sh?.loaded ? 'reload…' : 'deploy as shadow…'}
        </button>
        ${sh?.loaded
          ? html`<button
                class="chip-btn"
                title="atomically adopt the shadow program and its live state"
                @click=${() => this.onShadowPromote()}
                >promote</button
              ><button
                class="chip-btn"
                title="re-run active→shadow state migration"
                @click=${() => this.ctlOp('shadow reset', () => this.ctl.shadowReset())}
                >reset</button
              ><button
                class="chip-btn"
                @click=${() => this.ctlOp('shadow drop', () => this.ctl.shadowDrop())}
                >drop</button
              >`
          : nothing}
      </div>
      ${sh?.loaded
        ? html`<p class="plc-dim">
            outputs private · diffs are post-%Q byte runs · watch a candidate
            var as <code>SHADOW.&lt;sym&gt;</code>
          </p>`
        : nothing}
      ${diffs.length
        ? html`<table class="plc-table">
            <thead>
              <tr>
                <th>cycle</th>
                <th>img+off</th>
                <th>active</th>
                <th>shadow</th>
              </tr>
            </thead>
            <tbody>
              ${diffs.map(
                (d) => html`<tr>
                  <td>${d.cycle}</td>
                  <td>0x${d.imgOff.toString(16)}</td>
                  <td><code>${hex(d.active)}</code></td>
                  <td><code>${hex(d.shadow)}</code></td>
                </tr>`,
              )}
            </tbody>
          </table>`
        : nothing}
    `;
  }

  /** upload + deploy a .tplc, then load it as the shadow candidate. */
  private onShadowPkgFile = async (e: Event): Promise<void> => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    this.deployFrac = 0;
    this.requestUpdate();
    try {
      const uuid = await this.ctl.deploy(bytes, 0, (f) => {
        this.deployFrac = f;
        this.requestUpdate();
      });
      await this.ctl.shadowLoad(uuid);
      this.ctlErr = '';
      this.flash(`shadow ${file.name} → ${uuid.slice(0, 8)}`);
      await this.refreshCtl();
    } catch (e2) {
      this.ctlErr = `shadow load: ${e2 instanceof Error ? e2.message : e2}`;
    } finally {
      this.deployFrac = undefined;
      this.requestUpdate();
    }
  };

  /** confirm-with-summary, then adopt the shadow as the active program. */
  private onShadowPromote(): void {
    const sh = this.shadow;
    if (!sh?.loaded) return;
    const n = this.shadowDiffs?.length ?? 0;
    const sum =
      `promote shadow ${sh.name ?? ''} (${sh.uuid?.slice(0, 8)}) ` +
      `as the active program?\n\n` +
      `cycles ${sh.cycles} · missed ${sh.missed} · ` +
      `${sh.diffCount} diff${sh.diffCount === 1n ? '' : 's'} ` +
      `(${n} shown)\n\n` +
      `the shadow's live state is adopted atomically; rollback stays armed.`;
    if (!window.confirm(sum)) return;
    void this.ctlOp('shadow promote', async () => {
      const r = await this.ctl.shadowPromote();
      this.flash(`promoted ${r.uuid.slice(0, 8)} → epoch ${r.epoch}`);
    });
  }

  private debugCard(d: DbgState): TemplateResult {
    const s = this.dbgSym;
    /* SHADOW.<sym> resolutions carry the shadow program uuid — compare
       against the shadow identity, not the active one */
    const stale = s && s.uuid !== (this.dbgSymShadow ? this.shadow?.uuid : d.uuid);
    return html`
      <h4>
        debug
        <span class="plc-dim">
          blob ${d.blobSize}B · retain
          ${d.retainLen > 0n ? ` off ${d.retainOff} len ${d.retainLen}` : ' none'} ·
          ${d.symCount} symbols
        </span>
      </h4>
      <div class="plc-ops">
        <input
          class="fbd-in"
          placeholder="symbol name (e.g. ctu1.CV, SHADOW.cnt)"
          .value=${this.dbgSymName}
          @input=${(e: Event) => (this.dbgSymName = (e.target as HTMLInputElement).value)}
          @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && void this.onDbgResolve()}
        />
        <button class="chip-btn" @click=${() => void this.onDbgResolve()}>resolve</button>
        ${s
          ? html`<span class="${stale ? 'fbd-warn' : 'plc-dim'}">
                ${this.dbgSymShadow ? 'shadow ' : ''}sym ${s.symIdx} kind
                ${s.kind} region ${s.region} access ${s.access} ·
                off ${s.offset} size ${s.size}B${stale ? ' · STALE epoch' : ''}
              </span>
              <button class="chip-btn" @click=${() => void this.onDbgRead()}>read</button>
              ${!this.dbgSymShadow
                ? html`<input
                    class="fbd-in"
                    placeholder="hex (e.g. 07000000)"
                    .value=${this.dbgWriteHex}
                    @input=${(e: Event) =>
                      (this.dbgWriteHex = (e.target as HTMLInputElement).value)}
                  />
                  ${this.codecPicker()}
                  <input
                    class="fbd-in"
                    placeholder=${this.dbgCodec ? `${this.dbgCodec} value` : 'typed value'}
                    .value=${this.dbgTypedVal}
                    @input=${(e: Event) => {
                      this.dbgTypedVal = (e.target as HTMLInputElement).value;
                      this.dbgTypedDirty = true;
                    }}
                  />
                  <button class="chip-btn" @click=${() => void this.onDbgWrite()}>write</button>
                  <input
                    class="fbd-in plc-brk-task"
                    title="optional bit mask (hex, same byte count)"
                    placeholder="mask"
                    .value=${this.dbgMaskHex}
                    @input=${(e: Event) =>
                      (this.dbgMaskHex = (e.target as HTMLInputElement).value)}
                  />
                  <button
                    class="chip-btn plc-force-btn"
                    @click=${() => void this.onDbgForce()}
                    >force</button
                  >`
                : html`<span class="plc-dim">shadow blob is read-only</span>`}
              <button
                class="chip-btn"
                title="stage as a flight-recorder channel"
                @click=${() => this.onTraceChAdd()}
                >+ rec</button
              >
              <button
                class="chip-btn"
                title="stage as a watch item"
                @click=${() => this.onWatchChAdd()}
                >+ watch</button
              >`
          : nothing}
      </div>
      ${this.dbgHex ? html`<code class="plc-dbg-hex">${this.dbgHex}</code>` : nothing}
      ${this.dbgRawVal ? html`<code class="plc-dbg-hex">${this.dbgRawVal}</code>` : nothing}
      ${this.forces && this.forces.length > 0
        ? html`<div class="plc-forces">
            ${this.forces.map(
              (f) => html`<span class="plc-force-tag">
                off ${f.offset} =
                ${[...f.bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}
                ${f.mask && f.mask.some((m) => m !== 0xff)
                  ? html` & ${[...f.mask].map((m) =>
                      m.toString(16).padStart(2, '0')).join('')}`
                  : nothing}
                <button
                  class="chip-btn"
                  @click=${() =>
                    this.ctlOp('force clear', () => this.ctl.dbgForceClear(f.handle))}
                  >×</button
                >
              </span>`,
            )}
            <button
              class="chip-btn"
              @click=${() => this.ctlOp('force clear', () => this.ctl.dbgForceClear())}
              >clear all</button
            >
          </div>`
        : nothing}
      ${s && [1, 2, 4, 8].includes(s.size)
        ? html`<div class="plc-ops">
            <select
              class="fbd-in"
              .value=${this.brkKind}
              @change=${(e: Event) =>
                (this.brkKind = (e.target as HTMLSelectElement).value)}
            >
              <option value="0">break task</option>
              <option value="1">capture on</option>
            </select>
            <input
              class="fbd-in plc-brk-task"
              .value=${this.brkTask}
              @input=${(e: Event) =>
                (this.brkTask = (e.target as HTMLInputElement).value)}
            />
            <span class="plc-dim">when ${this.dbgSymName || 'sym'}</span>
            <select
              class="fbd-in"
              .value=${this.brkCmp}
              @change=${(e: Event) =>
                (this.brkCmp = (e.target as HTMLSelectElement).value)}
            >
              ${DBG_CMP.map((c, i) => html`<option value=${i}>${c}</option>`)}
            </select>
            <input
              class="fbd-in"
              placeholder="value"
              .value=${this.brkVal}
              @input=${(e: Event) =>
                (this.brkVal = (e.target as HTMLInputElement).value)}
            />
            <button class="chip-btn" @click=${() => void this.onDbgBreak()}>arm</button>
            <input
              class="fbd-in"
              placeholder="or expr: counter % 50 == 0 && flag"
              .value=${this.brkExpr}
              @input=${(e: Event) =>
                (this.brkExpr = (e.target as HTMLInputElement).value)}
            />
            <button
              class="chip-btn"
              title="arm expression trigger (paths resolve at arm time)"
              @click=${() => void this.onDbgBreakExpr()}
              >arm expr</button
            >
          </div>`
        : nothing}
      ${this.breaks && this.breaks.length > 0
        ? html`<div class="plc-forces">
            ${this.breaks.map(
              (b) => html`<span class="plc-force-tag">
                h${b.handle} ${b.kind ? 'cap' : 'brk'}
                ${b.stale ? 'stale ' : ''}task ${b.taskIdx}
                ${b.cmp === 0xff
                  ? 'expr'
                  : html`blob[${b.offset}..${b.len}]
                    ${DBG_CMP[b.cmp] ?? b.cmp} ${b.value}`}
                · hits ${b.hits}
                <button
                  class="chip-btn"
                  @click=${() =>
                    this.ctlOp('break clear', () => this.ctl.dbgBreakClear(b.handle))}
                  >×</button
                >
              </span>`,
            )}
            <button
              class="chip-btn"
              @click=${() => this.ctlOp('break clear', () => this.ctl.dbgBreakClear())}
              >clear all</button
            >
          </div>`
        : nothing}
      ${this.traceChs.length > 0
        ? html`<div class="plc-forces">
            <span class="plc-dim">rec ch:</span>
            ${this.traceChs.map(
              (c, i) => html`<span class="plc-force-tag">
                ${c.name} ${c.off}:${c.len}
                <button
                  class="chip-btn"
                  @click=${() => {
                    this.traceChs.splice(i, 1);
                    this.requestUpdate();
                  }}
                  >×</button
                >
              </span>`,
            )}
            <button class="chip-btn" @click=${() => void this.onTraceArm()}
              >record</button
            >
            <label class="plc-dim">
              <input
                type="checkbox"
                .checked=${this.traceNoFreeze}
                @change=${(e: Event) =>
                  (this.traceNoFreeze =
                    (e.target as HTMLInputElement).checked)}
              />
              nofreeze
            </label>
          </div>`
        : nothing}
      ${this.trace && this.trace.channels > 0
        ? html`<div class="plc-forces">
            <span class="plc-force-tag">
              rec ${this.trace.written} frames ·
              ${this.trace.avail} in ring ·
              ${this.trace.frameLen}B/frame
              ${this.trace.frozen ? ' · FROZEN' : nothing}
            </span>
            <button class="chip-btn" @click=${() => void this.onTraceRead()}
              >read</button
            >
            <button
              class="chip-btn"
              @click=${() => this.ctlOp('trace clear', () => this.ctl.dbgTraceClear())}
              >stop</button
            >
          </div>`
        : nothing}
      ${this.watchChs.length > 0
        ? html`<div class="plc-forces">
            <span class="plc-dim">watch items:</span>
            ${this.watchChs.map(
              (c, i) => html`<span class="plc-force-tag">
                ${c.name} ${c.off}:${c.len}
                <button
                  class="chip-btn"
                  @click=${() => {
                    this.watchChs.splice(i, 1);
                    this.requestUpdate();
                  }}
                  >×</button
                >
              </span>`,
            )}
            <button class="chip-btn" @click=${() => void this.onWatchAdd()}
              >add watch</button
            >
          </div>`
        : nothing}
      ${this.watches && this.watches.length > 0
        ? html`<div class="plc-forces">
            ${this.watches.map(
              (wt) => html`<span class="plc-force-tag">
                watch h${wt.handle} ${wt.items}×${wt.totalLen}B
                ${wt.rateHz ? ` · ${wt.rateHz}Hz` : ''}
                ${wt.stale ? ' · STALE' : ''}
                ${this.watchVals.get(wt.handle)?.map(
                  (v) => html` =${v}`,
                )}
                <button
                  class="chip-btn"
                  title="one-shot read"
                  @click=${() => void this.onWatchGet(wt.handle)}
                  >get</button
                >
                <button
                  class="chip-btn"
                  title=${wt.rateHz ? 'stop streaming' : 'stream at 10 Hz'}
                  @click=${() =>
                    this.ctlOp('watch stream', () =>
                      this.ctl.dbgWatchStream(
                        wt.handle, wt.rateHz ? 0 : 10))}
                  >${wt.rateHz ? 'stop' : 'stream'}</button
                >
                <button
                  class="chip-btn"
                  @click=${() =>
                    this.ctlOp('watch rm', () =>
                      this.ctl.dbgWatchRemove(wt.handle))}
                  >×</button
                >
              </span>`,
            )}
          </div>`
        : nothing}
      ${this.traceChart()}
      ${this.traceLines
        ? html`<details class="plc-trace-raw"><summary class="plc-dim">raw frames</summary>
            <code class="plc-dbg-hex">${this.traceLines.map(
              (l) => html`${l}<br />`,
            )}</code></details>`
        : nothing}
      <div class="plc-forces">
        <button
          class="chip-btn"
          title="what the last swap's migrate rules did"
          @click=${() => void this.onStateDiff()}
          >state.diff</button
        >
        ${this.stateDiff
          ? html`<span class="plc-dim">
              ${this.stateDiff.sameLayout ? 'same-layout' : 'migrated'}
              · ${this.stateDiff.rules.length} rules</span
            >`
          : nothing}
      </div>
      ${this.stateDiff
        ? html`<div class="plc-forces">
            ${this.stateDiff.rules.map(
              (r) => html`<span class="plc-force-tag">
                ${DBG_DIFF_KIND[r.kind] ?? r.kind}
                ${r.oldName || '-'}[${r.oldOff}:${r.oldLen}] →
                ${r.newName || '-'}[${r.newOff}:${r.newLen}]
                ${r.sev === 1 ? ' · degraded' : nothing}
                ${r.sev === 2 ? ' · deny' : nothing}
              </span>`,
            )}
          </div>`
        : nothing}
    `;
  }

  private async onStateDiff(): Promise<void> {
    try {
      this.stateDiff = await this.ctl.dbgStateDiff();
      this.ctlErr = '';
    } catch (e) {
      this.stateDiff = undefined;
      this.ctlErr = `state.diff: ${e instanceof CtlError ? e.message : e}`;
    }
    this.requestUpdate();
  }

  private async onDbgResolve(): Promise<void> {
    const name = this.dbgSymName.trim();
    try {
      this.dbgSym = await this.ctl.dbgResolve(name);
      this.dbgSymShadow = name.startsWith('SHADOW.');
      this.dbgHex = undefined;
      this.dbgRawVal = '';
      this.dbgTypedVal = '';
      this.dbgTypedDirty = false;
      this.dbgCodec = this.dbgSym ? codecForSym(this.dbgSym).label : '';
      this.ctlErr = '';
    } catch (e) {
      this.dbgSym = undefined;
      this.dbgSymShadow = false;
      this.ctlErr = `resolve: ${e instanceof CtlError ? e.message : e}`;
    }
    this.requestUpdate();
  }

  private async onDbgRead(): Promise<void> {
    const s = this.dbgSym;
    if (!s) return;
    try {
      const b = await this.ctl.dbgRead(s.offset, Math.min(s.size, 256),
                                     this.dbgSymShadow ? 1 : 0);
      this.dbgHex = [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');
      const c = codecForSym(s, this.dbgCodec);
      this.dbgRawVal = `${c.label}: ${safeDecode(c, b.slice(0, c.size))}`;
      this.dbgTypedVal = safeDecode(c, b.slice(0, c.size));
      this.dbgTypedDirty = false;
      this.ctlErr = '';
    } catch (e) {
      this.ctlErr = `read: ${e instanceof CtlError ? e.message : e}`;
    }
    this.requestUpdate();
  }

  /** codec picker for the resolved symbol — switches interpretation of
      the typed value field; size-constrained by the symbol. */
  private codecPicker(): TemplateResult | typeof nothing {
    const s = this.dbgSym;
    if (!s) return nothing;
    const opts = codecsForSize(s.size);
    if (opts.length <= 1) return nothing;
    return html`<select
      class="fbd-in"
      title="value interpretation"
      .value=${this.dbgCodec}
      @change=${(e: Event) => {
        this.dbgCodec = (e.target as HTMLSelectElement).value;
        if (this.dbgRawVal) {
          /* re-decode last read under the new codec */
          const bytes = this.dbgHexBytesFromDisplay();
          if (bytes) {
            const c = codecForSym(s, this.dbgCodec);
            this.dbgRawVal = `${c.label}: ${safeDecode(c, bytes.slice(0, c.size))}`;
            this.dbgTypedVal = safeDecode(c, bytes.slice(0, c.size));
          }
        }
        this.requestUpdate();
      }}
    >
      ${opts.map((o) => html`<option value=${o.label}>${o.label}</option>`)}
    </select>`;
  }

  /** re-parse the displayed hex blob (used when switching codecs). */
  private dbgHexBytesFromDisplay(): Uint8Array | undefined {
    const clean = (this.dbgHex ?? '').replace(/\s+/g, '');
    if (!/^[0-9a-f]+$/i.test(clean) || clean.length % 2) return undefined;
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++)
      out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)!;
    return out;
  }

  /** value bytes for write/force: typed field wins when non-empty and
      decodable, else fall back to the raw hex field. */
  private dbgWriteBytes(s: DbgSym): Uint8Array | undefined {
    const t = this.dbgTypedDirty ? this.dbgTypedVal.trim() : '';
    if (t) {
      const c = codecForSym(s, this.dbgCodec);
      try {
        const b = c.encode(t);
        if (b.length === s.size) return b;
        this.ctlErr = `${c.label} encodes to ${b.length}B, symbol is ${s.size}B`;
        this.requestUpdate();
        return undefined;
      } catch (e) {
        this.ctlErr = e instanceof Error ? e.message : String(e);
        this.requestUpdate();
        return undefined;
      }
    }
    return this.dbgHexBytes();
  }

  private dbgHexBytes(): Uint8Array | undefined {
    const hex = this.dbgWriteHex.replace(/\s+/g, '');
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2) {
      this.ctlErr = 'hex string expected';
      this.requestUpdate();
      return undefined;
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }

  private async onDbgWrite(): Promise<void> {
    const s = this.dbgSym;
    const bytes = s && this.dbgWriteBytes(s);
    if (!s || !bytes) return;
    await this.ctlOp('dbg write', async () => {
      await this.ctl.dbgWrite(s.offset, bytes);
      await this.onDbgRead();
    });
  }

  private async onDbgForce(): Promise<void> {
    const s = this.dbgSym;
    const bytes = s && this.dbgWriteBytes(s);
    if (!s || !bytes) return;
    const mh = this.dbgMaskHex.trim();
    let mask: Uint8Array | undefined;
    if (mh) {
      if (mh.length !== bytes.length * 2 || !/^[0-9a-fA-F]+$/.test(mh)) {
        this.ctlErr = 'force mask: hex, same byte count as value';
        this.requestUpdate();
        return;
      }
      mask = Uint8Array.from(mh.match(/../g)!.map((x) => parseInt(x, 16)));
    }
    await this.ctlOp('dbg force', async () => {
      await this.ctl.dbgForce(s.offset, bytes, mask);
      await this.onDbgRead();
    });
  }

  private async onDbgBreak(): Promise<void> {
    const s = this.dbgSym;
    if (!s) return;
    const taskIdx = parseInt(this.brkTask, 10);
    let value: bigint;
    try {
      value = BigInt(this.brkVal.trim());
    } catch {
      /* not a plain integer — try the typed codec against the resolved
         symbol (encode → LE bytes → bigint compare value) */
      try {
        const b = codecForSym(s, this.dbgCodec).encode(this.brkVal.trim());
        if (b.length > 8) throw new Error('compare value exceeds 8 B');
        let v = 0n;
        for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]!);
        value = v;
      } catch (e2) {
        this.ctlErr = `break: ${e2 instanceof Error ? e2.message : e2}`;
        this.requestUpdate();
        return;
      }
    }
    if (isNaN(taskIdx)) {
      this.ctlErr = 'break: task index required';
      this.requestUpdate();
      return;
    }
    const kind = Number(this.brkKind);
    await this.ctlOp(kind ? 'dbg capture' : 'dbg break', () =>
      (kind ? this.ctl.dbgCapture : this.ctl.dbgBreak).call(
        this.ctl, taskIdx, s.offset, s.size, Number(this.brkCmp), value));
  }

  private async onDbgBreakExpr(): Promise<void> {
    const taskIdx = parseInt(this.brkTask, 10);
    const expr = this.brkExpr.trim();
    if (isNaN(taskIdx)) {
      this.ctlErr = 'break: task index required';
      this.requestUpdate();
      return;
    }
    if (!expr) return;
    const kind = Number(this.brkKind);
    await this.ctlOp(kind ? 'dbg capture expr' : 'dbg break expr',
      () => this.ctl.dbgBreakExpr(taskIdx, expr, kind === 1));
  }

  private onTraceChAdd(): void {
    const s = this.dbgSym;
    if (!s) return;
    if (s.size > 8) {
      this.ctlErr = 'rec channel must be ≤ 8 B';
      this.requestUpdate();
      return;
    }
    if (this.traceChs.length >= 8) {
      this.ctlErr = 'max 8 rec channels';
      this.requestUpdate();
      return;
    }
    this.traceChs.push({ name: this.dbgSymName.trim() || `off${s.offset}`,
                         off: s.offset, len: s.size });
    this.requestUpdate();
  }

  private onWatchChAdd(): void {
    const s = this.dbgSym;
    if (!s) return;
    if (s.size > 64) {
      this.ctlErr = 'watch item must be ≤ 64 B';
      this.requestUpdate();
      return;
    }
    if (this.watchChs.length >= 16) {
      this.ctlErr = 'max 16 watch items';
      this.requestUpdate();
      return;
    }
    this.watchChs.push({ name: this.dbgSymName.trim() || `off${s.offset}`,
                         off: s.offset, len: s.size });
    this.requestUpdate();
  }

  private async onWatchAdd(): Promise<void> {
    const items = this.watchChs;
    await this.ctlOp('watch add', async () => {
      await this.ctl.dbgWatchAdd(
        items.map((c) => ({ offset: c.off, len: c.len,
                            name: c.name })));
      this.watchChs = [];
    });
  }

  private async onWatchGet(handle: number): Promise<void> {
    await this.ctlOp('watch get', async () => {
      const items = await this.ctl.dbgWatchGet(handle);
      this.watchVals.set(handle, items.map(
        (b) => b.length
          ? [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
          : 'stale'));
      this.requestUpdate();
    });
  }

  private async onTraceArm(): Promise<void> {
    await this.ctlOp('trace arm', () =>
      this.ctl.dbgTraceConf(
        this.traceChs.map((c) => ({ offset: c.off, len: c.len })),
        this.traceNoFreeze));
  }

  private async onTraceRead(): Promise<void> {
    await this.ctlOp('trace read', async () => {
      const r = await this.ctl.dbgTraceRead(0n, 64);
      this.traceFrames = r.frames;
      this.traceFrameLen = r.frameLen;
      this.traceLines = r.frames.length
        ? r.frames.slice(0, 8).map(
            (f) =>
              `#${f.seq} ${[...f.data]
                .map((b) => b.toString(16).padStart(2, '0'))
                .join(' ')}`)
        : ['(ring empty)'];
      this.requestUpdate();
    });
  }

  /** decode one channel's bytes out of a frame (channels are packed
      consecutively, each `len` bytes, in traceChs order). */
  private traceChannelValue(frame: DbgTraceFrame, chIdx: number): number | undefined {
    const ch = this.traceChs[chIdx];
    if (!ch) return undefined;
    /* channels are laid out in traceChs order within frame.data */
    let off = 0;
    for (let i = 0; i < chIdx; i++) off += this.traceChs[i]!.len;
    const bytes = frame.data.slice(off, off + ch.len);
    if (bytes.length < ch.len) return undefined;
    const c = defaultCodec(ch.len);
    const s = safeDecode(c, bytes);
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }

  /** waveform chart: one polyline per recorded channel. */
  private traceChart(): TemplateResult | typeof nothing {
    const frames = this.traceFrames;
    if (!frames?.length || !this.traceChs.length) return nothing;
    const w = 560, h = 120, pad = 4;
    const nCh = Math.min(this.traceChs.length, 8);
    const laneH = (h - pad * 2) / nCh;
    return html`<svg class="plc-trace" width=${w} height=${h}>
      ${Array.from({ length: nCh }, (_, ch) => {
        const vals = frames
          .map((f) => this.traceChannelValue(f, ch))
          .filter((v): v is number => v !== undefined);
        if (vals.length < 2) return nothing;
        let lo = Infinity, hi = -Infinity;
        for (const v of vals) { if (v < lo) lo = v; if (v > hi) hi = v; }
        if (lo === hi) { lo -= 1; hi += 1; }
        const y0 = pad + ch * laneH;
        const pts = vals.map((v, i) => {
          const x = pad + (i / (vals.length - 1)) * (w - pad * 2);
          const y = y0 + laneH - 2 - ((v - lo) / (hi - lo)) * (laneH - 4);
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(' ');
        const hue = (ch * 67) % 360;
        return html`<g>
          <text x=${pad + 2} y=${y0 + 10} class="plc-trace-lbl"
            fill="hsl(${hue},70%,65%)">${this.traceChs[ch]!.name}</text>
          <polyline points=${pts} fill="none"
            stroke="hsl(${hue},70%,60%)" stroke-width="1" />
        </g>`;
      })}
    </svg>`;
  }

  private retainCard(r: RetainStatus): TemplateResult {
    return html`
      <h4>
        retain store
        <span class="plc-dim">
          ${r.attached ? (r.dirty ? 'dirty' : 'clean') : 'detached'} · ${r.len}B · gen
          ${r.generation}
        </span>
      </h4>
      <div class="plc-ops">
        <button
          class="chip-btn"
          @click=${() => this.ctlOp('retain flush', () => this.ctl.retainFlush())}
        >
          flush
        </button>
        <button
          class="chip-btn"
          @click=${() => this.ctlOp('retain clear', () => this.ctl.retainClear())}
        >
          clear
        </button>
        <button class="chip-btn" @click=${() => void this.onRetainDump()}>dump…</button>
        <span class="plc-dim">
          ${r.flushes} flushes · ${r.restores} restores · ${r.losses} losses
        </span>
      </div>
    `;
  }

  /** download the raw retain region as a .bin file. */
  private async onRetainDump(): Promise<void> {
    try {
      const bytes = await this.ctl.retainDump();
      const url = URL.createObjectURL(
        new Blob([bytes as BlobPart], { type: 'application/octet-stream' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `${this.prog?.name ?? 'retain'}-dump.bin`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      this.ctlErr = e instanceof Error ? e.message : String(e);
    }
  }

  // ---- object dictionary ----------------------------------------------

  private odCard(): TemplateResult {
    const entries = this.odEntries ?? [];
    const vals = this.odVals ?? {};
    return html`
      <h4>
        object dictionary
        <span class="plc-dim">${entries.length ? `${entries.length} objects` : ''}</span>
      </h4>
      <div class="plc-ops">
        <button class="chip-btn" @click=${() => void this.onOdList()}>list</button>
        <button
          class="chip-btn"
          ?disabled=${!entries.length}
          @click=${() => void this.onOdRefreshAll()}
        >
          read all
        </button>
      </div>
      ${
        entries.length
          ? html`<table class="plc-table">
              <thead>
                <tr><th>index</th><th>sub</th><th>name</th><th>access</th><th>value</th><th></th></tr>
              </thead>
              <tbody>
                ${entries.map((e) => {
                  const key = `${e.index}.${e.sub}`;
                  const acc = ['ro', 'rw', 'wo'][e.access] ?? '?';
                  return html`<tr>
                    <td class="plc-dim">0x${e.index.toString(16).padStart(4, '0')}</td>
                    <td>${e.sub}</td>
                    <td>${e.name}</td>
                    <td>${acc}</td>
                    <td>
                      ${vals[key] !== undefined ? html`<code>${vals[key]}</code>` : '—'}
                      ${e.access !== 0
                        ? html`<input
                            class="fbd-in plc-force-in"
                            placeholder="hex"
                            .value=${this.odWriteHex[key] ?? ''}
                            @input=${(ev: Event) =>
                              (this.odWriteHex[key] = (ev.target as HTMLInputElement).value)}
                          />`
                        : nothing}
                    </td>
                    <td>
                      <button class="chip-btn" @click=${() => void this.onOdRead(e)}>read</button>
                      ${e.access !== 0
                        ? html`<button
                            class="chip-btn"
                            @click=${() => void this.onOdWrite(e)}
                          >write</button>`
                        : nothing}
                    </td>
                  </tr>`;
                })}
              </tbody>
            </table>`
          : html`<p class="plc-dim">No objects loaded — press list.</p>`
      }
    `;
  }

  private async onOdList(): Promise<void> {
    try {
      this.odEntries = await this.ctl.odList();
      this.odVals = {};
      this.ctlErr = '';
    } catch (e) {
      this.ctlErr = `od list: ${e instanceof Error ? e.message : e}`;
    }
    this.requestUpdate();
  }

  private async onOdRead(e: OdEntry): Promise<void> {
    try {
      const v = await this.ctl.odRead(e.index, e.sub);
      this.odVals = { ...(this.odVals ?? {}), [`${e.index}.${e.sub}`]: odDecode(v) };
      this.odRaw = { ...(this.odRaw ?? {}), [`${e.index}.${e.sub}`]: v.data };
      this.ctlErr = '';
    } catch (err) {
      this.ctlErr = `od read: ${err instanceof Error ? err.message : err}`;
    }
    this.requestUpdate();
  }

  private async onOdRefreshAll(): Promise<void> {
    const entries = this.odEntries ?? [];
    const vals: Record<string, string> = {};
    const raws: Record<string, Uint8Array> = {};
    for (const e of entries) {
      if (e.access === 2) continue; // write-only has nothing to read
      try {
        const v = await this.ctl.odRead(e.index, e.sub);
        vals[`${e.index}.${e.sub}`] = odDecode(v);
        raws[`${e.index}.${e.sub}`] = v.data;
      } catch {
        /* per-row read failure leaves the cell blank */
      }
    }
    this.odVals = vals;
    this.odRaw = raws;
    this.requestUpdate();
  }

  private async onOdWrite(e: OdEntry): Promise<void> {
    const key = `${e.index}.${e.sub}`;
    const text = (this.odWriteHex[key] ?? '').trim();
    if (!text) {
      this.ctlErr = 'od write: empty value';
      return;
    }
    /* prefer the declared type's width: if the typed text fits a
       known scalar codec use it, else treat input as raw hex */
    let bytes: Uint8Array;
    const raw = this.odRaw?.[key];
    const declaredLen = e.len || raw?.length || 0;
    const codec =
      declaredLen > 0
        ? defaultCodec(declaredLen)
        : undefined;
    try {
      const looksNumeric = /^-?[\d.]+\s*(ms|s|m|us|ns)?$/i.test(text) ||
        /^(true|false|on|off)$/i.test(text);
      if (codec && looksNumeric) bytes = codec.encode(text);
      else bytes = parseHex(text);
    } catch (err) {
      this.ctlErr = `od write: ${err instanceof Error ? err.message : err}`;
      return;
    }
    if (declaredLen && bytes.length !== declaredLen) {
      this.ctlErr = `od write: ${bytes.length}B != declared ${declaredLen}B`;
      return;
    }
    try {
      const ok = await this.ctl.odWrite(e.index, e.sub, bytes);
      this.ctlErr = ok ? '' : `od write 0x${e.index.toString(16)}/sub${e.sub}: refused`;
      delete this.odWriteHex[key];
      await this.onOdRead(e);
    } catch (err) {
      this.ctlErr = `od write: ${err instanceof Error ? err.message : err}`;
    }
    this.requestUpdate();
  }

  // ---- io map ---------------------------------------------------------

  /** process-image layout from the package's DEPLOY_MAP section —
      JSON rows {name, region I|Q|M, byte, bit}. */
  private ioMapCard(): TemplateResult {
    const rows = this.ioMap ?? [];
    return html`
      <h4>
        io map
        <span class="plc-dim">${rows.length ? `${rows.length} bindings` : ''}</span>
      </h4>
      <div class="plc-ops">
        <button class="chip-btn" @click=${() => void this.onIoMap()}>load</button>
      </div>
      ${
        rows.length
          ? html`<table class="plc-table">
              <thead>
                <tr><th>name</th><th>region</th><th>byte</th><th>bit</th></tr>
              </thead>
              <tbody>
                ${rows.map(
                  (r) => html`<tr>
                    <td>${r.name}</td>
                    <td>%${r.region}</td>
                    <td>${r.byte}</td>
                    <td>${r.bit ?? '—'}</td>
                  </tr>`,
                )}
              </tbody>
            </table>`
          : html`<p class="plc-dim">Process-image bindings of the deployed package.</p>`
      }
    `;
  }

  private async onIoMap(): Promise<void> {
    try {
      const raw = await this.ctl.mapGet();
      const text = new TextDecoder().decode(raw);
      const parsed = JSON.parse(text) as {
        name: string; region: string; byte: number; bit: number | null;
      }[];
      this.ioMap = Array.isArray(parsed) ? parsed : [];
      this.ctlErr = '';
    } catch (e) {
      this.ioMap = [];
      this.ctlErr = `io map: ${e instanceof Error ? e.message : e}`;
    }
    this.requestUpdate();
  }

  // ---- audit journal ----------------------------------------------------

  private journalCard(): TemplateResult {
    const lines = this.journal ?? [];
    return html`
      <h4>
        audit journal
        <span class="plc-dim">${lines.length ? `${lines.length} lines` : ''}</span>
      </h4>
      <div class="plc-ops">
        <button class="chip-btn" @click=${() => void this.onJournal()}>tail</button>
        <button
          class="chip-btn"
          ?disabled=${!lines.length}
          @click=${() => void this.onJournal(200)}
        >
          tail 200
        </button>
        <button
          class="chip-btn"
          ?disabled=${!lines.length}
          @click=${() => {
            this.journal = undefined;
            this.requestUpdate();
          }}
        >
          clear
        </button>
      </div>
      ${
        lines.length
          ? html`<pre class="plc-journal">${lines.join('\n')}</pre>`
          : html`<p class="plc-dim">Durable audit tail — every management and debug op with client, uid and result.</p>`
      }
    `;
  }

  private async onJournal(n = 50): Promise<void> {
    try {
      this.journal = await this.ctl.journalTail(n);
      this.ctlErr = '';
    } catch (e) {
      this.ctlErr = `journal: ${e instanceof Error ? e.message : e}`;
    }
    this.requestUpdate();
  }

  /** compile on the plc host and deploy the returned package directly. */
  private async onBuildDeploy(): Promise<void> {
    if (this.compiling) return;
    this.compiling = true;
    this.ctlErr = '';
    this.flushStEditors();
    try {
      const r = await compileProject(this.ctl.url, this.project, true);
      this.diags = r.diags;
      if (!r.ok || !r.package) {
        this.flash(r.ok ? 'build ok (no package)' : `build failed: ${r.errors} error(s)`);
        return;
      }
      this.flash('deploying…');
      this.deployFrac = 0;
      const uuid = await this.ctl.deploy(r.package, 0, (f) => {
        this.deployFrac = f;
      });
      this.deployFrac = undefined;
      await this.activateDeployed(uuid);
      this.flash(`deployed ${uuid.slice(0, 8)}`);
      await this.refreshCtl();
    } catch (e) {
      this.ctlErr = e instanceof Error ? e.message : String(e);
    } finally {
      this.compiling = false;
      this.deployFrac = undefined;
    }
  }

  /**
   * DEPLOY_COMMIT only stores the package under packages_dir — make it
   * the running program: stop the current one (PROG_PREPARE rejects
   * while RUNNING), prepare the stored uuid, start.
   */
  private async activateDeployed(uuid: string): Promise<void> {
    const st = await this.ctl.progStatus().catch(() => undefined);
    if (st && st.state === 1) await this.ctl.progStop();
    await this.ctl.progPrepare(uuid);
    await this.ctl.progStart();
  }

  private setCtlUrl(url: string): void {
    this.evSrc?.close();
    this.evSrc = undefined;
    this.ctl = new PlcCtl(url);
    localStorage.setItem('tether.plc.ctlUrl', url);
    this.refreshCtl();
  }

  /** SSE subscription to runtime events; coalesces refresh storms. */
  private openEvents(): void {
    if (this.evSrc) return;
    this.evSrc = this.ctl.events((e) => {
      if (e.type === EV.FAULT && e.payload.length >= 4) {
        const rc = new DataView(e.payload.buffer, e.payload.byteOffset).getInt32(0, true);
        this.flash(`plc fault rc=${rc}`);
      }
      if (e.type === EV.DBG_BREAK && e.payload.length >= 8) {
        const d = new DataView(e.payload.buffer, e.payload.byteOffset);
        this.flash(`break h${d.getUint32(0, true)} hit · task ${d.getUint32(4, true)}`);
      }
      if (e.type === EV.DBG_WATCH && e.payload.length >= 16) {
        /* {u32 handle, u64 seq, u32 n, {u32 len, u8 data[]}*} */
        const d = new DataView(e.payload.buffer, e.payload.byteOffset);
        const h = d.getUint32(0, true);
        const n = d.getUint32(12, true);
        const vals: string[] = [];
        let o = 16;
        for (let i = 0; i < n && o + 4 <= e.payload.length; i++) {
          const l = d.getUint32(o, true);
          vals.push(
            [...e.payload.slice(o + 4, o + 4 + l)]
              .map((b) => b.toString(16).padStart(2, '0'))
              .join(''));
          o += 4 + l;
        }
        this.watchVals.set(h, vals);
        this.requestUpdate();
      }
      if (
        e.type === EV.PROG_TRANSITION ||
        e.type === EV.FAULT ||
        e.type === EV.DBG_BREAK
      ) {
        if (this.evTimer === undefined)
          this.evTimer = window.setTimeout(() => {
            this.evTimer = undefined;
            void this.refreshCtl();
          }, 150);
      }
    });
  }

  private refreshCtl = async (): Promise<void> => {
    this.ctlOk = await this.ctl.health();
    this.ctlErr = '';
    if (!this.ctlOk) {
      this.evSrc?.close();
      this.evSrc = undefined;
    }
    if (this.ctlOk) {
      this.openEvents();
      try {
        [this.prog, this.rt, this.retain, this.dbg, this.forces,
          this.breaks, this.trace, this.watches, this.shadow] =
          await Promise.all([
            this.ctl.progStatus().catch(() => undefined),
            this.ctl.rtStatus().catch(() => undefined),
            this.ctl.retainStatus().catch(() => undefined),
            this.ctl.dbgState().catch(() => undefined),
            this.ctl.dbgForceList().catch(() => undefined),
            this.ctl.dbgBreakList().catch(() => undefined),
            this.ctl.dbgTraceStatus().catch(() => undefined),
            this.ctl.dbgWatchList().catch(() => undefined),
            this.ctl.shadowStatus().catch(() => undefined),
          ]);
        this.shadowDiffs = this.shadow?.loaded
          ? await this.ctl.shadowCompare().catch(() => undefined)
          : undefined;
      } catch (e) {
        this.ctlErr = e instanceof Error ? e.message : String(e);
      }
    }
    this.requestUpdate();
  };

  private ctlOp = async (name: string, op: () => Promise<unknown>): Promise<void> => {
    try {
      await op();
      this.ctlErr = '';
      await this.refreshCtl();
    } catch (e) {
      this.ctlErr = `${name}: ${e instanceof CtlError ? e.message : e}`;
      this.requestUpdate();
    }
  };

  private onPkgFile = async (e: Event): Promise<void> => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    this.deployFrac = 0;
    this.requestUpdate();
    try {
      const uuid = await this.ctl.deploy(bytes, 0, (f) => {
        this.deployFrac = f;
        this.requestUpdate();
      });
      await this.activateDeployed(uuid);
      this.ctlErr = '';
      this.flash(`deployed ${file.name} → ${uuid.slice(0, 8)}`);
      await this.refreshCtl();
    } catch (e2) {
      this.ctlErr = `deploy: ${e2 instanceof Error ? e2.message : e2}`;
    } finally {
      this.deployFrac = undefined;
      this.requestUpdate();
    }
  };
}

customElements.define('tether-plc-ide', TetherPlcIde);
