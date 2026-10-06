/**
 * @file motion.ts
 * @brief Motion view: control-authority lease panel, validated command
 *        dispatch, and the operation ledger.
 *
 * The browser only issues bounded commands through server-validated
 * gates. Nothing here is a safety function — E-stop, STO, and hardware
 * interlocks remain independent of this UI.
 */
import {
  AlarmView,
  CommandReceiptView,
  CommandState,
  MachineAction,
  MachineActionValue,
  OperationView,
} from '../domain/machine-control';
import { ds402StateLabel } from '../domain/machine-profile';

function esc(value: string): string {
  const span = document.createElement('span');
  span.textContent = value;
  return span.innerHTML;
}

export interface LeaseView {
  scope: string;
  token: bigint;
  remainingMs: number;
}

export interface CommandAxisOption {
  stableId: string;
  name: string;
  generation: bigint;
  ds402State: number;
  stale: boolean;
  /** Descriptor-declared homing capability (supports_homing). */
  supportsHoming: boolean;
  /** Profile-defined homing state from DriveSnapshotV1 (0 = not homed). */
  homingState: number;
}

export interface MotionModel {
  controlsAvailable: boolean;
  lease?: LeaseView;
  axes: CommandAxisOption[];
  lastReceipt?: CommandReceiptView;
  /** Stable IDs currently ticked as command targets (survives re-renders). */
  selectedTargets?: string[];
  busy: boolean;
}

/** Actions the motion console exposes; everything else stays in Explore. */
const COMMAND_ACTIONS: { value: MachineActionValue; label: string }[] = [
  { value: MachineAction.Enable, label: 'Enable' },
  { value: MachineAction.Disable, label: 'Disable' },
  { value: MachineAction.QuickStop, label: 'Quick stop' },
  { value: MachineAction.FaultReset, label: 'Fault reset' },
  { value: MachineAction.JogStop, label: 'Stop jog' },
];

export function commandActionLabel(action: number): string {
  const entry = COMMAND_ACTIONS.find((a) => a.value === action);
  return entry?.label ?? `Action ${action}`;
}

export function operationStateLabel(state: number): string {
  return (
    (
      { 0: 'Queued', 1: 'Running', 2: 'Completed', 3: 'Failed', 4: 'Cancelled' } as Record<
        number,
        string
      >
    )[state] ?? `Unknown (${state})`
  );
}

export function receiptStateLabel(state: number): string {
  return (
    ({ 0: 'In progress', 1: 'Accepted', 2: 'Rejected', 3: 'Failed' } as Record<number, string>)[
      state
    ] ?? `Unknown (${state})`
  );
}

export function renderAuthorityPanel(host: HTMLElement, model: MotionModel): void {
  if (!model.controlsAvailable) {
    host.innerHTML = `<p class="widget-empty">The control-authority service is not advertised by this server. Motion commands stay disabled; this is the safe state.</p>`;
    return;
  }
  const lease = model.lease;
  const leaseLine = lease
    ? `Held · scope <strong>${esc(lease.scope)}</strong> · token ${lease.token.toString()} · ${Math.max(0, Math.round(lease.remainingMs))} ms remaining`
    : 'No lease held — acquire before dispatching commands.';
  host.innerHTML = `
    <div class="authority-row">
      <label>Scope <input id="authority-scope" value="${esc(lease?.scope ?? 'machine')}" ${lease ? 'disabled' : ''}></label>
      <label>Lease <input id="authority-lease-ms" type="number" min="1000" max="30000" step="1000" value="10000"> ms</label>
      <button data-authority="acquire" ${model.busy ? 'disabled' : ''}>Acquire</button>
      <button data-authority="renew" ${!lease || model.busy ? 'disabled' : ''}>Renew</button>
      <button data-authority="release" class="secondary" ${!lease || model.busy ? 'disabled' : ''}>Release</button>
      <button data-authority="takeover" class="secondary" ${model.busy ? 'disabled' : ''}
        title="Force-take the scope lease from its current owner. Requires a controls-engineer or administrator role; the eviction is audited.">Take over</button>
    </div>
    <p class="authority-status">${leaseLine}</p>
    <p class="event-history-note">The lease is owned by the server and expires without renewal. Disconnecting releases it and cancels in-flight operations. This is not a hold-to-run safety device.</p>`;
}

export function renderCommandPanel(host: HTMLElement, model: MotionModel): void {
  if (!model.controlsAvailable) {
    host.innerHTML = '';
    return;
  }
  const selected = new Set(model.selectedTargets ?? []);
  const axes = model.axes
    .map(
      (axis) => `
      <label class="command-target">
        <input type="checkbox" data-target="${esc(axis.stableId)}" ${selected.has(axis.stableId) ? 'checked' : ''} ${axis.stale ? 'disabled' : ''}>
        <span>${esc(axis.name)} <small>${esc(axis.stableId)} · ${ds402StateLabel(axis.ds402State)}${axis.stale ? ' · stale' : ''}</small></span>
      </label>`,
    )
    .join('');
  const jogPad = model.axes.length
    ? `<div class="jog-pad">
        <div class="panel-title"><div><span class="eyebrow">Hold-to-run</span><h3>Jog</h3></div>
          <label>Jog velocity <input id="jog-velocity" type="number" min="1" max="1000000" value="1000"> drive units/s</label></div>
        ${model.axes
          .map(
            (axis) => `<div class="jog-row">
            <span class="jog-axis">${esc(axis.name)}</span>
            <button type="button" class="jog-btn" data-jog-axis="${esc(axis.stableId)}" data-jog-dir="-1"
              aria-label="Jog ${esc(axis.name)} negative (hold)"
              ${!model.lease || axis.stale ? 'disabled' : ''}>−</button>
            <button type="button" class="jog-btn" data-jog-axis="${esc(axis.stableId)}" data-jog-dir="1"
              aria-label="Jog ${esc(axis.name)} positive (hold)"
              ${!model.lease || axis.stale ? 'disabled' : ''}>+</button>
          </div>`,
          )
          .join('')}
        <p class="event-history-note">Hold to jog: JogStart is dispatched on press and JogStop on release, blur, or disconnect — and the server enforces a bounded duration regardless. This dead-man hold is a usability control, not a safety device.</p>
      </div>`
    : '';
  const receipt = model.lastReceipt;
  const receiptHtml = receipt
    ? `<div class="command-receipt ${receipt.state === CommandState.Accepted ? 'receipt-ok' : 'receipt-bad'}">
        <strong>${receiptStateLabel(receipt.state)}</strong>
        <span>${esc(receipt.message)}</span>
        ${receipt.operationId ? `<small>operation ${esc(receipt.operationId)}</small>` : ''}
        ${receipt.auditId ? `<small>audit ${esc(receipt.auditId)}</small>` : ''}
        ${receipt.blockers.length ? `<ul>${receipt.blockers.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
      </div>`
    : '';
  host.innerHTML = `
    <div class="authority-row">
      <label>Action <select id="command-action">${COMMAND_ACTIONS.map(
        (a) => `<option value="${a.value}">${a.label}</option>`,
      ).join('')}</select></label>
      <label>Deadline <input id="command-deadline-ms" type="number" min="100" max="60000" step="100" value="5000"> ms</label>
    </div>
    <fieldset class="command-targets"><legend>Targets (state generation is sent with the command)</legend>${axes || '<p class="widget-empty">No axes discovered</p>'}</fieldset>
    ${jogPad}
    <div class="authority-row">
      <button id="command-submit" ${!model.lease || model.busy ? 'disabled' : ''}>Dispatch command</button>
      ${!model.lease ? '<span class="widget-empty">Acquire the motion lease first.</span>' : ''}
    </div>
    ${receiptHtml}`;
}

// ---------------------------------------------------------------------------
// Guided homing
// ---------------------------------------------------------------------------

/** Local guided-flow stage per axis — the server remains the validator. */
export type HomingStage = 'idle' | 'prepared' | 'running';

/**
 * Profile-defined DriveSnapshotV1 homing_state labels. 3 means the drive
 * reports a valid reference; anything lower means motion-relative position
 * must not be trusted as referenced.
 */
export function homingStateLabel(state: number): string {
  return (
    (
      { 0: 'Not homed', 1: 'Homing in progress', 2: 'Interrupted', 3: 'Referenced' } as Record<
        number,
        string
      >
    )[state] ?? `State ${state}`
  );
}

/** A DS402 state where homing is a plausible request (guidance only). */
function homingEligible(axis: CommandAxisOption): boolean {
  return axis.supportsHoming && !axis.stale && axis.ds402State >= 1 && axis.ds402State <= 4;
}

/**
 * Render the guided homing checklist: per-axis Prepare → Start → verify,
 * with cancel while a homing operation is in flight. Buttons are disabled
 * rather than hidden when prerequisites fail so the blocker is visible.
 */
export function renderHomingPanel(
  host: HTMLElement,
  model: MotionModel,
  stages: ReadonlyMap<string, HomingStage>,
  runningHoming: ReadonlySet<string>,
): void {
  if (!model.controlsAvailable) {
    host.innerHTML = `<p class="widget-empty">Homing requires the validated command service; it is not advertised by this server.</p>`;
    return;
  }
  const axes = model.axes.filter((axis) => axis.supportsHoming);
  if (!axes.length) {
    host.innerHTML = `<p class="widget-empty">No axis declares homing support in the machine descriptor.</p>`;
    return;
  }
  const canCommand = !!model.lease && !model.busy;
  host.innerHTML =
    axes
      .map((axis) => {
        const stage = stages.get(axis.stableId) ?? 'idle';
        const running = runningHoming.has(axis.stableId);
        const eligible = homingEligible(axis);
        const prereq = axis.stale
          ? 'snapshot stale'
          : !axis.supportsHoming
            ? 'not configured'
            : eligible
              ? 'ready'
              : `${ds402StateLabel(axis.ds402State)} — prepare/start blocked`;
        const step =
          stage === 'running' || running
            ? 'Step 3 · homing — watch progress in Operations'
            : stage === 'prepared'
              ? 'Step 2 · ready to start homing'
              : 'Step 1 · run Prepare first';
        return `<div class="homing-row">
        <span class="jog-axis">${esc(axis.name)} <small>${esc(axis.stableId)}</small></span>
        <span class="homing-state">${homingStateLabel(axis.homingState)}</span>
        <span class="homing-prereq">${esc(prereq)} · ${ds402StateLabel(axis.ds402State)}</span>
        <span class="homing-step">${step}</span>
        <span class="homing-actions">
          <button type="button" class="secondary" data-home-axis="${esc(axis.stableId)}" data-home-step="prepare"
            ${!canCommand || !eligible ? 'disabled' : ''}>Prepare</button>
          <button type="button" data-home-axis="${esc(axis.stableId)}" data-home-step="start"
            ${!canCommand || !eligible || (stage !== 'prepared' && !running) ? 'disabled' : ''}>Start homing</button>
          <button type="button" class="secondary" data-home-axis="${esc(axis.stableId)}" data-home-step="cancel"
            ${!canCommand || (stage === 'idle' && !running) ? 'disabled' : ''}>Cancel</button>
        </span>
      </div>`;
      })
      .join('') +
    `<p class="event-history-note">Guided homing is a sequence of validated commands — the drive's own homing method and limits apply, and the server's authority/interlock checks gate every step. A "Referenced" state confirms a valid post-home reference for that axis.</p>`;
}

export function renderOperations(tbody: HTMLElement, operations: OperationView[]): void {
  if (!operations.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="widget-empty">No operations.</td></tr>';
    return;
  }
  tbody.innerHTML = operations
    .map(
      (op) => `<tr>
        <td>${esc(op.operationId)}</td>
        <td>${commandActionLabel(op.action)}</td>
        <td>${esc(op.target)}</td>
        <td>${operationStateLabel(op.state)}</td>
        <td>${op.progress}%</td>
        <td>${esc(op.message)}</td>
      </tr>`,
    )
    .join('');
}

// ---------------------------------------------------------------------------
// Hold-to-run jog event wiring
// ---------------------------------------------------------------------------

export interface HoldToRunHandlers {
  /** Begin a bounded JogStart for `axis` in `direction` (-1/+1). */
  start(axis: string, direction: number): void;
  /** Send JogStop for `axis` (no-op when not held). */
  stop(axis: string): void;
  /** Stop every held jog (focus loss, visibility change, disconnect). */
  stopAll(): void;
}

const jogButtonOf = (event: Event) =>
  (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('.jog-btn') ?? null;

/**
 * Bind hold-to-run semantics on `.jog-btn` elements under `host`: press or
 * Space/Enter starts a bounded jog; release, pointercancel, blur, or page
 * hide stops it. Key repeats are ignored so held keys do not re-dispatch.
 * Returns a disposer removing every listener (including window/document).
 */
export function bindHoldToRunJog(host: HTMLElement, handlers: HoldToRunHandlers): () => void {
  const onPointerDown = (event: Event) => {
    const button = jogButtonOf(event);
    if (!button || button.disabled) return;
    try {
      button.setPointerCapture?.((event as PointerEvent).pointerId);
    } catch {
      /* pointer capture is an optimization; ignore unsupported environments */
    }
    handlers.start(button.dataset.jogAxis!, Number(button.dataset.jogDir));
  };
  const onPointerEnd = (event: Event) => {
    const button = jogButtonOf(event);
    if (button) handlers.stop(button.dataset.jogAxis!);
  };
  const onKeyDown = (event: Event) => {
    const keyEvent = event as KeyboardEvent;
    const button = jogButtonOf(event);
    if (!button || button.disabled || keyEvent.repeat) return;
    if (keyEvent.key === ' ' || keyEvent.key === 'Enter') {
      event.preventDefault();
      handlers.start(button.dataset.jogAxis!, Number(button.dataset.jogDir));
    }
  };
  const onKeyUp = (event: Event) => {
    const keyEvent = event as KeyboardEvent;
    const button = jogButtonOf(event);
    if (button && (keyEvent.key === ' ' || keyEvent.key === 'Enter'))
      handlers.stop(button.dataset.jogAxis!);
  };
  const onBlur = () => handlers.stopAll();
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') handlers.stopAll();
  };

  host.addEventListener('pointerdown', onPointerDown);
  host.addEventListener('pointerup', onPointerEnd);
  host.addEventListener('pointercancel', onPointerEnd);
  host.addEventListener('keydown', onKeyDown);
  host.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    host.removeEventListener('pointerdown', onPointerDown);
    host.removeEventListener('pointerup', onPointerEnd);
    host.removeEventListener('pointercancel', onPointerEnd);
    host.removeEventListener('keydown', onKeyDown);
    host.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

// ---------------------------------------------------------------------------
// Alarm lifecycle view
// ---------------------------------------------------------------------------

const alarmStateLabel = { 0: 'Active', 1: 'Acknowledged', 2: 'Cleared' } as Record<number, string>;
const alarmSeverityLabel = { 0: 'Info', 1: 'Warning', 2: 'Fault', 3: 'Critical' } as Record<
  number,
  string
>;

export function renderAlarms(tbody: HTMLElement, alarms: AlarmView[], canMutate: boolean): void {
  if (!alarms.length) {
    tbody.innerHTML =
      '<tr><td colspan="8" class="widget-empty">No alarms in the retained journal.</td></tr>';
    return;
  }
  const fmtTime = (us: bigint) => new Date(Number(us / 1000n)).toLocaleTimeString();
  tbody.innerHTML = alarms
    .map(
      (alarm) => `<tr class="${alarm.state === 0 ? 'alarm-active' : ''}">
        <td>#${alarm.alarmId.toString()} <small>${alarm.code ? `0x${alarm.code.toString(16)}` : ''}</small></td>
        <td>${alarmSeverityLabel[alarm.severity] ?? alarm.severity}</td>
        <td>${esc(alarm.sourceId)}</td>
        <td>${esc(alarm.description)}</td>
        <td>${alarmStateLabel[alarm.state] ?? alarm.state}</td>
        <td>${fmtTime(alarm.raisedUs)}</td>
        <td>${esc(alarm.actor || '—')}</td>
        <td>${
          canMutate && alarm.state === 0
            ? `<button class="secondary" data-alarm-ack="${alarm.alarmId.toString()}">Acknowledge</button>`
            : ''
        }${
          canMutate && alarm.state !== 2
            ? `<button class="secondary" data-alarm-clear="${alarm.alarmId.toString()}">Clear</button>`
            : ''
        }</td>
      </tr>`,
    )
    .join('');
}
