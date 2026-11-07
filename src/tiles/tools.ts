/**
 * Tool tiles — the commissioning/service workflows as board tiles. The same
 * components are hosted by the tools overlay, so every workflow is usable
 * both embedded and full-screen. Rendering reuses the section-guarded
 * renderCommissioning (each tile supplies only its own panel element);
 * events delegate to hub methods.
 */
import { html, TemplateResult } from 'lit';
import { DataHub, HubTopic } from '../data/hub';
import { CatalogEntry, FunctionEntry } from '../protocol';
import {
  CommissioningModel,
  parseHexBytes,
  renderCommissioning,
  writableParameters,
} from '../views/commissioning';
import '../components';
import { TileElement } from './base';

function commissioningModel(hub: DataHub): CommissioningModel {
  return {
    captureAvailable: hub.control?.captureAvailable ?? false,
    configAvailable: hub.control?.configAvailable ?? false,
    capture: hub.captureStatus,
    config: hub.configStatus,
    writableParams: writableParameters(hub.params),
    triggerSignals: hub.signals,
    sdoAvailable: hub.control?.sdoAvailable ?? false,
    sdoSlave: hub.sdoSlave,
    sdoIndex: hub.sdoForm.index,
    sdoSubindex: hub.sdoForm.subindex,
    sdoData: hub.sdoForm.data,
    sdoMaxBytes: hub.sdoForm.maxBytes,
    sdoEntries: hub.sdoEntries,
    sdoResult: hub.sdoResult,
    sdoPendingWrite: hub.sdoPendingWrite,
    busy: hub.controlBusy,
    baselineAvailable: hub.control?.configBaselineAvailable ?? false,
    baseline: hub.baselineEntries,
    baselineDiff: hub.baselineDiff,
    baselineResult: hub.baselineResultText,
    checklistAvailable: hub.control?.checklistAvailable ?? false,
    checklist: hub.checklistItems,
    checklistResult: hub.checklistResultText,
  };
}

/** Base for commissioning tiles: one panel container + shared event wiring. */
export abstract class CommissioningTile extends TileElement {
  /** Which panel element this tile renders (e.g. 'sdo-panel'). */
  protected abstract panel(): TemplateResult;

  protected topics(): HubTopic[] {
    return ['services', 'connection', 'catalog'];
  }

  /** Read in-flight form values before the re-render replaces the DOM. */
  private captureFormState(): void {
    const hub = this.hub;
    if (!hub) return;
    const read = (id: string) => this.querySelector<HTMLInputElement>(id)?.value;
    const idx = read('#sdo-index');
    if (idx !== undefined) hub.sdoForm.index = idx;
    const sub = read('#sdo-subindex');
    if (sub !== undefined) hub.sdoForm.subindex = sub;
    const data = read('#sdo-data');
    if (data !== undefined) hub.sdoForm.data = data;
    const max = read('#sdo-max-bytes');
    if (max !== undefined) hub.sdoForm.maxBytes = max;
    const slave = read('#sdo-slave');
    if (slave !== undefined && slave !== '')
      hub.sdoSlave = Math.min(65535, Math.max(0, Number(slave) || 0));
  }

  protected render(): TemplateResult {
    return html`<div class="tile-scroll commissioning-tile">${this.panel()}</div>`;
  }

  protected updated(): void {
    const hub = this.hub;
    if (!hub) return;
    this.captureFormState();
    renderCommissioning(this, commissioningModel(hub));
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!this.hub) return;
      const form = event.target as HTMLElement;
      if (form.id === 'capture-form') void this.onCaptureSubmit();
      if (form.id === 'config-stage-form') void this.onConfigStage();
    });
    this.addEventListener('change', (event) => {
      const input = event.target as HTMLInputElement;
      if (input.id === 'baseline-file' && input.files?.length && this.hub)
        this.hub.baselineLoadFile(input.files[0]!);
    });
    this.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest('button');
      if (!button || button.type === 'submit' || !this.hub) return;
      const hub = this.hub;
      if (button.id === 'config-validate') void hub.configVerb('validate');
      else if (button.id === 'config-commit') void hub.configVerb('commit');
      else if (button.id === 'config-rollback') void hub.configVerb('rollback');
      else if (button.id === 'config-refresh') void hub.refreshCommissioning();
      else if (button.id === 'capture-cancel') void hub.captureCancel();
      else if (button.id === 'capture-export') void hub.captureExport();
      else if (button.id === 'sdo-list') void hub.sdoList();
      else if (button.id === 'sdo-read') void this.onSdoTransfer();
      else if (button.id === 'sdo-write') void this.onSdoPreviewWrite();
      else if (button.id === 'sdo-confirm') void hub.sdoConfirmWrite();
      else if (button.id === 'sdo-cancel') hub.sdoCancelWrite();
      else if (button.id === 'baseline-export') void hub.baselineExport();
      else if (button.id === 'baseline-diff') void hub.baselineDiffRun();
      else if (button.id === 'baseline-import') void hub.baselineImport();
      else if (button.id === 'checklist-refresh') void hub.checklistList();
      else if (button.id === 'checklist-report') void hub.checklistReport();
    });
  }

  private sdoIndexSubindex(): { index: number; subindex: number } | undefined {
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
      this.hub?.toast('Enter a valid hex index/subindex (e.g. 6040 / 00)', 'error');
      return undefined;
    }
    return { index, subindex };
  }

  private async onSdoTransfer(): Promise<void> {
    const hub = this.hub;
    if (!hub) return;
    hub.sdoSlave = this.sdoSlaveValue();
    const ids = this.sdoIndexSubindex();
    if (!ids) return;
    const maxBytes = Math.min(
      512,
      Math.max(1, Number(this.querySelector<HTMLInputElement>('#sdo-max-bytes')?.value) || 256),
    );
    await hub.sdoRead(ids.index, ids.subindex, maxBytes);
  }

  private async onSdoPreviewWrite(): Promise<void> {
    const hub = this.hub;
    if (!hub) return;
    hub.sdoSlave = this.sdoSlaveValue();
    const ids = this.sdoIndexSubindex();
    if (!ids) return;
    const data = parseHexBytes(this.querySelector<HTMLInputElement>('#sdo-data')?.value ?? '');
    if (!data?.length || data.length > 512) {
      hub.toast('Write data must be 1-512 hex bytes', 'error');
      return;
    }
    await hub.sdoPreviewWrite(ids.index, ids.subindex, data);
  }

  private sdoSlaveValue(): number {
    return Math.min(
      65535,
      Math.max(
        0,
        Number(this.querySelector<HTMLInputElement>('#sdo-slave')?.value ?? this.hub?.sdoSlave) ||
          0,
      ),
    );
  }

  private async onCaptureSubmit(): Promise<void> {
    const hub = this.hub;
    if (!hub) return;
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
    const template = this.querySelector<HTMLInputElement>('#capture-template')?.checked ? 1 : 0;
    await hub.captureSubmit({ name, rateHz: rate, enabled, trigger, template });
  }

  private async onConfigStage(): Promise<void> {
    const hub = this.hub;
    if (!hub) return;
    const idText = this.querySelector<HTMLSelectElement>('#config-param')?.value ?? '';
    const valueText = this.querySelector<HTMLInputElement>('#config-value')?.value ?? '';
    const value = parseHexBytes(valueText);
    if (!idText) {
      hub.toast('Select a writable parameter', 'error');
      return;
    }
    if (!value) {
      hub.toast('Value must be even-length hex bytes (e.g. "2a 00 00 00")', 'error');
      return;
    }
    await hub.configStage(BigInt(idText), value);
  }
}

export class TileSdoInspector extends CommissioningTile {
  protected panel(): TemplateResult {
    return html`<div id="sdo-panel"></div>`;
  }
}

export class TileConfigTxn extends CommissioningTile {
  protected panel(): TemplateResult {
    return html`<div id="config-panel"></div>`;
  }
}

export class TileCapture extends CommissioningTile {
  protected panel(): TemplateResult {
    return html`<div id="capture-panel"></div>`;
  }
}

export class TileBaseline extends CommissioningTile {
  protected panel(): TemplateResult {
    return html`<div id="baseline-panel"></div>`;
  }
}

export class TileChecklist extends CommissioningTile {
  protected panel(): TemplateResult {
    return html`<div id="checklist-panel"></div>`;
  }
}

// ---------------------------------------------------------------------------
// Catalog explorer — browse signals/params/functions (expert tool).
// ---------------------------------------------------------------------------

type CatalogTab = 'all' | 'signals' | 'params' | 'functions';

export class TileCatalog extends TileElement {
  private tab: CatalogTab = 'all';
  private selection: bigint[] = [];

  protected topics(): HubTopic[] {
    return ['catalog', 'connection'];
  }

  protected onHub(): void {
    this.requestUpdate();
    this.renderLists();
  }

  private entries(): CatalogEntry[] {
    const hub = this.hub;
    if (!hub) return [];
    if (this.tab === 'all') return [...hub.params, ...hub.signals];
    if (this.tab === 'signals') return hub.signals;
    return this.tab === 'params' ? hub.params : [];
  }

  private renderLists(): void {
    const catalog = this.querySelector<HTMLElement & { items: CatalogEntry[] }>('#catalog');
    if (catalog && this.tab !== 'functions') catalog.items = this.entries();
    const functions = this.querySelector<HTMLElement & { items: FunctionEntry[] }>('#functions');
    if (functions && this.hub) functions.items = this.hub.functions;
    const count = this.querySelector<HTMLElement>('#catalog-count');
    if (count && this.hub) count.textContent = String(this.entries().length);
  }

  protected render(): TemplateResult {
    const tab = (id: CatalogTab, label: string) =>
      html`<button
        class="tab${this.tab === id ? ' active' : ''}"
        @click=${() => {
          this.tab = id;
          this.requestUpdate();
          this.renderLists();
        }}
      >
        ${label}
      </button>`;
    return html`<div class="catalog-tile">
      <nav class="tabs">
        ${tab('all', 'All')}${tab('signals', 'Signals')}${tab('params', 'Parameters')}${tab(
          'functions',
          'Functions',
        )}
        <span id="catalog-count" class="badge"></span>
      </nav>
      <tether-catalog id="catalog" ?hidden=${this.tab === 'functions'}></tether-catalog>
      <tether-function-list
        id="functions"
        ?hidden=${this.tab !== 'functions'}
      ></tether-function-list>
      <p class="event-history-note">
        Selection: ${this.selection.length ? `${this.selection.length} signal(s)` : 'none'} — add a
        Scope tile and paste signal names to plot them.
      </p>
    </div>`;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener('selection-change', () => {
      const catalog = this.querySelector<HTMLElement & { selectedIds: bigint[] }>('#catalog');
      const signalIds = new Set((this.hub?.signals ?? []).map((s) => s.id));
      this.selection = (catalog?.selectedIds ?? []).filter((id) => signalIds.has(id));
      this.requestUpdate();
    });
  }

  protected updated(): void {
    this.renderLists();
  }
}

// ---------------------------------------------------------------------------
// Note — static text block.
// ---------------------------------------------------------------------------

export class TileNote extends TileElement {
  protected render(): TemplateResult {
    const text = (this.def?.options?.['text'] as string | undefined) ?? '';
    if (!text) return html`<p class="widget-empty">Empty note — add text in tile settings.</p>`;
    return html`<p class="note-text">${text}</p>`;
  }
}

customElements.define('tile-sdo-inspector', TileSdoInspector);
customElements.define('tile-config-txn', TileConfigTxn);
customElements.define('tile-capture', TileCapture);
customElements.define('tile-baseline', TileBaseline);
customElements.define('tile-checklist', TileChecklist);
customElements.define('tile-catalog', TileCatalog);
customElements.define('tile-note', TileNote);
