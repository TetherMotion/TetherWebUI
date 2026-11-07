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
import { FbdProject, Pou, portLabel } from './model';
import {
  emptyPlcProject,
  exportFbdJson,
  importFbdJson,
  loadProject,
  PlcProject,
  saveProject,
} from './store';

type Pane = 'explorer' | 'st' | 'fbd' | 'tasks' | 'watch' | 'deploy';

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
  };

  declare pane: Pane;
  declare selPou: string;
  declare selNet: number;
  declare status: string;

  private project: PlcProject = loadProject();
  private unsubs: (() => void)[] = [];
  private bindingRelease?: () => void;

  constructor() {
    super();
    this.pane = 'explorer';
    this.selPou = '';
    this.selNet = 0;
    this.status = '';
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

  /** Bind every plc.* signal so the hub polls it; values land in hub.values. */
  private rebind(): void {
    this.bindingRelease?.();
    this.bindingRelease = undefined;
    const hub = this.hub;
    if (!hub) return;
    const keys = hub.signals.filter((e) => e.name.startsWith('plc.')).map((e) => e.name);
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
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        this.project = importFbdJson(await file.text());
        this.selPou = this.project.fbd.pous[0]?.id ?? '';
        this.save();
        this.flash(`imported ${file.name}`);
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

  // ---- render --------------------------------------------------------

  render(): TemplateResult {
    const fbd = this.project.fbd;
    return html`
      <div class="plc-ide">
        <div class="plc-toolbar">
          <span class="plc-brand">TetherPLC</span>
          <span class="plc-proj">${fbd.project}</span>
          <span class="spacer"></span>
          <button class="chip-btn" @click=${this.onImport}>Import .fbd.json</button>
          <button class="chip-btn" @click=${this.onExport}>Export</button>
          ${this.status ? html`<span class="plc-status">${this.status}</span>` : nothing}
        </div>
        <div class="plc-nav">
          ${PANES.map(
            (p) => html`
              <button
                class="plc-nav-btn ${this.pane === p.id ? 'active' : ''}"
                @click=${() => (this.pane = p.id)}
              >
                ${p.label}
              </button>
            `,
          )}
        </div>
        <div class="plc-main">${this.paneBody()}</div>
      </div>
    `;
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
      <h3>${pou.name} <span class="plc-dim">${pou.kind}</span></h3>
      <table class="plc-table">
        <thead>
          <tr>
            <th>interface</th>
            <th>kind</th>
            <th>type</th>
            <th>init</th>
            <th>at</th>
          </tr>
        </thead>
        <tbody>
          ${pou.interface.map(
            (v) => html`
              <tr>
                <td>${v.name}</td>
                <td>${v.kind}</td>
                <td>${v.type}</td>
                <td>${v.init || ''}</td>
                <td>${v.at || ''}</td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    `;
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
                  <textarea
                    class="plc-st-editor"
                    spellcheck="false"
                    .value=${this.project.stSources[pou.name] ?? ''}
                    @input=${(e: Event) =>
                    this.onStEdit(pou, (e.target as HTMLTextAreaElement).value)}
                  ></textarea>
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
      <div class="tile-scroll plc-fbd">
        <h3>${pou.name} · net ${this.selNet + 1}${net.label ? ` — ${net.label}` : ''}</h3>
        ${net.blocks.map(
          (b) => html`
            <div class="plc-block">
              <span class="plc-kind"
                >${b.kind === 'fb' ? 'FB' : b.kind === 'operator' ? 'OP' : 'VAR'}</span
              >
              <b>${b.type_ref}</b>
              ${b.instance ? html`<span class="plc-dim">${b.instance}</span>` : nothing}
              ${b.name || ''} ${b.at ? html`<code>${b.at}</code>` : nothing}
              <span class="plc-dim">@${b.pos.x},${b.pos.y}</span>
              ${
                Object.keys(b.params).length
                  ? html`<span class="plc-dim"
                      >${Object.entries(b.params)
                        .map(([k, v]) => `${k}:=${v}`)
                        .join(' ')}</span
                    >`
                  : nothing
              }
            </div>
          `,
        )}
        ${net.wires.map(
          (w) => html`
            <div class="plc-wire">
              wire ${w.id}: b${w.src.block}${portLabel(w.src.port)} →
              ${w.dsts.map((d) => `b${d.block}${portLabel(d.port)}`).join(', ')}
              ${w.probe ? html`<span class="plc-probe">probe</span>` : nothing}
            </div>
          `,
        )}
      </div>
    `;
  }

  // ---- tasks ---------------------------------------------------------

  private tasksPane(): TemplateResult {
    const tasks = this.project.fbd.tasks;
    return html`
      <div class="tile-scroll">
        <h3>Tasks</h3>
        ${
          tasks.length
            ? html`
                <table class="plc-table">
                  <thead>
                    <tr>
                      <th>name</th>
                      <th>period</th>
                      <th>priority</th>
                      <th>programs</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${tasks.map(
                    (t) => html`
                      <tr>
                        <td>${t.name}</td>
                        <td>${t.period_ns / 1e6} ms</td>
                        <td>${t.priority}</td>
                        <td>${t.programs.join(', ')}</td>
                      </tr>
                    `,
                  )}
                  </tbody>
                </table>
              `
            : html`<p class="plc-dim">No tasks defined. Task editing lands with deploy.</p>`
        }
      </div>
    `;
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
                      </tr>
                    </thead>
                    <tbody>
                      ${entries.map(
                      (e) => html`
                        <tr>
                          <td>${e.name}</td>
                          <td>${e.kind}</td>
                          <td>${hub.values.get(e.name) ?? '—'}</td>
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
    const hub = this.hub;
    return html`
      <div class="tile-scroll">
        <h3>Deploy</h3>
        <p>
          Project: <b>${this.project.fbd.project}</b> · ${this.project.fbd.pous.length} POUs ·
          ${this.project.fbd.tasks.length} tasks
        </p>
        <p class="plc-dim">
          Deploy uses the tether-plc control channel via a WebSocket proxy that is not wired yet.
          Online change (state-preserving swap), quarantine, and rollback ops surface here once the
          proxy exists.
        </p>
        ${
          hub
            ? html`<p class="plc-dim">Machine connected — ctl ops will route through this link.</p>`
            : html`<p class="plc-dim">No machine connection.</p>`
        }
      </div>
    `;
  }
}

customElements.define('tether-plc-ide', TetherPlcIde);
