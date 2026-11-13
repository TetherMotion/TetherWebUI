import { describe, expect, it, beforeEach } from 'vitest';
import './plc-ide';
import { emptyProject } from './model';
import type { PlcProject } from './store';
import type { TetherPlcIde } from './plc-ide';

const KEY = 'tether.plc.project.v1';

function seed(): PlcProject {
  const fbd = emptyProject('demo');
  fbd.pous.push(
    { id: 'p1', name: 'main', kind: 'program', en_eno: 'off', interface: [], networks: [] },
    { id: 'p2', name: 'helper', kind: 'program', en_eno: 'off', interface: [], networks: [] },
  );
  const p: PlcProject = { fbd, stSources: {} };
  localStorage.setItem(KEY, JSON.stringify(p));
  return p;
}

async function mount() {
  const el = document.createElement('tether-plc-ide') as TetherPlcIde;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

function navTo(el: Element, label: string) {
  const btn = [...el.querySelectorAll<HTMLButtonElement>('.plc-nav-btn')].find(
    (b) => b.textContent?.trim() === label,
  )!;
  btn.click();
}

describe('plc-ide tasks pane', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  const tasks = () => JSON.parse(localStorage.getItem(KEY)!).fbd.tasks;

  it('adds, edits, assigns, and deletes tasks', async () => {
    seed();
    const el = await mount();
    navTo(el, 'Tasks');
    await el.updateComplete;

    // + task creates one bound to all program pous
    el.querySelector<HTMLButtonElement>('h3 .chip-btn')!.click();
    await el.updateComplete;
    expect(tasks()).toHaveLength(1);
    expect(tasks()[0]!.name).toBe('task1');
    expect(tasks()[0]!.programs).toEqual(['main', 'helper']);

    // period edit → ns conversion
    const periodIn = el.querySelectorAll<HTMLInputElement>('input[type=number]')[0]!;
    periodIn.value = '25';
    periodIn.dispatchEvent(new Event('change'));
    expect(tasks()[0]!.period_ns).toBe(25e6);

    // uncheck a program
    const cb = el.querySelector<HTMLInputElement>('.plc-task-prog input')!;
    cb.checked = false;
    cb.dispatchEvent(new Event('change'));
    expect(tasks()[0]!.programs).toEqual(['helper']);

    // delete
    el.querySelector<HTMLButtonElement>('td .chip-btn')!.click();
    await el.updateComplete;
    expect(tasks()).toHaveLength(0);

    el.remove();
  });

  it('shows retain card only when ctl reports a store', async () => {
    seed();
    const el = await mount();
    navTo(el, 'Deploy');
    await el.updateComplete;
    expect(el.querySelector('h4')?.textContent ?? '').not.toContain('retain store');
    el.remove();
  });
});

describe('parseDeployMap', () => {
  it('parses bridge-format channels, binds, safety and hash', async () => {
    const { parseDeployMap, deployMapOverlaps } = await import('./plc-ide');
    const text = [
      '# deploy map',
      'image in=64 out=64',
      'in off=0 size=1 key=temp_in type=i16',
      'in off=4 size=2 pdo=el1004.c1 safe=last',
      'out off=0 size=1 key=heater safe=defined 42',
      'bind "%IX0.0" temp_in',
      'safety heater',
      'hash abcdef0123456789',
    ].join('\n');
    const m = parseDeployMap(text);
    expect(m.inSize).toBe(64);
    expect(m.outSize).toBe(64);
    expect(m.channels).toHaveLength(3);
    expect(m.channels[0]).toMatchObject({ dir: 'in', off: 0, size: 1, key: 'temp_in', type: 'i16' });
    // pdo channel derives the runtime key suffix
    expect(m.channels[1]).toMatchObject({ key: 'el1004.c1.tx', pdo: 'el1004.c1', safe: 'last' });
    expect(m.channels[2]).toMatchObject({ dir: 'out', key: 'heater', safe: 'defined' });
    expect(m.bindings).toEqual([{ at: '%IX0.0', key: 'temp_in' }]);
    expect(m.safety).toEqual(['heater']);
    expect(m.hash).toBe('abcdef0123456789');
    expect(deployMapOverlaps(m.channels)).toHaveLength(0);
  });

  it('flags overlapping image ranges in the same direction only', async () => {
    const { parseDeployMap, deployMapOverlaps } = await import('./plc-ide');
    const m = parseDeployMap(
      [
        'in off=0 size=4 key=a',
        'in off=2 size=4 key=b',
        'in off=8 size=1 key=c',
        'out off=0 size=4 key=a_out',
        'out off=2 size=4 key=b_out',
      ].join('\n'),
    );
    const bad = deployMapOverlaps(m.channels);
    // a/b overlap in, a_out/b_out overlap out; c is clean
    expect(bad).toHaveLength(4);
    expect(bad).not.toContain(2);
  });

  it('returns an empty map for missing section bytes', async () => {
    const { parseDeployMap } = await import('./plc-ide');
    const m = parseDeployMap('');
    expect(m.channels).toHaveLength(0);
    expect(m.bindings).toHaveLength(0);
    expect(m.safety).toHaveLength(0);
  });
});

describe('projectIoBindings', () => {
  it('collects at bindings from globals, interfaces, vars and device pins', async () => {
    const { projectIoBindings } = await import('./plc-ide');
    const { emptyProject } = await import('./model');
    const fbd = emptyProject('x');
    fbd.global_vars.push({ name: 'g_in', kind: 'var_global', type: 'BOOL', at: '%IX0.0' });
    fbd.pous.push({
      id: 'p1', name: 'main', kind: 'program', en_eno: 'off',
      interface: [{ name: 'pv', kind: 'var_input', type: 'LREAL', at: '%IW0' }],
      networks: [{
        id: 'n1', kind: 'fbd', label: '', comments: [], assocs: [], labels: [],
        jumps: [], returns: [], wires: [],
        blocks: [
          { id: 1, kind: 'variable', type_ref: '', pos: { x: 0, y: 0 }, params: {}, exec_order: 0, negated: [], comment: '', role: 'in', name: 'run', at: '%IX1.0' },
          { id: 2, kind: 'device', type_ref: 'EK1123', pos: { x: 0, y: 0 }, params: {}, exec_order: 0, negated: [], comment: '',
            pins: [{ name: 'CH1', kind: 'var_output', type: 'INT', at: '%QW2' }] },
        ],
      }],
    });
    const binds = projectIoBindings(fbd);
    const names = binds.map((b) => b.name);
    expect(names).toContain('⚙ g_in');
    expect(names).toContain('main.pv');
    expect(names).toContain('main.run');
    expect(names).toContain('main.EK1123.CH1');
    expect(binds.find((b) => b.name === 'main.EK1123.CH1')?.at).toBe('%QW2');
  });
});
