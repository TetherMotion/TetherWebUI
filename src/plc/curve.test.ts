import { describe, expect, it } from 'vitest';
import {
  applyToPou,
  defaultProfile,
  emitPou,
  num,
  preview,
  profileCode,
  hasProfileLibrary,
  profileFromPou,
  sourceStem,
  segCode,
} from './curve';
import { Pou } from './model';
import { blockSig } from './sigs';

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

describe('curve codegen', () => {
  it('emits member-wise SEG writes inside a one-shot guard', () => {
    const p = defaultProfile();
    const code = profileCode(p);
    expect(code).toContain('IF CFG AND NOT loaded THEN');
    expect(code).toContain('PROF.NUM_SEG := 4;'); // end seg not counted
    expect(code).toContain('PROF.SEG[1].KIND := 3;');
    expect(code).toContain('PROF.SEG[1].TGT := 150.0;');
    expect(code).toContain('PROF.SEG[3].P1 := 0.5;');
    expect(code).toContain('PROF.PvStart := TRUE;');
    expect(code).toContain('DONE := loaded;');
  });

  it('emits a standalone FUNCTION_BLOCK with inout PROF', () => {
    const src = emitPou('FB_prof_cfg', defaultProfile());
    expect(src).toContain('FUNCTION_BLOCK FB_prof_cfg');
    expect(src).toContain('VAR_IN_OUT');
    expect(src).toContain('PROF : FB_AtcProfile;');
    expect(src).toContain('END_FUNCTION_BLOCK');
  });

  it('inserts fb + variable + st blocks wired through PROF', () => {
    const p = pou();
    applyToPou(p, defaultProfile());
    const net = p.networks[0]!;
    const fb = net.blocks.find((b) => b.kind === 'fb' && b.type_ref === 'FB_AtcProfile')!;
    const st = net.blocks.find((b) => b.kind === 'st')!;
    const vb = net.blocks.find((b) => b.kind === 'variable' && b.name === 'prof')!;
    // fb block precedes the variable block (precollect declares the
    // instance before the variable resolves it)
    expect(net.blocks.indexOf(fb)).toBeLessThan(net.blocks.indexOf(vb));
    expect(fb.instance).toBe('prof');
    expect(st.params.CODE).toContain('PROF.SEG[2].KIND := 1;');
    expect(st.params.CFG).toBe('TRUE');
    // inout pin appears on both sides of the st block signature
    const sig = blockSig(st, [p]);
    expect(sig.ins).toEqual(['CFG', 'PROF']);
    expect(sig.outs).toEqual(['PROF', 'DONE']);
    // variable → st.PROF wire
    const w = net.wires.find((w) => w.src.block === vb.id)!;
    expect(w.dsts).toEqual([{ block: st.id, port: 'PROF' }]);
    // controller fb placed with its own instance
    expect(net.blocks.some((b) => b.type_ref === 'FB_AtcPid' && b.instance === 'ctl')).toBe(true);
  });

  it('preview walks dwell/ramp/step/loop to an SP trajectory', () => {
    const p = defaultProfile();
    const pts = preview(p, 25);
    // rampt 60s→150, dwell +120s, ramp 0.5°/s: (150-80)/0.5=140s,
    // dwell +30s → total 350s
    expect(pts.at(-1)!.t).toBeCloseTo(350);
    expect(pts.at(-1)!.temp).toBe(80);
    expect(pts[1]!.t).toBe(60);
    expect(pts[1]!.temp).toBe(150);
  });

  it('wires run/pv/out interface vars when names are given', () => {
    const p = pou();
    const prof = { ...defaultProfile(), runVar: 'Run', pvVar: 'Pv', outVar: 'Q' };
    applyToPou(p, prof);
    const net = p.networks[0]!;
    // interface vars created with the right kinds
    expect(p.interface).toEqual([
      { name: 'Run', kind: 'var_input', type: 'BOOL' },
      { name: 'Pv', kind: 'var_input', type: 'LREAL' },
      { name: 'Q', kind: 'var_output', type: 'LREAL' },
    ]);
    const profId = net.blocks.find((b) => b.type_ref === 'FB_AtcProfile')!.id;
    const ctlId = net.blocks.find((b) => b.type_ref === 'FB_AtcPid')!.id;
    const dsts = net.wires.flatMap((w) => w.dsts.map((d) => `${d.block}:${d.port}`));
    // RUN + PV feed both blocks, SP feeds the controller, Out drives Q
    expect(dsts).toEqual(
      expect.arrayContaining([
        `${profId}:RUN`,
        `${ctlId}:Execute`,
        `${profId}:PV`,
        `${ctlId}:Actual`,
        `${ctlId}:Setpoint`,
      ]),
    );
    expect(net.wires.some((w) => w.src.block === ctlId && w.src.port === 'Out')).toBe(true);
    // no duplicate variable blocks when re-applied
    applyToPou(p, prof);
    const runBlocks = net.blocks.filter((b) => b.name === 'Run' && b.role === 'in');
    expect(runBlocks.length).toBe(1);
    expect(p.interface.length).toBe(3);
  });

  it('re-inserting updates the existing profile in place', () => {
    const p = pou();
    const prof = { ...defaultProfile(), runVar: 'Run', pvVar: 'Pv', outVar: 'Q' };
    applyToPou(p, prof);
    const net = p.networks[0]!;
    const blocks = net.blocks.length;
    const wires = net.wires.length;
    const cfg = net.blocks.find((b) => b.kind === 'st')!;
    // a changed table lands in the same block, wiring untouched
    applyToPou(p, {
      ...prof,
      cycleTime: 0.25,
      segs: [
        { kind: 'step', tgt: 42, p1: 0, p2: 0, ev: 0 },
        { kind: 'end', tgt: 0, p1: 0, p2: 0, ev: 0 },
      ],
    });
    expect(net.blocks.length).toBe(blocks);
    expect(net.wires.length).toBe(wires);
    expect(net.blocks.find((b) => b.kind === 'st')!.id).toBe(cfg.id);
    expect(net.blocks.find((b) => b.kind === 'st')!.params.CODE).toContain(
      'PROF.SEG[1].KIND := 4;',
    );
    expect(net.blocks.find((b) => b.type_ref === 'FB_AtcProfile')!.params.CycleTime).toBe('0.25');
    // no duplicate instance declarations
    expect(net.blocks.filter((b) => b.type_ref === 'FB_AtcProfile').length).toBe(1);
    expect(net.blocks.filter((b) => b.type_ref === 'FB_AtcPid').length).toBe(1);
  });

  it('round-trips a profile through the POU blocks', () => {
    const p = pou();
    const prof = {
      ...defaultProfile(),
      instance: 'oven',
      cycleTime: 0.5,
      controller: 'FB_AtcLqr',
      ctlInstance: 'lqr',
      runVar: 'Run',
      pvVar: 'Pv',
      holdVar: 'Hold',
      resetVar: 'Reset',
      outVar: 'Q',
      segs: [
        { kind: 'ramp' as const, tgt: 200, p1: 1.5, p2: 0, ev: 0 },
        { kind: 'dwell' as const, tgt: 200, p1: 90, p2: 3, ev: 7 },
        { kind: 'loop' as const, tgt: 1, p1: 2, p2: 0, ev: 0 },
        { kind: 'end' as const, tgt: 0, p1: 0, p2: 0, ev: 0 },
      ],
    };
    applyToPou(p, prof);
    const back = profileFromPou(p)!;
    expect(back.instance).toBe('oven');
    expect(back.cycleTime).toBe(0.5);
    expect(back.controller).toBe('FB_AtcLqr');
    expect(back.ctlInstance).toBe('lqr');
    expect(back.pvStart).toBe(true);
    expect(back.segs).toEqual(prof.segs);
    expect(back.runVar).toBe('Run');
    expect(back.pvVar).toBe('Pv');
    expect(back.holdVar).toBe('Hold');
    expect(back.resetVar).toBe('Reset');
    expect(back.outVar).toBe('Q');
  });

  it('wires busy/done status taps to BOOL outputs', () => {
    const p = pou();
    const prof = {
      ...defaultProfile(),
      runVar: 'Run',
      pvVar: 'Pv',
      busyVar: 'Running',
      doneVar: 'Finished',
    };
    applyToPou(p, prof);
    const net = p.networks[0]!;
    expect(p.interface).toEqual(
      expect.arrayContaining([
        { name: 'Running', kind: 'var_output', type: 'BOOL' },
        { name: 'Finished', kind: 'var_output', type: 'BOOL' },
      ]),
    );
    const profId = net.blocks.find((b) => b.type_ref === 'FB_AtcProfile')!.id;
    const dsts = net.wires.flatMap((w) =>
      w.src.block === profId ? w.dsts.map((d) => `${w.src.port}->${d.port}`) : [],
    );
    expect(dsts).toEqual(
      expect.arrayContaining(['Busy->0', 'Done->0', 'SP->Setpoint']),
    );
  });

  it('inserts a 1 Hz heater PWM stage on the controller output', () => {
    const p = pou();
    const prof = {
      ...defaultProfile(),
      runVar: 'Run',
      pvVar: 'Pv',
      busyVar: 'Running',
      doneVar: 'Finished',
      pwm: { instance: 'pwm', period: 1.0, minOn: 0.05, outVar: 'Heater' },
    };
    applyToPou(p, prof);
    const net = p.networks[0]!;
    const pwm = net.blocks.find((b) => b.type_ref === 'FB_AtcPwm')!;
    expect(pwm.instance).toBe('pwm');
    expect(pwm.params.Period).toBe('1.0');
    expect(pwm.params.MinOn).toBe('0.05');
    expect(p.interface).toEqual(
      expect.arrayContaining([{ name: 'Heater', kind: 'var_output', type: 'BOOL' }]),
    );
    const ctlId = net.blocks.find((b) => b.type_ref === 'FB_AtcPid')!.id;
    const profId = net.blocks.find((b) => b.type_ref === 'FB_AtcProfile')!.id;
    const runId = net.blocks.find((b) => b.name === 'Run' && b.role === 'in')!.id;
    // duty chain: ctl.Out -> pwm.Duty -> Q -> Heater var; Execute mirrors Run
    const has = (srcB: number, srcP: string, dstB: number, dstP: string) =>
      net.wires.some(
        (w) =>
          w.src.block === srcB &&
          w.src.port === srcP &&
          w.dsts.some((d) => d.block === dstB && d.port === dstP),
      );
    expect(has(ctlId, 'Out', pwm.id, 'Duty')).toBe(true);
    expect(has(runId, 0, pwm.id, 'Execute')).toBe(true);
    const heaterId = net.blocks.find((b) => b.name === 'Heater')!.id;
    expect(has(pwm.id, 'Q', heaterId, 0)).toBe(true);
    // status taps still wired
    expect(has(profId, 'Busy', net.blocks.find((b) => b.name === 'Running')!.id, 0)).toBe(true);
    expect(has(profId, 'Done', net.blocks.find((b) => b.name === 'Finished')!.id, 0)).toBe(true);
    // idempotent re-apply: no duplicate pwm block or wires
    const wires = net.wires.length;
    applyToPou(p, prof);
    expect(net.blocks.filter((b) => b.type_ref === 'FB_AtcPwm').length).toBe(1);
    expect(net.wires.length).toBe(wires);
  });

  it('round-trips busy/done/pwm through profileFromPou', () => {
    const p = pou();
    const prof = {
      ...defaultProfile(),
      runVar: 'Run',
      pvVar: 'Pv',
      busyVar: 'Running',
      doneVar: 'Finished',
      pwm: { instance: 'heaterPwm', period: 0.5, minOn: 0.02, outVar: 'Heater' },
    };
    applyToPou(p, prof);
    const back = profileFromPou(p)!;
    expect(back.busyVar).toBe('Running');
    expect(back.doneVar).toBe('Finished');
    expect(back.pwm).toEqual({
      instance: 'heaterPwm',
      period: 0.5,
      minOn: 0.02,
      outVar: 'Heater',
    });
    // duty feeds the PWM, so no LREAL outVar is recovered
    expect(back.outVar).toBeUndefined();
  });

  it('detects whether the profile library is present', () => {
    const lib = 'TYPE ST_AtcSeg : STRUCT\n    KIND : DINT;\nEND_STRUCT\nEND_TYPE\nFUNCTION_BLOCK FB_AtcProfile\nEND_FUNCTION_BLOCK\n';
    expect(hasProfileLibrary([lib])).toBe(true);
    expect(hasProfileLibrary([lib.toLowerCase()])).toBe(true);
    expect(hasProfileLibrary(['PROGRAM Main\nEND_PROGRAM\n'])).toBe(false);
    expect(hasProfileLibrary([])).toBe(false);
    // both halves are required (a stray mention is not a library)
    expect(hasProfileLibrary(['FUNCTION_BLOCK FB_AtcProfile\nEND_FUNCTION_BLOCK'])).toBe(false);
  });

  it('derives a file stem for an attached source', () => {
    expect(sourceStem('atc_tempctrl.st')).toBe('atc_tempctrl');
    expect(sourceStem('my lib.ST')).toBe('my_lib');
    expect(sourceStem('.st')).toBe('lib');
  });

  it('returns undefined for a POU without a profile', () => {
    expect(profileFromPou(pou())).toBeUndefined();
  });

  it('num always emits an LREAL literal', () => {
    expect(num(2)).toBe('2.0');
    expect(num(0.5)).toBe('0.5');
    expect(num(-3)).toBe('-3.0');
  });

  it('segCode maps kind names to ST_AtcSeg codes', () => {
    expect(segCode('end')).toBe(0);
    expect(segCode('dwell')).toBe(1);
    expect(segCode('ramp')).toBe(2);
    expect(segCode('rampt')).toBe(3);
    expect(segCode('step')).toBe(4);
    expect(segCode('loop')).toBe(5);
  });
});
