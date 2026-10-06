/** Legacy F64 parameter editor custom element. */
import { TetherIOClient } from '../client';
import type { CatalogEntry } from '../protocol';
import { schemaTypeName } from './format';

export class TetherParamPanel extends HTMLElement {
  private params: CatalogEntry[] = [];
  private client?: TetherIOClient;

  set model(value: { params: CatalogEntry[]; client: TetherIOClient }) {
    this.params = value.params;
    this.client = value.client;
    this.render();
  }

  connectedCallback(): void {
    this.render();
  }

  private encodeF64(value: number): Uint8Array {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setFloat64(0, value, true);
    return out;
  }

  private render(): void {
    this.replaceChildren();
    if (this.params.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No parameters available.';
      this.append(empty);
      return;
    }

    const heading = document.createElement('div');
    heading.className = 'param-panel-head';
    const eyebrow = document.createElement('span');
    eyebrow.className = 'eyebrow';
    eyebrow.textContent = 'Parameters';
    const title = document.createElement('h2');
    title.textContent = 'Live tuning';
    heading.append(eyebrow, title);
    this.append(heading);

    for (const entry of this.params) {
      const row = document.createElement('label');
      row.className = 'param-row';
      row.dataset.id = entry.id.toString();
      const description = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = entry.name;
      const metadata = document.createElement('small');
      metadata.textContent = `${entry.group} · ${schemaTypeName(entry)}`;
      description.append(name, metadata);
      const input = document.createElement('input');
      input.type = 'number';
      input.step = 'any';
      input.disabled = true;
      input.addEventListener('change', () => {
        const value = Number.parseFloat(input.value);
        if (!Number.isFinite(value) || !this.client) return;
        void this.client.setParameter(entry.id, this.encodeF64(value));
      });
      row.append(description, input);
      this.append(row);
      void this.loadValue(entry, input);
    }
  }

  private async loadValue(entry: CatalogEntry, input: HTMLInputElement): Promise<void> {
    if (!this.client) return;
    try {
      const bytes = await this.client.get('param', entry.id);
      if (bytes.length !== 8) return;
      input.value = String(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(0, true));
      input.disabled = false;
    } catch {
      // Leave unavailable values disabled; the user can still inspect the catalog.
    }
  }
}

customElements.define('tether-param-panel', TetherParamPanel);
