import { describe, expect, it } from 'vitest';
import {
  applyTunerToPou,
  liveVarName,
  tuneCode,
  tunePins,
  tunerFromPou,
  TuneCfg,
} from './tune';
import { Pou } from './model';

function pou(): Pou {
  return {
    id: 'p1',
    name: 'Main',
    kind: 'program',
    en_eno: 'off',
    interface: [],
    networks: [],
  };
}

const RELAY: TuneCfg = {
  kind: 'relay',
  instance: 'tune',
  ctlInstance: 'pid',
  runVar: 'TuneRun',
  pvVar: 'TempPV',
  spVar: 'TempSP',
  outVar: 'TuneOut',
  applyVar: 'TuneApply',
  resetVar: 'TuneReset',
};

describe('tune codegen', () => {
  it('relay handoff mirrors outputs and applies PID gains', () => {
    const code = tuneCode(RELAY);
    expect(code).toContain('tune_ku := TUNE.Ku;');
    expect(code).toContain('tune_done := TUNE.Done;');
    expect(code).toContain('IF APPLY AND NOT applied THEN');
    expect(code).toContain('CTL.Kp := TUNE.Kp;');
    expect(code).toContain('CTL.Tn := TUNE.Tn;');
    expect(code).toContain('CTL.Tv := TUNE.Tv;');
    expect(code).toContain('applied := TRUE;');
    expect(code).toContain('IF RESET THEN applied := FALSE; END_IF;');
  });

  it('step handoff reads gains from RULES, idents from IDENT', () => {
    const code = tuneCode({ kind: 'step', instance: 'ident', instance2: 'rules', ctlInstance: 'pid' });
    expect(code).toContain('ident_k := IDENT.K;');
    expect(code).toContain('rules_kp := RULES.Kp;');
    expect(code).toContain('CTL.Kp := RULES.Kp;');
  });

  it('lqg handoff splits Kalman and LQR gains', () => {
    const code = tuneCode({
      kind: 'lqg',
      instance: 'kal',
      instance2: 'lqr',
      ctlInstance: 'lqg',
    });
    expect(code).toContain('kal_l1 := KAL.L1;');
    expect(code).toContain('lqr_k1 := LQR.K1;');
    expect(code).toContain('CTL.L1 := KAL.L1;');
    expect(code).toContain('CTL.L2 := KAL.L2;');
    expect(code).toContain('CTL.K1 := LQR.K1;');
    expect(code).toContain('CTL.Ki := LQR.Ki;');
  });

  it('omits the gain block without a controller', () => {
    const code = tuneCode({ kind: 'relay', instance: 'tune' });
    expect(code).not.toContain('CTL.');
    expect(code).not.toContain('applied := TRUE;');
  });

  it('types live pins BOOL/DINT/INT/LREAL correctly', () => {
    const pins = tunePins({ kind: 'lqr', instance: 'lqr' });
    const byName = new Map(pins.map((p) => [p.name, p]));
    expect(byName.get('lqr_done')?.type).toBe('BOOL');
    expect(byName.get('lqr_iter')?.type).toBe('DINT');
    expect(byName.get('lqr_k1')?.type).toBe('LREAL');
    expect(byName.get('TUNE')?.kind).toBe('var_in_out');
    expect(byName.get('TUNE')?.type).toBe('FB_AtcLqrTune');
  });
});

describe('applyTunerToPou', () => {
  it('inserts relay tuner + handoff + wiring', () => {
    const p = pou();
    applyTunerToPou(p, RELAY);
    const net = p.networks[0]!;
    const fb = net.blocks.find((b) => b.kind === 'fb' && b.type_ref === 'FB_AtcRelayTune')!;
    expect(fb.instance).toBe('tune');
    expect(fb.params.RelayAmp).toBe('10.0');
    const st = net.blocks.find((b) => b.kind === 'st')!;
    expect(st.params.CODE).toContain('tune_ku := TUNE.Ku;');
    // instance alias var block precedes use (precollect order)
    const alias = net.blocks.find((b) => b.kind === 'variable' && b.name === 'tune')!;
    expect(net.blocks.indexOf(fb)).toBeLessThan(net.blocks.indexOf(alias));
    // wires: run→Execute, pv→Actual, sp→Setpoint, apply→APPLY,
    // reset→Reset, Out→out var, handoff→live vars
    const dsts = new Set(net.wires.flatMap((w) => w.dsts.map((d) => `${d.block}:${d.port}`)));
    expect(dsts.has(`${fb.id}:Execute`)).toBe(true);
    expect(dsts.has(`${fb.id}:Actual`)).toBe(true);
    expect(dsts.has(`${fb.id}:Setpoint`)).toBe(true);
    expect(dsts.has(`${fb.id}:Reset`)).toBe(true);
    expect(dsts.has(`${st.id}:APPLY`)).toBe(true);
    expect(dsts.has(`${st.id}:RESET`)).toBe(true);
    expect(dsts.has(`${st.id}:TUNE`)).toBe(true);
    expect(dsts.has(`${st.id}:CTL`)).toBe(true);
    // interface vars created
    const names = p.interface.map((v) => v.name);
    for (const n of ['TuneRun', 'TempPV', 'TempSP', 'TuneOut', 'TuneApply', 'TuneReset', 'tune_ku', 'tune_done']) {
      expect(names).toContain(n);
    }
    expect(p.interface.find((v) => v.name === 'TuneOut')?.kind).toBe('var_output');
    expect(p.interface.find((v) => v.name === 'tune_done')?.type).toBe('BOOL');
  });

  it('step kind wires IDENT outputs into RULES and Done→Execute', () => {
    const p = pou();
    applyTunerToPou(p, { kind: 'step', instance: 'ident', instance2: 'rules', pvVar: 'PV' });
    const net = p.networks[0]!;
    const ident = net.blocks.find((b) => b.kind === 'fb' && b.type_ref === 'FB_AtcStepIdent')!;
    const rules = net.blocks.find((b) => b.kind === 'fb' && b.type_ref === 'FB_AtcTuneRules')!;
    expect(ident.instance).toBe('ident');
    expect(rules.instance).toBe('rules');
    const wires = net.wires.filter((w) => w.src.block === ident.id);
    const ruleDsts = wires.flatMap((w) => w.dsts.filter((d) => d.block === rules.id).map((d) => d.port));
    expect(ruleDsts).toEqual(expect.arrayContaining(['K', 'Tau', 'Theta']));
    // RULES.Execute driven by IDENT.Done
    const execWire = net.wires.find(
      (w) => w.src.block === ident.id && w.src.port === 'Done' && w.dsts.some((d) => d.block === rules.id && d.port === 'Execute'),
    );
    expect(execWire).toBeTruthy();
    // runVar absent → Execute un wired on IDENT (param/default), no crash
  });

  it('is idempotent — re-apply replaces the handoff, keeps tuner params', () => {
    const p = pou();
    applyTunerToPou(p, RELAY);
    applyTunerToPou(p, { ...RELAY, instance: 'tune2' });
    const net = p.networks[0]!;
    const sts = net.blocks.filter((b) => b.kind === 'st' && (b.params.CODE ?? '').includes('applied :='));
    expect(sts).toHaveLength(1);
    expect(sts[0]!.params.CODE).toContain('tune2_ku');
    // only one RelayTune fb (old instance 'tune' remains — user may rewire;
    // the new instance 'tune2' was added)
    const fbs = net.blocks.filter((b) => b.kind === 'fb' && b.type_ref === 'FB_AtcRelayTune');
    expect(fbs.map((b) => b.instance)).toContain('tune2');
  });

  it('wires the controller block from the same run/pv/sp/out bindings', () => {
    const ctlBlk = (fb: string): import('./model').Block => ({
      id: 90,
      kind: 'fb',
      type_ref: fb,
      instance: 'pid',
      pos: { x: 30, y: 2 },
      params: { CycleTime: '0.1' },
      exec_order: 0,
      negated: [],
      comment: 'controller',
    });
    const p = pou();
    p.networks.push({
      id: 'n1', kind: 'fbd', label: '', comments: [], assocs: [],
      labels: [], jumps: [], returns: [], blocks: [ctlBlk('FB_AtcPid')], wires: [],
    });
    const net = p.networks[0]!;
    applyTunerToPou(p, RELAY);
    const dsts = new Set(net.wires.flatMap((w) => w.dsts.map((d) => `${d.block}:${d.port}`)));
    // pid.Execute/Actual/Setpoint driven; pid.Out loses to tuner Out on TuneOut
    expect(dsts.has('90:Execute')).toBe(true);
    expect(dsts.has('90:Actual')).toBe(true);
    expect(dsts.has('90:Setpoint')).toBe(true);
    expect(net.wires.some((w) => w.src.block === 90 && w.src.port === 'Out')).toBe(false);
    // seeds: PID gets OutMin/OutMax but never the tuned gains as params
    const pidBlk = net.blocks.find((b) => b.instance === 'pid')!;
    expect(pidBlk.params.OutMin).toBe('0.0');
    expect(pidBlk.params.OutMax).toBe('100.0');
    expect(pidBlk.params.Kp).toBeUndefined();
    // lqg: matrix tuners leave the controller fully wired incl. Out
    const q = pou();
    q.networks.push({
      id: 'n1', kind: 'fbd', label: '', comments: [], assocs: [],
      labels: [], jumps: [], returns: [], blocks: [ctlBlk('FB_AtcLqg')], wires: [],
    });
    applyTunerToPou(q, {
      kind: 'lqg',
      instance: 'kal',
      instance2: 'lqr',
      ctlInstance: 'pid',
      runVar: 'Run2',
      pvVar: 'Pv2',
      spVar: 'Sp2',
      outVar: 'Out2',
    });
    const qn = q.networks[0]!;
    const qdsts = new Set(qn.wires.flatMap((w) => w.dsts.map((d) => `${d.block}:${d.port}`)));
    expect(qdsts.has('90:Execute')).toBe(true);
    expect(qdsts.has('90:Actual')).toBe(true);
    expect(qdsts.has('90:Setpoint')).toBe(true);
    const outDst = qn.wires.find((w) => w.src.block === 90 && w.src.port === 'Out');
    expect(outDst).toBeTruthy();
    // LQG controller re-runs the estimator — it needs the plant A/B
    // matrices propagated from the tuner params, plus OutMin/OutMax
    const lqgBlk = qn.blocks.find((b) => b.instance === 'pid')!;
    expect(lqgBlk.params.A11).toBe('0.98');
    expect(lqgBlk.params.B1).toBe('0.5');
    expect(lqgBlk.params.B2).toBe('0.1');
    expect(lqgBlk.params.OutMin).toBe('0.0');
    expect(lqgBlk.params.OutMax).toBe('100.0');
    expect(lqgBlk.params.K1).toBeUndefined();
    expect(lqgBlk.params.L1).toBeUndefined();
    // tuner-only weights must not leak onto the controller
    expect(lqgBlk.params.Q1).toBeUndefined();
    expect(lqgBlk.params.R).toBeUndefined();
  });

  it('recovers a TuneCfg from an inserted POU', () => {
    const p = pou();
    applyTunerToPou(p, RELAY);
    const rec = tunerFromPou(p);
    expect(rec?.kind).toBe('relay');
    expect(rec?.instance).toBe('tune');
    expect(rec?.applyVar).toBe('TuneApply');
    expect(rec?.resetVar).toBe('TuneReset');
  });
});
