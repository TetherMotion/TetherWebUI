/** Descriptive, non-invoking remote function catalog element. */
import { FunctionEntry } from '../protocol';

export class TetherFunctionList extends HTMLElement {
  private functions: FunctionEntry[] = [];

  set items(value: FunctionEntry[]) {
    this.functions = value;
    this.render();
  }

  connectedCallback(): void {
    this.render();
  }

  private render(): void {
    this.replaceChildren();
    if (this.functions.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No functions advertised.';
      this.append(empty);
      return;
    }
    for (const fn of this.functions) {
      const row = document.createElement('article');
      row.className = 'function-row';
      const details = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = fn.name;
      const description = document.createElement('small');
      description.textContent = fn.description || fn.group;
      details.append(name, description);
      const count = document.createElement('span');
      count.textContent = `${fn.parameters.length} parameter${fn.parameters.length === 1 ? '' : 's'}`;
      row.append(details, count);
      this.append(row);
    }
  }
}

customElements.define('tether-function-list', TetherFunctionList);
