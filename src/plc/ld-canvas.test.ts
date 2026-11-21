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

function makeLdPou(blocks: Block[], wires: Network['wires'] = []): Pou {
  const net: Network = {
    id: 'n1', kind: 'ld', label: '', comments: [], assocs: [], labels: [],
    jumps: [], returns: [], blocks, wires,
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

/** private-method access helper — returns the method bound to the
    canvas so `this` works (canvas internals are unit-tested). */
function priv<T extends (...args: never[]) => unknown>(cv: LdCanvas, name: string): T {
  const fn = (cv as unknown as Record<string, unknown>)[name];
  return (fn as (...a: never[]) => unknown).bind(cv) as T;
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
    priv<(n: Network) => void>(cv, 'autoWireSeries')(net);
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
    priv<(n: Network) => void>(cv, 'autoWireSeries')(net);
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
    const c = priv<(n: Network, s: number, d: number) => void>(cv, 'addWire');
    const net = pou.networks[0]!;
    c(net, 1, 3);
    c(net, 2, 3);
    c(net, 1, 3); // duplicate dst ignored
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
    const net = pou.networks[0]!;
    const ab = net.wires.find((w) => w.src.block === 1 && w.dsts.some((d) => d.block === 2));
    expect(ab).toBeDefined();
    const aq = net.wires.find((w) => w.src.block === 1 && w.dsts.some((d) => d.block === 3));
    expect(aq).toBeDefined();
    cv.remove();
  });
});

describe('ld-canvas rung integration', () => {
  it('integrateRung freezes an unwired rung into series wires', async () => {
    const pou = makeLdPou([
      vblock(1, 'a', 0, 0, 'in'),
      vblock(2, 'b', 100, 0, 'in'),
      vblock(3, 'q', 200, 0, 'out'),
    ]);
    const cv = mount(pou);
    await cv.updateComplete;
    const net = pou.networks[0]!;
    priv<(n: Network, b: Block) => void>(cv, 'integrateRung')(net, net.blocks[2]!);
    // a→b, b→q
    expect(net.wires.map((w) => [w.src.block, w.dsts[0]!.block])).toEqual([[1, 2], [2, 3]]);
    cv.remove();
  });

  it('integrateRung splices a new contact between wired neighbours', async () => {
    const pou = makeLdPou(
      [
        vblock(1, 'a', 0, 0, 'in'),
        vblock(2, 'b', 200, 0, 'in'),
        vblock(3, 'q', 300, 0, 'out'),
      ],
      [{ id: 90, src: { block: 1, port: 0 }, dsts: [{ block: 2, port: 0 }] },
       { id: 91, src: { block: 2, port: 0 }, dsts: [{ block: 3, port: 0 }] }],
    );
    const cv = mount(pou);
    await cv.updateComplete;
    const net = pou.networks[0]!;
    const mid = vblock(4, 'm', 100, 0, 'in');
    net.blocks.push(mid);
    priv<(n: Network, b: Block) => void>(cv, 'integrateRung')(net, mid);
    // chain must be a→m→b→q: m steals b's feed, feeds b; b no longer fed by a
    const feedOf = (id: number) =>
      net.wires.filter((w) => w.dsts.some((d) => d.block === id)).map((w) => w.src.block);
    expect(feedOf(4)).toEqual([1]);
    expect(feedOf(2)).toEqual([4]);
    expect(feedOf(3)).toEqual([2]);
    cv.remove();
  });

  it('integrateRung re-feeds coils when a new last contact is inserted', async () => {
    const pou = makeLdPou(
      [
        vblock(1, 'a', 0, 0, 'in'),
        vblock(2, 'q', 200, 0, 'out'),
      ],
      [{ id: 90, src: { block: 1, port: 0 }, dsts: [{ block: 2, port: 0 }] }],
    );
    const cv = mount(pou);
    await cv.updateComplete;
    const net = pou.networks[0]!;
    const last = vblock(3, 'z', 100, 0, 'in');
    net.blocks.push(last);
    priv<(n: Network, b: Block) => void>(cv, 'integrateRung')(net, last);
    // a→z→q: coil re-fed from new last contact
    const feedOf = (id: number) =>
      net.wires.filter((w) => w.dsts.some((d) => d.block === id)).map((w) => w.src.block);
    expect(feedOf(3)).toEqual([1]);
    expect(feedOf(2)).toEqual([3]);
    cv.remove();
  });
});

describe('ld-canvas editing parity', () => {
  it('undo/redo restores network snapshots', async () => {
    const pou = makeLdPou([vblock(1, 'a', 0, 0, 'in')]);
    const cv = mount(pou);
    await cv.updateComplete;
    const c = cv as unknown as {
      mutate(fn: (n: Network) => void): void;
      undo(): void; redo(): void;
    };
    c.mutate((n) => n.blocks.push(vblock(2, 'b', 100, 0, 'in')));
    expect(pou.networks[0]!.blocks).toHaveLength(2);
    c.undo();
    expect(pou.networks[0]!.blocks).toHaveLength(1);
    c.redo();
    expect(pou.networks[0]!.blocks).toHaveLength(2);
    cv.remove();
  });

  it('copy/paste duplicates blocks with fresh ids and remaps wires', async () => {
    const pou = makeLdPou(
      [
        vblock(1, 'a', 0, 0, 'in'),
        vblock(2, 'b', 100, 0, 'in'),
      ],
      [{ id: 90, src: { block: 1, port: 0 }, dsts: [{ block: 2, port: 0 }] }],
    );
    const cv = mount(pou);
    await cv.updateComplete;
    const c = cv as unknown as {
      selIds: Set<number>;
      copySel(): void; paste(): void;
    };
    c.selIds = new Set([1, 2]);
    c.copySel();
    c.paste();
    const net = pou.networks[0]!;
    expect(net.blocks).toHaveLength(4);
    // pasted pair keeps its internal wire (a'→b')
    const pasted = net.blocks.slice(2);
    const pw = net.wires.find((w) =>
      w.src.block === pasted[0]!.id && w.dsts.some((d) => d.block === pasted[1]!.id));
    expect(pw).toBeDefined();
    // ids are fresh
    expect(new Set(net.blocks.map((b) => b.id)).size).toBe(4);
    cv.remove();
  });

  it('clipboard survives a network switch (cross-network paste)', async () => {
    const pou = makeLdPou([vblock(1, 'a', 0, 0, 'in')]);
    const net2: Network = {
      id: 'n2', kind: 'ld', label: '', comments: [], assocs: [], labels: [],
      jumps: [], returns: [], blocks: [], wires: [],
    };
    pou.networks.push(net2);
    const cv = mount(pou);
    await cv.updateComplete;
    const c = cv as unknown as {
      selIds: Set<number>; netIndex: number;
      copySel(): void; paste(): void;
    };
    c.selIds = new Set([1]);
    c.copySel();
    c.netIndex = 1;
    c.paste();
    expect(pou.networks[1]!.blocks).toHaveLength(1);
    cv.remove();
  });

  it('deleteSel removes multi-selected blocks and touching wires', async () => {
    const pou = makeLdPou(
      [
        vblock(1, 'a', 0, 0, 'in'),
        vblock(2, 'b', 100, 0, 'in'),
        vblock(3, 'q', 200, 0, 'out'),
      ],
      [{ id: 90, src: { block: 1, port: 0 }, dsts: [{ block: 2, port: 0 }, { block: 3, port: 0 }] }],
    );
    const cv = mount(pou);
    await cv.updateComplete;
    const c = cv as unknown as { selIds: Set<number>; deleteSel(): void };
    c.selIds = new Set([1, 2]);
    c.deleteSel();
    const net = pou.networks[0]!;
    expect(net.blocks.map((b) => b.id)).toEqual([3]);
    // wire src removed → wire gone entirely
    expect(net.wires).toHaveLength(0);
    cv.remove();
  });

  it('moveWireDst reconnects a wire end to a new block', async () => {
    const pou = makeLdPou(
      [
        vblock(1, 'a', 0, 0, 'in'),
        vblock(2, 'b', 100, 0, 'in'),
        vblock(3, 'q', 200, 0, 'out'),
      ],
      [{ id: 90, src: { block: 1, port: 0 }, dsts: [{ block: 2, port: 0 }] }],
    );
    const cv = mount(pou);
    await cv.updateComplete;
    const net = pou.networks[0]!;
    priv<(n: Network, id: number, di: number, dst: number) => void>(
      cv, 'moveWireDst')(net, 90, 0, 3);
    const w = net.wires.find((x) => x.src.block === 1);
    expect(w?.dsts.map((d) => d.block)).toEqual([3]);
    cv.remove();
  });

  it('moveWireSrc re-sources a wire, merging into an existing same-src wire', async () => {
    const pou = makeLdPou(
      [
        vblock(1, 'a', 0, 0, 'in'),
        vblock(2, 'b', 100, 0, 'in'),
        vblock(3, 'q', 200, 0, 'out'),
      ],
      [
        { id: 90, src: { block: 1, port: 0 }, dsts: [{ block: 3, port: 0 }] },
        { id: 91, src: { block: 2, port: 0 }, dsts: [{ block: 3, port: 0 }] },
      ],
    );
    const cv = mount(pou);
    await cv.updateComplete;
    const net = pou.networks[0]!;
    priv<(n: Network, id: number, src: number) => void>(cv, 'moveWireSrc')(net, 91, 1);
    // wire 91 merged into wire 90's dsts (dedup by block)
    expect(net.wires).toHaveLength(1);
    expect(net.wires[0]!.src.block).toBe(1);
    expect(net.wires[0]!.dsts.map((d) => d.block)).toEqual([3]);
    cv.remove();
  });

  it('undo stacks reset when the network switches', async () => {
    const pou = makeLdPou([vblock(1, 'a', 0, 0, 'in')]);
    pou.networks.push({
      id: 'n2', kind: 'ld', label: '', comments: [], assocs: [], labels: [],
      jumps: [], returns: [], blocks: [], wires: [],
    });
    const cv = mount(pou);
    await cv.updateComplete;
    const c = cv as unknown as {
      mutate(fn: (n: Network) => void): void;
      undo(): void; netIndex: number;
      undoStack: string[];
    };
    c.mutate((n) => n.blocks.push(vblock(2, 'b', 100, 0, 'in')));
    expect(c.undoStack.length).toBe(1);
    c.netIndex = 1;
    // touching the new net resets stacks — undo on net2 is a no-op
    c.undo();
    expect(pou.networks[0]!.blocks).toHaveLength(2);
    cv.remove();
  });
});
