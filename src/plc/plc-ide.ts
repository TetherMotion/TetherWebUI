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
import './st-editor';
import { CtlError, DBG_CMP, DbgBreak, DbgForce, DbgState, DbgSym, DbgTraceStatus, DbgWatchEntry, EV, PlcCtl, ProgStatus, RetainStatus, RtStatus } from './ctl';
import { byteToOffset, compileProject, CompileDiag, diagsForFile } from './build';
import type { StEditor } from './st-editor';
import { IfaceKind, IfaceVar, Pou, Task } from './model';
import { entryWritable, writeScalar } from './mon';
import { exportPlcopenXml, importPlcopenXml } from './plcopen';
import type { CatalogEntry } from '../protocol';
import { exportFbdJson, importFbdJson, loadProject, PlcProject, saveProject } from './store';

type Pane = 'explorer' | 'st' | 'fbd' | 'tasks' | 'watch' | 'deploy';

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
  { id: 'tasks', label: 'Tasks' },
  { id: 'watch', label: 'Watch' },
  { id: 'deploy', label: 'Deploy' },
];

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
    deployFrac: { state: true },
    diags: { state: true },
    compiling: { state: true },
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
  declare deployFrac?: number;
  declare diags?: CompileDiag[];
  declare compiling: boolean;
  declare dbg?: DbgState;
  declare dbgSym?: DbgSym;
  declare dbgHex?: string;
  declare forces?: DbgForce[];
  declare breaks?: DbgBreak[];
  declare trace?: DbgTraceStatus;
  declare traceLines?: string[];
  declare watches?: DbgWatchEntry[];

  private ctl = new PlcCtl();
  private dbgSymName = '';
  private dbgWriteHex = '';
  private dbgMaskHex = '';
  private brkTask = '0';
  private brkCmp = '4';
  private brkVal = '';
  private brkExpr = '';
  private brkKind = '0';
  private traceChs: { name: string; off: bigint; len: number }[] = [];
  private traceNoFreeze = false;
  private watchChs: { name: string; off: bigint; len: number }[] = [];
  private watchVals = new Map<number, string[]>();
  private evSrc?: EventSource;
  private evTimer?: number;

  private project: PlcProject = loadProject();
  private unsubs: (() => void)[] = [];
  private bindingRelease?: () => void;

  constructor() {
    super();
    this.pane = 'explorer';
    this.selPou = '';
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
    this.unsubs.push(this.hub.on('values', () => this.requestUpdate()));
    this.rebind();
  }

  /** Bind every plc.* entry so the hub polls it; values land in hub.values. */
  private rebind(): void {
    this.bindingRelease?.();
    this.bindingRelease = undefined;
    const hub = this.hub;
    if (!hub) return;
    const keys = [...hub.params, ...hub.signals]
      .filter((e) => e.name.startsWith('plc.'))
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
      networks:
        kind === 'function'
          ? []
          : [
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
    const v = Number(input.value.trim());
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

  /** run `tplcc check` through the ctl proxy; results land in the diags strip. */
  private async onCheck(): Promise<void> {
    if (this.compiling) return;
    this.compiling = true;
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
        </div>
        <div class="plc-detail">${this.selPouDetail()}</div>
      </div>
    `;
  }

  private selPouDetail(): TemplateResult {
    const pou = this.project.fbd.pous.find((p) => p.id === this.selPou);
    if (!pou) return html`<p class="plc-dim">Select a POU, or create one.</p>`;
    return html`
      <h3>
        ${pou.name} <span class="plc-dim">${pou.kind}</span>
        <button class="chip-btn" @click=${() => this.onDelPou(pou)}>delete pou</button>
      </h3>
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
          <button class="chip-btn" @click=${() => this.addNetwork(pou)}>+ network</button>
        </div>
        <fbd-canvas
          .pou=${pou}
          .netIndex=${this.selNet}
          .pous=${this.project.fbd.pous}
          .values=${this.hub ? new Map(this.hub.values) : undefined}
          .diags=${this.diags}
          @change=${() => this.save()}
        ></fbd-canvas>
      </div>
    `;
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

  private addNetwork(pou: Pou): void {
    pou.networks.push({
      id: `net${pou.networks.length + 1}`,
      kind: 'fbd',
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

  private watchPane(): TemplateResult {
    const hub = this.hub;
    const entries = hub
      ? [...hub.params, ...hub.signals].filter(
          (e) => e.name.startsWith('plc.') || e.group.startsWith('plc'),
        )
      : [];
    return html`
      <div class="tile-scroll">
        <h3>Watch <span class="plc-dim">plc.* catalog entries</span></h3>
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
        ${this.dbg ? this.debugCard(this.dbg) : nothing}
        ${this.retain ? this.retainCard(this.retain) : nothing}
        ${this.rt ? html`<p class="plc-dim">rt: up ${this.rt.uptimeS}s · ${this.rt.progCount} progs (${this.rt.runningCount} running) · master ${this.rt.masterStatus} plc ${this.rt.plcStatus}</p>` : nothing}
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
          >${['stopped', 'running', 'fault'][p.state] ?? p.state} · ${p.cycles} cycles</span
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
    `;
  }

  private debugCard(d: DbgState): TemplateResult {
    const s = this.dbgSym;
    const stale = s && s.uuid !== d.uuid;
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
          placeholder="symbol name (e.g. ctu1.CV)"
          .value=${this.dbgSymName}
          @input=${(e: Event) => (this.dbgSymName = (e.target as HTMLInputElement).value)}
          @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && void this.onDbgResolve()}
        />
        <button class="chip-btn" @click=${() => void this.onDbgResolve()}>resolve</button>
        ${s
          ? html`<span class="${stale ? 'fbd-warn' : 'plc-dim'}">
                sym ${s.symIdx} kind ${s.kind} region ${s.region} access ${s.access} ·
                off ${s.offset} size ${s.size}B${stale ? ' · STALE epoch' : ''}
              </span>
              <button class="chip-btn" @click=${() => void this.onDbgRead()}>read</button>
              <input
                class="fbd-in"
                placeholder="hex (e.g. 07000000)"
                .value=${this.dbgWriteHex}
                @input=${(e: Event) =>
                  (this.dbgWriteHex = (e.target as HTMLInputElement).value)}
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
              >
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
                h${b.handle} ${b.kind ? 'cap' : 'brk'} task ${b.taskIdx}
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
      ${this.traceLines
        ? html`<code class="plc-dbg-hex">${this.traceLines.map(
            (l) => html`${l}<br />`,
          )}</code>`
        : nothing}
    `;
  }

  private async onDbgResolve(): Promise<void> {
    try {
      this.dbgSym = await this.ctl.dbgResolve(this.dbgSymName.trim());
      this.dbgHex = undefined;
      this.ctlErr = '';
    } catch (e) {
      this.dbgSym = undefined;
      this.ctlErr = `resolve: ${e instanceof CtlError ? e.message : e}`;
    }
    this.requestUpdate();
  }

  private async onDbgRead(): Promise<void> {
    const s = this.dbgSym;
    if (!s) return;
    try {
      const b = await this.ctl.dbgRead(s.offset, Math.min(s.size, 256));
      this.dbgHex = [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');
      this.ctlErr = '';
    } catch (e) {
      this.ctlErr = `read: ${e instanceof CtlError ? e.message : e}`;
    }
    this.requestUpdate();
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
    const bytes = s && this.dbgHexBytes();
    if (!s || !bytes) return;
    await this.ctlOp('dbg write', async () => {
      await this.ctl.dbgWrite(s.offset, bytes);
      await this.onDbgRead();
    });
  }

  private async onDbgForce(): Promise<void> {
    const s = this.dbgSym;
    const bytes = s && this.dbgHexBytes();
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
      this.ctlErr = 'break: integer value required';
      this.requestUpdate();
      return;
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
        items.map((c) => ({ offset: c.off, len: c.len })));
      this.watchChs = [];
    });
  }

  private async onWatchGet(handle: number): Promise<void> {
    await this.ctlOp('watch get', async () => {
      const items = await this.ctl.dbgWatchGet(handle);
      this.watchVals.set(handle, items.map(
        (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')));
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
      const r = await this.ctl.dbgTraceRead(0n, 16);
      this.traceLines = r.frames.map(
        (f) =>
          `#${f.seq} ${[...f.data]
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(' ')}`);
      if (r.frames.length === 0) this.traceLines = ['(ring empty)'];
      this.requestUpdate();
    });
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

  /** compile on the plc host and deploy the returned package directly. */
  private async onBuildDeploy(): Promise<void> {
    if (this.compiling) return;
    this.compiling = true;
    this.ctlErr = '';
    try {
      const r = await compileProject(this.ctl.url, this.project, true);
      this.diags = r.diags;
      if (!r.ok || !r.package) {
        this.flash(r.ok ? 'build ok (no package)' : `build failed: ${r.errors} error(s)`);
        return;
      }
      this.flash('deploying…');
      this.deployFrac = 0;
      const progName = await this.ctl.deploy(r.package, 0, (f) => {
        this.deployFrac = f;
      });
      this.deployFrac = undefined;
      this.flash(`deployed ${progName}`);
      await this.refreshCtl();
    } catch (e) {
      this.ctlErr = e instanceof Error ? e.message : String(e);
    } finally {
      this.compiling = false;
      this.deployFrac = undefined;
    }
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
          this.breaks, this.trace, this.watches] =
          await Promise.all([
            this.ctl.progStatus().catch(() => undefined),
            this.ctl.rtStatus().catch(() => undefined),
            this.ctl.retainStatus().catch(() => undefined),
            this.ctl.dbgState().catch(() => undefined),
            this.ctl.dbgForceList().catch(() => undefined),
            this.ctl.dbgBreakList().catch(() => undefined),
            this.ctl.dbgTraceStatus().catch(() => undefined),
            this.ctl.dbgWatchList().catch(() => undefined),
          ]);
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
