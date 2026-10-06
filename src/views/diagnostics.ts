import {
  DriveSnapshotView,
  MachineAxisDescriptor,
  MachineDiagnosticsView,
  MachineSnapshotView,
  alStateLabel,
  ds402StateLabel,
} from '../domain/machine-profile';
import { DriveSnapshotRecord } from './drives';
import {
  PdoEntryView,
  SUPERVISOR_STATE_LABELS,
  SupervisorEntryView,
} from '../domain/machine-control';

/** DriveQuality bit values mirrored from the C++ profile. */
export const QUALITY_STALE = 1;
export const QUALITY_SIMULATED = 1 << 1;
export const QUALITY_RECOVERING = 1 << 2;

export interface DiagnosticsModel {
  profileAvailable: boolean;
  descriptor?: { axes: MachineAxisDescriptor[] };
  snapshot?: MachineSnapshotView;
  snapshotAgeMs?: number;
  drives: { axis?: MachineAxisDescriptor; snapshot: DriveSnapshotView; ageMs: number }[];
  connectionStale: boolean;
  /** Present only when the server attached a diagnostics source. */
  diagnostics?: MachineDiagnosticsView;
  diagnosticsAdvertised: boolean;
  /** Present only when machine.pdo.map is advertised and has been read. */
  pdoEntries?: PdoEntryView[];
  pdoAdvertised: boolean;
  /** Present only when machine.supervisor.* is advertised and has been read. */
  supervisor?: SupervisorEntryView[];
  supervisorAdvertised: boolean;
  /** Last retry outcome line (ok/error text). */
  supervisorResult?: string;
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function ageLabel(ageMs: number | undefined): string {
  if (ageMs === undefined || !Number.isFinite(ageMs)) return 'stale';
  return `${Math.max(0, Math.round(ageMs))} ms`;
}

function qualityLabels(flags: number): string {
  const labels: string[] = [];
  if (flags & QUALITY_STALE) labels.push('stale');
  if (flags & QUALITY_SIMULATED) labels.push('simulated');
  if (flags & QUALITY_RECOVERING) labels.push('recovering');
  return labels.length ? labels.join(', ') : 'good';
}

function statusClass(ok: boolean): string {
  return ok ? 'diag-ok' : 'diag-bad';
}

/**
 * Render the Diagnostics view: EtherCAT link/WKC/DC health, a per-slave
 * topology table in display order, and explicit stale/gap banners. All data
 * comes from the schema-negotiated MachineSnapshotV1/DriveSnapshotV1; nothing
 * here asserts functional-safety state.
 */
export function renderDiagnostics(root: HTMLElement, model: DiagnosticsModel): void {
  const page = root.querySelector<HTMLElement>('#diagnostics-page');
  if (!page) return;

  const banner = page.querySelector<HTMLElement>('#diag-stale-banner');
  if (banner) {
    const snapshotStale = model.snapshotAgeMs === undefined || model.snapshotAgeMs > 3000;
    const show = model.connectionStale || (model.profileAvailable && snapshotStale);
    banner.hidden = !show;
    banner.textContent = model.connectionStale
      ? 'Connection lost — every value below is stale. The server remains authoritative; do not act on this data.'
      : 'Snapshot data is stale — the last coherent machine snapshot is older than 3 s.';
  }

  const bus = page.querySelector<HTMLElement>('#diag-bus');
  if (bus) {
    if (!model.snapshot) {
      bus.innerHTML = `<p class="widget-empty">No coherent machine snapshot received${
        model.profileAvailable ? ' yet' : '; the machine.cia402.v1 profile is not advertised'
      }.</p>`;
    } else {
      const s = model.snapshot;
      const rows: [string, string, boolean][] = [
        ['Link', s.linkUp ? 'up' : 'down', s.linkUp],
        ['Working counter', `${s.actualWkc} / ${s.expectedWkc}`, s.actualWkc === s.expectedWkc],
        ['DC lock', s.dcLocked ? 'locked' : 'not locked', s.dcLocked],
        ['Lowest AL state', alStateLabel(s.alState), s.alState === 8],
        ['Stale drives', String(s.staleCount), s.staleCount === 0],
        ['Snapshot age', ageLabel(model.snapshotAgeMs), (model.snapshotAgeMs ?? Infinity) <= 3000],
      ];
      bus.innerHTML = rows
        .map(
          ([label, value, ok]) =>
            `<div class="diag-metric ${statusClass(ok)}"><small>${esc(label)}</small><strong>${esc(value)}</strong></div>`,
        )
        .join('');
    }
  }

  const tbody = page.querySelector<HTMLElement>('#diag-topology-body');
  if (tbody) {
    if (!model.drives.length) {
      tbody.innerHTML =
        '<tr><td colspan="8" class="widget-empty">No schema-backed drive snapshots discovered.</td></tr>';
    } else {
      const ordered = [...model.drives].sort((a, b) => {
        const orderA = a.axis?.displayOrder ?? a.snapshot.slaveIndex;
        const orderB = b.axis?.displayOrder ?? b.snapshot.slaveIndex;
        return orderA - orderB;
      });
      tbody.innerHTML = ordered
        .map(({ axis, snapshot, ageMs }) => {
          const stale = (snapshot.qualityFlags & QUALITY_STALE) !== 0 || ageMs > 3000;
          const faulted = snapshot.faultCode !== 0 || snapshot.ds402State === 7;
          return (
            `<tr class="${stale ? 'diag-row-stale' : faulted ? 'diag-row-fault' : ''}">` +
            `<td>${esc(axis?.name ?? `slave ${snapshot.slaveIndex}`)}<small class="diag-sub">${esc(axis?.stableId ?? '')}</small></td>` +
            `<td>${snapshot.slaveIndex}</td>` +
            `<td class="${statusClass(snapshot.alState === 8)}">${alStateLabel(snapshot.alState)}</td>` +
            `<td>${snapshot.alStatusCode === 0 ? '—' : `0x${snapshot.alStatusCode.toString(16)}`}</td>` +
            `<td>${ds402StateLabel(snapshot.ds402State)}</td>` +
            `<td>${esc(qualityLabels(snapshot.qualityFlags))}</td>` +
            `<td>${snapshot.faultCode === 0 ? '—' : `0x${snapshot.faultCode.toString(16)}`}</td>` +
            `<td>${ageLabel(ageMs)}</td>` +
            '</tr>'
          );
        })
        .join('');
    }
  }

  const cyclic = page.querySelector<HTMLElement>('#diag-cyclic');
  if (cyclic) {
    if (!model.diagnosticsAdvertised) {
      cyclic.innerHTML =
        '<p class="widget-empty">No diagnostics source attached — the optional machine.diagnostics surface is absent.</p>';
    } else if (!model.diagnostics) {
      cyclic.innerHTML =
        '<p class="widget-empty">Diagnostics signal advertised; waiting for first sample.</p>';
    } else {
      const d = model.diagnostics;
      const err = (n: bigint) => (n === 0n ? '0' : n.toString());
      const rows: [string, string, boolean][] = [
        ['Cyclic exchanges', d.cycleCount.toString(), true],
        ['Missed deadlines', err(d.missedDeadlines), d.missedDeadlines === 0n],
        ['Max cycle work', `${d.maxCycleWorkUs} µs`, d.maxCycleWorkUs < 900],
        ['Wake jitter max/avg', `${d.jitterMaxUs} / ${d.jitterAvgUs} µs`, true],
        [
          'DC syncs / errors',
          `${d.dcSyncCount.toString()} / ${err(d.dcSyncErrors)}`,
          d.dcSyncErrors === 0n,
        ],
        ['DC jitter max', `${d.dcJitterMaxUs} µs`, true],
        [
          'Mailbox sends / errors',
          `${d.mbxSends.toString()} / ${err(d.mbxSendErrors)}`,
          d.mbxSendErrors === 0n,
        ],
        [
          'Mailbox collects / errors',
          `${d.mbxCollects.toString()} / ${err(d.mbxCollectErrors)}`,
          d.mbxCollectErrors === 0n,
        ],
        ['Worst send latency', `${d.maxSendLatencyNs} ns`, true],
        ['Link retries / failures', `${d.txRetries} / ${d.txFailures}`, d.txFailures === 0],
        ['Frames received', String(d.rxFrames), true],
        [
          'Slaves detected / OP',
          `${d.slavesDetected} / ${d.slavesOperational}`,
          d.slavesDetected === d.slavesOperational,
        ],
        ['Last WKC', String(d.lastWkc), true],
      ];
      cyclic.innerHTML = rows
        .map(
          ([label, value, ok]) =>
            `<div class="diag-metric ${statusClass(ok)}"><small>${esc(label)}</small><strong>${esc(value)}</strong></div>`,
        )
        .join('');
    }
  }

  const chain = page.querySelector<HTMLElement>('#diag-chain');
  if (chain) {
    if (!model.drives.length) {
      chain.innerHTML = '';
    } else {
      const ordered = [...model.drives].sort((a, b) => {
        const orderA = a.axis?.displayOrder ?? a.snapshot.slaveIndex;
        const orderB = b.axis?.displayOrder ?? b.snapshot.slaveIndex;
        return orderA - orderB;
      });
      // EtherCAT physical wiring is a daisy chain; render the slave order the
      // snapshot reports. Port-level topology is not part of the profile.
      const nodes = ordered.map(({ axis, snapshot }) => {
        const faulted = snapshot.faultCode !== 0 || snapshot.ds402State === 7;
        const op = snapshot.alState === 8;
        const cls = faulted ? 'diag-node-fault' : op ? 'diag-node-op' : 'diag-node-idle';
        return `<div class="diag-node ${cls}" title="${esc(alStateLabel(snapshot.alState))}"><strong>${esc(axis?.name ?? `S${snapshot.slaveIndex}`)}</strong><small>#${snapshot.slaveIndex}</small></div>`;
      });
      chain.innerHTML =
        '<div class="diag-node diag-node-master"><strong>Master</strong></div>' +
        nodes.map((n) => `<span class="diag-link" aria-hidden="true">─</span>${n}`).join('');
    }
  }

  const pdoBody = page.querySelector<HTMLElement>('#diag-pdo-body');
  if (pdoBody) {
    if (!model.pdoAdvertised) {
      pdoBody.innerHTML =
        '<tr><td colspan="6" class="widget-empty">No PDO source attached — the optional machine.pdo.map surface is absent.</td></tr>';
    } else if (!model.pdoEntries) {
      pdoBody.innerHTML =
        '<tr><td colspan="6" class="widget-empty">PDO map advertised; waiting for first read.</td></tr>';
    } else if (!model.pdoEntries.length) {
      pdoBody.innerHTML =
        '<tr><td colspan="6" class="widget-empty">No enabled PDO entries.</td></tr>';
    } else {
      const ordered = [...model.pdoEntries].sort(
        (a, b) => a.slaveIndex - b.slaveIndex || a.logicalOffset - b.logicalOffset,
      );
      pdoBody.innerHTML = ordered
        .map(
          (e) =>
            '<tr>' +
            `<td>${e.slaveIndex}</td>` +
            `<td>0x${e.pdoIndex.toString(16).padStart(4, '0')}</td>` +
            `<td>${e.direction === 0 ? 'Rx (out)' : 'Tx (in)'}</td>` +
            `<td>${e.logicalOffset}</td>` +
            `<td>${e.length} B</td>` +
            `<td>${e.entryIndex}</td>` +
            '</tr>',
        )
        .join('');
    }
  }

  const supBody = page.querySelector<HTMLElement>('#diag-supervisor-body');
  if (supBody) {
    if (!model.supervisorAdvertised) {
      supBody.innerHTML =
        '<tr><td colspan="6" class="widget-empty">No supervisor attached — the optional machine.supervisor.* surface is absent.</td></tr>';
    } else if (!model.supervisor) {
      supBody.innerHTML =
        '<tr><td colspan="6" class="widget-empty">Supervisor advertised; waiting for first read.</td></tr>';
    } else if (!model.supervisor.length) {
      supBody.innerHTML =
        '<tr><td colspan="6" class="widget-empty">Supervisor reports no managed slaves.</td></tr>';
    } else {
      supBody.innerHTML = [...model.supervisor]
        .sort((a, b) => a.slaveIndex - b.slaveIndex)
        .map((e) => {
          const label = SUPERVISOR_STATE_LABELS[e.state] ?? `state ${e.state}`;
          const bad = e.state === 1 || e.state === 4;
          const canRetry = e.state === 1 || e.state === 4;
          return (
            `<tr class="${bad ? 'diag-row-fault' : ''}">` +
            `<td>${e.slaveIndex}</td>` +
            `<td class="${statusClass(!bad)}">${esc(label)}</td>` +
            `<td>${e.suspended ? 'yes' : '—'}</td>` +
            `<td>${e.recovering ? 'yes' : '—'}</td>` +
            `<td>${e.attemptCount}</td>` +
            `<td>${canRetry ? `<button type="button" class="btn-secondary" data-supervisor-retry="${e.slaveIndex}">Retry</button>` : '—'}</td>` +
            '</tr>'
          );
        })
        .join('');
    }
  }
  const supResult = page.querySelector<HTMLElement>('#diag-supervisor-result');
  if (supResult) supResult.textContent = model.supervisorResult ?? '';

  const counts = page.querySelector<HTMLElement>('#diag-counts');
  if (counts) {
    const s = model.snapshot;
    counts.textContent = s
      ? `${s.axisCount} axes · ${s.enabledCount} enabled · ${s.faultCount} faults · ${s.warningCount} warnings · generation ${s.stateGeneration.toString()}`
      : 'Waiting for machine snapshot';
  }
}
