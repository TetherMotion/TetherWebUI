import {
  DriveSnapshotView,
  MachineAxisDescriptor,
  alStateLabel,
  ds402StateLabel,
} from '../domain/machine-profile';
import { CatalogEntry } from '../protocol';

export interface DriveSnapshotRecord {
  snapshot: DriveSnapshotView;
  receivedAt: number;
}

type DriveSelection = (entry: CatalogEntry, snapshot: DriveSnapshotView, ageMs: number) => void;

interface DriveCardModel {
  entry: CatalogEntry;
  name: string;
  axis?: MachineAxisDescriptor;
  snapshot: DriveSnapshotView;
  ageMs: number;
}

interface DriveCardInput {
  entry: CatalogEntry;
  name: string;
  axis?: MachineAxisDescriptor;
  snapshot?: DriveSnapshotView;
  ageMs?: number;
}

/** Statusword warning bit (CiA 402 bit 7). */
const WARNING_BIT = 1 << 7;
/** |following_error| above this many raw counts is surfaced as an anomaly. */
const FOLLOWING_ERROR_ANOMALY_COUNTS = 50;
/** |target − actual| at or below this many raw counts reads as "at target". */
const AT_TARGET_COUNTS = 5;

type Tone = 'healthy' | 'caution' | 'fault' | 'muted' | 'unknown';

export interface DriveCondition {
  pill: string;
  tone: Tone;
  /** Interpreted situation line: mode + position semantics. */
  interp: string;
  /** Abnormal conditions surfaced in the compact header. */
  anomalies: string[];
}

/**
 * Interpret a drive snapshot for the operator: nominal conditions collapse
 * to a short situation line; only abnormal details (bus not OP, faults,
 * warnings, stale data, large following error) surface in the compact view.
 */
export function interpretDrive({
  snapshot,
  ageMs,
  axis,
}: Pick<DriveCardModel, 'snapshot' | 'ageMs' | 'axis'>): DriveCondition {
  const s = snapshot;
  const anomalies: string[] = [];
  const faulted = s.faultCode !== 0 || s.ds402State === 7;
  const warning = (s.statusWord & WARNING_BIT) !== 0;
  const stale = (s.qualityFlags & 1) !== 0 || ageMs > 3000;
  const busAbnormal = s.alState !== 8 || s.alStatusCode !== 0;

  let pill: string;
  let tone: Tone;
  if (faulted) {
    pill = `Fault 0x${s.faultCode.toString(16).padStart(4, '0')}`;
    tone = 'fault';
  } else if (stale) {
    pill = 'Stale';
    tone = 'muted';
    anomalies.push('snapshot stale — values may not reflect the drive');
  } else if (warning) {
    pill = 'Warning';
    tone = 'caution';
    anomalies.push('statusword warning bit set');
  } else if (s.ds402State === 4) {
    pill = 'Enabled';
    tone = 'healthy';
  } else {
    pill = ds402StateLabel(s.ds402State);
    tone = 'muted';
  }
  if (faulted) anomalies.push('drive stopped — clear the cause, then Fault reset');
  if (busAbnormal) {
    anomalies.push(
      `bus ${alStateLabel(s.alState)}${s.alStatusCode ? ` · AL status 0x${s.alStatusCode.toString(16).padStart(4, '0')}` : ''}`,
    );
  }
  if (Math.abs(s.followingError) > FOLLOWING_ERROR_ANOMALY_COUNTS) {
    anomalies.push(`following error ${formatPosition(s.followingError, axis)}`);
  }

  const atTarget = Math.abs(s.targetPosition - s.actualPosition) <= AT_TARGET_COUNTS;
  let motion: string;
  if (s.homingState === 1) {
    motion = 'homing in progress';
  } else if (s.homingState === 2) {
    motion = `homing interrupted · at ${formatPosition(s.actualPosition, axis)}`;
  } else {
    motion = atTarget
      ? `at ${formatPosition(s.actualPosition, axis)}`
      : `→ ${formatPosition(s.targetPosition, axis)}`;
  }
  return { pill, tone, interp: `${modeLabel(s.displayMode)} · ${motion}`, anomalies };
}

export function renderDriveViews(
  root: ParentNode,
  entries: CatalogEntry[],
  driveData: Map<bigint, DriveSnapshotRecord>,
  onSelect: DriveSelection,
  axesByStableId: ReadonlyMap<string, MachineAxisDescriptor> = new Map(),
): void {
  const list = root.querySelector<HTMLElement>('#drive-card-list');
  const summary = root.querySelector<HTMLElement>('#overview-drive-list');
  const widgets = root.querySelector<HTMLElement>('#drive-state-widgets');
  if (!list || !summary) return;
  // Cards rebuild every poll — remember which drives the user expanded.
  const openDrives = new Set(
    [...root.querySelectorAll<HTMLDetailsElement>('details.drive-card[open]')]
      .map((el) => el.dataset.driveName ?? '')
      .filter(Boolean),
  );
  list.replaceChildren();
  summary.replaceChildren();
  widgets?.replaceChildren();
  const axisFor = (entry: CatalogEntry) =>
    axesByStableId.get(entry.metadata?.['resource.stable_id'] ?? '');
  const displayName = (entry: CatalogEntry) => axisFor(entry)?.name ?? entry.name;
  const sortedEntries = [...entries].sort((a, b) => displayName(a).localeCompare(displayName(b)));
  let enabledCount = 0;
  let faultCount = 0;
  for (const entry of sortedEntries) {
    const name = displayName(entry);
    const data = driveData.get(entry.id);
    const open = openDrives.has(name);
    if (!data) {
      list.append(buildDriveCard({ entry, name }, open));
      widgets?.append(buildDriveCard({ entry, name }, open));
      continue;
    }
    const model: DriveCardModel = {
      entry,
      name,
      axis: axisFor(entry),
      snapshot: data.snapshot,
      ageMs: Math.max(0, Date.now() - data.receivedAt),
    };
    if (model.snapshot.ds402State === 4) enabledCount += 1;
    if (model.snapshot.faultCode !== 0 || model.snapshot.ds402State === 7) faultCount += 1;
    list.append(buildDriveCard(model, open));
    widgets?.append(buildDriveCard(model, open));
    appendOverviewDrive(summary, model, onSelect);
  }
  if (!sortedEntries.length) {
    const empty = document.createElement('p');
    empty.className = 'widget-empty';
    empty.textContent = 'No schema-backed drive snapshots are available for this machine.';
    widgets?.append(empty);
    list.append(empty.cloneNode(true));
  }
  const driveSummary = root.querySelector<HTMLElement>('#drive-summary');
  if (driveSummary && entries.length) {
    const liveCount = [...driveData.keys()].filter((id) =>
      entries.some((entry) => entry.id === id),
    ).length;
    driveSummary.textContent = `${liveCount} live · ${enabledCount} enabled · ${faultCount} faulted`;
  }
}

/** Compact interpreted card; expansion reveals the raw snapshot fields. */
function buildDriveCard(model: DriveCardInput, open = false): HTMLDetailsElement {
  const card = document.createElement('details');
  card.className = 'drive-card';
  card.dataset.driveName = model.name;
  if (open) card.open = true;
  const summary = document.createElement('summary');
  summary.className = 'drive-card-head';

  const name = document.createElement('span');
  name.className = 'drive-name';
  name.textContent = model.name;
  summary.append(name);

  if (model.snapshot === undefined) {
    const waiting = document.createElement('span');
    waiting.className = 'drive-interp';
    waiting.textContent = 'waiting for a coherent snapshot';
    const pill = document.createElement('span');
    pill.className = 'drive-pill unknown';
    pill.textContent = 'Waiting';
    summary.append(waiting, pill);
    card.append(summary);
    return card;
  }

  const condition = interpretDrive(model as DriveCardModel);
  card.classList.add(`drive-card-${condition.tone}`);

  const interp = document.createElement('span');
  interp.className = 'drive-interp';
  interp.textContent = condition.interp;
  summary.append(interp);

  for (const anomaly of condition.anomalies) {
    const chip = document.createElement('span');
    chip.className = 'drive-anomaly';
    chip.textContent = anomaly;
    summary.append(chip);
  }

  const pill = document.createElement('span');
  pill.className = `drive-pill ${condition.tone}`;
  pill.textContent = condition.pill;
  summary.append(pill);

  const age = document.createElement('small');
  age.className = 'drive-age';
  age.textContent = `${model.ageMs ?? 0} ms`;
  summary.append(age);

  card.append(summary, buildDriveDetail(model as DriveCardModel));
  return card;
}

function appendOverviewDrive(
  container: HTMLElement,
  model: DriveCardModel,
  onSelect: DriveSelection,
): void {
  const condition = interpretDrive(model);
  const card = document.createElement('button');
  card.className = 'overview-drive-row';
  card.textContent = `${model.name} · ${condition.pill} · ${condition.interp}`;
  card.addEventListener('click', () => onSelect(model.entry, model.snapshot, model.ageMs));
  container.append(card);
}

/** Raw snapshot fields shown only inside the expanded card. */
function buildDriveDetail(model: DriveCardModel): HTMLElement {
  const { snapshot: s, axis } = model;
  const detail = document.createElement('div');
  detail.className = 'drive-detail';

  const metrics = document.createElement('div');
  metrics.className = 'detail-grid';
  const hex = (v: number, w = 4) => `0x${v.toString(16).padStart(w, '0')}`;
  appendMetric(metrics, 'CiA 402 state', ds402StateLabel(s.ds402State));
  appendMetric(metrics, 'Mode', `${modeLabel(s.displayMode)} (${s.displayMode})`);
  appendMetric(
    metrics,
    'EtherCAT AL',
    `${alStateLabel(s.alState)}${s.alStatusCode ? ` · ${hex(s.alStatusCode)}` : ''}`,
  );
  appendMetric(
    metrics,
    'Target / actual',
    `${formatPosition(s.targetPosition, axis)} / ${formatPosition(s.actualPosition, axis)}`,
  );
  appendMetric(metrics, 'Demand position', formatPosition(s.demandPosition, axis));
  appendMetric(metrics, 'Following error', formatPosition(s.followingError, axis));
  appendMetric(
    metrics,
    'Velocity target/actual',
    `${formatVelocity(s.targetVelocity, axis)} / ${formatVelocity(s.actualVelocity, axis)}`,
  );
  appendMetric(metrics, 'Torque target/actual', `${s.targetTorque} / ${s.actualTorque} ‰`);
  appendMetric(metrics, 'Target mode', `${modeLabel(s.targetMode)} (${s.targetMode})`);
  appendMetric(metrics, 'Controlword', hex(s.controlWord));
  appendMetric(metrics, 'Statusword', hex(s.statusWord));
  appendMetric(metrics, 'Fault code', hex(s.faultCode));
  appendMetric(
    metrics,
    'Quality',
    (s.qualityFlags ? `flags ${hex(s.qualityFlags, 2)}` : 'good') +
      ` · generation ${s.stateGeneration.toString()}`,
  );
  detail.append(metrics);

  const bits: [string, number][] = [
    ['Ready to switch on', 0],
    ['Switched on', 1],
    ['Operation enabled', 2],
    ['Fault', 3],
    ['Voltage enabled', 4],
    ['Quick stop', 5],
    ['Switch-on disabled', 6],
    ['Warning', 7],
    ['Remote', 9],
    ['Target reached', 10],
    ['Internal limit active', 11],
  ];
  const table = document.createElement('table');
  table.className = 'bit-table';
  const headerRow = table.createTHead().insertRow();
  for (const label of ['Statusword bit', 'Meaning', 'Value']) {
    const cell = document.createElement('th');
    cell.textContent = label;
    headerRow.append(cell);
  }
  const tableBody = table.createTBody();
  for (const [label, bit] of bits) {
    const set = (s.statusWord & (1 << bit)) !== 0;
    const row = tableBody.insertRow();
    for (const value of [String(bit), label, set ? 'Set' : '—']) {
      const cell = row.insertCell();
      cell.textContent = value;
      if (set) row.classList.add('bit-set');
    }
  }
  detail.append(table);

  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent =
    `Snapshot generation ${s.stateGeneration.toString()} · received ${model.ageMs} ms ago · ` +
    'observational only — no drive command is issued from this view.';
  detail.append(note);
  return detail;
}

function appendMetric(container: HTMLElement, label: string, value: string): void {
  const metric = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = label;
  const detail = document.createElement('span');
  detail.textContent = value;
  metric.append(title, detail);
  container.append(metric);
}

function modeLabel(mode: number): string {
  return (
    (
      {
        1: 'PP',
        3: 'PV',
        4: 'PT',
        6: 'Homing',
        7: 'Interpolated',
        8: 'CSP',
        9: 'CSV',
        10: 'CST',
      } as Record<number, string>
    )[mode] ?? `Mode ${mode}`
  );
}

function formatPosition(value: number, axis?: MachineAxisDescriptor): string {
  if (!axis) return `${value} cts`;
  const converted = value * axis.positionScale;
  return `${Number.isFinite(converted) ? converted.toFixed(3) : '—'} ${axis.positionUnit}`;
}

function formatVelocity(value: number, axis?: MachineAxisDescriptor): string {
  if (!axis) return `${value} cts/s`;
  const converted = value * axis.velocityScale;
  return `${Number.isFinite(converted) ? converted.toFixed(2) : '—'} ${axis.velocityUnit}`;
}
