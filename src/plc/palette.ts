/**
 * Palette catalog + live-value pin keys for the FBD canvas.
 *
 * The operator/FB sets mirror exactly what `fbd-lower` accepts
 * (`op_kind` + `builtin_sig`), so every palette entry compiles. Library
 * FBs are discovered from attached ST sources (`FUNCTION_BLOCK <name>`)
 * and from project POUs.
 */
import { Block, Pou } from './model';
import { blockSig } from './sigs';

export interface PaletteItem {
  /** block kind the canvas creates ('function' for FUNCTION POUs). */
  kind: 'operator' | 'fb' | 'function' | 'device';
  /** type_ref for the block. */
  type: string;
  /** short label shown on the button. */
  label: string;
  /** hover help. */
  hint: string;
  /** device templates: preconfigured channel set for the wizard. */
  template?: DeviceTemplate;
  /** catalog blocks: library dir name + source file for auto-attach. */
  lib?: string;
  srcFile?: string;
}

/** Channel template used by the "add device" wizard. */
export interface DeviceTemplate {
  /** suggested terminal/device name (EK1108, EK1122, …). */
  name: string;
  /** channel kind: digital in (device→logic), digital out, analog. */
  channel: 'DI' | 'DO' | 'AI' | 'AO';
  /** default channel count. */
  count: number;
  /** IEC type for the channels. */
  ty: string;
  /** optional second channel group for mixed terminals
      (EK1110 = DI+DO, EK1122 = AI+AO). Lands in the other %I/%Q
      region or a different pin prefix, so it shares base 0. */
  channel2?: 'DI' | 'DO' | 'AI' | 'AO';
  count2?: number;
  ty2?: string;
}

export interface PaletteGroup {
  name: string;
  items: PaletteItem[];
}

const op = (type: string, hint: string, label = type): PaletteItem => ({
  kind: 'operator',
  type,
  label,
  hint,
});
const fb = (type: string, hint: string): PaletteItem => ({ kind: 'fb', type, label: type, hint });

export const PALETTE: PaletteGroup[] = [
  {
    name: 'Bit logic',
    items: [
      op('AND', 'AND — all inputs true'),
      op('OR', 'OR — any input true'),
      op('XOR', 'XOR — odd number of true inputs'),
      op('NOT', 'NOT — invert'),
    ],
  },
  {
    name: 'Arithmetic',
    items: [
      op('ADD', 'ADD — sum of inputs'),
      op('SUB', 'SUB — IN0 − IN1'),
      op('MUL', 'MUL — product of inputs'),
      op('DIV', 'DIV — IN0 ÷ IN1'),
      op('MOD', 'MOD — remainder'),
      op('ABS', 'ABS — absolute value'),
      op('MIN', 'MIN — smallest input'),
      op('MAX', 'MAX — largest input'),
    ],
  },
  {
    name: 'Comparison',
    items: [
      op('GT', 'GT — IN0 > IN1'),
      op('GE', 'GE — IN0 ≥ IN1'),
      op('LT', 'LT — IN0 < IN1'),
      op('LE', 'LE — IN0 ≤ IN1'),
      op('EQ', 'EQ — equal'),
      op('NE', 'NE — not equal'),
    ],
  },
  {
    name: 'Selection',
    items: [
      op('SEL', 'SEL — G ? IN1 : IN0'),
      op('LIMIT', 'LIMIT — clamp IN to MN..MX'),
      op('MUX', 'MUX — select IN by K (0-based)'),
      op('MOVE', 'MOVE — copy (typing / annotation)'),
    ],
  },
  {
    name: 'Shifts',
    items: [
      op('SHL', 'SHL — shift left'),
      op('SHR', 'SHR — shift right'),
      op('ROL', 'ROL — rotate left'),
      op('ROR', 'ROR — rotate right'),
    ],
  },
  {
    name: 'Timers',
    items: [
      fb('TON', 'TON — on-delay (IN, PT → Q, ET)'),
      fb('TOF', 'TOF — off-delay (IN, PT → Q, ET)'),
      fb('TP', 'TP — pulse (IN, PT → Q, ET)'),
    ],
  },
  {
    name: 'Edge / bistable',
    items: [
      fb('R_TRIG', 'R_TRIG — rising edge (CLK → Q)'),
      fb('F_TRIG', 'F_TRIG — falling edge (CLK → Q)'),
      fb('SR', 'SR — set-dominant bistable (S1, R → Q1)'),
      fb('RS', 'RS — reset-dominant bistable (S, R1 → Q1)'),
    ],
  },
  {
    name: 'Counters',
    items: [
      fb('CTU', 'CTU — count up (CU, R, PV → QU, CV)'),
      fb('CTD', 'CTD — count down (CD, LD, PV → QD, CV)'),
      fb('CTUD', 'CTUD — up/down counter'),
    ],
  },
  {
    name: 'Devices',
    items: [
      {
        kind: 'device',
        type: '',
        label: 'EK terminal…',
        hint: 'fieldbus terminal (EK1108 DI / EK1123 DO / EK1122 analog / custom) — channels become pins',
        template: { name: 'EK1108', channel: 'DI', count: 8, ty: 'BOOL' },
      },
      {
        kind: 'device',
        type: 'EK1123',
        label: 'EK1123 DO',
        hint: '8-ch digital output terminal — logic → %Q',
        template: { name: 'EK1123', channel: 'DO', count: 8, ty: 'BOOL' },
      },
      {
        kind: 'device',
        type: 'EK1122',
        label: 'EK1122 AI/AO',
        hint: '2-ch analog terminal — 2× AI + 2× AO, ±10 V / 0..20 mA',
        template: {
          name: 'EK1122',
          channel: 'AI',
          count: 2,
          ty: 'REAL',
          channel2: 'AO',
          count2: 2,
          ty2: 'REAL',
        },
      },
      {
        kind: 'device',
        type: 'EK1110',
        label: 'EK1110 DI/DO',
        hint: 'mixed terminal — 4× DI + 4× DO',
        template: {
          name: 'EK1110',
          channel: 'DI',
          count: 4,
          ty: 'BOOL',
          channel2: 'DO',
          count2: 4,
          ty2: 'BOOL',
        },
      },
    ],
  },
];

/** Scalar cast targets offered in the palette (X_TO_Y). */
export const CAST_TYPES = [
  'BOOL',
  'SINT',
  'INT',
  'DINT',
  'LINT',
  'USINT',
  'UINT',
  'UDINT',
  'ULINT',
  'REAL',
  'LREAL',
  'TIME',
  'STRING',
  'WSTRING',
];

/** Palette group for explicit conversion blocks. */
export function castGroup(): PaletteGroup {
  const items: PaletteItem[] = [];
  for (const from of ['INT', 'DINT', 'UINT', 'UDINT', 'REAL', 'LREAL', 'BOOL', 'TIME']) {
    for (const to of CAST_TYPES) {
      if (from === to) continue;
      items.push(op(`${from}_TO_${to}`, `${from} → ${to}`, `${from}→${to}`));
    }
  }
  return { name: 'Conversions', items };
}

/** Project POUs usable as blocks (FB / FUNCTION, not the edited POU). */
export function projectFbItems(pous: Pou[], self?: Pou): PaletteItem[] {
  return pous
    .filter((p) => p.kind !== 'program' && p.id !== self?.id)
    .map((p) => ({
      kind: (p.kind === 'function' ? 'function' : 'fb') as 'fb' | 'function',
      type: p.name,
      label: p.name,
      hint: `${p.kind === 'function' ? 'FUNCTION' : 'FUNCTION_BLOCK'} ${p.name}${
        p.interface.length ? ` — ${p.interface.map((v) => v.name).join(', ')}` : ''
      }`,
    }));
}

/** `FUNCTION_BLOCK <name>` declarations found in attached ST sources. */
export function libraryFbItems(sources: string[], pous: Pou[]): PaletteItem[] {
  const known = new Set(pous.map((p) => p.name.toUpperCase()));
  const seen = new Set<string>();
  const out: PaletteItem[] = [];
  for (const src of sources) {
    // \b keeps END_FUNCTION_BLOCK / END_FUNCTION from matching
    const re = /\b(FUNCTION_BLOCK|FUNCTION)\s+([A-Za-z_]\w*)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const name = m[2]!;
      const up = name.toUpperCase();
      if (known.has(up) || seen.has(up)) continue;
      seen.add(up);
      out.push({
        kind: m[1]!.toUpperCase() === 'FUNCTION' ? 'function' : 'fb',
        type: name,
        label: name,
        hint: `library ${m[1]!.toUpperCase() === 'FUNCTION' ? 'FUNCTION' : 'FB'} ${name}`,
      });
    }
  }
  return out.sort((a, b) => a.type.localeCompare(b.type));
}

/** Filter a palette group by a free-text query (label or type). */
export function filterGroup(g: PaletteGroup, q: string): PaletteGroup | undefined {
  const needle = q.trim().toUpperCase();
  if (!needle) return g;
  const items = g.items.filter(
    (i) => i.type.toUpperCase().includes(needle) || i.label.toUpperCase().includes(needle),
  );
  return items.length ? { name: g.name, items } : undefined;
}

/* ---------------- live values ---------------- */

/**
 * Catalog keys carrying a block pin's live value.
 *
 * The runtime's SMAP export includes FB instance members, so every
 * `fb`/`function` pin is readable as `plc.<pou>.<instance>.<member>`.
 * Variable blocks read their var / io-channel entry. Operator outputs
 * are scan temporaries and are not exported — they return no keys.
 */
export function pinKeys(
  pou: Pou,
  b: Block,
  pinName: string,
  values: Map<string, unknown>,
): string[] {
  const base = `plc.${pou.name}`;
  switch (b.kind) {
    case 'variable': {
      if (!b.name) return [];
      return [b.at ? `${base}.__io_${b.name}` : '', `${base}.${b.name}`].filter(Boolean);
    }
    case 'fb':
    case 'function': {
      if (!b.instance) return [];
      return [`${base}.${b.instance}.${pinName}`, `${base}.${b.instance}.${pinName.toUpperCase()}`];
    }
    case 'device': {
      /* channel pins alias located vars — the runtime exports them as
       * process-image channels plc.image.<I|Q|M>.ch.<pou>.__dev<id>_<PIN> */
      const pin = (b.pins ?? []).find((p) => p.name === pinName);
      const region = (pin?.at ?? b.at ?? '').toUpperCase().startsWith('%Q')
        ? 'Q'
        : (pin?.at ?? b.at ?? '').toUpperCase().startsWith('%M')
          ? 'M'
          : 'I';
      const vn = `__dev${b.id}_${(pin?.name ?? pinName).replace(/[^A-Za-z0-9_]/g, '_')}`;
      return [
        `${base}.${vn}`,
        `plc.image.${region}.ch.${pou.name}.${vn}`,
        `plc.image.${region}.ch.${vn}`,
      ];
    }
    default:
      return [];
  }
}

/** First live value for a pin, or undefined. */
export function livePin(
  pou: Pou,
  b: Block,
  pinName: string,
  values?: Map<string, unknown>,
): unknown {
  if (!values) return undefined;
  for (const k of pinKeys(pou, b, pinName, values)) if (values.has(k)) return values.get(k);
  return undefined;
}

/** Signature helper re-export so panels don't import sigs directly. */
export { blockSig };
