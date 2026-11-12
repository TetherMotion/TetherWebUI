import { beforeEach, describe, expect, it } from 'vitest';
import './tempcurve';
import type { TempCurve } from './tempcurve';
import { Pou } from './model';
import { defaultProfile } from './curve';

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

async function mount(p?: Pou): Promise<TempCurve> {
  const el = document.createElement('temp-curve') as TempCurve;
  if (p) el.pou = p;
  document.body.append(el);
  await el.updateComplete;
  return el;
}

describe('<temp-curve>', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the default profile preview and segment table', async () => {
    const el = await mount();
    expect(el.querySelectorAll('.curve-pt').length).toBeGreaterThan(0);
    expect(el.querySelectorAll('.curve-table tbody tr').length).toBe(5);
    expect(el.querySelector('.curve-head')!.textContent).toContain('temperature profile');
  });

  it('adds and deletes segments', async () => {
    const el = await mount();
    const add = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('segment'));
    add!.click();
    await el.updateComplete;
    expect(el.querySelectorAll('.curve-table tbody tr').length).toBe(6);

    const del = el.querySelectorAll('.curve-ops button')[2] as HTMLButtonElement;
    del.click();
    await el.updateComplete;
    expect(el.querySelectorAll('.curve-table tbody tr').length).toBe(5);
  });

  it('edits a segment target and emits change', async () => {
    const el = await mount();
    let changed = 0;
    el.addEventListener('change', () => changed++);
    const tgt = el.querySelectorAll('.curve-table tbody tr')[0]!.querySelectorAll('input')[0]!;
    (tgt as HTMLInputElement).value = '200';
    tgt.dispatchEvent(new Event('change'));
    await el.updateComplete;
    expect(el.prof.segs[0]!.tgt).toBe(200);
    expect(changed).toBe(1);
  });

  it('loads a persisted profile and emits it on change', async () => {
    const saved = { ...defaultProfile(), instance: 'oven', cycleTime: 0.5, runVar: 'Run' };
    const el = document.createElement('temp-curve') as TempCurve;
    el.pou = pou();
    el.profile = saved;
    document.body.append(el);
    await el.updateComplete;
    expect(el.prof.instance).toBe('oven');
    expect(el.prof.runVar).toBe('Run');
    expect(el.querySelectorAll('.curve-table tbody tr').length).toBe(saved.segs.length);

    let detail: unknown;
    el.addEventListener('change', (e) => (detail = (e as CustomEvent).detail));
    const tgt = el.querySelectorAll('.curve-table tbody tr')[0]!.querySelectorAll('input')[0]!;
    (tgt as HTMLInputElement).value = '175';
    tgt.dispatchEvent(new Event('change'));
    await el.updateComplete;
    expect((detail as typeof saved).segs[0]!.tgt).toBe(175);
    // the stored prop is untouched (the IDE owns persistence)
    expect(saved.segs[0]!.tgt).toBe(150);
  });

  it('inserts profile blocks into the selected POU', async () => {
    const p = pou();
    const el = await mount(p);
    let changed = 0;
    el.addEventListener('change', () => changed++);
    const insert = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('insert into'),
    );
    expect(insert!.textContent).toContain('Main');
    insert!.click();
    const net = p.networks[0]!;
    expect(net.blocks.some((b) => b.kind === 'st' && b.params.CODE?.includes('PROF.SEG[1]'))).toBe(
      true,
    );
    expect(net.blocks.some((b) => b.type_ref === 'FB_AtcProfile')).toBe(true);
    expect(changed).toBe(1);
  });

  it('exports a standalone FUNCTION_BLOCK source', async () => {
    const el = await mount(pou());
    let detail: { name: string; source: string } | undefined;
    el.addEventListener('export-st', (e) => (detail = (e as CustomEvent).detail));
    [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('export'))!.click();
    expect(detail!.name).toBe('FB_prof_cfg');
    expect(detail!.source).toContain('FUNCTION_BLOCK FB_prof_cfg');
    expect(detail!.source).toContain('PROF.SEG[1].KIND := 3;');
  });
});
