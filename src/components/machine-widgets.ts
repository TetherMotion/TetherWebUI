/** Reusable, schema-backed machine state widgets. */
import {
  DriveSnapshotView,
  MachineSnapshotView,
  alStateLabel,
  ds402StateLabel,
} from '../domain/machine-profile';

interface DriveWidgetData {
  name: string;
  snapshot: DriveSnapshotView;
  ageMs: number;
}

interface MachineWidgetData {
  snapshot: MachineSnapshotView;
  ageMs: number;
}

abstract class DriveStateWidget extends HTMLElement {
  protected data?: DriveWidgetData;

  set model(value: DriveWidgetData) {
    this.data = value;
    this.render();
  }

  connectedCallback(): void {
    this.render();
  }

  protected abstract render(): void;

  protected createCard(title: string, label: string, state: string, tone: string): HTMLElement {
    const card = document.createElement('article');
    card.className = `state-widget ${tone}`;
    const header = document.createElement('div');
    header.className = 'state-widget-head';
    const heading = document.createElement('div');
    const eyebrow = document.createElement('span');
    eyebrow.className = 'eyebrow';
    eyebrow.textContent = title;
    const resource = document.createElement('h3');
    resource.textContent = this.data?.name ?? 'Waiting for drive data';
    heading.append(eyebrow, resource);
    const badge = document.createElement('span');
    badge.className = `state-pill ${tone}`;
    badge.textContent = state;
    header.append(heading, badge);
    card.append(header);
    const detail = document.createElement('div');
    detail.className = 'state-widget-detail';
    const caption = document.createElement('span');
    caption.textContent = label;
    const age = document.createElement('small');
    age.textContent = this.data ? `${this.data.ageMs} ms old` : 'No snapshot';
    detail.append(caption, age);
    card.append(detail);
    if (this.data && this.data.ageMs > 2000) card.classList.add('is-stale');
    return card;
  }
}

/** EtherCAT AL-state and status-code card backed by DriveSnapshotV1. */
export class TetherEthercatStateWidget extends DriveStateWidget {
  protected render(): void {
    if (!this.isConnected) return;
    this.replaceChildren();
    if (!this.data) {
      this.append(this.createCard('EtherCAT · AL state', 'Slave state', 'WAITING', 'unknown'));
      return;
    }
    const { snapshot } = this.data;
    let tone = 'caution';
    if (snapshot.alState === 8) tone = 'healthy';
    else if (snapshot.alState === 1) tone = 'muted';
    const card = this.createCard('EtherCAT · AL state', `Slave ${snapshot.slaveIndex}`, alStateLabel(snapshot.alState), tone);
    const code = document.createElement('span');
    code.className = 'state-code';
    code.textContent = `AL status 0x${snapshot.alStatusCode.toString(16).padStart(4, '0')}`;
    card.append(code);
    this.append(card);
  }
}

/** CiA 402 state, mode and fault indicators backed by DriveSnapshotV1. */
export class TetherCia402StateWidget extends DriveStateWidget {
  protected render(): void {
    if (!this.isConnected) return;
    this.replaceChildren();
    if (!this.data) {
      this.append(this.createCard('CiA 402 · drive state', 'Statusword', 'WAITING', 'unknown'));
      return;
    }
    const { snapshot } = this.data;
    const faulted = snapshot.ds402State === 7 || snapshot.faultCode !== 0;
    const warning = (snapshot.statusWord & (1 << 7)) !== 0;
    let tone = 'muted';
    if (faulted) tone = 'fault';
    else if (warning) tone = 'caution';
    else if (snapshot.ds402State === 4) tone = 'healthy';
    const card = this.createCard('CiA 402 · drive state', `Mode ${snapshot.displayMode}`, ds402StateLabel(snapshot.ds402State), tone);
    const code = document.createElement('span');
    code.className = 'state-code';
    if (faulted) code.textContent = `Fault 0x${snapshot.faultCode.toString(16).padStart(4, '0')}`;
    else if (warning) code.textContent = 'Warning bit set';
    else code.textContent = `Statusword 0x${snapshot.statusWord.toString(16).padStart(4, '0')}`;
    card.append(code);
    this.append(card);
  }
}

/** EtherCAT master and fleet health card backed by MachineSnapshotV1. */
export class TetherMachineStateWidget extends HTMLElement {
  private data?: MachineWidgetData;

  set model(value: MachineWidgetData | undefined) {
    this.data = value;
    this.render();
  }

  connectedCallback(): void {
    this.render();
  }

  private render(): void {
    if (!this.isConnected) return;
    this.replaceChildren();
    const card = document.createElement('article');
    card.className = 'state-widget machine-state-widget';
    const state = document.createElement('span');
    const snapshot = this.data?.snapshot;
    let tone = 'unknown';
    if (snapshot) tone = snapshot.linkUp && snapshot.actualWkc === snapshot.expectedWkc ? 'healthy' : 'fault';
    state.className = `state-pill ${tone}`;
    state.textContent = snapshot ? alStateLabel(snapshot.alState) : 'WAITING';
    card.append(this.createHeader(state), this.createMetrics(snapshot), this.createFooter(snapshot));
    if (this.data && this.data.ageMs > 2000) card.classList.add('is-stale');
    this.append(card);
  }

  private createHeader(state: HTMLElement): HTMLElement {
    const header = document.createElement('div');
    header.className = 'state-widget-head';
    const title = document.createElement('div');
    const eyebrow = document.createElement('span');
    eyebrow.className = 'eyebrow';
    eyebrow.textContent = 'EtherCAT · master health';
    const heading = document.createElement('h3');
    heading.textContent = 'Fieldbus overview';
    title.append(eyebrow, heading);
    header.append(title, state);
    return header;
  }

  private createMetrics(snapshot?: MachineSnapshotView): HTMLElement {
    const details = document.createElement('div');
    details.className = 'machine-widget-metrics';
    const values: [string, string][] = snapshot
      ? this.snapshotMetricValues(snapshot)
      : [['Working counter', '—'], ['Link', '—'], ['Distributed clocks', '—'], ['Fleet', 'Waiting for typed snapshot']];
    for (const [label, value] of values) {
      const metric = document.createElement('div');
      const name = document.createElement('small');
      name.textContent = label;
      const content = document.createElement('strong');
      content.textContent = value;
      metric.append(name, content);
      details.append(metric);
    }
    return details;
  }

  private snapshotMetricValues(snapshot: MachineSnapshotView): [string, string][] {
    return [
      ['Working counter', `${snapshot.actualWkc} / ${snapshot.expectedWkc}`],
      ['Link', snapshot.linkUp ? 'Up' : 'Down'],
      ['Distributed clocks', snapshot.dcLocked ? 'Locked' : 'Not locked'],
      ['Fleet', `${snapshot.enabledCount}/${snapshot.axisCount} enabled · ${snapshot.faultCount} faults`],
    ];
  }

  private createFooter(snapshot?: MachineSnapshotView): HTMLElement {
    const footer = document.createElement('div');
    footer.className = 'state-widget-detail';
    const source = document.createElement('span');
    source.textContent = snapshot?.simulated ? 'Simulation' : 'Live server state';
    const age = document.createElement('small');
    age.textContent = this.data ? `${this.data.ageMs} ms old` : 'No snapshot';
    footer.append(source, age);
    return footer;
  }
}

if (!customElements.get('tether-ethercat-state')) {
  customElements.define('tether-ethercat-state', TetherEthercatStateWidget);
}
if (!customElements.get('tether-cia402-state')) {
  customElements.define('tether-cia402-state', TetherCia402StateWidget);
}
if (!customElements.get('tether-machine-state')) {
  customElements.define('tether-machine-state', TetherMachineStateWidget);
}