/**
 * TileElement — base class for every board tile.
 *
 * Tiles render into light DOM (global stylesheet applies) and never talk to
 * the client directly: they subscribe to {@link DataHub} topics and declare
 * signal bindings, which the hub deduplicates into one poll set. Properties
 * `hub` and `def` are assigned by the tile frame before first render.
 */
import { LitElement } from 'lit';
import { DataHub, HubTopic } from '../data/hub';
import { TileDef } from '../dash/model';

export abstract class TileElement extends LitElement {
  declare hub?: DataHub;
  declare def?: TileDef;
  declare editing: boolean;

  static properties = {
    hub: { attribute: false },
    def: { attribute: false },
    editing: { type: Boolean, reflect: true },
  };

  constructor() {
    super();
    this.editing = false;
  }

  private unsubs: (() => void)[] = [];
  private bindingRelease?: () => void;

  createRenderRoot(): this {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.syncSubscriptions();
  }

  disconnectedCallback(): void {
    this.clearSubscriptions();
    super.disconnectedCallback();
  }

  willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('hub') || changed.has('def')) this.syncSubscriptions();
  }

  private syncSubscriptions(): void {
    this.clearSubscriptions();
    const hub = this.hub;
    if (!hub || !this.isConnected) return;
    for (const topic of this.topics()) this.unsubs.push(hub.on(topic, () => this.onHub(topic)));
    const keys = this.bindingKeys();
    if (keys.length) this.bindingRelease = hub.acquireBindings(keys);
    this.afterSubscribe();
  }

  private clearSubscriptions(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.bindingRelease?.();
    this.bindingRelease = undefined;
  }

  /** Hub topics this tile re-renders on. */
  protected topics(): HubTopic[] {
    return [];
  }

  /** Signal keys (`entry` or `entry.field`) the hub should poll for this tile. */
  protected bindingKeys(): string[] {
    return bindingKeysOf(this.def);
  }

  protected onHub(_topic: HubTopic): void {
    this.requestUpdate();
  }

  /** Called after (re)subscribing — override to pull initial data. */
  protected afterSubscribe(): void {}
}

/** All signal keys a tile's bindings/axes reference. */
export function bindingKeysOf(def?: TileDef): string[] {
  const keys: string[] = [];
  for (const b of def?.bindings ?? []) keys.push(b.field ? `${b.entry}.${b.field}` : b.entry);
  for (const a of def?.axes ?? []) {
    keys.push(`${a.entry}.${a.field}`);
    if (a.targetField) keys.push(`${a.entry}.${a.targetField}`);
  }
  return keys;
}

export function esc(text: string): string {
  const span = document.createElement('span');
  span.textContent = text;
  return span.innerHTML;
}

/** First binding of a display tile, if any. */
export function firstBinding(
  def?: TileDef,
): { entry: string; field?: string; key: string } | undefined {
  const b = def?.bindings?.[0];
  if (!b) return undefined;
  return { entry: b.entry, field: b.field, key: b.field ? `${b.entry}.${b.field}` : b.entry };
}

/** Numeric option from tile def with fallback. */
export function opt(def: TileDef | undefined, key: string): unknown {
  return def?.options?.[key];
}

export function optNumber(def: TileDef | undefined, key: string): number | undefined {
  const v = def?.options?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function optString(def: TileDef | undefined, key: string): string | undefined {
  const v = def?.options?.[key];
  return typeof v === 'string' && v.length ? v : undefined;
}
