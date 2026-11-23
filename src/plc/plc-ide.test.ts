import { describe, expect, it, beforeEach, vi } from 'vitest';
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
    el.activity = 'configure';
    await el.updateComplete;
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
    el.activity = 'debug';
    await el.updateComplete;
    navTo(el, 'Run');
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

describe('plc-ide workbench (program activity)', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('renders explorer + tabs + inspector instead of pane nav', async () => {
    seed();
    const el = await mount();
    el.activity = 'program';
    await el.updateComplete;
    expect(el.querySelector('.plc-workbench')).toBeTruthy();
    expect(el.querySelector('.plc-side')).toBeTruthy();
    expect(el.querySelector('.plc-nav-btn')).toBeFalsy();
    // no tabs until a document is opened
    expect(el.querySelectorAll('.plc-tab').length).toBe(0);

    // clicking a POU in the explorer opens its FBD tab
    el.querySelector<HTMLElement>('.plc-tree-pou')!.click();
    await el.updateComplete;
    const tabs = el.querySelectorAll('.plc-tab');
    expect(tabs.length).toBe(1);
    expect(tabs[0]!.textContent).toContain('main');
    expect(el.querySelector('.plc-edkind')).toBeTruthy();

    // switching editor kind to ST mounts the st editor
    [...el.querySelectorAll<HTMLButtonElement>('.plc-edkind .chip-btn')]
      .find((b) => b.textContent?.trim() === 'ST')!
      .click();
    await el.updateComplete;
    expect(el.querySelector('st-editor')).toBeTruthy();

    // globals row opens a second tab; closing leaves the first
    [...el.querySelectorAll<HTMLElement>('.plc-tree-pou')]
      .find((r) => r.textContent?.includes('globals'))!
      .click();
    await el.updateComplete;
    expect(el.querySelectorAll('.plc-tab').length).toBe(2);
    el.querySelector<HTMLElement>('.plc-tab-x')!.click();
    await el.updateComplete;
    expect(el.querySelectorAll('.plc-tab').length).toBe(1);
    el.remove();
  });
});

describe('plc-ide discovery card', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false }) as Response),
    );
  });

  const showDiscovery = async (el: TetherPlcIde) => {
    el.activity = 'configure';
    await el.updateComplete;
    navTo(el, 'Discovery');
    await el.updateComplete;
    // refreshIfaces resolves a meta-op promise — let microtasks settle
    await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;
  };

  const stubCtl = (
    el: TetherPlcIde,
    meta: (op: string, fields: Record<string, unknown>) => Promise<unknown>,
  ) => {
    (el as unknown as { ctl: { meta: typeof meta } }).ctl = { meta };
  };

  it('auto-picks raw NIC transport when iface_list yields a sole physical NIC', async () => {
    seed();
    const el = await mount();
    const meta = vi.fn(async (op: string, _fields: Record<string, unknown> = {}) => {
      if (op === 'iface_list')
        return {
          ifaces: [
            { name: 'enp6s0', kind: 'ethernet', state: 'up', mac: '9c:6b:00:11:22:33', mtu: '1500' },
            { name: 'lo', kind: 'loopback', state: 'unknown', mac: '00:00:00:00:00:00', mtu: '65536' },
            { name: 'veth0', kind: 'virtual', state: 'up', mac: 'aa:bb:cc:dd:ee:ff', mtu: '1500' },
          ],
          auto: 'enp6s0',
        };
      return { exit: 0, stderr: '', fleet: '' };
    });
    stubCtl(el, meta);
    await showDiscovery(el);

    // transport picker rendered, raw auto-selected
    const segs = [...el.querySelectorAll<HTMLButtonElement>('.plc-ops .chip-btn')].map((b) =>
      b.textContent?.trim(),
    );
    expect(segs).toContain('EtherCAT/UDP');
    expect(segs).toContain('raw NIC');
    const active = el.querySelector<HTMLButtonElement>('.plc-ops .chip-btn.active');
    expect(active?.textContent?.trim()).toBe('raw NIC');

    // NIC select shows the auto-picked physical NIC, peer field hidden
    const sel = el.querySelector<HTMLSelectElement>('select.fbd-in');
    expect(sel).toBeTruthy();
    expect(sel!.value).toBe('enp6s0');
    expect([...sel!.querySelectorAll('option')].some((o) => o.textContent?.includes('auto'))).toBe(
      true,
    );
    const inputs = [...el.querySelectorAll<HTMLInputElement>('input.fbd-in')].map(
      (i) => i.placeholder,
    );
    expect(inputs).not.toContain('peer');

    // scan sends iface only (no peer/port leakage)
    meta.mockClear();
    [...el.querySelectorAll<HTMLButtonElement>('.plc-ops .chip-btn')]
      .find((b) => b.textContent?.trim() === 'scan bus')!
      .click();
    await new Promise((r) => setTimeout(r, 0));
    const scan = meta.mock.calls.find(([op]) => op === 'bus_scan');
    expect(scan?.[1]).toEqual({ iface: 'enp6s0' });
    el.remove();
  });

  it('defaults to UDP with peer/port when no NIC can be auto-selected', async () => {
    seed();
    const el = await mount();
    const meta = vi.fn(async (op: string, _fields: Record<string, unknown> = {}) => {
      if (op === 'iface_list')
        return {
          ifaces: [
            { name: 'eth0', kind: 'ethernet', state: 'up', mac: 'aa:00:00:00:00:01', mtu: '1500' },
            { name: 'eth1', kind: 'ethernet', state: 'down', mac: 'aa:00:00:00:00:02', mtu: '1500' },
          ],
          auto: '',
        };
      return { exit: 0, stderr: '', fleet: '' };
    });
    stubCtl(el, meta);
    await showDiscovery(el);

    const active = el.querySelector<HTMLButtonElement>('.plc-ops .chip-btn.active');
    expect(active?.textContent?.trim()).toBe('EtherCAT/UDP');
    const peer = el.querySelector<HTMLInputElement>('input[list="plc-bus-peers"]');
    expect(peer).toBeTruthy();
    expect(peer!.value).toBe('127.0.0.1');
    expect(el.querySelector('datalist#plc-bus-peers')).toBeTruthy();

    meta.mockClear();
    [...el.querySelectorAll<HTMLButtonElement>('.plc-ops .chip-btn')]
      .find((b) => b.textContent?.trim() === 'scan bus')!
      .click();
    await new Promise((r) => setTimeout(r, 0));
    const scan = meta.mock.calls.find(([op]) => op === 'bus_scan');
    expect(scan?.[1]).toEqual({ peer: '127.0.0.1', port: 34980 });
    el.remove();
  });

  it('switches contextual fields when the transport changes', async () => {
    seed();
    const el = await mount();
    stubCtl(el, async (op) =>
      op === 'iface_list'
        ? { ifaces: [{ name: 'eth0', kind: 'ethernet', state: 'up', mac: 'aa', mtu: '1500' }], auto: 'eth0' }
        : { exit: 0, stderr: '', fleet: '' },
    );
    await showDiscovery(el);

    // raw → select; switch to udp → peer input appears, select gone
    expect(el.querySelector('select.fbd-in')).toBeTruthy();
    [...el.querySelectorAll<HTMLButtonElement>('.plc-ops .chip-btn')]
      .find((b) => b.textContent?.trim() === 'EtherCAT/UDP')!
      .click();
    await el.updateComplete;
    expect(el.querySelector('select.fbd-in')).toBeFalsy();
    expect(el.querySelector('input[list="plc-bus-peers"]')).toBeTruthy();

    // back to raw → select again; 'other…' yields the manual fallback
    [...el.querySelectorAll<HTMLButtonElement>('.plc-ops .chip-btn')]
      .find((b) => b.textContent?.trim() === 'raw NIC')!
      .click();
    await el.updateComplete;
    const sel = el.querySelector<HTMLSelectElement>('select.fbd-in')!;
    sel.value = '__custom';
    sel.dispatchEvent(new Event('change'));
    await el.updateComplete;
    const manual = el.querySelector<HTMLInputElement>('input.fbd-in[placeholder="iface"]');
    expect(manual).toBeTruthy();
    el.remove();
  });

  it('warns about missing CAP_NET_RAW in raw mode when the backend says so', async () => {
    seed();
    const el = await mount();
    stubCtl(el, async (op) =>
      op === 'iface_list'
        ? {
            ifaces: [{ name: 'eth0', kind: 'ethernet', state: 'up', mac: 'aa', mtu: '1500' }],
            auto: 'eth0',
            raw_capable: false,
          }
        : { exit: 0, stderr: '', fleet: '' },
    );
    await showDiscovery(el);

    const warn = el.querySelector('.plc-ops .plc-warn');
    expect(warn).toBeTruthy();
    expect(warn!.textContent).toContain('CAP_NET_RAW');
    expect(warn!.getAttribute('title')).toContain('setcap');
    el.remove();
  });

  it('shows no CAP_NET_RAW warning when the backend does not report it', async () => {
    seed();
    const el = await mount();
    stubCtl(el, async (op) =>
      op === 'iface_list'
        ? {
            ifaces: [{ name: 'eth0', kind: 'ethernet', state: 'up', mac: 'aa', mtu: '1500' }],
            auto: 'eth0',
            raw_capable: true,
          }
        : { exit: 0, stderr: '', fleet: '' },
    );
    await showDiscovery(el);
    expect(el.querySelector('.plc-ops .plc-warn')).toBeFalsy();
    el.remove();
  });

  it('blocks a raw scan until an interface is chosen', async () => {
    seed();
    const el = await mount();
    const meta = vi.fn(async (_op: string, _fields: Record<string, unknown> = {}) => ({
      exit: 0,
      stderr: '',
      fleet: '',
    }));
    stubCtl(el, meta);
    // force raw mode with no iface_list data and no iface picked
    (el as unknown as { busLink: string }).busLink = 'raw';
    await showDiscovery(el);

    [...el.querySelectorAll<HTMLButtonElement>('.plc-ops .chip-btn')]
      .find((b) => b.textContent?.trim() === 'scan bus')!
      .click();
    await el.updateComplete;
    expect(meta.mock.calls.some(([op]) => op === 'bus_scan')).toBe(false);
    expect(el.textContent).toContain('pick an interface first');
    el.remove();
  });
});

describe('plc-ide devices panel (fbd workbench)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    document.body.innerHTML = '';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false }) as Response));
  });

  const seedWithNet = (): PlcProject => {
    const fbd = emptyProject('demo');
    fbd.pous.push({
      id: 'p1',
      name: 'main',
      kind: 'program',
      en_eno: 'off',
      interface: [],
      networks: [
        {
          id: 'n1', kind: 'fbd', label: '', comments: [], assocs: [],
          labels: [], jumps: [], returns: [], blocks: [], wires: [],
        },
      ],
    });
    const p: PlcProject = { fbd, stSources: {} };
    localStorage.setItem(KEY, JSON.stringify(p));
    return p;
  };

  const topo = JSON.stringify({
    v: 2,
    slaves: [
      { i: 0, part: 'EK1100', key: 'ek1100.c1', coupler: true, coupler_idx: 1, name: 'EK1100 coupler', vendor: 2, supported: true },
      { i: 1, part: 'EL2008', key: 'el2008.c1', coupler_idx: 1, name: '8-ch DO', do: 8, rx: 1, vendor: 2, supported: true },
    ],
  });

  const openDevices = async () => {
    const el = await mount();
    el.activity = 'program';
    await el.updateComplete;
    // devices lives behind the rail entry, not the project tree
    el.navigate('program', 'devices');
    await el.updateComplete;
    return el;
  };

  const blocks = () =>
    JSON.parse(localStorage.getItem(KEY)!).fbd.pous.find(
      (p: { name: string }) => p.name === 'main',
    ).networks[0].blocks;

  it('renders the doc even with no bus (offline catalog always usable)', async () => {
    seedWithNet();
    const el = await openDevices();
    const dev = el.querySelector<HTMLElement>('.plc-dev-doc');
    expect(dev).toBeTruthy();
    expect(dev!.textContent).toContain('Devices');
    expect(dev!.textContent).toContain('terminal catalog');
    // target selector lists the project POUs
    expect(dev!.querySelector('select option')?.textContent).toBe('main');
    el.remove();
  });

  it('shows live bus + entity sections and adds blocks into the target POU', async () => {
    seedWithNet();
    const el = await openDevices();
    (el as unknown as { busData: unknown }).busData = { simdir: '/tmp/x', topology: topo };
    (el as unknown as { catGroups: unknown }).catGroups = [
      {
        name: 'homeassistant · ha_entity',
        items: [
          { kind: 'fb', type: 'FB_HaEntity', label: 'FB_HaEntity', hint: 'ha entity', lib: 'homeassistant', srcFile: 'ha_entity.st' },
        ],
      },
    ];
    el.requestUpdate();
    await el.updateComplete;

    const dev = () => el.querySelector<HTMLElement>('.plc-dev-doc')!;
    expect(dev().textContent).toContain('EtherCAT bus');
    expect(dev().textContent).toContain('EL2008');
    expect(dev().textContent).toContain('entities');
    expect(dev().textContent).toContain('FB_HaEntity');

    // + device on the bus row → device block with the live endpoint
    const row = [...el.querySelectorAll<HTMLElement>('.plc-busterm')].find((r) =>
      r.textContent?.includes('EL2008'),
    )!;
    [...row.querySelectorAll<HTMLButtonElement>('.chip-btn')]
      .find((b) => b.textContent?.trim() === '+ device')!
      .click();
    await el.updateComplete;
    expect(blocks()).toHaveLength(1);
    expect(blocks()[0].kind).toBe('device');
    expect(blocks()[0].endpoint).toBe('el2008.c1');
    expect(blocks()[0].pins).toHaveLength(8);

    // entity button → catalog FB block in the same network
    [...el.querySelectorAll<HTMLButtonElement>('.plc-dev-items .chip-btn')]
      .find((b) => b.textContent?.includes('FB_HaEntity'))!
      .click();
    await el.updateComplete;
    expect(blocks().some((b: { kind: string; type_ref: string }) => b.kind === 'fb' && b.type_ref === 'FB_HaEntity')).toBe(true);

    el.remove();
  });

  it('adds an offline catalog terminal wired (vars + wires) via ⚡', async () => {
    seedWithNet();
    const el = await openDevices();
    const zap = [...el.querySelectorAll<HTMLButtonElement>('.plc-dev-zap')].find((b) =>
      b.title?.includes('EL2008'),
    )!;
    zap.click();
    await el.updateComplete;

    const p = JSON.parse(localStorage.getItem(KEY)!).fbd.pous.find(
      (x: { name: string }) => x.name === 'main',
    );
    const net = p.networks[0];
    expect(net.blocks.some((b: { kind: string }) => b.kind === 'device')).toBe(true);
    expect(net.blocks.filter((b: { kind: string }) => b.kind === 'variable')).toHaveLength(8);
    expect(net.wires.length).toBeGreaterThan(0);
    // declared vars for each channel
    expect(p.interface.length).toBe(8);
    el.remove();
  });
});
