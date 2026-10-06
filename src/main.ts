/** Machine-oriented shell for the browser Tether IO client. */
import './components';
import { describeBuild } from './build-info';
import { TetherIOClient } from './client';
import {
  discoverEventService,
  EventServiceAvailability,
  MachineEvent,
  readEventCursor,
  readEventPage,
} from './domain/event-history';
import { EventStore } from './stores/event-store';
import {
  MachineDescriptorView,
  MachineDiagnosticsView,
  MachineProfileAvailability,
  MachineSnapshotView,
  discoverMachineProfile,
  readDriveSnapshot,
  readMachineDescriptor,
  readMachineDiagnostics,
  readMachineSnapshot,
} from './domain/machine-profile';
import {
  AlarmMutationStatus,
  AlarmView,
  CaptureStatusView,
  CommandReceiptView,
  CommandState,
  ConfigStatusView,
  ConfigTxnState,
  MachineAction,
  MachineActionValue,
  MachineControlClient,
  OperationView,
  SdoEntryView,
  SdoResultView,
} from './domain/machine-control';
import {
  bindHoldToRunJog,
  CommandAxisOption,
  HomingStage,
  MotionModel,
  renderAlarms,
  renderAuthorityPanel,
  renderCommandPanel,
  renderHomingPanel,
  renderOperations,
} from './views/motion';
import { CatalogEntry, FunctionEntry, StreamRow } from './protocol';
import { NavigationItem, machineShellTemplate } from './views/machine-shell';
import { DiagnosticsModel, renderDiagnostics } from './views/diagnostics';
import {
  ChecklistItemView,
  ConfigDiffView,
  ConfigEntryView,
  PdoEntryView,
  RecipeInfoView,
  SupervisorEntryView,
  SUPERVISOR_STATE_LABELS,
} from './domain/machine-control';
import {
  CommissioningModel,
  parseBaselineFile,
  parseHexBytes,
  renderCommissioning,
  serializeBaseline,
  txnStateLabel,
  writableParameters,
} from './views/commissioning';
import {
  applyDerivedOp,
  buildSupportBundle,
  decodeCaptureRecord,
  fftMagnitudes,
  splitCaptureRecords,
} from './domain/analysis';
import { DriveSnapshotRecord, renderDriveViews } from './views/drives';
import {
  AppProfile,
  findAppProfileEntry,
  readAppProfile,
  widgetSignalBindings,
} from './domain/app-profile';
import { renderPanels } from './views/panels';
import { loadVolcanoPlot, VolcanoPlotCanvas } from './vendor/volcanoplot';
import { renderRecipes } from './views/recipes';
import './style.css';

type ScopeElement = HTMLElement & {
  setChannels(channels: { name: string; color: [number, number, number] }[]): void;
  push(timestampUs: bigint, values: number[]): void;
  clear(): void;
  togglePause(): boolean;
  isPaused(): boolean;
  resetView(): void;
};

type ViewId =
  | 'overview'
  | 'drives'
  | 'motion'
  | 'trends'
  | 'alarms'
  | 'diagnostics'
  | 'commissioning'
  | 'recipes'
  | 'panels'
  | 'explore'
  | 'settings';
type CatalogTab = 'all' | 'signals' | 'params' | 'functions';

const views: NavigationItem[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'drives', label: 'Drives' },
  { id: 'motion', label: 'Motion' },
  { id: 'trends', label: 'Trends' },
  { id: 'alarms', label: 'Alarms & events' },
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'commissioning', label: 'Commissioning' },
  { id: 'recipes', label: 'Recipes' },
  { id: 'panels', label: 'Panels' },
  { id: 'explore', label: 'Explore' },
  { id: 'settings', label: 'Settings' },
];
function escapeHtml(text: string): string {
  const element = document.createElement('span');
  element.textContent = text;
  return element.innerHTML;
}

function formatStat(value: number): string {
  return Number.isFinite(value) ? value.toPrecision(4) : '—';
}

const colors: [number, number, number][] = [
  [0, 0.45, 0.75],
  [0.85, 0.33, 0.1],
  [0, 0.62, 0.45],
  [0.8, 0.1, 0.2],
  [0.58, 0.4, 0.74],
  [0.91, 0.59, 0.09],
  [0.75, 0.31, 0.5],
  [0.4, 0.4, 0.4],
];
class TetherApp extends HTMLElement {
  private readonly client = new TetherIOClient();
  private params: CatalogEntry[] = [];
  private signals: CatalogEntry[] = [];
  private functions: FunctionEntry[] = [];
  private eventService: EventServiceAvailability = { available: false };
  private readonly eventStore = new EventStore(200);
  private profile: MachineProfileAvailability = {
    profile: 'unavailable',
    descriptor: false,
    machineSnapshot: false,
    driveSnapshots: [],
    controlsAvailable: false,
    explanation: 'Connect to a V6 server to discover available typed machine services.',
  };
  private readonly driveData = new Map<bigint, DriveSnapshotRecord>();
  private machineDescriptor?: MachineDescriptorView;
  private machineSnapshot?: MachineSnapshotView;
  private machineSnapshotReceivedAt?: number;
  private machineDiagnostics?: MachineDiagnosticsView;
  private pdoEntries?: PdoEntryView[];
  private supervisorEntries?: SupervisorEntryView[];
  private supervisorResultText?: string;
  private control?: MachineControlClient;
  private lease?: { scope: string; token: bigint; expiresAtMs: number };
  private lastReceipt?: CommandReceiptView;
  private operations: OperationView[] = [];
  private readonly alarms = new Map<bigint, AlarmView>();
  private alarmCursor = 0n;
  private captureStatus?: CaptureStatusView;
  private configStatus?: ConfigStatusView;
  private sdoSlave = 0;
  /**
   * Explicit-index transfer form values. The commissioning view re-renders
   * whenever a config/SDO call settles, so anything typed into the form must
   * survive that — otherwise an in-flight refresh silently clears the input.
   */
  private readonly sdoForm = { index: '', subindex: '', data: '', maxBytes: '256' };
  private sdoEntries?: SdoEntryView[];
  private sdoResult?: SdoResultView;
  private sdoPendingWrite?: CommissioningModel['sdoPendingWrite'];
  /**
   * Command-target ticks. The motion view rebuilds its checkboxes on every
   * poll, so the selection has to live here or the operator's ticks vanish
   * mid-task (and `Submit` silently finds no target).
   */
  private readonly selectedTargets = new Set<string>();
  /** Axes currently being jogged by this session: stableId → direction. */
  private readonly heldJogs = new Map<string, number>();
  /** Guided-homing progress per axis (local UI state; server validates). */
  private readonly homingStages = new Map<string, HomingStage>();
  private controlBusy = false;
  private streamLayout: { id: bigint }[] = [];
  private streamActive = false;
  /** Channel sets per scope, as indices into streamLayout. */
  private readonly scopeChannelIndex = new WeakMap<ScopeElement, number[]>();
  private exploreSelection: bigint[] = [];
  private trendSelections: [bigint[], bigint[]] = [[], []];
  /** Per-pane derived-channel op appended as a virtual trace. */
  private paneDerivedOps: ['' | 'diff' | 'sum' | 'abs', '' | 'diff' | 'sum' | 'abs'] = ['', ''];
  /** Recent rows per scope (for FFT + cursor stats), capped at 4096. */
  private readonly scopeHistory = new WeakMap<ScopeElement, number[][]>();
  private prefs = { url: '', pollMs: 1000, streamMs: 10 };
  private polling = false;
  private pollingEvents = false;
  private trendPlot?: VolcanoPlotCanvas;
  private drivePollTimer?: number;
  private activeView: ViewId = 'overview';

  connectedCallback(): void {
    const savedTheme = localStorage.getItem('tether-theme');
    document.documentElement.dataset.theme = savedTheme === 'dark' ? 'dark' : 'light';
    this.renderShell();
    this.bindEvents();
    void this.connect();
  }

  disconnectedCallback(): void {
    if (this.drivePollTimer !== undefined) window.clearInterval(this.drivePollTimer);
    this.client.disconnect();
  }

  private renderShell(): void {
    this.innerHTML = machineShellTemplate(views);
    const url = this.querySelector<HTMLInputElement>('#url');
    this.loadPrefs();
    if (url) {
      url.value =
        this.prefs.url ||
        `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/tether-io`;
    }
    this.renderPage();
  }

  private bindEvents(): void {
    this.querySelector<HTMLButtonElement>('#connect')?.addEventListener(
      'click',
      () => void this.connect(),
    );
    this.querySelector<HTMLButtonElement>('#theme-toggle')?.addEventListener('click', () =>
      this.toggleTheme(),
    );
    this.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) =>
      button.addEventListener('click', () => {
        const view = button.dataset.view as ViewId | undefined;
        if (view) this.openView(view);
      }),
    );
    this.querySelectorAll<HTMLButtonElement>('[data-open-view]').forEach((button) =>
      button.addEventListener('click', () => this.openView('drives')),
    );
    this.querySelectorAll<HTMLButtonElement>('.tab').forEach((button) =>
      button.addEventListener('click', () =>
        this.switchCatalogTab(button.dataset.tab as CatalogTab),
      ),
    );
    this.querySelector('tether-catalog')?.addEventListener(
      'selection-change',
      () => void this.onSelectionChange(),
    );
    this.querySelector<HTMLButtonElement>('#pause-btn')?.addEventListener('click', () =>
      this.toggleScopePause(),
    );
    this.querySelector<HTMLButtonElement>('#reset-zoom-btn')?.addEventListener('click', () =>
      this.querySelector<ScopeElement>('#scope')?.resetView(),
    );
    this.client.addEventListener('connected', () => {
      this.setStatus('Connected · V6 schemas verified', true);
      this.querySelector('#role-label')!.textContent = 'Role: unverified';
      this.querySelector('#freshness-label')!.textContent = 'Data: waiting for snapshots';
    });
    this.client.addEventListener('resynchronized', () => {
      // A reconnect re-negotiated the schema epoch. Reload catalogs and
      // profile state before resuming polls; prior snapshot data was
      // marked stale on disconnect.
      void this.loadCatalogs().then(() => {
        this.control = new MachineControlClient(this.client, this.functions);
        return this.refreshProfile();
      });
      this.showToast('Reconnected · catalogs re-synchronized', 'info');
    });
    this.client.addEventListener('reconnecting', (event: Event) => {
      const { attempt, delayMs } = (event as CustomEvent<{ attempt: number; delayMs: number }>)
        .detail;
      this.setStatus(`Reconnecting (attempt ${attempt}, in ${Math.round(delayMs)} ms)`, false);
    });
    this.client.addEventListener('stale', () => {
      this.querySelector('#freshness-label')!.textContent = 'Data: stale / connection lost';
      this.driveData.clear();
      this.invalidateStream();
    });
    this.client.addEventListener('disconnected', () => {
      this.setStatus('Disconnected', false);
      this.querySelector('#freshness-label')!.textContent = 'Data: stale / connection lost';
      this.invalidateStream();
      // The server releases leases and cancels operations on session end.
      this.lease = undefined;
      this.heldJogs.clear();
      this.homingStages.clear();
      this.querySelector('#authority-label')!.textContent = 'Control owner: none';
      this.renderDriveViews();
    });
    this.client.addEventListener('catalog-changed', () => {
      this.profile = discoverMachineProfile(undefined, [], []);
      this.control = undefined;
      this.lease = undefined;
      this.alarms.clear();
      this.alarmCursor = 0n;
      this.operations = [];
      this.captureStatus = undefined;
      this.configStatus = undefined;
      this.sdoEntries = undefined;
      this.sdoResult = undefined;
      this.sdoPendingWrite = undefined;
      this.sdoForm.index = '';
      this.sdoForm.subindex = '';
      this.sdoForm.data = '';
      this.sdoForm.maxBytes = '256';
      this.selectedTargets.clear();
      this.heldJogs.clear();
      this.homingStages.clear();
      this.eventService = { available: false };
      this.eventStore.reset();
      this.driveData.clear();
      this.machineDescriptor = undefined;
      this.machineSnapshot = undefined;
      this.machineDiagnostics = undefined;
      this.pdoEntries = undefined;
      this.supervisorEntries = undefined;
      this.supervisorResultText = undefined;
      this.baselineEntries = undefined;
      this.baselineDiff = undefined;
      this.baselineResultText = undefined;
      this.checklistItems = undefined;
      this.checklistResultText = undefined;
      this.appProfile = undefined;
      this.appProfileEntry = undefined;
      this.panelValues.clear();
      this.panelHistory.clear();
      this.panelUnresolved = [];
      this.recipes = undefined;
      this.recipeResultText = undefined;
      this.machineSnapshotReceivedAt = undefined;
      this.setStatus('Schema changed · reconnect required', false);
      this.querySelector('#freshness-label')!.textContent = 'Data: invalidated';
      this.renderMachineSummary();
      this.showToast(
        'The schema epoch changed. Data was invalidated; reconnect to renegotiate before reading again.',
        'error',
      );
    });
    this.client.addEventListener('error-message', (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      this.showToast(detail.message ?? 'Protocol error', 'error');
    });
    this.client.addEventListener('stream', (event: Event) =>
      this.onStream((event as CustomEvent<StreamRow>).detail),
    );
    // Motion view actions — delegated so re-rendering the panels keeps the bindings.
    this.querySelector('#motion-page')?.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest('button');
      if (!button) return;
      const authorityAction = button.dataset.authority;
      const homeAxis = button.dataset.homeAxis;
      if (authorityAction) void this.onAuthorityAction(authorityAction);
      else if (homeAxis) void this.onHomingAction(homeAxis, button.dataset.homeStep ?? 'prepare');
      else if (button.id === 'command-submit') void this.onCommandSubmit();
      else if (button.id === 'operations-refresh') void this.pollOperations();
    });
    this.querySelector('#alarm-table-body')?.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest('button');
      if (!button) return;
      const ack = button.dataset.alarmAck;
      const clear = button.dataset.alarmClear;
      if (ack) void this.onAlarmMutation(BigInt(ack), false);
      else if (clear) void this.onAlarmMutation(BigInt(clear), true);
    });
    // Commissioning view — delegated like the motion view.
    this.querySelector('#diagnostics-page')?.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest('button');
      if (!button) return;
      const retry = button.dataset.supervisorRetry;
      if (retry !== undefined) void this.onSupervisorRetry(Number(retry));
    });
    this.querySelector('#commissioning-page')?.addEventListener('submit', (event) => {
      event.preventDefault();
      if ((event.target as HTMLElement).id === 'capture-form') void this.onCaptureSubmit();
      if ((event.target as HTMLElement).id === 'config-stage-form') void this.onConfigStage();
    });
    this.querySelector('#commissioning-page')?.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest('button');
      if (!button || button.type === 'submit') return;
      if (button.id === 'config-validate') void this.onConfigVerb('validate');
      else if (button.id === 'config-commit') void this.onConfigVerb('commit');
      else if (button.id === 'config-rollback') void this.onConfigVerb('rollback');
      else if (button.id === 'config-refresh') void this.refreshCommissioning();
      else if (button.id === 'capture-cancel') void this.onCaptureCancel();
      else if (button.id === 'capture-export') void this.onCaptureExport();
      else if (button.id === 'sdo-list') void this.onSdoList();
      else if (button.id === 'sdo-read') void this.onSdoTransfer();
      else if (button.id === 'sdo-write') void this.onSdoPreviewWrite();
      else if (button.id === 'sdo-confirm') void this.onSdoConfirmWrite();
      else if (button.id === 'sdo-cancel') {
        this.sdoPendingWrite = undefined;
        this.renderCommissioningView();
      } else if (button.id === 'baseline-export') void this.onBaselineExport();
      else if (button.id === 'baseline-diff') void this.onBaselineDiff();
      else if (button.id === 'baseline-import') void this.onBaselineImport();
      else if (button.id === 'checklist-refresh') void this.onChecklistList();
      else if (button.id === 'checklist-report') void this.onChecklistReport();
    });
    // Recipes page: load list + delegated apply buttons.
    this.querySelector('#recipes-page')?.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest('button');
      if (!button || button.disabled) return;
      if (button.id === 'recipes-refresh') void this.onRecipesLoad();
      else if (button.classList.contains('recipe-apply') && button.dataset.recipe)
        void this.onRecipeApply(button.dataset.recipe);
    });
    // Baseline file picker fires 'change', not 'click'.
    this.querySelector('#commissioning-page')?.addEventListener('change', (event) => {
      const input = event.target as HTMLInputElement;
      if (input.id === 'baseline-file' && input.files?.length) this.onBaselineFile(input.files[0]!);
    });
    // Command targets are ticked checkboxes rebuilt on every poll — record
    // the selection in state so a re-render cannot drop it.
    this.querySelector('#motion-page')?.addEventListener('change', (event) => {
      const input = event.target as HTMLInputElement;
      const target = input.dataset?.target;
      if (!target) return;
      if (input.checked) this.selectedTargets.add(target);
      else this.selectedTargets.delete(target);
    });
    // Hold-to-run jog: press starts a bounded JogStart; release/blur/
    // visibility-loss sends JogStop. Pointer capture keeps the release event
    // on the button even if the pointer leaves it.
    bindHoldToRunJog(this, {
      start: (axis, direction) => void this.startJog(axis, direction),
      stop: (axis) => void this.stopJog(axis),
      stopAll: () => void this.stopAllJogs(),
    });
    // Declarative-panel controls — delegated so re-rendering keeps bindings.
    this.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const command = target.closest<HTMLButtonElement>('[data-widget-cmd-action]');
      if (command && !command.disabled) {
        void this.onPanelCommand(
          Number(command.dataset.widgetCmdAction),
          command.dataset.widgetCmdAxis!,
        );
        return;
      }
      const fn = target.closest<HTMLButtonElement>('[data-widget-fn]');
      if (fn && !fn.disabled) void this.onPanelFunction(fn.dataset.widgetFn!);
    });
    // Trends panes — each select owns an independent channel set.
    for (const pane of [0, 1] as const) {
      this.querySelector<HTMLSelectElement>(`#trend-select-${pane}`)?.addEventListener(
        'change',
        (event) => {
          this.trendSelections[pane] = [...(event.target as HTMLSelectElement).selectedOptions].map(
            (option) => BigInt(option.value),
          );
          void this.reconfigureStream();
        },
      );
      // Channel search: rebuild the option list filtered by name/group/unit.
      this.querySelector<HTMLInputElement>(`#trend-search-${pane}`)?.addEventListener(
        'input',
        (event) => this.filterTrendOptions(pane, (event.target as HTMLInputElement).value),
      );
      this.querySelector<HTMLSelectElement>(`#trend-preset-${pane}`)?.addEventListener(
        'change',
        (event) => {
          this.applyTrendPreset(pane, (event.target as HTMLSelectElement).value);
          (event.target as HTMLSelectElement).value = '';
        },
      );
      this.querySelector<HTMLButtonElement>(`.trend-freeze[data-pane="${pane}"]`)?.addEventListener(
        'click',
        (event) => {
          const scope = this.querySelector<ScopeElement>(`#trend-scope-${pane}`);
          if (!scope) return;
          (event.target as HTMLButtonElement).textContent = scope.togglePause()
            ? 'Resume'
            : 'Freeze';
        },
      );
      // Derived channel (A−B / Σ / |A|) and FFT of the retained history.
      this.querySelector<HTMLSelectElement>(`#trend-derive-${pane}`)?.addEventListener(
        'change',
        (event) => {
          this.paneDerivedOps[pane] = (event.target as HTMLSelectElement).value as
            '' | 'diff' | 'sum' | 'abs';
          void this.reconfigureStream();
        },
      );
      this.querySelector<HTMLButtonElement>(`.trend-fft[data-pane="${pane}"]`)?.addEventListener(
        'click',
        () => void this.renderFft(pane),
      );
    }
    this.querySelector('#trend-plot-close')?.addEventListener('click', () => {
      this.trendPlot?.destroy();
      this.trendPlot = undefined;
      const overlay = this.querySelector<HTMLElement>('#trend-plot-overlay');
      if (overlay) overlay.hidden = true;
    });
    // Synchronized freeze: pauses both panes at the same instant so their
    // time windows remain comparable.
    this.querySelector('#trend-freeze-all')?.addEventListener('click', () => {
      for (const pane of [0, 1] as const) {
        const scope = this.querySelector<ScopeElement>(`#trend-scope-${pane}`);
        if (scope && !scope.isPaused()) {
          scope.togglePause();
          const button = this.querySelector<HTMLButtonElement>(
            `.trend-freeze[data-pane="${pane}"]`,
          );
          if (button) button.textContent = 'Resume';
        }
      }
      const explore = this.querySelector<ScopeElement>('#scope');
      if (explore && !explore.isPaused()) this.toggleScopePause();
      const freezeAll = this.querySelector<HTMLElement>('#trend-freeze-all');
      const resumeAll = this.querySelector<HTMLElement>('#trend-resume-all');
      if (freezeAll) freezeAll.hidden = true;
      if (resumeAll) resumeAll.hidden = false;
    });
    this.querySelector('#trend-resume-all')?.addEventListener('click', () => {
      for (const pane of [0, 1] as const) {
        const scope = this.querySelector<ScopeElement>(`#trend-scope-${pane}`);
        if (scope?.isPaused()) {
          scope.togglePause();
          const button = this.querySelector<HTMLButtonElement>(
            `.trend-freeze[data-pane="${pane}"]`,
          );
          if (button) button.textContent = 'Freeze';
        }
      }
      const explore = this.querySelector<ScopeElement>('#scope');
      if (explore?.isPaused()) this.toggleScopePause();
      const freezeAll = this.querySelector<HTMLElement>('#trend-freeze-all');
      const resumeAll = this.querySelector<HTMLElement>('#trend-resume-all');
      if (freezeAll) freezeAll.hidden = false;
      if (resumeAll) resumeAll.hidden = true;
    });
    // Named layouts: persist pane selections per origin; missing signal ids
    // are reported rather than silently dropped (resource-ID migration check).
    this.querySelector('#layout-save')?.addEventListener('click', () => {
      const name = this.querySelector<HTMLInputElement>('#layout-name')?.value.trim();
      if (!name) return;
      const layouts = this.loadLayouts();
      layouts[name] = {
        version: 2,
        panes: this.trendSelections.map((ids) => ids.map((id) => id.toString())),
        explore: this.exploreSelection.map((id) => id.toString()),
        derived: [...this.paneDerivedOps],
      };
      localStorage.setItem('tether.layouts', JSON.stringify(layouts));
      this.populateLayoutPicker();
      this.showToast(`Layout "${name}" saved`, 'info');
    });
    this.querySelector('#layout-delete')?.addEventListener('click', () => {
      const name = this.querySelector<HTMLSelectElement>('#layout-select')?.value;
      if (!name) return;
      const layouts = this.loadLayouts();
      delete layouts[name];
      localStorage.setItem('tether.layouts', JSON.stringify(layouts));
      this.populateLayoutPicker();
    });
    this.querySelector<HTMLSelectElement>('#layout-select')?.addEventListener('change', (event) => {
      const name = (event.target as HTMLSelectElement).value;
      const layout = this.loadLayouts()[name];
      if (!layout) return;
      const known = new Set(this.signals.map((s) => s.id.toString()));
      const resolve = (ids: string[]) => ids.filter((id) => known.has(id)).map((id) => BigInt(id));
      const missing = [...layout.panes.flat(), ...layout.explore].filter((id) => !known.has(id));
      this.trendSelections = [resolve(layout.panes[0] ?? []), resolve(layout.panes[1] ?? [])];
      this.exploreSelection = resolve(layout.explore);
      // v2 layouts also restore the per-pane derived channel.
      const derived = layout.derived ?? ['', ''];
      for (const pane of [0, 1] as const) {
        this.paneDerivedOps[pane] = derived[pane] ?? '';
        const select = this.querySelector<HTMLSelectElement>(`#trend-derive-${pane}`);
        if (select) select.value = this.paneDerivedOps[pane];
      }
      this.populateTrendPickers();
      void this.reconfigureStream();
      if (missing.length)
        this.showToast(
          `Layout "${name}": ${missing.length} signal id(s) no longer exist and were dropped`,
          'error',
        );
    });
    // Capture replay: decode an exported .bin via the server's record layout
    // and load it paused into pane A.
    this.querySelector<HTMLInputElement>('#capture-replay-file')?.addEventListener(
      'change',
      (event) => void this.replayCapture(event.target as HTMLInputElement),
    );
    this.querySelector('#support-bundle')?.addEventListener('click', () => {
      const bundle = buildSupportBundle({
        url: this.querySelector<HTMLInputElement>('#connect-url')?.value,
        catalog: [...this.params, ...this.signals].map((entry) => ({
          id: entry.id,
          name: entry.name,
          kind: entry.kind,
          group: entry.group,
        })),
        events: this.eventStore.events.map((event) => ({
          severity: event.severity,
          type: event.eventType,
          description: event.description,
          timestampUs: event.timestampUs,
        })),
        status: { capture: this.captureStatus, config: this.configStatus },
      });
      const blob = new Blob([JSON.stringify(bundle, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `tether-support-${Date.now()}.json`;
      link.click();
      URL.revokeObjectURL(url);
      this.showToast('Support bundle downloaded (redacted)', 'info');
    });
    // Settings persistence.
    this.querySelector('#settings-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.savePrefs();
    });
    this.querySelector('#settings-reset')?.addEventListener('click', () => {
      localStorage.removeItem('tether.prefs');
      this.loadPrefs(true);
      this.populateSettingsForm();
      this.showToast('Preferences reset', 'info');
    });
  }

  // ---- Local preferences (browser-local; tokens are never stored) ---------

  private loadPrefs(overrides = false): void {
    const defaults = { url: '', pollMs: 1000, streamMs: 10 };
    try {
      const raw = localStorage.getItem('tether.prefs');
      const parsed = raw ? (JSON.parse(raw) as Partial<typeof defaults>) : {};
      this.prefs = {
        url: typeof parsed.url === 'string' ? parsed.url : defaults.url,
        pollMs: Math.min(60000, Math.max(200, Number(parsed.pollMs) || defaults.pollMs)),
        streamMs: Math.min(10000, Math.max(1, Number(parsed.streamMs) || defaults.streamMs)),
      };
    } catch {
      this.prefs = defaults;
    }
    if (overrides) this.prefs = defaults;
  }

  private savePrefs(): void {
    this.prefs.url = this.querySelector<HTMLInputElement>('#settings-url')?.value.trim() ?? '';
    this.prefs.pollMs = Math.min(
      60000,
      Math.max(
        200,
        Number(this.querySelector<HTMLInputElement>('#settings-poll-ms')?.value) || 1000,
      ),
    );
    this.prefs.streamMs = Math.min(
      10000,
      Math.max(1, Number(this.querySelector<HTMLInputElement>('#settings-stream-ms')?.value) || 10),
    );
    try {
      localStorage.setItem('tether.prefs', JSON.stringify(this.prefs));
    } catch {
      /* storage unavailable — session-only prefs */
    }
    const urlInput = this.querySelector<HTMLInputElement>('#url');
    if (urlInput && this.prefs.url) urlInput.value = this.prefs.url;
    // Apply the poll interval to a live timer.
    if (this.drivePollTimer !== undefined) {
      window.clearInterval(this.drivePollTimer);
      this.drivePollTimer = window.setInterval(() => {
        void this.pollDrives();
        void this.pollEvents();
        void this.pollAlarms();
        void this.pollOperations();
        void this.pollPanels();
        this.refreshLeaseState();
      }, this.prefs.pollMs);
    }
    this.showToast('Preferences saved', 'info');
  }

  private populateSettingsForm(): void {
    const url = this.querySelector<HTMLInputElement>('#settings-url');
    if (url) url.value = this.prefs.url;
    const poll = this.querySelector<HTMLInputElement>('#settings-poll-ms');
    if (poll) poll.value = String(this.prefs.pollMs);
    const stream = this.querySelector<HTMLInputElement>('#settings-stream-ms');
    if (stream) stream.value = String(this.prefs.streamMs);
    const buildInfo = this.querySelector('#build-info');
    if (buildInfo) buildInfo.textContent = `Dashboard build: ${describeBuild()}`;
  }

  private async connect(): Promise<void> {
    let url = this.querySelector<HTMLInputElement>('#url')?.value ?? '';
    // Browser WebSocket cannot set Authorization; the controller accepts the
    // credential as a `token` query parameter over TLS/loopback instead.
    const token = this.querySelector<HTMLInputElement>('#auth-token')?.value ?? '';
    if (token) url += `${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
    this.setStatus('Connecting…', false);
    try {
      await this.client.connect(url, { enabled: true });
      await this.loadCatalogs();
      this.control = new MachineControlClient(this.client, this.functions);
      await this.refreshProfile();
      if (this.drivePollTimer !== undefined) window.clearInterval(this.drivePollTimer);
      this.drivePollTimer = window.setInterval(() => {
        void this.pollDrives();
        void this.pollEvents();
        void this.pollAlarms();
        void this.pollOperations();
        void this.pollPanels();
        this.refreshLeaseState();
      }, this.prefs.pollMs);
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : 'Connection failed', false);
      this.showToast(error instanceof Error ? error.message : 'Connection failed', 'error');
    }
  }

  private async loadCatalogs(): Promise<void> {
    [this.params, this.signals, this.functions] = await Promise.all([
      this.client.list('params'),
      this.client.list('signals'),
      this.client.listFunctions(),
    ]);
    await this.loadEntryMetadata([...this.params, ...this.signals]);
    await this.loadAppProfile();
    this.renderCatalog([...this.params, ...this.signals]);
    const functionList = this.querySelector<HTMLElement & { items: FunctionEntry[] }>('#functions');
    if (functionList) functionList.items = this.functions;
    this.populateTrendPickers();
    this.populateLayoutPicker();
  }

  /** Fill the trend pane selects with the fixed-size signals. */
  private populateTrendPickers(): void {
    for (const pane of [0, 1] as const) {
      const select = this.querySelector<HTMLSelectElement>(`#trend-select-${pane}`);
      const search = this.querySelector<HTMLInputElement>(`#trend-search-${pane}`);
      if (select) this.renderTrendOptions(select, search?.value ?? '');
    }
  }

  /** Rebuild a pane's option list, filtered by a name/group/unit substring. */
  private filterTrendOptions(pane: 0 | 1, filter: string): void {
    const select = this.querySelector<HTMLSelectElement>(`#trend-select-${pane}`);
    if (select) this.renderTrendOptions(select, filter);
  }

  private renderTrendOptions(select: HTMLSelectElement, filter: string): void {
    const selected = new Set(
      this.trendSelections[TetherApp.paneOf(select)].map((id) => id.toString()),
    );
    const needle = filter.trim().toLowerCase();
    const matches = (s: CatalogEntry) =>
      !needle ||
      s.name.toLowerCase().includes(needle) ||
      s.group.toLowerCase().includes(needle) ||
      (s.metadata?.unit ?? '').toLowerCase().includes(needle);
    select.innerHTML = this.signals
      .filter(matches)
      .map(
        (s) =>
          `<option value="${s.id.toString()}"${selected.has(s.id.toString()) ? ' selected' : ''}>${escapeHtml(s.name)}${s.metadata?.unit ? ` [${escapeHtml(s.metadata.unit)}]` : ''}</option>`,
      )
      .join('');
  }

  /** Apply a named channel preset to a pane's selection. */
  private applyTrendPreset(pane: 0 | 1, preset: string): void {
    const patterns: Record<string, RegExp> = {
      motion: /position|velocity|torque|target|actual/i,
      error: /following.?error|error|deviation/i,
      network: /wkc|working.?counter|dc|distributed.?clock|link|al.?state/i,
    };
    const pattern = patterns[preset];
    if (!pattern) return;
    this.trendSelections[pane] = this.signals
      .filter((s) => pattern.test(s.name) || pattern.test(s.group))
      .map((s) => s.id);
    const select = this.querySelector<HTMLSelectElement>(`#trend-select-${pane}`);
    const search = this.querySelector<HTMLInputElement>(`#trend-search-${pane}`);
    if (select) this.renderTrendOptions(select, search?.value ?? '');
    void this.reconfigureStream();
  }

  private static paneOf(select: HTMLSelectElement): 0 | 1 {
    return select.id.endsWith('-1') ? 1 : 0;
  }

  // ---- Named layouts, FFT, replay, annotations -------------------------------

  /**
   * Saved trend layouts keyed by name.  v1 entries (`{panes, explore}`) are
   * still accepted — the missing `derived` field defaults to none.  Signal
   * IDs are stored as stable resource IDs (strings), so a machine catalog
   * change is detected on load and reported rather than silently dropped.
   */
  private loadLayouts(): Record<
    string,
    {
      version?: number;
      panes: string[][];
      explore: string[];
      derived?: ['' | 'diff' | 'sum' | 'abs', '' | 'diff' | 'sum' | 'abs'];
    }
  > {
    try {
      const raw = localStorage.getItem('tether.layouts');
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private populateLayoutPicker(): void {
    const select = this.querySelector<HTMLSelectElement>('#layout-select');
    if (!select) return;
    const names = Object.keys(this.loadLayouts()).sort();
    select.innerHTML =
      '<option value="">Saved layouts…</option>' +
      names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  }

  /** Magnitude spectrum of a pane's first channel over retained history. */
  private async renderFft(pane: 0 | 1): Promise<void> {
    const scope = this.querySelector<ScopeElement>(`#trend-scope-${pane}`);
    const output = this.querySelector<HTMLOutputElement>(`#trend-stats-${pane}`);
    const history = scope ? this.scopeHistory.get(scope) : undefined;
    if (!history?.length || !output) {
      this.showToast('No samples retained yet', 'error');
      return;
    }
    const channel = history.map((row) => row[0]!);
    const magnitudes = fftMagnitudes(channel);
    if (!magnitudes.length) {
      this.showToast('Need at least 4 samples for a spectrum', 'error');
      return;
    }
    const peak = magnitudes.reduce((best, v, i) => (v > magnitudes[best]! ? i : best), 0);
    const top = magnitudes
      .map((m, i) => ({ bin: i, m }))
      .sort((a, b) => b.m - a.m)
      .slice(0, 5)
      .map(({ bin, m }) => `bin ${bin}=${formatStat(m)}`)
      .join('  ·  ');
    output.textContent = `FFT (${channel.length}→${(magnitudes.length - 1) * 2} samples): peak bin ${peak} — ${top}`;
    // VolcanoPlot renders the actual spectrum figure (WebGPU, Canvas2D
    // fallback) in the overlay — the stats line stays as the text summary.
    const bundle = await loadVolcanoPlot();
    const overlay = this.querySelector<HTMLElement>('#trend-plot-overlay');
    const canvas = this.querySelector<HTMLCanvasElement>('#trend-plot-canvas');
    const title = this.querySelector<HTMLElement>('#trend-plot-title');
    if (!bundle || !overlay || !canvas) return;
    this.trendPlot?.destroy();
    this.trendPlot = undefined;
    overlay.hidden = false;
    const vp = await bundle.createCanvas(canvas);
    this.trendPlot = vp;
    vp.spectrum(channel, 1000 / this.prefs.streamMs);
    vp.title(`Magnitude spectrum — pane ${pane === 0 ? 'A' : 'B'}`);
    vp.xlabel('Frequency (Hz)');
    vp.ylabel('Magnitude');
    vp.grid(true);
    vp.enableInteraction(true);
    vp.render();
    if (title) title.textContent = 'Frequency spectrum (VolcanoPlot)';
  }

  /** Load an exported .bin capture into pane A using the server's layout. */
  private async replayCapture(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const status = this.captureStatus;
    if (!status?.recordFields.length || !status.recordsAvailable) {
      this.showToast(
        'No record layout available — read capture status first (record_fields)',
        'error',
      );
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const recordSize =
      Number(status.recordFields.reduce((max, f) => Math.max(max, f.offset + f.size), 0)) + 8;
    const records = splitCaptureRecords(bytes, recordSize);
    if (!records.length) {
      this.showToast('No complete records in file', 'error');
      return;
    }
    const entryById = (id: bigint) => this.signals.find((s) => s.id === id);
    const scope = this.querySelector<ScopeElement>('#trend-scope-0');
    if (!scope) return;
    const fields = status.recordFields;
    scope.setChannels(
      fields.map((f, i) => ({
        name: `${entryById(f.entryId)?.name ?? f.entryId.toString(16)} (replay)`,
        color: colors[i % colors.length] ?? [0.5, 0.5, 0.5],
      })),
    );
    scope.clear();
    this.scopeChannelIndex.delete(scope);
    for (const record of records) {
      const timestamp = new DataView(record.buffer, record.byteOffset).getBigUint64(0, true);
      scope.push(timestamp, decodeCaptureRecord(record, fields, entryById));
    }
    if (!scope.isPaused()) scope.togglePause();
    this.showToast(`Replayed ${records.length} records (paused)`, 'info');
  }

  /** Recent alarm/command/config events rendered as trend annotations. */
  private renderAnnotations(): void {
    const host = this.querySelector<HTMLElement>('#trend-annotations');
    if (!host) return;
    const events = this.eventStore.events.slice(-8);
    host.innerHTML = events.length
      ? events
          .map(
            (event) =>
              `<span class="annotation annotation-sev${event.severity}" title="${escapeHtml(event.description)}">${escapeHtml(event.eventType)}</span>`,
          )
          .join('')
      : '';
  }

  private async loadEntryMetadata(entries: CatalogEntry[]): Promise<void> {
    const batchSize = 24;
    const batches: CatalogEntry[][] = [];
    for (let offset = 0; offset < entries.length; offset += batchSize) {
      batches.push(entries.slice(offset, offset + batchSize));
    }
    await batches.reduce<Promise<void>>(
      (previous, batch) =>
        previous.then(async () => {
          await Promise.allSettled(
            batch.map(async (entry) => {
              entry.metadata = await this.client.getMetadata(entry.id);
            }),
          );
        }),
      Promise.resolve(),
    );
  }

  private async refreshProfile(): Promise<void> {
    this.profile = discoverMachineProfile(this.client.schemaCatalog, this.signals, this.functions);
    this.eventService = discoverEventService(
      this.client.schemaCatalog,
      this.signals,
      this.functions,
    );
    this.eventStore.reset();
    this.machineDescriptor = undefined;
    this.machineSnapshot = undefined;
    this.machineDiagnostics = undefined;
    if (this.profile.descriptorEntry) {
      try {
        this.machineDescriptor = await readMachineDescriptor(
          this.client,
          this.profile.descriptorEntry,
        );
      } catch (error) {
        this.showToast(
          error instanceof Error
            ? `Machine descriptor rejected: ${error.message}`
            : 'Machine descriptor rejected',
          'error',
        );
      }
    }
    this.renderMachineSummary();
    await this.pollDrives();
    await this.pollEvents();
  }

  private async pollEvents(): Promise<void> {
    const catalog = this.client.schemaCatalog;
    const service = this.eventService;
    if (
      this.client.state !== 'connected' ||
      !catalog ||
      !service.available ||
      !service.cursorEntry ||
      this.pollingEvents
    )
      return;
    this.pollingEvents = true;
    try {
      const latest = await readEventCursor(this.client, catalog, service.cursorEntry);
      if (latest !== this.eventStore.cursor || this.eventStore.cursor > latest) {
        const page = await readEventPage(this.client, catalog, service, this.eventStore.cursor, 50);
        this.eventStore.apply(page);
        // Notification hook: surface new fault/critical events immediately.
        const severe = page.events.filter((event) => event.severity >= 2);
        for (const event of severe.slice(-3)) {
          this.showToast(
            `${event.severity === 3 ? 'Critical' : 'Fault'}: ${event.eventType} — ${event.description}`,
            event.severity === 3 ? 'error' : 'info',
          );
        }
        this.renderAnnotations();
        this.renderEventTimeline();
      }
      const label = this.querySelector<HTMLElement>('#alarm-label');
      if (label)
        label.textContent = `Events: ${this.eventStore.events.length} retained${this.eventStore.gapDetected ? ' · gap detected' : ''}`;
    } catch (error) {
      const label = this.querySelector<HTMLElement>('#alarm-label');
      if (label) label.textContent = 'Events: service read failed';
      console.warn('[TetherIO] event history poll failed', error);
    } finally {
      this.pollingEvents = false;
    }
  }

  private renderEventTimeline(): void {
    const timeline = this.querySelector<
      HTMLElement & {
        model: { events: readonly MachineEvent[]; gapDetected: boolean; available: boolean };
      }
    >('#event-timeline');
    if (timeline)
      timeline.model = {
        events: this.eventStore.events,
        gapDetected: this.eventStore.gapDetected,
        available: this.eventService.available,
      };
    const count = this.querySelector<HTMLElement>('#event-count-summary');
    if (count)
      count.textContent = this.eventService.available
        ? String(this.eventStore.events.length)
        : 'Unavailable';
    const copy = this.querySelector<HTMLElement>('#event-summary-copy');
    if (copy) {
      if (!this.eventService.available)
        copy.textContent = 'Typed event history service not advertised';
      else {
        const historyState = this.eventStore.gapDetected
          ? 'history gap detected'
          : 'read-only history';
        copy.textContent = `${this.eventStore.events.length} retained · ${historyState}`;
      }
    }
  }

  private async pollDrives(): Promise<void> {
    const entries = this.profile.driveSnapshots;
    if (
      this.client.state !== 'connected' ||
      this.polling ||
      (!entries.length && !this.profile.machineSnapshotEntry)
    )
      return;
    this.polling = true;
    const tasks: Promise<
      | { kind: 'machine'; snapshot: MachineSnapshotView }
      | { kind: 'diagnostics'; diagnostics: MachineDiagnosticsView }
      | { kind: 'drive'; id: bigint; snapshot: DriveSnapshotRecord['snapshot'] }
      | { kind: 'pdo'; entries: PdoEntryView[] }
      | { kind: 'supervisor'; entries: SupervisorEntryView[] }
    >[] = [];
    if (this.profile.machineSnapshotEntry) {
      tasks.push(
        readMachineSnapshot(this.client, this.profile.machineSnapshotEntry).then((snapshot) => ({
          kind: 'machine' as const,
          snapshot,
        })),
      );
    }
    if (this.profile.diagnosticsEntry) {
      tasks.push(
        readMachineDiagnostics(this.client, this.profile.diagnosticsEntry).then((diagnostics) => ({
          kind: 'diagnostics' as const,
          diagnostics,
        })),
      );
    }
    if (this.control?.pdoMapAvailable) {
      tasks.push(this.control.pdoMap().then((entries) => ({ kind: 'pdo' as const, entries })));
    }
    if (this.control?.supervisorAvailable) {
      tasks.push(
        this.control
          .supervisorStatus()
          .then((entries) => ({ kind: 'supervisor' as const, entries })),
      );
    }
    for (const entry of entries) {
      tasks.push(
        readDriveSnapshot(this.client, entry).then((snapshot) => ({
          kind: 'drive' as const,
          id: entry.id,
          snapshot,
        })),
      );
    }
    const results = await Promise.allSettled(tasks);
    let machineReceived = false;
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      if (result.value.kind === 'machine') {
        this.machineSnapshot = result.value.snapshot;
        this.machineSnapshotReceivedAt = Date.now();
        machineReceived = true;
      } else if (result.value.kind === 'diagnostics') {
        this.machineDiagnostics = result.value.diagnostics;
      } else if (result.value.kind === 'pdo') {
        this.pdoEntries = result.value.entries;
      } else if (result.value.kind === 'supervisor') {
        this.supervisorEntries = result.value.entries;
      } else {
        this.driveData.set(result.value.id, {
          snapshot: result.value.snapshot,
          receivedAt: Date.now(),
        });
      }
    }
    for (const result of results) {
      if (result.status === 'rejected')
        console.warn('[TetherIO] drive poll failed:', result.reason);
    }
    const failedCount = results.filter((result) => result.status === 'rejected').length;
    let freshness = 'Data: live drive snapshots';
    if (machineReceived) freshness = 'Data: live · coherent machine snapshot';
    if (failedCount > 0) {
      const noun = failedCount === 1 ? 'read' : 'reads';
      freshness = `Data: partial · ${failedCount} ${noun} failed`;
    }
    this.querySelector('#freshness-label')!.textContent = freshness;
    this.renderMachineSummary();
    this.renderDriveViews();
    this.polling = false;
  }

  private renderMachineSummary(): void {
    this.renderProfileSummary();
    this.renderTelemetrySummary();
    this.renderEventTimeline();
    this.renderDriveViews();
    this.renderMotionView();
    this.renderAlarmView();
    this.renderDiagnosticsView();
  }

  private renderDiagnosticsView(): void {
    const axesByStableId = new Map(
      (this.machineDescriptor?.axes ?? []).map((axis) => [axis.stableId, axis]),
    );
    const drives: DiagnosticsModel['drives'] = [];
    for (const entry of this.profile.driveSnapshots) {
      const record = this.driveData.get(entry.id);
      if (!record) continue;
      drives.push({
        axis: axesByStableId.get(entry.metadata?.['resource.stable_id'] ?? ''),
        snapshot: record.snapshot,
        ageMs: Math.max(0, Date.now() - record.receivedAt),
      });
    }
    renderDiagnostics(this, {
      profileAvailable: this.profile.profile === 'machine.cia402.v1',
      descriptor: this.machineDescriptor,
      snapshot: this.machineSnapshot,
      snapshotAgeMs:
        this.machineSnapshotReceivedAt === undefined
          ? undefined
          : Math.max(0, Date.now() - this.machineSnapshotReceivedAt),
      drives,
      connectionStale: this.client.state !== 'connected',
      diagnostics: this.machineDiagnostics,
      diagnosticsAdvertised: this.profile.diagnosticsEntry !== undefined,
      pdoEntries: this.pdoEntries,
      pdoAdvertised: this.control?.pdoMapAvailable ?? false,
      supervisor: this.supervisorEntries,
      supervisorAdvertised: this.control?.supervisorAvailable ?? false,
      supervisorResult: this.supervisorResultText,
    });
  }

  private async onSupervisorRetry(slave: number): Promise<void> {
    if (!this.control?.supervisorAvailable) return;
    try {
      const result = await this.control.supervisorRetry(slave);
      const label = SUPERVISOR_STATE_LABELS[result.state] ?? `state ${result.state}`;
      this.supervisorResultText = result.ok
        ? `Retry accepted for slave ${slave} — supervisor state: ${label}.`
        : `Retry rejected for slave ${slave}: ${result.error || label}.`;
      this.showToast(
        result.ok
          ? `Recovery retry requested for slave ${slave}`
          : result.error || 'Retry rejected',
        result.ok ? 'info' : 'error',
      );
      // Refresh the table immediately so the new state/attempt count shows.
      this.supervisorEntries = await this.control.supervisorStatus();
    } catch (error) {
      this.supervisorResultText = `Retry request failed: ${(error as Error).message}`;
      this.showToast((error as Error).message, 'error');
    }
    this.renderDiagnosticsView();
  }

  // ---- Commissioning: capture + staged configuration ----------------------

  private renderCommissioningView(): void {
    // Preserve whatever the operator has typed: this render replaces the SDO
    // form's DOM, and an async refresh landing mid-entry must not clear it.
    const readInput = (id: string) => this.querySelector<HTMLInputElement>(id)?.value;
    this.sdoForm.index = readInput('#sdo-index') ?? this.sdoForm.index;
    this.sdoForm.subindex = readInput('#sdo-subindex') ?? this.sdoForm.subindex;
    this.sdoForm.data = readInput('#sdo-data') ?? this.sdoForm.data;
    this.sdoForm.maxBytes = readInput('#sdo-max-bytes') ?? this.sdoForm.maxBytes;
    const slave = readInput('#sdo-slave');
    if (slave !== undefined && slave !== '')
      this.sdoSlave = Math.min(65535, Math.max(0, Number(slave) || 0));
    renderCommissioning(this, {
      captureAvailable: this.control?.captureAvailable ?? false,
      configAvailable: this.control?.configAvailable ?? false,
      capture: this.captureStatus,
      config: this.configStatus,
      writableParams: writableParameters(this.params),
      triggerSignals: this.signals,
      sdoAvailable: this.control?.sdoAvailable ?? false,
      sdoSlave: this.sdoSlave,
      sdoIndex: this.sdoForm.index,
      sdoSubindex: this.sdoForm.subindex,
      sdoData: this.sdoForm.data,
      sdoMaxBytes: this.sdoForm.maxBytes,
      sdoEntries: this.sdoEntries,
      sdoResult: this.sdoResult,
      sdoPendingWrite: this.sdoPendingWrite,
      busy: this.controlBusy,
      baselineAvailable: this.control?.configBaselineAvailable ?? false,
      baseline: this.baselineEntries,
      baselineDiff: this.baselineDiff,
      baselineResult: this.baselineResultText,
      checklistAvailable: this.control?.checklistAvailable ?? false,
      checklist: this.checklistItems,
      checklistResult: this.checklistResultText,
    });
  }

  // ---- Commissioning: baseline export/diff/import + checklist ----------------

  private baselineEntries?: ConfigEntryView[];
  private baselineDiff?: ConfigDiffView;
  private baselineResultText?: string;
  private checklistItems?: ChecklistItemView[];
  private checklistResultText?: string;
  private appProfile?: AppProfile;
  private appProfileEntry?: CatalogEntry;
  private panelValues = new Map<string, number | string>();
  private panelHistory = new Map<string, number[]>();
  private panelUnresolved: string[] = [];
  private recipes?: RecipeInfoView[];
  private recipeResultText?: string;

  /** Read the optional machine.app.profile signal once per catalog epoch. */
  private async loadAppProfile(): Promise<void> {
    this.appProfile = undefined;
    this.appProfileEntry = findAppProfileEntry(this.signals);
    this.panelUnresolved = [];
    if (!this.appProfileEntry) return;
    try {
      this.appProfile = await readAppProfile(this.client, this.appProfileEntry);
      if (this.appProfile) {
        const known = new Set(this.signals.map((s) => s.name));
        this.panelUnresolved = [
          ...new Set(
            this.appProfile.panels
              .flatMap((p) => p.widgets.flatMap((w) => [...widgetSignalBindings(w)]))
              .map((binding) => binding.entry)
              .filter((name) => !known.has(name)),
          ),
        ];
      }
    } catch {
      this.appProfile = undefined;
    }
  }

  private renderPanelsView(): void {
    const axisName = (stableId: string) =>
      this.commandAxes().find((a) => a.stableId === stableId)?.name;
    renderPanels(this, {
      profile: this.appProfile,
      values: this.panelValues,
      history: this.panelHistory,
      unresolved: this.panelUnresolved,
      stale: this.client.state !== 'connected',
      controls: {
        canCommand: !!this.lease && !!this.control?.controlsAvailable,
        axisName,
      },
    });
  }

  /** Poll every signal referenced by profile widgets (only when bound). */
  private async pollPanels(): Promise<void> {
    if (!this.appProfile || this.client.state !== 'connected') return;
    const byName = new Map(this.signals.map((s) => [s.name, s]));
    let changed = false;
    for (const panel of this.appProfile.panels) {
      for (const widget of panel.widgets) {
        for (const binding of widgetSignalBindings(widget)) {
          const entry = byName.get(binding.entry);
          if (!entry) continue;
          const key = binding.key;
          try {
            // Schema-typed entries (marked by the server's `schema.name`
            // metadata) decode through the negotiated catalog; plain scalar
            // entries carry no type on the wire, so decode by byte length
            // using the dashboard's F64-first convention.
            let value: unknown;
            if (entry.metadata?.['schema.name']) {
              value = await this.client.getTyped(entry);
            } else {
              const bytes = await this.client.get(entry.kind, entry.id);
              const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
              value =
                bytes.length === 8
                  ? view.getFloat64(0, true)
                  : bytes.length === 4
                    ? view.getFloat32(0, true)
                    : bytes.length === 2
                      ? view.getUint16(0, true)
                      : bytes.length === 1
                        ? view.getUint8(0)
                        : bytes;
            }
            if (
              binding.field &&
              value &&
              typeof value === 'object' &&
              !Array.isArray(value) &&
              !(value instanceof Uint8Array)
            ) {
              value = (value as Record<string, unknown>)[binding.field] as never;
            }
            const normalized =
              typeof value === 'bigint'
                ? Number(value)
                : typeof value === 'number' || typeof value === 'boolean'
                  ? Number(value)
                  : typeof value === 'string'
                    ? value
                    : undefined;
            if (normalized === undefined) continue;
            if (this.panelValues.get(key) !== normalized) {
              this.panelValues.set(key, normalized);
              changed = true;
            }
            if (typeof normalized === 'number') {
              const history = this.panelHistory.get(key) ?? [];
              history.push(normalized);
              if (history.length > 120) history.shift();
              this.panelHistory.set(key, history);
            }
          } catch {
            /* single-entry read failure leaves the last value in place */
          }
        }
      }
    }
    if (changed && this.activeView === 'panels') this.renderPanelsView();
  }

  private renderRecipesView(): void {
    renderRecipes(this, {
      available: this.control?.recipesAvailable ?? false,
      recipes: this.recipes,
      result: this.recipeResultText,
      busy: this.controlBusy,
    });
  }

  private async onRecipesLoad(): Promise<void> {
    if (!this.control?.recipesAvailable) return;
    this.controlBusy = true;
    try {
      this.recipes = await this.control.recipeList();
      this.recipeResultText = `${this.recipes.length} recipe(s) available`;
    } catch (error) {
      this.recipeResultText = `recipe list failed: ${(error as Error).message}`;
    }
    this.controlBusy = false;
    this.renderRecipesView();
  }

  private async onRecipeApply(name: string): Promise<void> {
    if (!this.control?.recipesAvailable) return;
    this.controlBusy = true;
    try {
      // Stage only — validate + commit happen on the Commissioning page.
      const status = await this.control.recipeApply(name);
      this.configStatus = status;
      this.recipeResultText =
        `'${name}' staged as txn ${status.transactionId.toString()} ` +
        `(${txnStateLabel(status.state)}) — validate + commit under Commissioning`;
      if (status.state === ConfigTxnState.Failed)
        this.showToast(`Recipe rejected: ${status.message}`, 'error');
      else this.showToast(`Recipe '${name}' staged (not committed)`, 'info');
    } catch (error) {
      this.recipeResultText = `recipe apply failed: ${(error as Error).message}`;
      this.showToast((error as Error).message, 'error');
    }
    this.controlBusy = false;
    this.renderRecipesView();
  }

  private async onBaselineExport(): Promise<void> {
    if (!this.control?.configBaselineAvailable) return;
    this.controlBusy = true;
    try {
      const result = await this.control.configExport();
      this.baselineEntries = result.entries;
      this.baselineResultText = `exported ${result.entries.length} parameters at revision ${result.revision.toString()}`;
      const blob = new Blob([serializeBaseline(result.revision, result.entries)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'tether-baseline.json';
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      this.baselineResultText = `export failed: ${(error as Error).message}`;
    }
    this.controlBusy = false;
    this.renderCommissioningView();
  }

  private onBaselineFile(file: File): void {
    file.text().then((text) => {
      const entries = parseBaselineFile(text);
      if (!entries) {
        this.baselineResultText = 'baseline file rejected: not tether.config.baseline.v1 JSON';
        this.showToast('Baseline file rejected', 'error');
      } else {
        this.baselineEntries = entries;
        this.baselineDiff = undefined;
        this.baselineResultText = `loaded ${entries.length} baseline entries`;
      }
      this.renderCommissioningView();
    });
  }

  private async onBaselineDiff(): Promise<void> {
    if (!this.control?.configBaselineAvailable || !this.baselineEntries) return;
    this.controlBusy = true;
    try {
      this.baselineDiff = await this.control.configDiff(this.baselineEntries);
      this.baselineResultText =
        this.baselineDiff.diffs.length === 0
          ? `live config matches baseline at revision ${this.baselineDiff.revision.toString()}`
          : `${this.baselineDiff.diffs.length} parameter(s) differ from the baseline`;
    } catch (error) {
      this.baselineResultText = `diff failed: ${(error as Error).message}`;
    }
    this.controlBusy = false;
    this.renderCommissioningView();
  }

  private async onBaselineImport(): Promise<void> {
    if (!this.control?.configBaselineAvailable || !this.baselineEntries) return;
    this.controlBusy = true;
    try {
      // Import stages a transaction; validate + commit are still separate,
      // explicit steps — nothing is applied by this call alone.
      this.configStatus = await this.control.configImport(this.baselineEntries);
      this.baselineResultText =
        `imported ${this.baselineEntries.length} entries into ` +
        `txn ${this.configStatus.transactionId.toString()} (${txnStateLabel(this.configStatus.state)})`;
      if (this.configStatus.state === ConfigTxnState.Failed)
        this.showToast(`Import rejected: ${this.configStatus.message}`, 'error');
    } catch (error) {
      this.baselineResultText = `import failed: ${(error as Error).message}`;
      this.showToast((error as Error).message, 'error');
    }
    this.controlBusy = false;
    this.renderCommissioningView();
  }

  private async onChecklistList(): Promise<void> {
    if (!this.control?.checklistAvailable) return;
    this.controlBusy = true;
    try {
      this.checklistItems = await this.control.checklistList();
      this.checklistResultText = `${this.checklistItems.length} items evaluated`;
    } catch (error) {
      this.checklistResultText = `checklist read failed: ${(error as Error).message}`;
    }
    this.controlBusy = false;
    this.renderCommissioningView();
  }

  private async onChecklistReport(): Promise<void> {
    if (!this.control?.checklistAvailable) return;
    this.controlBusy = true;
    try {
      const report = await this.control.checklistReport();
      this.checklistItems = report.items;
      this.checklistResultText =
        `acceptance report recorded · revision ${report.revision.toString()} · ` +
        `${report.items.length} items · all required passed`;
      this.showToast('Acceptance report recorded in the audit journal', 'info');
    } catch (error) {
      this.checklistResultText = `report refused: ${(error as Error).message}`;
      this.showToast((error as Error).message, 'error');
      this.controlBusy = false;
      await this.onChecklistList();
      return;
    }
    this.controlBusy = false;
    this.renderCommissioningView();
  }

  // ---- SDO inspector (optional backend) --------------------------------------

  private sdoSlaveValue(): number {
    return Math.min(
      65535,
      Math.max(
        0,
        Number(this.querySelector<HTMLInputElement>('#sdo-slave')?.value ?? this.sdoSlave) || 0,
      ),
    );
  }

  private async onSdoList(): Promise<void> {
    const control = this.control;
    if (!control?.sdoAvailable || this.controlBusy) return;
    this.sdoSlave = this.sdoSlaveValue();
    this.controlBusy = true;
    this.renderCommissioningView();
    try {
      this.sdoEntries = await control.sdoList(this.sdoSlave);
    } catch (error) {
      this.sdoEntries = undefined;
      this.showToast(error instanceof Error ? error.message : 'sdo.list failed', 'error');
    } finally {
      this.controlBusy = false;
      this.renderCommissioningView();
    }
  }

  private async onSdoTransfer(): Promise<void> {
    const control = this.control;
    if (!control?.sdoAvailable || this.controlBusy) return;
    this.sdoSlave = this.sdoSlaveValue();
    const index = parseInt(this.querySelector<HTMLInputElement>('#sdo-index')?.value ?? '', 16);
    const subindex = parseInt(
      this.querySelector<HTMLInputElement>('#sdo-subindex')?.value ?? '',
      16,
    );
    const maxBytes = Math.min(
      512,
      Math.max(
        1,
        Number(this.querySelector<HTMLInputElement>('#sdo-max-bytes')?.value ?? 256) || 256,
      ),
    );
    if (
      !Number.isFinite(index) ||
      index > 0xffff ||
      !Number.isFinite(subindex) ||
      subindex > 0xff
    ) {
      this.showToast('Enter a valid hex index/subindex (e.g. 6040 / 00)', 'error');
      return;
    }
    this.controlBusy = true;
    this.renderCommissioningView();
    try {
      this.sdoResult = await control.sdoRead(this.sdoSlave, index, subindex, maxBytes);
      if (!this.sdoResult.ok)
        this.showToast(this.sdoResult.error || 'SDO transfer aborted', 'error');
    } catch (error) {
      this.sdoResult = undefined;
      this.showToast(error instanceof Error ? error.message : 'SDO transfer failed', 'error');
    } finally {
      this.controlBusy = false;
      this.renderCommissioningView();
    }
  }

  /**
   * Write workflow (plan §76): preview the current value, require an explicit
   * confirm click, then write — the server rate-limits, audits, and performs
   * a verification readback which the result panel displays.
   */
  private async onSdoPreviewWrite(): Promise<void> {
    const control = this.control;
    if (!control?.sdoAvailable || this.controlBusy) return;
    this.sdoSlave = this.sdoSlaveValue();
    const index = parseInt(this.querySelector<HTMLInputElement>('#sdo-index')?.value ?? '', 16);
    const subindex = parseInt(
      this.querySelector<HTMLInputElement>('#sdo-subindex')?.value ?? '',
      16,
    );
    if (
      !Number.isFinite(index) ||
      index > 0xffff ||
      !Number.isFinite(subindex) ||
      subindex > 0xff
    ) {
      this.showToast('Enter a valid hex index/subindex (e.g. 6040 / 00)', 'error');
      return;
    }
    const data = parseHexBytes(this.querySelector<HTMLInputElement>('#sdo-data')?.value ?? '');
    if (!data?.length || data.length > 512) {
      this.showToast('Write data must be 1-512 hex bytes', 'error');
      return;
    }
    const entry = this.sdoEntries?.find((e) => e.index === index && e.subindex === subindex);
    if (entry && entry.access === 1) {
      this.showToast(`0x${index.toString(16)}:${subindex.toString(16)} is read-only`, 'error');
      return;
    }
    this.controlBusy = true;
    this.renderCommissioningView();
    try {
      const current = await control.sdoRead(this.sdoSlave, index, subindex, data.length);
      this.sdoPendingWrite = {
        index,
        subindex,
        data,
        current: current.ok ? current.data : undefined,
        entry,
        error: current.ok ? undefined : current.error || current.abortName || 'read failed',
      };
      this.sdoResult = undefined;
    } catch (error) {
      this.sdoPendingWrite = {
        index,
        subindex,
        data,
        entry,
        error: error instanceof Error ? error.message : 'preview read failed',
      };
    } finally {
      this.controlBusy = false;
      this.renderCommissioningView();
    }
  }

  private async onSdoConfirmWrite(): Promise<void> {
    const control = this.control;
    const pending = this.sdoPendingWrite;
    if (!control?.sdoAvailable || !pending || this.controlBusy) return;
    this.controlBusy = true;
    this.renderCommissioningView();
    try {
      this.sdoResult = await control.sdoWrite(
        this.sdoSlave,
        pending.index,
        pending.subindex,
        pending.data,
      );
      this.sdoPendingWrite = undefined;
      if (!this.sdoResult.ok)
        this.showToast(
          this.sdoResult.error || this.sdoResult.abortName || 'SDO write aborted',
          'error',
        );
    } catch (error) {
      this.showToast(error instanceof Error ? error.message : 'SDO write failed', 'error');
    } finally {
      this.controlBusy = false;
      this.renderCommissioningView();
    }
  }

  private async refreshCommissioning(): Promise<void> {
    const control = this.control;
    if (!control || this.client.state !== 'connected') return;
    const [capture, config] = await Promise.allSettled([
      control.captureAvailable ? control.captureStatus() : Promise.resolve(undefined),
      control.configAvailable ? control.configStatus() : Promise.resolve(undefined),
    ]);
    if (capture.status === 'fulfilled' && capture.value) this.captureStatus = capture.value;
    if (config.status === 'fulfilled' && config.value) this.configStatus = config.value;
    this.renderCommissioningView();
  }

  private async onCaptureSubmit(): Promise<void> {
    const control = this.control;
    if (!control?.captureAvailable || this.controlBusy) return;
    const name = this.querySelector<HTMLInputElement>('#capture-name')?.value.trim() ?? '';
    const rate = Number(this.querySelector<HTMLInputElement>('#capture-rate')?.value ?? 0);
    const enabled = this.querySelector<HTMLInputElement>('#capture-enabled')?.checked ?? false;
    const triggerSignal =
      this.querySelector<HTMLSelectElement>('#capture-trigger-signal')?.value ?? '';
    const trigger =
      triggerSignal === ''
        ? undefined
        : {
            entryId: BigInt(triggerSignal),
            op: Number(this.querySelector<HTMLSelectElement>('#capture-trigger-op')?.value ?? '0'),
            level: Number(
              this.querySelector<HTMLInputElement>('#capture-trigger-level')?.value ?? '0',
            ),
            preRecords: Number(
              this.querySelector<HTMLInputElement>('#capture-trigger-pre')?.value ?? '0',
            ),
            postRecords: Number(
              this.querySelector<HTMLInputElement>('#capture-trigger-post')?.value ?? '0',
            ),
          };
    this.controlBusy = true;
    this.renderCommissioningView();
    try {
      // Empty entry list = all fixed-size entries (server-side rule).
      const template = this.querySelector<HTMLInputElement>('#capture-template')?.checked ? 1 : 0;
      this.captureStatus = await control.configureCapture(
        name,
        rate,
        enabled,
        [],
        trigger,
        template,
      );
    } catch (error) {
      this.showToast(error instanceof Error ? error.message : 'Capture configure failed', 'error');
    } finally {
      this.controlBusy = false;
      this.renderCommissioningView();
    }
  }

  private async onCaptureCancel(): Promise<void> {
    const control = this.control;
    if (!control?.captureAvailable || this.controlBusy) return;
    this.controlBusy = true;
    this.renderCommissioningView();
    try {
      this.captureStatus = await control.captureCancel();
    } catch (error) {
      this.showToast(error instanceof Error ? error.message : 'Capture cancel failed', 'error');
    } finally {
      this.controlBusy = false;
      this.renderCommissioningView();
    }
  }

  /**
   * Download the retained records as a .bin file. Chunks are paginated at
   * 64 KiB; every export call is audited server-side.
   */
  private async onCaptureExport(): Promise<void> {
    const control = this.control;
    if (!control?.captureAvailable || this.controlBusy) return;
    this.controlBusy = true;
    this.renderCommissioningView();
    try {
      const chunks: Uint8Array[] = [];
      let offset = 0n;
      let total = 0n;
      do {
        const chunk = await control.captureExport(offset);
        chunks.push(chunk.payload);
        total = chunk.totalRecords;
        const recordSize = BigInt(chunk.recordSize || 1);
        offset += BigInt(Math.max(1, chunk.payload.length)) / recordSize;
        if (chunk.payload.length === 0) break;
      } while (offset < total);
      const blob = new Blob(
        chunks.map((c) => c.buffer as ArrayBuffer),
        {
          type: 'application/octet-stream',
        },
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${this.captureStatus?.logName || 'capture'}-${Date.now()}.bin`;
      link.click();
      URL.revokeObjectURL(url);
      this.showToast(`Exported ${total.toString()} records`, 'info');
    } catch (error) {
      this.showToast(error instanceof Error ? error.message : 'Capture export failed', 'error');
    } finally {
      this.controlBusy = false;
      this.renderCommissioningView();
    }
  }

  private async onConfigStage(): Promise<void> {
    const control = this.control;
    if (!control?.configAvailable || this.controlBusy) return;
    const idText = this.querySelector<HTMLSelectElement>('#config-param')?.value ?? '';
    const valueText = this.querySelector<HTMLInputElement>('#config-value')?.value ?? '';
    const value = parseHexBytes(valueText);
    if (!idText) {
      this.showToast('Select a writable parameter', 'error');
      return;
    }
    if (!value) {
      this.showToast('Value must be even-length hex bytes (e.g. "2a 00 00 00")', 'error');
      return;
    }
    this.controlBusy = true;
    try {
      this.configStatus = await control.stageConfig([{ entryId: BigInt(idText), value }]);
      this.toastConfigResult(this.configStatus, 'staged');
    } catch (error) {
      this.showToast(error instanceof Error ? error.message : 'Stage failed', 'error');
    } finally {
      this.controlBusy = false;
      this.renderCommissioningView();
    }
  }

  private async onConfigVerb(verb: 'validate' | 'commit' | 'rollback'): Promise<void> {
    const control = this.control;
    if (!control?.configAvailable || this.controlBusy) return;
    this.controlBusy = true;
    try {
      this.configStatus = await (verb === 'validate'
        ? control.validateConfig()
        : verb === 'commit'
          ? control.commitConfig()
          : control.rollbackConfig());
      this.toastConfigResult(this.configStatus, verb);
    } catch (error) {
      this.showToast(error instanceof Error ? error.message : `config.${verb} failed`, 'error');
    } finally {
      this.controlBusy = false;
      this.renderCommissioningView();
    }
  }

  private toastConfigResult(status: ConfigStatusView, verb: string): void {
    if (status.state === ConfigTxnState.Failed) {
      this.showToast(status.message || `config.${verb} failed`, 'error');
    }
  }

  private renderProfileSummary(): void {
    const badge = this.querySelector<HTMLElement>('#profile-badge');
    if (badge)
      badge.textContent =
        this.profile.profile === 'machine.cia402.v1' ? 'CiA 402 profile' : 'Profile incomplete';
    const explanation = this.querySelector<HTMLElement>('#profile-explanation');
    if (explanation) explanation.textContent = this.profile.explanation;
    const count = this.querySelector<HTMLElement>('#drive-count');
    if (count)
      count.textContent = String(
        this.machineDescriptor?.axes.length ?? this.profile.driveSnapshots.length,
      );
    const summary = this.querySelector<HTMLElement>('#drive-summary');
    if (summary)
      summary.textContent =
        this.profile.driveSnapshots.length > 0
          ? `${this.driveData.size} current · ${this.profile.driveSnapshots.length} discovered`
          : 'No schema-backed drive snapshots';
  }

  private renderTelemetrySummary(): void {
    const message = this.querySelector<HTMLElement>('#overview-message');
    const machineName = this.querySelector<HTMLElement>('#machine-display-name');
    if (machineName && this.machineDescriptor)
      machineName.textContent = this.machineDescriptor.displayName;
    const health = this.querySelector<HTMLElement>('#machine-health');
    const healthCopy = this.querySelector<HTMLElement>('#machine-health-copy');
    this.renderMasterWidget();
    if (!this.machineSnapshot) {
      this.renderUnavailableTelemetry(health, healthCopy, message);
      return;
    }
    const state = this.machineSnapshot;
    const snapshotAgeMs =
      this.machineSnapshotReceivedAt === undefined
        ? Infinity
        : Date.now() - this.machineSnapshotReceivedAt;
    const degraded =
      !state.linkUp ||
      state.actualWkc !== state.expectedWkc ||
      state.staleCount > 0 ||
      state.faultCount > 0 ||
      snapshotAgeMs > 3000;
    if (health) health.textContent = degraded ? 'Degraded telemetry' : 'Telemetry nominal';
    if (healthCopy) healthCopy.textContent = this.formatMachineSnapshot(state, snapshotAgeMs);
    if (message)
      message.textContent = `${this.machineDescriptor?.displayName ?? 'Machine'} · generation ${state.stateGeneration.toString()}. Telemetry summary only; it does not assert safety or motion readiness.`;
  }

  private renderMasterWidget(): void {
    const widget = this.querySelector<
      HTMLElement & { model: { snapshot: MachineSnapshotView; ageMs: number } | undefined }
    >('#machine-state-widget');
    if (!widget) return;
    widget.model = this.machineSnapshot
      ? {
          snapshot: this.machineSnapshot,
          ageMs: Math.max(0, Date.now() - (this.machineSnapshotReceivedAt ?? Date.now())),
        }
      : undefined;
  }

  private renderUnavailableTelemetry(
    health: HTMLElement | null,
    healthCopy: HTMLElement | null,
    message: HTMLElement | null,
  ): void {
    if (health) health.textContent = 'Unknown';
    if (healthCopy) healthCopy.textContent = 'No coherent machine snapshot received.';
    if (message) message.textContent = this.profile.explanation;
  }

  private formatMachineSnapshot(state: MachineSnapshotView, ageMs: number): string {
    const source = state.simulated ? 'Simulated' : 'Live';
    const freshness = Number.isFinite(ageMs) ? `${Math.max(0, Math.round(ageMs))} ms old` : 'stale';
    return `${source} · ${state.enabledCount}/${state.axisCount} enabled · ${state.faultCount} faults · ${state.warningCount} warnings · ${state.staleCount} stale · WKC ${state.actualWkc}/${state.expectedWkc} · ${freshness}`;
  }

  private renderDriveViews(): void {
    const axesByStableId = new Map(
      (this.machineDescriptor?.axes ?? []).map((axis) => [axis.stableId, axis]),
    );
    renderDriveViews(
      this,
      this.profile.driveSnapshots,
      this.driveData,
      () => this.openView('drives'),
      axesByStableId,
    );
  }

  // ---- Control surface: authority, commands, alarms, operations -----------

  /** DriveSnapshotV1 qualityFlags bit for stale data (DriveQuality::Stale). */
  private static readonly QUALITY_STALE = 1;

  private commandAxes(): CommandAxisOption[] {
    return (this.machineDescriptor?.axes ?? []).map((axis) => {
      const entry = this.profile.driveSnapshots.find(
        (e) => e.metadata?.['resource.stable_id'] === axis.stableId,
      );
      const record = entry ? this.driveData.get(entry.id) : undefined;
      return {
        stableId: axis.stableId,
        name: axis.name,
        generation: record?.snapshot.stateGeneration ?? 0n,
        ds402State: record?.snapshot.ds402State ?? 0,
        supportsHoming: axis.supportsHoming,
        homingState: record?.snapshot.homingState ?? 0,
        stale:
          !record ||
          (record.snapshot.qualityFlags & TetherApp.QUALITY_STALE) !== 0 ||
          Date.now() - record.receivedAt > 3000,
      };
    });
  }

  private motionModel(): MotionModel {
    return {
      controlsAvailable: this.control?.controlsAvailable ?? false,
      lease: this.lease
        ? {
            scope: this.lease.scope,
            token: this.lease.token,
            remainingMs: Math.max(0, this.lease.expiresAtMs - Date.now()),
          }
        : undefined,
      axes: this.commandAxes(),
      lastReceipt: this.lastReceipt,
      selectedTargets: [...this.selectedTargets],
      busy: this.controlBusy,
    };
  }

  private renderMotionView(): void {
    const model = this.motionModel();
    const serviceState = this.querySelector<HTMLElement>('#motion-service-state');
    if (serviceState) {
      serviceState.textContent = model.controlsAvailable
        ? 'Authority + command services advertised'
        : 'Service not discovered';
    }
    const authority = this.querySelector<HTMLElement>('#authority-panel');
    if (authority) renderAuthorityPanel(authority, model);
    const command = this.querySelector<HTMLElement>('#command-panel');
    if (command) renderCommandPanel(command, model);
    const homing = this.querySelector<HTMLElement>('#homing-panel');
    if (homing) renderHomingPanel(homing, model, this.homingStages, this.runningHomingAxes());
    const operations = this.querySelector<HTMLElement>('#operations-table-body');
    if (operations) renderOperations(operations, this.operations);
    const authorityLabel = this.querySelector<HTMLElement>('#authority-label');
    if (authorityLabel) {
      authorityLabel.textContent = this.lease
        ? `Control owner: this session · ${Math.max(0, Math.round(this.lease.expiresAtMs - Date.now()))} ms`
        : 'Control owner: none';
    }
  }

  private renderAlarmView(): void {
    const state = this.querySelector<HTMLElement>('#alarm-service-state');
    const available = this.control?.controlsAvailable ?? false;
    if (state)
      state.textContent = available ? 'Lifecycle functions advertised' : 'Service not discovered';
    const tbody = this.querySelector<HTMLElement>('#alarm-table-body');
    if (tbody) {
      const ordered = [...this.alarms.values()].sort((a, b) => (a.alarmId > b.alarmId ? -1 : 1));
      renderAlarms(tbody, ordered, available);
    }
    const label = this.querySelector<HTMLElement>('#alarm-label');
    if (label) {
      const active = [...this.alarms.values()].filter((a) => a.state === 0).length;
      label.textContent = available ? `Alarms: ${active} active` : 'Alarms: unavailable';
    }
  }

  /** Track local lease expiry — the server owns the lease; we only mirror it. */
  private refreshLeaseState(): void {
    if (this.lease && Date.now() >= this.lease.expiresAtMs) {
      this.lease = undefined;
      this.showToast('Motion lease expired; re-acquire to issue further commands.', 'error');
      this.renderMotionView();
    } else if (this.lease) {
      this.renderMotionView();
    }
  }

  private async onAuthorityAction(action: string): Promise<void> {
    const control = this.control;
    if (!control?.controlsAvailable || this.controlBusy) return;
    const scope =
      this.querySelector<HTMLInputElement>('#authority-scope')?.value.trim() || 'machine';
    const leaseMs = Number(
      this.querySelector<HTMLInputElement>('#authority-lease-ms')?.value ?? 10000,
    );
    this.controlBusy = true;
    this.renderMotionView();
    try {
      if (action === 'acquire' || action === 'takeover') {
        const result =
          action === 'takeover'
            ? await control.takeoverAuthority(scope, leaseMs)
            : await control.acquireAuthority(scope, leaseMs);
        if (result.granted) {
          this.lease = {
            scope: result.scope,
            token: result.token,
            expiresAtMs: Date.now() + result.remainingMs,
          };
        } else {
          this.showToast(result.blocker || 'Authority was not granted', 'error');
        }
      } else if (this.lease) {
        const result =
          action === 'renew'
            ? await control.renewAuthority(this.lease.token, this.lease.scope, leaseMs)
            : await control.releaseAuthority(this.lease.token, this.lease.scope);
        if (result.granted && action === 'renew') {
          this.lease.expiresAtMs = Date.now() + result.remainingMs;
        } else {
          this.lease = undefined;
          if (result.blocker) this.showToast(result.blocker, 'error');
        }
      }
    } catch (error) {
      this.showToast(error instanceof Error ? error.message : 'Authority request failed', 'error');
      if (action !== 'acquire') this.lease = undefined;
    } finally {
      this.controlBusy = false;
      this.renderMotionView();
    }
  }

  // ---- Hold-to-run jog --------------------------------------------------------

  /** TLV parameter encoding matching decodeSimulatedParameters on the server. */
  private static jogParameters(velocity: number, durationMs: number): Uint8Array {
    const bytes = new Uint8Array(10);
    const view = new DataView(bytes.buffer);
    bytes[0] = 4;
    view.setInt32(1, velocity, true);
    bytes[5] = 5;
    view.setUint32(6, durationMs, true);
    return bytes;
  }

  private async startJog(axisId: string, direction: number): Promise<void> {
    const control = this.control;
    const lease = this.lease;
    const axis = this.commandAxes().find((a) => a.stableId === axisId);
    if (!control?.controlsAvailable || !lease || !axis || axis.stale || this.heldJogs.has(axisId))
      return;
    const velocity = Math.min(
      1_000_000,
      Math.max(
        1,
        Number(this.querySelector<HTMLInputElement>('#jog-velocity')?.value ?? 1000) || 0,
      ),
    );
    // Bounded server-side duration — the jog stops even if JogStop never arrives.
    const durationMs = Math.min(3000, Math.max(500, Math.round(lease.expiresAtMs - Date.now())));
    this.heldJogs.set(axisId, direction);
    try {
      const receipt = await control.command(
        {
          requestUuid: crypto.randomUUID(),
          scope: lease.scope,
          authorityToken: lease.token,
          action: MachineAction.JogStart,
          targets: [axisId],
          expectedGenerations: [axis.generation],
          deadlineUs: 1_000_000n,
          parameters: TetherApp.jogParameters(direction * velocity, durationMs),
        },
        { deadlineUs: 3_000_000n },
      );
      if (receipt.state !== CommandState.Accepted) {
        this.heldJogs.delete(axisId);
        this.showToast(receipt.blockers[0] ?? receipt.message ?? 'Jog rejected', 'error');
      }
      void this.pollOperations();
    } catch (error) {
      this.heldJogs.delete(axisId);
      this.showToast(error instanceof Error ? error.message : 'Jog failed', 'error');
    }
  }

  private async stopJog(axisId: string): Promise<void> {
    const control = this.control;
    const lease = this.lease;
    if (!this.heldJogs.delete(axisId)) return;
    const axis = this.commandAxes().find((a) => a.stableId === axisId);
    if (!control?.controlsAvailable || !lease || !axis) return;
    try {
      await control.command(
        {
          requestUuid: crypto.randomUUID(),
          scope: lease.scope,
          authorityToken: lease.token,
          action: MachineAction.JogStop,
          targets: [axisId],
          expectedGenerations: [axis.generation],
          deadlineUs: 1_000_000n,
        },
        { deadlineUs: 3_000_000n },
      );
      void this.pollOperations();
    } catch {
      // The server bounds the jog duration regardless — a failed stop message
      // only delays the already-bounded motion.
    }
  }

  private async stopAllJogs(): Promise<void> {
    for (const axisId of [...this.heldJogs.keys()]) await this.stopJog(axisId);
  }

  /** Profile command widget — single-target dispatch through the audited path. */
  private async onPanelCommand(action: number, axisId: string): Promise<void> {
    const control = this.control;
    const lease = this.lease;
    const axis = this.commandAxes().find((a) => a.stableId === axisId);
    if (!control?.controlsAvailable || !lease || !axis || axis.stale || this.controlBusy) return;
    this.controlBusy = true;
    try {
      const receipt = await control.command(
        {
          requestUuid: crypto.randomUUID(),
          scope: lease.scope,
          authorityToken: lease.token,
          action: action as MachineActionValue,
          targets: [axis.stableId],
          expectedGenerations: [axis.generation],
          deadlineUs: 5_000_000n,
        },
        { deadlineUs: 7_000_000n },
      );
      if (receipt.state !== CommandState.Accepted)
        this.showToast(receipt.blockers[0] ?? receipt.message ?? 'Command rejected', 'error');
      void this.pollOperations();
    } catch (error) {
      this.showToast(error instanceof Error ? error.message : 'Command dispatch failed', 'error');
    } finally {
      this.controlBusy = false;
    }
  }

  /** Profile button widget — invoke a zero-argument machine function by name. */
  private async onPanelFunction(name: string): Promise<void> {
    const fn = this.functions.find((f) => f.name === name);
    if (!fn || !this.client || this.client.state !== 'connected') {
      this.showToast(`Function ${name} is not advertised by this server`, 'error');
      return;
    }
    try {
      await this.client.callFunctionOrThrow(fn.id, []);
      this.showToast(`${name} accepted`, 'info');
    } catch (error) {
      this.showToast(error instanceof Error ? error.message : `${name} failed`, 'error');
    }
  }

  private async onCommandSubmit(): Promise<void> {
    const control = this.control;
    if (!control?.controlsAvailable || !this.lease || this.controlBusy) return;
    const action = Number(this.querySelector<HTMLSelectElement>('#command-action')?.value ?? 0);
    const deadlineMs = Number(
      this.querySelector<HTMLInputElement>('#command-deadline-ms')?.value ?? 5000,
    );
    const selected = this.commandAxes().filter((axis) => this.selectedTargets.has(axis.stableId));
    if (!selected.length) {
      this.showToast('Select at least one axis target', 'error');
      return;
    }
    this.controlBusy = true;
    this.renderMotionView();
    try {
      const receipt = await control.command(
        {
          requestUuid: crypto.randomUUID(),
          scope: this.lease.scope,
          authorityToken: this.lease.token,
          action: action as MachineActionValue,
          targets: selected.map((axis) => axis.stableId),
          expectedGenerations: selected.map((axis) => axis.generation),
          deadlineUs: BigInt(deadlineMs) * 1000n,
        },
        { deadlineUs: BigInt(deadlineMs) * 1000n + 2_000_000n },
      );
      this.lastReceipt = receipt;
      if (receipt.state !== CommandState.Accepted) {
        this.showToast(
          receipt.blockers[0] ?? receipt.message ?? 'Command rejected',
          receipt.state === CommandState.Rejected ? 'error' : 'info',
        );
      }
      await this.pollOperations();
      void this.pollAlarms();
    } catch (error) {
      this.showToast(error instanceof Error ? error.message : 'Command dispatch failed', 'error');
    } finally {
      this.controlBusy = false;
      this.renderMotionView();
    }
  }

  // ---- Guided homing ------------------------------------------------------

  /** Axes with an in-flight HomeStart/Homing operation (Queued or Running). */
  private runningHomingAxes(): Set<string> {
    const running = new Set<string>();
    for (const op of this.operations) {
      if (
        (op.action === MachineAction.HomeStart || op.action === MachineAction.HomePrepare) &&
        (op.state === 0 || op.state === 1) // Queued | Running
      )
        running.add(op.target);
    }
    return running;
  }

  /** Dispatch one step of the guided homing sequence for a single axis. */
  private async onHomingAction(axisId: string, step: string): Promise<void> {
    const control = this.control;
    const lease = this.lease;
    const axis = this.commandAxes().find((a) => a.stableId === axisId);
    if (!control?.controlsAvailable || !lease || !axis || this.controlBusy) return;
    const action =
      step === 'start'
        ? MachineAction.HomeStart
        : step === 'cancel'
          ? MachineAction.HomeCancel
          : MachineAction.HomePrepare;
    this.controlBusy = true;
    this.renderMotionView();
    try {
      const receipt = await control.command(
        {
          requestUuid: crypto.randomUUID(),
          scope: lease.scope,
          authorityToken: lease.token,
          action,
          targets: [axis.stableId],
          expectedGenerations: [axis.generation],
          deadlineUs: 30_000_000n,
        },
        { deadlineUs: 32_000_000n },
      );
      this.lastReceipt = receipt;
      if (receipt.state === CommandState.Accepted) {
        this.homingStages.set(
          axisId,
          action === MachineAction.HomePrepare
            ? 'prepared'
            : action === MachineAction.HomeStart
              ? 'running'
              : 'idle',
        );
      } else {
        this.showToast(receipt.blockers[0] ?? receipt.message ?? 'Homing step rejected', 'error');
        if (action === MachineAction.HomeCancel) this.homingStages.delete(axisId);
      }
      await this.pollOperations();
    } catch (error) {
      this.showToast(error instanceof Error ? error.message : 'Homing request failed', 'error');
    } finally {
      this.controlBusy = false;
      this.renderMotionView();
    }
  }

  private async pollOperations(): Promise<void> {
    const control = this.control;
    if (!control?.controlsAvailable || this.client.state !== 'connected') return;
    try {
      this.operations = await control.listOperations(32);
      // Homing ops that reached a terminal state leave the "running" stage;
      // the drive snapshot's homing_state reports the resulting validity.
      const running = this.runningHomingAxes();
      for (const [axisId, stage] of this.homingStages) {
        if (stage === 'running' && !running.has(axisId)) this.homingStages.set(axisId, 'idle');
      }
      const tbody = this.querySelector<HTMLElement>('#operations-table-body');
      if (tbody && this.activeView === 'motion') renderOperations(tbody, this.operations);
    } catch {
      /* operation ledger unavailable — leave last rendered state */
    }
  }

  private async pollAlarms(): Promise<void> {
    const control = this.control;
    if (!control?.controlsAvailable || this.client.state !== 'connected') return;
    try {
      const page = await control.readAlarms(this.alarmCursor, 50);
      for (const alarm of page.alarms) this.alarms.set(alarm.alarmId, alarm);
      this.alarmCursor = page.nextCursor;
      this.renderAlarmView();
    } catch {
      /* alarm service unavailable */
    }
  }

  private async onAlarmMutation(alarmId: bigint, clear: boolean): Promise<void> {
    const control = this.control;
    if (!control?.controlsAvailable) return;
    try {
      const status = clear
        ? await control.clearAlarm(alarmId)
        : await control.acknowledgeAlarm(alarmId);
      if (status === AlarmMutationStatus.Denied) {
        this.showToast('Alarm mutation requires an authenticated operator role', 'error');
      } else if (status === AlarmMutationStatus.AbsentOrTerminal) {
        this.showToast('Alarm is absent or already terminal', 'info');
      }
      // Re-read the page containing this alarm so the row reflects the server state.
      const page = await control.readAlarms(0n, 100);
      this.alarms.clear();
      for (const alarm of page.alarms) this.alarms.set(alarm.alarmId, alarm);
      this.alarmCursor = page.nextCursor;
      this.renderAlarmView();
    } catch (error) {
      this.showToast(error instanceof Error ? error.message : 'Alarm mutation failed', 'error');
    }
  }

  private openView(view: ViewId): void {
    this.activeView = view;
    this.querySelectorAll<HTMLElement>('.app-nav-item').forEach((button) =>
      button.classList.toggle('active', button.dataset.view === view),
    );
    this.renderPage();
  }

  private renderPage(): void {
    const nav = views.find((candidate) => candidate.id === this.activeView)!;
    this.querySelector('#view-title')!.textContent = nav.label;
    this.querySelector('#view-kicker')!.textContent =
      this.activeView === 'overview' ? 'Machine overview' : 'Machine console';
    const known: Partial<Record<ViewId, string>> = {
      overview: 'overview-page',
      drives: 'drives-page',
      motion: 'motion-page',
      trends: 'trends-page',
      alarms: 'alarms-page',
      diagnostics: 'diagnostics-page',
      commissioning: 'commissioning-page',
      recipes: 'recipes-page',
      panels: 'panels-page',
      explore: 'explore-page',
      settings: 'settings-page',
    };
    const pageId = known[this.activeView];
    this.querySelectorAll<HTMLElement>('.machine-page').forEach((page) => {
      page.hidden = page.id !== pageId;
    });
    if (pageId === 'motion-page') this.renderMotionView();
    if (pageId === 'alarms-page') this.renderAlarmView();
    if (pageId === 'diagnostics-page') this.renderDiagnosticsView();
    if (pageId === 'settings-page') this.populateSettingsForm();
    if (pageId === 'commissioning-page') {
      this.renderCommissioningView();
      void this.refreshCommissioning();
    }
    if (pageId === 'panels-page') this.renderPanelsView();
    if (pageId === 'recipes-page') {
      this.renderRecipesView();
      if (this.recipes === undefined) void this.onRecipesLoad();
    }
    if (!pageId) {
      const placeholder = this.querySelector<HTMLElement>('#placeholder-page')!;
      placeholder.hidden = false;
      this.querySelector('#placeholder-title')!.textContent = `${nav.label} service not advertised`;
      this.querySelector('#placeholder-copy')!.textContent =
        this.activeView === 'settings'
          ? 'Identity, roles, connection profiles, retention, and export policy must be provided by the authenticated deployment.'
          : `${nav.label} requires typed server-side event, diagnostic, capture, configuration, or recipe services. Generic registry names are not treated as an authoritative contract.`;
    } else {
      const placeholder = this.querySelector<HTMLElement>('#placeholder-page');
      if (placeholder) placeholder.hidden = true;
    }
    if (pageId === 'explore-page') this.renderCatalog([...this.params, ...this.signals]);
  }

  private renderCatalog(entries: CatalogEntry[]): void {
    const catalog = this.querySelector<HTMLElement & { items: CatalogEntry[] }>('#catalog');
    if (catalog) catalog.items = entries;
    const count = this.querySelector<HTMLElement>('#catalog-count');
    if (count) count.textContent = String(entries.length);
  }

  private switchCatalogTab(tab: CatalogTab): void {
    this.querySelectorAll<HTMLButtonElement>('.tab').forEach((button) =>
      button.classList.toggle('active', button.dataset.tab === tab),
    );
    if (tab === 'functions') {
      const list = this.querySelector<HTMLElement & { items: FunctionEntry[] }>('#functions');
      if (list) list.items = this.functions;
      return;
    }
    let entries: CatalogEntry[];
    if (tab === 'all') entries = [...this.params, ...this.signals];
    else if (tab === 'signals') entries = this.signals;
    else entries = this.params;
    this.renderCatalog(entries);
  }

  private async onSelectionChange(): Promise<void> {
    const catalog = this.querySelector<HTMLElement & { selectedIds: bigint[] }>('#catalog');
    const signalIds = new Set(this.signals.map((signal) => signal.id));
    this.exploreSelection = (catalog?.selectedIds ?? []).filter((id) => signalIds.has(id));
    await this.reconfigureStream();
  }

  /** Drop stream state after disconnect/resync — the server-side stream died. */
  private invalidateStream(): void {
    this.streamActive = false;
    this.streamLayout = [];
    this.querySelectorAll<ScopeElement>('tether-webgpu-scope').forEach((scope) => {
      scope.setChannels([]);
      this.scopeChannelIndex.delete(scope);
      this.scopeStats.delete(scope);
      this.scopeHistory.delete(scope);
    });
    for (const pane of [0, 1] as const) {
      const output = this.querySelector<HTMLOutputElement>(`#trend-stats-${pane}`);
      if (output) output.textContent = '';
    }
  }

  /**
   * Rebuild the single upstream stream as the union of the Explore selection
   * and both trend panes; each scope then receives only its own channels.
   */
  private async reconfigureStream(): Promise<void> {
    const signalIds = new Set(this.signals.map((signal) => signal.id));
    const panes: [string, bigint[]][] = [
      ['#scope', this.exploreSelection],
      ['#trend-scope-0', this.trendSelections[0]],
      ['#trend-scope-1', this.trendSelections[1]],
    ];
    const union: bigint[] = [];
    const seen = new Set<bigint>();
    for (const selection of panes.flatMap(([, ids]) => ids)) {
      if (signalIds.has(selection) && !seen.has(selection)) {
        seen.add(selection);
        union.push(selection);
      }
    }
    if (this.streamActive) {
      await this.client.stopStream();
      this.streamActive = false;
    }
    if (!union.length || this.client.state !== 'connected') {
      this.querySelectorAll<ScopeElement>('tether-webgpu-scope').forEach((scope) => {
        scope.setChannels([]);
        this.scopeChannelIndex.delete(scope);
        this.scopeStats.delete(scope);
        this.scopeHistory.delete(scope);
      });
      return;
    }
    await this.client.configureStream(union, this.prefs.streamMs, 20);
    this.streamLayout = this.client.currentStreamLayout.map(({ id }) => ({ id }));
    const indexOf = new Map(this.streamLayout.map((entry, index) => [entry.id, index]));
    for (const [selector, ids] of panes) {
      const scope = this.querySelector<ScopeElement>(selector);
      if (!scope) continue;
      const indices = ids
        .map((id) => indexOf.get(id))
        .filter((index): index is number => index !== undefined);
      this.scopeChannelIndex.set(scope, indices);
      const paneChannels = indices.map((layoutIndex, channel) => {
        const signal = this.signals.find((s) => s.id === this.streamLayout[layoutIndex]!.id);
        const unit = signal?.metadata?.unit;
        const quality = signal?.metadata?.quality ?? signal?.metadata?.decimation;
        return {
          name:
            (signal?.name ?? `ch${channel}`) +
            (unit ? ` [${unit}]` : '') +
            (quality ? ` ·${quality}` : ''),
          color: colors[channel % colors.length] ?? [0.5, 0.5, 0.5],
        };
      });
      const pane = selector === '#trend-scope-0' ? 0 : selector === '#trend-scope-1' ? 1 : -1;
      const derived = pane === -1 ? '' : this.paneDerivedOps[pane];
      if (derived && indices.length >= 2) {
        paneChannels.push({
          name: `derived ${derived}`,
          color: colors[paneChannels.length % colors.length] ?? [0.9, 0.9, 0.9],
        });
      }
      scope.setChannels(paneChannels);
      scope.clear();
      this.scopeHistory.delete(scope);
    }
    await this.client.startStream();
    this.streamActive = true;
  }

  private onStream(row: StreamRow): void {
    const values = row.values.map((bytes) => {
      if (bytes.length === 8)
        return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(0, true);
      if (bytes.length === 4)
        return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(0, true);
      return bytes.length ? bytes[0]! : 0;
    });
    this.querySelectorAll<ScopeElement>('tether-webgpu-scope').forEach((scope) => {
      const indices = this.scopeChannelIndex.get(scope);
      if (!indices?.length) return;
      const scoped = indices.map((i) => values[i]!);
      const pane = scope.id === 'trend-scope-0' ? 0 : scope.id === 'trend-scope-1' ? 1 : -1;
      const derived = pane === -1 ? '' : this.paneDerivedOps[pane];
      const extra = derived ? applyDerivedOp(derived, scoped) : undefined;
      const pushed = extra === undefined ? scoped : [...scoped, extra];
      scope.push(row.timestampUs, pushed);
      // Retain a bounded history for FFT and cursor statistics.
      const history = this.scopeHistory.get(scope) ?? [];
      history.push(pushed);
      if (history.length > 4096) history.splice(0, history.length - 4096);
      this.scopeHistory.set(scope, history);
      this.trackScopeStats(scope, indices, scoped);
    });
  }

  /** Per-channel last/min/max over the stream since the last reconfigure. */
  private readonly scopeStats = new WeakMap<
    ScopeElement,
    { layoutIndex: number; last: number; min: number; max: number }[]
  >();

  private trackScopeStats(scope: ScopeElement, indices: number[], values: number[]): void {
    let stats = this.scopeStats.get(scope);
    if (!stats || stats.length !== indices.length) {
      stats = indices.map((layoutIndex, i) => ({
        layoutIndex,
        last: values[i]!,
        min: values[i]!,
        max: values[i]!,
      }));
      this.scopeStats.set(scope, stats);
    } else {
      stats.forEach((stat, i) => {
        const v = values[i]!;
        stat.last = v;
        if (v < stat.min) stat.min = v;
        if (v > stat.max) stat.max = v;
      });
    }
    const pane = scope.id === 'trend-scope-0' ? 0 : scope.id === 'trend-scope-1' ? 1 : -1;
    if (pane < 0) return;
    const output = this.querySelector<HTMLOutputElement>(`#trend-stats-${pane}`);
    if (!output) return;
    output.textContent = stats
      .map((stat) => {
        const signal = this.signals.find((s) => s.id === this.streamLayout[stat.layoutIndex]?.id);
        const unit = signal?.metadata?.unit ? ` ${signal.metadata.unit}` : '';
        return `${signal?.name ?? 'ch'}: last=${formatStat(stat.last)}${unit} min=${formatStat(stat.min)} max=${formatStat(stat.max)}`;
      })
      .join('  ·  ');
  }

  private toggleScopePause(): void {
    const scope = this.querySelector<ScopeElement>('#scope');
    if (!scope) return;
    const paused = scope.togglePause();
    this.querySelector('#pause-btn')!.textContent = paused ? 'Resume' : 'Pause';
    const live = this.querySelector<HTMLElement>('#live-dot')!;
    live.textContent = paused ? 'Ⅱ PAUSED' : '● LIVE';
    live.classList.toggle('paused', paused);
    this.querySelector<HTMLButtonElement>('#reset-zoom-btn')!.hidden = !paused;
  }

  private toggleTheme(): void {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('tether-theme', next);
  }

  private setStatus(text: string, online: boolean): void {
    const status = this.querySelector<HTMLElement>('#status');
    if (status) status.textContent = text;
    status?.classList.toggle('online', online);
    const age = this.querySelector<HTMLElement>('#freshness-label');
    if (!online && age && !age.textContent?.includes('invalidated'))
      age.textContent = 'Data: stale / offline';
  }

  private showToast(message: string, kind: 'error' | 'info' = 'info'): void {
    const host = this.querySelector<HTMLElement>('#toast-host');
    if (!host) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${kind}`;
    toast.textContent = message;
    host.append(toast);
    requestAnimationFrame(() => toast.classList.add('toast-visible'));
    window.setTimeout(
      () => {
        toast.classList.remove('toast-visible');
        window.setTimeout(() => toast.remove(), 300);
      },
      kind === 'error' ? 6000 : 3000,
    );
  }
}

customElements.define('tether-app', TetherApp);
