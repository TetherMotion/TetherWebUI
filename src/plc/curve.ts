/**
 * Temperature profile model + codegen for the Atc_TempCtrl library.
 *
 * A profile is a list of ST_AtcSeg segments for FB_AtcProfile. Since
 * aggregate FB inputs can't be call-bound, the curve is delivered as an
 * inline `st` block whose body writes PROF.SEG[i].* member-wise through
 * a var_in_out pin — or, with `emitPou`, as a standalone FUNCTION_BLOCK
 * ST source that both FBD and ST can call (bidirectional interop).
 */
import { Block, IfaceVar, Network, PortSel, Pou, nextNodeId } from './model';

export type SegKind = 'end' | 'dwell' | 'ramp' | 'rampt' | 'step' | 'loop';

export interface CurveSeg {
  kind: SegKind;
  /** target °C; for loop: segment index to jump back to. */
  tgt: number;
  /** dwell s / ramp °C-per-s / rampt s / loop count. */
  p1: number;
  /** guaranteed-soak band °C (dwell only; 0 = off). */
  p2: number;
  /** event word emitted on EV while the segment is active. */
  ev: number;
}

/** Heater PWM stage: controller duty -> FB_AtcPwm -> BOOL pulse train. */
export interface CurvePwm {
  /** FB_AtcPwm instance name. */
  instance: string;
  /** PWM period s — 1.0 = 1 Hz base frequency (EL2004 PWM). */
  period: number;
  /** minimum on-time s (shorter pulses are suppressed). */
  minOn: number;
  /** BOOL interface var driven by pwm.Q — wire to a DO channel. */
  outVar: string;
}

export interface CurveProfile {
  /** instance name for the FB_AtcProfile var in the target POU. */
  instance: string;
  /** start ramps from measured PV (FB_AtcProfile.PvStart). */
  pvStart: boolean;
  /** task cycle time written to FB_AtcProfile.CycleTime (s). */
  cycleTime: number;
  /** controller FB to drop next to the profile (empty = none). */
  controller: string;
  /** instance name for the controller var. */
  ctlInstance: string;
  /** interface var wired to RUN (and the controller's enable); '' = skip. */
  runVar?: string;
  /** interface var wired to PV (and the controller's process value). */
  pvVar?: string;
  /** interface var wired to HOLD; '' = skip. */
  holdVar?: string;
  /** interface var wired to RESET; '' = skip. */
  resetVar?: string;
  /** interface var wired from the controller output; '' = skip. */
  outVar?: string;
  /** interface BOOL driven by prof.Busy (process running); '' = skip. */
  busyVar?: string;
  /** interface BOOL driven by prof.Done (profile finished); '' = skip. */
  doneVar?: string;
  /** heater PWM stage on the controller output; undefined = off. */
  pwm?: CurvePwm;
  segs: CurveSeg[];
}

export const SEG_KINDS: { id: SegKind; code: number; label: string }[] = [
  { id: 'dwell', code: 1, label: 'dwell (soak)' },
  { id: 'ramp', code: 2, label: 'ramp °/s' },
  { id: 'rampt', code: 3, label: 'ramp time' },
  { id: 'step', code: 4, label: 'step' },
  { id: 'loop', code: 5, label: 'loop' },
  { id: 'end', code: 0, label: 'end' },
];

/** Closed-loop controllers from Atc_TempCtrl that consume SP/PV. */
export interface ControllerDef {
  name: string;
  /** setpoint input pin. */
  sp: string;
  /** process-value input pin. */
  pv: string;
  /** control output pin. */
  out: string;
  /** run-enable input pin. */
  exec: string;
  /** seed parameters so the block runs before tuning. */
  params?: Record<string, string>;
  note?: string;
}

export const CONTROLLERS: ControllerDef[] = [
  {
    name: 'FB_AtcPid',
    sp: 'Setpoint',
    pv: 'Actual',
    out: 'Out',
    exec: 'Execute',
    params: { Kp: '2.0', Tn: '60.0', Tv: '0.0', OutMin: '0.0', OutMax: '100.0' },
  },
  {
    name: 'FB_AtcCascadePid',
    sp: 'Setpoint',
    pv: 'PvOuter',
    out: 'Out',
    exec: 'Execute',
    params: { OutMin: '0.0', OutMax: '100.0' },
  },
  {
    name: 'FB_AtcSmith',
    sp: 'Setpoint',
    pv: 'Actual',
    out: 'Out',
    exec: 'Execute',
    params: { Kp: '2.0', Tn: '60.0', Tv: '0.0', OutMin: '0.0', OutMax: '100.0' },
  },
  {
    name: 'FB_AtcLqr',
    sp: 'Setpoint',
    pv: 'Actual',
    out: 'Out',
    exec: 'Execute',
    params: { OutMin: '0.0', OutMax: '100.0' },
  },
  {
    name: 'FB_AtcLqg',
    sp: 'Setpoint',
    pv: 'Actual',
    out: 'Out',
    exec: 'Execute',
    params: { OutMin: '0.0', OutMax: '100.0' },
  },
  {
    name: 'FB_AtcRelayTune',
    sp: 'Setpoint',
    pv: 'Actual',
    out: 'Out',
    exec: 'Execute',
    params: { RelayAmp: '10.0', MeanOut: '30.0', OutMin: '0.0', OutMax: '100.0' },
    note: 'tuner — Ku/Tu/Kp feed the controller params',
  },
];

export function controllerDef(name: string): ControllerDef | undefined {
  return CONTROLLERS.find((c) => c.name === name);
}

export function segCode(kind: SegKind): number {
  return SEG_KINDS.find((k) => k.id === kind)?.code ?? 0;
}

export function defaultProfile(): CurveProfile {
  return {
    instance: 'prof',
    pvStart: true,
    cycleTime: 0.1,
    controller: 'FB_AtcPid',
    ctlInstance: 'ctl',
    runVar: '',
    pvVar: '',
    holdVar: '',
    resetVar: '',
    outVar: '',
    segs: [
      { kind: 'rampt', tgt: 150, p1: 60, p2: 0, ev: 0 },
      { kind: 'dwell', tgt: 150, p1: 120, p2: 2, ev: 1 },
      { kind: 'ramp', tgt: 80, p1: 0.5, p2: 0, ev: 0 },
      { kind: 'dwell', tgt: 80, p1: 30, p2: 0, ev: 2 },
      { kind: 'end', tgt: 0, p1: 0, p2: 0, ev: 0 },
    ],
  };
}

/**
 * ST body for the inline `st` block / config FB. One-shot loader: on
 * the CFG rising edge (or unconditionally when CFG is constant) the
 * SEG table + options are written into PROF member-wise.
 */
export function profileCode(p: CurveProfile): string {
  const n = p.segs.filter((s) => s.kind !== 'end').length;
  const l: string[] = [];
  l.push('IF CFG AND NOT loaded THEN');
  l.push(`    PROF.NUM_SEG := ${n};`);
  l.push(`    PROF.PvStart := ${p.pvStart ? 'TRUE' : 'FALSE'};`);
  l.push(`    PROF.CycleTime := ${num(p.cycleTime)};`);
  p.segs.forEach((s, i) => {
    const pre = `    PROF.SEG[${i + 1}]`;
    l.push(`${pre}.KIND := ${segCode(s.kind)};`);
    l.push(`${pre}.TGT := ${num(s.tgt)};`);
    l.push(`${pre}.P1 := ${num(s.p1)};`);
    l.push(`${pre}.P2 := ${num(s.p2)};`);
    if (s.ev) l.push(`${pre}.EV := ${s.ev};`);
  });
  l.push('    loaded := TRUE;');
  l.push('END_IF;');
  l.push('DONE := loaded;');
  return l.join('\n') + '\n';
}

/** Pins the generated st block / config FB exposes. */
export function cfgPins(): IfaceVar[] {
  return [
    { name: 'CFG', kind: 'var_input', type: 'BOOL' },
    { name: 'PROF', kind: 'var_in_out', type: 'FB_AtcProfile' },
    { name: 'DONE', kind: 'var_output', type: 'BOOL' },
    { name: 'loaded', kind: 'var', type: 'BOOL' },
  ];
}

/** Standalone FUNCTION_BLOCK ST source — callable from FBD and ST. */
export function emitPou(name: string, p: CurveProfile): string {
  const secs: Record<string, IfaceVar[]> = {};
  for (const v of cfgPins()) (secs[v.kind] ??= []).push(v);
  const sect = (kw: string, vs: IfaceVar[]) =>
    vs.length ? `${kw}\n${vs.map((v) => `    ${v.name} : ${v.type};`).join('\n')}\nEND_VAR\n` : '';
  return (
    `FUNCTION_BLOCK ${name}\n` +
    sect('VAR_INPUT', secs.var_input ?? []) +
    sect('VAR_OUTPUT', secs.var_output ?? []) +
    sect('VAR_IN_OUT', secs.var_in_out ?? []) +
    sect('VAR', secs.var ?? []) +
    profileCode(p) +
    'END_FUNCTION_BLOCK\n'
  );
}

/**
 * Insert the profile into a POU's first FBD network:
 *  - an `fb` FB_AtcProfile block with instance `p.instance` (the
 *    instance is auto-declared by the fbd lowerer — it must precede
 *    the variable block in the array so precollect sees it first),
 *  - a `prof` variable block wired to the cfg st block's PROF
 *    var_in_out pin (the inout aliases the instance's storage),
 *  - the `st` cfg block loading the SEG table one-shot (CFG is
 *    param-bound TRUE),
 *  - an optional `fb` controller block with instance `ctlInstance`.
 * Blocks land unwired apart from PROF — the user wires RUN/PV/SP/OUT.
 */
export function applyToPou(pou: Pou, p: CurveProfile): void {
  let net = pou.networks.find((n) => n.kind === 'fbd');
  if (!net) {
    net = {
      id: `net${pou.networks.length + 1}`,
      kind: 'fbd',
      label: 'profile',
      comments: [],
      assocs: [],
      labels: [],
      jumps: [],
      returns: [],
      blocks: [],
      wires: [],
    };
    pou.networks.push(net);
  }
  applyProfileToNet(pou, pou.networks.indexOf(net), p);
}

/**
 * Insert or refresh a profile inside ONE network — used by the block
 * editor dialog so a POU can host several independent curves. Matches
 * existing profile blocks in that net (preferring `p.instance`) and
 * updates them in place; appends the block set when none exist.
 */
export function applyProfileToNet(pou: Pou, netIndex: number, p: CurveProfile): void {
  const net = pou.networks[netIndex];
  if (!net) return;
  const y = 2 + Math.floor(net.blocks.length / 6) * 6;
  const cfgId = nextNodeId(pou);
  const profFbId = cfgId + 1;
  const profVarId = profFbId + 1;
  const ctlId = profFbId + 2;

  // Re-insert on a POU that already has a profile: update the existing
  // blocks in place (new SEG table, new cycle time) and keep the user's
  // wiring. Appending again would duplicate the instance (INST_REUSE).
  // prefer the group this profile belongs to (instance match, then the
  // cfg wired to that instance's PROF pin) before falling back to the
  // first profile blocks in the net
  const oldFb =
    net.blocks.find(
      (b) => b.kind === 'fb' && b.type_ref === 'FB_AtcProfile' && b.instance === p.instance,
    ) ?? net.blocks.find((b) => b.kind === 'fb' && b.type_ref === 'FB_AtcProfile');
  const oldCfg =
    net.blocks.find(
      (b) => isProfileCfg(b) && oldFb && inVarName(net, b.id, 'PROF') === oldFb.instance,
    ) ?? net.blocks.find(isProfileCfg);
  if (oldFb && oldCfg) {
    oldFb.instance = p.instance;
    oldFb.params = { ...oldFb.params, CycleTime: num(p.cycleTime) };
    oldCfg.params = { ...oldCfg.params, CFG: 'TRUE', CODE: profileCode(p) };
    oldCfg.comment = `temperature profile ${p.instance}`;
    const oldCtl = p.ctlInstance
      ? net.blocks.find((b) => b.kind === 'fb' && b.instance === p.ctlInstance)
      : undefined;
    if (oldCtl && p.controller) {
      oldCtl.type_ref = p.controller;
      oldCtl.params = { ...oldCtl.params, CycleTime: num(p.cycleTime) };
    }
    if (p.controller) wireController(pou, net, p);
    return;
  }

  // Execution follows array order: the config block must run before
  // the profile FB call, and the FB declaration must precede the
  // variable block that resolves its instance.
  net.blocks.push(
    {
      id: cfgId,
      kind: 'st',
      type_ref: 'ST',
      pos: { x: 2, y: y + 4 },
      params: { CFG: 'TRUE', CODE: profileCode(p) },
      exec_order: 0,
      negated: [],
      comment: `temperature profile ${p.instance}`,
      pins: cfgPins(),
    },
    {
      id: profFbId,
      kind: 'fb',
      type_ref: 'FB_AtcProfile',
      instance: p.instance,
      pos: { x: 14, y },
      params: { CycleTime: num(p.cycleTime) },
      exec_order: 0,
      negated: [],
      comment: 'wire RUN, PV; SP → controller',
    },
    {
      id: profVarId,
      kind: 'variable',
      type_ref: '',
      pos: { x: 2, y },
      params: {},
      exec_order: 0,
      negated: [],
      comment: '',
      role: 'in',
      name: p.instance,
    },
  );
  if (p.controller) {
    const cd = controllerDef(p.controller);
    net.blocks.push({
      id: ctlId,
      kind: 'fb',
      type_ref: p.controller,
      instance: p.ctlInstance,
      pos: { x: 28, y },
      params: { ...(cd?.params ?? {}), CycleTime: num(p.cycleTime) },
      exec_order: 0,
      negated: [],
      comment: cd
        ? `wire ${cd.exec}, ${cd.pv}; ${cd.sp} ← ${p.instance}.SP; ${cd.out} → output`
        : `wire ${p.ctlInstance} pins`,
    });
  }
  net.wires.push({
    id: nextNodeId(pou),
    src: { block: profVarId, port: 0 },
    dsts: [{ block: cfgId, port: 'PROF' }],
  });
  if (p.controller) wireController(pou, net, p);
}

/**
 * Wire the profile + controller to interface vars when names are given:
 * `runVar` → prof.RUN and the controller's enable, `pvVar` → prof.PV
 * and the controller's process value, prof.SP → controller setpoint,
 * controller output → `outVar`. Missing interface vars are created
 * (BOOL for run, LREAL otherwise) so the network compiles immediately.
 */
function wireController(pou: Pou, net: Network, p: CurveProfile): void {
  const cd = controllerDef(p.controller);
  if (!cd) return;
  const ctl = net.blocks.find((b) => b.instance === p.ctlInstance && b.type_ref === p.controller);
  const prof = net.blocks.find((b) => b.instance === p.instance && b.type_ref === 'FB_AtcProfile');
  if (!ctl || !prof) return;
  const varBlock = (name: string, role: 'in' | 'out'): Block => {
    const found = net.blocks.find(
      (b) => b.kind === 'variable' && b.name === name && b.role === role,
    );
    if (found) return found;
    const blk: Block = {
      id: nextNodeId(pou),
      kind: 'variable',
      type_ref: '',
      pos: { x: role === 'in' ? 0 : 40, y: 14 },
      params: {},
      exec_order: 0,
      negated: [],
      comment: '',
      role,
      name,
    };
    net.blocks.push(blk);
    return blk;
  };
  const ensureIface = (name: string, kind: IfaceVar['kind'], type: string) => {
    if (pou.interface.some((v) => v.name.toUpperCase() === name.toUpperCase())) return;
    pou.interface.push({ name, kind, type });
  };
  // idempotent: an input already driven keeps its source
  const driven = new Set<string>();
  for (const w of net.wires) for (const d of w.dsts) driven.add(`${d.block}:${d.port}`);
  const wire = (
    src: { block: number; port: PortSel },
    dsts: { block: number; port: PortSel }[],
  ) => {
    const fresh = dsts.filter((d) => !driven.has(`${d.block}:${d.port}`));
    if (!fresh.length) return;
    for (const d of fresh) driven.add(`${d.block}:${d.port}`);
    net.wires.push({ id: nextNodeId(pou), src, dsts: fresh });
  };

  if (p.runVar) {
    ensureIface(p.runVar, 'var_input', 'BOOL');
    const b = varBlock(p.runVar, 'in');
    wire({ block: b.id, port: 0 }, [
      { block: prof.id, port: 'RUN' },
      { block: ctl.id, port: cd.exec },
    ]);
  }
  if (p.pvVar) {
    ensureIface(p.pvVar, 'var_input', 'LREAL');
    const b = varBlock(p.pvVar, 'in');
    wire({ block: b.id, port: 0 }, [
      { block: prof.id, port: 'PV' },
      { block: ctl.id, port: cd.pv },
    ]);
  }
  for (const [name, port] of [
    [p.holdVar, 'HOLD'],
    [p.resetVar, 'RESET'],
  ] as const) {
    if (!name) continue;
    ensureIface(name, 'var_input', 'BOOL');
    const b = varBlock(name, 'in');
    wire({ block: b.id, port: 0 }, [{ block: prof.id, port }]);
  }
  wire({ block: prof.id, port: 'SP' }, [{ block: ctl.id, port: cd.sp }]);
  // status taps: Busy = process running, Done = profile finished —
  // the typical DO pair a downstream system watches
  for (const [name, port] of [
    [p.busyVar, 'Busy'],
    [p.doneVar, 'Done'],
  ] as const) {
    if (!name) continue;
    ensureIface(name, 'var_output', 'BOOL');
    const b = varBlock(name, 'out');
    wire({ block: prof.id, port }, [{ block: b.id, port: 0 }]);
  }
  if (p.pwm) wirePwm(pou, net, p, ctl, cd, wire, ensureIface, varBlock);
  else if (p.outVar) {
    ensureIface(p.outVar, 'var_output', 'LREAL');
    const b = varBlock(p.outVar, 'out');
    wire({ block: ctl.id, port: cd.out }, [{ block: b.id, port: 0 }]);
  }
}

/**
 * Heater PWM stage: ctl output (0..100 %) -> FB_AtcPwm.Duty -> Q pulse
 * train -> BOOL output var (EL2004 channel). Execute mirrors whatever
 * drives the controller's enable; Period/MinOn/CycleTime are params.
 * Duty resolution note: at CycleTime 0.1 s and Period 1 s the duty
 * quantum is 10 % — shorten the task or the period for finer control.
 */
function wirePwm(
  pou: Pou,
  net: Network,
  p: CurveProfile,
  ctl: Block,
  cd: ControllerDef,
  wire: (
    src: { block: number; port: PortSel },
    dsts: { block: number; port: PortSel }[],
  ) => void,
  ensureIface: (name: string, kind: IfaceVar['kind'], type: string) => void,
  varBlock: (name: string, role: 'in' | 'out') => Block,
): void {
  const pwm = p.pwm!;
  if (!pwm.outVar) return;
  let blk = net.blocks.find(
    (b) => b.kind === 'fb' && b.type_ref === 'FB_AtcPwm' && b.instance === pwm.instance,
  );
  if (!blk) {
    blk = {
      id: nextNodeId(pou),
      kind: 'fb',
      type_ref: 'FB_AtcPwm',
      instance: pwm.instance,
      pos: { x: 42, y: 2 },
      params: {
        Period: num(pwm.period),
        MinOn: num(pwm.minOn),
        CycleTime: num(p.cycleTime),
      },
      exec_order: 0,
      negated: [],
      comment: `heater PWM ${num(pwm.period)} s period`,
    };
    net.blocks.push(blk);
  } else {
    blk.params = {
      ...blk.params,
      Period: num(pwm.period),
      MinOn: num(pwm.minOn),
      CycleTime: num(p.cycleTime),
    };
  }
  // controller duty -> PWM; Execute mirrors the controller's enable
  // sources (e.g. the run var block); Q -> BOOL output var
  wire({ block: ctl.id, port: cd.out }, [{ block: blk.id, port: 'Duty' }]);
  for (const w of net.wires) {
    for (const d of w.dsts) {
      if (d.block === ctl.id && d.port === cd.exec) {
        wire({ block: w.src.block, port: w.src.port }, [
          { block: blk.id, port: 'Execute' },
        ]);
      }
    }
  }
  ensureIface(pwm.outVar, 'var_output', 'BOOL');
  const out = varBlock(pwm.outVar, 'out');
  wire({ block: blk.id, port: 'Q' }, [{ block: out.id, port: 0 }]);
}

/** The blocks that make up one temperature-profile group in a network. */
export interface ProfileGroup {
  /** FB_AtcProfile instance block. */
  profFb?: Block;
  /** inline `st` block writing PROF.SEG[] (the segment table). */
  cfg?: Block;
  /** controller FB (FB_AtcPid & friends) fed by prof.SP. */
  ctl?: Block;
  /** FB_AtcPwm heater stage driven by the controller output. */
  pwm?: Block;
}

const isProfileCfg = (b: Block): boolean =>
  b.kind === 'st' && (b.params.CODE ?? '').includes('PROF.SEG[');

/** variable-block name feeding `blk`'s `port` input, if any. */
function inVarName(net: Network, blk: number, port: PortSel): string {
  const w = net.wires.find((w) => w.dsts.some((d) => d.block === blk && d.port === port));
  const sb = w && net.blocks.find((x) => x.id === w.src.block);
  return sb?.kind === 'variable' ? (sb.name ?? '') : '';
}

/**
 * Resolve which profile group a canvas block belongs to — the
 * FB_AtcProfile instance, its `st` config block, the controller FB and
 * the PWM stage. Returns undefined for unrelated blocks.
 */
export function profileGroupAt(
  pou: Pou,
  netIndex: number,
  blockId: number,
): ProfileGroup | undefined {
  const net = pou.networks[netIndex];
  const b = net?.blocks.find((x) => x.id === blockId);
  if (!net || !b) return undefined;
  const profFbs = net.blocks.filter((x) => x.kind === 'fb' && x.type_ref === 'FB_AtcProfile');
  const cfgs = net.blocks.filter(isProfileCfg);
  if (!profFbs.length && !cfgs.length) return undefined;

  const profFbForCfg = (cfg: Block) =>
    profFbs.find((f) => f.instance && inVarName(net, cfg.id, 'PROF') === f.instance) ??
    (profFbs.length === 1 ? profFbs[0] : undefined);
  const cfgForFb = (fb: Block) =>
    cfgs.find((c) => inVarName(net, c.id, 'PROF') === fb.instance) ??
    (cfgs.length === 1 ? cfgs[0] : undefined);
  const ctlForFb = (fb: Block) => {
    const w = net.wires.find((w) => w.src.block === fb.id && w.src.port === 'SP');
    return w?.dsts
      .map((d) => net.blocks.find((x) => x.id === d.block))
      .find((x) => x?.kind === 'fb' && controllerDef(x.type_ref));
  };
  const pwmForCtl = (ctl: Block | undefined) => {
    const cd = ctl && controllerDef(ctl.type_ref);
    if (!ctl || !cd) return undefined;
    const w = net.wires.find((w) => w.src.block === ctl.id && w.src.port === cd.out);
    return w?.dsts
      .map((d) => net.blocks.find((x) => x.id === d.block))
      .find((x) => x?.kind === 'fb' && x.type_ref === 'FB_AtcPwm');
  };
  const fill = (fb?: Block, cfg?: Block): ProfileGroup | undefined => {
    if (!fb && !cfg) return undefined;
    const ctl = fb ? ctlForFb(fb) : undefined;
    return { profFb: fb, cfg: cfg ?? (fb ? cfgForFb(fb) : undefined), ctl, pwm: pwmForCtl(ctl) };
  };
  /* controller → its profile: the prof.SP → ctl.<sp> wire */
  const groupForCtl = (ctl: Block): ProfileGroup | undefined => {
    const cd = controllerDef(ctl.type_ref);
    const w =
      cd &&
      net.wires.find((w) =>
        w.dsts.some((d) => d.block === ctl.id && d.port === cd.sp),
      );
    const fb = w && net.blocks.find((x) => x.id === w.src.block && x.type_ref === 'FB_AtcProfile');
    const g = fb ? fill(fb, cfgForFb(fb)) : undefined;
    if (g) {
      g.ctl = ctl;
      g.pwm = pwmForCtl(ctl);
      return g;
    }
    return { ctl, pwm: pwmForCtl(ctl) };
  };

  if (b.kind === 'fb' && b.type_ref === 'FB_AtcProfile') return fill(b, cfgForFb(b));
  if (isProfileCfg(b)) return fill(profFbForCfg(b), b);
  if (b.kind === 'fb' && controllerDef(b.type_ref)) return groupForCtl(b);
  if (b.kind === 'fb' && b.type_ref === 'FB_AtcPwm') {
    /* pwm ← ctl output; find the controller feeding its Duty pin */
    const w = net.wires.find((w) => w.dsts.some((d) => d.block === b.id && d.port === 'Duty'));
    const ctl = w && net.blocks.find((x) => x.id === w.src.block);
    if (!ctl || !controllerDef(ctl.type_ref)) return undefined;
    const g = groupForCtl(ctl);
    if (g) g.pwm = b;
    return g;
  }
  if (b.kind === 'variable' && b.name) {
    const up = b.name.toUpperCase();
    const fb = profFbs.find((f) => f.instance?.toUpperCase() === up);
    if (fb) return fill(fb, cfgForFb(fb));
    const ctl = net.blocks.find(
      (x) => x.kind === 'fb' && controllerDef(x.type_ref) && x.instance?.toUpperCase() === up,
    );
    if (ctl) return groupForCtl(ctl);
    const pwm = net.blocks.find(
      (x) => x.kind === 'fb' && x.type_ref === 'FB_AtcPwm' && x.instance?.toUpperCase() === up,
    );
    if (pwm) {
      const w = net.wires.find((w) => w.dsts.some((d) => d.block === pwm.id && d.port === 'Duty'));
      const ctl2 = w && net.blocks.find((x) => x.id === w.src.block);
      if (ctl2 && controllerDef(ctl2.type_ref)) {
        const g = groupForCtl(ctl2);
        if (g) g.pwm = pwm;
        return g;
      }
    }
  }
  return undefined;
}

/**
 * Recover a CurveProfile from a resolved group: instance/cycle time
 * from the FB_AtcProfile block, controller from the ctl block, the
 * segment table decoded from the cfg st block's CODE, and the var
 * wiring names.
 */
export function profileFromGroup(net: Network, g: ProfileGroup): CurveProfile | undefined {
  const fb = g.profFb;
  const cfg = g.cfg;
  if (!fb && !cfg) return undefined;
  const prof = defaultProfile();
  if (fb) {
    prof.instance = fb.instance ?? prof.instance;
    prof.cycleTime = Number(fb.params.CycleTime ?? prof.cycleTime) || prof.cycleTime;
  }
  if (g.ctl) {
    prof.controller = g.ctl.type_ref;
    prof.ctlInstance = g.ctl.instance ?? prof.ctlInstance;
  } else {
    prof.controller = '';
  }
  if (cfg) decodeInto(prof, cfg.params.CODE ?? '');
  // var blocks feeding RUN/PV/OUT name the wiring
  const srcOf = (block: number, port: string) =>
    net.wires.find((w) => w.dsts.some((d) => d.block === block && d.port === port))?.src.block;
  const nameOf = (id?: number) => net.blocks.find((b) => b.id === id)?.name ?? '';
  const dstNameOf = (block: number, port: string) => {
    const w = net.wires.find((w) => w.src.block === block && w.src.port === port);
    return nameOf(w?.dsts.find((d) => net.blocks.some((b) => b.id === d.block && b.kind === 'variable'))?.block);
  };
  if (fb) {
    prof.runVar = nameOf(srcOf(fb.id, 'RUN'));
    prof.pvVar = nameOf(srcOf(fb.id, 'PV'));
    prof.holdVar = nameOf(srcOf(fb.id, 'HOLD'));
    prof.resetVar = nameOf(srcOf(fb.id, 'RESET'));
    prof.busyVar = dstNameOf(fb.id, 'Busy') || undefined;
    prof.doneVar = dstNameOf(fb.id, 'Done') || undefined;
  }
  if (g.pwm) {
    const pwmBlk = g.pwm;
    prof.pwm = {
      instance: pwmBlk.instance ?? 'pwm',
      period: Number(pwmBlk.params.Period ?? 1.0) || 1.0,
      minOn: Number(pwmBlk.params.MinOn ?? 0.0) || 0.0,
      outVar: dstNameOf(pwmBlk.id, 'Q'),
    };
  }
  if (g.ctl) {
    // the controller output is a source pin: its consumer names outVar
    // (skipped when the duty feeds a PWM block instead)
    const outPort = controllerDef(g.ctl.type_ref)!.out;
    const w = net.wires.find((w) => w.src.block === g.ctl!.id && w.src.port === outPort);
    const dst = w?.dsts.find((d) => {
      const b = net.blocks.find((x) => x.id === d.block);
      return b?.kind === 'variable';
    });
    prof.outVar = nameOf(dst?.block) || undefined;
  }
  return prof;
}

/**
 * Recover a profile from an existing POU (imported project or a project
 * saved before the Curves pane existed): read the FB_AtcProfile instance
 * name, the controller block, and parse the inline `st` config body back
 * into the segment table. Returns undefined when the POU has no profile.
 */
export function profileFromPou(pou: Pou): CurveProfile | undefined {
  for (const net of pou.networks) {
    const fb = net.blocks.find((b) => b.kind === 'fb' && b.type_ref === 'FB_AtcProfile');
    const cfg = net.blocks.find(isProfileCfg);
    if (!fb || !cfg) continue;
    const ctl = net.blocks.find(
      (b) => b.kind === 'fb' && b.type_ref !== 'FB_AtcProfile' && controllerDef(b.type_ref),
    );
    const pwmBlk = net.blocks.find((b) => b.kind === 'fb' && b.type_ref === 'FB_AtcPwm');
    const prof = profileFromGroup(net, { profFb: fb, cfg, ctl, pwm: pwmBlk });
    if (prof) return prof;
  }
  return undefined;
}

/** Parse `PROF.<field> := <value>;` lines into `p` (tolerant). */
function decodeInto(p: CurveProfile, code: string): void {
  const segs: CurveSeg[] = [];
  const numOf = (s: string | undefined): number | undefined => {
    if (s === undefined) return undefined;
    const v = Number(s);
    return Number.isFinite(v) ? v : undefined;
  };
  for (const line of code.split('\n')) {
    const t = line.trim();
    const m = t.match(/^PROF\.SEG\[(\d+)\]\.(\w+)\s*:=\s*([^;]+);/i);
    if (m) {
      const idx = Number(m[1]) - 1;
      const field = m[2]!.toUpperCase();
      const v = m[3]!.trim();
      segs[idx] ??= { kind: 'end', tgt: 0, p1: 0, p2: 0, ev: 0 };
      const cur = segs[idx]!;
      if (field === 'KIND') cur.kind = SEG_KINDS.find((k) => k.code === Number(v))?.id ?? 'end';
      else if (field === 'TGT') cur.tgt = numOf(v) ?? 0;
      else if (field === 'P1') cur.p1 = numOf(v) ?? 0;
      else if (field === 'P2') cur.p2 = numOf(v) ?? 0;
      else if (field === 'EV') cur.ev = numOf(v) ?? 0;
      continue;
    }
    const top = t.match(/^PROF\.(\w+)\s*:=\s*([^;]+);/i);
    if (top) {
      const field = top[1]!.toUpperCase();
      const v = top[2]!.trim();
      if (field === 'PVSTART') p.pvStart = /true/i.test(v);
      else if (field === 'CYCLETIME') p.cycleTime = numOf(v) ?? p.cycleTime;
      else if (field === 'NUM_SEG') {
        const n = numOf(v);
        if (n && n > 0) segs.length = Math.max(segs.length, n);
      }
    }
  }
  const table = segs.filter((s): s is CurveSeg => !!s);
  if (table.length) {
    // the END sentinel is implicit in the editor
    if (!table.some((s) => s.kind === 'end'))
      table.push({ kind: 'end', tgt: 0, p1: 0, p2: 0, ev: 0 });
    p.segs = table;
  }
}

/**
 * True when some project source declares the profile library types —
 * either pasted in as an ST source (library attach) or authored as a
 * POU. The Curves pane warns when it is missing, because the generated
 * config block instantiates FB_AtcProfile.
 */
export function hasProfileLibrary(sources: string[]): boolean {
  return sources.some(
    (s) =>
      /FUNCTION_BLOCK\s+FB_AtcProfile\b/i.test(s) &&
      /(STRUCT|TYPE)\s+ST_AtcSeg\b/i.test(s),
  );
}

/** File stem for an attached library source (keeps .st naming sane). */
export function sourceStem(fileName: string): string {
  return fileName.replace(/\.st$/i, '').replace(/[^A-Za-z0-9_]+/g, '_') || 'lib';
}

/** One polyline point of the SP-vs-time preview. */
export interface PreviewPt {
  t: number;
  temp: number;
  seg: number;
  loopTo?: number;
}

/**
 * Walk the segments once to produce the SP trajectory for preview.
 * LOOP marks a point with loopTo (rendered as a return arrow) rather
 * than re-expanding; END stops the trace.
 */
export function preview(p: CurveProfile, startTemp = 25): PreviewPt[] {
  const pts: PreviewPt[] = [{ t: 0, temp: startTemp, seg: -1 }];
  let t = 0;
  let temp = startTemp;
  for (let i = 0; i < p.segs.length; i++) {
    const s = p.segs[i]!;
    switch (s.kind) {
      case 'end':
        return pts;
      case 'dwell':
        t += Math.max(0, s.p1);
        pts.push({ t, temp, seg: i });
        break;
      case 'ramp': {
        const dt = s.p1 > 0 ? Math.abs(s.tgt - temp) / s.p1 : 0;
        t += dt;
        temp = s.tgt;
        pts.push({ t, temp, seg: i });
        break;
      }
      case 'rampt':
        t += Math.max(0, s.p1);
        temp = s.tgt;
        pts.push({ t, temp, seg: i });
        break;
      case 'step':
        temp = s.tgt;
        pts.push({ t, temp, seg: i });
        break;
      case 'loop':
        pts.push({ t, temp, seg: i, loopTo: Math.max(0, Math.trunc(s.tgt) - 1) });
        break;
    }
  }
  return pts;
}

/** fmt a number as an ST LREAL literal (always carries a fraction). */
export function num(v: number): string {
  if (!Number.isFinite(v)) return '0.0';
  const s = String(v);
  return s.includes('.') || s.includes('e') || s.includes('E') ? s : `${s}.0`;
}
