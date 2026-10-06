import {
  CaptureStatusView,
  ChecklistItemView,
  ConfigDiffView,
  ConfigEntryView,
  ConfigStatusView,
  ConfigTxnState,
  SdoEntryView,
  SdoResultView,
} from '../domain/machine-control';
import { CatalogEntry } from '../protocol/types';

const ENTRY_FLAG_WRITABLE = 0x02;

export interface CommissioningModel {
  captureAvailable: boolean;
  configAvailable: boolean;
  capture?: CaptureStatusView;
  config?: ConfigStatusView;
  /** Writable parameters eligible for staged writes. */
  writableParams: CatalogEntry[];
  /** Fixed-size signals usable as trigger sources. */
  triggerSignals: CatalogEntry[];
  /** Whether the server plugged in an SDO backend. */
  sdoAvailable: boolean;
  /** Slave index the OD listing and transfers apply to. */
  sdoSlave: number;
  /** Explicit-index transfer form values, preserved across re-renders. */
  sdoIndex?: string;
  sdoSubindex?: string;
  sdoData?: string;
  sdoMaxBytes?: string;
  /** Known-object table for sdoSlave, undefined until enumerated. */
  sdoEntries?: SdoEntryView[];
  /** Last explicit-index transfer result. */
  sdoResult?: SdoResultView;
  /** A write staged for preview→confirm before dispatch (never implicit). */
  sdoPendingWrite?: {
    index: number;
    subindex: number;
    data: Uint8Array;
    current?: Uint8Array;
    entry?: SdoEntryView;
    error?: string;
  };
  busy: boolean;
  /** Whether machine.config.export/diff/import are advertised. */
  baselineAvailable: boolean;
  /** A baseline loaded from disk or exported, used for diff/import. */
  baseline?: ConfigEntryView[];
  /** Last diff result against the live configuration. */
  baselineDiff?: ConfigDiffView;
  /** Status line for baseline operations. */
  baselineResult?: string;
  /** Whether machine.checklist.* is advertised. */
  checklistAvailable: boolean;
  /** Evaluated checklist items (undefined until first list call). */
  checklist?: ChecklistItemView[];
  /** Last checklist/report outcome line. */
  checklistResult?: string;
}

export function writableParameters(params: CatalogEntry[]): CatalogEntry[] {
  return params.filter((p) => (p.flags & ENTRY_FLAG_WRITABLE) !== 0);
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const CAPTURE_STATES = ['idle', 'recording', 'stopped', 'error'] as const;
const TXN_STATES = ['idle', 'staged', 'validated', 'committed', 'failed', 'rolled back'] as const;

function captureStateLabel(state: number): string {
  return CAPTURE_STATES[state] ?? `unknown (${state})`;
}

export function txnStateLabel(state: number): string {
  return TXN_STATES[state] ?? `unknown (${state})`;
}

/** Parse a hex byte string ("2a 00 00 00" or "2a000000") into bytes. */
export function parseHexBytes(text: string): Uint8Array | undefined {
  const compact = text.replace(/[\s_-]/g, '');
  if (compact.length === 0 || compact.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(compact))
    return undefined;
  const out = new Uint8Array(compact.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(compact.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function renderCapture(model: CommissioningModel): string {
  if (!model.captureAvailable) {
    return '<p class="widget-empty">The machine.capture.* service is not advertised by this server.</p>';
  }
  const s = model.capture;
  const triggerLabels = ['no trigger', 'armed (pre-trigger)', 'post-trigger', 'complete'];
  const status = s
    ? `<div class="config-status config-${s.state === 3 ? 'failed' : 'ok'}" role="status">
        <strong>${captureStateLabel(s.state)}${s.enabled ? ' · enabled' : ''} · ${triggerLabels[s.triggerState] ?? '?'}</strong>
        <span>${esc(s.logName || '(unnamed)')} · ${s.sampleRateHz} Hz · ${s.fieldCount} fields · ${s.recordsWritten.toString()} records · ${s.bytesWritten.toString()} B · retained ${s.recordsAvailable.toString()}${s.recordsDropped > 0n ? ` (+${s.recordsDropped.toString()} dropped)` : ''}</span>
      </div>`
    : '<p class="widget-empty">Capture status not read yet.</p>';
  return `
    <p class="event-history-note">Records stay on the server with bounded retention. Export downloads paginated chunks (max 64 KiB each) and is audited per call; cancel discards the capture.</p>
    ${status}
    <form id="capture-form" class="config-form">
      <label>Log name <input id="capture-name" maxlength="128" value="${esc(s?.logName ?? '')}" placeholder="commissioning-run" required></label>
      <label>Sample rate (Hz) <input id="capture-rate" type="number" min="1" max="100000" value="${s?.sampleRateHz ?? 1000}" required></label>
      <label class="config-check"><input id="capture-enabled" type="checkbox" ${s?.enabled ? 'checked' : ''}> Recording enabled</label>
      <label class="config-check"><input id="capture-template" type="checkbox"> Service preset — record every fixed-size signal</label>
      <fieldset class="capture-trigger">
        <legend>Trigger (optional, diagnostic — not a protection function)</legend>
        <label>Signal <select id="capture-trigger-signal"><option value="">none</option>${model.triggerSignals.map((p) => `<option value="${p.id.toString()}">${esc(p.name)}</option>`).join('')}</select></label>
        <label>Op <select id="capture-trigger-op"><option value="0">above</option><option value="1">below</option><option value="2">|value| above</option></select></label>
        <label>Level <input id="capture-trigger-level" type="number" step="any" value="0"></label>
        <label>Pre <input id="capture-trigger-pre" type="number" min="0" value="50"></label>
        <label>Post <input id="capture-trigger-post" type="number" min="0" value="100"></label>
      </fieldset>
      <div class="trend-pane-tools">
        <button type="submit" ${model.busy ? 'disabled' : ''}>Apply capture configuration</button>
        <button type="button" id="capture-cancel" class="secondary" ${model.busy || !s?.enabled ? 'disabled' : ''}>Cancel &amp; discard</button>
        <button type="button" id="capture-export" class="secondary" ${model.busy || !s || s.recordsAvailable === 0n ? 'disabled' : ''}>Export records</button>
      </div>
    </form>`;
}

function renderConfig(model: CommissioningModel): string {
  if (!model.configAvailable) {
    return '<p class="widget-empty">The machine.config.* service is not advertised by this server.</p>';
  }
  const t = model.config;
  const status = t
    ? `<div class="config-status config-${t.state === ConfigTxnState.Failed ? 'failed' : 'ok'}" role="status">
        <strong>txn ${t.transactionId.toString()} · ${txnStateLabel(t.state)}</strong>
        <span>revision ${t.revision.toString()} · ${t.stagedCount} staged${t.message ? ` · ${esc(t.message)}` : ''}</span>
        ${t.staged.length ? `<ul>${t.staged.map((w) => `<li><code>0x${w.entryId.toString(16)}</code> ← <code>${[...w.value].map((b) => b.toString(16).padStart(2, '0')).join(' ')}</code></li>`).join('')}</ul>` : ''}
      </div>`
    : '<p class="widget-empty">No transaction status read yet.</p>';
  const options = model.writableParams
    .map((p) => `<option value="${p.id.toString()}">${esc(p.name)}</option>`)
    .join('');
  const canCommit = t?.state === ConfigTxnState.Validated;
  return `
    <p class="event-history-note">Staged writes are checked, validated, then committed atomically on the server. Commit requires a technician role; nothing is applied by stage or validate.</p>
    ${status}
    <form id="config-stage-form" class="config-form">
      <label>Parameter <select id="config-param" ${model.writableParams.length ? '' : 'disabled'}>${options || '<option value="">No writable parameters</option>'}</select></label>
      <label>Value (hex bytes, little-endian) <input id="config-value" placeholder="2a 00 00 00" pattern="[0-9a-fA-F ]+" required></label>
      <div class="config-actions">
        <button type="submit" ${model.busy || !model.writableParams.length ? 'disabled' : ''}>Stage write</button>
        <button type="button" id="config-validate" ${model.busy || t?.state !== ConfigTxnState.Staged ? 'disabled' : ''}>Validate</button>
        <button type="button" id="config-commit" ${model.busy || !canCommit ? 'disabled' : ''}>Commit</button>
        <button type="button" id="config-rollback" class="secondary" ${model.busy || !t || t.state === ConfigTxnState.Idle ? 'disabled' : ''}>Roll back</button>
        <button type="button" id="config-refresh" class="secondary" ${model.busy ? 'disabled' : ''}>Refresh status</button>
      </div>
    </form>`;
}

function hexBytes(data: Uint8Array): string {
  return [...data].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

function renderSdo(model: CommissioningModel): string {
  if (!model.sdoAvailable) {
    return '<p class="widget-empty">No SDO backend is plugged in on this server — machine.sdo.* is not advertised.</p>';
  }
  const rows = (model.sdoEntries ?? [])
    .map((e) => {
      const bounds =
        e.minValue !== undefined && e.maxValue !== undefined && !Number.isNaN(e.minValue)
          ? `[${e.minValue}, ${e.maxValue}]`
          : '—';
      return `<tr title="${esc(e.description ?? '')}"><td><code>0x${e.index
        .toString(16)
        .padStart(4, '0')}:${e.subindex
        .toString(16)
        .padStart(2, '0')}</code></td><td>${esc(e.name)}</td><td><code>0x${e.dataType
        .toString(16)
        .padStart(
          4,
          '0',
        )}</code></td><td>${e.access === 1 ? 'ro' : 'rw'}</td><td>${esc(bounds)}</td></tr>`;
    })
    .join('');
  const table = model.sdoEntries
    ? model.sdoEntries.length
      ? `<div class="table-wrap"><table class="drive-table"><thead><tr><th>Index</th><th>Name</th><th>Type</th><th>Access</th><th>Range</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<p class="widget-empty">No object table for this slave — transfers by explicit index still work.</p>'
    : '';
  const pending = model.sdoPendingWrite;
  const preview = pending
    ? `<div class="config-status config-pending" role="alertdialog" aria-label="Confirm SDO write">
        <strong>Write preview — slave ${model.sdoSlave}, 0x${pending.index
          .toString(16)
          .padStart(4, '0')}:${pending.subindex.toString(16).padStart(2, '0')}${
          pending.entry ? ` ${esc(pending.entry.name)}` : ''
        }</strong>
        <span>Current: <code>${pending.current ? hexBytes(pending.current) : 'read failed'}</code></span>
        <span>New: <code>${hexBytes(pending.data)}</code></span>
        ${pending.error ? `<span>${esc(pending.error)}</span>` : ''}
        <div class="config-actions">
          <button type="button" id="sdo-confirm" ${model.busy ? 'disabled' : ''}>Confirm write</button>
          <button type="button" id="sdo-cancel" ${model.busy ? 'disabled' : ''}>Cancel</button>
        </div>
      </div>`
    : '';
  const result = model.sdoResult
    ? `<div class="config-status config-${model.sdoResult.ok ? 'ok' : 'failed'}" role="status">
        <strong>${model.sdoResult.ok ? 'Transfer complete' : `Aborted${model.sdoResult.abortCode ? ` · 0x${model.sdoResult.abortCode.toString(16).padStart(8, '0')}${model.sdoResult.abortName ? ` ${esc(model.sdoResult.abortName)}` : ''}` : ''}`}</strong>
        ${model.sdoResult.data.length ? `<code>${hexBytes(model.sdoResult.data)}</code>` : ''}
        ${model.sdoResult.readback?.length ? `<span>Readback: <code>${hexBytes(model.sdoResult.readback)}</code></span>` : ''}
        ${model.sdoResult.error ? `<span>${esc(model.sdoResult.error)}</span>` : ''}
      </div>`
    : '';
  return `
    <p class="event-history-note">CoE mailbox transfers run on the session thread, not the cyclic loop. Writes require a technician role and are journaled; drive-side interlocks still apply — this is not a safety channel.</p>
    <form id="sdo-form" class="config-form">
      <label>Slave <input id="sdo-slave" type="number" min="0" max="65535" value="${model.sdoSlave}" required></label>
      <div class="config-actions">
        <button type="button" id="sdo-list" ${model.busy ? 'disabled' : ''}>Enumerate known objects</button>
      </div>
    </form>
    ${table}
    <form id="sdo-transfer-form" class="config-form">
      <label>Index (hex) <input id="sdo-index" placeholder="6040" pattern="[0-9a-fA-F]{1,4}" value="${esc(model.sdoIndex ?? '')}" required></label>
      <label>Subindex (hex) <input id="sdo-subindex" placeholder="00" pattern="[0-9a-fA-F]{1,2}" value="${esc(model.sdoSubindex ?? '')}" required></label>
      <label>Max bytes <input id="sdo-max-bytes" type="number" min="1" max="512" value="${esc(model.sdoMaxBytes ?? '256')}"></label>
      <label>Write data (hex bytes) <input id="sdo-data" placeholder="leave empty for read" pattern="[0-9a-fA-F ]*" value="${esc(model.sdoData ?? '')}"></label>
      <div class="config-actions">
        <button type="button" id="sdo-read" ${model.busy ? 'disabled' : ''}>Read</button>
        <button type="button" id="sdo-write" ${model.busy ? 'disabled' : ''}>Preview write</button>
      </div>
    </form>
    ${preview}
    ${result}`;
}

// ---- Baseline file format --------------------------------------------------

/** Serialize a baseline to a portable JSON file. */
export function serializeBaseline(revision: bigint, entries: ConfigEntryView[]): string {
  return JSON.stringify(
    {
      format: 'tether.config.baseline.v1',
      revision: revision.toString(),
      entries: entries.map((e) => ({
        entry_id: `0x${e.entryId.toString(16)}`,
        value: hexBytes(e.value),
      })),
    },
    null,
    2,
  );
}

/** Parse a baseline file; returns undefined on any malformed input. */
export function parseBaselineFile(text: string): ConfigEntryView[] | undefined {
  try {
    const doc = JSON.parse(text) as {
      format?: string;
      entries?: { entry_id?: string; value?: string }[];
    };
    if (doc.format !== 'tether.config.baseline.v1' || !Array.isArray(doc.entries)) return undefined;
    const entries: ConfigEntryView[] = [];
    for (const entry of doc.entries) {
      const id = BigInt(entry.entry_id ?? '');
      const value = parseHexBytes(entry.value ?? '');
      if (value === undefined) return undefined;
      entries.push({ entryId: id, value });
    }
    return entries;
  } catch {
    return undefined;
  }
}

function renderBaseline(model: CommissioningModel): string {
  if (!model.baselineAvailable) {
    return '<p class="widget-empty">The machine.config.export/diff/import surface is not advertised by this server.</p>';
  }
  const loaded = model.baseline
    ? `${model.baseline.length} baseline entries loaded`
    : 'No baseline loaded — export the live configuration or load a file.';
  const diff = model.baselineDiff
    ? model.baselineDiff.diffs.length === 0
      ? '<p class="diag-ok">Live configuration matches the baseline (no diffs).</p>'
      : `<div class="table-wrap"><table class="drive-table"><thead><tr><th>Parameter</th><th>Baseline</th><th>Live</th></tr></thead><tbody>${model.baselineDiff.diffs
          .map(
            (d) =>
              `<tr><td><code>0x${d.entryId.toString(16)}</code></td><td><code>${hexBytes(d.expected)}</code></td><td><code>${hexBytes(d.actual)}</code></td></tr>`,
          )
          .join('')}</tbody></table></div>`
    : '';
  return `
    <p class="event-history-note">Export downloads every writable parameter as a baseline file. Diff compares a loaded baseline against live values. Import stages the baseline as a transaction — validate + commit still apply; the call is audited.</p>
    <div class="config-actions">
      <button type="button" id="baseline-export" ${model.busy ? 'disabled' : ''}>Export live baseline</button>
      <label class="btn-secondary baseline-load">Load baseline file <input id="baseline-file" type="file" accept=".json" hidden></label>
      <button type="button" id="baseline-diff" class="secondary" ${model.busy || !model.baseline ? 'disabled' : ''}>Diff vs live</button>
      <button type="button" id="baseline-import" ${model.busy || !model.baseline ? 'disabled' : ''}>Import &amp; stage</button>
    </div>
    <p class="form-result" role="status">${esc(loaded)}${model.baselineResult ? ` · ${esc(model.baselineResult)}` : ''}</p>
    ${diff}`;
}

function renderChecklist(model: CommissioningModel): string {
  if (!model.checklistAvailable) {
    return '<p class="widget-empty">No checklist source attached — the optional machine.checklist.* surface is absent.</p>';
  }
  const rows = (model.checklist ?? [])
    .map(
      (item) =>
        `<tr class="${item.required && !item.passed ? 'diag-row-fault' : ''}">` +
        `<td>${item.itemId}</td>` +
        `<td>${esc(item.label)}</td>` +
        `<td>${item.required ? 'required' : 'optional'}</td>` +
        `<td class="${item.passed ? 'diag-ok' : 'diag-bad'}">${item.passed ? 'pass' : 'fail'}</td>` +
        `<td>${esc(item.evidence)}</td>` +
        '</tr>',
    )
    .join('');
  const body = model.checklist
    ? `<div class="table-wrap"><table class="drive-table"><thead><tr><th>#</th><th>Requirement</th><th>Kind</th><th>Verdict</th><th>Evidence</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="widget-empty">Checklist is empty.</td></tr>'}</tbody></table></div>`
    : '<p class="widget-empty">Checklist not evaluated yet.</p>';
  return `
    <p class="event-history-note">Items are evaluated live by the server. The acceptance report is only generated when every required item passes and is journaled as evidence.</p>
    ${body}
    <div class="config-actions">
      <button type="button" id="checklist-refresh" class="secondary" ${model.busy ? 'disabled' : ''}>Re-evaluate</button>
      <button type="button" id="checklist-report" ${model.busy ? 'disabled' : ''}>Generate acceptance report</button>
    </div>
    <p class="form-result" role="status">${esc(model.checklistResult ?? '')}</p>`;
}

export function renderCommissioning(root: HTMLElement, model: CommissioningModel): void {
  const capture = root.querySelector<HTMLElement>('#capture-panel');
  if (capture) capture.innerHTML = renderCapture(model);
  const config = root.querySelector<HTMLElement>('#config-panel');
  if (config) config.innerHTML = renderConfig(model);
  const sdo = root.querySelector<HTMLElement>('#sdo-panel');
  if (sdo) sdo.innerHTML = renderSdo(model);
  const baseline = root.querySelector<HTMLElement>('#baseline-panel');
  if (baseline) baseline.innerHTML = renderBaseline(model);
  const checklist = root.querySelector<HTMLElement>('#checklist-panel');
  if (checklist) checklist.innerHTML = renderChecklist(model);
}
