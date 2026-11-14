import { describe, expect, it } from 'vitest';
import { generateDeployMap, validateDeployMapText } from './deploymap';
import type { FbdProject, Pou } from './model';

const dev = (id: number, type_ref: string, pins: object[], endpoint?: string) => ({
  id, kind: 'device', type_ref, pos: { x: 0, y: 0 },
  params: {}, exec_order: 0, negated: [], comment: '', endpoint, pins,
});
const di = (n: string, i: number) => ({ name: n, kind: 'var_output', type: 'BOOL', at: `%IX${i >> 3}.${i & 7}` });
const do_ = (n: string, i: number) => ({ name: n, kind: 'var_input', type: 'BOOL', at: `%QX${i >> 3}.${i & 7}` });
const ai = (n: string, i: number) => ({ name: n, kind: 'var_output', type: 'INT', at: `%ID${16 + i * 2}.0` });

/** The canonical user story: 3× EL1014 inputs (start on ch0), one
    EL3104 analog PV, one EL2004 with heater-PWM + done + running. */
function storyProject(): FbdProject {
  const blocks = [
    dev(1, 'EL1014', [di('DI0', 0), di('DI1', 1), di('DI2', 2), di('DI3', 3)], 'el1014.c1'),
    dev(2, 'EL1014', [di('DI0', 8), di('DI1', 9), di('DI2', 10), di('DI3', 11)], 'el1014.c1.2'),
    dev(3, 'EL1014', [di('DI0', 16), di('DI1', 17), di('DI2', 18), di('DI3', 19)], 'el1014.c1.3'),
    dev(4, 'EL3104', [ai('AI0', 0), ai('AI1', 1), ai('AI2', 2), ai('AI3', 3)], 'el3104.c1'),
    dev(5, 'EL2004', [do_('DO0', 0), do_('DO1', 1), do_('DO2', 2), do_('DO3', 3)], 'el2004.c1'),
  ];
  const pou: Pou = {
    id: 'pou:Main', name: 'Main', kind: 'program', en_eno: 'EN', interface: [],
    networks: [{ id: 'n1', kind: 'fbd', label: '', comments: [], assocs: [], labels: [],
      jumps: [], returns: [], blocks: blocks as never, wires: [] }],
  };
  return {
    schema: 'fbd.v1', project: 'story', data_types: [], global_vars: [], pous: [pou], tasks: [],
  };
}

describe('user story: EL1014×3 + EL3104 + EL2004', () => {
  it('generates a clean pdo map validated by the bridge rules', async () => {
    const r = await generateDeployMap({ fbd: storyProject() });
    expect(r.warnings).toHaveLength(0);
    /* 4 in-channels (3×EL1014 + EL3104) + 1 out (EL2004) */
    expect(r.map.channels).toHaveLength(5);
    expect(r.map.channels.filter((c) => c.dir === 'in')).toHaveLength(4);
    expect(r.map.channels.filter((c) => c.dir === 'out')).toHaveLength(1);
    /* every device pin binds to its PDO endpoint key */
    for (const at of ['%IX0.0', '%IX1.0', '%IX2.0'])
      expect(r.map.bindings.find((b) => b.at === at)?.key).toMatch(/^el1014\.c1.*\.tx$/);
    expect(r.map.bindings.find((b) => b.at === '%ID16.0')?.key).toBe('el3104.c1.tx');
    expect(r.map.bindings.find((b) => b.at === '%QX0.0')?.key).toBe('el2004.c1.rx');
    /* client-side validation clean */
    expect(validateDeployMapText(r.text)).toHaveLength(0);
    /* epoch hash present and stable */
    expect(r.map.hash).toMatch(/^[0-9a-f]{64}$/);
    const r2 = await generateDeployMap({ fbd: storyProject() });
    expect(r2.map.hash).toBe(r.map.hash);
  });

  it('warns when AT addresses collide across devices', async () => {
    const p = storyProject();
    /* move EL3104 onto the EL1014 bytes — %I channel overlap */
    for (const net of p.pous[0]!.networks)
      for (const b of net.blocks)
        if (b.type_ref === 'EL3104')
          b.pins = (b.pins ?? []).map((pin, i) => ({ ...pin, at: `%ID${i * 2}.0` }));
    const r = await generateDeployMap({ fbd: p });
    expect(r.warnings.some((w) => w.includes('overlap'))).toBe(true);
    expect(validateDeployMapText(r.text).some((v) => v.rule === 'MAP_OWNER')).toBe(true);
  });
});
