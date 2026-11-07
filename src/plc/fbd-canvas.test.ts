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
});
