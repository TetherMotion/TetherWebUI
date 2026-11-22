/**
 * tether-shell — the application chrome: status strip, workflow activity bar
 * (Configure/Program/Debug/Operate), board tabs (Operate only), slide-in
 * drawers (alarms/events), and overlays (connect/settings).
 * All machine data lives in the DataHub; this element only owns layout state.
 */
import { html, nothing, TemplateResult } from 'lit';
import { DataHub, HubTopic } from '../data/hub';
import { BOARD_FORMAT, BoardDoc, parseBoardDoc, serializeBoard, TileBinding, TileDef } from '../dash/model';
import {
  boardsFromProfile,
  ensureBuiltinBoards,
  loadBoards,
  resetBuiltinBoard,
  saveBoards,
} from '../dash/store';
import { BOARD_TEMPLATES, boardFromTemplate } from '../dash/board-templates';
import { autoBoardTiles } from '../hmi/autoscreen';
import { TILE_SPECS, TileSpec } from '../dash/registry';
import '../board/board-view';
import '../board/tile-frame';
import { ensureTileTag } from '../dash/loaders';
import type { Pane, PlcStatePayload, TetherPlcIde } from '../plc/plc-ide';
import { icon } from '../icons';
import { TileElement } from '../tiles/base';
import { buildSupportBundle } from '../domain/analysis';

type Drawer = 'alarms' | 'events' | undefined;
type Overlay = 'settings' | 'connect' | undefined;

/** Workflow activities — Configure/Program/Debug host the PLC IDE in
    section mode; Operate is the board/tile dashboards (TODO-UI-CONCEPT). */
type ShellActivity = 'configure' | 'program' | 'debug' | 'operate';
type PlcActivity = Exclude<ShellActivity, 'operate'>;

const ACTIVITIES: { id: ShellActivity; label: string; icon: string }[] = [
  { id: 'configure', label: 'Configure', icon: 'sliders-horizontal' },
  { id: 'program', label: 'Program', icon: 'square-pen' },
  { id: 'debug', label: 'Debug', icon: 'play' },
  { id: 'operate', label: 'Operate', icon: 'gauge' },
];

interface Toast {
  id: number;
  message: string;
  kind: 'error' | 'info';
}

let toastSeq = 0;

export class TetherShell extends TileElement {
  private boards: BoardDoc[] = [];
  private activeId = '';
  private activity: ShellActivity = 'program';
  /** the lazy plc-ide module — SECTIONS lives there for ⌘K section jumps. */
  private plcMod?: typeof import('../plc/plc-ide');
  /** last `plc-state` payload from the IDE — drives the strip's PLC items. */
  private plcState?: PlcStatePayload;
  private drawer?: Drawer;
  private overlay?: Overlay;
  private galleryOpen = false;
  private boardPickerOpen = false;
  private paletteOpen = false;
  private paletteQuery = '';
  private paletteIndex = 0;
  private toasts: Toast[] = [];
  private urlInput = '';
  private tokenInput = '';
  private pollInput = 1000;
  private streamInput = 10;
  private bundle?: Record<string, unknown>;
  private importInput?: HTMLInputElement;

  protected topics(): HubTopic[] {
    return ['connection', 'drives', 'catalog', 'services', 'profile', 'lease', 'operations'];
  }

  protected onHub(): void {
    this.requestUpdate();
  }

  private boardView():
    | (HTMLElement & {
        board?: BoardDoc;
        addTile?: (type: string, extra?: Partial<TileDef>, size?: { w: number; h: number }) => void;
      })
    | null {
    return this.querySelector('board-view');
  }

  /** the mounted PLC IDE — status strip + palette deep-link into it. */
  private ide(): TetherPlcIde | null {
    return this.querySelector<TetherPlcIde>('tether-plc-ide');
  }

  // ---- Lifecycle -----------------------------------------------------------------

  connectedCallback(): void {
    super.connectedCallback();
    /* the PLC IDE powers Configure/Program/Debug — register it lazily
       so the engineering chunk loads in parallel with first paint */
    void import('../plc/plc-ide').then((m) => {
      this.plcMod = m;
      this.requestUpdate();
    });
    this.boards = ensureBuiltinBoards(loadBoards());
    this.activeId = this.boards[0]?.id ?? '';
    this.rebuildBoards();
    const hub = this.hub;
    if (!hub) return;
    this.urlInput = hub.prefs.url;
    this.pollInput = hub.prefs.pollMs;
    this.streamInput = hub.prefs.streamMs;
    this.unsubHub = [
      hub.on('toast' as HubTopic, (e) => {
        const d = (e as CustomEvent<{ message: string; kind: 'error' | 'info' }>).detail;
        const toast = { id: ++toastSeq, message: d.message, kind: d.kind };
        this.toasts = [...this.toasts.slice(-4), toast];
        window.setTimeout(() => {
          this.toasts = this.toasts.filter((t) => t.id !== toast.id);
        }, 6000);
        this.requestUpdate();
      }),
    ];
    if (!hub.connected && hub.client.state === 'disconnected') void hub.connect();
    window.addEventListener('keydown', this.keyHandler);
  }

  private keyHandler = (e: KeyboardEvent): void => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      /* jump-anywhere palette — activities, sections, POUs, commands,
         signals; tile adds still require Operate (handled per-item) */
      this.paletteOpen = !this.paletteOpen;
      this.paletteQuery = '';
      this.requestUpdate();
      return;
    }
    if (e.key === 'Escape') {
      if (this.paletteOpen) {
        this.paletteOpen = false;
        this.requestUpdate();
      } else if (this.boardPickerOpen) {
        this.boardPickerOpen = false;
        this.requestUpdate();
      } else if (this.overlay) {
        this.overlay = undefined;
        this.requestUpdate();
      } else if (this.drawer) {
        this.drawer = undefined;
        this.requestUpdate();
      }
    }
  };

  private unsubHub: (() => void)[] = [];

  disconnectedCallback(): void {
    window.removeEventListener('keydown', this.keyHandler);
    this.unsubHub.forEach((u) => u());
    super.disconnectedCallback();
  }

  /** Merge persisted/user boards with profile-derived boards. */
  private rebuildBoards(): void {
    const hub = this.hub;
    const profileBoards = hub?.appProfile ? boardsFromProfile(hub.appProfile) : [];
    const userBoards = this.boards.filter((b) => b.source !== 'profile');
    this.boards = [...profileBoards, ...userBoards];
    if (!this.boards.some((b) => b.id === this.activeId)) this.activeId = this.boards[0]?.id ?? '';
    this.requestUpdate();
  }

  // ---- Board ops -------------------------------------------------------------------

  private activeBoard(): BoardDoc | undefined {
    return this.boards.find((b) => b.id === this.activeId);
  }

  private persist(): void {
    saveBoards(this.boards);
  }

  private onBoardChange(event: CustomEvent<{ board: BoardDoc }>): void {
    const board = event.detail.board;
    const idx = this.boards.findIndex((b) => b.id === board.id);
    if (idx >= 0) this.boards[idx] = board;
    this.persist();
    this.requestUpdate();
  }

  private addBoard(): void {
    /* template picker — blank is one of the cards */
    this.boardPickerOpen = true;
    this.requestUpdate();
  }

  private createBoard(templateId: string): void {
    this.boardPickerOpen = false;
    const board =
      templateId === 'auto-plc' ? this.autoPlcBoard() : boardFromTemplate(templateId);
    if (!board) return;
    if (templateId === 'blank') board.title = `Board ${this.boards.filter((b) => b.source === 'user').length + 1}`;
    this.boards.push(board);
    this.persist();
    this.activeId = board.id;
    this.editing = true;
    this.requestUpdate();
  }

  /** "Auto (PLC)" board — derive tiles from the live plc.* catalog. */
  private autoPlcBoard(): BoardDoc | undefined {
    const hub = this.hub;
    if (!hub) return undefined;
    const entries = [...hub.params, ...hub.signals].map((e) => ({
      name: e.name,
    }));
    const tiles = autoBoardTiles(entries);
    if (tiles.length <= 1) {
      hub.toast(
        'No plc.* catalog entries — deploy a PLC program first',
        'error',
      );
      return undefined;
    }
    return {
      format: BOARD_FORMAT,
      id: `user.${crypto.randomUUID().slice(0, 8)}`,
      title: 'PLC auto',
      source: 'user',
      tiles,
    };
  }

  private cloneBoard(board: BoardDoc): void {
    const clone: BoardDoc = {
      ...board,
      id: `user.${crypto.randomUUID().slice(0, 8)}`,
      title: `${board.title} (copy)`,
      source: 'user',
      profileTag: undefined,
      tiles: board.tiles.map((t) => ({ ...t, id: `t-${crypto.randomUUID().slice(0, 8)}` })),
    };
    this.boards.push(clone);
    this.persist();
    this.activeId = clone.id;
    this.editing = true;
    this.requestUpdate();
  }

  private deleteBoard(board: BoardDoc): void {
    if (board.source === 'profile') return;
    if (board.id.startsWith('builtin.')) {
      this.boards = this.boards.map((b) =>
        b.id === board.id ? (resetBuiltinBoard(board.id) ?? b) : b,
      );
    } else {
      this.boards = this.boards.filter((b) => b.id !== board.id);
    }
    this.persist();
    if (this.activeId === board.id) this.activeId = this.boards[0]?.id ?? '';
    this.requestUpdate();
  }

  private exportBoard(board: BoardDoc): void {
    const blob = new Blob([serializeBoard(board)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${board.id.replace(/[^\w.-]+/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  private async importBoard(file: File): Promise<void> {
    const doc = parseBoardDoc(await file.text());
    if (!doc) {
      this.hub?.toast('Not a valid tether.dashboard.v1 document', 'error');
      return;
    }
    const board = {
      ...doc,
      id: `user.${crypto.randomUUID().slice(0, 8)}`,
      source: 'user' as const,
    };
    this.boards.push(board);
    this.persist();
    this.activeId = board.id;
    this.editing = true;
    this.requestUpdate();
  }

  // ---- Quick add (⌘K) ---------------------------------------------------------------

  /** Jump-anywhere palette items — activities, PLC sections, POUs,
      IDE commands, watch signals, and (under Operate) signal tiles.
      Each item closes over its own action. */
  private paletteItems(): { icon: string; title: string; sub: string; run: () => void }[] {
    const items: { icon: string; title: string; sub: string; run: () => void }[] = [];
    const ide = () => this.ide();
    for (const a of ACTIVITIES)
      items.push({
        icon: a.icon,
        title: `go: ${a.label}`,
        sub: 'activity',
        run: () => {
          this.activity = a.id;
          this.requestUpdate();
        },
      });
    const sections = this.plcMod?.SECTIONS;
    if (sections)
      for (const [a, list] of Object.entries(sections)) {
        const act = a as PlcActivity;
        for (const s of list as { id: Pane; label: string }[])
          items.push({
            icon: 'list',
            title: `${act} → ${s.label}`,
            sub: 'section',
            run: () => ide()?.navigate(act, s.id),
          });
      }
    for (const p of this.plcState?.pous ?? [])
      for (const [ed, tag] of [
        ['fbd', 'FBD'],
        ['st', 'ST'],
        ['curve', 'curve'],
        ['tune', 'tune'],
      ] as const)
        items.push({
          icon: 'square-pen',
          title: `pou: ${p.name} (${tag})`,
          sub: p.kind,
          run: () => ide()?.openEditor(p.name, ed),
        });
    const cmds: [string, string][] = [
      ['check', 'compile + diagnose the project'],
      ['deploy', 'build & deploy to the target'],
      ['start', 'start the program'],
      ['stop', 'stop the program'],
      ['rollback', 'roll back the deployed program'],
      ['refresh', 'refresh runtime state'],
      ['new-program', 'new POU: program'],
      ['new-fb', 'new POU: function block'],
      ['new-fn', 'new POU: function'],
    ];
    for (const [name, hint] of cmds)
      items.push({
        icon: 'play',
        title: `cmd: ${name}`,
        sub: hint,
        run: () => ide()?.command(name),
      });
    for (const s of this.hub?.signals ?? []) {
      if (s.name.startsWith('plc.'))
        items.push({
          icon: 'binoculars',
          title: `watch: ${s.name}`,
          sub: 'signal → watch dock',
          run: () => ide()?.watchKey(s.name),
        });
      if (this.activity === 'operate')
        items.push({
          icon: 'gauge',
          title: `tile: ${s.name}`,
          sub: 'sparkline on the board',
          run: () => this.addSparkline(s.name),
        });
    }
    const q = this.paletteQuery.trim().toLowerCase();
    const hit = q
      ? items.filter(
          (i) => i.title.toLowerCase().includes(q) || i.sub.toLowerCase().includes(q),
        )
      : items;
    return hit.slice(0, 40);
  }

  private addSparkline(name: string): void {
    const binding: TileBinding = { entry: name };
    const view = this.boardView();
    view?.addTile?.('sparkline', { bindings: [binding], title: name }, { w: 6, h: 3 });
    this.editing = false;
    this.requestUpdate();
  }

  // ---- Render helpers ---------------------------------------------------------------

  private connState(): string {
    return this.hub?.client.state ?? 'disconnected';
  }

  private connLabel(): string {
    switch (this.connState()) {
      case 'connected':
        return 'connected';
      case 'connecting':
        return 'connecting…';
      case 'reconnecting':
        return this.hub?.client.unavailable
          ? 'io unavailable…'
          : 'reconnecting…';
      default:
        return 'offline';
    }
  }

  private statusStrip(): TemplateResult {
    const hub = this.hub;
    const alarms = hub?.activeAlarmCount() ?? 0;
    const age = hub?.snapshotAgeMs();
    const lease = hub?.lease
      ? `control: you (${Math.max(0, Math.round((hub.lease.expiresAtMs - Date.now()) / 1000))}s)`
      : hub?.canCommand
        ? 'control: held'
        : 'observer';
    const machine = hub?.machineDescriptor?.displayName ?? hub?.prefs.url ?? 'Tether';
    return html`<header class="status-strip">
      <span class="conn-dot ${this.connState()}"></span>
      <strong class="machine-name">${machine}</strong>
      <span class="status-item">${this.connLabel()}</span>
      <span class="status-item">${lease}</span>
      ${age !== undefined ? html`<span class="status-item">data ${Math.round(age / 100) / 10}s</span>` : nothing}
      ${this.plcStripItems()}
      ${
        alarms
          ? html`<button
              class="alarm-badge"
              @click=${() => {
                this.drawer = 'alarms';
                this.requestUpdate();
              }}
            >
              ${icon('triangle-alert')} ${alarms} alarm${alarms === 1 ? '' : 's'}
            </button>`
          : nothing
      }
      <span class="spacer"></span>
      <button
        class="icon-btn"
        title="Command palette (Ctrl/Cmd+K)"
        @click=${() => {
          this.paletteOpen = true;
          this.requestUpdate();
        }}
      >
        ${icon('command')}<span class="kbd">K</span>
      </button>
      <button class="icon-btn" title="Theme" @click=${() => this.toggleTheme()}>
        ${icon('sun-moon')}
      </button>
    </header>`;
  }

  /** PLC state items in the status strip — every item deep-links into
      the IDE at the surface that owns the fact it reports. */
  private plcStripItems(): TemplateResult | typeof nothing {
    const s = this.plcState;
    if (!s) return nothing;
    const go = (fn: (ide: TetherPlcIde) => void) => () => {
      const ide = this.ide();
      if (ide) fn(ide);
    };
    return html`
      <button
        class="status-item ghost plc-item"
        title="PLC project — Program"
        @click=${go((ide) => ide.navigate('program', 'explorer'))}
      >
        ${icon('plug-zap')} ${s.project}
      </button>
      ${
        s.runState
          ? html`<button
              class="status-item ghost plc-item plc-run-${s.runState}"
              title="program ${s.runState}${s.epoch !== undefined ? ` · epoch ${s.epoch}` : ''} — Debug → Run"
              @click=${go((ide) => ide.navigate('debug', 'run'))}
            >
              ${s.runState === 'running' ? '▶' : s.runState === 'fault' ? '⚠' : '■'}
              ${s.runState}${s.epoch !== undefined ? ` · e${s.epoch}` : ''}
            </button>`
          : nothing
      }
      ${
        s.errors
          ? html`<button
              class="status-item ghost plc-item warn"
              title="${s.errors} compile problem(s) — Problems dock"
              @click=${go((ide) => {
                ide.navigate('program', 'explorer');
                ide.openDock('problems');
              })}
            >
              ${icon('triangle-alert')} ${s.errors}
            </button>`
          : nothing
      }
      ${
        s.forces
          ? html`<button
              class="status-item ghost plc-item warn"
              title="${s.forces} forced value(s) — Debug → Watch"
              @click=${go((ide) => ide.navigate('debug', 'watch'))}
            >
              ⚡${s.forces}
            </button>`
          : nothing
      }
      ${
        s.alarms
          ? html`<button
              class="status-item ghost plc-item warn"
              title="${s.alarms} PLC alarm(s) — Debug → Events & Alarms"
              @click=${go((ide) => ide.navigate('debug', 'events'))}
            >
              ${icon('triangle-alert')} ${s.alarms}
            </button>`
          : nothing
      }
      ${this.workflowSteps()}
    `;
  }

  /** Configure → Program → Debug progress — each step lights from real
      IDE state and deep-links to the activity that owns it. */
  private workflowSteps(): TemplateResult | typeof nothing {
    const s = this.plcState;
    if (!s) return nothing;
    const go = (a: 'configure' | 'program' | 'debug', p?: string) => () => {
      this.ide()?.navigate(a, p as never);
    };
    const step = (
      label: string,
      state: 'done' | 'active' | 'todo',
      title: string,
      on: () => void,
    ) => html`
      <button
        class="status-item ghost plc-item plc-step plc-step-${state}"
        title=${title}
        @click=${on}
      >
        ${state === 'done' ? '✓' : state === 'active' ? '●' : '○'} ${label}
      </button>
    `;
    return html`<span class="plc-flow">
      ${step('Configure', 'done', `project "${s.project}" — Configure`, go('configure'))}
      <span class="plc-flow-sep">→</span>
      ${step(
        'Program',
        s.errors ? 'todo' : 'done',
        s.errors ? `${s.errors} problem(s) — Program` : 'clean compile — Program',
        go('program'),
      )}
      <span class="plc-flow-sep">→</span>
      ${step(
        'Debug',
        s.runState === 'running' ? 'active' : 'todo',
        s.runState ? `program ${s.runState} — Debug` : 'not deployed — Debug',
        go('debug', 'run'),
      )}
    </span>`;
  }

  private toggleTheme(): void {
    const root = document.documentElement;
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    localStorage.setItem('tether-theme', next);
  }

  private tabBar(): TemplateResult {
    const board = this.activeBoard();
    const editable = !!board && board.source !== 'profile';
    return html`<nav class="board-tabs">
      ${this.boards.map(
        (b) =>
          html`<button
            class="board-tab${b.id === this.activeId ? ' active' : ''}"
            @click=${() => {
              this.activeId = b.id;
              this.editing = false;
              this.galleryOpen = false;
              this.requestUpdate();
            }}
          >
            ${b.source === 'profile' ? icon('lock', 'tab-icon') : nothing}${b.title}
            ${
              b.source === 'user'
                ? html`<span
                    class="tab-x"
                    title="Delete board"
                    @click=${(e: Event) => {
                      e.stopPropagation();
                      this.deleteBoard(b);
                    }}
                    >${icon('x')}</span
                  >`
                : nothing
            }
          </button>`,
      )}
      <button class="board-tab add" title="New board" @click=${() => this.addBoard()}>
        ${icon('plus')}
      </button>
      ${
        board
          ? html`<span class="board-actions">
              ${
                board.source === 'profile'
                  ? html`<button class="chip-btn" @click=${() => this.cloneBoard(board)}>
                      Clone to editable
                    </button>`
                  : html`<button
                        class="chip-btn"
                        @click=${() => {
                          this.exportBoard(board);
                        }}
                      >
                        Export
                      </button>
                      <label class="chip-btn" title="Import board JSON">
                        Import
                        <input
                          type="file"
                          accept=".json,application/json"
                          hidden
                          @change=${(e: Event) => {
                            const f = (e.target as HTMLInputElement).files?.[0];
                            if (f) void this.importBoard(f);
                          }}
                        />
                      </label>`
              }
              ${
                board.id.startsWith('builtin.')
                  ? html`<button
                      class="chip-btn"
                      title="Restore default layout"
                      @click=${() => {
                        const fresh = resetBuiltinBoard(board.id);
                        if (fresh) {
                          this.boards = this.boards.map((b) => (b.id === board.id ? fresh : b));
                          this.persist();
                          this.requestUpdate();
                        }
                      }}
                    >
                      Reset
                    </button>`
                  : nothing
              }
              ${
                editable
                  ? html`<button
                      class="chip-btn${this.editing ? ' active' : ''}"
                      @click=${() => {
                        this.editing = !this.editing;
                        this.galleryOpen = false;
                        this.requestUpdate();
                      }}
                    >
                      ${this.editing ? html`${icon('check')} Done` : html`${icon('pencil')} Edit`}
                    </button>`
                  : nothing
              }
            </span>`
          : nothing
      }
    </nav>`;
  }

  /** Activity bar — the workflow rail. Engineering activities host the
      PLC IDE; Operate hosts the board/tile dashboards. */
  private activityBar(): TemplateResult {
    return html`<aside class="rail">
      ${ACTIVITIES.map(
        (a) =>
          html`<button
            class="rail-btn rail-act${this.activity === a.id ? ' active' : ''}"
            title=${a.label}
            @click=${() => {
              this.activity = a.id;
              this.requestUpdate();
            }}
          >
            ${icon(a.icon)}<span class="rail-act-label">${a.label}</span>
          </button>`,
      )}
      <div class="rail-sep"></div>
      <button
        class="rail-btn${this.drawer === 'alarms' ? ' active' : ''}"
        title="Alarms"
        @click=${() => {
          this.drawer = this.drawer === 'alarms' ? undefined : 'alarms';
          this.requestUpdate();
        }}
      >
        ${icon('triangle-alert')}<span
          class="rail-dot${(this.hub?.activeAlarmCount() ?? 0) ? ' on' : ''}"
        ></span>
      </button>
      <button
        class="rail-btn${this.drawer === 'events' ? ' active' : ''}"
        title="Events"
        @click=${() => {
          this.drawer = this.drawer === 'events' ? undefined : 'events';
          this.requestUpdate();
        }}
      >
        ${icon('list')}
      </button>
      <div class="spacer"></div>
      <button
        class="rail-btn"
        title="Connection settings"
        @click=${() => {
          this.overlay = this.overlay === 'connect' ? undefined : 'connect';
          this.requestUpdate();
        }}
      >
        ${icon('plug-zap')}
      </button>
    </aside>`;
  }

  private gallery(): TemplateResult | typeof nothing {
    if (!this.galleryOpen) return nothing;
    const groups = [...new Set(TILE_SPECS.map((s) => s.group))];
    return html`<aside class="gallery">
      <header class="gallery-head">
        <strong>Add tile</strong>
        <button
          class="icon-btn"
          @click=${() => {
            this.galleryOpen = false;
            this.requestUpdate();
          }}
        >
          ${icon('x')}
        </button>
      </header>
      ${groups.map(
        (group) =>
          html`<section class="gallery-group">
            <h4>${group}</h4>
            ${TILE_SPECS.filter((s) => s.group === group).map(
              (spec: TileSpec) =>
                html`<button
                  class="gallery-item"
                  title=${spec.description}
                  @click=${() => this.addGalleryTile(spec)}
                >
                  <span>${spec.label}</span>
                  <small>${spec.description}</small>
                </button>`,
            )}
          </section>`,
      )}
    </aside>`;
  }

  private addGalleryTile(spec: TileSpec): void {
    const view = this.boardView();
    view?.addTile?.(spec.type);
    this.galleryOpen = false;
    this.requestUpdate();
  }

  private drawerPanel(): TemplateResult | typeof nothing {
    if (!this.drawer) return nothing;
    return html`<aside class="drawer ${this.drawer}">
      <header class="drawer-head">
        <strong>${this.drawer === 'alarms' ? 'Alarms' : 'Events'}</strong>
        <button
          class="icon-btn"
          @click=${() => {
            this.drawer = undefined;
            this.requestUpdate();
          }}
        >
          ${icon('x')}
        </button>
      </header>
      <div class="drawer-body"></div>
    </aside>`;
  }

  private drawerSeq = 0;

  protected updated(changed: Map<string, unknown>): void {
    super.updated(changed);
    if (this.drawer) this.mountDrawerTile();
  }

  private mountDrawerTile(): void {
    const drawer = this.drawer;
    if (!drawer) return;
    const tag = drawer === 'alarms' ? 'tile-alarm-list' : 'tile-event-timeline';
    const seq = ++this.drawerSeq;
    void ensureTileTag(tag).then(() => {
      if (seq !== this.drawerSeq || this.drawer !== drawer || !this.isConnected) return;
      const body = this.querySelector<HTMLElement>('.drawer-body');
      if (!body) return;
      let el = body.querySelector(tag);
      if (!el) {
        el = document.createElement(tag) as HTMLElement & { hub?: DataHub };
        body.replaceChildren(el);
      }
      (el as { hub?: DataHub }).hub = this.hub;
    });
  }

  private overlayPanel(): TemplateResult | typeof nothing {
    if (!this.overlay) return nothing;
    if (this.overlay === 'settings') return this.settingsOverlay();
    return this.connectOverlay();
  }

  /** "New board" template picker — blank plus operator presets. */
  private boardPickerOverlay(): TemplateResult | typeof nothing {
    if (!this.boardPickerOpen) return nothing;
    return html`<div
      class="overlay"
      @click=${(e: Event) => {
        if (e.target === e.currentTarget) {
          this.boardPickerOpen = false;
          this.requestUpdate();
        }
      }}
    >
      <div class="overlay-panel narrow">
        <header class="overlay-head">
          <strong>New board</strong>
          <button
            class="icon-btn"
            @click=${() => {
              this.boardPickerOpen = false;
              this.requestUpdate();
            }}
          >
            ${icon('x')}
          </button>
        </header>
        <div class="overlay-body board-picker">
          ${BOARD_TEMPLATES.map(
            (t) => html`<button
              class="bp-card"
              @click=${() => this.createBoard(t.id)}
            >
              <strong>${t.title}</strong>
              <span>${t.description}</span>
            </button>`,
          )}
          <button
            class="bp-card"
            @click=${() => this.createBoard('auto-plc')}
          >
            <strong>Auto (PLC)</strong>
            <span>
              Generate widgets from the live plc.* catalog — profiles,
              loops, lamps and readouts bind themselves.
            </span>
          </button>
        </div>
      </div>
    </div>`;
  }

  private settingsOverlay(): TemplateResult {
    return html`<div
      class="overlay"
      @click=${(e: Event) => {
        if (e.target === e.currentTarget) {
          this.overlay = undefined;
          this.requestUpdate();
        }
      }}
    >
      <div class="overlay-panel narrow">
        <header class="overlay-head">
          <strong>Settings</strong>
          <button
            class="icon-btn"
            @click=${() => {
              this.overlay = undefined;
              this.requestUpdate();
            }}
          >
            ${icon('x')}
          </button>
        </header>
        <div class="overlay-body settings">
          <label
            >Poll interval (ms)
            <input
              type="number"
              min="100"
              step="100"
              .value=${String(this.pollInput)}
              @input=${(e: Event) => (this.pollInput = Number((e.target as HTMLInputElement).value))}
          /></label>
          <label
            >Stream interval (ms)
            <input
              type="number"
              min="1"
              step="1"
              .value=${String(this.streamInput)}
              @input=${(e: Event) => (this.streamInput = Number((e.target as HTMLInputElement).value))}
          /></label>
          <button
            class="primary"
            @click=${() => {
              const hub = this.hub;
              if (!hub) return;
              hub.prefs.pollMs = Math.max(100, this.pollInput || 1000);
              hub.prefs.streamMs = Math.max(1, this.streamInput || 10);
              hub.savePrefs();
              hub.restartPolling();
              this.overlay = undefined;
              this.requestUpdate();
            }}
          >
            Save &amp; apply
          </button>
          <hr />
          <button
            class="secondary"
            @click=${() => {
              const hub = this.hub;
              if (!hub) return;
              this.bundle = buildSupportBundle({
                url: hub.prefs.url,
                catalog: [...hub.params, ...hub.signals].map((e) => ({
                  id: e.id,
                  name: e.name,
                  kind: e.kind,
                  group: e.group,
                })),
                snapshot: {
                  machine: hub.machineSnapshot ?? null,
                  drives: [...hub.driveData.values()].map((r) => r.snapshot),
                  alarms: [...hub.alarms.values()],
                  operations: hub.operations,
                },
                events: hub.eventStore.events.slice(-50).map((e) => ({
                  severity: e.severity,
                  type: e.eventType,
                  description: e.description,
                  timestampUs: e.timestampUs,
                })),
                status: {
                  capture: hub.captureStatus,
                  config: hub.configStatus,
                },
              });
              this.requestUpdate();
            }}
          >
            Build support bundle
          </button>
          ${
            this.bundle
              ? html`<button
                  class="secondary"
                  @click=${() => {
                    const blob = new Blob([JSON.stringify(this.bundle, null, 2)], {
                      type: 'application/json',
                    });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `tether-support-${Date.now()}.json`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  Download bundle
                </button>`
              : nothing
          }
        </div>
      </div>
    </div>`;
  }

  private connectOverlay(): TemplateResult {
    return html`<div
      class="overlay"
      @click=${(e: Event) => {
        if (e.target === e.currentTarget) {
          this.overlay = undefined;
          this.requestUpdate();
        }
      }}
    >
      <div class="overlay-panel narrow">
        <header class="overlay-head">
          <strong>Connection</strong>
          <button
            class="icon-btn"
            @click=${() => {
              this.overlay = undefined;
              this.requestUpdate();
            }}
          >
            ${icon('x')}
          </button>
        </header>
        <div class="overlay-body settings">
          <label
            >Server URL
            <input
              id="conn-url"
              .value=${this.urlInput}
              placeholder="ws://host:port/tether-io"
              @input=${(e: Event) => (this.urlInput = (e.target as HTMLInputElement).value)}
          /></label>
          <label
            >Access token (not saved)
            <input
              id="conn-token"
              type="password"
              .value=${this.tokenInput}
              @input=${(e: Event) => (this.tokenInput = (e.target as HTMLInputElement).value)}
              @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && this.doConnect()}
          /></label>
          <div class="row">
            <button id="conn-connect" class="primary" @click=${() => this.doConnect()}>
              Connect
            </button>
            <button
              class="secondary"
              ?disabled=${!this.hub?.connected}
              @click=${() => this.hub?.disconnect()}
            >
              Disconnect
            </button>
          </div>
        </div>
      </div>
    </div>`;
  }

  private doConnect(): void {
    const hub = this.hub;
    if (!hub) return;
    hub.prefs.url = this.urlInput.trim();
    hub.savePrefs();
    void hub.connect(this.urlInput.trim() || undefined, this.tokenInput || undefined);
    this.tokenInput = '';
    this.overlay = undefined;
    this.requestUpdate();
  }

  private palette(): TemplateResult | typeof nothing {
    if (!this.paletteOpen) return nothing;
    const results = this.paletteItems();
    const pick = (i: number): void => {
      const r = results[i];
      if (!r) return;
      this.paletteOpen = false;
      r.run();
      this.requestUpdate();
    };
    return html`<div
      class="palette"
      @click=${(e: Event) => {
        if (e.target === e.currentTarget) {
          this.paletteOpen = false;
          this.requestUpdate();
        }
      }}
    >
      <div class="palette-box">
        <input
          placeholder="Jump anywhere — activity, section, POU, command, signal…"
          .value=${this.paletteQuery}
          @input=${(e: Event) => {
            this.paletteQuery = (e.target as HTMLInputElement).value;
            this.paletteIndex = 0;
            this.requestUpdate();
          }}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === 'Escape') {
              this.paletteOpen = false;
              this.requestUpdate();
              return;
            }
            if (e.key === 'ArrowDown')
              this.paletteIndex = Math.min(this.paletteIndex + 1, results.length - 1);
            if (e.key === 'ArrowUp') this.paletteIndex = Math.max(this.paletteIndex - 1, 0);
            if (e.key === 'Enter') {
              pick(this.paletteIndex);
              return;
            }
            this.requestUpdate();
          }}
          autofocus
        />
        <ul>
          ${results.map(
            (r, i) =>
              html`<li
                class=${i === this.paletteIndex ? 'active' : ''}
                @click=${() => pick(i)}
              >
                ${r.title} <small>${r.sub}</small>
              </li>`,
          )}
          ${!results.length ? html`<li class="empty">${this.paletteQuery ? 'No matches' : 'Type to filter — activities, sections, POUs, commands, signals'}</li>` : nothing}
        </ul>
      </div>
    </div>`;
  }

  private toastsEl(): TemplateResult | typeof nothing {
    if (!this.toasts.length) return nothing;
    return html`<div class="toasts">
      ${this.toasts.map((t) => html`<div class="toast ${t.kind}">${t.message}</div>`)}
    </div>`;
  }

  protected render(): TemplateResult {
    const board = this.activeBoard();
    const operate = this.activity === 'operate';
    return html`
      <div class="app">
        ${this.statusStrip()} ${operate ? this.tabBar() : nothing}
        <div class="body">
          ${this.activityBar()}
          <main class="content">
            ${
              operate && this.editing && board?.source !== 'profile'
                ? html`<button
                    class="gallery-fab"
                    @click=${() => {
                      this.galleryOpen = !this.galleryOpen;
                      this.requestUpdate();
                    }}
                  >
                    ${icon('plus')} Add tile
                  </button>`
                : nothing
            }
            ${
              operate
                ? html`<board-view
                    .hub=${this.hub}
                    .board=${board}
                    .editing=${this.editing}
                    @board-change=${(e: Event) => this.onBoardChange(e as CustomEvent)}
                  ></board-view>`
                : nothing
            }
            <!-- the IDE stays mounted across activity switches — its
                 project/ctl state must survive Configure→Debug hops -->
            <tether-plc-ide
              .hub=${this.hub}
              .activity=${operate ? 'program' : this.activity}
              ?hidden=${operate}
              @plc-navigate=${(e: CustomEvent<{ activity: PlcActivity }>) => {
                this.activity = e.detail.activity;
              }}
              @plc-state=${(e: CustomEvent<PlcStatePayload>) => {
                this.plcState = e.detail;
              }}
            ></tether-plc-ide>
          </main>
          ${this.gallery()} ${this.drawerPanel()}
        </div>
        ${this.overlayPanel()} ${this.boardPickerOverlay()} ${this.palette()} ${this.toastsEl()}
      </div>
    `;
  }
}

customElements.define('tether-shell', TetherShell);
