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

  it('offers the full operator + builtin set in a searchable block library', async () => {
    const { cv } = mount();
    await cv.updateComplete;
    cv.querySelector<HTMLButtonElement>('.fbd-libbtn')!.click();
    await cv.updateComplete;
    const labels = [...cv.querySelectorAll('.fbd-lib .fbd-lib-label')].map((b) => b.textContent);
    for (const t of ['AND', 'OR', 'XOR', 'NOT', 'ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'ABS',
      'MIN', 'MAX', 'GT', 'GE', 'LT', 'LE', 'EQ', 'NE', 'SEL', 'LIMIT', 'MUX', 'MOVE',
      'SHL', 'SHR', 'ROL', 'ROR', 'TON', 'TOF', 'TP', 'R_TRIG', 'F_TRIG', 'CTU', 'CTD',
      'CTUD', 'SR', 'RS'])
      expect(labels).toContain(t);
    // conversions collapse to a picker tile until searched
    expect(labels).toContain('Convert value…');
    expect(cv.querySelectorAll('.fbd-lib-group').length).toBeGreaterThanOrEqual(8);
    // search narrows the library
    const q = cv.querySelector<HTMLInputElement>('.fbd-lib-q')!;
    q.value = 'tON';
    q.dispatchEvent(new Event('input'));
    await cv.updateComplete;
    const filtered = [...cv.querySelectorAll('.fbd-lib .fbd-lib-label')].map((b) => b.textContent);
    expect(filtered).toEqual(['TON']);
    // …and casts surface as real items under search
    q.value = 'real→dint';
    q.dispatchEvent(new Event('input'));
    await cv.updateComplete;
    const casts = [...cv.querySelectorAll('.fbd-lib .fbd-lib-label')].map((b) => b.textContent);
    expect(casts).toContain('REAL→DINT');
    cv.remove();
  });

  it('typechecks wires and pins, with severities', async () => {
    const { cv, pou } = mount();
    pou.interface = [
      { name: 'B', kind: 'var_input', type: 'BOOL' },
      { name: 'R', kind: 'var_output', type: 'REAL' },
    ];
    const net = pou.networks[0]!;
    net.blocks = [
      { id: 1, kind: 'variable', type_ref: '', pos: { x: 1, y: 2 }, params: {}, exec_order: 0, negated: [], comment: '', role: 'in', name: 'B' },
      { id: 2, kind: 'operator', type_ref: 'MOVE', pos: { x: 8, y: 2 }, params: {}, exec_order: 0, negated: [], comment: '' },
      { id: 3, kind: 'variable', type_ref: '', pos: { x: 20, y: 2 }, params: {}, exec_order: 0, negated: [], comment: '', role: 'out', name: 'R' },
    ];
    net.wires = [
      { id: 10, src: { block: 1, port: 0 }, dsts: [{ block: 2, port: 0 }] },
      { id: 11, src: { block: 2, port: 0 }, dsts: [{ block: 3, port: 0 }] },
    ];
    cv.requestUpdate();
    await cv.updateComplete;
    const issues = cv.validateIssues();
    const errs = issues.filter((i) => i.severity === 'error').map((i) => i.message);
    expect(errs.join('\n')).toMatch(/type mismatch: BOOL → REAL/);
    // the offending wire and pin are marked
    expect(cv.querySelectorAll('.fbd-wire.err').length).toBe(1);
    expect(cv.querySelectorAll('.fbd-pin.err').length).toBeGreaterThan(0);
    // status strip reports the count
    expect(cv.querySelector('.fbd-status')!.textContent).toMatch(/1 error/);
    // pin types are exposed as tooltips
    const titles = [...cv.querySelectorAll('.fbd-pin title')].map((t) => t.textContent);
    expect(titles.join('|')).toMatch(/BOOL/);
    cv.remove();
  });

  it('shows live values on FB pins from the catalog', async () => {
    const { cv, pou } = mount();
    pou.name = 'Main';
    // library FB decl (the IDE passes these parsed from attached sources)
    cv.pous = [
      pou,
      {
        id: 'lib:FB_AtcPid',
        name: 'FB_AtcPid',
        kind: 'function_block',
        en_eno: 'off',
        networks: [],
        interface: [
          { name: 'Setpoint', kind: 'var_input', type: 'LREAL' },
          { name: 'Actual', kind: 'var_input', type: 'LREAL' },
          { name: 'Out', kind: 'var_output', type: 'LREAL' },
        ],
      },
    ];
    const net = pou.networks[0]!;
    net.blocks.push({
      id: 40, kind: 'fb', type_ref: 'FB_AtcPid', instance: 'ctl', pos: { x: 24, y: 2 },
      params: {}, exec_order: 0, negated: [], comment: '',
    });
    cv.values = new Map<string, unknown>([
      ['plc.Main.ctl.Out', 42.5],
      ['plc.Main.ctl.Setpoint', 150],
    ]);
    cv.requestUpdate();
    await cv.updateComplete;
    const live = [...cv.querySelectorAll('.fbd-pin-live')].map((t) => t.textContent);
    expect(live).toContain('42.500');
    expect(live).toContain('150');
    cv.remove();
  });

  it('treats user/library FB inputs as optional but builtin pins as required', async () => {
    const { cv, pou } = mount();
    await cv.updateComplete;
    const net = pou.networks[0]!;
    const mk = (id: number, kind: 'fb' | 'st', type: string): void => {
      net.blocks.push({
        id,
        kind,
        type_ref: type,
        instance: `i${id}`,
        pos: { x: 20 + id, y: 8 },
        params: {},
        exec_order: 0,
        negated: [],
        comment: '',
        ...(kind === 'st'
          ? { pins: [{ name: 'A', kind: 'var_input' as const, type: 'REAL' }] }
          : {}),
      });
    };
    mk(40, 'fb', 'FB_AtcProfile'); // library FB: HOLD/RESET/... optional
    mk(41, 'fb', 'TON'); // builtin: IN/PT required
    mk(42, 'st', 'ST'); // inline ST pin: required
    cv.requestUpdate();
    await cv.updateComplete;
    const diags = cv.validate().join('\n');
    expect(diags).not.toMatch(/b40 .*unconnected/);
    expect(diags).toMatch(/b41 TON: input IN unconnected/);
    expect(diags).toMatch(/b42 ST: input A unconnected/);
    cv.remove();
  });

  it('adds a block from the palette', async () => {
    const { cv, pou } = mount();
    await cv.updateComplete;
    cv.querySelector<HTMLButtonElement>('.fbd-libbtn')!.click();
    await cv.updateComplete;
    const btn = [...cv.querySelectorAll<HTMLButtonElement>('.fbd-lib-item')].find(
      (b) => b.querySelector('.fbd-lib-label')?.textContent === 'TON',
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

  it('completes a drag wire when pointerup is retargeted to the svg', async () => {
    /* real browsers: setPointerCapture on the out-pin retargets pointerup
       so it bubbles to the svg, never reaching the in-pin — the canvas
       resolves the drop target via elementsFromPoint instead */
    const { cv, pou } = mount();
    await cv.updateComplete;
    const blocks = cv.querySelectorAll('.fbd-block');
    const outPin = blocks[0]!.querySelector('.fbd-pin.out')!;
    const inPin = blocks[1]!.querySelectorAll('.fbd-pin.in')[0]!;
    const svg = cv.querySelector('svg')!;
    const orig = document.elementsFromPoint;
    document.elementsFromPoint = (() => [inPin]) as typeof document.elementsFromPoint;
    try {
      outPin.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }),
      );
      svg.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 20, clientY: 20 }));
      await cv.updateComplete;
      const wires = pou.networks[0]!.wires;
      expect(wires.length).toBe(1);
      expect(wires[0]!.src.block).toBe(1);
      expect(wires[0]!.dsts[0]).toEqual({ block: 2, port: 0 });
    } finally {
      document.elementsFromPoint = orig;
      cv.remove();
    }
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

  it('P toggles the live probe flag on the selected wire', async () => {
    const { cv, pou } = mount();
    await cv.updateComplete;
    const net = pou.networks[0]!;
    net.wires.push({ id: 9, src: { block: 1, port: 0 }, dsts: [{ block: 2, port: 0 }] });
    cv.requestUpdate();
    await cv.updateComplete;
    cv.selWire = 9;
    cv.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }));
    await cv.updateComplete;
    expect(net.wires[0]!.probe).toBe(true);
    expect(cv.querySelector('.fbd-wire')!.getAttribute('class')).toContain('probe');
    // second press clears it — the flag round-trips as absent, not false
    cv.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }));
    await cv.updateComplete;
    expect(net.wires[0]!.probe).toBeUndefined();
    cv.remove();
  });

  it('undo restores the pre-mutation network', async () => {
    const { cv, pou } = mount();
    await cv.updateComplete;
    const before = pou.networks[0]!.blocks.length;
    cv.querySelector<HTMLButtonElement>('.fbd-libbtn')!.click();
    await cv.updateComplete;
    const btn = [...cv.querySelectorAll<HTMLButtonElement>('.fbd-lib-item')].find(
      (b) => b.querySelector('.fbd-lib-label')?.textContent === 'TON',
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

  it('adds an inline ST block with pins and code from the palette', async () => {
    const { cv, pou } = mount();
    await cv.updateComplete;
    const btn = [...cv.querySelectorAll<HTMLButtonElement>('.fbd-palette .chip-btn')].find(
      (b) => b.textContent === 'ST',
    )!;
    btn.click();
    await cv.updateComplete;
    const st = pou.networks[0]!.blocks.find((b) => b.kind === 'st')!;
    expect(st.pins).toEqual([
      { name: 'IN', kind: 'var_input', type: 'REAL' },
      { name: 'OUT', kind: 'var_output', type: 'REAL' },
    ]);
    expect(st.params.CODE).toContain('OUT := IN;');
    // the canvas derives the pins from the declared interface
    const block = [...cv.querySelectorAll('.fbd-block')].find((g) =>
      g.textContent?.includes('ST'),
    )!;
    expect(block.querySelectorAll('.fbd-pin.in').length).toBe(1);
    expect(block.querySelectorAll('.fbd-pin.out').length).toBe(1);
    cv.remove();
  });

  it('edits inline ST pins and body in the properties panel', async () => {
    const { cv, pou } = mount();
    await cv.updateComplete;
    const net = pou.networks[0]!;
    net.blocks.push({
      id: 30,
      kind: 'st',
      type_ref: 'ST',
      pos: { x: 20, y: 8 },
      params: { CFG: 'TRUE', CODE: 'Q := A;' },
      exec_order: 0,
      negated: [],
      comment: '',
      pins: [
        { name: 'A', kind: 'var_input', type: 'REAL' },
        { name: 'BUF', kind: 'var_in_out', type: 'DINT' },
        { name: 'Q', kind: 'var_output', type: 'REAL' },
      ],
    });
    cv.selIds = new Set([30]);
    cv.requestUpdate();
    await cv.updateComplete;
    const code = cv.querySelector<HTMLTextAreaElement>('.fbd-stcode')!;
    expect(code.value).toBe('Q := A;');
    code.value = 'Q := A * 2.0;';
    code.dispatchEvent(new Event('change'));
    await cv.updateComplete;
    expect(net.blocks[2]!.params.CODE).toBe('Q := A * 2.0;');
    // in_out pins show on both sides
    const blk = [...cv.querySelectorAll('.fbd-block')][2]!;
    expect(blk.querySelectorAll('.fbd-pin.in').length).toBe(2);
    expect(blk.querySelectorAll('.fbd-pin.out').length).toBe(2);
    cv.remove();
  });

  it('offers EK device templates and creates a device block via the wizard', async () => {
    const { cv, pou } = mount();
    await cv.updateComplete;
    cv.querySelector<HTMLButtonElement>('.fbd-libbtn')!.click();
    await cv.updateComplete;
    const btn = [...cv.querySelectorAll<HTMLButtonElement>('.fbd-lib-item')].find(
      (b) => b.querySelector('.fbd-lib-label')?.textContent === 'EK1123 DO',
    )!;
    expect(btn).toBeTruthy();
    btn.click();
    await cv.updateComplete;
    // wizard dialog is open with the template prefilled
    const dlg = cv.querySelector('.fbd-devdlg-box')!.parentElement!;
    expect(dlg).toBeTruthy();
    const nameIn = dlg.querySelector<HTMLInputElement>('input.fbd-in')!;
    expect(nameIn.value).toBe('EK1123');
    // accept defaults → device block with 8 DO channels on %QX
    const add = [...dlg.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Add',
    )!;
    add.click();
    await cv.updateComplete;
    const dev = pou.networks[0]!.blocks.find((b) => b.kind === 'device')!;
    expect(dev.type_ref).toBe('EK1123');
    expect(dev.pins).toHaveLength(8);
    expect(dev.pins![0]).toMatchObject({
      name: 'DO0',
      kind: 'var_input',
      type: 'BOOL',
      at: '%QX0.0',
    });
    expect(dev.pins![7]).toMatchObject({ name: 'DO7', at: '%QX0.7' });
    // pins render as in-pins (logic → device)
    const blk = [...cv.querySelectorAll('.fbd-block')].find((g) =>
      g.textContent?.includes('EK1123'),
    )!;
    expect(blk.querySelectorAll('.fbd-pin.in').length).toBe(8);
    expect(blk.querySelectorAll('.fbd-pin.out').length).toBe(0);
    cv.remove();
  });

  it('mixed template (EK1110) creates DI+DO channel groups in one block', async () => {
    const { cv, pou } = mount();
    await cv.updateComplete;
    cv.querySelector<HTMLButtonElement>('.fbd-libbtn')!.click();
    await cv.updateComplete;
    const btn = [...cv.querySelectorAll<HTMLButtonElement>('.fbd-lib-item')].find(
      (b) => b.querySelector('.fbd-lib-label')?.textContent === 'EK1110 DI/DO',
    )!;
    expect(btn).toBeTruthy();
    btn.click();
    await cv.updateComplete;
    const dlg = cv.querySelector('.fbd-devdlg-box')!.parentElement!;
    // dialog previews the second channel group
    expect(dlg.textContent).toContain('4× DO');
    const add = [...dlg.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Add',
    )!;
    add.click();
    await cv.updateComplete;
    const dev = pou.networks[0]!.blocks.find((b) => b.kind === 'device')!;
    expect(dev.type_ref).toBe('EK1110');
    // 4 DI outputs (%I) + 4 DO inputs (%Q), distinct pin names
    expect(dev.pins).toHaveLength(8);
    expect(dev.pins!.map((p) => p.name)).toEqual([
      'DI0', 'DI1', 'DI2', 'DI3', 'DO0', 'DO1', 'DO2', 'DO3',
    ]);
    expect(dev.pins![0]).toMatchObject({ kind: 'var_output', at: '%IX0.0' });
    expect(dev.pins![3]).toMatchObject({ kind: 'var_output', at: '%IX0.3' });
    expect(dev.pins![4]).toMatchObject({
      kind: 'var_input',
      at: '%QX0.0',
    });
    expect(dev.pins![7]).toMatchObject({ kind: 'var_input', at: '%QX0.3' });
    cv.remove();
  });

  it('device block wires DI→logic→DO and tolerates self-channel wiring', async () => {
    const { cv, pou } = mount();
    await cv.updateComplete;
    const net = pou.networks[0]!;
    // DI terminal: 2 inputs; DO terminal: 2 outputs; analog: AI0→AO0 self-wire
    net.blocks.push(
      {
        id: 10, kind: 'device', type_ref: 'EK1108',
        pos: { x: 20, y: 2 }, params: {}, exec_order: 0, negated: [], comment: '',
        pins: [
          { name: 'DI0', kind: 'var_output', type: 'BOOL', at: '%IX0.0' },
          { name: 'DI1', kind: 'var_output', type: 'BOOL', at: '%IX0.1' },
        ],
      },
      {
        id: 11, kind: 'device', type_ref: 'EK1123',
        pos: { x: 40, y: 2 }, params: {}, exec_order: 0, negated: [], comment: '',
        pins: [
          { name: 'DO0', kind: 'var_input', type: 'BOOL', at: '%QX0.0' },
        ],
      },
      {
        id: 12, kind: 'device', type_ref: 'EK1122',
        pos: { x: 20, y: 12 }, params: {}, exec_order: 0, negated: [], comment: '',
        pins: [
          { name: 'AI0', kind: 'var_output', type: 'REAL', at: '%ID4.0' },
          { name: 'AO0', kind: 'var_input', type: 'REAL', at: '%QD4.0' },
        ],
      },
      { id: 13, kind: 'operator', type_ref: 'AND', pos: { x: 30, y: 4 }, params: {}, exec_order: 0, negated: [], comment: '' },
    );
    net.wires.push(
      { id: 20, src: { block: 10, port: 'DI0' }, dsts: [{ block: 13, port: 'IN0' }] },
      { id: 21, src: { block: 10, port: 'DI1' }, dsts: [{ block: 13, port: 'IN1' }] },
      { id: 22, src: { block: 13, port: 0 }, dsts: [{ block: 11, port: 'DO0' }] },
      // same-block AI→AO must not be an algebraic cycle
      { id: 23, src: { block: 12, port: 'AI0' }, dsts: [{ block: 12, port: 'AO0' }] },
    );
    cv.requestUpdate();
    await cv.updateComplete;
    // no unconnected-input errors for device pins (channels are optional);
    // the pre-existing AND block (id 2) is still dangling — ignore it
    const issues = cv.validate().filter((m) => !m.startsWith('b2 '));
    expect(issues.some((m) => m.includes('algebraic cycle'))).toBe(false);
    expect(issues.filter((m) => m.includes('unconnected'))).toHaveLength(0);
    // named device pins resolve for wires
    const dev = net.blocks[3]!;
    expect(dev.kind).toBe('device');
    cv.remove();
  });

  it('shows live image-channel values on device pins', async () => {
    const { cv, pou } = mount();
    await cv.updateComplete;
    const net = pou.networks[0]!;
    net.blocks.push({
      id: 10, kind: 'device', type_ref: 'EK1108',
      pos: { x: 20, y: 2 }, params: {}, exec_order: 0, negated: [], comment: '',
      pins: [{ name: 'DI0', kind: 'var_output', type: 'BOOL', at: '%IX0.0' }],
    });
    cv.values = new Map([['plc.image.I.ch.P1.__dev10_DI0', true]]);
    cv.requestUpdate();
    await cv.updateComplete;
    const blk = [...cv.querySelectorAll('.fbd-block')].find((g) =>
      g.textContent?.includes('EK1108'),
    )!;
    expect(blk.querySelector('.fbd-pin-live')?.textContent).toBe('T');
    cv.remove();
  });

  it('edits device channels in the properties panel', async () => {
    const { cv, pou } = mount();
    await cv.updateComplete;
    const net = pou.networks[0]!;
    net.blocks.push({
      id: 10, kind: 'device', type_ref: 'EK1108',
      pos: { x: 20, y: 2 }, params: {}, exec_order: 0, negated: [], comment: '',
      pins: [{ name: 'DI0', kind: 'var_output', type: 'BOOL', at: '%IX0.0' }],
    });
    cv.selIds = new Set([10]);
    cv.requestUpdate();
    await cv.updateComplete;
    const tbl = cv.querySelector('.fbd-devtbl')!;
    expect(tbl).toBeTruthy();
    // row inputs: name, type, at (dir is a <select>)
    const atIn = tbl.querySelectorAll<HTMLInputElement>('input.fbd-in')[2]!;
    expect(atIn.value).toBe('%IX0.0');
    atIn.value = '%IX0.1';
    atIn.dispatchEvent(new Event('change'));
    await cv.updateComplete;
    expect(net.blocks[2]!.pins![0]!.at).toBe('%IX0.1');
    // + channel appends a row
    const addBtn = [...cv.querySelectorAll<HTMLButtonElement>('.chip-btn')].find(
      (b) => b.textContent === '+ channel',
    )!;
    addBtn.click();
    await cv.updateComplete;
    expect(net.blocks[2]!.pins).toHaveLength(2);
    cv.remove();
  });

  it('renders typed pin-param editors for unconnected inputs', async () => {
    const { cv, pou } = mount();
    await cv.updateComplete;
    const net = pou.networks[0]!;
    net.blocks.push({
      id: 31, kind: 'fb', type_ref: 'TON',
      pos: { x: 20, y: 8 }, params: { PT: 'T#200ms' },
      exec_order: 0, negated: [], comment: '',
    });
    cv.selIds = new Set([31]);
    cv.requestUpdate();
    await cv.updateComplete;
    const pp = cv.querySelector('.fbd-pinparams')!;
    expect(pp).toBeTruthy();
    // two pin rows: IN (BOOL → checkbox) + PT (TIME → literal input)
    const rows = pp.querySelectorAll('tr');
    expect(rows).toHaveLength(2);
    const cb = pp.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(cb).toBeTruthy();
    const pt = pp.querySelector<HTMLInputElement>('input.fbd-in')!;
    expect(pt.value).toBe('T#200ms');
    // editing writes params[PT]
    pt.value = 'T#500ms';
    pt.dispatchEvent(new Event('change'));
    await cv.updateComplete;
    expect(net.blocks[2]!.params.PT).toBe('T#500ms');
    cv.remove();
  });
});


describe('fbd-canvas annotations + wire reconnect', () => {
  it('places, edits and deletes a comment note', async () => {
    const { cv, pou } = mount();
    await cv.updateComplete;
    const net = pou.networks[0]!;
    const c = cv as unknown as {
      armPlacing(k: string): void;
      placeNote(p: { x: number; y: number }): void;
      selNote?: { kind: string; id: number };
    };
    const prompts: string[] = [];
    const origPrompt = window.prompt;
    window.prompt = (msg?: string, def?: string) => { prompts.push(msg ?? ''); return 'hello note'; };
    try {
      c.armPlacing('comment');
      expect(cv.placing).toBe('comment');
      c.placeNote({ x: 140, y: 48 });
      await cv.updateComplete;
      expect(net.comments).toHaveLength(1);
      expect(net.comments[0]!.text).toBe('hello note');
      expect(net.comments[0]!.pos).toEqual({ x: 10, y: 3 });
      // edit via dblclick path
      const id = net.comments[0]!.id;
      window.prompt = () => 'edited';
      (cv as unknown as { editNote(k: string, id: number): void }).editNote('comment', id);
      await cv.updateComplete;
      expect(net.comments[0]!.text).toBe('edited');
      // delete via selNote + deleteSel
      cv.selNote = { kind: 'comment', id };
      (cv as unknown as { deleteSel(): void }).deleteSel();
      await cv.updateComplete;
      expect(net.comments).toHaveLength(0);
    } finally {
      window.prompt = origPrompt;
    }
    cv.remove();
  });

  it('places labels and return markers', async () => {
    const { cv, pou } = mount();
    await cv.updateComplete;
    const net = pou.networks[0]!;
    const c = cv as unknown as {
      armPlacing(k: string): void;
      placeNote(p: { x: number; y: number }): void;
    };
    const origPrompt = window.prompt;
    window.prompt = () => 'LBL1';
    try {
      c.armPlacing('label');
      c.placeNote({ x: 0, y: 0 });
      c.armPlacing('return');
      c.placeNote({ x: 200, y: 0 });
      await cv.updateComplete;
      expect(net.labels[0]!.name).toBe('LBL1');
      expect(net.returns).toHaveLength(1);
    } finally {
      window.prompt = origPrompt;
    }
    cv.remove();
  });

  it('reconnects a wire dst onto another in-pin', async () => {
    const { cv, pou } = mount();
    await cv.updateComplete;
    const net = pou.networks[0]!;
    // wire var-out → AND in0; reconnect dst to a second AND input
    net.blocks.push({
      id: 40, kind: 'operator', type_ref: 'AND',
      pos: { x: 16, y: 2 }, params: {}, exec_order: 0, negated: [], comment: '',
    });
    net.wires.push({
      id: 77, src: { block: 1, port: 0 },
      dsts: [{ block: 2, port: 0 }],
    });
    const c = cv as unknown as {
      pendingRec?: { wire: number; end: string; di: number; x: number; y: number };
      completeRec(e: PointerEvent): void;
    };
    // simulate: pendingRec armed on dst end 0, drop resolves via a fake pin element
    c.pendingRec = { wire: 77, end: 'dst', di: 0, x: 0, y: 0 };
    const and = net.blocks[1]!;
    const pinEl = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    pinEl.setAttribute('class', 'fbd-pin in');
    pinEl.setAttribute('data-node', '40');
    pinEl.setAttribute('data-pin', '1');
    const origElements = document.elementsFromPoint;
    (document as any).elementsFromPoint = () => [pinEl];
    try {
      c.completeRec(new MouseEvent('pointerup', { clientX: 0, clientY: 0 }) as PointerEvent);
    } finally {
      (document as any).elementsFromPoint = origElements;
    }
    await cv.updateComplete;
    void and;
    const w = net.wires.find((x) => x.src.block === 1);
    // dst moved from AND#0 (block2 pin0) to block40 pin1
    expect(w?.dsts).toEqual([{ block: 40, port: 1 }]);
    cv.remove();
  });

  it('undo stacks reset on network switch; clipboard survives', async () => {
    const { cv, pou } = mount();
    await cv.updateComplete;
    const net2 = {
      id: 'net2', kind: 'fbd' as const, label: '', comments: [], assocs: [],
      labels: [], jumps: [], returns: [], blocks: [], wires: [],
    };
    pou.networks.push(net2);
    const c = cv as unknown as {
      mutate(fn: (n: any) => void): void;
      undo(): void; copySel(): void; paste(): void;
      selIds: Set<number>; netIndex: number; undoStack: string[];
    };
    c.mutate((n) => { n.blocks.push({
      id: 50, kind: 'variable', type_ref: '', pos: { x: 1, y: 1 },
      params: {}, exec_order: 0, negated: [], comment: '', role: 'in', name: 'v',
    }); });
    // copy a block, switch network, paste — clipboard must survive
    c.selIds = new Set([1]);
    c.copySel();
    c.netIndex = 1;
    c.paste();
    await cv.updateComplete;
    expect(pou.networks[1]!.blocks).toHaveLength(1);
    // undo on the new net reverts only the paste (per-net stacks) and
    // never touches net1's blocks
    c.undo();
    await cv.updateComplete;
    expect(pou.networks[1]!.blocks).toHaveLength(0);
    expect(pou.networks[0]!.blocks.length).toBeGreaterThanOrEqual(2);
    cv.remove();
  });
});

describe('fbd-canvas wire-drop block picker', () => {
  function mount2(): { cv: FbdCanvas; pou: Pou } {
    const pou = makePou();
    const cv = document.createElement('fbd-canvas') as FbdCanvas;
    cv.pou = pou;
    cv.pous = [pou];
    document.body.appendChild(cv);
    return { cv, pou };
  }

  it('releasing a wire on empty canvas arms the picker; palette pick places + wires', async () => {
    const { cv, pou } = mount2();
    await cv.updateComplete;
    const outPin = cv.querySelectorAll('.fbd-block')[0]!.querySelector('.fbd-pin.out')!;
    const svg = cv.querySelector('svg')!;
    outPin.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }),
    );
    svg.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 300, clientY: 200 }));
    await cv.updateComplete;
    expect(cv.wirePick).toBeDefined();
    expect(cv.querySelector('.fbd-wirepick')).toBeTruthy();
    // the wire-drop auto-opens the library — pick AND, block lands at
    // the drop point and the wire lands on input 0
    expect(cv.libOpen).toBe(true);
    const btn = [...cv.querySelectorAll<HTMLElement>('.fbd-lib-item')]
      .find((b) => b.querySelector('.fbd-lib-label')?.textContent === 'AND')!;
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await cv.updateComplete;
    expect(cv.wirePick).toBeUndefined();
    const net = pou.networks[0]!;
    expect(net.blocks).toHaveLength(3);
    const added = net.blocks[2]!;
    expect(added.kind).toBe('operator');
    expect(added.type_ref).toBe('AND');
    const w = net.wires.find((x) => x.src.block === 1)!;
    expect(w).toBeDefined();
    expect(w.dsts).toContainEqual({ block: added.id, port: 0 });
    cv.remove();
  });

  it('Escape cancels the picker without placing anything', async () => {
    const { cv, pou } = mount2();
    await cv.updateComplete;
    const outPin = cv.querySelectorAll('.fbd-block')[0]!.querySelector('.fbd-pin.out')!;
    const svg = cv.querySelector('svg')!;
    outPin.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }),
    );
    svg.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 300, clientY: 200 }));
    await cv.updateComplete;
    expect(cv.wirePick).toBeDefined();
    cv.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await cv.updateComplete;
    expect(cv.wirePick).toBeUndefined();
    expect(pou.networks[0]!.blocks).toHaveLength(2);
    cv.remove();
  });
});
