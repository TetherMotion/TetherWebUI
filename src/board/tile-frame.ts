/**
 * tile-frame — the grid cell chrome: title bar, config popover, drag/resize
 * grips (edit mode only). Hosts the actual tile element imperatively so any
 * registered tag can be mounted.
 */
import { html, nothing, TemplateResult } from 'lit';
import { DataHub } from '../data/hub';
import { SceneAxisBinding, TileDef } from '../dash/model';
import { ConfigField, specFor } from '../dash/registry';
import { ensureTileTag } from '../dash/loaders';
import { icon } from '../icons';
import { TileElement } from '../tiles/base';

const AXIS_LETTERS = ['x', 'y', 'z'] as const;

export class TileFrame extends TileElement {
  private _readonly = false;
  private configOpen = false;

  set readonly(value: boolean) {
    const v = !!value;
    if (v === this._readonly) return;
    this._readonly = v;
    this.requestUpdate();
  }

  get readonly(): boolean {
    return this._readonly;
  }

  protected topics(): never[] {
    return [];
  }

  private tileEl?: TileElement;
  private mountSeq = 0;

  willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('def') || changed.has('hub') || changed.has('editing')) this.mountTile();
  }

  private mountTile(): void {
    const def = this.def;
    const spec = def ? specFor(def) : undefined;
    const body = this.querySelector<HTMLElement>('.tile-body');
    if (!body) return;
    if (!spec) {
      body.textContent = `Unknown tile type: ${def?.type ?? '?'}`;
      this.tileEl = undefined;
      return;
    }
    const tag = spec.tag;
    const seq = ++this.mountSeq;
    void ensureTileTag(tag).then(() => {
      if (seq !== this.mountSeq || !this.isConnected) return;
      const bodyNow = this.querySelector<HTMLElement>('.tile-body');
      if (!bodyNow) return;
      if (!this.tileEl || this.tileEl.tagName.toLowerCase() !== tag) {
        const el = document.createElement(tag) as TileElement;
        bodyNow.replaceChildren(el);
        this.tileEl = el;
      }
      this.tileEl.hub = this.hub;
      this.tileEl.def = this.def;
      this.tileEl.editing = this.editing;
    });
  }

  protected updated(): void {
    this.mountTile();
  }

  private tileTitle(): string {
    return this.def?.title ?? specFor(this.def ?? ({ type: '' } as TileDef))?.label ?? 'Tile';
  }

  // ---- Config popover ---------------------------------------------------------

  private fieldValue(field: ConfigField): unknown {
    const def = this.def;
    if (!def) return undefined;
    const key = field.key;
    if (field.kind === 'signal') return def.bindings?.[0]?.entry ?? '';
    if (field.kind === 'signals')
      return (def.bindings ?? [])
        .map((b) => (b.field ? `${b.entry}.${b.field}` : b.entry))
        .join('\n');
    if (field.kind === 'axis' || field.kind === 'action') return def.options?.[key];
    const axisMatch = /^([xyz])\.(.+)$/.exec(key);
    if (axisMatch) {
      const axis = def.axes?.[AXIS_LETTERS.indexOf(axisMatch[1] as 'x' | 'y' | 'z')];
      const prop = axisMatch[2] as keyof SceneAxisBinding;
      if (prop === 'entry' || prop === 'field' || prop === 'min' || prop === 'max')
        return axis?.[prop];
      return undefined;
    }
    if (key === 'field') return def.bindings?.[0]?.field ?? '';
    if (key === 'targets') return (def.axes ?? []).map((a) => a.targetField ?? '').join(',');
    return def.options?.[key];
  }

  private applyField(next: TileDef, field: ConfigField, raw: string): void {
    const key = field.key;
    const options = { ...(next.options ?? {}) };
    next.options = options;
    const setOpt = (k: string, v: unknown) => {
      if (v === '' || v === undefined) delete options[k];
      else options[k] = v;
    };
    if (field.kind === 'signal') {
      next.bindings = [{ ...(next.bindings?.[0] ?? {}), entry: raw }];
      return;
    }
    if (field.kind === 'signals') {
      next.bindings = raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length)
        .map((line) => {
          const dot = line.lastIndexOf('.');
          return dot > 0
            ? { entry: line.slice(0, dot), field: line.slice(dot + 1) }
            : { entry: line };
        });
      return;
    }
    if (field.kind === 'action') {
      setOpt(key, Number(raw));
      return;
    }
    if (field.kind === 'number') {
      setOpt(key, raw === '' ? undefined : Number(raw));
      return;
    }
    if (field.kind === 'checkbox') {
      setOpt(key, raw === 'on' || raw === 'true' || raw === '1');
      return;
    }
    const axisMatch = /^([xyz])\.(entry|field|min|max)$/.exec(key);
    if (axisMatch) {
      const idx = AXIS_LETTERS.indexOf(axisMatch[1] as 'x' | 'y' | 'z');
      const axes = (next.axes ?? []).map((a) => ({ ...a }));
      while (axes.length <= idx)
        axes.push({ name: AXIS_LETTERS[axes.length], entry: '', field: '' });
      const prop = axisMatch[2];
      const axis = axes[idx]!;
      if (prop === 'min' || prop === 'max') {
        const v = raw === '' ? undefined : Number(raw);
        if (v === undefined) delete axis[prop];
        else axis[prop] = v;
      } else {
        axis[prop as 'entry' | 'field'] = raw;
      }
      next.axes = axes.filter((a) => a.entry.length);
      return;
    }
    if (key === 'field') {
      if (next.bindings?.[0]) next.bindings = [{ ...next.bindings[0], field: raw || undefined }];
      return;
    }
    if (key === 'targets') {
      const targets = raw.split(',').map((t) => t.trim());
      next.axes = (next.axes ?? []).map((a, i) => {
        const t = targets[i];
        const copy = { ...a };
        if (t) copy.targetField = t;
        else delete copy.targetField;
        return copy;
      });
      return;
    }
    setOpt(key, raw);
  }

  private onConfigSubmit(event: SubmitEvent): void {
    event.preventDefault();
    const def = this.def;
    const spec = def ? specFor(def) : undefined;
    if (!def || !spec?.fields) return;
    const form = event.target as HTMLFormElement;
    const next: TileDef = { ...def, options: { ...(def.options ?? {}) } };
    for (const field of spec.fields) {
      const el = form.elements.namedItem(`cfg-${field.key}`);
      const raw =
        field.kind === 'checkbox'
          ? String((el as HTMLInputElement | null)?.checked ?? false)
          : ((el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null)?.value ??
            '');
      this.applyField(next, field, String(raw));
    }
    this.configOpen = false;
    this.dispatchEvent(
      new CustomEvent('tile-config', {
        bubbles: true,
        composed: true,
        detail: { def: next },
      }),
    );
  }

  private renderField(field: ConfigField): TemplateResult {
    const value = this.fieldValue(field);
    const name = `cfg-${field.key}`;
    const hub = this.hub;
    let input: TemplateResult;
    if (field.kind === 'checkbox') {
      input = html`<input type="checkbox" name=${name} ?checked=${value === true} />`;
    } else if (field.kind === 'signals') {
      input = html`<textarea name=${name} rows="4" .value=${String(value ?? '')}></textarea>`;
    } else if (field.kind === 'select' || field.kind === 'action') {
      const str = String(value ?? '');
      input = html`<select name=${name}>
        ${(field.options ?? []).map(
          (o) => html`<option value=${o.value} ?selected=${o.value === str}>${o.label}</option>`,
        )}
      </select>`;
    } else if (field.kind === 'axis') {
      const axes = hub?.commandAxes() ?? [];
      input = html`<select name=${name}>
        <option value="">— pick axis —</option>
        ${axes.map(
          (a) =>
            html`<option value=${a.stableId} ?selected=${a.stableId === value}>${a.name}</option>`,
        )}
      </select>`;
    } else if (field.kind === 'signal') {
      input = html`<input
        name=${name}
        list="tile-signal-names"
        .value=${String(value ?? '')}
        placeholder=${field.placeholder ?? 'signal name'}
      />`;
    } else if (field.kind === 'number') {
      input = html`<input
        type="number"
        step="any"
        name=${name}
        .value=${value === undefined ? '' : String(value)}
        placeholder=${field.placeholder ?? ''}
      />`;
    } else {
      input = html`<input
        name=${name}
        .value=${String(value ?? '')}
        placeholder=${field.placeholder ?? ''}
      />`;
    }
    return html`<label class="cfg-field"
      ><span>${field.label}</span
      >${input}${field.hint ? html`<small>${field.hint}</small>` : nothing}
    </label>`;
  }

  protected render(): TemplateResult {
    const def = this.def;
    const spec = def ? specFor(def) : undefined;
    const hideTitle = def?.options?.['hideTitle'] === true;
    const signals = this.hub?.signals ?? [];
    return html`
      ${
        !hideTitle || this.editing
          ? html`<header
              class="tile-head${this.editing ? ' grip' : ''}"
              @pointerdown=${(e: PointerEvent) =>
                this.editing && !this.readonly && !(e.target as HTMLElement).closest('button')
                  ? this.dispatchEvent(
                      new CustomEvent('grip-move', { detail: { event: e }, bubbles: true }),
                    )
                  : undefined}
            >
              <span class="tile-title">${this.tileTitle()}</span>
              ${
                this.editing && !this.readonly
                  ? html`<span class="tile-tools">
                      ${
                        spec?.fields?.length
                          ? html`<button
                              type="button"
                              class="icon-btn"
                              title="Configure tile"
                              @click=${() => (this.configOpen = !this.configOpen)}
                            >
                              ${icon('settings-2')}
                            </button>`
                          : nothing
                      }
                      <button
                        type="button"
                        class="icon-btn"
                        title="Remove tile"
                        @click=${() =>
                          this.dispatchEvent(new CustomEvent('tile-remove', { bubbles: true }))}
                      >
                        ${icon('x')}
                      </button>
                    </span>`
                  : nothing
              }
            </header>`
          : nothing
      }
      <div class="tile-body"></div>
      ${
        this.editing && !this.readonly
          ? html`<span
              class="tile-resize"
              title="Drag to resize"
              @pointerdown=${(e: PointerEvent) =>
                this.dispatchEvent(
                  new CustomEvent('grip-resize', { detail: { event: e }, bubbles: true }),
                )}
            ></span>`
          : nothing
      }
      ${
        this.configOpen && spec?.fields
          ? html`<form class="tile-config" @submit=${(e: SubmitEvent) => this.onConfigSubmit(e)}>
              <datalist id="tile-signal-names">
                ${signals.map((s) => html`<option value=${s.name}></option>`)}
              </datalist>
              ${spec.fields.map((f) => this.renderField(f))}
              <div class="cfg-actions">
                <button type="submit" class="primary">Apply</button>
                <button type="button" @click=${() => (this.configOpen = false)}>Cancel</button>
              </div>
            </form>`
          : nothing
      }
    `;
  }
}

customElements.define('tile-frame', TileFrame);
