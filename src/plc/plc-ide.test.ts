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
