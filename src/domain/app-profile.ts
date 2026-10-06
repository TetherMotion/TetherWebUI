/**
 * Application profile document (Phase 7 extension layer). The server serves
 * the document verbatim on the `machine.app.profile` signal; integrity is
 * verified server-side via a keyed BLAKE3 MAC at attach time. The client only
 * interprets a narrow declarative contract — panels of widgets bound to
 * catalog signal names (display) or to the authority-gated command surface
 * (jog/command/button). Display widgets can never write; control widgets
 * only reach paths that re-check role and interlocks server-side.
 */
import { CatalogEntry } from '../protocol';
import { TetherIOClient } from '../client';

export const APP_PROFILE_ROOT = 'tether.machine.cia402.AppProfileV1';
export const APP_PROFILE_FORMAT = 'tether.app.profile.v1';

export type AppProfileWidgetKind =
  // display
  | 'value'
  | 'bar'
  | 'gauge'
  | 'state'
  | 'lamp'
  | 'dro'
  | 'sparkline'
  | 'scene'
  // interactive — routed through the normal command/function surface
  | 'jog'
  | 'command'
  | 'button';

/** One axis binding inside a `scene` widget (plan item 89). */
export interface AppProfileAxisBinding {
  /** Axis label shown in the scene (defaults to x/y/z by position). */
  name?: string;
  /** Catalog signal name holding the axis position record. */
  entry: string;
  /** Struct field with the actual position. */
  field: string;
  /** Optional struct field with the target position (drawn hollow). */
  targetField?: string;
  min?: number;
  max?: number;
}

export interface AppProfileWidget {
  kind: AppProfileWidgetKind;
  label: string;
  /** Catalog signal name the widget reads (display widgets). */
  entry?: string;
  /** Struct field to display when the entry decodes to a record. */
  field?: string;
  unit?: string;
  min?: number;
  max?: number;
  /** Decimal places for dro/value rendering. */
  decimals?: number;
  /** Numeric threshold that renders the widget in a warning state. */
  warnAbove?: number;
  /** Numeric threshold that renders the widget in a critical state. */
  critAbove?: number;
  /** state/lamp mapping of numeric value → label, e.g. {"4": "enabled"}. */
  states?: Record<string, string>;
  /** jog/command: command-target stable id (axis). */
  axis?: string;
  /** command: numeric MachineAction to dispatch on the target. */
  action?: number;
  /** button: zero-argument machine function name to invoke. */
  fn?: string;
  /** scene: 1–3 axis bindings (x, y, optional z) for a top-down position view. */
  axes?: AppProfileAxisBinding[];
}

export interface AppProfilePanel {
  id: string;
  title: string;
  widgets: AppProfileWidget[];
}

export interface AppProfile {
  name: string;
  version: string;
  signatureHex: string;
  panels: AppProfilePanel[];
}

const WIDGET_KINDS = new Set<AppProfileWidgetKind>([
  'value',
  'bar',
  'gauge',
  'state',
  'lamp',
  'dro',
  'sparkline',
  'scene',
  'jog',
  'command',
  'button',
]);

/** Kinds that read a signal — all others are pure controls. */
export const READING_WIDGET_KINDS = new Set<AppProfileWidgetKind>([
  'value',
  'bar',
  'gauge',
  'state',
  'lamp',
  'dro',
  'sparkline',
  'scene',
  'jog',
  'command',
]);

function asWidget(value: unknown): AppProfileWidget | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.label !== 'string' ||
    raw.label.length === 0 ||
    !WIDGET_KINDS.has(raw.kind as AppProfileWidgetKind)
  )
    return undefined;
  const kind = raw.kind as AppProfileWidgetKind;
  const reads = READING_WIDGET_KINDS.has(kind);
  const entry = typeof raw.entry === 'string' && raw.entry.length ? raw.entry : undefined;
  if (reads && kind !== 'jog' && kind !== 'command' && kind !== 'scene' && !entry) return undefined;
  const axis = typeof raw.axis === 'string' && raw.axis.length ? raw.axis : undefined;
  if (kind === 'jog' && !axis) return undefined;
  const axes = asAxisBindings(raw.axes);
  if (kind === 'scene' && (!axes || axes.length === 0)) return undefined;
  const action =
    typeof raw.action === 'number' && Number.isInteger(raw.action) && raw.action >= 0
      ? raw.action
      : undefined;
  if (kind === 'command' && (action === undefined || !axis)) return undefined;
  const fn = typeof raw.fn === 'string' && raw.fn.length ? raw.fn : undefined;
  if (kind === 'button' && !fn) return undefined;
  const number = (key: string) =>
    typeof raw[key] === 'number' && Number.isFinite(raw[key]) ? (raw[key] as number) : undefined;
  const states: Record<string, string> = {};
  if (raw.states && typeof raw.states === 'object' && !Array.isArray(raw.states)) {
    for (const [key, label] of Object.entries(raw.states as Record<string, unknown>))
      if (typeof label === 'string') states[key] = label;
  }
  return {
    kind,
    label: raw.label,
    entry,
    field: typeof raw.field === 'string' && raw.field.length ? raw.field : undefined,
    unit: typeof raw.unit === 'string' ? raw.unit : undefined,
    min: number('min'),
    max: number('max'),
    decimals: number('decimals'),
    warnAbove: number('warnAbove'),
    critAbove: number('critAbove'),
    states: Object.keys(states).length ? states : undefined,
    axis,
    action,
    fn,
    axes,
  };
}

const AXIS_NAMES = ['x', 'y', 'z'];

function asAxisBindings(value: unknown): AppProfileAxisBinding[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3) return undefined;
  const bindings: AppProfileAxisBinding[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const a = raw as Record<string, unknown>;
    if (
      typeof a.entry !== 'string' ||
      !a.entry.length ||
      typeof a.field !== 'string' ||
      !a.field.length
    )
      return undefined;
    const num = (key: string) =>
      typeof a[key] === 'number' && Number.isFinite(a[key] as number)
        ? (a[key] as number)
        : undefined;
    bindings.push({
      name: typeof a.name === 'string' && a.name.length ? a.name : undefined,
      entry: a.entry,
      field: a.field,
      targetField:
        typeof a.targetField === 'string' && a.targetField.length ? a.targetField : undefined,
      min: num('min'),
      max: num('max'),
    });
  }
  return bindings;
}

/** Every signal binding a widget reads, as {entry, field, key} tuples. */
export function* widgetSignalBindings(
  widget: AppProfileWidget,
): Generator<{ entry: string; field?: string; key: string }> {
  if (widget.kind === 'scene' && widget.axes) {
    for (const axis of widget.axes) {
      yield { entry: axis.entry, field: axis.field, key: `${axis.entry}.${axis.field}` };
      if (axis.targetField)
        yield {
          entry: axis.entry,
          field: axis.targetField,
          key: `${axis.entry}.${axis.targetField}`,
        };
    }
    return;
  }
  if (widget.entry) {
    const field = widget.field;
    yield {
      entry: widget.entry,
      field,
      key: field ? `${widget.entry}.${field}` : widget.entry,
    };
  }
}

/** Default axis label for a scene binding index (x, y, z). */
export function axisNameAt(index: number): string {
  return AXIS_NAMES[index] ?? `a${index}`;
}

/** Parse a profile document; returns undefined on malformed input. */
export function parseAppProfileDocument(text: string): AppProfile | undefined {
  try {
    const doc = JSON.parse(text) as Record<string, unknown>;
    if (doc.format !== APP_PROFILE_FORMAT) return undefined;
    const panels: AppProfilePanel[] = [];
    const rawPanels = doc.panels;
    if (Array.isArray(rawPanels)) {
      for (const rawPanel of rawPanels) {
        if (!rawPanel || typeof rawPanel !== 'object' || Array.isArray(rawPanel)) continue;
        const panel = rawPanel as Record<string, unknown>;
        if (typeof panel.id !== 'string' || typeof panel.title !== 'string') continue;
        const widgets = Array.isArray(panel.widgets)
          ? panel.widgets.map(asWidget).filter((w): w is AppProfileWidget => !!w)
          : [];
        panels.push({ id: panel.id, title: panel.title, widgets });
      }
    }
    return { name: '', version: '', signatureHex: '', panels };
  } catch {
    return undefined;
  }
}

/** Find the profile signal in the catalog, if the server advertises it. */
export function findAppProfileEntry(signals: CatalogEntry[]): CatalogEntry | undefined {
  return signals.find((entry) => entry.name === 'machine.app.profile');
}

/**
 * Read and parse the application profile signal. Returns undefined when the
 * document is malformed; the record itself carries name/version/signature.
 */
export async function readAppProfile(
  client: TetherIOClient,
  entry: CatalogEntry,
): Promise<AppProfile | undefined> {
  const decoded = await client.getTyped(entry);
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return undefined;
  const record = decoded as Record<string, unknown>;
  const document = record.document;
  if (!(document instanceof Uint8Array)) return undefined;
  const parsed = parseAppProfileDocument(new TextDecoder().decode(document));
  if (!parsed) return undefined;
  parsed.name = typeof record.name === 'string' ? record.name : '';
  parsed.version = typeof record.version === 'string' ? record.version : '';
  const signature = record.signature;
  if (signature instanceof Uint8Array)
    parsed.signatureHex = [...signature.slice(0, 8)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  return parsed;
}
