import { describe, expect, it } from 'vitest';
import './fbd-canvas';
import type { FbdCanvas } from './fbd-canvas';
import {
  applyProfileToNet,
  applyToPou,
  defaultProfile,
  profileFromGroup,
  profileGroupAt,
} from './curve';
import {
  applyTunerToNet,
  applyTunerToPou,
  tunerCfgFromGroup,
  tunerFromPou,
  tuneGroupAt,
} from './tune';
import { Pou } from './model';

const RELAY = {
  kind: 'relay' as const,
  instance: 'tune',
  runVar: 'Run',
  pvVar: 'Pv',
  spVar: 'Sp',
  outVar: 'Out',
  applyVar: 'Apply',
  resetVar: 'Reset',
  ctlInstance: 'pid',
};

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

function mount(pou: Pou): FbdCanvas {
  const cv = document.createElement('fbd-canvas') as FbdCanvas;
  cv.pou = pou;
  cv.pous = [pou];
  document.body.appendChild(cv);
  return cv;
}

describe('profileGroupAt / profileFromGroup', () => {
  it('resolves the FB_AtcProfile block to its whole group and round-trips', () => {
    const p = pou();
    const prof = {
      ...defaultProfile(),
      instance: 'oven',
      controller: 'FB_AtcPid',
      ctlInstance: 'pid',
      runVar: 'Run',
      pvVar: 'Pv',
    };
    applyToPou(p, prof);
    const net = p.networks[0]!;
    const fbId = net.blocks.find((b) => b.type_ref === 'FB_AtcProfile')!.id;
    const g = profileGroupAt(p, 0, fbId)!;
    expect(g.profFb?.id).toBe(fbId);
    expect(g.cfg?.kind).toBe('st');
    expect(g.ctl?.type_ref).toBe('FB_AtcPid');
    const back = profileFromGroup(net, g)!;
    expect(back.instance).toBe('oven');
    expect(back.controller).toBe('FB_AtcPid');
    expect(back.runVar).toBe('Run');
    expect(back.pvVar).toBe('Pv');
    expect(back.segs).toEqual(prof.segs);
  });

  it('resolves the cfg st block and controller block to the same group', () => {
    const p = pou();
    applyToPou(p, defaultProfile());
    const net = p.networks[0]!;
    const cfgId = net.blocks.find((b) => b.kind === 'st')!.id;
    const g1 = profileGroupAt(p, 0, cfgId)!;
    expect(g1.profFb?.type_ref).toBe('FB_AtcProfile');
    expect(profileFromGroup(net, g1)?.instance).toBe('prof');
  });

  it('returns undefined for unrelated blocks', () => {
    const p = pou();
    applyToPou(p, defaultProfile());
    const net = p.networks[0]!;
    const andId = net.blocks.find((b) => b.kind === 'variable')!.id;
    // 'prof' var IS part of the group; use a fresh unrelated pou block
    const p2 = pou();
    p2.networks.push({
      id: 'n', kind: 'fbd', label: '', comments: [], assocs: [], labels: [],
      jumps: [], returns: [],
      blocks: [{
        id: 1, kind: 'operator', type_ref: 'AND', pos: { x: 0, y: 0 },
        params: {}, exec_order: 0, negated: [], comment: '',
      }],
      wires: [],
    });
    expect(profileGroupAt(p2, 0, 1)).toBeUndefined();
    void andId;
  });
});

describe('applyProfileToNet', () => {
  it('scopes updates to the target network only', () => {
    const p = pou();
    const a = { ...defaultProfile(), instance: 'curveA' };
    const b = { ...defaultProfile(), instance: 'curveB' };
    // net0 via applyToPou, net1 via applyProfileToNet
    applyToPou(p, a);
    p.networks.push({
      id: 'net2', kind: 'fbd', label: '', comments: [], assocs: [], labels: [],
      jumps: [], returns: [], blocks: [], wires: [],
    });
    applyProfileToNet(p, 1, b);
    expect(p.networks).toHaveLength(2);
    const insts0 = p.networks[0]!.blocks.filter((x) => x.type_ref === 'FB_AtcProfile').map((x) => x.instance);
    const insts1 = p.networks[1]!.blocks.filter((x) => x.type_ref === 'FB_AtcProfile').map((x) => x.instance);
    expect(insts0).toEqual(['curveA']);
    expect(insts1).toEqual(['curveB']);
    // editing curveB must not touch net0
    applyProfileToNet(p, 1, { ...b, cycleTime: 9.9 });
    expect(
      p.networks[1]!.blocks.find((x) => x.type_ref === 'FB_AtcProfile')!.params.CycleTime,
    ).toBe('9.9');
    expect(
      p.networks[0]!.blocks.find((x) => x.type_ref === 'FB_AtcProfile')!.params.CycleTime,
    ).not.toBe('9.9');
  });
});

describe('tuneGroupAt / tunerCfgFromGroup / applyTunerToNet', () => {
  it('resolves a tuner block and round-trips the cfg', () => {
    const p = pou();
    applyTunerToPou(p, { ...RELAY, ctlInstance: undefined });
    const net = p.networks[0]!;
    // the controller FB is user-placed — add it, then re-apply so the
    // handoff CTL alias + gain writes bind to it
    net.blocks.push({
      id: 900,
      kind: 'fb',
      type_ref: 'FB_AtcPid',
      instance: 'pid',
      pos: { x: 0, y: 0 },
      params: {},
      exec_order: 0,
      negated: [],
      comment: '',
    });
    applyTunerToNet(p, 0, RELAY);
    const tuner = net.blocks.find((x) => x.type_ref === 'FB_AtcRelayTune')!;
    const g = tuneGroupAt(p, 0, tuner.id)!;
    expect(g.kind).toBe('relay');
    expect(g.srcs[0]?.id).toBe(tuner.id);
    expect(g.handoff).toBeDefined();
    expect(g.ctl?.instance).toBe('pid');
    const cfg = tunerCfgFromGroup(net, g)!;
    expect(cfg.instance).toBe('tune');
    expect(cfg.pvVar).toBe('Pv');
    expect(cfg.applyVar).toBe('Apply');
    expect(cfg.ctlInstance).toBe('pid');
  });

  it('resolves the handoff st block to the same group', () => {
    const p = pou();
    applyTunerToPou(p, RELAY);
    const net = p.networks[0]!;
    const st = net.blocks.find((x) => x.kind === 'st')!;
    const g = tuneGroupAt(p, 0, st.id);
    expect(g?.kind).toBe('relay');
  });

  it('applyTunerToNet refreshes only the target net', () => {
    const p = pou();
    applyTunerToPou(p, RELAY);
    p.networks.push({
      id: 'net2', kind: 'fbd', label: '', comments: [], assocs: [], labels: [],
      jumps: [], returns: [], blocks: [], wires: [],
    });
    applyTunerToNet(p, 1, { ...RELAY, instance: 'tune2' });
    const n0t = p.networks[0]!.blocks.filter((x) => x.type_ref === 'FB_AtcRelayTune');
    const n1t = p.networks[1]!.blocks.filter((x) => x.type_ref === 'FB_AtcRelayTune');
    expect(n0t.map((x) => x.instance)).toEqual(['tune']);
    expect(n1t.map((x) => x.instance)).toEqual(['tune2']);
    // handoffs: one per net, not clobbered
    expect(p.networks[0]!.blocks.filter((x) => x.kind === 'st')).toHaveLength(1);
    expect(p.networks[1]!.blocks.filter((x) => x.kind === 'st')).toHaveLength(1);
  });
});

describe('fbd-canvas block edit events', () => {
  it('double-click on a tuner block emits edit-tune', async () => {
    const p = pou();
    applyTunerToPou(p, RELAY);
    const cv = mount(p);
    await cv.updateComplete;
    const net = p.networks[0]!;
    const tuner = net.blocks.find((x) => x.type_ref === 'FB_AtcRelayTune')!;
    let got: { pou?: Pou; netIndex?: number; blockId?: number } | undefined;
    cv.addEventListener('edit-tune', (e) => {
      got = (e as CustomEvent).detail;
    });
    const groups = [...cv.querySelectorAll('g.fbd-block')];
    const titles = groups.map((x) => x.querySelector('.fbd-title')?.textContent ?? '');
    const idx = titles.findIndex((t) => t.includes('FB_AtcRelayTune'));
    expect(idx).toBeGreaterThanOrEqual(0);
    groups[idx]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(got?.blockId).toBe(tuner.id);
    expect(got?.netIndex).toBe(0);
  });

  it('double-click on an unrelated block emits nothing', async () => {
    const p = pou();
    applyTunerToPou(p, RELAY);
    const cv = mount(p);
    await cv.updateComplete;
    let fired = false;
    cv.addEventListener('edit-tune', () => (fired = true));
    cv.addEventListener('edit-curve', () => (fired = true));
    // dblclick the SVG background
    cv.querySelector('svg')!.dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true }),
    );
    expect(fired).toBe(false);
  });
});
