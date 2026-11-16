import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { ValueType, type CatalogEntry } from '../protocol';
import type { SchemaNodeV6 } from '../schema-v6/types';
import type { TetherIOClient } from '../client';
import type { DataHub } from '../data/hub';
import type { TileDef } from '../dash/model';
import { bindingKeys, bindingLabel } from './hmi';
import './hmi'; // registers tile-trend / tile-bitbutton

const entry = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id: 7n,
  schemaEpoch: 0n,
  schemaSlot: 0,
  flags: 0,
  name: 'plc.Main.AUTO',
  description: '',
  group: '',
  kind: 'param',
  ...over,
});

const scalarNode = (scalarType: ValueType): SchemaNodeV6 => ({
  key: new Uint8Array([1]),
  revision: 1,
  kind: 1,
  flags: 0,
  name: 't',
  description: '',
  annotations: new Map(),
  scalarType,
  maxBytes: 0,
  fixedCount: 0,
  minCount: 0,
  maxCount: 0,
  structEncoding: 0,
  fields: [],
  oneOfMembers: [],
});

interface FakeHub {
  hub: DataHub;
  values: Map<string, number | string>;
  emitValues: () => void;
  setParameter: ReturnType<typeof vi.fn>;
}

function fakeHub(opts: {
  entries?: CatalogEntry[];
  values?: Record<string, number | string>;
  writable?: boolean;
} = {}): FakeHub {
  const values = new Map<string, number | string>(Object.entries(opts.values ?? {}));
  const entries = opts.entries ?? [entry({ flags: opts.writable === false ? 0 : 0x02 })];
  const cbs = new Map<string, () => void>();
  const setParameter = vi.fn(async () => {});
  const client = {
    schemaCatalog: {
      epoch: 0,
      manifest: [],
      nodesByKey: new Map(),
      slotToNode: [scalarNode(ValueType.I16)],
    },
    setParameter,
  } as unknown as TetherIOClient;
  const hub = {
    values,
    params: entries.filter((e) => e.kind === 'param'),
    signals: entries.filter((e) => e.kind !== 'param'),
    client,
    on: (topic: string, cb: () => void) => {
      cbs.set(topic, cb);
      return () => cbs.delete(topic);
    },
    acquireBindings: () => () => {},
  } as unknown as DataHub;
  return {
    hub,
    values,
    setParameter,
    emitValues: () => cbs.get('values')?.(),
  };
}

function tileDef(over: Partial<TileDef> = {}): TileDef {
  return {
    id: 't1',
    type: 'trend',
    x: 0,
    y: 0,
    w: 4,
    h: 3,
    options: {},
    ...over,
  } as TileDef;
}

interface Mountable extends HTMLElement {
  updateComplete: Promise<unknown>;
  hub: DataHub;
  def: TileDef;
}

async function mount(tag: string, hub: DataHub, def: TileDef): Promise<Mountable> {
  const el = document.createElement(tag) as Mountable;
  document.body.appendChild(el);
  el.hub = hub;
  el.def = def;
  await el.updateComplete;
  return el;
}

describe('hmi binding helpers', () => {
  it('bindingKeys rejoins entry.field and passes bare entries', () => {
    const def = tileDef({
      bindings: [
        { entry: 'plc.Main.PV' },
        { entry: 'plc.Main.CFG', field: 'scale' },
      ],
    });
    expect(bindingKeys(def)).toEqual(['plc.Main.PV', 'plc.Main.CFG.scale']);
    expect(bindingKeys(undefined)).toEqual([]);
  });

  it('bindingLabel prefers the labels JSON array, falls back to leaf', () => {
    const def = tileDef({ options: { labels: '["PV","SP"]' } });
    expect(bindingLabel(def, 'plc.Main.PV', 0)).toBe('PV');
    expect(bindingLabel(def, 'plc.Main.SP', 1)).toBe('SP');
    expect(bindingLabel(def, 'plc.Main.X', 5)).toBe('X');
    expect(bindingLabel(tileDef(), 'plc.Main.TIC101.PV', 0)).toBe('PV');
    expect(bindingLabel(tileDef({ options: { labels: 'not json' } }), 'a.b', 0)).toBe('b');
  });
});

describe('tile-trend', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('draws one path per bound pen once two samples exist', async () => {
    const { hub, values } = fakeHub({
      entries: [entry({ name: 'plc.Main.PV', kind: 'signal' }), entry({ name: 'plc.Main.SP', kind: 'signal' })],
      values: { 'plc.Main.PV': 42, 'plc.Main.SP': 50 },
    });
    const el = await mount('tile-trend', hub, tileDef({
      bindings: [{ entry: 'plc.Main.PV' }, { entry: 'plc.Main.SP' }],
      options: { labels: '["PV","SP"]', windowSec: 60 },
    }));
    /* first tick samples, second gives every pen 2 points → paths */
    vi.advanceTimersByTime(600);
    await el.updateComplete;
    vi.advanceTimersByTime(600);
    await el.updateComplete;
    expect(el.querySelectorAll('svg path')).toHaveLength(2);
    expect(el.querySelectorAll('.trend-pen')).toHaveLength(2);
    expect(el.querySelector('.trend-pen b')?.textContent).toBe('42.0');
    void values;
  });

  it('keeps sampling steady signals — the window does not drain', async () => {
    const { hub } = fakeHub({
      entries: [entry({ name: 'plc.Main.PV', kind: 'signal' })],
      values: { 'plc.Main.PV': 20 },
    });
    const el = await mount('tile-trend', hub, tileDef({
      bindings: [{ entry: 'plc.Main.PV' }],
      options: { windowSec: 2 },
    }));
    /* steady value: 'values' never re-emits, but the tile's own timer
       keeps appending points so the pen still has a visible trace */
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(500);
      await el.updateComplete;
    }
    expect(el.querySelectorAll('svg path').length).toBe(1);
  });

  it('shows threshold lines when configured', async () => {
    const { hub } = fakeHub({
      entries: [entry({ name: 'plc.Main.PV', kind: 'signal' })],
      values: { 'plc.Main.PV': 80 },
    });
    const el = await mount('tile-trend', hub, tileDef({
      bindings: [{ entry: 'plc.Main.PV' }],
      options: { min: 0, max: 100, warnAbove: 70, critAbove: 90 },
    }));
    vi.advanceTimersByTime(1200);
    await el.updateComplete;
    expect(el.querySelectorAll('.trend-th.warn')).toHaveLength(1);
    expect(el.querySelectorAll('.trend-th.crit')).toHaveLength(1);
  });
});

describe('tile-bitbutton', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('is disabled when the bound entry is not a writable param', async () => {
    const { hub } = fakeHub({
      entries: [entry({ name: 'plc.Main.RUN', kind: 'signal', flags: 0 })],
      values: { 'plc.Main.RUN': 0 },
    });
    const el = await mount('tile-bitbutton', hub, tileDef({
      type: 'bitbutton',
      bindings: [{ entry: 'plc.Main.RUN' }],
      options: { label: 'RUN' },
    }));
    const btn = el.querySelector('button')!;
    expect(btn.disabled).toBe(true);
    btn.click();
    await Promise.resolve();
    expect(el.querySelector('.bitbtn-state')).toBeTruthy();
  });

  it('toggle mode writes onValue then offValue on alternating clicks', async () => {
    const { hub, values, setParameter, emitValues } = fakeHub({
      values: { 'plc.Main.AUTO': 0 },
    });
    const el = await mount('tile-bitbutton', hub, tileDef({
      type: 'bitbutton',
      bindings: [{ entry: 'plc.Main.AUTO' }],
      options: { label: 'AUTO', mode: 'toggle' },
    }));
    const btn = el.querySelector('button')!;
    expect(btn.disabled).toBe(false);

    btn.click();
    await vi.waitFor(() => expect(setParameter).toHaveBeenCalledTimes(1));
    /* simulate the PLC applying the write */
    values.set('plc.Main.AUTO', 1);
    emitValues();
    await el.updateComplete;
    expect(btn.className).toContain('on');

    btn.click();
    await vi.waitFor(() => expect(setParameter).toHaveBeenCalledTimes(2));
  });

  it('momentary mode writes on press and off on release', async () => {
    const { hub, setParameter } = fakeHub({ values: { 'plc.Main.AUTO': 0 } });
    const el = await mount('tile-bitbutton', hub, tileDef({
      type: 'bitbutton',
      bindings: [{ entry: 'plc.Main.AUTO' }],
      options: { mode: 'momentary', onValue: 5, offValue: 2 },
    }));
    const btn = el.querySelector('button')!;
    btn.dispatchEvent(new Event('pointerdown'));
    await vi.waitFor(() => expect(setParameter).toHaveBeenCalledTimes(1));
    btn.dispatchEvent(new Event('pointerup'));
    await vi.waitFor(() => expect(setParameter).toHaveBeenCalledTimes(2));
  });
});
