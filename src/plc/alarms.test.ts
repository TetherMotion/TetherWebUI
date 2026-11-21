import { describe, expect, it } from 'vitest';
import { buildAlarmPou, defaultRule, ruleStem, ALARM_OPS, type AlarmRule } from './alarms';
import { emptyProject } from './model';

const rules: AlarmRule[] = [
  { id: 1, name: 'Overtemp', signal: '%IX0.4', op: '>', threshold: '85.0', priority: 3, message: 'oven too hot' },
  { id: 2, name: 'LowFlow', signal: 'flow_ok', op: '=', threshold: 'FALSE', priority: 1 },
];

describe('alarm rules', () => {
  it('ruleStem sanitizes identifiers', () => {
    expect(ruleStem('Over-Temp!', 7)).toBe('Over_Temp');
    expect(ruleStem('9lives', 3)).toBe('a_9lives');
    expect(ruleStem('', 5)).toBe('alarm5');
  });

  it('buildAlarmPou emits a valid program POU with compare+alarm per rule', () => {
    const pou = buildAlarmPou(rules);
    expect(pou.name).toBe('AlarmRules');
    expect(pou.kind).toBe('program');
    const proj = emptyProject('t'); proj.pous.push(pou);
    expect(proj.pous).toHaveLength(1);
    const net = pou.networks[0]!;
    const types = net.blocks.map((b) => `${b.kind}:${b.type_ref}`);
    expect(types.filter((t) => t === 'fb:FB_AtcAlarm')).toHaveLength(2);
    expect(types.filter((t) => t === 'operator:GT')).toHaveLength(1);
    expect(types.filter((t) => t === 'operator:EQ')).toHaveLength(1);
    // interface exposes ACT/UNACK per rule + ACK/SHELVE inputs
    const names = pou.interface.map((v) => v.name);
    expect(names).toContain('ACK');
    expect(names).toContain('Overtemp_ACT');
    expect(names).toContain('LowFlow_UNACK');
    // wires: signal→IN0, op→Cond, Active→out var
    const condWires = net.wires.filter((w) => w.dsts.some((d) => d.port === 'Cond'));
    expect(condWires).toHaveLength(2);
    const actWires = net.wires.filter((w) => w.src.port === 'Active');
    expect(actWires.length).toBeGreaterThanOrEqual(2);
    // AT signal lands on `at`, var signal on `name`
    const sigs = net.blocks.filter((b) => b.role === 'in' && (b.name ?? '').startsWith('sig'));
    expect(sigs[0]!.at).toBe('%IX0.4');
    const varSig = net.blocks.find((b) => (b.name ?? '') === 'flow_ok');
    expect(varSig).toBeTruthy();
  });

  it('higher-priority rules feed HigherPriActive through an OR', () => {
    const pou = buildAlarmPou(rules);
    const net = pou.networks[0]!;
    // LowFlow (pri 1) is below Overtemp (pri 3): it gets an OR + wire
    const hpa = net.wires.filter((w) => w.dsts.some((d) => d.port === 'HigherPriActive'));
    expect(hpa).toHaveLength(1);
    expect(hpa[0]!.src.block).toBeGreaterThan(0);
    const orBlock = net.blocks.find((b) => b.id === hpa[0]!.src.block);
    expect(orBlock!.type_ref).toBe('OR');
  });

  it('defaultRule + empty list still builds a runnable POU', () => {
    const pou = buildAlarmPou([defaultRule(9)]);
    expect(pou.networks[0]!.blocks.length).toBeGreaterThan(3);
    expect(buildAlarmPou([]).networks[0]!.blocks).toHaveLength(3);
    expect(ALARM_OPS).toHaveLength(6);
  });
});
