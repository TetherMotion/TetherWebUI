import { describe, expect, it, beforeEach } from 'vitest';
import './plc-ide';
import { emptyProject, type Network, type Pou } from './model';
import type { PlcProject } from './store';
import type { TetherPlcIde } from './plc-ide';

const KEY = 'tether.plc.project.v1';

function net(id: string): Network {
  return {
    id,
    kind: 'fbd',
    label: '',
    comments: [],
    assocs: [],
    labels: [],
    jumps: [],
    returns: [],
    blocks: [],
    wires: [],
  };
}

function pou(networks: Network[]): Pou {
  return { id: 'p1', name: 'main', kind: 'program', en_eno: 'off', interface: [], networks };
}

function seed(p: Pou): PlcProject {
  const fbd = emptyProject('demo');
  fbd.pous.push(p);
  const proj: PlcProject = { fbd, stSources: {} };
  localStorage.setItem(KEY, JSON.stringify(proj));
  return proj;
}

async function mount() {
  const el = document.createElement('tether-plc-ide') as TetherPlcIde;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

async function menuOn(el: TetherPlcIde, row: Element) {
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 30));
  return [...document.querySelectorAll<HTMLButtonElement>('.ctx-item')];
}

const saved = () => JSON.parse(localStorage.getItem(KEY)!);

describe('explorer context menus', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('deletes a network via context menu', async () => {
    seed(pou([net('n1'), net('n2')]));
    const el = await mount();
    el.activity = 'program';
    el.selPou = 'p1';
    el.selNet = 0;
    await el.updateComplete;
    const items = await menuOn(el, el.querySelectorAll('.plc-tree-net')[1]!);
    items.find((b) => b.textContent?.includes('Delete network'))!.click();
    await el.updateComplete;
    expect(saved().fbd.pous[0].networks.map((n: Network) => n.id)).toEqual(['n1']);
  });

  it('deletes the last remaining network', async () => {
    seed(pou([net('n1')]));
    const el = await mount();
    el.activity = 'program';
    el.selPou = 'p1';
    await el.updateComplete;
    const items = await menuOn(el, el.querySelector('.plc-tree-net')!);
    const del = items.find((b) => b.textContent?.includes('Delete network'))!;
    expect(del.disabled).toBe(false);
    del.click();
    await el.updateComplete;
    expect(saved().fbd.pous[0].networks).toHaveLength(0);
  });

  it('move later acts on the right-clicked row, not selNet', async () => {
    seed(pou([net('n1'), net('n2'), net('n3')]));
    const el = await mount();
    el.activity = 'program';
    el.selPou = 'p1';
    el.selNet = 0;
    await el.updateComplete;
    /* right-click net 2 (index 1) while net 1 is selected */
    const items = await menuOn(el, el.querySelectorAll('.plc-tree-net')[1]!);
    items.find((b) => b.textContent?.trim() === 'Move later')!.click();
    await el.updateComplete;
    expect(saved().fbd.pous[0].networks.map((n: Network) => n.id)).toEqual([
      'n1',
      'n3',
      'n2',
    ]);
  });
});
