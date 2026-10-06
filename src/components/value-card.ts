/** Read-once catalog value card custom element. */
import { TetherIOClient } from '../client';
import { formatValue } from '../protocol';
import type { CatalogEntry } from '../protocol';
import { schemaTypeName } from './format';

export class TetherValueCard extends HTMLElement {
  private entry?: CatalogEntry;
  private client?: TetherIOClient;
  private value = '—';

  set model(value: { entry: CatalogEntry; client: TetherIOClient }) {
    this.entry = value.entry;
    this.client = value.client;
    this.render();
  }

  connectedCallback(): void {
    this.render();
  }

  private render(): void {
    if (!this.entry) return;
    this.replaceChildren();
    const head = document.createElement('div');
    head.className = 'value-card-head';
    const name = document.createElement('span');
    name.textContent = this.entry.name;
    const button = document.createElement('button');
    button.className = 'read-button';
    button.textContent = 'Read';
    button.addEventListener('click', () => void this.read());
    head.append(name, button);
    const value = document.createElement('strong');
    value.className = 'value';
    value.textContent = this.value;
    const group = document.createElement('small');
    group.textContent = `${this.entry.group} · ${schemaTypeName(this.entry)}`;
    this.append(head, value, group);
  }

  async read(): Promise<void> {
    if (!this.entry || !this.client) return;
    try {
      this.value = formatValue(await this.client.get(this.entry.kind, this.entry.id));
    } catch (error) {
      this.value = error instanceof Error ? error.message : 'Read failed';
    }
    this.render();
  }
}

customElements.define('tether-value-card', TetherValueCard);
