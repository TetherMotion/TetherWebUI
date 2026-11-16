/**
 * Automatic HMI board generation from the IO catalog — the web port
 * of Tether/examples/common/HmiAuto.cpp. "Automagically tying into
 * the PLC code": given catalog entries (plc.<prog>.<var>[.<member>]
 * published by tplc-io), derive board tiles with no manual binding.
 *
 * Keep the widget-selection rules in lockstep with the C++ version —
 * both backends must generate the same widgets from the same catalog.
 *
 * Screen spec (mirrors WidgetSpec/HmiScreen in HmiAuto.hpp):
 *   { type, w, h, options: Record<string,string>, signals: string[] }
 */
import { makeTile, type TileDef } from '../dash/model';

export interface CatalogEntryLike {
  name: string;
}

export interface HmiWidgetSpec {
  type: 'digital' | 'lamp' | 'profile' | 'alarms' | 'bar' | 'gauge';
  w: number;
  h: number;
  options: Record<string, string>;
  signals: string[];
}

export interface HmiScreenSpec {
  widgets: HmiWidgetSpec[];
}

// ---------------------------------------------------------------------------
// catalog → screen (port of autoScreen() in HmiAuto.cpp)
// ---------------------------------------------------------------------------

const lower = (s: string) => s.toLowerCase();
const baseName = (p: string) => p.slice(p.lastIndexOf('.') + 1);
const isPlc = (n: string) => n.startsWith('plc.');

/** "plc.<prog>.<rest…>" → [prog, rest]; null when not plc.* */
function splitPlc(name: string): [string, string] | null {
  if (!isPlc(name)) return null;
  const p1 = name.indexOf('.', 4);
  if (p1 < 0) return null;
  const prog = name.slice(4, p1);
  const rest = name.slice(p1 + 1);
  return prog && rest ? [prog, rest] : null;
}

/** Instance prefix = everything before the last dot of rest. */
const instOf = (rest: string) =>
  rest.includes('.') ? rest.slice(0, rest.lastIndexOf('.')) : '';

const PROFILE_MEMBERS = new Set([
  'Done', 'Busy', 'Err', 'SegIdx', 'SegTime', 'SegTgt', 'RateNow',
  'RemTime', 'SP', 'EV', 'RUN', 'HOLD', 'RESET', 'NUM_SEG', 'PV',
]);
const LOOP_MEMBERS = new Set(['PV', 'SP', 'OUT', 'U', 'EV', 'Q']);
const BOOL_NAMES = new Set([
  'run', 'enable', 'auto', 'start', 'stop', 'fault', 'alarm', 'done',
  'busy', 'err', 'error', 'ok', 'ready', 'hold', 'reset', 'active',
  'inpos', 'homed', 'estop', 'perm',
]);
const SCALAR_SKIP = ['retain', 'image', 'status', 'version', 'name'];

const digitalWidget = (sig: string, label: string): HmiWidgetSpec => ({
  type: 'digital', w: 160, h: 64,
  options: { label }, signals: [sig],
});

/**
 * Derive the widget list from catalog entries — same rules and order
 * as tether::hmi::autoScreen().
 */
export function autoScreen(entries: CatalogEntryLike[]): HmiScreenSpec {
  const widgets: HmiWidgetSpec[] = [];

  // group plc.* leaves: prog → instance → member → signal
  const byProg = new Map<string, Map<string, Map<string, string>>>();
  const scalars: string[] = [];
  for (const e of entries) {
    const sp = splitPlc(e.name);
    if (!sp) continue;
    const [prog, rest] = sp;
    const inst = instOf(rest);
    const member = inst ? baseName(rest) : rest;
    if (!inst) {
      scalars.push(e.name);
    } else {
      let insts = byProg.get(prog);
      if (!insts) byProg.set(prog, (insts = new Map()));
      let members = insts.get(inst);
      if (!members) insts.set(inst, (members = new Map()));
      members.set(member, e.name);
    }
  }

  // --- instance groups -------------------------------------------------
  for (const [prog, insts] of byProg) {
    for (const [inst, members] of insts) {
      const prefix = `plc.${prog}.${inst}`;
      const memberName = (m: string) => members.get(m) ?? '';

      // profile panel: FB_AtcProfile-shaped instance
      const PROFILE_KEYS = [
        'Done', 'SegIdx', 'SegTgt', 'RateNow', 'RemTime', 'Busy', 'Err',
      ];
      const profHits = PROFILE_KEYS.filter((m) => members.has(m)).length;
      if (profHits >= 3) {
        const signals: string[] = [];
        for (const m of [
          'Done', 'Busy', 'Err', 'SegIdx', 'SegTime', 'SegTgt',
          'RateNow', 'RemTime', 'SP', 'EV', 'RUN', 'HOLD', 'RESET',
          'NUM_SEG', 'PV',
        ]) {
          const n = memberName(m);
          if (n) signals.push(n);
        }
        widgets.push({
          type: 'profile', w: 300, h: 170,
          options: { label: inst }, signals,
        });
        continue;
      }

      // loop cluster: PV+SP present → digital PV + digital SP + OUT bar
      if (members.has('PV') && members.has('SP')) {
        widgets.push(digitalWidget(memberName('PV'), `${inst} PV`));
        widgets.push(digitalWidget(memberName('SP'), `${inst} SP`));
        const out = memberName('OUT') || memberName('U') || memberName('EV');
        if (out) {
          widgets.push({
            type: 'bar', w: 220, h: 56,
            options: { label: `${inst} OUT` }, signals: [out],
          });
        }
        continue;
      }

      // boolean-ish members → lamp stack (up to 3)
      const bools: string[] = [];
      for (const [m, sig] of members) {
        if (BOOL_NAMES.has(lower(m))) bools.push(sig);
        if (bools.length === 3) break;
      }
      if (bools.length && bools.length === members.size) {
        widgets.push({
          type: 'lamp', w: 72, h: 170,
          options: { label: inst }, signals: bools,
        });
        continue;
      }

      // remaining instance members → digital readouts (cap 4)
      let n = 0;
      for (const [m, sig] of members) {
        if (n >= 4) break;
        if (PROFILE_MEMBERS.has(m) || LOOP_MEMBERS.has(m)) continue;
        widgets.push(digitalWidget(sig, `${inst} ${m}`));
        ++n;
      }
    }
  }

  // --- program-level scalars ------------------------------------------
  let n = 0;
  for (const name of scalars) {
    if (n >= 12) break;
    const sp = splitPlc(name);
    if (!sp) continue;
    const leaf = baseName(sp[1]);
    const ll = lower(leaf);
    if (SCALAR_SKIP.some((k) => ll.includes(k))) continue;
    widgets.push(digitalWidget(name, leaf));
    ++n;
  }

  // always append the alarm board — the journal exists on every server
  widgets.push({
    type: 'alarms', w: 240, h: 140,
    options: { title: 'ALARMS' }, signals: [],
  });
  return { widgets };
}

// ---------------------------------------------------------------------------
// spec → board tiles
// ---------------------------------------------------------------------------

/** Web tile type for each spec type (kept in sync with registry). */
const TILE_TYPE: Record<HmiWidgetSpec['type'], string> = {
  digital: 'hmi-digital',
  lamp: 'hmi-lamp',
  profile: 'profile',
  alarms: 'hmi-alarms',
  bar: 'hmi-bar',
  gauge: 'hmi-gauge',
};

/** Grid-unit size per tile type (mirrors registry defaultSize). */
const TILE_SIZE: Record<string, { w: number; h: number }> = {
  'hmi-digital': { w: 3, h: 2 },
  'hmi-lamp': { w: 2, h: 3 },
  'profile': { w: 4, h: 3 },
  'hmi-alarms': { w: 5, h: 3 },
  'hmi-bar': { w: 5, h: 2 },
  'hmi-gauge': { w: 4, h: 4 },
};

const BOARD_COLS = 12;

/**
 * Convert a screen spec into positioned board tiles. Flow layout:
 * left→right, wrap at the board's 12-column grid; each row is as tall
 * as its tallest tile. Deterministic — same spec, same layout.
 */
export function specToTiles(screen: HmiScreenSpec): TileDef[] {
  const tiles: TileDef[] = [];
  let x = 0, y = 0, rowH = 0;
  for (const w of screen.widgets) {
    const type = TILE_TYPE[w.type];
    const sz = TILE_SIZE[type] ?? { w: 4, h: 2 };
    if (x + sz.w > BOARD_COLS) { x = 0; y += rowH; rowH = 0; }
    const bindings = w.signals.map((s) => ({ entry: s }));
    const options: Record<string, string> = { ...w.options };
    if (w.type === 'profile' && w.signals.length) {
      /* profile tile resolves members itself from a prefix — the
         spec's signals are plc.<prog>.<inst>.<member>; prefix is the
         shared instance path */
      const first = w.signals[0];
      const pi = first ? first.lastIndexOf('.') : -1;
      if (first && pi > 0) options.prefix = first.slice(0, pi);
      delete options.label;
      if (w.options.label) options.title = w.options.label;
    }
    if (w.type === 'lamp' && w.signals.length) {
      /* lamp captions: keyword-match member names onto the
         run/alarm/fault slots, then fill remaining slots in order */
      const slots: Record<'run' | 'alarm' | 'fault', string | undefined> = {
        run: undefined, alarm: undefined, fault: undefined,
      };
      const rest: string[] = [];
      for (const s of w.signals) {
        const leaf = baseName(s).toLowerCase();
        const up = leaf.toUpperCase();
        if (/fault|err|estop/.test(leaf)) slots.fault ??= up;
        else if (/alarm|warn/.test(leaf)) slots.alarm ??= up;
        else rest.push(up);
      }
      for (const k of ['run', 'alarm', 'fault'] as const) {
        if (!slots[k]) slots[k] = rest.shift();
      }
      options.labels = JSON.stringify(
        Object.fromEntries(
          (['run', 'alarm', 'fault'] as const)
            .filter((k) => slots[k])
            .map((k) => [k, slots[k]]),
        ),
      );
      delete options.label;
    }
    tiles.push(makeTile(type, { x, y, w: sz.w, h: sz.h },
      { bindings, options }));
    x += sz.w;
    rowH = Math.max(rowH, sz.h);
  }
  return tiles;
}

/** One-call convenience: catalog entries → positioned board tiles. */
export function autoBoardTiles(entries: CatalogEntryLike[]): TileDef[] {
  return specToTiles(autoScreen(entries));
}
