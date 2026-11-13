import { describe, expect, it } from 'vitest';
import './ld-canvas';
import type { LdCanvas } from './ld-canvas';
import { Block, Network, Pou } from './model';

function vblock(id: number, name: string, x: number, y: number, role: 'in' | 'out', negated = false): Block {
  return {
    id, kind: 'variable', type_ref: '', pos: { x, y }, params: {},
    exec_order: 0, negated: negated ? [0] : [], comment: '', role, name,
  };
}

function makeLdPou(blocks: Block[]): Pou {
  const net: Network = {
    id: 'n1', kind: 'ld', label: '', comments: [], assocs: [], labels: [],
    jumps: [], returns: [], blocks, wires: [],
  };
  return { id: 'P1', name: 'P1', kind: 'program', en_eno: 'inherit', interface: [], networks: [net] };
}

function mount(pou: Pou): LdCanvas {
  const cv = document.createElement('ld-canvas') as LdCanvas;
  cv.pou = pou;
  cv.pous = [pou];
  cv.netIndex = 0;
  document.body.appendChild(cv);
  return cv;
}

describe('ld-canvas wire tool', () => {
  it('autoWireSeries chains contacts left→right and feeds coils', async () => {
    const pou = makeLdPou([
      vblock(1, 'a', 0, 0, 'in'),
      vblock(2, 'b', 100, 0, 'in', true),
      vblock(3, 'q1', 200, 0, 'out'),
      vblock(4, 'q2', 260, 0, 'out'),
    ]);
    const cv = mount(pou);
    await cv.updateComplete;
    const net = pou.networks[0]!;
    (cv as unknown as { autoWireSeries(n: Network): void }).autoWireSeries(net);
    // a→b, b→q1, b→q2 (fan-out into one wire's dsts)
    expect(net.wires).toHaveLength(2);
    expect(net.wires[0]).toMatchObject({ src: { block: 1 }, dsts: [{ block: 2 }] });
    expect(net.wires[1]).toMatchObject({ src: { block: 2 } });
    expect(net.wires[1]!.dsts.map((d) => d.block).sort()).toEqual([3, 4]);
    cv.remove();
  });

  it('keeps separate rung rows as separate series chains', async () => {
    const pou = makeLdPou([
      vblock(1, 'a', 0, 0, 'in'),
      vblock(2, 'q1', 100, 0, 'out'),
      vblock(3, 'b', 0, 56, 'in'),
      vblock(4, 'q2', 100, 56, 'out'),
    ]);
    const cv = mount(pou);
    await cv.updateComplete;
    const net = pou.networks[0]!;
    (cv as unknown as { autoWireSeries(n: Network): void }).autoWireSeries(net);
    // each row: last contact → its coil; two wires total
    expect(net.wires).toHaveLength(2);
    expect(net.wires.map((w) => w.src.block).sort()).toEqual([1, 3]);
    cv.remove();
  });

  it('addWire merges destinations into an existing same-src wire', async () => {
    const pou = makeLdPou([
      vblock(1, 'a', 0, 0, 'in'),
      vblock(2, 'b', 0, 56, 'in'),
      vblock(3, 'q', 100, 0, 'out'),
    ]);
    const cv = mount(pou);
    await cv.updateComplete;
    const c = cv as unknown as { addWire(s: number, d: number): void };
    c.addWire(1, 3);
    c.addWire(2, 3);
    c.addWire(1, 3); // duplicate dst ignored
    const net = pou.networks[0]!;
    expect(net.wires).toHaveLength(2);
    expect(net.wires[0]!.dsts).toHaveLength(1);
    expect(net.wires[1]).toMatchObject({ src: { block: 2 }, dsts: [{ block: 3 }] });
    cv.remove();
  });

  it('wire tool arms a contact source and links destinations', async () => {
    const pou = makeLdPou([
      vblock(1, 'a', 0, 0, 'in'),
      vblock(2, 'b', 0, 56, 'in'),
      vblock(3, 'q', 100, 0, 'out'),
    ]);
    const cv = mount(pou);
    await cv.updateComplete;
    const c = cv as unknown as {
      tool: string; wireSrc: number;
      onWireClick(x: number, y: number): void;
    };
    c.tool = 'wire';
    // svg coords: block at pos(0,0) → x in [24,24+84], y in [0,44]
    c.onWireClick(30, 10);          // arm contact a
    expect(c.wireSrc).toBe(1);
    c.onWireClick(30, 70);          // dst contact b (row 2)
    // first wire triggers autoWireSeries: row1 a→? (a is only contact, q is coil → a→q),
    // row2 b alone (no dst). Then user wire a→b added.
    const net = pou.networks[0]!;
    const ab = net.wires.find((w) => w.src.block === 1 && w.dsts.some((d) => d.block === 2));
    expect(ab).toBeDefined();
    // auto wires: a→q (row1), nothing for row2's lone contact
    const aq = net.wires.find((w) => w.src.block === 1 && w.dsts.some((d) => d.block === 3));
    expect(aq).toBeDefined();
    cv.remove();
  });
});
