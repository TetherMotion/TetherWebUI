import { MachineEvent, eventSeverityLabel } from '../domain/event-history';

export class TetherEventTimeline extends HTMLElement {
  private rows: readonly MachineEvent[] = [];
  private hasGap = false;
  private available = false;

  set model(value: { events: readonly MachineEvent[]; gapDetected: boolean; available: boolean } | undefined) {
    this.rows = value?.events ?? [];
    this.hasGap = value?.gapDetected ?? false;
    this.available = value?.available ?? false;
    this.render();
  }

  connectedCallback(): void { this.render(); }

  private render(): void {
    this.replaceChildren();
    if (this.hasGap) {
      const notice = document.createElement('p');
      notice.className = 'event-gap-notice';
      notice.setAttribute('role', 'status');
      notice.textContent = 'Event history gap detected: the server retention window or event sequence changed. Newest available history is shown.';
      this.append(notice);
    }
    if (this.rows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'event-empty';
      empty.textContent = this.available ? 'No retained events are available.' : 'This server does not advertise typed event history.';
      this.append(empty);
      return;
    }
    const list = document.createElement('ol');
    list.className = 'event-list';
    list.setAttribute('aria-label', 'Machine event history');
    for (const event of [...this.rows].reverse()) {
      const item = document.createElement('li');
      item.className = `event-row severity-${event.severity}`;
      const heading = document.createElement('div');
      heading.className = 'event-row-heading';
      const title = document.createElement('strong');
      title.textContent = event.eventType;
      const severity = document.createElement('span');
      severity.className = `event-severity severity-${event.severity}`;
      severity.textContent = eventSeverityLabel(event.severity);
      heading.append(title, severity);
      const description = document.createElement('p');
      description.textContent = event.description;
      const metadata = document.createElement('small');
      const codeLabel = event.code ? ` · code ${event.code}` : '';
      metadata.textContent = `#${event.eventId.toString()} · ${event.sourceId} · generation ${event.stateGeneration.toString()} · T+${event.timestampUs.toString()} µs${codeLabel}`;
      item.append(heading, description, metadata);
      list.append(item);
    }
    this.append(list);
  }
}

if (!customElements.get('tether-event-timeline')) {
  customElements.define('tether-event-timeline', TetherEventTimeline);
}
