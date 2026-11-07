/**
 * Tile registry — every widget type that can live on a board or in a drawer.
 *
 * A spec declares the tile's element tag, default/min grid size, and an
 * optional declarative config schema (`fields`) used to build the tile's
 * settings popover — so adding a configurable tile never requires writing
 * a bespoke settings form.
 */
import { TileDef } from './model';

export interface ConfigFieldOption {
  value: string;
  label: string;
}

export interface ConfigField {
  /** Key written into TileDef.options (or the special keys handled by the shell). */
  key: string;
  label: string;
  kind:
    | 'text'
    | 'number'
    | 'checkbox'
    | 'select'
    | 'signal' // single signal-name binding → TileDef.bindings[0]
    | 'signals' // multi signal-name bindings → TileDef.bindings
    | 'axis' // axis stable-id select → options.axis
    | 'action'; // MachineAction select → options.action
  options?: ConfigFieldOption[];
  placeholder?: string;
  hint?: string;
}

export interface TileSpec {
  type: string;
  label: string;
  group: 'Signals' | 'Machine' | 'Analysis' | 'Actions' | 'Tools' | 'Layout';
  description: string;
  /** Element tag name registered via customElements. */
  tag: string;
  defaultSize: { w: number; h: number };
  minSize: { w: number; h: number };
  fields?: ConfigField[];
}

const SIGNAL_FIELD: ConfigField = {
  key: 'signal',
  label: 'Signal',
  kind: 'signal',
  hint: 'Catalog signal name; add .field to pick a record member.',
};

const DISPLAY_OPTION_FIELDS: ConfigField[] = [
  {
    key: 'field',
    label: 'Field (record member)',
    kind: 'text',
    placeholder: 'e.g. actual_position',
  },
  { key: 'unit', label: 'Unit override', kind: 'text', placeholder: 'from catalog metadata' },
  { key: 'decimals', label: 'Decimals', kind: 'number', placeholder: 'auto' },
  { key: 'warnAbove', label: 'Warn above', kind: 'number' },
  { key: 'critAbove', label: 'Crit above', kind: 'number' },
];

const RANGE_FIELDS: ConfigField[] = [
  { key: 'min', label: 'Min', kind: 'number', placeholder: '0' },
  { key: 'max', label: 'Max', kind: 'number', placeholder: '1' },
];

const AXIS_FIELD: ConfigField = {
  key: 'axis',
  label: 'Axis',
  kind: 'axis',
};

const ACTION_OPTIONS: ConfigFieldOption[] = [
  { value: '0', label: 'Enable' },
  { value: '1', label: 'Disable' },
  { value: '2', label: 'Quick stop' },
  { value: '3', label: 'Fault reset' },
  { value: '4', label: 'Recover' },
  { value: '5', label: 'Set mode' },
  { value: '9', label: 'Step move' },
  { value: '10', label: 'Move to position' },
  { value: '11', label: 'Group move' },
];

export const TILE_SPECS: TileSpec[] = [
  // ---- Signals -------------------------------------------------------------
  {
    type: 'value',
    label: 'Value',
    group: 'Signals',
    description: 'Single live value with unit and thresholds.',
    tag: 'tile-value',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    fields: [
      SIGNAL_FIELD,
      {
        key: 'viz',
        label: 'Style',
        kind: 'select',
        options: [
          { value: 'value', label: 'Plain' },
          { value: 'dro', label: 'DRO (mono digits)' },
        ],
      },
      ...DISPLAY_OPTION_FIELDS,
    ],
  },
  {
    type: 'gauge',
    label: 'Gauge',
    group: 'Signals',
    description: 'Arc gauge with min/max and warn/crit thresholds.',
    tag: 'tile-gauge',
    defaultSize: { w: 3, h: 3 },
    minSize: { w: 2, h: 2 },
    fields: [SIGNAL_FIELD, ...RANGE_FIELDS, ...DISPLAY_OPTION_FIELDS],
  },
  {
    type: 'bar',
    label: 'Bar',
    group: 'Signals',
    description: 'Horizontal fill bar over a min/max span.',
    tag: 'tile-bar',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    fields: [SIGNAL_FIELD, ...RANGE_FIELDS, ...DISPLAY_OPTION_FIELDS],
  },
  {
    type: 'state',
    label: 'State',
    group: 'Signals',
    description: 'Numeric value mapped through a states table to a label.',
    tag: 'tile-state',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    fields: [
      SIGNAL_FIELD,
      { key: 'states', label: 'States (JSON {"4":"enabled"})', kind: 'text' },
      ...DISPLAY_OPTION_FIELDS,
    ],
  },
  {
    type: 'lamp',
    label: 'Lamp',
    group: 'Signals',
    description: 'Indicator lamp + state label (ok/warn/crit thresholds).',
    tag: 'tile-lamp',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    fields: [
      SIGNAL_FIELD,
      { key: 'states', label: 'States (JSON {"4":"enabled"})', kind: 'text' },
      ...DISPLAY_OPTION_FIELDS,
    ],
  },
  {
    type: 'sparkline',
    label: 'Sparkline',
    group: 'Signals',
    description: 'Rolling history line (~2 min) of one signal.',
    tag: 'tile-sparkline',
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 3, h: 2 },
    fields: [SIGNAL_FIELD, ...RANGE_FIELDS, ...DISPLAY_OPTION_FIELDS],
  },
  {
    type: 'scene',
    label: 'Position scene',
    group: 'Signals',
    description: 'Top-down XY view of actual (filled) vs target (hollow).',
    tag: 'tile-scene',
    defaultSize: { w: 4, h: 5 },
    minSize: { w: 3, h: 4 },
    fields: [
      {
        key: 'x.entry',
        label: 'X signal (entry.field)',
        kind: 'text',
        placeholder: 'e.g. axis.x.position.actual',
      },
      { key: 'x.field', label: 'X field (optional)', kind: 'text' },
      { key: 'y.entry', label: 'Y signal (entry.field)', kind: 'text' },
      { key: 'y.field', label: 'Y field (optional)', kind: 'text' },
      { key: 'z.entry', label: 'Z signal (optional)', kind: 'text' },
      { key: 'z.field', label: 'Z field (optional)', kind: 'text' },
      { key: 'x.min', label: 'X min', kind: 'number' },
      { key: 'x.max', label: 'X max', kind: 'number' },
      { key: 'y.min', label: 'Y min', kind: 'number' },
      { key: 'y.max', label: 'Y max', kind: 'number' },
      { key: 'z.min', label: 'Z min', kind: 'number' },
      { key: 'z.max', label: 'Z max', kind: 'number' },
      {
        key: 'targets',
        label: 'Target fields — e.g. x.target,y.target',
        kind: 'text',
        hint: 'comma list of axis.targetField',
      },
    ],
  },

  // ---- Machine ---------------------------------------------------------------
  {
    type: 'machine-state',
    label: 'Fieldbus health',
    group: 'Machine',
    description: 'EtherCAT master link/WKC/DC + fleet counters.',
    tag: 'tile-machine-state',
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 3, h: 3 },
  },
  {
    type: 'drive-cards',
    label: 'Drive fleet',
    group: 'Machine',
    description: 'Interpreted per-drive cards (expandable for raw fields).',
    tag: 'tile-drive-cards',
    defaultSize: { w: 8, h: 5 },
    minSize: { w: 4, h: 3 },
  },
  {
    type: 'diag-bus',
    label: 'Bus health',
    group: 'Machine',
    description: 'Link, working counter, DC lock, lowest AL state.',
    tag: 'tile-diag-bus',
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 3, h: 2 },
  },
  {
    type: 'diag-chain',
    label: 'Slave chain',
    group: 'Machine',
    description: 'Daisy-chain topology strip with per-slave state.',
    tag: 'tile-diag-chain',
    defaultSize: { w: 8, h: 2 },
    minSize: { w: 4, h: 2 },
  },
  {
    type: 'diag-topology',
    label: 'Topology table',
    group: 'Machine',
    description: 'Per-slave AL/CiA402/quality/fault rows.',
    tag: 'tile-diag-topology',
    defaultSize: { w: 8, h: 4 },
    minSize: { w: 6, h: 3 },
  },
  {
    type: 'diag-cyclic',
    label: 'Cyclic loop',
    group: 'Machine',
    description: 'Cycle counters, deadlines, mailbox/DC health.',
    tag: 'tile-diag-cyclic',
    defaultSize: { w: 6, h: 4 },
    minSize: { w: 4, h: 3 },
  },

  // ---- Analysis ---------------------------------------------------------------
  {
    type: 'scope',
    label: 'Scope',
    group: 'Analysis',
    description: 'Streaming signal traces (WebGPU, canvas fallback).',
    tag: 'tile-scope',
    defaultSize: { w: 8, h: 5 },
    minSize: { w: 4, h: 3 },
    fields: [
      {
        key: 'signals',
        label: 'Channels',
        kind: 'signals',
        hint: 'one catalog signal name per line',
      },
      {
        key: 'preset',
        label: 'Apply preset',
        kind: 'select',
        options: [
          { value: '', label: '—' },
          { value: 'motion', label: 'Position/velocity/torque' },
          { value: 'error', label: 'Following error' },
          { value: 'network', label: 'Network health' },
        ],
      },
      {
        key: 'derive',
        label: 'Derived channel',
        kind: 'select',
        options: [
          { value: '', label: 'none' },
          { value: 'diff', label: 'A−B' },
          { value: 'sum', label: 'Σ all' },
          { value: 'abs', label: '|A|' },
        ],
      },
      { key: 'fft', label: 'Show FFT button', kind: 'checkbox' },
    ],
  },
  {
    type: 'event-timeline',
    label: 'Event timeline',
    group: 'Analysis',
    description: 'Read-only journal of machine events.',
    tag: 'tile-event-timeline',
    defaultSize: { w: 5, h: 5 },
    minSize: { w: 3, h: 3 },
  },
  {
    type: 'alarm-list',
    label: 'Alarms',
    group: 'Analysis',
    description: 'Active/acknowledged alarms with lifecycle actions.',
    tag: 'tile-alarm-list',
    defaultSize: { w: 7, h: 4 },
    minSize: { w: 5, h: 3 },
  },
  {
    type: 'operations',
    label: 'Operations',
    group: 'Analysis',
    description: 'In-flight and recent command operations.',
    tag: 'tile-operations',
    defaultSize: { w: 7, h: 3 },
    minSize: { w: 5, h: 3 },
  },
  {
    type: 'supervisor',
    label: 'Supervisor',
    group: 'Analysis',
    description: 'Slave-supervisor recovery state with retry.',
    tag: 'tile-supervisor',
    defaultSize: { w: 6, h: 3 },
    minSize: { w: 4, h: 3 },
  },
  {
    type: 'pdo-map',
    label: 'PDO map',
    group: 'Analysis',
    description: 'Logical-address layout of cyclic process data.',
    tag: 'tile-pdo-map',
    defaultSize: { w: 6, h: 4 },
    minSize: { w: 4, h: 3 },
  },

  // ---- Actions -------------------------------------------------------------------
  {
    type: 'authority',
    label: 'Control authority',
    group: 'Actions',
    description: 'Acquire/renew/release the motion lease.',
    tag: 'tile-authority',
    defaultSize: { w: 5, h: 3 },
    minSize: { w: 4, h: 3 },
  },
  {
    type: 'jog',
    label: 'Jog pad',
    group: 'Actions',
    description: 'Hold-to-run jog for every discovered axis.',
    tag: 'tile-jog',
    defaultSize: { w: 5, h: 4 },
    minSize: { w: 3, h: 3 },
    fields: [
      { key: 'velocity', label: 'Velocity (drive units/s)', kind: 'number', placeholder: '1000' },
      AXIS_FIELD,
    ],
  },
  {
    type: 'jog-pair',
    label: 'Jog (single axis)',
    group: 'Actions',
    description: 'One axis −/+ hold-to-run pair.',
    tag: 'tile-jog-pair',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    fields: [
      AXIS_FIELD,
      { key: 'velocity', label: 'Velocity', kind: 'number', placeholder: '1000' },
    ],
  },
  {
    type: 'command',
    label: 'Command dispatch',
    group: 'Actions',
    description: 'Validated multi-target command panel.',
    tag: 'tile-command',
    defaultSize: { w: 6, h: 5 },
    minSize: { w: 4, h: 4 },
  },
  {
    type: 'command-button',
    label: 'Command button',
    group: 'Actions',
    description: 'Single action on one axis (audited path).',
    tag: 'tile-command-button',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    fields: [
      { key: 'action', label: 'Action', kind: 'action', options: ACTION_OPTIONS },
      AXIS_FIELD,
      { key: 'btnLabel', label: 'Button label', kind: 'text', placeholder: 'action name' },
    ],
  },
  {
    type: 'fn-button',
    label: 'Function button',
    group: 'Actions',
    description: 'Invoke a zero-argument machine function.',
    tag: 'tile-fn-button',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    fields: [{ key: 'fn', label: 'Function name', kind: 'text', placeholder: 'machine.*' }],
  },
  {
    type: 'homing',
    label: 'Homing',
    group: 'Actions',
    description: 'Guided prepare → start → verify per axis.',
    tag: 'tile-homing',
    defaultSize: { w: 8, h: 4 },
    minSize: { w: 6, h: 3 },
  },
  {
    type: 'recipes',
    label: 'Recipes',
    group: 'Actions',
    description: 'Named parameter sets — staged, audited.',
    tag: 'tile-recipes',
    defaultSize: { w: 6, h: 4 },
    minSize: { w: 4, h: 3 },
  },

  // ---- Tools (also openable as overlays) ----------------------------------------
  {
    type: 'sdo-inspector',
    label: 'SDO inspector',
    group: 'Tools',
    description: 'Object-dictionary list, read, and staged write.',
    tag: 'tile-sdo-inspector',
    defaultSize: { w: 7, h: 7 },
    minSize: { w: 5, h: 5 },
  },
  {
    type: 'config-txn',
    label: 'Config transaction',
    group: 'Tools',
    description: 'Stage → validate → commit parameter writes.',
    tag: 'tile-config-txn',
    defaultSize: { w: 6, h: 5 },
    minSize: { w: 4, h: 4 },
  },
  {
    type: 'capture',
    label: 'Capture',
    group: 'Tools',
    description: 'Server-side recording: config, status, export.',
    tag: 'tile-capture',
    defaultSize: { w: 6, h: 5 },
    minSize: { w: 4, h: 4 },
  },
  {
    type: 'baseline',
    label: 'Config baseline',
    group: 'Tools',
    description: 'Export/diff/import a parameter baseline.',
    tag: 'tile-baseline',
    defaultSize: { w: 6, h: 5 },
    minSize: { w: 4, h: 4 },
  },
  {
    type: 'checklist',
    label: 'Checklist',
    group: 'Tools',
    description: 'Commissioning acceptance items + report.',
    tag: 'tile-checklist',
    defaultSize: { w: 6, h: 5 },
    minSize: { w: 4, h: 4 },
  },
  {
    type: 'catalog',
    label: 'Catalog explorer',
    group: 'Tools',
    description: 'Browse signals, params, and functions.',
    tag: 'tile-catalog',
    defaultSize: { w: 6, h: 7 },
    minSize: { w: 4, h: 5 },
  },

  // ---- PLC ----------------------------------------------------------------------
  {
    type: 'plc-ide',
    label: 'PLC IDE',
    group: 'Tools',
    description: 'TetherPLC project explorer, ST/FBD sources, watch, deploy.',
    tag: 'tile-plc-ide',
    defaultSize: { w: 12, h: 14 },
    minSize: { w: 8, h: 8 },
  },

  // ---- Layout ---------------------------------------------------------------------
  {
    type: 'note',
    label: 'Text note',
    group: 'Layout',
    description: 'Static text/markdown-ish block.',
    tag: 'tile-note',
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 2, h: 1 },
    fields: [
      { key: 'text', label: 'Text', kind: 'text', placeholder: 'Note…' },
      { key: 'hideTitle', label: 'Hide title bar', kind: 'checkbox' },
    ],
  },
];

export const TILE_SPEC_BY_TYPE = new Map(TILE_SPECS.map((spec) => [spec.type, spec]));

export function specFor(def: TileDef): TileSpec | undefined {
  return TILE_SPEC_BY_TYPE.get(def.type);
}
