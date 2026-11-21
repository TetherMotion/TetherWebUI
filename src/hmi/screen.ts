/**
 * Freeform HMI screen model — `hmi.screen.v1`.
 *
 * A screen is an absolutely-positioned widget list on a fixed design
 * surface (default 800x480). Widgets reference live signals by catalog
 * key (`plc.*` names from the data hub) and render through the shared
 * scene IR — the same builders the dashboard tiles use — so a screen
 * designed here can later feed the WebGPU/native backends unchanged.
 */
import { HmiScene, SceneOp, ScenePt } from './scene';
import {
  gaugeScene, bargraphScene, digitalScene, lampStackScene,
  alarmBoardScene, type AlarmRow,
} from './widgets';

export type ScreenWidgetKind =
  | 'gauge' | 'bar' | 'digital' | 'lamp' | 'text' | 'alarmboard';

export interface ScreenWidget {
  id: number;
  kind: ScreenWidgetKind;
  x: number; y: number; w: number; h: number;
  /** caption / static text */
  label?: string;
  /** catalog signal key, e.g. 'plc.Main.pv' or 'plc.image.I.ch.temp' */
  signal?: string;
  unit?: string;
  min?: number; max?: number;
  warn?: number; crit?: number;
  decimals?: number;
  /** static text payload (kind 'text') */
  text?: string;
  /** bar orientation */
  vertical?: boolean;
}

export interface HmiScreen {
  version: 'hmi.screen.v1';
  name: string;
  w: number;
  h: number;
  widgets: ScreenWidget[];
}

export const SCREEN_KINDS: { kind: ScreenWidgetKind; label: string; defW: number; defH: number }[] = [
  { kind: 'gauge',      label: 'Gauge',       defW: 160, defH: 110 },
  { kind: 'bar',        label: 'Bar graph',   defW: 60,  defH: 140 },
  { kind: 'digital',    label: 'Digital',     defW: 140, defH: 56 },
  { kind: 'lamp',       label: 'Lamps',       defW: 120, defH: 90 },
  { kind: 'text',       label: 'Text',        defW: 160, defH: 28 },
  { kind: 'alarmboard', label: 'Alarm board', defW: 320, defH: 160 },
];

export function defaultScreen(name = 'screen1'): HmiScreen {
  return { version: 'hmi.screen.v1', name, w: 800, h: 480, widgets: [] };
}

function numD(v: unknown, d: number): number {
  return typeof v === 'number' && isFinite(v) ? v : d;
}

/** tolerant parse — drops malformed widgets, clamps geometry. */
export function normalizeScreen(j: unknown): HmiScreen | undefined {
  if (!j || typeof j !== 'object') return undefined;
  const o = j as Record<string, unknown>;
  if (o.version !== 'hmi.screen.v1') return undefined;
  const widgets: ScreenWidget[] = [];
  let nextId = 1;
  for (const w of Array.isArray(o.widgets) ? o.widgets : []) {
    const x = w as Record<string, unknown>;
    const kind = SCREEN_KINDS.find((k) => k.kind === x.kind)?.kind;
    if (!kind) continue;
    const num = (v: unknown, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
    const numOpt = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : undefined);
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    widgets.push({
      id: num(x.id) || nextId++,
      kind,
      x: Math.max(0, num(x.x)), y: Math.max(0, num(x.y)),
      w: Math.min(2000, Math.max(16, num(x.w, 100))),
      h: Math.min(2000, Math.max(16, num(x.h, 60))),
      label: str(x.label), signal: str(x.signal), unit: str(x.unit),
      text: str(x.text),
      min: numOpt(x.min), max: numOpt(x.max),
      warn: numOpt(x.warn), crit: numOpt(x.crit),
      decimals: numOpt(x.decimals),
      vertical: x.vertical === true ? true : undefined,
    });
  }
  return {
    version: 'hmi.screen.v1',
    name: typeof o.name === 'string' && o.name ? o.name : 'screen',
    w: Math.min(4000, Math.max(100, numD(o.w, 800))),
    h: Math.min(4000, Math.max(100, numD(o.h, 480))),
    widgets,
  };
}

// ---------------------------------------------------------------------------
// scene rendering
// ---------------------------------------------------------------------------

export type ScreenValues = Record<string, number | boolean | string | undefined>;

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) return Number(v);
  return undefined;
}

function translateOp(op: SceneOp, dx: number, dy: number): SceneOp {
  switch (op.k) {
    case 'rect': return { ...op, x: op.x + dx, y: op.y + dy };
    case 'line': return { ...op, x1: op.x1 + dx, y1: op.y1 + dy, x2: op.x2 + dx, y2: op.y2 + dy };
    case 'path': return { ...op, pts: op.pts.map(([px, py]: ScenePt) => [px + dx, py + dy] as ScenePt) };
    case 'text': return { ...op, x: op.x + dx, y: op.y + dy };
    default: return op;
  }
}

/** one widget → its own scene (design space = widget w/h). */
export function widgetScene(w: ScreenWidget, values: ScreenValues): HmiScene {
  const v = w.signal ? values[w.signal] : undefined;
  const vn = num(v);
  const vb = typeof v === 'boolean' ? v : undefined;
  switch (w.kind) {
    case 'gauge':
      return gaugeScene({
        w: w.w, h: w.h, label: w.label, unit: w.unit,
        min: w.min ?? 0, max: w.max ?? 100, value: vn,
        warn: w.warn, crit: w.crit, decimals: w.decimals,
      });
    case 'bar':
      return bargraphScene({
        w: w.w, h: w.h, label: w.label, unit: w.unit,
        min: w.min ?? 0, max: w.max ?? 100, value: vn,
        warn: w.warn, crit: w.crit, decimals: w.decimals,
        vertical: w.vertical,
      });
    case 'digital':
      return digitalScene({
        w: w.w, h: w.h, label: w.label, unit: w.unit,
        min: w.min, max: w.max, value: vn,
        warn: w.warn, crit: w.crit, decimals: w.decimals, window: true,
      });
    case 'lamp':
      return lampStackScene({
        w: w.w, h: w.h, phase: 0,
        run: vb ?? (vn !== undefined ? vn !== 0 : undefined),
        labels: w.label ? { run: w.label } : undefined,
      });
    case 'alarmboard': {
      /* alarm rows are supplied via a synthetic signal key
         'screen.alarms' — JSON array of {text,level,acked} — else a
         single bound signal renders as one row */
      const rows: AlarmRow[] = [];
      const raw = w.signal ? values[w.signal] : undefined;
      if (typeof raw === 'string' && raw.startsWith('[')) {
        try {
          for (const r of JSON.parse(raw) as { text?: string; level?: string; acked?: boolean }[])
            rows.push({
              text: r.text ?? '',
              level: r.level === 'crit' || r.level === 'warn' ? r.level : 'ok',
              acked: r.acked === true,
            });
        } catch { /* malformed → no rows */ }
      } else if (vn !== undefined || vb !== undefined) {
        const bad = vb === false || (vn !== undefined && (w.crit !== undefined ? vn >= w.crit : w.warn !== undefined && vn >= w.warn));
        rows.push({ text: w.label ?? w.signal ?? 'alarm', level: bad ? 'crit' : 'ok' });
      }
      return alarmBoardScene({ w: w.w, h: w.h, title: w.label, rows, maxRows: 8 });
    }
    case 'text':
      return {
        w: w.w, h: w.h, bg: '#14181d',
        ops: [{
          k: 'text', x: 4, y: w.h / 2 + 4, s: w.text ?? w.label ?? '',
          color: '#d7dee8', size: 12, anchor: 'start',
        } as SceneOp],
      };
  }
}

/** composite every widget into one scene at screen coordinates. */
export function screenScene(screen: HmiScreen, values: ScreenValues): HmiScene {
  const ops: SceneOp[] = [];
  for (const w of screen.widgets) {
    const sc = widgetScene(w, values);
    for (const op of sc.ops) ops.push(translateOp(op, w.x, w.y));
  }
  return { w: screen.w, h: screen.h, bg: '#0d1117', ops };
}

// ---------------------------------------------------------------------------
// persistence (localStorage, namespaced per screen name)
// ---------------------------------------------------------------------------

const KEY_PREFIX = 'tether.hmi.screen.';

export function screenKey(name: string): string {
  return KEY_PREFIX + name;
}

export function saveScreen(store: Pick<Storage, 'setItem'>, s: HmiScreen): void {
  store.setItem(screenKey(s.name), JSON.stringify(s));
}

export function loadScreen(store: Pick<Storage, 'getItem'>, name: string): HmiScreen | undefined {
  const raw = store.getItem(screenKey(name));
  if (!raw) return undefined;
  try { return normalizeScreen(JSON.parse(raw)); } catch { return undefined; }
}

export function listScreens(store: Pick<Storage, 'length' | 'key'>): string[] {
  const out: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k?.startsWith(KEY_PREFIX)) out.push(k.slice(KEY_PREFIX.length));
  }
  return out.sort();
}
