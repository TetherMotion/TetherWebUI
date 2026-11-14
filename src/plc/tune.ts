/**
 * Autotune model — inserts the Atc_TempCtrl tuner family into a POU's
 * FBD network and generates the ST handoff block that mirrors tuner
 * outputs to live vars and copies computed gains into the controller
 * instance on the APPLY strobe.
 *
 * Kinds:
 *  - relay: FB_AtcRelayTune          → Kp/Tn/Tv      → FB_AtcPid
 *  - step:  FB_AtcStepIdent + FB_AtcTuneRules → Kp/Tn/Tv → FB_AtcPid
 *  - lqr:   FB_AtcLqrTune            → K1/K2/Ki      → FB_AtcLqr
 *  - lqg:   FB_AtcKalmanTune + FB_AtcLqrTune → L1/L2 + K1/K2/Ki → FB_AtcLqg
 *
 * The handoff is an inline `st` block (same mechanism as the profile
 * config block): VAR_IN_OUT pins alias the tuner/controller instances,
 * VAR_OUTPUT pins become plain LREAL/BOOL interface vars the catalog
 * exposes as `plc.<pou>.<var>` — live tuner state needs no struct
 * decoding. Gain writes go through the inout alias (`CTL.Kp := …`),
 * which lands in the instance's input storage between scans; the
 * controller block must therefore NOT carry static params for the
 * tuned members (applyTuner strips them).
 *
 * Expr templates use `{P}` = the src's own handoff pin name and
 * `{P0}`/`{P1}` = first/second src pin inside gain writes.
 */
import { Block, IfaceVar, PortSel, Pou, nextNodeId } from './model';
import { controllerDef } from './curve';

export type TuneKind = 'relay' | 'step' | 'lqr' | 'lqg';

export interface TuneCfg {
  kind: TuneKind;
  /** primary tuner instance name. */
  instance: string;
  /** second tuner instance for step (rules) / lqg (lqr). */
  instance2?: string;
  /** controller instance receiving gains; '' = mirror only. */
  ctlInstance?: string;
  /** tuner param overrides merged over per-kind defaults. */
  params?: Record<string, string>;
  /** BOOL var wired to tuner Execute pins. */
  runVar?: string;
  /** LREAL var wired to Actual inputs. */
  pvVar?: string;
  /** LREAL var wired to Setpoint (relay only). */
  spVar?: string;
  /** LREAL var receiving the tuner Out (relay/step drive the plant). */
  outVar?: string;
  /** BOOL var pulsing the gain-apply strobe. */
  applyVar?: string;
  /** BOOL var wired to Reset pins. */
  resetVar?: string;
}

export interface TunerSrc {
  /** FB type of this source instance. */
  fb: string;
  /** cfg instance-name key. */
  inst: 'instance' | 'instance2';
  /** default param bindings (name → ST literal). */
  params: Record<string, string>;
  /** live mirror outputs: [pinName, exprTemplate]. */
  live: [string, string][];
}

/** controller FB type + gain member writes per kind. */
const CONTROLLERS: Record<TuneKind, { fb: string; gains: [string, string][] }> = {
  relay: {
    fb: 'FB_AtcPid',
    gains: [
      ['Kp', '{P0}.Kp'],
      ['Tn', '{P0}.Tn'],
      ['Tv', '{P0}.Tv'],
    ],
  },
  step: {
    fb: 'FB_AtcPid',
    gains: [
      ['Kp', '{P1}.Kp'],
      ['Tn', '{P1}.Tn'],
      ['Tv', '{P1}.Tv'],
    ],
  },
  lqr: {
    fb: 'FB_AtcLqr',
    gains: [
      ['K1', '{P0}.K1'],
      ['K2', '{P0}.K2'],
      ['Ki', '{P0}.Ki'],
    ],
  },
  lqg: {
    fb: 'FB_AtcLqg',
    gains: [
      ['L1', '{P0}.L1'],
      ['L2', '{P0}.L2'],
      ['K1', '{P1}.K1'],
      ['K2', '{P1}.K2'],
      ['Ki', '{P1}.Ki'],
    ],
  },
};

/** ST identifier used inside the handoff body for each source pin. */
const PIN_NAME: Record<TuneKind, string[]> = {
  relay: ['TUNE'],
  step: ['IDENT', 'RULES'],
  lqr: ['TUNE'],
  lqg: ['KAL', 'LQR'],
};

const SRC_DEFS: Record<TuneKind, TunerSrc[]> = {
  relay: [
    {
      fb: 'FB_AtcRelayTune',
      inst: 'instance',
      params: {
        RelayAmp: '10.0',
        MeanOut: '30.0',
        Hyst: '0.5',
        OutMin: '0.0',
        OutMax: '100.0',
        TuneRule: '0',
        MinCyc: '3',
        CycleTime: '0.1',
        Abort: 'FALSE',
        Reset: 'FALSE',
      },
      live: [
        ['KU', '{P}.Ku'],
        ['TU', '{P}.Tu'],
        ['AMP', '{P}.Amp'],
        ['KP', '{P}.Kp'],
        ['TN', '{P}.Tn'],
        ['TV', '{P}.Tv'],
        ['CYCLES', '{P}.Cycles'],
        ['DONE', '{P}.Done'],
        ['BUSY', '{P}.Busy'],
        ['ERR', '{P}.Err'],
      ],
    },
  ],
  step: [
    {
      fb: 'FB_AtcStepIdent',
      inst: 'instance',
      params: {
        U0: '0.0',
        U1: '50.0',
        SettleT: '30.0',
        TolBand: '0.2',
        SettleN: '10',
        MaxTime: '300.0',
        StoreEvery: '1',
        CycleTime: '0.1',
        Reset: 'FALSE',
      },
      live: [
        ['K', '{P}.K'],
        ['TAU', '{P}.Tau'],
        ['THETA', '{P}.Theta'],
        ['PV0', '{P}.Pv0'],
        ['PVF', '{P}.PvFinal'],
        ['T35', '{P}.T35'],
        ['T85', '{P}.T85'],
        ['ERRID', '{P}.ErrId'],
        ['DONE', '{P}.Done'],
        ['BUSY', '{P}.Busy'],
        ['ERR', '{P}.Err'],
      ],
    },
    {
      fb: 'FB_AtcTuneRules',
      inst: 'instance2',
      params: { Rule: '0', Lambda: '0.0' },
      live: [
        ['KP', '{P}.Kp'],
        ['TN', '{P}.Tn'],
        ['TV', '{P}.Tv'],
        ['DONE', '{P}.Done'],
        ['ERR', '{P}.Err'],
      ],
    },
  ],
  lqr: [
    {
      fb: 'FB_AtcLqrTune',
      inst: 'instance',
      params: {
        A11: '0.98',
        A12: '0.0',
        A21: '0.05',
        A22: '0.95',
        B1: '0.5',
        B2: '0.1',
        Q1: '1.0',
        Q2: '0.1',
        Qi: '0.01',
        R: '1.0',
        Ts: '0.1',
        MaxIter: '30',
        Tol: '1e-10',
      },
      live: [
        ['K1', '{P}.K1'],
        ['K2', '{P}.K2'],
        ['KI', '{P}.Ki'],
        ['ITER', '{P}.Iter'],
        ['CONV', '{P}.Conv'],
        ['DONE', '{P}.Done'],
        ['ERR', '{P}.Err'],
      ],
    },
  ],
  lqg: [
    {
      fb: 'FB_AtcKalmanTune',
      inst: 'instance',
      params: {
        A11: '0.98',
        A12: '0.0',
        A21: '0.05',
        A22: '0.95',
        Q1: '0.001',
        Q2: '0.0001',
        R: '0.1',
        MaxIter: '30',
        Tol: '1e-10',
      },
      live: [
        ['L1', '{P}.L1'],
        ['L2', '{P}.L2'],
        ['ITER', '{P}.Iter'],
        ['CONV', '{P}.Conv'],
        ['DONE', '{P}.Done'],
        ['ERR', '{P}.Err'],
      ],
    },
    {
      fb: 'FB_AtcLqrTune',
      inst: 'instance2',
      params: {
        A11: '0.98',
        A12: '0.0',
        A21: '0.05',
        A22: '0.95',
        B1: '0.5',
        B2: '0.1',
        Q1: '1.0',
        Q2: '0.1',
        Qi: '0.01',
        R: '1.0',
        Ts: '0.1',
        MaxIter: '30',
        Tol: '1e-10',
      },
      live: [
        ['K1', '{P}.K1'],
        ['K2', '{P}.K2'],
        ['KI', '{P}.Ki'],
        ['ITER', '{P}.Iter'],
        ['CONV', '{P}.Conv'],
        ['DONE', '{P}.Done'],
        ['ERR', '{P}.Err'],
      ],
    },
  ],
};

/** kind picker entries for the tune pane. */
export const TUNE_KINDS: { id: TuneKind; label: string }[] = [
  { id: 'relay', label: 'Relay feedback → PID (Z-N)' },
  { id: 'step', label: 'Step identification → PID (FOPDT)' },
  { id: 'lqr', label: 'LQR gain design' },
  { id: 'lqg', label: 'LQG (Kalman filter + LQR)' },
];

export function controllerFb(kind: TuneKind): string {
  return CONTROLLERS[kind].fb;
}

/** tuner source defs per kind (UI param tables + instance wiring). */
export const SRC_DEFS_FOR_UI: Record<TuneKind, TunerSrc[]> = SRC_DEFS;

/** handoff pin name for a src slot. */
export function srcPinName(kind: TuneKind, slot: number): string {
  return PIN_NAME[kind][slot]!;
}

/** instance name for a src slot. */
export function srcInstance(cfg: TuneCfg, slot: 'instance' | 'instance2'): string {
  return (slot === 'instance2' ? cfg.instance2 : cfg.instance) ?? cfg.instance;
}

/** live mirror var name (`tune_ku` style, lowercased). */
export function liveVarName(inst: string, pin: string): string {
  return `${inst.toLowerCase()}_${pin.toLowerCase()}`;
}

const BOOL_PINS = new Set(['DONE', 'BUSY', 'ERR', 'CONV']);
const INT_PINS = new Set(['ITER', 'CYCLES']);
const ERRID_PINS = new Set(['ERRID']);

function subst(expr: string, pins: string[]): string {
  return expr
    .replaceAll('{P0}', pins[0] ?? pins[0]!)
    .replaceAll('{P1}', pins[1] ?? pins[0]!);
}

/** pins the generated handoff block exposes. */
export function tunePins(cfg: TuneCfg): IfaceVar[] {
  const pins: IfaceVar[] = [];
  for (const [i, s] of SRC_DEFS[cfg.kind].entries()) {
    pins.push({ name: PIN_NAME[cfg.kind][i]!, kind: 'var_in_out', type: s.fb });
  }
  if (cfg.ctlInstance) {
    pins.push({ name: 'CTL', kind: 'var_in_out', type: CONTROLLERS[cfg.kind].fb });
  }
  pins.push({ name: 'APPLY', kind: 'var_input', type: 'BOOL' });
  pins.push({ name: 'RESET', kind: 'var_input', type: 'BOOL' });
  for (const s of SRC_DEFS[cfg.kind]) {
    const inst = srcInstance(cfg, s.inst);
    for (const [pin] of s.live) {
      pins.push({
        name: liveVarName(inst, pin),
        kind: 'var_output',
        type: BOOL_PINS.has(pin) ? 'BOOL' : INT_PINS.has(pin) ? 'DINT' : ERRID_PINS.has(pin) ? 'INT' : 'LREAL',
      });
    }
  }
  pins.push({ name: 'applied', kind: 'var', type: 'BOOL' });
  return pins;
}

/** ST body of the handoff block: live mirrors + gain apply. */
export function tuneCode(cfg: TuneCfg): string {
  const pins = PIN_NAME[cfg.kind];
  const l: string[] = [];
  for (const [i, s] of SRC_DEFS[cfg.kind].entries()) {
    const inst = srcInstance(cfg, s.inst);
    for (const [out, expr] of s.live) {
      const v = liveVarName(inst, out);
      l.push(`${v} := ${subst(expr, pins).replaceAll('{P}', pins[i]!)};`);
    }
  }
  if (cfg.ctlInstance) {
    l.push('IF APPLY AND NOT applied THEN');
    for (const [member, expr] of CONTROLLERS[cfg.kind].gains) {
      l.push(`    CTL.${member} := ${subst(expr, pins)};`);
    }
    l.push('    applied := TRUE;');
    l.push('END_IF;');
    l.push('IF RESET THEN applied := FALSE; END_IF;');
  }
  return l.join('\n') + '\n';
}

function fbBlock(
  pou: Pou,
  typeRef: string,
  instance: string,
  params: Record<string, string>,
  pos: { x: number; y: number },
  comment: string,
): Block {
  return {
    id: nextNodeId(pou),
    kind: 'fb',
    type_ref: typeRef,
    instance,
    pos,
    params,
    exec_order: 0,
    negated: [],
    comment,
  };
}

function varBlock(
  pou: Pou,
  role: 'in' | 'out',
  name: string,
  pos: { x: number; y: number },
): Block {
  return {
    id: nextNodeId(pou),
    kind: 'variable',
    type_ref: '',
    pos,
    params: {},
    exec_order: 0,
    negated: [],
    comment: '',
    role,
    name,
  };
}

/**
 * Insert (or refresh) the tuner set + handoff block into the POU's
 * first FBD network. Idempotent: existing tuner blocks of the same
 * instance are updated in place; the handoff st block is replaced.
 */
export function applyTunerToPou(pou: Pou, cfg: TuneCfg): void {
  let net = pou.networks.find((n) => n.kind === 'fbd');
  if (!net) {
    net = {
      id: `net${pou.networks.length + 1}`,
      kind: 'fbd',
      label: 'tune',
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
  const c = CONTROLLERS[cfg.kind];
  const y = 8 + Math.floor(net.blocks.length / 6) * 6;

  // drop a previous handoff for this cfg (identified by CODE marker)
  // plus every wire touching it — dsts are re-created below
  const dead = new Set(
    net.blocks
      .filter((b) => b.kind === 'st' && (b.params.CODE ?? '').includes('applied :='))
      .map((b) => b.id),
  );
  net.blocks = net.blocks.filter((b) => !dead.has(b.id));
  net.wires = net.wires.filter(
    (w) => !dead.has(w.src.block) && !w.dsts.some((d) => dead.has(d.block)),
  );

  // ---- tuner fb blocks -------------------------------------------------
  const srcBlocks: Block[] = [];
  for (const [i, s] of SRC_DEFS[cfg.kind].entries()) {
    const inst = srcInstance(cfg, s.inst);
    const params = { ...s.params, ...(cfg.params ?? {}) };
    const old = net.blocks.find(
      (b) => b.kind === 'fb' && b.instance === inst && b.type_ref === s.fb,
    );
    const blk =
      old ??
      fbBlock(pou, s.fb, inst, params, { x: 14 + i * 16, y }, `autotune ${s.fb}`);
    blk.params = params;
    blk.comment = `autotune ${s.fb}`;
    if (!old) net.blocks.push(blk);
    srcBlocks.push(blk);
  }

  // step kind: RULES consumes IDENT's FOPDT outputs directly
  if (cfg.kind === 'step') {
    const [ident, rules] = srcBlocks;
    const driven = new Set(net.wires.flatMap((w) => w.dsts.map((d) => `${d.block}:${d.port}`)));
    const add = (src: number, sp: PortSel, dp: number, pp: PortSel) => {
      if (!driven.has(`${dp}:${String(pp)}`)) {
        net!.wires.push({ id: nextNodeId(pou), src: { block: src, port: sp }, dsts: [{ block: dp, port: pp }] });
        driven.add(`${dp}:${String(pp)}`);
      }
    };
    add(ident!.id, 'K', rules!.id, 'K');
    add(ident!.id, 'Tau', rules!.id, 'Tau');
    add(ident!.id, 'Theta', rules!.id, 'Theta');
  }

  // ---- interface vars --------------------------------------------------
  const ensureIface = (name: string, kind: IfaceVar['kind'], type: string) => {
    if (pou.interface.some((v) => v.name.toUpperCase() === name.toUpperCase())) return;
    pou.interface.push({ name, kind, type });
  };
  for (const v of ['runVar', 'pvVar', 'spVar', 'outVar', 'applyVar', 'resetVar'] as const) {
    const n = cfg[v];
    if (!n) continue;
    const bool = v === 'runVar' || v === 'applyVar' || v === 'resetVar';
    ensureIface(n, bool || v === 'pvVar' || v === 'spVar' ? 'var_input' : 'var_output', bool ? 'BOOL' : 'LREAL');
  }

  // ---- var blocks + wiring ----------------------------------------------
  const vb = (role: 'in' | 'out', name: string, x: number): Block => {
    const found = net!.blocks.find(
      (b) => b.kind === 'variable' && b.name === name && b.role === role,
    );
    if (found) return found;
    const b = varBlock(pou, role, name, { x, y: y + 2 });
    net!.blocks.push(b);
    return b;
  };
  const driven = new Set(net.wires.flatMap((w) => w.dsts.map((d) => `${d.block}:${d.port}`)));
  const wireTo = (srcB: number, srcP: PortSel, dstB: number, dstP: PortSel) => {
    if (driven.has(`${dstB}:${String(dstP)}`)) return;
    driven.add(`${dstB}:${String(dstP)}`);
    net!.wires.push({ id: nextNodeId(pou), src: { block: srcB, port: srcP }, dsts: [{ block: dstB, port: dstP }] });
  };

  // instance alias var blocks for the handoff pins (role 'in', like
  // the profile's `prof` alias — the inout pin derefs the instance)
  const instVar = (inst: string, x: number): Block => {
    const found = net!.blocks.find(
      (b) => b.kind === 'variable' && b.name === inst && b.role === 'in',
    );
    if (found) return found;
    const b = varBlock(pou, 'in', inst, { x, y: y + 4 });
    net!.blocks.push(b);
    return b;
  };

  // ---- handoff st block ---------------------------------------------------
  const cfgId = nextNodeId(pou);
  const stParams: Record<string, string> = { CODE: tuneCode(cfg) };
  if (!cfg.applyVar) stParams.APPLY = 'TRUE';
  if (!cfg.resetVar) stParams.RESET = 'FALSE';
  const stBlock: Block = {
    id: cfgId,
    kind: 'st',
    type_ref: 'ST',
    pos: { x: 2, y: y + 6 },
    params: stParams,
    exec_order: 0,
    negated: [],
    comment: `autotune handoff ${cfg.kind}`,
    pins: tunePins(cfg),
  };
  net.blocks.push(stBlock);

  // wire instance aliases → handoff inout pins
  for (const [i, s] of SRC_DEFS[cfg.kind].entries()) {
    const pinName = PIN_NAME[cfg.kind][i]!;
    const iv = instVar(srcInstance(cfg, s.inst), 2 + i * 4);
    wireTo(iv.id, 0, cfgId, pinName);
  }
  if (cfg.ctlInstance) {
    const cv = instVar(cfg.ctlInstance, 14);
    // strip tuned gain params — the handoff owns them now
    const cb = net.blocks.find((b) => b.kind === 'fb' && b.instance === cfg.ctlInstance);
    if (cb) {
      for (const [m] of c.gains) delete cb.params[m];
      const cd = controllerDef(cb.type_ref);
      if (cd) {
        // seed run params (limits etc.) so the loop can run — minus the
        // tuned gain members; existing block params win
        const gainNames = new Set(c.gains.map(([m]) => m));
        const merged: Record<string, string> = {};
        for (const b of srcBlocks) Object.assign(merged, b.params);
        // plant-model inputs the controller needs live (LQG re-runs the
        // estimator; LQR takes Nref/FFwd) — propagate from tuner params
        const PLANT: Record<string, string[]> = {
          FB_AtcLqg: ['A11', 'A12', 'A21', 'A22', 'B1', 'B2', 'Nref', 'FFwd'],
          FB_AtcLqr: ['Nref', 'FFwd'],
        };
        for (const [k, v] of Object.entries(cd.params ?? {})) {
          if (!gainNames.has(k) && cb.params[k] === undefined) cb.params[k] = v;
        }
        for (const k of PLANT[cb.type_ref] ?? []) {
          if (cb.params[k] === undefined && merged[k] !== undefined) cb.params[k] = merged[k];
        }
      }
    }
    wireTo(cv.id, 0, cfgId, 'CTL');
  }
  if (cfg.applyVar) wireTo(vb('in', cfg.applyVar, 0).id, 0, cfgId, 'APPLY');
  if (cfg.resetVar) wireTo(vb('in', cfg.resetVar, 0).id, 0, cfgId, 'RESET');

  // live mirror outputs → interface vars
  for (const [i, s] of SRC_DEFS[cfg.kind].entries()) {
    const inst = srcInstance(cfg, s.inst);
    for (const [pin] of s.live) {
      const vn = liveVarName(inst, pin);
      const isBool = BOOL_PINS.has(pin);
      const ty = isBool ? 'BOOL' : INT_PINS.has(pin) ? 'DINT' : ERRID_PINS.has(pin) ? 'INT' : 'LREAL';
      ensureIface(vn, 'var_output', ty);
      const ob = vb('out', vn, 30 + i * 6);
      wireTo(cfgId, vn, ob.id, 0);
    }
  }

  // ---- signal wiring ------------------------------------------------------
  const inVar = (name: string | undefined, x: number): Block | undefined =>
    name ? vb('in', name, x) : undefined;
  for (const [i, s] of srcBlocks.entries()) {
    const b = s;
    const def = SRC_DEFS[cfg.kind][i]!;
    if (def.fb !== 'FB_AtcTuneRules' && cfg.runVar) {
      wireTo(inVar(cfg.runVar, 0)!.id, 0, b.id, 'Execute');
    }
    if (cfg.kind === 'step' && def.fb === 'FB_AtcTuneRules') {
      // RULES fires on IDENT.Done — the identification must finish first
      wireTo(srcBlocks[0]!.id, 'Done', b.id, 'Execute');
    }
    // only the process-driven tuners take Actual (matrix tuners don't)
    if (
      cfg.pvVar &&
      (def.fb === 'FB_AtcRelayTune' || def.fb === 'FB_AtcStepIdent')
    ) {
      wireTo(inVar(cfg.pvVar, 4)!.id, 0, b.id, 'Actual');
    }
    if (cfg.spVar && def.fb === 'FB_AtcRelayTune') {
      wireTo(inVar(cfg.spVar, 8)!.id, 0, b.id, 'Setpoint');
    }
    // Reset exists only on the process-driven tuners
    if (
      cfg.resetVar &&
      (def.fb === 'FB_AtcRelayTune' || def.fb === 'FB_AtcStepIdent')
    ) {
      wireTo(inVar(cfg.resetVar, 12)!.id, 0, b.id, 'Reset');
    }
    // tuner Out → plant input (relay/step only — LQR tuners don't drive)
    if (cfg.outVar && (def.fb === 'FB_AtcRelayTune' || def.fb === 'FB_AtcStepIdent')) {
      wireTo(b.id, 'Out', vb('out', cfg.outVar, 40)!.id, 0);
    }
  }

  // ---- controller wiring --------------------------------------------------
  // The same run/pv/sp/out bindings drive the controller block — for
  // lqr/lqg the matrix tuners have no process pins, so without this the
  // controller would sit unwired. wireTo is idempotent: pins already
  // driven (e.g. by the profile editor) keep their source, and for
  // relay/step the tuner Out already owns outVar.
  if (cfg.ctlInstance) {
    const cb = net.blocks.find(
      (b) => b.kind === 'fb' && b.instance === cfg.ctlInstance,
    );
    const cd = cb?.type_ref ? controllerDef(cb.type_ref) : undefined;
    if (cb && cd) {
      if (cfg.runVar) wireTo(vb('in', cfg.runVar, 0).id, 0, cb.id, cd.exec);
      if (cfg.pvVar) wireTo(vb('in', cfg.pvVar, 4).id, 0, cb.id, cd.pv);
      if (cfg.spVar) wireTo(vb('in', cfg.spVar, 8).id, 0, cb.id, cd.sp);
      if (cfg.outVar) wireTo(cb.id, cd.out, vb('out', cfg.outVar, 40)!.id, 0);
    }
  }
}

/** Recover a TuneCfg from a POU that already has tuner blocks. */
export function tunerFromPou(pou: Pou): TuneCfg | undefined {
  for (const net of pou.networks) {
    for (const kind of ['relay', 'step', 'lqr', 'lqg'] as TuneKind[]) {
      const srcs = SRC_DEFS[kind];
      const blk = net.blocks.find((b) => b.kind === 'fb' && b.type_ref === srcs[0]!.fb);
      if (!blk?.instance) continue;
      const cfg: TuneCfg = {
        kind,
        instance: blk.instance,
        params: { ...blk.params },
      };
      if (srcs[1]) {
        const b2 = net.blocks.find((b) => b.kind === 'fb' && b.type_ref === srcs[1]!.fb);
        if (b2?.instance) cfg.instance2 = b2.instance;
      }
      const st = net.blocks.find(
        (b) => b.kind === 'st' && (b.params.CODE ?? '').includes('applied :='),
      );
      if (st) {
        for (const w of net.wires) {
          for (const d of w.dsts) {
            if (d.block !== st.id) continue;
            const sb = net.blocks.find((b) => b.id === w.src.block);
            if (sb?.kind === 'variable' && sb.name && sb.role === 'in') {
              if (d.port === 'APPLY') cfg.applyVar = sb.name;
              if (d.port === 'RESET') cfg.resetVar = sb.name;
            }
          }
        }
      }
      return cfg;
    }
  }
  return undefined;
}
