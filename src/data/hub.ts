/**
 * DataHub — the single owner of all machine state for the boards UI.
 *
 * Everything the old monolithic TetherApp kept in fields lives here:
 * connection lifecycle, catalogs, typed machine services, polling, bound
 * signal values, the stream mux, authority lease, and command dispatch.
 * Tiles subscribe to topics via {@link DataHub.on} and read snapshots;
 * they never poll the client themselves. Display bindings are aggregated
 * ({@link acquireBindings}) so ten tiles on one signal cost one read.
 */
import { TetherIOClient } from '../client';
import {
  discoverEventService,
  EventServiceAvailability,
  readEventCursor,
  readEventPage,
} from '../domain/event-history';
import { EventStore } from '../stores/event-store';
import {
  discoverMachineProfile,
  MachineDescriptorView,
  MachineDiagnosticsView,
  MachineProfileAvailability,
  MachineSnapshotView,
  readDriveSnapshot,
  readMachineDescriptor,
  readMachineDiagnostics,
  readMachineSnapshot,
} from '../domain/machine-profile';
import {
  AlarmMutationStatus,
  AlarmView,
  CaptureStatusView,
  CaptureTriggerSpec,
  ChecklistItemView,
  CommandReceiptView,
  CommandState,
  ConfigDiffView,
  ConfigEntryView,
  ConfigStatusView,
  ConfigTxnState,
  MachineAction,
  MachineActionValue,
  MachineControlClient,
  OperationView,
  PdoEntryView,
  RecipeInfoView,
  SdoEntryView,
  SdoResultView,
  SUPERVISOR_STATE_LABELS,
  SupervisorEntryView,
} from '../domain/machine-control';
import { AppProfile, findAppProfileEntry, readAppProfile } from '../domain/app-profile';
import { CatalogEntry, FunctionEntry, StreamRow } from '../protocol';
import { DriveSnapshotRecord } from '../views/drives';
import { CommandAxisOption, HomingStage } from '../views/motion';
import { parseBaselineFile, serializeBaseline, txnStateLabel } from '../views/commissioning';

export type HubTopic =
  | 'connection'
  | 'catalog'
  | 'profile'
  | 'snapshot'
  | 'drives'
  | 'events'
  | 'alarms'
  | 'operations'
  | 'values'
  | 'lease'
  | 'services'
  | 'receipt'
  | 'toast';

export interface LeaseState {
  scope: string;
  token: bigint;
  expiresAtMs: number;
}

const QUALITY_STALE = 1;

export class DataHub extends EventTarget {
  readonly client = new TetherIOClient();

  prefs = { url: '', pollMs: 1000, streamMs: 10 };

  // ---- Catalog -------------------------------------------------------------
  params: CatalogEntry[] = [];
  signals: CatalogEntry[] = [];
  functions: FunctionEntry[] = [];

  // ---- Discovery -----------------------------------------------------------
  profile: MachineProfileAvailability = {
    profile: 'unavailable',
    descriptor: false,
    machineSnapshot: false,
    driveSnapshots: [],
    controlsAvailable: false,
    explanation: 'Connect to a V6 server to discover available typed machine services.',
  };
  eventService: EventServiceAvailability = { available: false };
  control?: MachineControlClient;
  appProfile?: AppProfile;

  // ---- Live machine data -----------------------------------------------------
  machineDescriptor?: MachineDescriptorView;
  machineSnapshot?: MachineSnapshotView;
  machineSnapshotAt?: number;
  machineDiagnostics?: MachineDiagnosticsView;
  readonly driveData = new Map<bigint, DriveSnapshotRecord>();
  pdoEntries?: PdoEntryView[];
  supervisorEntries?: SupervisorEntryView[];
  supervisorResultText?: string;

  // ---- Events / alarms / operations ------------------------------------------
  readonly eventStore = new EventStore(200);
  readonly alarms = new Map<bigint, AlarmView>();
  private alarmCursor = 0n;
  operations: OperationView[] = [];
  lastReceipt?: CommandReceiptView;

  // ---- Authority & motion ----------------------------------------------------
  lease?: LeaseState;
  readonly heldJogs = new Map<string, number>();
  readonly homingStages = new Map<string, HomingStage>();
  controlBusy = false;

  // ---- Bound signal values (the "panels" model generalized to any tile) -----
  readonly values = new Map<string, number | string>();
  readonly history = new Map<string, number[]>();
  /** Registered binding sets per subscriber. */
  private readonly bindingSubs = new Set<Set<string>>();
  private boundKeys = new Set<string>();

  // ---- Commissioning shared state --------------------------------------------
  captureStatus?: CaptureStatusView;
  configStatus?: ConfigStatusView;
  sdoSlave = 0;
  readonly sdoForm = { index: '', subindex: '', data: '', maxBytes: '256' };
  sdoEntries?: SdoEntryView[];
  sdoResult?: SdoResultView;
  sdoPendingWrite?: {
    index: number;
    subindex: number;
    data: Uint8Array;
    current?: Uint8Array;
    entry?: SdoEntryView;
    error?: string;
  };
  baselineEntries?: ConfigEntryView[];
  baselineDiff?: ConfigDiffView;
  baselineResultText?: string;
  checklistItems?: ChecklistItemView[];
  checklistResultText?: string;
  recipes?: RecipeInfoView[];
  recipeResultText?: string;

  // ---- Stream mux --------------------------------------------------------------
  /** Subscriber → wanted signal ids + callback receiving that sub's slice. */
  private readonly streamSubs = new Map<
    symbol,
    { ids: bigint[]; cb: (timestampUs: bigint, values: number[]) => void; indices: number[] }
  >();
  private streamLayout: bigint[] = [];
  private streamActive = false;
  private streamQueued = false;

  private pollTimer?: number;
  private polling = false;
  private pollingEvents = false;

  constructor() {
    super();
    this.loadPrefs();
    this.wireClient();
  }

  // ---- Topics / helpers --------------------------------------------------------

  /** Subscribe to a topic; returns an unsubscribe function. */
  on(topic: HubTopic, cb: (event: Event) => void): () => void {
    this.addEventListener(topic, cb);
    return () => this.removeEventListener(topic, cb);
  }

  emit(topic: HubTopic): void {
    this.dispatchEvent(new Event(topic));
  }

  toast(message: string, kind: 'error' | 'info' = 'info'): void {
    this.dispatchEvent(new CustomEvent('toast', { detail: { message, kind } }));
  }

  get connected(): boolean {
    return this.client.state === 'connected';
  }

  get canCommand(): boolean {
    return !!this.lease && !!this.control?.controlsAvailable;
  }

  axesByStableId(): Map<string, import('../domain/machine-profile').MachineAxisDescriptor> {
    return new Map((this.machineDescriptor?.axes ?? []).map((a) => [a.stableId, a]));
  }

  signalByName(name: string): CatalogEntry | undefined {
    return this.signals.find((s) => s.name === name);
  }

  axisName(stableId: string): string | undefined {
    return this.commandAxes().find((a) => a.stableId === stableId)?.name;
  }

  commandAxes(): CommandAxisOption[] {
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
          (record.snapshot.qualityFlags & QUALITY_STALE) !== 0 ||
          Date.now() - record.receivedAt > 3000,
      };
    });
  }

  drives(): {
    axis?: import('../domain/machine-profile').MachineAxisDescriptor;
    snapshot: import('../domain/machine-profile').DriveSnapshotView;
    ageMs: number;
  }[] {
    const axes = this.axesByStableId();
    const out: ReturnType<DataHub['drives']> = [];
    for (const entry of this.profile.driveSnapshots) {
      const record = this.driveData.get(entry.id);
      if (!record) continue;
      out.push({
        axis: axes.get(entry.metadata?.['resource.stable_id'] ?? ''),
        snapshot: record.snapshot,
        ageMs: Math.max(0, Date.now() - record.receivedAt),
      });
    }
    return out;
  }

  activeAlarmCount(): number {
    return [...this.alarms.values()].filter((a) => a.state === 0).length;
  }

  snapshotAgeMs(): number | undefined {
    return this.machineSnapshotAt === undefined
      ? undefined
      : Math.max(0, Date.now() - this.machineSnapshotAt);
  }

  // ---- Prefs ---------------------------------------------------------------------

  private loadPrefs(): void {
    try {
      const raw = localStorage.getItem('tether.prefs');
      if (raw) Object.assign(this.prefs, JSON.parse(raw));
    } catch {
      /* keep defaults */
    }
  }

  savePrefs(): void {
    localStorage.setItem('tether.prefs', JSON.stringify(this.prefs));
  }

  // ---- Connection ------------------------------------------------------------------

  private wireClient(): void {
    this.client.addEventListener('connected', () => this.emit('connection'));
    this.client.addEventListener('reconnecting', (event: Event) => {
      const { attempt } = (event as CustomEvent<{ attempt: number }>).detail;
      this.emit('connection');
      this.toast(`Reconnecting (attempt ${attempt})`, 'info');
    });
    this.client.addEventListener('resynchronized', () => {
      void this.loadCatalogs().then(() => {
        this.control = new MachineControlClient(this.client, this.functions);
        return this.refreshProfile();
      });
      this.toast('Reconnected · catalogs re-synchronized', 'info');
    });
    this.client.addEventListener('stale', () => {
      this.driveData.clear();
      void this.invalidateStream();
      this.emit('connection');
      this.emit('drives');
    });
    this.client.addEventListener('disconnected', () => {
      this.lease = undefined;
      this.heldJogs.clear();
      this.homingStages.clear();
      void this.invalidateStream();
      this.emit('connection');
      this.emit('lease');
      this.emit('drives');
    });
    this.client.addEventListener('catalog-changed', () => {
      this.toast(
        'The schema epoch changed. Data was invalidated; reconnect to renegotiate.',
        'error',
      );
      this.emit('catalog');
    });
    this.client.addEventListener('error-message', (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      this.toast(detail.message ?? 'Protocol error', 'error');
    });
    this.client.addEventListener('stream', (event: Event) =>
      this.onStreamRow((event as CustomEvent<StreamRow>).detail),
    );
  }

  async connect(url?: string, token?: string): Promise<void> {
    let target = (url ?? this.prefs.url).trim();
    if (!target)
      target = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/tether-io`;
    const tok = token ?? '';
    const full = tok
      ? `${target}${target.includes('?') ? '&' : '?'}token=${encodeURIComponent(tok)}`
      : target;
    this.prefs.url = target;
    this.savePrefs();
    try {
      await this.client.connect(full, { enabled: true });
      await this.loadCatalogs();
      this.control = new MachineControlClient(this.client, this.functions);
      await this.refreshProfile();
      this.startPolling();
      void this.syncStream();
    } catch (error) {
      this.toast(error instanceof Error ? error.message : 'Connection failed', 'error');
      this.emit('connection');
    }
  }

  disconnect(): void {
    this.client.disconnect();
  }

  private startPolling(): void {
    if (this.pollTimer !== undefined) window.clearInterval(this.pollTimer);
    this.pollTimer = window.setInterval(() => void this.pollCycle(), this.prefs.pollMs);
  }

  restartPolling(): void {
    if (this.connected) this.startPolling();
  }

  private async pollCycle(): Promise<void> {
    await Promise.allSettled([
      this.pollDrives(),
      this.pollEvents(),
      this.pollAlarms(),
      this.pollOperations(),
      this.pollBoundValues(),
    ]);
    this.refreshLeaseState();
  }

  private async loadCatalogs(): Promise<void> {
    [this.params, this.signals, this.functions] = await Promise.all([
      this.client.list('params'),
      this.client.list('signals'),
      this.client.listFunctions(),
    ]);
    // Metadata in batches — units/ranges/enum labels feed tile defaults.
    const entries = [...this.params, ...this.signals];
    const batchSize = 24;
    for (let offset = 0; offset < entries.length; offset += batchSize) {
      await Promise.allSettled(
        entries
          .slice(offset, offset + batchSize)
          .map(async (entry) => (entry.metadata = await this.client.getMetadata(entry.id))),
      );
    }
    this.appProfile = undefined;
    const profileEntry = findAppProfileEntry(this.signals);
    if (profileEntry) {
      try {
        this.appProfile = await readAppProfile(this.client, profileEntry);
      } catch {
        this.appProfile = undefined;
      }
    }
    this.emit('catalog');
  }

  async refreshProfile(): Promise<void> {
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
        this.toast(
          error instanceof Error
            ? `Machine descriptor rejected: ${error.message}`
            : 'Machine descriptor rejected',
          'error',
        );
      }
    }
    this.emit('profile');
    await this.pollDrives();
    await this.pollEvents();
    await this.refreshCommissioning();
    if (this.control?.recipesAvailable) void this.recipesLoad();
  }

  // ---- Polling --------------------------------------------------------------------

  private async pollDrives(): Promise<void> {
    const entries = this.profile.driveSnapshots;
    if (!this.connected || this.polling || (!entries.length && !this.profile.machineSnapshotEntry))
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
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      if (result.value.kind === 'machine') {
        this.machineSnapshot = result.value.snapshot;
        this.machineSnapshotAt = Date.now();
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
    this.polling = false;
    this.emit('snapshot');
    this.emit('drives');
  }

  private async pollEvents(): Promise<void> {
    const catalog = this.client.schemaCatalog;
    const service = this.eventService;
    if (
      !this.connected ||
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
        const severe = page.events.filter((event) => event.severity >= 2);
        for (const event of severe.slice(-3)) {
          this.toast(
            `${event.severity === 3 ? 'Critical' : 'Fault'}: ${event.eventType} — ${event.description}`,
            event.severity === 3 ? 'error' : 'info',
          );
        }
        this.emit('events');
      }
    } catch {
      /* event service read failed — keep last state */
    } finally {
      this.pollingEvents = false;
    }
  }

  async pollAlarms(): Promise<void> {
    const control = this.control;
    if (!control?.controlsAvailable || !this.connected) return;
    try {
      const page = await control.readAlarms(this.alarmCursor, 50);
      for (const alarm of page.alarms) this.alarms.set(alarm.alarmId, alarm);
      this.alarmCursor = page.nextCursor;
      this.emit('alarms');
    } catch {
      /* alarm service unavailable */
    }
  }

  async alarmMutation(alarmId: bigint, clear: boolean): Promise<void> {
    const control = this.control;
    if (!control?.controlsAvailable) return;
    try {
      const status = clear
        ? await control.clearAlarm(alarmId)
        : await control.acknowledgeAlarm(alarmId);
      if (status === AlarmMutationStatus.Denied) {
        this.toast('Alarm mutation requires an authenticated operator role', 'error');
      } else if (status === AlarmMutationStatus.AbsentOrTerminal) {
        this.toast('Alarm is absent or already terminal', 'info');
      }
      const page = await control.readAlarms(0n, 100);
      this.alarms.clear();
      for (const alarm of page.alarms) this.alarms.set(alarm.alarmId, alarm);
      this.alarmCursor = page.nextCursor;
      this.emit('alarms');
    } catch (error) {
      this.toast(error instanceof Error ? error.message : 'Alarm mutation failed', 'error');
    }
  }

  async pollOperations(): Promise<void> {
    const control = this.control;
    if (!control?.controlsAvailable || !this.connected) return;
    try {
      this.operations = await control.listOperations(32);
      const running = this.runningHomingAxes();
      for (const [axisId, stage] of this.homingStages) {
        if (stage === 'running' && !running.has(axisId)) this.homingStages.set(axisId, 'idle');
      }
      this.emit('operations');
    } catch {
      /* operation ledger unavailable */
    }
  }

  runningHomingAxes(): Set<string> {
    const running = new Set<string>();
    for (const op of this.operations) {
      if (
        (op.action === MachineAction.HomeStart || op.action === MachineAction.HomePrepare) &&
        (op.state === 0 || op.state === 1)
      )
        running.add(op.target);
    }
    return running;
  }

  // ---- Bound signal values ---------------------------------------------------------

  /**
   * Register a set of binding keys (`entry` or `entry.field`) the caller needs
   * polled. Keys are deduplicated across all subscribers; the returned function
   * releases the caller's set.
   */
  acquireBindings(keys: Iterable<string>): () => void {
    const set = new Set(keys);
    this.bindingSubs.add(set);
    this.recomputeBindings();
    return () => {
      this.bindingSubs.delete(set);
      this.recomputeBindings();
    };
  }

  private recomputeBindings(): void {
    const next = new Set<string>();
    for (const sub of this.bindingSubs) for (const key of sub) next.add(key);
    this.boundKeys = next;
  }

  private async pollBoundValues(): Promise<void> {
    if (!this.connected || !this.boundKeys.size) return;
    const byName = new Map(this.signals.map((s) => [s.name, s]));
    let changed = false;
    for (const key of this.boundKeys) {
      const [entryName, field] = splitKey(key);
      const entry = entryName ? byName.get(entryName) : undefined;
      if (!entry) continue;
      try {
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
          field &&
          value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          !(value instanceof Uint8Array)
        ) {
          value = (value as Record<string, unknown>)[field] as never;
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
        if (this.values.get(key) !== normalized) {
          this.values.set(key, normalized);
          changed = true;
        }
        if (typeof normalized === 'number') {
          const hist = this.history.get(key) ?? [];
          hist.push(normalized);
          if (hist.length > 120) hist.shift();
          this.history.set(key, hist);
        }
      } catch {
        /* single-entry read failure leaves the last value in place */
      }
    }
    if (changed) this.emit('values');
  }

  // ---- Stream mux -------------------------------------------------------------------

  /**
   * Register a stream consumer for a set of signal ids. The hub unions every
   * subscriber into one upstream stream and calls `cb` with that subscriber's
   * slice of each row. Returns an unsubscribe function.
   */
  subscribeStream(ids: bigint[], cb: (timestampUs: bigint, values: number[]) => void): () => void {
    const token = Symbol('stream');
    this.streamSubs.set(token, { ids, cb, indices: [] });
    void this.syncStream();
    return () => {
      this.streamSubs.delete(token);
      void this.syncStream();
    };
  }

  /** Debounced union → single configureStream. */
  private async syncStream(): Promise<void> {
    if (this.streamQueued) return;
    this.streamQueued = true;
    await Promise.resolve();
    this.streamQueued = false;
    const signalIds = new Set(this.signals.map((s) => s.id));
    const union: bigint[] = [];
    const seen = new Set<bigint>();
    for (const sub of this.streamSubs.values()) {
      for (const id of sub.ids) {
        if (signalIds.has(id) && !seen.has(id)) {
          seen.add(id);
          union.push(id);
        }
      }
    }
    try {
      if (this.streamActive) {
        await this.client.stopStream();
        this.streamActive = false;
      }
      if (!union.length || !this.connected) {
        this.streamLayout = [];
        for (const sub of this.streamSubs.values()) sub.indices = [];
        return;
      }
      await this.client.configureStream(union, this.prefs.streamMs, 20);
      this.streamLayout = this.client.currentStreamLayout.map((entry) => entry.id);
      const indexOf = new Map(this.streamLayout.map((id, index) => [id, index]));
      for (const sub of this.streamSubs.values()) {
        sub.indices = sub.ids
          .map((id) => indexOf.get(id))
          .filter((index): index is number => index !== undefined);
      }
      await this.client.startStream();
      this.streamActive = true;
      this.emit('snapshot'); // lets tiles re-read channel names
    } catch (error) {
      console.warn('[hub] stream reconfigure failed', error);
    }
  }

  private async invalidateStream(): Promise<void> {
    this.streamActive = false;
    this.streamLayout = [];
    for (const sub of this.streamSubs.values()) sub.indices = [];
  }

  private onStreamRow(row: StreamRow): void {
    const values = row.values.map((bytes) => {
      if (bytes.length === 8)
        return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(0, true);
      if (bytes.length === 4)
        return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(0, true);
      return bytes.length ? bytes[0]! : 0;
    });
    for (const sub of this.streamSubs.values()) {
      if (!sub.indices.length) continue;
      sub.cb(
        row.timestampUs,
        sub.indices.map((i) => values[i]!),
      );
    }
  }

  // ---- Authority ---------------------------------------------------------------------

  private refreshLeaseState(): void {
    if (this.lease && Date.now() >= this.lease.expiresAtMs) {
      this.lease = undefined;
      this.toast('Motion lease expired; re-acquire to issue further commands.', 'error');
      this.emit('lease');
    } else if (this.lease) {
      this.emit('lease');
    }
  }

  async authorityAction(
    action: 'acquire' | 'renew' | 'release' | 'takeover',
    scope: string,
    leaseMs: number,
  ): Promise<void> {
    const control = this.control;
    if (!control?.controlsAvailable || this.controlBusy) return;
    this.setBusy(true);
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
          this.toast(result.blocker || 'Authority was not granted', 'error');
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
          if (result.blocker) this.toast(result.blocker, 'error');
        }
      }
    } catch (error) {
      this.toast(error instanceof Error ? error.message : 'Authority request failed', 'error');
      if (action !== 'acquire') this.lease = undefined;
    } finally {
      this.setBusy(false);
      this.emit('lease');
    }
  }

  private setBusy(busy: boolean): void {
    this.controlBusy = busy;
    this.emit('services');
  }

  // ---- Commands / jog / homing ---------------------------------------------------------

  private static jogParameters(velocity: number, durationMs: number): Uint8Array {
    const bytes = new Uint8Array(10);
    const view = new DataView(bytes.buffer);
    bytes[0] = 4;
    view.setInt32(1, velocity, true);
    bytes[5] = 5;
    view.setUint32(6, durationMs, true);
    return bytes;
  }

  async startJog(axisId: string, direction: number, velocity: number): Promise<void> {
    const control = this.control;
    const lease = this.lease;
    const axis = this.commandAxes().find((a) => a.stableId === axisId);
    if (!control?.controlsAvailable || !lease || !axis || axis.stale || this.heldJogs.has(axisId))
      return;
    const v = Math.min(1_000_000, Math.max(1, velocity));
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
          parameters: DataHub.jogParameters(direction * v, durationMs),
        },
        { deadlineUs: 3_000_000n },
      );
      if (receipt.state !== CommandState.Accepted) {
        this.heldJogs.delete(axisId);
        this.toast(receipt.blockers[0] ?? receipt.message ?? 'Jog rejected', 'error');
      }
      void this.pollOperations();
    } catch (error) {
      this.heldJogs.delete(axisId);
      this.toast(error instanceof Error ? error.message : 'Jog failed', 'error');
    }
  }

  async stopJog(axisId: string): Promise<void> {
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
      /* the server bounds jog duration regardless */
    }
  }

  async stopAllJogs(): Promise<void> {
    for (const axisId of [...this.heldJogs.keys()]) await this.stopJog(axisId);
  }

  /** Single-target dispatch through the audited path (profile 'command' widget). */
  async dispatchAction(action: MachineActionValue, axisId: string): Promise<void> {
    const control = this.control;
    const lease = this.lease;
    const axis = this.commandAxes().find((a) => a.stableId === axisId);
    if (!control?.controlsAvailable || !lease || !axis || axis.stale || this.controlBusy) return;
    this.setBusy(true);
    try {
      const receipt = await control.command(
        {
          requestUuid: crypto.randomUUID(),
          scope: lease.scope,
          authorityToken: lease.token,
          action,
          targets: [axis.stableId],
          expectedGenerations: [axis.generation],
          deadlineUs: 5_000_000n,
        },
        { deadlineUs: 7_000_000n },
      );
      this.lastReceipt = receipt;
      this.emit('receipt');
      if (receipt.state !== CommandState.Accepted)
        this.toast(receipt.blockers[0] ?? receipt.message ?? 'Command rejected', 'error');
      void this.pollOperations();
    } catch (error) {
      this.toast(error instanceof Error ? error.message : 'Command dispatch failed', 'error');
    } finally {
      this.setBusy(false);
    }
  }

  /** Multi-target dispatch from the command panel. */
  async dispatchCommand(
    action: MachineActionValue,
    targets: string[],
    deadlineMs: number,
  ): Promise<void> {
    const control = this.control;
    if (!control?.controlsAvailable || !this.lease || this.controlBusy) return;
    const selected = this.commandAxes().filter((axis) => targets.includes(axis.stableId));
    if (!selected.length) {
      this.toast('Select at least one axis target', 'error');
      return;
    }
    this.setBusy(true);
    try {
      const receipt = await control.command(
        {
          requestUuid: crypto.randomUUID(),
          scope: this.lease.scope,
          authorityToken: this.lease.token,
          action,
          targets: selected.map((axis) => axis.stableId),
          expectedGenerations: selected.map((axis) => axis.generation),
          deadlineUs: BigInt(deadlineMs) * 1000n,
        },
        { deadlineUs: BigInt(deadlineMs) * 1000n + 2_000_000n },
      );
      this.lastReceipt = receipt;
      this.emit('receipt');
      if (receipt.state !== CommandState.Accepted) {
        this.toast(
          receipt.blockers[0] ?? receipt.message ?? 'Command rejected',
          receipt.state === CommandState.Rejected ? 'error' : 'info',
        );
      }
      await this.pollOperations();
      void this.pollAlarms();
    } catch (error) {
      this.toast(error instanceof Error ? error.message : 'Command dispatch failed', 'error');
    } finally {
      this.setBusy(false);
    }
  }

  /** Zero-argument machine function invocation (profile 'button' widget). */
  async invokeFunction(name: string): Promise<void> {
    const fn = this.functions.find((f) => f.name === name);
    if (!fn || !this.connected) {
      this.toast(`Function ${name} is not advertised by this server`, 'error');
      return;
    }
    try {
      await this.client.callFunctionOrThrow(fn.id, []);
      this.toast(`${name} accepted`, 'info');
    } catch (error) {
      this.toast(error instanceof Error ? error.message : `${name} failed`, 'error');
    }
  }

  async homingAction(axisId: string, step: string): Promise<void> {
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
    this.setBusy(true);
    try {
      const receipt = await control.command(
        {
          requestUuid: crypto.randomUUID(),
          scope: lease.scope,
          authorityToken: lease.token,
          action,
          targets: [axisId],
          expectedGenerations: [axis.generation],
          deadlineUs: 30_000_000n,
        },
        { deadlineUs: 32_000_000n },
      );
      this.lastReceipt = receipt;
      this.emit('receipt');
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
        this.toast(receipt.blockers[0] ?? receipt.message ?? 'Homing step rejected', 'error');
        if (action === MachineAction.HomeCancel) this.homingStages.delete(axisId);
      }
      await this.pollOperations();
    } catch (error) {
      this.toast(error instanceof Error ? error.message : 'Homing request failed', 'error');
    } finally {
      this.setBusy(false);
    }
  }

  // ---- Commissioning -------------------------------------------------------------------

  async refreshCommissioning(): Promise<void> {
    const control = this.control;
    if (!control || !this.connected) return;
    const [capture, config] = await Promise.allSettled([
      control.captureAvailable ? control.captureStatus() : Promise.resolve(undefined),
      control.configAvailable ? control.configStatus() : Promise.resolve(undefined),
    ]);
    if (capture.status === 'fulfilled' && capture.value) this.captureStatus = capture.value;
    if (config.status === 'fulfilled' && config.value) this.configStatus = config.value;
    this.emit('services');
  }

  async supervisorRetry(slave: number): Promise<void> {
    const control = this.control;
    if (!control?.supervisorAvailable) return;
    try {
      const result = await control.supervisorRetry(slave);
      const label = SUPERVISOR_STATE_LABELS[result.state] ?? `state ${result.state}`;
      this.supervisorResultText = result.ok
        ? `Retry accepted for slave ${slave} — supervisor state: ${label}.`
        : `Retry rejected for slave ${slave}: ${result.error || label}.`;
      this.toast(
        result.ok
          ? `Recovery retry requested for slave ${slave}`
          : result.error || 'Retry rejected',
        result.ok ? 'info' : 'error',
      );
      // Refresh the table immediately so the new state/attempt count shows.
      this.supervisorEntries = await control.supervisorStatus();
    } catch (error) {
      this.supervisorResultText = `Retry request failed: ${(error as Error).message}`;
      this.toast((error as Error).message, 'error');
    }
    this.emit('drives');
  }

  async captureSubmit(config: {
    name: string;
    rateHz: number;
    enabled: boolean;
    trigger?: CaptureTriggerSpec;
    template?: number;
  }): Promise<void> {
    const control = this.control;
    if (!control?.captureAvailable || this.controlBusy) return;
    this.setBusy(true);
    try {
      this.captureStatus = await control.configureCapture(
        config.name,
        config.rateHz,
        config.enabled,
        [],
        config.trigger,
        config.template,
      );
    } catch (error) {
      this.toast(error instanceof Error ? error.message : 'Capture configure failed', 'error');
    } finally {
      this.setBusy(false);
      this.emit('services');
    }
  }

  async captureCancel(): Promise<void> {
    const control = this.control;
    if (!control?.captureAvailable || this.controlBusy) return;
    this.setBusy(true);
    try {
      this.captureStatus = await control.captureCancel();
    } catch (error) {
      this.toast(error instanceof Error ? error.message : 'Capture cancel failed', 'error');
    } finally {
      this.setBusy(false);
      this.emit('services');
    }
  }

  async captureExport(): Promise<void> {
    const control = this.control;
    if (!control?.captureAvailable || this.controlBusy) return;
    this.setBusy(true);
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
      this.toast(`Exported ${total.toString()} records`, 'info');
    } catch (error) {
      this.toast(error instanceof Error ? error.message : 'Capture export failed', 'error');
    } finally {
      this.setBusy(false);
      this.emit('services');
    }
  }

  async configStage(entryId: bigint, value: Uint8Array): Promise<void> {
    const control = this.control;
    if (!control?.configAvailable || this.controlBusy) return;
    this.setBusy(true);
    try {
      this.configStatus = await control.stageConfig([{ entryId, value }]);
      this.toastConfigResult(this.configStatus, 'staged');
    } catch (error) {
      this.toast(error instanceof Error ? error.message : 'Stage failed', 'error');
    } finally {
      this.setBusy(false);
      this.emit('services');
    }
  }

  async configVerb(verb: 'validate' | 'commit' | 'rollback'): Promise<void> {
    const control = this.control;
    if (!control?.configAvailable || this.controlBusy) return;
    this.setBusy(true);
    try {
      this.configStatus = await (verb === 'validate'
        ? control.validateConfig()
        : verb === 'commit'
          ? control.commitConfig()
          : control.rollbackConfig());
      this.toastConfigResult(this.configStatus, verb);
    } catch (error) {
      this.toast(error instanceof Error ? error.message : `config.${verb} failed`, 'error');
    } finally {
      this.setBusy(false);
      this.emit('services');
    }
  }

  private toastConfigResult(status: ConfigStatusView, verb: string): void {
    if (status.state === ConfigTxnState.Failed)
      this.toast(status.message || `config.${verb} failed`, 'error');
  }

  async baselineExport(): Promise<void> {
    const control = this.control;
    if (!control?.configBaselineAvailable || this.controlBusy) return;
    this.setBusy(true);
    try {
      const result = await control.configExport();
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
    } finally {
      this.setBusy(false);
      this.emit('services');
    }
  }

  baselineLoadFile(file: File): void {
    void file.text().then((text) => {
      const entries = parseBaselineFile(text);
      if (!entries) {
        this.baselineResultText = 'baseline file rejected: not tether.config.baseline.v1 JSON';
        this.toast('Baseline file rejected', 'error');
      } else {
        this.baselineEntries = entries;
        this.baselineDiff = undefined;
        this.baselineResultText = `loaded ${entries.length} baseline entries`;
      }
      this.emit('services');
    });
  }

  async baselineDiffRun(): Promise<void> {
    const control = this.control;
    if (!control?.configBaselineAvailable || !this.baselineEntries) return;
    this.setBusy(true);
    try {
      this.baselineDiff = await control.configDiff(this.baselineEntries);
      this.baselineResultText =
        this.baselineDiff.diffs.length === 0
          ? `live config matches baseline at revision ${this.baselineDiff.revision.toString()}`
          : `${this.baselineDiff.diffs.length} parameter(s) differ from the baseline`;
    } catch (error) {
      this.baselineResultText = `diff failed: ${(error as Error).message}`;
    } finally {
      this.setBusy(false);
      this.emit('services');
    }
  }

  async baselineImport(): Promise<void> {
    const control = this.control;
    if (!control?.configBaselineAvailable || !this.baselineEntries) return;
    this.setBusy(true);
    try {
      this.configStatus = await control.configImport(this.baselineEntries);
      this.baselineResultText =
        `imported ${this.baselineEntries.length} entries into ` +
        `txn ${this.configStatus.transactionId.toString()} (${txnStateLabel(this.configStatus.state)})`;
      if (this.configStatus.state === ConfigTxnState.Failed)
        this.toast(`Import rejected: ${this.configStatus.message}`, 'error');
    } catch (error) {
      this.baselineResultText = `import failed: ${(error as Error).message}`;
      this.toast((error as Error).message, 'error');
    } finally {
      this.setBusy(false);
      this.emit('services');
    }
  }

  async checklistList(): Promise<void> {
    const control = this.control;
    if (!control?.checklistAvailable) return;
    this.setBusy(true);
    try {
      this.checklistItems = await control.checklistList();
      this.checklistResultText = `${this.checklistItems.length} items evaluated`;
    } catch (error) {
      this.checklistResultText = `checklist read failed: ${(error as Error).message}`;
    } finally {
      this.setBusy(false);
      this.emit('services');
    }
  }

  async checklistReport(): Promise<void> {
    const control = this.control;
    if (!control?.checklistAvailable) return;
    this.setBusy(true);
    try {
      const report = await control.checklistReport();
      this.checklistItems = report.items;
      this.checklistResultText =
        `acceptance report recorded · revision ${report.revision.toString()} · ` +
        `${report.items.length} items · all required passed`;
      this.toast('Acceptance report recorded in the audit journal', 'info');
    } catch (error) {
      this.checklistResultText = `report refused: ${(error as Error).message}`;
      this.toast((error as Error).message, 'error');
      this.setBusy(false);
      await this.checklistList();
      return;
    } finally {
      this.setBusy(false);
      this.emit('services');
    }
  }

  async sdoList(): Promise<void> {
    const control = this.control;
    if (!control?.sdoAvailable || this.controlBusy) return;
    this.setBusy(true);
    this.emit('services');
    try {
      this.sdoEntries = await control.sdoList(this.sdoSlave);
    } catch (error) {
      this.sdoEntries = undefined;
      this.toast(error instanceof Error ? error.message : 'sdo.list failed', 'error');
    } finally {
      this.setBusy(false);
      this.emit('services');
    }
  }

  async sdoRead(index: number, subindex: number, maxBytes: number): Promise<void> {
    const control = this.control;
    if (!control?.sdoAvailable || this.controlBusy) return;
    this.setBusy(true);
    this.emit('services');
    try {
      this.sdoResult = await control.sdoRead(this.sdoSlave, index, subindex, maxBytes);
      if (!this.sdoResult.ok) this.toast(this.sdoResult.error || 'SDO transfer aborted', 'error');
    } catch (error) {
      this.sdoResult = undefined;
      this.toast(error instanceof Error ? error.message : 'SDO transfer failed', 'error');
    } finally {
      this.setBusy(false);
      this.emit('services');
    }
  }

  async sdoPreviewWrite(index: number, subindex: number, data: Uint8Array): Promise<void> {
    const control = this.control;
    if (!control?.sdoAvailable || this.controlBusy) return;
    const entry = this.sdoEntries?.find((e) => e.index === index && e.subindex === subindex);
    if (entry && entry.access === 1) {
      this.toast(`0x${index.toString(16)}:${subindex.toString(16)} is read-only`, 'error');
      return;
    }
    this.setBusy(true);
    this.emit('services');
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
      this.setBusy(false);
      this.emit('services');
    }
  }

  async sdoConfirmWrite(): Promise<void> {
    const control = this.control;
    const pending = this.sdoPendingWrite;
    if (!control?.sdoAvailable || !pending || this.controlBusy) return;
    this.setBusy(true);
    this.emit('services');
    try {
      this.sdoResult = await control.sdoWrite(
        this.sdoSlave,
        pending.index,
        pending.subindex,
        pending.data,
      );
      this.sdoPendingWrite = undefined;
      if (!this.sdoResult.ok)
        this.toast(
          this.sdoResult.error || this.sdoResult.abortName || 'SDO write aborted',
          'error',
        );
    } catch (error) {
      this.toast(error instanceof Error ? error.message : 'SDO write failed', 'error');
    } finally {
      this.setBusy(false);
      this.emit('services');
    }
  }

  sdoCancelWrite(): void {
    this.sdoPendingWrite = undefined;
    this.emit('services');
  }

  async recipesLoad(): Promise<void> {
    const control = this.control;
    if (!control?.recipesAvailable) return;
    this.setBusy(true);
    try {
      this.recipes = await control.recipeList();
      this.recipeResultText = `${this.recipes.length} recipe(s) available`;
    } catch (error) {
      this.recipeResultText = `recipe list failed: ${(error as Error).message}`;
    } finally {
      this.setBusy(false);
      this.emit('services');
    }
  }

  async recipeApply(name: string): Promise<void> {
    const control = this.control;
    if (!control?.recipesAvailable) return;
    this.setBusy(true);
    try {
      const status = await control.recipeApply(name);
      this.configStatus = status;
      this.recipeResultText =
        `'${name}' staged as txn ${status.transactionId.toString()} ` +
        `(${txnStateLabel(status.state)}) — validate + commit in the config tool`;
      if (status.state === ConfigTxnState.Failed)
        this.toast(`Recipe rejected: ${status.message}`, 'error');
      else this.toast(`Recipe '${name}' staged (not committed)`, 'info');
    } catch (error) {
      this.recipeResultText = `recipe apply failed: ${(error as Error).message}`;
      this.toast((error as Error).message, 'error');
    } finally {
      this.setBusy(false);
      this.emit('services');
    }
  }
}

/** Split `entry.field` (field is a single dotted segment; entries never contain dots). */
function splitKey(key: string): [string, string | undefined] {
  const dot = key.indexOf('.');
  return dot < 0 ? [key, undefined] : [key.slice(0, dot), key.slice(dot + 1)];
}
