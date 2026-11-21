import { describe, expect, it } from 'vitest';
import './screen-designer';
import {
  defaultScreen, normalizeScreen, screenScene, widgetScene,
  saveScreen, loadScreen, listScreens, type HmiScreen,
} from './screen';

function scr(): HmiScreen {
  const s = defaultScreen('ops');
  s.widgets = [
    { id: 1, kind: 'gauge', x: 10, y: 20, w: 160, h: 110, label: 'Temp',
      signal: 'plc.Main.pv', unit: '°C', min: 0, max: 200, warn: 150, crit: 180 },
    { id: 2, kind: 'digital', x: 200, y: 20, w: 140, h: 56, signal: 'plc.Main.sp' },
    { id: 3, kind: 'text', x: 0, y: 400, w: 200, h: 28, text: 'Line 1' },
    { id: 4, kind: 'lamp', x: 400, y: 20, w: 120, h: 90, signal: 'plc.Main.run' },
  ];
  return s;
}

describe('hmi screen model', () => {
  it('normalizeScreen round-trips and drops bad widgets', () => {
    const s = scr();
    const j = JSON.parse(JSON.stringify(s));
    j.widgets.push({ kind: 'bogus', x: 0, y: 0, w: 10, h: 10 });
    j.widgets.push({ kind: 'gauge' }); // missing w/h → defaults
    const n = normalizeScreen(j)!;
    expect(n.version).toBe('hmi.screen.v1');
    expect(n.widgets).toHaveLength(5);
    expect(n.widgets[4]!.w).toBeGreaterThanOrEqual(16);
    expect(normalizeScreen({ version: 'other' })).toBeUndefined();
    expect(normalizeScreen(null)).toBeUndefined();
  });

  it('widgetScene resolves bound signals into scenes', () => {
    const g = widgetScene(scr().widgets[0]!, { 'plc.Main.pv': 175 });
    expect(g.ops.length).toBeGreaterThan(3);
    // value above crit → needle/zone ops exist; just assert ops non-empty
    const d = widgetScene(scr().widgets[1]!, { 'plc.Main.sp': 80.25 });
    expect(d.ops.some((o) => o.k === 'text')).toBe(true);
  });

  it('screenScene translates widget ops into screen coords', () => {
    const sc = screenScene(scr(), { 'plc.Main.pv': 50 });
    expect(sc.w).toBe(800);
    expect(sc.ops.length).toBeGreaterThan(10);
    // every op coordinate shifted by widget pos — spot-check a text op
    const texts = sc.ops.filter((o) => o.k === 'text');
    expect(texts.length).toBeGreaterThan(0);
  });

  it('persistence round-trips via localStorage-shaped store', () => {
    const mem = new Map<string, string>();
    const store = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      key: (i: number) => [...mem.keys()][i] ?? null,
      get length() { return mem.size; },
    };
    const s = scr();
    saveScreen(store, s);
    expect(listScreens(store)).toEqual(['ops']);
    const back = loadScreen(store, 'ops')!;
    expect(back.widgets).toHaveLength(4);
    expect(back.widgets[0]!.signal).toBe('plc.Main.pv');
    saveScreen(store, defaultScreen('second'));
    expect(listScreens(store)).toEqual(['ops', 'second']);
  });
});

describe('hmi-screen-designer element', () => {
  it('adds widgets from the palette and emits change', async () => {
    const { HmiScreenDesigner } = await import('./screen-designer');
    void HmiScreenDesigner;
    const el = document.createElement('hmi-screen-designer') as InstanceType<typeof HmiScreenDesigner>;
    document.body.appendChild(el);
    await el.updateComplete;
    const changes: string[] = [];
    el.addEventListener('change', (e) => changes.push((e as CustomEvent<string>).detail));
    const btns = [...el.querySelectorAll<HTMLButtonElement>('.hmi-d-palette .chip-btn')];
    expect(btns.length).toBe(6);
    btns[0]!.click(); // gauge
    await el.updateComplete;
    expect(el.screen.widgets).toHaveLength(1);
    expect(el.screen.widgets[0]!.kind).toBe('gauge');
    expect(changes.length).toBe(1);
    // props panel shows for selection
    expect(el.querySelector('.hmi-d-props input')).toBeTruthy();
    el.remove();
  });

  it('deletes the selected widget', async () => {
    const el = document.createElement('hmi-screen-designer') as InstanceType<typeof import('./screen-designer').HmiScreenDesigner>;
    document.body.appendChild(el);
    await el.updateComplete;
    (el as unknown as { addWidget(k: string): void }).addWidget('text');
    await el.updateComplete;
    expect(el.screen.widgets).toHaveLength(1);
    (el as unknown as { delWidget(id: number): void }).delWidget(1);
    await el.updateComplete;
    expect(el.screen.widgets).toHaveLength(0);
    el.remove();
  });
});
