/**
 * <tether-plc-ide> — the PLC IDE surface for the TetherPLC tab.
 *
 * Owns the project document (fbd.v1 + ST sources) via src/plc/store.
 * Sub-views: explorer tree, ST source editor (CodeMirror 6 with
 * completion, lint, signature help, go-to-def/usages/rename), FBD and
 * LD network inspectors, task table, watch (live plc.* catalog values),
 * deploy/debug via `tplc serve`'s /ws backend (compile/catalog meta-ops,
 * binary ctl frames for deploy, shadow runs, breakpoints, forces,
 * retain, traces, alarms, historians).
 */
import { html, LitElement, nothing, TemplateResult } from 'lit';
import { DataHub } from '../data/hub';
import './fbd-canvas';
import './ld-canvas';
import './st-editor';
import './tempcurve';
import './temp-tune';
import {
  CtlError,
  DBG_CMP,
  DbgBreak,
  DbgForce,
  DbgState,
  DbgStateDiff,
  DbgSym,
  DbgTraceFrame,
  DbgTraceStatus,
  DbgWatchEntry,
  EV,
  EvlogInfo,
  EvlogRecord,
  EvlogStats,
  HistChannel,
  MqttConn,
  MqttJournalEntry,
  OdEntry,
  OdValue,
  PlcCtl,
  ProgStatus,
  RetainStatus,
  RtStatus,
  ShadowDiff,
  ShadowStatus,
} from './ctl';
import { byteToOffset, compileProject, CompileDiag, diagsForFile, injectDeployMap } from './build';
import {
  atCollisions,
  endpointCollisions,
  generateDeployMap,
  serializeDeployMap,
  projectIoBindingsEx,
  stIoBindings,
  validateDeployMapText,
  type MapViolation,
} from './deploymap';
import type { StEditor, StNavEvent } from './st-editor';
import {
  declaredPous as declaredPousIn,
  findDefinition,
  instanceType,
  renameInSource,
  renameMemberAccesses,
  renamePou,
  stWorld,
  stVarSections,
} from './stnav';
import type { DefTarget, StWorld, Usage } from './stnav';
import { ALARM_OPS, buildAlarmPou, defaultRule, ruleStem, type AlarmRule } from './alarms';
import { FbdProject, IfaceKind, IfaceVar, Pou, Task, TaskTrigger } from './model';
import { entryWritable, writeScalar } from './mon';
import {
  codecFromSchema,
  codecsForSize,
  defaultCodec,
  hex,
  odDecode,
  odEncode,
  odTypeName,
  parseHex,
  type ScalarCodec,
} from './typedval';
import { exportPlcopenXml, importPlcopenXml } from './plcopen';
import type { CatalogEntry } from '../protocol';
import {
  exportFbdJson,
  importFbdJson,
  loadProject,
  loadRemoteProject,
  PlcProject,
  remoteProjectInfo,
  saveProject,
  saveProjectRemote,
} from './store';
import * as pa from './projectapi';
import { deleteSnapshot, diffSummary, getSnapshot, historyIndex, pushSnapshot } from './history';
import { parseStInterfaces } from './stiface';
import {
  blockSource,
  catalogGroups,
  catalogPous,
  fetchCatalog,
  fetchLibSrc,
  libStem,
  type CatalogLib,
} from './catalog';
import {
  CurveProfile,
  defaultProfile,
  hasProfileLibrary,
  profileFromPou,
  sourceStem,
} from './curve';
import { TuneCfg, tunerFromPou } from './tune';
import {
  instantiateTemplate,
  PROJECT_TEMPLATES,
  TPL_PICKER_FOREVER_KEY,
  TPL_PICKER_SESSION_KEY,
  tplPickerWanted,
  type ProjectTemplate,
} from './templates';

type Pane =
  | 'explorer'
  | 'st'
  | 'fbd'
  | 'curves'
  | 'tasks'
  | 'watch'
  | 'alarms'
  | 'events'
  | 'deploy'
  | 'project';

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
  { id: 'alarms', label: 'Alarms' },
  { id: 'events', label: 'Events' },
  { id: 'deploy', label: 'Deploy' },
  { id: 'project', label: 'Project' },
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
  let lo = Infinity,
    hi = -Infinity;
  for (const v of samples) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
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
function evalWatchExpr(
  expr: string,
  lookup: (name: string) => number | undefined,
): number | undefined {
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
    if (t === '-') {
      eat();
      const v = parseFactor();
      return v === undefined ? undefined : -v;
    }
    if (t === '+') {
      eat();
      return parseFactor();
    }
    if (t === '(') {
      eat();
      const v = parseExpr();
      if (eat() !== ')') return undefined;
      return v;
    }
    if (/^\d/.test(t)) {
      eat();
      return parseFloat(t);
    }
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

// ---- deploy map (bridge format, DEPLOY_MAP section 0x0031) ------------

export interface DeployMapChannel {
  dir: 'in' | 'out';
  off: number;
  size: number;
  key: string;
  pdo?: string;
  type?: string;
  safe?: string;
}

export interface DeployMapBinding {
  at: string;
  key: string;
}

export interface DeployMap {
  inSize?: number;
  outSize?: number;
  hash?: string;
  channels: DeployMapChannel[];
  bindings: DeployMapBinding[];
  safety: string[];
}

/** Parse the bridge-format deploy map text (`image`/`in`/`out`/`bind`/
    `safety`/`hash` lines, `#` comments). Unknown lines are skipped —
    the runtime's parser is authoritative; this view is best-effort. */
export function parseDeployMap(text: string): DeployMap {
  const m: DeployMap = { channels: [], bindings: [], safety: [] };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const t = line.split(/\s+/);
    const kv = (p: string) => {
      const tok = t.find((x) => x.startsWith(p));
      return tok ? tok.slice(p.length) : undefined;
    };
    if (t[0] === 'image') {
      const iv = kv('in=');
      const ov = kv('out=');
      /* `image in=64 out=64` — tokens are "in=64" style */
      for (let i = 1; i + 1 < t.length; i += 2) {
        if (t[i] === 'in') m.inSize = parseInt(t[i + 1]!, 0) || undefined;
        if (t[i] === 'out') m.outSize = parseInt(t[i + 1]!, 0) || undefined;
      }
      if (iv !== undefined) m.inSize = parseInt(iv, 0) || m.inSize;
      if (ov !== undefined) m.outSize = parseInt(ov, 0) || m.outSize;
      continue;
    }
    if (t[0] === 'hash') {
      m.hash = t[1];
      continue;
    }
    if (t[0] === 'safety') {
      if (t[1]) m.safety.push(t[1]);
      continue;
    }
    if (t[0] === 'bind') {
      if (t.length >= 3) {
        let at = t[1]!;
        if (at.startsWith('"') && at.endsWith('"')) at = at.slice(1, -1);
        m.bindings.push({ at, key: t[2]! });
      }
      continue;
    }
    if (t[0] === 'in' || t[0] === 'out') {
      const dir = t[0] as 'in' | 'out';
      const pdo = kv('pdo=');
      /* runtime derives the channel key for bus endpoints:
         pdo=<ep> → key=<ep>.tx (in) / <ep>.rx (out) */
      const key = kv('key=') ?? (pdo !== undefined ? `${pdo}.${dir === 'in' ? 'tx' : 'rx'}` : '');
      const c: DeployMapChannel = {
        dir,
        off: parseInt(kv('off=') ?? '0', 0) || 0,
        size: parseInt(kv('size=') ?? '0', 0) || 0,
        key,
      };
      if (pdo !== undefined) c.pdo = pdo;
      const ty = kv('type=');
      if (ty !== undefined) c.type = ty;
      const safe = kv('safe=');
      if (safe !== undefined) c.safe = safe;
      if (c.key) m.channels.push(c);
    }
  }
  return m;
}

export interface ProjectBinding {
  /** dotted name: global, POU.var, or POU.block.channel. */
  name: string;
  at: string;
  type?: string;
}

/** Every `at` binding declared in the project — globals, POU
    interface vars, variable blocks and device channels. This is the
    compile-time view (what tplcc writes to the IO_MAP section);
    the deploy map above is the runtime channel view. */
export function projectIoBindings(fbd: FbdProject): ProjectBinding[] {
  const out: ProjectBinding[] = [];
  const push = (name: string, at?: string, type?: string) => {
    if (at) out.push({ name, at, type });
  };
  for (const g of fbd.global_vars) push(`⚙ ${g.name}`, g.at, g.type);
  for (const pou of fbd.pous) {
    for (const v of pou.interface) push(`${pou.name}.${v.name}`, v.at, v.type);
    for (const net of pou.networks) {
      for (const b of net.blocks) {
        if (b.kind === 'variable') push(`${pou.name}.${b.name ?? `#${b.id}`}`, b.at);
        else if (b.kind === 'device')
          for (const p of b.pins ?? []) push(`${pou.name}.${b.type_ref}.${p.name}`, p.at, p.type);
      }
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.name.localeCompare(b.name));
}

function rangesOverlap(a: DeployMapChannel, b: DeployMapChannel): boolean {
  return a.dir === b.dir && a.off < b.off + b.size && b.off < a.off + a.size;
}

/** Indices of channels whose image range overlaps another channel in
    the same direction — two writers fighting over the same bytes. */
export function deployMapOverlaps(chans: DeployMapChannel[]): number[] {
  const bad = new Set<number>();
  for (let i = 0; i < chans.length; i++)
    for (let j = i + 1; j < chans.length; j++)
      if (rangesOverlap(chans[i]!, chans[j]!)) {
        bad.add(i);
        bad.add(j);
      }
  return [...bad];
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
    tplPicker: { state: true },
    historyOpen: { state: true },
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
  /** installed-library block catalog (/ws blocks meta-op), fetched once. */
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
  /** project-template picker overlay (auto-opened on fresh projects). */
  declare tplPicker: boolean;
  declare historyOpen: boolean;
  private traceFrames: DbgTraceFrame[] = [];
  private traceFrameLen = 0;
  declare watches?: DbgWatchEntry[];
  declare journal?: string[];
  declare odEntries?: OdEntry[];
  declare odVals?: Record<string, string>;
  declare odTypes?: Record<string, number>;
  declare ioMap?: DeployMap;
  declare odRaw?: Record<string, Uint8Array>;
  /** generated deploy-map draft (io-map card). */
  declare genMap?: { text: string; warnings: string[] };
  /** editable deploy-map text in the io-map card. */
  declare mapEdit?: string;
  /** client-side validation of mapEdit. */
  declare mapViolations?: MapViolation[];
  /** graphical channel/binding editor state (parsed from mapEdit draft) */
  declare mapRows?: {
    inSize?: number;
    outSize?: number;
    channels: DeployMapChannel[];
    bindings: DeployMapBinding[];
  };
  /** find-usages panel shown under the ST editor */
  declare usagesPanel?: { name: string; list: Usage[] };
  /** attached library source open in the ST pane (no fbd POU) */
  declare selLib?: string;

  private ctl = new PlcCtl();
  private dbgSymName = '';
  private dbgSymShadow = false;
  private dbgWriteHex = '';
  private dbgMaskHex = '';
  private dbgCodec = ''; // ScalarCodec.label for the resolved sym
  private dbgTypedVal = ''; // typed text input alongside hex
  private dbgTypedDirty = false; // user edited typed field → it wins over hex
  private dbgRawVal = ''; // decoded typed display of last read
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
  /* alarms pane: event journal + historian trend state */
  private alarms?: EvlogInfo[];
  private alarmStats?: EvlogStats;
  private alarmHist?: EvlogRecord[];
  private histChans?: HistChannel[];
  /* events pane: MQTT broker connections + receive journals */
  private mqttConns?: MqttConn[];
  private mqttJournals = new Map<number, { total: number; entries: MqttJournalEntry[] }>();
  private mqttTimer?: number;
  private histNamesInput = '';
  private trendCh = 0;
  private trendCodecLabel?: string;
  private trendSamples: number[] = [];
  private trendLastSeq = 0n;
  private trendTimer?: number;
  private stateDiff: DbgStateDiff | undefined;
  private odWriteHex: Record<string, string> = {};
  private evOff?: () => void;
  private evTimer?: number;

  private project: PlcProject = loadProject();
  /* backend project persistence: remote doc wins once per session
     (unless the user already edited locally); localStorage is the
     offline fallback. */
  private remoteLoaded = false;
  private localDirty = false;
  /* project pane state */
  private projInfo?: pa.ProjectInfo;
  private projFiles: pa.ProjectFile[] = [];
  private projRecent: string[] = [];
  private projOpenPath = '';
  private gitEntries: pa.GitStatusEntry[] = [];
  private gitCommits: pa.GitCommit[] = [];
  private gitBranch = '';
  private gitMsg = '';
  private gitDiffText?: string | null;
  private projBusy = false;
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
    /* first-run guidance: offer project templates on a fresh empty
       project until the user picks one, starts blank, or opts out */
    if (this.project.fbd.pous.length === 0 && tplPickerWanted(sessionStorage, localStorage)) {
      this.tplPicker = true;
    }
  }

  /** Apply a starter template — replaces the whole project document. */
  private applyTemplate(t: ProjectTemplate): void {
    this.project = instantiateTemplate(t);
    this.project.stSources = {};
    this.tplPicker = false;
    this.save();
    this.flash(`loaded template "${t.name}"`);
  }

  /** Close the picker; `forever` also suppresses future auto-opens. */
  private dismissTplPicker(forever: boolean): void {
    this.tplPicker = false;
    sessionStorage.setItem(TPL_PICKER_SESSION_KEY, '1');
    if (forever) localStorage.setItem(TPL_PICKER_FOREVER_KEY, '1');
    this.requestUpdate();
  }

  private historyDialog(): unknown {
    const items = historyIndex();
    return html`
      <div
        class="plc-tpl-overlay"
        @click=${(e: Event) => {
          if (e.target === e.currentTarget) this.historyOpen = false;
        }}
      >
        <div class="plc-tpl-dialog" style="max-width:34rem">
          <div class="plc-tpl-title">Project history</div>
          <div class="plc-tpl-sub">
            ${items.length} snapshots · auto-saved on edits (30s throttle)
          </div>
          <div class="plc-tpl-grid" style="grid-template-columns:1fr;max-height:50vh;overflow:auto">
            ${items.map(
              (h) => html`
                <div class="plc-tpl-card" style="cursor:default;text-align:left">
                  <span class="plc-tpl-name">${new Date(h.ts).toLocaleString()}</span>
                  <span class="plc-tpl-desc">${h.label} · id ${h.id}</span>
                  <span style="display:flex;gap:.4rem;margin-top:.3rem">
                    <button class="chip-btn" @click=${() => this.restoreSnapshot(h.id)}>
                      restore
                    </button>
                    <button
                      class="chip-btn"
                      @click=${() => {
                        deleteSnapshot(h.id);
                        this.requestUpdate();
                      }}
                    >
                      delete
                    </button>
                  </span>
                </div>
              `,
            )}
            ${items.length ? nothing : html`<p class="plc-dim">no snapshots yet — edits auto-snapshot after the first save.</p>`}
          </div>
          <div class="plc-tpl-foot">
            <button
              class="chip-btn"
              @click=${() => {
                pushSnapshot(this.project, 'manual', false);
                this.requestUpdate();
              }}
            >
              snapshot now
            </button>
            <button
              class="chip-btn"
              @click=${() => {
                this.historyOpen = false;
              }}
            >
              close
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private restoreSnapshot(id: number): void {
    const p = getSnapshot(id);
    if (!p) return;
    const d = diffSummary(this.project, p);
    this.project = p;
    this.selPou = p.fbd.pous[0]?.id ?? '';
    this.save();
    this.historyOpen = false;
    this.flash(`restored snapshot ${id} (${d} vs current)`);
  }

  /** Template-picker dialog — cards + blank/never-show row. */
  private templatePicker(): unknown {
    return html`
      <div
        class="plc-tpl-overlay"
        @click=${(e: Event) => {
          if (e.target === e.currentTarget) this.dismissTplPicker(false);
        }}
      >
        <div class="plc-tpl-dialog">
          <div class="plc-tpl-title">Start a project</div>
          <div class="plc-tpl-sub">Pick a template or start blank.</div>
          <div class="plc-tpl-grid">
            ${PROJECT_TEMPLATES.map(
              (t) => html`
                <button class="plc-tpl-card" @click=${() => this.applyTemplate(t)}>
                  <span class="plc-tpl-name">${t.name}</span>
                  <span class="plc-tpl-desc">${t.desc}</span>
                </button>
              `,
            )}
          </div>
          <div class="plc-tpl-foot">
            <button class="chip-btn" @click=${() => this.dismissTplPicker(false)}>
              Blank project
            </button>
            <button class="chip-btn" @click=${() => this.dismissTplPicker(true)}>
              Don't show again
            </button>
          </div>
        </div>
      </div>
    `;
  }

  /** Fetch the library block catalog once (no-op without backend/libs). */
  private async loadCatalog(): Promise<void> {
    const libs = await fetchCatalog(this.ctl);
    if (libs.length && JSON.stringify(libs) !== JSON.stringify(this.catalogLibs ?? [])) {
      this.catalogLibs = libs;
      this.catGroups = catalogGroups(libs);
      this.requestUpdate();
    }
  }

  /** Attach library sources for every catalog block the project
      references (fbd block type_refs + inline-st pin types) that isn't
      already in stSources — makes templates and pasted networks
      compile without a manual attach step. */
  private async ensureLibSources(): Promise<void> {
    const libs = this.catalogLibs ?? [];
    if (!libs.length) return;
    const refs = new Set<string>();
    for (const p of this.project.fbd.pous)
      for (const n of p.networks)
        for (const b of n.blocks) {
          if (b.type_ref) refs.add(b.type_ref.toUpperCase());
          for (const pin of b.pins ?? [])
            if (/^(FB_|F_)/i.test(pin.type)) refs.add(pin.type.toUpperCase());
        }
    let changed = false;
    for (const ref of refs) {
      const src = blockSource(libs, ref);
      if (!src) continue;
      const stem = libStem(src.file);
      const have = Object.keys(this.project.stSources).some(
        (k) => k.toUpperCase() === stem.toUpperCase(),
      );
      if (have) continue;
      const text = await fetchLibSrc(this.ctl, src.lib, src.file);
      if (text) {
        this.project.stSources[stem] = text;
        changed = true;
      }
    }
    if (changed) {
      this.save();
      this.flash('attached library sources');
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
    void fetchLibSrc(this.ctl, lib, file).then((src) => {
      if (!src) {
        this.flash(`library source ${file} not available from backend`);
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
    this.evOff?.();
    this.evOff = undefined;
    if (this.evTimer !== undefined) clearTimeout(this.evTimer);
    if (this.trendTimer !== undefined) {
      clearInterval(this.trendTimer);
      this.trendTimer = undefined;
    }
    if (this.mqttTimer !== undefined) {
      clearInterval(this.mqttTimer);
      this.mqttTimer = undefined;
    }
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
    this.unsubs.push(
      this.hub.on('values', () => {
        this.sampleExprs();
        this.requestUpdate();
      }),
    );
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
    pushSnapshot(this.project, `auto ${new Date().toLocaleTimeString()}`, true);
    saveProject(this.project);
    this.localDirty = true;
    /* persist into the backend project manifest (best-effort,
       fire-and-forget — no project open / backend down = no-op) */
    void saveProjectRemote(this.ctl, this.project).catch(() => {});
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

  // ---- ST semantic navigation (stnav.ts) ------------------------------

  private stNavWorld(): StWorld {
    return stWorld({ fbd: this.project.fbd, stSources: this.project.stSources });
  }

  private onStNav(e: CustomEvent<StNavEvent>): void {
    const d = e.detail;
    const pou = this.project.fbd.pous.find((p) => p.id === this.selPou) ?? this.project.fbd.pous[0];
    if (!pou) return;
    if (d.action === 'goto' && d.target) void this.stGoto(d.target, pou);
    else if (d.action === 'usages') this.usagesPanel = { name: d.name ?? '', list: d.usages ?? [] };
    else if (d.action === 'rename' && d.name !== undefined && d.from !== undefined)
      this.stRename(d.name, pou, d.from);
  }

  /** open `pouName`'s ST source (fbd POU or attached lib file) at `off`. */
  private async openStSource(pouName: string, off?: number): Promise<boolean> {
    const pou = this.project.fbd.pous.find((p) => p.name.toUpperCase() === pouName.toUpperCase());
    if (pou) {
      this.selPou = pou.id;
      this.selLib = undefined;
      this.pane = 'st';
    } else if (this.project.stSources[pouName]) {
      this.selLib = pouName;
      this.selPou = '';
      this.pane = 'st';
    } else {
      /* lib file whose key differs from the POU name — find the source
         that declares it */
      const key = Object.keys(this.project.stSources).find((k) =>
        declaredPousIn(this.project.stSources[k]!).some(
          (d) => d.name.toUpperCase() === pouName.toUpperCase(),
        ),
      );
      if (!key) return false;
      this.selLib = key;
      this.selPou = '';
      this.pane = 'st';
      pouName = key;
    }
    if (off !== undefined) {
      await this.updateComplete;
      this.querySelector<StEditor>('st-editor')?.jumpTo(off);
    }
    return true;
  }

  private async stGoto(t: DefTarget, fromPou: Pou): Promise<void> {
    switch (t.kind) {
      case 'pou': {
        /* prefer the declaring source + decl offset (covers lib files) */
        const key = t.source ?? t.pou;
        if (t.offset !== undefined && this.project.stSources[key]) {
          await this.openStSource(key, t.offset);
          return;
        }
        await this.openStSource(t.pou);
        return;
      }
      case 'var': {
        if (t.source && this.project.stSources[t.source]) {
          await this.openStSource(t.source, t.offset);
        } else {
          const pou = this.project.fbd.pous.find(
            (p) => p.name.toUpperCase() === t.pou.toUpperCase(),
          );
          if (pou) {
            this.selPou = pou.id;
            this.selLib = undefined;
            this.pane = 'st';
          }
        }
        return;
      }
      case 'member': {
        const src = this.project.stSources[fromPou.name] ?? '';
        const ty = instanceType(src, t.instance);
        if (!ty) return;
        /* find the source declaring the FB type, then the member decl */
        const key = Object.keys(this.project.stSources).find(
          (k) =>
            k.toUpperCase() === ty.toUpperCase() ||
            declaredPousIn(this.project.stSources[k]!).some(
              (d) => d.name.toUpperCase() === ty.toUpperCase(),
            ),
        );
        if (!key) {
          await this.openStSource(ty);
          return;
        }
        const fsrc = this.project.stSources[key]!;
        const decl = stVarSections(fsrc)
          .flatMap((s) => s.decls)
          .find((d) => d.names.some((n) => n.toUpperCase() === t.member.toUpperCase()));
        await this.openStSource(key, decl?.offset);
        return;
      }
      case 'global':
        return;
    }
  }

  private onUsageClick(u: Usage): void {
    if (!u.where.startsWith('st:')) return;
    void this.openStSource(u.where.slice(3), u.offset);
  }

  /** rename the symbol under the caret. POU renames are project-wide;
      var/member renames are scoped to the declaring POU's source +
      `inst.member` accesses (named-arg call sites are flagged by the
      compiler if they go stale). */
  private stRename(name: string, pou: Pou, at: number): void {
    const world = this.stNavWorld();
    const src = this.project.stSources[pou.name] ?? '';
    const t = findDefinition(world, pou.name, src, at);
    const nw = window.prompt(`Rename '${name}' to:`, name);
    if (!nw || nw === name || !/^[A-Za-z_]\w*$/.test(nw)) return;

    if (t?.kind === 'pou') {
      const r = renamePou(world, t.pou, nw);
      this.project.stSources = r.stSources;
      for (const p of this.project.fbd.pous)
        if (p.name.toUpperCase() === t.pou.toUpperCase()) p.name = nw;
      for (const tk of this.project.fbd.tasks ?? []) {
        const progs = (tk as { programs?: string[] }).programs;
        if (progs)
          for (let i = 0; i < progs.length; i++)
            if (progs[i]!.toUpperCase() === t.pou.toUpperCase()) progs[i] = nw;
      }
      this.save();
      this.status = `renamed ${t.pou} → ${nw}`;
      return;
    }

    /* var or member: declaring POU = target pou (or current for locals) */
    const pouName =
      t?.kind === 'member'
        ? this.memberPouName(pou, t.instance, t.member)
        : t?.kind === 'var'
          ? t.pou
          : pou.name;
    if (!pouName) {
      this.status = 'rename: could not resolve declaring POU';
      return;
    }
    const sym = t?.kind === 'member' ? t.member : name;
    /* source key: fbd pou name, or the lib file declaring it */
    const key = this.project.stSources[pouName]
      ? pouName
      : Object.keys(this.project.stSources).find(
          (k) =>
            k.toUpperCase() === pouName.toUpperCase() ||
            declaredPousIn(this.project.stSources[k]!).some(
              (d) => d.name.toUpperCase() === pouName.toUpperCase(),
            ),
        );
    if (key) {
      this.project.stSources[key] = renameInSource(this.project.stSources[key]!, sym, nw);
    }
    /* member accesses in every other source */
    for (const [k, v] of Object.entries(this.project.stSources)) {
      if (k === key) continue;
      this.project.stSources[k] = renameMemberAccesses(v, pouName, sym, nw);
    }
    /* fbd.v1 interface + variable blocks of the declaring POU */
    const dp = this.project.fbd.pous.find((p) => p.name.toUpperCase() === pouName.toUpperCase());
    if (dp) {
      for (const v of dp.interface) if (v.name.toUpperCase() === sym.toUpperCase()) v.name = nw;
      for (const net of dp.networks)
        for (const b of net.blocks)
          if (b.kind === 'variable' && b.name?.toUpperCase() === sym.toUpperCase()) b.name = nw;
    }
    this.save();
    this.status = `renamed ${sym} → ${nw} in ${pouName}`;
  }

  /** for `inst.member`, find the POU type `inst` is declared as. */
  private memberPouName(pou: Pou, inst: string, member: string): string | undefined {
    void member;
    const src = this.project.stSources[pou.name] ?? '';
    return instanceType(src, inst);
  }

  /**
   * Stimulate an image channel (`plc.image.<R>.ch.<name>`): resolve the
   * channel's qualified var name through the debug symmap and arm a
   * DBG_FORCE on the program var. The runtime translates the force
   * through the io bindings — %I forces patch the latched input image
   * every scan, %Q forces stamp the output image before commit. Only
   * BOOL bindings are forceable; other widths are denied (414).
   */
  private async onImageStim(entry: CatalogEntry, input: HTMLInputElement): Promise<void> {
    const hub = this.hub;
    if (!hub) return;
    const m = /^plc\.image\.[IQM]\.ch\.(.+)$/.exec(entry.name);
    if (!m) return;
    const name = m[1]!;
    const text = input.value.trim();
    if (!text) return;
    let sym: DbgSym;
    try {
      sym = await this.ctl.dbgResolve(name);
    } catch (e) {
      this.flash(`stim ${name}: ${e instanceof Error ? e.message : e}`);
      return;
    }
    /* SMAP kind 10 = the image-channel entry itself — its "offset" is
       an image byte, not a blob offset; only the var entry is forceable */
    if (sym.kind === 10) {
      this.flash(`stim ${name}: channel has no program var`);
      return;
    }
    const codec = codecForSym(sym);
    let bytes: Uint8Array;
    try {
      bytes = codec.encode(text);
    } catch (e) {
      this.flash(`stim ${name}: ${e instanceof Error ? e.message : e}`);
      return;
    }
    if (bytes.length !== sym.size) {
      this.flash(`stim ${name}: ${codec.label} is ${bytes.length}B, var is ${sym.size}B`);
      return;
    }
    try {
      await this.ctl.dbgForce(sym.offset, bytes);
      input.value = '';
      this.flash(`stim ${name} := ${text} (forced until cleared)`);
    } catch (e) {
      this.flash(`stim ${name}: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Write a scalar value to a writable catalog param (the force path). */
  private async onForce(entry: CatalogEntry, input: HTMLInputElement): Promise<void> {
    const hub = this.hub;
    if (!hub) return;
    const text = input.value.trim();
    /* accept BOOL spellings as well as numbers */
    const lower = text.toLowerCase();
    const v =
      lower === 'true' || lower === 'on'
        ? 1
        : lower === 'false' || lower === 'off'
          ? 0
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
          <button
            class="chip-btn"
            @click=${() => {
              this.tplPicker = true;
            }}
          >
            Templates…
          </button>
          <button class="chip-btn" @click=${this.onExport}>Export .fbd.json</button>
          <button
            class="chip-btn"
            @click=${() => {
              this.historyOpen = true;
            }}
          >
            History
          </button>
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
                  if (p.id === 'deploy' || p.id === 'events') void this.refreshCtl();
                }}
              >
                ${p.label}
              </button>
            `,
          )}
        </div>
        <div class="plc-main">${this.paneBody()}</div>
        ${this.diagsStrip()} ${this.tplPicker ? this.templatePicker() : nothing}
        ${this.historyOpen ? this.historyDialog() : nothing}
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

  /** run `tplcc check` through the /ws compile meta-op; results land in the diags strip. */
  private async onCheck(): Promise<void> {
    if (this.compiling) return;
    this.compiling = true;
    this.flushStEditors();
    try {
      await this.ensureLibSources();
      const r = await compileProject(this.ctl, this.project);
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
      case 'alarms':
        this.ensureTrendTimer();
        return this.alarmsPane();
      case 'events':
        this.ensureMqttTimer();
        return this.eventsPane();
      case 'deploy':
        return this.deployPane();
      case 'project':
        return this.projectPane();
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
                (n) =>
                  html`<div
                    class="plc-tree-net plc-tree-lib"
                    @click=${() => {
                      this.selLib = n;
                      this.selPou = '';
                      this.pane = 'st';
                    }}
                  >
                    ${n} <span class="plc-dim">${this.project.stSources[n]!.length} B</span>
                    <button
                      class="chip-btn"
                      title="detach source"
                      @click=${() => this.detachSource(n)}
                    >
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
          <tr>
            <th>name</th>
            <th>type</th>
            <th>init</th>
            <th>at</th>
            <th>retain</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${gvars.map(
            (v, vi) => html`
              <tr>
                <td>
                  <input
                    class="fbd-in"
                    .value=${v.name}
                    @change=${(e: Event) =>
                      this.editGlobalVar(vi, { name: (e.target as HTMLInputElement).value })}
                  />
                </td>
                <td>
                  <input
                    class="fbd-in"
                    .value=${v.type}
                    @change=${(e: Event) =>
                      this.editGlobalVar(vi, { type: (e.target as HTMLInputElement).value })}
                  />
                </td>
                <td>
                  <input
                    class="fbd-in"
                    .value=${v.init ?? ''}
                    @change=${(e: Event) =>
                      this.editGlobalVar(vi, { init: (e.target as HTMLInputElement).value })}
                  />
                </td>
                <td>
                  <input
                    class="fbd-in"
                    .value=${v.at ?? ''}
                    placeholder="%MW0 / %QX0.0"
                    @change=${(e: Event) =>
                      this.editGlobalVar(vi, { at: (e.target as HTMLInputElement).value })}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    .checked=${v.retain === true}
                    @change=${(e: Event) =>
                      this.editGlobalVar(vi, {
                        retain: (e.target as HTMLInputElement).checked || undefined,
                      })}
                  />
                </td>
                <td>
                  <button class="chip-btn" @click=${() => this.delGlobalVar(vi)}>✕</button>
                </td>
              </tr>
            `,
          )}
          ${
            gvars.length
              ? nothing
              : html`<tr>
                  <td colspan="6" class="plc-dim">No globals — add shared variables here.</td>
                </tr>`
          }
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
    if (this.selLib) return this.libPane();
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
                  this.selLib = undefined;
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
                    .world=${this.stNavWorld()}
                    .pouName=${pou.name}
                    @change=${(e: CustomEvent<string>) => this.onStEdit(pou, e.detail)}
                    @st-nav=${(e: CustomEvent<StNavEvent>) => this.onStNav(e)}
                  ></st-editor>
                  ${
                    this.usagesPanel
                      ? html`<div class="plc-usages">
                          <div class="plc-usages-head">
                            <b>${this.usagesPanel.list.length}</b> use(s) of
                            <b>${this.usagesPanel.name}</b>
                            <button class="chip-btn" @click=${() => (this.usagesPanel = undefined)}>
                              ✕
                            </button>
                          </div>
                          ${this.usagesPanel.list.map(
                            (u) =>
                              html`<div class="plc-usage" @click=${() => this.onUsageClick(u)}>
                                ${u.where.replace(/^st:/, '')}:${u.line}:${u.col}
                              </div>`,
                          )}
                        </div>`
                      : nothing
                  }
                `
              : html`<p class="plc-dim">No POU selected.</p>`
          }
        </div>
      </div>
    `;
  }

  /** read/write view of an attached library .st source (no fbd POU). */
  private libPane(): TemplateResult {
    const name = this.selLib ?? '';
    const src = this.project.stSources[name] ?? '';
    return html`
      <div class="plc-split">
        <div class="plc-tree tile-scroll">
          <div class="plc-tree-head"><span>Libraries</span></div>
          ${Object.keys(this.project.stSources)
            .filter((n) => this.project.stSources[n]!.trim())
            .map(
              (n) =>
                html`<div
                  class="plc-tree-net ${n === name ? 'sel' : ''}"
                  @click=${() => {
                    this.selLib = n;
                  }}
                >
                  ${n} <span class="plc-dim">${this.project.stSources[n]!.length} B</span>
                </div>`,
            )}
        </div>
        <div class="plc-detail">
          <h3>${name} <span class="plc-dim">library source</span></h3>
          <st-editor
            class="plc-st-editor"
            .value=${src}
            .symbols=${{ pous: [], vars: [] }}
            .world=${this.stNavWorld()}
            .pouName=${name}
            @change=${(e: CustomEvent<string>) => {
              this.project.stSources[name] = e.detail;
              this.save();
            }}
            @st-nav=${(e: CustomEvent<StNavEvent>) => this.onStNav(e)}
          ></st-editor>
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
                .ioBindings=${projectIoBindingsEx(this.project)}
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
    const tune =
      (key ? this.project.tunes?.[key] : undefined) ?? (pou ? tunerFromPou(pou) : undefined);
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
      <temp-tune
        .pou=${pou}
        .tune=${tune}
        .values=${this.hub ? new Map(this.hub.values) : undefined}
        @change=${(e: CustomEvent<TuneCfg>) => {
          if (key) (this.project.tunes ??= {})[key] = e.detail;
          this.save();
          this.requestUpdate();
        }}
      ></temp-tune>
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
                      <th>kind</th>
                      <th>period (ms)</th>
                      <th>trigger</th>
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
                            <select
                              class="fbd-in"
                              .value=${t.kind ?? 'cyclic'}
                              @change=${(e: Event) =>
                                this.editTask(ti, {
                                  kind: (e.target as HTMLSelectElement).value as Task['kind'],
                                  trigger:
                                    (e.target as HTMLSelectElement).value === 'event'
                                      ? (t.trigger ?? { type: 'rise' })
                                      : undefined,
                                })}
                            >
                              <option value="cyclic">cyclic</option>
                              <option value="freewheeling">freewheel</option>
                              <option value="event">event</option>
                            </select>
                          </td>
                          <td>
                            ${
                              (t.kind ?? 'cyclic') === 'cyclic'
                                ? html`<input
                                    class="fbd-in"
                                    type="number"
                                    min="1"
                                    .value=${String(t.period_ns / 1e6)}
                                    @change=${(e: Event) =>
                                    this.editTask(ti, {
                                      period_ns:
                                        Math.max(1, Number((e.target as HTMLInputElement).value)) *
                                        1e6,
                                    })}
                                  />`
                                : html`<span class="plc-dim">—</span>`
                            }
                          </td>
                          <td>
                            ${
                              (t.kind ?? 'cyclic') === 'event'
                                ? html`<span class="plc-task-trig">
                                    <select
                                      class="fbd-in"
                                      .value=${t.trigger?.type ?? 'rise'}
                                      @change=${(e: Event) =>
                                      this.editTask(ti, {
                                        trigger: {
                                          type: (e.target as HTMLSelectElement)
                                            .value as TaskTrigger['type'],
                                          signal: t.trigger?.signal,
                                        },
                                      })}
                                    >
                                      <option value="rise">rise</option>
                                      <option value="level">level</option>
                                      <option value="manual">manual</option>
                                    </select>
                                    ${
                                    (t.trigger?.type ?? 'rise') !== 'manual'
                                      ? html`<input
                                          class="fbd-in"
                                          placeholder="GVL.sig / PROG.var / %IX0.0"
                                          .value=${t.trigger?.signal ?? ''}
                                          @change=${(e: Event) =>
                                          this.editTask(ti, {
                                            trigger: {
                                              type: t.trigger?.type ?? 'rise',
                                              signal: (e.target as HTMLInputElement).value,
                                            },
                                          })}
                                        />`
                                      : ''
                                  }
                                  </span>`
                                : html`<span class="plc-dim">—</span>`
                            }
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
        return typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : undefined;
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
      const v = hub
        ? evalWatchExpr(ex, (n) => {
            const raw = hub.values.get(n);
            return typeof raw === 'number'
              ? raw
              : typeof raw === 'string'
                ? Number(raw)
                : undefined;
          })
        : undefined;
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
                <thead>
                  <tr>
                    <th>expr</th>
                    <th>value</th>
                    <th>trend</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  ${exprRows.map(
                    ({ ex, i, v }) =>
                      html`<tr>
                        <td><code>${ex}</code></td>
                        <td class=${v === undefined ? 'plc-dim' : ''}>
                          ${v === undefined ? '—' : v}
                        </td>
                        <td>${v === undefined ? nothing : sparkline(this.exprHistory(i))}</td>
                        <td>
                          <button
                            class="chip-btn"
                            @click=${() => {
                              this.watchExprs.splice(i, 1);
                              this.exprHistories.splice(i, 1);
                              this.requestUpdate();
                            }}
                          >
                            ×
                          </button>
                        </td>
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
                                  : /^plc\.image\.[IQM]\.ch\./.test(e.name)
                                    ? html`<input
                                          class="fbd-in plc-force-in"
                                          placeholder="stim"
                                          title="force this channel (BOOL channels only; persists until force-clear)"
                                          @keydown=${(ev: KeyboardEvent) => {
                                            if (ev.key === 'Enter') {
                                              void this.onImageStim(
                                                e,
                                                ev.target as HTMLInputElement,
                                              );
                                            }
                                          }}
                                        />
                                        <button
                                          class="chip-btn"
                                          @click=${(ev: Event) =>
                                            void this.onImageStim(
                                              e,
                                              (ev.target as HTMLElement)
                                                .previousElementSibling as HTMLInputElement,
                                            )}
                                        >
                                          stim
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

  // ---- alarms --------------------------------------------------------

  private static readonly SEV_NAMES = ['verbose', 'info', 'warning', 'error', 'critical'];
  private static readonly EV_STATE = ['?', 'raised', 'cleared', 'confirmed'];

  private sevName(sev: number): string {
    return TetherPlcIde.SEV_NAMES[sev] ?? `sev${sev}`;
  }

  private evStateName(st: number): string {
    return TetherPlcIde.EV_STATE[st] ?? `st${st}`;
  }

  private fmtNs(ns: bigint): string {
    const ms = Number(ns / 1000000n);
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const pad = (v: number) => String(v).padStart(2, '0');
    return `${pad(h)}:${pad(m % 60)}:${pad(s % 60)}.${String(ms % 1000).padStart(3, '0')}`;
  }

  private confirmAlarm = async (id: number): Promise<void> => {
    await this.ctlOp(`ack #${id}`, () => this.ctl.evlogConfirm(id));
    void this.refreshCtl();
  };

  private armHist = async (): Promise<void> => {
    const names = this.histNamesInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 8);
    if (!names.length) {
      this.flash('hist: enter comma-separated symbol names');
      return;
    }
    try {
      const total = await this.ctl.histConf(names);
      this.trendSamples = [];
      this.trendLastSeq = 0n;
      this.trendCh = 0;
      await this.refreshCtl();
      this.flash(`hist armed: ${names.length} ch, ${total} B frame`);
    } catch (e) {
      this.ctlErr = `hist: ${e instanceof CtlError ? e.message : e}`;
      this.requestUpdate();
    }
  };

  /** byte range of channel i inside a packed trace frame. */
  private trendChanRange(): { off: number; len: number } | undefined {
    const chs = this.histChans;
    if (!chs?.length) return undefined;
    const i = Math.min(this.trendCh, chs.length - 1);
    let off = 0;
    for (let k = 0; k < i; k++) off += chs[k]!.len;
    return { off, len: chs[i]!.len };
  }

  private trendCodecFor(ch: HistChannel | undefined): ScalarCodec {
    if (!ch) return defaultCodec(4);
    const opts = codecsForSize(ch.len);
    if (this.trendCodecLabel) {
      const pick = opts.find((c) => c.label === this.trendCodecLabel);
      if (pick) return pick;
    }
    /* prefer a float codec for 4/8-byte channels — historian feeds
       are usually REAL/LREAL process values */
    const flt = opts.find((c) => c.label === 'REAL' || c.label === 'LREAL');
    return flt ?? defaultCodec(ch.len);
  }

  /** poll TRACE_READ for new frames; decode the selected channel. */
  private trendTick = async (): Promise<void> => {
    if (this.pane !== 'alarms' || !this.histChans?.length || !this.ctlOk) {
      if (this.trendTimer !== undefined) {
        clearInterval(this.trendTimer);
        this.trendTimer = undefined;
      }
      return;
    }
    const range = this.trendChanRange();
    if (!range) return;
    try {
      const r = await this.ctl.dbgTraceRead(this.trendLastSeq, 256);
      if (!r.frames.length) {
        this.requestUpdate();
        return;
      }
      const codec = this.trendCodecFor(this.histChans[this.trendCh]);
      for (const f of r.frames) {
        this.trendLastSeq = f.seq + 1n;
        if (f.data.length < range.off + range.len) continue;
        const bytes = f.data.slice(range.off, range.off + range.len);
        const v = Number(codec.decode(bytes));
        if (Number.isFinite(v)) {
          this.trendSamples.push(v);
          if (this.trendSamples.length > 240) this.trendSamples.shift();
        }
      }
      this.requestUpdate();
    } catch {
      /* transient ctl error — next tick retries */
    }
  };

  private ensureTrendTimer(): void {
    if (this.trendTimer !== undefined) return;
    this.trendTimer = window.setInterval(() => void this.trendTick(), 700);
  }

  // ---- alarm rules ----------------------------------------------------

  private alarmRules(): AlarmRule[] {
    if (!this.project.alarms) this.project.alarms = [];
    return this.project.alarms;
  }

  private setAlarmRule(i: number, k: keyof AlarmRule, v: string): void {
    const r = this.alarmRules()[i];
    if (!r) return;
    if (k === 'priority')
      (r as unknown as Record<string, number>).priority = Math.max(0, Math.min(3, Number(v) || 0));
    else if (k === 'op') (r as unknown as Record<string, string>).op = v;
    else (r as unknown as Record<string, string>)[k] = v;
    this.save();
    this.requestUpdate();
  }

  private addAlarmRule(): void {
    const rules = this.alarmRules();
    const id = Math.max(0, ...rules.map((r) => r.id)) + 1;
    rules.push(defaultRule(id));
    this.save();
    this.requestUpdate();
  }

  private delAlarmRule(i: number): void {
    this.alarmRules().splice(i, 1);
    this.save();
    this.requestUpdate();
  }

  /** (re)generate the AlarmRules FBD program + ensure a task runs it. */
  private buildAlarmProgram(): void {
    const rules = this.alarmRules();
    const pou = buildAlarmPou(rules);
    const idx = this.project.fbd.pous.findIndex((p) => p.name === 'AlarmRules');
    if (idx >= 0) this.project.fbd.pous[idx] = pou;
    else this.project.fbd.pous.push(pou);
    /* run it on the first task (create MAIN if none) */
    const fbd = this.project.fbd;
    if (!fbd.tasks.length) {
      fbd.tasks.push({ name: 'MAIN', period_ns: 100000000, priority: 0, programs: [] } as never);
    }
    const t = fbd.tasks[0]! as { programs?: string[] };
    t.programs = t.programs ?? [];
    if (!t.programs.includes('p_alarms') && !t.programs.includes('AlarmRules'))
      t.programs.push('p_alarms');
    this.save();
    this.flash(`AlarmRules program built (${rules.length} rules)`);
    this.selPou = pou.id;
    this.pane = 'fbd';
  }

  private alarmRulesEditor(): TemplateResult {
    const rules = this.alarmRules();
    return html`
      <div class="plc-ops">
        <button class="chip-btn" @click=${() => this.addAlarmRule()}>+ rule</button>
        <button
          class="chip-btn primary"
          ?disabled=${!rules.length}
          @click=${() => this.buildAlarmProgram()}
        >
          build AlarmRules
        </button>
        ${
          rules.length
            ? html`<button
                class="chip-btn"
                @click=${() => {
                  this.project.alarms = [];
                  this.save();
                  this.requestUpdate();
                }}
              >
                clear
              </button>`
            : nothing
        }
      </div>
      ${
        rules.length
          ? html`<table class="plc-table">
              <thead>
                <tr>
                  <th>name</th>
                  <th>signal</th>
                  <th>op</th>
                  <th>threshold</th>
                  <th>pri</th>
                  <th>msg</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${rules.map(
                  (r, i) =>
                    html`<tr>
                      <td>
                        <input
                          class="plc-mapcell"
                          .value=${r.name}
                          @change=${(e: Event) => this.setAlarmRule(i, 'name', (e.target as HTMLInputElement).value)}
                        />
                      </td>
                      <td>
                        <input
                          class="plc-mapcell"
                          style="width:12ch"
                          .value=${r.signal}
                          placeholder="%IX0.0 / var"
                          @change=${(e: Event) => this.setAlarmRule(i, 'signal', (e.target as HTMLInputElement).value)}
                        />
                      </td>
                      <td>
                        <select
                          class="plc-mapcell"
                          .value=${r.op}
                          @change=${(e: Event) => this.setAlarmRule(i, 'op', (e.target as HTMLSelectElement).value)}
                        >
                          ${ALARM_OPS.map((o) => html`<option value=${o.op}>${o.op}</option>`)}
                        </select>
                      </td>
                      <td>
                        <input
                          class="plc-mapcell"
                          style="width:8ch"
                          .value=${r.threshold}
                          @change=${(e: Event) => this.setAlarmRule(i, 'threshold', (e.target as HTMLInputElement).value)}
                        />
                      </td>
                      <td>
                        <input
                          class="plc-mapcell"
                          type="number"
                          min="0"
                          max="3"
                          style="width:4ch"
                          .value=${String(r.priority)}
                          @change=${(e: Event) => this.setAlarmRule(i, 'priority', (e.target as HTMLInputElement).value)}
                        />
                      </td>
                      <td>
                        <input
                          class="plc-mapcell"
                          style="width:14ch"
                          .value=${r.message ?? ''}
                          @change=${(e: Event) => this.setAlarmRule(i, 'message', (e.target as HTMLInputElement).value)}
                        />
                      </td>
                      <td>
                        <button class="chip-btn" @click=${() => this.delAlarmRule(i)}>✕</button>
                      </td>
                    </tr>`,
                )}
              </tbody>
            </table>`
          : html`<p class="plc-dim">
              no rules — define a condition on a signal, then build the AlarmRules program.
            </p>`
      }
    `;
  }

  private alarmsPane(): TemplateResult {
    const st = this.alarmStats;
    const live = this.alarms ?? [];
    const hist = this.alarmHist ?? [];
    const chans = this.histChans ?? [];
    return html`
      <div class="tile-scroll">
        <h3>
          Alarms
          ${
            st
              ? html`<span class="plc-dim">
                  live ${st.live} · raised ${st.raised} · cleared ${st.cleared} · confirmed
                  ${st.confirmed}${st.dropped ? ` · dropped ${st.dropped}` : ''}
                </span>`
              : nothing
          }
        </h3>
        ${
          this.ctlOk === false
            ? html`<p class="plc-dim">ctl unreachable — connect on the Deploy pane.</p>`
            : nothing
        }
        <h4>Rules <span class="plc-dim">compiled into the AlarmRules program</span></h4>
        ${this.alarmRulesEditor()}
        <h4>Live events</h4>
        ${
          live.length
            ? html`
                <table class="plc-table">
                  <thead>
                    <tr>
                      <th>id</th>
                      <th>sev</th>
                      <th>state</th>
                      <th>event</th>
                      <th>text</th>
                      <th>raised</th>
                      <th>ack</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${live.map(
                      (e) => html`
                        <tr>
                          <td>#${e.id}</td>
                          <td>${this.sevName(e.severity)}</td>
                          <td>${this.evStateName(e.state)}</td>
                          <td>cls${e.cls}/evt${e.eventId}</td>
                          <td>${e.text}</td>
                          <td>${this.fmtNs(e.raisedNs)}</td>
                          <td>
                            ${
                              e.state === 1
                                ? html`<button
                                    class="chip-btn"
                                    @click=${() => void this.confirmAlarm(e.id)}
                                  >
                                    ack
                                  </button>`
                                : '—'
                            }
                          </td>
                        </tr>
                      `,
                    )}
                  </tbody>
                </table>
              `
            : html`<p class="plc-dim">no live events</p>`
        }
        <h4>History <span class="plc-dim">last transitions</span></h4>
        ${
          hist.length
            ? html`
                <table class="plc-table">
                  <thead>
                    <tr>
                      <th>time</th>
                      <th>id</th>
                      <th>state</th>
                      <th>sev</th>
                      <th>text</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${[...hist].reverse().map(
                      (r) => html`
                        <tr>
                          <td>${this.fmtNs(r.tsNs)}</td>
                          <td>#${r.journalId}</td>
                          <td>${this.evStateName(r.state)}</td>
                          <td>${this.sevName(r.severity)}</td>
                          <td>${r.text}</td>
                        </tr>
                      `,
                    )}
                  </tbody>
                </table>
              `
            : html`<p class="plc-dim">no transitions recorded</p>`
        }
        <h4>
          Historian
          <span class="plc-dim">named channels → flight-recorder ring</span>
        </h4>
        <div class="plc-ops">
          <input
            class="fbd-in wide"
            placeholder="symbols e.g. temp.sp, pv, cnt"
            .value=${this.histNamesInput}
            @input=${(e: Event) => (this.histNamesInput = (e.target as HTMLInputElement).value)}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === 'Enter') void this.armHist();
            }}
          />
          <button class="chip-btn" @click=${() => void this.armHist()}>arm</button>
          <button
            class="chip-btn"
            ?disabled=${!chans.length}
            @click=${() => void this.ctl.dbgTraceClear().then(() => this.refreshCtl())}
          >
            clear ring
          </button>
        </div>
        ${
          chans.length
            ? html`
                <table class="plc-table">
                  <thead>
                    <tr>
                      <th>channel</th>
                      <th>off</th>
                      <th>len</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${chans.map(
                      (c, i) => html`
                        <tr>
                          <td>${c.name}</td>
                          <td>${c.off.toString()}</td>
                          <td>${c.len}</td>
                          <td>
                            <input
                              type="radio"
                              name="trendch"
                              .checked=${this.trendCh === i}
                              @change=${() => {
                                this.trendCh = i;
                                this.trendSamples = [];
                                this.trendLastSeq = 0n;
                              }}
                            />
                          </td>
                        </tr>
                      `,
                    )}
                  </tbody>
                </table>
                <div class="plc-ops">
                  <span class="plc-dim">decode</span>
                  ${codecsForSize(chans[this.trendCh]?.len ?? 0).map(
                    (c) => html`
                      <button
                        class="chip-btn ${
                          this.trendCodecFor(chans[this.trendCh]).label === c.label ? 'active' : ''
                        }"
                        @click=${() => {
                          this.trendCodecLabel = c.label;
                          this.trendSamples = [];
                          this.trendLastSeq = 0n;
                          this.requestUpdate();
                        }}
                      >
                        ${c.label}
                      </button>
                    `,
                  )}
                </div>
                <div class="plc-trend">
                  ${sparkline(this.trendSamples, 320, 48)}
                  <span class="plc-dim">
                    ${chans[this.trendCh]?.name ?? ''}
                    ${
                      this.trendSamples.length
                        ? `= ${this.trendSamples[this.trendSamples.length - 1]}`
                        : '—'
                    }
                    (${this.trendSamples.length} samples)
                  </span>
                </div>
              `
            : html`<p class="plc-dim">no historian channels armed</p>`
        }
      </div>
    `;
  }

  // ---- events (MQTT/HA message feed + history) ------------------------

  private mqttTransportName(t: number): string {
    return ['auto', 'tcp', 'ssl', 'ws', 'wss'][t] ?? `t${t}`;
  }

  private mqttConnLabel(c: MqttConn): string {
    const scheme =
      c.transport === 3
        ? 'ws'
        : c.transport === 4
          ? 'wss'
          : c.transport === 1
            ? 'tcp'
            : c.transport === 2
              ? 'ssl'
              : c.tls
                ? 'ssl'
                : 'tcp';
    return `${scheme}://${c.host}:${c.port}`;
  }

  /** payload as display text: UTF-8 when printable, hex otherwise. */
  private mqttPayloadText(p: Uint8Array): string {
    if (!p.length) return '—';
    try {
      const s = new TextDecoder('utf-8', { fatal: true }).decode(p);
      if (/^[\x20-\x7e\t\r\n]*$/.test(s)) return s;
      return hex(p.subarray(0, 48)) + (p.length > 48 ? '…' : '');
    } catch {
      return hex(p.subarray(0, 48)) + (p.length > 48 ? '…' : '');
    }
  }

  private fmtMs(tsMs: bigint): string {
    const d = new Date(Number(tsMs));
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  }

  /** merged journal view: newest first across all connections. */
  private mqttFeed(): { conn: MqttConn; e: MqttJournalEntry }[] {
    const rows: { conn: MqttConn; e: MqttJournalEntry }[] = [];
    for (const c of this.mqttConns ?? []) {
      for (const e of this.mqttJournals.get(c.handle)?.entries ?? []) rows.push({ conn: c, e });
    }
    rows.sort((a, b) => (a.e.tsMs < b.e.tsMs ? 1 : -1));
    return rows.slice(0, 200);
  }

  private eventsPane(): TemplateResult {
    const conns = this.mqttConns ?? [];
    const feed = this.mqttFeed();
    const anyConn = conns.length > 0;
    const live = conns.filter((c) => c.state === 2).length;
    return html`
      <div class="tile-scroll">
        <h3>
          Events
          <span class="plc-dim">
            MQTT message feed · ${live}/${conns.length} broker${conns.length === 1 ? '' : 's'}
            connected
          </span>
        </h3>
        ${
          this.ctlOk === false
            ? html`<p class="plc-dim">ctl unreachable — connect on the Deploy pane.</p>`
            : nothing
        }
        <h4>Brokers</h4>
        ${
          anyConn
            ? html`
                <table class="plc-table">
                  <thead>
                    <tr>
                      <th>hdl</th>
                      <th>broker</th>
                      <th>transport</th>
                      <th>state</th>
                      <th>journaled</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${conns.map(
                      (c) => html`
                        <tr>
                          <td>#${c.handle}</td>
                          <td>
                            ${this.mqttConnLabel(c)}<br /><span class="plc-dim"
                              >${c.clientId || '—'}</span
                            >
                          </td>
                          <td>
                            ${this.mqttTransportName(c.transport)}${c.tls ? ' 🔒' : ''} ·
                            mqtt${c.mqttVersion}
                          </td>
                          <td>
                            ${c.state === 2 ? 'connected' : c.state === 1 ? 'connecting' : 'down'}
                          </td>
                          <td>${this.mqttJournals.get(c.handle)?.total ?? 0}</td>
                        </tr>
                      `,
                    )}
                  </tbody>
                </table>
              `
            : html`<p class="plc-dim">
                no MQTT brokers connected — the journal fills when a program polls FB_MqttRx /
                FB_Mqtt / FB_HaEntity.
              </p>`
        }
        <h4>
          Message history <span class="plc-dim">inbound PUBLISH, newest first · 64/conn</span>
        </h4>
        ${
          feed.length
            ? html`
                <table class="plc-table">
                  <thead>
                    <tr>
                      <th>time</th>
                      <th>broker</th>
                      <th>topic</th>
                      <th>payload</th>
                      <th>qos</th>
                      <th>ret</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${feed.map(
                      ({ conn, e }) => html`
                        <tr>
                          <td>${this.fmtMs(e.tsMs)}</td>
                          <td class="plc-dim">#${conn.handle}</td>
                          <td>${e.topic}</td>
                          <td class="plc-mono">${this.mqttPayloadText(e.payload)}</td>
                          <td>${e.qos}</td>
                          <td>${e.retain ? 'R' : ''}</td>
                        </tr>
                      `,
                    )}
                  </tbody>
                </table>
              `
            : html`<p class="plc-dim">${anyConn ? 'no messages journaled yet' : '—'}</p>`
        }
      </div>
    `;
  }

  /** ~1.5 s poll while the Events pane is open. */
  private mqttTick = async (): Promise<void> => {
    if (this.pane !== 'events' || !this.ctlOk) {
      if (this.mqttTimer !== undefined) {
        clearInterval(this.mqttTimer);
        this.mqttTimer = undefined;
      }
      return;
    }
    await this.refreshCtl();
  };

  private ensureMqttTimer(): void {
    if (this.mqttTimer !== undefined) return;
    this.mqttTimer = window.setInterval(() => void this.mqttTick(), 1500);
  }

  // ---- deploy --------------------------------------------------------

  private deployPane(): TemplateResult {
    const ctl = this.ctl;
    return html`
      <div class="tile-scroll">
        <h3>Deploy</h3>
        <div class="plc-ctlbar">
          backend
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
        ${this.prog ? this.progTable(this.prog) : nothing} ${this.shadowCard()}
        ${this.dbg ? this.debugCard(this.dbg) : nothing}
        ${this.retain ? this.retainCard(this.retain) : nothing} ${this.ioMapCard()} ${this.odCard()}
        ${this.journalCard()}
        ${this.rt ? html`<p class="plc-dim">rt: up ${this.rt.uptimeS}s · ${this.rt.progCount} progs (${this.rt.runningCount} running) · master ${this.rt.masterStatus} plc ${this.rt.plcStatus}${this.rt.version ? ` · ${this.rt.version}` : ''}</p>` : nothing}
        <p class="plc-dim">
          Requires <code>tplc serve</code> running on the plc host. Online-change (state-preserving
          swap + rollback) is live through PROG_SWAP / PROG_ROLLBACK.
        </p>
      </div>
    `;
  }

  /* ---------------- project pane ---------------- */

  private projInfoLoaded = false;
  private projEdit: Record<string, string> = {};

  private async refreshProjectPane(): Promise<void> {
    this.projBusy = true;
    try {
      const [info, files, entries, commits, recent, branch] = await Promise.all([
        remoteProjectInfo(this.ctl),
        pa.projectFiles(this.ctl),
        pa.gitStatus(this.ctl),
        pa.gitLog(this.ctl, 30),
        pa.projectsRecent(this.ctl),
        pa.gitBranch(this.ctl),
      ]);
      this.projInfo = info;
      this.projFiles = files;
      this.gitEntries = entries;
      this.gitCommits = commits;
      this.projRecent = recent;
      this.gitBranch = branch;
      if (info) {
        const m = info.manifest ?? {};
        this.projEdit = {
          name: m.name ?? info.name ?? '',
          description: m.description ?? '',
          sources: (m.sources ?? []).join(', '),
          libs: (m.libs ?? []).join(', '),
          taskPeriodNs: m.taskPeriodNs?.toString() ?? '',
          imageIn: m.imageIn?.toString() ?? '',
          imageOut: m.imageOut?.toString() ?? '',
        };
      }
      this.projInfoLoaded = true;
    } finally {
      this.projBusy = false;
      this.requestUpdate();
    }
  }

  private async projOpenDir(path: string): Promise<void> {
    this.projBusy = true;
    try {
      const info = await pa.projectOpen(this.ctl, path);
      this.projInfo = info;
      this.flash(`project opened: ${info.root}`);
      await this.refreshProjectPane();
    } catch (e) {
      this.flash(`open failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.projBusy = false;
      this.requestUpdate();
    }
  }

  private async projSaveManifest(): Promise<void> {
    const info = this.projInfo;
    if (!info) return;
    const e = this.projEdit;
    const csv = (s: string) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
    const manifest: pa.ProjectManifest = {
      ...(info.manifest ?? {}),
      name: e.name || info.name,
      description: e.description || undefined,
      sources: csv(e.sources ?? ''),
      libs: csv(e.libs ?? ''),
      taskPeriodNs: e.taskPeriodNs ? Number(e.taskPeriodNs) : undefined,
      imageIn: e.imageIn ? Number(e.imageIn) : undefined,
      imageOut: e.imageOut ? Number(e.imageOut) : undefined,
      ui: this.project,
    };
    try {
      await pa.projectSave(this.ctl, manifest);
      this.flash('project manifest saved');
    } catch (err) {
      this.flash(`save failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async projGitCommit(): Promise<void> {
    const msg = this.gitMsg.trim();
    if (!msg) return;
    try {
      const short = await pa.gitCommit(this.ctl, msg);
      this.gitMsg = '';
      this.flash(short ? `committed ${short}` : 'commit failed');
      await this.refreshProjectPane();
    } catch (e) {
      this.flash(`commit failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  private async projGitDiff(path?: string): Promise<void> {
    this.gitDiffText = await pa.gitDiff(this.ctl, path);
    this.requestUpdate();
  }

  private projectPane(): TemplateResult {
    if (!this.projInfoLoaded && !this.projBusy) void this.refreshProjectPane();
    const info = this.projInfo;
    const e = this.projEdit;
    const field = (key: string, label: string, ph = '') => html`
      <label class="plc-projfield"
        >${label}
        <input
          class="fbd-in"
          .value=${e[key] ?? ''}
          placeholder=${ph}
          @input=${(ev: Event) => {
            this.projEdit = { ...this.projEdit, [key]: (ev.target as HTMLInputElement).value };
          }}
      /></label>
    `;
    return html`
      <div class="tile-scroll">
        <h3>Project</h3>
        ${
          info
            ? html`<div class="plc-dim">
                <strong>${info.name}</strong> · ${info.root}
                ${info.git ? html`· git <code>${info.branch || '?'}</code>` : html`· no git`}
              </div>`
            : html`<p class="fbd-warn">
                No project open — the IDE document persists in this browser only. Open a project
                directory to get file persistence + git versioning.
              </p>`
        }

        <h4>Open project</h4>
        <div class="plc-ctlbar">
          <input
            class="fbd-in wide"
            placeholder="/path/to/project"
            .value=${this.projOpenPath}
            @input=${(ev: Event) => {
              this.projOpenPath = (ev.target as HTMLInputElement).value;
            }}
          />
          <button
            class="chip-btn"
            ?disabled=${this.projBusy || !this.projOpenPath.trim()}
            @click=${() => void this.projOpenDir(this.projOpenPath.trim())}
          >
            open
          </button>
          <button
            class="chip-btn"
            ?disabled=${this.projBusy}
            @click=${() => void this.refreshProjectPane()}
          >
            refresh
          </button>
        </div>
        ${
          this.projRecent.length
            ? html`<div class="plc-dim">recent:</div>
                ${this.projRecent.map(
                  (r) =>
                    html`<div class="plc-projrecent" @click=${() => void this.projOpenDir(r)}>
                      ${r}
                    </div>`,
                )}`
            : nothing
        }
        ${
          info
            ? html`
                <h4>Manifest</h4>
                <div class="plc-projgrid">
                  ${field('name', 'name')} ${field('description', 'description')}
                  ${field('sources', 'sources', 'src/main.st, src/other.st')}
                  ${field('libs', 'library dirs', 'libs, ../TetherPLC/libraries/tempctrl')}
                  ${field('taskPeriodNs', 'task period ns', '10000000')}
                  ${field('imageIn', 'image %I bytes', '64')}
                  ${field('imageOut', 'image %Q bytes', '64')}
                </div>
                <button class="chip-btn" @click=${() => void this.projSaveManifest()}>
                  save manifest
                </button>
                <span class="plc-dim"> (ui document is saved automatically on edit)</span>

                <h4>Files (${this.projFiles.length})</h4>
                <div class="plc-projfiles">
                  ${this.projFiles.slice(0, 200).map(
                    (f) =>
                      html`<div class="plc-projfile" title=${f.path}>
                        <code>${f.path}</code> <span class="plc-dim">${f.size} B</span>
                        <button
                          class="chip-btn"
                          @click=${() =>
                          void pa.gitDiff(this.ctl, f.path).then((d) => {
                            this.gitDiffText = d;
                            this.requestUpdate();
                          })}
                        >
                          diff
                        </button>
                      </div>`,
                  )}
                </div>

                <h4>Git ${info.git ? html`<code>${this.gitBranch}</code>` : nothing}</h4>
                ${
                  this.gitEntries.length
                    ? html`<div class="plc-projgit">
                        ${this.gitEntries.map(
                          (g) =>
                            html`<div class="plc-progmeta">
                              <code>${g.status}</code> ${g.path}
                              <button
                                class="chip-btn"
                                @click=${() =>
                                void pa.gitDiff(this.ctl, g.path).then((d) => {
                                  this.gitDiffText = d;
                                  this.requestUpdate();
                                })}
                              >
                                diff
                              </button>
                            </div>`,
                        )}
                      </div>`
                    : html`<div class="plc-ok">working tree clean</div>`
                }
                <div class="plc-ctlbar">
                  <input
                    class="fbd-in wide"
                    placeholder="commit message"
                    .value=${this.gitMsg}
                    @input=${(ev: Event) => {
                      this.gitMsg = (ev.target as HTMLInputElement).value;
                    }}
                    @keydown=${(ev: KeyboardEvent) => {
                      if (ev.key === 'Enter') void this.projGitCommit();
                    }}
                  />
                  <button
                    class="chip-btn"
                    ?disabled=${!this.gitMsg.trim()}
                    @click=${() => void this.projGitCommit()}
                  >
                    commit all
                  </button>
                </div>
                ${
                  this.gitDiffText != null
                    ? html`<pre class="plc-diff">${this.gitDiffText || '(no diff)'}</pre>`
                    : nothing
                }
                <h4>History</h4>
                <div class="plc-projgit">
                  ${this.gitCommits.map(
                    (c) =>
                      html`<div class="plc-progmeta">
                        <code>${c.short}</code> ${c.message}
                        <span class="plc-dim"
                          >${c.author} · ${new Date(c.time * 1000).toLocaleString()}</span
                        >
                      </div>`,
                  )}
                </div>
              `
            : nothing
        }
      </div>
    `;
  }

  private progTable(p: ProgStatus): TemplateResult {
    return html`
      <h4>
        program ${p.name}
        <span class="plc-dim"
          >${['stopped', 'running', 'fault'][p.state] ?? p.state} · ${p.cycles} cycles${p.epoch !== undefined ? ` · epoch ${p.epoch}` : ''}</span
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
                  ${
                    t.state === 2
                      ? html`<button
                            class="chip-btn"
                            @click=${() => this.ctlOp('resume', () => this.ctl.taskResume(i))}
                          >
                            resume</button
                          ><button
                            class="chip-btn"
                            @click=${() => this.ctlOp('step', () => this.ctl.taskStep(i, 1))}
                          >
                            step</button
                          ><button
                            class="chip-btn"
                            @click=${() => this.ctlOp('step×10', () => this.ctl.taskStep(i, 10))}
                          >
                            +10
                          </button>`
                      : html`<button
                          class="chip-btn"
                          ?disabled=${p.state !== 1}
                          @click=${() => this.ctlOp('suspend', () => this.ctl.taskSuspend(i))}
                        >
                          suspend
                        </button>`
                  }
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
      parts.push(`deployed ${new Date(Number(p.deployedAtNs / 1000000n)).toLocaleString()}`);
    if (p.lastFaultCode)
      parts.push(
        `last fault rc=${p.lastFaultCode}` +
          (p.faultCycle !== undefined ? ` @cycle ${p.faultCycle}` : ''),
      );
    if (p.forceCount) parts.push(`${p.forceCount} force(s) active`);
    if (p.retainDirtyBytes) parts.push(`retain dirty ${p.retainDirtyBytes} B`);
    if (p.swapStage)
      parts.push(
        `swap stage ${p.swapStage}` + (p.quarantineLeft ? ` (${p.quarantineLeft} left)` : ''),
      );
    if (!parts.length) return nothing;
    return html`<div class="plc-dim plc-progmeta">${parts.join(' · ')}</div>`;
  }

  private shadowCard(): TemplateResult | typeof nothing {
    if (!this.ctlOk || !this.prog) return nothing;
    const sh = this.shadow;
    const diffs = this.shadowDiffs ?? [];
    const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');
    return html`
      <h4>
        shadow run
        ${
          sh?.loaded
            ? html`<span class="plc-dim"
                >${sh.name} ${sh.uuid?.slice(0, 8)} ·
                ${['stopped', 'running', 'fault'][sh.state ?? 0] ?? sh.state} · ${sh.cycles} cycles
                · ${sh.missed} missed · ${sh.diffCount} diffs
                ${sh.diffCount ? html`· last @ cycle ${sh.lastDiffCycle}` : nothing}</span
              >`
            : html`<span class="plc-dim">none loaded</span>`
        }
      </h4>
      <div class="plc-ops">
        <input type="file" id="plc-shpkg" accept=".tplc" hidden @change=${this.onShadowPkgFile} />
        <button
          class="chip-btn"
          ?disabled=${this.prog.state !== 1}
          title="deploy a .tplc package and run it as the shadow candidate"
          @click=${() => this.querySelector<HTMLInputElement>('#plc-shpkg')?.click()}
        >
          ${sh?.loaded ? 'reload…' : 'deploy as shadow…'}
        </button>
        ${
          sh?.loaded
            ? html`<button
                  class="chip-btn"
                  title="atomically adopt the shadow program and its live state"
                  @click=${() => this.onShadowPromote()}
                >
                  promote</button
                ><button
                  class="chip-btn"
                  title="re-run active→shadow state migration"
                  @click=${() => this.ctlOp('shadow reset', () => this.ctl.shadowReset())}
                >
                  reset</button
                ><button
                  class="chip-btn"
                  @click=${() => this.ctlOp('shadow drop', () => this.ctl.shadowDrop())}
                >
                  drop
                </button>`
            : nothing
        }
      </div>
      ${
        sh?.loaded
          ? html`<p class="plc-dim">
              outputs private · diffs are post-%Q byte runs · watch a candidate var as
              <code>SHADOW.&lt;sym&gt;</code>
            </p>`
          : nothing
      }
      ${
        diffs.length
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
                  (d) =>
                    html`<tr>
                      <td>${d.cycle}</td>
                      <td>0x${d.imgOff.toString(16)}</td>
                      <td><code>${hex(d.active)}</code></td>
                      <td><code>${hex(d.shadow)}</code></td>
                    </tr>`,
                )}
              </tbody>
            </table>`
          : nothing
      }
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
          ${d.retainLen > 0n ? ` off ${d.retainOff} len ${d.retainLen}` : ' none'} · ${d.symCount}
          symbols
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
        ${
          s
            ? html`<span class="${stale ? 'fbd-warn' : 'plc-dim'}">
                  ${this.dbgSymShadow ? 'shadow ' : ''}sym ${s.symIdx} kind ${s.kind} region
                  ${s.region} access ${s.access} · off ${s.offset} size
                  ${s.size}B${stale ? ' · STALE epoch' : ''}
                </span>
                <button class="chip-btn" @click=${() => void this.onDbgRead()}>read</button>
                ${
                  !this.dbgSymShadow
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
                        <button class="chip-btn" @click=${() => void this.onDbgWrite()}>
                          write
                        </button>
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
                        >
                          force
                        </button>`
                    : html`<span class="plc-dim">shadow blob is read-only</span>`
                }
                <button
                  class="chip-btn"
                  title="stage as a flight-recorder channel"
                  @click=${() => this.onTraceChAdd()}
                >
                  + rec
                </button>
                <button
                  class="chip-btn"
                  title="stage as a watch item"
                  @click=${() => this.onWatchChAdd()}
                >
                  + watch
                </button>`
            : nothing
        }
      </div>
      ${this.dbgHex ? html`<code class="plc-dbg-hex">${this.dbgHex}</code>` : nothing}
      ${this.dbgRawVal ? html`<code class="plc-dbg-hex">${this.dbgRawVal}</code>` : nothing}
      ${
        this.forces && this.forces.length > 0
          ? html`<div class="plc-forces">
              ${this.forces.map(
                (f) =>
                  html`<span class="plc-force-tag">
                    off ${f.offset} =
                    ${[...f.bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}
                    ${
                    f.mask && f.mask.some((m) => m !== 0xff)
                      ? html` & ${[...f.mask].map((m) => m.toString(16).padStart(2, '0')).join('')}`
                      : nothing
                  }
                    <button
                      class="chip-btn"
                      @click=${() =>
                      this.ctlOp('force clear', () => this.ctl.dbgForceClear(f.handle))}
                    >
                      ×
                    </button>
                  </span>`,
              )}
              <button
                class="chip-btn"
                @click=${() => this.ctlOp('force clear', () => this.ctl.dbgForceClear())}
              >
                clear all
              </button>
            </div>`
          : nothing
      }
      ${
        s && [1, 2, 4, 8].includes(s.size)
          ? html`<div class="plc-ops">
              <select
                class="fbd-in"
                .value=${this.brkKind}
                @change=${(e: Event) => (this.brkKind = (e.target as HTMLSelectElement).value)}
              >
                <option value="0">break task</option>
                <option value="1">capture on</option>
              </select>
              <input
                class="fbd-in plc-brk-task"
                .value=${this.brkTask}
                @input=${(e: Event) => (this.brkTask = (e.target as HTMLInputElement).value)}
              />
              <span class="plc-dim">when ${this.dbgSymName || 'sym'}</span>
              <select
                class="fbd-in"
                .value=${this.brkCmp}
                @change=${(e: Event) => (this.brkCmp = (e.target as HTMLSelectElement).value)}
              >
                ${DBG_CMP.map((c, i) => html`<option value=${i}>${c}</option>`)}
              </select>
              <input
                class="fbd-in"
                placeholder="value"
                .value=${this.brkVal}
                @input=${(e: Event) => (this.brkVal = (e.target as HTMLInputElement).value)}
              />
              <button class="chip-btn" @click=${() => void this.onDbgBreak()}>arm</button>
              <input
                class="fbd-in"
                placeholder="or expr: counter % 50 == 0 && flag"
                .value=${this.brkExpr}
                @input=${(e: Event) => (this.brkExpr = (e.target as HTMLInputElement).value)}
              />
              <button
                class="chip-btn"
                title="arm expression trigger (paths resolve at arm time)"
                @click=${() => void this.onDbgBreakExpr()}
              >
                arm expr
              </button>
            </div>`
          : nothing
      }
      ${
        this.breaks && this.breaks.length > 0
          ? html`<div class="plc-forces">
              ${this.breaks.map(
                (b) =>
                  html`<span class="plc-force-tag">
                    h${b.handle} ${b.kind ? 'cap' : 'brk'} ${b.stale ? 'stale ' : ''}task
                    ${b.taskIdx}
                    ${
                    b.cmp === 0xff
                      ? 'expr'
                      : html`blob[${b.offset}..${b.len}] ${DBG_CMP[b.cmp] ?? b.cmp} ${b.value}`
                  }
                    · hits ${b.hits}
                    <button
                      class="chip-btn"
                      @click=${() =>
                      this.ctlOp('break clear', () => this.ctl.dbgBreakClear(b.handle))}
                    >
                      ×
                    </button>
                  </span>`,
              )}
              <button
                class="chip-btn"
                @click=${() => this.ctlOp('break clear', () => this.ctl.dbgBreakClear())}
              >
                clear all
              </button>
            </div>`
          : nothing
      }
      ${
        this.traceChs.length > 0
          ? html`<div class="plc-forces">
              <span class="plc-dim">rec ch:</span>
              ${this.traceChs.map(
                (c, i) =>
                  html`<span class="plc-force-tag">
                    ${c.name} ${c.off}:${c.len}
                    <button
                      class="chip-btn"
                      @click=${() => {
                      this.traceChs.splice(i, 1);
                      this.requestUpdate();
                    }}
                    >
                      ×
                    </button>
                  </span>`,
              )}
              <button class="chip-btn" @click=${() => void this.onTraceArm()}>record</button>
              <label class="plc-dim">
                <input
                  type="checkbox"
                  .checked=${this.traceNoFreeze}
                  @change=${(e: Event) =>
                    (this.traceNoFreeze = (e.target as HTMLInputElement).checked)}
                />
                nofreeze
              </label>
            </div>`
          : nothing
      }
      ${
        this.trace && this.trace.channels > 0
          ? html`<div class="plc-forces">
              <span class="plc-force-tag">
                rec ${this.trace.written} frames · ${this.trace.avail} in ring ·
                ${this.trace.frameLen}B/frame ${this.trace.frozen ? ' · FROZEN' : nothing}
              </span>
              <button class="chip-btn" @click=${() => void this.onTraceRead()}>read</button>
              <button
                class="chip-btn"
                @click=${() => this.ctlOp('trace clear', () => this.ctl.dbgTraceClear())}
              >
                stop
              </button>
            </div>`
          : nothing
      }
      ${
        this.watchChs.length > 0
          ? html`<div class="plc-forces">
              <span class="plc-dim">watch items:</span>
              ${this.watchChs.map(
                (c, i) =>
                  html`<span class="plc-force-tag">
                    ${c.name} ${c.off}:${c.len}
                    <button
                      class="chip-btn"
                      @click=${() => {
                      this.watchChs.splice(i, 1);
                      this.requestUpdate();
                    }}
                    >
                      ×
                    </button>
                  </span>`,
              )}
              <button class="chip-btn" @click=${() => void this.onWatchAdd()}>add watch</button>
            </div>`
          : nothing
      }
      ${
        this.watches && this.watches.length > 0
          ? html`<div class="plc-forces">
              ${this.watches.map(
                (wt) =>
                  html`<span class="plc-force-tag">
                    watch h${wt.handle} ${wt.items}×${wt.totalLen}B
                    ${wt.rateHz ? ` · ${wt.rateHz}Hz` : ''} ${wt.stale ? ' · STALE' : ''}
                    ${this.watchVals.get(wt.handle)?.map((v) => html` =${v}`)}
                    <button
                      class="chip-btn"
                      title="one-shot read"
                      @click=${() => void this.onWatchGet(wt.handle)}
                    >
                      get
                    </button>
                    <button
                      class="chip-btn"
                      title=${wt.rateHz ? 'stop streaming' : 'stream at 10 Hz'}
                      @click=${() =>
                      this.ctlOp('watch stream', () =>
                        this.ctl.dbgWatchStream(wt.handle, wt.rateHz ? 0 : 10),
                      )}
                    >
                      ${wt.rateHz ? 'stop' : 'stream'}
                    </button>
                    <button
                      class="chip-btn"
                      @click=${() => this.ctlOp('watch rm', () => this.ctl.dbgWatchRemove(wt.handle))}
                    >
                      ×
                    </button>
                  </span>`,
              )}
            </div>`
          : nothing
      }
      ${this.traceChart()}
      ${
        this.traceLines
          ? html`<details class="plc-trace-raw">
              <summary class="plc-dim">raw frames</summary>
              <code class="plc-dbg-hex">${this.traceLines.map((l) => html`${l}<br />`)}</code>
            </details>`
          : nothing
      }
      <div class="plc-forces">
        <button
          class="chip-btn"
          title="what the last swap's migrate rules did"
          @click=${() => void this.onStateDiff()}
        >
          state.diff
        </button>
        ${
          this.stateDiff
            ? html`<span class="plc-dim">
                ${this.stateDiff.sameLayout ? 'same-layout' : 'migrated'} ·
                ${this.stateDiff.rules.length} rules</span
              >`
            : nothing
        }
      </div>
      ${
        this.stateDiff
          ? html`<div class="plc-forces">
              ${this.stateDiff.rules.map(
                (r) =>
                  html`<span class="plc-force-tag">
                    ${DBG_DIFF_KIND[r.kind] ?? r.kind} ${r.oldName || '-'}[${r.oldOff}:${r.oldLen}]
                    → ${r.newName || '-'}[${r.newOff}:${r.newLen}]
                    ${r.sev === 1 ? ' · degraded' : nothing} ${r.sev === 2 ? ' · deny' : nothing}
                  </span>`,
              )}
            </div>`
          : nothing
      }
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
      const b = await this.ctl.dbgRead(s.offset, Math.min(s.size, 256), this.dbgSymShadow ? 1 : 0);
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
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)!;
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
        this.ctl,
        taskIdx,
        s.offset,
        s.size,
        Number(this.brkCmp),
        value,
      ),
    );
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
    await this.ctlOp(kind ? 'dbg capture expr' : 'dbg break expr', () =>
      this.ctl.dbgBreakExpr(taskIdx, expr, kind === 1),
    );
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
    this.traceChs.push({
      name: this.dbgSymName.trim() || `off${s.offset}`,
      off: s.offset,
      len: s.size,
    });
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
    this.watchChs.push({
      name: this.dbgSymName.trim() || `off${s.offset}`,
      off: s.offset,
      len: s.size,
    });
    this.requestUpdate();
  }

  private async onWatchAdd(): Promise<void> {
    const items = this.watchChs;
    await this.ctlOp('watch add', async () => {
      await this.ctl.dbgWatchAdd(items.map((c) => ({ offset: c.off, len: c.len, name: c.name })));
      this.watchChs = [];
    });
  }

  private async onWatchGet(handle: number): Promise<void> {
    await this.ctlOp('watch get', async () => {
      const items = await this.ctl.dbgWatchGet(handle);
      this.watchVals.set(
        handle,
        items.map((b) =>
          b.length ? [...b].map((x) => x.toString(16).padStart(2, '0')).join('') : 'stale',
        ),
      );
      this.requestUpdate();
    });
  }

  private async onTraceArm(): Promise<void> {
    await this.ctlOp('trace arm', () =>
      this.ctl.dbgTraceConf(
        this.traceChs.map((c) => ({ offset: c.off, len: c.len })),
        this.traceNoFreeze,
      ),
    );
  }

  private async onTraceRead(): Promise<void> {
    await this.ctlOp('trace read', async () => {
      const r = await this.ctl.dbgTraceRead(0n, 64);
      this.traceFrames = r.frames;
      this.traceFrameLen = r.frameLen;
      this.traceLines = r.frames.length
        ? r.frames
            .slice(0, 8)
            .map(
              (f) =>
                `#${f.seq} ${[...f.data].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`,
            )
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
    const w = 560,
      h = 120,
      pad = 4;
    const nCh = Math.min(this.traceChs.length, 8);
    const laneH = (h - pad * 2) / nCh;
    return html`<svg class="plc-trace" width=${w} height=${h}>
      ${Array.from({ length: nCh }, (_, ch) => {
        const vals = frames
          .map((f) => this.traceChannelValue(f, ch))
          .filter((v): v is number => v !== undefined);
        if (vals.length < 2) return nothing;
        let lo = Infinity,
          hi = -Infinity;
        for (const v of vals) {
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (lo === hi) {
          lo -= 1;
          hi += 1;
        }
        const y0 = pad + ch * laneH;
        const pts = vals
          .map((v, i) => {
            const x = pad + (i / (vals.length - 1)) * (w - pad * 2);
            const y = y0 + laneH - 2 - ((v - lo) / (hi - lo)) * (laneH - 4);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(' ');
        const hue = (ch * 67) % 360;
        return html`<g>
          <text x=${pad + 2} y=${y0 + 10} class="plc-trace-lbl" fill="hsl(${hue},70%,65%)"
            >${this.traceChs[ch]!.name}</text
          >
          <polyline points=${pts} fill="none" stroke="hsl(${hue},70%,60%)" stroke-width="1" />
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
                <tr>
                  <th>index</th>
                  <th>sub</th>
                  <th>name</th>
                  <th>access</th>
                  <th>value</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${entries.map((e) => {
                  const key = `${e.index}.${e.sub}`;
                  const acc = ['ro', 'rw', 'wo'][e.access] ?? '?';
                  const odTy = this.odTypes?.[key];
                  return html`<tr>
                    <td class="plc-dim">0x${e.index.toString(16).padStart(4, '0')}</td>
                    <td>${e.sub}</td>
                    <td>${e.name}</td>
                    <td>${acc}</td>
                    <td>
                      ${vals[key] !== undefined ? html`<code>${vals[key]}</code>` : '—'}
                      ${odTy !== undefined ? html`<span class="plc-dim"> ${odTypeName(odTy)}</span>` : nothing}
                      ${
                        e.access !== 0
                          ? html`<input
                              class="fbd-in plc-force-in"
                              placeholder=${odTy !== undefined ? odTypeName(odTy) : 'hex'}
                              title=${odTy !== undefined ? `write as ${odTypeName(odTy)}` : 'write as hex'}
                              .value=${this.odWriteHex[key] ?? ''}
                              @input=${(ev: Event) =>
                                (this.odWriteHex[key] = (ev.target as HTMLInputElement).value)}
                            />`
                          : nothing
                      }
                    </td>
                    <td>
                      <button class="chip-btn" @click=${() => void this.onOdRead(e)}>read</button>
                      ${
                        e.access !== 0
                          ? html`<button class="chip-btn" @click=${() => void this.onOdWrite(e)}>
                              write
                            </button>`
                          : nothing
                      }
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
      this.odTypes = { ...(this.odTypes ?? {}), [`${e.index}.${e.sub}`]: v.type };
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
    const types: Record<string, number> = {};
    for (const e of entries) {
      if (e.access === 2) continue; // write-only has nothing to read
      try {
        const v = await this.ctl.odRead(e.index, e.sub);
        vals[`${e.index}.${e.sub}`] = odDecode(v);
        raws[`${e.index}.${e.sub}`] = v.data;
        types[`${e.index}.${e.sub}`] = v.type;
      } catch {
        /* per-row read failure leaves the cell blank */
      }
    }
    this.odVals = vals;
    this.odRaw = raws;
    this.odTypes = types;
    this.requestUpdate();
  }

  private async onOdWrite(e: OdEntry): Promise<void> {
    const key = `${e.index}.${e.sub}`;
    const text = (this.odWriteHex[key] ?? '').trim();
    if (!text) {
      this.ctlErr = 'od write: empty value';
      return;
    }
    /* declared OD_T_* type wins (learned on read); write-only objects
       fall back to the length-codec/hex path */
    let bytes: Uint8Array;
    const raw = this.odRaw?.[key];
    const declaredLen = e.len || raw?.length || 0;
    const odType = this.odTypes?.[key];
    const codec = declaredLen > 0 ? defaultCodec(declaredLen) : undefined;
    try {
      if (odType !== undefined) bytes = odEncode(odType, text);
      else {
        const looksNumeric =
          /^-?[\d.]+\s*(ms|s|m|us|ns)?$/i.test(text) || /^(true|false|on|off)$/i.test(text);
        if (codec && looksNumeric) bytes = codec.encode(text);
        else bytes = parseHex(text);
      }
    } catch (err) {
      this.ctlErr = `od write: ${err instanceof Error ? err.message : err}`;
      return;
    }
    /* length check applies to fixed-width types only — for STR/BYTES
       the listed len is the *current* value size, not a capacity */
    const fixedWidth = odType === undefined || odType <= 4;
    if (fixedWidth && declaredLen && bytes.length !== declaredLen) {
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

  /** process-image layout — the package's DEPLOY_MAP section in
      bridge format: `image in=N out=M`, `in|out off= size= key=
      [pdo=] [type=] [safe=]`, `bind <at> <key>`, `safety <key>`,
      `hash <sha>`. */
  /** parse the current draft into editable channel/binding rows. */
  private openMapRows(): void {
    const draft = this.mapEdit ?? this.genMap?.text ?? this.project.deployMap ?? '';
    const m = parseDeployMap(draft);
    this.mapRows = {
      inSize: m.inSize,
      outSize: m.outSize,
      channels: m.channels.map((c) => ({ ...c })),
      bindings: m.bindings.map((b) => ({ ...b })),
    };
    this.requestUpdate();
  }

  private mapRow(k: string, v: string): void {
    const r = this.mapRows;
    if (!r) return;
    if (k === 'inSize' || k === 'outSize') {
      const n = Number(v);
      r[k] = Number.isFinite(n) && n >= 0 ? n : undefined;
      return;
    }
    /* channel field: idx:key */
    const m = /^(\d+):([\w]+)$/.exec(k);
    if (!m) return;
    const c = r.channels[Number(m[1])];
    if (!c) return;
    const f = m[2]!;
    if (f === 'dir') {
      if (v === 'in' || v === 'out') c.dir = v;
      return;
    }
    if (f === 'off' || f === 'size') {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) (c as unknown as Record<string, number>)[f] = Math.floor(n);
      return;
    }
    if (f === 'pdo' || f === 'type' || f === 'safe' || f === 'key') {
      if (v) (c as unknown as Record<string, string>)[f] = v;
      else delete (c as unknown as Record<string, string>)[f];
      if (f === 'key' && !c.pdo) c.key = v;
      if (f === 'pdo' && v) {
        delete (c as unknown as Record<string, string>).key;
        c.key = v;
      }
    }
    this.requestUpdate();
  }

  private mapBindRow(i: number, k: 'at' | 'key', v: string): void {
    const b = this.mapRows?.bindings[i];
    if (b) {
      b[k] = v;
      this.requestUpdate();
    }
  }

  private addMapChannel(): void {
    this.mapRows?.channels.push({ dir: 'in', off: 0, size: 1, key: 'ch0' });
    this.requestUpdate();
  }

  private addMapBind(): void {
    this.mapRows?.bindings.push({ at: '%IX0.0', key: 'ch0' });
    this.requestUpdate();
  }

  private delMapRow(kind: 'chan' | 'bind', i: number): void {
    if (kind === 'chan') this.mapRows?.channels.splice(i, 1);
    else this.mapRows?.bindings.splice(i, 1);
    this.requestUpdate();
  }

  /** serialize rows back into the editable map text. */
  private applyMapRows(): void {
    const r = this.mapRows;
    if (!r) return;
    this.mapEdit = serializeDeployMap({
      inSize: r.inSize,
      outSize: r.outSize,
      channels: r.channels,
      bindings: r.bindings,
      safety: [],
    });
    this.mapRows = undefined;
    this.mapViolations = undefined;
    this.requestUpdate();
  }

  /** editable channel/binding grid — the graphical deploy-map editor. */
  private mapRowsEditor(): TemplateResult {
    const r = this.mapRows!;
    const cell = (i: number, k: string, v: string | number | undefined, w = 6) =>
      html` <input
        class="plc-mapcell"
        style="width:${w}ch"
        .value=${v ?? ''}
        @change=${(e: Event) => this.mapRow(`${i}:${k}`, (e.target as HTMLInputElement).value)}
      />`;
    return html` <div class="plc-mapgrid">
      <div class="plc-mapgrid-row">
        <label
          >image in
          <input
            class="plc-mapcell"
            type="number"
            .value=${r.inSize ?? ''}
            @change=${(e: Event) => this.mapRow('inSize', (e.target as HTMLInputElement).value)}
        /></label>
        <label
          >out
          <input
            class="plc-mapcell"
            type="number"
            .value=${r.outSize ?? ''}
            @change=${(e: Event) => this.mapRow('outSize', (e.target as HTMLInputElement).value)}
        /></label>
        <button class="chip-btn" @click=${() => this.addMapChannel()}>+ channel</button>
        <button class="chip-btn" @click=${() => this.addMapBind()}>+ bind</button>
        <button class="chip-btn primary" @click=${() => this.applyMapRows()}>apply to text</button>
        <button
          class="chip-btn"
          @click=${() => {
            this.mapRows = undefined;
            this.requestUpdate();
          }}
        >
          cancel
        </button>
      </div>
      <table class="plc-table plc-mapgrid-tbl">
        <thead>
          <tr>
            <th>dir</th>
            <th>off</th>
            <th>size</th>
            <th>key/pdo</th>
            <th>type</th>
            <th>safe</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${r.channels.map(
            (c, i) =>
              html` <tr>
                <td>
                  <select
                    class="plc-mapcell"
                    .value=${c.dir}
                    @change=${(e: Event) => this.mapRow(`${i}:dir`, (e.target as HTMLSelectElement).value)}
                  >
                    <option value="in">in</option>
                    <option value="out">out</option>
                  </select>
                </td>
                <td>${cell(i, 'off', c.off)}</td>
                <td>${cell(i, 'size', c.size)}</td>
                <td>${cell(i, c.pdo ? 'pdo' : 'key', c.pdo ?? c.key, 14)}</td>
                <td>${cell(i, 'type', c.type, 8)}</td>
                <td>${cell(i, 'safe', c.safe, 8)}</td>
                <td>
                  <button class="chip-btn" @click=${() => this.delMapRow('chan', i)}>✕</button>
                </td>
              </tr>`,
          )}
        </tbody>
      </table>
      ${
        r.bindings.length
          ? html` <table class="plc-table plc-mapgrid-tbl">
              <thead>
                <tr>
                  <th>bind at</th>
                  <th>→ key</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${r.bindings.map(
                    (b, i) =>
                      html` <tr>
                        <td>
                          <input
                            class="plc-mapcell"
                            style="width:12ch"
                            .value=${b.at}
                            @change=${(e: Event) => this.mapBindRow(i, 'at', (e.target as HTMLInputElement).value)}
                          />
                        </td>
                        <td>
                          <input
                            class="plc-mapcell"
                            style="width:16ch"
                            .value=${b.key}
                            @change=${(e: Event) => this.mapBindRow(i, 'key', (e.target as HTMLInputElement).value)}
                          />
                        </td>
                        <td>
                          <button class="chip-btn" @click=${() => this.delMapRow('bind', i)}>
                            ✕
                          </button>
                        </td>
                      </tr>`,
                  )}
              </tbody>
            </table>`
          : nothing
      }
    </div>`;
  }

  private ioMapCard(): TemplateResult {
    const m = this.ioMap ?? parseDeployMap('');
    const chans = m.channels;
    const overlaps = deployMapOverlaps(chans);
    const overlapIdx = new Set(overlaps);
    const dirRows = (dir: 'in' | 'out') =>
      chans
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => c.dir === dir)
        .sort((a, b) => a.c.off - b.c.off || a.c.size - b.c.size);
    const chanRow = (dir: 'in' | 'out') => (e: { c: DeployMapChannel; i: number }) => {
      const c = e.c;
      return html`<tr class=${overlapIdx.has(e.i) ? 'plc-row-warn' : nothing}>
        <td>%${dir === 'in' ? 'I' : 'Q'}</td>
        <td>${c.off}</td>
        <td>${c.size}</td>
        <td>${c.key}</td>
        <td>${c.pdo ?? ''}</td>
        <td>${c.type ?? ''}</td>
        <td>${c.safe ?? ''}${m.safety.includes(c.key) ? ' 🔒' : ''}</td>
      </tr>`;
    };
    /* authoring state: saved override, generated draft, live edit */
    const saved = this.project.deployMap;
    const draft = this.mapEdit ?? this.genMap?.text ?? saved ?? '';
    const bindingsEx = projectIoBindingsEx(this.project);
    const atColl = atCollisions(this.project.fbd);
    const epColl = endpointCollisions(this.project.fbd);
    const stBinds = stIoBindings(this.project.stSources);
    return html`
      <h4>
        io map
        <span class="plc-dim">${chans.length ? `${chans.length} channels` : ''}</span>
        ${overlaps.length ? html`<span class="plc-warn"> ⚠ ${overlaps.length} overlap${overlaps.length > 1 ? 's' : ''}</span>` : nothing}
        ${saved ? html`<span class="plc-dim"> · saved for deploy</span>` : nothing}
      </h4>
      <div class="plc-ops">
        <button class="chip-btn" @click=${() => void this.onIoMap()}>load</button>
        <button class="chip-btn" @click=${() => void this.onGenMap()}>generate</button>
        <button class="chip-btn" ?disabled=${!draft.trim()} @click=${() => this.onValidateMap()}>
          validate
        </button>
        <button
          class="chip-btn primary"
          ?disabled=${!draft.trim()}
          @click=${() => this.onSaveMap()}
        >
          save for deploy
        </button>
        ${
          saved
            ? html`<button
                class="chip-btn"
                @click=${() => {
                  this.project.deployMap = undefined;
                  this.mapEdit = undefined;
                  this.genMap = undefined;
                  this.save();
                }}
              >
                clear
              </button>`
            : nothing
        }
      </div>
      ${
        this.genMap?.warnings.length
          ? html`<ul class="plc-od-warn">
              ${this.genMap.warnings.map((w) => html`<li>${w}</li>`)}
            </ul>`
          : nothing
      }
      ${
        this.mapViolations?.length
          ? html`<ul class="plc-od-warn">
              ${this.mapViolations.map((x) => html`<li>[${x.rule}] ${x.detail}</li>`)}
            </ul>`
          : nothing
      }
      ${
        atColl.length || epColl.length
          ? html`<ul class="plc-od-warn">
              ${atColl.map((c) => html`<li>AT ${c.at} claimed by ${c.claimants.join(', ')}</li>`)}
              ${epColl.map((c) => html`<li>PDO ${c.endpoint} claimed by ${c.claimants.join(', ')}</li>`)}
            </ul>`
          : nothing
      }
      <textarea
        class="plc-mapedit"
        rows="10"
        spellcheck="false"
        placeholder="deploy map (bridge format) — generate drafts channels + binds from project AT bindings; pdo= endpoints come from device blocks"
        .value=${draft}
        @input=${(e: Event) => {
          this.mapEdit = (e.target as HTMLTextAreaElement).value;
          this.mapViolations = undefined;
        }}
      ></textarea>
      ${
        this.mapRows
          ? this.mapRowsEditor()
          : html` <button
              class="chip-btn"
              ?disabled=${!draft.trim()}
              @click=${() => this.openMapRows()}
            >
              edit channels…
            </button>`
      }
      ${
        chans.length
          ? html` <p class="plc-dim">
                image in=${m.inSize ?? '?'}B
                out=${m.outSize ?? '?'}B${m.hash ? html` · hash ${m.hash.slice(0, 12)}…` : nothing}
                ${m.bindings.length ? html` · ${m.bindings.length} binds` : nothing}
              </p>
              <table class="plc-table">
                <thead>
                  <tr>
                    <th>dir</th>
                    <th>off</th>
                    <th>size</th>
                    <th>key</th>
                    <th>pdo</th>
                    <th>type</th>
                    <th>safe</th>
                  </tr>
                </thead>
                <tbody>
                  ${dirRows('in').map(chanRow('in'))} ${dirRows('out').map(chanRow('out'))}
                </tbody>
              </table>
              ${
                m.bindings.length
                  ? html`<details class="plc-raw">
                      <summary>binds (${m.bindings.length})</summary>
                      <table class="plc-table">
                        <tbody>
                          ${m.bindings.map(
                            (b) =>
                              html`<tr>
                                <td>${b.at}</td>
                                <td>→</td>
                                <td>${b.key}</td>
                              </tr>`,
                          )}
                        </tbody>
                      </table>
                    </details>`
                  : nothing
              }
              ${
                overlaps.length
                  ? html`<ul class="plc-od-warn">
                      ${overlaps.map((i) => {
                        const c = chans[i]!;
                        return html`<li>
                          %${c.dir === 'in' ? 'I' : 'Q'}[${c.off}..${c.off + c.size}) shared by
                          ${c.key} and
                          ${overlaps
                            .filter((j) => j !== i && rangesOverlap(chans[j]!, c))
                            .map((j) => chans[j]!.key)
                            .join(', ')}
                        </li>`;
                      })}
                    </ul>`
                  : nothing
              }`
          : html`<p class="plc-dim">
              Deploy map (bridge format) of the running package — channel image ranges, PDO
              endpoints, safe-state policy, safety keys.
            </p>`
      }
      ${(() => {
        return bindingsEx.length
          ? html`<details class="plc-raw">
              <summary>
                project bindings
                (${bindingsEx.length}${stBinds.length ? `, incl. ${stBinds.length} ST AT` : ''})
              </summary>
              <table class="plc-table">
                <tbody>
                  ${bindingsEx.map(
                    (b) =>
                      html`<tr>
                        <td>${b.name}</td>
                        <td class="plc-dim">${b.at}</td>
                        <td class="plc-dim">${b.type ?? ''}</td>
                      </tr>`,
                  )}
                </tbody>
              </table>
            </details>`
          : nothing;
      })()}
    `;
  }

  /** draft a deploy map from the project's AT bindings + device
      endpoints; lands in the editable textarea. */
  private async onGenMap(): Promise<void> {
    this.ctlErr = '';
    try {
      const r = await generateDeployMap(this.project);
      this.genMap = { text: r.text, warnings: r.warnings };
      this.mapEdit = r.text;
      this.mapViolations = validateDeployMapText(r.text);
    } catch (e) {
      this.ctlErr = `gen-map: ${e instanceof Error ? e.message : e}`;
    }
    this.requestUpdate();
  }

  private onValidateMap(): void {
    this.mapViolations = validateDeployMapText(this.mapEdit ?? '');
    this.requestUpdate();
  }

  /** persist the edited map — injected as DEPLOY_MAP at build+deploy. */
  private onSaveMap(): void {
    const text = (this.mapEdit ?? '').trim();
    if (!text) return;
    this.project.deployMap = text.endsWith('\n') ? text : text + '\n';
    this.save();
    this.flash('deploy map saved — injected on build+deploy');
  }

  private async onIoMap(): Promise<void> {
    try {
      const raw = await this.ctl.mapGet();
      this.ioMap = parseDeployMap(new TextDecoder().decode(raw));
      this.ctlErr = '';
    } catch (e) {
      this.ioMap = undefined;
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
          : html`<p class="plc-dim">
              Durable audit tail — every management and debug op with client, uid and result.
            </p>`
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
      await this.ensureLibSources();
      const r = await compileProject(this.ctl, this.project, true);
      this.diags = r.diags;
      if (!r.ok || !r.package) {
        this.flash(r.ok ? 'build ok (no package)' : `build failed: ${r.errors} error(s)`);
        return;
      }
      /* saved deploy map → DEPLOY_MAP section (0x31) via the pkgmap meta-op */
      let pkg = r.package;
      if (this.project.deployMap?.trim()) {
        this.flash('injecting deploy map…');
        pkg = await injectDeployMap(this.ctl, pkg, this.project.deployMap);
      }
      this.flash('deploying…');
      this.deployFrac = 0;
      const uuid = await this.ctl.deploy(pkg, 0, (f) => {
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
    this.evOff?.();
    this.evOff = undefined;
    this.ctl = new PlcCtl(url);
    localStorage.setItem('tether.plc.ctlUrl', url);
    this.refreshCtl();
  }

  /** /ws event subscription; coalesces refresh storms. */
  private openEvents(): void {
    if (this.evOff) return;
    this.evOff = this.ctl.events((e) => {
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
              .join(''),
          );
          o += 4 + l;
        }
        this.watchVals.set(h, vals);
        this.requestUpdate();
      }
      if (e.type === EV.USER && e.payload.length >= 20) {
        const d = new DataView(e.payload.buffer, e.payload.byteOffset);
        this.flash(
          `event #${d.getUint32(0, true)} state=${d.getUint32(4, true)} ` +
            `sev=${d.getUint32(16, true)}`,
        );
      }
      if (
        e.type === EV.PROG_TRANSITION ||
        e.type === EV.FAULT ||
        e.type === EV.DBG_BREAK ||
        e.type === EV.USER
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
      this.evOff?.();
      this.evOff = undefined;
    }
    if (this.ctlOk) {
      this.openEvents();
      /* one-shot remote hydrate: the project dir's manifest.ui is the
         persisted document — adopt it unless the user already edited
         locally this session */
      if (!this.remoteLoaded) {
        this.remoteLoaded = true;
        if (!this.localDirty) {
          void loadRemoteProject(this.ctl).then((rp) => {
            if (rp) {
              this.project = rp;
              saveProject(rp);
              this.requestUpdate();
            }
          });
        }
      }
      try {
        [
          this.prog,
          this.rt,
          this.retain,
          this.dbg,
          this.forces,
          this.breaks,
          this.trace,
          this.watches,
          this.shadow,
          this.alarms,
          this.alarmStats,
          this.alarmHist,
          this.histChans,
          this.mqttConns,
        ] = await Promise.all([
          this.ctl.progStatus().catch(() => undefined),
          this.ctl.rtStatus().catch(() => undefined),
          this.ctl.retainStatus().catch(() => undefined),
          this.ctl.dbgState().catch(() => undefined),
          this.ctl.dbgForceList().catch(() => undefined),
          this.ctl.dbgBreakList().catch(() => undefined),
          this.ctl.dbgTraceStatus().catch(() => undefined),
          this.ctl.dbgWatchList().catch(() => undefined),
          this.ctl.shadowStatus().catch(() => undefined),
          this.ctl.evlogList().catch(() => undefined),
          this.ctl.evlogStats().catch(() => undefined),
          this.ctl.evlogHistory(24).catch(() => undefined),
          this.ctl.histList().catch(() => undefined),
          this.ctl.mqttStatus().catch(() => undefined),
        ]);
        this.shadowDiffs = this.shadow?.loaded
          ? await this.ctl.shadowCompare().catch(() => undefined)
          : undefined;
        /* journal fetch only pays off while the Events pane is
           open — keep the map warm otherwise cheaply            */
        if (this.pane === 'events' && this.mqttConns?.length) {
          const conns = this.mqttConns.slice(0, 8);
          const jr = await Promise.all(
            conns.map((c) => this.ctl.mqttJournal(c.handle, 0, 64).catch(() => undefined)),
          );
          jr.forEach((j, i) => {
            const c = conns[i];
            if (j && c) this.mqttJournals.set(c.handle, j);
          });
        }
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
