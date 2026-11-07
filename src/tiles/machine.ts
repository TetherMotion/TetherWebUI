/**
 * Machine tiles — typed CiA402/EtherCAT state. These reuse the existing
 * section-guarded render functions (each fills only the element ids it is
 * given) and the schema-backed machine-widgets components, so nothing about
 * the interpretation logic is duplicated.
 */
import { html, TemplateResult } from 'lit';
import { HubTopic } from '../data/hub';
import { DiagnosticsModel, renderDiagnostics } from '../views/diagnostics';
import { renderDriveViews } from '../views/drives';
import '../components';
import { TileElement } from './base';

/** Shared DiagnosticsModel assembly — identical inputs to the old view. */
function diagModel(host: TileElement): DiagnosticsModel {
  const hub = host.hub!;
  return {
    profileAvailable: hub.profile.profile === 'machine.cia402.v1',
    descriptor: hub.machineDescriptor,
    snapshot: hub.machineSnapshot,
    snapshotAgeMs: hub.snapshotAgeMs(),
    drives: hub.drives(),
    connectionStale: !hub.connected,
    diagnostics: hub.machineDiagnostics,
    diagnosticsAdvertised: hub.profile.diagnosticsEntry !== undefined,
    pdoEntries: hub.pdoEntries,
    pdoAdvertised: hub.control?.pdoMapAvailable ?? false,
    supervisor: hub.supervisorEntries,
    supervisorAdvertised: hub.control?.supervisorAvailable ?? false,
    supervisorResult: hub.supervisorResultText,
  };
}

/** Base for tiles delegating to renderDiagnostics (needs #diagnostics-page). */
abstract class DiagTile extends TileElement {
  protected topics(): HubTopic[] {
    return ['drives', 'snapshot', 'connection'];
  }

  /** The sub-element markup renderDiagnostics targets (e.g. #diag-bus). */
  protected abstract section(): TemplateResult;

  protected render(): TemplateResult {
    return html`<div id="diagnostics-page" class="diag-tile">${this.section()}</div>`;
  }

  protected updated(): void {
    if (this.hub) renderDiagnostics(this, diagModel(this));
  }
}

export class TileMachineState extends TileElement {
  protected topics(): HubTopic[] {
    return ['snapshot', 'connection'];
  }

  protected render(): TemplateResult {
    return html`<tether-machine-state id="machine-state-widget"></tether-machine-state>`;
  }

  protected updated(): void {
    const hub = this.hub;
    const widget = this.querySelector<HTMLElement & { model: unknown }>('#machine-state-widget');
    if (!widget || !hub) return;
    widget.model = hub.machineSnapshot
      ? { snapshot: hub.machineSnapshot, ageMs: hub.snapshotAgeMs() ?? 0 }
      : undefined;
  }
}

export class TileDriveCards extends TileElement {
  protected topics(): HubTopic[] {
    return ['drives', 'connection'];
  }

  protected render(): TemplateResult {
    // renderDriveViews fills #drive-card-list and requires #overview-drive-list
    // to exist (summary rows — kept hidden here; the cards are the tile).
    return html`<div id="drive-card-list" class="drive-card-list"></div>
      <div id="overview-drive-list" hidden></div>`;
  }

  protected updated(): void {
    const hub = this.hub;
    if (!hub) return;
    renderDriveViews(
      this,
      hub.profile.driveSnapshots,
      hub.driveData,
      () => {},
      hub.axesByStableId(),
    );
  }
}

export class TileDiagBus extends DiagTile {
  protected section(): TemplateResult {
    return html`<div id="diag-bus" class="diag-metrics"></div>
      <span id="diag-counts" class="widget-source"></span>`;
  }
}

export class TileDiagChain extends DiagTile {
  protected section(): TemplateResult {
    return html`<div id="diag-chain" class="diag-chain"></div>`;
  }
}

export class TileDiagTopology extends DiagTile {
  protected section(): TemplateResult {
    return html`<div class="table-wrap">
      <table class="drive-table">
        <thead>
          <tr>
            <th>Axis</th>
            <th>Slave</th>
            <th>AL state</th>
            <th>AL status</th>
            <th>CiA 402</th>
            <th>Quality</th>
            <th>Fault</th>
            <th>Data age</th>
          </tr>
        </thead>
        <tbody id="diag-topology-body"></tbody>
      </table>
    </div>`;
  }
}

export class TileDiagCyclic extends DiagTile {
  protected section(): TemplateResult {
    return html`<div id="diag-cyclic" class="diag-metrics"></div>`;
  }
}

export class TileSupervisor extends DiagTile {
  protected section(): TemplateResult {
    return html`<div class="table-wrap">
        <table class="drive-table">
          <thead>
            <tr>
              <th>Slave</th>
              <th>State</th>
              <th>Suspended</th>
              <th>Recovering</th>
              <th>Attempts</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody id="diag-supervisor-body"></tbody>
        </table>
      </div>
      <p id="diag-supervisor-result" class="form-result" role="status"></p>`;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest('button');
      if (!button || button.disabled) return;
      const retry = button.dataset.supervisorRetry;
      if (retry !== undefined && this.hub) void this.hub.supervisorRetry(Number(retry));
    });
  }
}

export class TilePdoMap extends DiagTile {
  protected section(): TemplateResult {
    return html`<div class="table-wrap">
      <table class="drive-table">
        <thead>
          <tr>
            <th>Slave</th>
            <th>PDO</th>
            <th>Dir</th>
            <th>Logical offset</th>
            <th>Length</th>
            <th>Entry</th>
          </tr>
        </thead>
        <tbody id="diag-pdo-body"></tbody>
      </table>
    </div>`;
  }
}

customElements.define('tile-machine-state', TileMachineState);
customElements.define('tile-drive-cards', TileDriveCards);
customElements.define('tile-diag-bus', TileDiagBus);
customElements.define('tile-diag-chain', TileDiagChain);
customElements.define('tile-diag-topology', TileDiagTopology);
customElements.define('tile-diag-cyclic', TileDiagCyclic);
customElements.define('tile-supervisor', TileSupervisor);
customElements.define('tile-pdo-map', TilePdoMap);
