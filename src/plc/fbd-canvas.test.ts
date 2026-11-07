import { describe, expect, it } from 'vitest';
import './fbd-canvas';
import type { FbdCanvas } from './fbd-canvas';
import { Pou } from './model';

function makePou(): Pou {
  return {
    id: 'P1',
    name: 'P1',
    kind: 'program',
    en_eno: 'inherit',
    interface: [],
    networks: [
      {
        id: 'net1',
        kind: 'fbd',
        label: '',
        comments: [],
        assocs: [],
        labels: [],
        jumps: [],
        returns: [],
        blocks: [
          {
            id: 1,
            kind: 'variable',
            type_ref: '',
            pos: { x: 1, y: 2 },
            params: {},
            exec_order: 0,
            negated: [],
            comment: '',
            role: 'in',
            name: 'start',
            at: '%IX0.0',
          },
          {
            id: 2,
            kind: 'operator',
            type_ref: 'AND',
            pos: { x: 8, y: 2 },
            params: {},
            exec_order: 0,
            negated: [],
            comment: '',
          },
        ],
        wires: [],
      },
    ],
  };
}

function mount(): { cv: FbdCanvas; pou: Pou } {
  const pou = makePou();
  const cv = document.createElement('fbd-canvas') as FbdCanvas;
  cv.pou = pou;
  cv.pous = [pou];
  document.body.appendChild(cv);
  return { cv, pou };
}

describe('fbd-canvas', () => {
  it('renders blocks with pins and reports unconnected inputs', async () => {
    const { cv } = mount();
    await cv.updateComplete;
    expect(cv.querySelectorAll('.fbd-block').length).toBe(2);
    expect(cv.querySelectorAll('.fbd-pin.in').length).toBe(3); // 2 required + 1 spare
    expect(cv.validate().some((d) => d.includes('unconnected'))).toBe(true);
    cv.remove();
  });

  it('adds a block from the palette', async () => {
    const { cv, pou } = mount();
    await cv.updateComplete;
    const btn = [...cv.querySelectorAll<HTMLButtonElement>('.fbd-palette .chip-btn')].find(
      (b) => b.textContent === 'TON',
    )!;
    btn.click();
    await cv.updateComplete;
    expect(pou.networks[0]!.blocks.length).toBe(3);
    expect(pou.networks[0]!.blocks[2]!.type_ref).toBe('TON');
    cv.remove();
  });

  it('wires an out pin to an in pin via pointer events', async () => {
    const { cv, pou } = mount();
    await cv.updateComplete;
    const blocks = cv.querySelectorAll('.fbd-block');
    const outPin = blocks[0]!.querySelector('.fbd-pin.out')!;
    const inPin = blocks[1]!.querySelectorAll('.fbd-pin.in')[0]!;
    outPin.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }),
    );
    inPin.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 20, clientY: 20 }));
    await cv.updateComplete;
    const wires = pou.networks[0]!.wires;
    expect(wires.length).toBe(1);
    expect(wires[0]!.src.block).toBe(1);
    expect(wires[0]!.dsts[0]).toEqual({ block: 2, port: 0 });
    cv.remove();
  });

  it('deletes the selected block and its wires', async () => {
    const { cv, pou } = mount();
    await cv.updateComplete;
    const net = pou.networks[0]!;
    net.wires.push({ id: 9, src: { block: 1, port: 0 }, dsts: [{ block: 2, port: 0 }] });
    cv.requestUpdate();
    await cv.updateComplete;
    const blk = cv.querySelectorAll('.fbd-block')[1]!;
    blk.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5 }));
    await cv.updateComplete;
    cv.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await cv.updateComplete;
    expect(net.blocks.length).toBe(1);
    expect(net.wires.length).toBe(0);
    cv.remove();
  });

  it('undo restores the pre-mutation network', async () => {
    const { cv, pou } = mount();
    await cv.updateComplete;
    const before = pou.networks[0]!.blocks.length;
    const btn = [...cv.querySelectorAll<HTMLButtonElement>('.fbd-palette .chip-btn')].find(
      (b) => b.textContent === 'TON',
    )!;
    btn.click();
    await cv.updateComplete;
    expect(pou.networks[0]!.blocks.length).toBe(before + 1);
    cv.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await cv.updateComplete;
    expect(pou.networks[0]!.blocks.length).toBe(before);
    cv.remove();
  });

  it('marquee box-selects blocks; shift-click toggles membership', async () => {
    const { cv } = mount();
    await cv.updateComplete;
    const svg = cv.querySelector('svg')!;
    // drag a band over both blocks (vb offset -20,-20, scale 1)
    svg.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0, button: 0 }),
    );
    svg.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 300, clientY: 200 }));
    svg.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 300, clientY: 200 }));
    await cv.updateComplete;
    expect(cv.selIds.size).toBe(2);
    // shift-click block 1 removes it from the selection
    cv.querySelectorAll('.fbd-block')[0]!.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5, shiftKey: true }),
    );
    await cv.updateComplete;
    expect(cv.selIds.size).toBe(1);
    expect(cv.selIds.has(2)).toBe(true);
    cv.remove();
  });

  it('group drag moves every selected block by the same delta', async () => {
    const { cv, pou } = mount();
    await cv.updateComplete;
    cv.selIds = new Set([1, 2]);
    const blk2 = cv.querySelectorAll('.fbd-block')[1]!;
    blk2.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 }));
    cv.querySelector('svg')!.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 50, clientY: 50 }),
    );
    cv.querySelector('svg')!.dispatchEvent(
      new MouseEvent('pointerup', { bubbles: true, clientX: 50, clientY: 50 }),
    );
    await cv.updateComplete;
    const [b1, b2] = pou.networks[0]!.blocks;
    expect(b1!.pos).toEqual({ x: 5, y: 6 });
    expect(b2!.pos).toEqual({ x: 12, y: 6 });
    cv.remove();
  });

  it('ctrl-c/ctrl-v pastes a remapped copy incl. internal wires', async () => {
    const { cv, pou } = mount();
    await cv.updateComplete;
    const net = pou.networks[0]!;
    net.wires.push({ id: 9, src: { block: 1, port: 0 }, dsts: [{ block: 2, port: 0 }] });
    cv.selIds = new Set([1, 2]);
    cv.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }));
    cv.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true }));
    await cv.updateComplete;
    expect(net.blocks.length).toBe(4);
    const [nb1, nb2] = net.blocks.slice(2);
    expect(nb1!.id).toBeGreaterThan(2);
    expect(nb1!.pos).toEqual({ x: 2, y: 3 });
    // internal wire remapped to the copies, not the originals
    const pasted = net.wires.find((w) => w.id !== 9)!;
    expect(pasted.src.block).toBe(nb1!.id);
    expect(pasted.dsts[0]!.block).toBe(nb2!.id);
    // undo restores the whole paste as one step (restore swaps the
    // network object — re-read it from the pou)
    cv.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await cv.updateComplete;
    const restored = pou.networks[0]!;
    expect(restored.blocks.length).toBe(2);
    expect(restored.wires.length).toBe(1);
    cv.remove();
  });

  it('align-left snaps the selection to the minimum x', async () => {
    const { cv, pou } = mount();
    await cv.updateComplete;
    cv.selIds = new Set([1, 2]);
    await cv.updateComplete;
    const btn = [...cv.querySelectorAll<HTMLButtonElement>('.fbd-props .chip-btn')].find((b) =>
      b.textContent?.includes('⇤'),
    )!;
    btn.click();
    await cv.updateComplete;
    const [b1, b2] = pou.networks[0]!.blocks;
    expect(b1!.pos.x).toBe(1);
    expect(b2!.pos.x).toBe(1);
    cv.remove();
  });

  it('delete removes every selected block and incident wires', async () => {
    const { cv, pou } = mount();
    await cv.updateComplete;
    const net = pou.networks[0]!;
    net.wires.push({ id: 9, src: { block: 1, port: 0 }, dsts: [{ block: 2, port: 0 }] });
    cv.selIds = new Set([1, 2]);
    cv.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await cv.updateComplete;
    expect(net.blocks.length).toBe(0);
    expect(net.wires.length).toBe(0);
    cv.remove();
  });
});
