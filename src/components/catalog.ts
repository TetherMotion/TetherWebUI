/** Filterable catalog list custom element. */
import type { CatalogEntry } from '../protocol';
import { schemaTypeName } from './format';

export class TetherCatalog extends HTMLElement {
  private entries: CatalogEntry[] = [];
  private query = '';
  private selected = new Set<bigint>();

  set items(value: CatalogEntry[]) {
    this.entries = value;
    this.render();
  }

  get selectedIds(): bigint[] {
    return [...this.selected];
  }

  connectedCallback(): void {
    this.innerHTML = '<input class="catalog-filter" placeholder="Filter name, group, description…" aria-label="Filter catalog"><div class="catalog-list"></div>';
    this.querySelector('input')?.addEventListener('input', (event) => {
      this.query = (event.target as HTMLInputElement).value.toLowerCase();
      this.render();
    });
    this.render();
  }

  private render(): void {
    const list = this.querySelector('.catalog-list');
    if (!list) return;
    const rows = this.entries.filter((entry) =>
      `${entry.name} ${entry.group} ${entry.description} ${entry.kind}`.toLowerCase().includes(this.query),
    );
    list.replaceChildren();
    for (const entry of rows) {
      const row = document.createElement('div');
      row.className = 'catalog-row';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = this.selected.has(entry.id);
      checkbox.setAttribute('aria-label', `Select ${entry.name} for streaming`);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) this.selected.add(entry.id);
        else this.selected.delete(entry.id);
        this.dispatchEvent(new Event('selection-change'));
      });
      const description = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = entry.name;
      const metadata = document.createElement('small');
      metadata.textContent = `${entry.kind} · ${entry.group} · ${schemaTypeName(entry)}`;
      description.append(name, metadata);
      const readButton = document.createElement('button');
      readButton.type = 'button';
      readButton.title = 'Read now';
      readButton.setAttribute('aria-label', `Read ${entry.name} once`);
      readButton.textContent = '↗';
      readButton.addEventListener('click', () => this.dispatchEvent(new CustomEvent('read-entry', { detail: entry.id })));
      row.append(checkbox, description, readButton);
      list.append(row);
    }
  }
}

customElements.define('tether-catalog', TetherCatalog);
